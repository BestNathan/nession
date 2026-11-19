//! `nession_agent_update_session_metadata` — partial update of one Session's
//! work context.
//!
//! The patch is resolved by the Agent, the metadata's only writer, against the
//! current record under the caller's incarnation and revision preconditions.
//! This Tool never reads-then-writes on its own: a concurrent writer becomes a
//! `conflict`, never a silently dropped field (#4007).
//!
//! Patch field states (`SessionMetadataPatch`):
//! omitted preserves, explicit `null` (title/description) clears, a supplied
//! value replaces; `tags: []` clears the list. An empty patch is rejected.

use async_trait::async_trait;
use nession_protocol::contracts::session::v1::{SessionMetadataPatch, SessionMetadataPatchPayload};
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::error::ToolError;
use crate::tool::{non_empty, parse_arguments, reply_value, schema_for, ToolContext, ToolHandler};
use crate::tools::nession_agent_get_session_metadata::SessionMetadataOutput;

/// The Tool definition.
pub struct NessionAgentUpdateSessionMetadata;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Arguments {
    /// The Agent node that owns the Session.
    agent_id: String,
    /// The tmux Session name on that Agent.
    name: String,
    /// The durable instance the caller last read (from Get).
    expected_instance_id: String,
    /// The revision the caller last read (from Get).
    expected_revision: u64,
    /// Fields to change; omitted fields are preserved.
    patch: SessionMetadataPatch,
}

#[async_trait]
impl ToolHandler for NessionAgentUpdateSessionMetadata {
    fn name(&self) -> &'static str {
        "nession_agent_update_session_metadata"
    }

    fn description(&self) -> &'static str {
        "Partially update one explicit Agent Session's durable work context. Requires \
         `agent_id`, `name`, `expected_instance_id` and `expected_revision` read from \
         `nession_agent_get_session_metadata`. In `patch`, an omitted field is preserved, an \
         explicit null clears title/description, a supplied value replaces it, and `tags: []` \
         clears tags. A stale revision or a recreated same-name Session is a `conflict` and \
         leaves the current metadata intact; retry after re-reading."
    }

    fn input_schema(&self) -> Map<String, Value> {
        schema_for::<Arguments>()
    }

    fn output_schema(&self) -> Map<String, Value> {
        schema_for::<SessionMetadataOutput>()
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
        if arguments.patch.is_empty() {
            return Err(ToolError::invalid_argument(
                "`patch` must change at least one of title, description or tags",
            ));
        }
        let request = SessionMetadataPatchPayload {
            name: arguments.name.clone(),
            expected_instance_id: arguments.expected_instance_id,
            expected_revision: arguments.expected_revision,
            patch: arguments.patch,
        };
        let reply = context
            .node
            .update_session_metadata(&arguments.agent_id, request)
            .await?;
        reply_value(&SessionMetadataOutput::from_reply(
            &arguments.agent_id,
            &arguments.name,
            reply,
        )?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::{arguments, context, Recorded, Recording};
    use nession_protocol::contracts::session::v1::SessionMetadata;
    use nession_protocol::contracts::session::v1::SessionMetadataResponse;
    use std::sync::Arc;

    fn committed() -> SessionMetadataResponse {
        SessionMetadataResponse::success_for(
            "instance-a".to_string(),
            SessionMetadata {
                revision: 5,
                title: Some("Kept title".to_string()),
                description: Some("Next step".to_string()),
                tags: vec!["one".to_string()],
                created_at: Some(1),
                updated_at: Some(2),
            },
        )
    }

    #[tokio::test]
    async fn it_sends_the_guarded_partial_update() {
        let recorder = Arc::new(Recording::default());
        recorder.set_metadata_reply(serde_json::to_value(committed()).unwrap());
        let value = NessionAgentUpdateSessionMetadata
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "agent_id": "agent-1",
                    "name": "dev",
                    "expected_instance_id": "instance-a",
                    "expected_revision": 4,
                    "patch": { "description": "Next step" }
                })),
            )
            .await
            .expect("reply");
        assert_eq!(value["session_id"], "agent-1:dev");
        assert_eq!(value["instance_id"], "instance-a");
        assert_eq!(value["metadata"]["revision"], 5);
        let calls = recorder.calls();
        assert_eq!(calls.len(), 1);
        match &calls[0] {
            Recorded::UpdateSessionMetadata(agent_id, request) => {
                assert_eq!(agent_id, "agent-1");
                assert_eq!(request.name, "dev");
                assert_eq!(request.expected_instance_id, "instance-a");
                assert_eq!(request.expected_revision, 4);
                assert!(request.patch.title.is_none());
                assert_eq!(
                    request.patch.description,
                    Some(Some("Next step".to_string()))
                );
            }
            other => panic!("unexpected call: {other:?}"),
        }
    }

    #[test]
    fn its_input_schema_requires_both_preconditions_and_typed_patch_states() {
        let schema = NessionAgentUpdateSessionMetadata.input_schema();
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(
            schema["required"],
            serde_json::json!([
                "agent_id",
                "name",
                "expected_instance_id",
                "expected_revision",
                "patch"
            ])
        );
        assert_eq!(schema["properties"]["expected_revision"]["type"], "integer");
        let rendered = serde_json::to_string(&schema).unwrap();
        assert!(rendered.contains("\"patch\""), "{rendered}");
        assert!(rendered.contains("\"title\""), "{rendered}");
        assert!(rendered.contains("\"tags\""), "{rendered}");
    }

    #[tokio::test]
    async fn an_empty_patch_is_refused_before_the_backend() {
        let recorder = Arc::new(Recording::default());
        let error = NessionAgentUpdateSessionMetadata
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "agent_id": "agent-1",
                    "name": "dev",
                    "expected_instance_id": "instance-a",
                    "expected_revision": 4,
                    "patch": {}
                })),
            )
            .await
            .expect_err("empty patch");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn missing_preconditions_are_refused() {
        let recorder = Arc::new(Recording::default());
        for value in [
            serde_json::json!({
                "agent_id": "agent-1", "name": "dev", "expected_revision": 4,
                "patch": { "title": "x" }
            }),
            serde_json::json!({
                "agent_id": "agent-1", "name": "dev",
                "expected_instance_id": "instance-a", "patch": { "title": "x" }
            }),
            serde_json::json!({
                "agent_id": "agent-1", "name": "dev",
                "expected_instance_id": " ", "expected_revision": 4,
                "patch": { "title": "x" }
            }),
        ] {
            let error = NessionAgentUpdateSessionMetadata
                .call(&context(&recorder), arguments(value))
                .await
                .expect_err("refused");
            assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        }
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn a_stale_precondition_is_a_conflict() {
        let recorder = Arc::new(Recording::default());
        recorder.set_metadata_reply(serde_json::json!({
            "success": false,
            "error": "expected instance instance-a, current instance instance-b",
            "error_kind": "conflict",
            "metadata": null
        }));
        let error = NessionAgentUpdateSessionMetadata
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "agent_id": "agent-1", "name": "dev",
                    "expected_instance_id": "instance-a", "expected_revision": 0,
                    "patch": { "title": "Stale" }
                })),
            )
            .await
            .expect_err("conflict");
        assert_eq!(error.kind, crate::error::ToolErrorKind::Conflict);
        // The session is untouched; the Tool returns no success shape.
        assert!(!error.message.is_empty());
    }
}
