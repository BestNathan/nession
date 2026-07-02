//! nession-agent – distributed tmux agent.
//!
//! The agent runs on a machine with tmux and:
//! - Accepts P2P WebSocket connections from CLI clients (the agent server)
//! - Connects to the central nession-server for discovery and coordination
//! - Sends periodic heartbeats with session metrics
//! - Watches for tmux session changes and syncs them to the server

pub mod config;
pub mod connection;
pub mod fs;
pub mod server;
pub mod sync;
pub mod tmux;
