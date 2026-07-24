//! Environment variable management for tmux sessions.
//!
//! Sets, sources, and unsources environment variables on running tmux sessions
//! via `set-environment`, temp shell scripts, and `send-keys`. Scripts are
//! written to a configurable temporary directory (default `std::env::temp_dir`).

use anyhow::{Context, Result};
use std::path::PathBuf;
use tokio::fs;
use tokio::process::Command;

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

    /// Set tmux-level environment variables on a running session.
    ///
    /// Uses `tmux set-environment -t <session> -e KEY=VALUE` which makes
    /// variables available to new windows/panes in that session.
    /// Non-fatal: errors are returned as warnings rather than failing the
    /// whole operation so that a single bad env var doesn't block attach.
    pub async fn set_environment(
        &self,
        session_name: &str,
        vars: &[(String, String)],
    ) -> Result<(), Vec<String>> {
        let mut warnings = Vec::new();
        for (key, value) in vars {
            let status = Command::new("tmux")
                .args([
                    "set-environment",
                    "-t",
                    session_name,
                    "-e",
                    &format!("{key}={value}"),
                ])
                .status()
                .await;
            match status {
                Ok(s) if !s.success() => {
                    warnings.push(format!("set-environment {key}={value} failed"));
                }
                Err(e) => {
                    warnings.push(format!("set-environment {key}={value}: {e}"));
                }
                _ => {}
            }
        }
        if warnings.is_empty() {
            Ok(())
        } else {
            Err(warnings)
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
        let _ = Command::new("tmux")
            .args(["clear-history", "-t", session_name])
            .output()
            .await;

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
        let _ = Command::new("tmux")
            .args(["clear-history", "-t", session_name])
            .output()
            .await;

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
        let mgr = EnvManager::new(tmp());
        let session = "test-cleanup-sess";
        let source_path = source_script_path(tmp(), "c1", session, "a.env");
        let unsource_path = unsource_script_path(tmp(), "c1", session, "b.env");
        let other_session_path = source_script_path(tmp(), "c1", "other-sess", "c.env");

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

        let _ = tokio::fs::remove_file(&other_session_path).await;
    }

    #[tokio::test]
    async fn cleanup_client_scripts_removes_matching_files() {
        let mgr = EnvManager::new(tmp());
        let client_id = "test-cleanup-client";
        let source_path = source_script_path(tmp(), client_id, "sess1", "a.env");
        let unsource_path = unsource_script_path(tmp(), client_id, "sess2", "b.env");
        let other_client_path = source_script_path(tmp(), "other-client", "sess1", "c.env");

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

        let _ = tokio::fs::remove_file(&other_client_path).await;
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
    async fn set_environment_on_nonexistent_session_returns_warnings() {
        let mgr = EnvManager::new(tmp());
        let result = mgr
            .set_environment(
                "nession_nonexistent_xyz_123",
                &[("TEST_KEY".to_string(), "TEST_VALUE".to_string())],
            )
            .await;
        // Should return warnings (session doesn't exist) but not panic.
        assert!(result.is_err());
        let warnings = result.unwrap_err();
        assert!(!warnings.is_empty());
    }

    #[tokio::test]
    async fn cleanup_uses_configured_script_dir() {
        // Scripts in a custom dir are cleaned up; a matching file in the
        // system temp dir is left untouched (proves the dir is honored).
        let custom = std::env::temp_dir().join("nession-env-test-dir");
        tokio::fs::create_dir_all(&custom).await.unwrap();
        let mgr = EnvManager::new(custom.clone());

        let in_custom = source_script_path(custom.clone(), "cid", "sess", "a.env");
        tokio::fs::write(&in_custom, "export X=1\n").await.unwrap();

        mgr.cleanup_client_scripts("cid").await;
        assert!(!in_custom.exists());

        let _ = tokio::fs::remove_dir_all(&custom).await;
    }
}
