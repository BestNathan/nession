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

    let loaded = configuration::load_server(&selection)?;
    let from_file = loaded.from_file;
    let config = loaded.config;
    let config_path = selection.path.to_string_lossy().into_owned();
    let origin = configuration::describe_origin(&selection.path, from_file);

    if foreground {
        info!("Starting server in foreground mode");
        println!("Starting nession-server with {origin}");
        println!("Listen address: {}", config.listen_address);
        println!("Database: {}", config.db_path);
        println!("Press Ctrl+C to stop");

        pid_file::write_identity(
            &pid_file,
            pid_file::Component::Server,
            pid_file::ConfigRecord::from_loaded(&selection.path, from_file),
        )?;

        let result = run_server_foreground(config).await;

        let _ = fs::remove_file(&pid_file);

        result?;
    } else {
        info!("Starting server in background mode");
        let exe = std::env::current_exe()?;
        let mut cmd = background_child_command(&exe, &selection, &pid_file);

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
                let detail = startup::child_stderr(&mut child);
                let _ = fs::remove_file(&pid_file);
                anyhow::bail!(
                    "Server exited before it was serving ({status}){}",
                    if detail.is_empty() {
                        "; check the logs".to_string()
                    } else {
                        format!(": {detail}")
                    }
                );
            }
            startup::Startup::TimedOut => {
                startup::terminate(&mut child);
                let detail = startup::child_stderr(&mut child);
                let _ = fs::remove_file(&pid_file);
                anyhow::bail!(
                    "Server did not report itself serving within {}s{}",
                    startup::STARTUP_TIMEOUT.as_secs(),
                    if detail.is_empty() {
                        "; check the logs".to_string()
                    } else {
                        format!(": {detail}")
                    }
                );
            }
        }
        if from_file {
            println!("Config: {config_path}");
        } else {
            println!("Config: {origin}");
        }
    }

    Ok(())
}

/// The command the background branch re-executes itself with.
///
/// Extracted so the flag-forwarding contract is asserted against the vector
/// the parent actually spawns: a dropped `--pid-file` would make the child
/// record a different file than the one this command resolved (#1016). An
/// explicit `--config` is forwarded; an implicit selection is not, because the
/// child must apply the same documented default rule — including its no-file
/// fallback — rather than treating the resolved default as a file that must
/// exist (#2869 SC-01+03).
pub(crate) fn background_child_command(
    exe: &Path,
    selection: &ConfigSelection,
    pid_file: &str,
) -> Command {
    let mut cmd = Command::new(exe);
    let mut args = vec!["server".to_string(), "start".to_string()];
    if selection.explicit {
        args.push("--config".to_string());
        args.push(selection.path.to_string_lossy().into_owned());
    }
    args.extend([
        "--foreground".to_string(),
        "--pid-file".to_string(),
        pid_file.to_string(),
    ]);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        // Captured until the child either becomes ready or exits: its own
        // failure sentence is more useful than "check the logs" (#2869).
        .stderr(Stdio::piped());
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

    fn explicit_selection(path: &str) -> ConfigSelection {
        ConfigSelection {
            path: Path::new(path).to_path_buf(),
            explicit: true,
        }
    }

    fn implicit_selection(path: &str) -> ConfigSelection {
        ConfigSelection {
            path: Path::new(path).to_path_buf(),
            explicit: false,
        }
    }

    fn argv(command: &Command) -> Vec<String> {
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn the_background_child_receives_the_resolved_config_and_pid_file() {
        let command = background_child_command(
            Path::new("/bin/true"),
            &explicit_selection("/custom/server.toml"),
            "/custom/server.pid",
        );
        for expected in [
            "server",
            "start",
            "--config",
            "/custom/server.toml",
            "--foreground",
            "--pid-file",
            "/custom/server.pid",
        ] {
            let argv = argv(&command);
            assert!(
                argv.iter().any(|arg| arg == expected),
                "missing {expected}: {argv:?}"
            );
        }
    }

    /// #2869 SC-01+03: the child must not inherit an explicit `--config` that
    /// the user never supplied, or an absent default file would become a
    /// missing explicit file.
    #[test]
    fn an_implicit_selection_is_not_converted_into_an_explicit_flag() {
        let command = background_child_command(
            Path::new("/bin/true"),
            &implicit_selection("/home/me/.nession/server-config.toml"),
            "/custom/server.pid",
        );
        let argv = argv(&command);

        assert!(
            !argv.iter().any(|arg| arg == "--config"),
            "an implicit selection must not gain --config across re-exec: {argv:?}"
        );
        assert!(
            !argv.iter().any(|arg| arg.ends_with("server-config.toml")),
            "the resolved default path must not be forwarded: {argv:?}"
        );
        assert!(
            argv.iter().any(|arg| arg == "--pid-file"),
            "the pid file still identifies the child: {argv:?}"
        );
    }
}
