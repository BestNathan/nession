use async_trait::async_trait;
use nession_common::extension::AgentExtension;
use serde_json::Value;

pub struct ClaudeCodeAgentExtension;

impl Default for ClaudeCodeAgentExtension {
    fn default() -> Self {
        Self
    }
}

impl ClaudeCodeAgentExtension {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl AgentExtension for ClaudeCodeAgentExtension {
    fn name(&self) -> &'static str {
        "claude_code"
    }

    fn message_types(&self) -> &'static [&'static str] {
        &["extension.claude_code.list", "extension.claude_code.read"]
    }

    async fn handle_command(&self, command: &str, _payload: Value) -> anyhow::Result<Value> {
        match command {
            "claude_code.list" => Ok(serde_json::json!({ "available": false, "categories": [] })),
            "claude_code.read" => Ok(serde_json::json!({ "error": "not_implemented" })),
            _ => anyhow::bail!("unknown command: {command}"),
        }
    }
}
