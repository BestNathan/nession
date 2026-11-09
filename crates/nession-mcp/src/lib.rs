//! Nession's shared MCP access layer (`#565`).
//!
//! MCP is an **application access layer**, not another Protocol Unit. It
//! exposes the same business capabilities the Web and CLI already use, through
//! the tool names that state their semantic owner:
//!
//! * `nession_server_*` answers from the Server's cluster registry and routes
//!   mutations through the Server's existing paths.
//! * `nession_agent_*` answers for one **explicitly named** Agent node and
//!   never falls back to the host MCP happens to run on.
//!
//! ## Three hosts, one definition
//!
//! [`ClusterBackend`] and [`NodeBackend`] are the only seams. The catalog,
//! input schemas, validation, result shape, error mapping and the Streamable
//! HTTP lifecycle are defined once here and are identical in every hosting
//! mode; only the backend binding differs:
//!
//! | Mode | Cluster backend | Node backend |
//! |---|---|---|
//! | Standalone | [`remote::RemoteClusterBackend`] | [`remote::RemoteNodeBackend`] |
//! | `nession-agent` | Server client (or an unavailable backend in standalone mode) | the Agent's local services |
//! | `nession-server` | the Server's own services | the Server's Agent routing |
//!
//! ## What stays out
//!
//! No real-time terminal attach or PTY I/O, no env/command management tools, no
//! MCP resources/prompts. `nession_server_get_session_attach_info` returns a
//! **non-secret projection** of the attach facts; a Server-minted P2P
//! credential never reaches a model.
//!
//! ## Transport
//!
//! [`http::sniff`] is how an embedding host keeps its existing `/ws` listener:
//! it reads one HTTP request head, lets the WebSocket handshake replay it, and
//! hands `/mcp` requests to [`McpService`]. The service speaks MCP Streamable
//! HTTP (`2025-03-26`) over plain JSON responses.

pub mod backend;
pub mod error;
pub mod http;
pub mod jsonrpc;
pub mod protocol;
pub mod service;
pub mod tools;

#[cfg(feature = "remote")]
pub mod remote;

#[cfg(feature = "remote")]
pub mod standalone;

pub use backend::{ClusterBackend, NodeBackend, UnavailableClusterBackend, UnavailableNodeBackend};
pub use error::{ToolError, ToolErrorKind};
pub use service::{McpService, ServiceConfig, ServiceConfigError};
