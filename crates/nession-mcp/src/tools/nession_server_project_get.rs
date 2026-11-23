//! `nession_server_project_get` — Server-owned Project detail.
//!
//! The result is the canonical Project declaration: identity, Optional Git
//! source, Existing Locations, Session defaults, and the immutable image
//! digest reference. Session defaults carry Server ENV **references** (profile
//! ids), never file contents or expanded values.

use async_trait::async_trait;
use nession_protocol::contracts::project::v1::{
    is_valid_project_id, Project, ProjectGetPayload, ProjectValidationError,
};
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::error::ToolError;
use crate::tool::{non_empty, parse_arguments, reply_value, schema_for, ToolContext, ToolHandler};

/// The Tool definition.
pub struct NessionServerProjectGet;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Arguments {
    /// Stable Project identity (`project-<uuid>`).
    project_id: String,
}

#[async_trait]
impl ToolHandler for NessionServerProjectGet {
    fn name(&self) -> &'static str {
        "nession_server_project_get"
    }

    fn description(&self) -> &'static str {
        "Read one Project declaration from the Nession Server by project_id, including its \
         Existing Locations, Session defaults and image digest reference. No ENV values are \
         expanded. A malformed id is refused; an unknown Project is a not_found error."
    }

    fn input_schema(&self) -> Map<String, Value> {
        schema_for::<Arguments>()
    }

    fn output_schema(&self) -> Map<String, Value> {
        schema_for::<Project>()
    }

    async fn call(
        &self,
        context: &ToolContext,
        arguments: Map<String, Value>,
    ) -> Result<Value, ToolError> {
        let arguments: Arguments = parse_arguments(arguments)?;
        non_empty(&arguments.project_id, "project_id")?;
        if !is_valid_project_id(&arguments.project_id) {
            return Err(ToolError::invalid_argument(
                ProjectValidationError::InvalidProjectId.message(),
            ));
        }
        let reply = context
            .cluster
            .project_get(ProjectGetPayload {
                project_id: arguments.project_id,
            })
            .await?;
        if reply.success {
            if let Some(project) = reply.project {
                return reply_value(&project);
            }
        }
        let message = reply
            .error
            .unwrap_or_else(|| "the Server returned no Project".to_string());
        Err(match reply.error_kind.as_deref() {
            Some("invalid") => ToolError::invalid_argument(message),
            Some("not_found") => ToolError::not_found(message),
            Some("unavailable") => ToolError::unavailable(message),
            _ => ToolError::backend(message),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::{arguments, context, project_fixture, Recorded, Recording};
    use serde_json::json;
    use std::sync::Arc;

    const PROJECT_ID: &str = "project-123e4567-e89b-42d3-a456-426614174000";

    #[tokio::test]
    async fn it_returns_the_canonical_project_declaration() {
        let recorder = Arc::new(Recording::default());
        recorder.set_project_get_reply(json!({
            "success": true,
            "project": project_fixture(PROJECT_ID)
        }));
        let reply = NessionServerProjectGet
            .call(
                &context(&recorder),
                arguments(json!({ "project_id": PROJECT_ID })),
            )
            .await
            .expect("reply");
        assert_eq!(reply["project_id"], PROJECT_ID);
        assert_eq!(reply["locations"][0]["path"], "/srv/project");
        assert_eq!(reply["session_defaults"]["env_profile_ids"][0], "base.env");
        assert_eq!(
            recorder.calls(),
            vec![Recorded::ProjectGet(PROJECT_ID.to_string())]
        );
    }

    #[tokio::test]
    async fn an_unknown_project_is_not_found() {
        let recorder = Arc::new(Recording::default());
        recorder.set_project_get_reply(json!({
            "success": false,
            "error": "Project not found",
            "error_kind": "not_found"
        }));
        let error = NessionServerProjectGet
            .call(
                &context(&recorder),
                arguments(json!({ "project_id": PROJECT_ID })),
            )
            .await
            .expect_err("unknown project");
        assert_eq!(error.kind, crate::error::ToolErrorKind::NotFound);
        assert_eq!(error.message, "Project not found");
    }

    #[tokio::test]
    async fn an_unavailable_read_is_not_reported_as_not_found() {
        let recorder = Arc::new(Recording::default());
        recorder.set_project_get_reply(json!({
            "success": false,
            "error": "Project could not be loaded",
            "error_kind": "unavailable"
        }));
        let error = NessionServerProjectGet
            .call(
                &context(&recorder),
                arguments(json!({ "project_id": PROJECT_ID })),
            )
            .await
            .expect_err("unavailable read");
        assert_eq!(error.kind, crate::error::ToolErrorKind::Unavailable);
    }

    #[tokio::test]
    async fn a_malformed_identity_never_reaches_the_backend() {
        let recorder = Arc::new(Recording::default());
        let error = NessionServerProjectGet
            .call(
                &context(&recorder),
                arguments(json!({ "project_id": "not-a-project" })),
            )
            .await
            .expect_err("malformed project id");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert_eq!(
            error.message,
            ProjectValidationError::InvalidProjectId.message()
        );
        assert!(recorder.calls().is_empty());
    }

    #[test]
    fn its_schema_requires_a_string_identity() {
        let schema = NessionServerProjectGet.input_schema();
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"], json!(["project_id"]));
        assert_eq!(schema["properties"]["project_id"]["type"], "string");
    }

    #[tokio::test]
    async fn an_unexpected_argument_is_refused() {
        let recorder = Arc::new(Recording::default());
        let error = NessionServerProjectGet
            .call(
                &context(&recorder),
                arguments(json!({ "project_id": PROJECT_ID, "force": true })),
            )
            .await
            .expect_err("unexpected argument");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }
}
