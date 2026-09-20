//! `git.diff` / v1.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::{v1_descriptor, GitResponseV1, SessionTargetV1};

/// One file's diff against HEAD, as the caller receives it.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
pub struct FileDiff {
    pub path: String,
    /// Unified diff text, already capped and lossily decoded for transport.
    pub text: String,
    /// True when the file is binary — git reports that instead of a diff.
    pub binary: bool,
    /// Bytes dropped by the cap. Non-zero means `text` is a prefix, and the UI
    /// must say so (#750 C3).
    pub truncated_bytes: usize,
    pub truncated: bool,
}

pub const WIRE: &str = "extension.git.diff";

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
pub struct DiffRequestV1 {
    #[serde(flatten)]
    pub target: SessionTargetV1,
    /// Repository-relative. Validated agent-side before git runs — the client
    /// naming an absolute path is refused there, not here, because a
    /// client-side check would be a second and weaker boundary.
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
pub struct DiffOkV1 {
    pub diff: FileDiff,
}

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

pub type DiffResponseV1 = GitResponseV1<DiffOkV1>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_requires_both_a_session_and_a_path() {
        let ok: DiffRequestV1 =
            serde_json::from_value(serde_json::json!({"session": "s", "path": "src/lib.rs"}))
                .unwrap();
        assert_eq!(ok.path, "src/lib.rs");
        assert_eq!(ok.target.session, "s");

        assert!(
            serde_json::from_value::<DiffRequestV1>(serde_json::json!({"session": "s"})).is_err()
        );
    }

    #[test]
    fn the_descriptor_names_this_unit_its_owner_and_its_wire_type() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "git.diff");
        assert_eq!(d.owner, "nession-git");
        assert_eq!(d.contracts[0].wire, vec!["extension.git.diff".to_string()]);
        assert!(d.validate().is_ok());
    }
}
