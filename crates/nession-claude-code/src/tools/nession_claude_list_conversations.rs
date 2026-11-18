//! `nession_claude_list_conversations` — the conversations visible to one
//! named Nession Session (`#3779` P3).
//!
//! This Tool is a typed MCP projection of the existing
//! `claude-code.conversations` Protocol Unit (`#1222`), executed by the Agent
//! that owns the Session. It owns no discovery, selection or ordering rule:
//! the answer is exactly the unit's current-Session cwd-scoped list, including
//! its stable conversation ids, exact binding, opaque `next_cursor` and bounded
//! `limit`. A list of one is still a list — nothing is auto-opened.

use std::sync::Arc;

use async_trait::async_trait;
use nession_mcp::tool::{non_empty, parse_arguments, reply_value, schema_for};
use nession_mcp::{ToolContext, ToolError, ToolHandler};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::conversation_reader::ClaudeConversationReader;
use crate::protocol::conversations::{ConversationsRequestV1, ConversationsResponseV1};

/// The exact MCP Tool name.
pub const NAME: &str = "nession_claude_list_conversations";

/// The Tool's typed arguments.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ClaudeListConversationsInput {
    /// The Agent that owns the Session and executes the read.
    agent_id: String,
    /// The Nession Session, named `agent_id:session_name`.
    session_id: String,
    /// Continue from a previous response's opaque `next_cursor`.
    #[serde(default)]
    cursor: Option<String>,
    /// Requested conversation count; the Protocol Unit clamps it to 1..=200.
    #[serde(default)]
    limit: Option<u32>,
}

/// The `nession_claude_list_conversations` handler.
pub struct NessionClaudeListConversations {
    local_agent_id: String,
    reader: Arc<dyn ClaudeConversationReader>,
}

impl NessionClaudeListConversations {
    /// Bind the Tool to one Agent's conversation reader.
    pub fn new(
        local_agent_id: impl Into<String>,
        reader: Arc<dyn ClaudeConversationReader>,
    ) -> Self {
        Self {
            local_agent_id: local_agent_id.into(),
            reader,
        }
    }
}

#[async_trait]
impl ToolHandler for NessionClaudeListConversations {
    fn name(&self) -> &str {
        NAME
    }

    fn description(&self) -> &str {
        "List the Claude conversations visible to one named Nession Session, scoped to that \
         Session's current working directory. Returns the canonical claude-code.conversations \
         answer: stable conversation ids, the exact Session binding when current, opaque \
         next_cursor pagination and a bounded limit. The list never selects or opens a \
         conversation by recency."
    }

    fn input_schema(&self) -> Map<String, Value> {
        schema_for::<ClaudeListConversationsInput>()
    }

    fn output_schema(&self) -> Map<String, Value> {
        // The Unit's own response type is the output contract; the MCP
        // projection does not restate it.
        schema_for::<ConversationsResponseV1>()
    }

    async fn call(
        &self,
        _context: &ToolContext,
        arguments: Map<String, Value>,
    ) -> Result<Value, ToolError> {
        let input = parse_arguments::<ClaudeListConversationsInput>(arguments)?;
        let target =
            super::validate_target(&self.local_agent_id, &input.agent_id, &input.session_id)?;
        if let Some(cursor) = input.cursor.as_deref() {
            non_empty(cursor, "cursor")?;
        }
        let response = self
            .reader
            .conversations(ConversationsRequestV1 {
                session_id: target.session_id,
                cursor: input.cursor,
                limit: input.limit,
            })
            .await;
        reply_value(&response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::conversations::{
        ConversationActivityV1, ConversationBindingV1, ConversationItemV1, ConversationsStateV1,
    };
    use crate::protocol::messages::{MessagesRequestV1, MessagesResponseV1};
    use crate::protocol::transcript_record::{
        TranscriptRecordRequestV1, TranscriptRecordResponseV1,
    };
    use crate::protocol::transcript_records::{
        TranscriptRecordsRequestV1, TranscriptRecordsResponseV1,
    };
    use nession_mcp::backend::{
        ClusterBackend, NodeBackend, UnavailableClusterBackend, UnavailableNodeBackend,
    };

    struct FixtureReader;

    #[async_trait]
    impl ClaudeConversationReader for FixtureReader {
        async fn conversations(&self, request: ConversationsRequestV1) -> ConversationsResponseV1 {
            let has_more = request.cursor.is_none();
            ConversationsResponseV1 {
                state: ConversationsStateV1::Ready,
                cwd: Some("/work".to_string()),
                items: vec![ConversationItemV1 {
                    id: "conv-1".to_string(),
                    cwd: "/work".to_string(),
                    updated_at: None,
                    title: Some("Review changes".to_string()),
                    preview: None,
                }],
                binding: Some(ConversationBindingV1 {
                    conversation_id: "conv-1".to_string(),
                    activity: ConversationActivityV1::Active,
                }),
                next_cursor: request.cursor.map(|cursor| format!("next:{cursor}")),
                has_more,
                error: None,
            }
        }

        async fn messages(&self, _request: MessagesRequestV1) -> MessagesResponseV1 {
            unimplemented!("the list Tool never reads a conversation")
        }

        async fn transcript_records(
            &self,
            _request: TranscriptRecordsRequestV1,
        ) -> TranscriptRecordsResponseV1 {
            unimplemented!("the list Tool never reads a transcript")
        }

        async fn transcript_record(
            &self,
            _request: TranscriptRecordRequestV1,
        ) -> TranscriptRecordResponseV1 {
            unimplemented!("the list Tool never reads a record")
        }
    }

    fn context() -> ToolContext {
        let cluster: Arc<dyn ClusterBackend> =
            Arc::new(UnavailableClusterBackend::new("no server"));
        let node: Arc<dyn NodeBackend> = Arc::new(UnavailableNodeBackend::new("no agent"));
        ToolContext::new(cluster, node)
    }

    fn tool() -> NessionClaudeListConversations {
        NessionClaudeListConversations::new("agent-a", Arc::new(FixtureReader))
    }

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().expect("object").clone()
    }

    #[tokio::test]
    async fn the_answer_is_the_units_own_list_and_binding() {
        let reply = tool()
            .call(
                &context(),
                args(serde_json::json!({
                    "agent_id": "agent-a",
                    "session_id": "agent-a:dev"
                })),
            )
            .await
            .expect("list");
        assert_eq!(reply["state"], "ready");
        assert_eq!(reply["cwd"], "/work");
        assert_eq!(reply["items"][0]["id"], "conv-1");
        assert_eq!(reply["binding"]["conversation_id"], "conv-1");
        assert_eq!(reply["binding"]["activity"], "active");
        assert_eq!(reply["has_more"], true);
    }

    #[tokio::test]
    async fn the_cursor_is_passed_to_the_unit_unchanged() {
        let reply = tool()
            .call(
                &context(),
                args(serde_json::json!({
                    "agent_id": "agent-a",
                    "session_id": "agent-a:dev",
                    "cursor": "unit-cursor"
                })),
            )
            .await
            .expect("list");
        assert_eq!(reply["next_cursor"], "next:unit-cursor");
        assert_eq!(reply["has_more"], false);
    }

    #[tokio::test]
    async fn foreign_and_malformed_targets_are_refused_before_any_read() {
        for value in [
            serde_json::json!({"agent_id":"agent-b","session_id":"agent-b:dev"}),
            serde_json::json!({"agent_id":"agent-a","session_id":"agent-b:dev"}),
            serde_json::json!({"agent_id":"agent-a","session_id":"agent-a"}),
            serde_json::json!({"agent_id":"agent-a","session_id":"agent-a:dev","cursor":"  "}),
            serde_json::json!({"agent_id":"agent-a","session_id":"agent-a:dev","extra":true}),
        ] {
            let error = tool()
                .call(&context(), args(value))
                .await
                .expect_err("invalid target");
            assert_eq!(error.kind, nession_mcp::ToolErrorKind::InvalidArgument);
        }
    }

    #[test]
    fn the_contract_requires_the_target_and_advertises_the_unit_output() {
        let schema = tool().input_schema();
        assert_eq!(schema["additionalProperties"], false);
        let required = schema["required"].as_array().expect("required");
        for field in ["agent_id", "session_id"] {
            assert!(required.iter().any(|name| name == field), "{field}");
        }
        let output = tool().output_schema();
        for field in ["state", "items", "binding", "next_cursor", "has_more"] {
            assert!(
                output["properties"].get(field).is_some(),
                "missing output field {field}"
            );
        }
    }
}
