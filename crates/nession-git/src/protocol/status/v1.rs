//! `git.status` / v1.
//!
//! Everything the Workspace and the Terminal Signal need about one repository,
//! in one read: which branch, how far from its upstream, and what has changed.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::{v1_descriptor, GitResponseV1, SessionTargetV1};

/// This contract's wire message type — its transport projection.
///
/// Not the protocol id. Keeping the two separately nameable is what lets a
/// transport rename be told apart from a semantic change; only the second is a
/// breaking contract event.
pub const WIRE: &str = "extension.git.status";

/// What a caller asks for.
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
pub struct StatusRequestV1 {
    #[serde(flatten)]
    pub target: SessionTargetV1,
}

/// `camelCase` because that is what the client reads, and every other field on
/// this wire already is: the hand-written `truncatedBytes` beside it in
/// `agent.rs`, and every single-word field whose spelling the case rule cannot
/// touch. Without it this struct alone emitted `original_path`, so a renamed
/// file's tooltip read `undefined → new-name` — a field that is only populated
/// for renames, which is exactly the case no fixture exercised over the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// Present only for renames/copies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub kind: ChangeKind,
    /// Staged in the index (porcelain `X`).
    pub staged: bool,
    /// Changed in the working tree (porcelain `Y`).
    pub unstaged: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Unmerged,
    Unknown,
}

/// A repository's state as of one `status` call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
pub struct RepoStatus {
    /// Branch name, or `None` when detached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub detached: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// Tracked paths, Modified/Added/Deleted/Renamed — #750's "Modified" group.
    pub modified: Vec<ChangedFile>,
    /// Untracked paths. No diff is available for these, which is why the view
    /// gives them no expander (#750 SC2).
    pub untracked: Vec<String>,
    /// Unmerged paths, present during a conflicted merge/rebase/cherry-pick.
    pub unmerged: Vec<String>,
}

/// What the answer carries when there is one.
///
/// `root` rides along rather than costing a second request: the Terminal
/// Signal's worktree identity and the Workspace header both read it, and the
/// probe that decided "this is a repository" already knew it.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
pub struct StatusOkV1 {
    pub status: RepoStatus,
    pub root: String,
    /// True when the listing itself was cut off. A partial listing presented as
    /// a whole one is the failure `#750` C3 names.
    pub truncated: bool,
    #[serde(rename = "truncatedBytes")]
    pub truncated_bytes: usize,
}

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

/// The response this contract produces.
pub type StatusResponseV1 = GitResponseV1<StatusOkV1>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::GitFailure;
    use serde_json::json;

    #[test]
    fn the_request_reads_the_session_and_ignores_a_client_supplied_path() {
        // #750 C2: the repository is resolved agent-side, so a `cwd` in the
        // payload is ignored rather than honoured. A typed request that refused
        // unknown fields would turn that deliberate silence into an error.
        let req: StatusRequestV1 =
            serde_json::from_value(json!({"session": "a1:dev", "cwd": "/etc"})).unwrap();
        assert_eq!(req.target.session, "a1:dev");
    }

    #[test]
    fn a_request_without_a_session_is_refused_at_the_boundary() {
        assert!(serde_json::from_value::<StatusRequestV1>(json!({})).is_err());
    }

    #[test]
    fn the_ok_response_serialises_in_the_shipped_wire_shape() {
        // Typing this contract must not change a byte: peers already exist.
        let response: StatusResponseV1 = GitResponseV1::Ok {
            data: StatusOkV1 {
                status: RepoStatus {
                    branch: Some("main".to_string()),
                    detached: false,
                    upstream: Some("origin/main".to_string()),
                    ahead: 2,
                    behind: 1,
                    modified: Vec::new(),
                    untracked: Vec::new(),
                    unmerged: Vec::new(),
                },
                root: "/repo".to_string(),
                truncated: false,
                truncated_bytes: 0,
            },
        };

        let value = serde_json::to_value(&response).unwrap();
        assert_eq!(value["state"], "ok");
        assert_eq!(value["root"], "/repo");
        assert_eq!(value["truncated"], false);
        assert_eq!(value["truncatedBytes"], 0);
        assert_eq!(value["status"]["branch"], "main");
        assert_eq!(value["status"]["ahead"], 2);
    }

    #[test]
    fn each_failure_state_keeps_its_own_state_and_its_own_fields() {
        // The three are separate variants because they have different causes and
        // different fixes; collapsing them into one `error` would undo #750 SC4.
        let unavailable: StatusResponseV1 = GitFailure::Unavailable {
            reason: "session_workdir_unknown".to_string(),
            message: "Could not resolve this Session's working directory.".to_string(),
        }
        .into_response();
        let value = serde_json::to_value(&unavailable).unwrap();
        assert_eq!(value["state"], "unavailable");
        assert_eq!(value["reason"], "session_workdir_unknown");
        assert!(value.get("status").is_none());

        let not_a_repo: StatusResponseV1 = GitFailure::NotARepository {
            message: "not a git repository".to_string(),
        }
        .into_response();
        let value = serde_json::to_value(&not_a_repo).unwrap();
        assert_eq!(value["state"], "not_a_repository");
        assert_eq!(value["message"], "not a git repository");
        // No `reason`: a state that does not have one must not emit an empty one.
        assert!(value.get("reason").is_none());
    }

    #[test]
    fn the_descriptor_names_this_unit_its_owner_and_its_wire_type() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "git.status");
        assert_eq!(d.owner, "nession-git");
        assert_eq!(d.versions(), vec![nession_protocol::ContractVersion::V1]);
        assert_eq!(
            d.contracts[0].wire,
            vec!["extension.git.status".to_string()]
        );
        assert!(d.validate().is_ok());
    }
}
