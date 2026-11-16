//! `claude-code.transcript-record` — one raw record's bounded full text.

pub mod v1;

pub use v1::{
    descriptor, TranscriptRecordRequestV1, TranscriptRecordResponseV1, TranscriptRecordStateV1,
    CHUNK_CEILING, DEFAULT_CHUNK,
};

pub const ID: &str = "claude-code.transcript-record";

/// What the registry hands `handle_command` — the same string as `ID` and as
/// `v1::WIRE`.
pub const COMMAND: &str = "claude-code.transcript-record";
