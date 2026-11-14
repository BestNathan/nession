//! nession-agent binary — a thin adapter over [`nession_agent::runtime`].
//!
//! Everything that makes this process an Agent lives in the runtime, because
//! `nession agent start --foreground` starts the same one (#1014). This file
//! does exactly two things: decide which config to run, and hand it over.
//! Adding a subsystem here instead of in the runtime is what made the two
//! entrypoints drift apart in the first place.

use anyhow::{Context, Result};
use nession_agent::config::AgentConfig;
use std::path::Path;

fn main() -> Result<()> {
    // The hidden in-sandbox bridge subcommand (#2681). Dispatched before the
    // tokio runtime exists: inside a sandbox this process is PID 1, must not
    // load a config, and installs its own signal handlers for the child.
    let arguments: Vec<String> = std::env::args().collect();
    if nession_sandbox::bridge::is_bridge_invocation(&arguments) {
        std::process::exit(nession_sandbox::bridge::run_from_std_args());
    }
    tokio::runtime::Runtime::new()?.block_on(async_main())
}

async fn async_main() -> Result<()> {
    // Loaded before the runtime initializes logging, so a config that cannot be
    // read fails without a log destination to report to — the error goes to the
    // shell, which is where the operator is.
    let (config, config_path) = load_config()?;
    // This binary is always started directly — a daemon parent re-execs the CLI,
    // not this — so there is nobody to announce readiness to.
    nession_agent::runtime::run(
        config,
        config_path,
        nession_common::readiness::Readiness::Unwatched,
    )
    .await
}

/// Load agent configuration from a TOML file, falling back to defaults.
fn load_config() -> Result<(AgentConfig, std::path::PathBuf)> {
    let config_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "config.toml".to_string());

    if Path::new(&config_path).exists() {
        let config_str = std::fs::read_to_string(&config_path)
            .with_context(|| format!("failed to read config file: {config_path}"))?;
        let config: AgentConfig = toml::from_str(&config_str)
            .with_context(|| format!("failed to parse config file: {config_path}"))?;
        Ok((config, std::path::PathBuf::from(&config_path)))
    } else {
        // Reaches stdout only in the fallback case, where logging is not up yet
        // either — the runtime logs the "running on defaults" fact itself.
        eprintln!("No config file found at '{config_path}', using defaults");
        Ok((
            AgentConfig::default(),
            std::path::PathBuf::from(&config_path),
        ))
    }
}
