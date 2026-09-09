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

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{Context, Result};
use nession_common::tmux_socket;

/// Environment variables that describe a tmux server we are not addressing.
/// Stripped from every child so behaviour never depends on inheritance.
const INHERITED_TMUX_VARS: [&str; 2] = ["TMUX", "TMUX_TMPDIR"];

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

    /// A `tokio::process::Command` for `tmux -S <socket>`.
    pub fn tokio(&self) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new(&self.bin);
        cmd.arg("-S").arg(&self.socket);
        for var in INHERITED_TMUX_VARS {
            cmd.env_remove(var);
        }
        cmd
    }

    /// A `std::process::Command` for `tmux -S <socket>`, for the synchronous
    /// call sites (`Drop`, which cannot await).
    pub fn std(&self) -> std::process::Command {
        let mut cmd = std::process::Command::new(&self.bin);
        cmd.arg("-S").arg(&self.socket);
        for var in INHERITED_TMUX_VARS {
            cmd.env_remove(var);
        }
        cmd
    }

    /// A `portable_pty::CommandBuilder` for `tmux -S <socket>`.
    ///
    /// portable-pty has its own command type, so this cannot reuse
    /// [`TmuxCmd::std`] — the PTY attach path needs its own constructor rather
    /// than a mechanical substitution.
    pub fn pty(&self) -> portable_pty::CommandBuilder {
        let mut cmd = portable_pty::CommandBuilder::new(&self.bin);
        cmd.arg("-S");
        cmd.arg(&self.socket);
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
    GLOBAL.get_or_init(|| TmuxCmd::new("tmux", tmux_socket::resolve_socket_path(None)))
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
}
