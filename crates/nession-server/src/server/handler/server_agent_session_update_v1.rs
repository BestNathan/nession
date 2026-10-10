//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{warn, info, ConnectionHandler, ProtocolMessage, HandlerAction};

impl ConnectionHandler {
    /// Handle `server.agent.session-update` — the agent reporting the state of
    /// one of its tmux sessions.
    ///
    /// The agent it belongs to comes from the connection, not from the payload
    /// — see `authorized_agent_id`. Session ids are `agent_id:session_name`, so the
    /// payload's id decides which *namespace* the update writes into; a
    /// connection registered as `A` reporting for `B` would otherwise rewrite
    /// another agent's session list.
    pub(super) async fn handle_agent_session_update(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let payload: serde_json::Value = msg.payload;
        let Some(agent_id) = self
            .authorized_agent_id(&payload, "server.agent.session-update")
            .await
        else {
            return Ok(HandlerAction::Reply(None));
        };
        let session_name = payload
            .get("session_name")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let status_str = payload.get("status").and_then(|v| v.as_str()).unwrap_or("");

        if self.agent_registry.get(&agent_id).await.is_none() {
            warn!("Session update from unregistered agent: {}", agent_id);
            return Ok(HandlerAction::Reply(None));
        }

        let session_id = format!("{agent_id}:{session_name}");

        if status_str == "gone" {
            info!("Session {} removed (agent: {})", session_name, agent_id);
            self.session_registry.remove(&session_id).await;
            // Release any env usage locks held by this session so the env
            // files can be edited/deleted again. Without this, externally
            // killed sessions leave stale locks in memory.
            self.env_service.usage.clear_session(&session_id);
            self.broadcast_sessions().await;
            return Ok(HandlerAction::Reply(None));
        }

        let status = match status_str {
            "active" => crate::registry::session::SessionStatus::Active,
            "detached" => crate::registry::session::SessionStatus::Detached,
            "recovering" => crate::registry::session::SessionStatus::Recovering,
            "orphaned" => crate::registry::session::SessionStatus::Orphaned,
            "zombie" => crate::registry::session::SessionStatus::Zombie,
            _ => {
                warn!("Unknown session status '{}' for {}", status_str, session_id);
                return Ok(HandlerAction::Reply(None));
            }
        };

        let window_count = u32::try_from(
            payload
                .get("window_count")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
        )
        .unwrap_or(0);
        let attached_clients = u32::try_from(
            payload
                .get("attached_clients")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
        )
        .unwrap_or(0);

        let foreground_command = payload
            .get("foreground_command")
            .and_then(serde_json::Value::as_str)
            .filter(|command| !command.is_empty())
            .map(std::string::ToString::to_string);
        let working_dir = payload
            .get("working_dir")
            .and_then(serde_json::Value::as_str)
            .filter(|p| !p.is_empty())
            .map(std::string::ToString::to_string);

        let session_info = crate::registry::session::SessionInfo {
            session_id: session_id.clone(),
            agent_id: agent_id.clone(),
            session_name: session_name.to_string(),
            status,
            window_count,
            attached_clients,
            foreground_command,
            working_dir,
            created_at: chrono::Utc::now(),
            last_activity: chrono::Utc::now(),
        };

        info!(
            "Session {} updated (agent: {}, status: {:?}, windows: {}, clients: {})",
            session_name, agent_id, session_info.status, window_count, attached_clients
        );
        self.session_registry.update_session(session_info).await;
        self.broadcast_sessions().await;

        Ok(HandlerAction::Reply(None))
    }
}
