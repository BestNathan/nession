//! Common interface for tmux attach backends.
//!
//! Both [`PtySession`](super::pty::PtySession) (plain PTY) and
//! [`ControlModeSession`](super::control::ControlModeSession) (tmux `-C`
//! control mode) expose the same lifecycle to the WebSocket layer: write
//! input, resize the viewport, query dimensions and name, and close. This
//! trait captures that interface so callers can hold a `Box<dyn TmuxSession>`
//! instead of matching on a backend-specific enum.
//!
//! The trait is `async` (via `async-trait`) because the control-mode backend
//! drives tmux through an async child process; the PTY backend's synchronous
//! writes are trivially wrapped.

use anyhow::Result;
use async_trait::async_trait;

/// A tmux attach session, independent of the backend used to reach tmux.
///
/// Implementors forward terminal input, propagate viewport resizes, and clean
/// up the underlying tmux process on [`close`](TmuxSession::close) or drop.
#[async_trait]
pub trait TmuxSession: Send {
    /// Forward raw input bytes to the tmux session.
    async fn write_input(&mut self, data: &[u8]) -> Result<()>;

    /// Resize the tmux **window** to `cols` × `rows`.
    ///
    /// One window per session, one pane, shared by every attached client —
    /// this is not a per-client viewport, so a resize moves the pane for all of
    /// them (last write wins; see `tmux::control`'s module docs for the
    /// decision). The backends reach that one window by different routes — PTY
    /// size → `SIGWINCH`, or `resize-window` on control-mode stdin — so each
    /// implementation documents the resource it actually mutates.
    async fn resize(&mut self, cols: u16, rows: u16) -> Result<()>;

    /// Current viewport dimensions as `(cols, rows)`.
    fn viewport(&self) -> (u16, u16);

    /// Name of the tmux session this backend is attached to.
    fn session_name(&self) -> &str;

    /// Close the session, terminating the underlying tmux process.
    ///
    /// Idempotent. Backends that terminate on drop may implement this as a
    /// no-op, but callers should prefer `close` for prompt, awaitable cleanup.
    async fn close(&mut self) -> Result<()>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tmux::pty::PtySession;

    /// A `PtySession` can be stored and driven as a `Box<dyn TmuxSession>`.
    /// This is the exact usage the WebSocket layer relies on. When tmux is on
    /// PATH the attach spawns (the session need not exist); when tmux is
    /// absent the attach errors — both paths are acceptable, we only assert
    /// the trait object dispatches correctly on the Ok path.
    #[tokio::test]
    async fn pty_session_usable_as_trait_object() {
        let Ok((session, _rx)) = PtySession::attach(
            &crate::tmux::ops::TmuxDep::global(),
            "__nession_trait_test__",
            80,
            24,
        ) else {
            return; // tmux not available — nothing to assert
        };
        let mut boxed: Box<dyn TmuxSession> = Box::new(session);
        assert_eq!(boxed.session_name(), "__nession_trait_test__");
        assert_eq!(boxed.viewport(), (80, 24));
        // close is idempotent and awaitable through the trait object.
        boxed.close().await.expect("close via trait object");
    }
}
