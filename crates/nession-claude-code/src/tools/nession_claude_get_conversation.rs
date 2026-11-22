//! `nession_claude_get_conversation` — one explicitly named conversation's
//! ordered page (`#3779` P3).
//!
//! A typed MCP projection of `claude-code.messages` (`#1222`). The requested
//! `conversation_id` is the only selection mechanism: an unknown id is the
//! Unit's `not_found`, never the Session binding, the newest transcript or
//! another conversation. No cursor reads the **newest** bounded page (the
//! latest-observation read); passing a previous `next_cursor` continues to the
//! older page. Both cursors are opaque and owned by the Unit.

use std::sync::Arc;

use async_trait::async_trait;
use nession_mcp::tool::{non_empty, parse_arguments, reply_value, schema_for};
use nession_mcp::{ToolContext, ToolError, ToolHandler};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::conversation_reader::ClaudeConversationReader;
use crate::protocol::messages::{MessagesRequestV1, MessagesResponseV1};

/// The exact MCP Tool name.
pub const NAME: &str = "nession_claude_get_conversation";

/// The Tool's typed arguments.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ClaudeGetConversationInput {
    /// The Agent that owns the Session and executes the read.
    agent_id: String,
    /// The Nession Session, named `agent_id:session_name`.
    session_id: String,
    /// The conversation to read — one of the listed conversation ids.
    conversation_id: String,
    /// Continue from a previous response's opaque `next_cursor`.
    #[serde(default)]
    cursor: Option<String>,
    /// Requested item count; the Protocol Unit clamps it to 1..=200.
    #[serde(default)]
    limit: Option<u32>,
}

/// The `nession_claude_get_conversation` handler.
pub struct NessionClaudeGetConversation {
    local_agent_id: String,
    reader: Arc<dyn ClaudeConversationReader>,
}

impl NessionClaudeGetConversation {
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
impl ToolHandler for NessionClaudeGetConversation {
    fn name(&self) -> &str {
        NAME
    }

    fn description(&self) -> &str {
        "Read the ordered, paged timeline of exactly one Claude conversation named by \
         conversation_id in one Nession Session. Reuses the canonical claude-code.messages \
         answer: messages, tool calls with paired results, bounded payloads, opaque next_cursor \
         pagination and the Unit's unreadable/unknown semantics. Without a cursor the newest \
         page is returned (bounded latest observation); an unknown id is not_found and never \
         selects another conversation."
    }

    fn input_schema(&self) -> Map<String, Value> {
        schema_for::<ClaudeGetConversationInput>()
    }

    fn output_schema(&self) -> Map<String, Value> {
        // The Unit's own response type is the output contract; the MCP
        // projection does not restate it.
        schema_for::<MessagesResponseV1>()
    }

    async fn call(
        &self,
        _context: &ToolContext,
        arguments: Map<String, Value>,
    ) -> Result<Value, ToolError> {
        let input = parse_arguments::<ClaudeGetConversationInput>(arguments)?;
        let target =
            super::validate_target(&self.local_agent_id, &input.agent_id, &input.session_id)?;
        non_empty(&input.conversation_id, "conversation_id")?;
        if let Some(cursor) = input.cursor.as_deref() {
            non_empty(cursor, "cursor")?;
        }
        let response = self
            .reader
            .messages(MessagesRequestV1 {
                session_id: target.session_id,
                conversation_id: input.conversation_id,
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
    use crate::protocol::conversations::{ConversationActivityV1, ConversationItemV1};
    use crate::protocol::messages::{MessageItemV1, MessagesStateV1, ToolActivityV1, ToolStatusV1};
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
        async fn conversations(
            &self,
            _request: crate::protocol::conversations::ConversationsRequestV1,
        ) -> crate::protocol::conversations::ConversationsResponseV1 {
            unimplemented!("the conversation reader never lists")
        }

        async fn messages(&self, request: MessagesRequestV1) -> MessagesResponseV1 {
            if request.conversation_id == "missing" {
                return MessagesResponseV1::bare(MessagesStateV1::NotFound);
            }
            let has_more = request.cursor.is_none();
            MessagesResponseV1 {
                state: MessagesStateV1::Ready,
                conversation: Some(ConversationItemV1 {
                    id: request.conversation_id.clone(),
                    cwd: "/work".to_string(),
                    updated_at: None,
                    title: None,
                    preview: None,
                }),
                activity: Some(ConversationActivityV1::Active),
                items: vec![MessageItemV1::Tool {
                    id: "tool-1".to_string(),
                    timestamp: None,
                    tool: ToolActivityV1 {
                        call_id: "call-1".to_string(),
                        name: "Bash".to_string(),
                        status: ToolStatusV1::Success,
                        summary: "echo ok".to_string(),
                        input: None,
                        output: None,
                    },
                }],
                next_cursor: request.cursor.map(|cursor| format!("next:{cursor}")),
                has_more,
                partial_tail: false,
                skipped: 0,
                error: None,
            }
        }

        async fn transcript_records(
            &self,
            _request: TranscriptRecordsRequestV1,
        ) -> TranscriptRecordsResponseV1 {
            unimplemented!("the conversation reader never reads a transcript")
        }

        async fn transcript_record(
            &self,
            _request: TranscriptRecordRequestV1,
        ) -> TranscriptRecordResponseV1 {
            unimplemented!("the conversation reader never reads a record")
        }
    }

    fn context() -> ToolContext {
        let cluster: Arc<dyn ClusterBackend> =
            Arc::new(UnavailableClusterBackend::new("no server"));
        let node: Arc<dyn NodeBackend> = Arc::new(UnavailableNodeBackend::new("no agent"));
        ToolContext::new(cluster, node)
    }

    fn tool() -> NessionClaudeGetConversation {
        NessionClaudeGetConversation::new("agent-a", Arc::new(FixtureReader))
    }

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().expect("object").clone()
    }

    #[tokio::test]
    async fn it_reads_the_exact_requested_conversation_and_keeps_tool_activity() {
        let reply = tool()
            .call(
                &context(),
                args(serde_json::json!({
                    "agent_id": "agent-a",
                    "session_id": "agent-a:dev",
                    "conversation_id": "550e8400-e29b-41d4-a716-446655440000"
                })),
            )
            .await
            .expect("conversation");
        assert_eq!(
            reply["conversation"]["id"],
            "550e8400-e29b-41d4-a716-446655440000"
        );
        assert_eq!(reply["state"], "ready");
        assert_eq!(reply["items"][0]["kind"], "tool");
        assert_eq!(reply["items"][0]["tool"]["call_id"], "call-1");
        assert_eq!(reply["items"][0]["tool"]["status"], "success");
        assert_eq!(reply["has_more"], true);
    }

    #[tokio::test]
    async fn an_unknown_conversation_is_not_substituted() {
        let reply = tool()
            .call(
                &context(),
                args(serde_json::json!({
                    "agent_id": "agent-a",
                    "session_id": "agent-a:dev",
                    "conversation_id": "missing"
                })),
            )
            .await
            .expect("conversation");
        assert_eq!(reply["state"], "not_found");
        assert!(reply.get("conversation").is_none());
        assert!(reply.get("items").is_none());
    }

    #[tokio::test]
    async fn the_cursor_is_passed_to_the_unit_unchanged() {
        let reply = tool()
            .call(
                &context(),
                args(serde_json::json!({
                    "agent_id": "agent-a",
                    "session_id": "agent-a:dev",
                    "conversation_id": "550e8400-e29b-41d4-a716-446655440000",
                    "cursor": "unit-cursor"
                })),
            )
            .await
            .expect("conversation");
        assert_eq!(reply["next_cursor"], "next:unit-cursor");
    }

    #[tokio::test]
    async fn a_missing_foreign_or_blank_identity_is_refused_before_any_read() {
        for value in [
            serde_json::json!({"agent_id":"agent-a","session_id":"agent-a:dev"}),
            serde_json::json!({"agent_id":"agent-a","session_id":"agent-a:dev","conversation_id":" "}),
            serde_json::json!({"agent_id":"agent-b","session_id":"agent-b:dev","conversation_id":"conv"}),
            serde_json::json!({"agent_id":"agent-a","session_id":"agent-a:dev","conversation_id":"conv","cursor":""}),
            serde_json::json!({"agent_id":"agent-a","session_id":"agent-a:dev","conversation_id":"conv","extra":1}),
        ] {
            let error = tool()
                .call(&context(), args(value))
                .await
                .expect_err("invalid request");
            assert_eq!(error.kind, nession_mcp::ToolErrorKind::InvalidArgument);
        }
    }

    #[test]
    fn the_contract_requires_the_conversation_and_advertises_the_unit_output() {
        let schema = tool().input_schema();
        assert_eq!(schema["additionalProperties"], false);
        let required = schema["required"].as_array().expect("required");
        for field in ["agent_id", "session_id", "conversation_id"] {
            assert!(required.iter().any(|name| name == field), "{field}");
        }
        let output = tool().output_schema();
        for field in [
            "state",
            "conversation",
            "activity",
            "items",
            "next_cursor",
            "has_more",
            "partial_tail",
            "skipped",
        ] {
            assert!(
                output["properties"].get(field).is_some(),
                "missing output field {field}"
            );
        }
    }
}
