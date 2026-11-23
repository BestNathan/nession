//! `nession_agent_kill_session` — Agent-owned Session termination.
//!
//! Only the named Agent may terminate its own Session. A caller can reach the
//! Tool through any hosting mode, but the operation never falls back to a
//! local tmux server.
//!
//! The kill is bound to the caller-observed incarnation (#4302): the required
//! `expected_instance_id` travels through every hosting adapter to the Agent's
//! authoritative Session mutation owner, which checks it against the name's
//! current durable tmux instance in the same keyed lane as the termination. A
//! stale caller whose Session was replaced by a same-name successor is refused
//! as a `conflict`; the successor keeps running with its resources.

use async_trait::async_trait;
use nession_protocol::contracts::session::v1::SessionKillResponse;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::error::ToolError;
use crate::tool::{non_empty, parse_arguments, reply_value, schema_for, ToolContext, ToolHandler};

/// The Tool definition.
pub struct NessionAgentKillSession;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Arguments {
    /// The Agent node that owns the Session.
    agent_id: String,
    /// The Session (tmux session) name.
    name: String,
    /// The durable instance the caller last observed (from create/list/get).
    expected_instance_id: String,
}

#[async_trait]
impl ToolHandler for NessionAgentKillSession {
    fn name(&self) -> &'static str {
        "nession_agent_kill_session"
    }

    fn description(&self) -> &'static str {
        "Kill a tmux Session on one explicitly named Agent node. `agent_id`, `name` and \
         `expected_instance_id` are required; the call never falls back to the host running \
         MCP. `expected_instance_id` is the durable instance reported by \
         `nession_agent_create_session`, `nession_agent_list_sessions` or \
         `nession_agent_get_session_metadata`. A recreated same-name Session is a `conflict` \
         and is left running; re-read the current instance before an intentional kill."
    }

    fn input_schema(&self) -> Map<String, Value> {
        schema_for::<Arguments>()
    }

    fn output_schema(&self) -> Map<String, Value> {
        schema_for::<SessionKillResponse>()
    }

    async fn call(
        &self,
        context: &ToolContext,
        arguments: Map<String, Value>,
    ) -> Result<Value, ToolError> {
        let arguments: Arguments = parse_arguments(arguments)?;
        non_empty(&arguments.agent_id, "agent_id")?;
        non_empty(&arguments.name, "name")?;
        non_empty(&arguments.expected_instance_id, "expected_instance_id")?;
        let reply = context
            .node
            .kill_session(
                &arguments.agent_id,
                &arguments.name,
                &arguments.expected_instance_id,
            )
            .await?;
        reply_value(&reply)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::{arguments, context, Recorded, Recording};
    use std::sync::Arc;

    #[tokio::test]
    async fn it_kills_on_the_named_agent_with_the_observed_instance() {
        let recorder = Arc::new(Recording::default());
        let reply = NessionAgentKillSession
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "agent_id": "agent-1",
                    "name": "work",
                    "expected_instance_id": "instance-a"
                })),
            )
            .await
            .expect("reply");
        assert_eq!(reply["name"], "work");
        assert_eq!(
            recorder.calls(),
            vec![Recorded::KillSession(
                "agent-1".to_string(),
                "work".to_string(),
                "instance-a".to_string()
            )]
        );
    }

    #[test]
    fn its_schema_requires_every_identity_field() {
        let schema = NessionAgentKillSession.input_schema();
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(
            schema["required"],
            serde_json::json!(["agent_id", "name", "expected_instance_id"])
        );
    }

    #[tokio::test]
    async fn an_empty_agent_is_refused() {
        let recorder = Arc::new(Recording::default());
        let error = NessionAgentKillSession
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "agent_id": "",
                    "name": "work",
                    "expected_instance_id": "instance-a"
                })),
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
                arguments(serde_json::json!({
                    "agent_id": "a",
                    "expected_instance_id": "instance-a"
                })),
            )
            .await
            .expect_err("missing name");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn a_missing_expected_instance_is_refused() {
        let recorder = Arc::new(Recording::default());
        let error = NessionAgentKillSession
            .call(
                &context(&recorder),
                arguments(serde_json::json!({ "agent_id": "a", "name": "work" })),
            )
            .await
            .expect_err("missing expected instance");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn an_empty_expected_instance_is_refused() {
        let recorder = Arc::new(Recording::default());
        let error = NessionAgentKillSession
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "agent_id": "a",
                    "name": "work",
                    "expected_instance_id": ""
                })),
            )
            .await
            .expect_err("empty expected instance");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }
}
