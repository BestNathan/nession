use serde::{Deserialize, Serialize};

use crate::logging::LoggingConfig;

/// Canonical fixed terminal width (#2487).
///
/// One value is the *product* default for a new Session across Web and App.
/// It is not a per-client viewport: an existing Session keeps the width its
/// tmux pane already has, and the Agent refuses to change it through an
/// ordinary resize. A release embeds the same selected value into the Web
/// bundle and the Server/Agent runtime configuration (see
/// `docs/design/terminal/terminal-sizing.md`).
pub const DEFAULT_TERMINAL_COLS: u16 = 88;

/// The smallest accepted fixed column count. Below this a terminal is no
/// longer a usable text surface (20 columns fits a command name and a path).
pub const MIN_TERMINAL_COLS: u16 = 20;

/// The largest accepted fixed column count. Growth beyond this belongs in a
/// different sizing policy, not a wider release default.
pub const MAX_TERMINAL_COLS: u16 = 400;

/// The Web terminal's default preferred/maximum CSS font size (#2487).
pub const DEFAULT_TERMINAL_WEB_FONT_SIZE: f64 = 14.0;
/// The smallest accepted Web terminal font size, in CSS px.
pub const MIN_TERMINAL_WEB_FONT_SIZE: f64 = 6.0;
/// The largest accepted Web terminal font size, in CSS px.
pub const MAX_TERMINAL_WEB_FONT_SIZE: f64 = 32.0;

/// The Server/Agent runtime process environment variable carrying the fixed
/// column count. The deployment pipeline sets it from the same release-level
/// parameter that builds the Web bundle (#2487 SC-08).
pub const TERMINAL_COLS_ENV: &str = "NESSION_TERMINAL_COLS";
/// The process environment variable mirroring the Web maximum CSS font size.
/// The Server does not use it for PTY sizing; it is configuration
/// introspection, so an operator can compare a running Server with the Web
/// build it serves (#2487).
pub const TERMINAL_WEB_FONT_SIZE_ENV: &str = "NESSION_TERMINAL_WEB_FONT_SIZE";

/// Parse and range-check a fixed column count.
pub fn parse_terminal_cols(raw: &str) -> Result<u16, String> {
    if !raw.bytes().all(|byte| byte.is_ascii_digit()) || raw.is_empty() {
        return Err(format!(
            "{TERMINAL_COLS_ENV} must be a positive integer; got {raw:?}"
        ));
    }
    let cols: u16 = raw.parse().map_err(|_| {
        format!("{TERMINAL_COLS_ENV} is out of range for a terminal width: {raw:?}")
    })?;
    validate_terminal_cols(cols)?;
    Ok(cols)
}

/// Range-check a fixed column count.
pub fn validate_terminal_cols(cols: u16) -> Result<(), String> {
    if (MIN_TERMINAL_COLS..=MAX_TERMINAL_COLS).contains(&cols) {
        Ok(())
    } else {
        Err(format!(
            "{TERMINAL_COLS_ENV} must be in [{MIN_TERMINAL_COLS}, {MAX_TERMINAL_COLS}]; got {cols}"
        ))
    }
}

/// Parse and range-check the Web maximum CSS font size.
pub fn parse_terminal_web_font_size(raw: &str) -> Result<f64, String> {
    let value: f64 = raw.parse().map_err(|_| {
        format!(
            "{TERMINAL_WEB_FONT_SIZE_ENV} must be a number in \
             [{MIN_TERMINAL_WEB_FONT_SIZE}, {MAX_TERMINAL_WEB_FONT_SIZE}] CSS px; got {raw:?}"
        )
    })?;
    validate_terminal_web_font_size(value)?;
    Ok(value)
}

/// Range-check the Web maximum CSS font size.
pub fn validate_terminal_web_font_size(value: f64) -> Result<(), String> {
    if value.is_finite()
        && (MIN_TERMINAL_WEB_FONT_SIZE..=MAX_TERMINAL_WEB_FONT_SIZE).contains(&value)
    {
        Ok(())
    } else {
        Err(format!(
            "{TERMINAL_WEB_FONT_SIZE_ENV} must be a number in \
             [{MIN_TERMINAL_WEB_FONT_SIZE}, {MAX_TERMINAL_WEB_FONT_SIZE}] CSS px; got {value}"
        ))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub listen_address: String,
    pub tls_cert_path: String,
    pub tls_key_path: String,
    pub auth_token: String,
    /// Interval at which agents should send heartbeats, in seconds.
    /// Sent to each agent in the registration response so the cadence is
    /// configured centrally.
    #[serde(default = "default_heartbeat_interval")]
    pub heartbeat_interval_secs: u64,
    #[serde(default = "default_heartbeat_timeout")]
    pub heartbeat_timeout_secs: u64,
    #[serde(default = "default_db_path")]
    pub db_path: String,
    /// How long a relayed terminal frame may wait for room in a client's
    /// outbound queue before the Server gives up on that client (#961).
    ///
    /// A connection's outbound queue holds its bound before its producers wait,
    /// so this is a floor on the rate a client has to drain to stay attached:
    /// the effective bound divided by this, which for terminal-sized frames is
    /// the frame count rather than the byte budget. It is a policy knob rather
    /// than a tuning one — the arithmetic behind the default is in
    /// `server::outbound`.
    #[serde(default = "default_terminal_stall_grace")]
    pub terminal_stall_grace_secs: u64,
    /// How many queries one client connection may have in flight at once
    /// (#961-C).
    ///
    /// The bound on the connection's query lane: read-only units run on their
    /// own tasks so a query waiting on an agent does not hold the connection's
    /// other frames behind it, and this is what keeps that from being one task
    /// per message. Reaching it stops the connection from being *read* until a
    /// query finishes, so the bound is also the backpressure. See
    /// `nession_server::server::execution`.
    #[serde(default = "default_query_concurrency")]
    pub query_concurrency_per_connection: usize,
    /// How long a P2P credential stays valid after it is minted (#1013).
    ///
    /// A credential authorizes a direct Client → Agent connection, and it is
    /// validated by the **Agent** — the Server mints and forgets, the Agent
    /// honours it until this deadline passes. So this is the revocation
    /// window: it bounds how long a credential that leaked (a token in a URL
    /// reaches access logs) stays useful, and it is the only expiry the
    /// boundary has. Shorter is safer and costs the user nothing, because a
    /// client that needs a new one re-attaches and gets one.
    ///
    /// Five minutes, which is long enough for a slow first paint and for the
    /// reconnect budget a browser uses after a dropped socket, and short enough
    /// that a leaked token is stale by the time anyone notices it leaked.
    #[serde(default = "default_p2p_token_expiry")]
    pub p2p_token_expiry_secs: u64,
    /// The fixed column count a new Session is created at (#2487).
    ///
    /// The Server's runtime value comes from `NESSION_TERMINAL_COLS`, written by
    /// the deployment pipeline from the same release parameter that builds the
    /// Web bundle. It is **not** a live-Session resize policy: an existing
    /// Session's width belongs to its tmux pane and is enforced by the Agent.
    #[serde(default = "default_terminal_cols")]
    pub terminal_cols: u16,
    /// The Web terminal's preferred/maximum CSS font size, mirrored for
    /// configuration introspection (#2487).
    ///
    /// The Server does not apply it to a PTY — the Web bundle owns font
    /// sizing. Exposing the value here is what lets an operator compare a
    /// running Server with the Web build it serves.
    #[serde(default = "default_terminal_web_font_size")]
    pub terminal_web_font_size: f64,
    /// Logging configuration (optional). When omitted, defaults to
    /// `level = "info"`, `rotation = "daily"`, `retention_days = 7`.
    #[serde(default)]
    pub logging: LoggingConfig,
}

impl ServerConfig {
    /// Apply the runtime environment overrides owned by the deployment
    /// pipeline (#2487 SC-08).
    ///
    /// The entrypoint writes these values into `config.toml`; reading the same
    /// environment here makes a directly started Server (and a Compose/k8s
    /// environment that already supplies them) agree with that file instead of
    /// silently ignoring it. An explicitly set environment value wins over the
    /// file, because it is the release-level parameter and the file is its
    /// projection.
    pub fn apply_env_overrides(&mut self) -> anyhow::Result<()> {
        self.apply_env_overrides_from(|name| std::env::var(name).ok())
    }

    /// The testable half of [`Self::apply_env_overrides`].
    pub fn apply_env_overrides_from(
        &mut self,
        get: impl Fn(&str) -> Option<String>,
    ) -> anyhow::Result<()> {
        if let Some(raw) = get(TERMINAL_COLS_ENV) {
            self.terminal_cols = parse_terminal_cols(&raw).map_err(anyhow::Error::msg)?;
        }
        if let Some(raw) = get(TERMINAL_WEB_FONT_SIZE_ENV) {
            self.terminal_web_font_size =
                parse_terminal_web_font_size(&raw).map_err(anyhow::Error::msg)?;
        }
        Ok(())
    }

    /// Validate the effective configuration before the runtime starts.
    pub fn validate(&self) -> anyhow::Result<()> {
        validate_terminal_cols(self.terminal_cols).map_err(anyhow::Error::msg)?;
        validate_terminal_web_font_size(self.terminal_web_font_size).map_err(anyhow::Error::msg)?;
        Ok(())
    }
}

/// The default for [`ServerConfig::terminal_stall_grace_secs`], published so the
/// outbound queue's own default cannot drift from the config's.
pub const DEFAULT_TERMINAL_STALL_GRACE_SECS: u64 = 15;

/// The default for [`ServerConfig::p2p_token_expiry_secs`], published so a
/// test that needs a credential to be *expired* can derive one rather than
/// hard-code a number that would silently stop testing expiry if the default
/// moved.
pub const DEFAULT_P2P_TOKEN_EXPIRY_SECS: u64 = 300;

/// The default for [`ServerConfig::query_concurrency_per_connection`], published
/// for the same reason: the query lane's own default is this number.
///
/// Eight is a policy number, not a tuned one. A connection's queries are the
/// read-only units a browser asks for — a session list, a capture preview, an
/// env read — and they are mostly *waiting* on an agent, so the lane is about
/// how many of those may be outstanding before the Server would rather stop
/// reading the connection than open another task for it. Large enough that a
/// UI asking for several things at once is never the reason it stalls, small
/// enough that a connection which never gets answered costs eight tasks and not
/// the machine.
pub const DEFAULT_QUERY_CONCURRENCY_PER_CONNECTION: usize = 8;

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            listen_address: "0.0.0.0:19090".to_string(),
            tls_cert_path: String::new(),
            tls_key_path: String::new(),
            auth_token: String::new(),
            heartbeat_interval_secs: default_heartbeat_interval(),
            heartbeat_timeout_secs: default_heartbeat_timeout(),
            db_path: default_db_path(),
            terminal_stall_grace_secs: default_terminal_stall_grace(),
            query_concurrency_per_connection: default_query_concurrency(),
            p2p_token_expiry_secs: default_p2p_token_expiry(),
            terminal_cols: default_terminal_cols(),
            terminal_web_font_size: default_terminal_web_font_size(),
            logging: LoggingConfig::default(),
        }
    }
}

fn default_terminal_cols() -> u16 {
    DEFAULT_TERMINAL_COLS
}

fn default_terminal_web_font_size() -> f64 {
    DEFAULT_TERMINAL_WEB_FONT_SIZE
}

fn default_terminal_stall_grace() -> u64 {
    DEFAULT_TERMINAL_STALL_GRACE_SECS
}

fn default_query_concurrency() -> usize {
    DEFAULT_QUERY_CONCURRENCY_PER_CONNECTION
}

fn default_p2p_token_expiry() -> u64 {
    DEFAULT_P2P_TOKEN_EXPIRY_SECS
}

fn default_heartbeat_interval() -> u64 {
    10
}

fn default_heartbeat_timeout() -> u64 {
    30
}

fn default_db_path() -> String {
    crate::paths::server_db_path()
        .unwrap_or_else(|_| std::path::PathBuf::from("nession.db"))
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_server_config_default() {
        let config = ServerConfig::default();
        assert_eq!(config.listen_address, "0.0.0.0:19090");
        assert_eq!(config.tls_cert_path, "");
        assert_eq!(config.tls_key_path, "");
        assert_eq!(config.auth_token, "");
        assert_eq!(config.heartbeat_interval_secs, 10);
        assert_eq!(config.heartbeat_timeout_secs, 30);
        assert!(!config.db_path.is_empty());
    }

    #[test]
    fn test_server_config_serde() {
        let config = ServerConfig::default();
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: ServerConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.listen_address, "0.0.0.0:19090");
        assert_eq!(deserialized.heartbeat_interval_secs, 10);
    }

    #[test]
    fn test_server_config_custom_values() {
        let config = ServerConfig {
            listen_address: "127.0.0.1:9090".to_string(),
            tls_cert_path: "/path/to/cert".to_string(),
            tls_key_path: "/path/to/key".to_string(),
            auth_token: "secret".to_string(),
            heartbeat_interval_secs: 20,
            heartbeat_timeout_secs: 60,
            db_path: "/tmp/test.db".to_string(),
            ..Default::default()
        };
        assert_eq!(config.listen_address, "127.0.0.1:9090");
        assert_eq!(config.heartbeat_interval_secs, 20);
    }

    #[test]
    fn test_default_functions() {
        assert_eq!(default_heartbeat_interval(), 10);
        assert_eq!(default_heartbeat_timeout(), 30);
        assert!(!default_db_path().is_empty());
    }

    #[test]
    fn test_server_config_parsing() {
        let toml_str = r#"
            listen_address = "0.0.0.0:8443"
            tls_cert_path = "/path/to/cert.pem"
            tls_key_path = "/path/to/key.pem"
            auth_token = "secret_token_123"
            heartbeat_timeout_secs = 30
            db_path = "./nession-server.db"
        "#;

        let config: ServerConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.listen_address, "0.0.0.0:8443");
        assert_eq!(config.heartbeat_timeout_secs, 30);
        assert_eq!(config.db_path, "./nession-server.db");
    }

    #[test]
    fn test_server_config_defaults() {
        let toml_str = r#"
            listen_address = "0.0.0.0:8443"
            tls_cert_path = "/path/to/cert.pem"
            tls_key_path = "/path/to/key.pem"
            auth_token = "secret_token_123"
        "#;

        let config: ServerConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.heartbeat_timeout_secs, 30); // default
        assert_eq!(
            config.db_path,
            crate::paths::server_db_path()
                .expect("home dir required for test")
                .to_string_lossy()
                .into_owned()
        ); // default

        // A config file written before the query lane existed still describes a
        // connection that runs one (#961-C): the field has to default, not fail.
        assert_eq!(
            config.query_concurrency_per_connection,
            DEFAULT_QUERY_CONCURRENCY_PER_CONNECTION
        );
    }

    #[test]
    fn terminal_sizing_defaults_and_toml_round_trip() {
        let default = ServerConfig::default();
        assert_eq!(default.terminal_cols, DEFAULT_TERMINAL_COLS);
        assert_eq!(
            default.terminal_web_font_size,
            DEFAULT_TERMINAL_WEB_FONT_SIZE
        );

        // A config written before #2487 has neither field; both must default.
        let config: ServerConfig = toml::from_str(
            r#"
            listen_address = "0.0.0.0:8443"
            tls_cert_path = "/path/to/cert.pem"
            tls_key_path = "/path/to/key.pem"
            auth_token = "secret"
            "#,
        )
        .unwrap();
        assert_eq!(config.terminal_cols, DEFAULT_TERMINAL_COLS);
        assert_eq!(
            config.terminal_web_font_size,
            DEFAULT_TERMINAL_WEB_FONT_SIZE
        );

        let explicit: ServerConfig = toml::from_str(
            r#"
            listen_address = "0.0.0.0:8443"
            tls_cert_path = ""
            tls_key_path = ""
            auth_token = ""
            terminal_cols = 96
            terminal_web_font_size = 13.5
            "#,
        )
        .unwrap();
        assert_eq!(explicit.terminal_cols, 96);
        assert_eq!(explicit.terminal_web_font_size, 13.5);
    }

    #[test]
    fn terminal_cols_parser_rejects_out_of_range_and_non_numeric() {
        assert_eq!(parse_terminal_cols("88").unwrap(), 88);
        assert_eq!(parse_terminal_cols("20").unwrap(), 20);
        assert_eq!(parse_terminal_cols("400").unwrap(), 400);
        for raw in ["", "0", "19", "401", "88.5", "-1", "eighty", " 88"] {
            assert!(parse_terminal_cols(raw).is_err(), "{raw:?} must be refused");
        }
    }

    #[test]
    fn terminal_font_parser_rejects_units_and_out_of_range() {
        assert_eq!(parse_terminal_web_font_size("14").unwrap(), 14.0);
        assert_eq!(parse_terminal_web_font_size("6.5").unwrap(), 6.5);
        assert_eq!(parse_terminal_web_font_size("32").unwrap(), 32.0);
        for raw in ["", "0", "5.9", "32.1", "14px", "NaN", "inf"] {
            assert!(
                parse_terminal_web_font_size(raw).is_err(),
                "{raw:?} must be refused"
            );
        }
    }

    #[test]
    fn env_overrides_win_over_the_file_and_fail_fast() {
        let mut config = ServerConfig {
            terminal_cols: 80,
            terminal_web_font_size: 13.0,
            ..Default::default()
        };
        config
            .apply_env_overrides_from(|name| match name {
                TERMINAL_COLS_ENV => Some("96".to_string()),
                TERMINAL_WEB_FONT_SIZE_ENV => Some("14.5".to_string()),
                _ => None,
            })
            .unwrap();
        assert_eq!(config.terminal_cols, 96);
        assert_eq!(config.terminal_web_font_size, 14.5);

        let mut invalid = ServerConfig::default();
        assert!(invalid
            .apply_env_overrides_from(|name| (name == TERMINAL_COLS_ENV).then(|| "80x".to_string()))
            .is_err());
        assert!(invalid
            .apply_env_overrides_from(|name| {
                (name == TERMINAL_WEB_FONT_SIZE_ENV).then(|| "huge".to_string())
            })
            .is_err());
    }

    #[test]
    fn validate_rejects_values_that_bypass_the_parsers() {
        let below = ServerConfig {
            terminal_cols: MIN_TERMINAL_COLS - 1,
            ..Default::default()
        };
        assert!(below.validate().is_err());

        let above = ServerConfig {
            terminal_cols: MAX_TERMINAL_COLS + 1,
            ..Default::default()
        };
        assert!(above.validate().is_err());

        let not_a_number = ServerConfig {
            terminal_web_font_size: f64::NAN,
            ..Default::default()
        };
        assert!(not_a_number.validate().is_err());

        let too_large = ServerConfig {
            terminal_web_font_size: MAX_TERMINAL_WEB_FONT_SIZE + 1.0,
            ..Default::default()
        };
        assert!(too_large.validate().is_err());
    }
}
