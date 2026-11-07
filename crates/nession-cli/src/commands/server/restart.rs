//! `nession server restart` — validate the replacement, stop, then start.

use crate::configuration::{self, ConfigSelection, ConfigTarget};
use crate::lifecycle::pid_file;
use anyhow::Result;

pub async fn run(
    config: Option<String>,
    foreground: bool,
    pid_file_path: Option<String>,
) -> Result<()> {
    // Resolve and validate the replacement *before* stopping anything: a
    // missing, unreadable or runtime-invalid file must not take a healthy
    // daemon down on the way to being rejected (#2869 SC-01). The environment
    // overrides run here too, because they are part of the effective config
    // the runtime will validate.
    let selection = ConfigSelection::resolve(ConfigTarget::Server, config.clone())?;
    let loaded = configuration::load_server(&selection)?;
    let mut candidate = loaded.config;
    candidate.apply_env_overrides()?;
    candidate.validate()?;

    let pid_file = pid_file::resolve_path(pid_file_path, pid_file::Component::Server);
    println!("Restarting server...");
    super::stop::run(Some(pid_file.clone())).await?;
    super::start::run(config, foreground, Some(pid_file)).await
}
