//! `git.commit` / v1.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::{v1_descriptor, GitResponseV1, SessionTargetV1};

/// How a path changed in this commit.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ChangedFileEntry {
    pub path: String,
    /// Repository-relative path after a rename/copy, when git reports one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_path: Option<String>,
    /// Single-letter `name-status` code: A/M/D/R/C/T/U/X/B.
    pub status: String,
    /// True when git treats the path as binary in this commit.
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub oid: String,
    pub short_oid: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_date: String,
    pub committer: String,
    pub commit_date: String,
    pub subject: String,
    pub body: String,
    pub decorations: String,
    pub files: Vec<ChangedFileEntry>,
    pub files_truncated: bool,
    pub files_truncated_bytes: usize,
    pub message_truncated: bool,
    pub message_truncated_bytes: usize,
    /// v1 merge diffs use the first parent when showing a file patch via `git.diff`.
    pub merge_diff_parent: String,
}

pub const WIRE: &str = "git.commit";

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct CommitRequestV1 {
    #[serde(flatten)]
    pub target: SessionTargetV1,
    /// Full or abbreviated object name — validated agent-side, never passed as argv.
    pub oid: String,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct CommitOkV1 {
    pub commit: CommitDetail,
}

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

pub type CommitResponseV1 = GitResponseV1<CommitOkV1>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_descriptor_names_this_unit_its_owner_and_its_wire_type() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "git.commit");
        assert_eq!(d.contracts[0].wire, vec!["git.commit".to_string()]);
        assert!(d.validate().is_ok());
    }
}
