//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    session_env_active_reply, ClientSessionEnvActivePayload, ConnectionHandler, HandlerAction,
    ProtocolMessage, SessionEnvActiveResponse,
};

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
        // Visibility is a projection of the desired binding, not of an
        // in-memory usage index. An empty binding is a valid empty projection.
        let (active, error) = match self.env_service.bindings.get(&session_id).await {
            Ok(record) => (record.map_or_else(Vec::new, |record| record.active()), None),
            Err(e) => (
                Vec::new(),
                Some(format!("could not read the Session binding: {e:#}")),
            ),
        };
        Ok(session_env_active_reply(
            &msg.id,
            SessionEnvActiveResponse { active, error },
        ))
    }
}
