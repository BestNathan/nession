//! `nession_server_session_env_binding_set` — the Server's canonical binding
//! replacement.
//!
//! The complete ordered selection replaces the Session's binding; an empty
//! list clears it. `expected_revision` is mandatory here because the Server's
//! durable compare-and-swap is what keeps a model from silently overwriting a
//! concurrent Web or MCP writer.

use crate::error::ToolError;
use crate::tool::{parse_arguments, schema_for, ToolContext, ToolHandler};
use crate::tools::env_target::{canonical_session_id, env_file_ref, Source};
use async_trait::async_trait;
use nession_protocol::contracts::session::v1::ClientSessionEnvBindingSetPayload;
use serde::Deserialize;
use serde_json::{Map, Value};

/// The `nession_server_session_env_binding_set` Tool.
pub struct NessionServerSessionEnvBindingSet;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct ProfileArguments {
    name: String,
    #[serde(default)]
    source: Source,
    #[serde(default)]
    agent_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Arguments {
    session_id: String,
    expected_revision: u64,
    #[serde(default)]
    profiles: Vec<ProfileArguments>,
}

#[async_trait]
impl ToolHandler for NessionServerSessionEnvBindingSet {
    fn name(&self) -> &'static str {
        "nession_server_session_env_binding_set"
    }

    fn description(&self) -> &'static str {
        "Replace one live Session's complete ordered Environment Binding. `expected_revision` is the revision last read; a stale value is refused with revision_conflict and changes nothing, so re-read with get and retry. An empty `profiles` list clears the binding. Never returns ENV values."
    }

    fn input_schema(&self) -> Map<String, Value> {
        schema_for::<Arguments>()
    }

    async fn call(
        &self,
        context: &ToolContext,
        arguments: Map<String, Value>,
    ) -> Result<Value, ToolError> {
        let arguments: Arguments = parse_arguments(arguments)?;
        canonical_session_id(&arguments.session_id)?;
        let profiles = arguments
            .profiles
            .into_iter()
            .map(|profile| env_file_ref(profile.name, profile.source, profile.agent_id))
            .collect::<Result<Vec<_>, _>>()?;
        context
            .cluster
            .session_env_binding_set(ClientSessionEnvBindingSetPayload {
                session_id: arguments.session_id,
                profiles,
                expected_revision: Some(arguments.expected_revision),
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::{arguments, context, Recorded, Recording};
    use nession_protocol::contracts::env::v1::{EnvFileRef, EnvSource};
    use std::sync::Arc;

    #[test]
    fn schema_is_closed_and_requires_the_session_and_revision() {
        let schema = NessionServerSessionEnvBindingSet.input_schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false);
        let required = schema["required"].as_array().expect("required");
        assert!(required.contains(&serde_json::json!("session_id")));
        assert!(
            required.contains(&serde_json::json!("expected_revision")),
            "the compare-and-swap revision is mandatory for this Tool"
        );
    }

    #[tokio::test]
    async fn set_replaces_the_whole_ordered_selection() {
        let recorder = Arc::new(Recording::default());
        let reply = NessionServerSessionEnvBindingSet
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "session_id": "agent-a:dev",
                    "expected_revision": 3,
                    "profiles": [
                        { "name": "common.env" },
                        { "name": "dev.env", "source": "agent", "agent_id": "agent-a" }
                    ]
                })),
            )
            .await
            .expect("reply");
        assert_eq!(reply["success"], true);
        assert_eq!(
            recorder.calls(),
            vec![Recorded::BindingSet(
                "agent-a:dev".to_string(),
                3,
                vec![
                    EnvFileRef {
                        name: "common.env".to_string(),
                        source: EnvSource::Server,
                        agent_id: None,
                    },
                    EnvFileRef {
                        name: "dev.env".to_string(),
                        source: EnvSource::Agent,
                        agent_id: Some("agent-a".to_string()),
                    },
                ],
            )]
        );
    }

    #[tokio::test]
    async fn clearing_the_binding_is_an_explicit_empty_selection() {
        let recorder = Arc::new(Recording::default());
        let reply = NessionServerSessionEnvBindingSet
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "session_id": "agent-a:dev",
                    "expected_revision": 4,
                    "profiles": []
                })),
            )
            .await
            .expect("reply");
        assert_eq!(reply["success"], true);
        assert_eq!(
            recorder.calls(),
            vec![Recorded::BindingSet(
                "agent-a:dev".to_string(),
                4,
                Vec::new()
            )]
        );
    }

    #[tokio::test]
    async fn a_missing_revision_never_reaches_the_backend() {
        let recorder = Arc::new(Recording::default());
        let error = NessionServerSessionEnvBindingSet
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "session_id": "agent-a:dev",
                    "profiles": []
                })),
            )
            .await
            .expect_err("expected_revision is required");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn a_profile_without_its_agent_target_is_rejected() {
        let recorder = Arc::new(Recording::default());
        let error = NessionServerSessionEnvBindingSet
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "session_id": "agent-a:dev",
                    "expected_revision": 0,
                    "profiles": [{ "name": "dev.env", "source": "agent" }]
                })),
            )
            .await
            .expect_err("agent profile needs agent_id");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn a_server_profile_must_not_carry_an_agent_id() {
        let recorder = Arc::new(Recording::default());
        let error = NessionServerSessionEnvBindingSet
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "session_id": "agent-a:dev",
                    "expected_revision": 0,
                    "profiles": [{ "name": "dev.env", "agent_id": "agent-a" }]
                })),
            )
            .await
            .expect_err("server profile cannot name an agent");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }
}
