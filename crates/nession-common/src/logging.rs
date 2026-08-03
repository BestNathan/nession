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
use std::path::Path;

use serde::{Deserialize, Serialize};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::Rotation;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

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
}
