//! `git.branches` / v1.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::branches::Branches;
use crate::protocol::{v1_descriptor, GitResponseV1, SessionTargetV1};

pub const WIRE: &str = "extension.git.branches";

#[derive(Debug, Clone, Deserialize)]
pub struct BranchesRequestV1 {
    #[serde(flatten)]
    pub target: SessionTargetV1,
    /// A request the agent clamps, on the same terms as `git.log`'s.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
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
        assert_eq!(
            d.contracts[0].wire,
            vec!["extension.git.branches".to_string()]
        );
        assert!(d.validate().is_ok());
    }
}
