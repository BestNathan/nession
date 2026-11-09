//! `git.diff` / v2.
//!
//! One file's change, with the source stated as a typed value rather than
//! inferred from a flag. Staging needs to distinguish the three views:
//!
//! ```text
//! HEAD --staged--> INDEX --unstaged--> WORKTREE
//! ```
//!
//! v1 asks only for `HEAD -> WORKTREE` (or a historical commit patch); a client
//! that had to reconstruct the other two from `commit`/`--cached` variants would
//! be running ad-hoc command variants, which the contract exists to prevent
//! (#845 SC-01).

use serde::{Deserialize, Serialize};

use crate::protocol::diff::v1::FileDiff;
use crate::protocol::{GitResponseV1, GitSnapshotV1, SessionTargetV1};

/// Which pair of states the patch compares.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DiffSourceV2 {
    /// `HEAD -> WORKTREE`, the combined change v1 shows.
    Worktree,
    /// `HEAD -> INDEX`: what a commit would record.
    Staged,
    /// `INDEX -> WORKTREE`: what staging would pick up.
    Unstaged,
    /// A historical patch, parent -> commit (v1's `commit` option).
    Commit { oid: String },
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct DiffRequestV2 {
    #[serde(flatten)]
    pub target: SessionTargetV1,
    /// Repository-relative. Validated agent-side before git runs.
    pub path: String,
    pub source: DiffSourceV2,
}

/// The patch and the repository state it was read from.
///
/// The snapshot is read **before** the patch: if the file changes in between,
/// the token is older than the bytes the client sees, so a later mutation is
/// refused rather than applying content the user never reviewed.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct DiffOkV2 {
    pub diff: FileDiff,
    pub snapshot: GitSnapshotV1,
}

pub type DiffResponseV2 = GitResponseV1<DiffOkV2>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_source_is_a_typed_value_not_a_flag() {
        let request: DiffRequestV2 = serde_json::from_value(serde_json::json!({
            "session": "s",
            "path": "src/lib.rs",
            "source": {"kind": "unstaged"}
        }))
        .unwrap();
        assert_eq!(request.source, DiffSourceV2::Unstaged);

        let historical: DiffRequestV2 = serde_json::from_value(serde_json::json!({
            "session": "s",
            "path": "src/lib.rs",
            "source": {"kind": "commit", "oid": "abc1234"}
        }))
        .unwrap();
        assert_eq!(
            historical.source,
            DiffSourceV2::Commit {
                oid: "abc1234".to_string()
            }
        );

        assert!(serde_json::from_value::<DiffRequestV2>(serde_json::json!({
            "session": "s", "path": "x"
        }))
        .is_err());
    }

    #[test]
    fn the_three_change_views_have_distinct_wire_spellings() {
        for (source, spelling) in [
            (DiffSourceV2::Worktree, "worktree"),
            (DiffSourceV2::Staged, "staged"),
            (DiffSourceV2::Unstaged, "unstaged"),
        ] {
            let value = serde_json::to_value(&source).unwrap();
            assert_eq!(value["kind"], spelling);
        }
    }
}
