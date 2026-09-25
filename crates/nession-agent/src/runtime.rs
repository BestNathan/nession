//! The Agent runtime: one composition, every entrypoint.
//!
//! This is the **only** place the Agent's composition is expressed. The
//! `nession-agent` binary and `nession agent start --foreground` both call
//! [`run`], so a provider or subsystem added here reaches every entrypoint at
//! once.
//!
//! That property is the point of this module (#1014). Before it, `main.rs` and
//! `commands/agent.rs` each composed the Agent themselves, and they had already
//! drifted: the CLI path passed `Vec::new()` for the provider registry and `None`
//! for `connect_url` and `display_name`, so the process started by
//! `nession agent start --foreground` was a different product from
//! `nession-agent <config>` — and `install-service` delegates boot autostart to
//! that same CLI path, so the drift reached the service path too.
//!
//! What belongs here is the *runtime graph*: logging, the tmux socket, the P2P
//! server, the central-server connection, the providers, heartbeat, the session
//! watcher, address advertisement, the network watcher, resize forwarding and
//! shutdown. Callers may resolve a config — flags and environment overrides are
//! theirs to apply — but they do not re-specify the graph.

use anyhow::{Context, Result};
use nession_claude_code::agent::ClaudeCodeAgentExtension;
use nession_common::extension::AgentExtension;
use nession_common::readiness::Readiness;
use nession_common::system;
use nession_git::GitAgentExtension;
use nession_protocol::contracts::agent::v1::AgentMetadata;
use std::sync::Arc;
use tracing::{error, info, warn};

use crate::claude_session_context::TmuxSessionContext;
use crate::config::AgentConfig;
use crate::connection::ServerClient;
use crate::extension::ExtensionRegistry;
use crate::git_workdir::TmuxWorkdirResolver;
use crate::identity;
use crate::netdetect::build_advertised_addresses;
use crate::netwatch;
use crate::protocol::served_descriptors;
use crate::server::AgentServer;
use crate::sync::heartbeat::HeartbeatLoop;
use crate::sync::session_watcher::SessionWatcher;
use crate::tmux::manager::SessionManager;

/// Start the Agent runtime and run it until a shutdown signal arrives.
///
/// `config` is a *resolved* config: the caller decides where it came from.
///
/// Returns `Err` if the runtime could not be brought up — a tmux socket that
/// cannot be prepared, an agent server that will not bind, a provider set that
/// cannot be composed. Reaching the end of the composition is what "started"
/// means.
///
/// `ready` is how a daemon parent is told the child got this far. This return
/// value cannot serve that purpose: `run` does not return until shutdown, so a
/// parent would learn "started" only when it stopped (#1016).
pub async fn run(config: AgentConfig, ready: Readiness) -> Result<()> {
    // 1. Initialize logging (stdout + file)
    let _log_guard = nession_common::logging::init_logging(
        &config.logging,
        &nession_common::paths::agent_logs_dir()?,
        "nession-agent",
    )?;

    info!("nession-agent {} starting", env!("CARGO_PKG_VERSION"));
    info!("Agent ID: {}", config.agent_id);
    info!("Server URL: {}", config.server_url);
    info!("Listen address: {}", config.listen_address);

    // 2. Bind tmux to nession's own socket, before any tmux command runs.
    // Every later tmux invocation addresses this socket explicitly, so
    // nession's sessions are invisible to `tmux ls` on the default socket and
    // cannot be taken down along with the user's own tmux server. A socket that
    // cannot be prepared is fatal — falling back to the default socket is the
    // behaviour this replaces (#575).
    let tmux_socket = crate::tmux::cmd::configure(config.tmux_socket_path.as_deref())?;
    info!("tmux socket: {}", tmux_socket.display());
    info!(
        "attach a session by hand with: tmux -S {} attach -t <name>",
        tmux_socket.display()
    );

    // 3. Check tmux availability
    match crate::tmux::util::check_tmux_available().await {
        Ok(true) => info!("tmux is available"),
        Ok(false) => warn!("tmux does not appear to be available"),
        Err(e) => warn!("Could not check tmux availability: {}", e),
    }

    // 4. Start Agent WebSocket server
    let tls_option = load_tls(&config)?;
    // Resolve persistent agent identity. On first run this persists the
    // generated or configured agent_id; on subsequent runs it loads the
    // persisted identity so the server recognises us as the same agent.
    //
    // The empty check is not decoration: `resolve_agent_id` *persists* what it
    // is given, so an empty `agent_id` in a hand-written config would be written
    // to the identity file as this agent's identity — the duplicate-identity
    // failure #425 describes. The CLI carried this guard and this path did not,
    // which is drift running the other way; it lives here now so both
    // entrypoints answer alike.
    let configured_id = if config.agent_id.is_empty() {
        nession_common::system::get_hostname()
    } else {
        config.agent_id.clone()
    };
    let identity_path = nession_common::paths::agent_identity_path()?;
    let agent_id = identity::resolve_agent_id(&configured_id, &identity_path)?;

    let file_root = config
        .file_root
        .as_deref()
        .unwrap_or(&config.default_working_dir);

    // Resize forwarding lane: the P2P AgentServer publishes tmux
    // `%window-resize` events here (it starts before the central-server
    // connection exists, so it can't hold the handle directly), and the
    // forwarder spawned below drains them into the central server once a
    // live ServerClientHandle is available.
    //
    // A level, not a queue: each session's *latest* size is what the forwarder
    // is going to send, so the lane keeps one of them per session instead of
    // every intermediate one a busy pane produces (#961-D). See
    // `crate::server::resize`.
    // What this agent will honour on its P2P listener (#1013). Created here,
    // once, because two things need the same store: the Server connection,
    // which is where grants arrive, and the P2P listener, which is where they
    // are checked. #1014 put the composition in this file for exactly this
    // reason — a second construction site is a second, emptier store.
    let p2p_credentials = Arc::new(crate::p2p_credentials::P2pCredentials::new());

    let (resize, mut resize_updates) = crate::server::ResizeReporter::new();
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
    let (server_handle, listen_addr) = agent_server
        .start()
        .await
        .context("failed to start agent server")?;
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

    let tmux_version = crate::tmux::util::tmux_version().await;
    let os_version = format!("{} {}", std::env::consts::OS, std::env::consts::ARCH);

    let metadata = AgentMetadata {
        tmux_version,
        os_version,
        nession_version: env!("CARGO_PKG_VERSION").to_string(),
        image_tag: option_env!("IMAGE_TAG").unwrap_or("dev").to_string(),
    };

    let tmux_for_client = Arc::new(SessionManager::new());

    // Before any session can exist, and before the server connection, so a
    // standalone agent installs it too.
    install_claude_integration().await;

    // Skip server connection if server_url is empty (standalone mode).
    // The supervisor reconnects on its own, so we capture the handle and the
    // server-advertised heartbeat interval (falling back to the local config).
    let (client_handle, heartbeat_interval_secs) = if config.server_url.trim().is_empty() {
        info!("No server_url configured — running in standalone mode");
        // Serving: the P2P socket is bound and the tmux socket is pinned. There
        // is no provider set to compose on this path, and no remote to reach.
        ready.announce();
        (None, config.heartbeat_interval_secs)
    } else {
        let ext_registry = compose_providers(&agent_id, Arc::clone(&tmux_for_client))?;

        // Serving: the socket is bound and the provider set composed. Announced
        // *before* the central-server connection on purpose — that one is
        // allowed to fail, and a parent that waited for it would report a
        // healthy agent as a failed start.
        ready.announce();

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
            Arc::clone(&p2p_credentials),
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

    // Forward tmux resize events from the P2P server to the central server so
    // relay clients (browser → server → agent) receive size updates. Events
    // arriving while disconnected are dropped — the next attach re-syncs the
    // pane size via the initial window-size query the attach path makes.
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

    // 8. Start network change detector (sends address updates on interface changes).
    if let Some(ref handle) = client_handle {
        netwatch::spawn_watcher(handle.clone(), config.clone(), port);
    }

    // 9. Wait for shutdown signal (Ctrl+C or SIGTERM)
    info!("Agent is running. Press Ctrl+C to stop.");
    wait_for_shutdown().await?;
    info!("Shutdown signal received, stopping components...");

    // 10. Graceful shutdown of all components
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

/// The providers this Agent serves, alongside the units it routes itself.
///
/// Extracted from [`run`] so the composition can be asserted without starting an
/// agent — `run` does not return until shutdown. Callers cannot build a different
/// one: `nession-cli` has no provider list at all (#1014). What this guards is
/// the other direction — a provider quietly dropped *here* would reach every
/// entrypoint at once and no caller would disagree, so the composition is the
/// thing that has to be asserted.
///
/// Composition is a boundary, so it is allowed to fail, and this is where the
/// process says so rather than starting with a registry that silently dropped a
/// provider.
pub fn compose_providers(
    agent_id: &str,
    tmux: Arc<SessionManager>,
) -> Result<Arc<ExtensionRegistry>> {
    let extensions: Vec<Box<dyn AgentExtension>> = vec![
        // #1005. The context is what lets this provider resolve a Session's cwd
        // and whether Claude is running in it — the agent owns session
        // lifecycle, so it is the only thing that can answer, and the provider
        // must not depend back on it to ask.
        Box::new(ClaudeCodeAgentExtension::new(Arc::new(
            TmuxSessionContext::new(Arc::clone(&tmux)),
        ))),
        // #750. The resolver is what keeps git inside the Session's own working
        // directory: the client names a session, never a path.
        Box::new(GitAgentExtension::new(
            "git",
            Arc::new(TmuxWorkdirResolver::new(Arc::clone(&tmux))),
        )),
    ];
    // The third argument is the other half of what this runtime serves: the
    // Protocol Units whose handlers are the agent's own methods rather than an
    // extension. They come from the two invocations that dispatch them
    // (`core_routes!` for the server connection, `p2p_routes!` for the agent's
    // own socket), so the manifest cannot advertise a unit neither message loop
    // routes.
    Ok(Arc::new(
        ExtensionRegistry::new(agent_id.to_string(), extensions, served_descriptors()?)
            .context("cannot compose this agent's protocol providers")?,
    ))
}

/// Write the Claude Code integration plugin, register it, and prepare the
/// directory its hook reports into (`#1005`).
///
/// **Never fatal, and never returns an error.** `#1005` decision 5: a host
/// without `claude`, or with a version predating the plugin commands, must still
/// be a working Nession agent — the Claude capability reports itself unavailable
/// and nothing else is affected. Every branch below therefore logs and returns.
///
/// The plugin is rewritten on every start rather than when it looks out of date.
/// A directory marketplace loads in place, so rewriting the tree *is* the
/// update; comparing first would add a way to be wrong about whether it is
/// current, in exchange for saving a file write.
async fn install_claude_integration() {
    // The hook writes with `cat >`, so this must exist before any session runs
    // one. Created here rather than at session creation, which keeps that path
    // free of filesystem side effects.
    let Ok(bindings) = nession_common::paths::agent_claude_bindings_dir() else {
        return;
    };
    if let Err(e) = std::fs::create_dir_all(&bindings) {
        warn!(
            dir = %bindings.display(),
            error = %e,
            "claude: the binding directory could not be created; conversations will not bind"
        );
        return;
    }

    let Ok(state_dir) = nession_common::paths::agent_dir() else {
        return;
    };

    let version = nession_claude_code::plugin::version();
    let root = match nession_claude_code::plugin::write_into(&state_dir, version) {
        Ok(root) => root,
        Err(e) => {
            warn!(error = %e, "claude: the integration plugin could not be written");
            return;
        }
    };

    match nession_claude_code::plugin::reconcile(&root).await {
        nession_claude_code::plugin::Installed::Ready => {
            info!("claude: integration plugin {version} installed");
        }
        nession_claude_code::plugin::Installed::Unavailable(reason) => {
            // `info`, not `warn`: this is an answer about the host, not a fault.
            info!("claude: integration unavailable ({reason})");
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The provider set is composed, and this is the only place that decides it.
    ///
    /// `nession-cli` used to pass `Vec::new()` where this list is built, so a
    /// session started by `nession agent start --foreground` served **no**
    /// `git.*` unit while `nession-agent <config>` served six — and because
    /// `install-service` delegates to that same path, so did the service. One
    /// composition means one answer, and this asserts the answer is not empty.
    ///
    /// It guards the direction a caller *cannot*: a provider dropped here would
    /// reach every entrypoint at once, and nothing else would notice.
    #[test]
    fn the_runtime_composes_the_agent_providers() {
        let registry = compose_providers("agent-test", Arc::new(SessionManager::new()))
            .expect("the runtime's own providers must compose");
        let manifest = registry.manifest();

        for wire in ["git.status", "git.diff"] {
            assert!(
                manifest.carries(wire),
                "the git provider is part of the Agent product; {wire} is missing"
            );
        }
        assert!(
            !manifest.is_empty(),
            "the runtime must advertise at least the units it routes itself"
        );
    }
}
