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
use nession_claude_code::session_context::{McpHostContext, McpHostEndpoint};
use nession_claude_code::tools::ClaudeCodeToolProvider;
use nession_claude_code::workspace_trust::WorkspaceTrust;
use nession_common::extension::AgentExtension;
use nession_common::readiness::Readiness;
use nession_common::session_activity::SessionActivityProvider;
use nession_common::system;
use nession_git::GitAgentExtension;
use nession_github::{GithubAgentExtension, GithubClient};
use nession_mcp::provider::McpToolProvider;
use nession_protocol::contracts::agent::v1::AgentMetadata;
use std::sync::Arc;
use tracing::{error, info, warn};

use crate::claude_control::AgentClaudeControl;
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
use crate::session::activity::{
    ClaudeActivityProvider, SessionActivityCoordinator, ShellActivityProvider,
};
use crate::session_env::AgentSessionEnvironment;
use crate::sync::git_invalidation::GitInvalidationWatcher;
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
pub async fn run(
    config: AgentConfig,
    config_path: std::path::PathBuf,
    ready: Readiness,
) -> Result<()> {
    // The environment wins over the file for the release-selected terminal
    // width (#2487), and an invalid value fails before any subsystem starts.
    // Both entrypoints reach this function, so the rule has one owner.
    let mut config = config;
    // Failures before the runtime log writer exists have no file destination;
    // the bounded startup capture is where they remain readable (#4600).
    if let Err(error) = config.apply_env_overrides() {
        return Err(startup_failure("validate", error));
    }
    if let Err(error) = config.validate() {
        return Err(startup_failure("validate", error));
    }

    // Hard process-wide outbound ceilings for the peer-to-peer connections
    // (#4504), derived from their class limits over a bounded connection count.
    nession_runtime::outbound::ProcessAccounting::install(
        nession_runtime::outbound::ProcessLimits::for_connections(
            crate::server::outbound::P2P_CLASS_LIMITS,
            64,
        ),
    );

    // 1. Initialize logging (stdout + file)
    let _log_guard = match nession_common::logging::init_logging(
        &config.logging,
        &nession_common::paths::agent_logs_dir()?,
        nession_common::logging::LogComponent::Agent.log_prefix(),
    ) {
        Ok(guard) => guard,
        Err(error) => {
            // The log directory itself is unusable; startup capture lives
            // beside it and may fail for the same reason. Either way the
            // terminal/stderr diagnostic and this sentence survive.
            let note = nession_common::startup_log::record_or_note(
                nession_common::logging::LogComponent::Agent,
                "logging",
                &format!("{error}"),
            );
            return Err(anyhow::Error::new(error).context(note));
        }
    };

    info!("nession-agent {} starting", env!("CARGO_PKG_VERSION"));
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
    // Resolve persistent agent identity. A non-empty configured id is an
    // explicit operator override; an absent one reuses the persisted identity,
    // or generates and persists `agent-{uuid}` on first run (#91). The
    // identity owner decides both cases, so this path and `nession agent
    // start` cannot drift (#1014, #2973).
    let identity_path = nession_common::paths::agent_identity_path()?;
    let agent_id = identity::resolve_agent_id(&config.agent_id, &identity_path)?;
    info!("Agent ID: {agent_id}");

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
    // The durable inbound Agent Token (#3440): operator override, else the
    // token persisted beside this config file, else a generated one. Resolved
    // before the listener exists, so there is no window in which an inbound
    // connection reaches an Agent that has no verifier.
    let agent_token = crate::token::resolve_agent_token(&config_path, &config.agent_token)?;
    let p2p_auth = Arc::new(crate::p2p_auth::P2pAuth::new(agent_token.as_str()));
    // The process's one mutation lane (#1021): the peer-to-peer listener and the
    // central connection both mutate the same tmux sessions and the same file
    // sandbox, so they must queue in the same lane or ordering holds on each path
    // and not between them.
    let mutation_lane = crate::execution::mutation_scheduler();
    info!(
        inbound_auth = if p2p_auth.is_enabled() {
            "agent token"
        } else {
            "disabled (bug)"
        },
        "inbound Agent token resolved"
    );

    let (resize, mut resize_updates) = crate::server::ResizeReporter::new();
    // The Agent's durable EROFS cache (#3062): opened once for Managed
    // creation downloads. Inability to open it is not fatal for ordinary
    // Sessions, but every Managed create is refused rather than falling back.
    let erofs_cache = match config.effective_erofs_storage_dir() {
        Ok(resolved) => match crate::erofs_cache::open_resolved(&resolved, &agent_id).await {
            Ok(cache) => Some(Arc::new(cache)),
            Err(error) => {
                tracing::warn!(
                    "EROFS cache unavailable; Managed Session creation will be refused: {error:#}"
                );
                None
            }
        },
        Err(error) => {
            tracing::warn!(
                "EROFS cache path is unresolved; Managed Session creation will be refused: {error:#}"
            );
            None
        }
    };
    let tmux_for_client = {
        let mut mgr = SessionManager::new()
            .with_server_url(config.server_url.clone())
            .with_server_auth_token(config.auth_token.clone());
        // Binding state has to outlive this process: a tmux Session does, and
        // the Agent must still know a managed key's base value after a
        // restart. The directory is created here, where the Agent's state
        // directories come into existence, and secured by the manager on first
        // write.
        if let Ok(state_dir) = nession_common::paths::agent_env_bindings_dir() {
            if let Err(e) = std::fs::create_dir_all(&state_dir) {
                tracing::warn!(
                    "could not create env binding state dir {}: {e}",
                    state_dir.display()
                );
            } else {
                mgr = mgr.with_env_state_dir(state_dir);
            }
        }
        mgr.with_memory_threshold(Some(config.memory_threshold_percent));
        // Sandbox host configuration and the execution reaper (#2681). The
        // runtime is always present; `sandbox.enabled = false` makes every
        // explicit policy fail closed with a backend-unavailable reason.
        let sandbox = crate::sandbox_runtime::SandboxRuntime::from_config(
            &config,
            &agent_id,
            erofs_cache.clone(),
        );
        mgr = mgr.with_sandbox(Arc::clone(&sandbox));
        // Agent-owned reusable Workspaces (#3407). The registry lives under
        // the Agent's durable data directory; if that directory is
        // unavailable, the API reports unavailable rather than falling back
        // to an ephemeral location.
        match nession_common::paths::agent_dir() {
            Ok(agent_dir) => {
                // Deletion guards consult the observed Overlay/consumer state,
                // not only a volatile process-local lease count (#3582).
                let use_guard: std::sync::Arc<dyn crate::workspace_manager::WorkspaceUseGuard> =
                    crate::sandbox_runtime::SandboxWorkspaceUse::new(Arc::clone(&sandbox));
                match crate::workspace_manager::WorkspaceManager::open_with_guard(
                    agent_dir.join("workspaces"),
                    Some(use_guard),
                ) {
                    Ok(manager) => {
                        mgr = mgr.with_workspaces(Arc::new(manager));
                    }
                    Err(error) => {
                        tracing::warn!(
                            "Agent Workspace registry unavailable; the inventory API is disabled: {error:#}"
                        );
                    }
                }
            }
            Err(error) => {
                tracing::warn!(
                    "Agent Workspace registry path is unresolved; the inventory API is disabled: {error:#}"
                );
            }
        }
        Arc::new(mgr)
    };

    // Reconcile Sandbox records left by a previous Agent process against the
    // tmux Sessions that actually exist. A failed listing is not "no
    // Sessions"; the pass is skipped and the records stay for the next start.
    if let Some(sandbox) = tmux_for_client.sandbox_runtime() {
        match tmux_for_client.tmux_dep().ops().list_panes().await {
            Ok(panes) => {
                let live: Vec<nession_sandbox::LivePane> = panes
                    .into_iter()
                    .map(|pane| nession_sandbox::LivePane {
                        session_name: pane.session_name,
                        pane_id: pane.pane_id,
                    })
                    .collect();
                if let Err(error) = sandbox.reconcile(&live) {
                    tracing::warn!("Sandbox reconciliation failed: {error:#}");
                }
            }
            Err(error) => tracing::warn!(
                "skipping Sandbox reconciliation because tmux did not answer: {error:#}"
            ),
        }
    }

    // Repair generated zsh adapter artifacts left by a pre-#4605 Agent. The
    // pass is idempotent, touches only recorded zsh Sessions that still exist,
    // and writes nothing for a converged adapter. A tmux that cannot answer
    // skips the pass instead of guessing which Sessions are live.
    let repaired_adapters = tmux_for_client.env().repair_recorded_zsh_adapters().await;
    if repaired_adapters > 0 {
        info!("repaired {repaired_adapters} generated zsh Session adapter(s)");
    }

    // One metadata store for the process: the P2P listener and the central
    // connection are two entrypoints into the same Session-owned state (#2789).
    let session_metadata = Arc::new(crate::session::metadata::SessionMetadataStore::new(
        Arc::clone(&tmux_for_client),
    ));

    let mut agent_server = AgentServer::new(
        &config.listen_address,
        &agent_id,
        tls_option,
        config.default_working_dir.clone(),
        file_root,
        config.attach_mode.clone(),
        crate::server::websocket::AgentServerContext {
            resize,
            auth: Arc::clone(&p2p_auth),
            // Built here, once, because this is where the resources its keys
            // name are built — one tmux server, one file sandbox — and handed
            // to *both* mutating paths below (#1021).
            mutations: Arc::clone(&mutation_lane),
            tmux: Arc::clone(&tmux_for_client),
            session_metadata: Arc::clone(&session_metadata),
            terminal_cols: config.terminal_cols,
            // The P2P listener's default pre-authentication budget (#2653):
            // bounded pending handshakes plus a finite deadline, owned by the
            // listener rather than tunable from the config for now.
            handshake_policy: Default::default(),
        },
    )
    .context("failed to create agent server")?;
    // #4073: one post-create preparation hook, shared by the P2P listener and
    // the central connection so a direct and a relayed create prepare the
    // Session identically. It reads the Session's own live environment; the
    // Agent daemon's environment is never used.
    let session_created: crate::session_created::SharedSessionCreatedHook = Arc::new(
        crate::claude_workspace_trust::ClaudeWorkspaceTrustHook::new(Arc::new(
            TmuxSessionContext::new(Arc::clone(&tmux_for_client)),
        )),
    );
    agent_server = agent_server.with_session_created_hook(Arc::clone(&session_created));
    // Mount MCP on the P2P listener when `[mcp] enabled = true` (#565). A
    // fail-closed configuration error stops the start here, before `ready`.
    agent_server
        .mount_mcp(
            &config,
            agent_token.as_str(),
            compose_mcp_tool_providers(&agent_id, Arc::clone(&tmux_for_client)),
        )
        .context("failed to mount the MCP endpoint")?;
    // Mount the opt-in read-only OCI Registry on the P2P listener when
    // `[registry] enabled = true` (#4090). It is backed by the same verified
    // cache the Managed creation path uses and honours the Agent's own inbound
    // token. Without a cache the capability is refused rather than exposing an
    // empty or private CAS; the projection starts empty so nothing is advertised
    // until the preparation path registers an authorized tag.
    if config.registry.enabled {
        match erofs_cache.clone() {
            Some(cache) => {
                let registry =
                    crate::registry::build_read_only_registry(cache, Arc::clone(&p2p_auth))
                        .context("failed to mount the Agent read-only OCI Registry")?;
                agent_server.mount_registry(Arc::new(registry));
            }
            None => {
                tracing::warn!(
                    "Agent Registry enabled but no EROFS cache is available; \
                     the read-only /v2/ endpoint is not mounted"
                );
            }
        }
    }
    // The composed contribution catalog and the context its handlers receive
    // (#3778). The central connection advertises the manifest on registration
    // and executes Server-relayed contributed calls through the same catalog
    // and owner state as the embedded endpoint.
    let mcp_tools = match (agent_server.mcp_catalog(), agent_server.mcp_tool_context()) {
        (Some(catalog), Some(context)) => Some((catalog, context)),
        _ => None,
    };
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
    let platform = nession_erofs::oci::descriptor::Platform::for_consumer(
        std::env::consts::OS,
        std::env::consts::ARCH,
        None,
    );

    let metadata = AgentMetadata {
        tmux_version,
        os_version,
        nession_version: env!("CARGO_PKG_VERSION").to_string(),
        image_tag: option_env!("IMAGE_TAG").unwrap_or("dev").to_string(),
        architecture: platform.architecture,
        os: platform.os,
        variant: platform.variant,
    };

    // Before any session can exist, and before the server connection, so a
    // standalone agent installs it too.
    install_claude_integration().await;

    // Skip server connection if server_url is empty (standalone mode).
    // The supervisor reconnects on its own, so we capture the handle and the
    // server-advertised heartbeat interval (falling back to the local config).
    let (client_handle, heartbeat_interval_secs, activity) = if config.server_url.trim().is_empty()
    {
        info!("No server_url configured — running in standalone mode");
        // Serving: the P2P socket is bound and the tmux socket is pinned.
        // There is no provider set to compose on this path, and no remote
        // to reach.
        ready.announce();
        (None, config.heartbeat_interval_secs, None)
    } else {
        let ext_registry = compose_providers(
            &agent_id,
            Arc::clone(&tmux_for_client),
            claude_mcp_host(&config, listen_addr),
        )?;
        // Activity providers come from the same composition that serves
        // the protocol routes (#3800), so a capability cannot contribute
        // observations without being part of this Agent's provider set.
        let activity = SessionActivityCoordinator::new(
            agent_id.clone(),
            compose_activity_providers(&agent_id, Arc::clone(&tmux_for_client), &ext_registry),
        )
        .context("cannot compose this agent's Session Activity providers")?;

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
            Arc::clone(&tmux_for_client),
            config.default_working_dir.clone(),
            Some(ext_registry),
            agent_token.clone(),
            Arc::clone(&mutation_lane),
        )
        .with_session_metadata(session_metadata)
        .with_session_created_hook(session_created);
        let server_client = match mcp_tools {
            Some((catalog, context)) => server_client.with_mcp_tools(catalog, context),
            None => server_client,
        };

        // Attempt to connect with a timeout so the agent can still serve
        // local clients even if the central server is unreachable. The
        // supervisor keeps retrying in the background regardless.
        tokio::select! {
            result = server_client.connect_and_run() => {
                match result {
                    Ok((handle, server_interval)) => {
                        let interval = server_interval.unwrap_or(config.heartbeat_interval_secs);
                        info!("Connected to central server (heartbeat interval: {}s)", interval);
                        (Some(handle), interval, Some(activity.clone()))
                    }
                    Err(e) => {
                        error!("Failed to connect to central server: {:#}", e);
                        (None, config.heartbeat_interval_secs, Some(activity.clone()))
                    }
                }
            }
            _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {
                warn!("Timed out connecting to central server after 30s, continuing without sync");
                (None, config.heartbeat_interval_secs, Some(activity.clone()))
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
            while let Some((session_id, cols, rows, incarnation, generation)) =
                resize_updates.next().await
            {
                if handle.is_connected() {
                    let _ = handle.send_terminal_resize_at(
                        &session_id,
                        cols,
                        rows,
                        incarnation,
                        generation,
                    );
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
            Arc::clone(&tmux_for_client),
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
            Arc::clone(&tmux_for_client),
            config.session_poll_interval_secs,
        );
        let watcher = match activity.clone() {
            Some(activity) => watcher.with_activity(activity),
            None => watcher,
        };
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

    // 8. Git repository invalidation watcher (#1008).
    let git_invalidation_shutdown = if let Some(ref handle) = client_handle {
        let resolve = Arc::new(TmuxWorkdirResolver::new(Arc::clone(&tmux_for_client)));
        let watcher = GitInvalidationWatcher::new(
            handle.clone(),
            Arc::clone(&tmux_for_client),
            resolve,
            config.session_poll_interval_secs,
        );
        let shutdown_handle = watcher.shutdown_handle();
        tokio::spawn(async move {
            if let Err(e) = watcher.run().await {
                error!("Git invalidation watcher error: {:#}", e);
            }
        });
        info!("Git invalidation watcher started");
        Some(shutdown_handle)
    } else {
        None
    };

    // 9. Start network change detector (sends address updates on interface changes).
    if let Some(ref handle) = client_handle {
        netwatch::spawn_watcher(handle.clone(), config.clone(), port);
    }

    // 10. Wait for shutdown signal (Ctrl+C or SIGTERM)
    info!("Agent is running. Press Ctrl+C to stop.");
    wait_for_shutdown().await?;
    info!("Shutdown signal received, stopping components...");

    // 11. Graceful shutdown of all components
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
    if let Some(ref handle) = git_invalidation_shutdown {
        if let Err(e) = handle.shutdown().await {
            error!("Error shutting down git invalidation watcher: {:#}", e);
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
    claude_mcp_host: McpHostContext,
) -> Result<Arc<ExtensionRegistry>> {
    // #750/#1290. The resolver is what keeps Git and GitHub inside the
    // Session's own working directory: the client names a session, never a
    // path. Both providers share the one injected resolver.
    let workdir: Arc<dyn nession_git::WorkdirResolver> =
        Arc::new(TmuxWorkdirResolver::new(Arc::clone(&tmux)));
    // #4080. Session-addressed providers resolve values through the Session's
    // Environment Binding (explicit overrides) before the Agent baseline. The
    // Agent owns both halves, so it supplies the one boundary they share.
    let session_env: Arc<dyn nession_common::session_env::SessionEnvironment> =
        Arc::new(AgentSessionEnvironment::new(Arc::clone(&tmux)));
    let extensions: Vec<Box<dyn AgentExtension>> = vec![
        // #1005. The context is what lets this provider resolve a Session's cwd
        // and whether Claude is running in it — the agent owns session
        // lifecycle, so it is the only thing that can answer, and the provider
        // must not depend back on it to ask.
        Box::new(ClaudeCodeAgentExtension::new(Arc::new(
            TmuxSessionContext::new(Arc::clone(&tmux)).with_mcp_host(claude_mcp_host),
        ))),
        Box::new(GitAgentExtension::new(
            "git",
            Arc::clone(&workdir),
            Arc::clone(&session_env),
        )),
        // #1290. One Git capability, two providers: local Git and the
        // read-only GitHub hosting context. The transport is credential-free
        // at composition; each Session-addressed request selects the
        // credential its Session binding (or the Agent baseline) provides
        // (#4080). An absent credential is an honest unavailable state, not a
        // startup failure.
        Box::new(GithubAgentExtension::new(
            "git",
            workdir,
            Arc::new(GithubClient::api_transport()),
            session_env,
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

/// The Session Activity providers this Agent composes (#3800/#3802).
///
/// Capability providers come from the same Extension set that serves the
/// Protocol routes; the generic Shell provider belongs to the Agent itself
/// because it interprets tmux Pane foreground work, not a capability workload.
/// Extracted so the composition can be asserted without starting an Agent —
/// a provider dropped here would disappear from every entrypoint at once.
pub fn compose_activity_providers(
    agent_id: &str,
    tmux: Arc<SessionManager>,
    registry: &ExtensionRegistry,
) -> Vec<Arc<dyn SessionActivityProvider>> {
    let mut providers = registry.activity_providers();
    // The Claude adapter consumes #3779's source-owned status reader and owns
    // a Pane only when it can bind a verified Claude process to it.
    providers.push(Arc::new(ClaudeActivityProvider::new(
        agent_id,
        Arc::clone(&tmux),
    )));
    providers.push(Arc::new(ShellActivityProvider::new()));
    providers
}

/// Every MCP Tool contribution this Agent composes into its shared endpoint
/// (`#3778`).
///
/// An Extension reaches the MCP catalog only by being constructed here and
/// handed to the mount — there is no side-effect registration. The baseline
/// catalog is always present and unchanged. The Claude Code Extension is the
/// first consumer (`#3779`): its Tools execute through this Agent's own tmux
/// Session state, process membership and on-demand CLI observation.
pub fn compose_mcp_tool_providers(
    agent_id: &str,
    tmux: Arc<SessionManager>,
) -> Vec<Arc<dyn McpToolProvider>> {
    // The read Tools execute this Agent's **existing** conversation/transcript
    // Protocol Units through the same stateless extension the protocol routes
    // use, over the same tmux Session truth (`#3779` P3). There is no second
    // discovery or transcript parser behind the MCP surface.
    let context = Arc::new(TmuxSessionContext::new(Arc::clone(&tmux)));
    let reader = Arc::new(ClaudeCodeAgentExtension::new(context.clone()));
    // #4073: `claude.enter` prepares Claude's own Workspace Trust immediately
    // before launch, resolved from this same live Session view.
    let trust = Arc::new(WorkspaceTrust::new(context));
    vec![Arc::new(ClaudeCodeToolProvider::new(
        agent_id,
        Arc::new(AgentClaudeControl::new(agent_id, tmux)),
        reader,
        trust,
    ))]
}

/// What this Agent can tell the Claude MCP view about its own hosting (#3600).
///
/// The Agent-embedded endpoint is the P2P listener it actually bound, rendered
/// as an HTTP(S) origin a process on this host can reach. An unspecified bind
/// (`0.0.0.0`/`::`) is loopback for that purpose: the Session runs on this
/// host, and the listener is the same one. The Server endpoint is not invented
/// here — only the configured `server_url` is reported, and the connect
/// preflight derives the MCP origin from it with the Server's own path.
fn claude_mcp_host(config: &AgentConfig, listen_addr: std::net::SocketAddr) -> McpHostContext {
    let server_url = (!config.server_url.trim().is_empty()).then(|| config.server_url.clone());
    let agent = config.mcp.enabled.then(|| {
        let tls = config
            .tls_cert_path
            .as_deref()
            .is_some_and(|path| !path.trim().is_empty())
            && config
                .tls_key_path
                .as_deref()
                .is_some_and(|path| !path.trim().is_empty());
        let scheme = if tls { "https" } else { "http" };
        McpHostEndpoint {
            url: format!(
                "{scheme}://{}:{}{}",
                reachable_loopback_or_ip(listen_addr.ip()),
                listen_addr.port(),
                config.mcp.path
            ),
            path: config.mcp.path.clone(),
        }
    });
    McpHostContext { agent, server_url }
}

fn reachable_loopback_or_ip(ip: std::net::IpAddr) -> String {
    match ip {
        std::net::IpAddr::V4(address) if address.is_unspecified() => "127.0.0.1".to_string(),
        std::net::IpAddr::V4(address) => address.to_string(),
        std::net::IpAddr::V6(address) if address.is_unspecified() => "[::1]".to_string(),
        std::net::IpAddr::V6(address) => format!("[{address}]"),
    }
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

/// Attach a bounded startup-capture outcome to a pre-logging failure.
///
/// The original error stays the cause; the note says where the durable copy
/// went, or that the same unusable location prevented one.
fn startup_failure(phase: &str, error: anyhow::Error) -> anyhow::Error {
    let note = nession_common::startup_log::record_or_note(
        nession_common::logging::LogComponent::Agent,
        phase,
        &format!("{error:#}"),
    );
    error.context(note)
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
        let registry = compose_providers(
            "agent-test",
            Arc::new(SessionManager::new()),
            McpHostContext::default(),
        )
        .expect("the runtime's own providers must compose");
        let manifest = registry.manifest();

        for wire in ["git.status", "git.diff", "git.preview"] {
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

    /// The Claude and Shell Activity providers are part of the Agent product
    /// (#3801/#3802), and one capability id cannot be composed twice.
    #[test]
    fn the_runtime_composes_the_session_activity_providers() {
        let registry = compose_providers(
            "agent-test",
            Arc::new(SessionManager::new()),
            McpHostContext::default(),
        )
        .expect("the runtime's own providers must compose");
        let providers =
            compose_activity_providers("agent-test", Arc::new(SessionManager::new()), &registry);
        let ids: Vec<&'static str> = providers.iter().map(|provider| provider.id()).collect();

        for expected in ["claude-code", "shell"] {
            assert_eq!(
                ids.iter().filter(|id| **id == expected).count(),
                1,
                "the {expected} provider is part of the Agent product: {ids:?}"
            );
        }
        for id in &ids {
            let id = *id;
            assert_eq!(
                ids.iter().filter(|other| **other == id).count(),
                1,
                "capability id `{id}` must be composed exactly once: {ids:?}"
            );
        }
    }

    /// The Claude control Tools reach the shared MCP catalog only through this
    /// explicit composition (`#3779`).
    #[test]
    fn the_runtime_composes_the_claude_control_tools() {
        let providers = compose_mcp_tool_providers("agent-test", Arc::new(SessionManager::new()));
        let names: Vec<String> = providers
            .iter()
            .flat_map(|provider| provider.tools().expect("provider tools"))
            .map(|tool| tool.name().to_string())
            .collect();
        assert_eq!(
            names,
            vec![
                "nession_claude_status",
                "nession_claude_enter",
                "nession_claude_submit",
                "nession_claude_list_conversations",
                "nession_claude_get_conversation",
                "nession_claude_get_transcript"
            ]
        );
    }
}
