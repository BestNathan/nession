//! `claude-code.messages` / v1 — the normalized timeline of **one explicit**
//! conversation (`#1222`).
//!
//! This unit answers one question: what happened in the conversation the caller
//! named. Which conversations exist and which one the Session is bound to are
//! [`crate::protocol::conversations`]' questions; the two used to be a single
//! `claude-code.conversation` unit, and the split is what this module's rules
//! below exist to keep.
//!
//! ## What this unit never does
//!
//! - **Never substitutes for the requested id.** `conversation_id` is the only
//!   selection mechanism — an unknown id is `state: not_found`, not the binding,
//!   not the newest, and not the only conversation in the directory (`#1005`
//!   decision 3). A request that names nothing cannot be answered by
//!   coincidence, because the request shape makes omission a malformed request
//!   rather than a selectable default.
//! - **Never guesses across Sessions.** `session_id` is required alongside
//!   `conversation_id`: transcript visibility is scoped to a Session's cwd, and
//!   a machine-wide transcript lookup is a path around that.
//! - **Never carries a transcript path** — same structural rule as the sibling
//!   unit.
//!
//! ## What `state` and `activity` each say
//!
//! The retired unit's `Ready`/`Inactive` states fused two facts: whether the
//! read succeeded and whether Claude is still running. Here `state` answers
//! only the first; `activity` answers the second, as a closed enum — "finished"
//! and "the host cannot say" are different facts, and collapsing them lets a
//! client present a dead conversation as live.
//!
//! ## What an item is
//!
//! The normalization model is the one `#1167` introduced as the retired unit's
//! v2, carried forward under names that no longer call the whole thing "the
//! conversation": one item per thing that happened (a message, a tool call, or
//! a record this version does not model), a tool paired with its result, and
//! payloads bounded three times over — [`TOOL_SUMMARY_CEILING`] on the collapsed
//! line, [`TOOL_INPUT_CEILING`] / [`TOOL_OUTPUT_CEILING`] on one body, and
//! [`PAGE_PAYLOAD_BUDGET`] on the page, because 200 tools at the per-body
//! ceiling is 3.2 MB and no single-item limit prevents that.
//!
//! Raw `thinking` is still folded away — it is model reasoning, not a turn, and
//! it is the *largest* block type in a measured transcript (650 blocks against
//! 355 `text`), so exposing it would bury the conversation it reasons about. If
//! Claude later offers a summarized reasoning concept it gets its own content
//! kind; it does not reopen this one.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::conversations::v1::{ConversationActivityV1, ConversationItemV1};
use crate::protocol::v1_descriptor;

pub const WIRE: &str = "claude-code.messages";

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
pub enum MessageRoleV1 {
    User,
    Assistant,
}

/// Where a tool call stands.
///
/// A closed enum rather than a boolean, which cannot say "we do not know yet".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ToolStatusV1 {
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
    /// Deliberately distinct from [`ToolStatusV1::Running`]: "still going" and
    /// "we did not look far enough" are different facts, and presenting the
    /// second as the first is a claim the provider cannot support.
    Unknown,
}

/// What a payload body is, so a client can choose a treatment without parsing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum PayloadKindV1 {
    /// Serialized JSON — render preformatted, not as prose.
    Json,
    /// Anything else, kept verbatim.
    Text,
}

/// One bounded body of a tool call.
///
/// `text` is always present when the body is; `truncated` is what tells a reader
/// the difference between a short result and a long one that was cut.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct PayloadV1 {
    pub text: String,
    pub kind: PayloadKindV1,
    pub truncated: bool,
}

/// A tool call, paired with its result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct ToolActivityV1 {
    /// The `tool_use.id` this call was made under.
    ///
    /// Carried because it is the only thing that identifies a *call* rather than
    /// a row: two `Bash` calls in one turn are told apart by this and by nothing
    /// else. It is also what the client would need to correlate a live update,
    /// which is why it is on the wire rather than kept provider-side.
    pub call_id: String,
    /// The tool's name, e.g. `Bash`.
    pub name: String,
    pub status: ToolStatusV1,
    /// A one-line description, truncated to [`TOOL_SUMMARY_CEILING`].
    pub summary: String,
    /// What the call was given, when the transcript recorded it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<PayloadV1>,
    /// What it produced, when a result was paired.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<PayloadV1>,
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
pub enum MessageContentV1 {
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
/// deserializes. `id` is stable within the conversation, derived from the
/// transcript record, and is what a client keys identity reuse on across polls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MessageItemV1 {
    /// A human or model turn, with its content blocks in order.
    Message {
        /// Stable within the conversation, derived from the transcript record.
        id: String,
        /// The record's own timestamp, RFC 3339, when it carried one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timestamp: Option<String>,
        role: MessageRoleV1,
        /// Never empty: a turn whose blocks were all unmodelled is
        /// [`MessageItemV1::Unknown`], not a message with no content.
        content: Vec<MessageContentV1>,
    },
    /// A tool call, paired with its result when the transcript has one.
    Tool {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timestamp: Option<String>,
        tool: ToolActivityV1,
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

impl MessageItemV1 {
    /// The item's id, whichever arm it is.
    pub fn id(&self) -> &str {
        match self {
            Self::Message { id, .. } | Self::Tool { id, .. } | Self::Unknown { id, .. } => id,
        }
    }
}

/// Where the read of the requested conversation stands.
///
/// Four states, all about the *read*. Whether Claude is still running is
/// [`ConversationActivityV1`]'s answer, not a state; and "nothing selected" is
/// not a state either — that is what the sibling unit's list is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MessagesStateV1 {
    /// The requested conversation was found and the page is the answer.
    Ready,
    /// No conversation with the requested id is visible at the Session's cwd.
    ///
    /// Final — the response names no other conversation, because substituting
    /// the binding or the newest for a request that named one would be a guess
    /// the caller did not make (`#1005` decision 3).
    NotFound,
    /// The provider cannot establish the Session's cwd, so it cannot scope the
    /// read. Distinct from `NotFound`: nothing is wrong with the id, the scope
    /// is simply out of reach.
    Unavailable,
    /// The read was attempted and failed. `error` carries the reason.
    Error,
}

/// What the caller asks for.
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct MessagesRequestV1 {
    /// The Nession session the read is scoped to. Required: visibility is
    /// per-Session-cwd, so a request without one would be a machine-wide
    /// transcript lookup.
    pub session_id: String,

    /// The conversation to read — one of `claude-code.conversations`' `items[]`
    /// ids (or its `binding.conversation_id`). Required: **this is the only way
    /// a caller selects a conversation**. There is deliberately no "newest"
    /// flag: falling back to mtime is forbidden, and an API that cannot express
    /// a heuristic cannot make it by accident.
    pub conversation_id: String,

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
pub struct MessagesResponseV1 {
    pub state: MessagesStateV1,

    /// The conversation the page is from — the full item shape, not an
    /// identity projection. A client renders its header from this and never
    /// joins back against the list by id; the retired unit carried identity
    /// and metadata as two shapes and that join was the cost.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation: Option<ConversationItemV1>,

    /// Whether the conversation is live relative to the requesting Session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<ConversationActivityV1>,

    /// The page, oldest-first within the page.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<MessageItemV1>,

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

impl MessagesResponseV1 {
    /// The answer for a state that carries no items.
    pub fn bare(state: MessagesStateV1) -> Self {
        Self {
            state,
            conversation: None,
            activity: None,
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
            ..Self::bare(MessagesStateV1::Error)
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
        assert_eq!(MessagesResponseV1::page_limit(None), DEFAULT_ITEM_LIMIT);
        assert_eq!(MessagesResponseV1::page_limit(Some(10)), 10);
        assert_eq!(
            MessagesResponseV1::page_limit(Some(u32::MAX)),
            ITEM_CEILING,
            "a caller cannot make one response unbounded by asking for a large page"
        );
        assert_eq!(
            MessagesResponseV1::page_limit(Some(0)),
            1,
            "a zero page would return nothing and read as an empty conversation"
        );
    }

    #[test]
    fn an_item_serializes_with_its_kind_as_the_tag() {
        // The whole point of the union: a client switches on `kind`, and the
        // arm it selects is the arm that deserializes.
        let message = MessageItemV1::Message {
            id: "m1".into(),
            timestamp: Some("2026-09-25T00:00:00Z".into()),
            role: MessageRoleV1::Assistant,
            content: vec![MessageContentV1::Text {
                text: "# heading".into(),
            }],
        };
        let json = serde_json::to_value(&message).unwrap();
        assert_eq!(json["kind"], "message");
        assert_eq!(json["role"], "assistant");
        assert_eq!(json["content"][0]["type"], "text");

        let call = MessageItemV1::Tool {
            id: "t1".into(),
            timestamp: None,
            tool: ToolActivityV1 {
                call_id: "call-1".into(),
                name: "Bash".into(),
                status: ToolStatusV1::Error,
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
        let call = MessageItemV1::Tool {
            id: "t1".into(),
            timestamp: None,
            tool: ToolActivityV1 {
                call_id: "call-1".into(),
                name: "Read".into(),
                status: ToolStatusV1::Success,
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
    fn the_four_tool_states_are_told_apart() {
        // `Running` and `Unknown` are the pair worth pinning: collapsing them
        // would let "we did not look far enough" be presented as "still going".
        let states = [
            (ToolStatusV1::Running, "running"),
            (ToolStatusV1::Success, "success"),
            (ToolStatusV1::Error, "error"),
            (ToolStatusV1::Unknown, "unknown"),
        ];
        for (state, word) in states {
            assert_eq!(
                serde_json::to_string(&state).unwrap(),
                format!("\"{word}\"")
            );
        }
    }

    #[test]
    fn the_states_do_not_include_ready_wired_to_liveness_or_ambiguous() {
        // The retired unit's `inactive` was "the read succeeded but Claude
        // finished" — a liveness fact wearing a state costume, now answered by
        // `activity`. `ambiguous` died with the selection mechanism it served:
        // an explicit id is either found or it is not.
        for word in ["ready", "not_found", "unavailable", "error"] {
            let state: MessagesStateV1 = serde_json::from_str(&format!("\"{word}\"")).unwrap();
            assert_eq!(
                serde_json::to_string(&state).unwrap(),
                format!("\"{word}\"")
            );
        }
        assert!(serde_json::from_str::<MessagesStateV1>("\"inactive\"").is_err());
        assert!(serde_json::from_str::<MessagesStateV1>("\"ambiguous\"").is_err());
    }

    #[test]
    fn a_request_without_both_ids_is_malformed_not_defaulted() {
        // Required fields are the substitute-forbidding mechanism: a request
        // that omits either id fails to deserialize, so there is no shape in
        // which the provider is left to guess what was meant.
        assert!(serde_json::from_str::<MessagesRequestV1>(
            r#"{"session_id":"s1","conversation_id":"c1"}"#
        )
        .is_ok());
        assert!(
            serde_json::from_str::<MessagesRequestV1>(r#"{"conversation_id":"c1"}"#).is_err(),
            "a session-less request would be a machine-wide lookup"
        );
        assert!(
            serde_json::from_str::<MessagesRequestV1>(r#"{"session_id":"s1"}"#).is_err(),
            "a conversation-less request would need a default selection"
        );
    }

    #[test]
    fn a_not_found_response_names_no_other_conversation() {
        // The substitution ban, pinned structurally: `bare(NotFound)` is the
        // whole answer — no conversation, no binding, no newest.
        let value =
            serde_json::to_value(MessagesResponseV1::bare(MessagesStateV1::NotFound)).unwrap();
        assert_eq!(value["state"], "not_found");
        assert!(
            !value
                .as_object()
                .is_some_and(|o| o.contains_key("conversation")),
            "a substituted conversation would be a guess: {value}"
        );
    }

    #[test]
    fn a_response_never_serializes_a_filesystem_path() {
        let mut response = MessagesResponseV1::bare(MessagesStateV1::Ready);
        response.conversation = Some(ConversationItemV1 {
            id: "abc".into(),
            cwd: "/work".into(),
            updated_at: None,
            title: Some("a readable title".into()),
            preview: None,
        });
        let json = serde_json::to_string(&response).unwrap();
        assert!(
            !json.contains("transcript") && !json.contains(".jsonl"),
            "the response leaks where the transcript is: {json}"
        );
    }

    #[test]
    fn the_descriptor_names_this_unit_its_owner_and_its_wire() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "claude-code.messages");
        assert_eq!(d.owner, "nession-claude-code");
        assert_eq!(d.contracts[0].wire, vec![WIRE.to_string()]);
        assert!(d.validate().is_ok());
    }
}
