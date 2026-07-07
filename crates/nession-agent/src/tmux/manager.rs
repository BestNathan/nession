use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

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

    pub async fn create_session(
        &self,
        name: &str,
        width: u16,
        height: u16,
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
            &width.to_string(),
            "-y",
            &height.to_string(),
            "-c",
            working_dir,
        ]);

        // Inject env vars via `-e KEY=VALUE`. Supported since tmux 3.0; on older
        // tmux the flag is rejected and session creation fails loudly rather
        // than silently dropping the environment.
        for (key, value) in env {
            cmd.arg("-e").arg(format!("{key}={value}"));
        }

        let status = cmd.status().await?;

        if !status.success() {
            anyhow::bail!("Failed to create session: {name}");
        }

        Ok(())
    }

    /// Set an environment variable on a running session (`set-environment`).
    /// The variable becomes visible to processes started afterwards in the
    /// session (e.g. new windows/panes), not to already-running shells.
    pub async fn set_environment(&self, session_name: &str, key: &str, value: &str) -> Result<()> {
        let status = Command::new("tmux")
            .args(["set-environment", "-t", session_name, key, value])
            .status()
            .await?;

        if !status.success() {
            anyhow::bail!("Failed to set environment {key} on session: {session_name}");
        }

        Ok(())
    }

    /// Remove an environment variable from a running session
    /// (`set-environment -u`).
    pub async fn unset_environment(&self, session_name: &str, key: &str) -> Result<()> {
        let status = Command::new("tmux")
            .args(["set-environment", "-u", "-t", session_name, key])
            .status()
            .await?;

        if !status.success() {
            anyhow::bail!("Failed to unset environment {key} on session: {session_name}");
        }

        Ok(())
    }

    /// Send `export KEY=VALUE ...` to every pane in the session so that
    /// already-running shells pick up the env vars immediately. Pane errors
    /// are ignored (best-effort — a pane may not have a shell).
    pub async fn broadcast_export(
        &self,
        session_name: &str,
        vars: &[(String, String)],
    ) -> Result<()> {
        if vars.is_empty() {
            return Ok(());
        }
        let export_cmd = format!(
            "export {}",
            vars.iter()
                .map(|(k, v)| format!("{k}={}", Self::shell_escape(v)))
                .collect::<Vec<_>>()
                .join(" ")
        );
        self.send_keys_to_all_panes(session_name, &export_cmd).await
    }

    /// Send `unset KEY ...` to every pane so already-running shells drop the vars.
    pub async fn broadcast_unset(&self, session_name: &str, keys: &[String]) -> Result<()> {
        if keys.is_empty() {
            return Ok(());
        }
        let unset_cmd = format!("unset {}", keys.join(" "));
        self.send_keys_to_all_panes(session_name, &unset_cmd).await
    }

    /// List all pane IDs for a session, then send a shell command to each.
    async fn send_keys_to_all_panes(&self, session_name: &str, command: &str) -> Result<()> {
        let output = Command::new("tmux")
            .args(["list-panes", "-t", session_name, "-F", "#{pane_id}"])
            .output()
            .await?;
        if !output.status.success() {
            anyhow::bail!("Failed to list panes for session: {session_name}");
        }
        let pane_ids: Vec<String> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();

        for pane_id in &pane_ids {
            // Best-effort: a pane may not accept input (e.g. dead pane).
            let _ = Command::new("tmux")
                .args(["send-keys", "-t", pane_id, command, "Enter"])
                .status()
                .await;
        }
        Ok(())
    }

    /// Escape a value for safe use in a single-quoted shell string.
    /// Single quotes inside the value are replaced with `'\''`.
    fn shell_escape(value: &str) -> String {
        if value.is_empty() {
            return "''".to_string();
        }
        // Only need quoting if value contains shell metacharacters or spaces.
        if value
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '.')
        {
            return value.to_string();
        }
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    pub async fn kill_session(&self, name: &str) -> Result<()> {
        let status = Command::new("tmux")
            .args(["kill-session", "-t", name])
            .status()
            .await?;

        if !status.success() {
            anyhow::bail!("Failed to kill session: {name}");
        }

        Ok(())
    }

    pub async fn send_keys(&self, session_name: &str, keys: &str) -> Result<()> {
        let status = Command::new("tmux")
            .args(["send-keys", "-t", session_name, keys])
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
