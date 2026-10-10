//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{warn, info, ConnectionHandler, ProtocolMessage, HandlerAction, session_list_reply, ServerSessionListReply, SessionRefusal, ServerSessionListPayload, session_to_json, WebSessionInfo, session_to_info, WebSessionsListResponse};

impl ConnectionHandler {
    /// Handle `server.session.list` - returns all sessions, optionally filtered by agent_id.
    ///
    /// With `force: true` the server first queries every online agent for its
    /// live tmux state and rebuilds the registry from the answers, so the
    /// client gets strongly-consistent data instead of whatever the last
    /// watcher poll happened to leave behind. Agents that fail to answer keep
    /// their existing entries and are named in `stale_agents`.
    pub(super) async fn handle_client_sessions_list(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Typed at the contract boundary. The refusal branch used to be built
        // by hand because no contract described it — eleven handlers reply this
        // shape and none of them declared it.
        if !self.authenticated_client {
            warn!("Unauthenticated client requested sessions list");
            return Ok(session_list_reply(
                &msg.id,
                ServerSessionListReply::Refused(SessionRefusal {
                    status: "error".to_string(),
                    message: "Not authenticated".to_string(),
                }),
            ));
        }

        let payload: ServerSessionListPayload =
            serde_json::from_value(msg.payload).unwrap_or_default();
        let agent_id = payload.agent_id.as_deref();
        let force = payload.force;

        let stale_agents = if force {
            let stale = self.refresh_sessions_from_agents(agent_id).await;
            // The rebuild may have changed the list for everyone, not just the
            // requester — push it so other open browsers converge too.
            self.broadcast_sessions().await;
            stale
        } else {
            Vec::new()
        };

        let sessions = if let Some(aid) = agent_id {
            self.session_registry.list_by_agent(aid).await
        } else {
            self.session_registry.list().await
        };

        let sessions_json: Vec<serde_json::Value> = sessions.iter().map(session_to_json).collect();
        let sessions: Vec<WebSessionInfo> = sessions.iter().map(session_to_info).collect();

        info!(
            "Client requested sessions list (force: {}), returning {} sessions, {} stale agent(s)",
            force,
            sessions_json.len(),
            stale_agents.len()
        );

        Ok(session_list_reply(
            &msg.id,
            ServerSessionListReply::Listed(WebSessionsListResponse {
                sessions,
                stale_agents,
            }),
        ))
    }
}
