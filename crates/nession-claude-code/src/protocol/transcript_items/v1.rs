//! `claude-code.transcript-items` / v1 — the normalized **execution** timeline
//! of one explicitly named transcript (`#1234`).
//!
//! The transcript projection's counterpart to `claude-code.messages`. Both read
//! the same canonical page; they differ in what they are willing to draw. A
//! conversation answers "what did the user and Claude say to each other" and
//! hides everything that is not a turn or a tool; this answers "what did this
//! session actually do", and hides almost nothing.
//!
//! ## Stable categories, open-ended names
//!
//! The contract stabilizes seven **broad** kinds — `message`, `tool`,
//! `reasoning`, `attachment`, `event`, `metadata`, `unknown` — and carries
//! Claude's own type or subtype beside them as a string. Measured over a real
//! corpus, upstream already has 18 top-level record types, 7 `system` subtypes
//! and ~30 attachment types, and the sets change between Claude releases. Making
//! each of those a Nession enum would mean a new protocol generation every time
//! Claude adds one, for a change that is data.
//!
//! A new protocol generation is required only when *this* contract changes
//! incompatibly — which is what makes `unknown` the load-bearing kind rather
//! than an edge case: a record type this version has never seen is carried with
//! its upstream name, so a Claude upgrade shows up as parser coverage drift
//! instead of as a page that fails or a hole nobody can see.
//!
//! ## Not a raw JSONL viewer
//!
//! Near-lossless is not the same as raw. Several upstream records may become one
//! item and one record may become several, and the raw storage shape is not the
//! contract — a client is never asked to know what a `file-history-delta` is,
//! only that an event of that name happened.
//!
//! ## What this unit never does
//!
//! - **Never substitutes for the requested id.** `transcript_id` is the only
//!   selection mechanism; an unknown id is `not_found`, never the binding, never
//!   the newest, and never the only transcript in the directory — explicitly
//!   required by `#1234`'s "explicit missing/out-of-scope transcript never
//!   silently falls back to newest/binding".
//! - **Never carries a transcript path**, same structural rule as its siblings.
//! - **Never sends an unbounded body.** The three ceilings are the same measured
//!   ones `claude-code.messages` applies, reused deliberately: they bound bodies
//!   of the *same records*, and two copies of the number would drift.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::conversations::v1::ConversationActivityV1;
use crate::protocol::messages::v1::{MessageContentV1, PayloadV1, ToolActivityV1};
use crate::protocol::transcripts::v1::TranscriptItemV1;
use crate::protocol::v1_descriptor;

pub const WIRE: &str = "claude-code.transcript-items";

/// Most items one response may carry, whatever the caller asks for.
pub const ITEM_CEILING: u32 = 200;

/// Items returned when the caller names no limit.
pub const DEFAULT_ITEM_LIMIT: u32 = 50;

/// Longest reasoning body kept, in bytes.
///
/// Measured over 67,103 `thinking`/`redacted_thinking` blocks across the flat
/// and subagent corpora: p50 280 B, p90 3.1 KB, p99 14.3 KB, **max 126 KB**. 8 KiB
/// carries p90 whole and truncates 2.6% of blocks — and a truncated body says
/// so, which is what makes the cut safe rather than silent.
///
/// This is the one content kind that exists *only* here: the conversation
/// projection folds reasoning away entirely, so its bound belongs to this
/// contract rather than to `claude-code.messages`'.
pub const REASONING_CEILING: usize = 8 * 1024;

/// Longest attachment body kept, in bytes.
///
/// Measured over 91,057 `attachment` records: p50 436 B, p90 468 B — the
/// overwhelmingly common case is a *tiny* hook or context record — but p99 is
/// 23.5 KB and the **max is 1.2 MB**. The ceiling exists for that tail: without
/// it a single record could carry more than the entire page budget, and `#1234`
/// requires that a huge attachment be bounded and truncated with an explicit
/// signal rather than embedded.
pub const ATTACHMENT_CEILING: usize = 8 * 1024;

/// Where a message came from, semantically.
///
/// Four values, and the pair that matters is `human` against the other three: a
/// `type: "user"` envelope carries injected context and background-task
/// notifications as well as turns a person typed, so a client that drew
/// "user" as "You" would be wrong about who spoke. Measured, 4,499 such records
/// in one corpus.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MessageSourceV1 {
    /// A turn a human authored.
    Human,
    /// A turn the model authored.
    Assistant,
    /// Material Claude Code injected as context for the model.
    Synthetic,
    /// A turn the runtime produced in message position.
    System,
}

/// Which family of runtime fact an event is.
///
/// Coarse on purpose, and the upstream name travels beside it — see the module
/// docs on why the subtype is data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum EventCategoryV1 {
    /// The runtime reporting on itself.
    System,
    /// An operation the session performed.
    Runtime,
    /// The session's own circumstances changing.
    Lifecycle,
    /// A state checkpoint written down.
    Checkpoint,
}

/// One thing the transcript recorded, in the transcript's own order.
///
/// Tagged on `kind`, so the shape a client switches on is the shape it
/// deserializes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TranscriptEntryV1 {
    /// A turn, whichever of the four sources produced it.
    Message {
        /// Stable within the transcript, derived from the transcript itself.
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timestamp: Option<String>,
        source: MessageSourceV1,
        /// Never empty: a turn whose blocks were all unmodelled carries
        /// [`MessageContentV1::Unknown`] rather than reading as a turn that
        /// never happened.
        content: Vec<MessageContentV1>,
    },
    /// A tool call, paired with its result when the transcript has one.
    Tool {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timestamp: Option<String>,
        tool: ToolActivityV1,
    },
    /// Model reasoning. Parsed and carried whether or not a client draws it —
    /// measured, it is the *largest* block type in a real transcript.
    Reasoning {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timestamp: Option<String>,
        /// Upstream block type, verbatim — data, not an enum.
        reasoning_type: String,
        text: PayloadV1,
    },
    /// Something Claude Code injected into the conversation as context.
    Attachment {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timestamp: Option<String>,
        /// Upstream `attachment.type`, verbatim.
        attachment_type: String,
        /// The record's own body, cut to [`ATTACHMENT_CEILING`].
        ///
        /// Present because "an attachment of type `file` happened" is much less
        /// useful than what it carried — and **bounded** because the measured
        /// maximum is 1.2 MB, which is more than an entire page may carry.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<PayloadV1>,
    },
    /// A runtime/system/lifecycle/checkpoint fact that is not a message.
    Event {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timestamp: Option<String>,
        category: EventCategoryV1,
        /// Upstream `type` or `subtype`, verbatim.
        name: String,
    },
    /// A record that changes session-level state rather than saying anything.
    Metadata {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timestamp: Option<String>,
        name: String,
    },
    /// A record this version does not model.
    ///
    /// Carried rather than dropped, and it is the kind that makes a Claude
    /// upgrade observable instead of silent.
    Unknown {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timestamp: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        upstream_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        upstream_subtype: Option<String>,
    },
}

impl TranscriptEntryV1 {
    /// The item's id, whichever arm it is.
    pub fn id(&self) -> &str {
        match self {
            Self::Message { id, .. }
            | Self::Tool { id, .. }
            | Self::Reasoning { id, .. }
            | Self::Attachment { id, .. }
            | Self::Event { id, .. }
            | Self::Metadata { id, .. }
            | Self::Unknown { id, .. } => id,
        }
    }
}

/// How much of the page the parser understood, and how.
///
/// Replaces a single `skipped` count, which could not tell "the reader did not
/// understand this record" from "the reader understood it and this view does not
/// draw it". Measured, that difference is 25 records out of a median 50 — so the
/// one number was wrong about half of a normal page.
///
/// The four record counts partition the page: they sum to `raw_records`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct TranscriptParseStatsV1 {
    /// Every non-empty record the page selected.
    pub raw_records: u64,
    /// Understood, and carrying at least one fact.
    pub recognized_records: u64,
    /// Understood as session state rather than as an event.
    pub metadata_absorbed: u64,
    /// Parsed, but this version has no model for the record's type.
    pub unknown_records: u64,
    /// Not parseable as a JSON object at all.
    pub invalid_records: u64,
}

/// Where the read of the requested transcript stands.
///
/// Four states, and `not_found` **is** one here — unlike the conversation list,
/// where an empty cwd is a successful empty list. This unit is asked for one
/// explicitly named transcript, so "there is no such transcript" is an answer
/// about the request rather than a fact about a directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum TranscriptItemsStateV1 {
    /// The requested transcript was found and the page is the answer.
    Ready,
    /// No transcript with the requested id is visible at the Session's cwd.
    ///
    /// Final — the response names no other transcript.
    NotFound,
    /// The provider cannot establish the Session's cwd, so it cannot scope the
    /// read. Distinct from `NotFound`: the id is not wrong, the scope is out of
    /// reach.
    Unavailable,
    /// The read was attempted and failed. `error` carries the reason.
    Error,
}

/// What the caller asks for.
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct TranscriptItemsRequestV1 {
    /// The Nession session the read is scoped to. Required: visibility is
    /// per-Session-cwd, so a request without one would be a machine-wide
    /// transcript lookup.
    pub session_id: String,

    /// The transcript to read — one of `claude-code.transcripts`' `items[]` ids.
    /// Required: **this is the only way a caller selects a transcript**.
    pub transcript_id: String,

    /// Where to continue from, from a previous response's `next_cursor`.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub cursor: Option<String>,

    /// Requested item count, clamped to [`ITEM_CEILING`].
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub limit: Option<u32>,
}

/// The answer.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct TranscriptItemsResponseV1 {
    pub state: TranscriptItemsStateV1,

    /// The transcript the page is from — the full item shape, so a client
    /// renders its header from this without joining back to the list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript: Option<TranscriptItemV1>,

    /// Whether the transcript is live relative to the requesting Session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<ConversationActivityV1>,

    /// The page, oldest-first within the page.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<TranscriptEntryV1>,

    /// Pass back to continue. Absent when there is nothing older.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,

    /// Whether older items exist beyond this page.
    pub has_more: bool,

    /// Whether the transcript ended mid-record when it was read.
    ///
    /// **Not an error.** A transcript being appended to routinely ends in a
    /// partial line, and the completed items must still render.
    pub partial_tail: bool,

    /// What the parser understood, on a page it read.
    ///
    /// Absent when there is no page — a `not_found` carrying zeroes would claim
    /// "this transcript has no records", which is a different fact from "there
    /// is no such transcript".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<TranscriptParseStatsV1>,

    /// The reason, when `state` is `Error`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl TranscriptItemsResponseV1 {
    /// The answer for a state that carries no items.
    pub fn bare(state: TranscriptItemsStateV1) -> Self {
        Self {
            state,
            transcript: None,
            activity: None,
            items: Vec::new(),
            next_cursor: None,
            has_more: false,
            partial_tail: false,
            stats: None,
            error: None,
        }
    }

    /// The answer for a read that failed, carrying why.
    pub fn error(reason: impl Into<String>) -> Self {
        Self {
            error: Some(reason.into()),
            ..Self::bare(TranscriptItemsStateV1::Error)
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
            TranscriptItemsResponseV1::page_limit(None),
            DEFAULT_ITEM_LIMIT
        );
        assert_eq!(TranscriptItemsResponseV1::page_limit(Some(10)), 10);
        assert_eq!(
            TranscriptItemsResponseV1::page_limit(Some(u32::MAX)),
            ITEM_CEILING
        );
        assert_eq!(TranscriptItemsResponseV1::page_limit(Some(0)), 1);
    }

    #[test]
    fn every_broad_kind_serializes_with_its_own_tag() {
        // Seven stable categories is the contract's whole claim. A client
        // switches on this tag, so the tag is what must not move.
        let entries = [
            TranscriptEntryV1::Message {
                id: "m".into(),
                timestamp: None,
                source: MessageSourceV1::Human,
                content: vec![MessageContentV1::Unknown],
            },
            TranscriptEntryV1::Tool {
                id: "t".into(),
                timestamp: None,
                tool: ToolActivityV1 {
                    call_id: "c".into(),
                    name: "Bash".into(),
                    status: crate::protocol::messages::v1::ToolStatusV1::Success,
                    summary: "ls".into(),
                    input: None,
                    output: None,
                },
            },
            TranscriptEntryV1::Reasoning {
                id: "r".into(),
                timestamp: None,
                reasoning_type: "thinking".into(),
                text: PayloadV1 {
                    text: "…".into(),
                    kind: crate::protocol::messages::v1::PayloadKindV1::Text,
                    truncated: false,
                },
            },
            TranscriptEntryV1::Attachment {
                id: "a".into(),
                timestamp: None,
                attachment_type: "hook_success".into(),
                payload: None,
            },
            TranscriptEntryV1::Event {
                id: "e".into(),
                timestamp: None,
                category: EventCategoryV1::Checkpoint,
                name: "file-history-snapshot".into(),
            },
            TranscriptEntryV1::Metadata {
                id: "d".into(),
                timestamp: None,
                name: "ai-title".into(),
            },
            TranscriptEntryV1::Unknown {
                id: "u".into(),
                timestamp: None,
                upstream_type: Some("brand-new".into()),
                upstream_subtype: None,
            },
        ];
        let kinds: Vec<String> = entries
            .iter()
            .map(|entry| serde_json::to_value(entry).unwrap()["kind"].to_string())
            .collect();
        assert_eq!(
            kinds,
            vec![
                "\"message\"",
                "\"tool\"",
                "\"reasoning\"",
                "\"attachment\"",
                "\"event\"",
                "\"metadata\"",
                "\"unknown\"",
            ]
        );
        for (entry, kind) in entries.iter().zip(kinds.iter()) {
            assert_eq!(entry.id(), serde_json::to_value(entry).unwrap()["id"]);
            let _ = kind;
        }
    }

    #[test]
    fn an_unknown_record_keeps_its_upstream_name() {
        // The compatibility requirement, structurally: a record this version has
        // no model for still says what it was, so a Claude upgrade is
        // *observable* rather than a hole. Without the name, `unknown` would
        // report that something happened and nothing else.
        let entry = TranscriptEntryV1::Unknown {
            id: "u1".into(),
            timestamp: Some("2026-09-25T00:00:00Z".into()),
            upstream_type: Some("quantum-entanglement-state".into()),
            upstream_subtype: Some("collapsed".into()),
        };
        let value = serde_json::to_value(&entry).unwrap();
        assert_eq!(value["upstream_type"], "quantum-entanglement-state");
        assert_eq!(value["upstream_subtype"], "collapsed");
    }

    #[test]
    fn the_four_message_sources_are_told_apart() {
        // `human` against the rest is the distinction a reader depends on: the
        // same upstream `type: "user"` envelope carries all four.
        for (source, word) in [
            (MessageSourceV1::Human, "human"),
            (MessageSourceV1::Assistant, "assistant"),
            (MessageSourceV1::Synthetic, "synthetic"),
            (MessageSourceV1::System, "system"),
        ] {
            assert_eq!(
                serde_json::to_string(&source).unwrap(),
                format!("\"{word}\"")
            );
        }
    }

    #[test]
    fn not_found_is_a_state_here_unlike_the_conversation_list() {
        // This unit is asked for one explicitly named transcript, so "there is
        // no such transcript" is an answer about the request. The list units
        // have no such state, because there an empty cwd is a successful empty
        // list — and copying their state set here would be the wrong contract.
        for word in ["ready", "not_found", "unavailable", "error"] {
            let state: TranscriptItemsStateV1 =
                serde_json::from_str(&format!("\"{word}\"")).unwrap();
            assert_eq!(
                serde_json::to_string(&state).unwrap(),
                format!("\"{word}\"")
            );
        }
    }

    #[test]
    fn a_not_found_response_names_no_other_transcript() {
        // The substitution ban, pinned structurally: `bare(NotFound)` is the
        // whole answer — no transcript, no binding, no newest.
        let value = serde_json::to_value(TranscriptItemsResponseV1::bare(
            TranscriptItemsStateV1::NotFound,
        ))
        .unwrap();
        assert_eq!(value["state"], "not_found");
        assert!(
            !value
                .as_object()
                .is_some_and(|o| o.contains_key("transcript")),
            "a substituted transcript would be a guess: {value}"
        );
    }

    #[test]
    fn a_state_with_no_page_carries_no_stats() {
        // Zeroes would be a claim — "this transcript has no records" — and the
        // state is that there is no such transcript.
        let value = serde_json::to_value(TranscriptItemsResponseV1::bare(
            TranscriptItemsStateV1::NotFound,
        ))
        .unwrap();
        assert!(
            !value.as_object().is_some_and(|o| o.contains_key("stats")),
            "{value}"
        );
    }

    #[test]
    fn the_stats_partition_is_what_the_documentation_claims() {
        // The doc says the four counts sum to `raw_records`. A type cannot
        // enforce that, so the least this can do is state the shape it means.
        let stats = TranscriptParseStatsV1 {
            raw_records: 4,
            recognized_records: 1,
            metadata_absorbed: 1,
            unknown_records: 1,
            invalid_records: 1,
        };
        assert_eq!(
            stats.raw_records,
            stats.recognized_records
                + stats.metadata_absorbed
                + stats.unknown_records
                + stats.invalid_records
        );
    }

    #[test]
    fn a_request_without_both_ids_is_malformed_not_defaulted() {
        // Required fields are the substitute-forbidding mechanism.
        assert!(serde_json::from_str::<TranscriptItemsRequestV1>(
            r#"{"session_id":"s1","transcript_id":"t1"}"#
        )
        .is_ok());
        assert!(
            serde_json::from_str::<TranscriptItemsRequestV1>(r#"{"transcript_id":"t1"}"#).is_err(),
            "a session-less request would be a machine-wide lookup"
        );
        assert!(
            serde_json::from_str::<TranscriptItemsRequestV1>(r#"{"session_id":"s1"}"#).is_err(),
            "a transcript-less request would need a default selection"
        );
    }

    #[test]
    fn a_response_never_serializes_a_filesystem_path() {
        let mut response = TranscriptItemsResponseV1::bare(TranscriptItemsStateV1::Ready);
        response.transcript = Some(TranscriptItemV1 {
            id: "s1/agent-a".into(),
            cwd: "/work".into(),
            kind: crate::protocol::transcripts::v1::TranscriptKindV1::Sidechain,
            parent_id: Some("s1".into()),
            agent_id: Some("agent-a".into()),
            title: None,
            preview: None,
            created_at: None,
            updated_at: None,
        });
        let json = serde_json::to_string(&response).unwrap();
        assert!(
            !json.contains("subagents") && !json.contains(".jsonl"),
            "the response leaks where the transcript is: {json}"
        );
    }

    #[test]
    fn the_descriptor_names_this_unit_its_owner_and_its_wire() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "claude-code.transcript-items");
        assert_eq!(d.owner, "nession-claude-code");
        assert_eq!(d.contracts[0].wire, vec![WIRE.to_string()]);
        assert!(d.validate().is_ok());
    }
}
