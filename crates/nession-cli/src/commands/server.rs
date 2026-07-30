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

    // Check if server is already running
    if let Ok(pid) = pid_file::read_pid_file(&pid_file) {
        if pid_file::is_process_running(pid) {
            anyhow::bail!("Server is already running with PID {pid}");
        } else {
            // Process not running but PID file exists, clean it up
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

        // Write PID file for the current process (foreground mode)
        let pid = std::process::id();
        pid_file::write_pid_file(&pid_file, pid)?;

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
    // Read PID file
    let pid = match pid_file::read_pid_file(&pid_file) {
        Ok(pid) => pid,
        Err(_) => {
            println!("Server is not running (no PID file found)");
            return Ok(());
        }
    };

    // Check if process is running
    if !pid_file::is_process_running(pid) {
        println!("Server process {pid} is not running");
        // Clean up stale PID file
        let _ = fs::remove_file(&pid_file);
        return Ok(());
    }

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
    // Read PID file
    let pid = match pid_file::read_pid_file(&pid_file) {
        Ok(pid) => pid,
        Err(_) => {
            println!("Status: stopped (no PID file)");
            return Ok(());
        }
    };

    // Check if process is running
    if !pid_file::is_process_running(pid) {
        println!("Status: stopped (process not running)");
        // Clean up stale PID file
        let _ = fs::remove_file(&pid_file);
        return Ok(());
    }

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
            tls_cert_path: String::new(),
            tls_key_path: String::new(),
            auth_token: String::new(),
            heartbeat_interval_secs: 10,
            heartbeat_timeout_secs: 30,
            db_path: nession_common::paths::server_db_path()
                .unwrap_or_else(|_| std::path::PathBuf::from("nession.db"))
                .to_string_lossy()
                .into_owned(),
        })
    }
}

/// Run the server in foreground mode (blocks until shutdown).
async fn run_server_foreground(config: ServerConfig) -> Result<()> {
    // Initialize tracing for foreground mode
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    info!("nession-server {} starting", env!("CARGO_PKG_VERSION"));
    info!("Listen address: {}", config.listen_address);
    info!("Database: {}", config.db_path);

    // Import and run the server components
    use nession_server::db::Database;
    use nession_server::server::WebSocketServer;

    // Initialize database
    info!("Initializing database at {}", config.db_path);
    let database = Database::new(&config.db_path).await?;
    info!("Database initialized successfully");

    // Create and run WebSocket server
    info!("Creating WebSocket server");
    let mut server = WebSocketServer::new(config, std::sync::Arc::new(database)).await?;

    info!("Starting WebSocket server");
    server.run().await?;

    info!("nession-server stopped");
    Ok(())
}
