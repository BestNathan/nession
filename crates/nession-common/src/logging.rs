//! Logging initialization shared by agent and server.
//!
//! Sets up a dual-layer tracing subscriber:
//! - **stdout layer** – human-readable output for `docker logs` / `kubectl logs`
//! - **file layer** – rolling file appender with automatic cleanup of old logs
//!
//! # Configuration
//!
//! ```toml
//! [logging]
//! level = "info"        # trace, debug, info, warn, error
//! rotation = "daily"    # daily, hourly, never
//! retention_days = 7    # 0 = never clean up
//! ```

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::Rotation;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

use crate::paths;

/// The rolling runtime log filename prefix the Agent writer uses.
pub const AGENT_LOG_PREFIX: &str = "nession-agent";

/// The rolling runtime log filename prefix the Server writer uses.
pub const SERVER_LOG_PREFIX: &str = "nession-server";

/// The macOS managed-service capture filenames.
///
/// One owner for the generator (LaunchAgent plist), registration-time
/// rotation and the `logs --source service` reader (#4600).
pub const SERVICE_CAPTURE_STDOUT_FILE: &str = "launchd.out";
pub const SERVICE_CAPTURE_STDERR_FILE: &str = "launchd.err";

/// Size cap for each generated macOS managed-service capture file.
///
/// Rotation happens at registration, the only moment this CLI can safely
/// rename a file launchd is not writing yet. The live bound is one `.1`
/// generation plus a current file below this cap.
pub const SERVICE_CAPTURE_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// The Nession component a log tree belongs to.
///
/// This is the single owner of the component-to-prefix/directory mapping: the
/// writer (`init_logging`'s callers), `nession ... logs`, startup diagnostics
/// and the managed-service capture paths all read it instead of carrying their
/// own copy (#4600).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogComponent {
    Agent,
    Server,
}

impl LogComponent {
    pub fn as_str(self) -> &'static str {
        match self {
            LogComponent::Agent => "agent",
            LogComponent::Server => "server",
        }
    }

    /// The prefix `tracing_appender` puts before each rotation suffix.
    pub fn log_prefix(self) -> &'static str {
        match self {
            LogComponent::Agent => AGENT_LOG_PREFIX,
            LogComponent::Server => SERVER_LOG_PREFIX,
        }
    }

    /// The component's runtime logs directory under the process's home.
    pub fn logs_dir(self) -> io::Result<PathBuf> {
        match self {
            LogComponent::Agent => paths::agent_logs_dir(),
            LogComponent::Server => paths::server_logs_dir(),
        }
    }

    /// The component's runtime logs directory under an explicit home.
    pub fn logs_dir_under(self, home: &Path) -> PathBuf {
        match self {
            LogComponent::Agent => paths::agent_logs_dir_under(home),
            LogComponent::Server => paths::server_logs_dir_under(home),
        }
    }

    /// The component's bounded startup diagnostics directory.
    pub fn startup_dir(self) -> io::Result<PathBuf> {
        match self {
            LogComponent::Agent => paths::agent_startup_logs_dir(),
            LogComponent::Server => paths::server_startup_logs_dir(),
        }
    }

    /// The component's bounded startup diagnostics directory under an explicit
    /// home.
    pub fn startup_dir_under(self, home: &Path) -> PathBuf {
        match self {
            LogComponent::Agent => paths::agent_startup_logs_dir_under(home),
            LogComponent::Server => paths::server_startup_logs_dir_under(home),
        }
    }

    /// The component's managed-service capture directory.
    pub fn service_dir(self) -> io::Result<PathBuf> {
        match self {
            LogComponent::Agent => paths::agent_service_logs_dir(),
            LogComponent::Server => paths::server_service_logs_dir(),
        }
    }

    /// The component's managed-service capture directory under an explicit
    /// home.
    pub fn service_dir_under(self, home: &Path) -> PathBuf {
        match self {
            LogComponent::Agent => paths::agent_service_logs_dir_under(home),
            LogComponent::Server => paths::server_service_logs_dir_under(home),
        }
    }
}

/// Which rotation strategy produced a runtime log filename.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogRotation {
    Hourly,
    Daily,
    Never,
}

impl LogRotation {
    pub fn as_str(self) -> &'static str {
        match self {
            LogRotation::Hourly => "hourly",
            LogRotation::Daily => "daily",
            LogRotation::Never => "never",
        }
    }
}

/// A runtime log filename recognised as belonging to a component's writer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeLogFileName {
    /// The rotation the suffix describes.
    pub rotation: LogRotation,
    /// `YYYY-MM-DD` (daily), `YYYY-MM-DD-HH` (hourly), or `None` for the
    /// never-rotating file.
    pub period: Option<String>,
    /// Whether the name uses a compatible historical `.log` infix rather than
    /// the current writer's shape.
    pub legacy: bool,
}

/// Recognise a runtime log filename belonging to `prefix`.
///
/// This is the reader half of the writer contract. [`init_logging`] hands
/// `tracing_appender` a prefix and a [`Rotation`]; the crate names the file
/// `prefix`, `prefix.YYYY-MM-DD` or `prefix.YYYY-MM-DD-HH`. Files without a
/// suffix are the `never` rotation. Compatible historical names that appended
/// `.log` to the prefix are accepted when the remainder is one of the same
/// shapes; any other name — including `nession-agent.out`, rotation artefacts
/// such as `prefix.1`, or another component's files — is excluded so an
/// unrelated file is never read as runtime history.
pub fn parse_runtime_log_file_name(prefix: &str, name: &str) -> Option<RuntimeLogFileName> {
    if name == prefix {
        return Some(RuntimeLogFileName {
            rotation: LogRotation::Never,
            period: None,
            legacy: false,
        });
    }
    let remainder = name.strip_prefix(prefix)?.strip_prefix('.')?;
    // A compatible historical shape: `<prefix>.log[.<period>]`.
    if remainder == "log" {
        return Some(RuntimeLogFileName {
            rotation: LogRotation::Never,
            period: None,
            legacy: true,
        });
    }
    let (remainder, legacy) = match remainder.strip_prefix("log.") {
        Some(rest) => (rest, true),
        None => (remainder, false),
    };
    let (rotation, period) = parse_period(remainder)?;
    Some(RuntimeLogFileName {
        rotation,
        period: Some(period),
        legacy,
    })
}

fn parse_period(text: &str) -> Option<(LogRotation, String)> {
    let bytes = text.as_bytes();
    if bytes.len() == 10 {
        validate_date(text)?;
        return Some((LogRotation::Daily, text.to_string()));
    }
    if bytes.len() == 13 {
        let (date, hour) = text.split_at(10);
        validate_date(date)?;
        if hour.as_bytes().first() != Some(&b'-') {
            return None;
        }
        let hour = hour.get(1..)?;
        let hour: u32 = hour.parse().ok()?;
        if !(0..=23).contains(&hour) {
            return None;
        }
        return Some((LogRotation::Hourly, text.to_string()));
    }
    None
}

fn validate_date(text: &str) -> Option<()> {
    let mut parts = text.split('-');
    let year = parts.next()?;
    let month = parts.next()?;
    let day = parts.next()?;
    if parts.next().is_some() || year.len() != 4 || month.len() != 2 || day.len() != 2 {
        return None;
    }
    let month: u32 = month.parse().ok()?;
    let day: u32 = day.parse().ok()?;
    year.parse::<u32>().ok()?;
    ((1..=12).contains(&month) && (1..=31).contains(&day)).then_some(())
}

/// Logging configuration.
///
/// The entire `[logging]` section is optional. When omitted, defaults are:
/// `level = "info"`, `rotation = "daily"`, `retention_days = 7`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoggingConfig {
    /// Log level: `trace`, `debug`, `info`, `warn`, `error`.
    /// Default: `"info"`.
    #[serde(default = "default_log_level")]
    pub level: String,

    /// Rotation strategy: `daily`, `hourly`, `never`.
    /// Default: `"daily"`.
    #[serde(default = "default_rotation")]
    pub rotation: String,

    /// Number of days to retain old log files. 0 means never clean up.
    /// Default: `7`.
    #[serde(default = "default_retention_days")]
    pub retention_days: u64,
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            level: default_log_level(),
            rotation: default_rotation(),
            retention_days: default_retention_days(),
        }
    }
}

fn default_log_level() -> String {
    "info".to_string()
}

fn default_rotation() -> String {
    "daily".to_string()
}

const fn default_retention_days() -> u64 {
    7
}

/// Compute `max_log_files` from `retention_days` and `rotation`.
///
/// - `daily` → one file per day, so `max_files = retention_days`
/// - `hourly` → 24 files per day, so `max_files = retention_days * 24`
/// - `never` or `retention_days = 0` → no limit
fn max_files_from_config(config: &LoggingConfig) -> Option<usize> {
    if config.retention_days == 0 {
        return None;
    }
    let n = match config.rotation.as_str() {
        "hourly" => config.retention_days.saturating_mul(24),
        _ => config.retention_days,
    };
    Some(usize::try_from(n).unwrap_or(usize::MAX))
}

/// Initialize the tracing subscriber with stdout + file layers.
///
/// Returns a [`WorkerGuard`] that must be kept alive for the lifetime of the
/// process — dropping it causes the non-blocking file writer to flush and stop.
///
/// # Errors
///
/// Returns an error if the log directory cannot be created.
pub fn init_logging(
    config: &LoggingConfig,
    log_dir: &Path,
    component_name: &str,
) -> io::Result<WorkerGuard> {
    // Ensure the log directory exists.
    std::fs::create_dir_all(log_dir)?;

    // Build the env filter: RUST_LOG env var takes precedence, otherwise
    // use the configured level.
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(&config.level));

    // File appender with rotation. Use the builder so we can set max_log_files
    // and let tracing-appender handle pruning of old log files.
    let rotation = match config.rotation.as_str() {
        "hourly" => Rotation::HOURLY,
        "never" => Rotation::NEVER,
        _ => Rotation::DAILY,
    };
    let mut builder = tracing_appender::rolling::RollingFileAppender::builder()
        .rotation(rotation)
        .filename_prefix(component_name);
    if let Some(max_files) = max_files_from_config(config) {
        builder = builder.max_log_files(max_files);
    }
    let file_appender = builder
        .build(log_dir)
        .map_err(|e| io::Error::other(format!("failed to build rolling file appender: {e}")))?;
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    // Stdout layer for real-time viewing.
    let stdout_layer = tracing_subscriber::fmt::layer().with_writer(io::stdout);

    // File layer for persistent storage.
    let file_layer = tracing_subscriber::fmt::layer()
        .with_writer(non_blocking)
        .with_ansi(false);

    tracing_subscriber::registry()
        .with(env_filter)
        .with(stdout_layer)
        .with(file_layer)
        .init();

    Ok(guard)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_logging_config_defaults() {
        let config = LoggingConfig::default();
        assert_eq!(config.level, "info");
        assert_eq!(config.rotation, "daily");
        assert_eq!(config.retention_days, 7);
    }

    #[test]
    fn test_logging_config_serde_minimal() {
        let config: LoggingConfig = toml::from_str("").unwrap();
        assert_eq!(config.level, "info");
        assert_eq!(config.rotation, "daily");
        assert_eq!(config.retention_days, 7);
    }

    #[test]
    fn test_logging_config_serde_full() {
        let toml_str = r#"
            level = "debug"
            rotation = "hourly"
            retention_days = 30
        "#;
        let config: LoggingConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.level, "debug");
        assert_eq!(config.rotation, "hourly");
        assert_eq!(config.retention_days, 30);
    }

    #[test]
    fn test_logging_config_serde_partial() {
        let toml_str = r#"level = "warn""#;
        let config: LoggingConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.level, "warn");
        assert_eq!(config.rotation, "daily");
        assert_eq!(config.retention_days, 7);
    }

    #[test]
    fn test_max_files_daily() {
        let config = LoggingConfig {
            retention_days: 7,
            rotation: "daily".into(),
            ..Default::default()
        };
        assert_eq!(max_files_from_config(&config), Some(7));
    }

    #[test]
    fn test_max_files_hourly() {
        let config = LoggingConfig {
            retention_days: 3,
            rotation: "hourly".into(),
            ..Default::default()
        };
        assert_eq!(max_files_from_config(&config), Some(72)); // 3 * 24
    }

    #[test]
    fn test_max_files_zero_retention_returns_none() {
        let config = LoggingConfig {
            retention_days: 0,
            ..Default::default()
        };
        assert_eq!(max_files_from_config(&config), None);
    }

    #[test]
    fn test_max_files_never_rotation_returns_none() {
        let config = LoggingConfig {
            retention_days: 7,
            rotation: "never".into(),
            ..Default::default()
        };
        assert_eq!(max_files_from_config(&config), Some(7));
    }

    #[test]
    fn the_writers_actual_filenames_are_recognised() {
        let daily = parse_runtime_log_file_name(AGENT_LOG_PREFIX, "nession-agent.2026-11-26")
            .expect("daily shape");
        assert_eq!(daily.rotation, LogRotation::Daily);
        assert_eq!(daily.period.as_deref(), Some("2026-11-26"));
        assert!(!daily.legacy);

        let hourly = parse_runtime_log_file_name(AGENT_LOG_PREFIX, "nession-agent.2026-11-26-23")
            .expect("hourly shape");
        assert_eq!(hourly.rotation, LogRotation::Hourly);

        let never =
            parse_runtime_log_file_name(AGENT_LOG_PREFIX, "nession-agent").expect("never shape");
        assert_eq!(never.rotation, LogRotation::Never);
        assert_eq!(never.period, None);
    }

    #[test]
    fn compatible_historical_names_are_recognised() {
        let legacy =
            parse_runtime_log_file_name(SERVER_LOG_PREFIX, "nession-server.log.2026-11-26")
                .expect("legacy daily");
        assert!(legacy.legacy);
        assert_eq!(legacy.rotation, LogRotation::Daily);
        let bare = parse_runtime_log_file_name(SERVER_LOG_PREFIX, "nession-server.log")
            .expect("legacy never");
        assert_eq!(bare.rotation, LogRotation::Never);
    }

    #[test]
    fn unrelated_and_malformed_names_are_excluded() {
        for name in [
            "nession-agent.out",
            "nession-agent.1",
            "nession-agent.2026-11-26.gz",
            "nession-agent.2026-11-26-24",
            "nession-agent.2026-13-01",
            "nession-server.2026-11-26",
            "startup.log",
            "random",
        ] {
            assert!(
                parse_runtime_log_file_name(AGENT_LOG_PREFIX, name).is_none(),
                "{name} must not be read as Agent runtime history"
            );
        }
    }

    #[test]
    fn the_component_owns_the_prefix_and_directories() {
        for (component, prefix, label) in [
            (LogComponent::Agent, AGENT_LOG_PREFIX, "agent"),
            (LogComponent::Server, SERVER_LOG_PREFIX, "server"),
        ] {
            assert_eq!(component.log_prefix(), prefix);
            assert_eq!(component.as_str(), label);
            let home = Path::new("/tmp/example-home");
            assert_eq!(
                component.logs_dir_under(home),
                home.join(label).join("logs")
            );
            assert_eq!(
                component.startup_dir_under(home),
                home.join(label).join("logs").join("startup")
            );
            assert_eq!(
                component.service_dir_under(home),
                home.join(label).join("logs").join("service")
            );
        }
    }
}
