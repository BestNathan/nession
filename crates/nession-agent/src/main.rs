//! nession-agent binary – startup logic that wires all components together.
//!
//! Startup sequence:
//! 1. Parse configuration (TOML file or defaults)
//! 2. Initialize tracing/logging
//! 3. Create SessionManager
//! 4. Start Agent WebSocket server (P2P client connections)
//! 5. Connect to central server via ServerClient
//! 6. Start HeartbeatLoop (periodic heartbeats)
//! 7. Start SessionWatcher (session change detection)
//! 8. Wait for Ctrl+C shutdown signal
//! 9. Gracefully shut down all components

use anyhow::{Context, Result};
use nession_agent::config::AgentConfig;
use nession_agent::connection::ServerClient;
use nession_agent::extension::ExtensionRegistry;
use nession_agent::identity;
use nession_agent::netdetect::build_advertised_addresses;
use nession_agent::netwatch;
use nession_agent::server::AgentServer;
use nession_agent::sync::heartbeat::HeartbeatLoop;
use nession_agent::sync::session_watcher::SessionWatcher;
use nession_agent::tmux::manager::SessionManager;
use nession_common::extension::AgentExtension;
use nession_common::protocol::AgentMetadata;
use nession_common::system;
use std::path::Path;
use std::sync::Arc;
use tracing::{error, info, warn};

#[tokio::main]
async fn main() -> Result<()> {
    // 1. Load configuration
    let config = load_config()?;

    // 2. Initialize tracing
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

    // 3. Check tmux availability
    match nession_agent::tmux::util::check_tmux_available().await {
        Ok(true) => info!("tmux is available"),
        Ok(false) => warn!("tmux does not appear to be available"),
        Err(e) => warn!("Could not check tmux availability: {}", e),
    }

    // 4. Start Agent WebSocket server
    let tls_option = load_tls(&config)?;
    // Resolve persistent agent identity. On first run this persists the
    // generated or configured agent_id; on subsequent runs it loads the
    // persisted identity so the server recognises us as the same agent.
    let identity_path = nession_common::paths::agent_identity_path()?;
    let agent_id = identity::resolve_agent_id(&config.agent_id, &identity_path)?;

    let file_root = config
        .file_root
        .as_deref()
        .unwrap_or(&config.default_working_dir);
    let agent_server = AgentServer::new(
        &config.listen_address,
        &agent_id,
        tls_option,
        config.default_working_dir.clone(),
        file_root,
        config.attach_mode.clone(),
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

    // 5. Connect to central server
    let hostname = system::get_hostname();
    // Use advertise_address (IP) if configured, otherwise auto-detect
    let ip_address = config
        .advertise_address
        .clone()
        .unwrap_or_else(get_ip_address);
    let port = extract_port(&config.listen_address);

    // Assemble the full advertised-address list: auto-detected NICs (unless
    // disabled) + config-declared endpoints, finalised (deduped, ordered,
    // capped). Sent alongside the legacy ip/port/connect_url fields.
    let addresses = build_advertised_addresses(&config, port);
    info!(
        "Advertising {} P2P address(es): {}",
        addresses.len(),
        addresses
            .iter()
            .map(|a| a.url.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );

    let tmux_version = get_tmux_version().await;
    let os_version = format!("{} {}", std::env::consts::OS, std::env::consts::ARCH);

    let metadata = AgentMetadata {
        tmux_version,
        os_version,
        nession_version: env!("CARGO_PKG_VERSION").to_string(),
        image_tag: option_env!("IMAGE_TAG").unwrap_or("dev").to_string(),
    };

    let tmux_for_client = Arc::new(SessionManager::new());

    // Skip server connection if server_url is empty (standalone mode).
    // The supervisor reconnects on its own, so we capture the handle and the
    // server-advertised heartbeat interval (falling back to the local config).
    let (client_handle, heartbeat_interval_secs) = if config.server_url.trim().is_empty() {
        info!("No server_url configured — running in standalone mode");
        (None, config.heartbeat_interval_secs)
    } else {
        let extensions: Vec<Box<dyn AgentExtension>> = vec![];
        let ext_registry = if extensions.is_empty() {
            None
        } else {
            Some(Arc::new(ExtensionRegistry::new(extensions)))
        };

        let server_client = ServerClient::new(
            &config.server_url,
            &config.auth_token,
            &agent_id,
            &hostname,
            &ip_address,
            port,
            config.connect_url.clone(),
            addresses,
            config.display_name.clone(),
            metadata,
            tmux_for_client,
            config.default_working_dir.clone(),
            ext_registry,
        );

        // Attempt to connect with a timeout so the agent can still serve
        // local clients even if the central server is unreachable. The
        // supervisor keeps retrying in the background regardless.
        tokio::select! {
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
            _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {
                warn!("Timed out connecting to central server after 30s, continuing without sync");
                (None, config.heartbeat_interval_secs)
            }
        }
    };

    // 6. Start HeartbeatLoop
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
        info!(
            "Heartbeat loop started (interval: {}s)",
            heartbeat_interval_secs
        );
        Some(shutdown_handle)
    } else {
        None
    };

    // 7. Start SessionWatcher
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
        info!(
            "Session watcher started (interval: {}s)",
            config.session_poll_interval_secs
        );
        Some(shutdown_handle)
    } else {
        None
    };

    // 7.5. Start network change detector (sends address updates on interface changes).
    if let Some(ref handle) = client_handle {
        netwatch::spawn_watcher(handle.clone(), config.clone(), port);
    }

    // 8. Wait for shutdown signal (Ctrl+C or SIGTERM)
    info!("Agent is running. Press Ctrl+C to stop.");
    wait_for_shutdown().await?;
    info!("Shutdown signal received, stopping components...");

    // 9. Graceful shutdown of all components
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

/// Load agent configuration from a TOML file, falling back to defaults.
fn load_config() -> Result<AgentConfig> {
    let config_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "config.toml".to_string());

    if Path::new(&config_path).exists() {
        let config_str = std::fs::read_to_string(&config_path)
            .with_context(|| format!("failed to read config file: {config_path}"))?;
        let config: AgentConfig = toml::from_str(&config_str)
            .with_context(|| format!("failed to parse config file: {config_path}"))?;
        Ok(config)
    } else {
        info!("No config file found at '{}', using defaults", config_path);
        Ok(AgentConfig::default())
    }
}

/// Load TLS certificates from the paths specified in the config.
/// Returns `None` if no TLS paths are configured (plain WebSocket).
fn load_tls(
    config: &AgentConfig,
) -> Result<
    Option<(
        Vec<rustls::pki_types::CertificateDer<'static>>,
        rustls::pki_types::PrivateKeyDer<'static>,
    )>,
> {
    match (&config.tls_cert_path, &config.tls_key_path) {
        (Some(cert), Some(key)) => AgentServer::load_tls(Some(cert), Some(key)),
        (None, None) => Ok(None),
        _ => anyhow::bail!("both tls_cert_path and tls_key_path must be set (or both unset)"),
    }
}

/// Wait for a shutdown signal (SIGINT/SIGTERM).
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

/// Get the local IP address (best-effort).
fn get_ip_address() -> String {
    // Simple approach: try to determine the local IP by connecting to a
    // remote address (doesn't actually send data).
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            socket.connect("8.8.8.8:80")?;
            socket.local_addr()
        })
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}

/// Extract the port number from a `host:port` address string.
fn extract_port(addr: &str) -> u16 {
    // Handle both IPv4 (host:port) and IPv6 ([host]:port) formats.
    addr.rsplit(':')
        .next()
        .and_then(|p| p.parse().ok())
        .unwrap_or(0)
}

/// Get the tmux version string by running `tmux -V`.
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
