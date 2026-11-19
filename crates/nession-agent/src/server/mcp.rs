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
use nession_mcp::pending_mutation::PendingMutation;
use nession_mcp::provider::McpToolProvider;
use nession_mcp::tools::nession_agent_create_session::SessionCreatedOutput;
use nession_mcp::tools::nession_agent_list_sessions::SessionListOutput;
use nession_mcp::{McpService, ServiceConfig};
use nession_protocol::contracts::session::v1::{SessionKillResponse, SessionListResponse};

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

/// The borrowed host facts an MCP mount is built from.
///
/// Bundled so the mount signature stays a state description plus the services
/// it reuses, rather than accumulating one scalar per Host capability.
pub(crate) struct McpHost<'a> {
    pub config: &'a AgentConfig,
    /// The resolved durable Agent Token this endpoint verifies (#3440).
    pub agent_token: &'a str,
    pub agent_id: &'a str,
    pub default_working_dir: &'a str,
    pub terminal_cols: u16,
}

/// Build the Agent-hosted MCP service when `[mcp] enabled = true`.
///
/// `tool_providers` is the runtime's explicit Extension composition (#3778):
/// the Agent owns which contributions reach the shared endpoint, while the
/// shared catalog owns validation and generation swaps.
pub(crate) fn build(
    host: McpHost<'_>,
    tmux: Arc<SessionManager>,
    sessions: Arc<SessionRegistry>,
    mutations: Arc<KeyedLane<ResourceKey>>,
    tool_providers: Vec<Arc<dyn McpToolProvider>>,
) -> anyhow::Result<Option<Arc<McpService>>> {
    let McpHost {
        config,
        agent_token,
        agent_id,
        default_working_dir,
        terminal_cols,
    } = host;
    if !config.mcp.enabled {
        return Ok(None);
    }
    // Fail closed for a directly constructed config too.
    config.mcp.validate_for_host(agent_token, "agent_token")?;

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

    let allowed_hosts =
        config.mcp.allowed_hosts.clone().unwrap_or_else(|| {
            nession_mcp::service::allowed_hosts_for_bind(&config.listen_address)
        });
    let service_config = ServiceConfig {
        path: config.mcp.path.clone(),
        auth_token: nession_protocol::TokenVerifier::new(agent_token),
        tool_timeout: std::time::Duration::from_secs(config.mcp.tool_timeout_secs),
        max_concurrent_calls: config.mcp.max_concurrent_calls,
        allowed_origins: config.mcp.allowed_origins.clone(),
        allowed_hosts,
    };
    let service = McpService::with_providers(service_config, cluster, node, tool_providers)?;
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
        let (request, admission) = PendingMutation::new();
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
                    // An expired MCP request must not start its queued mutation.
                    // Once admitted to execution, let the owner finish it; the
                    // caller may receive an indeterminate timeout instead.
                    if admission.try_begin() {
                        let _ = reply.send(work.await);
                    }
                }),
            )
            .await;
        let outcome = result
            .await
            .map_err(|_| ToolError::backend("the Agent's mutation lane ended before answering"))?;
        drop(request);
        outcome
    }
}

#[async_trait::async_trait]
impl NodeBackend for AgentNodeBackend {
    async fn list_sessions(&self, agent_id: &str) -> Result<SessionListOutput, ToolError> {
        self.ensure_target(agent_id)?;
        let sessions = self
            .tmux
            .list_sessions()
            .await
            .map_err(|error| ToolError::backend(format!("{error:#}")))?;
        let reply = SessionListResponse {
            sessions,
            stale_agents: Vec::new(),
        };
        Ok(SessionListOutput::from_agent_sessions(
            agent_id,
            &reply.sessions,
        ))
    }

    async fn create_session(
        &self,
        agent_id: &str,
        name: &str,
        working_dir: Option<&str>,
    ) -> Result<SessionCreatedOutput, ToolError> {
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
                Ok(SessionCreatedOutput {
                    name: queued_name,
                    warnings: outcome.warnings,
                })
            })
            .await?;
        Ok(response)
    }

    async fn kill_session(
        &self,
        agent_id: &str,
        name: &str,
    ) -> Result<SessionKillResponse, ToolError> {
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
        Ok(response)
    }
}

// A real shared-key queue must not run abandoned MCP work after the earlier
// owner operation releases the key. This uses explicit barriers, not sleeps.
#[cfg(test)]
mod mcp_cancellation_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[tokio::test]
    async fn abandoned_queued_mutation_never_starts_after_lane_release() {
        let mut lane = KeyedLane::<ResourceKey>::new(16, "mcp test ");
        let key = ResourceKey::Session("held-session".to_string());
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let (release_sender, release_receiver) = tokio::sync::oneshot::channel();
        lane.enqueue(
            key.clone(),
            Box::pin(async move {
                let _ = started_sender.send(());
                let _ = release_receiver.await;
            }),
        )
        .await;
        started_receiver
            .await
            .expect("the first mutation claimed this key");

        let (request, admission) = PendingMutation::new();
        let executed = Arc::new(AtomicBool::new(false));
        let observed = Arc::clone(&executed);
        lane.enqueue(
            key,
            Box::pin(async move {
                if admission.try_begin() {
                    observed.store(true, Ordering::SeqCst);
                }
            }),
        )
        .await;
        drop(request); // exactly what an outer MCP timeout does to run_keyed
        release_sender.send(()).expect("release blocker");
        lane.drain().await;
        assert!(!executed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn started_mutation_finishes_even_after_caller_abandons_reply() {
        let mut lane = KeyedLane::<ResourceKey>::new(16, "mcp test ");
        let key = ResourceKey::Session("running-session".to_string());
        let (request, admission) = PendingMutation::new();
        let executed = Arc::new(AtomicBool::new(false));
        let observed = Arc::clone(&executed);
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let (release_sender, release_receiver) = tokio::sync::oneshot::channel();
        lane.enqueue(
            key,
            Box::pin(async move {
                if admission.try_begin() {
                    let _ = started_sender.send(());
                    let _ = release_receiver.await;
                    observed.store(true, Ordering::SeqCst);
                }
            }),
        )
        .await;
        started_receiver.await.expect("worker entered its mutation");
        drop(request); // the owner must finish a mutation already admitted
        release_sender.send(()).expect("release running work");
        lane.drain().await;
        assert!(executed.load(Ordering::SeqCst));
    }
}
