//! `claude-code.conversations` — the conversations of one Nession Session, and
//! which one the Session is exactly bound to.

pub mod v1;

pub use v1::{
    descriptor, ConversationActivityV1, ConversationBindingV1, ConversationItemV1,
    ConversationsRequestV1, ConversationsResponseV1, ConversationsStateV1,
};

pub const ID: &str = "claude-code.conversations";

/// What the registry hands `handle_command` — the same string as `ID` and as
/// `v1::WIRE` (see `list/mod.rs` for why the three are one).
pub const COMMAND: &str = "claude-code.conversations";
