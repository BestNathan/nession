//! `git.preview` — bounded read-only worktree file content for one status row.

pub mod v1;

pub use v1::{descriptor, PreviewOkV1, PreviewRequestV1};

pub const ID: &str = "git.preview";
