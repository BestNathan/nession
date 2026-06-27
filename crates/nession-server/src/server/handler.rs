use std::sync::Arc;
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use crate::registry::{AgentRegistry, SessionRegistry, AgentInfo, AgentStatus, SessionStatus};
use nession_common::protocol::{ProtocolMessage, AgentRegisterPayload};

pub struct ConnectionHandler {
    agent_registry: Arc<AgentRegistry>,
    session_registry: Arc<SessionRegistry>,
    server_auth_token: String,
    authenticated_client: bool,
    registered_agent_id: Option<String>,
}

impl ConnectionHandler {
    pub fn new(
        agent_registry: Arc<AgentRegistry>,
        session_registry: Arc<SessionRegistry>,
        server_auth_token: String,
    ) -> Self {
        Self {
            agent_registry,
            session_registry,
            server_auth_token,
            authenticated_client: false,
            registered_agent_id: None,
        }
    }

    pub async fn handle_message(&mut self, msg: Message) -> anyhow::Result<Option<Message>> {
        match msg {
            Message::Text(text) => {
                let protocol_msg: ProtocolMessage<serde_json::Value> = serde_json::from_str(&text)?;
                self.handle_protocol_message(protocol_msg).await
            }
            Message::Close(_) => {
                info!("Client disconnected");
                Ok(None)
            }
            _ => Ok(None),
        }
    }

    async fn handle_protocol_message(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<Option<Message>> {
        match msg.msg_type.as_str() {
            "agent.register" => self.handle_agent_register(msg).await,
            "agent.heartbeat" => self.handle_agent_heartbeat(msg).await,
            "client.auth" => self.handle_client_auth(msg).await,
            "client.agents.list" => self.handle_client_agents_list(msg).await,
            "client.sessions.list" => self.handle_client_sessions_list(msg).await,
            _ => {
                warn!("Unknown message type: {}", msg.msg_type);
                Ok(None)
            }
        }
    }

    async fn handle_agent_register(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<Option<Message>> {
        let payload: AgentRegisterPayload = serde_json::from_value(msg.payload)?;

        if payload.auth_token != self.server_auth_token {
            info!("Agent {} rejected: invalid auth token", payload.agent_id);
            return Ok(Some(Message::Text(
                json!({
                    "msg_type": "agent.register.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "rejected",
                        "message": "Invalid auth token"
                    }
                }).to_string()
            )));
        }

        let agent_info = AgentInfo {
            agent_id: payload.agent_id.clone(),
            hostname: payload.hostname,
            ip_address: payload.ip_address,
            port: payload.port,
            registered_at: chrono::Utc::now(),
            last_heartbeat: chrono::Utc::now(),
            status: AgentStatus::Online,
            metadata: payload.metadata,
            session_count: 0,
            active_sessions: 0,
        };

        self.agent_registry.register(agent_info).await;
        self.registered_agent_id = Some(payload.agent_id.clone());

        info!("Agent {} registered successfully", payload.agent_id);

        Ok(Some(Message::Text(
            json!({
                "msg_type": "agent.register.response",
                "id": msg.id,
                "timestamp": current_timestamp(),
                "payload": {
                    "status": "accepted",
                    "message": "Registration successful"
                }
            }).to_string()
        )))
    }

    async fn handle_agent_heartbeat(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<Option<Message>> {
        let payload: serde_json::Value = msg.payload;
        let agent_id = payload["agent_id"].as_str().unwrap_or("");

        if self.agent_registry.get(agent_id).await.is_none() {
            warn!("Heartbeat from unregistered agent: {}", agent_id);
            return Ok(None);
        }

        let session_count = payload["session_count"].as_u64().unwrap_or(0) as u32;
        let active_sessions = payload["active_sessions"].as_u64().unwrap_or(0) as u32;

        self.agent_registry
            .update_heartbeat(agent_id, session_count, active_sessions)
            .await;

        Ok(None)
    }

    async fn handle_client_auth(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<Option<Message>> {
        let payload: serde_json::Value = msg.payload;
        let auth_token = payload["auth_token"].as_str().unwrap_or("");

        if auth_token == self.server_auth_token {
            self.authenticated_client = true;
            info!("Client authenticated successfully");

            Ok(Some(Message::Text(
                json!({
                    "msg_type": "client.auth.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "success",
                        "message": "Authentication successful"
                    }
                }).to_string()
            )))
        } else {
            info!("Client authentication failed");

            Ok(Some(Message::Text(
                json!({
                    "msg_type": "client.auth.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "failed",
                        "message": "Invalid auth token"
                    }
                }).to_string()
            )))
        }
    }

    /// Handle `client.agents.list` - returns all registered agents.
    async fn handle_client_agents_list(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<Option<Message>> {
        if !self.authenticated_client {
            warn!("Unauthenticated client requested agents list");
            return Ok(Some(Message::Text(
                json!({
                    "msg_type": "client.agents.list.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "error",
                        "message": "Not authenticated"
                    }
                }).to_string()
            )));
        }

        let agents = self.agent_registry.list().await;

        let agents_json: Vec<serde_json::Value> = agents
            .iter()
            .map(|a| {
                json!({
                    "agent_id": a.agent_id,
                    "hostname": a.hostname,
                    "ip_address": a.ip_address,
                    "port": a.port,
                    "status": match a.status {
                        AgentStatus::Online => "online",
                        AgentStatus::Offline => "offline",
                        AgentStatus::Degraded => "degraded",
                    },
                    "session_count": a.session_count,
                    "last_heartbeat": a.last_heartbeat.to_rfc3339(),
                })
            })
            .collect();

        info!("Client requested agents list, returning {} agents", agents_json.len());

        Ok(Some(Message::Text(
            json!({
                "msg_type": "client.agents.list.response",
                "id": msg.id,
                "timestamp": current_timestamp(),
                "payload": {
                    "agents": agents_json
                }
            }).to_string()
        )))
    }

    /// Handle `client.sessions.list` - returns all sessions, optionally filtered by agent_id.
    async fn handle_client_sessions_list(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<Option<Message>> {
        if !self.authenticated_client {
            warn!("Unauthenticated client requested sessions list");
            return Ok(Some(Message::Text(
                json!({
                    "msg_type": "client.sessions.list.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "error",
                        "message": "Not authenticated"
                    }
                }).to_string()
            )));
        }

        let agent_id = msg.payload["agent_id"].as_str();

        let sessions = if let Some(aid) = agent_id {
            self.session_registry.list_by_agent(aid).await
        } else {
            self.session_registry.list().await
        };

        let sessions_json: Vec<serde_json::Value> = sessions
            .iter()
            .map(|s| {
                json!({
                    "session_id": s.session_id,
                    "agent_id": s.agent_id,
                    "session_name": s.session_name,
                    "status": match s.status {
                        SessionStatus::Active => "active",
                        SessionStatus::Detached => "detached",
                        SessionStatus::Zombie => "zombie",
                    },
                    "window_count": s.window_count,
                    "attached_clients": s.attached_clients,
                    "last_activity": s.last_activity.to_rfc3339(),
                })
            })
            .collect();

        info!("Client requested sessions list, returning {} sessions", sessions_json.len());

        Ok(Some(Message::Text(
            json!({
                "msg_type": "client.sessions.list.response",
                "id": msg.id,
                "timestamp": current_timestamp(),
                "payload": {
                    "sessions": sessions_json
                }
            }).to_string()
        )))
    }
}

fn current_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
