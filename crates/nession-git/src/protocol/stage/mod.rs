//! `git.stage` — stage one repository-relative path.

pub mod v1;

pub use v1::{descriptor, StageOkV1, StageRequestV1};

/// The protocol id, spelled once.
pub const ID: &str = "git.stage";
