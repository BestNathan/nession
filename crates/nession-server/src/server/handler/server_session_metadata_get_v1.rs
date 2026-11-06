//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    metadata_reply, metadata_response, ConnectionHandler, HandlerAction, ProtocolMessage,
    WebSessionMetadataGetPayload,
};

impl ConnectionHandler {
    /// Handle `server.session.metadata.get` — read one Session's metadata from
    /// its Agent. The Agent owns the store; the Server only authorizes and
    /// routes.
    pub(super) async fn handle_client_session_metadata_get(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let Ok(WebSessionMetadataGetPayload { session_id }) =
            serde_json::from_value::<WebSessionMetadataGetPayload>(msg.payload)
        else {
            return Ok(metadata_reply(
                &msg.id,
                "server.session.metadata.get",
                super::metadata_refusal("invalid", "session_id is required"),
            ));
        };

        let (agent_id, session_name) = match self.resolve_session_metadata_target(&session_id).await
        {
            Ok(target) => target,
            Err(response) => {
                return Ok(metadata_reply(
                    &msg.id,
                    "server.session.metadata.get",
                    response,
                ));
            }
        };

        let response = self
            .agent_command(
                &agent_id,
                "agent.session.metadata.get",
                serde_json::json!({ "name": session_name }),
            )
            .await;
        Ok(metadata_reply(
            &msg.id,
            "server.session.metadata.get",
            metadata_response(response),
        ))
    }
}
