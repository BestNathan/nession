//! `git.status` / v2.
//!
//! Same question as v1, plus the piece write operations need: an identity for
//! the exact repository state this answer describes. A client stages, unstages
//! or commits only after presenting that identity back, so a terminal-side
//! `git add` between review and confirmation is refused instead of silently
//! overwritten (#845 SC-02, SC-03).

use serde::{Deserialize, Serialize};

use crate::protocol::status::v1::RepoStatus;
use crate::protocol::{GitResponseV1, GitSnapshotV1, SessionTargetV1};

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct StatusRequestV2 {
    #[serde(flatten)]
    pub target: SessionTargetV1,
}

/// The answer, with the snapshot the listing was read from.
///
/// `snapshot` is read from the same `git status` invocation that produced
/// `status`, so the two cannot describe different states.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct StatusOkV2 {
    pub status: RepoStatus,
    pub root: String,
    pub snapshot: GitSnapshotV1,
    pub truncated: bool,
    pub truncated_bytes: usize,
}

pub type StatusResponseV2 = GitResponseV1<StatusOkV2>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_reads_the_session_and_ignores_a_client_supplied_path() {
        let req: StatusRequestV2 =
            serde_json::from_value(serde_json::json!({"session": "a1:dev", "cwd": "/etc"}))
                .unwrap();
        assert_eq!(req.target.session, "a1:dev");
        assert!(serde_json::from_value::<StatusRequestV2>(serde_json::json!({})).is_err());
    }

    #[test]
    fn the_ok_response_carries_the_snapshot_alongside_the_listing() {
        let response: StatusResponseV2 = GitResponseV1::Ok {
            data: StatusOkV2 {
                status: RepoStatus {
                    branch: Some("main".to_string()),
                    detached: false,
                    upstream: None,
                    ahead: 0,
                    behind: 0,
                    modified: Vec::new(),
                    untracked: Vec::new(),
                    unmerged: Vec::new(),
                },
                root: "/repo".to_string(),
                snapshot: GitSnapshotV1 {
                    token: "abc123".to_string(),
                    head: Some("0123456789abcdef".to_string()),
                    root: "/repo".to_string(),
                },
                truncated: false,
                truncated_bytes: 0,
            },
        };

        let value = serde_json::to_value(&response).unwrap();
        assert_eq!(value["state"], "ok");
        assert_eq!(value["snapshot"]["token"], "abc123");
        assert_eq!(value["snapshot"]["head"], "0123456789abcdef");
        assert_eq!(value["truncatedBytes"], 0);
    }
}
