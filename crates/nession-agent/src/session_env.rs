//! The Agent's half of the Session environment boundary (#4080).
//!
//! [`SessionEnvironment`] is declared by `nession-common` because providers
//! need it. This is the only implementation that can answer: the Agent owns
//! the Session's Environment Binding (`crate::tmux::env::EnvManager`) and the
//! tmux Session the binding was materialized into.
//!
//! The Session id is normalised with [`extract_session_name`] — the same
//! function the Git workdir resolver and the Claude session context use — so a
//! request naming `agent:name` resolves the environment of the same Session
//! those capabilities resolve the repository and conversation for.

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use nession_common::session_env::{SessionEnvironment, SessionEnvironmentError};

use crate::server::websocket::extract_session_name;
use crate::tmux::manager::SessionManager;

/// Answers Session environment questions from the Agent's own binding state.
pub struct AgentSessionEnvironment {
    tmux: Arc<SessionManager>,
}

impl AgentSessionEnvironment {
    pub fn new(tmux: Arc<SessionManager>) -> Self {
        Self { tmux }
    }
}

#[async_trait]
impl SessionEnvironment for AgentSessionEnvironment {
    async fn session_overrides(
        &self,
        session: &str,
        keys: Option<&[&str]>,
    ) -> Result<BTreeMap<String, String>, SessionEnvironmentError> {
        let name = extract_session_name(session);
        if name.is_empty() {
            return Err(SessionEnvironmentError::unavailable(
                "the request names no Session",
            ));
        }
        self.tmux
            .env()
            .session_overrides(&name, keys)
            .await
            .map_err(|error| {
                // `load_state` and the tmux read both produce bounded
                // diagnostics: the failing record/key and the session name,
                // never a value. The binding can hold secrets, so a value must
                // never be able to reach a provider response through here.
                SessionEnvironmentError::unavailable(format!(
                    "the Session environment could not be verified: {error:#}"
                ))
            })
    }

    fn agent_variable(&self, key: &str) -> Option<String> {
        // The Agent process environment is the inherited baseline for every
        // Session this Agent creates. An empty value is returned as-is; the
        // consumer decides whether empty means "no credential".
        std::env::var(key).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn environment() -> AgentSessionEnvironment {
        AgentSessionEnvironment::new(Arc::new(SessionManager::new()))
    }

    #[tokio::test]
    async fn an_id_with_no_session_name_is_not_a_verified_answer() {
        let error = environment()
            .session_overrides("", None)
            .await
            .expect_err("an empty id must not resolve to some Session");
        assert!(error.message().contains("no Session"));
    }

    #[tokio::test]
    async fn a_session_with_no_recorded_binding_overrides_nothing() {
        // `SessionManager::new` has an empty state directory, so the record is
        // verified absent — an answer, not a failure.
        let overrides = environment()
            .session_overrides("agent:unrecorded", None)
            .await
            .expect("no record is a verified answer");
        assert!(overrides.is_empty());
    }

    #[tokio::test]
    async fn the_agent_baseline_is_the_process_environment() {
        let environment = environment();
        // Read-only assertions: other tests in this binary run concurrently,
        // and no test may mutate the process environment under them.
        assert_eq!(environment.agent_variable("NESSON_4080_UNSET_PROBE"), None);
        let path = std::env::var("PATH").ok();
        assert!(path.is_some(), "the test process has a PATH");
        assert_eq!(environment.agent_variable("PATH"), path);
    }
}
