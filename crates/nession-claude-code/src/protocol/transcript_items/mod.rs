//! `claude-code.transcript-items` — the execution timeline of one explicitly
//! named transcript.

pub mod v1;

pub use v1::{
    descriptor, EventCategoryV1, MessageSourceV1, TranscriptEntryV1, TranscriptItemsRequestV1,
    TranscriptItemsResponseV1, TranscriptItemsStateV1, TranscriptParseStatsV1,
};

pub const ID: &str = "claude-code.transcript-items";

/// What the registry hands `handle_command` — the same string as `ID` and as
/// `v1::WIRE` (see `list/mod.rs` for why the three are one).
pub const COMMAND: &str = "claude-code.transcript-items";
