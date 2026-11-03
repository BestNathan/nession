//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    session_env_binding_reply, ClientSessionEnvBindingGetPayload,
    ClientSessionEnvBindingResponsePayload, ConnectionHandler, HandlerAction, ProtocolMessage,
};

impl ConnectionHandler {
    /// Handle `server.session.env.binding.get` — read desired + observed state.
    pub(super) async fn handle_client_session_env_binding_get(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let refusal = |error: &str| {
            session_env_binding_reply(
                &msg.id,
                "server.session.env.binding.get",
                ClientSessionEnvBindingResponsePayload {
                    success: false,
                    binding: None,
                    warnings: Vec::new(),
                    error: Some(error.to_string()),
                },
            )
        };
        if !self.authenticated_client {
            return Ok(refusal("Not authenticated"));
        }
        let Ok(ClientSessionEnvBindingGetPayload { session_id }) =
            serde_json::from_value(msg.payload)
        else {
            return Ok(refusal("session_id is required"));
        };
        if session_id.is_empty() {
            return Ok(refusal("session_id is required"));
        }

        let binding = self.session_binding_state(&session_id).await;
        Ok(session_env_binding_reply(
            &msg.id,
            "server.session.env.binding.get",
            ClientSessionEnvBindingResponsePayload {
                success: true,
                binding: Some(binding),
                warnings: Vec::new(),
                error: None,
            },
        ))
    }
}
