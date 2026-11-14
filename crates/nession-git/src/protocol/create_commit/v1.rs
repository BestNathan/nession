//! `git.create-commit` / v1.
//!
//! A deliberately new Unit rather than a new version of `git.commit`: that
//! Contract Version already means "read one commit's detail" (#1009) and
//! `GitPlugin.gitCommit()` consumes it. Overloading it would make the same
//! message mean a read or a write depending on fields (#845 SC-15).

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::{v1_descriptor, GitMutationResponseV1, MutationStateOkV1, SessionTargetV1};

pub const WIRE: &str = "git.create-commit";

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct CreateCommitRequestV1 {
    #[serde(flatten)]
    pub target: SessionTargetV1,
    /// The snapshot of the staged state the caller reviewed.
    pub expected_snapshot: String,
    pub message: String,
    /// Idempotency identity for one user-initiated commit. A retry carrying the
    /// same id is answered with the first attempt's outcome instead of creating
    /// a second commit (#845 SC-09).
    pub request_id: String,
}

/// The commit that was created, and the identity Git would use.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct CommitCreatedV1 {
    /// Full commit id. A commit always changes HEAD, so a success without one
    /// is reported as a failure rather than as this shape.
    pub oid: String,
    /// The effective author identity Git used, e.g. `A U Thor <a@example.com>`.
    pub author: String,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct CreateCommitOkV1 {
    pub commit: CommitCreatedV1,
    /// The authoritative post-commit state.
    #[serde(flatten)]
    pub state: MutationStateOkV1,
}

pub type CreateCommitResponseV1 = GitMutationResponseV1<CreateCommitOkV1>;

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_names_the_reviewed_state_the_message_and_the_request_id() {
        let request: CreateCommitRequestV1 = serde_json::from_value(serde_json::json!({
            "session": "s",
            "expected_snapshot": "abc123",
            "message": "feat: change",
            "request_id": "req-1"
        }))
        .unwrap();
        assert_eq!(request.expected_snapshot, "abc123");
        assert_eq!(request.message, "feat: change");
        assert_eq!(request.request_id, "req-1");
    }

    #[test]
    fn creating_a_commit_is_not_the_read_only_commit_detail_unit() {
        // #1009 already owns `git.commit` for commit detail; this unit must not
        // be routable under that wire.
        assert_ne!(WIRE, "git.commit");
        assert_eq!(descriptor().unwrap().id.as_str(), "git.create-commit");
    }

    #[test]
    fn the_descriptor_names_this_unit_its_owner_and_its_wire_type() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "git.create-commit");
        assert_eq!(d.owner, "nession-git");
        assert_eq!(d.contracts[0].wire, vec!["git.create-commit".to_string()]);
        assert!(d.validate().is_ok());
    }
}
