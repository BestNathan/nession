//! `nession_claude_enter` — enter a new or explicitly selected Claude
//! conversation (`#3779` P1b).
//!
//! The Tool owns the typed contract and the mode/identity checks. The Agent
//! sends the input into the named Session, proves the resulting conversation
//! and reports `entered`, `pending` or `refused` truthfully. A busy, waiting or
//! unknown Claude is never redirected into a second transcript writer.

use std::sync::Arc;

use async_trait::async_trait;
use nession_mcp::tool::{parse_arguments, reply_value, schema_for};
use nession_mcp::{ToolContext, ToolError, ToolHandler};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::control::{
    ClaudeActivityState, ClaudeControl, ClaudeObservation, ClaudeProcessState, EnterMode,
    EnterOutcome, EnterRequest, EnterStatus,
};

/// The exact MCP Tool name.
pub const NAME: &str = "nession_claude_enter";

/// The Tool's typed arguments.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ClaudeEnterInput {
    /// The Agent that owns the Session and executes the enter.
    agent_id: String,
    /// The Nession Session, named `agent_id:session_name`.
    session_id: String,
    /// `new` starts a fresh conversation; `resume` selects an existing one.
    mode: EnterMode,
    /// The selected conversation id; required for `resume`, omitted for `new`.
    #[serde(default)]
    conversation_id: Option<String>,
}

/// The Tool's typed success reply.
#[derive(Debug, serde::Serialize, JsonSchema)]
pub struct ClaudeEnterOutput {
    /// The Agent that executed the enter.
    agent_id: String,
    /// The Session that was entered.
    session_id: String,
    /// The actual conversation id, when verified.
    conversation_id: Option<String>,
    /// Entered / pending / refused.
    status: EnterStatus,
    /// Process state after the attempt.
    process: ClaudeProcessState,
    /// Activity after the attempt.
    activity: ClaudeActivityState,
    /// How the resulting state was observed.
    observation: ClaudeObservation,
    /// A bounded reason for a non-entered answer.
    detail: Option<String>,
    /// RFC 3339 timestamp of the observation.
    observed_at: String,
}

/// The `nession_claude_enter` handler.
pub struct NessionClaudeEnter {
    local_agent_id: String,
    control: Arc<dyn ClaudeControl>,
}

impl NessionClaudeEnter {
    /// Bind the handler to one Agent's control backend.
    pub fn new(local_agent_id: impl Into<String>, control: Arc<dyn ClaudeControl>) -> Self {
        Self {
            local_agent_id: local_agent_id.into(),
            control,
        }
    }
}

#[async_trait]
impl ToolHandler for NessionClaudeEnter {
    fn name(&self) -> &str {
        NAME
    }

    fn description(&self) -> &str {
        "Enter a new or explicitly selected Claude conversation in one named Nession \
         Session. Returns the actual verified conversation id, or a truthful pending/refused \
         state; never redirects a busy or unknown Claude into a second writer."
    }

    fn input_schema(&self) -> Map<String, Value> {
        schema_for::<ClaudeEnterInput>()
    }

    fn output_schema(&self) -> Map<String, Value> {
        schema_for::<ClaudeEnterOutput>()
    }

    async fn call(
        &self,
        _context: &ToolContext,
        arguments: Map<String, Value>,
    ) -> Result<Value, ToolError> {
        let input = parse_arguments::<ClaudeEnterInput>(arguments)?;
        let target =
            super::validate_target(&self.local_agent_id, &input.agent_id, &input.session_id)?;
        let conversation_id = match input.mode {
            EnterMode::New => {
                if input.conversation_id.is_some() {
                    return Err(ToolError::invalid_argument(
                        "`conversation_id` must be omitted for `mode: new`; the Agent chooses \
                         the new conversation id before launch",
                    ));
                }
                None
            }
            EnterMode::Resume => {
                let conversation_id = input.conversation_id.unwrap_or_default();
                if conversation_id.trim().is_empty() {
                    return Err(ToolError::invalid_argument(
                        "`conversation_id` is required for `mode: resume`",
                    ));
                }
                Some(conversation_id)
            }
        };
        let outcome = self
            .control
            .enter(EnterRequest {
                target: target.clone(),
                mode: input.mode,
                conversation_id,
            })
            .await;
        reply_value(&output(target.agent_id, target.session_id, outcome))
    }
}

fn output(agent_id: String, session_id: String, outcome: EnterOutcome) -> ClaudeEnterOutput {
    ClaudeEnterOutput {
        agent_id,
        session_id,
        conversation_id: outcome.conversation_id,
        status: outcome.status,
        process: outcome.process,
        activity: outcome.activity,
        observation: outcome.observation,
        detail: outcome.detail,
        observed_at: outcome.observed_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::{
        ClaudeStatusObservation, EnterRequest, SubmitOutcome, SubmitRequest, SubmitStatus,
    };
    use nession_mcp::backend::{
        ClusterBackend, NodeBackend, UnavailableClusterBackend, UnavailableNodeBackend,
    };

    struct FixtureControl;

    #[async_trait]
    impl ClaudeControl for FixtureControl {
        async fn status(
            &self,
            _target: &crate::control::ClaudeSessionTarget,
        ) -> ClaudeStatusObservation {
            ClaudeStatusObservation::not_running("2026-11-18T00:00:00Z")
        }

        async fn enter(&self, request: EnterRequest) -> EnterOutcome {
            let conversation_id = request
                .conversation_id
                .unwrap_or_else(|| "11111111-1111-4111-8111-111111111111".to_string());
            EnterOutcome {
                conversation_id: Some(conversation_id),
                status: EnterStatus::Entered,
                process: ClaudeProcessState::Running,
                activity: ClaudeActivityState::Idle,
                observation: ClaudeObservation::Verified,
                detail: None,
                observed_at: "2026-11-18T00:00:00Z".to_string(),
            }
        }

        async fn submit(&self, _request: SubmitRequest) -> SubmitOutcome {
            SubmitOutcome {
                conversation_id: None,
                status: SubmitStatus::Refused,
                observation: ClaudeObservation::Unknown,
                detail: Some("not used".to_string()),
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

    fn tool() -> NessionClaudeEnter {
        NessionClaudeEnter::new("agent-a", Arc::new(FixtureControl))
    }

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().expect("object").clone()
    }

    #[tokio::test]
    async fn resume_returns_the_selected_conversation() {
        let reply = tool()
            .call(
                &context(),
                args(serde_json::json!({
                    "agent_id": "agent-a",
                    "session_id": "agent-a:dev",
                    "mode": "resume",
                    "conversation_id": "550e8400-e29b-41d4-a716-446655440000"
                })),
            )
            .await
            .expect("enter");
        assert_eq!(
            reply["conversation_id"],
            "550e8400-e29b-41d4-a716-446655440000"
        );
        assert_eq!(reply["status"], "entered");
    }

    #[tokio::test]
    async fn new_lets_the_agent_choose_the_identity() {
        let reply = tool()
            .call(
                &context(),
                args(serde_json::json!({
                    "agent_id": "agent-a",
                    "session_id": "agent-a:dev",
                    "mode": "new"
                })),
            )
            .await
            .expect("enter");
        assert_eq!(reply["conversation_id"].as_str().unwrap().len(), 36);
    }

    #[tokio::test]
    async fn new_refuses_a_caller_supplied_identity() {
        let error = tool()
            .call(
                &context(),
                args(serde_json::json!({
                    "agent_id": "agent-a",
                    "session_id": "agent-a:dev",
                    "mode": "new",
                    "conversation_id": "550e8400-e29b-41d4-a716-446655440000"
                })),
            )
            .await
            .expect_err("caller-chosen new id");
        assert_eq!(error.kind, nession_mcp::ToolErrorKind::InvalidArgument);
    }

    #[tokio::test]
    async fn resume_requires_an_explicit_conversation() {
        for value in [
            serde_json::json!({"agent_id":"agent-a","session_id":"agent-a:dev","mode":"resume"}),
            serde_json::json!({"agent_id":"agent-a","session_id":"agent-a:dev","mode":"resume","conversation_id":"  "}),
        ] {
            let error = tool()
                .call(&context(), args(value))
                .await
                .expect_err("resume id");
            assert_eq!(error.kind, nession_mcp::ToolErrorKind::InvalidArgument);
        }
    }

    #[tokio::test]
    async fn a_foreign_target_is_refused() {
        let error = tool()
            .call(
                &context(),
                args(serde_json::json!({
                    "agent_id": "agent-b",
                    "session_id": "agent-b:dev",
                    "mode": "new"
                })),
            )
            .await
            .expect_err("foreign target");
        assert_eq!(error.kind, nession_mcp::ToolErrorKind::InvalidArgument);
    }

    #[test]
    fn the_contract_requires_the_target_and_mode() {
        let schema = tool().input_schema();
        assert_eq!(schema["additionalProperties"], false);
        let required = schema["required"].as_array().expect("required");
        for field in ["agent_id", "session_id", "mode"] {
            assert!(required.iter().any(|name| name == field), "{field}");
        }
        for field in [
            "conversation_id",
            "status",
            "process",
            "activity",
            "observation",
        ] {
            assert!(
                tool().output_schema()["properties"].get(field).is_some(),
                "{field}"
            );
        }
    }
}
