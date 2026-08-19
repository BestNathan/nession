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
    /// Logging configuration (optional). When omitted, defaults to
    /// `level = "info"`, `rotation = "daily"`, `retention_days = 7`.
    #[serde(default)]
    pub logging: LoggingConfig,
}

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
            logging: LoggingConfig::default(),
        }
    }
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
    }
}
