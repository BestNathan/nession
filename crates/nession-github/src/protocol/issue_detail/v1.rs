//! `github.issue-detail` / v1.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::{
    v1_descriptor, GithubLabelV1, GithubRepositoryRefV1, GithubResponseV1, GithubUserV1,
    SessionTargetV1,
};

pub const WIRE: &str = "github.issue-detail";

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct IssueDetailRequestV1 {
    #[serde(flatten)]
    pub target: SessionTargetV1,
    /// Validated Issue number, scoped to the already resolved repository.
    pub number: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct GithubIssueDetailV1 {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub author: GithubUserV1,
    pub labels: Vec<GithubLabelV1>,
    pub assignees: Vec<GithubUserV1>,
    pub created_at: String,
    pub updated_at: String,
    pub url: String,
    /// Raw Markdown. Rendering is the Web's, with its own sanitization.
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct IssueDetailOkV1 {
    pub repository: GithubRepositoryRefV1,
    pub issue: GithubIssueDetailV1,
}

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

pub type IssueDetailResponseV1 = GithubResponseV1<IssueDetailOkV1>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_number_is_required_and_positive_is_checked_by_the_provider() {
        assert!(serde_json::from_value::<IssueDetailRequestV1>(
            serde_json::json!({"session": "s"})
        )
        .is_err());
        let req: IssueDetailRequestV1 =
            serde_json::from_value(serde_json::json!({"session": "s", "number": 1290})).unwrap();
        assert_eq!(req.number, 1290);
    }

    #[test]
    fn the_descriptor_names_the_unit_owner_and_wire() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "github.issue-detail");
        assert_eq!(d.owner, "nession-github");
        assert!(d.validate().is_ok());
    }
}
