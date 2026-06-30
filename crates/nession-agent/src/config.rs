//! Agent configuration.

use serde::{Deserialize, Serialize};

/// Default listen address for the agent WebSocket server.
fn default_listen_address() -> String {
    "0.0.0.0:8080".to_string()
}

/// Default heartbeat interval in seconds.
fn default_heartbeat_interval() -> u64 {
    10
}

/// Default session poll interval in seconds.
fn default_session_poll_interval() -> u64 {
    5
}

/// Agent configuration loaded from a TOML file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Unique identifier for this agent.
    pub agent_id: String,
    /// Central server WebSocket URL (e.g., "ws://localhost:8443").
    pub server_url: String,
    /// Authentication token for the central server.
    pub auth_token: String,
    /// Address for the agent WebSocket server to listen on.
    #[serde(default = "default_listen_address")]
    pub listen_address: String,
    /// Path to TLS certificate PEM file (optional).
    #[serde(default)]
    pub tls_cert_path: Option<String>,
    /// Path to TLS private key PEM file (optional).
    #[serde(default)]
    pub tls_key_path: Option<String>,
    /// Heartbeat interval in seconds.
    #[serde(default = "default_heartbeat_interval")]
    pub heartbeat_interval_secs: u64,
    /// Session poll interval in seconds.
    #[serde(default = "default_session_poll_interval")]
    pub session_poll_interval_secs: u64,
    /// Address advertised to clients for P2P connections (optional).
    /// If not set, the agent auto-detects its IP. Useful for NAT/VPN setups.
    #[serde(default)]
    pub advertise_address: Option<String>,
    /// Public WebSocket URL that clients use to connect to this agent
    /// (e.g. "wss://agent.nession.nhome.local/ws").
    /// When set, the server returns this URL to clients during session attach
    /// instead of constructing one from the agent's IP and port.
    #[serde(default)]
    pub connect_url: Option<String>,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            agent_id: format!("agent-{}", uuid::Uuid::new_v4()),
            server_url: "ws://localhost:8443".to_string(),
            auth_token: String::new(),
            listen_address: default_listen_address(),
            tls_cert_path: None,
            tls_key_path: None,
            heartbeat_interval_secs: default_heartbeat_interval(),
            session_poll_interval_secs: default_session_poll_interval(),
            advertise_address: None,
            connect_url: None,
        }
    }
}
