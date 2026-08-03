//! Agent configuration.

use nession_common::logging::LoggingConfig;
use nession_common::protocol::{AgentAddress, NetworkType};
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

/// Default working directory for new tmux sessions.
/// When not set, defaults to $HOME.
fn default_working_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
}

/// A config-declared advertised address (tunnel/ingress/custom endpoint).
///
/// These are merged with the addresses the agent auto-detects from its network
/// interfaces. Declared explicitly in the TOML config because tunnels can't be
/// discovered from local interfaces (Non-Goal: tunnel process discovery).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdvertiseAddress {
    /// Complete WebSocket URL, e.g. `wss://agent.example.com/ws`.
    pub url: String,
    /// Optional human-readable label for the UI.
    #[serde(default)]
    pub label: Option<String>,
    /// Network category; defaults to `tunnel` since config-declared addresses
    /// are typically ingress/tunnel endpoints.
    #[serde(default = "default_network_type")]
    pub network_type: NetworkType,
    /// Optional explicit priority (lower connects first). When 0/omitted the
    /// server fills in the network-type default.
    #[serde(default)]
    pub priority: i32,
}

fn default_network_type() -> NetworkType {
    NetworkType::Tunnel
}

impl AdvertiseAddress {
    /// Convert to the protocol wire type.
    #[must_use]
    pub fn into_agent_address(self) -> AgentAddress {
        AgentAddress {
            url: self.url,
            label: self.label,
            network_type: self.network_type,
            priority: self.priority,
        }
    }
}

/// How the agent attaches to tmux sessions.
///
/// - `plain`: Spawn `tmux attach` under a real PTY.  tmux handles resize,
///   redraw, and multi-client natively.  One PTY shared per session.
/// - `control`: Use `tmux -C attach` (control mode).  Per-client sessions
///   with structured message parsing.  Preserved for backward compatibility.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachMode {
    #[default]
    Plain,
    Control,
}

/// Agent configuration loaded from a TOML file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Unique identifier for this agent.
    pub agent_id: String,
    /// Human-readable display name shown in the web UI.
    /// When absent the UI falls back to the machine hostname.
    #[serde(default)]
    pub display_name: Option<String>,
    /// Central server WebSocket URL (e.g., "ws://localhost:8443").
    pub server_url: String,
    /// Authentication token for the central server.
    pub auth_token: String,
    /// How the agent attaches to tmux sessions.  Default: "plain".
    #[serde(default)]
    pub attach_mode: AttachMode,
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
    /// Address advertised to clients for P2P connections (optional, legacy).
    /// If not set, the agent auto-detects its IP. Useful for NAT/VPN setups.
    /// Superseded by `advertise_addresses`; kept for backward compatibility.
    #[serde(default)]
    pub advertise_address: Option<String>,
    /// Public WebSocket URL that clients use to connect to this agent (legacy).
    /// Must be a complete URL including protocol and `/ws` path
    /// (e.g. "wss://agent.nession.nhome.local/ws").
    /// When set, the server returns this URL verbatim to clients during session
    /// attach instead of constructing one from the agent's IP and port.
    /// Superseded by `advertise_addresses`; kept for backward compatibility.
    #[serde(default)]
    pub connect_url: Option<String>,
    /// Explicitly declared advertised endpoints (tunnels, ingress, custom).
    /// Merged with auto-detected NIC addresses, de-duplicated by URL. Prefer
    /// this over `advertise_address`/`connect_url` for multi-path setups.
    #[serde(default)]
    pub advertise_addresses: Vec<AdvertiseAddress>,
    /// Skip auto-detecting local network interfaces. When true, only
    /// `advertise_addresses` (and legacy fields) are advertised. Useful when
    /// the node's only reachable path is a tunnel and LAN IPs would mislead.
    #[serde(default)]
    pub disable_address_autodetect: bool,

    /// Default working directory for new tmux sessions.
    /// When not set, defaults to $HOME.
    #[serde(default = "default_working_dir")]
    pub default_working_dir: String,

    /// Root directory for file operations via the P2P WebSocket.
    /// When not set, defaults to `default_working_dir`.
    /// File operations are restricted to paths within this directory.
    #[serde(default)]
    pub file_root: Option<String>,

    /// Logging configuration (optional). When omitted, defaults to
    /// `level = "info"`, `rotation = "daily"`, `retention_days = 7`.
    #[serde(default)]
    pub logging: LoggingConfig,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            agent_id: format!("agent-{}", uuid::Uuid::new_v4()),
            display_name: None,
            server_url: "ws://localhost:8443".to_string(),
            auth_token: String::new(),
            attach_mode: AttachMode::Plain,
            listen_address: default_listen_address(),
            tls_cert_path: None,
            tls_key_path: None,
            heartbeat_interval_secs: default_heartbeat_interval(),
            session_poll_interval_secs: default_session_poll_interval(),
            advertise_address: None,
            connect_url: None,
            advertise_addresses: Vec::new(),
            disable_address_autodetect: false,
            default_working_dir: default_working_dir(),
            file_root: None,
            logging: LoggingConfig::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_listen_address() {
        assert_eq!(default_listen_address(), "0.0.0.0:8080");
    }

    #[test]
    fn test_default_heartbeat_interval() {
        assert_eq!(default_heartbeat_interval(), 10);
    }

    #[test]
    fn test_default_session_poll_interval() {
        assert_eq!(default_session_poll_interval(), 5);
    }

    #[test]
    fn test_default_working_dir() {
        let dir = default_working_dir();
        // Either HOME or "/"
        assert!(!dir.is_empty());
    }

    #[test]
    fn test_default_network_type() {
        assert_eq!(default_network_type(), NetworkType::Tunnel);
    }

    #[test]
    fn test_agent_config_default() {
        let config = AgentConfig::default();
        assert!(config.agent_id.starts_with("agent-"));
        assert_eq!(config.server_url, "ws://localhost:8443");
        assert_eq!(config.listen_address, "0.0.0.0:8080");
        assert_eq!(config.heartbeat_interval_secs, 10);
        assert_eq!(config.session_poll_interval_secs, 5);
        assert!(config.tls_cert_path.is_none());
        assert!(config.tls_key_path.is_none());
        assert!(config.advertise_address.is_none());
        assert!(config.connect_url.is_none());
        assert!(config.advertise_addresses.is_empty());
        assert!(!config.disable_address_autodetect);
        assert!(config.file_root.is_none());
        assert!(config.display_name.is_none());
    }

    #[test]
    fn test_advertise_address_into_agent_address() {
        let advertise = AdvertiseAddress {
            url: "wss://example.com/ws".to_string(),
            label: Some("test".to_string()),
            network_type: NetworkType::Tunnel,
            priority: 5,
        };
        let agent_addr = advertise.into_agent_address();
        assert_eq!(agent_addr.url, "wss://example.com/ws");
        assert_eq!(agent_addr.label, Some("test".to_string()));
        assert_eq!(agent_addr.network_type, NetworkType::Tunnel);
        assert_eq!(agent_addr.priority, 5);
    }

    #[test]
    fn test_advertise_address_defaults() {
        let toml_str = r#"url = "wss://example.com/ws""#;
        let advertise: AdvertiseAddress = toml::from_str(toml_str).unwrap();
        assert_eq!(advertise.url, "wss://example.com/ws");
        assert!(advertise.label.is_none());
        assert_eq!(advertise.network_type, NetworkType::Tunnel);
        assert_eq!(advertise.priority, 0);
    }

    #[test]
    fn test_agent_config_serde_minimal() {
        let toml_str = r#"
            agent_id = "test-agent"
            server_url = "ws://localhost:9090"
            auth_token = "token123"
        "#;
        let config: AgentConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.agent_id, "test-agent");
        assert_eq!(config.server_url, "ws://localhost:9090");
        assert_eq!(config.auth_token, "token123");
        assert_eq!(config.listen_address, "0.0.0.0:8080");
    }

    #[test]
    fn test_attach_mode_default_is_plain() {
        let config: AgentConfig = toml::from_str(
            r#"
            agent_id = "test"
            server_url = "ws://localhost:8443"
            auth_token = "tok"
            "#,
        )
        .unwrap();
        assert!(matches!(config.attach_mode, AttachMode::Plain));
    }

    #[test]
    fn test_attach_mode_control() {
        let config: AgentConfig = toml::from_str(
            r#"
            agent_id = "test"
            server_url = "ws://localhost:8443"
            auth_token = "tok"
            attach_mode = "control"
            "#,
        )
        .unwrap();
        assert!(matches!(config.attach_mode, AttachMode::Control));
    }

    #[test]
    fn test_display_name_from_config() {
        let config: AgentConfig = toml::from_str(
            r#"
            agent_id = "test"
            server_url = "ws://localhost:8443"
            auth_token = "tok"
            display_name = "🏠 家庭服务器"
            "#,
        )
        .unwrap();
        assert_eq!(config.display_name, Some("🏠 家庭服务器".to_string()));
    }

    #[test]
    fn test_display_name_absent() {
        let config: AgentConfig = toml::from_str(
            r#"
            agent_id = "test"
            server_url = "ws://localhost:8443"
            auth_token = "tok"
            "#,
        )
        .unwrap();
        assert!(config.display_name.is_none());
    }
}
