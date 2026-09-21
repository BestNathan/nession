//! `git.branches` / v1.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::{v1_descriptor, GitResponseV1, SessionTargetV1};

/// One local branch.
///
/// `camelCase` for the reason `ChangedFile` records: the client reads camelCase,
/// and a multi-word field without the rule arrives as `undefined` with nothing
/// to say so.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    /// HEAD points here.
    pub current: bool,
    /// The configured upstream, `None` when the branch has none. Still set when
    /// the upstream has been deleted — that is what `upstream_gone` reports.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    /// Commits this branch has that its upstream does not.
    pub ahead: u32,
    /// Commits the upstream has that this branch does not.
    pub behind: u32,
    /// The configured upstream no longer exists — git's `[gone]`.
    pub upstream_gone: bool,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    pub branches: Vec<Branch>,
    /// The count that was answered for, so the view can offer "more" honestly.
    pub limit: usize,
    pub truncated_bytes: usize,
    pub truncated: bool,
}

pub const WIRE: &str = "git.branches";

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
pub struct BranchesRequestV1 {
    #[serde(flatten)]
    pub target: SessionTargetV1,
    /// A request the agent clamps, on the same terms as `git.log`'s.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
pub struct BranchesOkV1 {
    pub branches: Branches,
}

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

pub type BranchesResponseV1 = GitResponseV1<BranchesOkV1>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_limit_is_optional() {
        let req: BranchesRequestV1 =
            serde_json::from_value(serde_json::json!({"session": "s"})).unwrap();
        assert_eq!(req.limit, None);
    }

    #[test]
    fn the_descriptor_names_this_unit_its_owner_and_its_wire_type() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "git.branches");
        assert_eq!(d.contracts[0].wire, vec!["git.branches".to_string()]);
        assert!(d.validate().is_ok());
    }
}
