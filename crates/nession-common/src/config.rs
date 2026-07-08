use serde::{Deserialize, Serialize};

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
