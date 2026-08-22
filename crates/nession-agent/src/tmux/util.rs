//! Stateless tmux command helpers.
//!
//! Thin wrappers over `tmux` subcommands that don't belong to a specific
//! session backend or manager: sending keys, checking availability, capturing
//! scrollback, and running a session-scoped subcommand with consistent error
//! reporting.

use anyhow::{Context, Result};
use tokio::process::Command;

/// Run a tmux subcommand against a named session.
///
/// Spawns `tmux <args> -t <session>` and waits for completion. Returns
/// `Ok(())` on success, or an error with the command description and exit
/// status on failure.
///
/// Prefer this over ad-hoc `Command::new("tmux")` calls — it ensures
/// consistent error reporting (including the exit status in the message).
pub async fn run_tmux_command(session: &str, args: &[&str]) -> Result<()> {
    let mut cmd = Command::new("tmux");
    cmd.args(args)
        .arg("-t")
        .arg(session)
        .stderr(std::process::Stdio::null());
    let desc = format!("tmux {} -t {session}", args.join(" "));
    let status = cmd
        .status()
        .await
        .with_context(|| format!("failed to spawn {desc}"))?;
    if !status.success() {
        anyhow::bail!("{desc} exited with status: {status}");
    }
    Ok(())
}

/// Send a line of keystrokes to a session, followed by Enter.
pub async fn send_keys(session_name: &str, keys: &str) -> Result<()> {
    let status = Command::new("tmux")
        .args(["send-keys", "-t", session_name, keys, "Enter"])
        .stderr(std::process::Stdio::null())
        .status()
        .await?;

    if !status.success() {
        anyhow::bail!("Failed to send keys to session: {session_name}");
    }

    Ok(())
}

/// Check whether the `tmux` binary is available on `PATH`.
pub async fn check_tmux_available() -> Result<bool> {
    let status = Command::new("tmux")
        .arg("-V")
        .stderr(std::process::Stdio::null())
        .status()
        .await?;
    Ok(status.success())
}

/// Capture the last `lines` lines of scrollback for a session's active pane,
/// including ANSI escape sequences so xterm.js can render formatting.
///
/// Returns:
/// - `Ok(Some(bytes))` — tmux exited 0 and stdout is non-empty.
/// - `Ok(None)` — tmux exited 0 but stdout is empty (session exists, no history yet).
/// - `Err(e)` — tmux binary missing, failed to spawn, or exited non-zero.
pub async fn capture_scrollback(
    session: &str,
    lines: u32,
) -> Result<Option<Vec<u8>>, std::io::Error> {
    let lines_str = lines.to_string();
    let output = Command::new("tmux")
        .args([
            "capture-pane",
            "-t",
            session,
            "-p",
            "-S",
            &format!("-{lines_str}"),
            "-E",
            "-",
            "-e",
        ])
        .output()
        .await?;
    if output.status.success() {
        if output.stdout.is_empty() {
            Ok(None)
        } else {
            Ok(Some(output.stdout))
        }
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(std::io::Error::other(format!(
            "tmux capture-pane failed: {stderr}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestSession;
    use crate::tmux::manager::SessionManager;

    #[tokio::test]
    async fn capture_scrollback_fresh_session_returns_ok() {
        // A brand-new tmux session still has *some* content (shell prompt /
        // status bar), so the result is Ok(Some(…)), not Ok(None). This test
        // pins the 3-state contract: tmux success → Ok(_).
        if !check_tmux_available().await.unwrap_or(false) {
            return;
        }
        let ts = TestSession::new("preview-fresh");
        let mgr = SessionManager::new();
        mgr.create_session(ts.name(), 80, 24, "/tmp", &[])
            .await
            .expect("create session");
        let result = capture_scrollback(ts.name(), 100).await;
        assert!(
            result.is_ok(),
            "expected Ok(_) for fresh session, got {result:?}"
        );
    }

    #[tokio::test]
    async fn capture_scrollback_with_output_returns_some() {
        if !check_tmux_available().await.unwrap_or(false) {
            return;
        }
        let ts = TestSession::new("preview-output");
        let mgr = SessionManager::new();
        mgr.create_session(ts.name(), 80, 24, "/tmp", &[])
            .await
            .expect("create session");
        send_keys(ts.name(), "echo hello").await.expect("send keys");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let result = capture_scrollback(ts.name(), 100).await;
        assert!(
            matches!(result, Ok(Some(_))),
            "expected Ok(Some(_)) after output, got {result:?}"
        );
    }

    #[tokio::test]
    async fn capture_scrollback_nonexistent_session_returns_error() {
        if !check_tmux_available().await.unwrap_or(false) {
            return;
        }
        let result = capture_scrollback("nession-test-does-not-exist-xyz", 100).await;
        assert!(result.is_err(), "expected error for nonexistent session");
    }
}
