//! `nession_agent_kill_session` — Agent-owned Session termination.
//!
//! Only the named Agent may terminate its own Session. A caller can reach the
//! Tool through any hosting mode, but the operation never falls back to a
//! local tmux server.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::error::ToolError;
use crate::tool::{non_empty, parse_arguments, schema_for, ToolContext, ToolHandler};

/// The Tool definition.
pub struct NessionAgentKillSession;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Arguments {
    /// The Agent node that owns the Session.
    agent_id: String,
    /// The Session (tmux session) name.
    name: String,
}

#[async_trait]
impl ToolHandler for NessionAgentKillSession {
    fn name(&self) -> &'static str {
        "nession_agent_kill_session"
    }

    fn description(&self) -> &'static str {
        "Kill a tmux Session on one explicitly named Agent node. `agent_id` is required; the \
         call never falls back to the host running MCP."
    }

    fn input_schema(&self) -> Map<String, Value> {
        schema_for::<Arguments>()
    }

    async fn call(
        &self,
        context: &ToolContext,
        arguments: Map<String, Value>,
    ) -> Result<Value, ToolError> {
        let arguments: Arguments = parse_arguments(arguments)?;
        non_empty(&arguments.agent_id, "agent_id")?;
        non_empty(&arguments.name, "name")?;
        context
            .node
            .kill_session(&arguments.agent_id, &arguments.name)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::{arguments, context, Recorded, Recording};
    use std::sync::Arc;

    #[tokio::test]
    async fn it_kills_on_the_named_agent() {
        let recorder = Arc::new(Recording::default());
        let reply = NessionAgentKillSession
            .call(
                &context(&recorder),
                arguments(serde_json::json!({ "agent_id": "agent-1", "name": "work" })),
            )
            .await
            .expect("reply");
        assert_eq!(reply["name"], "work");
        assert_eq!(
            recorder.calls(),
            vec![Recorded::KillSession(
                "agent-1".to_string(),
                "work".to_string()
            )]
        );
    }

    #[test]
    fn its_schema_requires_both_identity_fields() {
        let schema = NessionAgentKillSession.input_schema();
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"], serde_json::json!(["agent_id", "name"]));
    }

    #[tokio::test]
    async fn an_empty_agent_is_refused() {
        let recorder = Arc::new(Recording::default());
        let error = NessionAgentKillSession
            .call(
                &context(&recorder),
                arguments(serde_json::json!({ "agent_id": "", "name": "work" })),
            )
            .await
            .expect_err("empty agent");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn a_missing_name_is_refused() {
        let recorder = Arc::new(Recording::default());
        let error = NessionAgentKillSession
            .call(
                &context(&recorder),
                arguments(serde_json::json!({ "agent_id": "a" })),
            )
            .await
            .expect_err("missing name");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }
}
