//! `claude-code.conversations` / v1 — the conversation **collection** of one
//! Nession Session (`#1222`).
//!
//! This unit answers one question: which conversations are visible at the
//! Session's current strict cwd, and which one — if any — the Session is
//! exactly bound to. Reading one conversation's timeline is
//! [`crate::protocol::messages`]' job; the two used to be a single
//! `claude-code.conversation` unit whose `claude_session_id?` field switched
//! between the two operations, and whose `ambiguous` state existed only because
//! they shared one. Here **the list is the answer**: an unbound session is not
//! an ambiguity to resolve, it is a list the caller has not chosen from yet.
//!
//! ## What this unit never does
//!
//! - **Never opens a conversation.** A binding is *reported*, and the caller
//!   decides what to do with it; a list of one is still a list of one, and is
//!   not auto-opened (`#1005` decision 3 — no heuristic stands in for a
//!   selection).
//! - **Never carries a transcript path.** The transcript's location is the
//!   provider's business; the response shape makes that structural rather
//!   than a rule.
//! - **Never answers by recency.** `updated_at` is display metadata and a
//!   listing order, not an identity and not a selection.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::v1_descriptor;

pub const WIRE: &str = "claude-code.conversations";

/// Most conversations one response may carry, whatever the caller asks for.
///
/// The list is bounded for the same reason a message page is: a directory of
/// transcripts is unbounded, and `#1222` requires the wire response not to be.
pub const ITEM_CEILING: u32 = 200;

/// Conversations returned when the caller names no limit.
pub const DEFAULT_ITEM_LIMIT: u32 = 50;

/// Whether a conversation is live relative to the Nession Session.
///
/// A closed enum rather than a boolean, because "Claude finished" and "the host
/// cannot say" are different facts: presenting the second as the first is a
/// claim the provider cannot support.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ConversationActivityV1 {
    /// The Session is bound to this conversation and Claude is running now.
    Active,
    /// Claude is not running for this conversation — either it finished, or
    /// the Session's live Claude belongs to another one.
    Inactive,
    /// The host could not say either way. Never presented as either of the
    /// other two.
    Unknown,
}

/// One conversation: identity plus bounded display metadata.
///
/// This is **the** conversation shape of the provider — returned here in
/// `items[]`, and returned by `claude-code.messages` as `conversation` for the
/// conversation whose page was read. The retired unit carried two projections
/// of this (a `Candidate` with metadata and an `Identity` without), and the Web
/// had to join them back by id to render a header; that join is why this is
/// one shape now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct ConversationItemV1 {
    /// The conversation's identity — Claude's own session id.
    ///
    /// Spelled `id` rather than `claude_session_id` because the value is
    /// already inside the `claude-code` provider namespace. **Identity, never
    /// display**: it is stable for the transcript, is returned unchanged to
    /// `claude-code.messages` as `conversation_id`, and is never inferred from
    /// a title, a cwd or a timestamp.
    pub id: String,
    /// The cwd the transcript itself recorded — not the directory it was
    /// found in, which is not a usable index.
    pub cwd: String,
    /// Newest timestamp the transcript carried, when it carried one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// Claude's own title for the conversation, when it wrote one.
    ///
    /// Display metadata, never identity: two conversations may carry the same
    /// title, and no selection path reads this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// What the user last asked, when Claude recorded it.
    ///
    /// Display metadata, never identity, exactly as `title` is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

/// The Session↔conversation relationship, when the host reported an exact one.
///
/// Carried **beside** the items rather than on one of them: a binding is a fact
/// about the Session, not a property of the conversation — the same
/// conversation is another Session's unbound list row. Absent when the host
/// reported no binding, and absent when the binding's transcript is not among
/// this Session's current cwd (a stale binding is not the current one).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct ConversationBindingV1 {
    /// The conversation the Session is bound to — one of `items[]`'s ids.
    pub conversation_id: String,
    pub activity: ConversationActivityV1,
}

/// Where the listing stands.
///
/// Three states, and `not_found` is deliberately **not** one of them: a cwd
/// that holds no conversations is a successful answer with an empty list, not
/// a failure — `state: ready, items: []` says it structurally.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ConversationsStateV1 {
    /// The provider answered; `items` is the whole answer, empty or not.
    Ready,
    /// The provider cannot establish the Session's cwd, so it cannot say what
    /// is visible. Distinct from an empty list: nothing is wrong with the
    /// directory, the fact is simply out of reach.
    Unavailable,
    /// The listing was attempted and failed. `error` carries the reason.
    Error,
}

/// What the caller asks for.
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct ConversationsRequestV1 {
    /// The Nession session whose conversations are wanted. Required, because
    /// conversation visibility is scoped to a Session's cwd — there is no
    /// machine-wide listing.
    pub session_id: String,

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
pub struct ConversationsResponseV1 {
    pub state: ConversationsStateV1,

    /// The Session's cwd the listing was made at, when it could be established.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,

    /// The conversations visible at `cwd`, newest first — a listing order, not
    /// a selection.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<ConversationItemV1>,

    /// The exact Nession↔Claude binding, when one is known and current.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<ConversationBindingV1>,

    /// Pass back to continue. Absent when there are no more conversations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,

    /// Whether more conversations exist beyond this page.
    pub has_more: bool,

    /// The reason, when `state` is `Error`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ConversationsResponseV1 {
    /// The answer for a state that carries no items.
    pub fn bare(state: ConversationsStateV1) -> Self {
        Self {
            state,
            cwd: None,
            items: Vec::new(),
            binding: None,
            next_cursor: None,
            has_more: false,
            error: None,
        }
    }

    /// The answer for a listing that failed, carrying why.
    pub fn error(reason: impl Into<String>) -> Self {
        Self {
            error: Some(reason.into()),
            ..Self::bare(ConversationsStateV1::Error)
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
            ConversationsResponseV1::page_limit(None),
            DEFAULT_ITEM_LIMIT
        );
        assert_eq!(ConversationsResponseV1::page_limit(Some(10)), 10);
        assert_eq!(
            ConversationsResponseV1::page_limit(Some(u32::MAX)),
            ITEM_CEILING,
            "a caller cannot make one response unbounded by asking for a large page"
        );
        assert_eq!(
            ConversationsResponseV1::page_limit(Some(0)),
            1,
            "a zero page would return nothing and read as an empty directory"
        );
    }

    #[test]
    fn an_empty_successful_list_is_structural_not_a_failure_state() {
        // The canonical model's answer to "no conversations here": `ready` with
        // nothing in it. A `not_found` state would make "the provider answered
        // and there were none" indistinguishable from "the provider could not
        // answer" — which is what `unavailable` is for.
        let value =
            serde_json::to_value(ConversationsResponseV1::bare(ConversationsStateV1::Ready))
                .unwrap();
        assert_eq!(value["state"], "ready");
        assert_eq!(value["has_more"], false);
        assert!(
            !value.as_object().is_some_and(|o| o.contains_key("items")),
            "an empty list is omitted, not sent as []: {value}"
        );
    }

    #[test]
    fn the_states_do_not_include_ambiguous_or_not_found() {
        // `ambiguous` existed only because list and message-read shared one
        // operation: with a first-class list, "nothing selected" is simply the
        // list. `not_found` is an empty successful list, not a state.
        for word in ["ready", "unavailable", "error"] {
            let state: ConversationsStateV1 = serde_json::from_str(&format!("\"{word}\"")).unwrap();
            assert_eq!(
                serde_json::to_string(&state).unwrap(),
                format!("\"{word}\"")
            );
        }
        assert!(serde_json::from_str::<ConversationsStateV1>("\"ambiguous\"").is_err());
        assert!(serde_json::from_str::<ConversationsStateV1>("\"not_found\"").is_err());
    }

    #[test]
    fn the_three_activities_are_told_apart() {
        // `unknown` is the one worth pinning: "the host could not say" must not
        // collapse into either claim.
        for (activity, word) in [
            (ConversationActivityV1::Active, "active"),
            (ConversationActivityV1::Inactive, "inactive"),
            (ConversationActivityV1::Unknown, "unknown"),
        ] {
            assert_eq!(
                serde_json::to_string(&activity).unwrap(),
                format!("\"{word}\"")
            );
        }
    }

    #[test]
    fn a_binding_names_a_conversation_and_an_activity_and_nothing_else() {
        let binding = ConversationBindingV1 {
            conversation_id: "abc".into(),
            activity: ConversationActivityV1::Active,
        };
        let value = serde_json::to_value(&binding).unwrap();
        assert_eq!(value["conversation_id"], "abc");
        assert_eq!(value["activity"], "active");
        assert_eq!(
            value.as_object().map(serde_json::Map::len),
            Some(2),
            "a binding is a relationship, not a conversation projection: {value}"
        );
    }

    #[test]
    fn an_item_never_serializes_a_filesystem_path() {
        let item = ConversationItemV1 {
            id: "abc".into(),
            cwd: "/work".into(),
            updated_at: None,
            title: Some("a readable title".into()),
            preview: None,
        };
        let json = serde_json::to_string(&item).unwrap();
        assert!(
            !json.contains("transcript") && !json.contains(".jsonl"),
            "the item leaks where the transcript is: {json}"
        );
    }

    #[test]
    fn the_descriptor_names_this_unit_its_owner_and_its_wire() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "claude-code.conversations");
        assert_eq!(d.owner, "nession-claude-code");
        assert_eq!(d.contracts[0].wire, vec![WIRE.to_string()]);
        assert!(d.validate().is_ok());
    }
}
