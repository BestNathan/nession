use tokio::process::Command;
use anyhow::Result;
use serde::{Deserialize, Serialize};

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
            .args(&[
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
                        name: parts[0].to_string(),
                        created_at: parts[1].parse().ok()?,
                        window_count: parts[2].parse().ok()?,
                        attached_clients: parts[3].parse().ok()?,
                        width: parts[4].parse().ok()?,
                        height: parts[5].parse().ok()?,
                    })
                } else {
                    None
                }
            })
            .collect();

        Ok(sessions)
    }

    pub async fn create_session(&self, name: &str, width: u16, height: u16) -> Result<()> {
        let status = Command::new("tmux")
            .args(&[
                "new-session",
                "-d",
                "-s", name,
                "-x", &width.to_string(),
                "-y", &height.to_string(),
            ])
            .status()
            .await?;

        if !status.success() {
            anyhow::bail!("Failed to create session: {}", name);
        }

        Ok(())
    }

    pub async fn kill_session(&self, name: &str) -> Result<()> {
        let status = Command::new("tmux")
            .args(&["kill-session", "-t", name])
            .status()
            .await?;

        if !status.success() {
            anyhow::bail!("Failed to kill session: {}", name);
        }

        Ok(())
    }

    pub async fn send_keys(&self, session_name: &str, keys: &str) -> Result<()> {
        let status = Command::new("tmux")
            .args(&["send-keys", "-t", session_name, keys])
            .status()
            .await?;

        if !status.success() {
            anyhow::bail!("Failed to send keys to session: {}", session_name);
        }

        Ok(())
    }

    pub async fn check_tmux_available(&self) -> Result<bool> {
        let status = Command::new("tmux")
            .arg("-V")
            .status()
            .await?;

        Ok(status.success())
    }
}

impl Default for TmuxManager {
    fn default() -> Self {
        Self::new()
    }
}
