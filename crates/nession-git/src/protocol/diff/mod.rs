//! `git.diff` — one file against HEAD.

pub mod v1;

pub use v1::{descriptor, DiffOkV1, DiffRequestV1};

pub const ID: &str = "git.diff";
