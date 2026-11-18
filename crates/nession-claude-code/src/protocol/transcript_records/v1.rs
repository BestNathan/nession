//! `claude-code.transcript-records` / v1 — one page of **raw** transcript
//! records (`#3726`).
//!
//! This unit replaces the semantic projection `claude-code.transcript-items`
//! for the Transcript surface. The provider's entire responsibility here is
//! *discovery and access*: find the transcript the caller named, read whole
//! lines from it in source order, and hand back the original text plus an
//! opaque record reference. It does not classify `user`, `assistant` or
//! `system`, does not parse nested `message.content`, does not infer reasoning
//! and does not pair `tool_use` with `tool_result` — those are rendering
//! decisions, and they belong to one Claude-specific frontend adapter.
//!
//! ## Every physical record is a row
//!
//! A page carries one [`TranscriptRecordV1`] per JSONL line, in file order,
//! including lines this or any Nession version does not understand and lines
//! that are not valid JSON at all. `raw` is the original line text. A line too
//! large to carry inline is still represented — as a record with no `raw`, a
//! `size_bytes` and a `record_ref` the caller can resolve through
//! `claude-code.transcript-record` — so a huge record is discoverable rather
//! than silently skipped or reported as a truncated line.
//!
//! ## What an opaque reference binds
//!
//! `record_ref` and `next_cursor` are opaque strings. Both encode the
//! transcript identity, a byte offset and a generation fingerprint of the
//! file. A reference from one transcript can never be used against another,
//! and a cursor from before the file was replaced is refused rather than
//! applied to different bytes. No filesystem path crosses the wire.
//!
//! ## Partial writes are withheld
//!
//! A transcript being appended to routinely ends in a half-written line. That
//! line is not a record yet: `partial_tail` reports it and the page stops at
//! the last complete record, exactly as the sibling units do.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::conversations::v1::ConversationActivityV1;
use crate::protocol::transcripts::v1::TranscriptItemV1;
use crate::protocol::v1_descriptor;

pub const WIRE: &str = "claude-code.transcript-records";

/// Most records one response may carry, whatever the caller asks for.
pub const ITEM_CEILING: u32 = 200;

/// Records returned when the caller names no limit.
pub const DEFAULT_ITEM_LIMIT: u32 = 50;

/// Longest single record carried inline in a page, in bytes.
///
/// Measured Claude transcripts contain records up to 1.2 MB. A page that
/// embedded that one whole line would spend its entire budget on one row; this
/// ceiling makes it a placeholder instead. The record still appears in order
/// and remains fully readable through `claude-code.transcript-record`.
pub const RECORD_INLINE_CEILING: usize = 64 * 1024;

/// Most record bytes one page may carry inline, across every record in it.
///
/// The per-record ceiling bounds one row; this bounds the page. Once the
/// budget is spent, later records are placeholders with their `record_ref`, so
/// degradation is deterministic and no record is dropped.
pub const PAGE_INLINE_BUDGET: usize = 256 * 1024;

/// One raw record: identity, size and, when it fits, the original text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[derive(schemars::JsonSchema)]
pub struct TranscriptRecordV1 {
    /// Opaque, resource-scoped identity of this line.
    ///
    /// Encodes the transcript identity, the line's byte offset and the file's
    /// generation fingerprint. It is the identity a renderer keys its row on,
    /// and the only way to ask for the full record.
    pub record_ref: String,

    /// The line's byte offset within the transcript.
    ///
    /// Carried beside the opaque reference because it is useful for
    /// diagnostics and stable ordering. It is not a filesystem path.
    pub offset: u64,

    /// The line's length in bytes.
    ///
    /// Present on every record, including placeholders, so a client can say
    /// how large a record is without fetching it.
    pub size_bytes: u64,

    /// The original line text, when the page could carry it.
    ///
    /// Absent — never truncated — when the record exceeds
    /// [`RECORD_INLINE_CEILING`] or the page's remaining
    /// [`PAGE_INLINE_BUDGET`]. Absence means "resolve `record_ref`"; it never
    /// means "this record is empty".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
}

/// Where a read of the requested transcript stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[derive(schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptRecordsStateV1 {
    /// The requested transcript was found and the page is the answer.
    Ready,
    /// No transcript with the requested id is visible at the Session's cwd.
    /// Final — the response names no other transcript.
    NotFound,
    /// The provider cannot establish the Session's cwd, so it cannot scope the
    /// read. Distinct from `NotFound`.
    Unavailable,
    /// The cursor was not issued for this transcript or this file generation.
    /// The caller must restart from the newest page; the response carries no
    /// page, so stale bytes are never applied to a newer file.
    StaleCursor,
    /// The read was attempted and failed. `error` carries the reason.
    Error,
}

/// What the caller asks for.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[derive(schemars::JsonSchema)]
pub struct TranscriptRecordsRequestV1 {
    /// The Nession session the read is scoped to. Required: visibility is
    /// per-Session-cwd, so a request without one would be a machine-wide
    /// transcript lookup.
    pub session_id: String,

    /// The transcript to read — one of `claude-code.transcripts`' `items[]`
    /// ids. Required: **this is the only way a caller selects a transcript**.
    pub transcript_id: String,

    /// Where to continue from, from a previous response's `next_cursor`.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub cursor: Option<String>,

    /// Requested record count, clamped to [`ITEM_CEILING`].
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub limit: Option<u32>,
}

/// The answer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[derive(schemars::JsonSchema)]
pub struct TranscriptRecordsResponseV1 {
    pub state: TranscriptRecordsStateV1,

    /// The transcript the page is from — the full item shape, so a client
    /// renders its header from this without joining back to the list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript: Option<TranscriptItemV1>,

    /// Whether the transcript is live relative to the requesting Session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<ConversationActivityV1>,

    /// The page, oldest-first, one entry per physical JSONL line.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub records: Vec<TranscriptRecordV1>,

    /// Pass back to continue. Absent when there is nothing older.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,

    /// Whether older records exist beyond this page.
    pub has_more: bool,

    /// Whether the transcript ended mid-record when it was read.
    ///
    /// **Not an error.** The unfinished line is withheld until it is complete.
    pub partial_tail: bool,

    /// The reason, when `state` is `Error`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl TranscriptRecordsResponseV1 {
    /// The answer for a state that carries no records.
    pub fn bare(state: TranscriptRecordsStateV1) -> Self {
        Self {
            state,
            transcript: None,
            activity: None,
            records: Vec::new(),
            next_cursor: None,
            has_more: false,
            partial_tail: false,
            error: None,
        }
    }

    /// The answer for a read that failed, carrying why.
    pub fn error(reason: impl Into<String>) -> Self {
        Self {
            error: Some(reason.into()),
            ..Self::bare(TranscriptRecordsStateV1::Error)
        }
    }

    /// The requested page size, clamped.
    pub fn page_limit(requested: Option<u32>) -> u32 {
        requested
            .unwrap_or(DEFAULT_ITEM_LIMIT)
            .clamp(1, ITEM_CEILING)
    }
}

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_limit_is_clamped_and_never_zero() {
        assert_eq!(
            TranscriptRecordsResponseV1::page_limit(None),
            DEFAULT_ITEM_LIMIT
        );
        assert_eq!(TranscriptRecordsResponseV1::page_limit(Some(10)), 10);
        assert_eq!(
            TranscriptRecordsResponseV1::page_limit(Some(u32::MAX)),
            ITEM_CEILING
        );
        assert_eq!(TranscriptRecordsResponseV1::page_limit(Some(0)), 1);
    }

    #[test]
    fn a_record_without_inline_raw_says_so_by_absence_not_truncation() {
        // Absence is the placeholder signal. If `raw` were present but cut, a
        // renderer could not distinguish a 64 B record from a 1.2 MB one shown
        // at 64 B — and #3726 requires the Raw view to be complete or to name
        // where completeness can be obtained.
        let record = TranscriptRecordV1 {
            record_ref: "opaque".into(),
            offset: 0,
            size_bytes: 1_200_000,
            raw: None,
        };
        let value = serde_json::to_value(&record).unwrap();
        assert!(
            !value.as_object().is_some_and(|o| o.contains_key("raw")),
            "{value}"
        );
        assert_eq!(value["size_bytes"], 1_200_000);
        assert_eq!(value["record_ref"], "opaque");
    }

    #[test]
    fn every_state_is_distinct_on_the_wire() {
        for (state, word) in [
            (TranscriptRecordsStateV1::Ready, "ready"),
            (TranscriptRecordsStateV1::NotFound, "not_found"),
            (TranscriptRecordsStateV1::Unavailable, "unavailable"),
            (TranscriptRecordsStateV1::StaleCursor, "stale_cursor"),
            (TranscriptRecordsStateV1::Error, "error"),
        ] {
            assert_eq!(
                serde_json::to_string(&state).unwrap(),
                format!("\"{word}\"")
            );
        }
    }

    #[test]
    fn a_not_found_response_names_no_other_transcript_and_no_records() {
        let value = serde_json::to_value(TranscriptRecordsResponseV1::bare(
            TranscriptRecordsStateV1::NotFound,
        ))
        .unwrap();
        assert_eq!(value["state"], "not_found");
        assert!(!value
            .as_object()
            .is_some_and(|o| o.contains_key("transcript")));
        assert!(!value.as_object().is_some_and(|o| o.contains_key("records")));
    }

    #[test]
    fn a_request_without_both_ids_is_malformed_not_defaulted() {
        assert!(serde_json::from_str::<TranscriptRecordsRequestV1>(
            r#"{"session_id":"s1","transcript_id":"t1"}"#
        )
        .is_ok());
        assert!(
            serde_json::from_str::<TranscriptRecordsRequestV1>(r#"{"transcript_id":"t1"}"#)
                .is_err(),
            "a session-less request would be a machine-wide lookup"
        );
        assert!(
            serde_json::from_str::<TranscriptRecordsRequestV1>(r#"{"session_id":"s1"}"#).is_err(),
            "a transcript-less request would need a default selection"
        );
    }

    #[test]
    fn the_descriptor_names_this_unit_its_owner_and_its_wire() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "claude-code.transcript-records");
        assert_eq!(d.owner, "nession-claude-code");
        assert_eq!(d.contracts[0].wire, vec![WIRE.to_string()]);
        assert!(d.validate().is_ok());
    }
}
