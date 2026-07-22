use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::fs;
use tokio::process::Command;

/// Fixed width for tmux sessions. Individual clients get independent
/// viewports via `refresh-client -C`, so the session's own size only needs
/// to be large enough to accommodate all realistic client viewports.
pub const SESSION_WIDTH: u16 = 200;

/// Default shell prompt injected into every tmux session so the K8s pod
/// hostname (e.g. `nession-agent-staging-84d4d8666f-zs5xj`) doesn't
/// clutter the terminal.  `\u` = user, `\w` = working dir, `\$` = # or $.
pub const DEFAULT_PS1: &str = r"\[\e[32m\]\u\[\e[0m\]:\[\e[34m\]\w\[\e[0m\]\$ ";

/// Fixed height for tmux sessions. See [`SESSION_WIDTH`] for rationale.
pub const SESSION_HEIGHT: u16 = 60;

/// Fixed-path script names, keyed by client + session + env-file name so they are
/// reused (overwritten) across repeated source / unsource operations.
fn source_script_path(client_id: &str, session: &str, name: &str) -> PathBuf {
    let safe = name.replace(['/', '\\'], "_");
    PathBuf::from(format!("/tmp/nession-source-{client_id}-{session}-{safe}"))
}

fn unsource_script_path(client_id: &str, session: &str, name: &str) -> PathBuf {
    let safe = name.replace(['/', '\\'], "_");
    PathBuf::from(format!(
        "/tmp/nession-unsource-{client_id}-{session}-{safe}"
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionInfo {
    pub name: String,
    pub created_at: u64,
    pub window_count: u32,
    pub attached_clients: u32,
    pub width: u16,
    pub height: u16,
}

pub struct TmuxManager;

impl TmuxManager {
    pub fn new() -> Self {
        Self
    }

    pub async fn list_sessions(&self) -> Result<Vec<SessionInfo>> {
        let output = Command::new("tmux")
            .args([
                "list-sessions",
                "-F",
                "#{session_name}\t#{session_created}\t#{session_windows}\t#{session_attached}\t#{window_width}\t#{window_height}",
            ])
            .output()
            .await?;

        if !output.status.success() {
            // tmux server not running, return empty list
            return Ok(vec![]);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let sessions: Vec<SessionInfo> = stdout
            .lines()
            .filter_map(|line| {
                let parts: Vec<&str> = line.split('\t').collect();
                if parts.len() == 6 {
                    Some(SessionInfo {
                        name: parts
                            .first()
                            .map(std::string::ToString::to_string)
                            .unwrap_or_default(),
                        created_at: parts.get(1).and_then(|s| s.parse().ok())?,
                        window_count: parts.get(2).and_then(|s| s.parse().ok())?,
                        attached_clients: parts.get(3).and_then(|s| s.parse().ok())?,
                        width: parts.get(4).and_then(|s| s.parse().ok())?,
                        height: parts.get(5).and_then(|s| s.parse().ok())?,
                    })
                } else {
                    None
                }
            })
            .collect();

        Ok(sessions)
    }

    /// Create a new detached tmux session at a fixed [`SESSION_WIDTH`] × [`SESSION_HEIGHT`].
    ///
    /// The `_width` and `_height` parameters are ignored — sessions always use the
    /// fixed size so that multiple clients with different viewports can attach to
    /// the same session without one resizing the pane out from under another.
    /// Each client sets its own viewport independently via `refresh-client -C`
    /// (see `ControlModeSession::resize`).
    pub async fn create_session(
        &self,
        name: &str,
        _width: u16,
        _height: u16,
        working_dir: &str,
        env: &[(String, String)],
    ) -> Result<()> {
        let mut cmd = Command::new("tmux");
        cmd.args([
            "new-session",
            "-d",
            "-s",
            name,
            "-x",
            &SESSION_WIDTH.to_string(),
            "-y",
            &SESSION_HEIGHT.to_string(),
            "-c",
            working_dir,
        ]);

        // Inject env vars via `-e KEY=VALUE`. Supported since tmux 3.0; on older
        // tmux the flag is rejected and session creation fails loudly rather
        // than silently dropping the environment.
        let mut has_ps1 = false;
        for (key, value) in env {
            if key == "PS1" {
                has_ps1 = true;
            }
            cmd.arg("-e").arg(format!("{key}={value}"));
        }
        let ps1_value = if has_ps1 {
            None
        } else {
            Some(DEFAULT_PS1.to_string())
        };

        let status = cmd.status().await?;

        if !status.success() {
            anyhow::bail!("Failed to create session: {name}");
        }

        // Apply the default PS1 inside the session's shell.  `-e PS1=…` at
        // creation time is often overridden by the distro's /etc/bash.bashrc,
        // so we type the export directly into the initial window — pure
        // session-level management, no files written.
        if let Some(ref ps1) = ps1_value {
            // Escape single quotes in the PS1 value for the shell.
            let escaped = ps1.replace('\'', "'\\''");
            let export_cmd = format!("export PS1='{escaped}'");
            let _ = Command::new("tmux")
                .args(["send-keys", "-t", name, &export_cmd, "Enter"])
                .status()
                .await;
        }

        Ok(())
    }

    /// Set tmux-level environment variables on a running session.
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
        let path = source_script_path(client_id, session_name, env_name);
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
        self.send_keys(session_name, &cmd).await?;

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
        let path = unsource_script_path(client_id, session_name, env_name);
        let content = keys.iter().fold(String::new(), |mut s, k| {
            s.push_str(&format!("unset {k}\n"));
            s
        });
        fs::write(&path, &content)
            .await
            .with_context(|| format!("failed to write unsource script: {}", path.display()))?;

        let cmd = format!(" . {}", path.display());
        self.send_keys(session_name, &cmd).await?;

        // Clear tmux scrollback history to hide the unsource command
        let _ = Command::new("tmux")
            .args(["clear-history", "-t", session_name])
            .output()
            .await;

        Ok(())
    }

    pub async fn kill_session(&self, name: &str) -> Result<()> {
        let status = Command::new("tmux")
            .args(["kill-session", "-t", name])
            .status()
            .await?;

        if !status.success() {
            anyhow::bail!("Failed to kill session: {name}");
        }

        // Clean up env source/unsource scripts for this session so they
        // don't linger in /tmp/ (sourced_env_files() scans /tmp/ to report
        // which env files are active — orphaned scripts cause stale
        // "sourced" state after the session is gone).
        self.cleanup_session_scripts(name).await;

        Ok(())
    }

    /// Remove all env source/unsource scripts from `/tmp/` for the given
    /// session. Called automatically by [`kill_session`](Self::kill_session)
    /// so that `sourced_env_files()` doesn't report stale entries.
    /// Matches files with format: `nession-{source,unsource}-{client_id}-{session}-{env}`
    async fn cleanup_session_scripts(&self, session_name: &str) {
        // Match files containing "-{session_name}-" to handle the client_id in the middle
        let session_marker = format!("-{session_name}-");
        let mut dir = match tokio::fs::read_dir("/tmp").await {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!(
                    "failed to read /tmp for env script cleanup (session {session_name}): {e}"
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

    /// Remove all env source/unsource scripts from `/tmp/` for the given
    /// client. Called when a client disconnects so that only that client's
    /// sourced envs are cleaned up, leaving other clients' scripts intact.
    /// Matches files with format: `nession-{source,unsource}-{client_id}-*`
    pub async fn cleanup_client_scripts(&self, client_id: &str) {
        let source_prefix = format!("nession-source-{client_id}-");
        let unsource_prefix = format!("nession-unsource-{client_id}-");
        let mut dir = match tokio::fs::read_dir("/tmp").await {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!(
                    "failed to read /tmp for env script cleanup (client {client_id}): {e}"
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

    pub async fn send_keys(&self, session_name: &str, keys: &str) -> Result<()> {
        let status = Command::new("tmux")
            .args(["send-keys", "-t", session_name, keys, "Enter"])
            .status()
            .await?;

        if !status.success() {
            anyhow::bail!("Failed to send keys to session: {session_name}");
        }

        Ok(())
    }

    pub async fn check_tmux_available(&self) -> Result<bool> {
        let status = Command::new("tmux").arg("-V").status().await?;

        Ok(status.success())
    }
}

impl Default for TmuxManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_script_path_sanitizes_slashes() {
        let path = source_script_path("client-1", "sess", "my/env.file");
        assert_eq!(
            path,
            PathBuf::from("/tmp/nession-source-client-1-sess-my_env.file")
        );
    }

    #[test]
    fn source_script_path_backslash_sanitized() {
        let path = source_script_path("c", "s", r"a\b");
        assert_eq!(path, PathBuf::from("/tmp/nession-source-c-s-a_b"));
    }

    #[test]
    fn unsource_script_path_format() {
        let path = unsource_script_path("cid", "sess", "vars.env");
        assert_eq!(
            path,
            PathBuf::from("/tmp/nession-unsource-cid-sess-vars.env")
        );
    }

    #[test]
    fn source_script_path_no_special_chars() {
        let path = source_script_path("abc", "def", "ghi.env");
        assert_eq!(path, PathBuf::from("/tmp/nession-source-abc-def-ghi.env"));
    }

    #[tokio::test]
    async fn cleanup_session_scripts_removes_matching_files() {
        let mgr = TmuxManager::new();
        // Create some fake script files in /tmp
        let session = "test-cleanup-sess";
        let source_path = source_script_path("c1", session, "a.env");
        let unsource_path = unsource_script_path("c1", session, "b.env");
        let other_session_path = source_script_path("c1", "other-sess", "c.env");

        // Write the files
        tokio::fs::write(&source_path, "export X=1\n")
            .await
            .unwrap();
        tokio::fs::write(&unsource_path, "unset X\n").await.unwrap();
        tokio::fs::write(&other_session_path, "export Y=2\n")
            .await
            .unwrap();

        // Clean up for our session
        mgr.cleanup_session_scripts(session).await;

        // Our session's files should be gone
        assert!(!source_path.exists());
        assert!(!unsource_path.exists());

        // Other session's file should still exist
        assert!(other_session_path.exists());

        // Clean up the other file
        let _ = tokio::fs::remove_file(&other_session_path).await;
    }

    #[tokio::test]
    async fn cleanup_client_scripts_removes_matching_files() {
        let mgr = TmuxManager::new();
        let client_id = "test-cleanup-client";
        let source_path = source_script_path(client_id, "sess1", "a.env");
        let unsource_path = unsource_script_path(client_id, "sess2", "b.env");
        let other_client_path = source_script_path("other-client", "sess1", "c.env");

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
        let mgr = TmuxManager::new();
        // Should not panic even when no matching files exist
        mgr.cleanup_session_scripts("nonexistent-session-xyz").await;
    }

    #[tokio::test]
    async fn cleanup_client_scripts_no_match_is_noop() {
        let mgr = TmuxManager::new();
        mgr.cleanup_client_scripts("nonexistent-client-xyz").await;
    }

    #[tokio::test]
    async fn set_environment_on_nonexistent_session_returns_warnings() {
        let mgr = TmuxManager::new();
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
}

#[cfg(test)]
mod window_size_lock_tests {
    use super::*;

    fn unique_name(prefix: &str) -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        format!("{prefix}-{nanos}")
    }

    async fn read_window_size_option(session: &str) -> Result<String> {
        let out = Command::new("tmux")
            .args(["show-option", "-t", session, "-v", "window-size"])
            .output()
            .await?;
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    #[tokio::test]
    async fn create_session_does_not_lock_window_size() {
        // Skip on machines without tmux (CI covers it).
        if Command::new("tmux").arg("-V").status().await.is_err() {
            eprintln!("tmux not available, skipping");
            return;
        }

        let mgr = TmuxManager::new();
        let name = unique_name("no-lock-test");
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();

        mgr.create_session(&name, 200, 60, &cwd, &[])
            .await
            .expect("create");

        // window-size should NOT be explicitly set, leaving it at tmux default
        // so that clients can resize the window.
        let val = read_window_size_option(&name).await.expect("show-option");
        assert!(
            val.is_empty(),
            "expected window-size to be unset, got {val:?}"
        );

        // Cleanup — swallow errors, best-effort.
        let _ = Command::new("tmux")
            .args(["kill-session", "-t", &name])
            .status()
            .await;
    }
}
