//! `git.log` — recent commits on the current branch.

pub mod v1;

pub use v1::{descriptor, LogOkV1, LogRequestV1};

pub const ID: &str = "git.log";
