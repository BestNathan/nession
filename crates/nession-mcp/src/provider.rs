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
//!
//! ## Two kinds of provider
//!
//! An **owning** provider (an Agent Extension) executes the Tool and derives
//! the advertised descriptor from the handler, so name/description/schemas and
//! execution have one typed source. A **routing** provider (the Server or a
//! standalone host) does not execute the Tool; it advertises the owning Agent's
//! already validated descriptor and forwards each call to the explicitly named
//! Agent through [`crate::backend::NodeBackend::call_extension_tool`].

use std::sync::Arc;

use async_trait::async_trait;
use nession_protocol::contracts::mcp::v1::McpToolDescriptor;
use serde_json::{Map, Value};

use crate::error::ToolError;
use crate::tool::{ToolContext, ToolHandler};

/// One contributed Tool: its advertised contract and the handler that serves
/// it *on this host*.
///
/// For an owning provider the handler is the real Extension implementation. For
/// a routing provider the handler is a [`RoutedTool`], which forwards to the
/// named owning Agent. The catalog rejects a contribution whose handler
/// identity or schemas disagree with the descriptor, so the advertised contract
/// cannot drift from what `tools/call` dispatches.
#[derive(Clone)]
pub struct McpToolContribution {
    /// The contract other hosts must reproduce exactly.
    pub descriptor: McpToolDescriptor,
    /// The handler this host uses when the Tool is called here.
    pub handler: Arc<dyn ToolHandler>,
}

impl McpToolContribution {
    /// Derive the descriptor from the handler that actually executes the Tool.
    pub fn from_handler(handler: Arc<dyn ToolHandler>, provider: &str) -> Self {
        let descriptor = McpToolDescriptor {
            name: handler.name().to_string(),
            provider: provider.to_string(),
            description: handler.description().to_string(),
            input_schema: Value::Object(handler.input_schema()),
            output_schema: Value::Object(handler.output_schema()),
        };
        Self {
            descriptor,
            handler,
        }
    }

    /// Advertise an already-validated descriptor and route its calls.
    pub fn routed(descriptor: McpToolDescriptor) -> Self {
        let handler = Arc::new(RoutedTool::new(descriptor.clone()));
        Self {
            descriptor,
            handler,
        }
    }
}

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

    /// The typed contributions of this provider.
    ///
    /// The default derives each descriptor from the handler, which is the
    /// owning-provider shape. A routing provider overrides it to keep the
    /// owning Agent's descriptor verbatim.
    fn contributions(&self) -> Result<Vec<McpToolContribution>, ToolProviderError> {
        Ok(self
            .tools()?
            .into_iter()
            .map(|handler| McpToolContribution::from_handler(handler, self.provider_name()))
            .collect())
    }
}

/// A Tool advertised from another Agent's validated manifest.
///
/// It owns no business behavior: the call is forwarded to the Agent the
/// caller explicitly names. The Agent (not this host) validates the arguments
/// and returns the stable reply, so the same Tool means the same semantics in
/// every hosting mode.
pub struct RoutedTool {
    descriptor: McpToolDescriptor,
}

impl RoutedTool {
    /// A routing handler for one advertised descriptor.
    pub fn new(descriptor: McpToolDescriptor) -> Self {
        Self { descriptor }
    }
}

fn schema_object(schema: &Value) -> Map<String, Value> {
    schema.as_object().cloned().unwrap_or_default()
}

#[async_trait]
impl ToolHandler for RoutedTool {
    fn name(&self) -> &str {
        &self.descriptor.name
    }

    fn description(&self) -> &str {
        &self.descriptor.description
    }

    fn input_schema(&self) -> Map<String, Value> {
        schema_object(&self.descriptor.input_schema)
    }

    fn output_schema(&self) -> Map<String, Value> {
        schema_object(&self.descriptor.output_schema)
    }

    async fn call(
        &self,
        context: &ToolContext,
        arguments: Map<String, Value>,
    ) -> Result<Value, ToolError> {
        let agent_id = arguments
            .get("agent_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_default();
        if agent_id.trim().is_empty() {
            return Err(ToolError::invalid_argument(
                "`agent_id` must name the Agent that owns this Tool",
            ));
        }
        context
            .node
            .call_extension_tool(&agent_id, &self.descriptor.name, arguments)
            .await
    }
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
