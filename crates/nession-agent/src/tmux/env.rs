//! Environment variable management for tmux sessions.
//!
//! Sets, sources, and unsources environment variables on running tmux sessions
//! via `set-environment`, temp shell scripts, and `send-keys`. Scripts are
//! written to a configurable temporary directory (default `std::env::temp_dir`).

use anyhow::{Context, Result};
use std::path::PathBuf;
use tokio::fs;

use super::cmd;
use super::util::send_keys;

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
async fn clear_history(session_name: &str) {
    match cmd::global()
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
}

/// Set one tmux session variable — the **only** place that knows how.
///
/// `#991`. This grammar used to be hand-written in six places: once here, and
/// five times in `SessionManager::create_session` (`TERM`, `LANG`, the caller's
/// `env`, the forwarded process environment, and `NESSON_PS1`). They did not all
/// agree — the copy in this module used `-e KEY=VALUE`, which is
/// `new-session`'s idiom and not this subcommand's, so every variable a caller
/// asked for went unset while its callers reported success (`#980`).
///
/// `#980` fixed that by correcting the copy. That leaves two implementations
/// that agree *today*, which is the arrangement that produced the drift in the
/// first place — so the fix that matters is not the corrected spelling, it is
/// that there is one spelling.
///
/// Two things are load-bearing about the shape, and neither is style:
///
/// - **`name` and `value` are two separate argv values.** `set-environment`
///   takes `name [value]`; handing it one `KEY=VALUE` fails with `variable name
///   contains =`. It is what keeps a value containing spaces, quotes or `=`
///   intact, because nothing re-parses it and nothing reconstructs it.
/// - **stderr is captured, not discarded.** tmux's own message ("no such
///   session: …") is the only thing that says *why* a required mutation failed,
///   and throwing it away is why the #980 failure was invisible even in logs.
///
/// Takes the command rather than reaching for `cmd::global()` so a caller can
/// pass the one it holds — `SessionManager` has had its own for a while, and
/// `#991` scope 3 is the rest of the subsystem catching up.
pub(crate) async fn set_environment_var(
    tmux: &cmd::TmuxCmd,
    session_name: &str,
    key: &str,
    value: &str,
) -> Result<()> {
    let output = tmux
        .tokio()
        .args(["set-environment", "-t", session_name, key, value])
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| anyhow::anyhow!("set-environment {key} for session {session_name}: {e}"))?;

    if output.status.success() {
        return Ok(());
    }
    Err(anyhow::anyhow!(
        "set-environment {key} for session {session_name}: {} ({})",
        output.status,
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

impl EnvManager {
    /// Create a new `EnvManager` with the given temporary directory.
    pub fn new(script_dir: PathBuf) -> Self {
        Self { script_dir }
    }

    /// Set tmux-level environment variables on a running session, making them
    /// available to new windows/panes in that session.
    ///
    /// One `tmux set-environment -t <session> <name> <value>` per variable,
    /// with `name` and `value` as **two separate argv values**. Both halves of
    /// that shape matter:
    ///
    /// - `set-environment` takes `name [value]`. Handing it one `KEY=VALUE`
    ///   argument fails with `variable name contains =` (exit 1), so a
    ///   `name`/`value` split is not a style preference — the joined form is
    ///   simply wrong.
    /// - `-e KEY=VALUE` is **`new-session`'s** idiom, not this subcommand's;
    ///   `set-environment` answers `unknown flag -e` (exit 1). It was copied
    ///   here from `SessionManager::create_session`, which uses it correctly.
    ///
    /// Separate argv values are also what keeps a value containing spaces,
    /// quotes or `=` intact: nothing re-parses it, and the value is never
    /// reconstructed into `KEY=VALUE`.
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
        let mut failures: Vec<String> = Vec::new();
        for (key, value) in vars {
            // Every variable is attempted even after one fails, so a single bad
            // name cannot hide the rest.
            if let Err(e) = set_environment_var(cmd::global(), session_name, key, value).await {
                failures.push(e.to_string());
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
        let cmd = format!(" . {}", path.display());
        send_keys(session_name, &cmd).await?;

        // Clear tmux scrollback history to hide the source command
        clear_history(session_name).await;

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
        send_keys(session_name, &cmd).await?;

        // Clear tmux scrollback history to hide the unsource command
        clear_history(session_name).await;

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
            message.contains("no such session") || message.contains("no server running"),
            "the failure must carry tmux's own diagnostic rather than only our summary: {message}"
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

    /// Write a fake `tmux` that records its argv and exits with `code`.
    ///
    /// The one seam that makes the grammar testable: `TmuxCmd::with_bin` accepts
    /// any path, so the whole operation path can be exercised without tmux —
    /// which is what `#991` scope 3 is about, and what made the `#980` drift
    /// invisible for so long (there was no way to assert what was executed).
    #[cfg(unix)]
    fn fake_tmux(dir: &std::path::Path, code: u8) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt as _;
        let log = dir.join("argv");
        let bin = dir.join("tmux");
        std::fs::write(
            &bin,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > {log}\n[ {code} -eq 0 ] || {{ echo 'variable name contains =' >&2; exit {code}; }}\nexit {code}\n",
                log = log.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn set_environment_var_passes_name_and_value_as_separate_arguments() {
        // The `#980` grammar, pinned where it now lives. `set-environment` takes
        // `name [value]`; a single `KEY=VALUE` argument fails with "variable name
        // contains =", and `-e KEY=VALUE` is `new-session`'s idiom, answered with
        // "unknown flag -e". Both are one edit away from coming back, and this is
        // the test that would catch it.
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("sock");
        let tmux = cmd::TmuxCmd::new(
            fake_tmux(dir.path(), 0).to_string_lossy().to_string(),
            sock.clone(),
        );

        // A value with spaces, `=` and quotes: nothing may re-parse it.
        set_environment_var(&tmux, "sess", "KEY", "a value = with \"both\"")
            .await
            .expect("the fake exits 0");

        let argv = std::fs::read_to_string(dir.path().join("argv")).unwrap();
        // The `-S <socket>` is asserted rather than filtered out: it is the
        // invariant `#574` established and this issue says to preserve, and a
        // refactor that reached for the default socket would be caught here.
        assert_eq!(
            argv.lines().collect::<Vec<_>>(),
            vec![
                "-S",
                &sock.to_string_lossy(),
                "set-environment",
                "-t",
                "sess",
                "KEY",
                "a value = with \"both\""
            ],
            "name and value are two argv values, the value is not reconstructed, \
             and the command addresses nession's own socket"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn set_environment_var_reports_tmuxs_own_message_on_failure() {
        // Required mutations must not degrade into success — the `#980` shape,
        // where the caller reported success while nothing was set. tmux's stderr
        // is the only thing that says *why*, so it travels with the error.
        let dir = tempfile::tempdir().unwrap();
        let tmux = cmd::TmuxCmd::new(
            fake_tmux(dir.path(), 1).to_string_lossy().to_string(),
            dir.path().join("sock"),
        );

        let err = set_environment_var(&tmux, "sess", "KEY", "value")
            .await
            .expect_err("a non-zero exit is a failure");
        let text = err.to_string();
        assert!(
            text.contains("variable name contains ="),
            "tmux's own message must survive into the error: {text}"
        );
        assert!(
            text.contains("KEY"),
            "and the variable it was setting: {text}"
        );
    }
}
