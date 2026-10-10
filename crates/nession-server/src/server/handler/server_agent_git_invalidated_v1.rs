//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::*;

impl ConnectionHandler {
    /// Handle `agent.terminal.resize` — broadcast terminal resize to all
    /// web clients attached to the session via relay.
    ///
    /// Authorized the same way as the other agent-originated state: the sending
    /// connection must be the agent's current generation, and the session it
    /// names must be one of *its own*. This handler used to check nothing at
    /// all — it read `session_id` and broadcast — which made it the one
    /// agent-originated wire where a connection registered as `A` could move
    /// state belonging to `B`, and where a superseded connection could still
    /// drive a session it no longer served (#960).
    ///
    /// The session check reads the id's own structure rather than a registry
    /// lookup: session ids are `agent_id:session_name` (see
    /// `crate::registry::session`), so the prefix is whose screen this is. A
    /// resize for a session the registry has never heard of is not refused —
    /// the resize is a level, and a client attached to a session the registry
    /// has not caught up with is still a client that needs the size.
    pub(super) async fn handle_agent_git_invalidated(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let value = msg.payload;
        let Some(agent_id) = self
            .authorized_agent_id(&value, "server.agent.git-invalidated")
            .await
        else {
            return Ok(HandlerAction::Reply(None));
        };
        let payload: nession_protocol::contracts::session::v1::AgentGitInvalidatedPayload =
            match serde_json::from_value(value) {
                Ok(p) => p,
                Err(e) => {
                    warn!("server.agent.git-invalidated with invalid payload: {}", e);
                    return Ok(HandlerAction::Reply(None));
                }
            };
        if payload.agent_id != agent_id {
            return Ok(HandlerAction::Reply(None));
        }
        if payload.session.is_empty() {
            return Ok(HandlerAction::Reply(None));
        }
        self.web_client_registry.broadcast_git_invalidated(payload);
        Ok(HandlerAction::Reply(None))
    }
}
