//! The single place in this workspace that may spawn a `tmux` process.
//!
//! Every tmux invocation nession makes — create, list, kill, attach, send-keys,
//! capture-pane, `-V` — is built here, so every one of them carries an explicit
//! `-S <socket path>` and lands on nession's own tmux server. That is the whole
//! point: a call that forgot `-S` would silently use tmux's default socket,
//! where the user's own sessions live, and killing nession's last session there
//! takes the user's entire tmux server with it (tmux's `exit-empty` is `on` by
//! default — this destroyed a real session on 2026-09-02, see #574/#575).
//!
//! Because "somewhere forgot `-S`" is invisible at runtime,
//! `scripts/check-tmux-socket.sh` fails the commit if any tmux process is
//! spawned outside this module.
//!
//! ## Environment is never trusted
//!
//! Each command explicitly removes `TMUX` and `TMUX_TMPDIR` from the child
//! environment. Neither is used for addressing — `-S` decides that — but an
//! inherited `TMUX` describes some *other* server, and leaving it in place lets
//! a tmux client or a shell inside a session act on that one instead.
//!
//! ## A dead server's socket is healed, once (#1225)
//!
//! A tmux server that dies without unlinking (SIGKILL, a crash, power loss)
//! leaves the socket file behind, and every later call against it fails with
//! `server exited unexpectedly` — a message that names neither the socket nor
//! the fact that nothing listens on it, so the whole session surface stays
//! broken until someone deletes the file by hand. [`heal_stale_socket`] is the
//! precise check (`ECONNREFUSED` on a file that is a socket), [`configure`]
//! runs it at startup, and [`TmuxCmd::output`] / [`TmuxCmd::output_with`] /
//! [`TmuxCmd::output_blocking`] run it between a failure and one retry.

#[cfg(unix)]
use std::os::unix::fs::FileTypeExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{Context, Result};
use nession_common::tmux_socket;

use super::HISTORY_LIMIT_LINES;

/// Environment variables that describe a tmux server we are not addressing.
/// Stripped from every child so behaviour never depends on inheritance.
const INHERITED_TMUX_VARS: [&str; 2] = ["TMUX", "TMUX_TMPDIR"];

/// The name of nession's own tmux configuration, inside the socket directory.
const SERVER_CONFIG_FILE: &str = "nession.conf";

/// Where the server configuration lives for a given socket: beside it, in the
/// directory nession already owns and creates with 0700.
fn server_config_path(socket: &Path) -> PathBuf {
    socket.with_file_name(SERVER_CONFIG_FILE)
}

/// What that file says.
///
/// One setting, and it is here rather than in a `set-option` call for a
/// measured reason: tmux reads a server configuration **only when it starts a
/// server**, and that is the only moment a server default can be installed
/// before the first window exists. `set-option`'s own manual is explicit that
/// it is not retroactive — "applies only to new windows … existing window
/// histories are not resized" — so a `set-option -g history-limit` issued after
/// `new-session` cannot fix the window `new-session` just created.
///
/// Measured on tmux 3.6b, cold socket, in this order:
///
/// - `set-option -g history-limit 5000` → `error connecting … (No such file or
///   directory)`: there is no server to set it on.
/// - `start-server` then `set-option` → `no server running`: a server with no
///   sessions exits immediately, because `exit-empty` defaults to on.
/// - one client invocation running `start-server ; set-option … ; new-session
///   …` → works, but puts command-list grammar at the call site.
/// - `-f <this file>` on the invocation that starts the server → works, and is
///   what tmux is designed for.
pub fn server_config_contents() -> String {
    format!("set -g history-limit {HISTORY_LIMIT_LINES}\n")
}

/// Write the server configuration beside `socket`, creating nothing else —
/// [`configure`] has already made the directory.
///
/// Idempotent rewrite rather than create-if-missing: the content is derived
/// from a compile-time constant, so an agent upgraded on a PVC-backed `/root`
/// must not be stuck with the previous version's file. That is the failure the
/// image's `/root/.tmux.conf` has (`deploy/entrypoint-agent.sh` writes it only
/// when absent).
fn write_server_config(socket: &Path) -> Result<()> {
    let path = server_config_path(socket);
    std::fs::write(&path, server_config_contents())
        .with_context(|| format!("failed to write tmux config {}", path.display()))
}

/// Process-wide tmux addressing, set once at startup by
/// [`configure`] and read by [`global`].
static GLOBAL: OnceLock<TmuxCmd> = OnceLock::new();

/// A tmux binary plus the socket every command it builds will address.
#[derive(Debug, Clone)]
pub struct TmuxCmd {
    bin: String,
    socket: PathBuf,
}

impl TmuxCmd {
    /// Bind a tmux binary to a socket path. Does not touch the filesystem —
    /// [`configure`] does that once at startup.
    pub fn new(bin: impl Into<String>, socket: impl Into<PathBuf>) -> Self {
        Self {
            bin: bin.into(),
            socket: socket.into(),
        }
    }

    /// The socket this instance addresses.
    pub fn socket_path(&self) -> &Path {
        &self.socket
    }

    /// The tmux binary name or path.
    pub fn bin(&self) -> &str {
        &self.bin
    }

    /// Same socket, different binary — the test seam for injecting a fake tmux.
    pub fn with_bin(&self, bin: impl Into<String>) -> Self {
        Self {
            bin: bin.into(),
            socket: self.socket.clone(),
        }
    }

    /// A `tokio::process::Command` for `tmux -S <socket> -f <config>`.
    pub fn tokio(&self) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new(&self.bin);
        self.apply_addressing(|arg| {
            cmd.arg(arg);
        });
        for var in INHERITED_TMUX_VARS {
            cmd.env_remove(var);
        }
        cmd
    }

    /// A `std::process::Command` for `tmux -S <socket> -f <config>`, for the
    /// synchronous call sites (`Drop`, which cannot await).
    pub fn std(&self) -> std::process::Command {
        let mut cmd = std::process::Command::new(&self.bin);
        self.apply_addressing(|arg| {
            cmd.arg(arg);
        });
        for var in INHERITED_TMUX_VARS {
            cmd.env_remove(var);
        }
        cmd
    }

    /// The two global flags every invocation carries, in order.
    ///
    /// `-f` is here rather than at a `set-option` call site because a server
    /// configuration is read only when tmux *starts* a server — see
    /// [`server_config_contents`]. Passing it unconditionally is what makes
    /// whichever invocation happens to start the server the one that installs
    /// nession's defaults, and it costs nothing on the ones that do not: tmux
    /// ignores `-f` when a server is already running, and a `-f` naming a file
    /// that does not exist is harmless (measured: exit 0, session created).
    /// That last property is what keeps this safe for a `TmuxCmd` built in a
    /// test against a socket directory nothing has written a config into.
    fn apply_addressing(&self, mut arg: impl FnMut(&std::ffi::OsStr)) {
        arg(std::ffi::OsStr::new("-S"));
        arg(self.socket.as_os_str());
        arg(std::ffi::OsStr::new("-f"));
        arg(server_config_path(&self.socket).as_os_str());
    }

    /// Run `tmux <args>` to completion, capturing stdout and stderr, with one
    /// self-heal: when the command fails because a dead server left its socket
    /// behind, remove the stale socket and run the command once more (#1225).
    ///
    /// `Command::output()` semantics — both pipes captured, stdin closed — so
    /// the `.stderr(Stdio::piped())` call sites used to write beside
    /// `.output()` is implied (tokio's `output()` re-pipes right before
    /// spawning regardless). The heal runs *between* the failure and the
    /// retry: a command that fails against a **live** server is returned
    /// as-is, unretried — the retry exists only for the state the heal
    /// removed, not for second-guessing tmux's own answers.
    pub async fn output(&self, args: &[&str]) -> std::io::Result<std::process::Output> {
        self.output_with(|cmd| {
            cmd.args(args);
        })
        .await
    }

    /// [`output`](Self::output) for a command built incrementally.
    ///
    /// The closure runs against a fresh command per attempt, so a retried
    /// call gets exactly the argv the first attempt had — relevant to
    /// `create_session`, whose argument list is assembled in loops over the
    /// environment and cannot be re-spelled as one `&[&str]`.
    pub async fn output_with(
        &self,
        build: impl Fn(&mut tokio::process::Command),
    ) -> std::io::Result<std::process::Output> {
        let mut first = self.tokio();
        build(&mut first);
        let out = first.output().await?;
        if out.status.success() || !heal_stale_socket(&self.socket) {
            return Ok(out);
        }
        let mut retry = self.tokio();
        build(&mut retry);
        retry.output().await
    }

    /// The blocking form of [`output`](Self::output), for callers that cannot
    /// await (`Drop`, sync setup). [`std`](Self::std)-based, same heal.
    pub fn output_blocking(&self, args: &[&str]) -> std::io::Result<std::process::Output> {
        let out = self.std().args(args).output()?;
        if out.status.success() || !heal_stale_socket(&self.socket) {
            return Ok(out);
        }
        self.std().args(args).output()
    }

    /// A `portable_pty::CommandBuilder` for `tmux -S <socket> -f <config>`.
    ///
    /// portable-pty has its own command type, so this cannot reuse
    /// [`TmuxCmd::std`] — the PTY attach path needs its own constructor rather
    /// than a mechanical substitution.
    pub fn pty(&self) -> portable_pty::CommandBuilder {
        let mut cmd = portable_pty::CommandBuilder::new(&self.bin);
        self.apply_addressing(|arg| {
            cmd.arg(arg);
        });
        for var in INHERITED_TMUX_VARS {
            cmd.env_remove(var);
        }
        // A PTY attach child inherits the agent's environment, which carries
        // no usable $TERM on CI runners and in docker/systemd — tmux then
        // fails with "terminal does not support clear" and the client sees a
        // dead session (#633). Pin the same terminal manager.rs forces on
        // session creation, so attach renders regardless of what the agent
        // process inherited.
        cmd.env("TERM", "xterm-256color");
        cmd
    }
}

/// One self-heal for a socket a dead server left behind (#1225): remove it,
/// but only when it provably has no listener.
///
/// The criterion is `ECONNREFUSED`, not "connect failed". Permission errors
/// and timeouts also fail a connect, and in those cases the server may be
/// serving — deleting its socket would take a live server off addressing,
/// which is the #574/#575 class of mistake (a wrong server-level cleanup that
/// destroyed a real session). Refused is the kernel's own "nothing is
/// listening", identical on Linux and macOS, and the only condition under
/// which the file is removed. A path that is not a socket is never touched
/// either: it is not ours to delete.
///
/// The accepted race: a server in the microseconds between `bind` and
/// `listen` also answers `ECONNREFUSED`. It is accepted because the
/// alternative is the permanent unavailability #1225 measures, and because
/// nession runs one agent per socket — the only process that could be
/// starting that server is this one.
///
/// Returns `true` when a stale socket was found and removed. The removal is
/// logged with its path: a delete without a trace is how the #574-class
/// mistakes stayed invisible for as long as they did.
#[cfg(unix)]
pub fn heal_stale_socket(socket: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(socket) else {
        return false; // nothing there — nothing to heal
    };
    if !meta.file_type().is_socket() {
        return false;
    }
    let Err(err) = std::os::unix::net::UnixStream::connect(socket) else {
        return false; // someone is listening — the socket is alive
    };
    if err.kind() != std::io::ErrorKind::ConnectionRefused {
        return false; // only "no listener" is ours to repair
    }
    match std::fs::remove_file(socket) {
        Ok(()) => {
            tracing::warn!(
                "removed stale tmux socket {} — nothing was listening on it \
                 (ECONNREFUSED); the previous server died without unlinking (#1225)",
                socket.display()
            );
            true
        }
        Err(err) => {
            tracing::warn!(
                "tmux socket {} has no listener but could not be removed: {err}",
                socket.display()
            );
            false
        }
    }
}

/// tmux is unix-only; elsewhere there is no unix socket to heal.
#[cfg(not(unix))]
pub fn heal_stale_socket(_socket: &Path) -> bool {
    false
}

/// Resolve the socket path, create its directory, and install the result as the
/// process-wide tmux addressing. Call once at startup, before any tmux use.
///
/// `configured` is the agent config's `tmux_socket_path`. Resolution order and
/// the default are documented on [`nession_common::tmux_socket`].
///
/// Returns the socket path so the caller can log it — a user who needs to
/// attach by hand has to know it.
///
/// Errors if the directory cannot be created or the path is too long for a unix
/// socket. It never falls back to another location: falling back is what put
/// nession's sessions on the user's socket in the first place.
pub fn configure(configured: Option<&str>) -> Result<PathBuf> {
    let socket = tmux_socket::resolve_socket_path(configured);
    tmux_socket::prepare_socket_dir(&socket)
        .with_context(|| format!("failed to prepare tmux socket {}", socket.display()))?;
    // The server configuration, written before any tmux command can start a
    // server — which is the only moment tmux reads it.
    write_server_config(&socket)?;
    // Startup is the one moment nothing of ours can be listening yet, so a
    // socket file that survived a crashed server is healed here rather than
    // after the first user-facing failure (#1225).
    heal_stale_socket(&socket);

    let cmd = TmuxCmd::new("tmux", socket.clone());
    if let Err(existing) = GLOBAL.set(cmd) {
        // Already configured — only possible if a tmux command ran before this
        // call (lazy init) or configure() was called twice. Both are bugs in
        // startup ordering, and silently keeping the old value would leave
        // sessions on a socket the operator did not configure.
        let existing = existing.socket_path().to_path_buf();
        if existing != socket {
            anyhow::bail!(
                "tmux socket already set to {} — cannot reconfigure to {}; \
                 configure() must run before any tmux command",
                existing.display(),
                socket.display()
            );
        }
    }
    Ok(socket)
}

/// The process-wide tmux addressing.
///
/// Falls back to lazy resolution (env var, then the documented default) when
/// [`configure`] has not run — which is the case in tests and in short-lived
/// CLI paths. The fallback still yields nession's own socket, never tmux's
/// default one, so it is safe rather than merely convenient. It does not create
/// the socket directory; tmux reports a clear "error creating" if it is absent.
pub fn global() -> &'static TmuxCmd {
    GLOBAL.get_or_init(|| {
        let cmd = TmuxCmd::new("tmux", tmux_socket::resolve_socket_path(None));
        // Install the server configuration here too, and not only in
        // [`configure`]. `-f` is read when tmux *starts a server*, so a file
        // written after that has no effect on the server that is already up —
        // which makes "who got there first" decide the depth. Production runs
        // `configure()` at startup, before any tmux command; this path is the
        // one tests and the short-lived CLI take, and it has to reach the same
        // state before its own first tmux command.
        //
        // BestEffort: a socket directory that cannot be written is a state
        // `configure()` reports and this one has no caller to report to. A
        // missing file is harmless — tmux tolerates `-f` naming nothing.
        let _ = write_server_config(cmd.socket_path());
        // Same heal as `configure()`, for the same reason: the lazy path is
        // the one tests and the short-lived CLI take, and a stale socket
        // fails them identically (#1225).
        heal_stale_socket(cmd.socket_path());
        cmd
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `global()` initialises the shared OnceLock, so tests that must not
    /// disturb it build their own instance.
    fn probe(socket: &str) -> TmuxCmd {
        TmuxCmd::new("tmux", socket)
    }

    #[test]
    fn tokio_command_carries_the_socket_flag() {
        let cmd = probe("/tmp/nession-probe/tmux.sock").tokio();
        let rendered = format!("{:?}", cmd.as_std());
        assert!(rendered.contains("-S"), "missing -S: {rendered}");
        assert!(
            rendered.contains("/tmp/nession-probe/tmux.sock"),
            "missing socket path: {rendered}"
        );
        // The server config rides every invocation; see `apply_addressing` for
        // why it has to be on whichever one starts the server.
        assert!(rendered.contains("-f"), "missing -f: {rendered}");
        assert!(
            rendered.contains("nession.conf"),
            "missing server config path: {rendered}"
        );
    }

    #[test]
    fn the_server_config_sits_beside_the_socket() {
        // Same directory, so it inherits the 0700 the socket directory already
        // gets and shares its lifetime. A config somewhere else would be a
        // second location to keep in step with the socket.
        assert_eq!(
            server_config_path(Path::new("/tmp/nession-probe/tmux.sock")),
            PathBuf::from("/tmp/nession-probe/nession.conf")
        );
    }

    #[test]
    fn the_server_config_carries_the_history_depth() {
        // The one setting, and it is the value the bootstrap asks for later —
        // two spellings of it would be two answers to one question.
        assert_eq!(
            server_config_contents(),
            format!("set -g history-limit {HISTORY_LIMIT_LINES}\n")
        );
    }

    #[test]
    fn configuring_writes_the_server_config() {
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("tmux.sock");
        std::fs::create_dir_all(dir.path()).expect("mkdir");

        write_server_config(&socket).expect("write");

        let written = std::fs::read_to_string(dir.path().join("nession.conf"))
            .expect("the config is beside the socket");
        assert_eq!(written, server_config_contents());

        // Rewritten, not create-if-missing: an agent upgraded over a
        // PVC-backed directory must not keep a previous version's file — the
        // failure the image's `/root/.tmux.conf` has.
        std::fs::write(dir.path().join("nession.conf"), "set -g history-limit 1\n")
            .expect("pre-write a stale config");
        write_server_config(&socket).expect("rewrite");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("nession.conf")).expect("read"),
            server_config_contents(),
            "a stale config must be replaced, not preserved"
        );
    }

    #[test]
    fn std_command_carries_the_socket_flag() {
        let cmd = probe("/tmp/nession-probe/tmux.sock").std();
        let rendered = format!("{cmd:?}");
        assert!(rendered.contains("-S"), "missing -S: {rendered}");
        assert!(
            rendered.contains("/tmp/nession-probe/tmux.sock"),
            "missing socket path: {rendered}"
        );
    }

    #[test]
    fn pty_command_carries_the_socket_flag() {
        // The portable-pty builder is a distinct API from std/tokio Command;
        // asserting on it separately is what keeps pty.rs from drifting back to
        // a bare `CommandBuilder::new("tmux")`.
        let cmd = probe("/tmp/nession-probe/tmux.sock").pty();
        let rendered = format!("{cmd:?}");
        assert!(rendered.contains("-S"), "missing -S: {rendered}");
        assert!(
            rendered.contains("/tmp/nession-probe/tmux.sock"),
            "missing socket path: {rendered}"
        );
    }

    #[test]
    fn pty_command_pins_term_for_the_client() {
        // A PTY attach child that inherits no usable $TERM (CI runners,
        // docker/systemd agents) makes tmux fail with "terminal does not
        // support clear" (#633). The pty builder pins TERM=xterm-256color —
        // the same value manager.rs forces when creating a session — so
        // attach works regardless of what the agent process inherited.
        //
        // The third assertion checks `is_from_base_env: false`: portable-pty
        // copies the whole process environment into the builder, so a plain
        // `contains("TERM")` would pass on developer shells that happen to
        // export TERM=xterm-256color already. Only an explicit override
        // (the fix) survives on a TERM-less agent.
        let rendered = format!("{:?}", probe("/tmp/nession-probe/tmux.sock").pty());
        assert!(
            rendered.contains("TERM"),
            "TERM should be pinned on the pty builder: {rendered}"
        );
        assert!(
            rendered.contains("xterm-256color"),
            "TERM should be pinned to xterm-256color: {rendered}"
        );
        assert!(
            rendered.contains("is_from_base_env: false"),
            "the TERM pin must be an explicit override, not an inherited value: {rendered}"
        );
    }

    #[test]
    fn commands_drop_inherited_tmux_env() {
        // An inherited $TMUX points at another server. tmux ignores TMUX_TMPDIR
        // whenever $TMUX is set (#574), so the two travel together.
        let tokio_rendered = format!(
            "{:?}",
            probe("/tmp/nession-probe/tmux.sock").tokio().as_std()
        );
        for var in INHERITED_TMUX_VARS {
            assert!(
                tokio_rendered.contains(var),
                "{var} should appear as a removal entry: {tokio_rendered}"
            );
        }
    }

    #[test]
    fn socket_path_and_bin_are_readable() {
        let cmd = probe("/tmp/nession-probe/tmux.sock");
        assert_eq!(cmd.bin(), "tmux");
        assert_eq!(cmd.socket_path(), Path::new("/tmp/nession-probe/tmux.sock"));
    }

    #[test]
    fn with_bin_swaps_the_binary_and_keeps_the_socket() {
        let cmd = probe("/tmp/nession-probe/tmux.sock").with_bin("/nonexistent/fake-tmux");
        assert_eq!(cmd.bin(), "/nonexistent/fake-tmux");
        assert_eq!(cmd.socket_path(), Path::new("/tmp/nession-probe/tmux.sock"));
    }

    #[test]
    fn global_addresses_nession_own_socket_not_tmux_default() {
        // The safety property of the lazy fallback: even with no configure()
        // call and no env var, the socket is nession's, so a stray command
        // cannot reach the user's sessions.
        let socket = global().socket_path();
        assert!(
            socket.to_string_lossy().contains("nession"),
            "fallback socket must be nession's own: {}",
            socket.display()
        );
        assert_ne!(socket.file_name().and_then(|n| n.to_str()), Some("default"));
    }

    #[test]
    fn global_is_stable_across_calls() {
        assert_eq!(global().socket_path(), global().socket_path());
    }

    // ── stale-socket healing (#1225) ─────────────────────────────────────────

    /// A dead server's leftover, without a server: a bound-then-dropped
    /// listener leaves the socket file on disk, and `connect` on it answers
    /// `ECONNREFUSED` — the kernel's "nothing is listening", on Linux and
    /// macOS alike.
    ///
    /// The drop alone does not settle the fixture: this test binary forks
    /// children constantly (shim installs, spawns under test), and a child
    /// forked in the bind→drop window inherits the listening fd, keeping the
    /// endpoint alive until its `exec` closes it (`CLOEXEC`) — a `connect` in
    /// that window *succeeds* (measured: 2 in 5 full-suite runs on macOS).
    /// Poll until the kernel's answer is the stable one; once every inherited
    /// copy has exec'd away there is no listener left to inherit, so the
    /// refusal is permanent.
    #[cfg(unix)]
    fn dead_socket(path: &Path) {
        drop(std::os::unix::net::UnixListener::bind(path).expect("bind a listener"));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match std::os::unix::net::UnixStream::connect(path) {
                Err(err) if err.kind() == std::io::ErrorKind::ConnectionRefused => return,
                other if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                    drop(other);
                }
                other => panic!("the dead socket never settled to ECONNREFUSED: {other:?}"),
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn heal_removes_a_socket_no_one_listens_on() {
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("tmux.sock");
        dead_socket(&socket);

        assert!(heal_stale_socket(&socket), "a refused socket must heal");
        assert!(
            !socket.exists(),
            "and the file must be gone — it was blocking every call"
        );
    }

    #[cfg(unix)]
    #[test]
    fn heal_never_touches_a_live_server() {
        // The #574/#575 guard: deleting a serving socket takes a live server
        // off addressing. A listener held open answers connect(2) with
        // success, and the file must survive untouched.
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("tmux.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&socket).expect("bind");

        assert!(!heal_stale_socket(&socket), "a live socket is not stale");
        assert!(socket.exists(), "the live server's socket is left alone");
    }

    #[cfg(unix)]
    #[test]
    fn heal_ignores_a_file_that_is_not_a_socket() {
        // `connect` on a regular file also answers ECONNREFUSED, so the
        // is-socket check is the only thing standing between the heal and
        // deleting a file that was never tmux's.
        let dir = tempfile::tempdir().expect("tempdir");
        let not_a_socket = dir.path().join("tmux.sock");
        std::fs::write(&not_a_socket, b"not a socket").expect("write");

        assert!(!heal_stale_socket(&not_a_socket));
        assert_eq!(
            std::fs::read(&not_a_socket).expect("the file must survive"),
            b"not a socket"
        );
    }

    #[cfg(unix)]
    #[test]
    fn heal_ignores_a_missing_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(!heal_stale_socket(&dir.path().join("tmux.sock")));
    }

    /// The fake answers `server exited unexpectedly` while the socket file
    /// exists and succeeds once it is gone — the two arms of one heal cycle.
    #[cfg(unix)]
    fn stale_then_gone_script(socket: &Path) -> String {
        format!(
            "if [ -S \"{}\" ]; then echo 'server exited unexpectedly' >&2; exit 1; fi\n\
             printf 'healed-ok\\n'",
            socket.display()
        )
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_call_on_a_stale_socket_is_healed_and_retried_once() {
        // The #1225 cycle end to end: the first attempt fails the way tmux
        // fails against a dead server's file, the heal removes it, and the
        // retry — the same argv — succeeds. The mutation this reddens on is
        // dropping the retry: the result would be the first attempt's
        // failure, and `calls()` would hold one entry, not two.
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("tmux.sock");
        dead_socket(&socket);
        let fake = crate::test_support::FakeTmux::new(dir.path(), &stale_then_gone_script(&socket));
        let cmd = TmuxCmd::new(fake.bin(), &socket);

        let out = cmd
            .output(&["list-sessions"])
            .await
            .expect("the retry runs against a real process");

        assert!(
            out.status.success(),
            "the retried call succeeds: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            "healed-ok\n",
            "and it is the retry's answer, not the failure's"
        );
        assert_eq!(
            fake.calls(),
            vec![
                vec!["list-sessions".to_string()],
                vec!["list-sessions".to_string()]
            ],
            "failed once, healed, retried once — the same argv twice"
        );
        assert!(!socket.exists(), "the stale socket was removed");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_call_on_a_live_server_is_returned_unretried() {
        // The other half of the contract: a failure alone never deletes and
        // never retries. tmux's own refusals (`no such session`, a bad flag)
        // must reach the caller as tmux made them, or every failure would be
        // reported twice and a live server's socket would be at risk.
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("tmux.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&socket).expect("bind");
        let fake = crate::test_support::FakeTmux::new(
            dir.path(),
            "echo 'no such session: nope' >&2; exit 1",
        );
        let cmd = TmuxCmd::new(fake.bin(), &socket);

        let out = cmd.output(&["has-session"]).await.expect("spawned");

        assert!(!out.status.success(), "the failure is the caller's to see");
        assert_eq!(
            String::from_utf8_lossy(&out.stderr).trim(),
            "no such session: nope",
            "and it is tmux's own answer, not a retry's"
        );
        assert_eq!(
            fake.calls().len(),
            1,
            "a live server means no heal and no second attempt"
        );
        assert!(socket.exists(), "the live socket was not touched");
    }

    #[cfg(unix)]
    #[test]
    fn the_blocking_form_heals_and_retries_the_same_way() {
        // `output_blocking` is the `Drop`-path spelling of the same heal; a
        // shared predicate does not prove the std command path runs it.
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("tmux.sock");
        dead_socket(&socket);
        let fake = crate::test_support::FakeTmux::new(dir.path(), &stale_then_gone_script(&socket));
        let cmd = TmuxCmd::new(fake.bin(), &socket);

        let out = cmd.output_blocking(&["list-sessions"]).expect("spawned");

        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout), "healed-ok\n");
        assert_eq!(fake.calls().len(), 2, "one failure, one heal, one retry");
        assert!(!socket.exists());
    }
}
