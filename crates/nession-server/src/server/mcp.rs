//! The Server's MCP backends (`#565`).
//!
//! The Server hosts MCP by injecting **its own business services**, not a
//! second implementation:
//!
//! * cluster tools dispatch through the same `server_routes!` table a Web or
//!   CLI connection reaches, using a detached authenticated handler. Registry
//!   mutation, keyed-lane ordering and broadcast semantics are therefore the
//!   Server's, not a copy.
//! * node tools route to the explicitly named Agent through the existing
//!   command broker. The Server host never creates a tmux Session itself.
//!
//! `get_session_attach_info` is the one projection written here rather than
//! dispatched: `server.session.attach` mints a P2P credential as a side
//! effect, and this tool is read-only and must not. The projection is derived
//! from the registry and contains no authentication material by construction.

use std::sync::Arc;

use nession_common::config::ServerConfig;
use nession_mcp::backend::{ClusterBackend, NodeBackend};
use nession_mcp::error::ToolError;
use nession_mcp::{McpService, ServiceConfig};
use nession_protocol::Message;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::registry::{
    legacy_agent_address, AgentInfo, AgentRegistry, AgentStatus, SessionRegistry,
};
use crate::server::execution::{
    policy_for_wire, ExecutionPolicy, Lanes, ResourceKey, DEFAULT_MUTATIONS_IN_FLIGHT,
    DEFAULT_QUERY_CONCURRENCY, LANE_LABEL,
};
use crate::server::handler::{
    dispatch_server, ConnectionHandler, ConnectionHandlerConfig, ConnectionHandlerDeps,
    HandlerAction,
};
use nession_runtime::lane::KeyedLane;

/// Build the Server-hosted MCP service when `[mcp] enabled = true`.
pub(crate) fn build(
    config: &ServerConfig,
    deps: ConnectionHandlerDeps,
    mutations: Arc<KeyedLane<ResourceKey>>,
) -> anyhow::Result<Option<Arc<McpService>>> {
    if !config.mcp.enabled {
        return Ok(None);
    }
    // Fail closed even when a caller constructed `ServerConfig` directly
    // rather than through `validate()`.
    config
        .mcp
        .validate_for_host(&config.auth_token, "auth_token")?;

    let agent_registry = Arc::clone(&deps.agent_registry);
    let session_registry = Arc::clone(&deps.session_registry);
    let handler = ConnectionHandler::new_authenticated(
        deps,
        ConnectionHandlerConfig {
            server_auth_token: config.auth_token.clone(),
            heartbeat_interval_secs: config.heartbeat_interval_secs,
            terminal_cols: config.terminal_cols,
            terminal_web_font_size: config.terminal_web_font_size,
        },
    );

    let mutations_for_node = Arc::clone(&mutations);
    let cluster = Arc::new(ServerClusterBackend {
        handler: handler.clone(),
        agent_registry,
        session_registry,
        mutations,
    });
    let node = Arc::new(ServerNodeBackend {
        handler,
        agent_registry: Arc::clone(&cluster.agent_registry),
        mutations: mutations_for_node,
    });

    let service_config = ServiceConfig {
        path: config.mcp.path.clone(),
        auth_token: config.auth_token.clone(),
        tool_timeout: std::time::Duration::from_secs(config.mcp.tool_timeout_secs),
        max_concurrent_calls: config.mcp.max_concurrent_calls,
        session_idle: std::time::Duration::from_secs(
            nession_mcp::protocol::DEFAULT_SESSION_IDLE_SECS,
        ),
        max_sessions: nession_mcp::protocol::DEFAULT_MAX_SESSIONS,
    };
    let service = McpService::new(service_config, cluster, node)?;
    Ok(Some(Arc::new(service)))
}

struct ServerClusterBackend {
    handler: ConnectionHandler,
    agent_registry: Arc<AgentRegistry>,
    session_registry: Arc<SessionRegistry>,
    /// The runtime's keyed mutation lane, shared with every WebSocket
    /// connection. An MCP mutation of a Session queues against a browser's
    /// mutation of the same Session (#565).
    mutations: Arc<KeyedLane<ResourceKey>>,
}

impl ServerClusterBackend {
    async fn dispatch(&self, wire: &'static str, payload: Value) -> Result<Value, ToolError> {
        match policy_for_wire(wire, &payload) {
            ExecutionPolicy::Key(key) => {
                // The lane's work future must be `'static`; the handler
                // template and the payload are owned, so the queued work does
                // not borrow this backend.
                let handler = self.handler.clone();
                let (reply, result) = tokio::sync::oneshot::channel();
                let mut lanes = Lanes::shared(
                    DEFAULT_QUERY_CONCURRENCY,
                    Arc::clone(&self.mutations),
                    DEFAULT_MUTATIONS_IN_FLIGHT,
                    LANE_LABEL,
                );
                lanes
                    .key(
                        key,
                        Box::pin(async move {
                            let _ = reply.send(dispatch_with(handler, wire, payload).await);
                        }),
                    )
                    .await;
                result.await.map_err(|_| {
                    ToolError::backend("the Server's mutation lane ended before answering")
                })?
            }
            // `Inline`, `Query` and `Ordered` need no key. None of this
            // backend's mutations in this phase is `Ordered`; if one becomes
            // that, this branch is where the barrier must be added rather than
            // guessed at.
            _ => dispatch_with(self.handler.clone(), wire, payload).await,
        }
    }
}

/// Route one unit through the Server's real handler table.
async fn dispatch_with(
    mut handler: ConnectionHandler,
    wire: &'static str,
    payload: Value,
) -> Result<Value, ToolError> {
    let message = Message::new(
        wire,
        uuid::Uuid::new_v4().to_string(),
        now_millis(),
        payload,
    );
    let action = dispatch_server(&mut handler, message)
        .await
        .map_err(|error| ToolError::backend(error.to_string()))?;
    match action {
        HandlerAction::Reply(Some(WsMessage::Text(text))) => {
            let envelope: Message<Value> = serde_json::from_str(&text)
                .map_err(|error| ToolError::backend(error.to_string()))?;
            Ok(envelope.payload)
        }
        HandlerAction::Reply(Some(_)) | HandlerAction::Reply(None) => Err(ToolError::backend(
            "the Server produced no JSON reply for this unit",
        )),
        HandlerAction::Relay { .. } | HandlerAction::Close => Err(ToolError::backend(
            "the Server routed this unit away from a reply",
        )),
    }
}

#[async_trait::async_trait]
impl ClusterBackend for ServerClusterBackend {
    async fn list_agents(&self) -> Result<Value, ToolError> {
        self.dispatch("server.agent.list", json!({})).await
    }

    async fn list_sessions(&self, agent_id: Option<&str>, force: bool) -> Result<Value, ToolError> {
        self.dispatch(
            "server.session.list",
            json!({ "agent_id": agent_id, "force": force }),
        )
        .await
    }

    async fn get_info(&self) -> Result<Value, ToolError> {
        self.dispatch("server.info", json!({})).await
    }

    async fn capture_session_preview(
        &self,
        session_id: &str,
        lines: u32,
    ) -> Result<Value, ToolError> {
        self.dispatch(
            "server.session.capture-preview",
            json!({ "session_id": session_id, "lines": lines }),
        )
        .await
    }

    async fn get_session_attach_info(&self, session_id: &str) -> Result<Value, ToolError> {
        let Some((agent_id, _session_name)) = session_id.split_once(':') else {
            return Err(ToolError::invalid_argument(
                "session_id must be in `agent_id:session_name` form",
            ));
        };
        let Some(session) = self.session_registry.get(session_id).await else {
            return Err(ToolError::not_found(format!(
                "Session '{session_id}' is not in the registry"
            )));
        };
        let Some(agent) = self.agent_registry.get(agent_id).await else {
            return Err(ToolError::not_found(format!(
                "Agent '{agent_id}' is not in the registry"
            )));
        };
        if agent.status != AgentStatus::Online {
            return Err(ToolError::unavailable(format!(
                "Agent '{agent_id}' is {}",
                agent_status(&agent.status)
            )));
        }
        Ok(attach_info_projection(
            &session.session_id,
            &session.agent_id,
            &session.session_name,
            session_status(&session.status),
            &agent,
        ))
    }

    async fn create_session(&self, agent_id: &str, name: &str) -> Result<Value, ToolError> {
        self.dispatch(
            "server.session.create",
            json!({ "agent_id": agent_id, "name": name }),
        )
        .await
    }

    async fn kill_session(&self, session_id: &str) -> Result<Value, ToolError> {
        self.dispatch("server.session.kill", json!({ "session_id": session_id }))
            .await
    }

    async fn rename_agent(
        &self,
        agent_id: &str,
        display_name: Option<&str>,
    ) -> Result<Value, ToolError> {
        self.dispatch(
            "server.agent.rename",
            json!({ "agent_id": agent_id, "display_name": display_name }),
        )
        .await
    }

    async fn delete_agent(&self, agent_id: &str) -> Result<Value, ToolError> {
        self.dispatch("server.agent.delete", json!({ "agent_id": agent_id }))
            .await
    }
}

struct ServerNodeBackend {
    handler: ConnectionHandler,
    agent_registry: Arc<AgentRegistry>,
    /// The runtime's keyed mutation lane. A node create/kill is ordered against
    /// a cluster `server.session.create`/`kill` of the same Session, because
    /// both name the same registry resource.
    mutations: Arc<KeyedLane<ResourceKey>>,
}

impl ServerNodeBackend {
    async fn require_online(&self, agent_id: &str) -> Result<(), ToolError> {
        match self.agent_registry.get(agent_id).await {
            Some(agent) if agent.status == AgentStatus::Online => Ok(()),
            Some(agent) => Err(ToolError::unavailable(format!(
                "Agent '{agent_id}' is {}",
                agent_status(&agent.status)
            ))),
            None => Err(ToolError::not_found(format!(
                "Agent '{agent_id}' is not in the registry"
            ))),
        }
    }

    async fn run_keyed<T, F>(&self, key: ResourceKey, work: F) -> Result<T, ToolError>
    where
        T: Send + 'static,
        F: std::future::Future<Output = Result<T, ToolError>> + Send + 'static,
    {
        let (reply, result) = tokio::sync::oneshot::channel();
        let mut lanes = Lanes::shared(
            DEFAULT_QUERY_CONCURRENCY,
            Arc::clone(&self.mutations),
            DEFAULT_MUTATIONS_IN_FLIGHT,
            LANE_LABEL,
        );
        lanes
            .key(
                key,
                Box::pin(async move {
                    let _ = reply.send(work.await);
                }),
            )
            .await;
        result
            .await
            .map_err(|_| ToolError::backend("the Server's mutation lane ended before answering"))?
    }
}

fn map_agent_error(error: String) -> ToolError {
    if error.starts_with("Timeout") {
        ToolError::timeout(error)
    } else {
        ToolError::unavailable(error)
    }
}

#[async_trait::async_trait]
impl NodeBackend for ServerNodeBackend {
    async fn list_sessions(&self, agent_id: &str) -> Result<Value, ToolError> {
        self.require_online(agent_id).await?;
        let response = self
            .handler
            .clone()
            .agent_command_with_timeout(
                agent_id,
                "agent.session.list",
                json!({}),
                std::time::Duration::from_secs(35),
            )
            .await
            .map_err(map_agent_error)?;
        if let Some(error) = response.get("error").and_then(Value::as_str) {
            return Err(ToolError::backend(error.to_string()));
        }
        Ok(json!({
            "sessions": response.get("sessions").cloned().unwrap_or(json!([])),
            // An Agent's own answer has nothing stale: this field exists for
            // the Server's fan-out, and the two tool families still share one
            // result shape.
            "stale_agents": [],
        }))
    }

    async fn create_session(
        &self,
        agent_id: &str,
        name: &str,
        working_dir: Option<&str>,
    ) -> Result<Value, ToolError> {
        self.require_online(agent_id).await?;
        let handler = self.handler.clone();
        let target = agent_id.to_string();
        let session_name = name.to_string();
        let working_dir = working_dir.map(str::to_owned);
        let response = self
            .run_keyed(
                ResourceKey::Session(format!("{agent_id}:{name}")),
                async move {
                    handler
                        .agent_command_with_timeout(
                            &target,
                            "agent.session.create",
                            json!({
                                "name": session_name,
                                // Placeholders the Agent ignores: it creates at
                                // its own release-selected width.
                                "width": 80,
                                "height": 24,
                                "working_dir": working_dir,
                                "env_snapshots": [],
                                "binding_profiles": [],
                                "binding_revision": null,
                            }),
                            std::time::Duration::from_secs(35),
                        )
                        .await
                        .map_err(map_agent_error)
                },
            )
            .await?;
        if response.get("success").and_then(Value::as_bool) != Some(true) {
            let message = response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("the Agent refused the create");
            return Err(ToolError::backend(message.to_string()));
        }
        Ok(json!({
            "name": response
                .get("session_name")
                .and_then(Value::as_str)
                .unwrap_or(name),
            "warnings": response.get("warnings").cloned().unwrap_or(json!([])),
        }))
    }

    async fn kill_session(&self, agent_id: &str, name: &str) -> Result<Value, ToolError> {
        self.require_online(agent_id).await?;
        let handler = self.handler.clone();
        let target = agent_id.to_string();
        let session_name = name.to_string();
        let response = self
            .run_keyed(
                ResourceKey::Session(format!("{agent_id}:{name}")),
                async move {
                    handler
                        .agent_command_with_timeout(
                            &target,
                            "agent.session.kill",
                            json!({ "name": session_name }),
                            std::time::Duration::from_secs(35),
                        )
                        .await
                        .map_err(map_agent_error)
                },
            )
            .await?;
        if response.get("success").and_then(Value::as_bool) != Some(true) {
            let message = response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("the Agent refused the kill");
            return Err(ToolError::backend(message.to_string()));
        }
        Ok(json!({ "name": name }))
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or_default())
        .unwrap_or_default()
}

fn agent_status(status: &AgentStatus) -> &'static str {
    match status {
        AgentStatus::Online => "online",
        AgentStatus::Offline => "offline",
        AgentStatus::Degraded => "degraded",
    }
}

fn session_status(status: &crate::registry::SessionStatus) -> &'static str {
    match status {
        crate::registry::SessionStatus::Active => "active",
        crate::registry::SessionStatus::Detached => "detached",
        crate::registry::SessionStatus::Recovering => "recovering",
        crate::registry::SessionStatus::Orphaned => "orphaned",
        crate::registry::SessionStatus::Zombie => "zombie",
    }
}

/// The shared non-secret attach projection.
///
/// `session_name` is passed separately so an Agent error cannot change which
/// Session the facts describe. The value has **no** credential field populated:
/// `"credential": null` is an explicit statement, not a redaction after the
/// fact.
fn attach_info_projection(
    session_id: &str,
    agent_id: &str,
    session_name: &str,
    session_status: &str,
    agent: &AgentInfo,
) -> Value {
    let agent_address = legacy_agent_address(&agent.addresses)
        .or_else(|| agent.connect_url.clone())
        .unwrap_or_else(|| format!("ws://{}:{}/ws", agent.ip_address, agent.port));
    json!({
        "session_id": session_id,
        "agent_id": agent_id,
        "session_name": session_name,
        "session_status": session_status,
        "agent_status": agent_status(&agent.status),
        "agent_address": agent_address,
        "addresses": agent.addresses,
        "credential": null,
    })
}
