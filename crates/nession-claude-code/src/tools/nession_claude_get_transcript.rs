//! `nession_claude_get_transcript` — raw JSONL transcript records, including
//! unknown types, partial tails and large records (`#3779` P3).
//!
//! A typed MCP projection of the existing raw transcript read family
//! (`claude-code.transcript-records` / `claude-code.transcript-record`,
//! `#3726`). Two explicit modes:
//!
//! * a **page** read selects exactly one transcript by `conversation_id` (that
//!   Session's own transcript) or by `transcript_id` (any listed transcript),
//!   and returns whole source lines in file order, opaque `next_cursor`
//!   pagination and `partial_tail`;
//! * a **record** read resolves one page placeholder by its opaque `record_ref`
//!   and returns one bounded chunk, with `has_more`/`next_offset` for the
//!   caller to continue.
//!
//! No filesystem path crosses either mode: transcript and record identity are
//! opaque strings owned by the Unit. A page whose record is too large carries
//! its `record_ref` and no `raw`; it is never truncated and never dropped.

use std::sync::Arc;

use async_trait::async_trait;
use nession_mcp::tool::{non_empty, parse_arguments, reply_value, schema_for};
use nession_mcp::{ToolContext, ToolError, ToolHandler};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::conversation_reader::ClaudeConversationReader;
use crate::protocol::transcript_record::{TranscriptRecordRequestV1, TranscriptRecordResponseV1};
use crate::protocol::transcript_records::{
    TranscriptRecordsRequestV1, TranscriptRecordsResponseV1,
};

/// The exact MCP Tool name.
pub const NAME: &str = "nession_claude_get_transcript";

/// The Tool's typed arguments.
///
/// Exactly one mode is selected: either a page read (`conversation_id` xor
/// `transcript_id`, plus optional `cursor`/`limit`) or a record read
/// (`record_ref`, plus optional `offset`/`chunk_limit`).
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ClaudeGetTranscriptInput {
    /// The Agent that owns the Session and executes the read.
    agent_id: String,
    /// The Nession Session, named `agent_id:session_name`.
    session_id: String,
    /// Page mode: read this conversation's own raw transcript. Exactly one of
    /// `conversation_id` / `transcript_id` is required.
    #[serde(default)]
    conversation_id: Option<String>,
    /// Page mode: read this transcript id (including a subagent transcript).
    #[serde(default)]
    transcript_id: Option<String>,
    /// Page mode: continue from a previous response's opaque `next_cursor`.
    #[serde(default)]
    cursor: Option<String>,
    /// Page mode: requested record count; the Unit clamps it to 1..=200.
    #[serde(default)]
    limit: Option<u32>,
    /// Record mode: resolve this page placeholder's opaque `record_ref`.
    #[serde(default)]
    record_ref: Option<String>,
    /// Record mode: byte offset within the record's line.
    #[serde(default)]
    offset: Option<u64>,
    /// Record mode: requested chunk length; the Unit clamps it to 256 KiB.
    #[serde(default)]
    chunk_limit: Option<u32>,
}

/// The Tool's typed success reply: exactly one of `page`/`record` is present.
#[derive(Debug, serde::Serialize, JsonSchema)]
pub struct ClaudeGetTranscriptOutput {
    /// The Agent that executed the read.
    agent_id: String,
    /// The Session the read was scoped to.
    session_id: String,
    /// The raw page, for a page read.
    #[serde(skip_serializing_if = "Option::is_none")]
    page: Option<TranscriptRecordsResponseV1>,
    /// One record chunk, for a `record_ref` read.
    #[serde(skip_serializing_if = "Option::is_none")]
    record: Option<TranscriptRecordResponseV1>,
}

/// The `nession_claude_get_transcript` handler.
pub struct NessionClaudeGetTranscript {
    local_agent_id: String,
    reader: Arc<dyn ClaudeConversationReader>,
}

impl NessionClaudeGetTranscript {
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
impl ToolHandler for NessionClaudeGetTranscript {
    fn name(&self) -> &str {
        NAME
    }

    fn description(&self) -> &str {
        "Read raw Claude transcript JSONL for one named Nession Session. Select a page with \
         exactly one of conversation_id (the Session's own transcript) or transcript_id (any \
         listed transcript), plus an opaque cursor and bounded limit; every physical line is \
         returned, including unknown or non-JSON records, with partial_tail reporting an \
         incomplete source line. Resolve a large record from a page placeholder with record_ref \
         to receive one bounded chunk. No transcript file path is returned."
    }

    fn input_schema(&self) -> Map<String, Value> {
        schema_for::<ClaudeGetTranscriptInput>()
    }

    fn output_schema(&self) -> Map<String, Value> {
        schema_for::<ClaudeGetTranscriptOutput>()
    }

    async fn call(
        &self,
        _context: &ToolContext,
        arguments: Map<String, Value>,
    ) -> Result<Value, ToolError> {
        let input = parse_arguments::<ClaudeGetTranscriptInput>(arguments)?;
        let target =
            super::validate_target(&self.local_agent_id, &input.agent_id, &input.session_id)?;
        let target_agent = target.agent_id;
        let target_session = target.session_id;

        let (page, record) = match input.record_ref {
            Some(record_ref) => {
                if input.conversation_id.is_some()
                    || input.transcript_id.is_some()
                    || input.cursor.is_some()
                    || input.limit.is_some()
                {
                    return Err(ToolError::invalid_argument(
                        "a `record_ref` read names one record: omit conversation_id, \
                         transcript_id, cursor and limit",
                    ));
                }
                non_empty(&record_ref, "record_ref")?;
                let record = self
                    .reader
                    .transcript_record(TranscriptRecordRequestV1 {
                        session_id: target_session.clone(),
                        record_ref,
                        offset: input.offset,
                        limit: input.chunk_limit,
                    })
                    .await;
                (None, Some(record))
            }
            None => {
                if input.offset.is_some() || input.chunk_limit.is_some() {
                    return Err(ToolError::invalid_argument(
                        "`offset` and `chunk_limit` are only valid together with `record_ref`",
                    ));
                }
                let transcript_id = match (input.conversation_id, input.transcript_id) {
                    (Some(_), Some(_)) => {
                        return Err(ToolError::invalid_argument(
                            "select exactly one transcript: pass conversation_id for the \
                             Session's own transcript, or transcript_id for any listed transcript",
                        ))
                    }
                    (Some(conversation_id), None) => {
                        non_empty(&conversation_id, "conversation_id")?;
                        conversation_id
                    }
                    (None, Some(transcript_id)) => {
                        non_empty(&transcript_id, "transcript_id")?;
                        transcript_id
                    }
                    (None, None) => {
                        return Err(ToolError::invalid_argument(
                            "a transcript page needs exactly one of conversation_id or \
                             transcript_id; there is no implicit or newest selection",
                        ))
                    }
                };
                if let Some(cursor) = input.cursor.as_deref() {
                    non_empty(cursor, "cursor")?;
                }
                let page = self
                    .reader
                    .transcript_records(TranscriptRecordsRequestV1 {
                        session_id: target_session.clone(),
                        transcript_id,
                        cursor: input.cursor,
                        limit: input.limit,
                    })
                    .await;
                (Some(page), None)
            }
        };

        reply_value(&ClaudeGetTranscriptOutput {
            agent_id: target_agent,
            session_id: target_session,
            page,
            record,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::conversations::{
        ConversationActivityV1, ConversationsRequestV1, ConversationsResponseV1,
    };
    use crate::protocol::messages::{MessagesRequestV1, MessagesResponseV1};
    use crate::protocol::transcript_record::TranscriptRecordStateV1;
    use crate::protocol::transcript_records::{TranscriptRecordV1, TranscriptRecordsStateV1};
    use crate::protocol::transcripts::{TranscriptItemV1, TranscriptKindV1};
    use nession_mcp::backend::{
        ClusterBackend, NodeBackend, UnavailableClusterBackend, UnavailableNodeBackend,
    };

    struct FixtureReader;

    #[async_trait]
    impl ClaudeConversationReader for FixtureReader {
        async fn conversations(&self, _request: ConversationsRequestV1) -> ConversationsResponseV1 {
            unimplemented!("the transcript reader never lists conversations")
        }

        async fn messages(&self, _request: MessagesRequestV1) -> MessagesResponseV1 {
            unimplemented!("the transcript reader never reads a conversation")
        }

        async fn transcript_records(
            &self,
            request: TranscriptRecordsRequestV1,
        ) -> TranscriptRecordsResponseV1 {
            if request.transcript_id == "missing" {
                return TranscriptRecordsResponseV1::bare(TranscriptRecordsStateV1::NotFound);
            }
            let has_more = request.cursor.is_none();
            TranscriptRecordsResponseV1 {
                state: TranscriptRecordsStateV1::Ready,
                transcript: Some(TranscriptItemV1 {
                    id: request.transcript_id.clone(),
                    cwd: "/work".to_string(),
                    kind: TranscriptKindV1::Primary,
                    parent_id: None,
                    agent_id: None,
                    title: None,
                    preview: None,
                    created_at: None,
                    updated_at: None,
                }),
                activity: Some(ConversationActivityV1::Inactive),
                records: vec![TranscriptRecordV1 {
                    record_ref: "ref-1".to_string(),
                    offset: 0,
                    size_bytes: 1_200_000,
                    raw: None,
                }],
                next_cursor: request.cursor.map(|cursor| format!("next:{cursor}")),
                has_more,
                partial_tail: true,
                error: None,
            }
        }

        async fn transcript_record(
            &self,
            request: TranscriptRecordRequestV1,
        ) -> TranscriptRecordResponseV1 {
            if request.record_ref != "ref-1" {
                return TranscriptRecordResponseV1::bare(TranscriptRecordStateV1::NotFound);
            }
            TranscriptRecordResponseV1 {
                state: TranscriptRecordStateV1::Ready,
                record_ref: Some(request.record_ref),
                raw: Some("{\"unknown\":true}".to_string()),
                offset: request.offset.or(Some(0)),
                size_bytes: Some(1_200_000),
                has_more: Some(false),
                next_offset: Some(1_200_000),
                error: None,
            }
        }
    }

    fn context() -> ToolContext {
        let cluster: Arc<dyn ClusterBackend> =
            Arc::new(UnavailableClusterBackend::new("no server"));
        let node: Arc<dyn NodeBackend> = Arc::new(UnavailableNodeBackend::new("no agent"));
        ToolContext::new(cluster, node)
    }

    fn tool() -> NessionClaudeGetTranscript {
        NessionClaudeGetTranscript::new("agent-a", Arc::new(FixtureReader))
    }

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().expect("object").clone()
    }

    #[tokio::test]
    async fn a_conversation_page_reads_that_sessions_own_transcript() {
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
            .expect("transcript page");
        assert_eq!(reply["agent_id"], "agent-a");
        assert_eq!(reply["page"]["state"], "ready");
        assert_eq!(
            reply["page"]["transcript"]["id"],
            "550e8400-e29b-41d4-a716-446655440000"
        );
        assert_eq!(reply["page"]["records"][0]["record_ref"], "ref-1");
        assert_eq!(reply["page"]["records"][0]["size_bytes"], 1_200_000);
        assert!(
            reply["page"]["records"][0].get("raw").is_none(),
            "a large record is a placeholder, never a truncated line"
        );
        assert_eq!(reply["page"]["partial_tail"], true);
        assert!(reply.get("record").is_none());
    }

    #[tokio::test]
    async fn an_explicit_transcript_id_and_cursor_are_passed_through() {
        let reply = tool()
            .call(
                &context(),
                args(serde_json::json!({
                    "agent_id": "agent-a",
                    "session_id": "agent-a:dev",
                    "transcript_id": "parent/agent-1",
                    "cursor": "unit-cursor"
                })),
            )
            .await
            .expect("transcript page");
        assert_eq!(reply["page"]["transcript"]["id"], "parent/agent-1");
        assert_eq!(reply["page"]["next_cursor"], "next:unit-cursor");
    }

    #[tokio::test]
    async fn a_record_ref_returns_one_bounded_chunk() {
        let reply = tool()
            .call(
                &context(),
                args(serde_json::json!({
                    "agent_id": "agent-a",
                    "session_id": "agent-a:dev",
                    "record_ref": "ref-1",
                    "offset": 0,
                    "chunk_limit": 65536
                })),
            )
            .await
            .expect("record");
        assert!(reply.get("page").is_none());
        assert_eq!(reply["record"]["state"], "ready");
        assert_eq!(reply["record"]["raw"], "{\"unknown\":true}");
        assert_eq!(reply["record"]["has_more"], false);
    }

    #[tokio::test]
    async fn an_unknown_transcript_is_not_substituted() {
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
            .expect("transcript page");
        assert_eq!(reply["page"]["state"], "not_found");
        assert!(reply["page"].get("transcript").is_none());
        assert!(reply["page"].get("records").is_none());
    }

    #[tokio::test]
    async fn the_two_modes_cannot_be_mixed_or_defaulted() {
        for value in [
            // No identity at all.
            serde_json::json!({"agent_id":"agent-a","session_id":"agent-a:dev"}),
            // Both identities.
            serde_json::json!({"agent_id":"agent-a","session_id":"agent-a:dev","conversation_id":"c","transcript_id":"t"}),
            // Record mode with page arguments.
            serde_json::json!({"agent_id":"agent-a","session_id":"agent-a:dev","record_ref":"r","cursor":"c"}),
            serde_json::json!({"agent_id":"agent-a","session_id":"agent-a:dev","record_ref":"r","conversation_id":"c"}),
            serde_json::json!({"agent_id":"agent-a","session_id":"agent-a:dev","record_ref":"r","limit":10}),
            // Page mode with record arguments.
            serde_json::json!({"agent_id":"agent-a","session_id":"agent-a:dev","conversation_id":"c","offset":0}),
            serde_json::json!({"agent_id":"agent-a","session_id":"agent-a:dev","conversation_id":"c","chunk_limit":10}),
            // Blank identities and cursors.
            serde_json::json!({"agent_id":"agent-a","session_id":"agent-a:dev","conversation_id":" "}),
            serde_json::json!({"agent_id":"agent-a","session_id":"agent-a:dev","transcript_id":" "}),
            serde_json::json!({"agent_id":"agent-a","session_id":"agent-a:dev","conversation_id":"c","cursor":" "}),
            serde_json::json!({"agent_id":"agent-a","session_id":"agent-a:dev","record_ref":" "}),
            // Foreign target and unexpected key.
            serde_json::json!({"agent_id":"agent-b","session_id":"agent-b:dev","conversation_id":"c"}),
            serde_json::json!({"agent_id":"agent-a","session_id":"agent-a:dev","conversation_id":"c","extra":true}),
        ] {
            let error = tool()
                .call(&context(), args(value))
                .await
                .expect_err("invalid transcript request");
            assert_eq!(error.kind, nession_mcp::ToolErrorKind::InvalidArgument);
        }
    }

    #[test]
    fn the_contract_advertises_both_modes_without_exposing_a_path() {
        let schema = tool().input_schema();
        assert_eq!(schema["additionalProperties"], false);
        let required = schema["required"].as_array().expect("required");
        for field in ["agent_id", "session_id"] {
            assert!(required.iter().any(|name| name == field), "{field}");
        }
        let output = tool().output_schema();
        for field in ["agent_id", "session_id", "page", "record"] {
            assert!(
                output["properties"].get(field).is_some(),
                "missing output field {field}"
            );
        }
        let rendered = serde_json::to_string(&output).expect("schema");
        assert!(
            !rendered.contains("\"path\""),
            "the output contract must not expose a transcript path: {rendered}"
        );
    }
}
