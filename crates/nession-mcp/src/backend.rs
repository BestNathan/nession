//! The two semantic backend seams (`#3264`, `#3735`).
//!
//! A Tool's semantic owner decides which seam it uses — never where the MCP
//! endpoint happens to run:
//!
//! * [`ClusterBackend`] answers **Server-owned discovery** and ENV/binding
//!   management.
//! * [`NodeBackend`] answers **Agent-owned Session state**: the real tmux
//!   Sessions of one explicitly named Agent.
//!
//! Every seam method returns a **typed success reply** (`#3735`). The type is
//! either the authoritative Protocol contract the owner already serves
//! (`WebAgentsListResponse`, `ClientEnv*ResponsePayload`,
//! `ClientSessionEnvBindingResponsePayload`, `SessionKillResponse`) or, where
//! hosting modes project one owner's state differently, the stabilized MCP
//! projection owned by the Tool module. A host adapter deserializes or builds
//! that type before the Tool can advertise or return it, so an untyped owner
//! reply cannot become a successful MCP result.
//!
//! A backend does not decide a Tool name, schema, validation or result shape —
//! those live with the Tool module — and it never sees the inbound MCP token.

use async_trait::async_trait;
use nession_protocol::contracts::agent::v1::WebAgentsListResponse;
use nession_protocol::contracts::env::v1::{
    ClientEnvDeletePayload, ClientEnvDeleteResponsePayload, ClientEnvGetPayload,
    ClientEnvGetResponsePayload, ClientEnvListResponsePayload, ClientEnvWritePayload,
    ClientEnvWriteResponsePayload,
};
use nession_protocol::contracts::session::v1::{
    ClientSessionEnvBindingGetPayload, ClientSessionEnvBindingReapplyPayload,
    ClientSessionEnvBindingResponsePayload, ClientSessionEnvBindingSetPayload, SessionKillResponse,
};
use serde_json::{Map, Value};

use crate::error::ToolError;
use crate::tools::nession_agent_create_session::SessionCreatedOutput;
use crate::tools::nession_agent_list_sessions::SessionListOutput;

/// The Server-owned cluster view.
///
/// The Server owns registry discovery and ENV-file inventory and mutation.
/// Agent-owned Session lifecycle and live state remain on the Node seam.
#[async_trait]
pub trait ClusterBackend: Send + Sync {
    /// `nession_server_list_agents` — the Server registry's Agent view.
    async fn list_agents(&self) -> Result<WebAgentsListResponse, ToolError>;

    /// `nession_server_env_list` — server and online-agent file inventory.
    async fn env_list(&self) -> Result<ClientEnvListResponsePayload, ToolError>;

    /// `nession_server_env_get` — raw file content (potentially sensitive).
    async fn env_get(
        &self,
        payload: ClientEnvGetPayload,
    ) -> Result<ClientEnvGetResponsePayload, ToolError>;

    /// `nession_server_env_write` — canonical in-use/overwrite protection.
    async fn env_write(
        &self,
        payload: ClientEnvWritePayload,
    ) -> Result<ClientEnvWriteResponsePayload, ToolError>;

    /// `nession_server_env_delete` — canonical in-use/delete protection.
    async fn env_delete(
        &self,
        payload: ClientEnvDeletePayload,
    ) -> Result<ClientEnvDeleteResponsePayload, ToolError>;

    /// `nession_server_session_env_binding_get` — desired + observed state.
    async fn session_env_binding_get(
        &self,
        payload: ClientSessionEnvBindingGetPayload,
    ) -> Result<ClientSessionEnvBindingResponsePayload, ToolError>;

    /// `nession_server_session_env_binding_set` — whole ordered replacement
    /// with the Server's durable revision compare-and-swap.
    async fn session_env_binding_set(
        &self,
        payload: ClientSessionEnvBindingSetPayload,
    ) -> Result<ClientSessionEnvBindingResponsePayload, ToolError>;

    /// `nession_server_session_env_binding_reapply` — re-resolve the current
    /// selection at a new revision.
    async fn session_env_binding_reapply(
        &self,
        payload: ClientSessionEnvBindingReapplyPayload,
    ) -> Result<ClientSessionEnvBindingResponsePayload, ToolError>;
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
    async fn list_sessions(&self, agent_id: &str) -> Result<SessionListOutput, ToolError>;

    /// `nession_agent_create_session`.
    async fn create_session(
        &self,
        agent_id: &str,
        name: &str,
        working_dir: Option<&str>,
    ) -> Result<SessionCreatedOutput, ToolError>;

    /// `nession_agent_kill_session`.
    async fn kill_session(
        &self,
        agent_id: &str,
        name: &str,
    ) -> Result<SessionKillResponse, ToolError>;

    /// Execute one Extension-contributed Tool on the explicitly named Agent
    /// (`#3778`).
    ///
    /// The default is a truthful refusal: a host that cannot route a
    /// contribution (for example an Agent answering for somebody else) never
    /// silently executes it locally. The Server broker and the standalone
    /// routing backends override this with the canonical route.
    async fn call_extension_tool(
        &self,
        _agent_id: &str,
        _tool: &str,
        _arguments: Map<String, Value>,
    ) -> Result<Value, ToolError> {
        Err(ToolError::unavailable(
            "this MCP host cannot execute Extension-contributed Tools for the named Agent",
        ))
    }
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
    async fn list_agents(&self) -> Result<WebAgentsListResponse, ToolError> {
        Err(ToolError::unavailable(self.reason.clone()))
    }

    async fn env_list(&self) -> Result<ClientEnvListResponsePayload, ToolError> {
        Err(ToolError::unavailable(self.reason.clone()))
    }

    async fn env_get(
        &self,
        _payload: ClientEnvGetPayload,
    ) -> Result<ClientEnvGetResponsePayload, ToolError> {
        Err(ToolError::unavailable(self.reason.clone()))
    }

    async fn env_write(
        &self,
        _payload: ClientEnvWritePayload,
    ) -> Result<ClientEnvWriteResponsePayload, ToolError> {
        Err(ToolError::unavailable(self.reason.clone()))
    }

    async fn env_delete(
        &self,
        _payload: ClientEnvDeletePayload,
    ) -> Result<ClientEnvDeleteResponsePayload, ToolError> {
        Err(ToolError::unavailable(self.reason.clone()))
    }

    async fn session_env_binding_get(
        &self,
        _payload: ClientSessionEnvBindingGetPayload,
    ) -> Result<ClientSessionEnvBindingResponsePayload, ToolError> {
        Err(ToolError::unavailable(self.reason.clone()))
    }

    async fn session_env_binding_set(
        &self,
        _payload: ClientSessionEnvBindingSetPayload,
    ) -> Result<ClientSessionEnvBindingResponsePayload, ToolError> {
        Err(ToolError::unavailable(self.reason.clone()))
    }

    async fn session_env_binding_reapply(
        &self,
        _payload: ClientSessionEnvBindingReapplyPayload,
    ) -> Result<ClientSessionEnvBindingResponsePayload, ToolError> {
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
    async fn list_sessions(&self, _agent_id: &str) -> Result<SessionListOutput, ToolError> {
        Err(ToolError::unavailable(self.reason.clone()))
    }

    async fn create_session(
        &self,
        _agent_id: &str,
        _name: &str,
        _working_dir: Option<&str>,
    ) -> Result<SessionCreatedOutput, ToolError> {
        Err(ToolError::unavailable(self.reason.clone()))
    }

    async fn kill_session(
        &self,
        _agent_id: &str,
        _name: &str,
    ) -> Result<SessionKillResponse, ToolError> {
        Err(ToolError::unavailable(self.reason.clone()))
    }
}
