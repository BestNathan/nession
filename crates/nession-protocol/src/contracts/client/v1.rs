use serde::{Deserialize, Serialize};

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientAuthPayload {
    /// The token the **Server** compares against its own, on `server.auth`.
    ///
    /// Read, and read for real: `handle_client_auth` fails the handshake on a
    /// mismatch unless the Server is in no-auth mode (an empty configured
    /// token). The browser sends it — `useAppConnection`'s request carries
    /// `auth_token` — so it is the client half of the Server's authentication,
    /// not a leftover.
    ///
    /// **`#1013` planned to delete this field and that plan was wrong on both
    /// of its premises**, which are recorded here so the next reader does not
    /// re-derive them: the issue says the Web never sends it, and it does; and
    /// that it is a field no verifier reads, and the Server is the verifier.
    /// The Agent parses this same shape on `client.auth` and *does* ignore the
    /// value — but that is the Agent sharing one handshake type with the
    /// Server, which the type's own docs state as the point, not a field
    /// looking for a reader. Deleting it would remove client authentication.
    ///
    /// What is true of it, and worth stating: it is the **user's** long-lived
    /// token, unlike the P2P credential beside it in this family, which is
    /// minted per attach, scoped, and short-lived. The two are not
    /// interchangeable and a caller should not treat this one as a capability.
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
