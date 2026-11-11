//! The two semantic backend seams (`#3264`).
//!
//! A Tool's semantic owner decides which seam it uses — never where the MCP
//! endpoint happens to run:
//!
//! * [`ClusterBackend`] answers **Server-owned discovery**: which Agents the
//!   Server registry knows about.
//! * [`NodeBackend`] answers **Agent-owned Session state**: the real tmux
//!   Sessions of one explicitly named Agent.
//!
//! A backend does not decide a Tool name, schema, validation or result shape —
//! those live with the Tool module — and it never sees the inbound MCP token.

use async_trait::async_trait;
use serde_json::Value;

use crate::error::ToolError;

/// The Server-owned cluster view.
///
/// The only Server-owned Tool is Agent discovery; Session lifecycle and live
/// state belong to the Agent even when the caller reaches them through the
/// Server's routing.
#[async_trait]
pub trait ClusterBackend: Send + Sync {
    /// `nession_server_list_agents` — the Server registry's Agent view.
    async fn list_agents(&self) -> Result<Value, ToolError>;
}

/// One explicitly named Agent node's real Session state.
///
/// `agent_id` is always present by the time a backend sees it: the Tool schema
/// requires it and the registry rejects an empty value before dispatch. The
/// backend owns the remaining target check:
///
/// * Agent embedded accepts only its own id;
/// * Server embedded routes to that id through the canonical broker;
/// * Standalone routes through the configured Server, or through the explicit
///   direct-Agent backend when an operator configured one.
#[async_trait]
pub trait NodeBackend: Send + Sync {
    /// `nession_agent_list_sessions`.
    async fn list_sessions(&self, agent_id: &str) -> Result<Value, ToolError>;

    /// `nession_agent_create_session`.
    async fn create_session(
        &self,
        agent_id: &str,
        name: &str,
        working_dir: Option<&str>,
    ) -> Result<Value, ToolError>;

    /// `nession_agent_kill_session`.
    async fn kill_session(&self, agent_id: &str, name: &str) -> Result<Value, ToolError>;
}

/// The cluster backend of a host that has no Server configured.
///
/// It exists so the Tool catalog does not shrink when a backend is temporarily
/// absent: a configured catalog stays stable and an offline backend answers
/// with a structured error. The common case is a standalone Agent.
pub struct UnavailableClusterBackend {
    reason: String,
}

impl UnavailableClusterBackend {
    /// Build one with the sentence every cluster call will report.
    pub fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }
}

#[async_trait]
impl ClusterBackend for UnavailableClusterBackend {
    async fn list_agents(&self) -> Result<Value, ToolError> {
        Err(ToolError::unavailable(self.reason.clone()))
    }
}

/// The node backend of a deployment with no reachable Agent target.
///
/// Used by a standalone host that has neither a direct `[backend.agent]` nor a
/// Server to route through. The Agent tools remain in the catalog and each call
/// names what is missing rather than silently choosing the MCP host — which is
/// the one thing the requirement forbids.
pub struct UnavailableNodeBackend {
    reason: String,
}

impl UnavailableNodeBackend {
    /// Build one with the sentence every node call will report.
    pub fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }
}

#[async_trait]
impl NodeBackend for UnavailableNodeBackend {
    async fn list_sessions(&self, _agent_id: &str) -> Result<Value, ToolError> {
        Err(ToolError::unavailable(self.reason.clone()))
    }

    async fn create_session(
        &self,
        _agent_id: &str,
        _name: &str,
        _working_dir: Option<&str>,
    ) -> Result<Value, ToolError> {
        Err(ToolError::unavailable(self.reason.clone()))
    }

    async fn kill_session(&self, _agent_id: &str, _name: &str) -> Result<Value, ToolError> {
        Err(ToolError::unavailable(self.reason.clone()))
    }
}
