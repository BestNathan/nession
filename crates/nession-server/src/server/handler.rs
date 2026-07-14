use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use crate::env::EnvService;
use crate::registry::{AgentInfo, AgentRegistry, AgentStatus, SessionRegistry, SessionStatus};
use crate::server::command_broker::CommandBroker;
use nession_common::env_file::parse_env;
use nession_common::protocol::{
    AgentRegisterPayload, EnvFileRef, EnvSnapshot, EnvSource, ProtocolMessage,
};

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
    env_service: Arc<EnvService>,
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
        env_service: Arc<EnvService>,
        server_auth_token: String,
        heartbeat_interval_secs: u64,
    ) -> Self {
        Self {
            agent_registry,
            session_registry,
            command_broker,
            env_service,
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
            "client.env.list" => self.handle_client_env_list(msg).await,
            "client.env.get" => self.handle_client_env_get(msg).await,
            "client.env.write" => self.handle_client_env_write(msg).await,
            "client.env.delete" => self.handle_client_env_delete(msg).await,
            "client.session.env.apply" => self.handle_client_session_env_apply(msg).await,
            "client.session.env.unset" => self.handle_client_session_env_unset(msg).await,
            "client.session.env.active" => self.handle_client_session_env_active(msg).await,
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

        let agent_info = AgentInfo {
            agent_id: payload.agent_id.clone(),
            hostname: payload.hostname,
            ip_address: payload.ip_address,
            port: payload.port,
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
            // For relay mode, the server will proxy I/O between client and agent.
            // The handler loop must transition into relay mode.
            Ok(HandlerAction::Relay { agent_ws_url })
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
