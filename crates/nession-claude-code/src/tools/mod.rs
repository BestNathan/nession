//! Typed MCP Tools contributed by the Claude Code Extension (`#3779`).
//!
//! One flat file per Tool, named exactly like the MCP Tool. The module owns its
//! contract and validation; execution is delegated to the Agent-supplied
//! [`crate::control::ClaudeControl`].

pub mod nession_claude_status;

use std::sync::Arc;

use nession_mcp::provider::{McpToolProvider, ToolProviderError};
use nession_mcp::ToolHandler;

use crate::control::ClaudeControl;

/// Every Claude control Tool, composed explicitly by the owning Agent.
pub struct ClaudeCodeToolProvider {
    local_agent_id: String,
    control: Arc<dyn ClaudeControl>,
}

impl ClaudeCodeToolProvider {
    /// Build the provider for one Agent's control backend.
    pub fn new(local_agent_id: impl Into<String>, control: Arc<dyn ClaudeControl>) -> Self {
        Self {
            local_agent_id: local_agent_id.into(),
            control,
        }
    }
}

impl McpToolProvider for ClaudeCodeToolProvider {
    fn provider_name(&self) -> &str {
        "claude-code"
    }

    fn tools(&self) -> Result<Vec<Arc<dyn ToolHandler>>, ToolProviderError> {
        Ok(vec![Arc::new(
            nession_claude_status::NessionClaudeStatus::new(
                self.local_agent_id.clone(),
                Arc::clone(&self.control),
            ),
        )])
    }
}
