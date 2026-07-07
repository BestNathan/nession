use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::fs;
use tokio::process::Command;

/// Fixed-path script names, keyed by session + env-file name so they are
/// reused (overwritten) across repeated source / unsource operations.
fn source_script_path(session: &str, name: &str) -> PathBuf {
    let safe = name.replace(['/', '\\'], "_");
    PathBuf::from(format!("/tmp/nession-source-{session}-{safe}"))
}

fn unsource_script_path(session: &str, name: &str) -> PathBuf {
    let safe = name.replace(['/', '\\'], "_");
    PathBuf::from(format!("/tmp/nession-unsource-{session}-{safe}"))
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

    /// Write a shell script with `export` lines and source it into the
    /// session. The command line is cleared afterwards via ANSI escape so
    /// it barely flashes on screen.
    pub async fn source_env(
        &self,
        session_name: &str,
        env_name: &str,
        vars: &[(String, String)],
    ) -> Result<()> {
        let path = source_script_path(session_name, env_name);
        let mut content = String::new();
        for (k, v) in vars {
            content.push_str(&format!("export {k}='{}'\n", v.replace('\'', "'\\''")));
        }
        fs::write(&path, &content)
            .await
            .with_context(|| format!("failed to write source script: {}", path.display()))?;

        // Source the file then move up 1 line and clear to end of line so
        // the command disappears from view. ANSI \033[1A (cursor up) +
        // \033[2K (clear line) works in all modern terminals.
        let cmd = format!(". {}; printf '\\033[1A\\033[2K'", path.display());
        self.send_keys(session_name, &cmd).await
    }

    /// Write a shell script with `unset` lines and source it into the
    /// session, clearing the command from view.
    pub async fn unsource_env(
        &self,
        session_name: &str,
        env_name: &str,
        keys: &[String],
    ) -> Result<()> {
        let path = unsource_script_path(session_name, env_name);
        let content = keys.iter().fold(String::new(), |mut s, k| {
            s.push_str(&format!("unset {k}\n"));
            s
        });
        fs::write(&path, &content)
            .await
            .with_context(|| format!("failed to write unsource script: {}", path.display()))?;

        let cmd = format!(". {}; printf '\\033[1A\\033[2K'", path.display());
        self.send_keys(session_name, &cmd).await
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
