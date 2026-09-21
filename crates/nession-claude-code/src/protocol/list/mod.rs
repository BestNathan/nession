//! `claude-code.list` — what a `.claude/` directory holds.

pub mod v1;

pub use v1::{descriptor, ListRequestV1, ListResponseV1};

pub const ID: &str = "claude-code.list";

/// What the registry hands `handle_command`.
///
/// The same string as `ID` below and as `v1::WIRE` — this provider *compares*
/// where it used to translate. The registry passes `msg_type` through verbatim,
/// and `ProtocolId` refuses underscores, so the wire had to drop its underscore
/// for the two to be one string; `the_wire_is_the_protocol_id` in the parent
/// module pins that they are.
pub const COMMAND: &str = "claude-code.list";
