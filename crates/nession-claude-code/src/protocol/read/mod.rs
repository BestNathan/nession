//! `claude-code.read` — one file out of a `.claude/` directory, paginated.

pub mod v1;

pub use v1::{
    chunk, descriptor, ReadFailureV1, ReadOkV1, ReadRequestV1, ReadResponseV1, Scope,
    CHUNK_CEILING, FILE_CEILING,
};

pub const ID: &str = "claude-code.read";

/// What the registry hands `handle_command`.
///
/// The same string as `ID` below and as `v1::WIRE`. The wire *is* the protocol
/// id now — the registry passes `msg_type` through verbatim, with no namespace
/// left to strip — so there is nothing to translate. Three names for one
/// string, because they answer three different questions: identity, dispatch
/// key, transport projection. That they cannot drift apart is pinned by
/// `the_command_the_wire_and_the_id_are_one_string` in the parent module.
pub const COMMAND: &str = "claude-code.read";
