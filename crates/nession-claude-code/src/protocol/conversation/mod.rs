//! `claude-code.conversation` — one Nession Session's Claude conversation,
//! normalized and paged.

pub mod v1;

pub use v1::{
    descriptor, ConversationCandidateV1, ConversationIdentityV1, ConversationItemV1,
    ConversationRequestV1, ConversationResponseV1, ConversationStateV1, ItemKindV1, ToolV1,
    DEFAULT_ITEM_LIMIT, ITEM_CEILING, TOOL_SUMMARY_CEILING,
};

pub const ID: &str = "claude-code.conversation";

/// What the registry hands `handle_command`.
///
/// The same string as `ID` and as `v1::WIRE` — the wire *is* the protocol id,
/// so there is nothing to translate. Three names for one string because they
/// answer three different questions: identity, dispatch key, transport
/// projection.
pub const COMMAND: &str = "claude-code.conversation";
