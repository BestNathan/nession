//! nession-agent – distributed tmux agent.
//!
//! The agent runs on a machine with tmux and:
//! - Accepts P2P WebSocket connections from CLI clients (the agent server)
//! - Connects to the central nession-server for discovery and coordination
//! - Sends periodic heartbeats with session metrics
//! - Watches for tmux session changes and syncs them to the server

pub mod claude_binding;
pub mod claude_control;
pub mod claude_session_context;
pub mod claude_workspace_trust;
pub mod config;
pub mod connection;
pub mod env;
pub mod erofs_cache;
pub mod execution;
pub mod extension;
pub mod fs;
pub mod git_workdir;
pub mod identity;
pub mod managed_session;
pub mod memory;
pub mod netdetect;
pub mod netwatch;
pub mod p2p_auth;
pub mod peer_registry;
pub mod protocol;
pub mod registry;
pub mod runtime;
pub mod sandbox_images;
pub mod sandbox_runtime;
pub mod server;
pub mod session;
pub mod session_created;
pub mod session_env;
pub mod stream;
pub mod sync;
pub mod tmux;
pub mod token;
pub mod workspace_manager;

#[cfg(test)]
mod test_support;
