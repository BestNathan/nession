//! `git.root` / v1.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::{v1_descriptor, GitResponseV1, SessionTargetV1};

pub const WIRE: &str = "git.root";

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
pub struct RootRequestV1 {
    #[serde(flatten)]
    pub target: SessionTargetV1,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
pub struct RootOkV1 {
    pub root: String,
}

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

pub type RootResponseV1 = GitResponseV1<RootOkV1>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::GitFailure;

    #[test]
    fn only_the_session_is_required() {
        let req: RootRequestV1 =
            serde_json::from_value(serde_json::json!({"session": "s"})).unwrap();
        assert_eq!(req.target.session, "s");
    }

    #[test]
    fn the_ok_response_carries_the_root_alone() {
        let response: RootResponseV1 = GitResponseV1::Ok {
            data: RootOkV1 {
                root: "/repo".to_string(),
            },
        };
        let value = serde_json::to_value(&response).unwrap();
        assert_eq!(value["state"], "ok");
        assert_eq!(value["root"], "/repo");
        // No status: this contract exists so a handoff does not pay for one.
        assert!(value.get("status").is_none());
    }

    #[test]
    fn a_repository_that_is_not_one_is_an_answer_rather_than_an_error() {
        let response: RootResponseV1 = GitFailure::NotARepository {
            message: "not a git repository".to_string(),
        }
        .into_response();
        assert_eq!(
            serde_json::to_value(&response).unwrap()["state"],
            "not_a_repository"
        );
    }

    #[test]
    fn the_descriptor_names_this_unit_its_owner_and_its_wire_type() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "git.root");
        assert_eq!(d.contracts[0].wire, vec!["git.root".to_string()]);
        assert!(d.validate().is_ok());
    }
}
