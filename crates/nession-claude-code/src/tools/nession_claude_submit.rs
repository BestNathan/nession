//! `nession_claude_submit` — send one prompt to the verified idle Claude
//! conversation (`#3779` P2, delivery truthfulness `#4665`).
//!
//! The answer carries the verified actual conversation id and a truthful
//! delivery phase, never an invented execution result. `input_sent` means the
//! prompt's **submission was confirmed by read-back** (the exact user message
//! in the addressed conversation), not merely that tmux accepted the keys.
//! Unconfirmed delivery answers `unknown` with read-back guidance. A stale
//! conversation id, a busy/waiting/unknown Claude, an unready or non-empty
//! composer, or a concurrent conflicting write is refused without sending.

use std::sync::Arc;

use async_trait::async_trait;
use nession_mcp::tool::{parse_arguments, reply_value, schema_for};
use nession_mcp::{ToolContext, ToolError, ToolHandler};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::control::{
    ClaudeControl, ClaudeObservation, SubmitOutcome, SubmitRequest, SubmitStatus,
};

/// The exact MCP Tool name.
pub const NAME: &str = "nession_claude_submit";

/// The Tool's typed arguments.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ClaudeSubmitInput {
    /// The Agent that owns the Session and executes the submit.
    agent_id: String,
    /// The Nession Session, named `agent_id:session_name`.
    session_id: String,
    /// The verified conversation the caller expects; a mismatch refuses.
    conversation_id: String,
    /// One prompt line. Newlines and carriage returns are refused.
    prompt: String,
}

/// The Tool's typed success reply.
#[derive(Debug, serde::Serialize, JsonSchema)]
pub struct ClaudeSubmitOutput {
    /// The Agent that executed the submit.
    agent_id: String,
    /// The Session that received the prompt.
    session_id: String,
    /// The verified actual conversation the input was addressed to.
    conversation_id: Option<String>,
    /// The delivery phase (`input_sent`, `refused`, `unknown`).
    status: SubmitStatus,
    /// How the target state was observed.
    observation: ClaudeObservation,
    /// A bounded reason for a non-sent answer.
    detail: Option<String>,
    /// RFC 3339 timestamp of the observation.
    observed_at: String,
}

/// The `nession_claude_submit` handler.
pub struct NessionClaudeSubmit {
    local_agent_id: String,
    control: Arc<dyn ClaudeControl>,
}

impl NessionClaudeSubmit {
    /// Bind the handler to one Agent's control backend.
    pub fn new(local_agent_id: impl Into<String>, control: Arc<dyn ClaudeControl>) -> Self {
        Self {
            local_agent_id: local_agent_id.into(),
            control,
        }
    }
}

#[async_trait]
impl ToolHandler for NessionClaudeSubmit {
    fn name(&self) -> &str {
        NAME
    }

    fn description(&self) -> &str {
        "Send one prompt line to the verified idle Claude conversation in one named Nession \
         Session. Returns the actual verified conversation id and a truthful delivery phase: \
         `input_sent` only after the prompt's submission is confirmed by read-back (the exact \
         user message in the addressed conversation); `unknown` with read-back guidance when \
         delivery could not be confirmed; never a fabricated execution result. A stale \
         conversation id, a busy/waiting/unknown Claude, an unready or non-empty composer, or \
         a concurrent writer is refused without sending."
    }

    fn input_schema(&self) -> Map<String, Value> {
        schema_for::<ClaudeSubmitInput>()
    }

    fn output_schema(&self) -> Map<String, Value> {
        schema_for::<ClaudeSubmitOutput>()
    }

    async fn call(
        &self,
        _context: &ToolContext,
        arguments: Map<String, Value>,
    ) -> Result<Value, ToolError> {
        let input = parse_arguments::<ClaudeSubmitInput>(arguments)?;
        let target =
            super::validate_target(&self.local_agent_id, &input.agent_id, &input.session_id)?;
        if input.conversation_id.trim().is_empty() {
            return Err(ToolError::invalid_argument(
                "`conversation_id` must be the verified conversation the caller expects",
            ));
        }
        if input.prompt.trim().is_empty() {
            return Err(ToolError::invalid_argument("`prompt` must not be empty"));
        }
        if input.prompt.contains(['\n', '\r']) {
            return Err(ToolError::invalid_argument(
                "`prompt` must be one line; newlines are refused so one call cannot submit \
                 multiple prompts",
            ));
        }
        let outcome = self
            .control
            .submit(SubmitRequest {
                target: target.clone(),
                conversation_id: input.conversation_id,
                prompt: input.prompt,
            })
            .await;
        reply_value(&output(target.agent_id, target.session_id, outcome))
    }
}

fn output(agent_id: String, session_id: String, outcome: SubmitOutcome) -> ClaudeSubmitOutput {
    ClaudeSubmitOutput {
        agent_id,
        session_id,
        conversation_id: outcome.conversation_id,
        status: outcome.status,
        observation: outcome.observation,
        detail: outcome.detail,
        observed_at: outcome.observed_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::{
        ClaudeSessionTarget, ClaudeStatusObservation, EnterOutcome, EnterRequest, EnterStatus,
    };
    use nession_mcp::backend::{
        ClusterBackend, NodeBackend, UnavailableClusterBackend, UnavailableNodeBackend,
    };

    struct FixtureControl;

    #[async_trait]
    impl ClaudeControl for FixtureControl {
        async fn status(&self, _target: &ClaudeSessionTarget) -> ClaudeStatusObservation {
            ClaudeStatusObservation::not_running("2026-11-18T00:00:00Z")
        }

        async fn enter(&self, _request: EnterRequest) -> EnterOutcome {
            EnterOutcome {
                conversation_id: None,
                status: EnterStatus::Refused,
                process: crate::control::ClaudeProcessState::Unknown,
                activity: crate::control::ClaudeActivityState::Unknown,
                observation: ClaudeObservation::Unknown,
                detail: Some("not used".to_string()),
                observed_at: "2026-11-18T00:00:00Z".to_string(),
            }
        }

        async fn submit(&self, request: SubmitRequest) -> SubmitOutcome {
            SubmitOutcome {
                conversation_id: Some(request.conversation_id),
                status: SubmitStatus::InputSent,
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

    fn tool() -> NessionClaudeSubmit {
        NessionClaudeSubmit::new("agent-a", Arc::new(FixtureControl))
    }

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().expect("object").clone()
    }

    #[tokio::test]
    async fn a_verified_submit_reports_input_sent_with_the_actual_id() {
        let reply = tool()
            .call(
                &context(),
                args(serde_json::json!({
                    "agent_id": "agent-a",
                    "session_id": "agent-a:dev",
                    "conversation_id": "550e8400-e29b-41d4-a716-446655440000",
                    "prompt": "Review changes"
                })),
            )
            .await
            .expect("submit");
        assert_eq!(reply["status"], "input_sent");
        assert_eq!(
            reply["conversation_id"],
            "550e8400-e29b-41d4-a716-446655440000"
        );
    }

    struct UnconfirmedControl;

    #[async_trait]
    impl ClaudeControl for UnconfirmedControl {
        async fn status(&self, _target: &ClaudeSessionTarget) -> ClaudeStatusObservation {
            ClaudeStatusObservation::not_running("2026-11-18T00:00:00Z")
        }

        async fn enter(&self, _request: EnterRequest) -> EnterOutcome {
            unreachable!("submit does not enter")
        }

        async fn submit(&self, request: SubmitRequest) -> SubmitOutcome {
            SubmitOutcome {
                conversation_id: Some(request.conversation_id),
                status: SubmitStatus::Unknown,
                observation: ClaudeObservation::Verified,
                detail: Some(
                    "the input was sent but its submission was not confirmed; read the \
                     conversation back before retrying"
                        .to_string(),
                ),
                observed_at: "2026-11-18T00:00:00Z".to_string(),
            }
        }
    }

    #[tokio::test]
    async fn an_unconfirmed_delivery_is_passed_through_as_unknown_with_guidance() {
        // #4665: the Tool must not dress an unconfirmed delivery as
        // `input_sent`. The backend's truthful `unknown` and its read-back
        // guidance reach the caller unchanged.
        let tool = NessionClaudeSubmit::new("agent-a", Arc::new(UnconfirmedControl));
        let reply = tool
            .call(
                &context(),
                args(serde_json::json!({
                    "agent_id": "agent-a",
                    "session_id": "agent-a:dev",
                    "conversation_id": "550e8400-e29b-41d4-a716-446655440000",
                    "prompt": "Review changes"
                })),
            )
            .await
            .expect("submit");
        assert_eq!(reply["status"], "unknown");
        assert_eq!(
            reply["conversation_id"],
            "550e8400-e29b-41d4-a716-446655440000"
        );
        assert!(
            reply["detail"]
                .as_str()
                .expect("detail")
                .contains("read the conversation back"),
            "the read-back guidance must survive: {reply}"
        );
    }

    #[tokio::test]
    async fn empty_or_multi_line_prompts_are_refused() {
        for prompt in ["", "   ", "one\ntwo", "one\r\ntwo"] {
            let error = tool()
                .call(
                    &context(),
                    args(serde_json::json!({
                        "agent_id": "agent-a",
                        "session_id": "agent-a:dev",
                        "conversation_id": "550e8400-e29b-41d4-a716-446655440000",
                        "prompt": prompt
                    })),
                )
                .await
                .expect_err(prompt);
            assert_eq!(error.kind, nession_mcp::ToolErrorKind::InvalidArgument);
        }
    }

    #[tokio::test]
    async fn the_conversation_guard_is_required() {
        let error = tool()
            .call(
                &context(),
                args(serde_json::json!({
                    "agent_id": "agent-a",
                    "session_id": "agent-a:dev",
                    "conversation_id": " ",
                    "prompt": "Review changes"
                })),
            )
            .await
            .expect_err("conversation");
        assert_eq!(error.kind, nession_mcp::ToolErrorKind::InvalidArgument);
    }

    #[tokio::test]
    async fn a_foreign_target_is_refused_before_any_input() {
        let error = tool()
            .call(
                &context(),
                args(serde_json::json!({
                    "agent_id": "agent-b",
                    "session_id": "agent-b:dev",
                    "conversation_id": "550e8400-e29b-41d4-a716-446655440000",
                    "prompt": "Review changes"
                })),
            )
            .await
            .expect_err("foreign target");
        assert_eq!(error.kind, nession_mcp::ToolErrorKind::InvalidArgument);
    }

    #[test]
    fn the_contract_requires_every_routing_and_content_field() {
        let schema = tool().input_schema();
        assert_eq!(schema["additionalProperties"], false);
        let required = schema["required"].as_array().expect("required");
        for field in ["agent_id", "session_id", "conversation_id", "prompt"] {
            assert!(required.iter().any(|name| name == field), "{field}");
        }
        for field in ["conversation_id", "status", "observation", "detail"] {
            assert!(
                tool().output_schema()["properties"].get(field).is_some(),
                "{field}"
            );
        }
    }
}
