//! `claude-code.transcripts` — the transcripts of one Nession Session: each
//! session's own, and the subagents it spawned.

pub mod v1;

pub use v1::{
    descriptor, TranscriptBindingV1, TranscriptItemV1, TranscriptKindV1, TranscriptsRequestV1,
    TranscriptsResponseV1, TranscriptsStateV1,
};

pub const ID: &str = "claude-code.transcripts";

/// What the registry hands `handle_command` — the same string as `ID` and as
/// `v1::WIRE` (see `list/mod.rs` for why the three are one).
pub const COMMAND: &str = "claude-code.transcripts";
