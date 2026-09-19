//! `git.worktrees` / v1.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::{v1_descriptor, GitResponseV1, SessionTargetV1};
use crate::worktrees::Worktrees;

pub const WIRE: &str = "extension.git.worktrees";

#[derive(Debug, Clone, Deserialize)]
pub struct WorktreesRequestV1 {
    #[serde(flatten)]
    pub target: SessionTargetV1,
}

/// No `limit`: a worktree is a directory someone made by hand, so the count is
/// small in a way a branch count is not. The agent still caps the bytes.
#[derive(Debug, Clone, Serialize)]
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
