//! `nession_agent_create_session` — Agent-owned Session creation.
//!
//! The named Agent owns the new Session. Routing through a Server or a
//! standalone host changes how the request reaches that Agent, never who
//! creates the Session or which node owns it.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::error::ToolError;
use crate::tool::{non_empty, parse_arguments, schema_for, ToolContext, ToolHandler};

/// The Tool definition.
pub struct NessionAgentCreateSession;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Arguments {
    /// The Agent node that will own the Session.
    agent_id: String,
    /// The Session (tmux session) name.
    name: String,
    /// Optional initial working directory on that Agent.
    #[serde(default)]
    working_dir: Option<String>,
}

#[async_trait]
impl ToolHandler for NessionAgentCreateSession {
    fn name(&self) -> &'static str {
        "nession_agent_create_session"
    }

    fn description(&self) -> &'static str {
        "Create a tmux Session on one explicitly named Agent node. `agent_id` is required; the \
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
            .create_session(
                &arguments.agent_id,
                &arguments.name,
                arguments.working_dir.as_deref(),
            )
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::{arguments, context, Recorded, Recording};
    use std::sync::Arc;

    #[tokio::test]
    async fn it_creates_on_the_named_agent_with_the_working_directory() {
        let recorder = Arc::new(Recording::default());
        let reply = NessionAgentCreateSession
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "agent_id": "agent-1",
                    "name": "work",
                    "working_dir": "/srv/project"
                })),
            )
            .await
            .expect("reply");
        assert_eq!(reply["name"], "work");
        assert_eq!(
            recorder.calls(),
            vec![Recorded::CreateSession(
                "agent-1".to_string(),
                "work".to_string(),
                Some("/srv/project".to_string())
            )]
        );
    }

    #[test]
    fn its_schema_matches_the_typed_contract() {
        let schema = NessionAgentCreateSession.input_schema();
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"], serde_json::json!(["agent_id", "name"]));
        assert_eq!(schema["properties"]["agent_id"]["type"], "string");
        assert_eq!(schema["properties"]["name"]["type"], "string");
        assert!(schema["properties"]["working_dir"].is_object());
    }

    #[tokio::test]
    async fn an_empty_name_is_refused() {
        let recorder = Arc::new(Recording::default());
        let error = NessionAgentCreateSession
            .call(
                &context(&recorder),
                arguments(serde_json::json!({ "agent_id": "a", "name": "" })),
            )
            .await
            .expect_err("empty name");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn an_invalid_working_directory_type_is_refused() {
        let recorder = Arc::new(Recording::default());
        let error = NessionAgentCreateSession
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "agent_id": "a",
                    "name": "n",
                    "working_dir": 7
                })),
            )
            .await
            .expect_err("invalid working_dir");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn an_unexpected_argument_is_refused() {
        let recorder = Arc::new(Recording::default());
        let error = NessionAgentCreateSession
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "agent_id": "a",
                    "name": "n",
                    "sandbox": true
                })),
            )
            .await
            .expect_err("unexpected argument");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
    }
}
