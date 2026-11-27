//! Installation-owned client connection Profiles (#4682).
//!
//! A Profile is a **client connection context**: a named Server endpoint plus
//! the credential policy for reaching it. It is deliberately not an Agent,
//! Project, Session or release, and it is a different owner from
//! [`crate::configuration`] (daemon configs) and [`crate::versions`] (release
//! layout):
//!
//! - the store lives at `<installation home>/client-config.toml` and belongs
//!   to the *installation*: upgrades retain it in place and release archives
//!   never receive a copy (see `update/snapshot.rs`);
//! - secrets never live in the profile TOML. They live in an independent
//!   credential store ([`credential`]) — the OS credential store when
//!   available, a private file fallback otherwise — and a profile only records
//!   a *reference* scoped to itself and its canonical endpoint;
//! - the one-time Agent endpoint import copies `server_url` only. Daemon
//!   credentials (`auth_token`, `agent_token`) are never copied or derived
//!   into a client credential (#2267's boundary, preserved).
//!
//! [`store`] owns persistence (validation, locking, atomic writes);
//! [`crate::connection`] owns resolving a Profile into a target/credential
//! pair for a remote command.

pub mod credential;
pub mod store;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The only client-store schema this build understands. An unknown schema is
/// refused, never guessed or overwritten.
pub const CLIENT_SCHEMA_VERSION: u32 = 1;

/// The profile name the one-time Agent endpoint bootstrap imports into.
pub const DEFAULT_IMPORTED_PROFILE: &str = "agent";

/// The capability token an archived release advertises when it can consume
/// the installation's client context read-only (#4682 release continuity).
pub const CLIENT_PROFILE_CONTRACT_TOKEN: &str = "nession-client-profile-v1";

/// The capability line printed by `nession --client-profile-contract`.
pub fn contract_line() -> String {
    format!(
        "{CLIENT_PROFILE_CONTRACT_TOKEN} {}",
        env!("CARGO_PKG_VERSION")
    )
}

/// The persisted client connection store (`client-config.toml`).
///
/// `deny_unknown_fields` everywhere: a typo or a future field is a malformed
/// store, refused without mutation, not a silently ignored key.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ClientConfigFile {
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_profile: Option<String>,
    #[serde(default)]
    pub profiles: BTreeMap<String, ProfileEntry>,
}

impl Default for ClientConfigFile {
    fn default() -> Self {
        Self {
            schema_version: CLIENT_SCHEMA_VERSION,
            current_profile: None,
            profiles: BTreeMap::new(),
        }
    }
}

/// One named client connection context.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProfileEntry {
    /// The Server endpoint, validated ws/wss without userinfo/query/fragment.
    pub server_url: String,
    /// A credential reference scoped to this profile. Must equal the profile's
    /// own name; present only when a credential is stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_ref: Option<String>,
    /// Which credential backend holds the referenced secret. Present exactly
    /// when `credential_ref` is, so a later unavailable backend is a hard
    /// error rather than a silent read of the wrong store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_backend: Option<CredentialBackendKind>,
    /// Explicitly configured no-auth: this profile sends no credential.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub no_auth: bool,
}

/// Where a referenced credential is stored.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CredentialBackendKind {
    /// The OS credential store (macOS Keychain, Windows Credential Manager,
    /// Linux Secret Service).
    Keychain,
    /// The private file fallback (`client-credentials/<name>.toml`, 0600).
    File,
}

impl CredentialBackendKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Keychain => "keychain",
            Self::File => "file",
        }
    }
}

/// The credential policy a profile entry records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialState {
    /// Nothing configured: connecting refuses with setup guidance.
    Unset,
    /// Explicitly configured to send no credential.
    NoAuth,
    /// A stored credential bound to this profile and its canonical endpoint.
    Bound(CredentialBackendKind),
}

impl ProfileEntry {
    pub fn credential_state(&self) -> CredentialState {
        match (self.no_auth, self.credential_backend) {
            (true, _) => CredentialState::NoAuth,
            (false, Some(kind)) => CredentialState::Bound(kind),
            (false, None) => CredentialState::Unset,
        }
    }

    /// A masked, secret-free description for `profile list`/`show`.
    pub fn credential_display(&self) -> String {
        match self.credential_state() {
            CredentialState::Unset => "unset (setup required)".to_string(),
            CredentialState::NoAuth => "no-auth".to_string(),
            CredentialState::Bound(kind) => format!("stored ({})", kind.label()),
        }
    }
}

impl ClientConfigFile {
    /// Validate the whole store. Called on every load and before every write;
    /// an invalid store is never consumed and never overwritten.
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != CLIENT_SCHEMA_VERSION {
            bail!(
                "unsupported client connection store schema_version {} (this CLI understands \
                 version {CLIENT_SCHEMA_VERSION}); the store is left untouched. Run a Current \
                 CLI that supports this schema, or repair the store explicitly.",
                self.schema_version
            );
        }
        for (name, entry) in &self.profiles {
            validate_profile_name(name)
                .map_err(|error| error.context(format!("client profile name {name:?}")))?;
            entry
                .validate(name)
                .map_err(|error| error.context(format!("client profile {name:?}")))?;
        }
        if let Some(current) = &self.current_profile {
            if !self.profiles.contains_key(current) {
                bail!(
                    "current_profile {current:?} does not name an existing client profile; \
                     the store is left untouched"
                );
            }
        }
        Ok(())
    }
}

impl ProfileEntry {
    fn validate(&self, name: &str) -> Result<()> {
        validate_server_url(&self.server_url)?;
        if self.no_auth && self.credential_ref.is_some() {
            bail!("no_auth and credential_ref are mutually exclusive");
        }
        match (&self.credential_ref, self.credential_backend) {
            (Some(reference), Some(_)) => {
                if reference != name {
                    bail!(
                        "credential_ref {reference:?} must equal the profile's own name \
                         {name:?}; a credential reference is scoped to one profile"
                    );
                }
            }
            (None, None) => {}
            (Some(_), None) => {
                bail!("credential_ref requires credential_backend (keychain or file)");
            }
            (None, Some(_)) => {
                bail!("credential_backend requires credential_ref");
            }
        }
        Ok(())
    }
}

/// Stable, path-safe profile names: an alphanumeric start, then
/// alphanumerics/`_`/`-`, at most 64 characters. No separators, dots,
/// whitespace or control characters can escape the credential directory.
pub fn validate_profile_name(name: &str) -> Result<()> {
    let mut chars = name.chars();
    let first = chars.next();
    let valid = first.is_some_and(|c| c.is_ascii_alphanumeric())
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !valid {
        bail!(
            "invalid profile name {name:?}: use 1-64 characters, starting with a letter or \
             digit, then letters, digits, '_' or '-'"
        );
    }
    Ok(())
}

/// Validate a stored client endpoint: a ws/wss URL with a host, no userinfo,
/// no query and no fragment. Query strings and fragments are refused because
/// they are a common place to embed secrets, and a profile endpoint must be a
/// bare connection target.
pub fn validate_server_url(raw: &str) -> Result<()> {
    let trimmed = raw.trim();
    let url = url::Url::parse(trimmed)
        .map_err(|_| anyhow::anyhow!("invalid server URL {raw:?}: expected ws:// or wss://"))?;
    if !matches!(url.scheme(), "ws" | "wss") {
        bail!("server URL {raw:?} must use the ws:// or wss:// scheme");
    }
    if url.host_str().is_none_or(str::is_empty) {
        bail!("server URL {raw:?} must name a host");
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("server URL {raw:?} must not embed userinfo (user:password@)");
    }
    if url.query().is_some() || url.fragment().is_some() {
        bail!(
            "server URL {raw:?} must not carry a query string or fragment; a profile endpoint \
             is a bare scheme://host[:port][/path] target"
        );
    }
    Ok(())
}

/// The canonical endpoint a credential reference is bound to.
///
/// Reuses the shared address normalisation (lower-case scheme/host, default
/// port collapsed, trailing slash trimmed) so two spellings of one endpoint
/// compare equal.
pub fn canonical_endpoint(url: &str) -> String {
    nession_common::address::normalize_url(url)
}

/// What the canonical Agent config offers a client endpoint import.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentEndpointRead {
    /// No config file at the path: legacy loopback remains permitted.
    Absent,
    /// A valid config that does not explicitly configure `server_url`: there
    /// is nothing to import, and `AgentConfig::default()` is never a source.
    NoExplicitEndpoint,
    /// A valid, explicitly configured endpoint (endpoint only).
    Endpoint(String),
}

/// Read the Agent's explicitly configured `server_url` for an endpoint-only
/// import (bootstrap and `profile import-agent` share this one reader).
///
/// An unreadable or invalid config is an actionable error — never a silent
/// fallback and never a bogus endpoint built from `AgentConfig` defaults. The
/// daemon's `auth_token`/`agent_token` are not read into any client state.
pub fn read_agent_endpoint_for_bootstrap(path: &std::path::Path) -> Result<AgentEndpointRead> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AgentEndpointRead::Absent);
        }
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "the Agent config at {} is unreadable; refusing to guess a client endpoint. \
                     Fix the file, or target the Server explicitly with --server-url.",
                    path.display()
                )
            });
        }
    };
    // Import validity is about the endpoint, not full daemon startup
    // validity: an explicit, well-formed server_url is importable even if the
    // daemon would refuse other fields. AgentConfig defaults are never a
    // source — only a key actually present in the file is.
    let value: toml::Value = toml::from_str(&text).map_err(|_| {
        anyhow::anyhow!(
            "the Agent config at {} is invalid; refusing to import an endpoint from it. \
             Fix the config, or target the Server explicitly with --server-url.",
            path.display()
        )
    })?;
    match value.get("server_url") {
        None => Ok(AgentEndpointRead::NoExplicitEndpoint),
        Some(toml::Value::String(raw)) if raw.trim().is_empty() => bail!(
            "the Agent config at {} configures an empty server_url; refusing to import it. \
             Set a valid endpoint, or target the Server explicitly with --server-url.",
            path.display()
        ),
        Some(toml::Value::String(raw)) => {
            validate_server_url(raw).map_err(|error| {
                error.context(format!(
                    "the Agent config at {} configures an invalid server_url",
                    path.display()
                ))
            })?;
            Ok(AgentEndpointRead::Endpoint(raw.trim().to_string()))
        }
        Some(_) => bail!(
            "the Agent config at {} configures a non-string server_url; refusing to import \
             it. Fix the config, or target the Server explicitly with --server-url.",
            path.display()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(url: &str) -> ProfileEntry {
        ProfileEntry {
            server_url: url.to_string(),
            credential_ref: None,
            credential_backend: None,
            no_auth: false,
        }
    }

    #[test]
    fn profile_names_are_stable_and_path_safe() {
        for name in ["home", "local", "prod-1", "A_b-2", "0"] {
            validate_profile_name(name).unwrap();
        }
        for name in [
            "",
            "-lead",
            "_lead",
            "has space",
            "has/slash",
            "..",
            ".",
            "dot.name",
            "back\\slash",
            "nul\0byte",
            "ünicode",
        ] {
            assert!(
                validate_profile_name(name).is_err(),
                "{name:?} must be refused"
            );
        }
        assert!(validate_profile_name(&"a".repeat(64)).is_ok());
        assert!(validate_profile_name(&"a".repeat(65)).is_err());
    }

    #[test]
    fn server_urls_are_bare_ws_targets() {
        for url in [
            "ws://127.0.0.1:8080",
            "ws://127.0.0.1:8080/ws",
            "wss://nession.example.internal/ws",
            "ws://[::1]:8080/ws",
            "wss://host:443/ws",
        ] {
            validate_server_url(url).unwrap();
        }
        for url in [
            "http://host/ws",
            "https://host/ws",
            "ws://",
            "ws://user:pass@host/ws",
            "ws://user@host/ws",
            "ws://host/ws?token=secret",
            "ws://host/ws#fragment",
            "not a url",
            "",
        ] {
            assert!(validate_server_url(url).is_err(), "{url:?} must be refused");
        }
    }

    #[test]
    fn canonical_endpoint_collapses_default_ports_and_case() {
        assert_eq!(
            canonical_endpoint("wss://Host:443/ws/"),
            canonical_endpoint("wss://host/ws")
        );
        assert_eq!(
            canonical_endpoint("ws://Host:80/ws"),
            canonical_endpoint("ws://host/ws")
        );
        assert_ne!(
            canonical_endpoint("ws://host:8080/ws"),
            canonical_endpoint("ws://host/ws")
        );
    }

    #[test]
    fn a_valid_store_round_trips_through_toml() {
        let mut file = ClientConfigFile {
            schema_version: CLIENT_SCHEMA_VERSION,
            current_profile: Some("home".to_string()),
            profiles: BTreeMap::new(),
        };
        file.profiles.insert(
            "home".to_string(),
            ProfileEntry {
                server_url: "wss://nession.example.internal/ws".to_string(),
                credential_ref: Some("home".to_string()),
                credential_backend: Some(CredentialBackendKind::File),
                no_auth: false,
            },
        );
        file.profiles
            .insert("local".to_string(), entry("ws://127.0.0.1:8080"));
        file.validate().unwrap();
        let text = toml::to_string_pretty(&file).unwrap();
        assert!(
            !text.contains("token"),
            "no secret field exists in the schema"
        );
        let parsed: ClientConfigFile = toml::from_str(&text).unwrap();
        assert_eq!(parsed, file);
    }

    #[test]
    fn an_unknown_schema_is_refused() {
        let file = ClientConfigFile {
            schema_version: CLIENT_SCHEMA_VERSION + 1,
            ..Default::default()
        };
        let error = file.validate().unwrap_err();
        assert!(format!("{error:#}").contains("unsupported client connection store schema"));
    }

    #[test]
    fn unknown_fields_are_refused() {
        let text = format!(
            "schema_version = {CLIENT_SCHEMA_VERSION}\n\
             [profiles.home]\n\
             server_url = \"ws://host/ws\"\n\
             auth_token = \"smuggled\"\n"
        );
        assert!(toml::from_str::<ClientConfigFile>(&text).is_err());
    }

    #[test]
    fn credential_reference_must_be_self_scoped_and_paired() {
        let mut e = entry("ws://host/ws");
        e.credential_ref = Some("other".to_string());
        e.credential_backend = Some(CredentialBackendKind::File);
        assert!(e.validate("home").is_err());

        e.credential_ref = Some("home".to_string());
        e.credential_backend = None;
        assert!(e.validate("home").is_err());

        e.credential_backend = Some(CredentialBackendKind::File);
        e.no_auth = true;
        assert!(e.validate("home").is_err());

        e.no_auth = false;
        e.validate("home").unwrap();
        assert_eq!(
            e.credential_state(),
            CredentialState::Bound(CredentialBackendKind::File)
        );
    }

    #[test]
    fn current_must_name_an_existing_profile() {
        let file = ClientConfigFile {
            schema_version: CLIENT_SCHEMA_VERSION,
            current_profile: Some("ghost".to_string()),
            profiles: BTreeMap::new(),
        };
        assert!(file.validate().is_err());
    }

    #[test]
    fn the_agent_endpoint_reader_distinguishes_absent_invalid_and_explicit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-config.toml");

        assert_eq!(
            read_agent_endpoint_for_bootstrap(&path).unwrap(),
            AgentEndpointRead::Absent
        );

        std::fs::write(&path, "this is not toml {{{").unwrap();
        assert!(read_agent_endpoint_for_bootstrap(&path).is_err());

        // A valid config without an explicit server_url is not a source of
        // AgentConfig::default()'s endpoint.
        std::fs::write(&path, "terminal_cols = 96\n").unwrap();
        assert_eq!(
            read_agent_endpoint_for_bootstrap(&path).unwrap(),
            AgentEndpointRead::NoExplicitEndpoint
        );

        std::fs::write(&path, "server_url = \"\"\n").unwrap();
        assert!(read_agent_endpoint_for_bootstrap(&path).is_err());

        std::fs::write(&path, "server_url = 123\n").unwrap();
        assert!(read_agent_endpoint_for_bootstrap(&path).is_err());

        std::fs::write(&path, "server_url = \"http://not-ws\"\n").unwrap();
        assert!(read_agent_endpoint_for_bootstrap(&path).is_err());

        std::fs::write(
            &path,
            "server_url = \"ws://agent:9/ws\"\nauth_token = \"daemon-secret\"\n",
        )
        .unwrap();
        assert_eq!(
            read_agent_endpoint_for_bootstrap(&path).unwrap(),
            AgentEndpointRead::Endpoint("ws://agent:9/ws".to_string())
        );
    }
}
