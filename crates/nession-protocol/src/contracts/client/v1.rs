use serde::{Deserialize, Serialize};

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientAuthPayload {
    #[serde(default)]
    pub auth_token: String,
    #[serde(default)]
    pub client_id: Option<String>,
}

/// The answer to `server.auth` and `client.auth` — one handshake, two ends.
///
/// `client_id` is an `Option` because **most branches that build this type have
/// no client id to put in it**, and a required field was being satisfied by a
/// placeholder rather than by a value:
///
/// | builder | `client_id` it sent |
/// |---|---|
/// | `client.auth` success arm (`websocket.rs`) | a real id |
/// | `client.auth` invalid-payload arm (same match) | `String::new()` |
/// | `server.auth`, both arms (`handle_client_auth`) | no key at all |
///
/// The empty string is the tell: it says "absent" in the only dialect a
/// required field allows. Relaxed rather than removed, because `client.auth`'s
/// success branch genuinely has one.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthResponsePayload {
    pub status: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
}
