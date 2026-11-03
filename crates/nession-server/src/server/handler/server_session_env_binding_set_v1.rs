//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    session_env_binding_reply, ClientSessionEnvBindingResponsePayload,
    ClientSessionEnvBindingSetPayload, ConnectionHandler, HandlerAction, ProtocolMessage,
};

impl ConnectionHandler {
    /// Handle `server.session.env.binding.set` — replace a Session's whole
    /// Environment Binding.
    ///
    /// The unit is a replacement, not an apply/unset sequence: the caller names
    /// the complete ordered selection and the Server resolves it as one
    /// revision. An empty list clears the binding.
    pub(super) async fn handle_client_session_env_binding_set(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let refusal = |error: &str| {
            session_env_binding_reply(
                &msg.id,
                "server.session.env.binding.set",
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
        let Ok(ClientSessionEnvBindingSetPayload {
            session_id,
            profiles,
        }) = serde_json::from_value(msg.payload)
        else {
            return Ok(refusal("session_id is required"));
        };
        if session_id.is_empty() {
            return Ok(refusal("session_id is required"));
        }

        match self
            .set_session_binding(&session_id, &profiles, "attach")
            .await
        {
            Ok((warnings, error, binding)) => Ok(session_env_binding_reply(
                &msg.id,
                "server.session.env.binding.set",
                ClientSessionEnvBindingResponsePayload {
                    success: error.is_none(),
                    binding: Some(binding),
                    warnings,
                    error,
                },
            )),
            Err(error) => Ok(refusal(&error)),
        }
    }
}
