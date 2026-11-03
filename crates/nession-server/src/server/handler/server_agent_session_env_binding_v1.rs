//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{warn, ConnectionHandler, HandlerAction, ProtocolMessage};

impl ConnectionHandler {
    /// Handle `server.agent.session-env-binding` — an Agent reporting the
    /// observed binding state of its live Sessions.
    ///
    /// One-way, like `server.agent.session-update`: the Server updates its
    /// observed cache and answers nothing. The Agent's report is what makes a
    /// Server restart recover the observed half of a binding whose tmux Session
    /// survived.
    pub(super) async fn handle_agent_session_env_binding(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let Some(agent_id) = self
            .authorized_agent_id(&msg.payload, "server.agent.session-env-binding")
            .await
        else {
            return Ok(HandlerAction::Reply(None));
        };

        let sessions = msg
            .payload
            .get("sessions")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        let mut updated = 0usize;
        for entry in sessions {
            let Some(session_name) = entry.get("session_name").and_then(|v| v.as_str()) else {
                warn!("Session env binding report without a session_name from {agent_id}");
                continue;
            };
            let Some(observed) = entry.get("observed").cloned() else {
                continue;
            };
            let Ok(observed) = serde_json::from_value::<
                nession_protocol::contracts::env::v1::SessionEnvObservedState,
            >(observed) else {
                warn!("Session env binding report for {agent_id}:{session_name} is malformed");
                continue;
            };
            let session_id = format!("{agent_id}:{session_name}");
            // A state file can outlive a tmux Session after an Agent crash.
            // Only a Session the Server's registry still knows is a live claim.
            if self.session_registry.get(&session_id).await.is_none() {
                continue;
            }
            self.env_service.observed.set(&session_id, observed);
            updated += 1;
        }

        tracing::debug!("Agent {agent_id} reported env binding state for {updated} Session(s)");
        Ok(HandlerAction::Reply(None))
    }
}
