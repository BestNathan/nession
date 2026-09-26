//! `git.commit` — one commit's metadata and changed-file summary.

pub mod v1;

pub const ID: &str = "git.commit";

pub use v1::{descriptor, CommitOkV1, CommitRequestV1, CommitResponseV1};
