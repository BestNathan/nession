use async_trait::async_trait;
use serde_json::Value;

/// Agent-side extension: handles commands relayed from the server.
/// Registered at startup. The agent dispatcher routes messages
/// prefixed with "extension." to the matching extension.
#[async_trait]
pub trait AgentExtension: Send + Sync {
    /// Unique extension name (e.g. "claude_code").
    fn name(&self) -> &'static str;

    /// msg_type patterns this extension handles (e.g. ["extension.claude_code.list", ...]).
    fn message_types(&self) -> &'static [&'static str];

    /// Handle a command relayed from the server via CommandBroker.
    /// `command` is the action suffix (e.g. "claude_code.list").
    /// Returns a JSON value for the response payload.
    async fn handle_command(&self, command: &str, payload: Value) -> anyhow::Result<Value>;
}
