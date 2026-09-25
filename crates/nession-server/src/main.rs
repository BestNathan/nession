//! nession-server binary — a thin adapter over [`nession_server::runtime`].
//!
//! The Server's composition lives in the runtime, because
//! `nession server start --foreground` starts the same one (#1014). This file
//! decides which config to run and hands it over; nothing about what a Server
//! *is* belongs here.

use anyhow::Context;
use nession_common::config::ServerConfig;
use std::path::Path;
use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = load_config()?;
    // This binary is always started directly — a daemon parent re-execs the CLI,
    // not this — so there is nobody to announce readiness to.
    nession_server::runtime::run(config, nession_common::readiness::Readiness::Unwatched).await
}

/// Load server configuration.
///
/// The config path is taken from the first argv argument (if present),
/// falling back to `config.toml` in the current directory.
fn load_config() -> anyhow::Result<ServerConfig> {
    let config_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "config.toml".to_string());

    if Path::new(&config_path).exists() {
        info!("Loading configuration from {}", config_path);
        let config_str = std::fs::read_to_string(&config_path)
            .with_context(|| format!("failed to read config file: {config_path}"))?;
        let config: ServerConfig = toml::from_str(&config_str)
            .with_context(|| format!("failed to parse config file: {config_path}"))?;
        Ok(config)
    } else {
        // Reaches stdout only when no log destination exists yet; the runtime
        // logs the same fact once logging is up.
        eprintln!("No config found at '{config_path}', using default configuration");
        Ok(ServerConfig {
            listen_address: "127.0.0.1:8080".to_string(),
            ..Default::default()
        })
    }
}
