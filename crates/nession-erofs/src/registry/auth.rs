//! Registry challenge parsing, credential supply and import authorization.
//!
//! This module owns the security boundary, not the policy:
//!
//! - the Server implements [`RegistryCredentialProvider`] over its secret
//!   source and [`RegistryImportAuthorizer`] over Project/Session/tenant
//!   access rules;
//! - the crate never stores credentials in an image object, grant, diagnostic
//!   or error and never asks an authorizer for a credential;
//! - challenge scopes are checked against the repository actually requested,
//!   so a registry cannot redirect a token request to a different repository.

use std::fmt;

use base64::Engine;

use super::{RegistryAuthority, RegistryError, RegistryResult};

/// The maximum accepted `WWW-Authenticate` length.
pub const MAX_CHALLENGE_BYTES: usize = 8 * 1024;
/// The maximum accepted credential field length.
pub const MAX_CREDENTIAL_BYTES: usize = 4096;

/// One Basic credential supplied by the Server-owned secret source.
///
/// The fields are private and [`fmt::Debug`] is redacted. There is deliberately
/// no `Display`, `Serialize` or public accessor: a caller that needs a header
/// asks the client to make one request, it never receives the secret itself.
#[derive(Clone)]
pub struct RegistryCredential {
    username: String,
    password: String,
}

impl RegistryCredential {
    /// Validate and wrap one credential.
    pub fn new(username: impl Into<String>, password: impl Into<String>) -> RegistryResult<Self> {
        let username = username.into();
        let password = password.into();
        if username.is_empty() {
            return Err(RegistryError::AuthChallenge(
                "registry credential username must not be empty".to_string(),
            ));
        }
        if username.len() > MAX_CREDENTIAL_BYTES
            || password.len() > MAX_CREDENTIAL_BYTES
            || username.chars().any(char::is_control)
            || password.chars().any(char::is_control)
        {
            return Err(RegistryError::AuthChallenge(
                "registry credential contains unsupported bytes".to_string(),
            ));
        }
        if username.contains(':') {
            return Err(RegistryError::AuthChallenge(
                "registry credential username must not contain ':'".to_string(),
            ));
        }
        Ok(Self { username, password })
    }

    /// Build the Basic authorization value for the token endpoint.
    ///
    /// The result contains the secret and is passed directly to a request
    /// header; callers must never format, log or store it.
    pub(crate) fn basic_authorization(&self) -> String {
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", self.username, self.password));
        format!("Basic {encoded}")
    }
}

impl fmt::Debug for RegistryCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RegistryCredential(<redacted>)")
    }
}

/// Supplies credentials for exactly one registry authority and repository.
///
/// The Server owns the implementation and its secret source. Returning `None`
/// is normal for an anonymous/public registry; it is never an error that would
/// leak whether a secret exists.
pub trait RegistryCredentialProvider: Send + Sync {
    fn credential_for(
        &self,
        authority: &RegistryAuthority,
        repository: &str,
    ) -> Option<RegistryCredential>;
}

/// A provider for registries that need no credential.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoCredentials;

impl RegistryCredentialProvider for NoCredentials {
    fn credential_for(
        &self,
        _authority: &RegistryAuthority,
        _repository: &str,
    ) -> Option<RegistryCredential> {
        None
    }
}

/// The facts a Server-owned access policy needs before an import starts.
///
/// It carries no credential and no image bytes. The authorizer runs before any
/// network request, so a denied import cannot even reveal whether the remote
/// object exists.
#[derive(Debug)]
pub struct ImportScope<'a> {
    pub authority: &'a RegistryAuthority,
    pub repository: &'a str,
    pub local_repository: &'a str,
    pub local_tag: &'a str,
    pub platform: &'a crate::oci::Platform,
}

/// Server-owned import authorization.
///
/// Implementations decide Project/Session/tenant visibility. The crate calls
/// this before the first HTTP request and before any catalog write; it does
/// not provide a permissive default for production callers.
pub trait RegistryImportAuthorizer: Send + Sync {
    fn authorize_import(&self, scope: &ImportScope<'_>) -> RegistryResult<()>;
}

/// A test/trusted-internal authorizer that approves every import.
#[derive(Debug, Default, Clone, Copy)]
pub struct AllowAllImports;

impl RegistryImportAuthorizer for AllowAllImports {
    fn authorize_import(&self, _scope: &ImportScope<'_>) -> RegistryResult<()> {
        Ok(())
    }
}

/// Explicitly approves nothing. Useful as the default of a new adapter.
#[derive(Debug, Default, Clone, Copy)]
pub struct DenyAllImports;

impl RegistryImportAuthorizer for DenyAllImports {
    fn authorize_import(&self, scope: &ImportScope<'_>) -> RegistryResult<()> {
        Err(RegistryError::ImportDenied(
            scope.local_repository.to_string(),
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChallengeScheme {
    Bearer,
    Basic,
}

/// One parsed `WWW-Authenticate` challenge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AuthChallenge {
    pub scheme: ChallengeScheme,
    pub realm: Option<String>,
    pub service: Option<String>,
    pub scope: Option<String>,
    pub error: Option<String>,
}

impl AuthChallenge {
    pub fn required_realm(&self) -> RegistryResult<&str> {
        self.realm
            .as_deref()
            .filter(|realm| !realm.is_empty())
            .ok_or_else(|| {
                RegistryError::AuthChallenge("challenge has no usable realm".to_string())
            })
    }
}

/// Parse one Bearer or Basic challenge from a `WWW-Authenticate` value.
pub(crate) fn parse_challenge(value: &str) -> RegistryResult<AuthChallenge> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_CHALLENGE_BYTES {
        return Err(RegistryError::AuthChallenge(
            "authentication challenge is missing or too large".to_string(),
        ));
    }
    let Some((scheme, rest)) = value.split_once(char::is_whitespace) else {
        return Err(RegistryError::AuthChallenge(
            "authentication challenge has no parameters".to_string(),
        ));
    };
    let scheme = match scheme.to_ascii_lowercase().as_str() {
        "bearer" => ChallengeScheme::Bearer,
        "basic" => ChallengeScheme::Basic,
        other => {
            return Err(RegistryError::AuthChallenge(format!(
                "unsupported authentication scheme {other:?}"
            )));
        }
    };
    let params = parse_parameters(rest)?;
    if scheme == ChallengeScheme::Bearer && !params.iter().any(|(key, _)| key == "realm") {
        return Err(RegistryError::AuthChallenge(
            "Bearer challenge has no realm".to_string(),
        ));
    }
    let find = |name: &str| {
        params
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
    };
    Ok(AuthChallenge {
        scheme,
        realm: find("realm"),
        service: find("service"),
        scope: find("scope"),
        error: find("error"),
    })
}

fn parse_parameters(input: &str) -> RegistryResult<Vec<(String, String)>> {
    let mut parameters = Vec::new();
    let mut rest = input.trim_start();
    while !rest.is_empty() {
        rest = rest.trim_start_matches([',', ' ']);
        if rest.is_empty() {
            break;
        }
        let Some(equals) = rest.find('=') else {
            return Err(RegistryError::AuthChallenge(
                "authentication parameter is missing '='".to_string(),
            ));
        };
        let key = rest
            .get(..equals)
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if key.is_empty() || key.chars().any(|character| !is_token_char(character)) {
            return Err(RegistryError::AuthChallenge(
                "authentication parameter has an invalid name".to_string(),
            ));
        }
        let after = rest.get(equals + 1..).unwrap_or_default().trim_start();
        let (value, remainder) = if let Some(quoted) = after.strip_prefix('"') {
            parse_quoted(quoted)?
        } else {
            let end = after
                .find(|character: char| character == ',' || character.is_ascii_whitespace())
                .unwrap_or(after.len());
            (
                after.get(..end).unwrap_or_default().to_string(),
                after.get(end..).unwrap_or_default(),
            )
        };
        if value.chars().any(char::is_control) {
            return Err(RegistryError::AuthChallenge(
                "authentication parameter contains control characters".to_string(),
            ));
        }
        if parameters.iter().any(|(existing, _)| existing == &key) {
            return Err(RegistryError::AuthChallenge(
                "authentication challenge repeats a parameter".to_string(),
            ));
        }
        parameters.push((key, value));
        rest = remainder.trim_start_matches([',', ' ']);
    }
    Ok(parameters)
}

fn parse_quoted(input: &str) -> RegistryResult<(String, &str)> {
    let mut value = String::new();
    let mut characters = input.char_indices();
    while let Some((index, character)) = characters.next() {
        match character {
            '"' => {
                return Ok((value, input.get(index + 1..).unwrap_or_default()));
            }
            '\\' => {
                let Some((_, escaped)) = characters.next() else {
                    break;
                };
                value.push(escaped);
            }
            _ => value.push(character),
        }
    }
    Err(RegistryError::AuthChallenge(
        "authentication parameter has an unterminated quote".to_string(),
    ))
}

fn is_token_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '*')
}

/// Refuse a challenge scope that names any repository other than the requested
/// one. Actions are intentionally not trusted; the client requests its own
/// least-privilege scope.
pub(crate) fn validate_challenge_scope(scope: &str, repository: &str) -> RegistryResult<()> {
    if scope.len() > MAX_CHALLENGE_BYTES {
        return Err(RegistryError::AuthChallenge(
            "authentication scope is too large".to_string(),
        ));
    }
    for entry in scope.split_whitespace() {
        let mut parts = entry.splitn(3, ':');
        let kind = parts.next().unwrap_or_default();
        let resource = parts.next().unwrap_or_default();
        let actions = parts.next().unwrap_or_default();
        if kind != "repository" || actions.is_empty() {
            return Err(RegistryError::AuthChallenge(
                "authentication scope is not a repository scope".to_string(),
            ));
        }
        if resource != repository {
            return Err(RegistryError::AuthChallenge(
                "authentication scope names a different repository".to_string(),
            ));
        }
    }
    Ok(())
}

/// The least-privilege scope the client asks a token service for.
pub(crate) fn requested_scope(repository: &str, actions: &str) -> RegistryResult<String> {
    if !actions
        .split(',')
        .all(|action| action == "pull" || action == "push")
    {
        return Err(RegistryError::AuthChallenge(
            "unsupported registry action".to_string(),
        ));
    }
    Ok(format!("repository:{repository}:{actions}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_and_basic_challenges_parse_without_losing_params() {
        let bearer = parse_challenge(
            r#"Bearer realm="https://auth.example/token",service="registry",scope="repository:team/app:pull,push",error="insufficient_scope""#,
        )
        .unwrap();
        assert_eq!(bearer.scheme, ChallengeScheme::Bearer);
        assert_eq!(bearer.realm.as_deref(), Some("https://auth.example/token"));
        assert_eq!(bearer.service.as_deref(), Some("registry"));
        assert_eq!(
            bearer.scope.as_deref(),
            Some("repository:team/app:pull,push")
        );
        assert_eq!(bearer.error.as_deref(), Some("insufficient_scope"));

        let basic = parse_challenge(r#"Basic realm="registry""#).unwrap();
        assert_eq!(basic.scheme, ChallengeScheme::Basic);
        assert_eq!(basic.realm.as_deref(), Some("registry"));

        assert!(parse_challenge("").is_err());
        assert!(parse_challenge("Bearer service=\"registry\"").is_err());
        assert!(parse_challenge("Digest realm=\"x\"").is_err());
        assert!(parse_challenge(r#"Bearer realm="unterminated"#).is_err());
        assert!(parse_challenge(r#"Bearer realm="a",realm="b""#).is_err());
    }

    #[test]
    fn a_challenge_scope_cannot_name_a_second_repository() {
        validate_challenge_scope("repository:team/app:pull,push", "team/app").unwrap();
        let error = validate_challenge_scope("repository:other/app:pull", "team/app").unwrap_err();
        assert!(error.to_string().contains("different repository"));
        assert!(validate_challenge_scope("registry:catalog:*", "team/app").is_err());
        assert_eq!(
            requested_scope("team/app", "pull").unwrap(),
            "repository:team/app:pull"
        );
        assert!(requested_scope("team/app", "delete").is_err());
    }

    #[test]
    fn credentials_are_redacted_and_basic_encoding_is_private() {
        let credential =
            RegistryCredential::new("robot", "super-secret-value").expect("valid credential");
        let debug = format!("{credential:?}");
        assert!(!debug.contains("robot"));
        assert!(!debug.contains("super-secret-value"));
        assert_eq!(
            credential.basic_authorization(),
            "Basic cm9ib3Q6c3VwZXItc2VjcmV0LXZhbHVl"
        );
        assert!(RegistryCredential::new("", "x").is_err());
        assert!(RegistryCredential::new("a:b", "x").is_err());
        assert!(RegistryCredential::new("robot", "line\nbreak").is_err());
    }

    #[test]
    fn the_authorization_boundary_denies_before_any_scope_is_trusted() {
        let authority = RegistryAuthority {
            scheme: "https".to_string(),
            host: "registry.example".to_string(),
            port: 443,
        };
        let platform = crate::oci::Platform {
            os: "linux".to_string(),
            architecture: "amd64".to_string(),
            os_features: Some(vec!["erofs".to_string()]),
            ..crate::oci::Platform::default()
        };
        let scope = ImportScope {
            authority: &authority,
            repository: "team/app",
            local_repository: "tenant-a/app",
            local_tag: "v1",
            platform: &platform,
        };
        assert!(DenyAllImports.authorize_import(&scope).is_err());
        AllowAllImports.authorize_import(&scope).unwrap();
    }
}
