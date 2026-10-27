use serde::{Deserialize, Serialize};

use crate::contracts::default_image_tag;

/// ISO 8601 build timestamp, absent when the binary was not built with one.
pub(crate) fn default_build_time() -> String {
    "unknown".to_string()
}

// --- Server info ---

/// Request payload for `server.info` — empty (protocol marker).
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerInfoRequest {}

/// Response payload for `server.info`.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
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
    /// What this server serves (`#678`).
    ///
    /// The Server is a provider like any other, and until this field existed it
    /// was the one peer whose offer was invisible: an agent advertised a
    /// manifest, the web resolved against it, and the server brokering both
    /// said nothing about itself.
    ///
    /// It travels here rather than in a message of its own because
    /// `server.info` is already the call a client makes to ask what this
    /// server is — one field on an existing round trip, not a new one.
    ///
    /// Optional for the same reason the agent's is: a server predating this
    /// field serves `null` rather than failing to parse, and a client reading it
    /// gets "this server did not say" rather than a decode error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_manifest: Option<crate::ProtocolManifest>,
    /// The fixed column count this Server selects for a new Session (#2487).
    ///
    /// A Web build compares its embedded value with this one. It is the
    /// Server's release configuration, not a claim about an existing Session —
    /// that width belongs to the Session's tmux pane and is stated by the
    /// Agent on attach.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_cols: Option<u16>,
    /// The Web maximum CSS font size mirrored for configuration introspection
    /// (#2487). The Server does not apply it to a PTY.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_web_font_size: Option<f64>,
}
