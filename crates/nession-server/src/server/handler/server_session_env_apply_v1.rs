//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    session_env_reply, ClientSessionEnvApplyPayload, ClientSessionEnvResponsePayload,
    ConnectionHandler, HandlerAction, ProtocolMessage,
};

impl ConnectionHandler {
    /// Handle `server.session.env.apply` — the pre-#170 per-file apply unit.
    ///
    /// **Compatibility adapter.** The canonical model is a whole-binding
    /// replacement; this adds the named files to the Session's current desired
    /// selection and materializes the result as one revision. It is never the
    /// authority the canonical units use, and it does not make the call an
    /// attach-owned operation.
    pub(super) async fn handle_client_session_env_apply(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(session_env_reply(
                &msg.id,
                "server.session.env.apply",
                ClientSessionEnvResponsePayload {
                    success: false,
                    error: Some("Not authenticated".to_string()),
                    warnings: Vec::new(),
                },
            ));
        }
        let Ok(ClientSessionEnvApplyPayload {
            session_id,
            env_files,
        }) = serde_json::from_value(msg.payload)
        else {
            return Ok(session_env_reply(
                &msg.id,
                "server.session.env.apply",
                ClientSessionEnvResponsePayload {
                    success: false,
                    error: Some("session_id is required".to_string()),
                    warnings: Vec::new(),
                },
            ));
        };

        let mut refs = match self.env_service.bindings.get(&session_id).await {
            Ok(Some(record)) => record
                .profiles
                .into_iter()
                .map(|profile| profile.profile)
                .collect::<Vec<_>>(),
            Ok(None) => Vec::new(),
            Err(e) => {
                return Ok(session_env_reply(
                    &msg.id,
                    "server.session.env.apply",
                    ClientSessionEnvResponsePayload {
                        success: false,
                        error: Some(format!("could not read the Session binding: {e:#}")),
                        warnings: Vec::new(),
                    },
                ))
            }
        };
        refs.extend(env_files);

        match self.set_session_binding(&session_id, &refs, "attach").await {
            Ok((warnings, error, _binding)) => Ok(session_env_reply(
                &msg.id,
                "server.session.env.apply",
                ClientSessionEnvResponsePayload {
                    success: error.is_none(),
                    error,
                    warnings,
                },
            )),
            Err(error) => Ok(session_env_reply(
                &msg.id,
                "server.session.env.apply",
                ClientSessionEnvResponsePayload {
                    success: false,
                    error: Some(error),
                    warnings: Vec::new(),
                },
            )),
        }
    }
}
