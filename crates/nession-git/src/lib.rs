//! Read-only git state for a Session's working directory (#750).
//!
//! The capability answers three questions about the repository a Session is
//! sitting in — *what state is it in* (`status`), *what changed in this file*
//! (`diff`), and *what happened here recently* (`log`) — and refuses the rest.
//! Reads only: no stage, no commit, no checkout. See `cmd.rs` for why that is
//! enforced in code rather than by convention.
//!
//! ## Layout
//!
//! - [`cmd`] — the only place a `git` process is spawned: explicit `-C`,
//!   scrubbed environment, timeout, mutating subcommands refused.
//! - [`security`] — path and byte boundaries; the client may name a relative
//!   path inside the repository and nothing else.
//! - [`status`] — `--porcelain=v2` parsing, including unmerged (conflicted)
//!   state rather than pretending a paused rebase is a set of edits.
//! - [`diff`] — one file's diff against HEAD, capped, with truncation reported.
//! - [`log`] — recent commits, bounded by count and by bytes.
//! - [`agent`] — the `AgentExtension` implementation.
//!
//! ## What this crate deliberately does not own
//!
//! Where the working directory *comes from*. That is a tmux question — the
//! session's shell can `cd` at any time — and tmux has its own chokepoint in
//! `nession-agent`. The agent injects a resolver, so this crate never addresses
//! a tmux server and the agent never spawns git.

pub mod agent;
pub mod cmd;
pub mod diff;
pub mod log;
pub mod security;
pub mod status;

pub use agent::{GitAgentExtension, WorkdirResolver};
pub use cmd::{GitCmd, GitOutput};
pub use diff::FileDiff;
pub use log::{Commit, History};
pub use status::{ChangeKind, ChangedFile, RepoStatus};
