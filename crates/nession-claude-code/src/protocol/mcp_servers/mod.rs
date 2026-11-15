//! `claude-code.mcp-servers` — the current Session's Claude MCP inventory.

pub mod v1;

pub use v1::*;

pub const ID: &str = "claude-code.mcp-servers";

/// What the registry hands `handle_command`. The wire is the id (`#678`).
pub const COMMAND: &str = "claude-code.mcp-servers";
