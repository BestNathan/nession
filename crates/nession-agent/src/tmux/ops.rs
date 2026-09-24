//! The tmux **semantic** boundary: the one place this crate encodes what a
//! reusable tmux *operation* means.
//!
//! [`TmuxCmd`] owns *process addressing* — which binary, which socket, and the
//! `TMUX`/`TMUX_TMPDIR` stripping that keeps a child process from describing
//! some other server. It says nothing about *grammar*, and that gap is not
//! theoretical. One capability (`set-environment`) was written twice: once in
//! `manager.rs`, correctly, and once in `env.rs`, where the copy invented
//! `set-environment -t <session> -e KEY=VALUE`. `-e` is `new-session`'s flag and
//! a joined `KEY=VALUE` is not a variable name, so tmux refused every call,
//! every variable it was asked for went unset, and every caller reported
//! success (#980).
//!
//! So this module owns the operation and its argument vector. Nothing else does:
//!
//! ```text
//! TmuxCmd                                       = process / socket boundary
//! TmuxOps                                       = tmux semantic boundary
//! SessionManager / EnvManager / attach backends = Nession domain boundary
//! ```
//!
//! ## What it deliberately does not offer
//!
//! There is **no `run(args: &[&str])`**. A generic argv runner would leave the
//! grammar with the caller — `-e` would still be writable, just from one more
//! place — and the point of the boundary is that a caller *cannot express* the
//! wrong shape. The operations below take typed parameters and build a private,
//! fixed-arity argument vector, so there is nowhere for `-e` to come from.
//!
//! ## What it deliberately does not decide
//!
//! Result *policy* belongs to the caller, because it is a property of the call
//! and not of the operation. The same `set-environment` is `Required` when a
//! user asked for those variables ([`EnvManager::set_environment`]) and
//! `BestEffort` when it propagates an environment an earlier stage already
//! established to windows that do not exist yet
//! ([`SessionManager::create_session`](super::manager::SessionManager)). So
//! every operation here returns its failure and none of them swallows one; a
//! caller choosing `BestEffort` has to say so, and it says it in its own code
//! where a reader can see it.
//!
//! ## What is deliberately not here: control-mode command lines
//!
//! `control.rs` writes `send-keys … -H <hex>` and `resize-window …` to an
//! attached control-mode client's **stdin** rather than spawning anything. That
//! is tmux grammar too, and it is a *different operation* from the argv
//! [`TmuxOps::send_keys`] below — different flag, different payload encoding
//! (raw bytes rather than key names), different transport. It cannot become an
//! operation here as things stand either, because an operation's one guarantee
//! is that it returns the failure it caused, and that transport has no failure
//! to return: nothing is spawned, so there is no exit status, no stderr, and
//! tmux's answer to a bad line arrives asynchronously on the same pipe the
//! output comes back on. One `send_keys` covering both would be one name for
//! two incompatible result semantics. It is also the same shape as
//! `resize-window`, which #991 assigns to its step 8 — so that transport's seam
//! gets designed once both shapes are known, not from the first of them.
//!
//! [`TmuxCmd`]: super::cmd::TmuxCmd
//! [`EnvManager::set_environment`]: super::env::EnvManager::set_environment

use anyhow::{Context, Result};

use super::cmd::{self, TmuxCmd};

/// tmux's own words for "this session does not hold that variable".
///
/// `show-environment <name>` exits 1 both when the variable is unset and when
/// the session does not exist — measured on tmux 3.6b, both messages on stderr:
///
/// ```text
/// $ tmux -S <sock> show-environment -t probe NESSION_MISSING
/// unknown variable: NESSION_MISSING                            (exit 1)
/// $ tmux -S <sock> show-environment -t nope NESSION_A
/// no such session: nope                                        (exit 1)
/// ```
///
/// The exit status alone therefore cannot tell "it is not there" from "I could
/// not look", and only this message separates them. Matching on tmux's wording
/// is a cost, paid in the safe direction: a later tmux that rewords it turns the
/// answer into an `Err` — loud — instead of a `None` claiming a variable is
/// unset when nobody managed to ask.
const UNKNOWN_VARIABLE: &str = "unknown variable";

/// The argument vector for one `set-environment`, in the order tmux receives it.
///
/// Both halves of #980 are properties of this array and of nothing else:
///
/// - there is no `-e`. That flag belongs to `new-session`; `set-environment`
///   answers `unknown flag -e` (exit 1, measured on tmux 3.6b).
/// - `name` and `value` are **two entries**. `set-environment` takes
///   `name [value]`, so a joined `KEY=VALUE` is not a variable name at all:
///   tmux answers `variable name contains =` (exit 1, measured).
///
/// Separate entries are also what keeps a value intact: one containing spaces,
/// quotes or `=` arrives as the single argv value the caller passed, and nothing
/// here reconstructs it into `KEY=VALUE`. Measured on tmux 3.6b: a value of `-x`
/// is taken as the value and not as a flag, because the argument parser stops
/// reading flags at the first non-flag argument (`name`).
///
/// The arity is part of the type — a sixth entry cannot be appended without
/// changing this signature.
fn set_environment_args<'a>(session: &'a str, name: &'a str, value: &'a str) -> [&'a str; 5] {
    ["set-environment", "-t", session, name, value]
}

/// The argument vector for one `show-environment`.
///
/// `show-environment [-g] [-h] [-s] [-t target-session] name` — one `name`, and
/// `-t` is what binds the answer to the session that was asked about. It is not
/// decoration: measured on tmux 3.6b with two sessions on one socket, a
/// target-less query answered out of a session the caller never named, and
/// reported `unknown variable` for a variable the other one held.
fn show_environment_args<'a>(session: &'a str, name: &'a str) -> [&'a str; 4] {
    ["show-environment", "-t", session, name]
}

/// The value half of the one `NAME=VALUE` line `show-environment` prints.
///
/// `split_once` rather than a split on every `=`: tmux prints the variable name
/// and then whatever the value holds, and a value may contain `=`. tmux
/// constructs the line, so nothing here reconstructs `KEY=VALUE` either.
///
/// `None` when the line holds no `=` at all — tmux answered successfully with
/// something that is not the line it documents.
fn value_from_line(line: &str) -> Option<String> {
    line.split_once('=').map(|(_, value)| value.to_string())
}

/// The format the window-size query asks tmux for.
///
/// Both dimensions in one format, because they are one round trip either way
/// and two queries could answer out of two different moments — a window
/// resized in between would report a width and a height that never coexisted.
/// It is a const so a caller cannot ask for half a size.
const WINDOW_SIZE_FORMAT: &str = "#{window_width} #{window_height}";

/// The argument vector for one window-size query.
///
/// `display-message [-p] [-t target-pane] [format]`. `-p` is what makes tmux
/// print the expansion to stdout instead of writing it into a status line, and
/// `-t` is what binds the answer to the session that was asked about — without
/// it tmux resolves a target of its own choosing (measured on 3.6b: with two
/// sessions on one socket, a target-less query answered out of one the caller
/// never named).
///
/// The arity is part of the type, like [`set_environment_args`]'s: a second
/// format entry cannot be appended without changing this signature.
fn window_size_args(session: &str) -> [&str; 5] {
    ["display-message", "-p", "-t", session, WINDOW_SIZE_FORMAT]
}

/// Parse the `"<cols> <rows>"` line [`TmuxOps::window_size`] asks for.
///
/// Whitespace-separated rather than a fixed split, because that is what tmux's
/// word is: it prints the two numbers and a newline. Extra trailing fields are
/// ignored, and a missing or unparseable dimension is an error rather than a
/// default — a call site that wants a default has to supply one, which is how
/// `capture_scrollback`'s 80×24 stays visible in `util.rs` beside the call it
/// belongs to.
fn size_from_line(line: &str) -> Result<(u16, u16)> {
    let mut parts = line.split_whitespace();
    let cols = parts
        .next()
        .with_context(|| format!("no width in {line:?}"))?
        .parse::<u16>()
        .with_context(|| format!("width in {line:?} is not a number"))?;
    let rows = parts
        .next()
        .with_context(|| format!("no height in {line:?}"))?
        .parse::<u16>()
        .with_context(|| format!("height in {line:?} is not a number"))?;
    Ok((cols, rows))
}

/// The argument vector for one line typed into a session:
/// `send-keys -t <session> <keys> Enter`.
///
/// `keys` is ONE entry, so a line containing spaces arrives as the single
/// argument the caller passed and nothing here splits it into key names. `Enter`
/// is the last of the fixed five, so pressing it cannot be forgotten at a call
/// site and cannot drift out of the grammar.
fn send_keys_args<'a>(session: &'a str, keys: &'a str) -> [&'a str; 5] {
    ["send-keys", "-t", session, keys, "Enter"]
}

/// The query that resolves a client's name from the process that owns it.
///
/// `detach-client -t` takes a **client** target, and a session name is not one
/// — measured on tmux 3.6b: `detach-client -t <session>` answers `can't find
/// client: <session>` with exit 1 and detaches nothing, which is why every
/// teardown that named a session had been a no-op since it was written
/// (#1011). tmux does record the pid of the process that attached, and
/// `#{client_pid}` is the `tmux attach` process this backend spawned, so the
/// client we own is the one carrying our child's pid. `-s <session>` would be
/// the wrong repair: it detaches *every* client of the session, including one
/// a user attached by hand.
fn list_clients_args() -> [&'static str; 3] {
    ["list-clients", "-F", "#{client_pid} #{client_name}"]
}

/// Detach one client, by name — see [`list_clients_args`] for why the name and
/// not the session. Fixed arity, so a caller cannot drop the target and detach
/// the current client by accident.
fn detach_client_args(client: &str) -> [&str; 3] {
    ["detach-client", "-t", client]
}

/// The client name on the line whose pid is `pid`, from a
/// [`list_clients_args`] listing. `None` means no client carries that pid.
///
/// Parsing lives here rather than at the call sites so the `-F` format and the
/// reading of it cannot drift apart — a listing read with the wrong shape finds
/// nothing and looks exactly like "the client is already gone".
fn client_name_for_pid_in(listing: &[u8], pid: u32) -> Option<String> {
    String::from_utf8_lossy(listing).lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        let line_pid = fields.next()?.parse::<u32>().ok()?;
        let name = fields.next()?;
        (line_pid == pid).then(|| name.to_string())
    })
}

/// The tmux semantic owner: typed operations over one [`TmuxCmd`].
#[derive(Debug, Clone)]
pub struct TmuxOps {
    cmd: TmuxCmd,
}

impl TmuxOps {
    /// Bind the operations to a specific process addressing.
    pub fn new(cmd: TmuxCmd) -> Self {
        Self { cmd }
    }

    /// The operations bound to the process-wide tmux addressing — how a call
    /// site with no injected [`TmuxCmd`] reaches the owner, mirroring
    /// [`cmd::global`]'s accessor shape.
    ///
    /// It resolves [`cmd::global`] on **every** call rather than caching it. A
    /// second `OnceLock` here would freeze whichever socket happened to be
    /// current the first time an operation ran; if that ran before
    /// [`cmd::configure`](super::cmd::configure), the process would keep
    /// addressing the *fallback* socket for its whole life, and `configure`'s
    /// already-set check compares against `cmd::global()`, so it could not see
    /// it. A `TmuxCmd` is a `String` and a `PathBuf`, which is nothing beside
    /// the process spawn that follows.
    pub fn global() -> Self {
        Self::new(cmd::global().clone())
    }

    /// Set one environment variable on a session's tmux environment:
    /// `tmux set-environment -t <session> <name> <value>`.
    ///
    /// Whether a failure is `Required` or `BestEffort` is the caller's decision
    /// — see the module docs. This returns it either way, carrying tmux's own
    /// stderr, because `variable name contains =` and `no such session: …` are
    /// different problems and a summary that dropped the difference is what made
    /// #980 unreadable even in the logs that had it.
    pub async fn set_environment(&self, session: &str, name: &str, value: &str) -> Result<()> {
        let output = self
            .cmd
            .tokio()
            .args(set_environment_args(session, name, value))
            // Deliberately not `stderr(Stdio::null())`: tmux's message is the
            // only thing that says *why* a mutation failed.
            .stderr(std::process::Stdio::piped())
            .output()
            .await
            .with_context(|| {
                format!("failed to spawn tmux set-environment for {name} on session {session}")
            })?;
        if output.status.success() {
            return Ok(());
        }
        anyhow::bail!(
            "tmux set-environment -t {session} {name} failed: {} ({})",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )
    }

    /// What tmux holds for `name` in `session`: the value, `Ok(None)` when the
    /// session holds nothing under that name, `Err` when the question could not
    /// be asked at all.
    ///
    /// Read back after a mutation, this is the only thing that distinguishes
    /// "the variable was set" from "nothing was set and everything reported
    /// success" — which is what #980 was, and why `set_environment` alone could
    /// not have caught it.
    ///
    /// Only the trailing newline is stripped from tmux's line: tmux preserves
    /// leading and trailing whitespace inside a value (measured on tmux 3.6b —
    /// `set-environment -t p K 'v '` reads back as `K=v \n`), so a `trim()`
    /// here would answer with a value the caller never wrote.
    pub async fn show_environment(&self, session: &str, name: &str) -> Result<Option<String>> {
        let output = self
            .cmd
            .tokio()
            .args(show_environment_args(session, name))
            .stderr(std::process::Stdio::piped())
            .output()
            .await
            .with_context(|| {
                format!("failed to spawn tmux show-environment for {name} on session {session}")
            })?;

        let stderr = String::from_utf8_lossy(&output.stderr);
        if !output.status.success() {
            if stderr.contains(UNKNOWN_VARIABLE) {
                return Ok(None);
            }
            anyhow::bail!(
                "tmux show-environment -t {session} {name} failed: {} ({})",
                output.status,
                stderr.trim()
            );
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let line = stdout.trim_end_matches(['\r', '\n']);
        value_from_line(line).map(Some).with_context(|| {
            format!(
                "tmux show-environment -t {session} {name} printed no NAME=VALUE line: {line:?}"
            )
        })
    }

    /// The current size of `session`'s active window, as tmux reports it:
    /// `tmux display-message -p -t <session> '#{window_width} #{window_height}'`.
    ///
    /// This was written twice before #991 — `util.rs` asked
    /// `-t <session> -p <format>` and fell back to 80×24 per dimension on any
    /// failure, `server/websocket.rs` asked `-p -t <session> <format>` and
    /// errored. Same query, two encodings, two policies. The query and its
    /// parse are here now; each caller keeps the policy it had, at its own call
    /// site (see the module docs).
    ///
    /// **A target that does not exist is not a non-zero exit.** Measured on
    /// tmux 3.6b against a live server: `display-message -p -t nope '<fmt>'`
    /// exits **0** and prints an empty line, because the format expands to
    /// nothing. So the parse is what fails, and this returns `Err` for it —
    /// which is what lets the `BestEffort` caller fall back to its default and
    /// keeps the `Required` caller from reading an empty answer as a size.
    pub async fn window_size(&self, session: &str) -> Result<(u16, u16)> {
        let output = self
            .cmd
            .tokio()
            .args(window_size_args(session))
            .stderr(std::process::Stdio::piped())
            .output()
            .await
            .with_context(|| format!("failed to spawn tmux display-message for {session}"))?;
        if !output.status.success() {
            anyhow::bail!(
                "tmux display-message -p -t {session} failed: {} ({})",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let line = stdout.trim_end_matches(['\r', '\n']);
        size_from_line(line).with_context(|| {
            format!("tmux display-message -p -t {session} answered no window size")
        })
    }

    /// Type one line into `session`'s active pane and press Enter:
    /// `tmux send-keys -t <session> <keys> Enter`.
    ///
    /// The `Enter` is part of the operation, not of the caller's argument,
    /// because every call site wants it: the line is a shell command and a line
    /// that is never submitted is not the operation anyone asked for.
    ///
    /// This is the **argv** form — a subprocess, whose exit status and stderr
    /// are the failure this returns. A control-mode client's `send-keys -H` is a
    /// different operation over a different transport and is deliberately not
    /// this; see the module docs for why it is not unified with it.
    ///
    /// Both halves of what changed when this moved: the argument vector is now
    /// built once, in [`send_keys_args`], instead of at the two call sites that
    /// each wrote it; and a failure now carries tmux's own stderr, where the
    /// `util::send_keys` it replaces discarded it (`Stdio::null()`) and
    /// reported only the session name (#991: a required failure retains useful
    /// tmux context). No caller's *class* changed — `EnvManager` still
    /// propagates, `SessionManager`'s legacy stage 2 still ignores.
    pub async fn send_keys(&self, session: &str, keys: &str) -> Result<()> {
        let output = self
            .cmd
            .tokio()
            .args(send_keys_args(session, keys))
            .stderr(std::process::Stdio::piped())
            .output()
            .await
            .with_context(|| format!("failed to spawn tmux send-keys for session {session}"))?;
        if output.status.success() {
            return Ok(());
        }
        anyhow::bail!(
            "tmux send-keys -t {session} failed: {} ({})",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )
    }

    /// Detach the tmux client owned by `pid` — the one this backend spawned.
    ///
    /// `Ok(true)` means a client carried that pid and was detached.
    /// **`Ok(false)` means no client does, and is not a failure**: the client
    /// is already gone, so there is nothing left to detach. `Err` means the
    /// question could not be asked at all — tmux missing, server unreachable —
    /// and carries tmux's own words.
    ///
    /// The call sites classify all of this `Cleanup`, so the distinction is not
    /// about propagation: `Ok(false)` is the ordinary "already finished" answer
    /// and an `Err` is the one worth a line in a log. Collapsing them into a
    /// bare `let _ =` is what let the previous, session-targeted form stay
    /// invisible for as long as it did (#1011).
    pub async fn detach_client_by_pid(&self, pid: u32) -> Result<bool> {
        let Some(client) = self.client_name_for_pid(pid).await? else {
            return Ok(false);
        };
        let output = self
            .cmd
            .tokio()
            .args(detach_client_args(&client))
            .stderr(std::process::Stdio::piped())
            .output()
            .await
            .with_context(|| format!("failed to spawn tmux detach-client for {client}"))?;
        if output.status.success() {
            return Ok(true);
        }
        anyhow::bail!(
            "tmux detach-client -t {client} failed: {} ({})",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )
    }

    /// [`detach_client_by_pid`](Self::detach_client_by_pid) for a caller that
    /// cannot await. `Drop` is why this exists.
    ///
    /// The same operation on the blocking [`TmuxCmd::std`] builder, not a
    /// second grammar: both reach [`detach_client_args`] and
    /// [`client_name_for_pid_in`]. Only the spawn differs, which is the
    /// `std`/`tokio` duality [`TmuxCmd`] already carries.
    pub fn detach_client_by_pid_blocking(&self, pid: u32) -> Result<bool> {
        let Some(client) = self.client_name_for_pid_blocking(pid)? else {
            return Ok(false);
        };
        let output = self
            .cmd
            .std()
            .args(detach_client_args(&client))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .with_context(|| format!("failed to spawn tmux detach-client for {client}"))?;
        if output.status.success() {
            return Ok(true);
        }
        anyhow::bail!(
            "tmux detach-client -t {client} failed: {} ({})",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )
    }

    /// The name of the client whose process is `pid`; `None` when no client
    /// carries it.
    async fn client_name_for_pid(&self, pid: u32) -> Result<Option<String>> {
        let output = self
            .cmd
            .tokio()
            .args(list_clients_args())
            .stderr(std::process::Stdio::piped())
            .output()
            .await
            .with_context(|| format!("failed to spawn tmux list-clients to resolve pid {pid}"))?;
        if !output.status.success() {
            anyhow::bail!(
                "tmux list-clients failed: {} ({})",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(client_name_for_pid_in(&output.stdout, pid))
    }

    /// [`client_name_for_pid`](Self::client_name_for_pid) on the blocking
    /// builder.
    fn client_name_for_pid_blocking(&self, pid: u32) -> Result<Option<String>> {
        let output = self
            .cmd
            .std()
            .args(list_clients_args())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .with_context(|| format!("failed to spawn tmux list-clients to resolve pid {pid}"))?;
        if !output.status.success() {
            anyhow::bail!(
                "tmux list-clients failed: {} ({})",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(client_name_for_pid_in(&output.stdout, pid))
    }
}

/// The tmux **dependency** a domain type runs on: one [`TmuxCmd`], from which
/// the semantic owner is derived.
///
/// This is the seam #991's step 6 exists for. Before it, every type that was
/// not [`SessionManager`](super::manager::SessionManager) reached
/// [`cmd::global`] itself — `EnvManager` for `set-environment` and
/// `clear-history`, `PtySession`/`ControlModeSession` for `attach` and
/// `detach-client` — so substituting a fake tmux binary covered
/// `SessionManager` alone, and the operations those types performed could only
/// be exercised against the real tmux on a real socket.
///
/// Both halves are substitutions of one thing: a domain type holds a `TmuxDep`,
/// a test hands in one built with [`TmuxDep::injected`], and every operation the
/// type performs — process addressing *and* the grammar [`TmuxOps`] derives from
/// it — follows. Nothing in a holder of this resolves the process-wide
/// addressing behind its own back.
///
/// It is not the whole crate's seam yet, and the remainder is deliberate:
/// [`util`](super::util)'s capture and availability helpers
/// (`capture_scrollback`, `check_tmux_available`, `tmux_version`) take no
/// dependency and still resolve [`cmd::global`], because they are stateless
/// functions on the capture/preview and startup paths rather than operations of
/// a domain type. `run_tmux_command`, which an attach *does* call, takes one.
///
/// A `TmuxDep` built with [`TmuxDep::global`] resolves [`cmd::global`] on
/// **every** use rather than once, which is the property [`TmuxOps::global`]
/// documents: a value frozen before [`cmd::configure`](super::cmd::configure)
/// would pin the process to the fallback socket for its whole life, and
/// `configure`'s already-set check compares against `cmd::global()`, so it
/// could not see that it had been bypassed. The injected arm is the one that is
/// fixed by construction — that is what injecting means.
#[derive(Debug, Clone)]
pub struct TmuxDep(Option<TmuxCmd>);

impl TmuxDep {
    /// The process-wide addressing, resolved per use.
    pub fn global() -> Self {
        Self(None)
    }

    /// Exactly this addressing — what a test hands in so that one fake tmux
    /// binary covers every operation in the path.
    pub fn injected(cmd: TmuxCmd) -> Self {
        Self(Some(cmd))
    }

    /// The process addressing to build a command on — what a caller needs for
    /// the subcommands that are not (yet) operations here.
    pub fn cmd(&self) -> TmuxCmd {
        self.0.clone().unwrap_or_else(|| cmd::global().clone())
    }

    /// The semantic owner bound to that addressing.
    pub fn ops(&self) -> TmuxOps {
        TmuxOps::new(self.cmd())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real tmux session on this run's harness socket, killed on drop.
    ///
    /// Created through `SessionManager` rather than by spelling `new-session`
    /// here: the point of these tests is that the owner's queries agree with
    /// the session the rest of the crate creates, and a test that built its own
    /// session could agree with itself and nothing else.
    async fn probe_session(prefix: &str) -> crate::test_support::TestSession {
        use super::super::manager::{SessionManager, SESSION_HEIGHT, SESSION_WIDTH};
        let guard = crate::test_support::TestSession::new(prefix);
        SessionManager::new()
            .create_session(guard.name(), SESSION_WIDTH, SESSION_HEIGHT, "/tmp", &[])
            .await
            .expect("create probe session");
        guard
    }

    #[test]
    fn set_environment_argv_splits_name_from_value() {
        // The two halves of #980 in one assertion: no `-e`, and `name`/`value`
        // as two entries rather than one joined `KEY=VALUE`.
        let argv = set_environment_args("sess", "KEY", "value");
        assert_eq!(argv, ["set-environment", "-t", "sess", "KEY", "value"]);
        assert!(
            !argv.contains(&"-e"),
            "`-e` is new-session's flag; set-environment refuses it: {argv:?}"
        );
        assert_eq!(argv.len(), 5, "arity is part of the grammar: {argv:?}");
        assert_ne!(
            argv[3], "KEY=value",
            "name and value must be two entries, not one joined KEY=VALUE: {argv:?}"
        );
    }

    #[test]
    fn set_environment_argv_keeps_a_value_intact() {
        // A value containing `=`, spaces and quotes is one argv entry. This is
        // what "passed as a separate argv value" means, and the `=` is the sharp
        // case: a joined `KEY=VALUE` would split it here rather than at tmux.
        for value in ["k=v=w", "a b  c", r#"he said "hi""#, "", "v "] {
            let argv = set_environment_args("sess", "KEY", value);
            assert_eq!(argv[4], value, "the value must arrive unchanged: {argv:?}");
            assert_eq!(
                argv[3], "KEY",
                "the name must not absorb the value: {argv:?}"
            );
        }
    }

    #[test]
    fn show_environment_argv_names_the_session_and_the_variable() {
        // Without `-t`, tmux resolves a session of its own choosing (measured on
        // 3.6b), so an answer can come from a session the caller never named.
        let argv = show_environment_args("sess", "KEY");
        assert_eq!(argv, ["show-environment", "-t", "sess", "KEY"]);
        assert!(
            argv.contains(&"-t"),
            "the target is what binds the answer to the session asked about: {argv:?}"
        );
        assert_eq!(argv.len(), 4, "arity is part of the grammar: {argv:?}");
    }

    #[test]
    fn value_from_line_splits_on_the_first_equals_only() {
        assert_eq!(value_from_line("K=v").as_deref(), Some("v"));
        assert_eq!(value_from_line("K=v=w").as_deref(), Some("v=w"));
        assert_eq!(value_from_line("K=").as_deref(), Some(""));
        assert_eq!(value_from_line("K= v ").as_deref(), Some(" v "));
        // A line with no `=` is not a value; the caller turns this into an error
        // rather than into an empty answer.
        assert_eq!(value_from_line("K"), None);
    }

    #[test]
    fn unknown_variable_is_recognized_as_the_unset_answer() {
        // The two non-zero answers tmux gives, as measured on 3.6b. Only the
        // first means "the session does not hold it"; the second must stay an
        // error, or a mistyped session name would read back as "unset".
        assert!("\nunknown variable: NESSION_MISSING\n".contains(UNKNOWN_VARIABLE));
        assert!(!"\nno such session: nope\n".contains(UNKNOWN_VARIABLE));
        assert!(!"\nno server running on /tmp/x/tmux.sock\n".contains(UNKNOWN_VARIABLE));
    }

    #[test]
    fn global_addresses_the_process_socket() {
        // `TmuxOps::global()` must inherit the process-wide addressing — a
        // second socket here would send an operation to a different tmux server
        // than the manager that created the session.
        assert_eq!(
            TmuxOps::global().cmd.socket_path(),
            cmd::global().socket_path()
        );
    }

    #[test]
    fn new_keeps_the_cmd_it_was_given() {
        // The constructor step 6 will use to hand the owner a substituted
        // `TmuxCmd`; without this the seam would exist but not bind.
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("probe.sock");
        let ops = TmuxOps::new(TmuxCmd::new("/nonexistent/fake-tmux", socket.clone()));
        assert_eq!(ops.cmd.socket_path(), socket.as_path());
        assert_eq!(ops.cmd.bin(), "/nonexistent/fake-tmux");
    }

    // ── the dependency, and the failure arms it makes reachable ──────────────

    #[test]
    fn a_dep_resolves_the_process_socket_until_it_is_injected() {
        // Two properties, and both are what a substituted binary depends on:
        // the default resolves the process-wide addressing (so a `TmuxDep`
        // passed by value through a domain type is not a second socket), and an
        // injected one keeps *both* halves of what was handed in. A seam that
        // reset the socket would make fake-tmux tests pass while proving
        // nothing about `-S`.
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("probe.sock");
        let injected = TmuxDep::injected(TmuxCmd::new("/nonexistent/fake-tmux", socket.clone()));
        assert_eq!(injected.cmd().bin(), "/nonexistent/fake-tmux");
        assert_eq!(injected.cmd().socket_path(), socket.as_path());

        assert_eq!(
            TmuxDep::global().cmd().socket_path(),
            cmd::global().socket_path(),
            "the default must address the process socket"
        );
        assert_eq!(
            TmuxDep::injected(TmuxCmd::new("tmux", socket.clone()))
                .ops()
                .cmd
                .socket_path(),
            socket.as_path(),
            "the owner an operation runs on must be built from the same addressing"
        );
    }

    #[tokio::test]
    async fn a_missing_binary_is_a_spawn_failure_not_a_silent_answer() {
        // The arm with no exit status to report: the binary does not exist, so
        // no process is ever spawned. It is a different failure from tmux
        // answering non-zero, and the message has to say which — a caller that
        // sees only "set-environment failed" cannot tell a refused flag from a
        // missing tmux.
        //
        // Covered through the owner's own addressing rather than through
        // `cmd::global()`: a test that reached the real binary here would not
        // reach this arm at all.
        let dir = tempfile::tempdir().expect("tempdir");
        let ops = TmuxOps::new(TmuxCmd::new(
            "/nonexistent/fake-tmux",
            dir.path().join("tmux.sock"),
        ));

        let set = format!(
            "{:#}",
            ops.set_environment("sess", "NESSON_SPAWN", "v")
                .await
                .expect_err("there is no binary to spawn")
        );
        assert!(
            set.contains("failed to spawn tmux set-environment"),
            "the failure must say the process never started: {set}"
        );
        assert!(
            set.contains("NESSON_SPAWN") && set.contains("sess"),
            "and it must name the variable and the session it was for: {set}"
        );

        let show = format!(
            "{:#}",
            ops.show_environment("sess", "NESSON_SPAWN")
                .await
                .expect_err("there is no binary to spawn")
        );
        assert!(
            show.contains("failed to spawn tmux show-environment"),
            "the query must fail the same way rather than answer `None`: {show}"
        );
        assert!(
            show.contains("NESSON_SPAWN") && show.contains("sess"),
            "and it must name the variable and the session it was asked about: {show}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn show_environment_refuses_an_answer_that_is_not_a_value() {
        // tmux exited 0 and printed something that is not the one `NAME=VALUE`
        // line it documents. `Ok(None)` here would say "the session does not
        // hold it", which is the answer a *successful* query gives — and the
        // caller cannot tell the two apart afterwards. The fake is what makes
        // the arm reachable: real tmux does not answer this way.
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = crate::test_support::FakeTmux::new(dir.path(), "printf 'not a value\\n'");

        let err = format!(
            "{:#}",
            fake.dep()
                .ops()
                .show_environment("sess", "NESSON_MALFORMED")
                .await
                .expect_err("a line with no `=` is not a value")
        );
        assert!(
            err.contains("printed no NAME=VALUE line"),
            "the failure must say what tmux answered instead: {err}"
        );
        assert!(
            err.contains("NESSON_MALFORMED") && err.contains("sess"),
            "and it must name the variable and the session it asked about: {err}"
        );
        assert_eq!(
            fake.calls(),
            vec![vec!["show-environment", "-t", "sess", "NESSON_MALFORMED"]],
            "the query must be the owner's grammar, run against the injected binary"
        );
    }

    // ── the window-size query ────────────────────────────────────────────────

    #[test]
    fn window_size_argv_prints_the_target_and_both_dimensions() {
        // Each assertion is the one that goes red under a specific edit:
        //   - drop `-p`            → the first (the full vector) fails
        //   - drop `-t`            → the first, and `names the target` below
        //   - swap `-p`/`-t`       → the first (the order is asserted)
        //   - ask only one dimension → `asks for both dimensions` fails
        let argv = window_size_args("sess");
        assert_eq!(
            argv,
            [
                "display-message",
                "-p",
                "-t",
                "sess",
                "#{window_width} #{window_height}"
            ]
        );
        assert!(
            argv.contains(&"-p"),
            "without -p tmux writes into a status line instead of stdout: {argv:?}"
        );
        assert!(
            argv.contains(&"-t"),
            "without -t tmux resolves a target of its own choosing, so the answer \
             can come from a session nobody asked about: {argv:?}"
        );
        let format = argv[4];
        assert!(
            format.contains("#{window_width}") && format.contains("#{window_height}"),
            "one query answers both dimensions, or a resize between two queries \
             reports a size that never existed: {format:?}"
        );
        assert_eq!(argv.len(), 5, "arity is part of the grammar: {argv:?}");
    }

    #[test]
    fn size_from_line_reads_the_two_numbers_tmux_prints() {
        // Whitespace-separated, because that is tmux's word: it prints the two
        // numbers and a newline. A `split(' ')` instead would go red on the
        // leading/trailing-space case below.
        assert_eq!(size_from_line("200 60").ok(), Some((200, 60)));
        assert_eq!(
            size_from_line(" 200   60 \n").ok(),
            Some((200, 60)),
            "tmux's output is whitespace-separated and newline-terminated"
        );
        assert_eq!(
            size_from_line("200 60 extra").ok(),
            Some((200, 60)),
            "the size is the first two fields; a third cannot appear in the format"
        );
    }

    #[test]
    fn size_from_line_refuses_to_invent_a_dimension() {
        // The mutation this pins: defaulting a missing or unparseable dimension.
        // `capture_scrollback`'s 80×24 belongs to `capture_scrollback`; an owner
        // that supplied defaults would give the `Required` caller a size it
        // could not tell from a real one.
        for (line, missing) in [
            ("200", "no height"),
            ("", "no width"),
            ("200 x", "height"),
            ("x 60", "width"),
        ] {
            let err = size_from_line(line)
                .expect_err(&format!("{line:?} is not a size"))
                .to_string();
            assert!(
                err.contains(missing),
                "the failure must say what was missing ({missing:?}): {err}"
            );
            assert!(
                err.contains(&format!("{line:?}")),
                "the failure must quote what tmux actually answered: {err}"
            );
        }
    }

    #[test]
    fn send_keys_argv_presses_enter_and_keeps_the_line_whole() {
        // Two edits redden this, and both are the mistakes the inline copies
        // could make: dropping `Enter` (the line is typed but never submitted)
        // and splitting `keys` into key names (a line with spaces becomes
        // several keystrokes).
        let argv = send_keys_args("sess", "export A='b c'");
        assert_eq!(argv, ["send-keys", "-t", "sess", "export A='b c'", "Enter"]);
        assert_eq!(
            argv.last(),
            Some(&"Enter"),
            "the operation is \"type this line AND submit it\": {argv:?}"
        );
        assert_eq!(
            argv[3], "export A='b c'",
            "the line is one argument, not a sequence of key names: {argv:?}"
        );
        assert_eq!(argv.len(), 5, "arity is part of the grammar: {argv:?}");
    }

    #[tokio::test]
    async fn window_size_reads_back_the_size_tmux_created_the_session_with() {
        // The real-tmux proof that the unified grammar asks the question the
        // two hand-written copies used to ask. `create_session` builds a
        // session at the crate's fixed size, so the answer is not a guess.
        use super::super::manager::{SESSION_HEIGHT, SESSION_WIDTH};
        if !super::super::util::check_tmux_available()
            .await
            .unwrap_or(false)
        {
            return;
        }
        let guard = probe_session("ops-window-size").await;
        let size = TmuxOps::global()
            .window_size(guard.name())
            .await
            .expect("a session that exists has a size");
        assert_eq!(
            size,
            (SESSION_WIDTH, SESSION_HEIGHT),
            "the query must answer with the session's real size"
        );
    }

    #[tokio::test]
    async fn window_size_of_a_missing_session_is_an_error_not_a_default() {
        // Measured on tmux 3.6b: against a live server whose target does not
        // exist, `display-message -p -t nope '<fmt>'` exits **0** and prints an
        // empty line. So this `Err` comes from the parse, and the mutation that
        // proves the target is bound is dropping `-t` from the argv: tmux then
        // answers out of a session it picked itself and this call succeeds.
        if !super::super::util::check_tmux_available()
            .await
            .unwrap_or(false)
        {
            return;
        }
        // A live server, so the failure cannot be "no server running": that is
        // the other arm, and it is asserted separately.
        let _server = probe_session("ops-window-size-missing").await;
        let err = TmuxOps::global()
            .window_size("nession_nonexistent_session_xyz")
            .await
            .expect_err("a session that does not exist must not answer a size");
        let message = format!("{err:#}");
        assert!(
            message.contains("nession_nonexistent_session_xyz"),
            "the failure must name the session it asked about: {message}"
        );
    }

    #[tokio::test]
    async fn a_socket_with_no_server_fails_with_tmux_own_words() {
        // The non-zero-exit arm, for both operations, without a fake tmux: a
        // real tmux binary and a socket no server has ever bound. tmux answers
        // "error connecting to <path>" on stderr and exits 1.
        //
        // The mutation this pins is the one #980 was: swallowing the status.
        // Returning `Ok` where the status is non-zero reddens the `expect_err`
        // below (run: the send-keys half of the pair fails), and dropping
        // tmux's stderr from the message reddens the first assertion — a
        // `Required` caller that cannot see either is the failure mode #991
        // exists for.
        if !super::super::util::check_tmux_available()
            .await
            .unwrap_or(false)
        {
            return;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("tmux.sock");
        assert!(dir.path().join("tmux.sock").to_string_lossy().len() < 103);
        let ops = TmuxOps::new(TmuxCmd::new(
            cmd::global().bin().to_string(),
            socket.clone(),
        ));
        let socket_text = socket.to_string_lossy().into_owned();

        let errors = [
            ops.window_size("sess").await.expect_err("no server to ask"),
            ops.send_keys("sess", "echo hi")
                .await
                .expect_err("no server to type into"),
        ];
        for err in errors {
            let message = format!("{err:#}");
            assert!(
                message.contains("error connecting to"),
                "the failure must carry tmux's own stderr: {message}"
            );
            assert!(
                message.contains(&socket_text),
                "and it must name the socket tmux could not reach: {message}"
            );
        }
    }

    #[tokio::test]
    async fn send_keys_types_the_line_into_the_session_shell() {
        // The end-to-end proof for the argv form: the bytes reach a real shell
        // *and the shell runs the line*.
        //
        // The marker is deliberately not the text that is typed. A shell echoes
        // what it is handed, so a pane containing the typed line proves only
        // that the characters arrived — `send-keys` without `Enter` leaves
        // exactly that, unexecuted. `printf` makes the printed word a value the
        // input never contains: the echoed line reads `printf 'step5%s\n' …`,
        // and only execution produces `step5-send-keys-ran`. Dropping `Enter`
        // from `send_keys_args` reddens this.
        if !super::super::util::check_tmux_available()
            .await
            .unwrap_or(false)
        {
            return;
        }
        let guard = probe_session("ops-send-keys").await;
        // The shell needs a moment to be readable; the existing capture tests
        // wait the same way.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        TmuxOps::global()
            .send_keys(guard.name(), "printf 'step5%s\\n' -send-keys-ran")
            .await
            .expect("send keys to a session that exists");

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut seen = String::new();
        while tokio::time::Instant::now() < deadline {
            if let Ok(Some((bytes, _, _))) =
                super::super::util::capture_scrollback(guard.name(), 100).await
            {
                seen = String::from_utf8_lossy(&bytes).into_owned();
                if seen.contains("step5-send-keys-ran") {
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(
            seen.contains("step5-send-keys-ran"),
            "the line was typed but never ran — or never arrived: {seen:?}"
        );
    }

    /// The listing is one line per client and the pid is what identifies ours.
    /// Both halves matter: reading the wrong field finds nothing, and "found
    /// nothing" is indistinguishable from "the client is already gone" — the
    /// two outcomes the operation exists to tell apart.
    #[test]
    fn the_client_with_our_pid_is_the_one_that_is_found() {
        let listing = b"111 client-111\n222 client-222\n333 client-333\n";
        assert_eq!(
            client_name_for_pid_in(listing, 222).as_deref(),
            Some("client-222"),
            "the pid selects the line, not the position in the listing"
        );
    }

    #[test]
    fn a_listing_without_our_pid_finds_nothing() {
        let listing = b"111 client-111\n222 client-222\n";
        assert_eq!(client_name_for_pid_in(listing, 999), None);
    }

    #[test]
    fn an_empty_listing_finds_nothing() {
        // What a server with no clients prints, and what the fake prints when
        // the attach never recorded a pid.
        assert_eq!(client_name_for_pid_in(b"", 1), None);
    }

    #[test]
    fn a_line_that_is_not_a_pid_is_skipped_rather_than_matched() {
        // tmux's own diagnostics can land on stdout; a line whose first field
        // is not a number must not be mistaken for a client.
        let listing = b"not-a-pid client-x\n42 client-42\n";
        assert_eq!(
            client_name_for_pid_in(listing, 42).as_deref(),
            Some("client-42"),
            "the unparsable line is skipped, and the real one after it is found"
        );
    }
}
