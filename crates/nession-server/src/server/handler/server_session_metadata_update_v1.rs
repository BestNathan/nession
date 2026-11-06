//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    metadata_reply, metadata_response, ConnectionHandler, HandlerAction, ProtocolMessage,
    WebSessionMetadataUpdatePayload,
};

impl ConnectionHandler {
    /// Handle `server.session.metadata.update` — forward a revision-guarded
    /// replacement to the Session's Agent.
    pub(super) async fn handle_client_session_metadata_update(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let Ok(payload) = serde_json::from_value::<WebSessionMetadataUpdatePayload>(msg.payload)
        else {
            return Ok(metadata_reply(
                &msg.id,
                "server.session.metadata.update",
                super::metadata_refusal(
                    "invalid",
                    "session_id and the metadata fields are required",
                ),
            ));
        };

        let (agent_id, session_name) = match self
            .resolve_session_metadata_target(&payload.session_id)
            .await
        {
            Ok(target) => target,
            Err(response) => {
                return Ok(metadata_reply(
                    &msg.id,
                    "server.session.metadata.update",
                    response,
                ));
            }
        };

        let response = self
            .agent_command(
                &agent_id,
                "agent.session.metadata.update",
                serde_json::json!({
                    "name": session_name,
                    "title": payload.title,
                    "description": payload.description,
                    "tags": payload.tags,
                    "expected_revision": payload.expected_revision,
                }),
            )
            .await;
        Ok(metadata_reply(
            &msg.id,
            "server.session.metadata.update",
            metadata_response(response),
        ))
    }
}
