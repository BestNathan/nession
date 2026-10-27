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
    // `--print-config [path]` answers "what would this process run with?" and
    // exits. It exists because the effective terminal configuration is a
    // deployment fact (#2487 SC-08): the release pipeline writes it through
    // the entrypoint and the environment, and a Case needs to read it back
    // through the same canonical parser and validation the runtime uses,
    // without starting a database or a listener.
    let args: Vec<String> = std::env::args().collect();
    if let Some(index) = args.iter().position(|arg| arg == "--print-config") {
        let config_path = args
            .get(index + 1)
            .map_or_else(|| "config.toml".to_string(), Clone::clone);
        let config = effective_config(&config_path)?;
        println!(
            "{}",
            serde_json::json!({
                "listen_address": config.listen_address,
                "terminal_cols": config.terminal_cols,
                "terminal_web_font_size": config.terminal_web_font_size,
            })
        );
        return Ok(());
    }

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
    load_config_from(&config_path)
}

fn load_config_from(config_path: &str) -> anyhow::Result<ServerConfig> {
    if Path::new(config_path).exists() {
        info!("Loading configuration from {config_path}");
        let config_str = std::fs::read_to_string(config_path)
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

/// The configuration the runtime would actually use: file, then the
/// deployment environment overrides, then startup validation.
fn effective_config(config_path: &str) -> anyhow::Result<ServerConfig> {
    let mut config = load_config_from(config_path)?;
    config.apply_env_overrides()?;
    config.validate()?;
    Ok(config)
}
