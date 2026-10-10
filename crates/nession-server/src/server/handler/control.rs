//! Control is not a Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{info, warn, Arc, ConnectionHandler, HandlerAction, ProtocolMessage};

impl ConnectionHandler {
    /// Handle `control.heartbeat`.
    ///
    /// Named for the wire rather than for the agent, because the wire no longer
    /// names one: it used to be `server.agent.heartbeat`, which read as "the
    /// server answers this" and stopped being true when the acknowledgement was
    /// recognised as a message of its own.
    ///
    /// The agent it belongs to comes from the connection, not from the payload
    /// — see `authorized_agent_id`.
    pub(super) async fn handle_control_heartbeat(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let payload: serde_json::Value = msg.payload;
        let Some(agent_id) = self
            .authorized_agent_id(&payload, "control.heartbeat")
            .await
        else {
            return Ok(HandlerAction::Reply(None));
        };

        if self.agent_registry.get(&agent_id).await.is_none() {
            warn!("Heartbeat from unregistered agent: {}", agent_id);
            return Ok(HandlerAction::Reply(None));
        }

        let session_count = u32::try_from(
            payload
                .get("session_count")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
        )
        .unwrap_or(0);
        let active_sessions = u32::try_from(
            payload
                .get("active_sessions")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
        )
        .unwrap_or(0);

        info!(
            "Heartbeat from {}: sessions={}, active={}",
            agent_id, session_count, active_sessions
        );

        // Update agent metadata if provided (keeps version/tmux/OS current
        // after agent upgrades — previously only sent on register).
        if let Some(agent_meta) = payload
            .get("metadata")
            .and_then(|v| v.get("agent"))
            .and_then(|v| serde_json::from_value(v.clone()).ok())
        {
            self.agent_registry
                .update_metadata(&agent_id, agent_meta)
                .await;
        }

        let changed = self
            .agent_registry
            .update_heartbeat(&agent_id, session_count, active_sessions)
            .await;

        // Push updated agent state to all connected web dashboard clients
        // only when a meaningful field changed (status, session counts).
        // Timestamp-only heartbeats don't need a broadcast.
        if changed {
            self.web_client_registry
                .broadcast_agents_changed(Arc::clone(&self.agent_registry))
                .await;
        }

        // Nothing is sent back. There used to be an acknowledgement here, on a
        // wire of its own (`server.heartbeat.ack`), and it was removed rather
        // than renamed: **control has no acknowledgement**. A heartbeat is a
        // one-way statement — `control.heartbeat` — so an ack is not a reply
        // the protocol owes anyone, and the agent's handler for it logged and
        // returned, which is what a message sent for no one's benefit looks
        // like. (The "miss counter" an older comment here said the ack reset
        // does not exist in `nession-agent` either; nothing was reset.)
        Ok(HandlerAction::Reply(None))
    }
}
