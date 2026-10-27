//! The tmux **dependency** a Nession domain type runs on.
//!
//! The tmux operation grammar itself lives in the independent `nession-tmux`
//! crate (`nession_tmux::ops`): typed argument vectors, the parsers, and the
//! result policy boundaries documented there. This module keeps the one thing
//! Nession adds — [`TmuxDep`], which resolves the process-wide or an injected
//! [`TmuxCmd`](super::cmd::TmuxCmd) per use and hands the corresponding SDK
//! command to the operation owner.
//!
//! ```text
//! nession_tmux::TmuxCommand  = process / socket boundary
//! nession_tmux::TmuxOps      = tmux semantic boundary
//! TmuxDep                    = Nession's substitution seam
//! SessionManager / EnvManager / attach backends = Nession domain boundary
//! ```
//!
//! A `TmuxDep` built with [`TmuxDep::global`] resolves [`cmd::global`] on
//! **every** use rather than once: a value frozen before
//! [`cmd::configure`](super::cmd::configure) would pin the process to the
//! fallback socket for its whole life, and `configure`'s already-set check
//! compares against `cmd::global()`, so it could not see that it had been
//! bypassed. The injected arm is the one that is fixed by construction — that
//! is what injecting means.

pub use nession_tmux::ops::{PaneModeFlags, TmuxOps};

use super::cmd::{self, TmuxCmd};

/// One tmux addressing, resolved per use, from which the operation owner is
/// derived.
#[derive(Debug, Clone)]
pub struct TmuxDep(Option<TmuxCmd>);

impl TmuxDep {
    /// The process-wide addressing, resolved per use.
    pub fn global() -> Self {
        Self(None)
    }

    /// Exactly this addressing — what a test hands in so that one fake tmux
    /// binary covers every operation in the path.
    pub fn injected(cmd: TmuxCmd) -> Self {
        Self(Some(cmd))
    }

    /// The process addressing to build a command on.
    pub fn cmd(&self) -> TmuxCmd {
        self.0.clone().unwrap_or_else(|| cmd::global().clone())
    }

    /// The tmux operation owner bound to that addressing.
    pub fn ops(&self) -> TmuxOps {
        TmuxOps::new(self.cmd().as_sdk().clone())
    }

    /// The SDK process owner this addressing resolves to.
    ///
    /// The Control Mode client lives in `nession-tmux` and takes an explicit
    /// command; this keeps the Agent's per-use resolution (global vs injected)
    /// authoritative for both one-shot and attached operations.
    pub fn sdk(&self) -> nession_tmux::TmuxCommand {
        self.cmd().as_sdk().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dep_resolves_the_process_socket_until_it_is_injected() {
        let socket = std::path::PathBuf::from("/tmp/nession-tmux-dep-probe/tmux.sock");
        // The default resolves the process-wide addressing on every use.
        assert_eq!(
            TmuxDep::global().cmd().socket_path(),
            cmd::global().socket_path()
        );
        // Injection is fixed by construction, and the operation owner sees the
        // same addressing (the seam would exist but not bind otherwise).
        let injected = TmuxDep::injected(TmuxCmd::new("tmux", socket.clone()));
        assert_eq!(injected.cmd().socket_path(), socket.as_path());
        assert_eq!(injected.ops().command().socket_path(), socket.as_path());
        assert_eq!(injected.ops().command().bin(), "tmux");
    }
}
