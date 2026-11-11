//! `github.repository` / v1.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::{
    v1_descriptor, GithubRemoteChoiceV1, GithubRepositoryRefV1, GithubResponseV1, SessionTargetV1,
};

pub const WIRE: &str = "github.repository";

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct RepositoryRequestV1 {
    #[serde(flatten)]
    pub target: SessionTargetV1,
}

/// The identity resolution's answer, including the states that are not an
/// error: a repository without a GitHub remote is a working local repository.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum RepositoryStateV1 {
    Resolved,
    NoRemote,
    Ambiguous,
    HostNotAllowed,
    NotARepository,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct RepositoryOkV1 {
    /// The identity resolution, distinct from the response's `state`.
    pub resolution: RepositoryStateV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<GithubRepositoryRefV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub choices: Vec<GithubRemoteChoiceV1>,
    /// Whether the Agent has a host-appropriate credential. Discovery is not
    /// authentication; this is the fact the UI must show before a read.
    pub authenticated: bool,
}

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

pub type RepositoryResponseV1 = GithubResponseV1<RepositoryOkV1>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_names_only_the_session_and_a_discovered_remote() {
        let req: RepositoryRequestV1 =
            serde_json::from_value(serde_json::json!({"session": "s"})).unwrap();
        assert_eq!(req.target.session, "s");
        assert_eq!(req.target.remote_name, None);
        let req: RepositoryRequestV1 =
            serde_json::from_value(serde_json::json!({"session": "s", "remote_name": "upstream"}))
                .unwrap();
        assert_eq!(req.target.remote_name.as_deref(), Some("upstream"));
    }

    #[test]
    fn a_no_remote_answer_is_ok_with_typed_state_rather_than_an_error() {
        let response: RepositoryResponseV1 = GithubResponseV1::Ok {
            data: RepositoryOkV1 {
                resolution: RepositoryStateV1::NoRemote,
                repository: None,
                branch: Some("main".into()),
                choices: Vec::new(),
                authenticated: false,
            },
        };
        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["state"], "ok");
        assert_eq!(value["resolution"], "no_remote");
        assert_eq!(value["choices"].as_array().unwrap().len(), 0);
        assert_eq!(
            serde_json::to_value(RepositoryStateV1::NoRemote).unwrap(),
            "no_remote"
        );
    }

    #[test]
    fn the_descriptor_names_the_unit_owner_and_wire() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "github.repository");
        assert_eq!(d.owner, "nession-github");
        assert_eq!(d.contracts[0].wire, vec!["github.repository".to_string()]);
        assert!(d.validate().is_ok());
    }
}
