use serde::{Deserialize, Serialize};

use crate::contracts::default_image_tag;
use crate::ProtocolManifest;

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRegisterPayload {
    pub agent_id: String,
    pub hostname: String,
    pub ip_address: String,
    pub port: u16,
    pub auth_token: String,
    pub metadata: AgentMetadata,
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
    /// What this agent actually offers (`#678`).
    ///
    /// Optional, and that is the design's answer to "manifest in `agent.register`
    /// or a separate discovery message": putting it here costs no extra round
    /// trip, and making it optional means an **old agent registers exactly as it
    /// always did**. An absent manifest is not "supports everything" — it makes
    /// the agent a *Legacy Peer*, resolved only through contracts that declare an
    /// explicit legacy adapter.
    ///
    /// The manifest is derived from the providers an agent actually composed, so
    /// it cannot advertise a contract no handler serves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_manifest: Option<ProtocolManifest>,
}

/// Network category of an advertised agent address.
///
/// Used to label endpoints in the UI and to break ties when the server must
/// pick a single legacy `agent_address` for old clients (tunnels win).
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
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
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
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
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
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
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbedAddress {
    #[serde(flatten)]
    pub address: AgentAddress,
    pub status: AddressStatus,
    /// Round-trip time of the last successful probe, in milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rtt_ms: Option<u64>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMetadata {
    pub tmux_version: String,
    pub os_version: String,
    pub nession_version: String,
    /// Docker image tag (short sha) baked in at build time.
    /// "dev" when running from `cargo run`, "unknown" when not set.
    #[serde(default = "default_image_tag")]
    pub image_tag: String,
}

/// The agent family's refusal, `{ status, message }`.
///
/// Per family rather than shared with `session`'s, which is spelled the same:
/// `contracts/mod.rs` places a contract by the family its id names, and a
/// cross-family type has no segment to look up. Two families refusing alike
/// therefore have two types, and that is the accepted cost of placement staying
/// a lookup.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRefusal {
    pub status: String,
    pub message: String,
}

/// `server.agent.list`'s reply: the list, or the refusal.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgentListReply {
    Listed(WebAgentsListResponse),
    Refused(AgentRefusal),
}

/// `server.agent.list`'s request: empty, and explicitly so — the call reads
/// nothing and is not permitted to have no request.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentListPayload {}

/// `server.agent.rename`'s reply: the renamed agent, or the refusal.
///
/// The agent half is [`WebAgentInfo`] — the same type `server.agent.list`
/// returns — and that is the point of adding it. This call built its own
/// `json!` block, twelve fields against the builder's thirteen, and had drifted
/// in exactly the two ways `agent_view`'s doc comment describes as fixed: no
/// `protocols`, and no `metadata.image_tag`.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRenameResponse {
    /// On **both** branches, so it is not what the untagged union discriminates
    /// on — `agent` against `error` is. Kept because the wire carries it.
    pub success: bool,
    pub agent: WebAgentInfo,
}

/// `server.agent.rename`'s request.
///
/// `display_name` is an `Option` because **`null` means clear**, which the arm
/// distinguishes from "not supplied" before normalising: an absent key leaves
/// the name alone, an explicit null clears it. Both arrive as `None` here, so
/// the distinction is the caller's to make — and the contract says the field is
/// nullable rather than inventing a sentinel for it.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRenamePayload {
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

/// Rename's refusal — `{ success, error }`, **not** [`AgentRefusal`].
///
/// `server.agent.list` refuses with `{status, message}` and `server.agent.rename`
/// refuses with `{success, error}`, in one family, one call apart. Fourth time
/// this has turned up: the convention is per handler, and a family is no guide
/// to which one a unit uses.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRenameFailure {
    pub success: bool,
    pub error: String,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgentRenameReply {
    /// Boxed, and the box is load-bearing: `WebAgentInfo` is far larger than
    /// `AgentRenameFailure`, and clippy's `large_enum_variant` is right to
    /// object. The alternative would be an `#[allow]`, which this tree does not
    /// take — the type is edited rather than the lint.
    Renamed(Box<AgentRenameResponse>),
    Refused(AgentRenameFailure),
}

/// Server → Agent response to `agent.register`.
///
/// On acceptance the server tells the agent which heartbeat interval to use,
/// so the cadence is configured centrally rather than per-agent.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
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
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerHeartbeatAckPayload {
    /// Echoes the agent id the heartbeat was for.
    pub agent_id: String,
    /// Server timestamp (unix seconds) when the heartbeat was processed.
    pub server_time: u64,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentHeartbeatPayload {
    pub agent_id: String,
    pub status: AgentStatus,
    pub session_count: u32,
    pub active_sessions: u32,
    pub metadata: HeartbeatMetadata,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Online,
    Offline,
    Degraded,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatMetadata {
    pub uptime_seconds: u64,
    pub load_average: [f64; 3],
    /// Agent version info — included in each heartbeat so the server
    /// stays current after agent upgrades (previously only sent on register).
    #[serde(default)]
    pub agent: Option<AgentMetadata>,
}

// --- Client → Server agent management payloads ---

/// `server.agent.delete` — permanently remove an offline agent and its sessions.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientAgentDeletePayload {
    pub agent_id: String,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientAgentDeleteResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Agent → Server: update advertised addresses after network change.
///
/// Sent when the agent detects a network interface change (WiFi switch,
/// VPN connect/disconnect, sleep/wake). The server replaces the agent's
/// address list and re-probes reachability.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentAddressUpdatePayload {
    pub agent_id: String,
    /// Raw un-finalised addresses from the agent (the server re-runs
    /// finalisation to keep priorities consistent across updates).
    pub addresses: Vec<AgentAddress>,
}

// --- The peer-to-peer projection (#678) ---

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebAgentInfo {
    pub agent_id: String,
    pub hostname: String,
    pub ip_address: String,
    pub port: u16,
    pub status: String,
    pub session_count: u32,
    pub last_heartbeat: String,
    // The six below were on the wire and not in this type. `agent_view.rs` is
    // the single builder both `server.agent.list` and the `agents.changed` push
    // go through — its own doc comment says why — and it has always sent these.
    //
    // The type was named right and shaped wrong, which is the fifth time in
    // this run: `SessionListResponse`, `SessionInfo`, `SessionCapturePreviewPayload`,
    // `WebSessionInfo`, and now this. Here it is visible at a glance by
    // counting: seven fields against the builder's thirteen.
    /// Human-readable name, set by config or a Web UI rename. The UI falls back
    /// to the hostname when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub active_sessions: u32,
    pub registered_at: String,
    /// The server's probe results, so the item type is `ProbedAddress` and not
    /// `AgentAddress` — the obvious guess, and the wrong one.
    pub addresses: Vec<ProbedAddress>,
    /// What this agent reported it can serve.
    ///
    /// **No `skip_serializing_if`**, deliberately, and `agent_view`'s own test
    /// (`a_peer_with_no_manifest_gets_null_and_not_a_missing_key`) fails if one
    /// is added. A consumer has to tell "no manifest for that peer" from "that
    /// peer advertises nothing", because they resolve differently — and an
    /// absent key cannot say which. Written with the attribute first, having
    /// quoted the rule in this very comment while adding it.
    #[serde(default)]
    pub protocols: Option<ProtocolManifest>,
    pub metadata: AgentMetadata,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebAgentsListResponse {
    pub agents: Vec<WebAgentInfo>,
}
