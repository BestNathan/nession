//! The Server's MCP backends (`#3264`).
//!
//! The Server hosts MCP by injecting **its own business services**, not a
//! second implementation:
//!
//! * Server-owned discovery dispatches through the same `server_routes!`
//!   table a Web or CLI connection reaches, using a detached authenticated
//!   handler.
//! * Agent-owned Session tools route to the explicitly named Agent through the
//!   existing command broker. The Server host never creates a tmux Session
//!   itself.
//!
//! Only four Tools exist: one Server-owned discovery Tool and three
//! Agent-owned Session Tools. Removing an MCP projection did not remove any
//! Protocol route.

use std::sync::Arc;

use nession_common::config::ServerConfig;
use nession_mcp::backend::{ClusterBackend, NodeBackend};
use nession_mcp::error::ToolError;
use nession_mcp::{McpService, ServiceConfig};
use nession_protocol::Message;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::registry::{AgentRegistry, AgentStatus};
use crate::server::execution::{
    Lanes, ResourceKey, DEFAULT_MUTATIONS_IN_FLIGHT, DEFAULT_QUERY_CONCURRENCY, LANE_LABEL,
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
    let handler = ConnectionHandler::new_authenticated(
        deps,
        ConnectionHandlerConfig {
            server_auth_token: config.auth_token.clone(),
            heartbeat_interval_secs: config.heartbeat_interval_secs,
            terminal_cols: config.terminal_cols,
            terminal_web_font_size: config.terminal_web_font_size,
        },
    );

    let cluster = Arc::new(ServerClusterBackend {
        handler: handler.clone(),
    });
    let node = Arc::new(ServerNodeBackend {
        handler,
        agent_registry,
        mutations,
    });

    let allowed_hosts =
        config.mcp.allowed_hosts.clone().unwrap_or_else(|| {
            nession_mcp::service::allowed_hosts_for_bind(&config.listen_address)
        });
    let service_config = ServiceConfig {
        path: config.mcp.path.clone(),
        auth_token: nession_protocol::TokenVerifier::new(config.auth_token.clone()),
        tool_timeout: std::time::Duration::from_secs(config.mcp.tool_timeout_secs),
        max_concurrent_calls: config.mcp.max_concurrent_calls,
        allowed_origins: config.mcp.allowed_origins.clone(),
        allowed_hosts,
    };
    let service = McpService::new(service_config, cluster, node)?;
    Ok(Some(Arc::new(service)))
}

struct ServerClusterBackend {
    handler: ConnectionHandler,
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
        dispatch_with(self.handler.clone(), "server.agent.list", json!({})).await
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
