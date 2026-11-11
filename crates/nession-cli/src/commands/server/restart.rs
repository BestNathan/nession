//! `nession server restart` — validate the replacement, stop, then start.

use crate::configuration::{self, ConfigSelection, ConfigTarget};
use crate::lifecycle::lock::LifecycleLock;
use crate::lifecycle::{pid_file, release};
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
    let selection = ConfigSelection::resolve(ConfigTarget::Server, config)?;
    let loaded = configuration::load_server(&selection)?;
    let mut candidate = loaded.config;
    candidate.apply_env_overrides()?;
    candidate.validate()?;

    let state = pid_file::StateFiles::from_cli(pid_file_path, pid_file::Component::Server)?;
    let lock = LifecycleLock::acquire()?;
    // Refuse before stopping anything if the Agent is running another release.
    release::ensure_no_mixed_release(pid_file::Component::Agent, pid_file::Component::Server)?;
    println!("Restarting server (release {})...", release::this_release());
    super::stop::run_with(state.clone(), &lock).await?;
    super::start::run_with(selection, foreground, state, Some(lock)).await
}
