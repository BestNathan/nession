//! Static authentication for the Agent's peer-to-peer socket (#3440).
//!
//! One durable Agent Token gates the listener. There is no per-attach grant,
//! no expiry and no scope: a client that holds the token has the Agent's
//! trusted surface, which is the explicit 0.x tradeoff in #3440. The verifier
//! is still endpoint-owned — the Server Token never opens this socket — and the
//! authenticated context is established once per connection, before any
//! business frame, and never re-derived afterwards.

use nession_common::TokenVerifier;

/// What one authenticated connection proved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthContext {
    /// The client identity named by `client.auth`. A connection has exactly one
    /// identity for its life; a repeated authentication never replaces it.
    pub client_id: String,
}

/// What a peer-to-peer wire needs from the connection.
///
/// Declared beside each arm in `p2p_routes!`, so a new arm cannot arrive with an
/// implicit "everything is allowed". Pre-auth is exactly the authentication
/// frame; everything else requires an authenticated connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum P2pAccess {
    /// The wire may be sent before authentication: `client.auth` only.
    PreAuth,
    /// The wire requires a successfully authenticated connection.
    Authenticated,
}

/// The endpoint-owned verifier for inbound Agent connections.
#[derive(Debug, Clone)]
pub struct P2pAuth {
    verifier: TokenVerifier,
}

impl P2pAuth {
    pub fn new(token: impl Into<String>) -> Self {
        Self {
            verifier: TokenVerifier::new(token),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.verifier.is_enabled()
    }

    pub fn verify(&self, presented: &str) -> bool {
        self.verifier.verify(presented)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_configured_token_authenticates() {
        let auth = P2pAuth::new("agent-a-token");
        assert!(auth.verify("agent-a-token"));
        assert!(!auth.verify("agent-b-token"));
        assert!(!auth.verify(""));
        assert!(!P2pAuth::new("").verify(""));
        assert!(!P2pAuth::new("").verify("anything"));
    }
}
