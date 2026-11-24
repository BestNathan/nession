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
//! The Server-owned ENV operations use the existing Server route table, including
//! its in-use and overwrite protections; Agent-owned Session tools still route
//! to the Agent that owns the Session.

use std::sync::Arc;

use nession_common::config::ServerConfig;
use nession_mcp::backend::{ClusterBackend, NodeBackend};
use nession_mcp::error::{ToolError, ToolErrorKind};
use nession_mcp::pending_mutation::PendingMutation;
use nession_mcp::tools::nession_agent_create_session::SessionCreatedOutput;
use nession_mcp::tools::nession_agent_list_sessions::SessionListOutput;
use nession_mcp::{McpService, ServiceConfig};
use nession_protocol::contracts::agent::v1::{AgentListReply, AgentRefusal, WebAgentsListResponse};
use nession_protocol::contracts::env::v1::{
    ClientEnvDeletePayload, ClientEnvDeleteResponsePayload, ClientEnvGetPayload,
    ClientEnvGetResponsePayload, ClientEnvListResponsePayload, ClientEnvWritePayload,
    ClientEnvWriteResponsePayload,
};
use nession_protocol::contracts::project::v1::{
    ProjectGetPayload, ProjectGetResponsePayload, ProjectListResponsePayload,
};
use nession_protocol::contracts::session::v1::{
    ClientSessionCreatePayload, ClientSessionCreateResponsePayload,
    ClientSessionEnvBindingGetPayload, ClientSessionEnvBindingReapplyPayload,
    ClientSessionEnvBindingResponsePayload, ClientSessionEnvBindingSetPayload,
    ServerSessionListReply, SessionInitialMetadata, SessionKillResponse, SessionMetadata,
    SessionMetadataPatchPayload, SessionMetadataResponse, SessionRefusal,
    WebSessionMetadataGetPayload, WebSessionMetadataPatchPayload, WebSessionsListResponse,
};
use nession_protocol::Message;
use nession_runtime::frame::WsFrame;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use crate::registry::{AgentRegistry, AgentStatus};
use crate::server::execution::{
    Lanes, ResourceKey, DEFAULT_MUTATIONS_IN_FLIGHT, DEFAULT_QUERY_CONCURRENCY, LANE_LABEL,
};
use crate::server::handler::{
    dispatch_server, ConnectionHandler, ConnectionHandlerConfig, ConnectionHandlerDeps,
    HandlerAction,
};
use nession_runtime::lane::{AdmitError, KeyedLane};

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
    // The contribution catalog is the Server's one owner of Agent manifests
    // (#3778). Production constructs it before this build so registration can
    // install manifests; a directly built service (tests) still gets a valid
    // baseline catalog rather than an empty route.
    let extension_tools = match deps.extension_tools.clone() {
        Some(tools) => tools,
        None => Arc::new(crate::server::extension_tools::ExtensionToolCatalog::new(
            Arc::clone(&deps.agent_registry),
            Arc::clone(&deps.command_broker),
        )?),
    };
    let handler = ConnectionHandler::new_authenticated(
        deps,
        ConnectionHandlerConfig {
            server_auth: nession_protocol::TokenVerifier::new(config.auth_token.clone()),
            heartbeat_interval_secs: config.heartbeat_interval_secs,
            terminal_cols: config.terminal_cols,
            terminal_web_font_size: config.terminal_web_font_size,
            mcp_enabled: config.mcp.enabled,
            mcp_path: config.mcp.path.clone(),
        },
    );

    let cluster = Arc::new(ServerClusterBackend {
        handler: handler.clone(),
    });
    let node = Arc::new(ServerNodeBackend {
        handler,
        agent_registry,
        mutations,
        extension_tools: Arc::clone(&extension_tools),
    });

    let allowed_hosts =
        config.mcp.allowed_hosts.clone().unwrap_or_else(|| {
            nession_mcp::service::allowed_hosts_for_bind(&config.listen_address)
        });
    let service_config = ServiceConfig {
        path: config.mcp.path.clone(),
        auth_token: nession_protocol::TokenVerifier::new(config.auth_token.clone()),
        allow_query_token: false, // Embedded hosts remain Bearer-only.
        tool_timeout: std::time::Duration::from_secs(config.mcp.tool_timeout_secs),
        max_concurrent_calls: config.mcp.max_concurrent_calls,
        allowed_origins: config.mcp.allowed_origins.clone(),
        allowed_hosts,
    };
    let service = Arc::new(McpService::with_catalog(
        service_config,
        cluster,
        node,
        extension_tools.catalog(),
    )?);
    // The contribution catalog and the mounted endpoint are both live now;
    // connect the explicit-manifest-update announcer to the endpoint's
    // legacy-session list-change notification (`#3778` P2).
    {
        let weak = Arc::downgrade(&service);
        extension_tools.set_change_notifier(Arc::new(move || {
            if let Some(service) = weak.upgrade() {
                service.notify_catalog_changed();
            }
        }));
    }
    Ok(Some(service))
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
        HandlerAction::Reply(Some(WsFrame::Text(text))) => {
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

/// Route one unit and require its reply to be the typed Protocol contract.
///
/// The MCP Tool advertises the same type (`#3735`). A Server reply that does
/// not match it is a backend failure, never a successful untyped result.
async fn dispatch_typed<T>(
    handler: ConnectionHandler,
    wire: &'static str,
    payload: Value,
) -> Result<T, ToolError>
where
    T: DeserializeOwned,
{
    let value = dispatch_with(handler, wire, payload).await?;
    serde_json::from_value(value).map_err(|error| {
        ToolError::backend(format!(
            "the Server's `{wire}` reply does not match its typed contract: {error}"
        ))
    })
}

/// Interpret the `server.session.list` union for either Server-owned consumer.
///
/// The Project query and the Agent Session view must agree on what a refusal
/// means; neither may turn it into an empty list.
async fn list_sessions_via(
    handler: ConnectionHandler,
    agent_id: Option<&str>,
    force: bool,
) -> Result<WebSessionsListResponse, ToolError> {
    match dispatch_typed::<ServerSessionListReply>(
        handler,
        "server.session.list",
        json!({ "agent_id": agent_id, "force": force }),
    )
    .await?
    {
        ServerSessionListReply::Listed(listed) => Ok(listed),
        ServerSessionListReply::Refused(SessionRefusal { status, message }) => {
            Err(ToolError::backend(format!("{status}: {message}")))
        }
    }
}

#[async_trait::async_trait]
impl ClusterBackend for ServerClusterBackend {
    async fn list_agents(&self) -> Result<WebAgentsListResponse, ToolError> {
        match dispatch_typed::<AgentListReply>(self.handler.clone(), "server.agent.list", json!({}))
            .await?
        {
            AgentListReply::Listed(listed) => Ok(listed),
            AgentListReply::Refused(AgentRefusal { status, message }) => {
                Err(ToolError::backend(format!("{status}: {message}")))
            }
        }
    }

    async fn list_sessions(
        &self,
        agent_id: Option<&str>,
        force: bool,
    ) -> Result<WebSessionsListResponse, ToolError> {
        list_sessions_via(self.handler.clone(), agent_id, force).await
    }

    async fn project_list(&self) -> Result<ProjectListResponsePayload, ToolError> {
        dispatch_typed(self.handler.clone(), "server.project.list", json!({})).await
    }

    async fn project_get(
        &self,
        payload: ProjectGetPayload,
    ) -> Result<ProjectGetResponsePayload, ToolError> {
        let payload =
            serde_json::to_value(payload).map_err(|error| ToolError::backend(error.to_string()))?;
        dispatch_typed(self.handler.clone(), "server.project.get", payload).await
    }

    async fn create_project_session(
        &self,
        payload: ClientSessionCreatePayload,
    ) -> Result<ClientSessionCreateResponsePayload, ToolError> {
        let payload =
            serde_json::to_value(payload).map_err(|error| ToolError::backend(error.to_string()))?;
        dispatch_typed(self.handler.clone(), "server.session.create", payload).await
    }

    async fn env_list(&self) -> Result<ClientEnvListResponsePayload, ToolError> {
        dispatch_typed(self.handler.clone(), "server.env.list", json!({})).await
    }

    async fn env_get(
        &self,
        payload: ClientEnvGetPayload,
    ) -> Result<ClientEnvGetResponsePayload, ToolError> {
        let payload =
            serde_json::to_value(payload).map_err(|error| ToolError::backend(error.to_string()))?;
        dispatch_typed(self.handler.clone(), "server.env.get", payload).await
    }

    async fn env_write(
        &self,
        payload: ClientEnvWritePayload,
    ) -> Result<ClientEnvWriteResponsePayload, ToolError> {
        let payload =
            serde_json::to_value(payload).map_err(|error| ToolError::backend(error.to_string()))?;
        dispatch_typed(self.handler.clone(), "server.env.write", payload).await
    }

    async fn env_delete(
        &self,
        payload: ClientEnvDeletePayload,
    ) -> Result<ClientEnvDeleteResponsePayload, ToolError> {
        let payload =
            serde_json::to_value(payload).map_err(|error| ToolError::backend(error.to_string()))?;
        dispatch_typed(self.handler.clone(), "server.env.delete", payload).await
    }

    async fn session_env_binding_get(
        &self,
        payload: ClientSessionEnvBindingGetPayload,
    ) -> Result<ClientSessionEnvBindingResponsePayload, ToolError> {
        let payload =
            serde_json::to_value(payload).map_err(|error| ToolError::backend(error.to_string()))?;
        dispatch_typed(
            self.handler.clone(),
            "server.session.env.binding.get",
            payload,
        )
        .await
    }

    async fn session_env_binding_set(
        &self,
        payload: ClientSessionEnvBindingSetPayload,
    ) -> Result<ClientSessionEnvBindingResponsePayload, ToolError> {
        let payload =
            serde_json::to_value(payload).map_err(|error| ToolError::backend(error.to_string()))?;
        dispatch_typed(
            self.handler.clone(),
            "server.session.env.binding.set",
            payload,
        )
        .await
    }

    async fn session_env_binding_reapply(
        &self,
        payload: ClientSessionEnvBindingReapplyPayload,
    ) -> Result<ClientSessionEnvBindingResponsePayload, ToolError> {
        let payload =
            serde_json::to_value(payload).map_err(|error| ToolError::backend(error.to_string()))?;
        dispatch_typed(
            self.handler.clone(),
            "server.session.env.binding.reapply",
            payload,
        )
        .await
    }
}

struct ServerNodeBackend {
    handler: ConnectionHandler,
    agent_registry: Arc<AgentRegistry>,
    /// The Server's validated contribution catalog and broker route (#3778).
    extension_tools: Arc<crate::server::extension_tools::ExtensionToolCatalog>,
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
        let (request, admission) = PendingMutation::new();
        let mut lanes = Lanes::shared(
            DEFAULT_QUERY_CONCURRENCY,
            Arc::clone(&self.mutations),
            DEFAULT_MUTATIONS_IN_FLIGHT,
            LANE_LABEL,
        );
        if let Err(error) = lanes
            .try_key(
                key,
                Box::pin(async move {
                    // An expired MCP request must not start its queued mutation.
                    // Once admitted to execution, let the owner finish it; the
                    // caller may receive an indeterminate timeout instead.
                    if admission.try_begin() {
                        let _ = reply.send(work.await);
                    }
                }),
            )
            .await
        {
            return Err(match error {
                AdmitError::Saturated => ToolError::backend(
                    "the Server's mutation lane is at its execution bound; retry the request",
                ),
                AdmitError::Closed => ToolError::backend("the Server's mutation lane is closed"),
            });
        }
        let outcome = result
            .await
            .map_err(|_| ToolError::backend("the Server's mutation lane ended before answering"))?;
        drop(request);
        outcome
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
    async fn list_sessions(&self, agent_id: &str) -> Result<SessionListOutput, ToolError> {
        self.require_online(agent_id).await?;
        // The canonical `server.session.list` route with `force: true` asks
        // the named Agent for its live tmux state and joins the Server-owned
        // Project association for the same Session incarnation. Reading the
        // Agent command directly would return Agent truth without the Server
        // metadata the Tool now promises.
        let listed = list_sessions_via(self.handler.clone(), Some(agent_id), true).await?;
        Ok(SessionListOutput::from_web_sessions(
            &listed.sessions,
            listed.stale_agents,
        ))
    }

    async fn create_session(
        &self,
        agent_id: &str,
        name: &str,
        working_dir: Option<&str>,
        initial_metadata: Option<&SessionInitialMetadata>,
    ) -> Result<SessionCreatedOutput, ToolError> {
        self.require_online(agent_id).await?;
        let handler = self.handler.clone();
        let target = agent_id.to_string();
        let session_name = name.to_string();
        let working_dir = working_dir.map(str::to_owned);
        let initial_metadata = initial_metadata.cloned();
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
                                // Initial work context committed with the
                                // create by the Agent (#4081).
                                "initial_metadata": initial_metadata,
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
        let warnings: Vec<String> =
            serde_json::from_value(response.get("warnings").cloned().unwrap_or(json!([])))
                .map_err(|error| {
                    ToolError::backend(format!(
                        "the Agent's create warnings do not match their typed contract: {error}"
                    ))
                })?;
        let instance_id = response
            .get("instance_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        let metadata: Option<SessionMetadata> = response
            .get("metadata")
            .filter(|value| !value.is_null())
            .cloned()
            .map(|value| {
                serde_json::from_value(value).map_err(|error| {
                    ToolError::backend(format!(
                        "the Agent's committed metadata does not match its typed contract: {error}"
                    ))
                })
            })
            .transpose()?;
        Ok(SessionCreatedOutput {
            name: response
                .get("session_name")
                .and_then(Value::as_str)
                .unwrap_or(name)
                .to_string(),
            warnings,
            instance_id,
            metadata,
        })
    }

    async fn kill_session(
        &self,
        agent_id: &str,
        name: &str,
        expected_instance_id: &str,
    ) -> Result<SessionKillResponse, ToolError> {
        self.require_online(agent_id).await?;
        let handler = self.handler.clone();
        let target = agent_id.to_string();
        let session_name = name.to_string();
        let expected = expected_instance_id.to_string();
        let response = self
            .run_keyed(
                ResourceKey::Session(format!("{agent_id}:{name}")),
                async move {
                    handler
                        .agent_command_with_timeout(
                            &target,
                            "agent.session.kill",
                            // The precondition rides the canonical command; the
                            // Agent enforces it in its keyed mutation lane (#4302).
                            json!({
                                "name": session_name,
                                "expected_instance_id": expected,
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
                .unwrap_or("the Agent refused the kill");
            // The Agent's guarded refusal classifies itself; an unclassified
            // failure keeps the legacy backend mapping.
            return Err(match response.get("error_kind").and_then(Value::as_str) {
                Some(kind) => ToolError::new(ToolErrorKind::from_wire(kind), message.to_string()),
                None => ToolError::backend(message.to_string()),
            });
        }
        Ok(SessionKillResponse {
            name: name.to_string(),
        })
    }

    async fn get_session_metadata(
        &self,
        agent_id: &str,
        name: &str,
    ) -> Result<SessionMetadataResponse, ToolError> {
        self.require_online(agent_id).await?;
        // Route through the same `server.session.metadata.get` unit the Web
        // uses; the Server authorizes and the Agent answers.
        dispatch_typed::<SessionMetadataResponse>(
            self.handler.clone(),
            "server.session.metadata.get",
            serde_json::to_value(WebSessionMetadataGetPayload {
                session_id: format!("{agent_id}:{name}"),
            })
            .map_err(|error| ToolError::backend(error.to_string()))?,
        )
        .await
    }

    async fn update_session_metadata(
        &self,
        agent_id: &str,
        request: SessionMetadataPatchPayload,
    ) -> Result<SessionMetadataResponse, ToolError> {
        self.require_online(agent_id).await?;
        let payload = WebSessionMetadataPatchPayload {
            session_id: format!("{agent_id}:{}", request.name),
            expected_instance_id: request.expected_instance_id,
            expected_revision: request.expected_revision,
            patch: request.patch,
        };
        dispatch_typed::<SessionMetadataResponse>(
            self.handler.clone(),
            "server.session.metadata.patch",
            serde_json::to_value(payload).map_err(|error| ToolError::backend(error.to_string()))?,
        )
        .await
    }

    async fn call_extension_tool(
        &self,
        agent_id: &str,
        tool: &str,
        arguments: serde_json::Map<String, Value>,
    ) -> Result<Value, ToolError> {
        self.extension_tools.call(agent_id, tool, arguments).await
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
