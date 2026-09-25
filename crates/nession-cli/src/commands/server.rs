//! Server CLI commands implementation.

use crate::utils::{pid_file, process};
use anyhow::{Context, Result};
use nession_common::config::ServerConfig;
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;
use tracing::{error, info};

/// Start the server process.
pub async fn start(config_path: String, foreground: bool, pid_file: String) -> Result<()> {
    // Ensure component directories exist before any file operations (PID file, DB)
    nession_common::paths::ensure_component_dirs()
        .context("failed to create nession component directories")?;

    // Already running, decided by ownership rather than by pid (#1016) — the
    // same question the agent path asks, for the same reason: a stale file whose
    // pid was reused must not read as "already running".
    match pid_file::ownership(&pid_file) {
        Ok(pid_file::Ownership::Alive(identity)) => {
            anyhow::bail!("Server is already running with PID {}", identity.pid);
        }
        Ok(_) | Err(_) => {
            let _ = fs::remove_file(&pid_file);
        }
    }

    // Load configuration
    let config = load_server_config(&config_path)?;

    if foreground {
        // Run in foreground
        info!("Starting server in foreground mode");
        println!("Starting nession-server with config: {config_path}");
        println!("Listen address: {}", config.listen_address);
        println!("Database: {}", config.db_path);
        println!("Press Ctrl+C to stop");

        // Record this process's identity (foreground mode) — not a bare pid.
        pid_file::write_identity(&pid_file, pid_file::Component::Server)?;

        // Run the server directly (this will block)
        let result = run_server_foreground(config).await;

        // Clean up PID file on exit
        let _ = fs::remove_file(&pid_file);

        result?;
    } else {
        // Run in background
        info!("Starting server in background mode");

        // Get current executable path
        let exe = std::env::current_exe()?;

        // Spawn the server process with proper daemonization on Unix
        let mut cmd = Command::new(&exe);
        cmd.args(["server", "start", "--config", &config_path, "--foreground"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        // On Unix, detach the child process from the parent's session
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            unsafe {
                cmd.pre_exec(|| {
                    // Create a new session to detach from parent
                    libc::setsid();
                    Ok(())
                });
            }
        }

        let _child = cmd.spawn().context("failed to spawn server process")?;

        // Give the child a moment to write its PID file
        tokio::time::sleep(Duration::from_millis(500)).await;

        // Read the PID from the file written by the child
        match pid_file::read_pid_file(&pid_file) {
            Ok(pid) => {
                println!("Server started in background with PID {pid}");
                println!("PID file: {pid_file}");
            }
            Err(_) => {
                println!("Server started in background (waiting for PID file...)");
                // Wait a bit more and try again
                tokio::time::sleep(Duration::from_secs(1)).await;
                if let Ok(pid) = pid_file::read_pid_file(&pid_file) {
                    println!("Server started in background with PID {pid}");
                } else {
                    println!("Server is starting, check logs for status");
                }
            }
        }
        println!("Config: {config_path}");
    }

    Ok(())
}

/// Stop the server process.
pub async fn stop(pid_file: String) -> Result<()> {
    // Ownership, not liveness (#1016) — the same reading the agent's `stop`
    // makes, and for the same reason: a reused pid is somebody else's process.
    let pid = match pid_file::ownership(&pid_file) {
        Ok(pid_file::Ownership::Alive(identity)) => identity.pid,
        Ok(pid_file::Ownership::Reused(identity)) => {
            println!(
                "Recorded pid {} is running but is not this server — not signalling it.",
                identity.pid
            );
            let _ = fs::remove_file(&pid_file);
            return Ok(());
        }
        Ok(pid_file::Ownership::Stale(identity)) => {
            println!("Server process {} is not running", identity.pid);
            let _ = fs::remove_file(&pid_file);
            return Ok(());
        }
        Err(_) => {
            println!("Server is not running (no state file found)");
            return Ok(());
        }
    };

    println!("Stopping server (PID {pid})...");

    // Send SIGTERM
    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;

        let nix_pid = Pid::from_raw(pid as i32);
        kill(nix_pid, Signal::SIGTERM).context("failed to send SIGTERM")?;
    }

    // Wait for graceful shutdown (5 seconds)
    let timeout = Duration::from_secs(5);
    let start = std::time::Instant::now();

    while start.elapsed() < timeout {
        if !pid_file::is_process_running(pid) {
            println!("Server stopped successfully");
            // Clean up PID file
            let _ = fs::remove_file(&pid_file);
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // Process didn't stop gracefully, try SIGKILL
    println!("Server didn't stop gracefully, sending SIGKILL...");

    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;

        let nix_pid = Pid::from_raw(pid as i32);
        kill(nix_pid, Signal::SIGKILL).context("failed to send SIGKILL")?;
    }

    // Wait a bit more for SIGKILL
    tokio::time::sleep(Duration::from_millis(500)).await;

    if pid_file::is_process_running(pid) {
        error!("Failed to stop server process {}", pid);
        anyhow::bail!("Failed to stop server process");
    }

    println!("Server stopped (force killed)");
    // Clean up PID file
    let _ = fs::remove_file(&pid_file);

    Ok(())
}

/// Restart the server process (stop then start).
pub async fn restart(config_path: String, foreground: bool, pid_file: String) -> Result<()> {
    println!("Restarting server...");
    stop(pid_file.clone()).await?;
    start(config_path, foreground, pid_file).await
}

/// Show server status.
pub async fn status(pid_file: String) -> Result<()> {
    // Ownership, like `stop` (#1016): reading a bare pid out of an identity
    // file would report a serving server as stopped.
    let pid = match pid_file::ownership(&pid_file) {
        Ok(pid_file::Ownership::Alive(identity)) => identity.pid,
        Ok(pid_file::Ownership::Reused(identity)) => {
            println!(
                "Status: stopped (pid {} is running but is not this server)",
                identity.pid
            );
            let _ = fs::remove_file(&pid_file);
            return Ok(());
        }
        Ok(pid_file::Ownership::Stale(_)) => {
            println!("Status: stopped (process not running)");
            let _ = fs::remove_file(&pid_file);
            return Ok(());
        }
        Err(_) => {
            println!("Status: stopped (no state file)");
            return Ok(());
        }
    };

    // Get process start time for uptime calculation
    let uptime = process::get_process_uptime(pid).map(pid_file::format_duration);

    println!("Status: running");
    println!("PID: {pid}");
    if let Some(uptime_str) = uptime {
        println!("Uptime: {uptime_str}");
    }

    // Try to load config to show additional info
    let default_config_path = nession_common::paths::server_config_path()
        .unwrap_or_else(|_| std::path::PathBuf::from("server-config.toml"));
    let default_config_path = default_config_path.to_string_lossy();
    if let Ok(config) = load_server_config(&default_config_path) {
        println!("Listen address: {}", config.listen_address);
        println!("Database: {}", config.db_path);
        println!("Heartbeat timeout: {}s", config.heartbeat_timeout_secs);
    }

    Ok(())
}

/// Load server configuration from file or use defaults.
fn load_server_config(path: &str) -> Result<ServerConfig> {
    if Path::new(path).exists() {
        let config_str = fs::read_to_string(path)
            .with_context(|| format!("failed to read config file: {path}"))?;
        let config: ServerConfig = toml::from_str(&config_str)
            .with_context(|| format!("failed to parse config file: {path}"))?;
        Ok(config)
    } else {
        info!("No config file found at '{}', using defaults", path);
        Ok(ServerConfig {
            listen_address: "127.0.0.1:8080".to_string(),
            ..Default::default()
        })
    }
}

/// Run the server in foreground mode (blocks until shutdown).
async fn run_server_foreground(config: ServerConfig) -> Result<()> {
    // The composition is not here: `nession_server::runtime` owns it (#1014).
    //
    // This copy had already drifted the same way the Agent's had — it skipped
    // `ensure_component_dirs`, so a Server started through this path depended on
    // the directories already existing while `nession-server` created them.
    nession_server::runtime::run(config).await
}
