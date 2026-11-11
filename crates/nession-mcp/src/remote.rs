//! Backends for hosts that are not the Server or Agent themselves (`#3264`).
//!
//! Two consumers exist:
//!
//! * the standalone `nession-mcp` binary, which has no local Server or Agent;
//! * an Agent-embedded host, whose Server-owned discovery reuses the Server it
//!   already reports to.
//!
//! Both go through [`nession_client`], the canonical consumer boundary. A
//! connection is opened for **one tool call** and closed with it. That is a
//! deliberate simplification: concurrent calls are independent (no reply can
//! be correlated against another call's request), costs one WebSocket
//! handshake per call, and keeps a failed call from poisoning a long-lived
//! socket.
//!
//! ## Routing rule
//!
//! Agent-owned Session tools reached from a standalone host go **through the
//! Server's canonical Agent route** ([`ServerRoutedNodeBackend`]) by default:
//! the Server authenticates, authorizes, resolves and routes to the named
//! Agent, and Nession has exactly one management path. An operator may instead
//! configure an explicit direct-Agent backend; there is no implicit fallback
//! between the two.

use async_trait::async_trait;
use nession_client::{AgentConnection, ClientConfig, ClientConnection, ClientError};
use nession_protocol::contracts::agent::v1::{AgentListReply, AgentRefusal};
use nession_protocol::contracts::session::v1::{ServerSessionListReply, SessionRefusal};
use serde_json::{json, Value};
use std::time::Duration;
use tracing::debug;

use crate::backend::{ClusterBackend, NodeBackend};
use crate::error::ToolError;

/// How long to wait for the Server's authentication handshake.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// A Server-backed cluster backend.
pub struct RemoteClusterBackend {
    endpoint: String,
    auth_token: String,
    request_timeout: Duration,
}

impl RemoteClusterBackend {
    /// Build a backend for one Server endpoint.
    pub fn new(endpoint: impl Into<String>, auth_token: impl Into<String>) -> Self {
        Self {
            endpoint: endpoint.into(),
            auth_token: auth_token.into(),
            request_timeout: nession_client::DEFAULT_REQUEST_TIMEOUT,
        }
    }

    /// Override the per-call request deadline.
    pub fn with_request_timeout(mut self, timeout: Duration) -> Self {
        self.request_timeout = timeout;
        self
    }

    async fn connect(&self) -> Result<ClientConnection, ToolError> {
        connect_server(&self.endpoint, &self.auth_token, self.request_timeout).await
    }

    async fn close(connection: ClientConnection) {
        close_server(connection).await;
    }
}

#[async_trait]
impl ClusterBackend for RemoteClusterBackend {
    async fn list_agents(&self) -> Result<Value, ToolError> {
        let mut connection = self.connect().await?;
        let reply = connection.list_agents().await.map_err(map_client_error)?;
        Self::close(connection).await;
        match reply {
            AgentListReply::Listed(listed) => {
                serde_json::to_value(listed).map_err(|error| ToolError::backend(error.to_string()))
            }
            AgentListReply::Refused(AgentRefusal { status, message }) => {
                Err(refusal_error(status, message))
            }
        }
    }
}

async fn connect_server(
    endpoint: &str,
    auth_token: &str,
    request_timeout: Duration,
) -> Result<ClientConnection, ToolError> {
    let config = ClientConfig {
        server_url: endpoint.to_string(),
        auth_token: auth_token.to_string(),
        request_timeout,
    };
    tokio::time::timeout(CONNECT_TIMEOUT, ClientConnection::connect(config))
        .await
        .map_err(|_| ToolError::unavailable("the Nession Server did not answer the handshake"))?
        .map_err(map_client_error)
}

async fn close_server(connection: ClientConnection) {
    if let Err(error) = connection.close().await {
        debug!(%error, "closing an MCP backend connection failed");
    }
}

fn refusal_error(status: String, message: String) -> ToolError {
    ToolError::backend(format!("{status}: {message}"))
}

/// Agent-owned Session tools routed through the Server's canonical Agent path.
///
/// This is the standalone default. The Server owns authentication,
/// authorization and routing to the explicitly named Agent; the caller never
/// needs an independently configured direct Agent endpoint, and no request can
/// bypass the Server's policy.
pub struct ServerRoutedNodeBackend {
    endpoint: String,
    auth_token: String,
    request_timeout: Duration,
}

impl ServerRoutedNodeBackend {
    /// Build a Server-routed node backend.
    pub fn new(endpoint: impl Into<String>, auth_token: impl Into<String>) -> Self {
        Self {
            endpoint: endpoint.into(),
            auth_token: auth_token.into(),
            request_timeout: nession_client::DEFAULT_REQUEST_TIMEOUT,
        }
    }

    /// Override the per-call request deadline.
    pub fn with_request_timeout(mut self, timeout: Duration) -> Self {
        self.request_timeout = timeout;
        self
    }

    async fn connect(&self) -> Result<ClientConnection, ToolError> {
        connect_server(&self.endpoint, &self.auth_token, self.request_timeout).await
    }

    /// Open a Server connection whose registry contains this online Agent.
    ///
    /// The Server is the routing authority, so an unknown or offline target is
    /// refused here rather than turned into an empty registry answer. That is
    /// the same refusal Server-embedded and Agent-embedded give.
    async fn connect_to_agent(&self, agent_id: &str) -> Result<ClientConnection, ToolError> {
        let mut connection = self.connect().await?;
        match connection.list_agents().await.map_err(map_client_error)? {
            AgentListReply::Listed(listed) => {
                let Some(agent) = listed
                    .agents
                    .iter()
                    .find(|agent| agent.agent_id == agent_id)
                else {
                    return Err(ToolError::not_found(format!(
                        "Agent '{agent_id}' is not in the Server registry"
                    )));
                };
                if agent.status != "online" {
                    return Err(ToolError::unavailable(format!(
                        "Agent '{agent_id}' is {}",
                        agent.status
                    )));
                }
                Ok(connection)
            }
            AgentListReply::Refused(AgentRefusal { status, message }) => {
                Err(refusal_error(status, message))
            }
        }
    }
}

#[async_trait]
impl NodeBackend for ServerRoutedNodeBackend {
    async fn list_sessions(&self, agent_id: &str) -> Result<Value, ToolError> {
        let mut connection = self.connect_to_agent(agent_id).await?;
        // `force: true` asks the target Agent for its live tmux state; the
        // registry's cached view is not "Agent truth" and the Tool promises it.
        let reply = connection
            .list_sessions_with_force(Some(agent_id), true)
            .await
            .map_err(map_client_error)?;
        close_server(connection).await;
        match reply {
            ServerSessionListReply::Listed(listed) => {
                serde_json::to_value(listed).map_err(|error| ToolError::backend(error.to_string()))
            }
            ServerSessionListReply::Refused(SessionRefusal { status, message }) => {
                Err(refusal_error(status, message))
            }
        }
    }

    async fn create_session(
        &self,
        agent_id: &str,
        name: &str,
        working_dir: Option<&str>,
    ) -> Result<Value, ToolError> {
        let mut connection = self.connect_to_agent(agent_id).await?;
        let reply = connection
            .create_session_in(agent_id, name, working_dir)
            .await
            .map_err(map_client_error)?;
        close_server(connection).await;
        if !reply.success {
            return Err(ToolError::backend(
                reply
                    .error
                    .unwrap_or_else(|| "the Server refused the create".to_string()),
            ));
        }
        // The same business payload the Server-embedded and Agent-embedded
        // adapters return for this Tool.
        Ok(json!({ "name": name, "warnings": reply.warnings }))
    }

    async fn kill_session(&self, agent_id: &str, name: &str) -> Result<Value, ToolError> {
        let mut connection = self.connect_to_agent(agent_id).await?;
        let reply = connection
            .kill_session(&format!("{agent_id}:{name}"))
            .await
            .map_err(map_client_error)?;
        close_server(connection).await;
        if !reply.success {
            return Err(ToolError::backend(
                reply
                    .error
                    .unwrap_or_else(|| "the Server refused the kill".to_string()),
            ));
        }
        Ok(json!({ "name": name }))
    }
}

/// An Agent-backed node backend for a standalone MCP host.
///
/// `agent_id` is the configured target. A call naming another Agent is refused
/// rather than silently redirected — the requirement forbids an implicit host
/// fallback, and this is the only place that could invent one.
pub struct RemoteNodeBackend {
    endpoint: String,
    credential: String,
    agent_id: String,
}

impl RemoteNodeBackend {
    /// Build a backend for the one Agent this host may manage.
    pub fn new(
        endpoint: impl Into<String>,
        credential: impl Into<String>,
        agent_id: impl Into<String>,
    ) -> Self {
        Self {
            endpoint: endpoint.into(),
            credential: credential.into(),
            agent_id: agent_id.into(),
        }
    }

    fn ensure_target(&self, agent_id: &str) -> Result<(), ToolError> {
        if agent_id == self.agent_id {
            Ok(())
        } else {
            Err(ToolError::invalid_argument(format!(
                "this MCP host is configured for Agent '{}', not '{agent_id}'",
                self.agent_id
            )))
        }
    }

    async fn connect(&self) -> Result<AgentConnection, ToolError> {
        let connection = tokio::time::timeout(
            CONNECT_TIMEOUT,
            AgentConnection::connect(&self.endpoint, &self.credential),
        )
        .await
        .map_err(|_| ToolError::unavailable("the Agent did not answer the handshake"))?
        .map_err(map_client_error)?;
        Ok(connection)
    }

    async fn close(connection: AgentConnection) {
        if let Err(error) = connection.close().await {
            debug!(%error, "closing an MCP Agent connection failed");
        }
    }
}

#[async_trait]
impl NodeBackend for RemoteNodeBackend {
    async fn list_sessions(&self, agent_id: &str) -> Result<Value, ToolError> {
        self.ensure_target(agent_id)?;
        let mut connection = self.connect().await?;
        let reply = connection.list_sessions().await.map_err(map_client_error)?;
        Self::close(connection).await;
        serde_json::to_value(reply).map_err(|error| ToolError::backend(error.to_string()))
    }

    async fn create_session(
        &self,
        agent_id: &str,
        name: &str,
        working_dir: Option<&str>,
    ) -> Result<Value, ToolError> {
        self.ensure_target(agent_id)?;
        let mut connection = self.connect().await?;
        let reply = connection
            .create_session(name, working_dir)
            .await
            .map_err(map_client_error)?;
        Self::close(connection).await;
        serde_json::to_value(reply).map_err(|error| ToolError::backend(error.to_string()))
    }

    async fn kill_session(&self, agent_id: &str, name: &str) -> Result<Value, ToolError> {
        self.ensure_target(agent_id)?;
        let mut connection = self.connect().await?;
        let reply = connection
            .kill_session(name)
            .await
            .map_err(map_client_error)?;
        Self::close(connection).await;
        serde_json::to_value(reply).map_err(|error| ToolError::backend(error.to_string()))
    }
}

fn map_client_error(error: ClientError) -> ToolError {
    match error {
        ClientError::Connect { .. }
        | ClientError::Closed { .. }
        | ClientError::Transport { .. } => ToolError::unavailable(error.to_string()),
        ClientError::Timeout { .. } => ToolError::timeout(error.to_string()),
        ClientError::AgentRefused { .. } | ClientError::Auth { .. } => {
            ToolError::backend(error.to_string())
        }
        ClientError::Reply { .. }
        | ClientError::Frame { .. }
        | ClientError::Send { .. }
        | ClientError::UnexpectedReply { .. } => ToolError::backend(error.to_string()),
    }
}
