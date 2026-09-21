//! `claude-code.read` — one file out of a `.claude/` directory, paginated.

pub mod v1;

pub use v1::{
    chunk, descriptor, ReadFailureV1, ReadOkV1, ReadRequestV1, ReadResponseV1, Scope,
    CHUNK_CEILING, FILE_CEILING,
};

pub const ID: &str = "claude-code.read";

/// What the registry hands `handle_command` after stripping `extension.`.
///
/// Not the id — see the parent module on why this provider translates where
/// `nession-git` can compare.
pub const COMMAND: &str = "claude-code.read";
