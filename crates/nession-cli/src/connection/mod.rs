//! Where a **remote** CLI command connects, and as whom (#2267, #4682).
//!
//! This is deliberately a different owner from [`crate::configuration`]. The
//! daemon configs describe an Agent/Server; `agents`/`sessions` are remote
//! consumers and never borrow a daemon credential. The one
//! [`ConnectionContext`] resolver resolves target **and credential as a pair**
//! for every remote leaf (and `profile test`), so two commands cannot disagree.
//!
//! Target precedence:
//!
//! 1. the explicit `--server-url` flag (stateless: never reads the store);
//! 2. the explicit `--profile` flag (overrides ambient URL variables);
//! 3. `NESSION_SERVER_URL`, then the legacy `NENSION_SERVER_URL`;
//! 4. `NESSION_PROFILE`;
//! 5. the persisted current profile;
//! 6. the one-time Agent endpoint bootstrap (endpoint only, never a daemon
//!    credential; only when no client store exists);
//! 7. the documented loopback default.
//!
//! `--server-url` and `--profile` together are rejected as ambiguous. An
//! explicit `--auth-token` deliberately binds to this invocation's resolved
//! target. An ambient token is allowed for the legacy flag/env/default flows,
//! or when an accompanying ambient URL is the same canonical endpoint — never
//! silently applied to a selected named profile or imported endpoint. A
//! profile otherwise uses only its endpoint-bound credential or explicitly
//! configured no-auth; an unconfigured profile refuses with setup guidance.
//!
//! `agent start`/`restart` keep the separate daemon override path
//! ([`environment_server_url`]/[`environment_auth_token`]); profile resolution
//! never runs there.

use anyhow::{bail, Context, Result};

use nession_client::{ClientConfig, ClientConnection};

use crate::profile::{self, canonical_endpoint, store, CredentialState};

/// Default server URL (ws://127.0.0.1:8080).
pub const DEFAULT_SERVER_URL: &str = "ws://127.0.0.1:8080";

/// Default auth token (empty string; set `auth_token` for an authenticated Server).
pub const DEFAULT_AUTH_TOKEN: &str = "";

/// Canonical environment name for the CLI's remote Server target.
pub const SERVER_URL_ENV: &str = "NESSION_SERVER_URL";

/// Canonical environment name for the CLI's remote credential.
pub const AUTH_TOKEN_ENV: &str = "NESSION_AUTH_TOKEN";

/// Legacy (pre-#2267) spelling of [`SERVER_URL_ENV`], kept as a deprecated
/// alias so an existing environment keeps working.
pub const SERVER_URL_LEGACY_ENV: &str = "NENSION_SERVER_URL";

/// Legacy (pre-#2267) spelling of [`AUTH_TOKEN_ENV`], kept as a deprecated
/// alias so an existing environment keeps working.
pub const AUTH_TOKEN_LEGACY_ENV: &str = "NENSION_AUTH_TOKEN";

/// Environment name selecting a named client profile for one invocation.
pub const PROFILE_ENV: &str = "NESSION_PROFILE";

/// The environment-provided target, without the loopback default.
///
/// `agent start`/`restart` consume the same global flag as a *daemon* override:
/// an explicit flag or environment value replaces the config file's value, and
/// absence leaves the config alone. This is the part of the old Clap `env`
/// behavior that must be preserved; the default belongs only to remote client
/// commands, where it is an actual target rather than a file override.
pub fn environment_server_url() -> Option<String> {
    std::env::var(SERVER_URL_ENV)
        .ok()
        .or_else(|| std::env::var(SERVER_URL_LEGACY_ENV).ok())
}

pub fn environment_auth_token() -> Option<String> {
    std::env::var(AUTH_TOKEN_ENV)
        .ok()
        .or_else(|| std::env::var(AUTH_TOKEN_LEGACY_ENV).ok())
}

/// The per-invocation inputs a remote leaf hands the resolver.
#[derive(Debug, Clone, Default)]
pub struct RemoteInputs {
    pub server_url: Option<String>,
    pub profile: Option<String>,
    pub auth_token: Option<String>,
}

/// Which precedence step selected the target (diagnostics, never a secret).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetSource {
    Flag,
    ProfileFlag,
    EnvCanonical,
    EnvLegacy,
    EnvProfile,
    Current,
    Test,
    Loopback,
}

impl TargetSource {
    pub fn label(self) -> &'static str {
        match self {
            Self::Flag => "--server-url",
            Self::ProfileFlag => "--profile",
            Self::EnvCanonical => SERVER_URL_ENV,
            Self::EnvLegacy => SERVER_URL_LEGACY_ENV,
            Self::EnvProfile => PROFILE_ENV,
            Self::Current => "current profile",
            Self::Test => "profile test",
            Self::Loopback => "loopback default",
        }
    }
}

/// Which credential policy produced the token (diagnostics, never the token).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialSource {
    Flag,
    Env,
    AmbientMatchingEndpoint,
    ProfileCredential,
    NoAuth,
    EmptyDefault,
}

impl CredentialSource {
    pub fn label(self) -> &'static str {
        match self {
            Self::Flag => "--auth-token",
            Self::Env => "ambient token",
            Self::AmbientMatchingEndpoint => "ambient token (matching endpoint)",
            Self::ProfileCredential => "profile credential",
            Self::NoAuth => "no-auth",
            Self::EmptyDefault => "empty default",
        }
    }
}

/// The resolved target/credential pair for one remote invocation.
#[derive(Debug, Clone)]
pub struct ConnectionContext {
    pub server_url: String,
    pub auth_token: String,
    pub profile: Option<String>,
    pub target_source: TargetSource,
    pub credential_source: CredentialSource,
}

/// Resolve the remote connection context for `agents`/`sessions` leaves.
pub async fn resolve_remote(inputs: RemoteInputs) -> Result<ConnectionContext> {
    if inputs.server_url.is_some() && inputs.profile.is_some() {
        bail!(
            "--server-url and --profile are ambiguous together: --server-url is an explicit \
             stateless target and --profile selects a stored connection context. Pass one or \
             the other (this is the documented exception to target precedence)."
        );
    }

    // 1. Explicit flag target: a safe stateless path that never consumes the
    //    client store, so a corrupt store cannot break it.
    if let Some(url) = inputs.server_url {
        let (token, credential_source) = flag_or_ambient_token(inputs.auth_token);
        return Ok(ConnectionContext {
            server_url: url,
            auth_token: token,
            profile: None,
            target_source: TargetSource::Flag,
            credential_source,
        });
    }

    // 2. Explicit named profile overrides ambient URL variables.
    if let Some(name) = inputs.profile {
        return resolve_named(&name, inputs.auth_token, TargetSource::ProfileFlag).await;
    }

    // 3/4. Ambient URL (canonical then legacy): the legacy explicit-env flow.
    if let Some(url) = environment_server_url() {
        let target_source = if std::env::var(SERVER_URL_ENV).is_ok() {
            TargetSource::EnvCanonical
        } else {
            TargetSource::EnvLegacy
        };
        let (token, credential_source) = flag_or_ambient_token(inputs.auth_token);
        return Ok(ConnectionContext {
            server_url: url,
            auth_token: token,
            profile: None,
            target_source,
            credential_source,
        });
    }

    // 5. Ambient named profile.
    if let Ok(name) = std::env::var(PROFILE_ENV) {
        return resolve_named(&name, inputs.auth_token, TargetSource::EnvProfile).await;
    }

    // 6/7. The persisted installation client context.
    if let Some(loc) = store::StoreLocation::locate()? {
        match store::load(&loc)? {
            Some(file) => {
                let Some(current) = file.current_profile.clone() else {
                    bail!(
                        "the client connection store at {} has no selected profile; select one \
                         explicitly with `nession profile use <name>` (see `nession profile \
                         list`), or pass --profile/--server-url. Bootstrap does not run again \
                         once a store exists.",
                        loc.config_path().display()
                    );
                };
                let entry = file
                    .profiles
                    .get(&current)
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("current profile {current:?} vanished"))?;
                return resolve_entry(
                    &loc,
                    &current,
                    &entry,
                    inputs.auth_token,
                    false,
                    TargetSource::Current,
                )
                .await;
            }
            None => {
                // First-use bootstrap: endpoint only, and only a writable
                // installation context (never a dispatched archive).
                if !loc.read_only {
                    if let Some(endpoint) = bootstrap_endpoint()? {
                        let file = store::bootstrap_import(&loc, &endpoint)?;
                        let name = file
                            .current_profile
                            .clone()
                            .unwrap_or_else(|| profile::DEFAULT_IMPORTED_PROFILE.to_string());
                        let entry =
                            file.profiles.get(&name).cloned().ok_or_else(|| {
                                anyhow::anyhow!("imported profile {name:?} vanished")
                            })?;
                        return resolve_entry(
                            &loc,
                            &name,
                            &entry,
                            inputs.auth_token,
                            false,
                            TargetSource::Current,
                        )
                        .await;
                    }
                }
            }
        }
    }

    // 8. Legacy loopback default (token-only env backward compatibility).
    let (token, credential_source) = flag_or_ambient_token(inputs.auth_token);
    Ok(ConnectionContext {
        server_url: DEFAULT_SERVER_URL.to_string(),
        auth_token: token,
        profile: None,
        target_source: TargetSource::Loopback,
        credential_source,
    })
}

/// Resolve a profile for `profile test`: the named profile (or the current
/// selection) with its own stored credential policy. Ambient tokens never
/// apply — a test proves what the profile itself would send.
pub async fn resolve_profile_for_test(name: Option<String>) -> Result<ConnectionContext> {
    let Some(loc) = store::StoreLocation::locate()? else {
        bail!(
            "no client connection store is available to this release; run `profile test` on \
             Current (without a version selector)."
        );
    };
    let file = store::load(&loc)?.ok_or_else(|| {
        anyhow::anyhow!(
            "no client connection store at {}; nothing to test. Add a profile: \
             nession profile add home --server-url <url>.",
            loc.config_path().display()
        )
    })?;
    let name = match name {
        Some(name) => name,
        None => file.current_profile.clone().ok_or_else(|| {
            anyhow::anyhow!(
                "no profile selected to test; name one explicitly: nession profile test <name>"
            )
        })?,
    };
    let entry = file.profiles.get(&name).ok_or_else(|| {
        anyhow::anyhow!(
            "unknown profile {name:?}; run `nession profile list` to see the stored profiles"
        )
    })?;
    resolve_entry(&loc, &name, entry, None, false, TargetSource::Test).await
}

/// Resolve an explicitly named profile (flag or `NESSION_PROFILE`). Missing or
/// invalid stores/profiles fail closed; ambient URL variables do not apply.
async fn resolve_named(
    name: &str,
    flag_token: Option<String>,
    target_source: TargetSource,
) -> Result<ConnectionContext> {
    let Some(loc) = store::StoreLocation::locate()? else {
        bail!(
            "no client connection store is available to this release; profile {name:?} cannot \
             be resolved. Run on Current (without a version selector) or pass --server-url."
        );
    };
    let file = store::load(&loc)?.ok_or_else(|| {
        anyhow::anyhow!(
            "unknown profile {name:?}: no client connection store at {}. Create it with \
             `nession profile add {name} --server-url <url>`.",
            loc.config_path().display()
        )
    })?;
    let entry = file.profiles.get(name).ok_or_else(|| {
        anyhow::anyhow!(
            "unknown profile {name:?}; run `nession profile list` to see the stored profiles"
        )
    })?;
    resolve_entry(&loc, name, entry, flag_token, true, target_source).await
}

/// Resolve one profile entry's target/credential pair.
async fn resolve_entry(
    loc: &store::StoreLocation,
    name: &str,
    entry: &profile::ProfileEntry,
    flag_token: Option<String>,
    allow_ambient_matching: bool,
    target_source: TargetSource,
) -> Result<ConnectionContext> {
    let target = entry.server_url.clone();
    let (token, credential_source) = if let Some(token) = flag_token {
        // An explicit credential deliberately binds to this invocation's
        // resolved target, whatever selected it.
        (token, CredentialSource::Flag)
    } else if allow_ambient_matching
        && environment_server_url()
            .is_some_and(|url| canonical_endpoint(&url) == canonical_endpoint(&target))
    {
        match environment_auth_token() {
            Some(token) => (token, CredentialSource::AmbientMatchingEndpoint),
            None => profile_credential(loc, name, entry).await?,
        }
    } else {
        profile_credential(loc, name, entry).await?
    };
    Ok(ConnectionContext {
        server_url: target,
        auth_token: token,
        profile: Some(name.to_string()),
        target_source,
        credential_source,
    })
}

/// A named/current profile uses only its endpoint-bound credential or its
/// explicitly configured no-auth. Anything else refuses with guidance.
async fn profile_credential(
    loc: &store::StoreLocation,
    name: &str,
    entry: &profile::ProfileEntry,
) -> Result<(String, CredentialSource)> {
    match entry.credential_state() {
        CredentialState::NoAuth => Ok((String::new(), CredentialSource::NoAuth)),
        CredentialState::Bound(kind) => {
            let record = profile::credential::get_bound(loc, name, kind)
                .await?
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "profile {name:?} references a credential that is not stored; \
                         reconfigure it with `nession profile credential set {name}`"
                    )
                })?;
            if !record.matches_endpoint(&entry.server_url) {
                bail!(
                    "the credential stored for profile {name:?} is bound to a different \
                     endpoint; changing a profile's endpoint invalidates its credential. \
                     Reconfigure it with `nession profile credential set {name}`."
                );
            }
            Ok((record.token, CredentialSource::ProfileCredential))
        }
        CredentialState::Unset => bail!(
            "profile {name:?} has no client credential configured (endpoint {}). Set one with \
             `nession profile credential set {name}`, or mark it no-auth with `nession profile \
             set {name} --no-auth`. Daemon credentials are never copied into a client profile.",
            sanitized_endpoint(&entry.server_url)
        ),
    }
}

/// The explicit flag credential, else the ambient token, else the empty
/// default — the legacy flag/env/default credential chain.
fn flag_or_ambient_token(flag: Option<String>) -> (String, CredentialSource) {
    if let Some(token) = flag {
        return (token, CredentialSource::Flag);
    }
    if let Some(token) = environment_auth_token() {
        return (token, CredentialSource::Env);
    }
    (
        DEFAULT_AUTH_TOKEN.to_string(),
        CredentialSource::EmptyDefault,
    )
}

/// The one-time bootstrap endpoint from the canonical Agent config.
///
/// Absent config (or a config without an explicit `server_url`) yields `None`
/// and the legacy loopback remains permitted; an invalid/unreadable config is
/// an actionable error, never a silent fallback or a bogus profile built from
/// `AgentConfig` defaults.
fn bootstrap_endpoint() -> Result<Option<String>> {
    let path = nession_common::paths::agent_config_path()
        .context("failed to determine the Agent config path for endpoint bootstrap")?;
    match profile::read_agent_endpoint_for_bootstrap(&path)? {
        profile::AgentEndpointRead::Endpoint(url) => Ok(Some(url)),
        profile::AgentEndpointRead::Absent | profile::AgentEndpointRead::NoExplicitEndpoint => {
            Ok(None)
        }
    }
}

/// Connect to the Server, with this CLI's own failure sentence attached.
///
/// The boundary reports typed errors and no prose for the shell; where the
/// sentence lives is a CLI decision, which is why `nession-client` has no
/// `anyhow` and this function does.
pub async fn connect(server_url: &str, auth_token: &str) -> Result<ClientConnection> {
    ClientConnection::connect(ClientConfig::new(server_url, auth_token))
        .await
        .with_context(|| "Failed to connect to server. Is the server running?")
}

/// The sanitized connection-context block attached to a remote failure.
///
/// Names the selected profile (if any), the endpoint without userinfo, the
/// target source and the credential policy — never the credential — and the
/// actionable next command.
pub fn failure_context(ctx: &ConnectionContext) -> String {
    let profile_part = match &ctx.profile {
        Some(name) => format!("profile '{name}'"),
        None => "no profile".to_string(),
    };
    let next = match &ctx.profile {
        Some(name) => format!("nession profile test {name}"),
        None => "nession profile import-agent   (or: nession profile add home --server-url <url>)"
            .to_string(),
    };
    format!(
        "{profile_part}; endpoint: {}; target source: {}; credential: {}. Next: {next}",
        sanitized_endpoint(&ctx.server_url),
        ctx.target_source.label(),
        ctx.credential_source.label(),
    )
}

/// An endpoint safe to print: userinfo stripped, even for an unparseable
/// explicit flag value.
pub fn sanitized_endpoint(raw: &str) -> String {
    match url::Url::parse(raw) {
        Ok(mut url) => {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.to_string()
        }
        Err(_) => {
            if let Some((scheme, rest)) = raw.split_once("://") {
                if let Some((_, host)) = rest.rsplit_once('@') {
                    return format!("{scheme}://{host}");
                }
            }
            raw.to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_env::{lock as lock_env, EnvSetting};

    /// Clear every target/credential/profile input so a test starts from the
    /// documented empty environment.
    struct CleanEnv {
        _settings: Vec<EnvSetting>,
    }

    fn clean_env() -> CleanEnv {
        CleanEnv {
            _settings: vec![
                EnvSetting::unset(SERVER_URL_ENV),
                EnvSetting::unset(SERVER_URL_LEGACY_ENV),
                EnvSetting::unset(AUTH_TOKEN_ENV),
                EnvSetting::unset(AUTH_TOKEN_LEGACY_ENV),
                EnvSetting::unset(PROFILE_ENV),
                EnvSetting::unset(crate::versions::NESSION_VERSION_DISPATCHED_ENV),
                EnvSetting::unset(crate::versions::NESSION_CLIENT_HOME_ENV),
            ],
        }
    }

    #[tokio::test]
    async fn the_default_target_is_the_loopback_server() {
        let _env = lock_env().await;
        let _clean = clean_env();
        let dir = tempfile::tempdir().unwrap();
        let _home = EnvSetting::set(
            nession_common::paths::NESSION_HOME_ENV,
            dir.path().to_str().unwrap(),
        );

        let ctx = resolve_remote(RemoteInputs::default()).await.unwrap();
        assert_eq!(ctx.server_url, DEFAULT_SERVER_URL);
        assert_eq!(ctx.auth_token, DEFAULT_AUTH_TOKEN);
        assert_eq!(ctx.target_source, TargetSource::Loopback);
        assert!(!dir.path().join("client-config.toml").exists());
    }

    #[tokio::test]
    async fn the_canonical_environment_names_win_over_the_legacy_aliases() {
        let _env = lock_env().await;
        let _clean = clean_env();
        let dir = tempfile::tempdir().unwrap();
        let _home = EnvSetting::set(
            nession_common::paths::NESSION_HOME_ENV,
            dir.path().to_str().unwrap(),
        );
        let _server = EnvSetting::set(SERVER_URL_ENV, "ws://canonical:1");
        let _server_legacy = EnvSetting::set(SERVER_URL_LEGACY_ENV, "ws://legacy:2");
        let _token = EnvSetting::set(AUTH_TOKEN_ENV, "canonical-token");
        let _token_legacy = EnvSetting::set(AUTH_TOKEN_LEGACY_ENV, "legacy-token");

        let ctx = resolve_remote(RemoteInputs::default()).await.unwrap();
        assert_eq!(ctx.server_url, "ws://canonical:1");
        assert_eq!(ctx.auth_token, "canonical-token");
        assert_eq!(ctx.target_source, TargetSource::EnvCanonical);

        let ctx = resolve_remote(RemoteInputs {
            server_url: Some("ws://flag:3".to_string()),
            auth_token: Some("flag-token".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
        assert_eq!(ctx.server_url, "ws://flag:3");
        assert_eq!(ctx.auth_token, "flag-token");
        assert_eq!(ctx.target_source, TargetSource::Flag);
    }

    #[tokio::test]
    async fn the_legacy_environment_names_still_resolve() {
        let _env = lock_env().await;
        let _clean = clean_env();
        let dir = tempfile::tempdir().unwrap();
        let _home = EnvSetting::set(
            nession_common::paths::NESSION_HOME_ENV,
            dir.path().to_str().unwrap(),
        );
        let _server_legacy = EnvSetting::set(SERVER_URL_LEGACY_ENV, "ws://legacy-only:4");
        let _token_legacy = EnvSetting::set(AUTH_TOKEN_LEGACY_ENV, "legacy-only-token");

        let ctx = resolve_remote(RemoteInputs::default()).await.unwrap();
        assert_eq!(ctx.server_url, "ws://legacy-only:4");
        assert_eq!(ctx.auth_token, "legacy-only-token");
        assert_eq!(ctx.target_source, TargetSource::EnvLegacy);
    }

    /// #2267's boundary, evolved by #4682: the remote chain never borrows a
    /// daemon credential. The independent client store may supply an endpoint
    /// (one-time import) and a client credential of its own; an Agent's
    /// `auth_token`/`agent_token` are never copied, derived or sent.
    #[tokio::test]
    async fn the_remote_chain_never_borrows_daemon_credentials() {
        let _env = lock_env().await;
        let _clean = clean_env();
        let dir = tempfile::tempdir().unwrap();
        let _home = EnvSetting::set(
            nession_common::paths::NESSION_HOME_ENV,
            dir.path().to_str().unwrap(),
        );
        std::fs::write(
            dir.path().join("agent-config.toml"),
            "server_url = \"ws://agent-endpoint:9/ws\"\n\
             auth_token = \"daemon-auth-canary\"\n\
             agent_token = \"daemon-agent-canary\"\n",
        )
        .unwrap();

        // First use imports the endpoint only; the credential stays unset and
        // the resolver refuses with guidance rather than sending a daemon or
        // ambient secret.
        let _ambient = EnvSetting::set(AUTH_TOKEN_ENV, "ambient-canary");
        let error = resolve_remote(RemoteInputs::default()).await.unwrap_err();
        let message = format!("{error:#}");
        assert!(
            message.contains("no client credential configured"),
            "{message}"
        );
        assert!(!message.contains("daemon-auth-canary"), "{message}");
        assert!(!message.contains("daemon-agent-canary"), "{message}");
        assert!(!message.contains("ambient-canary"), "{message}");

        let store_text = std::fs::read_to_string(dir.path().join("client-config.toml")).unwrap();
        assert!(store_text.contains("ws://agent-endpoint:9/ws"));
        assert!(!store_text.contains("daemon-auth-canary"));
        assert!(!store_text.contains("daemon-agent-canary"));
        assert!(!store_text.contains("ambient-canary"));
        assert!(!store_text.contains("auth_token"));
        assert!(!store_text.contains("agent_token"));
    }

    #[tokio::test]
    async fn an_explicit_url_is_stateless_even_with_a_corrupt_store() {
        let _env = lock_env().await;
        let _clean = clean_env();
        let dir = tempfile::tempdir().unwrap();
        let _home = EnvSetting::set(
            nession_common::paths::NESSION_HOME_ENV,
            dir.path().to_str().unwrap(),
        );
        std::fs::write(dir.path().join("client-config.toml"), "corrupt {{{").unwrap();
        let _ambient = EnvSetting::set(AUTH_TOKEN_ENV, "ambient-token");

        let ctx = resolve_remote(RemoteInputs {
            server_url: Some("ws://explicit:1/ws".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
        assert_eq!(ctx.server_url, "ws://explicit:1/ws");
        assert_eq!(ctx.auth_token, "ambient-token");
        assert_eq!(ctx.target_source, TargetSource::Flag);
    }

    #[tokio::test]
    async fn flag_url_and_profile_together_are_rejected() {
        let _env = lock_env().await;
        let _clean = clean_env();
        let error = resolve_remote(RemoteInputs {
            server_url: Some("ws://explicit:1/ws".to_string()),
            profile: Some("home".to_string()),
            ..Default::default()
        })
        .await
        .unwrap_err();
        assert!(format!("{error:#}").contains("ambiguous"));
    }

    #[tokio::test]
    async fn token_only_env_keeps_the_legacy_loopback_flow() {
        let _env = lock_env().await;
        let _clean = clean_env();
        let dir = tempfile::tempdir().unwrap();
        let _home = EnvSetting::set(
            nession_common::paths::NESSION_HOME_ENV,
            dir.path().to_str().unwrap(),
        );
        let _token = EnvSetting::set(AUTH_TOKEN_ENV, "token-only");

        let ctx = resolve_remote(RemoteInputs::default()).await.unwrap();
        assert_eq!(ctx.server_url, DEFAULT_SERVER_URL);
        assert_eq!(ctx.auth_token, "token-only");
        assert_eq!(ctx.credential_source, CredentialSource::Env);
    }

    #[tokio::test]
    async fn an_explicit_empty_token_is_a_deliberate_no_auth_override() {
        let _env = lock_env().await;
        let _clean = clean_env();
        let dir = tempfile::tempdir().unwrap();
        let _home = EnvSetting::set(
            nession_common::paths::NESSION_HOME_ENV,
            dir.path().to_str().unwrap(),
        );
        let _token = EnvSetting::set(AUTH_TOKEN_ENV, "ambient");

        let ctx = resolve_remote(RemoteInputs {
            auth_token: Some(String::new()),
            ..Default::default()
        })
        .await
        .unwrap();
        assert_eq!(ctx.auth_token, "");
        assert_eq!(ctx.credential_source, CredentialSource::Flag);
    }

    #[test]
    fn sanitized_endpoint_strips_userinfo() {
        assert_eq!(
            sanitized_endpoint("ws://user:pass@host:8080/ws"),
            "ws://host:8080/ws"
        );
        assert_eq!(
            sanitized_endpoint("not-a-url user:pass@host"),
            "not-a-url user:pass@host"
        );
        assert_eq!(sanitized_endpoint("ws://u:p@host"), "ws://host/");
    }
}
