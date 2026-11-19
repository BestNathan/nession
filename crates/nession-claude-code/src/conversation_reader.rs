//! The typed reader seam for the **existing** Conversation/Transcript Protocol
//! Units (`#3779` P3).
//!
//! `nession_claude_list_conversations`, `nession_claude_get_conversation` and
//! `nession_claude_get_transcript` must expose what this provider already
//! answers through `claude-code.conversations`, `claude-code.messages`,
//! `claude-code.transcript-records` and `claude-code.transcript-record`
//! (`#1222`, `#1234`, `#3726`). This module is deliberately only a seam: it
//! routes a typed request to the same [`ClaudeCodeAgentExtension`] handler the
//! Agent's Protocol routing uses, and deserializes that handler's typed reply.
//! There is no second discovery, selection, pagination or raw-record parser
//! here, so the MCP Tools cannot drift from the conversation UI's answers.
//!
//! A handler that cannot answer (an internal composition failure rather than a
//! Session read state) is reported as the unit's own `error` state, never as an
//! MCP transport error: a caller who asked "what is in this conversation" gets
//! the provider's answer, and no other conversation is substituted for it.

use async_trait::async_trait;
use nession_common::extension::AgentExtension;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::agent::ClaudeCodeAgentExtension;
use crate::protocol::conversations::{self, ConversationsRequestV1, ConversationsResponseV1};
use crate::protocol::messages::{self as messages_protocol, MessagesRequestV1, MessagesResponseV1};
use crate::protocol::transcript_record::{
    self, TranscriptRecordRequestV1, TranscriptRecordResponseV1,
};
use crate::protocol::transcript_records::{
    self, TranscriptRecordsRequestV1, TranscriptRecordsResponseV1,
};

/// The Agent-supplied reader behind the three Conversation/Transcript MCP
/// Tools.
///
/// Each method is the owning unit's own answer to one typed request. The trait
/// exists so the Tools can be tested without a live tmux Session and so the
/// Agent host, rather than the Tool, remains the execution authority.
#[async_trait]
pub trait ClaudeConversationReader: Send + Sync {
    /// `claude-code.conversations`: the current-Session cwd-scoped list.
    async fn conversations(&self, request: ConversationsRequestV1) -> ConversationsResponseV1;

    /// `claude-code.messages`: one explicitly named conversation's page.
    async fn messages(&self, request: MessagesRequestV1) -> MessagesResponseV1;

    /// `claude-code.transcript-records`: one raw JSONL page.
    async fn transcript_records(
        &self,
        request: TranscriptRecordsRequestV1,
    ) -> TranscriptRecordsResponseV1;

    /// `claude-code.transcript-record`: one bounded chunk of a large record.
    async fn transcript_record(
        &self,
        request: TranscriptRecordRequestV1,
    ) -> TranscriptRecordResponseV1;
}

/// Serialize one typed request, call the owning unit, and deserialize its typed
/// reply.
///
/// Both failure directions become the unit's `error` state via `on_error`;
/// neither invents a different conversation or a different record.
async fn read_unit<S, R>(
    extension: &ClaudeCodeAgentExtension,
    command: &str,
    request: S,
    on_error: fn(String) -> R,
) -> R
where
    S: Serialize,
    R: DeserializeOwned,
{
    let payload = match serde_json::to_value(request) {
        Ok(payload) => payload,
        Err(error) => return on_error(format!("bad_request: {error}")),
    };
    let reply: Value = match extension.handle_command(command, payload).await {
        Ok(reply) => reply,
        Err(error) => return on_error(format!("unavailable: {error}")),
    };
    match serde_json::from_value(reply) {
        Ok(reply) => reply,
        Err(error) => on_error(format!("bad_reply: {error}")),
    }
}

#[async_trait]
impl ClaudeConversationReader for ClaudeCodeAgentExtension {
    async fn conversations(&self, request: ConversationsRequestV1) -> ConversationsResponseV1 {
        read_unit(
            self,
            conversations::COMMAND,
            request,
            ConversationsResponseV1::error,
        )
        .await
    }

    async fn messages(&self, request: MessagesRequestV1) -> MessagesResponseV1 {
        read_unit(
            self,
            messages_protocol::COMMAND,
            request,
            MessagesResponseV1::error,
        )
        .await
    }

    async fn transcript_records(
        &self,
        request: TranscriptRecordsRequestV1,
    ) -> TranscriptRecordsResponseV1 {
        read_unit(
            self,
            transcript_records::COMMAND,
            request,
            TranscriptRecordsResponseV1::error,
        )
        .await
    }

    async fn transcript_record(
        &self,
        request: TranscriptRecordRequestV1,
    ) -> TranscriptRecordResponseV1 {
        read_unit(
            self,
            transcript_record::COMMAND,
            request,
            TranscriptRecordResponseV1::error,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::conversations::ConversationsStateV1;
    use crate::protocol::messages::MessagesStateV1;
    use crate::protocol::transcript_record::TranscriptRecordStateV1;
    use crate::protocol::transcript_records::TranscriptRecordsStateV1;
    use crate::session_context::NoSessionContext;
    use std::sync::Arc;

    fn extension() -> ClaudeCodeAgentExtension {
        ClaudeCodeAgentExtension::new(Arc::new(NoSessionContext))
    }

    #[tokio::test]
    async fn each_reader_method_returns_the_unit_answer_not_an_invented_one() {
        let extension = extension();

        let list = extension
            .conversations(ConversationsRequestV1 {
                session_id: "agent-a:dev".into(),
                cursor: None,
                limit: None,
            })
            .await;
        assert_eq!(list.state, ConversationsStateV1::Unavailable);
        assert!(list.items.is_empty());

        let messages = extension
            .messages(MessagesRequestV1 {
                session_id: "agent-a:dev".into(),
                conversation_id: "550e8400-e29b-41d4-a716-446655440000".into(),
                cursor: None,
                limit: None,
            })
            .await;
        assert_eq!(messages.state, MessagesStateV1::Unavailable);
        assert!(messages.conversation.is_none(), "no substitute selection");

        let page = extension
            .transcript_records(TranscriptRecordsRequestV1 {
                session_id: "agent-a:dev".into(),
                transcript_id: "550e8400-e29b-41d4-a716-446655440000".into(),
                cursor: None,
                limit: None,
            })
            .await;
        assert_eq!(page.state, TranscriptRecordsStateV1::Unavailable);
        assert!(page.records.is_empty());

        let record = extension
            .transcript_record(TranscriptRecordRequestV1 {
                session_id: "agent-a:dev".into(),
                record_ref: "not-a-reference".into(),
                offset: None,
                limit: None,
            })
            .await;
        assert_eq!(record.state, TranscriptRecordStateV1::NotFound);
        assert!(record.raw.is_none());
    }

    #[test]
    fn every_unit_reply_round_trips_through_its_typed_contract() {
        // The reader deserializes the handler's serialized reply. These types
        // therefore have to be `Deserialize` as well as `Serialize`, and an
        // added response field that cannot be read back is a contract failure
        // rather than a silently dropped fact.
        let replies = [
            serde_json::to_value(ConversationsResponseV1::bare(ConversationsStateV1::Ready))
                .unwrap(),
            serde_json::to_value(MessagesResponseV1::bare(MessagesStateV1::Ready)).unwrap(),
            serde_json::to_value(TranscriptRecordsResponseV1::bare(
                TranscriptRecordsStateV1::Ready,
            ))
            .unwrap(),
            serde_json::to_value(TranscriptRecordResponseV1::bare(
                TranscriptRecordStateV1::Ready,
            ))
            .unwrap(),
        ];
        assert_eq!(replies.len(), 4);
        assert!(serde_json::from_value::<ConversationsResponseV1>(replies[0].clone()).is_ok());
        assert!(serde_json::from_value::<MessagesResponseV1>(replies[1].clone()).is_ok());
        assert!(serde_json::from_value::<TranscriptRecordsResponseV1>(replies[2].clone()).is_ok());
        assert!(serde_json::from_value::<TranscriptRecordResponseV1>(replies[3].clone()).is_ok());
    }
}
