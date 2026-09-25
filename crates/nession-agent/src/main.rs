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

#[tokio::main]
async fn main() -> Result<()> {
    // Loaded before the runtime initializes logging, so a config that cannot be
    // read fails without a log destination to report to — the error goes to the
    // shell, which is where the operator is.
    let config = load_config()?;
    nession_agent::runtime::run(config).await
}

/// Load agent configuration from a TOML file, falling back to defaults.
fn load_config() -> Result<AgentConfig> {
    let config_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "config.toml".to_string());

    if Path::new(&config_path).exists() {
        let config_str = std::fs::read_to_string(&config_path)
            .with_context(|| format!("failed to read config file: {config_path}"))?;
        let config: AgentConfig = toml::from_str(&config_str)
            .with_context(|| format!("failed to parse config file: {config_path}"))?;
        Ok(config)
    } else {
        // Reaches stdout only in the fallback case, where logging is not up yet
        // either — the runtime logs the "running on defaults" fact itself.
        eprintln!("No config file found at '{config_path}', using defaults");
        Ok(AgentConfig::default())
    }
}
