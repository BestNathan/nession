//! Connection module for agent-to-server communication.
//!
//! This module provides the WebSocket client that connects the agent to the
//! central nession-server for registration, heartbeat, and session updates.

mod server_client;

// `core_descriptors` is generated in `server_client` because the handlers it
// describes need that module's private state; it is re-exported here so callers
// composing the manifest name it without opening the module.
pub use server_client::{core_descriptors, msg_types, ServerClient, ServerClientHandle};
