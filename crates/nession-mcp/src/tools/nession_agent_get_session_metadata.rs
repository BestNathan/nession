//! `nession_agent_get_session_metadata` — read one Session's work context.
//!
//! The Agent owns the metadata; this Tool adapts its answer into the MCP
//! result. The caller always names the target explicitly: there is no implicit
//! "current Agent/Session" and no fallback to the MCP host (#4007).
//!
//! The success projection carries the canonical Session identity, the durable
//! `instance_id` that record belongs to, and the full metadata. A missing or
//! offline Agent/Session is a tool error, never an apparently empty record: a
//! revision-0 answer is reserved for a Session the Agent actually read.

use async_trait::async_trait;
use nession_protocol::contracts::session::v1::{SessionMetadata, SessionMetadataResponse};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{ToolError, ToolErrorKind};
use crate::tool::{non_empty, parse_arguments, reply_value, schema_for, ToolContext, ToolHandler};

/// The Tool definition.
pub struct NessionAgentGetSessionMetadata;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Arguments {
    /// The Agent node that owns the Session.
    agent_id: String,
    /// The tmux Session name on that Agent.
    name: String,
}

/// The success projection shared by both metadata Tools.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SessionMetadataOutput {
    /// Canonical Session identity (`<agent_id>:<session_name>`).
    pub session_id: String,
    /// The durable tmux instance this record belongs to. Use it as
    /// `expected_instance_id` on the next guarded write.
    pub instance_id: String,
    /// The complete Agent-owned record (revision 0 = confirmed legacy/empty).
    pub metadata: SessionMetadata,
}

impl SessionMetadataOutput {
    /// Project one successful owner reply, or map its refusal to a Tool error.
    pub fn from_reply(
        agent_id: &str,
        name: &str,
        reply: SessionMetadataResponse,
    ) -> Result<Self, ToolError> {
        if !reply.success {
            return Err(owner_refusal(&reply));
        }
        let metadata = reply.metadata.ok_or_else(|| {
            ToolError::backend("the Agent answered success without Session metadata")
        })?;
        let instance_id = reply.instance_id.ok_or_else(|| {
            ToolError::backend("the Agent answered success without a Session instance identity")
        })?;
        Ok(Self {
            session_id: format!("{agent_id}:{name}"),
            instance_id,
            metadata,
        })
    }
}

/// Map the metadata owner's stable refusal vocabulary to the MCP error kinds.
///
/// The owner's kinds are `invalid | conflict | not_found | unavailable`; the
/// caller must be able to tell a stale precondition from an unknown target.
pub fn owner_refusal(reply: &SessionMetadataResponse) -> ToolError {
    let kind = match reply.error_kind.as_deref() {
        Some("invalid") => ToolErrorKind::InvalidArgument,
        Some("conflict") => ToolErrorKind::Conflict,
        Some("not_found") => ToolErrorKind::NotFound,
        Some("unavailable") => ToolErrorKind::Unavailable,
        _ => ToolErrorKind::Backend,
    };
    ToolError::new(
        kind,
        reply
            .error
            .clone()
            .unwrap_or_else(|| "the Session metadata operation was refused".to_string()),
    )
}

#[async_trait]
impl ToolHandler for NessionAgentGetSessionMetadata {
    fn name(&self) -> &'static str {
        "nession_agent_get_session_metadata"
    }

    fn description(&self) -> &'static str {
        "Read one explicit Agent Session's durable work context (title, description, tags, \
         revision) and its authoritative tmux `instance_id`. `agent_id` and `name` are required; \
         the call never infers the target. A Session with no saved metadata answers revision 0 \
         with empty fields; a missing/offline Agent or missing Session is an error, not empty \
         metadata."
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
        let reply = context
            .node
            .get_session_metadata(&arguments.agent_id, &arguments.name)
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
    use std::sync::Arc;

    fn reply() -> SessionMetadataResponse {
        SessionMetadataResponse::success_for(
            "instance-a".to_string(),
            SessionMetadata {
                revision: 3,
                title: Some("Release triage".to_string()),
                description: Some("Triage the run".to_string()),
                tags: vec!["release".to_string()],
                created_at: Some(1),
                updated_at: Some(2),
            },
        )
    }

    #[tokio::test]
    async fn it_reads_the_explicit_target_and_projects_identity() {
        let recorder = Arc::new(Recording::default());
        recorder.set_metadata_reply(serde_json::to_value(reply()).unwrap());
        let value = NessionAgentGetSessionMetadata
            .call(
                &context(&recorder),
                arguments(serde_json::json!({ "agent_id": "agent-1", "name": "dev" })),
            )
            .await
            .expect("reply");
        assert_eq!(value["session_id"], "agent-1:dev");
        assert_eq!(value["instance_id"], "instance-a");
        assert_eq!(value["metadata"]["revision"], 3);
        assert_eq!(value["metadata"]["title"], "Release triage");
        assert_eq!(
            recorder.calls(),
            vec![Recorded::GetSessionMetadata(
                "agent-1".to_string(),
                "dev".to_string()
            )]
        );
    }

    #[test]
    fn both_targets_are_required_and_statically_typed() {
        let schema = NessionAgentGetSessionMetadata.input_schema();
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"], serde_json::json!(["agent_id", "name"]));
        assert_eq!(schema["properties"]["agent_id"]["type"], "string");
        assert_eq!(schema["properties"]["name"]["type"], "string");
        let output = NessionAgentGetSessionMetadata.output_schema();
        let rendered = serde_json::to_string(&output).unwrap();
        assert!(rendered.contains("session_id"), "{rendered}");
        assert!(rendered.contains("instance_id"), "{rendered}");
        assert!(rendered.contains("metadata"), "{rendered}");
    }

    #[tokio::test]
    async fn an_empty_target_is_refused_before_the_backend() {
        let recorder = Arc::new(Recording::default());
        for arguments_value in [
            serde_json::json!({ "agent_id": " ", "name": "dev" }),
            serde_json::json!({ "agent_id": "agent-1", "name": "" }),
            serde_json::json!({ "agent_id": "agent-1" }),
            serde_json::json!({ "agent_id": "agent-1", "name": "dev", "extra": 1 }),
        ] {
            let error = NessionAgentGetSessionMetadata
                .call(&context(&recorder), arguments(arguments_value))
                .await
                .expect_err("refused");
            assert_eq!(error.kind, ToolErrorKind::InvalidArgument);
        }
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn a_missing_session_is_not_an_empty_record() {
        let recorder = Arc::new(Recording::default());
        recorder.set_metadata_reply(serde_json::json!({
            "success": false,
            "error": "no such session: dev",
            "error_kind": "not_found",
            "metadata": null
        }));
        let error = NessionAgentGetSessionMetadata
            .call(
                &context(&recorder),
                arguments(serde_json::json!({ "agent_id": "agent-1", "name": "dev" })),
            )
            .await
            .expect_err("not found");
        assert_eq!(error.kind, ToolErrorKind::NotFound);
        assert!(error.message.contains("no such session"));
    }

    #[test]
    fn owner_refusals_keep_their_classification() {
        let refusal = |kind: &str| SessionMetadataResponse {
            success: false,
            error: Some("detail".to_string()),
            error_kind: Some(kind.to_string()),
            metadata: None,
            instance_id: None,
        };
        assert_eq!(
            owner_refusal(&refusal("invalid")).kind,
            ToolErrorKind::InvalidArgument
        );
        assert_eq!(
            owner_refusal(&refusal("conflict")).kind,
            ToolErrorKind::Conflict
        );
        assert_eq!(
            owner_refusal(&refusal("not_found")).kind,
            ToolErrorKind::NotFound
        );
        assert_eq!(
            owner_refusal(&refusal("unavailable")).kind,
            ToolErrorKind::Unavailable
        );
        assert_eq!(
            owner_refusal(&refusal("other")).kind,
            ToolErrorKind::Backend
        );
    }
}
