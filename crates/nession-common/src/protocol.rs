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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMetadata {
    pub tmux_version: String,
    pub os_version: String,
    pub nession_version: String,
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
