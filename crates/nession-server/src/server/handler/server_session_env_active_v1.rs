//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::*;

impl ConnectionHandler {
    /// Handle `server.session.env.active` — list env files active on a session.
    pub(super) async fn handle_client_session_env_active(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary. One shape with an optional error, so
        // unlike the session-list reply there is nothing to discriminate on.
        if !self.authenticated_client {
            return Ok(session_env_active_reply(
                &msg.id,
                SessionEnvActiveResponse {
                    active: Vec::new(),
                    error: Some("Not authenticated".to_string()),
                },
            ));
        }
        let ClientSessionEnvActivePayload { session_id } = serde_json::from_value(msg.payload)
            .unwrap_or_else(|_| ClientSessionEnvActivePayload {
                session_id: String::new(),
            });
        let active = self.env_service.usage.active_for(&session_id);
        Ok(session_env_active_reply(
            &msg.id,
            SessionEnvActiveResponse {
                active,
                error: None,
            },
        ))
    }
}
