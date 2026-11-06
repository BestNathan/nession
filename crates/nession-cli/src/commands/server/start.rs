//! `nession server start` — start the Server daemon.
//!
//! The background branch forwards the resolved `--config` and `--pid-file` to
//! the detached child, so the child loads the same file and records its
//! identity where `stop`/`status` look (#1016).

use crate::configuration::{self, ConfigSelection, ConfigTarget};
use crate::lifecycle::{pid_file, startup};
use anyhow::{Context, Result};
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use tracing::info;

pub async fn run(
    config: Option<String>,
    foreground: bool,
    pid_file_path: Option<String>,
) -> Result<()> {
    let selection = ConfigSelection::resolve(ConfigTarget::Server, config)?;
    let pid_file = pid_file::resolve_path(pid_file_path, pid_file::Component::Server);

    // Ensure component directories exist before any file operations (PID file, DB)
    nession_common::paths::ensure_component_dirs()
        .context("failed to create nession component directories")?;

    // Already running, decided by ownership rather than by pid (#1016) — the
    // same question the agent path asks, for the same reason.
    match pid_file::ownership(&pid_file) {
        Ok(pid_file::Ownership::Alive(identity)) => {
            anyhow::bail!("Server is already running with PID {}", identity.pid);
        }
        Ok(_) | Err(_) => {
            let _ = fs::remove_file(&pid_file);
        }
    }

    let config = configuration::load_server(&selection)?;
    let config_path = selection.path.to_string_lossy().into_owned();

    if foreground {
        info!("Starting server in foreground mode");
        println!("Starting nession-server with config: {config_path}");
        println!("Listen address: {}", config.listen_address);
        println!("Database: {}", config.db_path);
        println!("Press Ctrl+C to stop");

        pid_file::write_identity(
            &pid_file,
            pid_file::Component::Server,
            Some(&selection.path),
        )?;

        let result = run_server_foreground(config).await;

        let _ = fs::remove_file(&pid_file);

        result?;
    } else {
        info!("Starting server in background mode");
        let exe = std::env::current_exe()?;
        let mut cmd = background_child_command(&exe, &config_path, &pid_file);

        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            unsafe {
                cmd.pre_exec(|| {
                    libc::setsid();
                    Ok(())
                });
            }
        }

        let marker = startup::ReadyMarker::beside_state_file(&pid_file);
        marker.arm(&mut cmd);

        let mut child = cmd.spawn().context("failed to spawn server process")?;

        match startup::wait_for_ready(&mut child, &marker, startup::STARTUP_TIMEOUT).await {
            startup::Startup::Serving => {
                let pid = startup::announced_pid(&pid_file)?;
                println!("Server started in background with PID {pid}");
                println!("PID file: {pid_file}");
            }
            startup::Startup::Exited(status) => {
                anyhow::bail!("Server exited before it was serving ({status}); check the logs");
            }
            startup::Startup::TimedOut => {
                anyhow::bail!(
                    "Server did not report itself serving within {}s; check the logs",
                    startup::STARTUP_TIMEOUT.as_secs()
                );
            }
        }
        println!("Config: {config_path}");
    }

    Ok(())
}

/// The command the background branch re-executes itself with.
///
/// Extracted so the flag-forwarding contract is asserted against the vector
/// the parent actually spawns: a dropped `--config` or `--pid-file` would make
/// the child load or record a different file than the one this command
/// resolved (#1016).
pub(crate) fn background_child_command(exe: &Path, config_path: &str, pid_file: &str) -> Command {
    let mut cmd = Command::new(exe);
    cmd.args([
        "server",
        "start",
        "--config",
        config_path,
        "--foreground",
        "--pid-file",
        pid_file,
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    cmd
}

/// Run the Server runtime in foreground mode (blocks until shutdown).
async fn run_server_foreground(config: nession_common::config::ServerConfig) -> Result<()> {
    // The composition is owned by `nession_server::runtime` (#1014).
    nession_server::runtime::run(config, nession_common::readiness::Readiness::from_env()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_background_child_receives_the_resolved_config_and_pid_file() {
        let command = background_child_command(
            Path::new("/bin/true"),
            "/custom/server.toml",
            "/custom/server.pid",
        );
        let argv: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        for expected in [
            "server",
            "start",
            "--config",
            "/custom/server.toml",
            "--foreground",
            "--pid-file",
            "/custom/server.pid",
        ] {
            assert!(
                argv.iter().any(|arg| arg == expected),
                "missing {expected}: {argv:?}"
            );
        }
    }
}
