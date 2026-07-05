use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use crate::registry::{AgentInfo, AgentRegistry, AgentStatus, SessionRegistry, SessionStatus};
use crate::server::command_broker::CommandBroker;
use nession_common::protocol::{AgentRegisterPayload, ProtocolMessage};

/// Action returned by the connection handler after processing a message.
pub enum HandlerAction {
    /// Send an optional reply message back to the sender.
    Reply(Option<Message>),
    /// Enter relay mode: forward messages between this client and the agent
    /// at the given WebSocket address.
    Relay { agent_ws_url: String },
    /// Close the connection.
    Close,
}

pub struct ConnectionHandler {
    agent_registry: Arc<AgentRegistry>,
    session_registry: Arc<SessionRegistry>,
    command_broker: Arc<CommandBroker>,
    server_auth_token: String,
    /// Heartbeat interval (seconds) advertised to agents on registration.
    heartbeat_interval_secs: u64,
    authenticated_client: bool,
    registered_agent_id: Option<String>,
}

impl ConnectionHandler {
    pub fn new(
        agent_registry: Arc<AgentRegistry>,
        session_registry: Arc<SessionRegistry>,
        command_broker: Arc<CommandBroker>,
        server_auth_token: String,
        heartbeat_interval_secs: u64,
    ) -> Self {
        Self {
            agent_registry,
            session_registry,
            command_broker,
            server_auth_token,
            heartbeat_interval_secs,
            authenticated_client: false,
            registered_agent_id: None,
        }
    }

    pub fn registered_agent_id(&self) -> Option<&String> {
        self.registered_agent_id.as_ref()
    }

    pub async fn handle_message(&mut self, msg: Message) -> anyhow::Result<HandlerAction> {
        match msg {
            Message::Text(text) => {
                let protocol_msg: ProtocolMessage<serde_json::Value> = serde_json::from_str(&text)?;
                self.handle_protocol_message(protocol_msg).await
            }
            Message::Close(_) => {
                info!("Client disconnected");
                Ok(HandlerAction::Close)
            }
            _ => Ok(HandlerAction::Reply(None)),
        }
    }

    async fn handle_protocol_message(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // Log all agent-originated messages at info for diagnostics
        if msg.msg_type.starts_with("agent.") {
            info!(
                "Received agent message: type={}, id={}",
                msg.msg_type, msg.id
            );
        }
        match msg.msg_type.as_str() {
            "agent.register" => self.handle_agent_register(msg).await,
            "agent.heartbeat" => self.handle_agent_heartbeat(msg).await,
            "agent.session.update" => self.handle_agent_session_update(msg).await,
            "agent.session.command.response" => self.handle_agent_command_response(msg).await,
            "client.auth" => self.handle_client_auth(msg).await,
            "client.agents.list" => self.handle_client_agents_list(msg).await,
            "client.sessions.list" => self.handle_client_sessions_list(msg).await,
            "client.session.attach" => self.handle_client_session_attach(msg).await,
            "client.session.create" => self.handle_client_session_create(msg).await,
            "client.session.kill" => self.handle_client_session_kill(msg).await,
            _ => {
                warn!("Unknown message type: {}", msg.msg_type);
                Ok(HandlerAction::Reply(None))
            }
        }
    }

    async fn handle_agent_register(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let payload: AgentRegisterPayload = serde_json::from_value(msg.payload)?;

        // Empty server auth_token means no-auth mode: accept any agent
        let auth_ok =
            self.server_auth_token.is_empty() || payload.auth_token == self.server_auth_token;

        if !auth_ok {
            info!("Agent {} rejected: invalid auth token", payload.agent_id);
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "agent.register.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "rejected",
                        "message": "Invalid auth token"
                    }
                })
                .to_string(),
            ))));
        }

        let agent_info = AgentInfo {
            agent_id: payload.agent_id.clone(),
            hostname: payload.hostname,
            ip_address: payload.ip_address,
            port: payload.port,
            connect_url: payload.connect_url.clone(),
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

        Ok(HandlerAction::Reply(Some(Message::Text(
            json!({
                "msg_type": "agent.register.response",
                "id": msg.id,
                "timestamp": current_timestamp(),
                "payload": {
                    "status": "accepted",
                    "message": "Registration successful",
                    "heartbeat_interval_secs": self.heartbeat_interval_secs
                }
            })
            .to_string(),
        ))))
    }

    async fn handle_agent_heartbeat(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let payload: serde_json::Value = msg.payload;
        let agent_id = payload
            .get("agent_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if self.agent_registry.get(agent_id).await.is_none() {
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

        self.agent_registry
            .update_heartbeat(agent_id, session_count, active_sessions)
            .await;

        // Acknowledge so the agent can confirm the link is healthy in both
        // directions and reset its own miss counter.
        Ok(HandlerAction::Reply(Some(Message::Text(
            json!({
                "msg_type": "server.heartbeat.ack",
                "id": msg.id,
                "timestamp": current_timestamp(),
                "payload": {
                    "agent_id": agent_id,
                    "server_time": current_timestamp()
                }
            })
            .to_string(),
        ))))
    }

    async fn handle_agent_session_update(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let payload: serde_json::Value = msg.payload;
        let agent_id = payload
            .get("agent_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let session_name = payload
            .get("session_name")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let status_str = payload.get("status").and_then(|v| v.as_str()).unwrap_or("");

        if self.agent_registry.get(agent_id).await.is_none() {
            warn!("Session update from unregistered agent: {}", agent_id);
            return Ok(HandlerAction::Reply(None));
        }

        let session_id = format!("{agent_id}:{session_name}");

        if status_str == "gone" {
            info!("Session {} removed (agent: {})", session_name, agent_id);
            self.session_registry.remove(&session_id).await;
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

        let session_info = crate::registry::session::SessionInfo {
            session_id: session_id.clone(),
            agent_id: agent_id.to_string(),
            session_name: session_name.to_string(),
            status,
            window_count,
            attached_clients,
            created_at: chrono::Utc::now(),
            last_activity: chrono::Utc::now(),
        };

        info!(
            "Session {} updated (agent: {}, status: {:?}, windows: {}, clients: {})",
            session_name, agent_id, session_info.status, window_count, attached_clients
        );
        self.session_registry.update_session(session_info).await;

        Ok(HandlerAction::Reply(None))
    }

    async fn handle_client_auth(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let payload: serde_json::Value = msg.payload;
        let auth_token = payload
            .get("auth_token")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        // Empty server auth_token means no-auth mode: accept any client
        let auth_ok = self.server_auth_token.is_empty() || auth_token == self.server_auth_token;

        if auth_ok {
            self.authenticated_client = true;
            info!("Client authenticated successfully");

            Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "client.auth.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "success",
                        "message": "Authentication successful"
                    }
                })
                .to_string(),
            ))))
        } else {
            info!("Client authentication failed");

            Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "client.auth.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "failed",
                        "message": "Invalid auth token"
                    }
                })
                .to_string(),
            ))))
        }
    }

    /// Handle `client.agents.list` - returns all registered agents.
    async fn handle_client_agents_list(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            warn!("Unauthenticated client requested agents list");
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "client.agents.list.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "error",
                        "message": "Not authenticated"
                    }
                })
                .to_string(),
            ))));
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
                    "active_sessions": a.active_sessions,
                    "last_heartbeat": a.last_heartbeat.to_rfc3339(),
                    "metadata": {
                        "nession_version": a.metadata.nession_version,
                        "tmux_version": a.metadata.tmux_version,
                        "os_version": a.metadata.os_version,
                    },
                })
            })
            .collect();

        info!(
            "Client requested agents list, returning {} agents",
            agents_json.len()
        );

        Ok(HandlerAction::Reply(Some(Message::Text(
            json!({
                "msg_type": "client.agents.list.response",
                "id": msg.id,
                "timestamp": current_timestamp(),
                "payload": {
                    "agents": agents_json
                }
            })
            .to_string(),
        ))))
    }

    /// Handle `client.sessions.list` - returns all sessions, optionally filtered by agent_id.
    async fn handle_client_sessions_list(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            warn!("Unauthenticated client requested sessions list");
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "client.sessions.list.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "error",
                        "message": "Not authenticated"
                    }
                })
                .to_string(),
            ))));
        }

        let agent_id = msg.payload.get("agent_id").and_then(|v| v.as_str());

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
                        SessionStatus::Recovering => "recovering",
                        SessionStatus::Orphaned => "orphaned",
                        SessionStatus::Zombie => "zombie",
                    },
                    "window_count": s.window_count,
                    "attached_clients": s.attached_clients,
                    "last_activity": s.last_activity.to_rfc3339(),
                })
            })
            .collect();

        info!(
            "Client requested sessions list, returning {} sessions",
            sessions_json.len()
        );

        Ok(HandlerAction::Reply(Some(Message::Text(
            json!({
                "msg_type": "client.sessions.list.response",
                "id": msg.id,
                "timestamp": current_timestamp(),
                "payload": {
                    "sessions": sessions_json
                }
            })
            .to_string(),
        ))))
    }

    /// Handle `client.session.attach` - returns P2P agent address or enters relay mode.
    ///
    /// In P2P mode, the response includes the agent's IP:port so the client can
    /// connect directly. In relay mode, the server opens a WebSocket to the agent
    /// and bidirectionally forwards terminal I/O.
    async fn handle_client_session_attach(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "client.session.attach.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "error",
                        "message": "Not authenticated"
                    }
                })
                .to_string(),
            ))));
        }

        let session_id = msg
            .payload
            .get("session_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let preferred_mode = msg
            .payload
            .get("preferred_mode")
            .and_then(|v| v.as_str())
            .unwrap_or("p2p");

        // Parse session_id as "agent_id:session_name"
        let (agent_id, session_name) = match session_id.split_once(':') {
            Some((aid, sname)) => (aid.to_string(), sname.to_string()),
            None => {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "client.session.attach.response",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "status": "error",
                            "message": "Invalid session_id format. Expected 'agent_id:session_name'"
                        }
                    })
                    .to_string(),
                ))));
            }
        };

        // Look up the session in the registry
        let session = self.session_registry.get(session_id).await;
        if session.is_none() {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "client.session.attach.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "error",
                        "message": format!("Session '{}' not found", session_id)
                    }
                })
                .to_string(),
            ))));
        }

        // Look up the agent
        let agent = self.agent_registry.get(&agent_id).await;
        let agent = match agent {
            Some(a) if a.status == AgentStatus::Online => a,
            Some(_) => {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "client.session.attach.response",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "status": "error",
                            "message": format!("Agent '{}' is offline", agent_id)
                        }
                    })
                    .to_string(),
                ))));
            }
            None => {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "client.session.attach.response",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "status": "error",
                            "message": format!("Agent '{}' not found or offline", agent_id)
                        }
                    })
                    .to_string(),
                ))));
            }
        };

        // Prefer the agent's declared connect_url (k8s ingress / public hostname),
        // falling back to a constructed URL for bare-metal / direct-access deployments.
        // Both produce a complete URL (e.g. "ws://agent.example.com/ws" or "ws://10.0.0.1:19090/ws")
        // so the frontend can use agent_address as-is without further splicing.
        let agent_ws_url = agent
            .connect_url
            .clone()
            .unwrap_or_else(|| format!("ws://{}:{}/ws", agent.ip_address, agent.port));
        let agent_address = agent_ws_url.clone();
        let connection_token = uuid::Uuid::new_v4().to_string();

        info!(
            "Client requested attach to session {} (mode: {}), agent at {}",
            session_id, preferred_mode, agent_ws_url
        );

        if preferred_mode == "relay" {
            // For relay mode, the server will proxy I/O between client and agent.
            // The handler loop must transition into relay mode.
            Ok(HandlerAction::Relay { agent_ws_url })
        } else {
            // P2P mode: return the agent's public WebSocket URL so the client
            // can connect directly. Uses connect_url when configured (k8s),
            // or the raw IP:port otherwise.
            Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "client.session.attach.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "success",
                        "mode": "p2p",
                        "agent_address": agent_address,
                        "connection_token": connection_token,
                        "session_name": session_name
                    }
                })
                .to_string(),
            ))))
        }
    }

    /// Handle `client.session.create` — create a new session on a target agent.
    async fn handle_client_session_create(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "client.session.create.response",
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
        let name = msg
            .payload
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if agent_id.is_empty() || name.is_empty() {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "client.session.create.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "success": false,
                        "error": "agent_id and name are required"
                    }
                })
                .to_string(),
            ))));
        }

        // Check agent exists and is online
        let agent = self.agent_registry.get(agent_id).await;
        match agent {
            Some(a) if a.status == AgentStatus::Online => {}
            Some(_) => {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "client.session.create.response",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "success": false,
                            "error": format!("Agent '{}' is offline", agent_id)
                        }
                    })
                    .to_string(),
                ))));
            }
            None => {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "client.session.create.response",
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
        }

        let request_id = uuid::Uuid::new_v4().to_string();

        info!(
            "Client requested session create on agent {}: name={}",
            agent_id, name
        );

        let rx = self
            .command_broker
            .send_command(
                agent_id,
                "server.session.create",
                &request_id,
                json!({
                    "request_id": request_id,
                    "name": name,
                    "width": 80,
                    "height": 24
                }),
            )
            .await;

        match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(response)) => {
                let success = response
                    .get("success")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                let session_id = if success {
                    let sid = format!("{agent_id}:{name}");
                    // Immediately register the session so it shows up in list
                    // and attach requests without waiting for the agent's
                    // SessionWatcher poll cycle.
                    let session_info = crate::registry::session::SessionInfo {
                        session_id: sid.clone(),
                        agent_id: agent_id.to_string(),
                        session_name: name.to_string(),
                        status: crate::registry::session::SessionStatus::Detached,
                        window_count: 1,
                        attached_clients: 0,
                        created_at: chrono::Utc::now(),
                        last_activity: chrono::Utc::now(),
                    };
                    self.session_registry.update_session(session_info).await;
                    Some(sid)
                } else {
                    None
                };
                let error = response
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(std::string::ToString::to_string);

                Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "client.session.create.response",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "success": success,
                            "session_id": session_id,
                            "error": error,
                        }
                    })
                    .to_string(),
                ))))
            }
            Ok(Err(_)) => Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "client.session.create.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "success": false,
                        "error": "Agent disconnected"
                    }
                })
                .to_string(),
            )))),
            Err(_) => Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "client.session.create.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "success": false,
                        "error": "Timeout waiting for agent response"
                    }
                })
                .to_string(),
            )))),
        }
    }

    /// Handle `client.session.kill` — kill a session on its agent.
    async fn handle_client_session_kill(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "client.session.kill.response",
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

        let session_id = msg
            .payload
            .get("session_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let (agent_id, session_name) = match session_id.split_once(':') {
            Some((aid, sname)) => (aid.to_string(), sname.to_string()),
            None => {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "client.session.kill.response",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "success": false,
                            "error": "Invalid session_id format. Expected 'agent_id:session_name'"
                        }
                    })
                    .to_string(),
                ))));
            }
        };

        // Check session exists in registry
        let session = self.session_registry.get(session_id).await;
        if session.is_none() {
            let agent = self.agent_registry.get(&agent_id).await;
            match agent {
                Some(a) if a.status != AgentStatus::Online => {
                    self.session_registry.remove(session_id).await;
                    return Ok(HandlerAction::Reply(Some(Message::Text(
                        json!({
                            "msg_type": "client.session.kill.response",
                            "id": msg.id,
                            "timestamp": current_timestamp(),
                            "payload": {
                                "success": true
                            }
                        })
                        .to_string(),
                    ))));
                }
                Some(_) => {
                    return Ok(HandlerAction::Reply(Some(Message::Text(
                        json!({
                            "msg_type": "client.session.kill.response",
                            "id": msg.id,
                            "timestamp": current_timestamp(),
                            "payload": {
                                "success": false,
                                "error": format!("Session '{}' not found", session_id)
                            }
                        })
                        .to_string(),
                    ))));
                }
                None => {
                    return Ok(HandlerAction::Reply(Some(Message::Text(
                        json!({
                            "msg_type": "client.session.kill.response",
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
            }
        }

        let request_id = uuid::Uuid::new_v4().to_string();

        info!(
            "Client requested session kill: {} (agent: {})",
            session_name, agent_id
        );

        let rx = self
            .command_broker
            .send_command(
                &agent_id,
                "server.session.kill",
                &request_id,
                json!({
                    "request_id": request_id,
                    "name": session_name,
                }),
            )
            .await;

        match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(response)) => {
                let success = response
                    .get("success")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                let error = response
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(std::string::ToString::to_string);

                if success {
                    self.session_registry.remove(session_id).await;
                }

                Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "client.session.kill.response",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "success": success,
                            "error": error,
                        }
                    })
                    .to_string(),
                ))))
            }
            Ok(Err(_)) => Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "client.session.kill.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "success": false,
                        "error": "Agent disconnected"
                    }
                })
                .to_string(),
            )))),
            Err(_) => Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "client.session.kill.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "success": false,
                        "error": "Timeout waiting for agent response"
                    }
                })
                .to_string(),
            )))),
        }
    }

    /// Handle `agent.session.command.response` — resolve a pending command.
    async fn handle_agent_command_response(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let agent_id = match &self.registered_agent_id {
            Some(id) => id.clone(),
            None => {
                warn!("agent.session.command.response from unregistered connection");
                return Ok(HandlerAction::Reply(None));
            }
        };

        let request_id = msg
            .payload
            .get("request_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if request_id.is_empty() {
            warn!("agent.session.command.response missing request_id");
            return Ok(HandlerAction::Reply(None));
        }

        info!(
            "Received command response from agent {}: request_id={}, command={}",
            agent_id,
            request_id,
            msg.payload
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        );

        self.command_broker
            .resolve_command(&agent_id, &request_id, msg.payload)
            .await;

        Ok(HandlerAction::Reply(None))
    }
}

fn current_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
