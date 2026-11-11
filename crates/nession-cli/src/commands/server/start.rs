//! `nession server start` — start the Server daemon.
//!
//! The background branch forwards the resolved `--config` and `--pid-file` to
//! the detached child, so the child loads the same file and records its
//! identity where `stop`/`status` look (#1016).

use crate::configuration::{self, ConfigSelection, ConfigTarget};
use crate::lifecycle::lock::LifecycleLock;
use crate::lifecycle::{pid_file, release, startup};
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
    let state = pid_file::StateFiles::from_cli(pid_file_path, pid_file::Component::Server)?;
    // One lifecycle command at a time across every installed release. The
    // foreground child of a background start inherits the parent's lock through
    // its marker; it must not take the same lock again.
    let lock = if foreground
        && std::env::var_os(crate::lifecycle::lock::LOCK_HELD_BY_PARENT_ENV).is_some()
    {
        None
    } else {
        Some(LifecycleLock::acquire()?)
    };
    run_with(selection, foreground, state, lock).await
}

/// Start with an already-resolved configuration selection and state location,
/// holding the lifecycle lock.
///
/// `restart` uses this entry point so the replacement it validated is the same
/// selection this start loads, and the state file it stopped is the one this
/// start writes.
pub(crate) async fn run_with(
    selection: ConfigSelection,
    foreground: bool,
    state: pid_file::StateFiles,
    lock: Option<LifecycleLock>,
) -> Result<()> {
    // Ensure durable component directories exist before file operations. The
    // runtime state directory was already created by `StateFiles::from_cli`
    // for the default location.
    nession_common::paths::ensure_component_dirs()
        .context("failed to create nession component directories")?;

    // Already running, decided by ownership rather than by pid (#1016) — the
    // same question the agent path asks, for the same reason. Both locations
    // are consulted so a live pre-runtime daemon is not duplicated.
    //
    // Start is idempotent by requirement: a live Server is reported and left
    // alone, even when the selected release differs from the running one. Only
    // `restart` replaces a running process.
    let inspection = pid_file::Inspection::of(&state);
    if let Some((record, identity)) = inspection.live() {
        println!(
            "Server is already running with PID {} (release {}, state file {}); start is idempotent.",
            identity.pid,
            identity.release_version.as_deref().unwrap_or("unknown"),
            record.path
        );
        return Ok(());
    }
    // A live Agent from another release is a conflict, not something this
    // command may fix by restarting it.
    release::ensure_no_mixed_release(pid_file::Component::Agent, pid_file::Component::Server)?;
    inspection.clean_dead();
    for warning in inspection.unresolved_warnings("server") {
        eprintln!("Warning: {warning}");
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
            &state.current,
            pid_file::Component::Server,
            pid_file::ConfigRecord::from_loaded(&selection.path, from_file),
        )?;

        // A foreground daemon owns the terminal for its whole lifetime; holding
        // the lifecycle lock would block every later stop/restart/install.
        drop(lock);
        let result = run_server_foreground(config).await;

        let _ = fs::remove_file(&state.current);

        result?;
    } else {
        info!("Starting server in background mode");
        let exe = std::env::current_exe()?;
        let mut cmd = background_child_command(&exe, &selection, &state.current);

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

        let marker = startup::ReadyMarker::beside_state_file(&state.current);
        marker.arm(&mut cmd);

        let mut child = cmd.spawn().context("failed to spawn server process")?;

        match startup::wait_for_ready(&mut child, &marker, startup::STARTUP_TIMEOUT).await {
            startup::Startup::Serving => {
                let pid = startup::announced_pid(&state.current)?;
                println!("Server started in background with PID {pid}");
                println!("PID file: {}", state.current);
            }
            startup::Startup::Exited(status) => {
                let detail = startup::child_stderr(&mut child);
                let _ = fs::remove_file(&state.current);
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
                let _ = fs::remove_file(&state.current);
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
        drop(lock);
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
        .env(crate::lifecycle::lock::LOCK_HELD_BY_PARENT_ENV, "1")
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
