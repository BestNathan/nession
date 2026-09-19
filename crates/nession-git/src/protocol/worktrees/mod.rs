//! `git.worktrees` — the repository's other checkouts, and this one.

pub mod v1;

pub use v1::{descriptor, WorktreesOkV1, WorktreesRequestV1};

pub const ID: &str = "git.worktrees";
