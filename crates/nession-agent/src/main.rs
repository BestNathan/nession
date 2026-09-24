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
use nession_agent::git_workdir::TmuxWorkdirResolver;
use nession_agent::identity;
use nession_agent::netdetect::build_advertised_addresses;
use nession_agent::netwatch;
use nession_agent::protocol::served_descriptors;
use nession_agent::server::AgentServer;
use nession_agent::sync::heartbeat::HeartbeatLoop;
use nession_agent::sync::session_watcher::SessionWatcher;
use nession_agent::tmux::manager::SessionManager;
use nession_claude_code::agent::ClaudeCodeAgentExtension;
use nession_common::extension::AgentExtension;
use nession_common::system;
use nession_git::GitAgentExtension;
use nession_protocol::contracts::agent::v1::AgentMetadata;
use std::path::Path;
use std::sync::Arc;
use tracing::{error, info, warn};

#[tokio::main]
async fn main() -> Result<()> {
    // Diagnostic: print immediately to stderr to confirm process starts
    eprintln!("[DIAGNOSTIC] nession-agent process started");

    // 1. Load configuration
    eprintln!("[DIAGNOSTIC] Loading configuration...");
    let config = match load_config() {
        Ok(c) => {
            eprintln!("[DIAGNOSTIC] Configuration loaded successfully");
            c
        }
        Err(e) => {
            eprintln!("[DIAGNOSTIC] ERROR: Failed to load configuration: {e:?}");
            return Err(e);
        }
    };

    // 2. Initialize logging (stdout + file)
    eprintln!("[DIAGNOSTIC] Initializing logging...");
    let _log_guard = match nession_common::logging::init_logging(
        &config.logging,
        &nession_common::paths::agent_logs_dir()?,
        "nession-agent",
    ) {
        Ok(g) => {
            eprintln!("[DIAGNOSTIC] Logging initialized successfully");
            g
        }
        Err(e) => {
            eprintln!("[DIAGNOSTIC] ERROR: Failed to initialize logging: {e:?}");
            return Err(e.into());
        }
    };

    eprintln!("[DIAGNOSTIC] About to log startup info...");
    info!("nession-agent {} starting", env!("CARGO_PKG_VERSION"));
    eprintln!("[DIAGNOSTIC] Startup info logged");
    info!("Agent ID: {}", config.agent_id);
    info!("Server URL: {}", config.server_url);
    info!("Listen address: {}", config.listen_address);

    eprintln!("[DIAGNOSTIC] About to check tmux availability...");
    // 3. Bind tmux to nession's own socket, before any tmux command runs.
    // Every later tmux invocation addresses this socket explicitly, so
    // nession's sessions are invisible to `tmux ls` on the default socket and
    // cannot be taken down along with the user's own tmux server. A socket that
    // cannot be prepared is fatal — falling back to the default socket is the
    // behaviour this replaces (#575).
    let tmux_socket = nession_agent::tmux::cmd::configure(config.tmux_socket_path.as_deref())?;
    eprintln!("[DIAGNOSTIC] tmux socket: {}", tmux_socket.display());
    info!("tmux socket: {}", tmux_socket.display());
    info!(
        "attach a session by hand with: tmux -S {} attach -t <name>",
        tmux_socket.display()
    );

    // 3.5. Check tmux availability
    match nession_agent::tmux::util::check_tmux_available().await {
        Ok(true) => {
            eprintln!("[DIAGNOSTIC] tmux check returned true");
            info!("tmux is available");
        }
        Ok(false) => {
            eprintln!("[DIAGNOSTIC] tmux check returned false");
            warn!("tmux does not appear to be available");
        }
        Err(e) => {
            eprintln!("[DIAGNOSTIC] tmux check returned error: {e:?}");
            warn!("Could not check tmux availability: {}", e);
        }
    }
    eprintln!("[DIAGNOSTIC] tmux check completed");

    // 4. Start Agent WebSocket server
    eprintln!("[DIAGNOSTIC] Loading TLS...");
    let tls_option = load_tls(&config)?;
    eprintln!("[DIAGNOSTIC] TLS loaded");
    // Resolve persistent agent identity. On first run this persists the
    // generated or configured agent_id; on subsequent runs it loads the
    // persisted identity so the server recognises us as the same agent.
    eprintln!("[DIAGNOSTIC] Resolving agent identity...");
    let identity_path = nession_common::paths::agent_identity_path()?;
    eprintln!("[DIAGNOSTIC] Identity path: {identity_path:?}");
    let agent_id = identity::resolve_agent_id(&config.agent_id, &identity_path)?;
    eprintln!("[DIAGNOSTIC] Agent ID resolved: {agent_id}");

    let file_root = config
        .file_root
        .as_deref()
        .unwrap_or(&config.default_working_dir);
    eprintln!("[DIAGNOSTIC] Creating resize lane...");
    // Resize forwarding lane: the P2P AgentServer publishes tmux
    // `%window-resize` events here (it starts before the central-server
    // connection exists, so it can't hold the handle directly), and the
    // forwarder spawned below drains them into the central server once a
    // live ServerClientHandle is available.
    //
    // A level, not a queue: each session's *latest* size is what the forwarder
    // is going to send, so the lane keeps one of them per session instead of
    // every intermediate one a busy pane produces (#961-D). See
    // `nession_agent::server::resize`.
    let (resize, mut resize_updates) = nession_agent::server::ResizeReporter::new();
    eprintln!("[DIAGNOSTIC] Creating AgentServer...");
    let agent_server = AgentServer::new(
        &config.listen_address,
        &agent_id,
        tls_option,
        config.default_working_dir.clone(),
        file_root,
        config.attach_mode.clone(),
        resize,
    )
    .context("failed to create agent server")?;
    eprintln!("[DIAGNOSTIC] AgentServer created, starting...");
    let (server_handle, listen_addr) = agent_server
        .start()
        .await
        .context("failed to start agent server")?;
    eprintln!("[DIAGNOSTIC] AgentServer started on {listen_addr}");
    info!("Agent WebSocket server started on {}", listen_addr);

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

    let tmux_version = nession_agent::tmux::util::tmux_version().await;
    let os_version = format!("{} {}", std::env::consts::OS, std::env::consts::ARCH);

    let metadata = AgentMetadata {
        tmux_version,
        os_version,
        nession_version: env!("CARGO_PKG_VERSION").to_string(),
        image_tag: option_env!("IMAGE_TAG").unwrap_or("dev").to_string(),
    };

    let tmux_for_client = Arc::new(SessionManager::new());

    eprintln!("[DIAGNOSTIC] Checking server_url: '{}'", config.server_url);
    // Skip server connection if server_url is empty (standalone mode).
    // The supervisor reconnects on its own, so we capture the handle and the
    // server-advertised heartbeat interval (falling back to the local config).
    let (client_handle, heartbeat_interval_secs) = if config.server_url.trim().is_empty() {
        eprintln!("[DIAGNOSTIC] No server_url configured — standalone mode");
        info!("No server_url configured — running in standalone mode");
        (None, config.heartbeat_interval_secs)
    } else {
        eprintln!(
            "[DIAGNOSTIC] Connecting to central server at {}...",
            config.server_url
        );
        let extensions: Vec<Box<dyn AgentExtension>> = vec![
            Box::new(ClaudeCodeAgentExtension::new()),
            // #750. The resolver is what keeps git inside the Session's own
            // working directory: the client names a session, never a path.
            Box::new(GitAgentExtension::new(
                "git",
                Arc::new(TmuxWorkdirResolver::new(Arc::clone(&tmux_for_client))),
            )),
        ];
        // Composition is a boundary, so it is allowed to fail — and this is
        // where the process says so rather than starting with a registry that
        // silently dropped a provider.
        //
        // The `is_empty` guard that used to stand here could never fire: the vec
        // above is a non-empty literal, so its `None` branch was unreachable
        // code standing in for a check that did not exist. `ServerClient` still
        // takes an `Option`, because callers that compose no extensions — the
        // CLI, and most tests — legitimately have none; this path always does.
        //
        // The third argument is the other half of what this runtime serves: the
        // Protocol Units whose handlers are the agent's own methods rather than
        // an extension. They come from the two invocations that dispatch them
        // (`core_routes!` for the server connection, `p2p_routes!` for the
        // agent's own socket), so the manifest cannot advertise a unit neither
        // message loop routes.
        let ext_registry = Arc::new(
            ExtensionRegistry::new(agent_id.clone(), extensions, served_descriptors()?)
                .context("cannot compose this agent's protocol providers")?,
        );

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
            Some(ext_registry),
        );

        // Attempt to connect with a timeout so the agent can still serve
        // local clients even if the central server is unreachable. The
        // supervisor keeps retrying in the background regardless.
        eprintln!("[DIAGNOSTIC] Calling connect_and_run...");
        tokio::select! {
            result = server_client.connect_and_run() => {
                eprintln!("[DIAGNOSTIC] connect_and_run returned");
                match result {
                    Ok((handle, server_interval)) => {
                        let interval = server_interval.unwrap_or(config.heartbeat_interval_secs);
                        eprintln!("[DIAGNOSTIC] Connected to central server!");
                        info!("Connected to central server (heartbeat interval: {}s)", interval);
                        (Some(handle), interval)
                    }
                    Err(e) => {
                        eprintln!("[DIAGNOSTIC] Failed to connect: {e:?}");
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

    // Forward tmux resize events from the P2P server to the central server so
    // relay clients (browser → server → agent) receive size updates. Events
    // arriving while disconnected are dropped — the next attach re-syncs the
    // pane size via the initial `query_window_size` flow.
    //
    // What a consumer that is behind costs now is a superseded intermediate
    // size and not a queue: the lane holds one value per session, so a
    // disconnected or slow central connection can no longer make this the one
    // place in the agent whose memory grows with how long it stayed away.
    if let Some(ref handle) = client_handle {
        let handle = handle.clone();
        tokio::spawn(async move {
            while let Some((session_id, cols, rows)) = resize_updates.next().await {
                if handle.is_connected() {
                    let _ = handle.send_terminal_resize(&session_id, cols, rows);
                }
            }
        });
    } else {
        // No central-server connection: drop the consumer. The agent's P2P
        // server keeps publishing, and the lane keeps the latest size per
        // session — bounded by the number of sessions, and overwritten rather
        // than accumulated, so there is nothing here for a reader to rescue.
        drop(resize_updates);
    }

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
