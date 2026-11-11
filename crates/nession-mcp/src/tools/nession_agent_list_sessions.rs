//! `nession_agent_list_sessions` — Agent-owned Session discovery.
//!
//! The answer is the real tmux Session state of the Agent named in
//! `agent_id`. It is never the Server registry's view, and an omitted or empty
//! target is refused rather than defaulting to the MCP host.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::error::ToolError;
use crate::tool::{non_empty, parse_arguments, schema_for, ToolContext, ToolHandler};

/// The Tool definition.
pub struct NessionAgentListSessions;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Arguments {
    /// The Agent node whose Sessions are listed.
    agent_id: String,
}

#[async_trait]
impl ToolHandler for NessionAgentListSessions {
    fn name(&self) -> &'static str {
        "nession_agent_list_sessions"
    }

    fn description(&self) -> &'static str {
        "List the real tmux Sessions on one explicitly named Agent node. This is Agent truth, \
         not the Server registry view. `agent_id` is required; the call never falls back to the \
         host running MCP."
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
        context.node.list_sessions(&arguments.agent_id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::{arguments, context, Recorded, Recording};
    use std::sync::Arc;

    #[tokio::test]
    async fn it_asks_the_named_agent() {
        let recorder = Arc::new(Recording::default());
        let reply = NessionAgentListSessions
            .call(
                &context(&recorder),
                arguments(serde_json::json!({ "agent_id": "agent-1" })),
            )
            .await
            .expect("reply");
        assert_eq!(reply["sessions"], serde_json::json!([]));
        assert_eq!(
            recorder.calls(),
            vec![Recorded::ListSessions("agent-1".to_string())]
        );
    }

    #[test]
    fn agent_id_is_required_and_statically_typed() {
        let schema = NessionAgentListSessions.input_schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"], serde_json::json!(["agent_id"]));
        assert_eq!(schema["properties"]["agent_id"]["type"], "string");
    }

    #[tokio::test]
    async fn a_missing_target_is_refused() {
        let recorder = Arc::new(Recording::default());
        let error = NessionAgentListSessions
            .call(&context(&recorder), arguments(serde_json::json!({})))
            .await
            .expect_err("missing agent_id");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn an_empty_target_is_refused_rather_than_interpreted_as_local() {
        let recorder = Arc::new(Recording::default());
        let error = NessionAgentListSessions
            .call(
                &context(&recorder),
                arguments(serde_json::json!({ "agent_id": "  " })),
            )
            .await
            .expect_err("empty agent_id");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn an_unexpected_argument_is_refused() {
        let recorder = Arc::new(Recording::default());
        let error = NessionAgentListSessions
            .call(
                &context(&recorder),
                arguments(serde_json::json!({ "agent_id": "a", "force": true })),
            )
            .await
            .expect_err("unexpected argument");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
    }
}
