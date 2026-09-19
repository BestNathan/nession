//! `git.status` — the repository's state as of one read.
//!
//! One module per Protocol Unit, one file per contract version. A v2 goes
//! beside `v1.rs`; `v1.rs` is never edited to express it.

pub mod v1;

pub use v1::{descriptor, StatusOkV1, StatusRequestV1};

/// The protocol id, spelled once. A second spelling is a second protocol.
pub const ID: &str = "git.status";
