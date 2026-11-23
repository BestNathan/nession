//! `nession_agent_create_session` — Agent-owned Session creation.
//!
//! The named Agent owns the new Session. Routing through a Server or a
//! standalone host changes how the request reaches that Agent, never who
//! creates the Session or which node owns it.
//!
//! The success reply is the stabilized MCP projection shared by every hosting
//! mode: the created Session name, materialization warnings and — when the
//! request asked for initial work context — the committed metadata and the
//! incarnation identity it belongs to (#4081). Agent-specific details that only
//! one route can report are not part of this Tool contract.

use async_trait::async_trait;
use nession_protocol::contracts::session::v1::{SessionInitialMetadata, SessionMetadata};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::ToolError;
use crate::tool::{non_empty, parse_arguments, reply_value, schema_for, ToolContext, ToolHandler};

/// The Tool definition.
pub struct NessionAgentCreateSession;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Arguments {
    /// The Agent node that will own the Session.
    agent_id: String,
    /// The Session (tmux session) name.
    name: String,
    /// Optional initial working directory on that Agent.
    #[serde(default)]
    working_dir: Option<String>,
    /// Optional initial work context committed with the create (#4081).
    ///
    /// Input only: `revision`, timestamps and the instance identity are
    /// Agent-owned and rejected as unknown fields. The same normalization and
    /// bounds as the metadata update Tools apply.
    #[serde(default)]
    metadata: Option<SessionInitialMetadata>,
}

/// The success reply of `nession_agent_create_session`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SessionCreatedOutput {
    /// The created tmux Session name, as the owning Agent reports it.
    pub name: String,
    /// Non-fatal warnings produced while materializing the Session.
    #[serde(default)]
    pub warnings: Vec<String>,
    /// The durable tmux instance identity of the created Session (#4081).
    /// Absent only for a legacy route that cannot report it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    /// The initial work context committed with this create (#4081). Present
    /// only when the request supplied `metadata`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<SessionMetadata>,
}

#[async_trait]
impl ToolHandler for NessionAgentCreateSession {
    fn name(&self) -> &'static str {
        "nession_agent_create_session"
    }

    fn description(&self) -> &'static str {
        "Create a tmux Session on one explicitly named Agent node. `agent_id` is required; the \
         call never falls back to the host running MCP. An optional `metadata` object supplies \
         the Session's initial work context (title, description, tags); it is validated and \
         committed with the create, so a readback needs no separate update call."
    }

    fn input_schema(&self) -> Map<String, Value> {
        schema_for::<Arguments>()
    }

    fn output_schema(&self) -> Map<String, Value> {
        schema_for::<SessionCreatedOutput>()
    }

    async fn call(
        &self,
        context: &ToolContext,
        arguments: Map<String, Value>,
    ) -> Result<Value, ToolError> {
        let arguments: Arguments = parse_arguments(arguments)?;
        non_empty(&arguments.agent_id, "agent_id")?;
        non_empty(&arguments.name, "name")?;
        // The published schema fixes the shape; the shared contract validator
        // owns the bounds and normalization. Running it here refuses an invalid
        // request before the Session backend is asked to create anything.
        if let Some(metadata) = arguments.metadata.as_ref() {
            metadata
                .normalized()
                .map_err(|error| ToolError::invalid_argument(error.to_string()))?;
        }
        let reply = context
            .node
            .create_session(
                &arguments.agent_id,
                &arguments.name,
                arguments.working_dir.as_deref(),
                arguments.metadata.as_ref(),
            )
            .await?;
        reply_value(&reply)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::{arguments, context, Recorded, Recording};
    use std::sync::Arc;

    #[tokio::test]
    async fn it_creates_on_the_named_agent_with_the_working_directory() {
        let recorder = Arc::new(Recording::default());
        let reply = NessionAgentCreateSession
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "agent_id": "agent-1",
                    "name": "work",
                    "working_dir": "/srv/project"
                })),
            )
            .await
            .expect("reply");
        assert_eq!(reply["name"], "work");
        assert_eq!(
            recorder.calls(),
            vec![Recorded::CreateSession(
                "agent-1".to_string(),
                "work".to_string(),
                Some("/srv/project".to_string()),
                None,
            )]
        );
    }

    #[tokio::test]
    async fn it_forwards_initial_metadata_and_returns_the_committed_record() {
        let recorder = Arc::new(Recording::default());
        let reply = NessionAgentCreateSession
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "agent_id": "agent-1",
                    "name": "oauth-work",
                    "metadata": {
                        "title": "OAuth implementation",
                        "description": "Goal: implement and validate the OAuth flow.",
                        "tags": ["backend", "oauth"]
                    }
                })),
            )
            .await
            .expect("reply");
        assert_eq!(reply["name"], "oauth-work");
        assert_eq!(reply["metadata"]["revision"], 1);
        assert_eq!(reply["metadata"]["title"], "OAuth implementation");
        assert_eq!(reply["instance_id"], "instance-fixture");
        let forwarded = match &recorder.calls()[0] {
            Recorded::CreateSession(agent, name, working_dir, metadata) => {
                assert_eq!(agent, "agent-1");
                assert_eq!(name, "oauth-work");
                assert!(working_dir.is_none());
                metadata.clone().expect("metadata was forwarded")
            }
            other => panic!("unexpected call: {other:?}"),
        };
        assert_eq!(
            forwarded.tags,
            vec!["backend".to_string(), "oauth".to_string()]
        );
    }

    #[tokio::test]
    async fn invalid_initial_metadata_is_refused_before_the_backend() {
        let recorder = Arc::new(Recording::default());
        for metadata in [
            serde_json::json!({ "title": "x".repeat(121) }),
            serde_json::json!({ "tags": ["same", "SAME"] }),
            serde_json::json!({ "tags": ["  "] }),
            serde_json::json!({ "tags": ["123456789012345678901234567890123"] }),
        ] {
            let error = NessionAgentCreateSession
                .call(
                    &context(&recorder),
                    arguments(serde_json::json!({
                        "agent_id": "a",
                        "name": "n",
                        "metadata": metadata
                    })),
                )
                .await
                .expect_err("invalid metadata");
            assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        }
        assert!(recorder.calls().is_empty(), "no Session backend call");
    }

    #[tokio::test]
    async fn owner_written_or_unknown_metadata_fields_are_refused() {
        let recorder = Arc::new(Recording::default());
        for metadata in [
            serde_json::json!({ "revision": 3 }),
            serde_json::json!({ "instance_id": "instance-a" }),
            serde_json::json!({ "created_at": 1 }),
            serde_json::json!({ "title": 7 }),
            serde_json::json!({ "tags": "backend" }),
        ] {
            let error = NessionAgentCreateSession
                .call(
                    &context(&recorder),
                    arguments(serde_json::json!({
                        "agent_id": "a",
                        "name": "n",
                        "metadata": metadata
                    })),
                )
                .await
                .expect_err("owner-written/unknown field");
            assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        }
        assert!(recorder.calls().is_empty(), "no Session backend call");
    }

    #[test]
    fn its_schema_matches_the_typed_contract() {
        let schema = NessionAgentCreateSession.input_schema();
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"], serde_json::json!(["agent_id", "name"]));
        assert_eq!(schema["properties"]["agent_id"]["type"], "string");
        assert_eq!(schema["properties"]["name"]["type"], "string");
        assert!(schema["properties"]["working_dir"].is_object());
        assert!(schema["properties"]["metadata"].is_object());
        let metadata = &schema["properties"]["metadata"];
        assert!(
            metadata["anyOf"].is_array(),
            "the optional metadata object is published: {metadata}"
        );
        let definition = &schema["$defs"]["SessionInitialMetadata"];
        assert_eq!(
            definition["additionalProperties"], false,
            "the initial metadata object is closed: {definition}"
        );
        for field in ["title", "description", "tags"] {
            assert!(
                definition["properties"][field].is_object(),
                "metadata.{field} must be published: {definition}"
            );
        }
    }

    #[tokio::test]
    async fn an_empty_name_is_refused() {
        let recorder = Arc::new(Recording::default());
        let error = NessionAgentCreateSession
            .call(
                &context(&recorder),
                arguments(serde_json::json!({ "agent_id": "a", "name": "" })),
            )
            .await
            .expect_err("empty name");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn an_invalid_working_directory_type_is_refused() {
        let recorder = Arc::new(Recording::default());
        let error = NessionAgentCreateSession
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "agent_id": "a",
                    "name": "n",
                    "working_dir": 7
                })),
            )
            .await
            .expect_err("invalid working_dir");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn an_unexpected_argument_is_refused() {
        let recorder = Arc::new(Recording::default());
        let error = NessionAgentCreateSession
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "agent_id": "a",
                    "name": "n",
                    "sandbox": true
                })),
            )
            .await
            .expect_err("unexpected argument");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
    }
}
