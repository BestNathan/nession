//! OCI Distribution registry mechanics for EROFS artifacts (#3498, #4088).
//!
//! Two host-independent surfaces live here:
//!
//! - the external OCI Distribution **client** (feature `registry`, #3498):
//!   pull/push against an authorized remote registry. Credentials enter only
//!   through a [`RegistryCredentialProvider`] supplied by the host's secret
//!   source; every pull is approved by a [`RegistryImportAuthorizer`] before
//!   any network request or catalog write; imported JSON keeps its exact
//!   source bytes; redirects/hosts/bodies are bounded.
//! - the mountable **`/v2/` Registry service** (feature `registry-service`,
//!   #4088): a reusable Axum router over a supplied `BlobStore`,
//!   `RepositoryStore` and `RegistryAuthorizer`, with an explicit read-only
//!   mode and push behind an injected publisher.
//!
//! Neither surface unpacks container layers, converts an upstream image to
//! EROFS, or owns host identity/authorization policy. The two features are
//! independent so an Agent can mount the service without compiling the
//! external client's credential machinery.

#[cfg(feature = "registry")]
use std::fmt;
#[cfg(feature = "registry")]
use std::time::Duration;

#[cfg(feature = "registry")]
use reqwest::Url;

#[cfg(feature = "registry")]
pub mod auth;
#[cfg(feature = "registry")]
pub mod client;
#[cfg(feature = "registry")]
pub mod pull;
#[cfg(feature = "registry")]
pub mod push;
#[cfg(feature = "registry")]
pub mod sdk;
#[cfg(feature = "registry-service")]
pub mod service;

// Bare `cfg(test)` so clippy's allow-in-tests recognizes the module; the file
// itself is gated on the `registry` client feature via an inner attribute so a
// service-only build does not compile the client mock.
#[cfg(test)]
mod test_registry;

#[cfg(feature = "registry")]
pub use auth::{
    AllowAllImports, DenyAllImports, ImportScope, NoCredentials, RegistryCredential,
    RegistryCredentialProvider, RegistryImportAuthorizer,
};
#[cfg(feature = "registry")]
pub use client::{FetchedManifest, RegistryClient, RegistryConfig};
#[cfg(feature = "registry")]
pub use pull::{pull_image, ImportOutcome, ImportRequest, RegistryDigestGrant};
#[cfg(feature = "registry")]
pub use push::{export_layout, push_image, push_tag, LayoutExport, PushOutcome};
#[cfg(feature = "registry")]
pub use sdk::{ingest_image, ingest_pinned, ImageReference, VerifiedImage};
#[cfg(feature = "registry-service")]
pub use service::{
    AllowAllAuthorizer, Authorization, DenyAllAuthorizer, NoPublisher, RegistryAction,
    RegistryAuthorizer, RegistryMode, RegistryService, RepositoryPublisher,
};

/// Default bound for Manifest/Index/Config JSON responses.
#[cfg(feature = "registry")]
pub const DEFAULT_MAX_JSON_BYTES: u64 = 4 * 1024 * 1024;
/// Default bound for authentication token responses.
#[cfg(feature = "registry")]
pub const DEFAULT_MAX_TOKEN_BYTES: u64 = 1024 * 1024;
/// Default redirect bound for one logical request.
#[cfg(feature = "registry")]
pub const DEFAULT_MAX_REDIRECTS: usize = 5;
/// The OCI Distribution version prefix.
pub const DISTRIBUTION_PREFIX: &str = "v2";
/// The media types accepted when resolving a Manifest or Index.
pub const MANIFEST_ACCEPT: &str =
    "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json";
/// The media type used for an untyped blob transfer.
pub const OCTET_STREAM: &str = "application/octet-stream";

/// The explicit failure classes a registry operation can produce.
///
/// Variants carry only resource names, digests, hosts and numeric status. No
/// variant carries an authorization header, token, password or credential.
#[cfg(feature = "registry")]
#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("invalid OCI registry endpoint: {0}")]
    InvalidEndpoint(String),
    #[error("invalid OCI registry reference: {0}")]
    InvalidReference(String),
    #[error("unsupported image platform: {0}")]
    UnsupportedPlatform(String),
    #[error("malformed OCI manifest: {0}")]
    MalformedManifest(String),
    #[error("malformed OCI index: {0}")]
    MalformedIndex(String),
    #[error("malformed OCI config: {0}")]
    MalformedConfig(String),
    #[error("malformed registry response: {0}")]
    MalformedResponse(String),
    #[error("registry authentication challenge was refused: {0}")]
    AuthChallenge(String),
    #[error("registry authentication was denied for {0}")]
    AuthDenied(String),
    #[error("registry authorization host {0} is not allowed")]
    AuthHostRefused(String),
    #[error("registry request to {0} is not authorized")]
    Unauthorized(String),
    #[error("registry forbidden {0}")]
    Forbidden(String),
    #[error("registry object {0} was not found")]
    NotFound(String),
    #[error("registry import into {0} was denied by server policy")]
    ImportDenied(String),
    #[error("redirect from {from} to {to} was refused")]
    RedirectRefused { from: String, to: String },
    #[error("too many redirects for {0}")]
    TooManyRedirects(String),
    #[error("registry response for {resource} exceeds the {limit}-byte bound")]
    ResponseTooLarge { resource: String, limit: u64 },
    #[error("digest mismatch for {resource}: expected {expected}, got {actual}")]
    DigestMismatch {
        resource: String,
        expected: String,
        actual: String,
    },
    #[error("size mismatch for {resource}: expected {expected}, got {actual}")]
    SizeMismatch {
        resource: String,
        expected: u64,
        actual: u64,
    },
    #[error("media type mismatch for {resource}: expected {expected}, got {actual}")]
    MediaTypeMismatch {
        resource: String,
        expected: String,
        actual: String,
    },
    #[error("transfer for {0} was interrupted")]
    TransferInterrupted(String),
    #[error("registry upload for {resource} failed with status {status}")]
    UploadFailed { resource: String, status: u16 },
    #[error("registry transport failed for {resource}: {source}")]
    Transport {
        resource: String,
        source: reqwest::Error,
    },
    #[error("local image operation failed: {0}")]
    Local(String),
}

#[cfg(feature = "registry")]
impl From<anyhow::Error> for RegistryError {
    fn from(error: anyhow::Error) -> RegistryError {
        RegistryError::Local(format!("{error:#}"))
    }
}

/// The result type used by registry client operations.
#[cfg(feature = "registry")]
pub type RegistryResult<T> = std::result::Result<T, RegistryError>;

/// The normalized authority of one registry endpoint.
///
/// This is the scope passed to a credential provider. It contains no
/// credential and cannot name a second registry by accident.
#[cfg(feature = "registry")]
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RegistryAuthority {
    pub scheme: String,
    pub host: String,
    pub port: u16,
}

#[cfg(feature = "registry")]
impl RegistryAuthority {
    fn from_url(url: &Url) -> RegistryResult<Self> {
        let scheme = url.scheme().to_string();
        if scheme != "https" && scheme != "http" {
            return Err(RegistryError::InvalidEndpoint(
                "registry URL scheme must be https or http".to_string(),
            ));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(RegistryError::InvalidEndpoint(
                "registry URL must not contain credentials".to_string(),
            ));
        }
        let Some(host) = url.host_str() else {
            return Err(RegistryError::InvalidEndpoint(
                "registry URL must name a host".to_string(),
            ));
        };
        if host.is_empty() || host.chars().any(char::is_control) {
            return Err(RegistryError::InvalidEndpoint(
                "registry URL has an invalid host".to_string(),
            ));
        }
        let Some(port) = url.port_or_known_default() else {
            return Err(RegistryError::InvalidEndpoint(
                "registry URL must name a resolvable port".to_string(),
            ));
        };
        if scheme == "http" && !is_loopback_host(host) {
            return Err(RegistryError::InvalidEndpoint(
                "plaintext http registries are allowed only on loopback; use https".to_string(),
            ));
        }
        Ok(Self {
            scheme,
            host: host.to_ascii_lowercase(),
            port,
        })
    }

    /// A stable `host:port` label safe for diagnostics.
    pub fn label(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

#[cfg(feature = "registry")]
impl fmt::Display for RegistryAuthority {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}://{}:{}", self.scheme, self.host, self.port)
    }
}

#[cfg(feature = "registry")]
pub(crate) fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host == "127.0.0.1"
        || host == "[::1]"
        || host == "::1"
}

/// One mutable remote reference: a tag or an immutable digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteReference {
    Tag(String),
    Digest(String),
}

impl RemoteReference {
    /// Parse an OCI Distribution tag or sha256 digest reference.
    pub fn parse(value: &str) -> Result<Self, String> {
        if value.starts_with(crate::digest::DIGEST_PREFIX) {
            if !crate::digest::is_valid_digest(value) {
                return Err("digest must be sha256:<64 lowercase hex>".to_string());
            }
            return Ok(Self::Digest(value.to_string()));
        }
        if value.contains(':') {
            return Err("only sha256 digest references are supported".to_string());
        }
        validate_remote_tag(value)?;
        Ok(Self::Tag(value.to_string()))
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::Tag(value) | Self::Digest(value) => value,
        }
    }

    pub fn digest(&self) -> Option<&str> {
        match self {
            Self::Tag(_) => None,
            Self::Digest(value) => Some(value),
        }
    }
}

/// Validate the OCI Distribution tag grammar (`[A-Za-z0-9_][A-Za-z0-9._-]{0,127}`).
pub fn validate_remote_tag(tag: &str) -> Result<(), String> {
    if tag.is_empty() || tag.len() > 128 {
        return Err("tag must be 1..=128 bytes".to_string());
    }
    let mut characters = tag.chars();
    let Some(first) = characters.next() else {
        return Err("tag must not be empty".to_string());
    };
    if !first.is_ascii_alphanumeric() && first != '_' {
        return Err(format!(
            "tag {tag:?} must start with an alphanumeric character or underscore"
        ));
    }
    if let Some(character) = characters.find(|character| {
        !(character.is_ascii_alphanumeric()
            || *character == '.'
            || *character == '_'
            || *character == '-')
    }) {
        return Err(format!(
            "tag {tag:?} contains an unsupported character {character:?}"
        ));
    }
    Ok(())
}

/// Validate an OCI Distribution repository path with the catalog's rule.
///
/// The remote name is deliberately held to the same lowercase segment grammar
/// as the local repository, so a remote name can never be used to build a
/// surprising URL or a second catalog identity.
#[cfg(feature = "registry")]
pub fn validate_remote_repository(repository: &str) -> RegistryResult<()> {
    crate::catalog::validate_repository_name(repository)
        .map_err(|error| RegistryError::InvalidReference(format!("{error:#}")))
}

/// Whether an authority is exactly the configured registry authority.
#[cfg(feature = "registry")]
pub(crate) fn same_authority(left: &RegistryAuthority, right: &RegistryAuthority) -> bool {
    left.scheme.eq_ignore_ascii_case(&right.scheme)
        && left.host.eq_ignore_ascii_case(&right.host)
        && left.port == right.port
}

/// Whether `url` matches an explicitly allowed `host` or `host:port` entry.
#[cfg(feature = "registry")]
pub(crate) fn host_entry_matches(url: &Url, entries: &[String]) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let port = url.port_or_known_default();
    entries.iter().any(|entry| {
        let entry = entry.trim();
        if entry.is_empty() {
            return false;
        }
        let (entry_host, entry_port) = split_host_entry(entry);
        host.eq_ignore_ascii_case(entry_host)
            && entry_port.is_none_or(|expected| Some(expected) == port)
    })
}

#[cfg(feature = "registry")]
fn split_host_entry(entry: &str) -> (&str, Option<u16>) {
    if entry.starts_with('[') {
        if let Some(end) = entry.find(']') {
            let host = entry.get(..=end).unwrap_or(entry);
            let rest = entry.get(end + 1..).unwrap_or_default();
            let port = rest
                .strip_prefix(':')
                .and_then(|value| value.parse::<u16>().ok());
            return (host, port);
        }
        return (entry, None);
    }
    match entry.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => match port.parse::<u16>() {
            Ok(port) => (host, Some(port)),
            _ => (host, None),
        },
        _ => (entry, None),
    }
}

/// The default timeout for a complete registry request.
#[cfg(feature = "registry")]
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// The default connection timeout for a registry request.
#[cfg(feature = "registry")]
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

#[cfg(all(test, feature = "registry"))]
mod tests {
    use super::*;

    #[test]
    fn remote_references_accept_tags_and_sha256_only() {
        assert_eq!(
            RemoteReference::parse("v1.2").unwrap(),
            RemoteReference::Tag("v1.2".to_string())
        );
        let digest = format!("sha256:{}", "a".repeat(64));
        assert_eq!(
            RemoteReference::parse(&digest).unwrap(),
            RemoteReference::Digest(digest)
        );
        for invalid in [
            "",
            "-leading",
            "with/slash",
            "sha256:abc",
            "md5:abcd",
            "has space",
        ] {
            assert!(
                RemoteReference::parse(invalid).is_err(),
                "{invalid:?} must be refused"
            );
        }
    }

    #[test]
    fn plaintext_registries_are_loopback_only() {
        let local =
            RegistryAuthority::from_url(&Url::parse("http://127.0.0.1:5000").unwrap()).unwrap();
        assert_eq!(local.port, 5000);
        assert!(
            RegistryAuthority::from_url(&Url::parse("http://registry.example:5000").unwrap())
                .is_err()
        );
        assert!(
            RegistryAuthority::from_url(&Url::parse("https://registry.example").unwrap()).is_ok()
        );
        assert!(RegistryAuthority::from_url(
            &Url::parse("https://user:password@registry.example").unwrap()
        )
        .is_err());
    }

    #[test]
    fn allowed_host_entries_match_host_and_optional_port() {
        let url = Url::parse("http://127.0.0.1:5000/x").unwrap();
        assert!(host_entry_matches(&url, &["127.0.0.1".to_string()]));
        assert!(host_entry_matches(&url, &["127.0.0.1:5000".to_string()]));
        assert!(!host_entry_matches(&url, &["127.0.0.1:5001".to_string()]));
        assert!(!host_entry_matches(&url, &["localhost".to_string()]));
    }
}
