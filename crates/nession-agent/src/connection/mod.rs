//! Connection module for agent-to-server communication.
//!
//! This module provides the WebSocket client that connects the agent to the
//! central nession-server for registration, heartbeat, and session updates.

/// How this connection's frames are scheduled (`#961-E`): the lanes, the
/// policies and the bounds. `crate::server::execution` is the peer-to-peer
/// socket's answer to the same question — see [`execution`] for why the two are
/// separate modules rather than one.
pub mod execution;
/// How this connection's business notifications leave it (`#961`, finding 4):
/// a bounded, coalescing lane per class. The outbound half of [`execution`],
/// and the two are deliberately separate modules — one is what a peer may make
/// this agent *do*, the other is what this agent *says* about itself.
pub mod outbox;
mod server_client;

// `core_descriptors` is generated in `server_client` because the handlers it
// describes need that module's private state; it is re-exported here so callers
// composing the manifest name it without opening the module.
pub use server_client::{core_descriptors, msg_types, ServerClient, ServerClientHandle};
