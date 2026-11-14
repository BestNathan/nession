//! Endpoint-owned static token verification.
//!
//! One verifier shape shared by the Server WebSocket, Agent registration, the
//! Agent P2P listener, embedded MCP and the image HTTP route. Each endpoint
//! constructs its own [`TokenVerifier`] from its own configured secret; the
//! verifier never falls back to another endpoint's token. A future JWT verifier
//! can replace the expected value behind the same `verify` call without moving
//! the transport contracts.
//!
//! `SecretString` keeps the configured value out of `Debug` output. It is not a
//! general secret manager: values still travel in memory and across the
//! authenticated channels that own them.

use std::fmt;

use serde::{Deserialize, Serialize};

/// A token carried in a wire payload.
///
/// Serializes as the raw string; `Debug` renders `<redacted>` so a payload that
/// reaches a structured log cannot leak it. Wire consumers that need the value
/// call [`RedactedToken::as_str`].
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RedactedToken(String);

impl RedactedToken {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for RedactedToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

impl From<String> for RedactedToken {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for RedactedToken {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

/// A configured secret whose `Debug` rendering never exposes the value.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Whether `presented` is exactly this secret, without an early exit.
    ///
    /// An empty expected value never matches: a verifier that has no secret is
    /// a misconfiguration, not an invitation.
    pub fn verify(&self, presented: &str) -> bool {
        !self.0.is_empty() && constant_time_eq(presented, &self.0)
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

impl From<String> for SecretString {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for SecretString {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

/// One endpoint's static verifier.
///
/// `enabled` is a separate fact from the expected value: the Server's empty
/// `auth_token` deliberately disables WebSocket authentication, while the
/// Agent's P2P listener refuses to start without a token. Keeping the two
/// questions apart stops one endpoint's "no auth" mode from being read as
/// another's authorization.
#[derive(Clone)]
pub struct TokenVerifier {
    expected: SecretString,
    enabled: bool,
}

impl TokenVerifier {
    pub fn new(expected: impl Into<String>) -> Self {
        let expected = SecretString::new(expected);
        let enabled = !expected.is_empty();
        Self { expected, enabled }
    }

    /// A verifier that refuses every presented token.
    pub fn disabled() -> Self {
        Self {
            expected: SecretString::new(String::new()),
            enabled: false,
        }
    }

    /// Whether this endpoint has an authentication step at all.
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn verify(&self, presented: &str) -> bool {
        self.enabled && self.expected.verify(presented)
    }

    pub fn expected(&self) -> &SecretString {
        &self.expected
    }

    pub fn matches(&self, other: &TokenVerifier) -> bool {
        self.expected == other.expected
    }
}

impl fmt::Debug for TokenVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TokenVerifier")
            .field("enabled", &self.enabled)
            .finish()
    }
}

/// Compare two token strings without an early exit on the first mismatch.
///
/// The length is folded into the same accumulator rather than returned early:
/// a caller must not learn a prefix match from timing.
pub fn constant_time_eq(presented: &str, expected: &str) -> bool {
    let presented = presented.as_bytes();
    let expected = expected.as_bytes();
    let mut difference = presented.len() ^ expected.len();
    let longest = presented.len().max(expected.len());
    for index in 0..longest {
        let left = presented.get(index).copied().unwrap_or(0);
        let right = expected.get(index).copied().unwrap_or(0);
        difference |= usize::from(left ^ right);
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_never_renders_in_debug() {
        let secret = SecretString::new("super-secret-token");
        let rendered = format!("{secret:?}");
        assert!(!rendered.contains("super-secret-token"));
        assert_eq!(rendered, "<redacted>");

        let verifier = TokenVerifier::new("super-secret-token");
        let rendered = format!("{verifier:?}");
        assert!(!rendered.contains("super-secret-token"));
    }

    #[test]
    fn verification_accepts_only_the_exact_value() {
        let verifier = TokenVerifier::new("agent-token-a");
        assert!(verifier.verify("agent-token-a"));
        assert!(!verifier.verify("agent-token-b"));
        assert!(!verifier.verify(""));
        assert!(!verifier.verify("agent-token-a "));
    }

    #[test]
    fn an_empty_verifier_refuses_everything() {
        let verifier = TokenVerifier::new("");
        assert!(!verifier.is_enabled());
        assert!(!verifier.verify(""));
        assert!(!verifier.verify("anything"));
        assert!(!TokenVerifier::disabled().verify(""));
    }

    #[test]
    fn constant_time_comparison_matches_string_equality() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
        assert!(!constant_time_eq("", "a"));
        assert!(constant_time_eq("", ""));
    }
}
