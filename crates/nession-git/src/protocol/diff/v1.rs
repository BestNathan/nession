//! `git.diff` / v1.

use serde::{Deserialize, Serialize};

use crate::protocol::{GitResponseV1, SessionTargetV1};

/// One file's diff against HEAD, as the caller receives it.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
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

pub const WIRE: &str = "git.diff";

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct DiffRequestV1 {
    #[serde(flatten)]
    pub target: SessionTargetV1,
    /// Repository-relative. Validated agent-side before git runs — the client
    /// naming an absolute path is refused there, not here, because a
    /// client-side check would be a second and weaker boundary.
    pub path: String,
    /// When set, diff this path between the commit's parent and the commit
    /// instead of the working tree against HEAD.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct DiffOkV1 {
    pub diff: FileDiff,
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
}
