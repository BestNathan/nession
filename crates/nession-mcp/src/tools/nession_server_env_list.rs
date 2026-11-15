//! `nession_server_env_list` — Server-owned ENV management.
//! Routes through the same Server API as Web/CLI; does not access arbitrary host files.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Map, Value};
use crate::error::ToolError;
use crate::tool::{parse_arguments, schema_for, ToolContext, ToolHandler};

/// The `nession_server_env_list` Tool.
pub struct NessionServerEnvList;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Arguments {}

#[async_trait]
impl ToolHandler for NessionServerEnvList {
    fn name(&self) -> &'static str {
        "nession_server_env_list"
    }

    fn description(&self) -> &'static str {
        "List Nession ENV file metadata on the Server and its online Agents. Does not return file contents or secret values."
    }

    fn input_schema(&self) -> Map<String, Value> {
        schema_for::<Arguments>()
    }

    async fn call(
        &self,
        context: &ToolContext,
        arguments: Map<String, Value>,
    ) -> Result<Value, ToolError> {
        let _: Arguments = parse_arguments(arguments)?;
        context.cluster.env_list().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::{arguments, context, Recorded, Recording};
    use std::sync::Arc;

    #[test]
    fn schema_is_closed() {
        let schema = NessionServerEnvList.input_schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false);
    }

    #[tokio::test]
    async fn empty_request_reads_metadata() {
        let recorder = Arc::new(Recording::default());
        let reply = NessionServerEnvList.call(&context(&recorder), arguments(serde_json::json!({})))
            .await.expect("reply");
        assert_eq!(reply["files"], serde_json::json!([]));
        assert_eq!(recorder.calls(), vec![Recorded::EnvList]);
    }
}
