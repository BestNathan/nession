//! The GitHub provider's contracts (#1290, #678).
//!
//! A directory per Protocol Unit and a file per contract version. GitHub is a
//! hosting provider for the one Git capability; it owns these units and the
//! typed client behind them, and it does not become a second top-level
//! capability.

pub mod issue_detail;
pub mod issues;
pub mod pull_request_detail;
pub mod pull_requests;
pub mod repository;
pub mod workflows;

use nession_protocol::{ContractDescriptor, ContractVersion, IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

/// This provider's identity in a manifest.
pub const OWNER: &str = "nession-github";

/// Every request names the Session whose live repository is authoritative.
///
/// `agent_id` is transport routing, never a provider-selected repository; it is
/// absent here because it is not part of the contract.
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct SessionTargetV1 {
    pub session: String,
    /// A remote name discovered by the Agent for this Session. The provider
    /// re-resolves it on every request; it can never name a host/owner/repo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_name: Option<String>,
}

/// The selected GitHub repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct GithubRepositoryRefV1 {
    pub host: String,
    pub owner: String,
    pub repo: String,
    pub remote_name: String,
    /// The canonical browser source of this repository, never a credential URL.
    pub source_url: String,
}

/// One remote the Agent discovered for the Session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct GithubRemoteChoiceV1 {
    pub remote_name: String,
    pub host: String,
    pub owner: String,
    pub repo: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct GithubUserV1 {
    pub login: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct GithubLabelV1 {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// The machine-readable failure classes `#1290` requires stay distinguishable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum GithubErrorCodeV1 {
    NotARepository,
    NoGithubRemote,
    AmbiguousRemote,
    HostNotAllowed,
    ClientUnavailable,
    NotAuthenticated,
    AccessDenied,
    NotFound,
    RateLimited,
    NetworkUnavailable,
    Timeout,
    ApiError,
    MalformedResponse,
}

/// The answer every unit shares.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum GithubResponseV1<T> {
    Ok {
        #[serde(flatten)]
        data: T,
    },
    Error {
        code: GithubErrorCodeV1,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_after_seconds: Option<u64>,
    },
}

impl<T> GithubResponseV1<T> {
    pub fn error(code: GithubErrorCodeV1, message: impl Into<String>) -> Self {
        Self::Error {
            code,
            message: message.into(),
            retry_after_seconds: None,
        }
    }
}

/// One version, one wire message type.
pub(crate) fn v1_descriptor(id: &str, wire: &str) -> Result<ProtocolDescriptor, IdentityError> {
    ProtocolDescriptor::new(
        id,
        OWNER,
        vec![ContractDescriptor::new(ContractVersion::new(1)?, &[wire])],
    )
}

pub fn descriptors() -> Result<Vec<ProtocolDescriptor>, IdentityError> {
    Ok(vec![
        repository::descriptor()?,
        issues::descriptor()?,
        issue_detail::descriptor()?,
        pull_requests::descriptor()?,
        pull_request_detail::descriptor()?,
        workflows::descriptor()?,
    ])
}
