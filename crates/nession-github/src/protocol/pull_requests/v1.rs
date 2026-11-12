//! `github.pull-requests` / v1.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::{
    v1_descriptor, GithubRepositoryRefV1, GithubResponseV1, GithubUserV1, SessionTargetV1,
};

pub const WIRE: &str = "github.pull-requests";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum PullRequestStateFilterV1 {
    #[default]
    Open,
    Closed,
    All,
}

/// The current branch's relation to a PR, identity-checked rather than
/// guessed from a branch name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum BranchRelationV1 {
    Matched,
    None,
    Ambiguous,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct GithubBaseRefV1 {
    #[serde(rename = "ref")]
    pub ref_name: String,
    pub sha: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct GithubHeadRefV1 {
    /// The head repository's owner; empty when the fork was deleted.
    pub owner: String,
    pub repo: String,
    #[serde(rename = "ref")]
    pub ref_name: String,
    pub sha: String,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct PullRequestsRequestV1 {
    #[serde(flatten)]
    pub target: SessionTargetV1,
    #[serde(default)]
    pub state: PullRequestStateFilterV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct GithubPullRequestSummaryV1 {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub draft: bool,
    pub merged: bool,
    pub author: GithubUserV1,
    pub head: GithubHeadRefV1,
    pub head_ref_name: String,
    pub base: GithubBaseRefV1,
    pub base_ref_name: String,
    pub updated_at: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct PullRequestsOkV1 {
    pub repository: GithubRepositoryRefV1,
    pub pull_requests: Vec<GithubPullRequestSummaryV1>,
    /// The current branch's relation, computed by exact repository/head-owner
    /// and head-ref identity.
    pub current_branch: BranchRelationV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_branch_pr: Option<u64>,
    pub has_more: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

pub type PullRequestsResponseV1 = GithubResponseV1<PullRequestsOkV1>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_head_ref_serializes_as_ref_without_losing_the_identity_fields() {
        let head = GithubHeadRefV1 {
            owner: "fork".into(),
            repo: "r".into(),
            ref_name: "feature/x".into(),
            sha: "abc".into(),
        };
        let value = serde_json::to_value(head).unwrap();
        assert_eq!(value["ref"], "feature/x");
        assert_eq!(value["owner"], "fork");
    }

    #[test]
    fn the_descriptor_names_the_unit_owner_and_wire() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "github.pull-requests");
        assert_eq!(d.owner, "nession-github");
        assert!(d.validate().is_ok());
    }
}
