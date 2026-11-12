//! `github.issues` / v1.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::{
    v1_descriptor, GithubLabelV1, GithubRepositoryRefV1, GithubResponseV1, GithubUserV1,
    SessionTargetV1,
};

pub const WIRE: &str = "github.issues";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum IssueStateFilterV1 {
    #[default]
    Open,
    Closed,
    All,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct IssuesRequestV1 {
    #[serde(flatten)]
    pub target: SessionTargetV1,
    #[serde(default)]
    pub state: IssueStateFilterV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// The opaque continuation from the previous page; never a URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// An explicit user Refresh bypasses the short-lived read cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct GithubIssueSummaryV1 {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub author: GithubUserV1,
    pub labels: Vec<GithubLabelV1>,
    pub assignees: Vec<GithubUserV1>,
    pub updated_at: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct IssuesOkV1 {
    pub repository: GithubRepositoryRefV1,
    pub issues: Vec<GithubIssueSummaryV1>,
    pub has_more: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

pub type IssuesResponseV1 = GithubResponseV1<IssuesOkV1>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_default_to_open_and_cursor_is_opaque() {
        let req: IssuesRequestV1 =
            serde_json::from_value(serde_json::json!({"session": "s"})).unwrap();
        assert_eq!(req.state, IssueStateFilterV1::Open);
        assert_eq!(req.cursor, None);
        assert!(req.refresh.is_none());
    }

    #[test]
    fn the_descriptor_names_the_unit_owner_and_wire() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "github.issues");
        assert_eq!(d.owner, "nession-github");
        assert!(d.validate().is_ok());
    }
}
