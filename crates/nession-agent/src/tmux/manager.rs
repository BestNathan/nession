//! tmux session lifecycle management: create, list, and kill sessions.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
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

/// Timeout for quick tmux queries (`list-sessions`, `display-message`).
/// Must stay below the server's 3s force-refresh window so a slow list still
/// answers before the server marks the agent stale.
const TMUX_LIST_TIMEOUT: Duration = Duration::from_secs(2);

/// Timeout for `kill-session`.
const TMUX_KILL_TIMEOUT: Duration = Duration::from_secs(5);

/// Timeout for the multi-stage `create_session` (new-session + env setup).
const TMUX_CREATE_TIMEOUT: Duration = Duration::from_secs(10);

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
    /// tmux binary name or path. Injectable so tests can substitute a fake.
    tmux_bin: String,
    list_timeout: Duration,
    kill_timeout: Duration,
    create_timeout: Duration,
}

impl SessionManager {
    /// Create a `SessionManager` whose env scripts live in the system temp
    /// directory (`std::env::temp_dir()`).
    pub fn new() -> Self {
        Self {
            env: EnvManager::new(std::env::temp_dir()),
            tmux_bin: "tmux".to_string(),
            list_timeout: TMUX_LIST_TIMEOUT,
            kill_timeout: TMUX_KILL_TIMEOUT,
            create_timeout: TMUX_CREATE_TIMEOUT,
        }
    }

    /// Create a `SessionManager` with a custom base directory for env scripts.
    /// Useful for tests and containerized environments with a non-`/tmp`
    /// temporary directory policy.
    pub fn with_script_dir(script_dir: PathBuf) -> Self {
        Self {
            env: EnvManager::new(script_dir),
            ..Self::new()
        }
    }

    /// Test seam: override the tmux binary (inject a fake `tmux`).
    #[cfg(test)]
    pub(crate) fn with_tmux_bin(&mut self, tmux_bin: impl Into<String>) -> &mut Self {
        self.tmux_bin = tmux_bin.into();
        self
    }

    /// Test seam: override per-command timeouts for fast, deterministic tests.
    #[cfg(test)]
    pub(crate) fn with_timeouts(
        &mut self,
        list: Duration,
        kill: Duration,
        create: Duration,
    ) -> &mut Self {
        self.list_timeout = list;
        self.kill_timeout = kill;
        self.create_timeout = create;
        self
    }

    /// Access the environment manager for set/source/unsource operations.
    pub fn env(&self) -> &EnvManager {
        &self.env
    }

    pub async fn list_sessions(&self) -> Result<Vec<SessionInfo>> {
        let mut cmd = Command::new(&self.tmux_bin);
        cmd.args([
            "list-sessions",
            "-F",
            // Use | (pipe) as delimiter. Tmux converts tab characters (0x09)
            // in -F format strings to underscores (0x5F), so \t is unusable.
            "#{session_name}|#{session_created}|#{session_windows}|#{session_attached}|#{window_width}|#{window_height}",
        ]);
        let output = tmux_output(&mut cmd, self.list_timeout).await?;

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

    /// Query the current working directory of a tmux session's active pane.
    pub async fn get_session_cwd(&self, session_name: &str) -> Result<String> {
        let mut cmd = Command::new(&self.tmux_bin);
        cmd.args([
            "display-message",
            "-p",
            "-t",
            session_name,
            "-F",
            "#{pane_current_path}",
        ]);
        let output = tmux_output(&mut cmd, self.list_timeout).await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow::anyhow!(
                "tmux display-message failed for session {}: {}",
                session_name,
                stderr.trim()
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(stdout.trim().to_string())
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
        width: u16,
        height: u16,
        working_dir: &str,
        env: &[(String, String)],
    ) -> Result<()> {
        match tokio::time::timeout(
            self.create_timeout,
            self.create_session_impl(name, width, height, working_dir, env),
        )
        .await
        {
            Err(_) => Err(anyhow::anyhow!(
                "tmux create-session timed out after {:?}",
                self.create_timeout
            )),
            Ok(inner) => inner,
        }
    }

    async fn create_session_impl(
        &self,
        name: &str,
        _width: u16,
        _height: u16,
        working_dir: &str,
        env: &[(String, String)],
    ) -> Result<()> {
        // Stage 1: try with `-e` (tmux ≥ 3.0).  This injects env vars directly
        // into the shell process so they take effect before bashrc runs — the
        // only reliable way to set PS1 on Debian (bashrc unconditionally
        // overwrites it).
        let mut cmd = Command::new(&self.tmux_bin);
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

        // Pass through the agent process environment (PATH, NODE_PATH, etc.)
        // so tools installed via init container are available in tmux sessions.
        // Skip TERM — we force xterm-256color below regardless of what the
        // container has (typically unset or "dumb").
        // Skip the caller-supplied env keys — those are handled below.
        // Collect first — std::env::vars() iterator is not Send.
        let caller_keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        let process_env: Vec<(String, String)> = std::env::vars().collect();
        for (key, value) in process_env.iter() {
            if key == "TERM"
                || key == "LANG"
                || key == "LC_ALL"
                || caller_keys.iter().any(|k| *k == key)
            {
                continue;
            }
            cmd.arg("-e").arg(format!("{key}={value}"));
        }
        // Force TERM and locale so TUI apps render correctly.
        // Containers default to C/POSIX locale (no Unicode) → box-drawing
        // characters become underscores; TERM is typically unset or "dumb".
        cmd.arg("-e").arg("TERM=xterm-256color");
        cmd.arg("-e").arg("LANG=C.UTF-8");

        let mut has_ps1 = false;
        for (key, value) in env {
            if key == "PS1" {
                has_ps1 = true;
            }
            cmd.arg("-e").arg(format!("{key}={value}"));
        }
        if !has_ps1 {
            cmd.arg("-e").arg(format!("NESSON_PS1={DEFAULT_PS1}"));
            cmd.arg("-e").arg(
                "PROMPT_COMMAND=[ -n \"$NESSON_PS1\" ] && { PS1=\"$NESSON_PS1\"; unset NESSON_PS1; }",
            );
        }

        let status = cmd.status().await?;
        let use_e = status.success();

        if !use_e {
            // Stage 2 (fallback): `-e` not supported (tmux < 3.0).
            // Retry without it, then inject via set-environment for future
            // windows and send-keys for the already-running initial shell.
            let mut cmd2 = Command::new(&self.tmux_bin);
            cmd2.args([
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

            let status2 = cmd2.status().await?;
            if !status2.success() {
                anyhow::bail!("Failed to create session: {name}");
            }

            // Inject env vars into the live shell via send-keys.
            let mut init_cmd = String::from("export TERM=xterm-256color;export LANG=C.UTF-8;");
            for (key, value) in &process_env {
                if key == "TERM"
                    || key == "LANG"
                    || key == "LC_ALL"
                    || caller_keys.iter().any(|k| *k == key)
                {
                    continue;
                }
                init_cmd.push_str(&format!("export {key}='{}';", value.replace('\'', "'\\''")));
            }
            for (key, value) in env {
                init_cmd.push_str(&format!("export {key}='{}';", value.replace('\'', "'\\''")));
            }
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
                let _ = Command::new(&self.tmux_bin)
                    .args(["send-keys", "-t", name, &init_cmd, "Enter"])
                    .stderr(std::process::Stdio::null())
                    .status()
                    .await;
                let _ = Command::new(&self.tmux_bin)
                    .args(["clear-history", "-t", name])
                    .stderr(std::process::Stdio::null())
                    .status()
                    .await;
            }
        }

        // Stage 3: set-environment for future windows/panes (both paths).
        let _ = Command::new(&self.tmux_bin)
            .args(["set-environment", "-t", name, "TERM", "xterm-256color"])
            .stderr(std::process::Stdio::null())
            .status()
            .await;
        let _ = Command::new(&self.tmux_bin)
            .args(["set-environment", "-t", name, "LANG", "C.UTF-8"])
            .stderr(std::process::Stdio::null())
            .status()
            .await;
        for (key, value) in &process_env {
            if key == "TERM"
                || key == "LANG"
                || key == "LC_ALL"
                || caller_keys.iter().any(|k| *k == key)
            {
                continue;
            }
            let _ = Command::new(&self.tmux_bin)
                .args(["set-environment", "-t", name, key, value])
                .stderr(std::process::Stdio::null())
                .status()
                .await;
        }
        for (key, value) in env {
            let _ = Command::new(&self.tmux_bin)
                .args(["set-environment", "-t", name, key, value])
                .stderr(std::process::Stdio::null())
                .status()
                .await;
        }
        if !has_ps1 {
            let _ = Command::new(&self.tmux_bin)
                .args(["set-environment", "-t", name, "NESSON_PS1", DEFAULT_PS1])
                .stderr(std::process::Stdio::null())
                .status()
                .await;
            let _ = Command::new(&self.tmux_bin)
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

        // Enable tmux mouse mode so mouse events reach tmux as SGR sequences
        // (copy-mode scroll, pane selection, and forwarding to TUI apps).
        // The web client lets xterm.js use its default behaviour — mouse
        // clicks pass through to the PTY; hold Shift for local selection.
        let _ = Command::new(&self.tmux_bin)
            .args(["set-option", "-t", name, "mouse", "on"])
            .stderr(std::process::Stdio::null())
            .status()
            .await;

        Ok(())
    }

    pub async fn kill_session(&self, name: &str) -> Result<()> {
        let mut cmd = Command::new(&self.tmux_bin);
        cmd.args(["kill-session", "-t", name])
            .stderr(std::process::Stdio::null());
        let status = tmux_status(&mut cmd, self.kill_timeout).await?;

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

/// Run a tmux command, failing with a timeout error if it exceeds `timeout`.
async fn tmux_output(cmd: &mut Command, timeout: Duration) -> Result<std::process::Output> {
    match tokio::time::timeout(timeout, cmd.output()).await {
        Err(_) => Err(anyhow::anyhow!("tmux command timed out after {timeout:?}")),
        Ok(res) => Ok(res?),
    }
}

/// Run a tmux command that only needs its exit status, with a timeout.
async fn tmux_status(cmd: &mut Command, timeout: Duration) -> Result<std::process::ExitStatus> {
    match tokio::time::timeout(timeout, cmd.status()).await {
        Err(_) => Err(anyhow::anyhow!("tmux command timed out after {timeout:?}")),
        Ok(res) => Ok(res?),
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

    #[tokio::test]
    async fn get_session_cwd_returns_path() {
        if Command::new("tmux").arg("-V").status().await.is_err() {
            eprintln!("tmux not available, skipping");
            return;
        }

        let mgr = SessionManager::new();
        let name = unique_name("cwd-test");
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();

        mgr.create_session(&name, 200, 60, &cwd, &[])
            .await
            .expect("create");

        let result = mgr.get_session_cwd(&name).await.expect("get_session_cwd");
        // Canonicalize both paths: macOS /var is a symlink to /private/var,
        // and tmux may resolve symlinks differently from std::env::temp_dir().
        let expected = std::fs::canonicalize(&cwd).unwrap_or_else(|_| PathBuf::from(&cwd));
        let actual = std::fs::canonicalize(&result).unwrap_or_else(|_| PathBuf::from(&result));
        assert_eq!(
            actual, expected,
            "CWD should match the session's working directory"
        );

        let _ = Command::new("tmux")
            .args(["kill-session", "-t", &name])
            .status()
            .await;
    }

    #[tokio::test]
    async fn tmux_output_times_out() {
        let mut cmd = Command::new("sleep");
        cmd.arg("30");
        let start = std::time::Instant::now();
        let res = tmux_output(&mut cmd, Duration::from_millis(100)).await;
        assert!(res.is_err(), "expected timeout error, got {res:?}");
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn tmux_status_times_out() {
        let mut cmd = Command::new("sleep");
        cmd.arg("30");
        let res = tmux_status(&mut cmd, Duration::from_millis(100)).await;
        assert!(res.is_err(), "expected timeout error, got {res:?}");
    }
}
