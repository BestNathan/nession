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
    #[serde(default = "default_protocol_version")]
    pub protocol_version: String,
    /// Human-readable display name (set via agent config or Web UI rename).
    /// When absent the UI falls back to hostname.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Public WebSocket URL clients use to connect (e.g. "wss://agent.example.com/ws").
    /// When empty, the server constructs a URL from ip_address:port with `/ws` path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connect_url: Option<String>,
    /// All reachable WebSocket endpoints for this agent, in priority order.
    /// Newer agents populate this from NIC detection + config-declared tunnels.
    /// Older agents omit it; the server then synthesises a single-entry list
    /// from `ip_address`/`port`/`connect_url` for backward compatibility.
    #[serde(default)]
    pub addresses: Vec<AgentAddress>,
}

fn default_protocol_version() -> String {
    "1.0".to_string()
}

/// Network category of an advertised agent address.
///
/// Used to label endpoints in the UI and to break ties when the server must
/// pick a single legacy `agent_address` for old clients (tunnels win).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NetworkType {
    /// RFC 1918 / link-local address on a physical or virtual LAN.
    Lan,
    /// Address that reaches the node over a VPN overlay.
    Vpn,
    /// Reverse tunnel / ingress hostname (frp, ngrok, cloudflared, k8s ingress).
    Tunnel,
    /// Routable public address.
    Public,
    /// User-declared address that doesn't fit the other categories.
    Custom,
}

impl NetworkType {
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            NetworkType::Lan => "lan",
            NetworkType::Vpn => "vpn",
            NetworkType::Tunnel => "tunnel",
            NetworkType::Public => "public",
            NetworkType::Custom => "custom",
        }
    }

    /// Default priority for auto-detected addresses of this type (lower connects
    /// first). Tunnels are most likely reachable from anywhere, LAN is fastest
    /// when co-located, so we bias LAN highest then tunnel then the rest.
    #[must_use]
    pub fn default_priority(&self) -> i32 {
        match self {
            NetworkType::Lan => 10,
            NetworkType::Vpn => 20,
            NetworkType::Tunnel => 30,
            NetworkType::Public => 40,
            NetworkType::Custom => 50,
        }
    }
}

/// A single advertised way to reach an agent over WebSocket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentAddress {
    /// Complete WebSocket URL, e.g. `ws://192.168.1.5:8080/ws`.
    pub url: String,
    /// Human-readable label for the UI (e.g. "LAN", "Tunnel"). Optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// How this address reaches the node.
    pub network_type: NetworkType,
    /// Connection preference; lower connects first. Defaults from
    /// `NetworkType::default_priority` when not explicitly set.
    #[serde(default)]
    pub priority: i32,
}

/// Result of the server's TCP reachability probe for an address.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AddressStatus {
    /// Not yet probed (e.g. right after server restart).
    Unknown,
    /// Last TCP dial succeeded within the timeout.
    Reachable,
    /// Last TCP dial failed or timed out.
    Unreachable,
}

impl AddressStatus {
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            AddressStatus::Unknown => "unknown",
            AddressStatus::Reachable => "reachable",
            AddressStatus::Unreachable => "unreachable",
        }
    }
}

/// An advertised address annotated with the server's latest probe result.
/// Sent to clients in the attach response so they can prioritise reachable
/// endpoints and skip known-dead ones.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbedAddress {
    #[serde(flatten)]
    pub address: AgentAddress,
    pub status: AddressStatus,
    /// Round-trip time of the last successful probe, in milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rtt_ms: Option<u64>,
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

fn default_attach_mode() -> String {
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

// --- Env state query payloads ---

/// `server.env.query` — ask an agent for its currently sourced env files.
/// Used by the EnvPanel to show which env files are active on each agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerEnvQueryPayload {
    pub request_id: String,
}

/// Agent response to `server.env.query`. The agent reports which env files
/// it has currently sourced (applied to its environment).
/// Response message type: `agent.session.command.response` with command="env.query"
/// and this payload structure in the JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEnvStatePayload {
    pub request_id: String,
    /// List of env file refs currently sourced by this agent.
    pub sourced_files: Vec<EnvFileRef>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_message_new() {
        let msg = Message::new(
            "test.type".to_string(),
            "id-123".to_string(),
            1234567890,
            "payload".to_string(),
        );
        assert_eq!(msg.msg_type, "test.type");
        assert_eq!(msg.id, "id-123");
        assert_eq!(msg.timestamp, 1234567890);
        assert_eq!(msg.payload, "payload");
    }

    #[test]
    fn test_message_serde() {
        let msg = Message::new("test".to_string(), "id".to_string(), 100, 42i32);
        let json = serde_json::to_string(&msg).unwrap();
        let deserialized: Message<i32> = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.msg_type, "test");
        assert_eq!(deserialized.payload, 42);
    }

    #[test]
    fn test_network_type_as_str() {
        assert_eq!(NetworkType::Lan.as_str(), "lan");
        assert_eq!(NetworkType::Vpn.as_str(), "vpn");
        assert_eq!(NetworkType::Tunnel.as_str(), "tunnel");
        assert_eq!(NetworkType::Public.as_str(), "public");
        assert_eq!(NetworkType::Custom.as_str(), "custom");
    }

    #[test]
    fn test_network_type_serde() {
        let t: NetworkType = serde_json::from_str("\"lan\"").unwrap();
        assert_eq!(t, NetworkType::Lan);
        let json = serde_json::to_string(&NetworkType::Tunnel).unwrap();
        assert_eq!(json, "\"tunnel\"");
    }

    #[test]
    fn test_address_status_as_str() {
        assert_eq!(AddressStatus::Unknown.as_str(), "unknown");
        assert_eq!(AddressStatus::Reachable.as_str(), "reachable");
        assert_eq!(AddressStatus::Unreachable.as_str(), "unreachable");
    }

    #[test]
    fn test_env_source_as_str() {
        assert_eq!(EnvSource::Server.as_str(), "server");
        assert_eq!(EnvSource::Agent.as_str(), "agent");
    }

    #[test]
    fn test_env_source_serde() {
        let s: EnvSource = serde_json::from_str("\"server\"").unwrap();
        assert_eq!(s, EnvSource::Server);
        let s: EnvSource = serde_json::from_str("\"agent\"").unwrap();
        assert_eq!(s, EnvSource::Agent);
    }

    #[test]
    fn test_default_attach_mode() {
        assert_eq!(default_attach_mode(), "p2p");
    }

    #[test]
    fn test_agent_register_payload_serde() {
        let payload = AgentRegisterPayload {
            agent_id: "agent-1".to_string(),
            hostname: "host".to_string(),
            ip_address: "127.0.0.1".to_string(),
            port: 8080,
            auth_token: "token".to_string(),
            metadata: AgentMetadata {
                tmux_version: "3.4".to_string(),
                os_version: "linux".to_string(),
                nession_version: "0.1.0".to_string(),
            },
            protocol_version: "1.0".to_string(),
            display_name: Some("my-agent".to_string()),
            connect_url: None,
            addresses: vec![],
        };
        let json = serde_json::to_string(&payload).unwrap();
        let deserialized: AgentRegisterPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.agent_id, "agent-1");
        assert_eq!(deserialized.port, 8080);
        assert!(deserialized.connect_url.is_none());
    }

    #[test]
    fn test_agent_register_payload_no_display_name() {
        // Old agents without display_name should deserialize to None (backward compat)
        let json = serde_json::json!({
            "agent_id": "agent-1",
            "hostname": "host",
            "ip_address": "127.0.0.1",
            "port": 8080,
            "auth_token": "token",
            "addresses": [],
            "metadata": {
                "tmux_version": "3.4",
                "os_version": "linux",
                "nession_version": "0.1.0"
            }
        });
        let payload: AgentRegisterPayload = serde_json::from_value(json).unwrap();
        assert_eq!(payload.agent_id, "agent-1");
        assert!(payload.display_name.is_none());
    }

    #[test]
    fn test_env_file_ref_serde() {
        let r = EnvFileRef {
            name: "test.env".to_string(),
            source: EnvSource::Server,
            agent_id: None,
        };
        let json = serde_json::to_string(&r).unwrap();
        let deserialized: EnvFileRef = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.name, "test.env");
        assert_eq!(deserialized.source, EnvSource::Server);
        assert!(deserialized.agent_id.is_none());
    }

    #[test]
    fn test_env_file_ref_with_agent_id() {
        let r = EnvFileRef {
            name: "test.env".to_string(),
            source: EnvSource::Agent,
            agent_id: Some("agent-1".to_string()),
        };
        let json = serde_json::to_string(&r).unwrap();
        let deserialized: EnvFileRef = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.agent_id, Some("agent-1".to_string()));
    }

    #[test]
    fn test_terminal_resize_payload_serde() {
        let payload = AgentTerminalResizePayload {
            session_id: "session-123".to_string(),
            cols: 120,
            rows: 40,
        };
        let json = serde_json::to_string(&payload).unwrap();
        let deserialized: AgentTerminalResizePayload = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.session_id, "session-123");
        assert_eq!(deserialized.cols, 120);
        assert_eq!(deserialized.rows, 40);
    }

    #[test]
    fn test_server_terminal_resize_payload_serde() {
        let payload = ServerTerminalResizePayload {
            session_id: "session-123".to_string(),
            cols: 120,
            rows: 40,
        };
        let json = serde_json::to_string(&payload).unwrap();
        let deserialized: ServerTerminalResizePayload = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.session_id, "session-123");
        assert_eq!(deserialized.cols, 120);
        assert_eq!(deserialized.rows, 40);
    }

    #[test]
    fn test_client_session_attach_payload_default_env_snapshots() {
        let json = serde_json::json!({
            "session_id": "agent:session",
            "preferred_mode": "relay"
        });
        let payload: ClientSessionAttachPayload = serde_json::from_value(json).unwrap();
        assert_eq!(payload.session_id, "agent:session");
        assert_eq!(payload.preferred_mode, "relay");
        assert!(payload.env_snapshots.is_empty());
    }

    #[test]
    fn test_client_session_attach_payload_with_env_snapshots() {
        let json = serde_json::json!({
            "session_id": "agent:session",
            "preferred_mode": "relay",
            "env_snapshots": [{
                "name": "staging.env",
                "source": "server",
                "vars": [["NODE_ENV", "staging"], ["DEBUG", "true"]],
                "warnings": []
            }]
        });
        let payload: ClientSessionAttachPayload = serde_json::from_value(json).unwrap();
        assert_eq!(payload.env_snapshots.len(), 1);
        assert_eq!(payload.env_snapshots[0].name, "staging.env");
        assert_eq!(payload.env_snapshots[0].vars.len(), 2);
    }
}
