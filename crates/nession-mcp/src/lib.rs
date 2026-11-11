//! Nession's shared MCP access layer (`#3264`).
//!
//! MCP exposes **business capabilities to AI**, not a 1:1 projection of
//! Protocol endpoints. Each Tool's semantic owner is the owner of the
//! authoritative state or action, independent of where the endpoint runs:
//!
//! * `nession_server_list_agents` answers from the Server's Agent registry.
//! * `nession_agent_*` tools act on one **explicitly named** Agent node and
//!   never fall back to the host MCP happens to run on.
//!
//! ## Flat Tools, one owner each
//!
//! Every Tool is one file under [`tools`], named exactly like the MCP Tool.
//! [`tools::registry`] registers them explicitly with a single
//! [`registry::ToolRegistry`]; there is no central `match name` dispatch.
//! [`tool::ToolHandler`] owns the name, description, typed arguments, schema
//! and execution; the [service](service) owns lifecycle, transport,
//! authentication, concurrency and deadlines.
//!
//! ## Three hosts, one contract
//!
//! [`ClusterBackend`] and [`NodeBackend`] are the only seams. The catalog,
//! schemas, validation, result shape, error mapping and protocol behavior are
//! defined once here and are identical in every hosting mode:
//!
//! | Mode | Cluster backend | Node backend |
//! |---|---|---|
//! | Standalone | [`remote::RemoteClusterBackend`] | Server-routed (or an explicit direct Agent) |
//! | `nession-agent` | Server client (or unavailable) | the Agent's local services |
//! | `nession-server` | the Server's registry | the Server's canonical Agent routing |
//!
//! ## Protocol
//!
//! The service is dual-era: `2026-07-28` requests are stateless and carry
//! their version, client identity and capabilities per request, while
//! `2025-03-26` clients keep the `initialize`/`Mcp-Session-Id` lifecycle. The
//! wire grammar and header validation come from the official `rmcp` SDK.
//!
//! [`http::sniff`] is how an embedding host keeps its existing `/ws` listener:
//! it reads one HTTP request head, lets the WebSocket handshake replay it, and
//! hands `/mcp` connections to [`McpService::serve`].

pub mod backend;
pub mod error;
pub mod http;
pub mod protocol;
pub mod registry;
pub mod service;
pub mod tool;
pub mod tools;

#[cfg(feature = "remote")]
pub mod remote;

#[cfg(feature = "remote")]
pub mod standalone;

pub use backend::{ClusterBackend, NodeBackend, UnavailableClusterBackend, UnavailableNodeBackend};
pub use error::{ToolError, ToolErrorKind};
pub use registry::{RegistryError, ToolRegistry};
pub use service::{McpService, ServiceConfig, ServiceConfigError};
pub use tool::{ToolContext, ToolHandler};
