use serde::{Deserialize, Serialize};

use crate::logging::LoggingConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub listen_address: String,
    pub tls_cert_path: String,
    pub tls_key_path: String,
    pub auth_token: String,
    /// Interval at which agents should send heartbeats, in seconds.
    /// Sent to each agent in the registration response so the cadence is
    /// configured centrally.
    #[serde(default = "default_heartbeat_interval")]
    pub heartbeat_interval_secs: u64,
    #[serde(default = "default_heartbeat_timeout")]
    pub heartbeat_timeout_secs: u64,
    #[serde(default = "default_db_path")]
    pub db_path: String,
    /// How long a relayed terminal frame may wait for room in a client's
    /// outbound queue before the Server gives up on that client (#961).
    ///
    /// A connection's outbound queue holds its bound before its producers wait,
    /// so this is a floor on the rate a client has to drain to stay attached:
    /// the effective bound divided by this, which for terminal-sized frames is
    /// the frame count rather than the byte budget. It is a policy knob rather
    /// than a tuning one — the arithmetic behind the default is in
    /// `server::outbound`.
    #[serde(default = "default_terminal_stall_grace")]
    pub terminal_stall_grace_secs: u64,
    /// How many queries one client connection may have in flight at once
    /// (#961-C).
    ///
    /// The bound on the connection's query lane: read-only units run on their
    /// own tasks so a query waiting on an agent does not hold the connection's
    /// other frames behind it, and this is what keeps that from being one task
    /// per message. Reaching it stops the connection from being *read* until a
    /// query finishes, so the bound is also the backpressure. See
    /// `nession_server::server::execution`.
    #[serde(default = "default_query_concurrency")]
    pub query_concurrency_per_connection: usize,
    /// How long a P2P credential stays valid after it is minted (#1013).
    ///
    /// A credential authorizes a direct Client → Agent connection, and it is
    /// validated by the **Agent** — the Server mints and forgets, the Agent
    /// honours it until this deadline passes. So this is the revocation
    /// window: it bounds how long a credential that leaked (a token in a URL
    /// reaches access logs) stays useful, and it is the only expiry the
    /// boundary has. Shorter is safer and costs the user nothing, because a
    /// client that needs a new one re-attaches and gets one.
    ///
    /// Five minutes, which is long enough for a slow first paint and for the
    /// reconnect budget a browser uses after a dropped socket, and short enough
    /// that a leaked token is stale by the time anyone notices it leaked.
    #[serde(default = "default_p2p_token_expiry")]
    pub p2p_token_expiry_secs: u64,
    /// Logging configuration (optional). When omitted, defaults to
    /// `level = "info"`, `rotation = "daily"`, `retention_days = 7`.
    #[serde(default)]
    pub logging: LoggingConfig,
}

/// The default for [`ServerConfig::terminal_stall_grace_secs`], published so the
/// outbound queue's own default cannot drift from the config's.
pub const DEFAULT_TERMINAL_STALL_GRACE_SECS: u64 = 15;

/// The default for [`ServerConfig::p2p_token_expiry_secs`], published so a
/// test that needs a credential to be *expired* can derive one rather than
/// hard-code a number that would silently stop testing expiry if the default
/// moved.
pub const DEFAULT_P2P_TOKEN_EXPIRY_SECS: u64 = 300;

/// The default for [`ServerConfig::query_concurrency_per_connection`], published
/// for the same reason: the query lane's own default is this number.
///
/// Eight is a policy number, not a tuned one. A connection's queries are the
/// read-only units a browser asks for — a session list, a capture preview, an
/// env read — and they are mostly *waiting* on an agent, so the lane is about
/// how many of those may be outstanding before the Server would rather stop
/// reading the connection than open another task for it. Large enough that a
/// UI asking for several things at once is never the reason it stalls, small
/// enough that a connection which never gets answered costs eight tasks and not
/// the machine.
pub const DEFAULT_QUERY_CONCURRENCY_PER_CONNECTION: usize = 8;

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            listen_address: "0.0.0.0:19090".to_string(),
            tls_cert_path: String::new(),
            tls_key_path: String::new(),
            auth_token: String::new(),
            heartbeat_interval_secs: default_heartbeat_interval(),
            heartbeat_timeout_secs: default_heartbeat_timeout(),
            db_path: default_db_path(),
            terminal_stall_grace_secs: default_terminal_stall_grace(),
            query_concurrency_per_connection: default_query_concurrency(),
            p2p_token_expiry_secs: default_p2p_token_expiry(),
            logging: LoggingConfig::default(),
        }
    }
}

fn default_terminal_stall_grace() -> u64 {
    DEFAULT_TERMINAL_STALL_GRACE_SECS
}

fn default_query_concurrency() -> usize {
    DEFAULT_QUERY_CONCURRENCY_PER_CONNECTION
}

fn default_p2p_token_expiry() -> u64 {
    DEFAULT_P2P_TOKEN_EXPIRY_SECS
}

fn default_heartbeat_interval() -> u64 {
    10
}

fn default_heartbeat_timeout() -> u64 {
    30
}

fn default_db_path() -> String {
    crate::paths::server_db_path()
        .unwrap_or_else(|_| std::path::PathBuf::from("nession.db"))
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_server_config_default() {
        let config = ServerConfig::default();
        assert_eq!(config.listen_address, "0.0.0.0:19090");
        assert_eq!(config.tls_cert_path, "");
        assert_eq!(config.tls_key_path, "");
        assert_eq!(config.auth_token, "");
        assert_eq!(config.heartbeat_interval_secs, 10);
        assert_eq!(config.heartbeat_timeout_secs, 30);
        assert!(!config.db_path.is_empty());
    }

    #[test]
    fn test_server_config_serde() {
        let config = ServerConfig::default();
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: ServerConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.listen_address, "0.0.0.0:19090");
        assert_eq!(deserialized.heartbeat_interval_secs, 10);
    }

    #[test]
    fn test_server_config_custom_values() {
        let config = ServerConfig {
            listen_address: "127.0.0.1:9090".to_string(),
            tls_cert_path: "/path/to/cert".to_string(),
            tls_key_path: "/path/to/key".to_string(),
            auth_token: "secret".to_string(),
            heartbeat_interval_secs: 20,
            heartbeat_timeout_secs: 60,
            db_path: "/tmp/test.db".to_string(),
            ..Default::default()
        };
        assert_eq!(config.listen_address, "127.0.0.1:9090");
        assert_eq!(config.heartbeat_interval_secs, 20);
    }

    #[test]
    fn test_default_functions() {
        assert_eq!(default_heartbeat_interval(), 10);
        assert_eq!(default_heartbeat_timeout(), 30);
        assert!(!default_db_path().is_empty());
    }

    #[test]
    fn test_server_config_parsing() {
        let toml_str = r#"
            listen_address = "0.0.0.0:8443"
            tls_cert_path = "/path/to/cert.pem"
            tls_key_path = "/path/to/key.pem"
            auth_token = "secret_token_123"
            heartbeat_timeout_secs = 30
            db_path = "./nession-server.db"
        "#;

        let config: ServerConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.listen_address, "0.0.0.0:8443");
        assert_eq!(config.heartbeat_timeout_secs, 30);
        assert_eq!(config.db_path, "./nession-server.db");
    }

    #[test]
    fn test_server_config_defaults() {
        let toml_str = r#"
            listen_address = "0.0.0.0:8443"
            tls_cert_path = "/path/to/cert.pem"
            tls_key_path = "/path/to/key.pem"
            auth_token = "secret_token_123"
        "#;

        let config: ServerConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.heartbeat_timeout_secs, 30); // default
        assert_eq!(
            config.db_path,
            crate::paths::server_db_path()
                .expect("home dir required for test")
                .to_string_lossy()
                .into_owned()
        ); // default

        // A config file written before the query lane existed still describes a
        // connection that runs one (#961-C): the field has to default, not fail.
        assert_eq!(
            config.query_concurrency_per_connection,
            DEFAULT_QUERY_CONCURRENCY_PER_CONNECTION
        );
    }
}
