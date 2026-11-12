//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    current_timestamp, info, json, AgentStatus, Arc, ConnectionHandler, HandlerAction, Message,
    ProtocolMessage,
};
use crate::registry::agent::AgentDeleteClaim;

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

        // The destructive transition must be ordered against registration and
        // heartbeat recovery for this Agent id. The broker gate is the one a
        // registration holds; the registry gate is the one `register` and
        // heartbeat recovery take. Taking both, then revalidating Offline under
        // the registry gate, closes the TOCTOU where an Agent reconnected
        // between the old status snapshot and the first destructive write. Both
        // guards stay alive until the last removal below.
        let _registration_order = self.command_broker.begin_deletion(agent_id).await;
        let _deletion = match self.agent_registry.begin_agent_deletion(agent_id).await {
            AgentDeleteClaim::Claimed(guard) => guard,
            AgentDeleteClaim::NotFound => {
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
            AgentDeleteClaim::NotOffline(status) => {
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
                                match status {
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
        };

        info!("Deleting offline agent {} and its sessions", agent_id);

        // Delete sessions and their durable Project memberships from the DB,
        // then the agent. This is an explicit Agent deletion, unlike a
        // reconnect/offline cache clear which must preserve memberships.
        if let Err(e) = self
            .db
            .delete_sessions_and_project_bindings_by_agent(agent_id)
            .await
        {
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
        self.session_registry.remove_by_agent(agent_id).await;
        // Sessions and their bindings are gone with the Agent; a desired row
        // for a session nobody can serve is not intent worth keeping.
        self.env_service.clear_agent_state(agent_id).await;
        self.command_broker.forget_agent(agent_id).await;
        // The registry entry is the last removal. `unregister` also drops the
        // liveness gate map entry, so a registration that resolved the gate
        // before this point still waits on its own Arc until this handler
        // returns; a registration that arrives after it starts a new
        // incarnation and cannot be erased by the cleanup above.
        self.agent_registry.unregister(agent_id).await;

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
