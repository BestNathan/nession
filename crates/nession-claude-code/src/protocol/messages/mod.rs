//! `claude-code.messages` — the normalized timeline of one explicitly named
//! conversation.

pub mod v1;

pub use v1::{
    descriptor, MessageContentV1, MessageItemV1, MessageRoleV1, MessagesRequestV1,
    MessagesResponseV1, MessagesStateV1, PayloadKindV1, PayloadV1, ToolActivityV1, ToolStatusV1,
};

pub const ID: &str = "claude-code.messages";

/// What the registry hands `handle_command` — the same string as `ID` and as
/// `v1::WIRE` (see `list/mod.rs` for why the three are one).
pub const COMMAND: &str = "claude-code.messages";
