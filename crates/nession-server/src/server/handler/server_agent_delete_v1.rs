//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    current_timestamp, info, json, AgentStatus, Arc, ConnectionHandler, HandlerAction, Message,
    ProtocolMessage,
};

impl ConnectionHandler {
    /// Handle `server.agent.delete` — permanently remove an offline agent and its sessions.
    /// Rejects if the agent is online or degraded.
    pub(super) async fn handle_client_agent_delete(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.agent.delete",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "success": false,
                        "error": "Not authenticated"
                    }
                })
                .to_string(),
            ))));
        }

        let agent_id = msg
            .payload
            .get("agent_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if agent_id.is_empty() {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.agent.delete",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "success": false,
                        "error": "agent_id is required"
                    }
                })
                .to_string(),
            ))));
        }

        // Check agent exists and is offline.
        let agent = match self.agent_registry.get(agent_id).await {
            Some(a) => a,
            None => {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "server.agent.delete",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "success": false,
                            "error": format!("Agent '{}' not found", agent_id)
                        }
                    })
                    .to_string(),
                ))));
            }
        };

        if agent.status != AgentStatus::Offline {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.agent.delete",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "success": false,
                        "error": format!(
                            "Agent '{}' is {} — only offline agents can be deleted",
                            agent_id,
                            match agent.status {
                                AgentStatus::Online => "online",
                                AgentStatus::Degraded => "degraded",
                                AgentStatus::Offline => "offline",
                            }
                        )
                    }
                })
                .to_string(),
            ))));
        }

        info!("Deleting offline agent {} and its sessions", agent_id);

        // Delete sessions from DB, then agent from DB.
        if let Err(e) = self.db.delete_sessions_by_agent(agent_id).await {
            tracing::error!("Failed to delete sessions for agent {}: {:?}", agent_id, e);
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.agent.delete",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "success": false,
                        "error": format!("Failed to delete sessions: {e}")
                    }
                })
                .to_string(),
            ))));
        }

        if let Err(e) = self.db.delete_agent(agent_id).await {
            tracing::error!("Failed to delete agent {}: {:?}", agent_id, e);
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "server.agent.delete",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "success": false,
                        "error": format!("Failed to delete agent: {e}")
                    }
                })
                .to_string(),
            ))));
        }

        // Remove from in-memory registries. The broker entry goes with them,
        // but not through the disconnect path: this is a verdict about the
        // *agent* (it is offline), and it is not the release of a claim — see
        // `CommandBroker::forget_agent`, which is the one removal that may drop
        // the generation high-water mark, because the agent it belonged to is
        // gone rather than quiet.
        self.agent_registry.unregister(agent_id).await;
        self.session_registry.remove_by_agent(agent_id).await;
        self.command_broker.forget_agent(agent_id).await;

        // Broadcast updated lists to all connected web clients.
        self.web_client_registry
            .broadcast_agents_changed(Arc::clone(&self.agent_registry))
            .await;
        self.broadcast_sessions().await;

        Ok(HandlerAction::Reply(Some(Message::Text(
            json!({
                "msg_type": "server.agent.delete",
                "id": msg.id,
                "timestamp": current_timestamp(),
                "payload": {
                    "success": true
                }
            })
            .to_string(),
        ))))
    }
}
