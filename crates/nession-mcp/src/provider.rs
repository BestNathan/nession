//! Extension-contributed MCP Tools (`#3778`).
//!
//! A [`McpToolProvider`] is the explicit seam between an Extension and the
//! shared MCP endpoint. The Extension owns the Tool's semantics; its Agent
//! composes the provider and executes the Tool; this crate owns the MCP
//! protocol, the typed schema contract, authentication, deadlines and results.
//!
//! There is no side-effect registration: a contribution reaches the endpoint
//! only because a host constructed the provider and handed it to
//! [`crate::catalog::McpCatalog`]. Providers are not named to a concrete host
//! crate here — `nession-mcp` never depends on `nession-agent`,
//! `nession-server`, `nession-common` or an Extension implementation.
//!
//! Each contributed Tool still satisfies the one-Tool contract: a flat
//! `<tool_name>.rs` in its owning crate implementing
//! [`crate::tool::ToolHandler`] with its name, description, typed input schema,
//! typed output schema and execution.

use std::sync::Arc;

use crate::tool::ToolHandler;

/// One explicit source of Extension-contributed MCP Tools.
pub trait McpToolProvider: Send + Sync {
    /// Stable provider identity used in diagnostics and ownership conflicts.
    fn provider_name(&self) -> &str;

    /// The Tools this provider contributes to the host's catalog.
    ///
    /// Called only when a host explicitly builds or reconfigures the catalog —
    /// never by `tools/list` or `tools/call`. An error rejects the whole
    /// candidate generation; the host keeps its previous valid generation.
    fn tools(&self) -> Result<Vec<Arc<dyn ToolHandler>>, ToolProviderError>;
}

/// Why a provider could not enumerate its contributions.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct ToolProviderError {
    message: String,
}

impl ToolProviderError {
    /// A provider that cannot currently answer for its Tools.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}
