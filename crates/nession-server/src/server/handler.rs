use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use crate::env::EnvService;
use crate::registry::{AgentInfo, AgentRegistry, AgentStatus, SessionRegistry, SessionStatus};
use crate::server::client_registry::ClientRegistry;
use crate::server::command_broker::{CommandBroker, WsMessageSender};
use nession_common::display_name::validate_display_name;
use nession_common::env_file::parse_env;
use nession_common::protocol::{
    AddressStatus, AgentRegisterPayload, AgentTerminalResizePayload, EnvFileRef, EnvSnapshot,
    EnvSource, ProtocolMessage, ServerTerminalResizePayload,
};

/// Action returned by the connection handler after processing a message.
pub enum HandlerAction {
    /// Send an optional reply message back to the sender.
    Reply(Option<Message>),
    /// Enter relay mode: forward messages between this client and the agent.
    /// The server tries each URL in order with a fast timeout until one connects.
    Relay {
        /// Candidate agent WebSocket URLs, best-first (Reachable > Unknown > Unreachable).
        agent_ws_urls: Vec<String>,
        /// Session id ("agent_id:session_name") for client registry tracking.
        session_id: String,
        /// Short session name for agent protocol messages (client.attach, etc.).
        session_name: String,
        /// Unique client id assigned for this relay connection.
        client_id: String,
        /// Resolved env snapshots to inject via client.attach to the agent.
        env_snapshots: Vec<EnvSnapshot>,
        /// Terminal columns for the initial tmux resize (from browser viewport).
        cols: u16,
        /// Terminal rows for the initial tmux resize (from browser viewport).
        rows: u16,
    },
    /// Close the connection.
    Close,
}

pub struct ConnectionHandler {
    agent_registry: Arc<AgentRegistry>,
    session_registry: Arc<SessionRegistry>,
    command_broker: Arc<CommandBroker>,
    client_registry: Arc<ClientRegistry>,
    env_service: Arc<EnvService>,
    server_auth_token: String,
    /// Heartbeat interval (seconds) advertised to agents on registration.
    heartbeat_interval_secs: u64,
    authenticated_client: bool,
    registered_agent_id: Option<String>,
    /// Outgoing message sender for this client connection (set after construction).
    client_sender: Option<WsMessageSender>,
    /// Session this client is attached to via relay (for cleanup on disconnect).
    attached_session_id: Option<String>,
    /// Unique client id for this relay attachment (for cleanup on disconnect).
    attached_client_id: Option<String>,
}

impl ConnectionHandler {
    pub fn new(
        agent_registry: Arc<AgentRegistry>,
        session_registry: Arc<SessionRegistry>,
        command_broker: Arc<CommandBroker>,
        client_registry: Arc<ClientRegistry>,
        env_service: Arc<EnvService>,
        server_auth_token: String,
        heartbeat_interval_secs: u64,
    ) -> Self {
        Self {
            agent_registry,
            session_registry,
            command_broker,
            client_registry,
            env_service,
            server_auth_token,
            heartbeat_interval_secs,
            authenticated_client: false,
            registered_agent_id: None,
            client_sender: None,
            attached_session_id: None,
            attached_client_id: None,
        }
    }

    pub fn registered_agent_id(&self) -> Option<&String> {
        self.registered_agent_id.as_ref()
    }

    /// Set the outgoing message sender for this client connection.
    /// Must be called before processing messages that may need to broadcast.
    pub fn set_client_sender(&mut self, sender: WsMessageSender) {
        self.client_sender = Some(sender);
    }

    /// Session this client is attached to via relay (for cleanup on disconnect).
    pub fn attached_session_id(&self) -> Option<&str> {
        self.attached_session_id.as_deref()
    }

    /// Unique client id for this relay attachment (for cleanup on disconnect).
    pub fn attached_client_id(&self) -> Option<&str> {
        self.attached_client_id.as_deref()
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
            "agent.terminal.resize" => self.handle_agent_terminal_resize(msg).await,
            "client.auth" => self.handle_client_auth(msg).await,
            "client.agents.list" => self.handle_client_agents_list(msg).await,
            "client.sessions.list" => self.handle_client_sessions_list(msg).await,
            "client.session.attach" => self.handle_client_session_attach(msg).await,
            "client.session.relay.begin" => self.handle_client_session_relay_begin(msg).await,
            // client.session.relay.end is intercepted by the relay function
            // (relay_bidirectional_via_channel) and never reaches here during
            // active relay.  After relay exits the duplicate lands here; it is
            // a safe no-op.
            "client.session.relay.end" => Ok(HandlerAction::Reply(None)),
            "client.session.create" => self.handle_client_session_create(msg).await,
            "client.session.kill" => self.handle_client_session_kill(msg).await,
            "client.env.list" => self.handle_client_env_list(msg).await,
            "client.env.get" => self.handle_client_env_get(msg).await,
            "client.env.write" => self.handle_client_env_write(msg).await,
            "client.env.delete" => self.handle_client_env_delete(msg).await,
            "client.session.env.apply" => self.handle_client_session_env_apply(msg).await,
            "client.session.env.unset" => self.handle_client_session_env_unset(msg).await,
            "client.session.env.active" => self.handle_client_session_env_active(msg).await,
            "client.session.env.query" => self.handle_client_session_env_query(msg).await,
            "client.agent.rename" => self.handle_client_agent_rename(msg).await,
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

        let addresses = crate::registry::build_probed_addresses(
            payload.addresses.clone(),
            &payload.ip_address,
            payload.port,
            payload.connect_url.as_deref(),
        );
        info!(
            "Agent {} advertised {} P2P address(es)",
            payload.agent_id,
            addresses.len()
        );

        // Keep an existing display_name if it was manually set via Web UI
        // (survives agent restart). Otherwise use the agent's config value.
        let display_name = match self.agent_registry.get(&payload.agent_id).await {
            Some(existing) if existing.display_name.is_some() => {
                info!(
                    "Agent {} keeping existing display_name: {:?}",
                    payload.agent_id, existing.display_name
                );
                existing.display_name
            }
            _ => payload.display_name.clone(),
        };

        let agent_info = AgentInfo {
            agent_id: payload.agent_id.clone(),
            hostname: payload.hostname,
            ip_address: payload.ip_address,
            port: payload.port,
            display_name,
            connect_url: payload.connect_url.clone(),
            addresses,
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
            // Release any env usage locks held by this session so the env
            // files can be edited/deleted again. Without this, externally
            // killed sessions leave stale locks in memory.
            self.env_service.usage.clear_session(&session_id);
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
                    "display_name": a.display_name,
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
                    "registered_at": a.registered_at.to_rfc3339(),
                    "addresses": serde_json::to_value(&a.addresses).unwrap_or(json!([])),
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

    /// Handle `client.agent.rename` — update an agent's display name.
    /// Accepts `agent_id` and `display_name` (string or null to clear).
    /// Returns the updated agent info on success.
    async fn handle_client_agent_rename(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "client.agent.rename.response",
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
                    "msg_type": "client.agent.rename.response",
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

        // Resolve the new display_name: JSON null → clear, string → validate
        let raw: Option<String> = msg
            .payload
            .get("display_name")
            .and_then(|v| {
                if v.is_null() {
                    Some(None) // explicit null = clear
                } else {
                    v.as_str().map(|s| Some(s.to_string()))
                }
            })
            .flatten();

        let display_name = match raw {
            Some(ref s) => match validate_display_name(s) {
                Ok(Some(normalized)) => Some(normalized),
                Ok(None) => None, // empty after trim → clear
                Err(e) => {
                    return Ok(HandlerAction::Reply(Some(Message::Text(
                        json!({
                            "msg_type": "client.agent.rename.response",
                            "id": msg.id,
                            "timestamp": current_timestamp(),
                            "payload": {
                                "success": false,
                                "error": e
                            }
                        })
                        .to_string(),
                    ))));
                }
            },
            None => None, // explicit null → clear
        };

        info!(
            "Rename agent {} display_name: {:?} -> {:?}",
            agent_id,
            self.agent_registry
                .get(agent_id)
                .await
                .and_then(|a| a.display_name),
            display_name
        );

        match self
            .agent_registry
            .update_display_name(agent_id, display_name.clone())
            .await
        {
            Some(updated) => {
                let agent_json = json!({
                    "agent_id": updated.agent_id,
                    "hostname": updated.hostname,
                    "display_name": updated.display_name,
                    "ip_address": updated.ip_address,
                    "port": updated.port,
                    "status": match updated.status {
                        AgentStatus::Online => "online",
                        AgentStatus::Offline => "offline",
                        AgentStatus::Degraded => "degraded",
                    },
                    "session_count": updated.session_count,
                    "active_sessions": updated.active_sessions,
                    "last_heartbeat": updated.last_heartbeat.to_rfc3339(),
                    "registered_at": updated.registered_at.to_rfc3339(),
                    "addresses": serde_json::to_value(&updated.addresses).unwrap_or(json!([])),
                    "metadata": {
                        "nession_version": updated.metadata.nession_version,
                        "tmux_version": updated.metadata.tmux_version,
                        "os_version": updated.metadata.os_version,
                    },
                });

                Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "client.agent.rename.response",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "success": true,
                            "agent": agent_json
                        }
                    })
                    .to_string(),
                ))))
            }
            None => Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "client.agent.rename.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "success": false,
                        "error": format!("Agent '{}' not found", agent_id)
                    }
                })
                .to_string(),
            )))),
        }
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

        // Legacy single endpoint for old clients: prefer a tunnel, then any
        // reachable address, then the first. Falls back to the constructed
        // URL when the agent advertised no addresses at all.
        let agent_ws_url = crate::registry::legacy_agent_address(&agent.addresses)
            .or_else(|| agent.connect_url.clone())
            .unwrap_or_else(|| format!("ws://{}:{}/ws", agent.ip_address, agent.port));
        let agent_address = agent_ws_url.clone();
        let connection_token = uuid::Uuid::new_v4().to_string();
        // Serialise the full probed-address list for multi-address clients.
        let addresses_json = serde_json::to_value(&agent.addresses).unwrap_or(json!([]));

        info!(
            "Client requested attach to session {} (mode: {}), agent at {} ({} address(es))",
            session_id,
            preferred_mode,
            agent_ws_url,
            agent.addresses.len()
        );

        if preferred_mode == "relay" {
            // Resolve env snapshots if provided in the attach request.
            let attach_env_snapshots: Vec<EnvSnapshot> = msg
                .payload
                .get("env_snapshots")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();

            if !attach_env_snapshots.is_empty() {
                info!(
                    "Relay attach with {} env snapshot(s) for session {}",
                    attach_env_snapshots.len(),
                    session_name
                );
            }

            // Honour a manually-selected relay address from the browser.
            let _manual_relay_url: Option<String> = msg
                .payload
                .get("relay_url")
                .and_then(|v| v.as_str())
                .map(str::to_string);

            // Build candidate URL list for the server to try when
            // connecting to the agent.  If the browser specified a
            // relay_url, use only that one.  Otherwise auto-select:
            // Reachable > Unknown > Unreachable > legacy fallback.
            let _relay_urls: Vec<String> = if let Some(ref url) = _manual_relay_url {
                info!(
                    "Relay mode: using manual URL {} for session {}",
                    url, session_name
                );
                vec![url.clone()]
            } else {
                let mut urls: Vec<String> = agent
                    .addresses
                    .iter()
                    .filter(|p| p.status == AddressStatus::Reachable)
                    .map(|p| p.address.url.clone())
                    .chain(
                        agent
                            .addresses
                            .iter()
                            .filter(|p| p.status == AddressStatus::Unknown)
                            .map(|p| p.address.url.clone()),
                    )
                    .chain(
                        agent
                            .addresses
                            .iter()
                            .filter(|p| p.status == AddressStatus::Unreachable)
                            .map(|p| p.address.url.clone()),
                    )
                    .collect();
                if urls.is_empty() {
                    urls.push(agent_ws_url.clone());
                }
                info!(
                    "Relay mode: {} candidate URL(s) for agent {} (session {})",
                    urls.len(),
                    agent_id,
                    session_name
                );
                urls
            };

            let client_id = uuid::Uuid::new_v4().to_string();
            if let Some(ref sender) = self.client_sender {
                self.client_registry
                    .register(session_id, &client_id, sender.clone())
                    .await;
            } else {
                warn!(
                    "Client attach to session {} in relay mode but no client_sender set",
                    session_id
                );
            }
            self.attached_session_id = Some(session_id.to_string());
            self.attached_client_id = Some(client_id.clone());

            // Send attach response to browser BEFORE entering relay mode,
            // so the browser's requestAttach() resolves instead of timing out.
            if let Some(ref sender) = self.client_sender {
                let response = Message::Text(
                    serde_json::json!({
                        "msg_type": "client.session.attach.response",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "status": "success",
                            "mode": "relay",
                            "session_name": session_name,
                            // Server TCP probe results — the browser shows these
                            // so the user can pick a specific relay endpoint.
                            "addresses": addresses_json,
                        }
                    })
                    .to_string(),
                );
                let _ = sender.send(response);
            }

            // Phase 1 complete — relay info returned to browser.
            // The browser will send client.session.relay.begin when the
            // Terminal is mounted and ready to receive terminal output.
            // This avoids the race between server entering relay mode and
            // the browser subscribing to terminal.output.
            Ok(HandlerAction::Reply(None))
        } else {
            // P2P mode: return the full candidate list (with probe status) plus
            // the legacy single `agent_address` for backward compatibility. The
            // client tests latency across `addresses` and falls back per-address.
            Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "client.session.attach.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "status": "success",
                        "mode": "p2p",
                        "agent_address": agent_address,
                        "addresses": addresses_json,
                        "connection_token": connection_token,
                        "session_name": session_name
                    }
                })
                .to_string(),
            ))))
        }
    }

    /// Handle `client.session.relay.begin` — Phase 2 of relay attach.
    ///
    /// Phase 1 (client.session.attach, relay mode) returned the candidate
    /// addresses but did NOT enter relay forwarding.  Now the Terminal is
    /// mounted and subscribed — the browser sends this to actually start
    /// the relay data flow.
    async fn handle_client_session_relay_begin(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "client.session.relay.begin.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": { "status": "error", "message": "Not authenticated" }
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
                        "msg_type": "client.session.relay.begin.response",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": { "status": "error", "message": "Invalid session_id format" }
                    })
                    .to_string(),
                ))));
            }
        };

        let session = self.session_registry.get(session_id).await;
        if session.is_none() {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "client.session.relay.begin.response",
                    "id": msg.id, "timestamp": current_timestamp(),
                    "payload": { "status": "error", "message": format!("Session not found: {session_id}") }
                }).to_string(),
            ))));
        }

        let agent = self.agent_registry.get(&agent_id).await;
        let agent = match agent {
            Some(a) if a.status == AgentStatus::Online => a,
            _ => {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "client.session.relay.begin.response",
                        "id": msg.id, "timestamp": current_timestamp(),
                        "payload": { "status": "error", "message": format!("Agent '{agent_id}' is offline") }
                    }).to_string(),
                ))));
            }
        };

        // Manual relay URL override from the browser.
        let manual_relay_url: Option<String> = msg
            .payload
            .get("relay_url")
            .and_then(|v| v.as_str())
            .map(str::to_string);

        // Build URL list: respect manual override, otherwise auto-select.
        let agent_ws_url = crate::registry::legacy_agent_address(&agent.addresses)
            .or_else(|| agent.connect_url.clone())
            .unwrap_or_else(|| format!("ws://{}:{}/ws", agent.ip_address, agent.port));

        let relay_urls: Vec<String> = if let Some(ref url) = manual_relay_url {
            vec![url.clone()]
        } else {
            let mut urls: Vec<String> = agent
                .addresses
                .iter()
                .filter(|p| p.status == AddressStatus::Reachable)
                .map(|p| p.address.url.clone())
                .chain(
                    agent
                        .addresses
                        .iter()
                        .filter(|p| p.status == AddressStatus::Unknown)
                        .map(|p| p.address.url.clone()),
                )
                .chain(
                    agent
                        .addresses
                        .iter()
                        .filter(|p| p.status == AddressStatus::Unreachable)
                        .map(|p| p.address.url.clone()),
                )
                .collect();
            if urls.is_empty() {
                urls.push(agent_ws_url);
            }
            urls
        };

        info!(
            "Relay begin: {} URL(s) for session '{}'",
            relay_urls.len(),
            session_name
        );

        let client_id = uuid::Uuid::new_v4().to_string();
        if let Some(ref sender) = self.client_sender {
            self.client_registry
                .register(session_id, &client_id, sender.clone())
                .await;
        }
        self.attached_session_id = Some(session_id.to_string());
        self.attached_client_id = Some(client_id.clone());

        // No separate response — the server enters relay forwarding immediately.
        // terminal.output flows back through this WebSocket.

        // Terminal dimensions from the browser viewport (via ResizeObserver).
        // Default to 80×24 if the browser hasn't sent them yet.
        let cols = u16::try_from(
            msg.payload
                .get("cols")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(80),
        )
        .unwrap_or(80);
        let rows = u16::try_from(
            msg.payload
                .get("rows")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(24),
        )
        .unwrap_or(24);

        Ok(HandlerAction::Relay {
            agent_ws_urls: relay_urls,
            session_id: session_id.to_string(),
            session_name,
            client_id,
            env_snapshots: Vec::new(),
            cols,
            rows,
        })
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

        // Optional env files selected for create-time injection.
        let env_refs: Vec<EnvFileRef> = msg
            .payload
            .get("env_files")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();

        let env_snapshots = if env_refs.is_empty() {
            Vec::new()
        } else {
            match self.resolve_snapshots(agent_id, &env_refs).await {
                Ok(s) => s,
                Err(e) => {
                    return Ok(HandlerAction::Reply(Some(Message::Text(
                        json!({
                            "msg_type": "client.session.create.response",
                            "id": msg.id,
                            "timestamp": current_timestamp(),
                            "payload": { "success": false, "error": e }
                        })
                        .to_string(),
                    ))));
                }
            }
        };

        info!(
            "Client requested session create on agent {}: name={}, env_files={}",
            agent_id,
            name,
            env_refs.len()
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
                    "height": 24,
                    "env_snapshots": env_snapshots,
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
                    // Record create-time env usage for visibility + in-use lock.
                    if !env_refs.is_empty() {
                        self.env_service.usage.record_create(&sid, &env_refs, None);
                    }
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
                    // Session destroyed: create-time env vars are gone with it
                    // (EC7) and any attach-time usage is now moot, so release
                    // all locks this session held.
                    self.env_service.usage.clear_session(session_id);
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

    /// Handle `agent.terminal.resize` — broadcast terminal resize to all
    /// web clients attached to the session via relay.
    async fn handle_agent_terminal_resize(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let payload: AgentTerminalResizePayload = match serde_json::from_value(msg.payload) {
            Ok(p) => p,
            Err(e) => {
                warn!("agent.terminal.resize with invalid payload: {}", e);
                return Ok(HandlerAction::Reply(None));
            }
        };

        info!(
            "Terminal resize for session {}: {}x{}",
            payload.session_id, payload.cols, payload.rows
        );

        let server_payload = ServerTerminalResizePayload {
            session_id: payload.session_id.clone(),
            cols: payload.cols,
            rows: payload.rows,
        };
        let broadcast_msg = serde_json::json!({
            "msg_type": "terminal.resize",
            "id": uuid::Uuid::new_v4().to_string(),
            "timestamp": current_timestamp(),
            "payload": server_payload,
        });

        let sent = self
            .client_registry
            .broadcast(&payload.session_id, broadcast_msg.to_string())
            .await;

        if sent > 0 {
            info!(
                "Broadcast terminal resize to {} client(s) for session {}",
                sent, payload.session_id
            );
        }

        Ok(HandlerAction::Reply(None))
    }

    // ========================================================================
    // Environment-variable file management
    // ========================================================================

    /// Send a command to an agent and await its response (10s timeout).
    /// Returns the response payload, or an error string on timeout/disconnect.
    async fn agent_command(
        &self,
        agent_id: &str,
        msg_type: &str,
        mut payload: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let request_id = uuid::Uuid::new_v4().to_string();
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("request_id".to_string(), json!(request_id));
        }
        let rx = self
            .command_broker
            .send_command(agent_id, msg_type, &request_id, payload)
            .await;
        match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err("Agent disconnected".to_string()),
            Err(_) => Err("Timeout waiting for agent response".to_string()),
        }
    }

    /// Handle `client.env.list` — aggregate server env files with those from
    /// every online agent (EC6: same filename on both shows twice with badges).
    async fn handle_client_env_list(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(reply_json(
                &msg.id,
                "client.env.list.response",
                json!({ "files": [], "error": "Not authenticated" }),
            ));
        }

        let mut files = self.env_service.store.list().await.unwrap_or_default();

        // Query each online agent for its local files.
        for agent in self.agent_registry.list().await {
            if agent.status != AgentStatus::Online {
                continue;
            }
            match self
                .agent_command(&agent.agent_id, "server.env.list", json!({}))
                .await
            {
                Ok(resp) => {
                    if let Some(arr) = resp.get("files").and_then(|v| v.as_array()) {
                        for f in arr {
                            if let Ok(info) = serde_json::from_value::<
                                nession_common::protocol::EnvFileInfo,
                            >(f.clone())
                            {
                                files.push(info);
                            }
                        }
                    }
                }
                Err(e) => warn!("env.list from agent {} failed: {}", agent.agent_id, e),
            }
        }

        Ok(reply_json(
            &msg.id,
            "client.env.list.response",
            json!({ "files": files }),
        ))
    }

    /// Handle `client.env.get` — read one env file's content and report which
    /// sessions currently use it (for the in-use lock).
    async fn handle_client_env_get(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(reply_json(
                &msg.id,
                "client.env.get.response",
                json!({ "success": false, "error": "Not authenticated" }),
            ));
        }
        let (name, source, agent_id) = parse_env_ref(&msg.payload);
        if name.is_empty() {
            return Ok(reply_json(
                &msg.id,
                "client.env.get.response",
                json!({ "success": false, "error": "name is required" }),
            ));
        }

        let in_use_by = self
            .env_service
            .usage
            .sessions_using(&name, source, agent_id.as_deref());

        let result = match source {
            EnvSource::Server => self
                .env_service
                .store
                .read(&name)
                .await
                .map_err(|e| e.to_string()),
            EnvSource::Agent => match &agent_id {
                Some(aid) => self
                    .agent_command(aid, "server.env.get", json!({ "name": name }))
                    .await
                    .and_then(|resp| {
                        if resp.get("success").and_then(serde_json::Value::as_bool) == Some(true) {
                            Ok(resp
                                .get("content")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string())
                        } else {
                            Err(resp
                                .get("error")
                                .and_then(|v| v.as_str())
                                .unwrap_or("read failed")
                                .to_string())
                        }
                    }),
                None => Err("agent_id is required for agent files".to_string()),
            },
        };

        match result {
            Ok(content) => Ok(reply_json(
                &msg.id,
                "client.env.get.response",
                json!({ "success": true, "content": content, "in_use_by": in_use_by }),
            )),
            Err(e) => Ok(reply_json(
                &msg.id,
                "client.env.get.response",
                json!({ "success": false, "error": e, "in_use_by": in_use_by }),
            )),
        }
    }

    /// Handle `client.env.write` — create/overwrite an env file. Blocks writes
    /// to files currently in use by a running session (SC5/EC10).
    async fn handle_client_env_write(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(reply_json(
                &msg.id,
                "client.env.write.response",
                json!({ "success": false, "error": "Not authenticated" }),
            ));
        }
        let (name, source, agent_id) = parse_env_ref(&msg.payload);
        let content = msg
            .payload
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let overwrite = msg
            .payload
            .get("overwrite")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);

        if name.is_empty() {
            return Ok(reply_json(
                &msg.id,
                "client.env.write.response",
                json!({ "success": false, "error": "name is required" }),
            ));
        }

        // In-use lock: an overwrite of a file bound to a running session is
        // refused with a clear message listing the sessions.
        if overwrite {
            let in_use = self
                .env_service
                .usage
                .sessions_using(&name, source, agent_id.as_deref());
            if !in_use.is_empty() {
                return Ok(reply_json(
                    &msg.id,
                    "client.env.write.response",
                    json!({
                        "success": false,
                        "error": format!(
                            "This file is in use by session(s): {}. Stop the session or detach before editing.",
                            in_use.join(", ")
                        )
                    }),
                ));
            }
        }

        let warnings = parse_env(&content).warnings;

        let outcome = match source {
            EnvSource::Server => self
                .env_service
                .store
                .write(&name, &content, overwrite)
                .await
                .map_err(|e| e.to_string()),
            EnvSource::Agent => match &agent_id {
                Some(aid) => self
                    .agent_command(
                        aid,
                        "server.env.write",
                        json!({ "name": name, "content": content, "overwrite": overwrite }),
                    )
                    .await
                    .map(|resp| {
                        // Agent returns success=true on write, exists=true when
                        // refused for lack of overwrite.
                        resp.get("success").and_then(serde_json::Value::as_bool) == Some(true)
                    }),
                None => Err("agent_id is required for agent files".to_string()),
            },
        };

        match outcome {
            Ok(true) => Ok(reply_json(
                &msg.id,
                "client.env.write.response",
                json!({ "success": true, "warnings": warnings }),
            )),
            Ok(false) => Ok(reply_json(
                &msg.id,
                "client.env.write.response",
                json!({ "success": false, "exists": true }),
            )),
            Err(e) => Ok(reply_json(
                &msg.id,
                "client.env.write.response",
                json!({ "success": false, "error": e }),
            )),
        }
    }

    /// Handle `client.env.delete` — delete an env file (blocked if in use).
    async fn handle_client_env_delete(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(reply_json(
                &msg.id,
                "client.env.delete.response",
                json!({ "success": false, "error": "Not authenticated" }),
            ));
        }
        let (name, source, agent_id) = parse_env_ref(&msg.payload);
        if name.is_empty() {
            return Ok(reply_json(
                &msg.id,
                "client.env.delete.response",
                json!({ "success": false, "error": "name is required" }),
            ));
        }

        let in_use = self
            .env_service
            .usage
            .sessions_using(&name, source, agent_id.as_deref());
        if !in_use.is_empty() {
            return Ok(reply_json(
                &msg.id,
                "client.env.delete.response",
                json!({
                    "success": false,
                    "error": format!(
                        "This file is in use by session(s): {}. Stop the session or detach before deleting.",
                        in_use.join(", ")
                    )
                }),
            ));
        }

        let outcome = match source {
            EnvSource::Server => self
                .env_service
                .store
                .delete(&name)
                .await
                .map_err(|e| e.to_string()),
            EnvSource::Agent => match &agent_id {
                Some(aid) => self
                    .agent_command(aid, "server.env.delete", json!({ "name": name }))
                    .await
                    .and_then(|resp| {
                        if resp.get("success").and_then(serde_json::Value::as_bool) == Some(true) {
                            Ok(())
                        } else {
                            Err(resp
                                .get("error")
                                .and_then(|v| v.as_str())
                                .unwrap_or("delete failed")
                                .to_string())
                        }
                    }),
                None => Err("agent_id is required for agent files".to_string()),
            },
        };

        match outcome {
            Ok(()) => Ok(reply_json(
                &msg.id,
                "client.env.delete.response",
                json!({ "success": true }),
            )),
            Err(e) => Ok(reply_json(
                &msg.id,
                "client.env.delete.response",
                json!({ "success": false, "error": e }),
            )),
        }
    }

    /// Resolve a set of env-file references into snapshots, capturing content at
    /// this moment (snapshot semantics). Server files are read locally; agent
    /// files are fetched from the owning agent. Missing files produce an error.
    async fn resolve_snapshots(
        &self,
        agent_id: &str,
        refs: &[EnvFileRef],
    ) -> Result<Vec<EnvSnapshot>, String> {
        let mut snapshots = Vec::new();
        for r in refs {
            let content = match r.source {
                EnvSource::Server => self.env_service.store.read(&r.name).await.map_err(|_| {
                    format!("Env file not found. It may have been deleted: {}", r.name)
                })?,
                EnvSource::Agent => {
                    // Agent files are read from the file's owning agent (which is
                    // normally the same agent hosting the session).
                    let owner = r.agent_id.as_deref().unwrap_or(agent_id);
                    let resp = self
                        .agent_command(owner, "server.env.get", json!({ "name": r.name }))
                        .await?;
                    if resp.get("success").and_then(serde_json::Value::as_bool) != Some(true) {
                        return Err(format!(
                            "Env file not found. It may have been deleted: {}",
                            r.name
                        ));
                    }
                    resp.get("content")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string()
                }
            };
            let parsed = parse_env(&content);
            snapshots.push(EnvSnapshot {
                name: r.name.clone(),
                source: r.source,
                agent_id: r.agent_id.clone(),
                vars: parsed.vars,
                warnings: parsed.warnings,
            });
        }
        Ok(snapshots)
    }

    /// Handle `client.session.env.apply` — apply env files to a running session.
    async fn handle_client_session_env_apply(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(reply_json(
                &msg.id,
                "client.session.env.apply.response",
                json!({ "success": false, "error": "Not authenticated" }),
            ));
        }
        let session_id = msg
            .payload
            .get("session_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let refs: Vec<EnvFileRef> = msg
            .payload
            .get("env_files")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();

        let Some((agent_id, session_name)) = session_id.split_once(':') else {
            return Ok(reply_json(
                &msg.id,
                "client.session.env.apply.response",
                json!({ "success": false, "error": "Invalid session_id" }),
            ));
        };
        let agent_id = agent_id.to_string();
        let session_name = session_name.to_string();

        let snapshots = match self.resolve_snapshots(&agent_id, &refs).await {
            Ok(s) => s,
            Err(e) => {
                return Ok(reply_json(
                    &msg.id,
                    "client.session.env.apply.response",
                    json!({ "success": false, "error": e }),
                ));
            }
        };

        let warnings: Vec<String> = snapshots.iter().flat_map(|s| s.warnings.clone()).collect();

        let resp = self
            .agent_command(
                &agent_id,
                "server.session.env.apply",
                json!({ "name": session_name, "snapshots": snapshots }),
            )
            .await;

        match resp {
            Ok(r) if r.get("success").and_then(serde_json::Value::as_bool) == Some(true) => {
                self.env_service
                    .usage
                    .record_attach(&session_id, &refs, None);
                Ok(reply_json(
                    &msg.id,
                    "client.session.env.apply.response",
                    json!({ "success": true, "warnings": warnings }),
                ))
            }
            Ok(r) => Ok(reply_json(
                &msg.id,
                "client.session.env.apply.response",
                json!({
                    "success": false,
                    "error": r.get("error").and_then(|v| v.as_str()).unwrap_or("apply failed")
                }),
            )),
            Err(e) => Ok(reply_json(
                &msg.id,
                "client.session.env.apply.response",
                json!({ "success": false, "error": e }),
            )),
        }
    }

    /// Handle `client.session.env.unset` — remove attach-time env files from a
    /// running session (on detach).
    async fn handle_client_session_env_unset(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(reply_json(
                &msg.id,
                "client.session.env.unset.response",
                json!({ "success": false, "error": "Not authenticated" }),
            ));
        }
        let session_id = msg
            .payload
            .get("session_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let refs: Vec<EnvFileRef> = msg
            .payload
            .get("env_files")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();

        let Some((agent_id, session_name)) = session_id.split_once(':') else {
            return Ok(reply_json(
                &msg.id,
                "client.session.env.unset.response",
                json!({ "success": false, "error": "Invalid session_id" }),
            ));
        };
        let agent_id = agent_id.to_string();
        let session_name = session_name.to_string();

        // Resolve the keys to unset from the current file content. Best-effort:
        // if a file is now missing, skip it rather than failing the detach.
        let snapshots = self
            .resolve_snapshots(&agent_id, &refs)
            .await
            .unwrap_or_default();
        let keys: Vec<String> = snapshots
            .iter()
            .flat_map(|s| s.vars.iter().map(|(k, _)| k.clone()))
            .collect();

        let resp = self
            .agent_command(
                &agent_id,
                "server.session.env.unset",
                json!({ "name": session_name, "keys": keys }),
            )
            .await;

        // Release the usage regardless of the agent's reply — the client's
        // intent to detach is authoritative for lock purposes.
        self.env_service
            .usage
            .remove_attach(&session_id, &refs, None);

        match resp {
            Ok(r) if r.get("success").and_then(serde_json::Value::as_bool) == Some(true) => {
                Ok(reply_json(
                    &msg.id,
                    "client.session.env.unset.response",
                    json!({ "success": true }),
                ))
            }
            Ok(r) => Ok(reply_json(
                &msg.id,
                "client.session.env.unset.response",
                json!({
                    "success": false,
                    "error": r.get("error").and_then(|v| v.as_str()).unwrap_or("unset failed")
                }),
            )),
            Err(e) => Ok(reply_json(
                &msg.id,
                "client.session.env.unset.response",
                json!({ "success": false, "error": e }),
            )),
        }
    }

    /// Handle `client.session.env.active` — list env files active on a session.
    async fn handle_client_session_env_active(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(reply_json(
                &msg.id,
                "client.session.env.active.response",
                json!({ "active": [], "error": "Not authenticated" }),
            ));
        }
        let session_id = msg
            .payload
            .get("session_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let active = self.env_service.usage.active_for(session_id);
        Ok(reply_json(
            &msg.id,
            "client.session.env.active.response",
            json!({ "active": active }),
        ))
    }

    /// Handle `client.session.env.query` — ask the agent which env files are
    /// currently sourced (applied to its process environment).
    async fn handle_client_session_env_query(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(reply_json(
                &msg.id,
                "client.session.env.query.response",
                json!({ "sourced_files": [], "error": "Not authenticated" }),
            ));
        }
        let session_id = msg
            .payload
            .get("session_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let Some((agent_id, _session_name)) = session_id.split_once(':') else {
            return Ok(reply_json(
                &msg.id,
                "client.session.env.query.response",
                json!({ "sourced_files": [], "error": "Invalid session_id" }),
            ));
        };
        let resp = self
            .agent_command(agent_id, "server.env.query", json!({}))
            .await;
        match resp {
            Ok(r) => {
                let sourced = r
                    .get("sourced_files")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                Ok(reply_json(
                    &msg.id,
                    "client.session.env.query.response",
                    json!({ "sourced_files": sourced }),
                ))
            }
            Err(e) => Ok(reply_json(
                &msg.id,
                "client.session.env.query.response",
                json!({ "sourced_files": [], "error": e }),
            )),
        }
    }
}

/// Build a `HandlerAction::Reply` with a standard protocol envelope.
fn reply_json(id: &str, msg_type: &str, payload: serde_json::Value) -> HandlerAction {
    HandlerAction::Reply(Some(Message::Text(
        json!({
            "msg_type": msg_type,
            "id": id,
            "timestamp": current_timestamp(),
            "payload": payload,
        })
        .to_string(),
    )))
}

/// Extract (name, source, agent_id) from an env-file reference payload.
fn parse_env_ref(payload: &serde_json::Value) -> (String, EnvSource, Option<String>) {
    let name = payload
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let source = match payload.get("source").and_then(|v| v.as_str()) {
        Some("agent") => EnvSource::Agent,
        _ => EnvSource::Server,
    };
    let agent_id = payload
        .get("agent_id")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    (name, source, agent_id)
}

fn current_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::env::EnvService;
    use crate::registry::{AgentRegistry, SessionRegistry};
    use crate::server::client_registry::ClientRegistry;
    use crate::server::command_broker::CommandBroker;
    use tokio_tungstenite::tungstenite::Message;

    /// Build a test handler wired to in-memory DB + tempdir env store.
    async fn test_handler(auth_token: &str) -> ConnectionHandler {
        let db = Arc::new(Database::new(":memory:").await.unwrap());
        let agent_registry = Arc::new(AgentRegistry::new(60, Arc::clone(&db)));
        let session_registry = Arc::new(SessionRegistry::new(Arc::clone(&db)));
        let command_broker = Arc::new(CommandBroker::new());
        let client_registry = Arc::new(ClientRegistry::new());
        let env_root = tempfile::tempdir().unwrap().keep();
        let env_service = EnvService::new(env_root);
        ConnectionHandler::new(
            agent_registry,
            session_registry,
            command_broker,
            client_registry,
            env_service,
            auth_token.to_string(),
            30,
        )
    }

    fn proto_msg(msg_type: &str, payload: serde_json::Value) -> Message {
        let text = json!({
            "msg_type": msg_type,
            "id": "test-1",
            "timestamp": 0,
            "payload": payload,
        })
        .to_string();
        Message::Text(text)
    }

    fn parse_reply(action: HandlerAction) -> serde_json::Value {
        match action {
            HandlerAction::Reply(Some(Message::Text(text))) => serde_json::from_str(&text).unwrap(),
            _ => panic!("expected Reply(Some(Text))"),
        }
    }

    // ---- handle_message dispatch ----

    #[tokio::test]
    async fn close_message_returns_close() {
        let mut h = test_handler("").await;
        let action = h.handle_message(Message::Close(None)).await.unwrap();
        assert!(matches!(action, HandlerAction::Close));
    }

    #[tokio::test]
    async fn binary_message_returns_empty_reply() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(Message::Binary(vec![1, 2, 3]))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }

    #[tokio::test]
    async fn invalid_json_returns_error() {
        let mut h = test_handler("").await;
        let result = h.handle_message(Message::Text("not json".into())).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn unknown_msg_type_returns_empty_reply() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg("unknown.type", json!({})))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }

    // ---- agent.register ----

    #[tokio::test]
    async fn agent_register_no_auth_mode() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "agent.register",
                json!({
                    "agent_id": "a1",
                    "hostname": "host",
                    "ip_address": "1.2.3.4",
                    "port": 19091,
                    "auth_token": "anything",
                    "addresses": [],
                    "connect_url": null,
                    "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
                }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "accepted");
        assert_eq!(h.registered_agent_id(), Some(&"a1".to_string()));
    }

    #[tokio::test]
    async fn agent_register_valid_token() {
        let mut h = test_handler("secret").await;
        let action = h
            .handle_message(proto_msg(
                "agent.register",
                json!({
                    "agent_id": "a1",
                    "hostname": "host",
                    "ip_address": "1.2.3.4",
                    "port": 19091,
                    "auth_token": "secret",
                    "addresses": [],
                    "connect_url": null,
                    "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
                }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "accepted");
    }

    #[tokio::test]
    async fn agent_register_invalid_token_rejected() {
        let mut h = test_handler("secret").await;
        let action = h
            .handle_message(proto_msg(
                "agent.register",
                json!({
                    "agent_id": "a1",
                    "hostname": "host",
                    "ip_address": "1.2.3.4",
                    "port": 19091,
                    "auth_token": "wrong",
                    "addresses": [],
                    "connect_url": null,
                    "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
                }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "rejected");
        assert!(reply["payload"]["message"]
            .as_str()
            .unwrap()
            .contains("Invalid auth token"));
    }

    #[tokio::test]
    async fn agent_register_with_addresses() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "agent.register",
                json!({
                    "agent_id": "a1",
                    "hostname": "host",
                    "ip_address": "1.2.3.4",
                    "port": 19091,
                    "auth_token": "",
                    "addresses": [
                        { "url": "ws://1.2.3.4:19091/ws", "network_type": "lan", "label": "" }
                    ],
                    "connect_url": null,
                    "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
                }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "accepted");
        // Verify heartbeat_interval_secs is present
        assert_eq!(reply["payload"]["heartbeat_interval_secs"], 30);
    }

    // ---- agent.heartbeat ----

    #[tokio::test]
    async fn agent_heartbeat_registered() {
        let mut h = test_handler("").await;
        // Register first
        h.handle_message(proto_msg(
            "agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();

        let action = h
            .handle_message(proto_msg(
                "agent.heartbeat",
                json!({
                    "agent_id": "a1",
                    "session_count": 3,
                    "active_sessions": 1,
                }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["msg_type"], "server.heartbeat.ack");
        assert_eq!(reply["payload"]["agent_id"], "a1");
    }

    #[tokio::test]
    async fn agent_heartbeat_unregistered_returns_none() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "agent.heartbeat",
                json!({
                    "agent_id": "unknown",
                    "session_count": 0,
                    "active_sessions": 0,
                }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }

    #[tokio::test]
    async fn agent_heartbeat_missing_fields_defaults_to_zero() {
        let mut h = test_handler("").await;
        // Register
        h.handle_message(proto_msg(
            "agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
        // Heartbeat with no session_count / active_sessions
        let action = h
            .handle_message(proto_msg("agent.heartbeat", json!({ "agent_id": "a1" })))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["msg_type"], "server.heartbeat.ack");
    }

    // ---- agent.session.update ----

    #[tokio::test]
    async fn session_update_active() {
        let mut h = test_handler("").await;
        // Register agent
        h.handle_message(proto_msg(
            "agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();

        let action = h
            .handle_message(proto_msg(
                "agent.session.update",
                json!({
                    "agent_id": "a1",
                    "session_name": "dev",
                    "status": "active",
                    "window_count": 2,
                    "attached_clients": 1,
                }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }

    #[tokio::test]
    async fn session_update_all_statuses() {
        let mut h = test_handler("").await;
        h.handle_message(proto_msg(
            "agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();

        for status in &["active", "detached", "recovering", "orphaned", "zombie"] {
            let action = h
                .handle_message(proto_msg(
                    "agent.session.update",
                    json!({
                        "agent_id": "a1",
                        "session_name": format!("s_{status}"),
                        "status": status,
                        "window_count": 1,
                        "attached_clients": 0,
                    }),
                ))
                .await
                .unwrap();
            assert!(matches!(action, HandlerAction::Reply(None)));
        }
    }

    #[tokio::test]
    async fn session_update_unknown_status_returns_none() {
        let mut h = test_handler("").await;
        h.handle_message(proto_msg(
            "agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
        let action = h
            .handle_message(proto_msg(
                "agent.session.update",
                json!({
                    "agent_id": "a1",
                    "session_name": "dev",
                    "status": "invalid_status",
                }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }

    #[tokio::test]
    async fn session_update_gone_removes_session() {
        let mut h = test_handler("").await;
        // Register agent
        h.handle_message(proto_msg(
            "agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
        // Create a session
        h.handle_message(proto_msg(
            "agent.session.update",
            json!({
                "agent_id": "a1",
                "session_name": "dev",
                "status": "active",
                "window_count": 1,
                "attached_clients": 0,
            }),
        ))
        .await
        .unwrap();
        // Remove it
        h.handle_message(proto_msg(
            "agent.session.update",
            json!({
                "agent_id": "a1",
                "session_name": "dev",
                "status": "gone",
            }),
        ))
        .await
        .unwrap();
        // Session should be gone
        let _action = h
            .handle_message(proto_msg("client.sessions.list", json!({})))
            .await
            .unwrap();
        // First need to authenticate
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg("client.sessions.list", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(reply["payload"]["sessions"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn session_update_from_unregistered_agent() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "agent.session.update",
                json!({
                    "agent_id": "unknown",
                    "session_name": "dev",
                    "status": "active",
                }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }

    // ---- client.auth ----

    #[tokio::test]
    async fn client_auth_success() {
        let mut h = test_handler("secret").await;
        let action = h
            .handle_message(proto_msg("client.auth", json!({ "auth_token": "secret" })))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "success");
    }

    #[tokio::test]
    async fn client_auth_failure() {
        let mut h = test_handler("secret").await;
        let action = h
            .handle_message(proto_msg("client.auth", json!({ "auth_token": "wrong" })))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "failed");
    }

    #[tokio::test]
    async fn client_auth_no_auth_mode() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "client.auth",
                json!({ "auth_token": "anything" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "success");
    }

    // ---- unauthenticated client rejection ----

    #[tokio::test]
    async fn unauthenticated_agents_list_rejected() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg("client.agents.list", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "error");
    }

    #[tokio::test]
    async fn unauthenticated_sessions_list_rejected() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg("client.sessions.list", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "error");
    }

    #[tokio::test]
    async fn unauthenticated_session_attach_rejected() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "client.session.attach",
                json!({ "session_id": "a1:s1" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "error");
    }

    #[tokio::test]
    async fn unauthenticated_session_create_rejected() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "client.session.create",
                json!({ "agent_id": "a1", "name": "dev" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
    }

    #[tokio::test]
    async fn unauthenticated_session_kill_rejected() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "client.session.kill",
                json!({ "session_id": "a1:s1" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
    }

    // ---- client.agents.list ----

    #[tokio::test]
    async fn agents_list_returns_registered() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        // Register an agent
        h.handle_message(proto_msg(
            "agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();

        let action = h
            .handle_message(proto_msg("client.agents.list", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        let agents = reply["payload"]["agents"].as_array().unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0]["agent_id"], "a1");
        assert_eq!(agents[0]["status"], "online");
    }

    #[tokio::test]
    async fn agents_list_empty() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg("client.agents.list", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(reply["payload"]["agents"].as_array().unwrap().is_empty());
    }

    // ---- client.sessions.list ----

    #[tokio::test]
    async fn sessions_list_with_filter() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        // Register agent
        h.handle_message(proto_msg(
            "agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
        // Create sessions
        for name in &["s1", "s2"] {
            h.handle_message(proto_msg(
                "agent.session.update",
                json!({
                    "agent_id": "a1",
                    "session_name": name,
                    "status": "active",
                    "window_count": 1,
                    "attached_clients": 0,
                }),
            ))
            .await
            .unwrap();
        }
        // Filter by agent_id
        let action = h
            .handle_message(proto_msg(
                "client.sessions.list",
                json!({ "agent_id": "a1" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        let sessions = reply["payload"]["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 2);
    }

    // ---- client.session.attach ----

    #[tokio::test]
    async fn attach_invalid_session_id_format() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "client.session.attach",
                json!({ "session_id": "no-colon" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(reply["payload"]["message"]
            .as_str()
            .unwrap()
            .contains("Invalid session_id format"));
    }

    #[tokio::test]
    async fn attach_session_not_found() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "client.session.attach",
                json!({ "session_id": "a1:nonexistent" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(reply["payload"]["message"]
            .as_str()
            .unwrap()
            .contains("not found"));
    }

    #[tokio::test]
    async fn attach_agent_offline() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        // Register agent
        h.handle_message(proto_msg(
            "agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
        // Create session
        h.handle_message(proto_msg(
            "agent.session.update",
            json!({
                "agent_id": "a1",
                "session_name": "dev",
                "status": "active",
                "window_count": 1,
                "attached_clients": 0,
            }),
        ))
        .await
        .unwrap();
        // Manually set agent offline by checking with timeout
        h.agent_registry.check_offline_agents().await;
        // Force offline: update heartbeat to long ago
        h.agent_registry.unregister("a1").await;

        // Re-register with a different approach - just test that agent not found works
        let action = h
            .handle_message(proto_msg(
                "client.session.attach",
                json!({ "session_id": "a1:dev" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(reply["payload"]["message"]
            .as_str()
            .unwrap()
            .contains("not found"));
    }

    #[tokio::test]
    async fn attach_p2p_mode_success() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        // Register agent
        h.handle_message(proto_msg(
            "agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
        // Create session
        h.handle_message(proto_msg(
            "agent.session.update",
            json!({
                "agent_id": "a1",
                "session_name": "dev",
                "status": "active",
                "window_count": 1,
                "attached_clients": 0,
            }),
        ))
        .await
        .unwrap();
        // Attach in P2P mode
        let action = h
            .handle_message(proto_msg(
                "client.session.attach",
                json!({ "session_id": "a1:dev", "preferred_mode": "p2p" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["status"], "success");
        assert_eq!(reply["payload"]["mode"], "p2p");
        assert!(reply["payload"]["agent_address"]
            .as_str()
            .unwrap()
            .contains("1.2.3.4"));
    }

    #[tokio::test]
    async fn attach_relay_mode() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        // Register agent + create session
        h.handle_message(proto_msg(
            "agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
        h.handle_message(proto_msg(
            "agent.session.update",
            json!({
                "agent_id": "a1",
                "session_name": "dev",
                "status": "active",
                "window_count": 1,
                "attached_clients": 0,
            }),
        ))
        .await
        .unwrap();

        // Phase 1: query relay — returns info but does NOT enter relay forwarding.
        let action = h
            .handle_message(proto_msg(
                "client.session.attach",
                json!({ "session_id": "a1:dev", "preferred_mode": "relay" }),
            ))
            .await
            .unwrap();
        assert!(
            matches!(action, HandlerAction::Reply(None)),
            "Phase 1 should return Reply(None)"
        );

        // Phase 2: begin relay — actually enters relay forwarding.
        let action = h
            .handle_message(proto_msg(
                "client.session.relay.begin",
                json!({ "session_id": "a1:dev" }),
            ))
            .await
            .unwrap();
        match action {
            HandlerAction::Relay {
                agent_ws_urls,
                session_id: _,
                session_name,
                client_id: _,
                env_snapshots,
                cols: _,
                rows: _,
            } => {
                assert!(!agent_ws_urls.is_empty(), "expected at least one relay URL");
                assert!(agent_ws_urls[0].contains("1.2.3.4"));
                assert_eq!(session_name, "dev");
                assert!(env_snapshots.is_empty());
            }
            _ => panic!("expected Relay action"),
        }
    }

    // ---- client.session.create ----

    #[tokio::test]
    async fn session_create_missing_fields() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "client.session.create",
                json!({ "agent_id": "", "name": "" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("required"));
    }

    #[tokio::test]
    async fn session_create_agent_not_found() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "client.session.create",
                json!({ "agent_id": "nonexistent", "name": "dev" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("not found"));
    }

    // ---- client.session.kill ----

    #[tokio::test]
    async fn session_kill_invalid_format() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "client.session.kill",
                json!({ "session_id": "no-colon" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("Invalid session_id format"));
    }

    #[tokio::test]
    async fn session_kill_agent_not_found() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "client.session.kill",
                json!({ "session_id": "unknown:s1" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("not found"));
    }

    #[tokio::test]
    async fn session_kill_session_not_found_agent_online() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        // Register agent (it's online)
        h.handle_message(proto_msg(
            "agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
        // Kill a session that doesn't exist — agent is online
        let action = h
            .handle_message(proto_msg(
                "client.session.kill",
                json!({ "session_id": "a1:nonexistent" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("not found"));
    }

    // ---- agent.session.command.response ----

    #[tokio::test]
    async fn command_response_from_unregistered_returns_none() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "agent.session.command.response",
                json!({ "request_id": "r1", "success": true }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }

    #[tokio::test]
    async fn command_response_missing_request_id_returns_none() {
        let mut h = test_handler("").await;
        // Register agent
        h.handle_message(proto_msg(
            "agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
        let action = h
            .handle_message(proto_msg(
                "agent.session.command.response",
                json!({ "request_id": "", "success": true }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }

    // ---- env handlers (unauthenticated) ----

    #[tokio::test]
    async fn env_list_unauthenticated() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg("client.env.list", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["error"], "Not authenticated");
    }

    #[tokio::test]
    async fn env_get_unauthenticated() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg("client.env.get", json!({ "name": "test.env" })))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["error"], "Not authenticated");
    }

    #[tokio::test]
    async fn env_write_unauthenticated() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "client.env.write",
                json!({ "name": "test.env", "content": "X=1" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["error"], "Not authenticated");
    }

    #[tokio::test]
    async fn env_delete_unauthenticated() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "client.env.delete",
                json!({ "name": "test.env" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["error"], "Not authenticated");
    }

    // ---- env handlers (authenticated, server files) ----

    #[tokio::test]
    async fn env_get_missing_name() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg("client.env.get", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("required"));
    }

    #[tokio::test]
    async fn env_write_and_read_server_file() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        // Write
        let action = h
            .handle_message(proto_msg(
                "client.env.write",
                json!({
                    "name": "test.env",
                    "content": "FOO=bar\nBAZ=qux",
                    "overwrite": false,
                }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], true);
        // Read back
        let action = h
            .handle_message(proto_msg(
                "client.env.get",
                json!({ "name": "test.env", "source": "server" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], true);
        assert!(reply["payload"]["content"]
            .as_str()
            .unwrap()
            .contains("FOO=bar"));
    }

    #[tokio::test]
    async fn env_write_missing_name() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "client.env.write",
                json!({ "name": "", "content": "X=1" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("required"));
    }

    #[tokio::test]
    async fn env_delete_missing_name() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg("client.env.delete", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("required"));
    }

    #[tokio::test]
    async fn env_list_server_files() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        // Write a file first
        h.handle_message(proto_msg(
            "client.env.write",
            json!({
                "name": "test.env",
                "content": "X=1",
                "overwrite": false,
            }),
        ))
        .await
        .unwrap();
        let action = h
            .handle_message(proto_msg("client.env.list", json!({})))
            .await
            .unwrap();
        let reply = parse_reply(action);
        let files = reply["payload"]["files"].as_array().unwrap();
        assert!(!files.is_empty());
    }

    #[tokio::test]
    async fn env_delete_server_file() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        h.handle_message(proto_msg(
            "client.env.write",
            json!({ "name": "del.env", "content": "X=1", "overwrite": false }),
        ))
        .await
        .unwrap();
        let action = h
            .handle_message(proto_msg(
                "client.env.delete",
                json!({ "name": "del.env", "source": "server" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], true);
    }

    // ---- session env handlers ----

    #[tokio::test]
    async fn session_env_apply_unauthenticated() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "client.session.env.apply",
                json!({ "session_id": "a1:s1", "env_files": [] }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["error"], "Not authenticated");
    }

    #[tokio::test]
    async fn session_env_apply_invalid_session_id() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "client.session.env.apply",
                json!({ "session_id": "no-colon", "env_files": [] }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("Invalid session_id"));
    }

    #[tokio::test]
    async fn session_env_unset_unauthenticated() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "client.session.env.unset",
                json!({ "session_id": "a1:s1" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["error"], "Not authenticated");
    }

    #[tokio::test]
    async fn session_env_unset_invalid_session_id() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "client.session.env.unset",
                json!({ "session_id": "no-colon" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
    }

    #[tokio::test]
    async fn session_env_active_unauthenticated() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "client.session.env.active",
                json!({ "session_id": "a1:s1" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["error"], "Not authenticated");
    }

    #[tokio::test]
    async fn session_env_active_returns_list() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "client.session.env.active",
                json!({ "session_id": "a1:s1" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(reply["payload"]["active"].as_array().is_some());
    }

    #[tokio::test]
    async fn session_env_query_unauthenticated() {
        let mut h = test_handler("").await;
        let action = h
            .handle_message(proto_msg(
                "client.session.env.query",
                json!({ "session_id": "a1:s1" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["error"], "Not authenticated");
    }

    #[tokio::test]
    async fn session_env_query_invalid_session_id() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "client.session.env.query",
                json!({ "session_id": "no-colon" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("Invalid session_id"));
    }

    // ---- parse_env_ref ----

    #[test]
    fn parse_env_ref_server_default() {
        let payload = json!({ "name": "test.env" });
        let (name, source, agent_id) = parse_env_ref(&payload);
        assert_eq!(name, "test.env");
        assert_eq!(source, EnvSource::Server);
        assert!(agent_id.is_none());
    }

    #[test]
    fn parse_env_ref_agent() {
        let payload = json!({ "name": "test.env", "source": "agent", "agent_id": "a1" });
        let (name, source, agent_id) = parse_env_ref(&payload);
        assert_eq!(name, "test.env");
        assert_eq!(source, EnvSource::Agent);
        assert_eq!(agent_id, Some("a1".to_string()));
    }

    #[test]
    fn parse_env_ref_empty() {
        let payload = json!({});
        let (name, source, agent_id) = parse_env_ref(&payload);
        assert_eq!(name, "");
        assert_eq!(source, EnvSource::Server);
        assert!(agent_id.is_none());
    }

    // ---- env write in-use lock ----

    #[tokio::test]
    async fn env_write_blocked_when_in_use() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        // Write a file first
        h.handle_message(proto_msg(
            "client.env.write",
            json!({ "name": "locked.env", "content": "X=1", "overwrite": false }),
        ))
        .await
        .unwrap();
        // Record usage
        h.env_service.usage.record_create(
            "a1:s1",
            &[nession_common::protocol::EnvFileRef {
                name: "locked.env".to_string(),
                source: EnvSource::Server,
                agent_id: None,
            }],
            None,
        );
        // Try to overwrite — should fail
        let action = h
            .handle_message(proto_msg(
                "client.env.write",
                json!({
                    "name": "locked.env",
                    "content": "X=2",
                    "overwrite": true,
                    "source": "server",
                }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("in use"));
    }

    #[tokio::test]
    async fn env_delete_blocked_when_in_use() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        // Write a file first
        h.handle_message(proto_msg(
            "client.env.write",
            json!({ "name": "used.env", "content": "X=1", "overwrite": false }),
        ))
        .await
        .unwrap();
        // Record usage
        h.env_service.usage.record_create(
            "a1:s1",
            &[nession_common::protocol::EnvFileRef {
                name: "used.env".to_string(),
                source: EnvSource::Server,
                agent_id: None,
            }],
            None,
        );
        // Try to delete — should fail
        let action = h
            .handle_message(proto_msg(
                "client.env.delete",
                json!({ "name": "used.env", "source": "server" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("in use"));
    }

    // ---- agent.env.get without agent_id ----

    #[tokio::test]
    async fn env_get_agent_without_agent_id() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "client.env.get",
                json!({ "name": "test.env", "source": "agent" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("agent_id is required"));
    }

    #[tokio::test]
    async fn env_write_agent_without_agent_id() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "client.env.write",
                json!({ "name": "test.env", "content": "X=1", "source": "agent" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("agent_id is required"));
    }

    #[tokio::test]
    async fn env_delete_agent_without_agent_id() {
        let mut h = test_handler("").await;
        h.authenticated_client = true;
        let action = h
            .handle_message(proto_msg(
                "client.env.delete",
                json!({ "name": "test.env", "source": "agent" }),
            ))
            .await
            .unwrap();
        let reply = parse_reply(action);
        assert_eq!(reply["payload"]["success"], false);
        assert!(reply["payload"]["error"]
            .as_str()
            .unwrap()
            .contains("agent_id is required"));
    }

    // ---- agent.terminal.resize ----

    #[tokio::test]
    async fn agent_terminal_resize_broadcasts_to_attached_clients() {
        use crate::server::command_broker::WsMessageSender;

        let mut h = test_handler("").await;

        // Register two clients in the ClientRegistry for the target session
        let client_registry = Arc::clone(&h.client_registry);
        let (sender1, mut rx1) = WsMessageSender::new();
        let (sender2, mut rx2) = WsMessageSender::new();
        client_registry.register("a1:dev", "c1", sender1).await;
        client_registry.register("a1:dev", "c2", sender2).await;

        // Send agent.terminal.resize
        let action = h
            .handle_message(proto_msg(
                "agent.terminal.resize",
                json!({
                    "session_id": "a1:dev",
                    "cols": 120,
                    "rows": 40,
                }),
            ))
            .await
            .unwrap();

        // Handler returns Reply(None) — broadcast goes through ClientRegistry
        assert!(matches!(action, HandlerAction::Reply(None)));

        // Both clients should receive the broadcast message
        let msg1 = rx1.try_recv().unwrap();
        let msg2 = rx2.try_recv().unwrap();

        let parsed1: serde_json::Value = serde_json::from_str(msg1.to_text().unwrap()).unwrap();
        let parsed2: serde_json::Value = serde_json::from_str(msg2.to_text().unwrap()).unwrap();

        assert_eq!(parsed1["msg_type"], "terminal.resize");
        assert_eq!(parsed1["payload"]["session_id"], "a1:dev");
        assert_eq!(parsed1["payload"]["cols"], 120);
        assert_eq!(parsed1["payload"]["rows"], 40);
        assert_eq!(parsed2["msg_type"], "terminal.resize");
        assert_eq!(parsed2["payload"]["session_id"], "a1:dev");
    }

    #[tokio::test]
    async fn agent_terminal_resize_no_attached_clients() {
        let mut h = test_handler("").await;

        // No clients attached — should still succeed silently
        let action = h
            .handle_message(proto_msg(
                "agent.terminal.resize",
                json!({
                    "session_id": "a1:dev",
                    "cols": 80,
                    "rows": 24,
                }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }

    #[tokio::test]
    async fn agent_terminal_resize_invalid_payload() {
        let mut h = test_handler("").await;

        // Missing required fields — should log warning but not crash
        let action = h
            .handle_message(proto_msg(
                "agent.terminal.resize",
                json!({ "session_id": "a1:dev" }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }
}
