//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    session_env_binding_reply, ClientSessionEnvBindingReapplyPayload,
    ClientSessionEnvBindingResponsePayload, ConnectionHandler, HandlerAction, ProtocolMessage,
};

impl ConnectionHandler {
    /// Handle `server.session.env.binding.reapply` — re-resolve the currently
    /// desired profiles and materialize a new revision.
    ///
    /// This is the explicit operation after a profile edit. An ordinary save
    /// does not advance any Session's materialization.
    pub(super) async fn handle_client_session_env_binding_reapply(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let refusal = |error: &str| {
            session_env_binding_reply(
                &msg.id,
                "server.session.env.binding.reapply",
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
        let Ok(ClientSessionEnvBindingReapplyPayload { session_id }) =
            serde_json::from_value(msg.payload)
        else {
            return Ok(refusal("session_id is required"));
        };
        if session_id.is_empty() {
            return Ok(refusal("session_id is required"));
        }

        let record = match self.env_service.bindings.get(&session_id).await {
            Ok(Some(record)) => record,
            Ok(None) => {
                // Reapplying an empty binding is a valid no-op; there is
                // nothing to resolve and no revision to advance.
                let binding = self.session_binding_state(&session_id).await;
                return Ok(session_env_binding_reply(
                    &msg.id,
                    "server.session.env.binding.reapply",
                    ClientSessionEnvBindingResponsePayload {
                        success: true,
                        binding: Some(binding),
                        warnings: Vec::new(),
                        error: None,
                    },
                ));
            }
            Err(error) => return Ok(refusal(&format!("could not read the binding: {error:#}"))),
        };

        let refs: Vec<_> = record
            .profiles
            .iter()
            .map(|profile| profile.profile.clone())
            .collect();
        match self
            .set_session_binding(&session_id, &refs, "reapply")
            .await
        {
            Ok((warnings, error, binding)) => Ok(session_env_binding_reply(
                &msg.id,
                "server.session.env.binding.reapply",
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
