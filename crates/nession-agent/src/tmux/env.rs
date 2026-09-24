//! Environment variable management for tmux sessions.
//!
//! Sets, sources, and unsources environment variables on running tmux sessions
//! via the [`TmuxOps`] semantic operations, temp shell scripts, and
//! `send-keys`. Scripts are written to a configurable temporary directory
//! (default `std::env::temp_dir`).
//!
//! This module owns what is *domain* about a session's environment: which
//! variables a batch contains, how a batch's failures are reported, and the
//! script/send-keys mechanism `source_env`/`unsource_env` use. The grammar of
//! the tmux subcommands it needs is [`TmuxOps`]'s — see [`super::ops`] for why
//! that split is load-bearing rather than stylistic (#980, #991).

use anyhow::{Context, Result};
use std::path::PathBuf;
use tokio::fs;

use super::ops::TmuxDep;

/// Path for the source script of a given (client, session, env-name) triple.
fn source_script_path(base_dir: PathBuf, client_id: &str, session: &str, name: &str) -> PathBuf {
    let safe = name.replace(['/', '\\'], "_");
    base_dir.join(format!("nession-source-{client_id}-{session}-{safe}"))
}

/// Path for the unsource script of a given (client, session, env-name) triple.
fn unsource_script_path(base_dir: PathBuf, client_id: &str, session: &str, name: &str) -> PathBuf {
    let safe = name.replace(['/', '\\'], "_");
    base_dir.join(format!("nession-unsource-{client_id}-{session}-{safe}"))
}

/// Clear a session's scrollback, hiding the `. <script>` line the caller just
/// printed.
///
/// **BestEffort**, and the class is stated here rather than left implicit: a
/// failure does not change `source_env`/`unsource_env`'s result — a session
/// whose scrollback could not be cleared is still a session the script was
/// sourced into — but it is logged, because `let _ =` on a command whose
/// stderr is `Stdio::null()` is unobservable, and unobservable is a policy
/// nobody chose (#991's edge cases: a cosmetic failure after a successful
/// primary is observable and does not rewrite the primary).
///
/// `clear-history` is still written here rather than in [`super::ops`]: #991
/// step 5 inventoried it as two call sites in one shape and left it, and
/// rewiring the *dependency* is what step 6 is — the grammar migrates when
/// there is a second shape to unify, not to make this file shorter.
///
/// `pub(crate)` since #991 step 7, for the same reason: the crate's other
/// `clear-history` site is `SessionManager`'s stage-2 path, which hides the
/// same kind of typed line from the same kind of pane. It is the same
/// operation and the same class, so it is one implementation — the argument
/// vector and the policy cannot drift apart, which is what #980 did to the two
/// `set-environment` encodings. Both callers state the class at their own
/// call site; this function is where it is enacted.
pub(crate) async fn clear_history(tmux: &TmuxDep, session_name: &str) {
    match tmux
        .cmd()
        .tokio()
        .args(["clear-history", "-t", session_name])
        .stderr(std::process::Stdio::piped())
        .output()
        .await
    {
        Ok(out) if out.status.success() => {}
        Ok(out) => tracing::warn!(
            "clear-history for session {session_name} failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ),
        Err(e) => tracing::warn!("clear-history for session {session_name} failed: {e}"),
    }
}

/// Manages environment variables for tmux sessions.
pub struct EnvManager {
    /// Base directory for temporary scripts. Defaults to `std::env::temp_dir()`.
    script_dir: PathBuf,
    /// The tmux everything this manager runs is addressed to.
    ///
    /// Before #991 step 6 the manager had no such field and reached
    /// `cmd::global()` / `TmuxOps::global()` at each call, so a fake tmux
    /// binary injected into a `SessionManager` covered session creation and
    /// stopped there: the env operations went to the real binary on the process
    /// socket, and the one path #980 was about could not be exercised without
    /// real tmux to fail.
    tmux: TmuxDep,
}

impl EnvManager {
    /// Create a new `EnvManager` with the given temporary directory, addressed
    /// to the process-wide tmux.
    pub fn new(script_dir: PathBuf) -> Self {
        Self {
            script_dir,
            tmux: TmuxDep::global(),
        }
    }

    /// Bind this manager to a specific tmux dependency, replacing the
    /// process-wide one — **the substitution seam**.
    ///
    /// A test hands in a [`TmuxDep::injected`] fake tmux and thereby exercises
    /// the whole mutation path — the grammar, the spawn, the exit status, the
    /// stderr — without a tmux server, and observes what it ran. Nothing else
    /// in this type resolves tmux addressing, so a substitution here is total.
    ///
    /// `SessionManager::with_tmux_bin` calls this too, so one injected binary
    /// covers the manager *and* the env operations a caller reaches through
    /// [`SessionManager::env`](super::manager::SessionManager::env).
    pub fn with_tmux(&mut self, tmux: TmuxDep) -> &mut Self {
        self.tmux = tmux;
        self
    }

    /// The tmux dependency this manager runs on.
    pub fn tmux(&self) -> &TmuxDep {
        &self.tmux
    }

    /// Set tmux-level environment variables on a running session, making them
    /// available to new windows/panes in that session.
    ///
    /// One [`TmuxOps::set_environment`] per variable — that operation owns the
    /// `set-environment` argument vector, and this function owns only what is
    /// domain about it: how a batch of variables is attempted and how their
    /// failures are reported. Before #991 this function built the argument
    /// vector itself, and the copy it built was wrong (`-e KEY=VALUE`, both
    /// halves refused by tmux — #980).
    ///
    /// **Required.** These are variables a caller asked for, and "set" and
    /// "not set" look identical from the outside — which is how every variable
    /// this function was asked for went unset while its callers reported
    /// success (#980). Every variable is still attempted (one bad name must not
    /// hide the rest), and any tmux failure — non-zero exit or a spawn error —
    /// is returned as an error carrying tmux's own stderr, never downgraded to
    /// a warning. See #991 for the operation classes.
    pub async fn set_environment(
        &self,
        session_name: &str,
        vars: &[(String, String)],
    ) -> Result<()> {
        let ops = self.tmux.ops();
        let mut failures: Vec<String> = Vec::new();
        for (key, value) in vars {
            // One spawn per variable, deliberately: the failure of one variable
            // must not hide the others, and the error each reports names the
            // variable it was setting. It is also what the ordering tests
            // measure — `server.rs` parks a session key for the length of this
            // loop, and that length is this many tmux spawns.
            if let Err(e) = ops.set_environment(session_name, key, value).await {
                failures.push(format!("{e:#}"));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(anyhow::anyhow!("{}", failures.join("; ")))
        }
    }

    /// Write a shell script with `export` lines and source it into the
    /// session. The command line is cleared afterwards via ANSI escape so
    /// it barely flashes on screen.
    pub async fn source_env(
        &self,
        client_id: &str,
        session_name: &str,
        env_name: &str,
        vars: &[(String, String)],
    ) -> Result<()> {
        let path = source_script_path(self.script_dir.clone(), client_id, session_name, env_name);
        let mut content = String::new();
        for (k, v) in vars {
            content.push_str(&format!("export {k}='{}'\n", v.replace('\'', "'\\''")));
        }
        fs::write(&path, &content)
            .await
            .with_context(|| format!("failed to write source script: {}", path.display()))?;

        // Use tmux send-keys to source the script, then clear the scrollback
        // history so the command doesn't appear when re-attaching.
        // **Required**: a script that was never sourced is the whole operation
        // failing, and it is invisible from the outside — the variables simply
        // are not there. The grammar is the owner's; the class is this line's.
        let cmd = format!(" . {}", path.display());
        self.tmux.ops().send_keys(session_name, &cmd).await?;

        // Clear tmux scrollback history to hide the source command
        clear_history(&self.tmux, session_name).await;

        Ok(())
    }

    /// Write a shell script with `unset` lines and source it into the
    /// session, clearing the command from view.
    pub async fn unsource_env(
        &self,
        client_id: &str,
        session_name: &str,
        env_name: &str,
        keys: &[String],
    ) -> Result<()> {
        let path = unsource_script_path(self.script_dir.clone(), client_id, session_name, env_name);
        let content = keys.iter().fold(String::new(), |mut s, k| {
            s.push_str(&format!("unset {k}\n"));
            s
        });
        fs::write(&path, &content)
            .await
            .with_context(|| format!("failed to write unsource script: {}", path.display()))?;

        let cmd = format!(" . {}", path.display());
        self.tmux.ops().send_keys(session_name, &cmd).await?;

        // Clear tmux scrollback history to hide the unsource command
        clear_history(&self.tmux, session_name).await;

        Ok(())
    }

    /// Remove all env source/unsource scripts from the temp directory for the
    /// given session. Called automatically by
    /// [`SessionManager::kill_session`](super::manager::SessionManager::kill_session)
    /// so that `sourced_env_files()` doesn't report stale entries.
    pub async fn cleanup_session_scripts(&self, session_name: &str) {
        let session_marker = format!("-{session_name}-");
        let mut dir = match tokio::fs::read_dir(&self.script_dir).await {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!(
                    "failed to read {} for env script cleanup (session {session_name}): {e}",
                    self.script_dir.display()
                );
                return;
            }
        };
        while let Ok(Some(entry)) = dir.next_entry().await {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if (name_str.starts_with("nession-source-")
                || name_str.starts_with("nession-unsource-"))
                && name_str.contains(&session_marker)
            {
                let path = entry.path();
                if let Err(e) = tokio::fs::remove_file(&path).await {
                    tracing::warn!("failed to remove env script {}: {e}", path.display());
                }
            }
        }
    }

    /// Remove all env source/unsource scripts from the temp directory for the
    /// given client. Called when a client disconnects so that only that
    /// client's sourced envs are cleaned up, leaving other clients' scripts
    /// intact.
    pub async fn cleanup_client_scripts(&self, client_id: &str) {
        let source_prefix = format!("nession-source-{client_id}-");
        let unsource_prefix = format!("nession-unsource-{client_id}-");
        let mut dir = match tokio::fs::read_dir(&self.script_dir).await {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!(
                    "failed to read {} for env script cleanup (client {client_id}): {e}",
                    self.script_dir.display()
                );
                return;
            }
        };
        while let Ok(Some(entry)) = dir.next_entry().await {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with(&source_prefix) || name_str.starts_with(&unsource_prefix) {
                let path = entry.path();
                if let Err(e) = tokio::fs::remove_file(&path).await {
                    tracing::warn!("failed to remove env script {}: {e}", path.display());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        std::env::temp_dir()
    }

    #[test]
    fn source_script_path_sanitizes_slashes() {
        let path = source_script_path(tmp(), "client-1", "sess", "my/env.file");
        assert_eq!(path, tmp().join("nession-source-client-1-sess-my_env.file"));
    }

    #[test]
    fn source_script_path_backslash_sanitized() {
        let path = source_script_path(tmp(), "c", "s", r"a\b");
        assert_eq!(path, tmp().join("nession-source-c-s-a_b"));
    }

    #[test]
    fn unsource_script_path_format() {
        let path = unsource_script_path(tmp(), "cid", "sess", "vars.env");
        assert_eq!(path, tmp().join("nession-unsource-cid-sess-vars.env"));
    }

    #[test]
    fn source_script_path_no_special_chars() {
        let path = source_script_path(tmp(), "abc", "def", "ghi.env");
        assert_eq!(path, tmp().join("nession-source-abc-def-ghi.env"));
    }

    #[tokio::test]
    async fn cleanup_session_scripts_removes_matching_files() {
        // Own temp dir. These script names are fixed, so sharing the system
        // temp dir let a concurrent test run delete the file this test needs to
        // survive — a race a single run passes every time.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let mgr = EnvManager::new(root.clone());
        let session = "test-cleanup-sess";
        let source_path = source_script_path(root.clone(), "c1", session, "a.env");
        let unsource_path = unsource_script_path(root.clone(), "c1", session, "b.env");
        let other_session_path = source_script_path(root.clone(), "c1", "other-sess", "c.env");

        tokio::fs::write(&source_path, "export X=1\n")
            .await
            .unwrap();
        tokio::fs::write(&unsource_path, "unset X\n").await.unwrap();
        tokio::fs::write(&other_session_path, "export Y=2\n")
            .await
            .unwrap();

        mgr.cleanup_session_scripts(session).await;

        assert!(!source_path.exists());
        assert!(!unsource_path.exists());
        assert!(other_session_path.exists());
    }

    #[tokio::test]
    async fn cleanup_client_scripts_removes_matching_files() {
        // Own temp dir, same reasoning as above.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let mgr = EnvManager::new(root.clone());
        let client_id = "test-cleanup-client";
        let source_path = source_script_path(root.clone(), client_id, "sess1", "a.env");
        let unsource_path = unsource_script_path(root.clone(), client_id, "sess2", "b.env");
        let other_client_path = source_script_path(root.clone(), "other-client", "sess1", "c.env");

        tokio::fs::write(&source_path, "export X=1\n")
            .await
            .unwrap();
        tokio::fs::write(&unsource_path, "unset X\n").await.unwrap();
        tokio::fs::write(&other_client_path, "export Y=2\n")
            .await
            .unwrap();

        mgr.cleanup_client_scripts(client_id).await;

        assert!(!source_path.exists());
        assert!(!unsource_path.exists());
        assert!(other_client_path.exists());
    }

    #[tokio::test]
    async fn cleanup_session_scripts_no_match_is_noop() {
        let mgr = EnvManager::new(tmp());
        mgr.cleanup_session_scripts("nonexistent-session-xyz").await;
    }

    #[tokio::test]
    async fn cleanup_client_scripts_no_match_is_noop() {
        let mgr = EnvManager::new(tmp());
        mgr.cleanup_client_scripts("nonexistent-client-xyz").await;
    }

    #[tokio::test]
    async fn set_environment_on_nonexistent_session_fails_with_tmux_diagnostic() {
        // A real non-zero exit from real tmux, and the property that makes a
        // failure actionable rather than merely visible: the message carries
        // tmux's own words. `stderr(Stdio::null())` used to discard them, so
        // every failure — this one included — was indistinguishable from any
        // other (#991: required failures retain useful tmux stderr context).
        //
        // The name is one no other test creates, so the only way tmux answers
        // successfully is a session that exists.
        //
        // A session is created first, so that the *server* exists too and the
        // only missing thing is the session the name is about. Without it this
        // test only held in a full run, where an earlier test had already
        // started a server on the shared socket; on a socket no server has
        // bound — a filtered run with a fresh `NESSION_TMUX_SOCKET` — tmux
        // answers `error connecting to <path> (No such file or directory)`,
        // which is a different situation that the same call would report the
        // same way for any session name, existing or not. The cold socket has
        // its own test, by name:
        // `tmux::ops::tests::a_socket_with_no_server_fails_with_tmux_own_words`.
        // `show_environment_tells_an_unset_variable_apart_from_an_unanswerable_question`
        // (tests/integration/tmux.rs) is the same shape for the sibling
        // operation — a session is created there for this same reason.
        use super::super::manager::{SessionManager, SESSION_HEIGHT, SESSION_WIDTH};
        let guard = crate::test_support::TestSession::new("env-missing-session");
        SessionManager::new()
            .create_session(guard.name(), SESSION_WIDTH, SESSION_HEIGHT, "/tmp", &[])
            .await
            .expect("a running server, so the failure below can only be about the session");

        let mgr = EnvManager::new(tmp());
        let result = mgr
            .set_environment(
                "nession_nonexistent_xyz_123",
                &[("TEST_KEY".to_string(), "TEST_VALUE".to_string())],
            )
            .await;
        let err = result.expect_err("setting a variable on a session that does not exist");
        let message = err.to_string();
        assert!(
            message.contains("TEST_KEY"),
            "the failure must name the variable it was setting: {message}"
        );
        assert!(
            message.contains("no such session"),
            "the failure must carry tmux's own diagnostic for *this* session missing \
             rather than only our summary: {message}"
        );
    }

    #[tokio::test]
    async fn cleanup_uses_configured_script_dir() {
        // Scripts in a configured dir are cleaned up, proving EnvManager honours
        // the dir it was given rather than always using the system temp dir.
        //
        // The dir is a TempDir rather than a fixed `temp_dir()/nession-env-test-dir`:
        // sharing that name across concurrent test runs let one run's
        // `remove_dir_all` delete the other's file, and because the assertion
        // below is "the file is gone", the test would still pass — silently
        // proving nothing.
        let dir = tempfile::tempdir().unwrap();
        let custom = dir.path().to_path_buf();
        let mgr = EnvManager::new(custom.clone());

        let in_custom = source_script_path(custom.clone(), "cid", "sess", "a.env");
        tokio::fs::write(&in_custom, "export X=1\n").await.unwrap();
        assert!(in_custom.exists(), "script should exist before cleanup");

        mgr.cleanup_client_scripts("cid").await;
        assert!(!in_custom.exists());
    }

    // ── the injected tmux (#991 step 6) ──────────────────────────────────────
    //
    // Everything below runs against a fake binary and needs no tmux, no server
    // and no harness socket: the substitution is total, which is what the seam
    // was added for. Two independent things are asserted in each test — what
    // the fake *recorded* (so "the operation ran, with this grammar" is
    // observed rather than assumed) and what the caller got back. The first is
    // the load-bearing one: a test that only checked the caller's result would
    // pass against real tmux and prove nothing about which binary ran — which
    // is exactly how the pre-step-6 seam (`SessionManager::with_tmux_bin`)
    // could look injectable and send every env operation to the real binary.
    //
    // The injected [`TmuxDep`] addresses a socket inside the test's own
    // temporary directory that no server has ever bound, so "the injection did
    // not take" is not a silent pass either: a call that reached the real
    // binary would fail to connect, and the `expect` below would redden.

    /// An `EnvManager` whose tmux is a fake that records its argv.
    #[cfg(unix)]
    fn manager_on(dep: TmuxDep, dir: &std::path::Path) -> EnvManager {
        let mut mgr = EnvManager::new(dir.to_path_buf());
        mgr.with_tmux(dep);
        mgr
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_fake_tmux_runs_the_whole_env_mutation_path() {
        // The criterion #991's `#### Testability` was missing: "a fake tmux
        // binary can exercise the complete env mutation path, not only
        // `SessionManager`". Before step 6 this test could not exist — the
        // argument vector was the owner's, but the *process* was resolved by
        // `TmuxOps::global()` inside `set_environment`, so a fake could be
        // injected into the manager and this call would still reach real tmux.
        //
        // What makes it a proof rather than a formality is the recorded argv:
        // it is the owner's grammar (`set-environment -t <session> <name>
        // <value>`, one spawn per variable) seen from outside the process, and
        // if the injection had not taken there would be nothing in the log at
        // all — the real binary writes to no log.
        let dir = tempfile::tempdir().unwrap();
        let fake = crate::test_support::FakeTmux::new(dir.path(), "exit 0");
        let mgr = manager_on(fake.dep(), dir.path());

        mgr.set_environment(
            "nession-fake-sess",
            &[
                ("NESSON_FAKE_A".to_string(), "1".to_string()),
                ("NESSON_FAKE_B".to_string(), "two words".to_string()),
            ],
        )
        .await
        .expect("the injected tmux exits 0 for every call");

        assert_eq!(
            fake.calls(),
            vec![
                vec![
                    "set-environment",
                    "-t",
                    "nession-fake-sess",
                    "NESSON_FAKE_A",
                    "1"
                ],
                vec![
                    "set-environment",
                    "-t",
                    "nession-fake-sess",
                    "NESSON_FAKE_B",
                    "two words"
                ],
            ],
            "one spawn per variable, in the owner's grammar, run by the injected binary"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_fake_tmux_runs_the_source_and_unsource_paths() {
        // The rest of the mutation path: the script goes to disk, the session
        // is told to source it, and the scrollback is cleared — the same three
        // steps in the other direction for `unsource_env`. All of it through
        // the injected binary, which is what "the complete path" means.
        //
        // `clear-history`'s `BestEffort` class is asserted here too, from the
        // caller's side: the fake fails it, and `source_env` still returns
        // `Ok` — a scrollback that could not be cleared is still a script that
        // was sourced. Its failure is observable (a `tracing::warn!`), which is
        // the difference from the `let _ =` it replaced.
        let dir = tempfile::tempdir().unwrap();
        let fake = crate::test_support::FakeTmux::new(
            dir.path(),
            "case \"$1\" in clear-history) echo 'no server' >&2; exit 1;; *) exit 0;; esac",
        );
        let mgr = manager_on(fake.dep(), dir.path());

        mgr.source_env(
            "cid",
            "nession-fake-sess",
            "vars.env",
            &[("NESSON_SOURCED".to_string(), "v".to_string())],
        )
        .await
        .expect("a failed clear-history is BestEffort");
        mgr.unsource_env(
            "cid",
            "nession-fake-sess",
            "vars.env",
            &["NESSON_SOURCED".to_string()],
        )
        .await
        .expect("a failed clear-history is BestEffort");

        let calls = fake.calls();
        assert_eq!(
            calls.len(),
            4,
            "source and unsource are each send-keys + clear-history: {calls:?}"
        );
        for (call, script) in [
            (&calls[0], "nession-source-cid-nession-fake-sess-vars.env"),
            (&calls[2], "nession-unsource-cid-nession-fake-sess-vars.env"),
        ] {
            assert_eq!(
                &call[..3],
                ["send-keys", "-t", "nession-fake-sess"],
                "the script is typed into the session with the owner's grammar: {call:?}"
            );
            assert_eq!(
                call.last().map(String::as_str),
                Some("Enter"),
                "a line that is typed but never submitted sources nothing: {call:?}"
            );
            assert!(
                call[3].contains(script),
                "the line sources the script this manager wrote ({script}): {call:?}"
            );
            assert!(
                dir.path().join(script).exists(),
                "the script must exist on disk: {script}"
            );
        }
        assert_eq!(
            calls[1],
            vec!["clear-history", "-t", "nession-fake-sess"],
            "the source line is cleared from view afterwards: {calls:?}"
        );
        assert_eq!(
            calls[3],
            vec!["clear-history", "-t", "nession-fake-sess"],
            "and so is the unsource line: {calls:?}"
        );
        assert!(
            std::fs::read_to_string(
                dir.path()
                    .join("nession-source-cid-nession-fake-sess-vars.env")
            )
            .unwrap()
            .contains("export NESSON_SOURCED='v'"),
            "the script holds the variables the caller asked for"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_required_mutation_that_the_injected_tmux_refuses_is_never_success() {
        // The Error-semantics arm, made reachable without needing real tmux to
        // fail for the right reason. The fake answers the way the drifted
        // grammar made real tmux answer — non-zero, with tmux's own words on
        // stderr — and the two things #980 was missing are both asserted: the
        // failure is an `Err` (not a warning that every caller logged before
        // answering `ok`), and the message carries tmux's diagnostic rather
        // than only our summary.
        //
        // Every variable is still attempted: one bad name must not hide the
        // rest, and the count of recorded calls is what proves the loop kept
        // going past the first failure.
        let dir = tempfile::tempdir().unwrap();
        let fake = crate::test_support::FakeTmux::new(
            dir.path(),
            "case \"$1\" in set-environment) echo 'unknown flag -e' >&2; exit 1;; *) exit 0;; esac",
        );
        let mgr = manager_on(fake.dep(), dir.path());

        let err = mgr
            .set_environment(
                "nession-fake-sess",
                &[
                    ("NESSON_ALPHA".to_string(), "1".to_string()),
                    ("NESSON_BETA".to_string(), "2".to_string()),
                ],
            )
            .await
            .expect_err("the injected tmux refused every variable");
        let message = err.to_string();

        assert!(
            message.contains("unknown flag -e"),
            "the failure must carry tmux's own stderr: {message}"
        );
        for name in ["NESSON_ALPHA", "NESSON_BETA"] {
            assert!(
                message.contains(name),
                "every variable is attempted and named, not just the first ({name}): {message}"
            );
        }
        assert_eq!(
            fake.calls().len(),
            2,
            "one spawn per variable, so the second is not skipped after the first fails"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_primary_keeps_its_error_when_the_cleanup_also_fails() {
        // #991's cleanup edge case — "cleanup fails while the primary operation
        // already failed: primary error is preserved; cleanup error may be
        // attached/logged" — for the one place in this file where the two run
        // back to back. `source-env`'s `send-keys` is the primary (a script
        // that was never sourced is the whole operation failing); `clear-history`
        // is the cosmetic cleanup behind it. Here *both* fail, with different
        // words, so the assertion can tell which error the caller got.
        //
        // What holds it: `send_keys` propagates with `?` before the cleanup is
        // reached, and the cleanup's own failure is a `tracing::warn!` that
        // cannot travel. The mutation that reddens this is the plausible future
        // edit the class exists to forbid: giving the cleanup a `Result` and
        // `?`-ing it *before* the primary — the caller then reads
        // "clear-history-marker" instead.
        let dir = tempfile::tempdir().unwrap();
        let fake = crate::test_support::FakeTmux::new(
            dir.path(),
            "case \"$1\" in \
             send-keys) echo 'injected tmux refuses send-keys' >&2; exit 1;; \
             clear-history) echo 'clear-history-marker' >&2; exit 1;; \
             *) exit 0;; esac",
        );
        let mgr = manager_on(fake.dep(), dir.path());

        let err = mgr
            .source_env("cid", "nession-fake-sess", "vars.env", &[])
            .await
            .expect_err("the script was never sourced, so the operation failed");
        let message = format!("{err:#}");
        assert!(
            message.starts_with("tmux send-keys"),
            "the failure the caller reads must be the primary's, not the \
             cleanup's: {message}"
        );
        assert!(
            message.contains("injected tmux refuses send-keys"),
            "with the primary's own context: {message}"
        );
        assert_eq!(
            fake.calls()
                .iter()
                .filter(|args| args.first().map(String::as_str) == Some("send-keys"))
                .count(),
            1,
            "the primary really was attempted: {:#?}",
            fake.calls()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_managers_own_tmux_is_the_process_one_until_it_is_replaced() {
        // The default is the process-wide addressing, and it must be resolved
        // per use rather than frozen when the manager is built — a `TmuxDep`
        // captured before `cmd::configure` would pin the process to the
        // fallback socket for its whole life (the reason `TmuxOps::global`
        // gives). This asserts the property without a configure() call: what
        // the default resolves to is what `cmd::global()` currently is.
        let mgr = EnvManager::new(std::env::temp_dir());
        assert_eq!(
            mgr.tmux().cmd().socket_path(),
            crate::tmux::cmd::global().socket_path(),
            "an unreplaced manager must address the process socket"
        );
    }
}
