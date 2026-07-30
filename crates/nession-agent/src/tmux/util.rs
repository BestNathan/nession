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
/// Returns the raw ANSI bytes on success, or `None` if the capture fails
/// (e.g. session has no panes, tmux not available).
pub async fn capture_scrollback(session: &str, lines: u16) -> Option<Vec<u8>> {
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
        .await
        .ok()?;
    if output.status.success() && !output.stdout.is_empty() {
        Some(output.stdout)
    } else {
        None
    }
}
