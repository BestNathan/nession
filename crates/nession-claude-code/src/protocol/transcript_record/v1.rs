//! `claude-code.transcript-record` / v1 — one raw record's full text,
//! chunkable (`#3726`).
//!
//! A page from `claude-code.transcript-records` carries whole lines inline
//! when they fit. A record too large for a page arrives as a placeholder with
//! its `record_ref`; this unit is how the caller reads that record completely
//! without asking for an unbounded response. The reference is resource-scoped
//! and carries a generation fingerprint, so it cannot be replayed against
//! another transcript or a replaced file.
//!
//! The response is one bounded chunk of the line. `has_more` says whether the
//! line continues; a caller concatenates chunks until it is false. Invalid
//! UTF-8 is decoded lossily, exactly as page reads do, and chunk boundaries are
//! adjusted to character boundaries so no chunk ends mid-character.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::v1_descriptor;

pub const WIRE: &str = "claude-code.transcript-record";

/// Largest chunk this unit returns, in bytes.
pub const CHUNK_CEILING: u32 = 256 * 1024;

/// Chunk size when the caller names none.
pub const DEFAULT_CHUNK: u32 = 256 * 1024;

/// Where a single-record read stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[derive(schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptRecordStateV1 {
    /// The record was found and this chunk is part of it.
    Ready,
    /// The reference does not name a record visible to this Session.
    NotFound,
    /// The reference was issued for a different file generation.
    ///
    /// The caller must reload the transcript page; this response carries no
    /// bytes, so a stale reference never returns text from a replaced file.
    StaleGeneration,
    /// The provider cannot establish the Session's cwd, so it cannot scope the
    /// read.
    Unavailable,
    /// The read was attempted and failed. `error` carries the reason.
    Error,
}

/// What the caller asks for.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[derive(schemars::JsonSchema)]
pub struct TranscriptRecordRequestV1 {
    /// The Nession session the read is scoped to. Required.
    pub session_id: String,

    /// The `record_ref` from `claude-code.transcript-records`.
    pub record_ref: String,

    /// Byte offset within the record's line. Absent means the beginning.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub offset: Option<u64>,

    /// Requested chunk length in bytes, clamped to [`CHUNK_CEILING`].
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub limit: Option<u32>,
}

/// The answer: one chunk of one record.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[derive(schemars::JsonSchema)]
pub struct TranscriptRecordResponseV1 {
    pub state: TranscriptRecordStateV1,

    /// The reference this chunk belongs to, echoed for correlation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record_ref: Option<String>,

    /// The chunk text. Empty when the requested offset is at the line's end.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,

    /// Byte offset within the record's line where this chunk starts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,

    /// The record line's total length in bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,

    /// Whether more of the line exists after this chunk.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_more: Option<bool>,

    /// Byte offset within the line where the next chunk starts.
    ///
    /// Computed from the file, not from the decoded string's length: invalid
    /// UTF-8 is decoded lossily, so a client counting encoded bytes could
    /// overshoot or repeat a byte. Equal to `size_bytes` when the line ends.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u64>,

    /// The reason, when `state` is `Error`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl TranscriptRecordResponseV1 {
    /// The answer for a state that carries no bytes.
    pub fn bare(state: TranscriptRecordStateV1) -> Self {
        Self {
            state,
            record_ref: None,
            raw: None,
            offset: None,
            size_bytes: None,
            has_more: None,
            next_offset: None,
            error: None,
        }
    }

    /// The answer for a read that failed, carrying why.
    pub fn error(reason: impl Into<String>) -> Self {
        Self {
            error: Some(reason.into()),
            ..Self::bare(TranscriptRecordStateV1::Error)
        }
    }

    /// The requested chunk size, clamped.
    pub fn chunk_limit(requested: Option<u32>) -> u32 {
        requested.unwrap_or(DEFAULT_CHUNK).clamp(1, CHUNK_CEILING)
    }
}

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_chunk_limit_is_clamped_and_never_zero() {
        assert_eq!(TranscriptRecordResponseV1::chunk_limit(None), DEFAULT_CHUNK);
        assert_eq!(TranscriptRecordResponseV1::chunk_limit(Some(1024)), 1024);
        assert_eq!(
            TranscriptRecordResponseV1::chunk_limit(Some(u32::MAX)),
            CHUNK_CEILING
        );
        assert_eq!(TranscriptRecordResponseV1::chunk_limit(Some(0)), 1);
    }

    #[test]
    fn every_state_is_distinct_on_the_wire() {
        for (state, word) in [
            (TranscriptRecordStateV1::Ready, "ready"),
            (TranscriptRecordStateV1::NotFound, "not_found"),
            (TranscriptRecordStateV1::StaleGeneration, "stale_generation"),
            (TranscriptRecordStateV1::Unavailable, "unavailable"),
            (TranscriptRecordStateV1::Error, "error"),
        ] {
            assert_eq!(
                serde_json::to_string(&state).unwrap(),
                format!("\"{word}\"")
            );
        }
    }

    #[test]
    fn a_not_found_answer_carries_no_bytes() {
        let value = serde_json::to_value(TranscriptRecordResponseV1::bare(
            TranscriptRecordStateV1::NotFound,
        ))
        .unwrap();
        assert_eq!(value["state"], "not_found");
        assert!(!value.as_object().is_some_and(|o| o.contains_key("raw")));
        assert!(!value
            .as_object()
            .is_some_and(|o| o.contains_key("size_bytes")));
    }

    #[test]
    fn a_request_names_a_session_and_a_reference() {
        assert!(serde_json::from_str::<TranscriptRecordRequestV1>(
            r#"{"session_id":"s1","record_ref":"opaque"}"#
        )
        .is_ok());
        assert!(
            serde_json::from_str::<TranscriptRecordRequestV1>(r#"{"record_ref":"opaque"}"#)
                .is_err(),
            "a session-less request would be a machine-wide lookup"
        );
        assert!(
            serde_json::from_str::<TranscriptRecordRequestV1>(r#"{"session_id":"s1"}"#).is_err(),
            "a reference-less request would need a default selection"
        );
    }

    #[test]
    fn the_descriptor_names_this_unit_its_owner_and_its_wire() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "claude-code.transcript-record");
        assert_eq!(d.owner, "nession-claude-code");
        assert_eq!(d.contracts[0].wire, vec![WIRE.to_string()]);
        assert!(d.validate().is_ok());
    }
}
