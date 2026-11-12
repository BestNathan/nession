//! `github.pull-request-detail` / v1.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::pull_requests::{GithubBaseRefV1, GithubHeadRefV1};
use crate::protocol::{
    v1_descriptor, GithubRepositoryRefV1, GithubResponseV1, GithubUserV1, SessionTargetV1,
};

pub const WIRE: &str = "github.pull-request-detail";

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct PullRequestDetailRequestV1 {
    #[serde(flatten)]
    pub target: SessionTargetV1,
    pub number: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct GithubPullRequestDetailV1 {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub draft: bool,
    pub merged: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_at: Option<String>,
    pub author: GithubUserV1,
    pub head: GithubHeadRefV1,
    pub head_ref_name: String,
    pub base: GithubBaseRefV1,
    pub base_ref_name: String,
    pub created_at: String,
    pub updated_at: String,
    pub url: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetailOkV1 {
    pub repository: GithubRepositoryRefV1,
    pub pull_request: GithubPullRequestDetailV1,
}

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

pub type PullRequestDetailResponseV1 = GithubResponseV1<PullRequestDetailOkV1>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_detail_request_requires_a_number() {
        assert!(serde_json::from_value::<PullRequestDetailRequestV1>(
            serde_json::json!({"session": "s"})
        )
        .is_err());
    }

    #[test]
    fn the_descriptor_names_the_unit_owner_and_wire() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "github.pull-request-detail");
        assert_eq!(d.owner, "nession-github");
        assert!(d.validate().is_ok());
    }
}
