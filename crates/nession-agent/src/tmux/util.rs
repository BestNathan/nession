//! Stateless tmux command helpers.
//!
//! Thin wrappers over `tmux` subcommands that don't belong to a specific
//! session backend or manager: checking availability, reading the version,
//! capturing scrollback, and running a session-scoped subcommand with
//! consistent error reporting.
//!
//! Grammar does not live here. Where a helper needs a reusable tmux operation
//! it calls [`TmuxOps`], which is the one place its argument vector is written
//! — `send-keys` and the window-size query moved there in #991 step 5, each of
//! them having been written twice in this crate. What stays here is what is
//! genuinely this module's: the *class* of each call, said at the call site.

use anyhow::{Context, Result};

use super::cmd;
use super::ops::TmuxOps;

/// Default window size for a session whose size could not be read.
///
/// Deliberately not a dimension of anything: it is the value the pre-#991 code
/// fell back to, and it exists so that [`capture_scrollback`]'s `BestEffort`
/// class is visible in one place instead of folded into the owner.
const FALLBACK_WINDOW_SIZE: (u16, u16) = (80, 24);

/// Run a tmux subcommand against a named session.
///
/// Spawns `tmux <args> -t <session>` and waits for completion. Returns
/// `Ok(())` on success, or an error with the command description and exit
/// status on failure.
///
/// Prefer this for session-scoped subcommands — it gives consistent error
/// reporting (including the exit status in the message). It is not the
/// isolation boundary: every tmux process in this crate, this one included, is
/// spawned by [`super::cmd`], which is what guarantees the `-S` socket flag.
///
/// **Not the place for new grammar.** Its one caller is `control.rs`'s
/// attach-time `resize-window`, which #991 assigns to step 8 — a caller
/// *supplies the argument vector here*, so anything reusable added on top of it
/// would be the `run(args: &[&str])` shape #991 rules out. A reusable operation
/// belongs in [`TmuxOps`].
pub async fn run_tmux_command(session: &str, args: &[&str]) -> Result<()> {
    let mut cmd = cmd::global().tokio();
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

/// A session's window size, or [`FALLBACK_WINDOW_SIZE`] when tmux cannot be
/// asked.
///
/// **BestEffort at this call site, and that is the whole point of the split**:
/// [`TmuxOps::window_size`] returns the failure, and the caller is the one that
/// decides what it means. Here it means "capture a session whose size we could
/// not read" — the scrollback is still the scrollback, so the answer is 80×24
/// rather than an error (#991's operation classes; the owner never supplies a
/// default of its own).
///
/// This is also where the two failure policies that used to hide inside two
/// hand-written copies of one query stay distinguishable: `server/websocket.rs`
/// propagates the same `Err` instead of falling back.
async fn window_size_or_fallback(session: &str) -> (u16, u16) {
    TmuxOps::global()
        .window_size(session)
        .await
        .unwrap_or(FALLBACK_WINDOW_SIZE)
}

/// Check whether the `tmux` binary is available on `PATH`.
pub async fn check_tmux_available() -> Result<bool> {
    let status = cmd::global()
        .tokio()
        .arg("-V")
        .stderr(std::process::Stdio::null())
        .status()
        .await?;
    Ok(status.success())
}

/// Version string reported by `tmux -V`, or `"unknown"` if it cannot be read.
///
/// Shared by the agent binary and the CLI's bare-metal agent mode; both used to
/// keep their own copy, and a copy is a place for an un-socketed tmux spawn to
/// reappear.
pub async fn tmux_version() -> String {
    cmd::global()
        .tokio()
        .arg("-V")
        .output()
        .await
        .ok()
        .and_then(|output| {
            if output.status.success() {
                Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "unknown".to_string())
}

/// Capture the last `lines` lines of scrollback for a session's active pane,
/// including ANSI escape sequences so xterm.js can render formatting.
///
/// Returns:
/// - `Ok(Some((bytes, cols, rows)))` — tmux exited 0 and stdout is non-empty.
/// - `Ok(None)` — tmux exited 0 but stdout is empty (session exists, no history yet).
/// - `Err(e)` — the `capture-pane` spawn failed or it exited non-zero.
///
/// `cols`/`rows` are the session's window size when it could be read and 80×24
/// when it could not — a capture that cannot be told apart from a smaller
/// session is worse than a capture with a stale guess, which is the tradeoff
/// this call site makes and the one `server/websocket.rs` declines to make.
pub async fn capture_scrollback(
    session: &str,
    lines: u32,
) -> Result<Option<(Vec<u8>, u16, u16)>, std::io::Error> {
    // First, get the session dimensions — BestEffort, see
    // `window_size_or_fallback`. The query itself is the owner's.
    let (cols, rows) = window_size_or_fallback(session).await;

    // Then capture the scrollback
    let lines_str = lines.to_string();
    let output = cmd::global()
        .tokio()
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
            Ok(Some((output.stdout, cols, rows)))
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
        crate::tmux::ops::TmuxOps::global()
            .send_keys(ts.name(), "echo hello")
            .await
            .expect("send keys");
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

    #[tokio::test]
    async fn window_size_falls_back_when_tmux_cannot_be_asked() {
        // The `BestEffort` half of the split, and the behaviour the pre-#991
        // code had: a session tmux will not answer for is captured at 80×24
        // rather than refused.
        //
        // The mutation this pins is on `window_size_or_fallback` — changing the
        // constant reddens it, and propagating the error (`?`) instead of
        // falling back removes the function's whole value. Against real tmux a
        // missing session is an *empty answer with exit 0* (measured on 3.6b),
        // so this exercises the parse arm; the non-zero-exit arm is asserted in
        // `ops.rs`.
        if !check_tmux_available().await.unwrap_or(false) {
            return;
        }
        assert_eq!(
            window_size_or_fallback("nession-test-does-not-exist-xyz").await,
            FALLBACK_WINDOW_SIZE
        );
        assert_eq!(
            FALLBACK_WINDOW_SIZE,
            (80, 24),
            "the fallback is the value callers have seen since before #991"
        );
    }
}
