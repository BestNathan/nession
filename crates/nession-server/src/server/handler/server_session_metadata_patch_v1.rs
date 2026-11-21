//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    metadata_reply, metadata_response, ConnectionHandler, HandlerAction, ProtocolMessage,
    WebSessionMetadataPatchPayload,
};

impl ConnectionHandler {
    /// Handle `server.session.metadata.patch` — forward a partial update with
    /// its incarnation/revision preconditions to the Session's Agent.
    ///
    /// The merge happens at the Agent, the metadata's only writer: the Server
    /// neither reads the current value nor resolves the patch itself (#4007).
    pub(super) async fn handle_client_session_metadata_patch(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let Ok(payload) = serde_json::from_value::<WebSessionMetadataPatchPayload>(msg.payload)
        else {
            return Ok(metadata_reply(
                &msg.id,
                "server.session.metadata.patch",
                super::metadata_refusal(
                    "invalid",
                    "session_id, expected_instance_id, expected_revision and patch are required",
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
                    "server.session.metadata.patch",
                    response,
                ));
            }
        };

        let response = self
            .agent_command(
                &agent_id,
                "agent.session.metadata.patch",
                serde_json::json!({
                    "name": session_name,
                    "expected_instance_id": payload.expected_instance_id,
                    "expected_revision": payload.expected_revision,
                    "patch": payload.patch,
                }),
            )
            .await;
        Ok(metadata_reply(
            &msg.id,
            "server.session.metadata.patch",
            metadata_response(response),
        ))
    }
}
