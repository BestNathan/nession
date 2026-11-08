//! `git.unstage` — restore one path's index entry without touching the worktree.

pub mod v1;

pub use v1::{descriptor, UnstageOkV1, UnstageRequestV1};

/// The protocol id, spelled once.
pub const ID: &str = "git.unstage";
