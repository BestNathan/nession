//! Config CLI commands — init, show, and modify agent/server configuration.

use anyhow::{Context, Result};
use nession_agent::config::AgentConfig;
use nession_common::config::ServerConfig;
use std::fs;
use std::path::PathBuf;

/// Config target: agent or server.
pub enum ConfigTarget {
    Agent,
    Server,
}

/// Return the default config path for the given target.
pub fn default_config_path(target: &ConfigTarget) -> Result<PathBuf> {
    match target {
        ConfigTarget::Agent => nession_common::paths::agent_config_path()
            .context("failed to determine agent config path"),
        ConfigTarget::Server => nession_common::paths::server_config_path()
            .context("failed to determine server config path"),
    }
}

/// Return the human-readable label for the config target.
fn target_label(target: &ConfigTarget) -> &'static str {
    match target {
        ConfigTarget::Agent => "agent",
        ConfigTarget::Server => "server",
    }
}

/// Initialize a default configuration file.
pub fn init(target: ConfigTarget, force: bool) -> Result<()> {
    let path = default_config_path(&target)?;
    let label = target_label(&target);

    if path.exists() && !force {
        println!(
            "{} config already exists at '{}'. Use --force to overwrite.",
            label,
            path.display()
        );
        return Ok(());
    }

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create directory: {}", parent.display()))?;
    }

    let toml_str = match &target {
        ConfigTarget::Agent => {
            let config = AgentConfig::default();
            toml::to_string_pretty(&config).context("failed to serialize agent config")?
        }
        ConfigTarget::Server => {
            let config = ServerConfig::default();
            toml::to_string_pretty(&config).context("failed to serialize server config")?
        }
    };

    fs::write(&path, &toml_str)
        .with_context(|| format!("failed to write config to: {}", path.display()))?;

    println!("{} config written to '{}'", label, path.display());
    Ok(())
}

/// Show the current configuration (parsed values).
pub fn show(target: ConfigTarget) -> Result<()> {
    let path = default_config_path(&target)?;
    let label = target_label(&target);

    if !path.exists() {
        println!(
            "No {} config file found at '{}'. Run 'nession config {} init' to create one.",
            label,
            path.display(),
            label
        );
        return Ok(());
    }

    let content = fs::read_to_string(&path)
        .with_context(|| format!("failed to read config: {}", path.display()))?;

    println!("--- {} config ({}) ---", label, path.display());
    println!("{content}");
    Ok(())
}

/// Set a configuration key to a new value.
pub fn set(target: ConfigTarget, key: &str, value: &str) -> Result<()> {
    let path = default_config_path(&target)?;
    let label = target_label(&target);

    if !path.exists() {
        anyhow::bail!(
            "No {} config file found at '{}'. Run 'nession config {} init' first.",
            label,
            path.display(),
            label
        );
    }

    let content = fs::read_to_string(&path)
        .with_context(|| format!("failed to read config: {}", path.display()))?;

    match &target {
        ConfigTarget::Agent => {
            let mut config: AgentConfig = toml::from_str(&content)
                .with_context(|| format!("failed to parse {label} config"))?;
            set_agent_field(&mut config, key, value)?;
            let toml_str =
                toml::to_string_pretty(&config).context("failed to serialize agent config")?;
            fs::write(&path, &toml_str)
                .with_context(|| format!("failed to write config: {}", path.display()))?;
        }
        ConfigTarget::Server => {
            let mut config: ServerConfig = toml::from_str(&content)
                .with_context(|| format!("failed to parse {label} config"))?;
            set_server_field(&mut config, key, value)?;
            let toml_str =
                toml::to_string_pretty(&config).context("failed to serialize server config")?;
            fs::write(&path, &toml_str)
                .with_context(|| format!("failed to write config: {}", path.display()))?;
        }
    }

    println!("{label} config updated: {key} = {value}");
    Ok(())
}

fn set_agent_field(config: &mut AgentConfig, key: &str, value: &str) -> Result<()> {
    match key {
        "agent_id" => config.agent_id = value.to_string(),
        "server_url" => config.server_url = value.to_string(),
        "auth_token" => config.auth_token = value.to_string(),
        "listen_address" => config.listen_address = value.to_string(),
        "tls_cert_path" => config.tls_cert_path = parse_optional(value)?,
        "tls_key_path" => config.tls_key_path = parse_optional(value)?,
        "heartbeat_interval_secs" => {
            config.heartbeat_interval_secs = parse_u64(key, value)?;
        }
        "session_poll_interval_secs" => {
            config.session_poll_interval_secs = parse_u64(key, value)?;
        }
        "advertise_address" => config.advertise_address = parse_optional(value)?,
        "connect_url" => config.connect_url = parse_optional(value)?,
        "default_working_dir" => config.default_working_dir = value.to_string(),
        "file_root" => config.file_root = parse_optional(value)?,
        _ => anyhow::bail!(
            "unknown agent config key: '{key}'. Valid keys: agent_id, server_url, auth_token, \
             listen_address, tls_cert_path, tls_key_path, heartbeat_interval_secs, \
             session_poll_interval_secs, advertise_address, connect_url, \
             default_working_dir, file_root"
        ),
    }
    Ok(())
}

fn set_server_field(config: &mut ServerConfig, key: &str, value: &str) -> Result<()> {
    match key {
        "listen_address" => config.listen_address = value.to_string(),
        "tls_cert_path" => config.tls_cert_path = value.to_string(),
        "tls_key_path" => config.tls_key_path = value.to_string(),
        "auth_token" => config.auth_token = value.to_string(),
        "heartbeat_interval_secs" => {
            config.heartbeat_interval_secs = parse_u64(key, value)?;
        }
        "heartbeat_timeout_secs" => {
            config.heartbeat_timeout_secs = parse_u64(key, value)?;
        }
        "db_path" => config.db_path = value.to_string(),
        _ => anyhow::bail!(
            "unknown server config key: '{key}'. Valid keys: listen_address, tls_cert_path, \
             tls_key_path, auth_token, heartbeat_interval_secs, heartbeat_timeout_secs, db_path"
        ),
    }
    Ok(())
}

fn parse_u64(key: &str, value: &str) -> Result<u64> {
    value
        .parse::<u64>()
        .with_context(|| format!("'{key}' must be a non-negative integer, got '{value}'"))
}

/// Parse an optional string value. Empty string or "none" clears the field.
fn parse_optional(value: &str) -> Result<Option<String>> {
    if value.is_empty() || value.eq_ignore_ascii_case("none") {
        Ok(None)
    } else {
        Ok(Some(value.to_string()))
    }
}
