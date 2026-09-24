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

use super::cmd;
use super::ops::TmuxOps;
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

impl EnvManager {
    /// Create a new `EnvManager` with the given temporary directory.
    pub fn new(script_dir: PathBuf) -> Self {
        Self { script_dir }
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
        let ops = TmuxOps::global();
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
}
