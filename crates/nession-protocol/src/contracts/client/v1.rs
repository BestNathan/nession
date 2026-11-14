use serde::{Deserialize, Serialize};

use crate::RedactedToken;

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientAuthPayload {
    /// The endpoint-owned token presented to whichever endpoint answers.
    ///
    /// `server.auth` compares it with the Server Token. `client.auth` compares
    /// it with that Agent's durable Agent Token (#3440) before any business
    /// frame is accepted. The two values are different secrets: the Server
    /// Token never authenticates to an Agent, and an Agent Token never
    /// authenticates to the Server.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(type = "string"))]
    #[cfg_attr(feature = "codegen", schemars(with = "String"))]
    pub auth_token: RedactedToken,
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
