//! `claude-code.list` — what a `.claude/` directory holds.

pub mod v1;

pub use v1::{descriptor, ListRequestV1, ListResponseV1};

pub const ID: &str = "claude-code.list";

/// What the registry hands `handle_command` after stripping `extension.`.
///
/// Not the id: `ProtocolId` refuses underscores and the wire spelling cannot
/// change without breaking peers, so this provider translates where
/// `nession-git` can compare. `the_wire_suffix_is_not_the_protocol_id` in the
/// parent module pins the difference.
pub const COMMAND: &str = "claude-code.list";
