//! `github.workflows` / v1.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::{v1_descriptor, GithubRepositoryRefV1, GithubResponseV1, SessionTargetV1};

pub const WIRE: &str = "github.workflows";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum RunScopeV1 {
    #[default]
    Repository,
    Branch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStateV1 {
    Active,
    Disabled,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WorkflowRunStatusV1 {
    Queued,
    InProgress,
    Completed,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct WorkflowRunV1 {
    pub id: u64,
    pub status: WorkflowRunStatusV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conclusion: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub sha: String,
    pub event: String,
    pub created_at: String,
    pub updated_at: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct GithubWorkflowV1 {
    pub id: u64,
    pub name: String,
    pub path: String,
    pub state: WorkflowStateV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_run: Option<WorkflowRunV1>,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct WorkflowsRequestV1 {
    #[serde(flatten)]
    pub target: SessionTargetV1,
    #[serde(default)]
    pub scope: RunScopeV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct WorkflowsOkV1 {
    pub repository: GithubRepositoryRefV1,
    pub scope: RunScopeV1,
    /// The branch whose runs were asked for; present only for branch scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub workflows: Vec<GithubWorkflowV1>,
    pub has_more: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

pub type WorkflowsResponseV1 = GithubResponseV1<WorkflowsOkV1>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_defaults_to_repository_and_branch_is_explicit() {
        let req: WorkflowsRequestV1 =
            serde_json::from_value(serde_json::json!({"session": "s"})).unwrap();
        assert_eq!(req.scope, RunScopeV1::Repository);
        let req: WorkflowsRequestV1 =
            serde_json::from_value(serde_json::json!({"session": "s", "scope": "branch"})).unwrap();
        assert_eq!(req.scope, RunScopeV1::Branch);
    }

    #[test]
    fn queued_is_not_collapsed_into_a_conclusion() {
        let value = serde_json::to_value(WorkflowRunStatusV1::Queued).unwrap();
        assert_eq!(value, "queued");
        assert!(serde_json::to_value(WorkflowRunStatusV1::InProgress)
            .unwrap()
            .as_str()
            .unwrap()
            .starts_with("in_progress"));
    }

    #[test]
    fn the_descriptor_names_the_unit_owner_and_wire() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "github.workflows");
        assert_eq!(d.owner, "nession-github");
        assert!(d.validate().is_ok());
    }
}
