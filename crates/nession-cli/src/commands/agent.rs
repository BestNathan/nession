//! Agent CLI commands implementation.

use crate::utils::{pid_file, process};
use anyhow::{Context, Result};
use nession_agent::config::AgentConfig;
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;
use tracing::{error, info};

/// Start the agent process.
pub async fn start(
    config_path: String,
    foreground: bool,
    pid_file: String,
    server_url_override: Option<String>,
    auth_token_override: Option<String>,
) -> Result<()> {
    // Ensure component directories exist before any file operations (PID file)
    nession_common::paths::ensure_component_dirs()
        .context("failed to create nession component directories")?;

    // Check if agent is already running
    if let Ok(pid) = pid_file::read_pid_file(&pid_file) {
        if pid_file::is_process_running(pid) {
            anyhow::bail!("Agent is already running with PID {pid}");
        } else {
            // Process not running but PID file exists, clean it up
            let _ = fs::remove_file(&pid_file);
        }
    }

    // Load configuration (CLI/env overrides take precedence over file/defaults)
    let config = load_agent_config(&config_path, &server_url_override, &auth_token_override)?;

    if foreground {
        // Run in foreground
        info!("Starting agent in foreground mode");
        println!("Starting nession-agent with config: {config_path}");
        println!("Agent ID: {}", config.agent_id);
        println!("Press Ctrl+C to stop");

        // Write PID file for the current process (foreground mode)
        let pid = std::process::id();
        pid_file::write_pid_file(&pid_file, pid)?;

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
        let mut child_args: Vec<String> = vec![
            "agent".to_string(),
            "start".to_string(),
            "--config".to_string(),
            config_path.clone(),
            "--foreground".to_string(),
        ];
        // Forward CLI/env overrides to the child process so it uses the same values
        if let Some(ref url) = server_url_override {
            child_args.push("--server-url".to_string());
            child_args.push(url.clone());
        }
        if let Some(ref token) = auth_token_override {
            child_args.push("--auth-token".to_string());
            child_args.push(token.clone());
        }
        cmd.args(&child_args)
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
        match pid_file::read_pid_file(&pid_file) {
            Ok(pid) => {
                println!("Agent started in background with PID {pid}");
                println!("PID file: {pid_file}");
            }
            Err(_) => {
                println!("Agent started in background (waiting for PID file...)");
                // Wait a bit more and try again
                tokio::time::sleep(Duration::from_secs(1)).await;
                if let Ok(pid) = pid_file::read_pid_file(&pid_file) {
                    println!("Agent started in background with PID {pid}");
                } else {
                    println!("Agent is starting, check logs for status");
                }
            }
        }
        println!("Config: {config_path}");
    }

    Ok(())
}

/// Stop the agent process.
pub async fn stop(pid_file: String) -> Result<()> {
    // Read PID file
    let pid = match pid_file::read_pid_file(&pid_file) {
        Ok(pid) => pid,
        Err(_) => {
            println!("Agent is not running (no PID file found)");
            return Ok(());
        }
    };

    // Check if process is running
    if !pid_file::is_process_running(pid) {
        println!("Agent process {pid} is not running");
        // Clean up stale PID file
        let _ = fs::remove_file(&pid_file);
        return Ok(());
    }

    println!("Stopping agent (PID {pid})...");

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

    if pid_file::is_process_running(pid) {
        error!("Failed to stop agent process {}", pid);
        anyhow::bail!("Failed to stop agent process");
    }

    println!("Agent stopped (force killed)");
    // Clean up PID file
    let _ = fs::remove_file(&pid_file);

    Ok(())
}

/// Restart the agent process (stop then start).
pub async fn restart(
    config_path: String,
    foreground: bool,
    pid_file: String,
    server_url_override: Option<String>,
    auth_token_override: Option<String>,
) -> Result<()> {
    println!("Restarting agent...");
    stop(pid_file.clone()).await?;
    start(
        config_path,
        foreground,
        pid_file,
        server_url_override,
        auth_token_override,
    )
    .await
}

/// Show agent status.
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
    let default_config_path = nession_common::paths::agent_config_path()
        .unwrap_or_else(|_| std::path::PathBuf::from("agent-config.toml"));
    let default_config_path = default_config_path.to_string_lossy();
    if let Ok(config) = load_agent_config(&default_config_path, &None, &None) {
        println!("Agent ID: {}", config.agent_id);
        println!("Server URL: {}", config.server_url);
        println!("Listen address: {}", config.listen_address);
    }

    Ok(())
}

/// Load agent configuration from file or use defaults.
/// CLI flags and env vars (passed as overrides) take precedence over config file values.
fn load_agent_config(
    path: &str,
    server_url_override: &Option<String>,
    auth_token_override: &Option<String>,
) -> Result<AgentConfig> {
    let mut config = if Path::new(path).exists() {
        let config_str = fs::read_to_string(path)
            .with_context(|| format!("failed to read config file: {path}"))?;
        toml::from_str::<AgentConfig>(&config_str)
            .with_context(|| format!("failed to parse config file: {path}"))?
    } else {
        info!("No config file found at '{}', using defaults", path);
        AgentConfig::default()
    };

    // Apply CLI/env overrides (they take precedence over config file)
    if let Some(url) = server_url_override {
        config.server_url = url.clone();
    }
    if let Some(token) = auth_token_override {
        config.auth_token = token.clone();
    }

    Ok(config)
}

/// Run the agent in foreground mode (blocks until shutdown).
async fn run_agent_foreground(config: AgentConfig) -> Result<()> {
    // Initialize logging (stdout + file).
    let _log_guard = nession_common::logging::init_logging(
        &config.logging,
        &nession_common::paths::agent_logs_dir()?,
        "nession-agent",
    )?;

    info!("nession-agent {} starting", env!("CARGO_PKG_VERSION"));
    info!("Agent ID: {}", config.agent_id);
    info!("Server URL: {}", config.server_url);
    info!("Listen address: {}", config.listen_address);

    // Import and run the agent components
    use nession_agent::connection::ServerClient;
    use nession_agent::server::AgentServer;
    use nession_agent::sync::heartbeat::HeartbeatLoop;
    use nession_agent::sync::session_watcher::SessionWatcher;
    use nession_agent::tmux::manager::SessionManager;
    use nession_common::protocol::AgentMetadata;
    use std::sync::Arc;

    // Start Agent WebSocket server
    let tls_option = load_tls(&config)?;
    let file_root = config
        .file_root
        .as_deref()
        .unwrap_or(&config.default_working_dir);
    let agent_id = if config.agent_id.is_empty() {
        nession_common::system::get_hostname()
    } else {
        config.agent_id.clone()
    };
    let agent_server = AgentServer::new(
        &config.listen_address,
        &agent_id,
        tls_option,
        config.default_working_dir.clone(),
        file_root,
        config.attach_mode.clone(),
    )
    .context("failed to create agent server")?;
    let (server_handle, listen_addr) = agent_server
        .start()
        .await
        .context("failed to start agent server")?;
    info!("Agent WebSocket server started on {}", listen_addr);

    // Connect to central server
    let hostname = nession_common::system::get_hostname();
    let ip_address = get_ip_address();
    let port = extract_port(&config.listen_address);
    // Advertise all non-loopback NIC addresses so clients can pick the best
    // P2P path; falls back to the legacy ip/port if detection finds nothing.
    let addresses = {
        let (finalised, _dropped) = nession_common::address::finalize_addresses(
            nession_agent::netdetect::detect_local_addresses(port),
        );
        finalised
    };
    let tmux_version = get_tmux_version().await;
    let os_version = format!("{} {}", std::env::consts::OS, std::env::consts::ARCH);

    let metadata = AgentMetadata {
        tmux_version,
        os_version,
        nession_version: env!("CARGO_PKG_VERSION").to_string(),
        image_tag: option_env!("IMAGE_TAG").unwrap_or("dev").to_string(),
    };

    let server_client = ServerClient::new(
        &config.server_url,
        &config.auth_token,
        &config.agent_id,
        &hostname,
        &ip_address,
        port,
        None, // connect_url — not used in CLI bare-metal agent mode
        addresses,
        None, // display_name — not used in CLI bare-metal agent mode
        metadata,
        Arc::new(SessionManager::new()),
        config.default_working_dir.clone(),
        None, // extension_registry
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
        let heartbeat = HeartbeatLoop::new(
            handle.clone(),
            SessionManager::new(),
            heartbeat_interval_secs,
        );
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
            SessionManager::new(),
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
    wait_for_shutdown().await?;
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
async fn wait_for_shutdown() -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigint =
            signal(SignalKind::interrupt()).context("failed to register SIGINT handler")?;
        let mut sigterm =
            signal(SignalKind::terminate()).context("failed to register SIGTERM handler")?;
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
            .context("failed to listen for ctrl+c")?;
        info!("Received Ctrl+C");
    }
    Ok(())
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
