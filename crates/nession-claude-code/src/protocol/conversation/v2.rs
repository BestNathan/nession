//! `claude-code.conversation` / v2.
//!
//! The same conversation as [`super::v1`], structured enough for a client to
//! render it as an AI conversation rather than as a transcript of records
//! (`#1167`). The wire is unchanged — a unit at two versions travels as one wire
//! and `contract_version` selects the generation
//! (`docs/architecture/protocol.md`, "One wire, several generations"). `v1.rs`
//! is not edited: a shipped version is never rewritten to express a new one.
//!
//! ## What changed, and why each one is a version rather than an addition
//!
//! - **`text` is gone; a message carries `content`.** v1 emitted one item per
//!   `text` block, so an assistant turn that wrote prose, called a tool and wrote
//!   more prose arrived as three rows with no record of the turn they came from.
//!   v2 emits one message per record with its content blocks in order. A removed
//!   field and a changed item count are both consumer-observable.
//! - **A tool carries its call's identity, its outcome and its bodies.** v1's
//!   `ToolV1` has `name / summary / is_error / truncated`, and `is_error` shipped
//!   hardcoded `false` — no result was ever read, so no tool could report what it
//!   produced. `is_error: bool` could not express "still running" anyway.
//! - **`kind` is a tag on a union rather than a field beside optional
//!   siblings.** v1's `text` + `optional tool` is an implicit union one field
//!   away from being unrepresentable; `#1167` names growing it further as the
//!   thing to avoid.
//!
//! ## What deliberately did not change
//!
//! Raw `thinking` is still folded away — it is model reasoning, not a turn, and
//! it is the *largest* block type in a measured transcript (650 blocks against
//! 355 `text`), so exposing it would bury the conversation it reasons about. If
//! Claude later offers a summarized reasoning concept it gets its own content
//! type; it does not reopen this one.
//!
//! ## Payloads are bounded twice over
//!
//! `#1005` bounds resource use, and a tool is where a transcript's bytes live.
//! Three limits, because one is not enough: [`TOOL_SUMMARY_CEILING`] bounds the
//! collapsed line, [`TOOL_INPUT_CEILING`] / [`TOOL_OUTPUT_CEILING`] bound one
//! body, and [`PAGE_PAYLOAD_BUDGET`] bounds the *response* — a page of 200 tools
//! each at the per-body ceiling is 3.2 MB, which no single-item limit prevents.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::versioned_descriptor;

pub const WIRE: &str = "claude-code.conversation";

/// The generation of this contract. Named rather than inlined into
/// [`descriptor`] so the handler that dispatches on it can compare against the
/// same number the descriptor advertises.
pub const CONTRACT_VERSION: u32 = 2;

/// Most items one response may carry, whatever the caller asks for.
pub const ITEM_CEILING: u32 = 200;

/// Items returned when the caller names no limit.
pub const DEFAULT_ITEM_LIMIT: u32 = 50;

/// Longest tool summary in characters.
pub const TOOL_SUMMARY_CEILING: usize = 500;

/// Longest serialized tool input kept, in bytes.
///
/// Measured over 1180 real tool calls: p50 268 B, p90 1.3 KB, p99 12.6 KB,
/// max 21 KB. 8 KiB carries p90 whole and truncates under 1% of calls — and a
/// truncated call still says so, which is what makes the cut safe.
pub const TOOL_INPUT_CEILING: usize = 8 * 1024;

/// Longest tool result kept, in bytes.
///
/// Same measurement, results: p50 234 B, p90 3 KB, p99 10 KB, max 47 KB. The
/// same 8 KiB, for the same reason.
pub const TOOL_OUTPUT_CEILING: usize = 8 * 1024;

/// Most tool-payload bytes one response may carry, across every tool in it.
///
/// The per-body ceilings bound one tool; this bounds the page. Both are needed:
/// `limit × (input + output)` is 3.2 MB at the defaults, which is a bound only
/// in the sense that it is finite. Once the budget is spent, later tools carry
/// their summary and say their bodies were cut, so the page degrades in
/// resolution rather than failing.
pub const PAGE_PAYLOAD_BUDGET: usize = 128 * 1024;

/// Who a message is from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum RoleV2 {
    User,
    Assistant,
}

/// Where a tool call stands.
///
/// A closed enum rather than v1's `is_error: bool`, which cannot say "we do not
/// know yet" — and which shipped hardcoded `false`, so it said "succeeded" about
/// calls nobody had read a result for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ToolStatusV2 {
    /// The call is the newest thing in the transcript and no result exists yet.
    /// Ordinary, not an error: a tool that is still running is what a live
    /// conversation looks like.
    Running,
    /// A paired result reported success.
    Success,
    /// A paired result reported failure.
    Error,
    /// No result could be paired *and we cannot say why* — the call sits at a
    /// page edge and its result lies beyond the window this read searched.
    ///
    /// Deliberately distinct from [`ToolStatusV2::Running`]: "still going" and
    /// "we did not look far enough" are different facts, and presenting the
    /// second as the first is a claim the provider cannot support.
    Unknown,
}

/// What a payload body is, so a client can choose a treatment without parsing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum PayloadKindV2 {
    /// Serialized JSON — render preformatted, not as prose.
    Json,
    /// Anything else, kept verbatim.
    Text,
}

/// One bounded body of a tool call.
///
/// `text` is always present when the body is; `truncated` is what tells a reader
/// the difference between a short result and a long one that was cut, which
/// v1's `truncated` could not do because nothing was ever cut.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct PayloadV2 {
    pub text: String,
    pub kind: PayloadKindV2,
    pub truncated: bool,
}

/// A tool call, paired with its result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct ToolV2 {
    /// The `tool_use.id` this call was made under.
    ///
    /// Carried because it is the only thing that identifies a *call* rather than
    /// a row: two `Bash` calls in one turn are told apart by this and by nothing
    /// else. It is also what the client would need to correlate a live update,
    /// which is why it is on the wire rather than kept provider-side.
    pub call_id: String,
    /// The tool's name, e.g. `Bash`.
    pub name: String,
    pub status: ToolStatusV2,
    /// A one-line description, truncated to [`TOOL_SUMMARY_CEILING`].
    pub summary: String,
    /// What the call was given, when the transcript recorded it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<PayloadV2>,
    /// What it produced, when a result was paired.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<PayloadV2>,
}

/// One block of a message's body.
///
/// A union rather than a bare `String` so a later version can add a content
/// kind — a summarized reasoning block is the one actually expected — without
/// making every existing client treat a new block as prose it cannot read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConversationContentV2 {
    /// Prose. Carried verbatim: whether it is Markdown is the client's reading,
    /// and a provider that decided would be unable to change its mind.
    Text { text: String },
    /// A block type this version does not model.
    ///
    /// Kept as a position rather than dropped, so a message that carried one
    /// does not silently read as if it had not.
    Unknown,
}

/// One thing that happened in the conversation, in order.
///
/// Tagged on `kind`, so the shape a client switches on is the shape it
/// deserializes — v1's flat `text` + `optional tool` allowed an item that was
/// both and an item that was neither.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConversationItemV2 {
    /// A human or model turn, with its content blocks in order.
    Message {
        /// Stable within the conversation, derived from the transcript record.
        id: String,
        /// The record's own timestamp, RFC 3339, when it carried one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timestamp: Option<String>,
        role: RoleV2,
        /// Never empty: a turn whose blocks were all unmodelled is
        /// [`ConversationItemV2::Unknown`], not a message with no content.
        content: Vec<ConversationContentV2>,
    },
    /// A tool call, paired with its result when the transcript has one.
    Tool {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timestamp: Option<String>,
        tool: ToolV2,
    },
    /// A record this version does not model.
    ///
    /// Carried rather than dropped so a client can say "some events were not
    /// shown" instead of silently presenting a conversation with holes in it.
    Unknown {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timestamp: Option<String>,
    },
}

impl ConversationItemV2 {
    /// The item's id, whichever arm it is.
    pub fn id(&self) -> &str {
        match self {
            Self::Message { id, .. } | Self::Tool { id, .. } | Self::Unknown { id, .. } => id,
        }
    }
}

/// Where the conversation stands, which is not the same as whether it loaded.
///
/// Declared here rather than reused from [`super::v1`] so that a v1 change can
/// never reach a v2 consumer through a shared type — the reason versions exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ConversationStateV2 {
    /// Items are available, and Claude Code is running right now.
    Ready,
    /// Items are from the last conversation this Session was bound to, and
    /// Claude Code is no longer running. A client must not present this as live.
    Inactive,
    /// The session's cwd has more than one candidate and nothing proves which is
    /// current. The caller picks from [`ConversationResponseV2::candidates`].
    Ambiguous,
    /// The session's cwd has no conversations at all.
    NotFound,
    /// This provider cannot answer. Distinct from `NotFound`: nothing is wrong
    /// with the session's cwd, the capability is simply absent.
    Unavailable,
    /// The read was attempted and failed. `error` carries the reason.
    Error,
}

/// What the caller asks for.
#[derive(Debug, Clone, Default, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct ConversationRequestV2 {
    /// The Nession session whose conversation is wanted.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub session_id: Option<String>,

    /// The Claude conversation the caller has explicitly chosen.
    ///
    /// As in v1, **this is the only way a caller selects a conversation** —
    /// there is deliberately no "newest" flag, because falling back to mtime is
    /// forbidden and an API that cannot express the choice cannot make it by
    /// accident.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub claude_session_id: Option<String>,

    /// Where to continue from, from a previous response's `next_cursor`.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub cursor: Option<String>,

    /// Requested item count, clamped to [`ITEM_CEILING`].
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub limit: Option<u32>,
}

/// A conversation this session's cwd could be showing.
///
/// **No filesystem path**, as in v1: the transcript's location is the provider's
/// business, and the response shape makes that structural rather than a rule.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct ConversationCandidateV2 {
    pub claude_session_id: String,
    /// The cwd the transcript itself recorded, not the directory it was found in.
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// A human-readable title, when Claude recorded one. Never identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// What the user last asked, when Claude recorded it. Never identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

/// The conversation the response is about.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct ConversationIdentityV2 {
    pub claude_session_id: String,
    pub cwd: String,
}

/// The answer.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct ConversationResponseV2 {
    pub state: ConversationStateV2,

    /// Set when a conversation was resolved — including an `Inactive` one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation: Option<ConversationIdentityV2>,

    /// What the caller may choose from, when `state` is `Ambiguous`.
    ///
    /// Also populated for `Ready` so a client can offer the list without a
    /// second round trip.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<ConversationCandidateV2>,

    /// The page, oldest-first within the page.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<ConversationItemV2>,

    /// Pass back to continue. Absent when there is nothing older.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,

    /// Whether older items exist beyond this page.
    pub has_more: bool,

    /// Whether the transcript ended mid-record when it was read.
    ///
    /// **Not an error.** A transcript being appended to routinely ends in a
    /// partial line, and the completed messages must still render.
    pub partial_tail: bool,

    /// How many records were skipped as unrecognised.
    pub skipped: u64,

    /// The reason, when `state` is `Error`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ConversationResponseV2 {
    /// The answer for a state that carries no items.
    pub fn bare(state: ConversationStateV2) -> Self {
        Self {
            state,
            conversation: None,
            candidates: Vec::new(),
            items: Vec::new(),
            next_cursor: None,
            has_more: false,
            partial_tail: false,
            skipped: 0,
            error: None,
        }
    }

    /// The answer for a read that failed, carrying why.
    pub fn error(reason: impl Into<String>) -> Self {
        Self {
            error: Some(reason.into()),
            ..Self::bare(ConversationStateV2::Error)
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
    versioned_descriptor("claude-code.conversation", WIRE, CONTRACT_VERSION)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_limit_is_clamped_and_never_zero() {
        assert_eq!(ConversationResponseV2::page_limit(None), DEFAULT_ITEM_LIMIT);
        assert_eq!(ConversationResponseV2::page_limit(Some(10)), 10);
        assert_eq!(
            ConversationResponseV2::page_limit(Some(u32::MAX)),
            ITEM_CEILING,
            "a caller cannot make one response unbounded by asking for a large page"
        );
        assert_eq!(
            ConversationResponseV2::page_limit(Some(0)),
            1,
            "a zero page would return nothing and read as an empty conversation"
        );
    }

    #[test]
    fn an_item_serializes_with_its_kind_as_the_tag() {
        // The whole point of the union: a client switches on `kind`, and the
        // arm it selects is the arm that deserializes. v1's flat shape could
        // not promise that.
        let message = ConversationItemV2::Message {
            id: "m1".into(),
            timestamp: Some("2026-09-25T00:00:00Z".into()),
            role: RoleV2::Assistant,
            content: vec![ConversationContentV2::Text {
                text: "# heading".into(),
            }],
        };
        let json = serde_json::to_value(&message).unwrap();
        assert_eq!(json["kind"], "message");
        assert_eq!(json["role"], "assistant");
        assert_eq!(json["content"][0]["type"], "text");

        let call = ConversationItemV2::Tool {
            id: "t1".into(),
            timestamp: None,
            tool: ToolV2 {
                call_id: "call-1".into(),
                name: "Bash".into(),
                status: ToolStatusV2::Error,
                summary: "cargo test".into(),
                input: None,
                output: None,
            },
        };
        let json = serde_json::to_value(&call).unwrap();
        assert_eq!(json["kind"], "tool");
        assert_eq!(json["tool"]["status"], "error");
        assert_eq!(json["tool"]["call_id"], "call-1");
    }

    #[test]
    fn an_absent_body_is_omitted_rather_than_sent_as_null() {
        // A client deciding whether to draw an Input section reads absence
        // directly. Sending `"input": null` would make "no input recorded"
        // and "input recorded as nothing" the same payload.
        let call = ConversationItemV2::Tool {
            id: "t1".into(),
            timestamp: None,
            tool: ToolV2 {
                call_id: "call-1".into(),
                name: "Read".into(),
                status: ToolStatusV2::Success,
                summary: "src/main.rs".into(),
                input: None,
                output: None,
            },
        };
        let json = serde_json::to_string(&call).unwrap();
        assert!(
            !json.contains("input"),
            "absent input was serialized: {json}"
        );
        assert!(
            !json.contains("timestamp"),
            "absent timestamp was serialized: {json}"
        );
    }

    #[test]
    fn the_three_tool_states_are_told_apart() {
        // `Running` and `Unknown` are the pair worth pinning: v1's boolean
        // could express neither, and collapsing them would let "we did not
        // look far enough" be presented as "still going".
        let states = [
            (ToolStatusV2::Running, "running"),
            (ToolStatusV2::Success, "success"),
            (ToolStatusV2::Error, "error"),
            (ToolStatusV2::Unknown, "unknown"),
        ];
        for (state, word) in states {
            assert_eq!(
                serde_json::to_string(&state).unwrap(),
                format!("\"{word}\"")
            );
        }
    }

    #[test]
    fn the_descriptor_advertises_the_version_the_handler_dispatches_on() {
        // The descriptor is the only thing a peer reads to negotiate; the
        // handler compares the payload's `contract_version` against
        // CONTRACT_VERSION to pick an arm. If the two disagreed, a peer would
        // negotiate one generation and be answered with another.
        let advertised = descriptor().unwrap();
        assert_eq!(
            advertised.contracts.first().map(|c| c.version.get()),
            Some(CONTRACT_VERSION)
        );
        assert_eq!(
            advertised.contracts.first().map(|c| c.wire.clone()),
            Some(vec![WIRE.to_string()]),
            "v2 travels on the unit's one wire, not a versioned respelling"
        );
    }

    #[test]
    fn a_response_never_serializes_a_filesystem_path() {
        let candidate = ConversationCandidateV2 {
            claude_session_id: "abc".into(),
            cwd: "/work".into(),
            updated_at: None,
            title: Some("a readable title".into()),
            preview: None,
        };
        let json = serde_json::to_string(&candidate).unwrap();
        assert!(
            !json.contains("transcript") && !json.contains(".jsonl"),
            "the candidate leaks where the transcript is: {json}"
        );
    }
}
