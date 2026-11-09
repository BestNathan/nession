//! Backends for hosts that are not the Server or Agent themselves.
//!
//! Two consumers exist:
//!
//! * the standalone `nession-mcp` binary, which has no local Server or Agent;
//! * an Agent-embedded host, whose cluster tools reuse the Server it already
//!   reports to.
//!
//! Both go through [`nession_client`], the canonical consumer boundary. A
//! connection is opened for **one tool call** and closed with it. That is a
//! deliberate simplification: it makes concurrent calls independent (no reply
//! can be correlated against another call's request), costs one WebSocket
//! handshake per call, and keeps a failed call from poisoning a long-lived
//! socket. A future higher-traffic host can add pooling behind the same trait.

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
        let config = ClientConfig {
            server_url: self.endpoint.clone(),
            auth_token: self.auth_token.clone(),
            request_timeout: self.request_timeout,
        };
        let connection = tokio::time::timeout(CONNECT_TIMEOUT, ClientConnection::connect(config))
            .await
            .map_err(|_| ToolError::unavailable("the Nession Server did not answer the handshake"))?
            .map_err(map_client_error)?;
        Ok(connection)
    }

    async fn close(connection: ClientConnection) {
        if let Err(error) = connection.close().await {
            debug!(%error, "closing an MCP backend connection failed");
        }
    }
}

#[async_trait]
impl ClusterBackend for RemoteClusterBackend {
    async fn list_agents(&self) -> Result<Value, ToolError> {
        let mut connection = self.connect().await?;
        let reply = connection.list_agents().await.map_err(map_client_error)?;
        Self::close(connection).await;
        Ok(match reply {
            AgentListReply::Listed(listed) => serde_json::to_value(listed)
                .map_err(|error| ToolError::backend(error.to_string()))?,
            AgentListReply::Refused(AgentRefusal { status, message }) => {
                json!({ "status": status, "message": message })
            }
        })
    }

    async fn list_sessions(&self, agent_id: Option<&str>, force: bool) -> Result<Value, ToolError> {
        let mut connection = self.connect().await?;
        let reply = connection
            .list_sessions_with_force(agent_id, force)
            .await
            .map_err(map_client_error)?;
        Self::close(connection).await;
        Ok(match reply {
            ServerSessionListReply::Listed(listed) => serde_json::to_value(listed)
                .map_err(|error| ToolError::backend(error.to_string()))?,
            ServerSessionListReply::Refused(SessionRefusal { status, message }) => {
                json!({ "status": status, "message": message })
            }
        })
    }

    async fn get_info(&self) -> Result<Value, ToolError> {
        let mut connection = self.connect().await?;
        let reply = connection
            .get_server_info()
            .await
            .map_err(map_client_error)?;
        Self::close(connection).await;
        serde_json::to_value(reply).map_err(|error| ToolError::backend(error.to_string()))
    }

    async fn capture_session_preview(
        &self,
        session_id: &str,
        lines: u32,
    ) -> Result<Value, ToolError> {
        let mut connection = self.connect().await?;
        let reply = connection
            .capture_session_preview(session_id, lines)
            .await
            .map_err(map_client_error)?;
        Self::close(connection).await;
        Ok(reply)
    }

    async fn get_session_attach_info(&self, session_id: &str) -> Result<Value, ToolError> {
        // Deliberately not `server.session.attach`: that call **mints** a P2P
        // credential. This tool is a read; deriving the same non-secret facts
        // from the session list and the agent list means there is no credential
        // to redact, rather than a redaction a later change could miss.
        let mut connection = self.connect().await?;
        let sessions = connection
            .list_sessions(None)
            .await
            .map_err(map_client_error)?;
        let session = match sessions {
            ServerSessionListReply::Listed(listed) => listed
                .sessions
                .into_iter()
                .find(|session| session.session_id == session_id)
                .ok_or_else(|| {
                    ToolError::not_found(format!("Session '{session_id}' is not in the registry"))
                })?,
            ServerSessionListReply::Refused(SessionRefusal { status, message }) => {
                return Err(ToolError::backend(format!("{status}: {message}")))
            }
        };
        Self::close(connection).await;

        let mut connection = self.connect().await?;
        let agents = connection.list_agents().await.map_err(map_client_error)?;
        let agent = match agents {
            AgentListReply::Listed(listed) => listed
                .agents
                .into_iter()
                .find(|agent| agent.agent_id == session.agent_id)
                .ok_or_else(|| {
                    ToolError::not_found(format!(
                        "Agent '{}' is not in the registry",
                        session.agent_id
                    ))
                })?,
            AgentListReply::Refused(AgentRefusal { status, message }) => {
                return Err(ToolError::backend(format!("{status}: {message}")))
            }
        };
        Self::close(connection).await;

        let legacy_address = agent
            .addresses
            .iter()
            .find(|address| {
                address.status == nession_protocol::contracts::agent::v1::AddressStatus::Reachable
            })
            .map(|address| address.address.url.clone())
            .or_else(|| {
                agent
                    .addresses
                    .first()
                    .map(|address| address.address.url.clone())
            })
            .unwrap_or_else(|| format!("ws://{}:{}/ws", agent.ip_address, agent.port));

        Ok(json!({
            "session_id": session.session_id,
            "agent_id": session.agent_id,
            "session_name": session.session_name,
            "session_status": session.status,
            "agent_status": agent.status,
            "agent_address": legacy_address,
            "addresses": agent.addresses,
            // Explicit and stable: this projection never carries credential
            // material, so a model can rely on the field set.
            "credential": null,
        }))
    }

    async fn create_session(&self, agent_id: &str, name: &str) -> Result<Value, ToolError> {
        let mut connection = self.connect().await?;
        let reply = connection
            .create_session(agent_id, name)
            .await
            .map_err(map_client_error)?;
        Self::close(connection).await;
        serde_json::to_value(reply).map_err(|error| ToolError::backend(error.to_string()))
    }

    async fn kill_session(&self, session_id: &str) -> Result<Value, ToolError> {
        let mut connection = self.connect().await?;
        let reply = connection
            .kill_session(session_id)
            .await
            .map_err(map_client_error)?;
        Self::close(connection).await;
        serde_json::to_value(reply).map_err(|error| ToolError::backend(error.to_string()))
    }

    async fn rename_agent(
        &self,
        agent_id: &str,
        display_name: Option<&str>,
    ) -> Result<Value, ToolError> {
        let mut connection = self.connect().await?;
        let reply = connection
            .rename_agent(agent_id, display_name)
            .await
            .map_err(map_client_error)?;
        Self::close(connection).await;
        serde_json::to_value(reply).map_err(|error| ToolError::backend(error.to_string()))
    }

    async fn delete_agent(&self, agent_id: &str) -> Result<Value, ToolError> {
        let mut connection = self.connect().await?;
        let reply = connection
            .delete_agent(agent_id)
            .await
            .map_err(map_client_error)?;
        Self::close(connection).await;
        serde_json::to_value(reply).map_err(|error| ToolError::backend(error.to_string()))
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
