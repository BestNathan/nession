//! `claude-code.transcript-records` — one page of raw transcript records.

pub mod v1;

pub use v1::{
    descriptor, TranscriptRecordV1, TranscriptRecordsRequestV1, TranscriptRecordsResponseV1,
    TranscriptRecordsStateV1, PAGE_INLINE_BUDGET, RECORD_INLINE_CEILING,
};

pub const ID: &str = "claude-code.transcript-records";

/// What the registry hands `handle_command` — the same string as `ID` and as
/// `v1::WIRE`.
pub const COMMAND: &str = "claude-code.transcript-records";
