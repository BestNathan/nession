//! `nession_server_env_get` — Server-owned ENV management.
//! Routes through the same Server API as Web/CLI; does not access arbitrary host files.

use super::env_target::Source;
use crate::error::ToolError;
use crate::tool::{non_empty, parse_arguments, reply_value, schema_for, ToolContext, ToolHandler};
use async_trait::async_trait;
use nession_protocol::contracts::env::v1::{ClientEnvGetPayload, ClientEnvGetResponsePayload};
use serde::Deserialize;
use serde_json::{Map, Value};

/// The `nession_server_env_get` Tool.
pub struct NessionServerEnvGet;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Arguments {
    name: String,
    #[serde(default)]
    source: Source,
    #[serde(default)]
    agent_id: Option<String>,
}

#[async_trait]
impl ToolHandler for NessionServerEnvGet {
    fn name(&self) -> &'static str {
        "nession_server_env_get"
    }

    fn description(&self) -> &'static str {
        "Read the raw contents of one named Nession ENV file from the Server or an Agent. Contents may contain secrets; handle the result as sensitive data."
    }

    fn input_schema(&self) -> Map<String, Value> {
        schema_for::<Arguments>()
    }

    fn output_schema(&self) -> Map<String, Value> {
        schema_for::<ClientEnvGetResponsePayload>()
    }

    async fn call(
        &self,
        context: &ToolContext,
        arguments: Map<String, Value>,
    ) -> Result<Value, ToolError> {
        let arguments: Arguments = parse_arguments(arguments)?;
        non_empty(&arguments.name, "name")?;
        let (source, agent_id) = arguments.source.resolve(arguments.agent_id.as_deref())?;
        let reply = context
            .cluster
            .env_get(ClientEnvGetPayload {
                name: arguments.name,
                source,
                agent_id,
            })
            .await?;
        reply_value(&reply)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::{arguments, context, Recorded, Recording};
    use std::sync::Arc;

    #[test]
    fn schema_is_closed() {
        let schema = NessionServerEnvGet.input_schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false);
    }

    #[tokio::test]
    async fn missing_or_empty_name_never_reaches_backend() {
        let recorder = Arc::new(Recording::default());
        let input = serde_json::json!({ "name": "" });
        let error = NessionServerEnvGet
            .call(&context(&recorder), arguments(input))
            .await
            .expect_err("empty name");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn read_uses_the_explicit_agent_scope() {
        let recorder = Arc::new(Recording::default());
        let reply = NessionServerEnvGet
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "name": "prod.env",
                    "source": "agent",
                    "agent_id": "agent-1"
                })),
            )
            .await
            .expect("reply");
        assert_eq!(reply["content"], "PUBLIC=1\n");
        assert_eq!(
            recorder.calls(),
            vec![Recorded::EnvGet(
                "prod.env".to_string(),
                nession_protocol::contracts::env::v1::EnvSource::Agent,
                Some("agent-1".to_string()),
            )]
        );
    }

    #[tokio::test]
    async fn unexpected_input_is_rejected() {
        let recorder = Arc::new(Recording::default());
        let invalid = serde_json::json!({"name": "prod.env", "path": "/etc/passwd"});
        let result = NessionServerEnvGet
            .call(&context(&recorder), arguments(invalid))
            .await;
        assert!(result.is_err());
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn agent_source_requires_target() {
        let recorder = Arc::new(Recording::default());
        let input = serde_json::json!({ "name": "prod.env", "source": "agent" });
        let error = NessionServerEnvGet
            .call(&context(&recorder), arguments(input))
            .await
            .expect_err("agent_id");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }
}
