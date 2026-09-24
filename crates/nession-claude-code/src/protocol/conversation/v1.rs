//! `claude-code.conversation` / v1.
//!
//! The normalized shape of one Claude Code conversation, as this provider
//! understands it. Web binds to *this*, never to Claude's JSONL
//! (`#1005` constraint 2): the upstream record set is open — a measured
//! transcript carried 13 record types that are not messages, plus four block
//! types inside the messages — and it grows. A client that parsed it directly
//! would break on the next internal event Claude adds.
//!
//! ## Why a new Protocol Unit rather than more of `claude-code.read`
//!
//! `read` is "give me bytes of a file", capped at 1 MB and implemented by
//! reading the whole file into a `String`. Both are wrong for a transcript on
//! every axis that matters here: an append-only JSONL of this size is not
//! something to load per refresh, and a byte chunk carries no conversation
//! semantics. `#1005` asks for a separate unit, and the split is also what
//! keeps `read`'s shipped shape untouched.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::v1_descriptor;

pub const WIRE: &str = "claude-code.conversation";

/// Most items one response may carry, whatever the caller asks for.
///
/// A request, clamped — the shape `read` learned the hard way. The ceiling
/// exists so a caller cannot make one response unbounded by asking for a large
/// page, and it is enforced here rather than trusted to the provider.
pub const ITEM_CEILING: u32 = 200;

/// Items returned when the caller names no limit.
pub const DEFAULT_ITEM_LIMIT: u32 = 50;

/// Longest tool summary in characters.
///
/// Tool traffic dominates a real transcript — one measured conversation had
/// 1099 `tool_use` and 1098 `tool_result` blocks against 619 assistant text
/// blocks — so a tool result must not be able to carry a page's worth of bytes
/// through a single item. The full payload is not part of v1 at all; this only
/// bounds the summary that is.
pub const TOOL_SUMMARY_CEILING: usize = 500;

/// What one item in the conversation is.
///
/// A closed enum with an explicit `Unknown` arm rather than a string: a string
/// would let an unrecognised upstream shape arrive as a bare `"foo"` and be
/// rendered as a chat row, which is the failure `#1005` criterion 4 names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ItemKindV1 {
    /// A human turn.
    User,
    /// A model turn — the prose, with any reasoning folded away.
    Assistant,
    /// A tool call, paired with its result when the transcript has one.
    ///
    /// Default-collapsed in every client. This is the arm that keeps a
    /// transcript readable.
    Tool,
    /// A record this version does not model.
    ///
    /// Carried rather than dropped so a client can say "some events were not
    /// shown" instead of silently presenting a conversation with holes in it.
    Unknown,
}

/// Where the conversation stands, which is not the same as whether it loaded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ConversationStateV1 {
    /// Items are available, and Claude Code is running right now.
    Ready,
    /// Items are available from the last conversation this Session was bound to,
    /// and Claude Code is no longer running. A client must not present this as
    /// live (`#1005` criterion 4).
    Inactive,
    /// The session's cwd has more than one candidate and nothing proves which is
    /// current. The caller picks from [`ConversationResponseV1::candidates`].
    Ambiguous,
    /// The session's cwd has no conversations at all.
    NotFound,
    /// This provider cannot answer — no `claude` on the host, or the integration
    /// is not installed. Distinct from `NotFound`: nothing is wrong with the
    /// session's cwd, the capability is simply absent.
    Unavailable,
    /// The read was attempted and failed. `error` carries the reason.
    Error,
}

/// What the caller asks for.
#[derive(Debug, Clone, Default, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct ConversationRequestV1 {
    /// The Nession session whose conversation is wanted.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub session_id: Option<String>,

    /// The Claude conversation the caller has explicitly chosen.
    ///
    /// Set when a user picks from the candidate list, or when the client is
    /// restoring the conversation it was already showing. **This is the only
    /// way a caller selects a conversation** — there is deliberately no
    /// "newest" flag, because `#1005` forbids falling back to mtime and an
    /// API that cannot express the choice is one that cannot make it by
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

/// A tool call, reduced to what a reader needs to know it happened.
///
/// No input payload and no result body: `#1005` bounds resource use and keeps
/// tool output from drowning the conversation, and a v1 that shipped the bodies
/// would do neither.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct ToolV1 {
    /// The tool's name, e.g. `Bash`.
    pub name: String,
    /// A one-line description, truncated to [`TOOL_SUMMARY_CEILING`].
    pub summary: String,
    /// Whether the tool reported failure. Paired from the result record.
    pub is_error: bool,
    /// Whether the transcript held more than `summary` shows.
    pub truncated: bool,
}

/// One thing that happened in the conversation, in order.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct ConversationItemV1 {
    /// Stable within the conversation, derived from the transcript record.
    pub id: String,
    pub kind: ItemKindV1,
    /// The record's own timestamp, RFC 3339, when it carried one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    /// The message text, for `user` and `assistant`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Present only for [`ItemKindV1::Tool`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<ToolV1>,
}

/// A conversation this session's cwd could be showing.
///
/// **No filesystem path.** The transcript's location is the provider's
/// business (`#1005` criterion 7): a client that never learns the path cannot
/// ask for one, and the response shape makes that structural rather than a rule
/// someone has to remember.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct ConversationCandidateV1 {
    /// The Claude session id, which is also what a caller passes back to select
    /// this conversation.
    pub claude_session_id: String,
    /// The cwd the transcript itself recorded.
    ///
    /// The transcript's own field, not the directory it was found in — those
    /// disagree in practice (measured: 10 of 39 transcripts sit in a directory
    /// that does not correspond to their `cwd`), which is why matching is done
    /// against this value and not against a directory name.
    pub cwd: String,
    /// The newest timestamp in the transcript, when it had one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

/// The conversation the response is about.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct ConversationIdentityV1 {
    pub claude_session_id: String,
    pub cwd: String,
}

/// The answer.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct ConversationResponseV1 {
    pub state: ConversationStateV1,

    /// Set when a conversation was resolved — including an `Inactive` one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation: Option<ConversationIdentityV1>,

    /// What the caller may choose from, when `state` is `Ambiguous`.
    ///
    /// Also populated for `Ready` so a client can offer the list without a
    /// second round trip — `#1005` decision 3 makes the list the stable entry
    /// point, not a fallback.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<ConversationCandidateV1>,

    /// The page, oldest-first within the page.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<ConversationItemV1>,

    /// Pass back to continue. Absent when there is nothing older.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,

    /// Whether older items exist beyond this page.
    pub has_more: bool,

    /// Whether the transcript ended mid-record when it was read.
    ///
    /// **Not an error.** A transcript being appended to routinely ends in a
    /// partial line; `#1005` criterion 6 requires that the completed messages
    /// still render, so this reports the condition instead of failing the read.
    pub partial_tail: bool,

    /// How many records were skipped as unrecognised.
    ///
    /// Reported rather than silent so a client can say the conversation is
    /// partial when upstream adds a record this version does not model.
    pub skipped: u64,

    /// The reason, when `state` is `Error`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ConversationResponseV1 {
    /// The answer for a state that carries no items.
    pub fn bare(state: ConversationStateV1) -> Self {
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
            ..Self::bare(ConversationStateV1::Error)
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
    v1_descriptor("claude-code.conversation", WIRE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_limit_is_clamped_and_never_zero() {
        assert_eq!(ConversationResponseV1::page_limit(None), DEFAULT_ITEM_LIMIT);
        assert_eq!(ConversationResponseV1::page_limit(Some(10)), 10);
        assert_eq!(
            ConversationResponseV1::page_limit(Some(u32::MAX)),
            ITEM_CEILING,
            "a caller cannot make one response unbounded by asking for a large page"
        );
        assert_eq!(
            ConversationResponseV1::page_limit(Some(0)),
            1,
            "a zero page would return nothing and read as an empty conversation"
        );
    }

    #[test]
    fn a_bare_response_carries_no_items_and_no_fabricated_conversation() {
        let answered = ConversationResponseV1::bare(ConversationStateV1::NotFound);
        assert!(answered.conversation.is_none());
        assert!(answered.items.is_empty());
        assert!(!answered.has_more);
        assert_eq!(answered.skipped, 0);
    }

    #[test]
    fn an_error_response_carries_its_reason() {
        let failed = ConversationResponseV1::error("transcript unreadable");
        assert_eq!(failed.state, ConversationStateV1::Error);
        assert_eq!(failed.error.as_deref(), Some("transcript unreadable"));
    }

    #[test]
    fn states_and_kinds_serialize_as_snake_case() {
        assert_eq!(
            serde_json::to_string(&ConversationStateV1::NotFound).unwrap(),
            "\"not_found\""
        );
        assert_eq!(
            serde_json::to_string(&ItemKindV1::Tool).unwrap(),
            "\"tool\""
        );
    }

    #[test]
    fn a_response_never_serializes_a_filesystem_path() {
        // The candidate carries the conversation's identity and its cwd, and
        // nothing about *where the transcript lives*: a client that never
        // learns the path cannot ask for one (#1005 criterion 7).
        let candidate = ConversationCandidateV1 {
            claude_session_id: "abc".to_string(),
            cwd: "/work".to_string(),
            updated_at: None,
        };
        let json = serde_json::to_string(&candidate).unwrap();
        assert!(
            !json.contains("transcript") && !json.contains(".jsonl"),
            "the candidate leaks where the transcript is: {json}"
        );
    }
}
