//! The effective GitHub credential for one Session-addressed request (#4080).
//!
//! ## Scope precedence precedes alias precedence
//!
//! ```text
//! Session.GITHUB_TOKEN
//! Session.GH_TOKEN
//! Agent.GITHUB_TOKEN
//! Agent.GH_TOKEN
//! otherwise: not_authenticated
//! ```
//!
//! Reading the Session's *effective* tmux environment for `GITHUB_TOKEN`
//! would invert this: a Session that overrides only `GH_TOKEN` still inherits
//! an Agent `GITHUB_TOKEN`, so that inherited value would outrank the
//! Session's explicit alias. [`SessionEnvironment`] returns explicit overrides
//! only, which is why both Session keys are consulted before either Agent key.
//!
//! An explicitly bound Session value always decides — including an empty one.
//! Falling through to another alias or to the Agent would select a different
//! credential than the one the Session bound, which is exactly the
//! unpredictability the binding semantics forbid.

use std::collections::BTreeMap;

use nession_common::session_env::SessionEnvironment;

/// The aliases GitHub clients accept, in precedence order.
const CREDENTIAL_ALIASES: [&str; 2] = ["GITHUB_TOKEN", "GH_TOKEN"];

/// Resolve the token a Session-addressed request authenticates with.
///
/// `overrides` is the explicit Session half from
/// [`SessionEnvironment::session_overrides`]; `environment` supplies the Agent
/// fallback. The result never contains a diagnostic or cache-visible form of
/// the token — callers fingerprint it through `GithubClient`.
pub(crate) fn effective_token(
    overrides: &BTreeMap<String, String>,
    environment: &dyn SessionEnvironment,
) -> Option<String> {
    if let Some(value) = CREDENTIAL_ALIASES
        .iter()
        .find_map(|alias| overrides.get(*alias))
    {
        // Explicit Session scope wins even when the bound value is empty: the
        // Session said "this is the value", and falling through would pick a
        // credential it did not.
        return normalize(value);
    }
    CREDENTIAL_ALIASES
        .iter()
        .find_map(|alias| environment.agent_variable(alias))
        .and_then(|value| normalize(&value))
}

/// A token value is trimmed; an empty value is no credential.
fn normalize(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use nession_common::session_env::SessionEnvironmentError;

    #[derive(Default)]
    struct FakeEnvironment {
        agent: BTreeMap<String, String>,
    }

    impl FakeEnvironment {
        fn agent(pairs: &[(&str, &str)]) -> Self {
            Self {
                agent: pairs
                    .iter()
                    .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                    .collect(),
            }
        }
    }

    #[async_trait]
    impl SessionEnvironment for FakeEnvironment {
        async fn session_overrides(
            &self,
            _session: &str,
            _keys: Option<&[&str]>,
        ) -> Result<BTreeMap<String, String>, SessionEnvironmentError> {
            Ok(BTreeMap::new())
        }

        fn agent_variable(&self, key: &str) -> Option<String> {
            self.agent.get(key).cloned()
        }
    }

    fn overrides(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn session_scope_precedes_every_agent_key() {
        let agent = FakeEnvironment::agent(&[
            ("GITHUB_TOKEN", "agent-primary"),
            ("GH_TOKEN", "agent-secondary"),
        ]);
        assert_eq!(
            effective_token(&overrides(&[("GH_TOKEN", "session-secondary")]), &agent),
            Some("session-secondary".to_string()),
            "a Session alias must outrank an inherited Agent primary"
        );
        assert_eq!(
            effective_token(
                &overrides(&[
                    ("GITHUB_TOKEN", "session-primary"),
                    ("GH_TOKEN", "session-secondary"),
                ]),
                &agent
            ),
            Some("session-primary".to_string()),
            "the Session primary outranks the Session alias"
        );
    }

    #[test]
    fn agent_keys_follow_their_own_alias_order_when_no_session_override_exists() {
        let agent = FakeEnvironment::agent(&[
            ("GITHUB_TOKEN", "agent-primary"),
            ("GH_TOKEN", "agent-secondary"),
        ]);
        assert_eq!(
            effective_token(&BTreeMap::new(), &agent),
            Some("agent-primary".to_string())
        );
        let secondary = FakeEnvironment::agent(&[("GH_TOKEN", "agent-secondary")]);
        assert_eq!(
            effective_token(&BTreeMap::new(), &secondary),
            Some("agent-secondary".to_string())
        );
        assert_eq!(
            effective_token(&BTreeMap::new(), &FakeEnvironment::default()),
            None
        );
    }

    #[test]
    fn an_explicit_empty_session_value_is_not_authenticated_and_does_not_fall_through() {
        let agent = FakeEnvironment::agent(&[
            ("GITHUB_TOKEN", "agent-primary"),
            ("GH_TOKEN", "agent-secondary"),
        ]);
        assert_eq!(
            effective_token(
                &overrides(&[("GITHUB_TOKEN", "   "), ("GH_TOKEN", "session-secondary")]),
                &agent
            ),
            None,
            "an explicitly empty Session primary decides: no credential, no fallback"
        );
    }

    #[test]
    fn values_are_trimmed_and_never_exposed_as_part_of_the_decision() {
        let agent = FakeEnvironment::agent(&[("GITHUB_TOKEN", "  agent-primary  ")]);
        assert_eq!(
            effective_token(&overrides(&[("GITHUB_TOKEN", " session-token ")]), &agent),
            Some("session-token".to_string())
        );
        assert_eq!(
            effective_token(&BTreeMap::new(), &agent),
            Some("agent-primary".to_string())
        );
    }
}
