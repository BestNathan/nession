//! `git.create-commit` — create one normal local commit from the index.

pub mod v1;

pub use v1::{descriptor, CommitCreatedV1, CreateCommitOkV1, CreateCommitRequestV1};

/// The protocol id, spelled once.
pub const ID: &str = "git.create-commit";
