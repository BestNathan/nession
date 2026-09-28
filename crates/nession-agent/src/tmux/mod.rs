pub mod cmd;
pub mod control;
pub mod env;
pub mod manager;
pub mod ops;
pub mod parser;
pub mod pty;
pub mod session;
pub mod util;

/// How many lines of history a Session's windows retain — and therefore how
/// much a client can be given when it attaches (#321).
///
/// **One number, in one place, because it is the same number at both ends.**
/// The create path sets it (a window that retains less than this cannot satisfy
/// a bootstrap that asks for it) and the bootstrap asks for it. Two constants
/// would be two answers to one question.
///
/// **It is the agent's decision, not the image's.** It used to be neither: the
/// agent set nothing, tmux defaulted to 2000, and the container image's
/// `/root/.tmux.conf` said 50000 — so a bare-metal agent and a container agent
/// retained different amounts, and `deploy/entrypoint-agent.sh` only writes
/// that file when it is *missing*, which means a PVC-backed `/root` keeps
/// whatever an older image wrote, forever.
///
/// **`set-option -t <session>` would not work.** From the tmux manual:
/// "This setting applies only to new windows - existing window histories are
/// not resized and retain the limit at the point they were created." It is a
/// *server default*, so it has to be set before the window exists — at agent
/// startup, and again before a create that may have brought a fresh tmux server
/// up. See [`ops::TmuxOps::set_history_limit_default`].
///
/// 5000 is the owner's figure (issue #321, 2026-08-20: fixed for all platforms,
/// replacing an earlier 50k-with-progressive-load design). The bootstrap is a
/// bounded snapshot, not replay retention — that is #1094.
pub const HISTORY_LIMIT_LINES: u32 = 5000;
