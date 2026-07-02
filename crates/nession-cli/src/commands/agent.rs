//! Agent CLI commands implementation.

use anyhow::{Context, Result};
use nession_agent::config::AgentConfig;
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tracing::{error, info};

/// Start the agent process.
pub async fn start(config_path: String, foreground: bool, pid_file: String) -> Result<()> {
    // Ensure component directories exist before any file operations (PID file)
    nession_common::paths::ensure_component_dirs()
        .context("failed to create nession component directories")?;

    // Check if agent is already running
    if let Ok(pid) = read_pid_file(&pid_file) {
        if is_process_running(pid) {
            anyhow::bail!("Agent is already running with PID {}", pid);
        } else {
            // Process not running but PID file exists, clean it up
            let _ = fs::remove_file(&pid_file);
        }
    }

    // Load configuration
    let config = load_agent_config(&config_path)?;

    if foreground {
        // Run in foreground
        info!("Starting agent in foreground mode");
        println!("Starting nession-agent with config: {}", config_path);
        println!("Agent ID: {}", config.agent_id);
        println!("Press Ctrl+C to stop");

        // Write PID file for the current process (foreground mode)
        let pid = std::process::id();
        write_pid_file(&pid_file, pid)?;

        // Run the agent directly (this will block)
        let result = run_agent_foreground(config).await;

        // Clean up PID file on exit
        let _ = fs::remove_file(&pid_file);

        result?;
    } else {
        // Run in background
        info!("Starting agent in background mode");

        // Get current executable path
        let exe = std::env::current_exe()?;

        // Spawn the agent process with proper daemonization on Unix
        let mut cmd = Command::new(&exe);
        cmd.args(["agent", "start", "--config", &config_path, "--foreground"])
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

        let _child = cmd.spawn().context("failed to spawn agent process")?;

        // Give the child a moment to write its PID file
        tokio::time::sleep(Duration::from_millis(500)).await;

        // Read the PID from the file written by the child
        match read_pid_file(&pid_file) {
            Ok(pid) => {
                println!("Agent started in background with PID {}", pid);
                println!("PID file: {}", pid_file);
            }
            Err(_) => {
                println!("Agent started in background (waiting for PID file...)");
                // Wait a bit more and try again
                tokio::time::sleep(Duration::from_secs(1)).await;
                if let Ok(pid) = read_pid_file(&pid_file) {
                    println!("Agent started in background with PID {}", pid);
                } else {
                    println!("Agent is starting, check logs for status");
                }
            }
        }
        println!("Config: {}", config_path);
    }

    Ok(())
}

/// Stop the agent process.
pub async fn stop(pid_file: String) -> Result<()> {
    // Read PID file
    let pid = match read_pid_file(&pid_file) {
        Ok(pid) => pid,
        Err(_) => {
            println!("Agent is not running (no PID file found)");
            return Ok(());
        }
    };

    // Check if process is running
    if !is_process_running(pid) {
        println!("Agent process {} is not running", pid);
        // Clean up stale PID file
        let _ = fs::remove_file(&pid_file);
        return Ok(());
    }

    println!("Stopping agent (PID {})...", pid);

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
            println!("Agent stopped successfully");
            // Clean up PID file
            let _ = fs::remove_file(&pid_file);
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // Process didn't stop gracefully, try SIGKILL
    println!("Agent didn't stop gracefully, sending SIGKILL...");

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
        error!("Failed to stop agent process {}", pid);
        anyhow::bail!("Failed to stop agent process");
    }

    println!("Agent stopped (force killed)");
    // Clean up PID file
    let _ = fs::remove_file(&pid_file);

    Ok(())
}

/// Show agent status.
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
    if let Ok(config) = load_agent_config("agent-config.toml") {
        println!("Agent ID: {}", config.agent_id);
        println!("Server URL: {}", config.server_url);
        println!("Listen address: {}", config.listen_address);
    }

    Ok(())
}

/// Load agent configuration from file or use defaults.
fn load_agent_config(path: &str) -> Result<AgentConfig> {
    if Path::new(path).exists() {
        let config_str = fs::read_to_string(path)
            .with_context(|| format!("failed to read config file: {}", path))?;
        let config: AgentConfig = toml::from_str(&config_str)
            .with_context(|| format!("failed to parse config file: {}", path))?;
        Ok(config)
    } else {
        info!("No config file found at '{}', using defaults", path);
        Ok(AgentConfig::default())
    }
}

/// Run the agent in foreground mode (blocks until shutdown).
async fn run_agent_foreground(config: AgentConfig) -> Result<()> {
    // Initialize tracing for foreground mode
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    info!("nession-agent {} starting", env!("CARGO_PKG_VERSION"));
    info!("Agent ID: {}", config.agent_id);
    info!("Server URL: {}", config.server_url);
    info!("Listen address: {}", config.listen_address);

    // Import and run the agent components
    use nession_agent::connection::ServerClient;
    use nession_agent::server::AgentServer;
    use nession_agent::sync::heartbeat::HeartbeatLoop;
    use nession_agent::sync::session_watcher::SessionWatcher;
    use nession_agent::tmux::manager::TmuxManager;
    use nession_common::protocol::AgentMetadata;
    use std::sync::Arc;

    // Start Agent WebSocket server
    let tls_option = load_tls(&config)?;
    let file_root = config.file_root.as_deref().unwrap_or(&config.default_working_dir);
    let agent_server = AgentServer::new(
        &config.listen_address,
        tls_option,
        config.default_working_dir.clone(),
        file_root,
    )
    .context("failed to create agent server")?;
    let server_handle = agent_server
        .start()
        .await
        .context("failed to start agent server")?;
    info!(
        "Agent WebSocket server started on {}",
        config.listen_address
    );

    // Connect to central server
    let hostname = get_hostname();
    let ip_address = get_ip_address();
    let port = extract_port(&config.listen_address);
    let tmux_version = get_tmux_version().await;
    let os_version = format!("{} {}", std::env::consts::OS, std::env::consts::ARCH);

    let metadata = AgentMetadata {
        tmux_version,
        os_version,
        nession_version: env!("CARGO_PKG_VERSION").to_string(),
    };

    let server_client = ServerClient::new(
        &config.server_url,
        &config.auth_token,
        &config.agent_id,
        &hostname,
        &ip_address,
        port,
        None, // connect_url — not used in CLI bare-metal agent mode
        metadata,
        Arc::new(TmuxManager::new()),
        config.default_working_dir.clone(),
    );

    let (client_handle, heartbeat_interval_secs) = tokio::select! {
        result = server_client.connect_and_run() => {
            match result {
                Ok((handle, server_interval)) => {
                    let interval = server_interval.unwrap_or(config.heartbeat_interval_secs);
                    info!("Connected to central server (heartbeat interval: {}s)", interval);
                    (Some(handle), interval)
                }
                Err(e) => {
                    error!("Failed to connect to central server: {:#}", e);
                    (None, config.heartbeat_interval_secs)
                }
            }
        }
        _ = tokio::time::sleep(Duration::from_secs(30)) => {
            info!("Timed out connecting to central server after 30s, continuing without sync");
            (None, config.heartbeat_interval_secs)
        }
    };

    // Start HeartbeatLoop
    let heartbeat_shutdown = if let Some(ref handle) = client_handle {
        let heartbeat =
            HeartbeatLoop::new(handle.clone(), TmuxManager::new(), heartbeat_interval_secs);
        let shutdown_handle = heartbeat.shutdown_handle();
        tokio::spawn(async move {
            if let Err(e) = heartbeat.run().await {
                error!("Heartbeat loop error: {:#}", e);
            }
        });
        Some(shutdown_handle)
    } else {
        None
    };

    // Start SessionWatcher
    let watcher_shutdown = if let Some(ref handle) = client_handle {
        let watcher = SessionWatcher::new(
            handle.clone(),
            TmuxManager::new(),
            config.session_poll_interval_secs,
        );
        let shutdown_handle = watcher.shutdown_handle();
        tokio::spawn(async move {
            if let Err(e) = watcher.run().await {
                error!("Session watcher error: {:#}", e);
            }
        });
        Some(shutdown_handle)
    } else {
        None
    };

    // Wait for shutdown signal
    info!("Agent is running. Press Ctrl+C to stop.");
    wait_for_shutdown().await;
    info!("Shutdown signal received, stopping components...");

    // Graceful shutdown
    if let Err(e) = server_handle.shutdown().await {
        error!("Error shutting down agent server: {:#}", e);
    }
    if let Some(ref handle) = heartbeat_shutdown {
        if let Err(e) = handle.shutdown().await {
            error!("Error shutting down heartbeat loop: {:#}", e);
        }
    }
    if let Some(ref handle) = watcher_shutdown {
        if let Err(e) = handle.shutdown().await {
            error!("Error shutting down session watcher: {:#}", e);
        }
    }

    info!("nession-agent stopped");
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
    let content =
        fs::read_to_string(path).with_context(|| format!("failed to read PID file: {}", path))?;
    let pid: u32 = content
        .trim()
        .parse()
        .with_context(|| "failed to parse PID from file")?;
    Ok(pid)
}

/// Check if a process is running.
fn is_process_running(pid: u32) -> bool {
    #[cfg(unix)]
    {
        use nix::errno::Errno;
        use nix::sys::signal::kill;
        use nix::unistd::Pid;

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
                    if let (Ok(boot_time), Some(clock_ticks)) = (get_boot_time(), get_clock_ticks())
                    {
                        let start_time = boot_time + (start_ticks / clock_ticks);
                        let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
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

/// Load TLS certificates from config.
fn load_tls(
    config: &AgentConfig,
) -> Result<
    Option<(
        Vec<rustls::pki_types::CertificateDer<'static>>,
        rustls::pki_types::PrivateKeyDer<'static>,
    )>,
> {
    match (&config.tls_cert_path, &config.tls_key_path) {
        (Some(cert), Some(key)) => {
            use nession_agent::server::AgentServer;
            AgentServer::load_tls(Some(cert), Some(key))
        }
        (None, None) => Ok(None),
        _ => anyhow::bail!("both tls_cert_path and tls_key_path must be set (or both unset)"),
    }
}

/// Wait for shutdown signal (SIGINT/SIGTERM).
async fn wait_for_shutdown() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigint =
            signal(SignalKind::interrupt()).expect("failed to register SIGINT handler");
        let mut sigterm =
            signal(SignalKind::terminate()).expect("failed to register SIGTERM handler");
        tokio::select! {
            _ = sigint.recv() => {
                info!("Received SIGINT");
            }
            _ = sigterm.recv() => {
                info!("Received SIGTERM");
            }
        }
    }

    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to listen for ctrl+c");
        info!("Received Ctrl+C");
    }
}

/// Get the system hostname.
fn get_hostname() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("HOST"))
        .unwrap_or_else(|_| "unknown".to_string())
}

/// Get the local IP address.
fn get_ip_address() -> String {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            socket.connect("8.8.8.8:80")?;
            socket.local_addr()
        })
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}

/// Extract port from address string.
fn extract_port(addr: &str) -> u16 {
    addr.rsplit(':')
        .next()
        .and_then(|p| p.parse().ok())
        .unwrap_or(0)
}

/// Get tmux version.
async fn get_tmux_version() -> String {
    tokio::process::Command::new("tmux")
        .arg("-V")
        .output()
        .await
        .ok()
        .and_then(|output| {
            if output.status.success() {
                Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "unknown".to_string())
}
