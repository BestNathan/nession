//! `git.worktrees` / v1.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::{v1_descriptor, GitResponseV1, SessionTargetV1};

/// One work tree, or one administrative entry for one that used to exist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    /// Absolute path as git records it.
    pub path: String,
    /// The branch checked out there, without `refs/heads/`. `None` when the
    /// entry is detached, bare, or has no `branch` line at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// This is the work tree the Session is sitting in.
    pub current: bool,
    pub detached: bool,
    /// A bare repository has no work tree; git lists the repository itself.
    pub bare: bool,
    /// `git worktree lock` reason, when it was locked. An empty string means
    /// locked with no reason given, which is a different sentence from unlocked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked: Option<String>,
    /// The directory is gone and the entry is waiting for `git worktree prune`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prunable: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Worktrees {
    pub worktrees: Vec<Worktree>,
    pub truncated_bytes: usize,
    pub truncated: bool,
}

pub const WIRE: &str = "extension.git.worktrees";

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
pub struct WorktreesRequestV1 {
    #[serde(flatten)]
    pub target: SessionTargetV1,
}

/// No `limit`: a worktree is a directory someone made by hand, so the count is
/// small in a way a branch count is not. The agent still caps the bytes.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
pub struct WorktreesOkV1 {
    pub worktrees: Worktrees,
}

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

pub type WorktreesResponseV1 = GitResponseV1<WorktreesOkV1>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_session_is_required() {
        let req: WorktreesRequestV1 =
            serde_json::from_value(serde_json::json!({"session": "s"})).unwrap();
        assert_eq!(req.target.session, "s");
    }

    #[test]
    fn the_descriptor_names_this_unit_its_owner_and_its_wire_type() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "git.worktrees");
        assert_eq!(
            d.contracts[0].wire,
            vec!["extension.git.worktrees".to_string()]
        );
        assert!(d.validate().is_ok());
    }
}
