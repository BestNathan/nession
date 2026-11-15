//! `nession_server_env_write` — Server-owned ENV management.
//! Routes through the same Server API as Web/CLI; does not access arbitrary host files.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Map, Value};
use nession_protocol::contracts::env::v1::ClientEnvWritePayload;
use crate::error::ToolError;
use super::env_target::Source;
use crate::tool::{non_empty, parse_arguments, schema_for, ToolContext, ToolHandler};

/// The `nession_server_env_write` Tool.
pub struct NessionServerEnvWrite;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Arguments {
    name: String,
    #[serde(default)]
    source: Source,
    #[serde(default)]
    agent_id: Option<String>,
    content: String,
    #[serde(default)]
    overwrite: bool,
    #[serde(default)]
    force: bool,
}

#[async_trait]
impl ToolHandler for NessionServerEnvWrite {
    fn name(&self) -> &'static str {
        "nession_server_env_write"
    }

    fn description(&self) -> &'static str {
        "Create or explicitly overwrite a Nession ENV file on the Server or an Agent. Content can contain secrets. Existing files are protected unless overwrite=true; files in use remain protected unless force=true."
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
        context.cluster.env_write(ClientEnvWritePayload {
            name: arguments.name,
            source,
            agent_id,
            content: arguments.content,
            overwrite: arguments.overwrite,
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
        let schema = NessionServerEnvWrite.input_schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false);
    }

    #[tokio::test]
    async fn missing_or_empty_name_never_reaches_backend() {
        let recorder = Arc::new(Recording::default());
        let input = serde_json::json!({ "name": "", "content": "A=1" });
        let error = NessionServerEnvWrite.call(&context(&recorder), arguments(input))
            .await.expect_err("empty name");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn write_is_create_only_and_not_forced_by_default() {
        let recorder = Arc::new(Recording::default());
        let reply = NessionServerEnvWrite
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "name": "prod.env",
                    "content": "PUBLIC=1"
                })),
            )
            .await
            .expect("reply");
        assert_eq!(reply["success"], true);
        assert_eq!(
            recorder.calls(),
            vec![Recorded::EnvWrite(
                "prod.env".to_string(),
                nession_protocol::contracts::env::v1::EnvSource::Server,
                None,
                "PUBLIC=1".to_string(),
                false,
                false,
            )]
        );
    }

    #[tokio::test]
    async fn agent_source_requires_target() {
        let recorder = Arc::new(Recording::default());
        let input = serde_json::json!({ "name": "prod.env", "source": "agent", "content": "A=1" });
        let error = NessionServerEnvWrite.call(&context(&recorder), arguments(input))
            .await.expect_err("agent_id");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }
}
