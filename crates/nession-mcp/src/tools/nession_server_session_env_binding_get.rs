//! `nession_server_session_env_binding_get` — the Server's Session
//! Environment Binding owner.
//!
//! The reply carries the desired revision and ordered profiles (with outdated
//! flags), the Agent-observed revision/status and the managed key **names**.
//! It never carries ENV values, snapshots or credentials.

use crate::error::ToolError;
use crate::tool::{parse_arguments, schema_for, ToolContext, ToolHandler};
use crate::tools::env_target::canonical_session_id;
use async_trait::async_trait;
use nession_protocol::contracts::session::v1::ClientSessionEnvBindingGetPayload;
use serde::Deserialize;
use serde_json::{Map, Value};

/// The `nession_server_session_env_binding_get` Tool.
pub struct NessionServerSessionEnvBindingGet;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Arguments {
    session_id: String,
}

#[async_trait]
impl ToolHandler for NessionServerSessionEnvBindingGet {
    fn name(&self) -> &'static str {
        "nession_server_session_env_binding_get"
    }

    fn description(&self) -> &'static str {
        "Read one live Session's Environment Binding: ordered desired profiles and revision, whether each profile's file changed since materialization, and the Agent-observed applied revision and status. Never returns ENV variable values or credentials."
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
        canonical_session_id(&arguments.session_id)?;
        context
            .cluster
            .session_env_binding_get(ClientSessionEnvBindingGetPayload {
                session_id: arguments.session_id,
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::{arguments, context, Recorded, Recording};
    use std::sync::Arc;

    #[test]
    fn schema_is_closed_and_requires_the_session() {
        let schema = NessionServerSessionEnvBindingGet.input_schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(
            schema["required"],
            serde_json::json!(["session_id"]),
            "the caller must name the Session explicitly"
        );
    }

    #[tokio::test]
    async fn get_reads_the_named_session_binding() {
        let recorder = Arc::new(Recording::default());
        let reply = NessionServerSessionEnvBindingGet
            .call(
                &context(&recorder),
                arguments(serde_json::json!({ "session_id": "agent-a:dev" })),
            )
            .await
            .expect("reply");
        assert_eq!(reply["success"], true);
        assert_eq!(
            recorder.calls(),
            vec![Recorded::BindingGet("agent-a:dev".to_string())]
        );
    }

    #[tokio::test]
    async fn a_non_canonical_session_id_never_reaches_the_backend() {
        let recorder = Arc::new(Recording::default());
        for session_id in ["agent-a", ":dev", "agent-a:", ""] {
            let error = NessionServerSessionEnvBindingGet
                .call(
                    &context(&recorder),
                    arguments(serde_json::json!({ "session_id": session_id })),
                )
                .await
                .expect_err("invalid session id");
            assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        }
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn unexpected_input_is_rejected() {
        let recorder = Arc::new(Recording::default());
        let error = NessionServerSessionEnvBindingGet
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "session_id": "agent-a:dev",
                    "agent_fallback": true
                })),
            )
            .await
            .expect_err("unexpected field");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }
}
