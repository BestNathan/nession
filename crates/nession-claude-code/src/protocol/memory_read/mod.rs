//! `claude-code.memory-read` — one Auto Memory file, paginated.

pub mod v1;

pub use v1::{
    descriptor, MemoryReadFailureV1, MemoryReadOkV1, MemoryReadRequestV1, MemoryReadResponseV1,
};

pub const ID: &str = "claude-code.memory-read";

/// What the registry hands `handle_command`; the wire *is* the id.
pub const COMMAND: &str = "claude-code.memory-read";
