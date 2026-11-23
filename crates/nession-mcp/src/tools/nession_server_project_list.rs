//! `nession_server_project_list` — Server-owned Project discovery.
//!
//! The semantic owner is the Server's Project declaration store. The result is
//! independent of Agent availability: a Project may exist while every Agent it
//! references is offline. A failed read is an error, never an empty collection
//! that would claim the user has no Projects.

use async_trait::async_trait;
use nession_protocol::contracts::project::v1::Project;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::ToolError;
use crate::tool::{parse_arguments, reply_value, schema_for, ToolContext, ToolHandler};

/// The Tool definition.
pub struct NessionServerProjectList;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Arguments {}

/// One Project as discovery returns it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ProjectSummary {
    /// Stable Server-minted identity (`project-<uuid>`).
    pub project_id: String,
    /// Human-readable Project name.
    pub name: String,
    /// Optional free-text description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Unix timestamp (seconds) of the last declaration update.
    pub updated_at: u64,
}

impl ProjectSummary {
    fn from_project(project: &Project) -> Self {
        Self {
            project_id: project.project_id.clone(),
            name: project.name.clone(),
            description: project.description.clone(),
            updated_at: project.updated_at,
        }
    }
}

/// The success reply of `nession_server_project_list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ProjectListOutput {
    /// Every Project declaration the Server owns, oldest first.
    pub projects: Vec<ProjectSummary>,
}

#[async_trait]
impl ToolHandler for NessionServerProjectList {
    fn name(&self) -> &'static str {
        "nession_server_project_list"
    }

    fn description(&self) -> &'static str {
        "List every Project the Nession Server owns, with each stable project_id. Project \
         discovery is Server-owned and works independently of Agent online status. Use \
         `nession_server_project_get` for a Project's locations, defaults and image reference."
    }

    fn input_schema(&self) -> Map<String, Value> {
        schema_for::<Arguments>()
    }

    fn output_schema(&self) -> Map<String, Value> {
        schema_for::<ProjectListOutput>()
    }

    async fn call(
        &self,
        context: &ToolContext,
        arguments: Map<String, Value>,
    ) -> Result<Value, ToolError> {
        let _: Arguments = parse_arguments(arguments)?;
        let reply = context.cluster.project_list().await?;
        if let Some(error) = reply.error {
            return Err(ToolError::backend(error));
        }
        reply_value(&ProjectListOutput {
            projects: reply
                .projects
                .iter()
                .map(ProjectSummary::from_project)
                .collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::{arguments, context, project_fixture, Recorded, Recording};
    use serde_json::json;
    use std::sync::Arc;

    #[tokio::test]
    async fn it_lists_server_projects_as_discovery_summaries() {
        let recorder = Arc::new(Recording::default());
        recorder.set_project_list_reply(json!({
            "projects": [project_fixture("project-123e4567-e89b-42d3-a456-426614174000")]
        }));
        let reply = NessionServerProjectList
            .call(&context(&recorder), arguments(json!({})))
            .await
            .expect("reply");
        assert_eq!(
            reply["projects"][0],
            json!({
                "project_id": "project-123e4567-e89b-42d3-a456-426614174000",
                "name": "Fixture Project",
                "description": "a test declaration",
                "updated_at": 2
            })
        );
        assert_eq!(recorder.calls(), vec![Recorded::ProjectList]);
    }

    #[tokio::test]
    async fn an_empty_server_list_is_a_distinct_success() {
        let recorder = Arc::new(Recording::default());
        let reply = NessionServerProjectList
            .call(&context(&recorder), arguments(json!({})))
            .await
            .expect("reply");
        assert_eq!(reply["projects"], json!([]));
    }

    #[tokio::test]
    async fn a_failed_read_is_not_reported_as_an_empty_collection() {
        let recorder = Arc::new(Recording::default());
        recorder.set_project_list_reply(json!({
            "projects": [],
            "error": "Projects could not be loaded"
        }));
        let error = NessionServerProjectList
            .call(&context(&recorder), arguments(json!({})))
            .await
            .expect_err("failed read");
        assert_eq!(error.kind, crate::error::ToolErrorKind::Backend);
        assert_eq!(error.message, "Projects could not be loaded");
    }

    #[test]
    fn its_schema_is_a_closed_empty_object() {
        let schema = NessionServerProjectList.input_schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false);
        if let Some(properties) = schema.get("properties") {
            assert_eq!(properties, &json!({}));
        }
    }

    #[tokio::test]
    async fn an_unexpected_argument_is_refused() {
        let recorder = Arc::new(Recording::default());
        let error = NessionServerProjectList
            .call(
                &context(&recorder),
                arguments(json!({ "agent_id": "agent-1" })),
            )
            .await
            .expect_err("unexpected argument");
        assert_eq!(error.kind, crate::error::ToolErrorKind::InvalidArgument);
        assert!(recorder.calls().is_empty());
    }
}
