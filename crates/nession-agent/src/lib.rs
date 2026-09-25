//! nession-agent – distributed tmux agent.
//!
//! The agent runs on a machine with tmux and:
//! - Accepts P2P WebSocket connections from CLI clients (the agent server)
//! - Connects to the central nession-server for discovery and coordination
//! - Sends periodic heartbeats with session metrics
//! - Watches for tmux session changes and syncs them to the server

pub mod claude_binding;
pub mod claude_session_context;
pub mod config;
pub mod connection;
pub mod env;
pub mod extension;
pub mod fs;
pub mod git_workdir;
pub mod identity;
pub mod netdetect;
pub mod netwatch;
pub mod p2p_credentials;
pub mod protocol;
pub mod runtime;
pub mod server;
pub mod sync;
pub mod tmux;

#[cfg(test)]
mod test_support;
