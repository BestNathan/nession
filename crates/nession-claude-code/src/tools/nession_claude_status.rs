//! `nession_claude_status` — observe one Session's Claude state on demand
//! (`#3779`).
//!
//! The Tool owns the exact typed contract and argument validation. The
//! observation itself is the owning Agent's: it proves the named target, runs
//! the verified CLI probe in the Session environment and binds the reported
//! PID to the Session through its process discovery. Nothing here guesses a
//! conversation from cwd or transcript recency.

use std::sync::Arc;

use async_trait::async_trait;
use nession_mcp::tool::{non_empty, parse_arguments, reply_value, schema_for};
use nession_mcp::{ToolContext, ToolError, ToolHandler};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::control::{
    ClaudeActivityState, ClaudeControl, ClaudeObservation, ClaudeProcessState, ClaudeSessionTarget,
    ClaudeStatusObservation,
};

/// The exact MCP Tool name.
pub const NAME: &str = "nession_claude_status";

/// The Tool's typed arguments.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ClaudeStatusInput {
    /// The Agent that owns the Session and executes the observation.
    agent_id: String,
    /// The Nession Session to observe, named `agent_id:session_name`.
    session_id: String,
}

/// The Tool's typed success reply.
#[derive(Debug, Serialize, JsonSchema)]
pub struct ClaudeStatusOutput {
    /// The Agent that executed the observation.
    agent_id: String,
    /// The Session that was observed.
    session_id: String,
    /// Running, not running, or unknown.
    process: ClaudeProcessState,
    /// Busy, waiting, idle, or unknown.
    activity: ClaudeActivityState,
    /// What Claude reported it is waiting for, when it did.
    waiting_for: Option<String>,
    /// The verified conversation id, when one is bound to this Session.
    conversation_id: Option<String>,
    /// How the status was obtained.
    observation: ClaudeObservation,
    /// A bounded reason for a non-verified observation.
    detail: Option<String>,
    /// RFC 3339 timestamp of the observation.
    observed_at: String,
}

/// The `nession_claude_status` handler.
pub struct NessionClaudeStatus {
    local_agent_id: String,
    control: Arc<dyn ClaudeControl>,
}

impl NessionClaudeStatus {
    /// Bind the handler to one Agent's control backend.
    pub fn new(local_agent_id: impl Into<String>, control: Arc<dyn ClaudeControl>) -> Self {
        Self {
            local_agent_id: local_agent_id.into(),
            control,
        }
    }
}

#[async_trait]
impl ToolHandler for NessionClaudeStatus {
    fn name(&self) -> &str {
        NAME
    }

    fn description(&self) -> &str {
        "Observe one Nession Session's live Claude state on demand: process, \
         busy/waiting/idle activity, waiting reason and the verified conversation id. \
         Unknown or unobservable state is reported as such, never guessed."
    }

    fn input_schema(&self) -> Map<String, Value> {
        schema_for::<ClaudeStatusInput>()
    }

    fn output_schema(&self) -> Map<String, Value> {
        schema_for::<ClaudeStatusOutput>()
    }

    async fn call(
        &self,
        _context: &ToolContext,
        arguments: Map<String, Value>,
    ) -> Result<Value, ToolError> {
        let input = parse_arguments::<ClaudeStatusInput>(arguments)?;
        non_empty(&input.agent_id, "agent_id")?;
        non_empty(&input.session_id, "session_id")?;
        if input.agent_id != self.local_agent_id {
            return Err(ToolError::invalid_argument(format!(
                "this Claude provider is Agent '{}', not '{}'",
                self.local_agent_id, input.agent_id
            )));
        }
        let prefix = format!("{}:", input.agent_id);
        if !input.session_id.starts_with(&prefix) || input.session_id.len() == prefix.len() {
            return Err(ToolError::invalid_argument(
                "`session_id` must name a Session on the named Agent as `agent_id:session_name`",
            ));
        }
        let target = ClaudeSessionTarget {
            agent_id: input.agent_id,
            session_id: input.session_id,
        };
        let status = self.control.status(&target).await;
        reply_value(&output(target.agent_id, target.session_id, status))
    }
}

fn output(
    agent_id: String,
    session_id: String,
    status: ClaudeStatusObservation,
) -> ClaudeStatusOutput {
    ClaudeStatusOutput {
        agent_id,
        session_id,
        process: status.process,
        activity: status.activity,
        waiting_for: status.waiting_for,
        conversation_id: status.conversation_id,
        observation: status.observation,
        detail: status.detail,
        observed_at: status.observed_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::ClaudeObservation;
    use nession_mcp::backend::{
        ClusterBackend, NodeBackend, UnavailableClusterBackend, UnavailableNodeBackend,
    };

    struct FixtureControl;

    #[async_trait]
    impl ClaudeControl for FixtureControl {
        async fn status(&self, _target: &ClaudeSessionTarget) -> ClaudeStatusObservation {
            ClaudeStatusObservation {
                process: ClaudeProcessState::Running,
                activity: ClaudeActivityState::Waiting,
                waiting_for: Some("input needed".to_string()),
                conversation_id: Some("a460cce1-35c0-4b8f-9d5f-5ae899e72229".to_string()),
                observation: ClaudeObservation::Verified,
                detail: None,
                observed_at: "2026-11-18T00:00:00Z".to_string(),
            }
        }
    }

    fn context() -> ToolContext {
        let cluster: Arc<dyn ClusterBackend> =
            Arc::new(UnavailableClusterBackend::new("no server"));
        let node: Arc<dyn NodeBackend> = Arc::new(UnavailableNodeBackend::new("no agent"));
        ToolContext::new(cluster, node)
    }

    fn tool() -> NessionClaudeStatus {
        NessionClaudeStatus::new("agent-a", Arc::new(FixtureControl))
    }

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().expect("object").clone()
    }

    #[tokio::test]
    async fn it_returns_the_typed_verified_status() {
        let reply = tool()
            .call(
                &context(),
                args(serde_json::json!({
                    "agent_id": "agent-a",
                    "session_id": "agent-a:dev"
                })),
            )
            .await
            .expect("status");
        assert_eq!(reply["process"], "running");
        assert_eq!(reply["activity"], "waiting");
        assert_eq!(reply["waiting_for"], "input needed");
        assert_eq!(
            reply["conversation_id"],
            "a460cce1-35c0-4b8f-9d5f-5ae899e72229"
        );
        assert_eq!(reply["observation"], "verified");
    }

    #[tokio::test]
    async fn a_foreign_agent_is_refused_not_observed_locally() {
        let error = tool()
            .call(
                &context(),
                args(serde_json::json!({
                    "agent_id": "agent-b",
                    "session_id": "agent-b:dev"
                })),
            )
            .await
            .expect_err("foreign agent");
        assert_eq!(error.kind, nession_mcp::ToolErrorKind::InvalidArgument);
    }

    #[tokio::test]
    async fn a_session_on_another_agent_is_refused() {
        for session_id in ["agent-a", "agent-a:", "agent-b:dev"] {
            let error = tool()
                .call(
                    &context(),
                    args(serde_json::json!({
                        "agent_id": "agent-a",
                        "session_id": session_id
                    })),
                )
                .await
                .expect_err(session_id);
            assert_eq!(error.kind, nession_mcp::ToolErrorKind::InvalidArgument);
        }
    }

    #[test]
    fn both_identity_fields_are_required_and_unexpected_keys_are_refused() {
        let schema = tool().input_schema();
        assert_eq!(schema["additionalProperties"], false);
        let required = schema["required"].as_array().expect("required");
        assert!(required.iter().any(|field| field == "agent_id"));
        assert!(required.iter().any(|field| field == "session_id"));
        let error = parse_arguments::<ClaudeStatusInput>(args(serde_json::json!({
            "agent_id": "agent-a",
            "session_id": "agent-a:dev",
            "extra": true
        })))
        .expect_err("unexpected key");
        assert_eq!(error.kind, nession_mcp::ToolErrorKind::InvalidArgument);
    }

    #[test]
    fn the_output_contract_names_every_state_and_identity_field() {
        let schema = tool().output_schema();
        for field in [
            "process",
            "activity",
            "waiting_for",
            "conversation_id",
            "observation",
            "detail",
            "observed_at",
        ] {
            assert!(
                schema["properties"].get(field).is_some(),
                "missing output field {field}"
            );
        }
    }
}
