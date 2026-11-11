//! The Agent's MCP backends (`#565`).
//!
//! An Agent host is two capabilities in one process:
//!
//! * **Node tools** answer for this Agent's own tmux Session state, using the
//!   same [`SessionManager`] and [`SessionRegistry`] the P2P listener and the
//!   central connection use.
//! * **Cluster tools** reuse the Server this Agent already reports to. When
//!   there is no Server (`server_url` empty — standalone mode), the catalog
//!   still lists them and each call returns a structured "no Server backend"
//!   error. That is deliberate: SC-07 requires local tools to work while the
//!   Server is offline, and a catalog that silently shrinks would hide the
//!   dependency instead of stating it.

use std::sync::Arc;

use nession_mcp::backend::{ClusterBackend, NodeBackend, UnavailableClusterBackend};
use nession_mcp::error::ToolError;
use nession_mcp::{McpService, ServiceConfig};
use nession_protocol::contracts::session::v1::{
    SessionCreateResponse, SessionKillResponse, SessionListResponse,
};
use serde_json::Value;

use crate::config::AgentConfig;
use crate::execution::ResourceKey;
use crate::server::execution::{
    ExecutionLanes, DEFAULT_MUTATIONS_IN_FLIGHT, DEFAULT_QUERY_CONCURRENCY,
};
use crate::session::registry::SessionRegistry;
use crate::tmux::manager::{SessionBindingInput, SessionManager};
use nession_runtime::lane::KeyedLane;

/// The label MCP-originated lane waits carry in logs, so a mutation queued by
/// the endpoint is not mistaken for a peer-to-peer frame's.
const MCP_LANE_LABEL: &str = "mcp ";

/// Build the Agent-hosted MCP service when `[mcp] enabled = true`.
pub(crate) fn build(
    config: &AgentConfig,
    agent_id: &str,
    tmux: Arc<SessionManager>,
    sessions: Arc<SessionRegistry>,
    default_working_dir: &str,
    terminal_cols: u16,
    mutations: Arc<KeyedLane<ResourceKey>>,
) -> anyhow::Result<Option<Arc<McpService>>> {
    if !config.mcp.enabled {
        return Ok(None);
    }
    // Fail closed for a directly constructed config too.
    config
        .mcp
        .validate_for_host(&config.agent_token, "agent_token")?;

    let cluster: Arc<dyn ClusterBackend> = if config.server_url.trim().is_empty() {
        Arc::new(UnavailableClusterBackend::new(
            "this Agent is standalone (no server_url); cluster tools need a Nession Server, \
             while the nession_agent_* tools remain available",
        ))
    } else {
        Arc::new(nession_mcp::remote::RemoteClusterBackend::new(
            config.server_url.clone(),
            config.auth_token.clone(),
        ))
    };

    let node = Arc::new(AgentNodeBackend {
        agent_id: agent_id.to_string(),
        tmux,
        sessions,
        default_working_dir: default_working_dir.to_string(),
        terminal_cols,
        mutations,
    });

    let service_config = ServiceConfig {
        path: config.mcp.path.clone(),
        auth_token: config.agent_token.clone(),
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

struct AgentNodeBackend {
    agent_id: String,
    tmux: Arc<SessionManager>,
    sessions: Arc<SessionRegistry>,
    default_working_dir: String,
    terminal_cols: u16,
    /// The process's keyed mutation lane, shared with the P2P listener and the
    /// central connection. An MCP create/kill of a Session is ordered against
    /// a terminal client's mutation of the same Session (#565).
    mutations: Arc<KeyedLane<ResourceKey>>,
}

impl AgentNodeBackend {
    fn ensure_target(&self, agent_id: &str) -> Result<(), ToolError> {
        if agent_id == self.agent_id {
            Ok(())
        } else {
            Err(ToolError::invalid_argument(format!(
                "this MCP host is Agent '{}', not '{agent_id}'; agent tools require the id of \
                 the node they act on",
                self.agent_id
            )))
        }
    }

    /// Run one mutation on the process's shared keyed lane, keyed by the
    /// Session it names.
    ///
    /// The future must be `'static`: it is queued, not awaited here, so it owns
    /// every Arc and string it touches. The oneshot is what carries the result
    /// back to this request; the lane itself carries nothing.
    async fn run_keyed<T, F>(&self, session_name: &str, work: F) -> Result<T, ToolError>
    where
        T: Send + 'static,
        F: std::future::Future<Output = Result<T, ToolError>> + Send + 'static,
    {
        let (reply, result) = tokio::sync::oneshot::channel();
        let mut lanes = ExecutionLanes::shared(
            DEFAULT_QUERY_CONCURRENCY,
            Arc::clone(&self.mutations),
            DEFAULT_MUTATIONS_IN_FLIGHT,
            MCP_LANE_LABEL,
        );
        lanes
            .key(
                ResourceKey::Session(session_name.to_string()),
                Box::pin(async move {
                    let _ = reply.send(work.await);
                }),
            )
            .await;
        result
            .await
            .map_err(|_| ToolError::backend("the Agent's mutation lane ended before answering"))?
    }
}

#[async_trait::async_trait]
impl NodeBackend for AgentNodeBackend {
    async fn list_sessions(&self, agent_id: &str) -> Result<Value, ToolError> {
        self.ensure_target(agent_id)?;
        let sessions = self
            .tmux
            .list_sessions()
            .await
            .map_err(|error| ToolError::backend(format!("{error:#}")))?;
        serde_json::to_value(SessionListResponse {
            sessions,
            stale_agents: Vec::new(),
        })
        .map_err(|error| ToolError::backend(error.to_string()))
    }

    async fn create_session(
        &self,
        agent_id: &str,
        name: &str,
        working_dir: Option<&str>,
    ) -> Result<Value, ToolError> {
        self.ensure_target(agent_id)?;
        let working_dir = match working_dir {
            Some(path) => SessionManager::validate_initial_working_dir(path)
                .map_err(|error| ToolError::invalid_argument(error.to_string()))?,
            None => self.default_working_dir.clone(),
        };
        let tmux = Arc::clone(&self.tmux);
        let terminal_cols = self.terminal_cols;
        let session_name = name.to_string();
        let queued_name = session_name.clone();
        let response = self
            .run_keyed(&session_name, async move {
                let outcome = tmux
                    .create_session_with_binding(
                        &queued_name,
                        terminal_cols,
                        24,
                        &working_dir,
                        SessionBindingInput {
                            revision: 0,
                            profiles: &[],
                            snapshots: &[],
                        },
                    )
                    .await
                    .map_err(|error| ToolError::backend(format!("{error:#}")))?;
                Ok(SessionCreateResponse {
                    name: queued_name,
                    warnings: outcome.warnings,
                    sandbox: outcome.sandbox,
                    workspace: None,
                })
            })
            .await?;
        serde_json::to_value(response).map_err(|error| ToolError::backend(error.to_string()))
    }

    async fn kill_session(&self, agent_id: &str, name: &str) -> Result<Value, ToolError> {
        self.ensure_target(agent_id)?;
        let tmux = Arc::clone(&self.tmux);
        let sessions = Arc::clone(&self.sessions);
        let session_name = name.to_string();
        let queued_name = session_name.clone();
        let response = self
            .run_keyed(&session_name, async move {
                tmux.kill_session(&queued_name)
                    .await
                    .map_err(|error| ToolError::backend(format!("{error:#}")))?;
                // The tmux Session is gone; an attachment left behind would
                // answer the next attach with a dead backend. Same retirement
                // the P2P route runs.
                sessions
                    .retire_session(
                        &queued_name,
                        "the session was killed; create or attach a new one",
                    )
                    .await;
                Ok(SessionKillResponse { name: queued_name })
            })
            .await?;
        serde_json::to_value(response).map_err(|error| ToolError::backend(error.to_string()))
    }
}
