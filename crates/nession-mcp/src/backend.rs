//! The only two seams a hosting mode fills in.
//!
//! A backend answers one semantic-owner family. It does **not** decide the tool
//! name, schema, validation or result shape — those live in [`crate::tools`] —
//! and it never sees the inbound MCP token.
//!
//! Every method returns the business reply as it is produced by the existing
//! owner (a Server contract reply, an Agent session reply, or an equivalent
//! projection). [`crate::service`] is what turns a reply into an MCP result,
//! including the `isError` bit for a delivered refusal.

use async_trait::async_trait;
use serde_json::Value;

use crate::error::ToolError;

/// The Server-owned cluster view and mutations.
///
/// These tools answer from the **Server's registry** and route through the
/// Server's existing paths. A cluster tool that happens to carry an `agent_id`
/// filter is still a Server query; it is never an Agent-local read in disguise.
#[async_trait]
pub trait ClusterBackend: Send + Sync {
    /// `nession_server_list_agents`.
    async fn list_agents(&self) -> Result<Value, ToolError>;

    /// `nession_server_list_sessions`, with the existing `server.session.list`
    /// `agent_id`/`force` semantics.
    async fn list_sessions(&self, agent_id: Option<&str>, force: bool) -> Result<Value, ToolError>;

    /// `nession_server_get_info`.
    async fn get_info(&self) -> Result<Value, ToolError>;

    /// `nession_server_capture_session_preview`.
    async fn capture_session_preview(
        &self,
        session_id: &str,
        lines: u32,
    ) -> Result<Value, ToolError>;

    /// `nession_server_get_session_attach_info`.
    ///
    /// Implementations must return **only** non-secret fields. A Server P2P
    /// credential (or any other authentication material) must never appear in
    /// the returned value.
    async fn get_session_attach_info(&self, session_id: &str) -> Result<Value, ToolError>;

    /// `nession_server_create_session`.
    async fn create_session(&self, agent_id: &str, name: &str) -> Result<Value, ToolError>;

    /// `nession_server_kill_session`.
    async fn kill_session(&self, session_id: &str) -> Result<Value, ToolError>;

    /// `nession_server_rename_agent`.
    async fn rename_agent(
        &self,
        agent_id: &str,
        display_name: Option<&str>,
    ) -> Result<Value, ToolError>;

    /// `nession_server_delete_agent`.
    async fn delete_agent(&self, agent_id: &str) -> Result<Value, ToolError>;
}

/// One explicitly named Agent node's real session state.
///
/// `agent_id` is always present by the time a backend sees it: the tool schema
/// requires it, and [`crate::service`] rejects an empty value before dispatch.
/// The backend is responsible for the remaining target check:
///
/// * Agent embedded accepts only its own id;
/// * Server embedded routes to that id;
/// * Standalone checks the configured target.
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
/// It exists so the tool catalog does **not** shrink when a backend is
/// temporarily absent: the requirement is that a configured catalog stays
/// stable and an offline backend answers with a structured error. The most
/// common case is an Agent running in standalone mode.
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

    async fn list_sessions(
        &self,
        _agent_id: Option<&str>,
        _force: bool,
    ) -> Result<Value, ToolError> {
        Err(ToolError::unavailable(self.reason.clone()))
    }

    async fn get_info(&self) -> Result<Value, ToolError> {
        Err(ToolError::unavailable(self.reason.clone()))
    }

    async fn capture_session_preview(
        &self,
        _session_id: &str,
        _lines: u32,
    ) -> Result<Value, ToolError> {
        Err(ToolError::unavailable(self.reason.clone()))
    }

    async fn get_session_attach_info(&self, _session_id: &str) -> Result<Value, ToolError> {
        Err(ToolError::unavailable(self.reason.clone()))
    }

    async fn create_session(&self, _agent_id: &str, _name: &str) -> Result<Value, ToolError> {
        Err(ToolError::unavailable(self.reason.clone()))
    }

    async fn kill_session(&self, _session_id: &str) -> Result<Value, ToolError> {
        Err(ToolError::unavailable(self.reason.clone()))
    }

    async fn rename_agent(
        &self,
        _agent_id: &str,
        _display_name: Option<&str>,
    ) -> Result<Value, ToolError> {
        Err(ToolError::unavailable(self.reason.clone()))
    }

    async fn delete_agent(&self, _agent_id: &str) -> Result<Value, ToolError> {
        Err(ToolError::unavailable(self.reason.clone()))
    }
}

/// The node backend of a deployment with no configured Agent target.
///
/// Used by the standalone binary when `[backend.agent]` is absent. The Agent
/// tools remain in the catalog and each call names what is missing rather than
/// silently choosing the MCP host — which is the one thing the requirement
/// forbids.
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
