//! Configuration and composition for the standalone `nession-mcp` program.
//!
//! The document has two halves because the requirement separates them:
//!
//! * `[mcp]` is the **inbound** endpoint — its own listen address and its own
//!   bearer token.
//! * `[backend.server]` / `[backend.agent]` are **outbound** credentials. They
//!   are explicit; nothing is guessed from the host machine, and the inbound
//!   token is never forwarded to a backend.
//!
//! ```toml
//! [mcp]
//! listen_address = "127.0.0.1:9090"
//! auth_token = "<mcp-inbound-token>"
//!
//! [backend.server]
//! endpoint = "wss://nession.example.com/ws"
//! auth_token = "<server-token>"
//!
//! # Optional: direct Agent management for `nession_agent_*`.
//! [backend.agent]
//! endpoint = "ws://127.0.0.1:19091/ws"
//! auth_token = "<agent-operator-token>"
//! agent_id = "agent-..."
//! ```

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;

use crate::backend::{NodeBackend, UnavailableNodeBackend};
use crate::protocol;
use crate::remote::{RemoteClusterBackend, RemoteNodeBackend};
use crate::service::{McpService, ServiceConfig};

/// The standalone document.
#[derive(Debug, Clone, Deserialize)]
pub struct StandaloneConfig {
    /// The inbound MCP endpoint.
    pub mcp: StandaloneMcpConfig,
    /// The outbound backends.
    #[serde(default)]
    pub backend: BackendConfig,
}

/// The inbound endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct StandaloneMcpConfig {
    /// Endpoint path; `/mcp` unless configured.
    #[serde(default = "default_path")]
    pub path: String,
    /// The address this program listens on.
    pub listen_address: String,
    /// The bearer token every MCP request must present.
    pub auth_token: String,
    /// Optional TLS certificate for the MCP listener.
    #[serde(default)]
    pub tls_cert_path: Option<String>,
    /// Optional TLS private key for the MCP listener.
    #[serde(default)]
    pub tls_key_path: Option<String>,
    /// Tool execution deadline.
    #[serde(default = "default_tool_timeout")]
    pub tool_timeout_secs: u64,
    /// Concurrent tool executions.
    #[serde(default = "default_max_concurrent_calls")]
    pub max_concurrent_calls: usize,
}

fn default_path() -> String {
    protocol::DEFAULT_PATH.to_string()
}

fn default_tool_timeout() -> u64 {
    protocol::DEFAULT_TOOL_TIMEOUT_SECS
}

fn default_max_concurrent_calls() -> usize {
    protocol::DEFAULT_MAX_CONCURRENT_CALLS
}

/// The configured backends.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct BackendConfig {
    /// The Nession Server every cluster tool uses.
    #[serde(default)]
    pub server: Option<ServerBackendConfig>,
    /// The one Agent `nession_agent_*` tools may manage, if any.
    #[serde(default)]
    pub agent: Option<AgentBackendConfig>,
}

/// A Server endpoint and its outbound credential.
#[derive(Debug, Clone, Deserialize)]
pub struct ServerBackendConfig {
    /// The Server WebSocket URL.
    pub endpoint: String,
    /// The Server auth token.
    pub auth_token: String,
    /// Optional per-call request deadline.
    #[serde(default)]
    pub request_timeout_secs: Option<u64>,
}

/// One Agent endpoint and its operator credential.
#[derive(Debug, Clone, Deserialize)]
pub struct AgentBackendConfig {
    /// The Agent WebSocket URL.
    pub endpoint: String,
    /// The Agent's configured operator token.
    pub auth_token: String,
    /// The Agent id this host is allowed to manage.
    pub agent_id: String,
}

impl StandaloneConfig {
    /// Load and validate a document.
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path)
            .map_err(|error| anyhow::anyhow!("could not read {}: {error}", path.display()))?;
        let config: Self = toml::from_str(&text)
            .map_err(|error| anyhow::anyhow!("could not parse {}: {error}", path.display()))?;
        config.validate()?;
        Ok(config)
    }

    /// Fail closed on a document that cannot authenticate or reach a backend.
    pub fn validate(&self) -> anyhow::Result<()> {
        if self.mcp.listen_address.trim().is_empty() {
            anyhow::bail!("[mcp] listen_address is required");
        }
        if self.mcp.auth_token.trim().is_empty() {
            anyhow::bail!(
                "[mcp] auth_token is required: an MCP endpoint with no inbound token is \
                 anonymous, and fail-closed is the requirement"
            );
        }
        if self.mcp.tool_timeout_secs == 0 {
            anyhow::bail!("[mcp] tool_timeout_secs must be greater than zero");
        }
        if self.mcp.max_concurrent_calls == 0 {
            anyhow::bail!("[mcp] max_concurrent_calls must be greater than zero");
        }
        let server = self.backend.server.as_ref().ok_or_else(|| {
            anyhow::anyhow!(
                "[backend.server] is required: cluster tools must reach a real Nession Server"
            )
        })?;
        if server.endpoint.trim().is_empty() || server.auth_token.trim().is_empty() {
            anyhow::bail!("[backend.server] endpoint and auth_token are both required");
        }
        if let Some(agent) = &self.backend.agent {
            if agent.endpoint.trim().is_empty()
                || agent.auth_token.trim().is_empty()
                || agent.agent_id.trim().is_empty()
            {
                anyhow::bail!(
                    "[backend.agent] endpoint, auth_token and agent_id are all required when \
                     present"
                );
            }
        }
        self.service_config().validate()?;
        Ok(())
    }

    /// The shared service configuration derived from `[mcp]`.
    pub fn service_config(&self) -> ServiceConfig {
        ServiceConfig {
            path: self.mcp.path.clone(),
            auth_token: self.mcp.auth_token.clone(),
            tool_timeout: Duration::from_secs(self.mcp.tool_timeout_secs),
            max_concurrent_calls: self.mcp.max_concurrent_calls,
            session_idle: Duration::from_secs(protocol::DEFAULT_SESSION_IDLE_SECS),
            max_sessions: protocol::DEFAULT_MAX_SESSIONS,
        }
    }

    /// Build the service from explicit backends.
    pub fn build_service(&self) -> anyhow::Result<Arc<McpService>> {
        let server = self
            .backend
            .server
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("[backend.server] is required"))?;
        let mut cluster = RemoteClusterBackend::new(&server.endpoint, &server.auth_token);
        if let Some(seconds) = server.request_timeout_secs {
            cluster = cluster.with_request_timeout(Duration::from_secs(seconds));
        }
        let node: Arc<dyn NodeBackend> = match &self.backend.agent {
            Some(agent) => Arc::new(RemoteNodeBackend::new(
                &agent.endpoint,
                &agent.auth_token,
                &agent.agent_id,
            )),
            None => Arc::new(UnavailableNodeBackend::new(
                "this standalone MCP host has no [backend.agent]; agent tools need an explicit \
                 Agent endpoint and operator token",
            )),
        };
        let service = McpService::new(self.service_config(), Arc::new(cluster), node)?;
        Ok(Arc::new(service))
    }

    /// The TLS material, when both halves are configured.
    pub fn tls_material(&self) -> anyhow::Result<Option<(String, String)>> {
        match (&self.mcp.tls_cert_path, &self.mcp.tls_key_path) {
            (Some(cert), Some(key)) if cert.is_empty() && key.is_empty() => Ok(None),
            (Some(cert), Some(key)) if !cert.is_empty() && !key.is_empty() => {
                Ok(Some((cert.clone(), key.clone())))
            }
            (None, None) => Ok(None),
            _ => anyhow::bail!("[mcp] tls_cert_path and tls_key_path must be configured together"),
        }
    }
}
