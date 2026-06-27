//! Connection module for agent-to-server communication.
//!
//! This module provides the WebSocket client that connects the agent to the
//! central nession-server for registration, heartbeat, and session updates.

mod server_client;

pub use server_client::{msg_types, ServerClient, ServerClientHandle};
