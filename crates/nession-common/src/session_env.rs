//! Session-first environment resolution for Session-addressed operations
//! (#4080).
//!
//! A Nession Session runs on its Agent's runtime: the Agent's environment is
//! the legitimate inherited baseline, and the Session's Environment Binding
//! overlays explicitly selected values. A provider serving a request that
//! names a Session must resolve the values for *that* Session rather than
//! freezing the Agent's process environment when it is composed:
//!
//! ```text
//! explicit Session override  →  inherited Agent value  →  absent
//! ```
//!
//! ## Why this returns overrides, not the effective tmux environment
//!
//! The tmux Session environment is the *effective* result: it contains the
//! explicit overlay **and** every value the Session inherited from the Agent.
//! Reading it as though its keys were Session-scoped would invert precedence
//! for credential aliases — a Session that overrides only `GH_TOKEN` also
//! inherits an Agent `GITHUB_TOKEN`, and a naive lookup would prefer that
//! inherited value over the Session's explicit one.
//!
//! [`SessionEnvironment::session_overrides`] therefore returns only the keys
//! the binding explicitly manages (materialized and observed in tmux). A key
//! that is merely inherited is absent from the map on purpose: providers
//! place every Session candidate ahead of every Agent candidate and let
//! absence mean "not overridden".
//!
//! ## A failed lookup is not "no override"
//!
//! An unreadable binding record or a refused tmux read is returned as
//! [`SessionEnvironmentError`], never collapsed into an empty map. A provider
//! that treated "cannot verify" as "nothing overridden" would silently fall
//! back to an Agent credential the Session explicitly replaced.

use std::collections::BTreeMap;
use std::fmt;

use async_trait::async_trait;

/// How a provider asks its host for the Session's explicit environment.
///
/// Implemented by the Agent host, which owns both the Environment Binding and
/// its tmux materialization. Object-safe and injected as
/// `Arc<dyn SessionEnvironment>` so a provider can be tested against a fake
/// Session that does not exist on this host.
#[async_trait]
pub trait SessionEnvironment: Send + Sync {
    /// The explicit overrides materialized for `session`.
    ///
    /// `keys: Some([...])` restricts the answer to those names; `None` asks
    /// for every key the binding manages. A key is present only when the
    /// binding manages it **and** tmux currently holds a materialized value
    /// for it. An absent key is not an override — the Agent's inherited value
    /// applies — and an empty map is a verified "this Session overrides
    /// nothing" answer.
    ///
    /// `Err` means the Session's environment could not be verified. Callers
    /// must report that explicitly; it is **not** equivalent to an empty map.
    async fn session_overrides(
        &self,
        session: &str,
        keys: Option<&[&str]>,
    ) -> Result<BTreeMap<String, String>, SessionEnvironmentError>;

    /// The Agent's own environment value, the fallback for a key the Session
    /// does not override.
    ///
    /// This is the same process environment the Agent passes into a new
    /// Session, so it is the baseline an inherited key would have. An empty
    /// value is returned as-is; providers that treat empty as absent (a
    /// credential, for example) normalise it themselves.
    fn agent_variable(&self, key: &str) -> Option<String>;
}

/// The Session's environment could not be verified.
///
/// The message names what could not be read. It never contains an
/// environment value: the binding can hold secrets, and this error travels
/// into provider responses and logs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionEnvironmentError {
    message: String,
}

impl SessionEnvironmentError {
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    /// The bounded, value-free explanation.
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for SessionEnvironmentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for SessionEnvironmentError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unavailable_error_keeps_its_bounded_message() {
        let error = SessionEnvironmentError::unavailable("cannot read the binding for session s");
        assert_eq!(error.message(), "cannot read the binding for session s");
        assert_eq!(error.to_string(), "cannot read the binding for session s");
    }
}
