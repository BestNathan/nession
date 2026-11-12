//! Where a **remote** CLI command connects, and as whom (#2267).
//!
//! This is deliberately a different owner from [`crate::configuration`]. The
//! daemon configs describe an Agent/Server; `agents`/`sessions` are remote
//! consumers and never borrow one (a daemon's outbound `server_url` is not
//! where this CLI is pointed). The chain is:
//!
//! 1. the explicit global flag;
//! 2. `NESSION_SERVER_URL` / `NESSION_AUTH_TOKEN`;
//! 3. the legacy `NENSION_*` aliases;
//! 4. the documented loopback default.
//!
//! One resolver for every remote command, so two commands cannot disagree.

use anyhow::{Context, Result};

use nession_client::{ClientConfig, ClientConnection};

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

/// Resolve the remote Server URL.
pub fn resolve_server_url(cli_url: Option<String>) -> String {
    cli_url
        .or_else(environment_server_url)
        .unwrap_or_else(|| DEFAULT_SERVER_URL.to_string())
}

/// Resolve the remote credential.
pub fn resolve_auth_token(cli_token: Option<String>) -> String {
    cli_token
        .or_else(environment_auth_token)
        .unwrap_or_else(|| DEFAULT_AUTH_TOKEN.to_string())
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::sync::Mutex;

    /// `NESSION_*` is process-global; serialise the tests that set it.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvSetting {
        key: &'static str,
        previous: Option<OsString>,
    }

    impl EnvSetting {
        fn set(key: &'static str, value: &str) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, previous }
        }

        fn unset(key: &'static str) -> Self {
            let previous = std::env::var_os(key);
            std::env::remove_var(key);
            Self { key, previous }
        }
    }

    impl Drop for EnvSetting {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(previous) => std::env::set_var(self.key, previous),
                None => std::env::remove_var(self.key),
            }
        }
    }

    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[test]
    fn the_default_target_is_the_loopback_server() {
        let _env = lock_env();
        let _server = EnvSetting::unset(SERVER_URL_ENV);
        let _server_legacy = EnvSetting::unset(SERVER_URL_LEGACY_ENV);
        let _token = EnvSetting::unset(AUTH_TOKEN_ENV);
        let _token_legacy = EnvSetting::unset(AUTH_TOKEN_LEGACY_ENV);

        assert_eq!(resolve_server_url(None), DEFAULT_SERVER_URL);
        assert_eq!(resolve_auth_token(None), DEFAULT_AUTH_TOKEN);
    }

    #[test]
    fn the_canonical_environment_names_win_over_the_legacy_aliases() {
        let _env = lock_env();
        let _server = EnvSetting::set(SERVER_URL_ENV, "ws://canonical:1");
        let _server_legacy = EnvSetting::set(SERVER_URL_LEGACY_ENV, "ws://legacy:2");
        let _token = EnvSetting::set(AUTH_TOKEN_ENV, "canonical-token");
        let _token_legacy = EnvSetting::set(AUTH_TOKEN_LEGACY_ENV, "legacy-token");

        assert_eq!(resolve_server_url(None), "ws://canonical:1");
        assert_eq!(resolve_auth_token(None), "canonical-token");

        assert_eq!(
            resolve_server_url(Some("ws://flag:3".to_string())),
            "ws://flag:3"
        );
        assert_eq!(
            resolve_auth_token(Some("flag-token".to_string())),
            "flag-token"
        );
    }

    #[test]
    fn the_legacy_environment_names_still_resolve() {
        let _env = lock_env();
        let _server = EnvSetting::unset(SERVER_URL_ENV);
        let _server_legacy = EnvSetting::set(SERVER_URL_LEGACY_ENV, "ws://legacy-only:4");
        let _token = EnvSetting::unset(AUTH_TOKEN_ENV);
        let _token_legacy = EnvSetting::set(AUTH_TOKEN_LEGACY_ENV, "legacy-only-token");

        assert_eq!(resolve_server_url(None), "ws://legacy-only:4");
        assert_eq!(resolve_auth_token(None), "legacy-only-token");
    }

    /// #2267: the remote chain never reads a daemon config. The daemon target
    /// and the remote target are separate owners; a resolver that consulted a
    /// config file would let a remote command silently talk to localhost.
    #[test]
    fn the_remote_chain_has_no_config_file_source() {
        let _env = lock_env();
        let _server = EnvSetting::unset(SERVER_URL_ENV);
        let _server_legacy = EnvSetting::unset(SERVER_URL_LEGACY_ENV);
        let _token = EnvSetting::unset(AUTH_TOKEN_ENV);
        let _token_legacy = EnvSetting::unset(AUTH_TOKEN_LEGACY_ENV);

        // The only inputs are the flag and the two environment name pairs.
        assert_eq!(resolve_server_url(None), DEFAULT_SERVER_URL);
        assert_eq!(environment_server_url(), None);
        assert_eq!(environment_auth_token(), None);
    }
}
