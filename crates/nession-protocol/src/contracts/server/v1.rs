use serde::{Deserialize, Serialize};

use crate::contracts::default_image_tag;

/// ISO 8601 build timestamp, absent when the binary was not built with one.
pub(crate) fn default_build_time() -> String {
    "unknown".to_string()
}

// --- Server info ---

/// Request payload for `client.server.info` — empty (protocol marker).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerInfoRequest {}

/// Response payload for `client.server.info`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerInfoResponse {
    pub version: String,
    #[serde(default = "default_image_tag")]
    pub image_tag: String,
    pub uptime_seconds: u64,
    pub agent_count: usize,
    pub online_agent_count: usize,
    pub session_count: usize,
    /// ISO 8601 timestamp when the binary was built (injected via BUILD_TIME env var at compile time).
    #[serde(default = "default_build_time")]
    pub build_time: String,
}
