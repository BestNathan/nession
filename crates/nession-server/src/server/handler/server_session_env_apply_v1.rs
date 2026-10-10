//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    session_env_reply, ClientSessionEnvApplyPayload, ClientSessionEnvResponsePayload,
    ConnectionHandler, HandlerAction, ProtocolMessage,
};

impl ConnectionHandler {
    /// Handle `server.session.env.apply` — apply env files to a running session.
    pub(super) async fn handle_client_session_env_apply(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary. `refs` used to be read beside a
        // `session_id` also read by hand; both are fields of the payload the
        // contract already described.
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
        let ClientSessionEnvApplyPayload {
            session_id,
            env_files: refs,
        } = serde_json::from_value(msg.payload).unwrap_or_else(|_| ClientSessionEnvApplyPayload {
            session_id: String::new(),
            env_files: Vec::new(),
        });

        match self.source_env_into_session(&session_id, &refs).await {
            Ok(warnings) => {
                // An explicit apply is a new attachment. The forced-write
                // re-source is not — that session already had the file — which
                // is why usage is recorded here rather than in the helper.
                self.env_service
                    .usage
                    .record_attach(&session_id, &refs, None);
                Ok(session_env_reply(
                    &msg.id,
                    "server.session.env.apply",
                    ClientSessionEnvResponsePayload {
                        success: true,
                        error: None,
                        warnings,
                    },
                ))
            }
            Err(e) => Ok(session_env_reply(
                &msg.id,
                "server.session.env.apply",
                ClientSessionEnvResponsePayload {
                    success: false,
                    error: Some(e),
                    warnings: Vec::new(),
                },
            )),
        }
    }
}
