//! `claude-code.mcp-server` — one named MCP entry and optional discovery.

pub mod v1;

pub use v1::*;

pub const ID: &str = "claude-code.mcp-server";

pub const COMMAND: &str = "claude-code.mcp-server";
