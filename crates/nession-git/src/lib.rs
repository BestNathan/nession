//! Read-only git state for a Session's working directory (#750).
//!
//! The capability answers five questions about the repository a Session is
//! sitting in — *what state is it in* (`status`), *what changed in this file*
//! (`diff`), *what happened here recently* (`log`), *what other branches are
//! there* (`branches`), and *what other checkouts are there* (`worktrees`) —
//! and refuses the rest. Reads only: no stage, no commit, no checkout. See
//! `cmd.rs` for why that is enforced in code rather than by convention.
//!
//! ## Layout
//!
//! Two halves, and the split is the point — see [`protocol`] for the contracts
//! and [`runtime`] for what serves them.
//!
//! - [`protocol`] — the typed requests, responses and `ProtocolDescriptor`s.
//! - [`runtime::cmd`] — the only place a `git` process is spawned: explicit
//!   `-C`, scrubbed environment, timeout, mutating subcommands refused.
//! - [`runtime::security`] — path and byte boundaries; the client may name a
//!   relative path inside the repository and nothing else.
//! - [`runtime::status`] — `--porcelain=v2` parsing, including unmerged
//!   (conflicted) state rather than pretending a paused rebase is a set of
//!   edits.
//! - [`runtime::diff`] — one file's diff against HEAD, capped, with truncation
//!   reported.
//! - [`runtime::log`] — recent commits, bounded by count and by bytes.
//! - [`runtime::branches`] — local branches and their tracking state, current
//!   first.
//! - [`runtime::worktrees`] — the repository's other checkouts, and this one
//!   marked.
//! - [`agent`] — the `AgentExtension` implementation, where the types are
//!   erased back to `Value`.
//!
//! ## What this crate deliberately does not own
//!
//! Where the working directory *comes from*. That is a tmux question — the
//! session's shell can `cd` at any time — and tmux has its own chokepoint in
//! `nession-agent`. The agent injects a resolver, so this crate never addresses
//! a tmux server and the agent never spawns git.

pub mod agent;
pub mod protocol;
pub mod runtime;

// The implementation modules keep their flat public paths — `nession_git::cmd`
// and `nession_git::status` are what this crate's tests and the agent name —
// while the *directory* says which half is the contract and which is the
// implementation. A re-export is a path, not a second definition; there is
// still one file behind each of these.
pub use runtime::{branches, cmd, diff, log, security, status, worktrees};

pub use agent::{GitAgentExtension, WorkdirResolver};
pub use branches::{Branch, Branches};
pub use cmd::{GitCmd, GitOutput};
pub use diff::FileDiff;
pub use log::{Commit, History};
pub use status::{ChangeKind, ChangedFile, RepoStatus};
pub use worktrees::{Worktree, Worktrees};
