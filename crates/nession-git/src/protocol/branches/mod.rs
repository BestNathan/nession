//! `git.branches` — local branches and their tracking state.

pub mod v1;

pub use v1::{descriptor, BranchesOkV1, BranchesRequestV1};

pub const ID: &str = "git.branches";
