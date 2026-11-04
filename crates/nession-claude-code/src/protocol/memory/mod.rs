//! `claude-code.memory` — the current Session's repository Auto Memory.

pub mod v1;

pub use v1::{
    descriptor, MemoryFileV1, MemoryRepositoryKindV1, MemoryRequestV1, MemoryResponseV1,
    MemoryStateV1,
};

pub const ID: &str = "claude-code.memory";

/// What the registry hands `handle_command`; the wire *is* the id.
pub const COMMAND: &str = "claude-code.memory";
