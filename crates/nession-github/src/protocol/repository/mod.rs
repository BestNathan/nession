//! `github.repository` — the selected hosting identity and its discovered
//! alternatives.

pub mod v1;

pub use v1::{descriptor, RepositoryOkV1, RepositoryRequestV1, RepositoryStateV1};

pub const ID: &str = "github.repository";
