//! tmux session lifecycle management: create, list, and kill sessions.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::process::Command;

use super::env::EnvManager;

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionInfo {
    pub name: String,
    pub created_at: u64,
    pub window_count: u32,
    pub attached_clients: u32,
    pub width: u16,
    pub height: u16,
}

/// Manages the lifecycle of tmux sessions (create / list / kill).
///
/// Holds an [`EnvManager`] so that killing a session can clean up any env
/// scripts it left behind. Environment operations themselves are exposed
/// through [`SessionManager::env`].
pub struct SessionManager {
    env: EnvManager,
}

impl SessionManager {
    /// Create a `SessionManager` whose env scripts live in the system temp
    /// directory (`std::env::temp_dir()`).
    pub fn new() -> Self {
        Self {
            env: EnvManager::new(std::env::temp_dir()),
        }
    }

    /// Create a `SessionManager` with a custom base directory for env scripts.
    /// Useful for tests and containerized environments with a non-`/tmp`
    /// temporary directory policy.
    pub fn with_script_dir(script_dir: PathBuf) -> Self {
        Self {
            env: EnvManager::new(script_dir),
        }
    }

    /// Access the environment manager for set/source/unsource operations.
    pub fn env(&self) -> &EnvManager {
        &self.env
    }

    pub async fn list_sessions(&self) -> Result<Vec<SessionInfo>> {
        let output = Command::new("tmux")
            .args([
                "list-sessions",
                "-F",
                // Use | (pipe) as delimiter. Tmux converts tab characters (0x09)
                // in -F format strings to underscores (0x5F), so \t is unusable.
                "#{session_name}|#{session_created}|#{session_windows}|#{session_attached}|#{window_width}|#{window_height}",
            ])
            .output()
            .await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stderr = stderr.trim();
            // "no server running" means no tmux sessions exist — expected, not an error
            if stderr.contains("no server running") {
                tracing::debug!("tmux list-sessions: {} (no tmux server running)", stderr);
            } else {
                tracing::warn!(
                    "tmux list-sessions exited with {}: {}",
                    output.status,
                    stderr
                );
            }
            return Ok(vec![]);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let sessions: Vec<SessionInfo> = stdout
            .lines()
            .filter_map(|line| {
                let parts: Vec<&str> = line.split('|').collect();
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

        tracing::info!("tmux list-sessions: {} session(s) found", sessions.len());
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
        // Build new-session WITHOUT `-e` — that flag requires tmux ≥ 3.0.
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
        ])
        .stderr(std::process::Stdio::null());

        let status = cmd.status().await?;

        if !status.success() {
            anyhow::bail!("Failed to create session: {name}");
        }

        // set-environment only affects future windows/panes — the initial
        // window's shell is already running.  Use send-keys to inject env
        // vars into the live shell (the session is detached, so no one
        // sees the commands), then clear-history to remove the evidence.
        // Also call set-environment so new windows inherit the vars.

        // ── send-keys: inject into the initial window ──────────────────
        let mut init_cmd = String::new();
        let mut has_ps1 = false;
        for (key, value) in env {
            if key == "PS1" {
                has_ps1 = true;
            }
            init_cmd.push_str(&format!("export {key}='{}';", value.replace('\'', "'\\''")));
        }

        // Default short PS1.  Debian's /etc/bash.bashrc unconditionally
        // overwrites PS1, so a plain export is not enough.  We set
        // NESSON_PS1 (the value) and PROMPT_COMMAND (the mechanism).
        // PROMPT_COMMAND runs *after* bashrc, just before the first prompt,
        // applies PS1, and unsets NESSON_PS1 so later prompts have zero
        // overhead.  No recursive ${PROMPT_COMMAND:+…} tail.
        if !has_ps1 {
            init_cmd.push_str(&format!(
                "export NESSON_PS1='{}';",
                DEFAULT_PS1.replace('\'', "'\\''")
            ));
            init_cmd.push_str(
                r#"export PROMPT_COMMAND='[ -n "$NESSON_PS1" ] && { PS1="$NESSON_PS1"; unset NESSON_PS1; }';"#,
            );
        }

        if !init_cmd.is_empty() {
            // Inject env vars into the initial window's shell via send-keys.
            // The session was just created with -d (detached); the shell is
            // starting in the background.  send-keys queues keystrokes into
            // the pane's input buffer — it works even if the shell hasn't
            // finished its rc files yet.
            //
            // Use a direct Command rather than the send_keys helper so that
            // a non-zero exit is not fatal (the set-environment calls above
            // already cover future windows; this is best-effort for the
            // initial window).
            let _ = Command::new("tmux")
                .args(["send-keys", "-t", name, &init_cmd, "Enter"])
                .stderr(std::process::Stdio::null())
                .status()
                .await;
            let _ = Command::new("tmux")
                .args(["clear-history", "-t", name])
                .stderr(std::process::Stdio::null())
                .status()
                .await;
        }

        // ── set-environment: for future windows/panes ─────────────────
        for (key, value) in env {
            let _ = Command::new("tmux")
                .args(["set-environment", "-t", name, key, value])
                .stderr(std::process::Stdio::null())
                .status()
                .await;
        }
        if !has_ps1 {
            let _ = Command::new("tmux")
                .args(["set-environment", "-t", name, "NESSON_PS1", DEFAULT_PS1])
                .stderr(std::process::Stdio::null())
                .status()
                .await;
            let _ = Command::new("tmux")
                .args([
                    "set-environment",
                    "-t",
                    name,
                    "PROMPT_COMMAND",
                    "[ -n \"$NESSON_PS1\" ] && { PS1=\"$NESSON_PS1\"; unset NESSON_PS1; }",
                ])
                .stderr(std::process::Stdio::null())
                .status()
                .await;
        }

        // Enable tmux mouse mode so wheel events reach tmux as SGR mouse
        // sequences for copy-mode scroll.  The web client monkey-patches
        // xterm.js's SelectionManager.shouldForceSelection → always true,
        // so mouse button events stay local for text selection.
        let _ = Command::new("tmux")
            .args(["set-option", "-t", name, "mouse", "on"])
            .stderr(std::process::Stdio::null())
            .status()
            .await;

        Ok(())
    }

    pub async fn kill_session(&self, name: &str) -> Result<()> {
        let status = Command::new("tmux")
            .args(["kill-session", "-t", name])
            .stderr(std::process::Stdio::null())
            .status()
            .await?;

        if !status.success() {
            anyhow::bail!("Failed to kill session: {name}");
        }

        // Clean up env source/unsource scripts for this session so they
        // don't linger in the temp dir (sourced_env_files() scans it to
        // report which env files are active — orphaned scripts cause stale
        // "sourced" state after the session is gone).
        self.env.cleanup_session_scripts(name).await;

        Ok(())
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
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

        let mgr = SessionManager::new();
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
