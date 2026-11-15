//! `nession_server_env_delete` — Server-owned ENV management.
//! Routes through the same Server API as Web/CLI; does not access arbitrary host files.

use super::env_target::Source;
use crate::error::ToolError;
use crate::tool::{non_empty, parse_arguments, schema_for, ToolContext, ToolHandler};
use async_trait::async_trait;
use nession_protocol::contracts::env::v1::ClientEnvDeletePayload;
use serde::Deserialize;
use serde_json::{Map, Value};

/// The `nession_server_env_delete` Tool.
pub struct NessionServerEnvDelete;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Arguments {
    name: String,
    #[serde(default)]
    source: Source,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    force: bool,
}

#[async_trait]
impl ToolHandler for NessionServerEnvDelete {
    fn name(&self) -> &'static str {
        "nession_server_env_delete"
    }

    fn description(&self) -> &'static str {
        "Delete one Nession ENV file via the Server's canonical management route. Refuses to delete files bound to running Sessions unless force=true."
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
        non_empty(&arguments.name, "name")?;
        let (source, agent_id) = arguments.source.resolve(arguments.agent_id.as_deref())?;
        context
            .cluster
            .env_delete(ClientEnvDeletePayload {
                name: arguments.name,
                source,
                agent_id,
                force: arguments.force,
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
    fn schema_is_closed() {
        let schema = NessionServerEnvDelete.input_schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false);
    }

    #[tokio::test]
    async fn missing_or_empty_name_never_reaches_backend() {
        let recorder = Arc::new(Recording::default());
        let input = serde_json::json!({ "name": "" });
        let error = NessionServerEnvDelete
            .call(&context(&recorder), arguments(input))
            .await
            .expect_err("empty name");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn delete_explicitly_carries_force_and_target() {
        let recorder = Arc::new(Recording::default());
        let reply = NessionServerEnvDelete
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "name": "prod.env",
                    "source": "agent",
                    "agent_id": "agent-1",
                    "force": true
                })),
            )
            .await
            .expect("reply");
        assert_eq!(reply["success"], true);
        assert_eq!(
            recorder.calls(),
            vec![Recorded::EnvDelete(
                "prod.env".to_string(),
                nession_protocol::contracts::env::v1::EnvSource::Agent,
                Some("agent-1".to_string()),
                true,
            )]
        );
    }

    #[tokio::test]
    async fn agent_source_requires_target() {
        let recorder = Arc::new(Recording::default());
        let input = serde_json::json!({ "name": "prod.env", "source": "agent" });
        let error = NessionServerEnvDelete
            .call(&context(&recorder), arguments(input))
            .await
            .expect_err("agent_id");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }
}
