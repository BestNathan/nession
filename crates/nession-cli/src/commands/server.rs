//! Server CLI commands implementation.

use anyhow::{Context, Result};
use nession_common::config::ServerConfig;
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tracing::{error, info};

/// Start the server process.
pub async fn start(config_path: String, foreground: bool, pid_file: String) -> Result<()> {
    // Check if server is already running
    if let Ok(pid) = read_pid_file(&pid_file) {
        if is_process_running(pid) {
            anyhow::bail!("Server is already running with PID {}", pid);
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
        println!("Starting nession-server with config: {}", config_path);
        println!("Listen address: {}", config.listen_address);
        println!("Database: {}", config.db_path);
        println!("Press Ctrl+C to stop");

        // Write PID file for the current process (foreground mode)
        let pid = std::process::id();
        write_pid_file(&pid_file, pid)?;

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

        let _child = cmd
            .spawn()
            .context("failed to spawn server process")?;

        // Give the child a moment to write its PID file
        tokio::time::sleep(Duration::from_millis(500)).await;

        // Read the PID from the file written by the child
        match read_pid_file(&pid_file) {
            Ok(pid) => {
                println!("Server started in background with PID {}", pid);
                println!("PID file: {}", pid_file);
            }
            Err(_) => {
                println!("Server started in background (waiting for PID file...)");
                // Wait a bit more and try again
                tokio::time::sleep(Duration::from_secs(1)).await;
                if let Ok(pid) = read_pid_file(&pid_file) {
                    println!("Server started in background with PID {}", pid);
                } else {
                    println!("Server is starting, check logs for status");
                }
            }
        }
        println!("Config: {}", config_path);
    }

    Ok(())
}

/// Stop the server process.
pub async fn stop(pid_file: String) -> Result<()> {
    // Read PID file
    let pid = match read_pid_file(&pid_file) {
        Ok(pid) => pid,
        Err(_) => {
            println!("Server is not running (no PID file found)");
            return Ok(());
        }
    };

    // Check if process is running
    if !is_process_running(pid) {
        println!("Server process {} is not running", pid);
        // Clean up stale PID file
        let _ = fs::remove_file(&pid_file);
        return Ok(());
    }

    println!("Stopping server (PID {})...", pid);

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
        if !is_process_running(pid) {
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

    if is_process_running(pid) {
        error!("Failed to stop server process {}", pid);
        anyhow::bail!("Failed to stop server process");
    }

    println!("Server stopped (force killed)");
    // Clean up PID file
    let _ = fs::remove_file(&pid_file);

    Ok(())
}

/// Show server status.
pub async fn status(pid_file: String) -> Result<()> {
    // Read PID file
    let pid = match read_pid_file(&pid_file) {
        Ok(pid) => pid,
        Err(_) => {
            println!("Status: stopped (no PID file)");
            return Ok(());
        }
    };

    // Check if process is running
    if !is_process_running(pid) {
        println!("Status: stopped (process not running)");
        // Clean up stale PID file
        let _ = fs::remove_file(&pid_file);
        return Ok(());
    }

    // Get process start time for uptime calculation
    let uptime = get_process_uptime(pid);

    println!("Status: running");
    println!("PID: {}", pid);
    if let Some(uptime_str) = uptime {
        println!("Uptime: {}", uptime_str);
    }

    // Try to load config to show additional info
    if let Ok(config) = load_server_config("server-config.toml") {
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
            .with_context(|| format!("failed to read config file: {}", path))?;
        let config: ServerConfig = toml::from_str(&config_str)
            .with_context(|| format!("failed to parse config file: {}", path))?;
        Ok(config)
    } else {
        info!("No config file found at '{}', using defaults", path);
        Ok(ServerConfig {
            listen_address: "127.0.0.1:8080".to_string(),
            tls_cert_path: String::new(),
            tls_key_path: String::new(),
            auth_token: String::new(),
            heartbeat_timeout_secs: 30,
            db_path: "./nession-server.db".to_string(),
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
    let _database = Database::new(&config.db_path).await?;
    info!("Database initialized successfully");

    // Create and run WebSocket server
    info!("Creating WebSocket server");
    let mut server = WebSocketServer::new(config).await?;

    info!("Starting WebSocket server");
    server.run().await?;

    info!("nession-server stopped");
    Ok(())
}

/// Write PID to file.
fn write_pid_file(path: &str, pid: u32) -> Result<()> {
    fs::write(path, pid.to_string())
        .with_context(|| format!("failed to write PID file: {}", path))?;
    Ok(())
}

/// Read PID from file.
fn read_pid_file(path: &str) -> Result<u32> {
    let content = fs::read_to_string(path)
        .with_context(|| format!("failed to read PID file: {}", path))?;
    let pid: u32 = content.trim().parse()
        .with_context(|| "failed to parse PID from file")?;
    Ok(pid)
}

/// Check if a process is running.
fn is_process_running(pid: u32) -> bool {
    #[cfg(unix)]
    {
        use nix::sys::signal::kill;
        use nix::unistd::Pid;
        use nix::errno::Errno;

        let nix_pid = Pid::from_raw(pid as i32);
        match kill(nix_pid, None) {
            Ok(_) => true,
            Err(Errno::ESRCH) => false,
            Err(_) => false,
        }
    }

    #[cfg(not(unix))]
    {
        // On non-unix systems, try to read from /proc or use other methods
        false
    }
}

/// Get process uptime as a formatted string.
fn get_process_uptime(pid: u32) -> Option<String> {
    #[cfg(unix)]
    {
        // Try to read process start time from /proc on Linux
        if let Ok(stat) = fs::read_to_string(format!("/proc/{}/stat", pid)) {
            // Parse start time (field 22, 0-indexed 21)
            let fields: Vec<&str> = stat.split_whitespace().collect();
            if fields.len() > 21 {
                if let Ok(start_ticks) = fields[21].parse::<u64>() {
                    // Get system boot time and clock ticks per second
                    if let (Ok(boot_time), Some(clock_ticks)) = (get_boot_time(), get_clock_ticks()) {
                        let start_time = boot_time + (start_ticks / clock_ticks);
                        let now = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .ok()?
                            .as_secs();
                        let uptime_secs = now.saturating_sub(start_time);
                        return Some(format_duration(uptime_secs));
                    }
                }
            }
        }
    }

    None
}

/// Get system boot time (Unix timestamp).
#[cfg(unix)]
fn get_boot_time() -> Result<u64, ()> {
    if let Ok(stat) = fs::read_to_string("/proc/stat") {
        for line in stat.lines() {
            if line.starts_with("btime ") {
                if let Some(btime_str) = line.split_whitespace().nth(1) {
                    if let Ok(btime) = btime_str.parse::<u64>() {
                        return Ok(btime);
                    }
                }
            }
        }
    }
    Err(())
}

/// Get clock ticks per second.
#[cfg(unix)]
fn get_clock_ticks() -> Option<u64> {
    use std::process::Command;

    let output = Command::new("getconf").arg("CLK_TCK").output().ok()?;
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        stdout.trim().parse().ok()
    } else {
        Some(100) // Default on most Linux systems
    }
}

/// Format duration in seconds to human-readable string.
fn format_duration(seconds: u64) -> String {
    let days = seconds / 86400;
    let hours = (seconds % 86400) / 3600;
    let minutes = (seconds % 3600) / 60;
    let secs = seconds % 60;

    if days > 0 {
        format!("{}d {}h {}m {}s", days, hours, minutes, secs)
    } else if hours > 0 {
        format!("{}h {}m {}s", hours, minutes, secs)
    } else if minutes > 0 {
        format!("{}m {}s", minutes, secs)
    } else {
        format!("{}s", secs)
    }
}
