//! `nession_server_session_env_binding_reapply` — re-resolve a Session's
//! currently bound profiles at a new revision.
//!
//! Saving an ENV file never changes a running Session; this explicit operation
//! is the only ordinary path that applies a profile edit. `expected_revision`
//! is mandatory for the same reason as `set`: a stale caller must re-read
//! instead of overwriting a concurrent writer.

use crate::error::ToolError;
use crate::tool::{parse_arguments, schema_for, ToolContext, ToolHandler};
use crate::tools::env_target::canonical_session_id;
use async_trait::async_trait;
use nession_protocol::contracts::session::v1::ClientSessionEnvBindingReapplyPayload;
use serde::Deserialize;
use serde_json::{Map, Value};

/// The `nession_server_session_env_binding_reapply` Tool.
pub struct NessionServerSessionEnvBindingReapply;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Arguments {
    session_id: String,
    expected_revision: u64,
}

#[async_trait]
impl ToolHandler for NessionServerSessionEnvBindingReapply {
    fn name(&self) -> &'static str {
        "nession_server_session_env_binding_reapply"
    }

    fn description(&self) -> &'static str {
        "Re-resolve one live Session's currently bound profiles and materialize a new revision without adding, removing or reordering profiles. `expected_revision` is the revision last read; a stale value is refused with revision_conflict and changes nothing. Never returns ENV values."
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
        context
            .cluster
            .session_env_binding_reapply(ClientSessionEnvBindingReapplyPayload {
                session_id: arguments.session_id,
                expected_revision: Some(arguments.expected_revision),
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::{arguments, context, Recorded, Recording};
    use std::sync::Arc;

    #[test]
    fn schema_is_closed_and_requires_the_session_and_revision() {
        let schema = NessionServerSessionEnvBindingReapply.input_schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false);
        let required = schema["required"].as_array().expect("required");
        assert!(required.contains(&serde_json::json!("session_id")));
        assert!(required.contains(&serde_json::json!("expected_revision")));
    }

    #[tokio::test]
    async fn reapply_carries_the_expected_revision() {
        let recorder = Arc::new(Recording::default());
        let reply = NessionServerSessionEnvBindingReapply
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "session_id": "agent-a:dev",
                    "expected_revision": 7
                })),
            )
            .await
            .expect("reply");
        assert_eq!(reply["success"], true);
        assert_eq!(
            recorder.calls(),
            vec![Recorded::BindingReapply("agent-a:dev".to_string(), 7)]
        );
    }

    #[tokio::test]
    async fn a_missing_revision_never_reaches_the_backend() {
        let recorder = Arc::new(Recording::default());
        let error = NessionServerSessionEnvBindingReapply
            .call(
                &context(&recorder),
                arguments(serde_json::json!({ "session_id": "agent-a:dev" })),
            )
            .await
            .expect_err("expected_revision is required");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }

    #[tokio::test]
    async fn a_non_canonical_session_id_never_reaches_the_backend() {
        let recorder = Arc::new(Recording::default());
        let error = NessionServerSessionEnvBindingReapply
            .call(
                &context(&recorder),
                arguments(serde_json::json!({
                    "session_id": "dev",
                    "expected_revision": 1
                })),
            )
            .await
            .expect_err("session id");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }
}
