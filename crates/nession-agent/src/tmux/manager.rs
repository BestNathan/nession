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
