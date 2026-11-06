//! `nession server restart` — stop, then start with the same selection.

use crate::lifecycle::pid_file;
use anyhow::Result;

pub async fn run(
    config: Option<String>,
    foreground: bool,
    pid_file_path: Option<String>,
) -> Result<()> {
    let pid_file = pid_file::resolve_path(pid_file_path, pid_file::Component::Server);
    println!("Restarting server...");
    super::stop::run(Some(pid_file.clone())).await?;
    super::start::run(config, foreground, Some(pid_file)).await
}
