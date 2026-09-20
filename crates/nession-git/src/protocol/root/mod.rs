//! `git.root` — the work tree's address, without the listing.
//!
//! A caller entering the Workspace from a Terminal Peek already has the Peek's
//! context and wants the address, not a second full status read
//! (`#826`: the handoff preserves repo/worktree context).

pub mod v1;

pub use v1::{descriptor, RootOkV1, RootRequestV1};

pub const ID: &str = "git.root";
