//! `git.unstage` / v1.
//!
//! Unstage is an index mutation, never a worktree restore: the content the user
//! has on disk must survive an unstage even when the staged copy differed
//! (#845 SC-04).

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::Deserialize;

use crate::protocol::{v1_descriptor, GitMutationResponseV1, MutationStateOkV1, SessionTargetV1};

pub const WIRE: &str = "git.unstage";

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct UnstageRequestV1 {
    #[serde(flatten)]
    pub target: SessionTargetV1,
    /// Repository-relative, validated agent-side before git runs.
    pub path: String,
    /// The snapshot the caller reviewed. A stale token is refused and the index
    /// is left untouched.
    pub expected_snapshot: String,
}

pub type UnstageOkV1 = MutationStateOkV1;

pub type UnstageResponseV1 = GitMutationResponseV1<UnstageOkV1>;

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_requires_a_path_and_the_reviewed_snapshot() {
        let request: UnstageRequestV1 = serde_json::from_value(serde_json::json!({
            "session": "s",
            "path": "src/lib.rs",
            "expected_snapshot": "abc123"
        }))
        .unwrap();
        assert_eq!(request.path, "src/lib.rs");
        assert_eq!(request.expected_snapshot, "abc123");

        assert!(
            serde_json::from_value::<UnstageRequestV1>(serde_json::json!({
                "session": "s", "path": "x"
            }))
            .is_err()
        );
    }

    #[test]
    fn the_descriptor_names_this_unit_its_owner_and_its_wire_type() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "git.unstage");
        assert_eq!(d.owner, "nession-git");
        assert_eq!(d.contracts[0].wire, vec!["git.unstage".to_string()]);
        assert!(d.validate().is_ok());
    }
}
