//! `claude-code.transcripts` / v1 — the **transcript** collection of one Nession
//! Session (`#1234`).
//!
//! This unit answers one question: which transcripts are visible at the
//! Session's current strict cwd, and which one — if any — the Session is exactly
//! bound to. It is the transcript projection's sibling to
//! [`crate::protocol::conversations`], not a replacement for it: the same
//! upstream session is *one* conversation and *one* transcript, and the two
//! resource families stay semantically distinct even where they name the same
//! file.
//!
//! ## A transcript is not always a session
//!
//! Claude Code writes a session's own transcript as a flat
//! `<project>/<session-uuid>.jsonl`, and **every subagent that session spawns**
//! as a separate `<project>/<session-uuid>/subagents/agent-<id>.jsonl`.
//! Measured over `~/.claude/projects`: 464 such transcripts against 170
//! sessions, one session spawning up to 19 of them.
//!
//! The conversation list shows only the sessions — a user's list of their own
//! work should not be the model's internal delegation — and this list is where
//! the subagents are reachable. [`TranscriptKindV1`] is the distinction, and
//! `parent_id` is what keeps the relation, which `#1234` requires even though a
//! subagent *tree* UI is explicitly not required in v1.
//!
//! ## What this unit never does
//!
//! - **Never carries a transcript path.** Same structural rule as both sibling
//!   units: the location is how the provider reaches the file, and the response
//!   shape makes that a property of the type rather than a rule to remember.
//! - **Never opens a transcript.** Which one to read is the caller's decision,
//!   made through `claude-code.transcript-items`; a list of one is still a list
//!   of one.
//! - **Never answers by recency.** `updated_at` is display metadata and a
//!   listing order, not an identity and not a selection.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::conversations::v1::ConversationActivityV1;
use crate::protocol::v1_descriptor;

pub const WIRE: &str = "claude-code.transcripts";

/// Most transcripts one response may carry, whatever the caller asks for.
pub const ITEM_CEILING: u32 = 200;

/// Transcripts returned when the caller names no limit.
pub const DEFAULT_ITEM_LIMIT: u32 = 50;

/// Whether a transcript is a session's own, or a subagent's within it.
///
/// Two values and no `unknown`: the distinction is structural — a session's
/// transcript is the file the session *is*, a subagent's lives under it — so a
/// provider that cannot tell them apart cannot tell which files it is looking
/// at, and that is a failure to answer rather than a state to report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum TranscriptKindV1 {
    /// A session's own transcript.
    Primary,
    /// A subagent's transcript, belonging to the session that spawned it.
    Sidechain,
}

/// One transcript: identity, its kind, and bounded display metadata.
///
/// The same shape is returned in `items[]` and, by
/// `claude-code.transcript-items`, as the `transcript` whose page was read — so
/// a client renders a header from one object rather than joining the list
/// against the page, which is the join `#1222` removed from the conversation
/// pair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct TranscriptItemV1 {
    /// The transcript's identity, opaque to the caller.
    ///
    /// **Not** the upstream `sessionId`, which cannot serve as one: measured, a
    /// subagent's own `sessionId` is sometimes its own and sometimes its
    /// parent's, so it does not tell two subagents of one session apart. This is
    /// derived from where the transcript lives, which always does.
    pub id: String,
    /// The cwd the transcript **itself** recorded — not scope.
    ///
    /// For a subagent that is frequently a subdirectory of its session's
    /// (measured: `…/feat-session-attach-profile/web` under a session recorded
    /// at `…/feat-session-attach-profile`), and it is scoped by its session, not
    /// by this. Reported because it is true, not because it selects.
    pub cwd: String,
    pub kind: TranscriptKindV1,
    /// The session this transcript belongs to. Present for a sidechain only —
    /// a primary transcript *is* the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// The subagent's own id, for a sidechain.
    ///
    /// Distinct from `parent_id` because one session spawns many.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// Claude's own title, when it wrote one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// What the user last asked, when Claude recorded it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// When the transcript starts, from its first record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// Newest timestamp it carries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

/// The Session↔transcript relationship, when the host reported an exact one.
///
/// Beside the items rather than on one of them, exactly as the conversation
/// unit's binding is: a binding is a fact about the Session, not a property of
/// the transcript.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct TranscriptBindingV1 {
    /// The transcript the Session is bound to — one of `items[]`'s ids.
    pub transcript_id: String,
    pub activity: ConversationActivityV1,
}

/// Where the listing stands.
///
/// Three states, and `not_found` is deliberately **not** one of them: a cwd
/// that holds no transcripts is a successful answer with an empty list, exactly
/// as it is for conversations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum TranscriptsStateV1 {
    /// The provider answered; `items` is the whole answer, empty or not.
    Ready,
    /// The provider cannot establish the Session's cwd, so it cannot say what
    /// is visible. Distinct from an empty list.
    Unavailable,
    /// The listing was attempted and failed. `error` carries the reason.
    Error,
}

/// What the caller asks for.
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct TranscriptsRequestV1 {
    /// The Nession session whose transcripts are wanted. Required, because
    /// visibility is scoped to a Session's cwd — there is no machine-wide
    /// listing.
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
pub struct TranscriptsResponseV1 {
    pub state: TranscriptsStateV1,

    /// The Session's cwd the listing was made at, when it could be established.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,

    /// The transcripts visible at `cwd`, newest first — a listing order, not a
    /// selection.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<TranscriptItemV1>,

    /// The exact Nession↔transcript binding, when one is known and current.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<TranscriptBindingV1>,

    /// Pass back to continue. Absent when there are no more transcripts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,

    /// Whether more transcripts exist beyond this page.
    pub has_more: bool,

    /// The reason, when `state` is `Error`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl TranscriptsResponseV1 {
    /// The answer for a state that carries no items.
    pub fn bare(state: TranscriptsStateV1) -> Self {
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
            ..Self::bare(TranscriptsStateV1::Error)
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

    fn item(id: &str, kind: TranscriptKindV1) -> TranscriptItemV1 {
        TranscriptItemV1 {
            id: id.into(),
            cwd: "/work".into(),
            kind,
            parent_id: None,
            agent_id: None,
            title: None,
            preview: None,
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn the_page_limit_is_clamped_and_never_zero() {
        assert_eq!(TranscriptsResponseV1::page_limit(None), DEFAULT_ITEM_LIMIT);
        assert_eq!(TranscriptsResponseV1::page_limit(Some(10)), 10);
        assert_eq!(
            TranscriptsResponseV1::page_limit(Some(u32::MAX)),
            ITEM_CEILING,
            "a caller cannot make one response unbounded by asking for a large page"
        );
        assert_eq!(
            TranscriptsResponseV1::page_limit(Some(0)),
            1,
            "a zero page would return nothing and read as an empty directory"
        );
    }

    #[test]
    fn an_empty_successful_list_is_structural_not_a_failure_state() {
        // A cwd with no transcripts is `ready` with nothing in it. A `not_found`
        // state would make "the provider answered and there were none"
        // indistinguishable from "the provider could not answer".
        let value =
            serde_json::to_value(TranscriptsResponseV1::bare(TranscriptsStateV1::Ready)).unwrap();
        assert_eq!(value["state"], "ready");
        assert_eq!(value["has_more"], false);
        assert!(
            !value.as_object().is_some_and(|o| o.contains_key("items")),
            "an empty list is omitted, not sent as []: {value}"
        );
    }

    #[test]
    fn the_states_do_not_include_not_found() {
        for word in ["ready", "unavailable", "error"] {
            let state: TranscriptsStateV1 = serde_json::from_str(&format!("\"{word}\"")).unwrap();
            assert_eq!(
                serde_json::to_string(&state).unwrap(),
                format!("\"{word}\"")
            );
        }
        assert!(serde_json::from_str::<TranscriptsStateV1>("\"not_found\"").is_err());
    }

    #[test]
    fn the_two_kinds_are_told_apart_on_the_wire() {
        for (kind, word) in [
            (TranscriptKindV1::Primary, "primary"),
            (TranscriptKindV1::Sidechain, "sidechain"),
        ] {
            assert_eq!(serde_json::to_string(&kind).unwrap(), format!("\"{word}\""));
        }
    }

    #[test]
    fn a_sidechain_carries_its_relation_and_a_primary_carries_none() {
        // The relation is the whole reason a subagent is listable without a tree
        // UI (#1234): dropping `parent_id` would leave 464 transcripts that
        // belong to something and do not say what.
        let mut sidechain = item("s1/agent-a", TranscriptKindV1::Sidechain);
        sidechain.parent_id = Some("s1".into());
        sidechain.agent_id = Some("agent-a".into());
        let value = serde_json::to_value(&sidechain).unwrap();
        assert_eq!(value["kind"], "sidechain");
        assert_eq!(value["parent_id"], "s1");
        assert_eq!(value["agent_id"], "agent-a");

        let primary = item("s1", TranscriptKindV1::Primary);
        let json = serde_json::to_string(&primary).unwrap();
        assert!(
            !json.contains("parent_id") && !json.contains("agent_id"),
            "a session's own transcript claims a parent: {json}"
        );
    }

    #[test]
    fn an_absent_field_is_omitted_rather_than_sent_as_null() {
        // A client deciding whether to draw a second line reads absence
        // directly; `"preview": null` would make "not recorded" and "recorded as
        // nothing" the same payload.
        let json = serde_json::to_string(&item("s1", TranscriptKindV1::Primary)).unwrap();
        for absent in ["title", "preview", "created_at", "updated_at"] {
            assert!(!json.contains(absent), "{absent} was serialized: {json}");
        }
    }

    #[test]
    fn an_item_never_serializes_a_filesystem_path() {
        // The path is how the provider reaches the file. This makes that a
        // property of the shape rather than a rule someone has to remember.
        let mut transcript = item("s1/agent-a", TranscriptKindV1::Sidechain);
        transcript.title = Some("a readable title".into());
        let json = serde_json::to_string(&transcript).unwrap();
        assert!(
            !json.contains("subagents") && !json.contains(".jsonl"),
            "the item leaks where the transcript is: {json}"
        );
    }

    #[test]
    fn a_request_without_a_session_is_malformed_not_defaulted() {
        // Required, because visibility is per-Session-cwd: a request without one
        // would be a machine-wide transcript lookup.
        assert!(serde_json::from_str::<TranscriptsRequestV1>(r#"{"session_id":"s1"}"#).is_ok());
        assert!(serde_json::from_str::<TranscriptsRequestV1>(r#"{"cursor":"1"}"#).is_err());
    }

    #[test]
    fn a_binding_names_a_transcript_and_an_activity_and_nothing_else() {
        let binding = TranscriptBindingV1 {
            transcript_id: "s1".into(),
            activity: ConversationActivityV1::Active,
        };
        let value = serde_json::to_value(&binding).unwrap();
        assert_eq!(
            value.as_object().map(serde_json::Map::len),
            Some(2),
            "a binding is a relationship, not a transcript projection: {value}"
        );
    }

    #[test]
    fn the_descriptor_names_this_unit_its_owner_and_its_wire() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "claude-code.transcripts");
        assert_eq!(d.owner, "nession-claude-code");
        assert_eq!(d.contracts[0].wire, vec![WIRE.to_string()]);
        assert!(d.validate().is_ok());
    }
}
