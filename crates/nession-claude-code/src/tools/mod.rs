//! Typed MCP Tools contributed by the Claude Code Extension (`#3779`).
//!
//! One flat file per Tool, named exactly like the MCP Tool. The module owns its
//! contract and validation; execution is delegated to the Agent-supplied
//! [`crate::control::ClaudeControl`] for live control, and to the Agent's
//! existing Conversation/Transcript Protocol Units through
//! [`crate::conversation_reader::ClaudeConversationReader`] for reads.

pub mod nession_claude_enter;
pub mod nession_claude_get_conversation;
pub mod nession_claude_get_transcript;
pub mod nession_claude_list_conversations;
pub mod nession_claude_status;
pub mod nession_claude_submit;

use std::sync::Arc;

use nession_mcp::provider::{McpToolProvider, ToolProviderError};
use nession_mcp::tool::non_empty;
use nession_mcp::{ToolError, ToolHandler};

use crate::control::{ClaudeControl, ClaudeSessionTarget};
use crate::conversation_reader::ClaudeConversationReader;

/// Validate the Agent/Session target every Claude Tool names.
///
/// One owner for the rule: the local Agent must be the named one, and the
/// Session id must be this Agent's `agent_id:session_name` spelling. A foreign
/// target is refused before any tmux or CLI observation.
pub(crate) fn validate_target(
    local_agent_id: &str,
    agent_id: &str,
    session_id: &str,
) -> Result<ClaudeSessionTarget, ToolError> {
    non_empty(agent_id, "agent_id")?;
    non_empty(session_id, "session_id")?;
    if agent_id != local_agent_id {
        return Err(ToolError::invalid_argument(format!(
            "this Claude provider is Agent '{local_agent_id}', not '{agent_id}'"
        )));
    }
    let prefix = format!("{agent_id}:");
    if !session_id.starts_with(&prefix) || session_id.len() == prefix.len() {
        return Err(ToolError::invalid_argument(
            "`session_id` must name a Session on the named Agent as `agent_id:session_name`",
        ));
    }
    Ok(ClaudeSessionTarget {
        agent_id: agent_id.to_string(),
        session_id: session_id.to_string(),
    })
}

/// Every Claude control and read Tool, composed explicitly by the owning Agent.
pub struct ClaudeCodeToolProvider {
    local_agent_id: String,
    control: Arc<dyn ClaudeControl>,
    reader: Arc<dyn ClaudeConversationReader>,
}

impl ClaudeCodeToolProvider {
    /// Build the provider for one Agent's control backend and Unit readers.
    pub fn new(
        local_agent_id: impl Into<String>,
        control: Arc<dyn ClaudeControl>,
        reader: Arc<dyn ClaudeConversationReader>,
    ) -> Self {
        Self {
            local_agent_id: local_agent_id.into(),
            control,
            reader,
        }
    }
}

impl McpToolProvider for ClaudeCodeToolProvider {
    fn provider_name(&self) -> &str {
        "claude-code"
    }

    fn tools(&self) -> Result<Vec<Arc<dyn ToolHandler>>, ToolProviderError> {
        Ok(vec![
            Arc::new(nession_claude_status::NessionClaudeStatus::new(
                self.local_agent_id.clone(),
                Arc::clone(&self.control),
            )),
            Arc::new(nession_claude_enter::NessionClaudeEnter::new(
                self.local_agent_id.clone(),
                Arc::clone(&self.control),
            )),
            Arc::new(nession_claude_submit::NessionClaudeSubmit::new(
                self.local_agent_id.clone(),
                Arc::clone(&self.control),
            )),
            Arc::new(
                nession_claude_list_conversations::NessionClaudeListConversations::new(
                    self.local_agent_id.clone(),
                    Arc::clone(&self.reader),
                ),
            ),
            Arc::new(
                nession_claude_get_conversation::NessionClaudeGetConversation::new(
                    self.local_agent_id.clone(),
                    Arc::clone(&self.reader),
                ),
            ),
            Arc::new(
                nession_claude_get_transcript::NessionClaudeGetTranscript::new(
                    self.local_agent_id.clone(),
                    Arc::clone(&self.reader),
                ),
            ),
        ])
    }
}
