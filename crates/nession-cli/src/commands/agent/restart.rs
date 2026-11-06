//! `nession agent restart` — stop, then start with the same selection.

use crate::lifecycle::pid_file;
use anyhow::Result;

pub async fn run(
    config: Option<String>,
    foreground: bool,
    pid_file_path: Option<String>,
    server_url_override: Option<String>,
    auth_token_override: Option<String>,
) -> Result<()> {
    let pid_file = pid_file::resolve_path(pid_file_path, pid_file::Component::Agent);
    println!("Restarting agent...");
    super::stop::run(Some(pid_file.clone())).await?;
    super::start::run(
        config,
        foreground,
        Some(pid_file),
        server_url_override,
        auth_token_override,
        // `restart` is never the child of a handoff: a background restart
        // re-executes `agent start`, which is the path that reads the pipe.
        false,
    )
    .await
}
