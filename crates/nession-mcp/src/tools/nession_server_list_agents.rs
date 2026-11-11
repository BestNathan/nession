//! `nession_server_list_agents` — Server-owned Agent discovery.
//!
//! The semantic owner is the Server: the answer is its registry view
//! (registration, heartbeat, advertised addresses), not a live query of any
//! Agent node. Hosting mode does not change the owner.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::error::ToolError;
use crate::tool::{parse_arguments, schema_for, ToolContext, ToolHandler};

/// The Tool definition.
pub struct NessionServerListAgents;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Arguments {}

#[async_trait]
impl ToolHandler for NessionServerListAgents {
    fn name(&self) -> &'static str {
        "nession_server_list_agents"
    }

    fn description(&self) -> &'static str {
        "List every Agent known to the Nession Server's cluster registry. This is the Server's \
         view (registration, heartbeat, advertised addresses), not a live query of any Agent node."
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
        context.cluster.list_agents().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::{arguments, context, Recorded, Recording};
    use std::sync::Arc;

    #[tokio::test]
    async fn it_reads_the_server_registry() {
        let recorder = Arc::new(Recording::default());
        let reply = NessionServerListAgents
            .call(&context(&recorder), arguments(serde_json::json!({})))
            .await
            .expect("reply");
        assert_eq!(reply["agents"], serde_json::json!([]));
        assert_eq!(recorder.calls(), vec![Recorded::ListAgents]);
    }

    #[test]
    fn its_schema_is_a_closed_empty_object() {
        let schema = NessionServerListAgents.input_schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false);
        if let Some(properties) = schema.get("properties") {
            assert_eq!(properties, &serde_json::json!({}));
        }
    }

    #[tokio::test]
    async fn an_unexpected_argument_is_refused() {
        let recorder = Arc::new(Recording::default());
        let error = NessionServerListAgents
            .call(
                &context(&recorder),
                arguments(serde_json::json!({ "agent_id": "a" })),
            )
            .await
            .expect_err("unexpected argument");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }
}
