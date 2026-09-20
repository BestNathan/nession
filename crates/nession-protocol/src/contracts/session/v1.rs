use serde::{Deserialize, Serialize};

use crate::contracts::agent::v1::ProbedAddress;
use crate::contracts::env::v1::{EnvFileRef, EnvSnapshot};

// --- Server → Agent command payloads ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSessionCreatePayload {
    pub request_id: String,
    pub name: String,
    #[serde(default = "default_width")]
    pub width: u16,
    #[serde(default = "default_height")]
    pub height: u16,
    /// Resolved env-file snapshots to inject via `tmux new-session -e`.
    /// Empty (default) preserves the pre-env-feature behaviour exactly.
    #[serde(default)]
    pub env_snapshots: Vec<EnvSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSessionKillPayload {
    pub request_id: String,
    pub name: String,
}

pub(crate) fn default_width() -> u16 {
    80
}

pub(crate) fn default_height() -> u16 {
    24
}

// --- Agent → Server command response payload ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCommandResponsePayload {
    pub request_id: String,
    pub command: String,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
}

// --- Client → Server session command payloads ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionCreatePayload {
    pub agent_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionKillPayload {
    pub session_id: String,
}

// --- Server → Client session command response payloads ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionCreateResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionKillResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// --- Client ↔ Server session attach ---

/// `client.session.attach` — request to attach to a session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionAttachPayload {
    pub session_id: String,
    /// "auto" | "p2p" | "relay". The client resolves "auto" itself by first
    /// asking for "p2p" and falling back to "relay", so the server only ever
    /// sees "p2p" or "relay" in practice.
    #[serde(default = "default_attach_mode")]
    pub preferred_mode: String,
    /// Resolved env-file snapshots for attach-time injection (relay mode).
    /// Empty (default) preserves the pre-env-feature behaviour.
    #[serde(default)]
    pub env_snapshots: Vec<EnvSnapshot>,
    /// When set, the server connects to this exact URL for relay mode instead
    /// of auto-selecting from the agent's advertised addresses.  The URL must
    /// be one of the addresses returned in the attach response.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_url: Option<String>,
}

pub(crate) fn default_attach_mode() -> String {
    "p2p".to_string()
}

/// Server → Client response to `client.session.attach`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionAttachResponsePayload {
    /// "success" or "error".
    pub status: String,
    /// "p2p" or "relay".
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    /// Legacy single endpoint (first/preferred address). Kept so old clients
    /// that only read `agent_address` keep working.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_address: Option<String>,
    /// Full list of candidate endpoints with probe status, priority order.
    /// Clients test latency across these and fall back address-by-address.
    #[serde(default)]
    pub addresses: Vec<ProbedAddress>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// --- Env application to sessions ---

/// `client.session.env.apply` — apply env files to an already-running session
/// via `tmux set-environment` (attach-time).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionEnvApplyPayload {
    pub session_id: String,
    pub env_files: Vec<EnvFileRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionEnvUnsetPayload {
    pub session_id: String,
    /// The specific files (by name) previously applied by this client that
    /// should now be removed via `tmux set-environment -u`.
    pub env_files: Vec<EnvFileRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionEnvResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// `server.session.env.apply` / `server.session.env.unset` — the server hands
/// the agent already-resolved snapshots (so parsing/source resolution is done
/// centrally) to apply or remove on a running session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSessionEnvApplyPayload {
    pub request_id: String,
    pub name: String,
    pub snapshots: Vec<EnvSnapshot>,
    #[serde(default)]
    pub client_id: Option<String>,
    /// The env file refs being applied (for tracking purposes)
    #[serde(default)]
    pub env_files: Vec<EnvFileRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSessionEnvUnsetPayload {
    pub request_id: String,
    pub name: String,
    /// The variable keys to remove via `tmux set-environment -u`.
    pub keys: Vec<String>,
    #[serde(default)]
    pub client_id: Option<String>,
}

// ============================================================================
// Terminal resize events
// ============================================================================

/// Agent → Server: tmux session resized.
/// Agent parses tmux control mode `%window-resize` events and sends this
/// payload with the session id and new dimensions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTerminalResizePayload {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

/// Server → Client: broadcast terminal resize to all attached clients.
/// Reuses the message type name already used by CLI (`terminal.resize`).
/// The `session_id` lets each client route to its per-session callback —
/// clients may be attached to multiple sessions on the same WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerTerminalResizePayload {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}
