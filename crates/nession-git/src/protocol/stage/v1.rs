//! `git.stage` / v1.
//!
//! Stage one repository-relative path. File-level only: hunk staging would need
//! a stateless, snapshot-checked patch selection, which #845 keeps optional for
//! a later contract.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::Deserialize;

use crate::protocol::{v1_descriptor, GitMutationResponseV1, MutationStateOkV1, SessionTargetV1};

pub const WIRE: &str = "git.stage";

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct StageRequestV1 {
    #[serde(flatten)]
    pub target: SessionTargetV1,
    /// Repository-relative, validated agent-side before git runs.
    pub path: String,
    /// The snapshot the caller reviewed. The mutation is refused, without being
    /// applied, if the repository no longer matches it.
    #[serde(rename = "expectedSnapshot")]
    pub expected_snapshot: String,
}

/// Staging answers with the authoritative post-mutation repository state.
pub type StageOkV1 = MutationStateOkV1;

pub type StageResponseV1 = GitMutationResponseV1<StageOkV1>;

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_requires_a_path_and_the_reviewed_snapshot() {
        let request: StageRequestV1 = serde_json::from_value(serde_json::json!({
            "session": "s",
            "path": "src/lib.rs",
            "expectedSnapshot": "abc123"
        }))
        .unwrap();
        assert_eq!(request.path, "src/lib.rs");
        assert_eq!(request.expected_snapshot, "abc123");

        assert!(serde_json::from_value::<StageRequestV1>(serde_json::json!({
            "session": "s", "path": "x"
        }))
        .is_err());
    }

    #[test]
    fn the_descriptor_names_this_unit_its_owner_and_its_wire_type() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "git.stage");
        assert_eq!(d.owner, "nession-git");
        assert_eq!(d.contracts[0].wire, vec!["git.stage".to_string()]);
        assert!(d.validate().is_ok());
    }
}
