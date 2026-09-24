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
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
