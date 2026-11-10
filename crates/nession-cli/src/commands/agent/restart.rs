//! `nession agent restart` — validate the replacement, stop, then start.

use crate::configuration::{self, ConfigSelection, ConfigTarget};
use crate::lifecycle::lock::LifecycleLock;
use crate::lifecycle::{pid_file, release};
use anyhow::Result;

pub async fn run(
    config: Option<String>,
    foreground: bool,
    pid_file_path: Option<String>,
    server_url_override: Option<String>,
    auth_token_override: Option<String>,
) -> Result<()> {
    // Resolve and validate the replacement *before* stopping anything: a
    // missing, unreadable or runtime-invalid file must not take a healthy
    // daemon down on the way to being rejected (#2869 SC-01). The environment
    // overrides run here too, because they are part of the effective config
    // the runtime will validate.
    let selection = ConfigSelection::resolve(ConfigTarget::Agent, config)?;
    let loaded = configuration::load_agent(&selection, &server_url_override, &auth_token_override)?;
    let mut candidate = loaded.config;
    candidate.apply_env_overrides()?;
    candidate.validate()?;

    let state = pid_file::StateFiles::from_cli(pid_file_path, pid_file::Component::Agent)?;
    let lock = LifecycleLock::acquire()?;
    // Refuse before stopping anything if the Server is running another release.
    release::ensure_no_mixed_release(pid_file::Component::Server, pid_file::Component::Agent)?;
    println!("Restarting agent (release {})...", release::this_release());
    super::stop::run_with(state.clone(), &lock).await?;
    super::start::run_with(
        selection,
        foreground,
        state,
        server_url_override,
        auth_token_override,
        // `restart` is never the child of a handoff: a background restart
        // re-executes `agent start`, which is the path that reads the pipe.
        false,
        Some(lock),
    )
    .await
}
