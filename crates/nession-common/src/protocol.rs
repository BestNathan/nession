use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message<T> {
    pub msg_type: String,
    pub id: String,
    pub timestamp: u64,
    pub payload: T,
}

impl<T> Message<T> {
    pub fn new(msg_type: String, id: String, timestamp: u64, payload: T) -> Self {
        Self {
            msg_type,
            id,
            timestamp,
            payload,
        }
    }
}

pub type ProtocolMessage<T> = Message<T>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRegisterPayload {
    pub agent_id: String,
    pub hostname: String,
    pub ip_address: String,
    pub port: u16,
    pub auth_token: String,
    pub metadata: AgentMetadata,
    pub protocol_version: String,
    /// Public WebSocket URL clients use to connect (e.g. "wss://agent.example.com/ws").
    /// When empty, the server constructs a URL from ip_address:port with `/ws` path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connect_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMetadata {
    pub tmux_version: String,
    pub os_version: String,
    pub nession_version: String,
}

/// Server → Agent response to `agent.register`.
///
/// On acceptance the server tells the agent which heartbeat interval to use,
/// so the cadence is configured centrally rather than per-agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRegisterResponsePayload {
    /// "accepted" or "rejected".
    pub status: String,
    /// Human-readable detail.
    pub message: String,
    /// Heartbeat interval the agent should use, in seconds. Absent on rejection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heartbeat_interval_secs: Option<u64>,
}

/// Server → Agent acknowledgement of a received `agent.heartbeat`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerHeartbeatAckPayload {
    /// Echoes the agent id the heartbeat was for.
    pub agent_id: String,
    /// Server timestamp (unix seconds) when the heartbeat was processed.
    pub server_time: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentHeartbeatPayload {
    pub agent_id: String,
    pub status: AgentStatus,
    pub session_count: u32,
    pub active_sessions: u32,
    pub metadata: HeartbeatMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Online,
    Offline,
    Degraded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatMetadata {
    pub uptime_seconds: u64,
    pub load_average: [f64; 3],
}

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

fn default_width() -> u16 {
    80
}

fn default_height() -> u16 {
    24
}

// --- Agent → Server command response payload ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCommandResponsePayload {
    pub request_id: String,
    pub command: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionKillResponsePayload {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ============================================================================
// Environment-variable file management
// ============================================================================

/// Where an env file physically lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnvSource {
    /// Stored on the central server (`~/.nession/server/envs`). Uploaded or
    /// created via the Web UI; authoritative and syncable to agents.
    Server,
    /// Discovered locally on an agent node (`~/.nession/agent/envs`).
    Agent,
}

impl EnvSource {
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            EnvSource::Server => "server",
            EnvSource::Agent => "agent",
        }
    }
}

/// Metadata describing a single env file in a listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvFileInfo {
    /// Filename including the `.env` suffix (e.g. `staging.env`).
    pub name: String,
    /// Where the file lives.
    pub source: EnvSource,
    /// For `EnvSource::Agent`, the owning agent id. `None` for server files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// File size in bytes.
    pub size: u64,
    /// Last-modified time (unix seconds).
    pub modified: u64,
    /// Number of resolved variables (best-effort; excludes malformed lines).
    pub var_count: usize,
}

/// A reference to an env file, used to select files for a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvFileRef {
    pub name: String,
    pub source: EnvSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

/// A resolved env-file snapshot: the file's parsed variables captured at
/// use-time so later edits don't affect a running session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvSnapshot {
    pub name: String,
    pub source: EnvSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// Ordered KEY/VALUE pairs (already deduplicated, last-wins).
    pub vars: Vec<(String, String)>,
    /// Non-fatal parse warnings surfaced to the UI.
    #[serde(default)]
    pub warnings: Vec<String>,
}

// --- Client → Server env CRUD payloads ---

/// `client.env.list` — list env files from server + all online agents.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ClientEnvListPayload {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientEnvListResponsePayload {
    pub files: Vec<EnvFileInfo>,
}

/// `client.env.get` — read one env file's raw content for editing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientEnvGetPayload {
    pub name: String,
    pub source: EnvSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientEnvGetResponsePayload {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Session ids currently using this file (empty when not in use).
    #[serde(default)]
    pub in_use_by: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `client.env.write` — create or overwrite an env file (server or agent).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientEnvWritePayload {
    pub name: String,
    pub source: EnvSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub content: String,
    /// When false, refuse to overwrite an existing file (create-only).
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientEnvWriteResponsePayload {
    pub success: bool,
    /// True when the write was refused because the file already exists and
    /// `overwrite` was false (UI prompts for confirmation).
    #[serde(default)]
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// `client.env.delete` — delete an env file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientEnvDeletePayload {
    pub name: String,
    pub source: EnvSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientEnvDeleteResponsePayload {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// An active env application on a session (for visibility). Reported alongside
/// session listings / attach info.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveEnvFile {
    pub name: String,
    pub source: EnvSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// "create" (injected at session creation) or "attach" (applied on attach).
    pub phase: String,
    /// The client/user that applied it (best-effort identifier).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_by: Option<String>,
}

// --- Server → Agent env command payloads ---

/// `server.env.list` — ask an agent for its local env files.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerEnvListPayload {
    pub request_id: String,
}

/// `server.env.get` — read one agent-local env file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerEnvGetPayload {
    pub request_id: String,
    pub name: String,
}

/// `server.env.write` — write an agent-local env file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerEnvWritePayload {
    pub request_id: String,
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub overwrite: bool,
}

/// `server.env.delete` — delete an agent-local env file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerEnvDeletePayload {
    pub request_id: String,
    pub name: String,
}

/// `server.session.env.apply` / `server.session.env.unset` — the server hands
/// the agent already-resolved snapshots (so parsing/source resolution is done
/// centrally) to apply or remove on a running session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSessionEnvApplyPayload {
    pub request_id: String,
    pub name: String,
    pub snapshots: Vec<EnvSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSessionEnvUnsetPayload {
    pub request_id: String,
    pub name: String,
    /// The variable keys to remove via `tmux set-environment -u`.
    pub keys: Vec<String>,
}
