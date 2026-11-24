use anyhow::Context;
use nession_runtime::frame::WsFrame;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tracing::{debug, error, info, warn};

use axum::extract::{FromRequestParts, Path, State, WebSocketUpgrade};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;
use nession_runtime::ingress::{self, AdmissionSlot, AxumWebSocket};

use super::handler::{overload_reply, ConnectionHandler, ConnectionHandlerDeps, HandlerAction};
use crate::db::Database;
use crate::env::EnvService;
use crate::image::{ImageHttpService, ImageManager, ImageManagerOptions};
use crate::registry::{AgentRegistry, SessionRegistry};
use crate::server::client_registry::ClientRegistry;
use crate::server::command_broker::CommandBroker;
use crate::server::execution::{
    answer, mutation_scheduler, policy_for_wire, ExecutionPolicy, Lanes, ResourceKey,
    DEFAULT_MUTATIONS_IN_FLIGHT,
};
use crate::server::outbound::WsMessageSender;
use crate::server::web_client_registry::WebClientRegistry;
use nession_common::config::ServerConfig;
use nession_common::readiness::Readiness;
use nession_protocol::contracts::env::v1::EnvSnapshot;
use nession_protocol::ProtocolMessage;
use nession_runtime::lane::{AdmitError, KeyedLane};

pub struct WebSocketServer {
    config: ServerConfig,
    agent_registry: Arc<AgentRegistry>,
    session_registry: Arc<SessionRegistry>,
    command_broker: Arc<CommandBroker>,
    client_registry: Arc<ClientRegistry>,
    web_client_registry: Arc<WebClientRegistry>,
    env_service: Arc<EnvService>,
    db: Arc<Database>,
    /// The one mutation lane every connection of this Server dispatches into.
    /// Built here because the resources its keys name — the registries and the
    /// env store — are built here. See `server::execution::mutation_scheduler`.
    mutations: Arc<KeyedLane<ResourceKey>>,
    /// The MCP endpoint (`#565`), when `[mcp] enabled = true`. It shares this
    /// listener and the Server's business services.
    mcp: Option<Arc<nession_mcp::McpService>>,
    /// The validated Extension-contribution catalog (`#3778`). Registration
    /// installs manifests here; the MCP endpoint and
    /// `server.mcp.tool.call` route read the same owner.
    extension_tools: Arc<super::extension_tools::ExtensionToolCatalog>,
    /// Global EROFS image manager (#3022), shared by every connection.
    image_manager: Arc<ImageManager>,
    /// Authorized blob HTTP route mounted on this listener.
    image_http: Arc<ImageHttpService>,
    /// The standard OCI `/v2/` Registry service mounted on this listener (#4090),
    /// backed by the same CAS/Catalog/Token authority as the image manager. The
    /// proprietary `image_http` route coexists during the compatibility window.
    image_registry: Arc<crate::image::registry::ServerRegistry>,
    listener: Option<TcpListener>,
}

impl WebSocketServer {
    pub async fn new(config: ServerConfig, db: Arc<Database>) -> anyhow::Result<Self> {
        // The bind is the exposed boundary: validate the effective config here
        // as well as in `runtime::run`, so a caller that constructs the
        // listener directly cannot bind an unauthenticated remote control
        // plane (#4066 SC-01).
        config.validate()?;
        let listener = TcpListener::bind(&config.listen_address).await?;
        let agent_registry = Arc::new(AgentRegistry::new(
            config.heartbeat_timeout_secs,
            Arc::clone(&db),
        ));
        let session_registry = Arc::new(SessionRegistry::new(Arc::clone(&db)));

        // Load persisted agents + sessions from the database. Agents come back
        // Offline (probe status Unknown) until they reconnect; sessions show as
        // "recovering" until their agent reconnects and confirms them.
        agent_registry.load_from_db().await;
        session_registry.load_from_db().await;

        let command_broker = Arc::new(CommandBroker::new());
        // One owner for Extension-contributed MCP Tool manifests (#3778):
        // registration writes it, the MCP endpoint and the routing unit read
        // it, and a rejected manifest leaves the previous generation intact.
        let extension_tools = Arc::new(super::extension_tools::ExtensionToolCatalog::new(
            Arc::clone(&agent_registry),
            Arc::clone(&command_broker),
        )?);
        let client_registry = Arc::new(ClientRegistry::new());
        let web_client_registry = Arc::new(WebClientRegistry::new());

        let env_service = EnvService::new(Arc::clone(&db));

        // Import legacy filesystem env files into the DB on first run.
        // The DB is authoritative from this point forward, but filesystem
        // copies are kept for zero-downtime rollback safety.
        if let Ok(envs_dir) = nession_common::paths::server_envs_dir() {
            match env_service.store.import_from_dir(&envs_dir).await {
                Ok(n) => {
                    if n > 0 {
                        tracing::info!("Imported {n} env file(s) from {envs_dir:?} into DB");
                    }
                }
                Err(e) => tracing::warn!("Env file import from {envs_dir:?} failed: {e:#}"),
            }
        }

        // The global image manager (#3022): one content-addressed blob store,
        // one bounded build worker, one owner of image metadata.
        let blob_store = nession_erofs::FsBlobStore::new(&config.image_blob_dir)
            .context("failed to open the image blob store")?;
        // Historical digest-addressed rows remain readable while the catalog
        // gains one deterministic Manifest identity per ready Blob. The
        // migration is additive and byte-preserving; a failure leaves the
        // legacy registry authoritative instead of blocking startup.
        match nession_erofs::catalog::migrate_legacy_images(
            db.connection(),
            &blob_store,
            &nession_erofs::catalog::LegacyPlatform::host(),
            chrono::Utc::now().timestamp(),
        )
        .await
        {
            Ok(report) if report.ready_images > 0 => info!(
                ready = report.ready_images,
                migrated = report.migrated_images,
                already = report.already_migrated,
                alias_tags = report.created_alias_tags,
                "Migrated legacy EROFS image identities into the Manifest catalog"
            ),
            Ok(_) => {}
            Err(error) => warn!(
                "Legacy image catalog migration failed; legacy rows remain authoritative: {error:#}"
            ),
        }
        let image_builder = nession_erofs::ErofsBuilder::new(
            Arc::new(nession_erofs::ProcessGitRunner::default()),
            Arc::new(nession_erofs::ProcessMkfsRunner::default()),
            blob_store.clone(),
            &config.image_build_dir,
        )
        .context("failed to open the image build workspace")?;
        let image_manager = Arc::new(ImageManager::new(
            Arc::clone(&db),
            Arc::new(image_builder),
            blob_store,
            ImageManagerOptions {
                max_concurrent_builds: config.image_max_concurrent_builds,
                build_root: std::path::PathBuf::from(&config.image_build_dir),
                source_root: (!config.image_source_root.trim().is_empty())
                    .then(|| std::path::PathBuf::from(config.image_source_root.trim())),
                build_stage_timeout: (config.image_build_stage_timeout_secs > 0)
                    .then(|| std::time::Duration::from_secs(config.image_build_stage_timeout_secs)),
                build_log_max_bytes: config.image_build_log_max_bytes,
                build_retention_secs: config.image_build_retention_secs,
            },
        )?);
        let image_http = Arc::new(ImageHttpService::new(
            Arc::clone(&image_manager),
            nession_protocol::TokenVerifier::new(config.auth_token.clone()),
        ));
        // The standard `/v2/` Registry service shares the image manager's CAS,
        // Catalog connection and Server Token identity (#4090). It is mounted on
        // the same ingress below; the proprietary blob route stays for the
        // compatibility window.
        let image_registry = crate::image::registry::build_registry(
            &image_manager,
            nession_protocol::TokenVerifier::new(config.auth_token.clone()),
        )
        .context("failed to mount the Server OCI Registry service")?;
        // Build transitions are pushed with the authoritative descriptor read
        // from the durable build directory. A client that missed a push asks
        // `server.image.build.get|list` after reconnecting.
        {
            let registry = Arc::clone(&web_client_registry);
            image_manager.set_build_notifier(Arc::new(move |build| {
                registry.broadcast_image_build_changed(build);
            }));
        }
        // The exclusive build-root lock held by the manager proves the previous
        // owner is gone, so every `running` record is an orphan to reconcile
        // now. A verified snapshot resumes at packaging; an unpinned Git source
        // is fetched again; a local source without a trustworthy snapshot fails
        // explicitly. A recovery scan/storage failure stops the start.
        image_manager
            .recover_builds()
            .await
            .context("failed to recover durable image builds")?;

        // Mount MCP on this listener when configured. Building it here (rather
        // than on first request) means a fail-closed configuration error stops
        // the start, before `ready` is announced. It shares the runtime's
        // mutation lane, so an MCP mutation of a Session is ordered against a
        // Web client's mutation of the same Session (#565).
        let mutations = mutation_scheduler();
        let mcp = crate::server::mcp::build(
            &config,
            ConnectionHandlerDeps {
                agent_registry: Arc::clone(&agent_registry),
                session_registry: Arc::clone(&session_registry),
                command_broker: Arc::clone(&command_broker),
                client_registry: Arc::clone(&client_registry),
                web_client_registry: Arc::clone(&web_client_registry),
                env_service: Arc::clone(&env_service),
                image_manager: Arc::clone(&image_manager),
                db: Arc::clone(&db),
                extension_tools: Some(Arc::clone(&extension_tools)),
            },
            Arc::clone(&mutations),
        )?;

        Ok(Self {
            config,
            agent_registry,
            session_registry,
            command_broker,
            client_registry,
            web_client_registry,
            env_service,
            db,
            mutations,
            mcp,
            extension_tools,
            image_manager,
            image_http,
            image_registry,
            listener: Some(listener),
        })
    }

    pub async fn run(&mut self, ready: Readiness) -> anyhow::Result<()> {
        let listener = self
            .listener
            .take()
            .ok_or_else(|| anyhow::anyhow!("Server already running or not initialized"))?;

        info!("WebSocket server listening on {}", listener.local_addr()?);

        let tls_acceptor = if !self.config.tls_cert_path.is_empty() {
            Some(build_tls_acceptor(
                &self.config.tls_cert_path,
                &self.config.tls_key_path,
            )?)
        } else {
            None
        };

        // Serving. Deliberately *after* the TLS acceptor and not at the bind in
        // `new`: a configured certificate that cannot be read is a start that
        // fails here, and announcing at the bind would report it as a success
        // (#1016). Everything from this point to the accept loop is `spawn`,
        // which cannot fail.
        ready.announce();

        // Background sweep: bounded image GC (#3180). The interval and the
        // per-sweep candidate/byte bounds are configuration; a sweep that hits
        // its bound leaves the remainder in the database for the next tick.
        // `0` disables the schedule — an explicit operator sweep still works.
        if self.config.image_gc_interval_secs > 0 {
            let image_manager = Arc::clone(&self.image_manager);
            let interval = std::time::Duration::from_secs(self.config.image_gc_interval_secs);
            let limits = crate::image::GcLimits {
                max_candidates: self.config.image_gc_max_candidates,
                ..Default::default()
            };
            tokio::spawn(async move {
                let mut ticker = tokio::time::interval(interval);
                ticker.tick().await; // consume the immediate first tick
                loop {
                    ticker.tick().await;
                    match image_manager.gc_bounded(limits).await {
                        Ok(report) => info!(
                            removed_images = report.removed_images,
                            removed_blobs = report.removed_blobs,
                            reclaimed_bytes = report.reclaimed_bytes,
                            deferred_by_limit = report.deferred_by_limit,
                            skipped_active_transfers = report.skipped_active_transfers,
                            skipped_active_builds = report.skipped_active_builds,
                            "bounded image GC sweep completed"
                        ),
                        Err(error) => {
                            warn!("bounded image GC sweep failed and will retry: {error:#}")
                        }
                    }
                    match image_manager.cleanup_builds().await {
                        Ok(report) => info!(
                            expired_builds = report.expired_builds,
                            expired_rejected = report.expired_rejected,
                            deferred_active = report.deferred_active,
                            "bounded image build cleanup completed"
                        ),
                        Err(error) => {
                            warn!("bounded image build cleanup failed and will retry: {error:#}")
                        }
                    }
                }
            });
        }

        let heartbeat_interval_secs = self.config.heartbeat_interval_secs;

        // Background sweeper: periodically mark agents that have missed their
        // heartbeat window as offline so clients stop targeting dead agents.
        // Sessions for offline agents are cleaned after a 30s grace period
        // to allow for agent reconnection.
        {
            let agent_registry = Arc::clone(&self.agent_registry);
            let session_registry = Arc::clone(&self.session_registry);
            let command_broker = Arc::clone(&self.command_broker);
            let env_service = Arc::clone(&self.env_service);
            let web_client_registry = Arc::clone(&self.web_client_registry);
            // Sweep at the heartbeat cadence (min 1s) so detection latency stays
            // close to the configured timeout.
            let sweep_period = std::time::Duration::from_secs(heartbeat_interval_secs.max(1));
            tokio::spawn(async move {
                let mut ticker = tokio::time::interval(sweep_period);
                ticker.tick().await; // consume the immediate first tick
                loop {
                    ticker.tick().await;
                    let offline = agent_registry.check_offline_agents().await;
                    for transition in offline {
                        let agent_id = transition.agent_id;
                        info!("Agent {} marked offline (heartbeat timeout)", agent_id);
                        // A liveness verdict, not a disconnect: nobody is
                        // heartbeating for this agent, so there is no owner to
                        // compare against — see `CommandBroker::evict_agent`.
                        // A connection that is still alive re-claims on its next
                        // message, which is the only way back for an agent that
                        // went quiet without dropping its WebSocket.
                        command_broker.evict_agent(&agent_id).await;

                        // Schedule session cleanup after the grace period,
                        // bound to the offline episode this transition opened.
                        // If the agent heartbeats or re-registers before the
                        // grace expires, the cleanup stands down; if a later
                        // offline interval begins, this task cannot remove its
                        // Sessions (#2997).
                        tokio::spawn(super::offline_grace::schedule_expired_offline_cleanup(
                            Arc::clone(&agent_registry),
                            Arc::clone(&session_registry),
                            Arc::clone(&env_service),
                            Arc::clone(&web_client_registry),
                            agent_id,
                            transition.offline_generation,
                        ));
                    }
                }
            });
        }

        // Background sweep: periodically clean up recovering Sessions whose
        // Agent has not restored them within the retention window.
        //
        // Selection and deletion are deliberately separate: the selection is
        // only a candidate list, and the reclamation re-checks that same
        // stale-recovering predicate at the destructive boundary while holding
        // the Session's lifecycle guard (#2848).
        {
            let session_registry = Arc::clone(&self.session_registry);
            let env_service = Arc::clone(&self.env_service);
            let db = Arc::clone(&self.db);
            // Run every hour — orphan cleanup is not latency-sensitive.
            let sweep_period = std::time::Duration::from_secs(3600);
            tokio::spawn(async move {
                let mut ticker = tokio::time::interval(sweep_period);
                ticker.tick().await; // consume the immediate first tick
                loop {
                    ticker.tick().await;
                    match super::orphan_sweep::select_stale_recovering(
                        &db,
                        super::orphan_sweep::RECOVERING_RETENTION,
                    )
                    .await
                    {
                        Ok((cutoff, rows)) => {
                            if rows.is_empty() {
                                continue;
                            }
                            let outcome = super::orphan_sweep::reclaim_selected(
                                &rows,
                                cutoff,
                                &session_registry,
                                &env_service,
                            )
                            .await;
                            info!(
                                selected = outcome.selected,
                                reclaimed = outcome.reclaimed,
                                skipped = outcome.skipped,
                                "recovering Session sweep complete"
                            );
                        }
                        Err(e) => {
                            error!("Orphan session sweep failed: {:#}", e);
                        }
                    }
                }
            });
        }

        // Background probe: periodically TCP-dial every agent's advertised P2P
        // addresses (issue #43) so the attach response carries fresh
        // reachability, letting clients skip dead endpoints.
        crate::probe::spawn_probe_task(Arc::clone(&self.agent_registry));

        // The pre-authentication admission budget (#3439). One slot per
        // accepted socket that has not yet completed an HTTP request; an
        // accepted socket beyond the bound is closed before any task is
        // spawned for it. This is the Server's answer to the Agent's #2653
        // bound, and it exists for the same reason: a peer that sends nothing
        // must not cost a task and a socket indefinitely.
        let handshake_slots = Arc::new(tokio::sync::Semaphore::new(DEFAULT_MAX_PENDING_HANDSHAKES));
        // A separate budget for upgraded WebSockets that have not authenticated
        // yet (#3439 W2): the handshake slot above is returned when the upgrade
        // is answered, so this is what bounds an upgraded socket's task, queue
        // and writer before it proves a credential.
        let pending_auth_slots = Arc::new(tokio::sync::Semaphore::new(
            self.config.max_pending_ws_auth.max(1),
        ));
        // The WS browser-Origin allowance and the canonical Server Token
        // verifier are fixed for the listener's lifetime (#4066).
        let allowed_origins = Arc::new(self.config.allowed_origins.clone());
        let server_auth = nession_protocol::TokenVerifier::new(self.config.auth_token.clone());
        let mut connections = tokio::task::JoinSet::new();

        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let (tcp_stream, addr) = accepted?;
                    info!("New connection from: {}", addr);

                    let Ok(slot) = Arc::clone(&handshake_slots).try_acquire_owned() else {
                        // Debug, not warn: this fires once per offered socket,
                        // and under the flood the bound exists for the log
                        // backend would become the next bottleneck.
                        debug!(
                            %addr,
                            pending = DEFAULT_MAX_PENDING_HANDSHAKES,
                            "refusing a connection: every handshake slot is occupied"
                        );
                        drop(tcp_stream);
                        continue;
                    };

                    let ctx = ServerContext {
                        agent_registry: Arc::clone(&self.agent_registry),
                        session_registry: Arc::clone(&self.session_registry),
                        command_broker: Arc::clone(&self.command_broker),
                        client_registry: Arc::clone(&self.client_registry),
                        web_client_registry: Arc::clone(&self.web_client_registry),
                        env_service: Arc::clone(&self.env_service),
                        db: Arc::clone(&self.db),
                        mutations: Arc::clone(&self.mutations),
                        mcp: self.mcp.clone(),
                        extension_tools: Arc::clone(&self.extension_tools),
                        mcp_enabled: self.config.mcp.enabled,
                        mcp_path: self.config.mcp.path.clone(),
                        image_manager: Arc::clone(&self.image_manager),
                        image_http: Arc::clone(&self.image_http),
                        image_registry: Arc::clone(&self.image_registry),
                        legacy_blob_route: self.config.legacy_blob_route,
                        allowed_origins: Arc::clone(&allowed_origins),
                        server_auth: server_auth.clone(),
                        heartbeat_interval_secs,
                        terminal_cols: self.config.terminal_cols,
                        terminal_web_font_size: self.config.terminal_web_font_size,
                        terminal_stall_grace: std::time::Duration::from_secs(
                            self.config.terminal_stall_grace_secs,
                        ),
                        query_concurrency: self.config.query_concurrency_per_connection,
                        ws_auth_timeout: std::time::Duration::from_secs(
                            self.config.ws_auth_timeout_secs,
                        ),
                    };
                    let tls_acceptor = tls_acceptor.clone();
                    let pending_auth = Arc::clone(&pending_auth_slots);

                    connections.spawn(async move {
                        if let Err(e) = handle_connection(
                            tcp_stream,
                            tls_acceptor,
                            ctx,
                            AdmissionSlot::new(slot),
                            pending_auth,
                        )
                        .await
                        {
                            error!("Connection error: {}", e);
                        }
                    });
                }
                // Reap finished connections so a long-lived Server does not
                // accumulate one completed entry per socket.
                Some(result) = connections.join_next(), if !connections.is_empty() => {
                    if let Err(e) = result {
                        error!("Connection task failed: {}", e);
                    }
                }
            }
        }
    }

    pub fn local_addr(&self) -> anyhow::Result<std::net::SocketAddr> {
        self.listener
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Server not initialized"))?
            .local_addr()
            .map_err(|e| anyhow::anyhow!("Failed to get local address: {e}"))
    }
}

fn build_tls_acceptor(cert_path: &str, key_path: &str) -> anyhow::Result<TlsAcceptor> {
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};
    use rustls::ServerConfig;
    use rustls_pemfile::{certs, private_key};
    use std::fs::File;
    use std::io::BufReader;

    let cert_file = File::open(cert_path)?;
    let mut cert_reader = BufReader::new(cert_file);
    let cert_chain: Vec<CertificateDer<'static>> =
        certs(&mut cert_reader).collect::<Result<Vec<_>, _>>()?;

    let key_file = File::open(key_path)?;
    let mut key_reader = BufReader::new(key_file);
    let key: PrivateKeyDer<'static> =
        private_key(&mut key_reader)?.ok_or_else(|| anyhow::anyhow!("No private key found"))?;

    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(cert_chain, key)?;

    Ok(TlsAcceptor::from(Arc::new(config)))
}

/// Shared, cheaply-cloneable state handed to each connection handler task.
#[derive(Clone)]
struct ServerContext {
    agent_registry: Arc<AgentRegistry>,
    session_registry: Arc<SessionRegistry>,
    command_broker: Arc<CommandBroker>,
    client_registry: Arc<ClientRegistry>,
    web_client_registry: Arc<WebClientRegistry>,
    env_service: Arc<EnvService>,
    db: Arc<Database>,
    /// The runtime's mutation lane (`#961` review, finding 1), shared by every
    /// connection this Server serves, because the resources it orders are the
    /// Server's rather than any one connection's. See
    /// `server::execution::mutation_scheduler`.
    mutations: Arc<KeyedLane<ResourceKey>>,
    /// The MCP endpoint mounted on this listener, when enabled.
    mcp: Option<Arc<nession_mcp::McpService>>,
    /// The validated Extension-contribution catalog (`#3778`).
    extension_tools: Arc<super::extension_tools::ExtensionToolCatalog>,
    /// Whether `[mcp] enabled = true` (#3600). Stated separately from the
    /// mounted service so the protocol answer is the configuration that was
    /// actually applied at startup.
    mcp_enabled: bool,
    /// The configured MCP path (#3600).
    mcp_path: String,
    /// Global EROFS image manager and its authorized HTTP route (#3022).
    image_manager: Arc<ImageManager>,
    image_http: Arc<ImageHttpService>,
    /// The standard OCI `/v2/` Registry service mounted on this ingress (#4090).
    image_registry: Arc<crate::image::registry::ServerRegistry>,
    /// Whether the proprietary `/images/blobs/{digest}` route is mounted (#4250).
    ///
    /// The protected compatibility toggle (`ServerConfig::legacy_blob_route`).
    /// `true` keeps the bounded compatibility window for untagged builds and
    /// digest-only legacy rows; `false` is the staged removal — migrated clients
    /// hold only `/v2/` grants and never need this route. The standard `/v2/`
    /// Registry is mounted regardless; this gates only the legacy reader.
    legacy_blob_route: bool,
    /// Browser origins allowed to open the protocol WebSocket (#4066).
    ///
    /// Empty refuses every upgrade that presents an `Origin`; requests without
    /// one (CLI, Agent, native clients) pass.
    allowed_origins: Arc<Vec<String>>,
    /// The canonical constant-time verifier for the configured Server Token.
    /// An empty token keeps the documented no-auth mode.
    server_auth: nession_protocol::TokenVerifier,
    heartbeat_interval_secs: u64,
    /// The release-selected fixed column count (#2487).
    terminal_cols: u16,
    /// The Web maximum CSS font size, mirrored for introspection (#2487).
    terminal_web_font_size: f64,
    terminal_stall_grace: std::time::Duration,
    /// How many queries one connection may have in flight (`#961-C`). Bound
    /// here rather than read per frame so a connection's lane is fixed for its
    /// lifetime: see `nession_runtime::lane::QueryLane`.
    query_concurrency: usize,
    /// The absolute deadline for an upgraded connection's first authentication
    /// (`#3439` W2), fixed for the listener rather than read per frame.
    ws_auth_timeout: std::time::Duration,
}

/// How many accepted Server connections may be mid-HTTP-request at once
/// (#3439).
///
/// The Server's equivalent of the Agent's #2653 budget. One slot per accepted
/// socket that has not yet completed an HTTP request; an accepted socket
/// beyond the bound is dropped before any task is spawned for it. This bounds
/// pending work, not Sessions or attached clients.
pub const DEFAULT_MAX_PENDING_HANDSHAKES: usize = 64;

/// How long one Server connection may take to complete an HTTP request
/// (#3439).
///
/// Covers the optional TLS handshake and the request head. It ends when the
/// request reaches the router and releases its admission slot, so a
/// long-lived WebSocket or MCP stream is never cut short by this bound.
pub const DEFAULT_HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// The frame limits the listener has always enforced. Stated explicitly rather
/// than left to a default: `#3439` moved the transport, not the bounds.
const MAX_WS_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_WS_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// Router state for one accepted connection.
#[derive(Clone)]
struct HttpState {
    ctx: ServerContext,
    /// This connection's pre-authentication claim (#3439).
    slot: AdmissionSlot,
    /// The listener's budget for upgraded-but-unauthenticated sockets
    /// (#3439 W2), acquired before an upgrade is answered.
    pending_auth: Arc<tokio::sync::Semaphore>,
}

/// Serve one accepted socket through the Server's Axum router.
async fn handle_connection(
    tcp_stream: tokio::net::TcpStream,
    tls_acceptor: Option<TlsAcceptor>,
    ctx: ServerContext,
    slot: AdmissionSlot,
    pending_auth: Arc<tokio::sync::Semaphore>,
) -> anyhow::Result<()> {
    let router = http_router(ctx, slot.clone(), pending_auth);
    ingress::serve(
        move || ingress::TcpOrTls::accept(tcp_stream, tls_acceptor),
        router,
        slot,
        DEFAULT_HANDSHAKE_TIMEOUT,
        ingress::HTTP_HEADER_READ_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Build the explicit route table for one accepted connection.
///
/// Axum owns the HTTP grammar and the Upgrade; the routes name the existing
/// owners: `/ws` for the protocol WebSocket, the Image Manager's authorized
/// blob route, and the MCP endpoint when `[mcp] enabled = true`. There is no
/// protocol sniff and no hand-written HTTP response on this listener.
///
/// The fallback keeps two pre-existing behaviors: the Server has always
/// accepted a WebSocket upgrade at the authority root (`ws://host:port`) as
/// well as at `/ws`, and anything that is not an upgrade gets a plain 404.
fn http_router(
    ctx: ServerContext,
    slot: AdmissionSlot,
    pending_auth: Arc<tokio::sync::Semaphore>,
) -> Router {
    let mcp_path = ctx.mcp.as_ref().map(|mcp| mcp.path().to_string());
    // The protected compatibility toggle (#4250): the legacy blob route is
    // mounted only while the bounded compatibility window is open. The standard
    // `/v2/` Registry below is mounted regardless, so a migrated client holding
    // only `/v2/` grants is unaffected when the legacy reader is removed.
    let legacy_blob_route = ctx.legacy_blob_route;
    // The standard `/v2/` Registry router (#4090) is stateless once built; it is
    // merged below so its requests share the same admission-slot backstop as the
    // WebSocket and proprietary blob routes.
    let registry_router = ctx.image_registry.router();
    let state = HttpState {
        ctx,
        slot: slot.clone(),
        pending_auth,
    };
    let mut router = Router::new().route("/ws", get(ws_upgrade));
    if legacy_blob_route {
        router = router.route(&crate::image::http::blob_route(), get(image_blob));
    }
    if let Some(path) = mcp_path.as_deref() {
        router = router.route(path, any(mcp_http));
    }
    router
        .fallback(websocket_or_not_found)
        .with_state(state)
        .merge(registry_router)
        .layer(axum::middleware::from_fn_with_state(
            slot,
            ingress::release_after_response,
        ))
}

/// The `/ws` route: a valid upgrade is accepted, anything else is the
/// extractor's own rejection (405 for a non-GET, 400 for a malformed upgrade).
/// A browser upgrade must pass the Origin policy before it reaches the
/// extractor's upgrade decision (#4066 SC-02).
async fn ws_upgrade(
    State(state): State<HttpState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !origin_policy_allows(&state.ctx.allowed_origins, &headers) {
        debug!("refusing a WebSocket upgrade: its browser Origin is not allowed");
        return StatusCode::FORBIDDEN.into_response();
    }
    finish_ws_upgrade(state, ws)
}

/// Accept a WebSocket upgrade on an otherwise unmatched path.
///
/// The registry advertises `/ws`, but the Server has always also accepted
/// `ws://host:port` and a configured `connect_url` with any path. The fallback
/// keeps that contract while still answering every non-upgrade request with
/// 404 rather than an implicit upgrade. The compatibility path applies the same
/// browser-Origin policy as `/ws` (#4066 SC-02).
async fn websocket_or_not_found(
    State(state): State<HttpState>,
    request: axum::extract::Request,
) -> Response {
    if !ingress::looks_like_websocket_upgrade(request.method(), request.headers()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let (mut parts, _body) = request.into_parts();
    if !origin_policy_allows(&state.ctx.allowed_origins, &parts.headers) {
        debug!("refusing a fallback WebSocket upgrade: its browser Origin is not allowed");
        return StatusCode::FORBIDDEN.into_response();
    }
    match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
        Ok(ws) => finish_ws_upgrade(state, ws),
        Err(rejection) => rejection.into_response(),
    }
}

/// Whether an upgrade request passes the browser-Origin policy (#4066).
///
/// A request without `Origin` is a non-browser client — the CLI, the Agent, a
/// native transport — and stays compatible. A request carrying one is a
/// browser page and must be named explicitly in the Server's
/// `allowed_origins`: reachability, including through a loopback listener, is
/// not proof of trust, and an approved Origin is never a credential.
fn origin_policy_allows(allowed_origins: &[String], headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(axum::http::header::ORIGIN) else {
        return true;
    };
    origin
        .to_str()
        .is_ok_and(|origin| allowed_origins.iter().any(|allowed| allowed == origin))
}

fn finish_ws_upgrade(state: HttpState, ws: WebSocketUpgrade) -> Response {
    // The upgrade request is the end of the pre-authentication admission
    // window, but not of the upgrade's *unauthenticated* window: until
    // `server.auth` or an authenticated Agent registration, the socket holds
    // the listener's pending-auth budget (#3439 W2). Refusing here means a
    // peer beyond the budget costs an HTTP response, not a connection task.
    let Ok(pending_auth) = Arc::clone(&state.pending_auth).try_acquire_owned() else {
        debug!("refusing a WebSocket upgrade: every pending-authentication slot is occupied");
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    state.slot.release();
    let ctx = state.ctx;
    ws.max_message_size(MAX_WS_MESSAGE_BYTES)
        .max_frame_size(MAX_WS_FRAME_BYTES)
        .on_upgrade(move |socket| async move {
            if let Err(error) =
                handle_ws_stream(AxumWebSocket::new(socket), ctx, pending_auth).await
            {
                error!("Connection error: {error:#}");
            }
        })
}

/// The Image Manager's authorized blob route.
async fn image_blob(
    State(state): State<HttpState>,
    Path(digest): Path<String>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    state.slot.release();
    state
        .ctx
        .image_http
        .respond(&method, &digest, &headers)
        .await
}

/// The MCP endpoint, mounted only when configured.
async fn mcp_http(State(state): State<HttpState>, request: axum::extract::Request) -> Response {
    state.slot.release();
    match state.ctx.mcp.as_ref() {
        Some(mcp) => mcp.handle(request).await.into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn handle_ws_stream(
    ws_stream: AxumWebSocket,
    ctx: ServerContext,
    pending_auth: tokio::sync::OwnedSemaphorePermit,
) -> anyhow::Result<()> {
    use futures_util::StreamExt;

    let ServerContext {
        agent_registry,
        session_registry,
        command_broker,
        client_registry,
        web_client_registry,
        env_service,
        db,
        mutations,
        heartbeat_interval_secs,
        terminal_cols,
        terminal_web_font_size,
        terminal_stall_grace,
        query_concurrency,
        ws_auth_timeout,
        image_manager,
        mcp: _,
        extension_tools,
        mcp_enabled,
        mcp_path,
        image_http: _,
        image_registry: _,
        legacy_blob_route: _,
        allowed_origins: _,
        server_auth,
    } = ctx;

    let (mut write, mut read) = ws_stream.split();

    // Create the outgoing-message queue BEFORE the handler so the handler can
    // register its sender for broadcasts (e.g. terminal resize). The queue is
    // bounded and its policies belong to the messages rather than to the
    // connection: see `server::outbound`.
    let (sender, mut rx) = WsMessageSender::with_terminal_grace(terminal_stall_grace);

    let token_registry = Arc::clone(&agent_registry);
    let mut handler = ConnectionHandler::new(
        crate::server::handler::ConnectionHandlerDeps {
            agent_registry,
            session_registry,
            command_broker: command_broker.clone(),
            client_registry: client_registry.clone(),
            web_client_registry: web_client_registry.clone(),
            env_service,
            image_manager,
            db,
            extension_tools: Some(extension_tools),
        },
        crate::server::handler::ConnectionHandlerConfig {
            server_auth,
            heartbeat_interval_secs,
            terminal_cols,
            terminal_web_font_size,
            mcp_enabled,
            mcp_path,
        },
    );
    handler.set_client_sender(sender.clone());

    // Spawn a relay task that drains the queue and forwards to the actual
    // write sink. A periodic WebSocket Ping keeps the TCP path alive through
    // intermediaries and lets us detect a dead peer quickly.
    //
    // The task is the queue's **single consumer**, which is what makes the
    // queue's bound a bound on the socket: a frame holds its claim on the byte
    // budget until this loop has handed it over, so producers can run ahead of
    // the socket by exactly one budget and no further.
    //
    // The ping is written directly rather than queued: it is connection control,
    // and a keepalive that a saturated business queue can starve is not a
    // keepalive. `select!` polls both arms regardless of whether the other is
    // parked, so a stalled business frame never delays a ping. The one thing
    // that could keep the ping from running was an unbounded `write.send`; each
    // write now has a finite deadline, and a timeout settles the connection so
    // the reader stops too (#4434).
    let ping_period = std::time::Duration::from_secs(heartbeat_interval_secs.max(1));
    let lifecycle = nession_runtime::lifecycle::ConnectionLifecycle::new(0);
    let write_timeouts = nession_runtime::lifecycle::WriteTimeouts::default();
    let writer_lifecycle = std::sync::Arc::clone(&lifecycle);
    let mut relay_writer = RelayWriterGuard(tokio::spawn(async move {
        let mut ping_ticker = tokio::time::interval(ping_period);
        ping_ticker.tick().await; // consume the immediate first tick
        loop {
            tokio::select! {
                maybe_msg = rx.recv() => {
                    match maybe_msg {
                        Some(frame) => {
                            // Split so the budget claim is released *after* the
                            // write, not before it: the permits stay alive
                            // across the await and drop at the end of the arm.
                            let crate::server::outbound::QueuedFrame {
                                message, budget, ..
                            } = frame;
                            let written = nession_runtime::lifecycle::write_frame(
                                &mut write,
                                message,
                                write_timeouts.write,
                            )
                            .await;
                            drop(budget);
                            if let Err(failure) = written {
                                error!("Failed to send WebSocket message: {failure}");
                                writer_lifecycle.settle(match failure {
                                    nession_runtime::lifecycle::WriteFailure::Timeout => {
                                        nession_runtime::lifecycle::CloseReason::WriteTimeout
                                    }
                                    nession_runtime::lifecycle::WriteFailure::Sink(_) => {
                                        nession_runtime::lifecycle::CloseReason::WriteError
                                    }
                                });
                                break;
                            }
                        }
                        None => break,
                    }
                }
                _ = ping_ticker.tick() => {
                    let written = nession_runtime::lifecycle::write_frame(
                        &mut write,
                        WsFrame::Ping(Vec::new()),
                        write_timeouts.write,
                    )
                    .await;
                    if let Err(failure) = written {
                        // A ping that times out is the clearest statement that
                        // the peer's TCP path is not moving.
                        debug!("WebSocket ping failed: {failure}");
                        writer_lifecycle.settle(
                            nession_runtime::lifecycle::CloseReason::WriteTimeout,
                        );
                        break;
                    }
                }
            }
        }
    }));

    // The work this connection has in flight (#961-C, #961-E). Read-only units
    // run on the query lane — this connection's own, since it is admission — and
    // mutations on the *runtime's* key lane, queued behind their resource's own
    // queue rather than in this loop. So one unit waiting on an agent does not
    // hold the connection's other frames behind it, and a mutation of a session
    // is ordered against the other connections' mutations of that session rather
    // than only against this connection's. `server::execution` owns the bounds
    // and the policies that decide which units those are.
    let mut lanes = Lanes::shared(
        query_concurrency,
        mutations,
        DEFAULT_MUTATIONS_IN_FLIGHT,
        super::execution::LANE_LABEL,
    );

    // A bounded, credential-free classification of *why* this connection ends.
    // It is logged once below and is what makes a browser's close event
    // correlatable with the Server's own view (#3358 SC-05).
    let mut close_reason = "peer-closed";

    // Read and dispatch to completion, and **capture** the outcome rather than
    // returning through the function. Teardown below must run for every way the
    // read loop ends — a normal close, a transport error, a malformed frame, a
    // handler failure, a failed relay — and a `?` in the loop used to return
    // past the lane shutdown, the generation-fenced broker release, the client
    // retirement and the writer wait (#3547). The block is all of the fallible
    // work and nothing else: when it ends, its borrows of `read`, `handler`,
    // `lanes` and `sender` are released and the teardown owns them again.
    // The upgraded socket's pending-auth budget, and the one absolute deadline
    // for its first authentication (#3439 W2). The deadline is deliberately
    // not re-armed: a Ping, malformed JSON, a refused `server.auth` or a
    // business frame must not extend the unauthenticated window. Once
    // authenticated — a client auth or an authenticated Agent registration —
    // neither applies any more.
    let mut pending_auth = Some(pending_auth);
    let auth_deadline = tokio::time::Instant::now() + ws_auth_timeout;
    let reader_result: anyhow::Result<()> = async {
        loop {
            if handler.is_authenticated() {
                pending_auth.take();
            }
            // The reader races its own stream against the writer's settlement.
            // Without this, a reader parked on a frame that will never come
            // kept the connection (and its tasks and registry entry) alive
            // after the writer had already declared the peer unhealthy
            // (#4434; the same shape as #2179).
            let next = if handler.is_authenticated() {
                tokio::select! {
                    _ = lifecycle.wait_cancelled() => {
                        close_reason = "write-side-closed";
                        break;
                    }
                    next = read.next() => next,
                }
            } else {
                match tokio::select! {
                    _ = lifecycle.wait_cancelled() => {
                        close_reason = "write-side-closed";
                        break;
                    }
                    next = tokio::time::timeout_at(auth_deadline, read.next()) => next,
                } {
                    Ok(next) => next,
                    Err(_) => {
                        close_reason = "auth-timeout";
                        break;
                    }
                }
            };
            let Some(frame) = next else { break };
            let frame = match frame {
                Ok(frame) => frame,
                Err(error) => {
                    close_reason = "read-error";
                    return Err(error.into());
                }
            };

            // Not a protocol message: a close, a ping, a pong, a binary frame.
            // Connection lifecycle, handled where it stands *and ahead of the
            // barrier below*, because a slow operation must not hold the connection
            // open — the requirement names ping and close explicitly. The work
            // still in flight is ended with the connection, further down.
            let WsFrame::Text(text) = frame else {
                match handler.handle_message(frame).await {
                    Ok(HandlerAction::Close) => {
                        close_reason = "client-close";
                        break;
                    }
                    Ok(_) => {}
                    Err(error) => {
                        close_reason = "handler-error";
                        return Err(error);
                    }
                }
                claim_agent_channel(&handler, &command_broker, &sender).await;
                continue;
            };

            // Decoded once, here: the policy is read from the envelope's own
            // `msg_type` — and, for a mutation, from its payload — and the message
            // that is dispatched below is the one this decode produced. A frame
            // whose envelope cannot be read ends the connection — which is what it
            // did when the handler did the decoding inside the loop, and the reason
            // it is still done inside the loop instead of inside the task that will
            // run it.
            let msg: ProtocolMessage<serde_json::Value> = match serde_json::from_str(&text) {
                Ok(msg) => msg,
                Err(error) => {
                    close_reason = "malformed-frame";
                    return Err(error.into());
                }
            };
            let policy = policy_for_wire(&msg.msg_type, &msg.payload);

            match policy {
                ExecutionPolicy::Query => {
                    // The claim comes first: it is what binds this connection as the
                    // agent's control channel, and a query may reach for the broker
                    // as soon as its task is scheduled.
                    claim_agent_channel(&handler, &command_broker, &sender).await;
                    // Admission is non-blocking (`#4433`): a full lane is answered
                    // with an explicit overload, so the reader never parks on a
                    // business permit and heartbeat/control keep moving.
                    let reply_wire = msg.msg_type.clone();
                    let reply_id = msg.id.clone();
                    match lanes.try_query(answer(handler.clone(), msg, sender.clone(), "a query")) {
                        Ok(()) => {}
                        Err(AdmitError::Saturated) => {
                            if sender
                                .send_reply(overload_reply(&reply_wire, &reply_id))
                                .await
                                .is_err()
                            {
                                close_reason = "outbound-closed";
                                break;
                            }
                        }
                        Err(AdmitError::Closed) => {
                            close_reason = "lane-closed";
                            break;
                        }
                    }
                    continue;
                }
                ExecutionPolicy::Key(key) => {
                    // Claimed here for the same reason as a query's: the mutation
                    // reaches for the broker as soon as its key's worker runs it,
                    // and the claim is about *this* connection rather than about the
                    // frame that prompted it.
                    claim_agent_channel(&handler, &command_broker, &sender).await;
                    // Atomic non-blocking admission at both bounds: the per-key
                    // depth and this connection's mutation slots. A refusal
                    // reserves nothing and is answered explicitly (#4433).
                    let reply_wire = msg.msg_type.clone();
                    let reply_id = msg.id.clone();
                    match lanes
                        .try_key(
                            key,
                            Box::pin(answer(handler.clone(), msg, sender.clone(), "a mutation")),
                        )
                        .await
                    {
                        Ok(()) => {}
                        Err(AdmitError::Saturated) => {
                            if sender
                                .send_reply(overload_reply(&reply_wire, &reply_id))
                                .await
                                .is_err()
                            {
                                close_reason = "outbound-closed";
                                break;
                            }
                        }
                        Err(AdmitError::Closed) => {
                            close_reason = "lane-closed";
                            break;
                        }
                    }
                    continue;
                }
                ExecutionPolicy::Ordered => {
                    // Authentication, agent registration, the relay mode
                    // transitions — applied, and answered, after everything read
                    // before them, which is what their determinism is made of on a
                    // connection that is no longer serial. The barrier covers both
                    // lanes: an `attach` must not be applied while the `create` it
                    // is about is still queued. See `ExecutionPolicy::Ordered`.
                    lanes.drain().await;
                }
                ExecutionPolicy::Inline => {}
            }

            let action = match handler.handle_protocol_message(msg).await {
                Ok(action) => action,
                Err(error) => {
                    close_reason = "handler-error";
                    return Err(error);
                }
            };
            claim_agent_channel(&handler, &command_broker, &sender).await;

            match action {
                HandlerAction::Reply(Some(response)) => {
                    // A reply is not droppable, so it waits for room rather than
                    // failing. The only error left is the queue being closed, which
                    // means this connection is over: leave the loop by the normal
                    // exit so the cleanup below still runs, instead of returning
                    // through `?` and skipping it.
                    if sender.send_reply(response).await.is_err() {
                        close_reason = "outbound-closed";
                        break;
                    }
                }
                HandlerAction::Reply(None) => {
                    // No response needed, continue
                }
                HandlerAction::Relay {
                    agent_ws_urls,
                    session_id,
                    session_name,
                    relay_request_id,
                    client_id,
                    agent_token,
                    browser_client_id,
                    env_snapshots,
                    cols,
                    rows,
                    size_known,
                    needs_bootstrap,
                    subscription_id,
                } => {
                    let mut dispatch = RelayDispatch {
                        handler: &handler,
                        lanes: &mut lanes,
                        command_broker: &command_broker,
                        sender: &sender,
                    };
                    let outcome = relay_bidirectional_via_channel(
                        &mut read,
                        sender.clone(),
                        &mut dispatch,
                        RelayRequest {
                            agent_ws_urls: &agent_ws_urls,
                            session_name: &session_name,
                            relay_request_id: &relay_request_id,
                            agent_token: &agent_token,
                            // The browser's own id wherever it has one: the Agent's
                            // control bookkeeping names clients, and the client is
                            // the only party that can recognise its own name
                            // (#1429).
                            client_id: browser_client_id.as_deref().unwrap_or(&client_id),
                            // A pre-ID legacy browser receives no route proof:
                            // its Server-generated fallback is not its own identity.
                            authenticated_browser_id: browser_client_id.as_deref(),
                            env_snapshots: &env_snapshots,
                            cols,
                            rows,
                            size_known,
                            needs_bootstrap,
                            subscription_id: subscription_id.as_deref(),
                        },
                    )
                    .await;
                    // Relay ended — clean up the client registration so the
                    // cleanup block below (WS-close path) doesn't double-free.
                    client_registry.unregister(&session_id, &client_id).await;
                    match outcome {
                        Ok(RelayEnd::Ended) => {
                            // Don't break — the WebSocket stays open for dashboard
                            // use.
                            continue;
                        }
                        Ok(RelayEnd::AgentEnded) => {
                            // The Agent's terminal stream ended while this browser
                            // still had the relay live. Nothing will arrive again,
                            // and the browser cannot see its own healthy socket and
                            // the dead tunnel apart — that silence *is* the frozen
                            // terminal #2179 reports. Closing the connection is what
                            // makes the client's own reconnect path run: it records
                            // the truncation and re-begins the relay with a fresh
                            // history bootstrap. A client that asked to stop, or one
                            // whose socket already ended, takes `Ended` instead.
                            warn!(
                                session = %session_name,
                                close_reason = "relay-agent-ended",
                                "Relay for session '{}' ended: the Agent's terminal stream ended \
                                 while the client was still attached; closing the connection so it \
                                 re-attaches",
                                session_name
                            );
                            close_reason = "relay-agent-ended";
                            // Deliberately no Close frame here. A clean close frame
                            // lets the browser reconnect before the re-registering
                            // Agent has republished its Sessions, so the client can
                            // observe a transiently empty Session list while it is
                            // rebuilding the relay. Dropping the socket keeps the
                            // pre-existing reconnect timing; the reason is recorded
                            // above and in the connection-end log for correlation.
                            break;
                        }
                        Ok(RelayEnd::AgentHalfOpen) => {
                            // The Relay→Agent leg went half-open: the Server sent
                            // probe pings and observed neither a pong nor any
                            // other frame within the bounded idle deadline, while
                            // the browser leg stayed healthy (#4065). This is the
                            // silent-partition case — no FIN/RST reached the
                            // Server, so without the probe the relay would have
                            // waited on `agent_read.next()` forever. Same
                            // recovery as `AgentEnded`: close the connection so
                            // the browser re-attaches via its existing reconnect
                            // path with a fresh relay.
                            warn!(
                                session = %session_name,
                                close_reason = "relay-agent-half-open",
                                "Relay for session '{}' ended: the Agent leg is half-open \
                                 (no frame within the idle deadline); closing the connection \
                                 so it re-attaches",
                                session_name
                            );
                            close_reason = "relay-agent-half-open";
                            // Unlike a stalled browser, this browser is still
                            // draining its socket. Expose a bounded, typed
                            // WebSocket close reason instead of leaving the
                            // client to guess why its Relay disappeared.
                            // A saturated outbound queue cannot keep teardown
                            // open: the close is best-effort and time limited.
                            let close =
                                WsFrame::Close(Some(nession_runtime::frame::WsCloseFrame {
                                    code: 1011,
                                    reason: "relay-agent-half-open".to_string(),
                                }));
                            if !matches!(
                                tokio::time::timeout(
                                    std::time::Duration::from_secs(2),
                                    sender.send_reply(close),
                                )
                                .await,
                                Ok(Ok(()))
                            ) {
                                warn!(
                                    session = %session_name,
                                    "Could not deliver bounded Agent-leg close reason"
                                );
                            }
                            break;
                        }
                        Ok(RelayEnd::ClientStalled) => {
                            // The client stopped draining its terminal (#961). Every
                            // remaining answer for it is one it is not reading, and
                            // the screen it is showing is no longer the session's —
                            // so the connection ends here rather than sitting open
                            // on a terminal that has stopped moving. The client
                            // re-attaches, and is handed a redrawn screen.
                            //
                            // The close is the socket's rather than a frame's: a
                            // `Close` sent through the queue would have to wait for
                            // room in exactly the queue this client is not draining,
                            // so the frame that says "you are not reading" would be
                            // the one that never gets written. Breaking here drops
                            // the socket, which is the same fact without the wait.
                            warn!(
                                session = %session_name,
                                close_reason = "relay-client-stalled",
                                "Relay for session '{}' ended: the client stopped draining its \
                                 terminal; closing the connection",
                                session_name
                            );
                            // Deliberately no Close frame: the queue this client is
                            // not draining is exactly where it would wait. The
                            // browser observes 1006; this log is the Server-side
                            // reason it correlates with (#3358 SC-05).
                            close_reason = "relay-client-stalled";
                            break;
                        }
                        Err(e) => {
                            close_reason = "relay-error";
                            return Err(e);
                        }
                    }
                }
                HandlerAction::Close => {
                    close_reason = "client-close";
                    break;
                }
            }
        }
        Ok(())
    }
    .await;

    info!(close_reason, "WebSocket connection ended");

    // Record the read half's verdict if the write half did not already. The
    // first observation wins, which is what keeps the close line, the write
    // deadline and a peer EOF from disagreeing about why this connection ended.
    if !lifecycle.is_settled() {
        lifecycle.settle(match close_reason {
            "peer-closed" | "client-close" => nession_runtime::lifecycle::CloseReason::PeerClosed,
            "outbound-closed" => nession_runtime::lifecycle::CloseReason::LocalClose,
            "write-side-closed" => nession_runtime::lifecycle::CloseReason::Aborted,
            _ => nession_runtime::lifecycle::CloseReason::ReadError,
        });
    }

    // End the work still in flight, before anything below waits on a writer it
    // may be parked in.
    //
    // A unit that has not finished is one nobody is waiting for any more: the
    // connection is over, so its answer would go to a peer that is gone. It is
    // ended rather than left running because a task parked in `send_reply` holds
    // a sender, and the writer task only stops once every sender is gone — so an
    // abandoned task would hold this connection's shutdown open for as long as
    // the peer's TCP stack took to give up, which is the unbounded wait this
    // stage exists to remove.
    lanes.shutdown(terminal_stall_grace).await;

    // What this connection's bounds ever did, read by something that is not a
    // test — `#961`'s "metrics/logging can observe queue saturation, in-flight
    // count, per-key queue depth". The lane's own saturation events say *when* a
    // bound was reached and which key reached it; this says how far the
    // connection ever got, which is the number that survives the connection.
    {
        let (queries, keys) = lanes.snapshot().await;
        debug!(
            "connection closed — lanes: {} (the mutation half is the shared scheduler's, \
             which this connection dispatched into); its own mutation admissions waited \
             {} time(s)",
            nession_runtime::lane::summary(&queries, &keys),
            lanes.admission_waits().await
        );
    }
    debug!("connection closed — outbound: {:?}", sender.snapshot());

    // Clean up: release the agent's control channel, but only if this
    // connection still owns it. A connection that a reconnect has already
    // superseded leaves the agent alone — its replacement is serving it — and
    // an agent that really did drop still fails its in-flight commands here.
    if let Some(agent_id) = handler.registered_agent_id() {
        if command_broker
            .release_agent(agent_id, handler.connection_generation())
            .await
        {
            // The registration generation that vouched for the cached token is
            // gone; attach must refuse until the Agent registers again (#3440).
            token_registry.clear_agent_token(agent_id).await;
        }
    }

    // Clean up: unregister client from ClientRegistry on disconnect
    if let (Some(session_id), Some(client_id)) = (
        handler.attached_session_id().map(String::from),
        handler.attached_client_id().map(String::from),
    ) {
        client_registry.unregister(&session_id, &client_id).await;
    }

    // Drop the sender to signal the relay task to exit, and wait for it — but
    // not indefinitely.
    //
    // The writer can be parked on a socket its peer has stopped reading, and
    // then it never comes back to notice the closed queue. Waiting on it would
    // keep this connection's task — and its socket, and its half of the queue —
    // alive for as long as the peer's TCP stack takes to give up, which is the
    // same unbounded wait this stage exists to remove, one level down. The grace
    // here is the terminal stall grace: "how long may a frame wait to be handed
    // over before we stop waiting" is the same question, asked at shutdown.
    //
    // The handler holds a sender of its own, so it has to go too: teardown is
    // the last thing this connection will ever ask of it, and leaving the clone
    // alive is what would turn the wait below into the grace, every time. A
    // verified web client's registry subscriber also holds one — that clone is
    // not this connection's to drop — which is what the bounded wait and abort
    // are still for.
    // Close the outbound first. The classified receiver owns an `Arc` of the
    // same inner cell that holds the class senders, so dropping the sender
    // clones alone never closes a channel: `recv` would park until the grace
    // expires and be aborted. `close` is the explicit signal that ends the
    // scheduler, which is what makes an unauthenticated socket or any other
    // ordinary teardown drop its write half promptly.
    sender.close();
    drop(handler);
    drop(sender);
    if tokio::time::timeout(terminal_stall_grace, &mut relay_writer.0)
        .await
        .is_err()
    {
        warn!(
            "outbound: writer still parked after {:?} with frames undelivered; \
             aborting it so the connection can close",
            terminal_stall_grace
        );
        relay_writer.0.abort();
    }

    // The reader's error is still the connection's outcome; the teardown above
    // ran either way, so returning it here no longer skips anything.
    reader_result
}

/// The connection's writer task, aborted if the connection future is dropped
/// before the teardown reaches it.
///
/// A bare `JoinHandle` is not an owner: dropping it detaches the task instead of
/// ending it, and this task owns the socket's write half. A panic unwinding
/// through the connection drops its future — and runtime cancellation drops it
/// too — before the ordinary teardown runs, so the task has to be held by
/// something whose `Drop` ends it. The normal path still waits for the task and
/// aborts it only after the bounded grace; this guard is what keeps a dropped
/// future from leaving the writer, and the peer's socket, alive indefinitely.
struct RelayWriterGuard(tokio::task::JoinHandle<()>);

impl Drop for RelayWriterGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Point the agent's control channel at this connection.
///
/// Re-asserted on every inbound message from a registered agent connection, but
/// the broker only lets the **newest** connection hold an agent (see
/// `CommandBroker::claim_agent`). That matters here and nowhere else: a
/// reconnect arrives as a brand-new connection, so it takes the agent over on
/// its first message — which is also what makes the first command after a
/// reconnect work, the old sender having been released. A message from a
/// connection that has already been superseded changes nothing, however late it
/// arrives (#960).
///
/// One spelling for both lanes. The ordered path claims after the frame has been
/// handled — so the registration frame itself, which is what registers the
/// identity the claim names, claims on the frame that establishes it — and the
/// query path claims before handing the frame to a task, because that task may
/// reach for the broker the moment it is scheduled.
async fn claim_agent_channel(
    handler: &ConnectionHandler,
    broker: &CommandBroker,
    sender: &WsMessageSender,
) {
    if let Some(agent_id) = handler.registered_agent_id() {
        broker
            .claim_agent(agent_id, handler.connection_generation(), sender.clone())
            .await;
    }
}

/// How a relay ended, for the caller that has to decide what to do with the
/// connection it ran on (#961).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RelayEnd {
    /// The relay stopped for an ordinary reason: the client detached or asked
    /// to stop, or the client's own socket ended. The WebSocket stays open for
    /// the connection's other work.
    Ended,
    /// The client stopped draining the terminal lane long enough that the
    /// Server declared it gone. The caller closes the connection so the client
    /// re-attaches and is handed a redrawn screen.
    ClientStalled,
    /// The **Agent's** terminal stream ended while the client was still
    /// attached and had not asked to stop (#2179). The client has no other way
    /// to learn that its terminal will produce nothing again: the relay is a
    /// Server-side pump and the client's own socket is still healthy, so
    /// silence here is the frozen terminal the bug reports. Closing the
    /// connection is what turns it into the client's reconnect path
    /// (`noteStreamTruncated` + re-begin with a fresh history bootstrap).
    AgentEnded,
    /// The Relay→Agent leg went half-open: the Server sent a probe ping and
    /// observed neither a pong nor any other frame within the bounded idle
    /// deadline, while the browser leg remained healthy (#4065). This is the
    /// silent-partition case — no FIN/RST reached the Server, so without the
    /// probe the relay would have waited on `agent_read.next()` forever. Like
    /// `AgentEnded`, the client's own socket is fine but its terminal is
    /// frozen; closing the connection is what hands the browser back to its
    /// own reconnect path with a fresh relay.
    AgentHalfOpen,
}

/// What a relay was asked for: the addresses to try, and everything the attach
/// the Server builds for the agent carries.
///
/// A struct rather than a positional tail because the fields are one thing —
/// a request — and reading the call site should not require counting
/// arguments. The Server interprets none of them; it passes each to the agent,
/// which is where they mean something.
struct RelayRequest<'a> {
    /// Candidate agent WebSocket URLs, best-first.
    agent_ws_urls: &'a [String],
    /// Short session name, as the agent knows it.
    session_name: &'a str,
    /// Original browser begin request id; this is request correlation, not
    /// a credential and not a verified parser baseline (#2089).
    relay_request_id: &'a str,
    /// The target Agent's durable token, presented as the first `client.auth`
    /// frame on the dial (#3440).
    agent_token: &'a str,
    /// The identity this relay presents to the Agent (#1429): the browser's
    /// stable client id when it sent one, and the Server's per-attach id
    /// otherwise. It is written as `client.auth` on the relay's own connection
    /// before the attach, so every id the Agent publishes for this session is
    /// one the browser can recognise — see `relay_bidirectional_via_channel`.
    client_id: &'a str,
    /// The browser-authored authenticated identity, if actually supplied.
    /// A generated compatibility fallback can attach but cannot obtain proof.
    authenticated_browser_id: Option<&'a str>,
    /// Resolved env snapshots to inject via the attach.
    env_snapshots: &'a [EnvSnapshot],
    /// Terminal columns for the initial tmux resize.
    cols: u16,
    /// Terminal rows for the initial tmux resize.
    rows: u16,
    /// Whether those columns are the browser's own measurement, forwarded
    /// verbatim for the same reason as `needs_bootstrap`: only the client knows
    /// whether it has laid a terminal out yet, and `Some(false)` tells the agent
    /// not to resize the shared window to the placeholder (#1265).
    size_known: Option<bool>,
    /// The browser's bootstrap answer (#321), forwarded verbatim. Whether a
    /// client needs the session's history is a fact about *that client's*
    /// terminal, which only the client has — so the Server does not read it.
    needs_bootstrap: Option<bool>,
    /// The browser page's subscription identity, forwarded verbatim. The
    /// Agent uses it to keep two same-origin tabs as separate subscriptions.
    subscription_id: Option<&'a str>,
}

/// Read from the agent until the reply carrying `request_id` arrives, sending
/// every other frame on to the client.
///
/// The frames in between are the Agent talking to the **client** — a scrollback
/// prefill, an initial `terminal.resize` — and they must ride the same terminal
/// lane they would have without the relay in the path. This used to read
/// exactly **one** frame and treat whatever came back as the answer, which held
/// only while the Agent stayed silent between a request and its reply; under
/// control mode it does not, and a relayed attach silently lost its bootstrap
/// (measured in the #321 S3 e2e run). A frame that cannot be read at all is
/// forwarded rather than guessed at: an unknown wire is ignored everywhere else
/// in this tree, and here "ignored" and "dropped on the floor" would be the same
/// thing.
///
/// Generic over the read half so a test can drive it without a socket, the same
/// shape [`forward_client_to_agent`] has. The caller owns the deadline.
async fn await_agent_reply<RS, E>(
    agent_read: &mut RS,
    sender: &crate::server::outbound::WsMessageSender,
    request_id: &str,
    waiting_for: &str,
) -> Result<serde_json::Value, String>
where
    RS: futures_util::Stream<Item = Result<WsFrame, E>> + Unpin,
    E: std::fmt::Display,
{
    use futures_util::StreamExt;

    loop {
        let Some(frame) = agent_read.next().await else {
            return Err(format!(
                "Agent closed the connection before answering {waiting_for}"
            ));
        };
        let msg = match frame {
            Ok(msg) => msg,
            Err(e) => {
                return Err(format!(
                    "Agent connection error while waiting for {waiting_for}: {e}"
                ));
            }
        };
        let parsed = msg
            .to_text()
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok());
        if let Some(value) = parsed {
            if value.get("id").and_then(|v| v.as_str()) == Some(request_id) {
                return Ok(value);
            }
        }
        if is_agent_forged_relay_ready(&msg) {
            warn!("Dropped Agent-forged Relay ready notification while awaiting {waiting_for}");
            continue;
        }
        match sender.send_terminal(msg).await {
            Ok(()) => {}
            Err(crate::server::outbound::OutboundError::Stalled) => {
                return Err(format!(
                    "Client stalled while the agent was answering {waiting_for}"
                ));
            }
            Err(e) => return Err(format!("Failed to forward agent message: {e}")),
        }
    }
}

/// A correlated reply is not evidence that the Agent bound this *browser*
/// identity. In particular client.auth may answer "ok" with status="error"
/// when its payload was invalid, leaving the Agent socket unauthenticated.
/// This guard runs before attach on the very same Agent socket (#2084).
fn validate_relay_client_auth_reply(
    reply: &serde_json::Value,
    expected_client_id: &str,
) -> Result<(), &'static str> {
    if expected_client_id.is_empty() {
        return Err("missing_relay_client_identity");
    }
    if reply.get("msg_type").and_then(serde_json::Value::as_str) != Some("ok") {
        return Err("unexpected_agent_auth_reply");
    }
    let Some(payload) = reply.get("payload") else {
        return Err("missing_agent_auth_payload");
    };
    if payload.get("status").and_then(serde_json::Value::as_str) != Some("success") {
        return Err("agent_auth_not_successful");
    }
    if payload.get("client_id").and_then(serde_json::Value::as_str) != Some(expected_client_id) {
        return Err("agent_auth_wrong_client");
    }
    Ok(())
}

/// This is a **Server-authored notification**; an Agent cannot speak for
/// a Server connection's current route. In particular the Agent may be
/// buggy or compromised and tunnel arbitrary JSON frames. Refuse this wire
/// on both the pre-attach and established forwarding paths (#2089).
pub const RELAY_SUBSCRIPTION_READY_WIRE: &str = "server.session.relay.ready";

fn is_agent_forged_relay_ready(msg: &WsFrame) -> bool {
    // Reuse the header-only classifier. A full Value allocation per output
    // frame would punish 100k+ terminal bursts for a rare spoofed wire.
    msg.to_text()
        .ok()
        .and_then(|text| serde_json::from_str::<RelayEnvelope<'_>>(text).ok())
        .is_some_and(|frame| frame.msg_type == Some(RELAY_SUBSCRIPTION_READY_WIRE))
}

/// Publish only a pair actually returned on the **authenticated, currently
/// attached Agent socket**. The Server mints the route ID, but never the
/// subscriber generation or stream epoch; the browser's request ID provides
/// correlation to its original Relay begin. This is NOT ACK authorization:
/// verified renderer baseline, live-route admission and issued-byte credit
/// are separate work in the parent Relay ACK requirement.
fn agent_attached_relay_ready(
    attach_reply: &serde_json::Value,
    session_name: &str,
    browser_client_id: &str,
    relay_request_id: &str,
) -> Option<WsFrame> {
    if browser_client_id.is_empty() || relay_request_id.is_empty() {
        return None;
    }
    if validate_relay_attach_reply(attach_reply, session_name) != Ok(true) {
        return None;
    }
    let payload = attach_reply.get("payload")?;
    let subscriber_generation = payload.get("subscriber_generation")?.as_u64()?;
    let stream_epoch = payload.get("stream_epoch")?.as_u64()?;
    let mut frame = serde_json::json!({
        "msg_type": RELAY_SUBSCRIPTION_READY_WIRE,
        "id": uuid::Uuid::new_v4().to_string(),
        "timestamp": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        "payload": {
            "session_name": session_name,
            "browser_client_id": browser_client_id,
            "relay_request_id": relay_request_id,
            "route_id": uuid::Uuid::new_v4().to_string(),
            "subscriber_generation": subscriber_generation,
            "stream_epoch": stream_epoch,
        }
    });
    // The ControlLease as the Agent answered it (#2157). Under Relay the
    // attach reply belongs to this Server, so this receipt is the only place
    // the *browser* can learn its role at attach; the Agent's later
    // control.changed notifications cover every change after it. Forwarded
    // only in its wire form and only when the Agent stated it — an older
    // Agent simply leaves the fields absent and the browser keeps its
    // pre-#2157 default.
    let out_payload = frame.get_mut("payload")?;
    if let Some(role) = payload.get("control_role").and_then(|v| v.as_str()) {
        if role == "controller" || role == "observer" {
            out_payload["control_role"] = serde_json::json!(role);
        }
    }
    if let Some(generation) = payload
        .get("control_generation")
        .and_then(serde_json::Value::as_u64)
    {
        out_payload["control_generation"] = serde_json::json!(generation);
    }
    if let Some(client_id) = payload.get("controller_client_id").and_then(|v| v.as_str()) {
        if !client_id.is_empty() {
            out_payload["controller_client_id"] = serde_json::json!(client_id);
        }
    }
    // Notification-only capabilities (#2877) are the Agent's statement, so the
    // Server forwards them unchanged — it neither adds nor validates an entry.
    // The browser negotiates the response-less progress wire from this list;
    // absent means an older Agent and keeps the v1 operation.
    if let Some(capabilities) = payload.get("terminal_capabilities") {
        if capabilities.is_array() {
            out_payload["terminal_capabilities"] = capabilities.clone();
        }
    }
    Some(WsFrame::text(frame.to_string()))
}

/// Validate that an Agent really accepted this Relay socket's attach before
/// any browser output can be pumped (#2060). A matching response id alone is
/// not proof: unexpected reply types and cross-session "ok" frames fail closed.
///
/// A new Agent includes a subscriber generation and stream epoch. The pair is
/// eligible for a future route-scoped receipt only when BOTH were minted by
/// that Agent and fit JavaScript's safe integer range. A legacy Agent may omit
/// the pair and remain on its existing non-credit Relay lane; absence does not
/// grant parser-applied ACK capability.
fn validate_relay_attach_reply(
    reply: &serde_json::Value,
    expected_session: &str,
) -> Result<bool, &'static str> {
    if reply.get("msg_type").and_then(serde_json::Value::as_str) != Some("ok") {
        return Err("unexpected_agent_attach_reply");
    }
    let Some(payload) = reply.get("payload") else {
        return Err("missing_agent_attach_payload");
    };
    if payload
        .get("session_name")
        .and_then(serde_json::Value::as_str)
        != Some(expected_session)
    {
        return Err("agent_attach_wrong_session");
    }
    let generation = payload.get("subscriber_generation");
    let epoch = payload.get("stream_epoch");
    const MAX_WIRE_INT: u64 = (1_u64 << 53) - 1;
    let safe = |value: &serde_json::Value| {
        value
            .as_u64()
            .is_some_and(|value| (1..=MAX_WIRE_INT).contains(&value))
    };
    if generation.is_some_and(|value| !safe(value)) || epoch.is_some_and(|value| !safe(value)) {
        return Err("invalid_agent_attach_subscription_identity");
    }
    Ok(generation.is_some() && epoch.is_some())
}

/// Log-safe identity of a dialed Agent endpoint (#2652).
///
/// Every URL passed to the relay dial carries the scoped credential in its
/// query. Logs keep only scheme, host, port and path; userinfo and the query
/// are discarded rather than redacted in place, so a crafted credential URL
/// has no spelling that can reach a log line. The dial itself still uses the
/// credential-bearing URL — this function is for diagnostics only.
fn sanitized_endpoint(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(parsed) => {
            let mut safe = format!(
                "{}://{}",
                parsed.scheme(),
                parsed.host_str().unwrap_or("unknown-host")
            );
            if let Some(port) = parsed.port() {
                safe.push(':');
                safe.push_str(&port.to_string());
            }
            safe.push_str(parsed.path());
            safe
        }
        Err(_) => "invalid-endpoint".to_string(),
    }
}

/// A bounded reason for a failed relay dial.
///
/// Tungstenite's `Display` can embed the URL (and therefore its credential),
/// so the log carries this category instead of the raw error.
fn relay_failure_reason(error: &tokio_tungstenite::tungstenite::Error) -> &'static str {
    use tokio_tungstenite::tungstenite::Error as Ws;
    match error {
        Ws::ConnectionClosed => "connection-closed",
        Ws::AlreadyClosed => "already-closed",
        Ws::Io(_) => "io",
        Ws::Tls(_) => "tls",
        Ws::Capacity(_) => "capacity",
        Ws::Protocol(_) => "protocol",
        Ws::WriteBufferFull(_) => "write-buffer-full",
        Ws::Utf8 => "utf8",
        Ws::AttackAttempt => "attack-attempt",
        Ws::Url(_) => "url",
        Ws::Http(_) => "http",
        Ws::HttpFormat(_) => "http-format",
    }
}

/// The Agent side of a Relay, read as the transport-neutral vocabulary.
///
/// The Agent is dialled with `tokio-tungstenite`, and that is the adapter edge
/// (`#3548`): the relay's own forwarding, classification and outbound lanes all
/// speak [`WsFrame`], exactly as the browser connection does. A raw tungstenite
/// frame is a write-side detail its readers never produce; if one appears it is
/// refused rather than given an invented text or binary meaning.
struct AgentRead<RS>(RS);

impl<RS> futures_util::Stream for AgentRead<RS>
where
    RS: futures_util::Stream<
            Item = Result<
                tokio_tungstenite::tungstenite::Message,
                tokio_tungstenite::tungstenite::Error,
            >,
        > + Unpin,
{
    type Item = Result<WsFrame, tokio_tungstenite::tungstenite::Error>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        std::pin::Pin::new(&mut self.0).poll_next(cx).map(|ready| {
            ready.map(|item| {
                item.and_then(|message| {
                    WsFrame::from_tungstenite(message).ok_or_else(|| {
                        tokio_tungstenite::tungstenite::Error::Io(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "a raw WebSocket frame cannot be read",
                        ))
                    })
                })
            })
        })
    }
}

/// The Agent side of a Relay, written from the transport-neutral vocabulary.
///
/// The conversion back to tungstenite happens in `start_send`, which is the
/// same adapter edge as [`AgentRead`].
struct AgentWrite<AS>(AS);

/// How long one Relay→Agent write may take before the relay declares the Agent
/// leg unhealthy (`#4434`). The Agent leg already has an idle timeout for
/// *reads* (#4065); this is the matching bound for a socket write the peer has
/// stopped draining.
const RELAY_WRITE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

impl<AS> AgentWrite<AS>
where
    AS: futures_util::Sink<tokio_tungstenite::tungstenite::Message> + Unpin,
    AS::Error: std::fmt::Display,
{
    /// Send one frame under a finite deadline.
    ///
    /// The relay's Agent leg had no write deadline: a peer that stopped reading
    /// could park `forward_client_to_agent` (and therefore the browser leg's
    /// input) indefinitely. A timeout is the same terminal condition as a sink
    /// error, and the caller breaks the relay on either.
    async fn send_bounded(
        &mut self,
        frame: WsFrame,
        deadline: std::time::Duration,
    ) -> Result<(), nession_runtime::lifecycle::WriteFailure> {
        nession_runtime::lifecycle::write_frame(self, frame, deadline).await
    }
}

impl<AS> futures_util::Sink<WsFrame> for AgentWrite<AS>
where
    AS: futures_util::Sink<tokio_tungstenite::tungstenite::Message> + Unpin,
{
    type Error = AS::Error;

    fn poll_ready(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        std::pin::Pin::new(&mut self.0).poll_ready(cx)
    }

    fn start_send(mut self: std::pin::Pin<&mut Self>, item: WsFrame) -> Result<(), Self::Error> {
        std::pin::Pin::new(&mut self.0).start_send(item.into_tungstenite())
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        std::pin::Pin::new(&mut self.0).poll_flush(cx)
    }

    fn poll_close(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        std::pin::Pin::new(&mut self.0).poll_close(cx)
    }
}

/// Relay mode using the connection's queued outbound path for client writes.
/// Used when the write sink is managed by a relay task.
///
/// Tries each URL in `request.agent_ws_urls` with a fast 2s connect timeout
/// until one succeeds.  This avoids long hangs when the first address
/// is unreachable (common in k8s where pod IPs are not routable).
async fn relay_bidirectional_via_channel<RS, E>(
    client_read: &mut RS,
    sender: crate::server::outbound::WsMessageSender,
    dispatch: &mut RelayDispatch<'_>,
    request: RelayRequest<'_>,
) -> anyhow::Result<RelayEnd>
where
    RS: futures_util::Stream<Item = Result<WsFrame, E>> + Unpin,
    E: std::fmt::Display,
{
    use futures_util::SinkExt;
    use futures_util::StreamExt;

    let RelayRequest {
        agent_ws_urls,
        session_name,
        relay_request_id,
        agent_token,
        client_id,
        authenticated_browser_id,
        env_snapshots,
        cols,
        rows,
        size_known,
        needs_bootstrap,
        subscription_id,
    } = request;

    info!(
        "Entering relay mode for session '{}', {} candidate URL(s)",
        session_name,
        agent_ws_urls.len()
    );

    // Fast-retry: try each URL with a 2s connect timeout.  The list is
    // sorted best-first (Reachable → Unknown → Unreachable) by the
    // handler so the first success is the best available endpoint.
    let mut agent_ws = None;
    let mut connected_url: Option<String> = None;
    for url in agent_ws_urls {
        info!("Relay: trying {}", sanitized_endpoint(url));
        match tokio::time::timeout(
            std::time::Duration::from_secs(2),
            tokio_tungstenite::connect_async(url),
        )
        .await
        {
            Ok(Ok((ws, _))) => {
                info!("Relay: connected to {}", sanitized_endpoint(url));
                agent_ws = Some(ws);
                connected_url = Some(url.clone());
                break;
            }
            Ok(Err(ref e)) => {
                warn!(
                    "Relay: connect to {} failed ({})",
                    sanitized_endpoint(url),
                    relay_failure_reason(e)
                );
            }
            Err(_) => {
                warn!(
                    "Relay: connect to {} timed out (2s)",
                    sanitized_endpoint(url)
                );
            }
        }
    }

    let agent_ws = match agent_ws {
        Some(ws) => ws,
        None => {
            anyhow::bail!(
                "Could not connect to agent for session '{}': tried {} URL(s)",
                session_name,
                agent_ws_urls.len()
            );
        }
    };

    let (agent_write, agent_read) = agent_ws.split();
    // From here on the Agent socket is just another frame transport: the
    // adapters are the only code that knows it speaks tungstenite (#3548).
    let mut agent_write = AgentWrite(agent_write);
    let mut agent_read = AgentRead(agent_read);

    // ── Step 0: Bind this relay's identity on the Agent connection (#1429) ──
    //
    // The Agent roles and authorizes attach, control changes and input by the
    // connection's `client_id`, and everything it publishes about control names
    // that id back to the client (`agent.terminal.control.changed`, the acquire
    // reply). The browser decides its own role by comparing those names against
    // its stable id — so a relay that presents no identity leaves the Agent
    // naming every relayed browser, and the Server itself, `unknown-client`, and
    // every one of those comparisons false.
    //
    // Sent, and waited for, *before* the attach on the same socket: the Agent
    // serves `client.auth` inline after draining everything read before it, so
    // ordering on this one socket is what makes the attach that follows be
    // served by this identity rather than by whatever the connection was. The
    // wait is what turns a refusal into a failed relay instead of a session
    // that quietly belongs to nobody.
    //
    // The Agent Token is the relay leg's real authentication (#3440): the
    // Server holds it from the Agent's registration and presents it here, not
    // in the URL.
    let auth_id = uuid::Uuid::new_v4().to_string();
    let auth_msg = serde_json::json!({
        "msg_type": "client.auth",
        "id": auth_id.clone(),
        "timestamp": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        "payload": { "auth_token": agent_token, "client_id": client_id },
    });
    agent_write
        .send_bounded(WsFrame::Text(auth_msg.to_string()), RELAY_WRITE_DEADLINE)
        .await?;
    let auth_response = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        await_agent_reply(&mut agent_read, &sender, &auth_id, "the client auth"),
    )
    .await;
    match auth_response {
        Ok(Ok(reply)) => {
            validate_relay_client_auth_reply(&reply, client_id)
                .map_err(|reason| anyhow::anyhow!("Agent relay client auth rejected: {reason}"))?;
        }
        Ok(Err(reason)) => {
            error!("{reason}");
            return Err(anyhow::anyhow!("{reason}"));
        }
        Err(_) => {
            error!("Timeout waiting for the agent's client.auth response (10s)");
            return Err(anyhow::anyhow!(
                "Timeout waiting for agent to bind the relay's identity for session '{session_name}'",
            ));
        }
    }

    // ── Step 1: Send agent.attach to the agent ──
    // The Agent answers this one, so the wire carries the Agent's prefix even
    // though the Server is the sender — the rule names the handler, not the
    // sender. Writing `server.attach` here reads as "the Server handles it",
    // which is the opposite of true and leaves the relay hanging.
    // Kept, because the reply is matched on it below: `id` is how every reply in
    // this tree is correlated (a reply carries its request's own wire name and
    // is paired by `id`, not by arrival order).
    let attach_id = uuid::Uuid::new_v4().to_string();
    // Built as an object rather than a literal so the optional bootstrap answer
    // can be *absent* rather than null: the agent's rule reads the field's
    // presence (`Option<bool>`), and a JSON `null` and a missing key are the
    // same thing to serde only because `Option` ignores both — but the wire is
    // also what an older agent reads, and it has never seen this key.
    let mut attach_payload = serde_json::json!({
        "session_name": session_name,
        "width": cols,
        "height": rows,
        "env_snapshots": env_snapshots,
    });
    if let Some(size_known) = size_known {
        // Same shape, and the same reason, as `needs_bootstrap` below: absent
        // rather than null, because an older agent has never seen this key and
        // absence is what preserves the meaning it already had.
        if let Some(object) = attach_payload.as_object_mut() {
            object.insert(
                "size_known".to_string(),
                serde_json::Value::Bool(size_known),
            );
        }
    }
    if let Some(needs_bootstrap) = needs_bootstrap {
        // `as_object_mut`, not `[…]`: the payload is a literal built three
        // lines up, so indexing it is a panic waiting for someone to edit that
        // literal — and there is no upside to the shorter spelling.
        if let Some(object) = attach_payload.as_object_mut() {
            object.insert(
                "needs_bootstrap".to_string(),
                serde_json::Value::Bool(needs_bootstrap),
            );
        }
    }
    if let Some(subscription_id) = subscription_id {
        if let Some(object) = attach_payload.as_object_mut() {
            object.insert(
                "subscription_id".to_string(),
                serde_json::Value::String(subscription_id.to_string()),
            );
        }
    }
    let attach_msg = serde_json::json!({
        "msg_type": "agent.attach",
        "id": attach_id.clone(),
        "timestamp": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        "payload": attach_payload,
    });
    agent_write
        .send_bounded(WsFrame::Text(attach_msg.to_string()), RELAY_WRITE_DEADLINE)
        .await?;

    // Wait for the reply *to this request*, forwarding anything the agent says
    // in the meantime. The whole wait shares the 10s budget.
    //
    // This used to read exactly **one** frame and treat whatever came back as
    // the answer. That held only while the agent stayed silent between the
    // request and its reply — and under control mode it does not: the scrollback
    // prefill and an initial `terminal.resize` are sent first. Those frames were
    // logged and dropped, so a relayed attach silently lost its bootstrap, which
    // is not a shape anything reports. Measured in the #321 S3 e2e run:
    // `Agent confirmed attach for session 'e2e-resize-0'
    // (msg_type=agent.terminal.output)`.
    //
    // A frame that is not ours is the agent talking to the **client**; it rides
    // the same terminal lane it would have without the relay in the path.
    let attach_response = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        await_agent_reply(&mut agent_read, &sender, &attach_id, "the attach"),
    )
    .await;
    let attach_response = match attach_response {
        Ok(Ok(parsed)) => parsed,
        Ok(Err(reason)) => {
            error!("{reason}");
            return Err(anyhow::anyhow!("{reason}"));
        }
        Err(_) => {
            error!("Timeout waiting for agent attach response (10s)");
            return Err(anyhow::anyhow!(
                "Timeout waiting for agent to accept attach for session '{session_name}'",
            ));
        }
    };
    let resp_type = attach_response
        .get("msg_type")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if resp_type == "error" {
        let err_msg = attach_response
            .get("payload")
            .and_then(|p| p.get("message"))
            .and_then(|v| v.as_str())
            .unwrap_or("attach failed");
        error!(
            "Agent rejected attach for session '{}': {}",
            session_name, err_msg
        );
        // Forward error to the browser client
        let client_error = WsFrame::Text(
            serde_json::json!({
                "msg_type": "error",
                "id": uuid::Uuid::new_v4().to_string(),
                "timestamp": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
                "payload": {
                    "code": "attach_failed",
                    "message": format!(
                        "Failed to attach to session '{}': {}",
                        session_name, err_msg
                    ),
                }
            })
            .to_string(),
        );
        if sender.send_reply(client_error).await.is_err() {
            // The queue is closed — the client's connection is already over,
            // and the error it was going to be told about is moot.
            return Ok(RelayEnd::Ended);
        }
        return Ok(RelayEnd::Ended);
    }
    let has_agent_subscription_proof = validate_relay_attach_reply(&attach_response, session_name)
        .map_err(|reason| anyhow::anyhow!("Agent relay attach rejected: {reason}"))?;
    info!(
        "Agent confirmed relay attach for session '{}' (Agent subscription proof: {})",
        session_name, has_agent_subscription_proof,
    );

    // This receipt can only name the Agent subscription on the same socket
    // whose attach reply we just validated. Legacy and partial identity never
    // yield one. It is informational: it does NOT enable ACK or credit.
    if has_agent_subscription_proof {
        if let Some(browser_id) = authenticated_browser_id {
            if let Some(receipt) = agent_attached_relay_ready(
                &attach_response,
                session_name,
                browser_id,
                relay_request_id,
            ) {
                sender.send_reply(receipt).await.map_err(|e| {
                    anyhow::anyhow!("Could not publish Relay subscription proof: {e}")
                })?;
            }
        }
    }
    info!("Relay established for session '{}'", session_name);

    // ── Step 2: Bidirectional forwarding ──

    let client_to_agent = forward_client_to_agent(
        client_read,
        &mut agent_write,
        session_name,
        INPUT_THROTTLE,
        AGENT_LEG_PROBE_INTERVAL,
        Some(dispatch),
    );

    // Forward agent -> client, through the terminal lane of the outbound queue.
    //
    // Terminal bytes are the one stream on this connection that is *steady*: a
    // session produces them whether or not anybody is watching, so a client that
    // has stopped draining does not simply park a producer that was about to
    // finish — it pins the relay, and the agent's output behind it, for as long
    // as it stays connected. The stall grace is what turns that into a verdict
    // (`ClientStalled`) instead of an indefinite park; see
    // `outbound::WsMessageSender::send_terminal`.
    let mut stalled = false;
    let mut agent_ended = false;
    // The Relay→Agent leg has no liveness of its own: the browser-leg ping
    // ticker (in the enclosing WS handler) is a different socket, and the one
    // 10s handshake timeout above covers only `client.auth`, not the long-lived
    // stream that follows. A silent partition between the Server and the Agent
    // — TCP half-open, no FIN/RST — would leave `agent_read.next()` parked
    // forever. The idle deadline below is what turns that into a verdict
    // (`AgentHalfOpen`); the matching probe pings that keep a healthy but idle
    // Agent from tripping it are sent by `forward_client_to_agent`, which owns
    // the Agent-leg writer (#4065).
    let mut agent_half_open = false;
    let agent_to_client = async {
        match relay_agent_to_client(&mut agent_read, &sender, AGENT_LEG_IDLE_TIMEOUT).await {
            AgentToClient::HalfOpen => {
                agent_half_open = true;
            }
            AgentToClient::Errored | AgentToClient::Ended => {
                agent_ended = true;
            }
            AgentToClient::Stalled => {
                stalled = true;
            }
        }
    };

    tokio::select! {
        outcome = client_to_agent => {
            info!(
                "Client to agent relay ended for session '{}' ({:?})",
                session_name, outcome
            );
        }
        _ = agent_to_client => {
            info!("Agent to client relay ended for session '{}'", session_name);
        }
    }

    // ── Step 3: Send agent.detach on exit (best-effort, fresh connection) ──
    // The original agent WS was split+consumed, so we open a fresh connection
    // to the same URL that worked for the attach.
    if let Some(ref url) = connected_url {
        if let Ok((mut detach_ws, _)) = tokio_tungstenite::connect_async(url).await {
            // The detach is a **second dial**, so it authenticates like the
            // first: the Agent Token as the first frame, never a URL parameter
            // (#3440). Sending detach on an unauthenticated socket would be the
            // silent second path this design exists to remove.
            let auth_id = uuid::Uuid::new_v4().to_string();
            let auth_msg = serde_json::json!({
                "msg_type": "client.auth",
                "id": auth_id.clone(),
                "timestamp": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
                "payload": { "auth_token": agent_token, "client_id": client_id },
            });
            let mut authenticated = false;
            if detach_ws
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    auth_msg.to_string(),
                ))
                .await
                .is_ok()
            {
                loop {
                    match tokio::time::timeout(std::time::Duration::from_secs(10), detach_ws.next())
                        .await
                    {
                        Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text)))) => {
                            let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                                continue;
                            };
                            if value.get("id").and_then(|id| id.as_str()) == Some(auth_id.as_str())
                            {
                                authenticated = value
                                    .pointer("/payload/status")
                                    .and_then(|status| status.as_str())
                                    == Some("success");
                                break;
                            }
                        }
                        Ok(Some(Ok(_))) => continue,
                        _ => break,
                    }
                }
            }
            if authenticated {
                let detach_msg = serde_json::json!({
                    "msg_type": "agent.detach",
                    "id": uuid::Uuid::new_v4().to_string(),
                    "timestamp": std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs(),
                    "payload": {
                        "session_name": session_name,
                    }
                });
                let _ = detach_ws
                    .send(tokio_tungstenite::tungstenite::Message::Text(
                        detach_msg.to_string(),
                    ))
                    .await;
                info!(
                    "Sent client.detach for session '{}' (best-effort)",
                    session_name
                );
            } else {
                warn!(
                    "Agent refused the detach connection's authentication for session '{}'",
                    session_name
                );
            }
        } else {
            warn!(
                "Could not connect to agent for client.detach for session '{}'",
                session_name
            );
        }
    }

    info!("Relay mode ended for session '{}'", session_name);
    Ok(if stalled {
        RelayEnd::ClientStalled
    } else if agent_half_open {
        RelayEnd::AgentHalfOpen
    } else if agent_ended {
        RelayEnd::AgentEnded
    } else {
        RelayEnd::Ended
    })
}

/// The terminal-input throttle window: a burst of input arriving inside it is
/// collapsed to its newest frame. 16 ms ≈ 60 fps — faster than a mouse-tracking
/// flood, slower than anything a person types.
const INPUT_THROTTLE: std::time::Duration = std::time::Duration::from_millis(16);

/// How often `forward_client_to_agent` writes a WebSocket ping on the Relay→
/// Agent leg when the client has not sent anything to forward (#4065). The
/// Agent's tungstenite stack auto-answers pings with pongs at the wire level;
/// that pong surfaces as a frame on `agent_read` and is what resets the idle
/// deadline in `agent_to_client`. Kept deliberately longer than the browser-leg
/// ping period (which tracks the registry heartbeat): the Agent leg is a
/// separate socket and does not need to match the browser cadence, but it does
/// need to be shorter than [`AGENT_LEG_IDLE_TIMEOUT`] so a healthy idle Agent
/// always answers inside the deadline.
const AGENT_LEG_PROBE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

/// Bounded wait for *any* frame on the Relay→Agent leg before declaring it
/// half-open (#4065). The matching probe pings are sent by
/// `forward_client_to_agent` every [`AGENT_LEG_PROBE_INTERVAL`]; a healthy
/// Agent's pong (or any terminal/control frame) resets the clock. Chosen as
/// 3× the probe interval, matching the ratio the registry uses between its
/// own heartbeat interval and heartbeat timeout — long enough that a slow but
/// responsive Agent is never spuriously torn down, short enough that a
/// partitioned leg is retired in a documented finite bound.
const AGENT_LEG_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);

/// The wire a browser sends keystrokes and mouse reports on. The **Agent**
/// answers it, so the name carries the Agent's prefix even though the Server is
/// the one relaying it (`docs/architecture/protocol-identity.md`).
const TERMINAL_INPUT_WIRE: &str = "agent.terminal.input";

/// Relay-local control: stop the relay without closing the WebSocket. The
/// Server is the handler — no Agent serves this wire, which is why it must
/// never be forwarded.
const RELAY_END_WIRE: &str = "server.session.relay.end";

/// What one client frame means to the relay.
///
/// Decided once per frame, from the envelope's own `msg_type`, and reused by
/// every read path — the main loop and the throttle's drain loop alike. Two
/// things this fixes, both of them the same defect at different depths: what a
/// frame means must not depend on *when* it was read, and it must not depend on
/// what its payload happens to say. The substring matching this replaces read
/// `"terminal.input"` out of the raw text, so a payload that merely mentioned
/// the string was routed as protocol identity, while the real frame —
/// `agent.terminal.input`, since the wire was renamed to name its handler
/// (#884) — matched nothing at all and the throttle never ran for a frame a
/// browser can send (#962).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClientFrame {
    /// `agent.terminal.input` — terminal data, and the only coalescable kind.
    TerminalInput,
    /// `server.session.relay.end` — control: ends the relay, never forwarded.
    RelayEnd,
    /// A wire the **Server** serves — the connection's own work, asked while it
    /// happens to be attached: attach settings, `server.session.create`,
    /// `server.info`, `server.env.list`. Answered here by the Server, never
    /// forwarded (#1504).
    ServerUnit,
    /// Everything else, forwarded unchanged and in arrival order.
    Other,
}

/// The envelope header, and nothing else.
///
/// `msg_type` is all the relay routes on, so the rest of the frame is skipped
/// rather than materialised: this runs on every frame of a mouse flood, where
/// building a `Value` per frame would be work nobody reads.
#[derive(serde::Deserialize)]
struct RelayEnvelope<'a> {
    #[serde(borrow)]
    msg_type: Option<&'a str>,
}

/// Decide what a frame is from the envelope's own field.
///
/// A frame that is not text, is not JSON, or carries no `msg_type` is `Other`:
/// unreadable is not the same as terminal input, and the previous spelling's
/// answer to "unreadable" was an accident of where the substring landed. A wire
/// this relay does not recognise is forwarded rather than guessed at, which is
/// the rule everywhere else in the tree — an unknown wire is ignored, never
/// rejected.
fn classify_client_frame(msg: &WsFrame) -> ClientFrame {
    let Ok(text) = msg.to_text() else {
        return ClientFrame::Other;
    };
    let Ok(envelope) = serde_json::from_str::<RelayEnvelope<'_>>(text) else {
        return ClientFrame::Other;
    };
    match envelope.msg_type {
        Some(TERMINAL_INPUT_WIRE) => ClientFrame::TerminalInput,
        Some(RELAY_END_WIRE) => ClientFrame::RelayEnd,
        // The split is the protocol's own rule, not a convention invented here:
        // a wire's first segment names the runtime that **answers** it
        // (`docs/architecture/protocol.md`), so `server.` is the wire saying
        // the Server serves it. The relay used to send everything that was not
        // terminal input onward — which asks the Agent for an answer it has no
        // unit for, and its reply was `unknown message type` for every
        // server-scoped request a client made while attached (#1504).
        Some(wire) if wire.starts_with("server.") => ClientFrame::ServerUnit,
        _ => ClientFrame::Other,
    }
}

/// Answer one Server-served unit while a relay holds this connection (#1504).
///
/// The read half belongs to the relay for as long as it runs, so nothing else
/// can dispatch the frames it reads — and the connection's owner is still using
/// it: attach settings, session create and `server.info` are all asked *while*
/// attached. This runs them through the same lane discipline the connection's
/// ordinary loop applies ([`ExecutionPolicy`]), so a relay is not a window in
/// which one mutation may jump another mutation of the same session.
///
/// [`answer`] is the shared unit runner, and it already refuses what cannot
/// happen from here: a unit answering with a connection transition (a second
/// relay, a close) is reported rather than obeyed, because a lane runs against
/// a snapshot of the connection.
///
/// Returns false only if the frame cannot be decoded — which
/// [`classify_client_frame`] has already ruled out for the frames that reach
/// this, so the caller's fallback is a formality rather than a path.
async fn answer_server_unit(
    handler: &ConnectionHandler,
    lanes: &mut Lanes,
    command_broker: &CommandBroker,
    sender: &WsMessageSender,
    text: &str,
) -> bool {
    let Ok(msg) = serde_json::from_str::<ProtocolMessage<serde_json::Value>>(text) else {
        return false;
    };
    // Claimed once, up front, exactly as the ordinary loop claims for both lane
    // arms before its task is scheduled. It is a no-op for a browser client —
    // the claim is about an *agent's* control channel — which is every
    // connection that reaches a relay.
    claim_agent_channel(handler, command_broker, sender).await;
    let reply_wire = msg.msg_type.clone();
    let reply_id = msg.id.clone();
    match policy_for_wire(&msg.msg_type, &msg.payload) {
        ExecutionPolicy::Query => {
            match lanes.try_query(answer(handler.clone(), msg, sender.clone(), "a query")) {
                Ok(()) => {}
                Err(AdmitError::Saturated) => {
                    if sender
                        .send_reply(overload_reply(&reply_wire, &reply_id))
                        .await
                        .is_err()
                    {
                        return false;
                    }
                }
                Err(AdmitError::Closed) => return false,
            }
        }
        ExecutionPolicy::Key(key) => {
            match lanes
                .try_key(
                    key,
                    Box::pin(answer(handler.clone(), msg, sender.clone(), "a mutation")),
                )
                .await
            {
                Ok(()) => {}
                Err(AdmitError::Saturated) => {
                    if sender
                        .send_reply(overload_reply(&reply_wire, &reply_id))
                        .await
                        .is_err()
                    {
                        return false;
                    }
                }
                Err(AdmitError::Closed) => return false,
            }
        }
        // The barrier an ordered unit waits behind is what makes it
        // deterministic on a connection that is no longer serial, so it is
        // applied here for the same reason it is applied out there.
        ExecutionPolicy::Ordered => {
            lanes.drain().await;
            answer(handler.clone(), msg, sender.clone(), "an ordered unit").await;
        }
        ExecutionPolicy::Inline => {
            answer(handler.clone(), msg, sender.clone(), "an inline unit").await;
        }
    }
    true
}

/// Where one terminal-input frame says its bytes sit in the session's input
/// stream (#1307).
///
/// Three answers rather than two, because "this frame states no position" and
/// "this frame states half a position" are different facts about it. The first
/// is a sender from before the contract — `TerminalInputPayload` documents its
/// absence as legal and means *unsequenced*, so it merges like any other bytes
/// that claim nothing. The second is malformed: the two ends are present
/// together or neither, the Agent refuses such a frame outright
/// (`bad_input_sequence`), and merging cannot repair one.
enum InputPosition {
    /// No position stated: a sender that has none, whose bytes are still
    /// written and still advance nothing.
    Unsequenced,
    Sequenced {
        epoch: u64,
        start: u64,
        end: u64,
    },
    /// Some of the three fields and not all — never mergeable.
    Malformed,
}

/// Read [`InputPosition`] off a frame's envelope.
fn input_position(envelope: &serde_json::Value) -> InputPosition {
    let payload = envelope.get("payload");
    let field = |name: &str| {
        payload
            .and_then(|p| p.get(name))
            .and_then(serde_json::Value::as_u64)
    };
    match (field("input_epoch"), field("seq_start"), field("seq_end")) {
        (None, None, None) => InputPosition::Unsequenced,
        (Some(epoch), Some(start), Some(end)) => InputPosition::Sequenced { epoch, start, end },
        _ => InputPosition::Malformed,
    }
}

/// The sequence range a burst's bytes lie in, once the burst is known to have
/// one.
enum MergedRange {
    /// Every frame is unsequenced, so the merged frame claims nothing — and
    /// claiming nothing is the only true statement about it.
    Unsequenced,
    Sequenced {
        epoch: u64,
        start: u64,
        end: u64,
    },
    /// The burst has no single range, so it must not be given one.
    Unmergeable,
}

/// Derive the range a burst covers, or refuse to state one.
///
/// A merged frame carries one envelope for bytes that came from several, so it
/// can only be honest if those bytes really do form one run: **the first frame's
/// `seq_start` through the last frame's `seq_end`**, with nothing missing in
/// between. Refusing is the answer to everything that breaks that — which is
/// the whole point of deriving rather than inventing, because a merged frame
/// that overstates its range is worse than an unmerged one. The Agent advances
/// its applied cursor to whatever the frame claims, so a range that spans a
/// chunk the burst did not carry marks that chunk applied; the frame that later
/// brings it is then refused as a duplicate, and the user's input is gone with
/// no error anywhere.
///
/// Four ways a burst fails to be one run:
///
/// * a frame states half a position ([`InputPosition::Malformed`]);
/// * the frames do not agree on `input_epoch`, so their numbers count in
///   different runs and the merged frame would have to pick one;
/// * the burst mixes sequenced and unsequenced frames — the sequenced ones name
///   positions the unsequenced ones do not occupy, so no range states where the
///   bytes are;
/// * two consecutive frames do not meet end to end, leaving a hole the merged
///   range would nonetheless claim.
fn merged_range(positions: &[InputPosition]) -> MergedRange {
    // `(epoch, first start, running end)` — the first frame's start and the
    // last frame's end, which is the range the caller states.
    let mut range: Option<(u64, u64, u64)> = None;
    let mut saw_unsequenced = false;

    for position in positions {
        match *position {
            InputPosition::Malformed => return MergedRange::Unmergeable,
            InputPosition::Unsequenced => {
                if range.is_some() {
                    return MergedRange::Unmergeable;
                }
                saw_unsequenced = true;
            }
            InputPosition::Sequenced { epoch, start, end } => {
                if saw_unsequenced {
                    return MergedRange::Unmergeable;
                }
                match range {
                    None => range = Some((epoch, start, end)),
                    Some((seen_epoch, first_start, seen_end)) => {
                        // `saturating_add`: a frame at the top of the u64 range
                        // is not a burst to panic on, it is one no later frame
                        // can continue.
                        if epoch != seen_epoch || start != seen_end.saturating_add(1) {
                            return MergedRange::Unmergeable;
                        }
                        range = Some((seen_epoch, first_start, end));
                    }
                }
            }
        }
    }

    match range {
        Some((epoch, start, end)) => MergedRange::Sequenced { epoch, start, end },
        None => MergedRange::Unsequenced,
    }
}

/// Merge a burst of terminal-input frames into one that carries every byte.
///
/// `#966`. The window used to keep only the **newest** frame of a burst, which
/// is right for a mouse report — a position, where only the last one matters —
/// and wrong for everything else that shares `agent.terminal.input`: a paste, an
/// IME composition and key repeat all arrive here, and their earlier frames are
/// *content*, not stale positions.
///
/// Telling the two apart means reading escape sequences out of the payload, and
/// the payload is base64 — so the classifier that decides "coalescable" cannot
/// also decide "safe to drop". Merging removes the question instead of answering
/// it: every byte survives, and the window still does its job, because the agent
/// receives one frame instead of N.
///
/// `#1307`: the newest frame's envelope also carried the newest frame's
/// *position*, and every frame before it had none — so a burst of numbered
/// input went out stating the last frame's range while carrying all of them,
/// and the Agent, which refuses a frame that does not continue its cursor,
/// refused the lot. The merged envelope's `seq_start`/`seq_end` are therefore
/// replaced with the range the burst actually covers, derived by
/// [`merged_range`].
///
/// `None` when any frame's payload cannot be read **or the burst has no single
/// range** ([`MergedRange::Unmergeable`]), which is the honest answer in both
/// cases — there is nothing to merge, and the caller forwards them in order
/// rather than guessing which ones mattered.
fn merge_terminal_input(frames: &[WsFrame]) -> Option<WsFrame> {
    use base64::Engine as _;
    let engine = base64::engine::general_purpose::STANDARD;

    let mut bytes = Vec::new();
    let mut positions = Vec::with_capacity(frames.len());
    for frame in frames {
        let envelope: serde_json::Value = serde_json::from_str(frame.to_text().ok()?).ok()?;
        let data = envelope.get("payload")?.get("data")?.as_str()?;
        bytes.extend(engine.decode(data).ok()?);
        positions.push(input_position(&envelope));
    }

    let range = match merged_range(&positions) {
        MergedRange::Unmergeable => return None,
        MergedRange::Unsequenced => None,
        MergedRange::Sequenced { epoch, start, end } => Some((epoch, start, end)),
    };

    // The newest frame supplies the envelope — the id and the session — and only
    // its `data` is replaced. All frames in a burst are for this one relay's
    // session, so the envelope is the same shape throughout.
    let mut envelope: serde_json::Value =
        serde_json::from_str(frames.last()?.to_text().ok()?).ok()?;
    let payload = envelope.get_mut("payload")?.as_object_mut()?;
    payload.insert(
        "data".to_string(),
        serde_json::Value::String(engine.encode(&bytes)),
    );
    // Only for a sequenced burst: an unsequenced one states no position, and
    // writing one there would be inventing the very thing this function
    // exists to stop inventing.
    if let Some((epoch, start, end)) = range {
        payload.insert("input_epoch".to_string(), serde_json::Value::from(epoch));
        payload.insert("seq_start".to_string(), serde_json::Value::from(start));
        payload.insert("seq_end".to_string(), serde_json::Value::from(end));
    }
    Some(WsFrame::Text(envelope.to_string()))
}

/// Forward a burst that the throttle window held, in order and losing nothing.
///
/// Returns `false` when a send failed, which is how the caller learns to stop.
async fn flush_burst<AS>(agent_write: &mut AS, burst: &mut Vec<WsFrame>) -> bool
where
    AS: futures_util::Sink<WsFrame> + Unpin,
    AS::Error: std::fmt::Display,
{
    let frames = std::mem::take(burst);

    // One frame needs no merge, and the common case is a burst of one.
    let merged = match frames.len() {
        0 => return true,
        1 => frames.into_iter().next(),
        _ => match merge_terminal_input(&frames) {
            Some(merged) => Some(merged),
            // Unmergeable: forward them individually rather than drop the ones
            // that could not be folded in.
            None => {
                for frame in frames {
                    if let Err(e) = nession_runtime::lifecycle::write_frame(
                        agent_write,
                        frame,
                        RELAY_WRITE_DEADLINE,
                    )
                    .await
                    {
                        error!("Failed to forward client message to agent: {}", e);
                        return false;
                    }
                }
                return true;
            }
        },
    };

    match merged {
        Some(frame) => {
            match nession_runtime::lifecycle::write_frame(agent_write, frame, RELAY_WRITE_DEADLINE)
                .await
            {
                Ok(()) => true,
                Err(e) => {
                    error!("Failed to forward client message to agent: {}", e);
                    false
                }
            }
        }
        None => true,
    }
}

/// Why the client → agent half of the relay stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClientToAgent {
    /// The client asked for it: `server.session.relay.end`. The frame that said
    /// so is not forwarded to the agent.
    ClientRequested,
    /// The client stream ended, or a frame could not be forwarded.
    Ended,
}

/// Forward client frames to the agent until the client ends the relay.
///
/// Split out of [`relay_bidirectional_via_channel`], and generic over both
/// halves, so that the throttle's window is reachable from a test without a
/// socket; production passes the split WebSocket halves unchanged. It returns
/// *why* it stopped, because "the client asked to detach" and "the connection
/// dropped" are different events that both stop the loop — and because a test
/// that only asserted "no frame was lost" could not tell the throttle's drain
/// loop apart from never entering it.
///
/// `input_throttle` is a parameter for the same reason: a test can widen the
/// window past any scheduling stall, so "the drain loop ran" is a property of
/// the test rather than of the machine. Production has one value, in
/// [`INPUT_THROTTLE`].
/// What the relay needs to serve the connection's own Server-scoped units while
/// it holds the read half (#1504).
///
/// Borrowed rather than cloned because these are the connection's dispatcher,
/// its lanes and its reply path — the same objects the ordinary loop uses, so a
/// relay is not a second answer to "who may dispatch on this connection".
struct RelayDispatch<'a> {
    handler: &'a ConnectionHandler,
    lanes: &'a mut Lanes,
    command_broker: &'a CommandBroker,
    sender: &'a WsMessageSender,
}

/// `dispatch` is `None` only in the throttle's unit tests, which drive this
/// pump over frames that carry no Server units — a real relay always has one.
/// A Server unit that arrived without a dispatcher is reported and dropped:
/// forwarding it is the defect this parameter exists to remove (#1504), so the
/// unreachable branch errs on the side of not answering the wrong runtime.
async fn forward_client_to_agent<RS, AS, E>(
    client_read: &mut RS,
    agent_write: &mut AS,
    session_name: &str,
    input_throttle: std::time::Duration,
    agent_probe_interval: std::time::Duration,
    mut dispatch: Option<&mut RelayDispatch<'_>>,
) -> ClientToAgent
where
    RS: futures_util::Stream<Item = Result<WsFrame, E>> + Unpin,
    E: std::fmt::Display,
    AS: futures_util::Sink<WsFrame> + Unpin,
    AS::Error: std::fmt::Display,
{
    use futures_util::StreamExt;

    // 60 s in the past, so the first input of a relay is never throttled: the
    // keystroke that opens a session must not wait out a window.
    let mut last_terminal_input = std::time::Instant::now()
        .checked_sub(std::time::Duration::from_secs(60))
        .unwrap_or_else(std::time::Instant::now);

    // Relay→Agent leg probe (#4065). While the client is idle — no terminal
    // input, no control frame — this ticker fires and we write a WebSocket
    // ping on the Agent leg. The Agent's tungstenite auto-answers with a pong,
    // which surfaces as a frame on `agent_read` and is what keeps the idle
    // deadline in `agent_to_client` from declaring the leg half-open. The
    // interval is [`AGENT_LEG_PROBE_INTERVAL`] in production; tests may pass
    // a shorter interval to exercise the probe behavior without wall-clock
    // delays. Any client frame resets it so we never send a probe right after
    // forwarding real traffic.
    let mut probe_ticker = tokio::time::interval(agent_probe_interval);
    probe_ticker.tick().await; // consume the immediate first tick

    'forward: loop {
        let msg = tokio::select! {
            next = client_read.next() => {
                // A browser Ping/Pong acknowledges only its own WebSocket.
                // It is NOT Agent-leg liveness and must never postpone the
                // independent Agent probe ticker (#4065).
                match next {
                    Some(m) => m,
                    None => break,
                }
            }
            _ = probe_ticker.tick() => {
                // Idle: send a probe ping so the Agent's auto-pong gives the
                // `agent_to_client` side a frame to reset its idle deadline.
                // A failure here is the same terminal condition as any other
                // `agent_write` failure — the writer is gone.
                if let Err(e) = nession_runtime::lifecycle::write_frame(
                    agent_write,
                    WsFrame::Ping(Vec::new()),
                    RELAY_WRITE_DEADLINE,
                )
                .await
                {
                    error!("Failed to send agent-leg probe ping: {}", e);
                    break;
                }
                continue;
            }
        };
        let msg = match msg {
            Ok(m) => m,
            Err(e) => {
                error!("Error reading from client: {}", e);
                break;
            }
        };

        // One classification per frame, before any throttling decision. The
        // drain loop below calls the same function, which is what keeps this
        // frame's meaning from depending on when it was read.
        match classify_client_frame(&msg) {
            ClientFrame::RelayEnd => {
                info!("Client requested relay end for session '{}'", session_name);
                return ClientToAgent::ClientRequested;
            }
            // The connection's own unit, asked while it is attached: answered
            // here, and deliberately **not** written to the agent — that is the
            // whole of #1504.
            ClientFrame::ServerUnit => {
                if let (Some(dispatch), Ok(text)) = (dispatch.as_deref_mut(), msg.to_text()) {
                    answer_server_unit(
                        dispatch.handler,
                        dispatch.lanes,
                        dispatch.command_broker,
                        dispatch.sender,
                        text,
                    )
                    .await;
                }
                continue;
            }
            ClientFrame::Other => {
                // WebSocket control frames terminate at the browser/Server
                // boundary. The Agent has its OWN independent probe channel;
                // forwarding a browser Pong there, or resetting the probe
                // ticker for it, can starve a healthy idle Agent of probes.
                if matches!(&msg, WsFrame::Ping(_) | WsFrame::Pong(_)) {
                    continue;
                }
                // An actual Agent-directed application message can defer the
                // next probe briefly; browser keepalives never can.
                probe_ticker.reset();
                if let Err(e) =
                    nession_runtime::lifecycle::write_frame(agent_write, msg, RELAY_WRITE_DEADLINE)
                        .await
                {
                    error!("Failed to forward client message to agent: {}", e);
                    break;
                }
                continue;
            }
            ClientFrame::TerminalInput => {
                probe_ticker.reset();
            }
        }

        // Terminal input outside the window — forward it now (leading edge).
        // This is the common path and the one that has to stay zero-latency.
        if last_terminal_input.elapsed() >= input_throttle {
            last_terminal_input = std::time::Instant::now();
            if let Err(e) =
                nession_runtime::lifecycle::write_frame(agent_write, msg, RELAY_WRITE_DEADLINE)
                    .await
            {
                error!("Failed to forward client message to agent: {}", e);
                break;
            }
            continue;
        }

        // Inside the window: hold this frame and keep reading until the window
        // closes, so a flood collapses to its newest frame. Everything that
        // arrives in the meantime has to be handled *here* — this loop is the
        // only reader for as long as it runs.
        let drain_deadline = last_terminal_input + input_throttle;
        // Every terminal-input frame the window holds, oldest first. A `Vec`
        // rather than a single `Option` because the window merges a burst
        // instead of keeping its newest — see `merge_terminal_input` (`#966`).
        let mut burst: Vec<WsFrame> = vec![msg];
        let mut end_requested = false;

        loop {
            let remaining = drain_deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match tokio::time::timeout(remaining, client_read.next()).await {
                // Control-lane Pong/Ping are local to the browser socket,
                // including when the terminal-input throttle is draining.
                Ok(Some(Ok(m))) if matches!(&m, WsFrame::Ping(_) | WsFrame::Pong(_)) => continue,
                Ok(Some(Ok(m))) => match classify_client_frame(&m) {
                    // Coalescable: held, and merged with the rest of the burst
                    // rather than replacing it. Replacing dropped the earlier
                    // frames, which is right for a mouse report and wrong for a
                    // paste — and nothing here can tell them apart.
                    ClientFrame::TerminalInput => burst.push(m),
                    // Control, read inside the window. It ends the relay
                    // exactly as the main loop ends it, and is not forwarded.
                    // Without this arm the frame fell through to the
                    // forward-everything case: relay.end became something the
                    // Agent received instead of an instruction the Server
                    // carried out, for any client fast enough to still be in a
                    // window when it asked to stop (#962).
                    ClientFrame::RelayEnd => {
                        end_requested = true;
                        break;
                    }
                    // A Server unit, read inside the window: the same ordering
                    // rule as `Other` — nothing the client wrote earlier may be
                    // overtaken by it — but its destination is the Server.
                    ClientFrame::ServerUnit => {
                        if !flush_burst(agent_write, &mut burst).await {
                            break 'forward;
                        }
                        if let (Some(dispatch), Ok(text)) = (dispatch.as_deref_mut(), m.to_text()) {
                            answer_server_unit(
                                dispatch.handler,
                                dispatch.lanes,
                                dispatch.command_broker,
                                dispatch.sender,
                                text,
                            )
                            .await;
                        }
                        break;
                    }
                    // Not coalescable, and sent *after* the frame being held:
                    // flush the held frame first, so the agent sees frames in
                    // the order the client sent them, then hand this one on and
                    // go back to reading outside the window.
                    ClientFrame::Other => {
                        if !flush_burst(agent_write, &mut burst).await {
                            break 'forward;
                        }
                        if let Err(e) = nession_runtime::lifecycle::write_frame(
                            agent_write,
                            m,
                            RELAY_WRITE_DEADLINE,
                        )
                        .await
                        {
                            error!("Failed to forward client message to agent: {}", e);
                            break 'forward;
                        }
                        break;
                    }
                },
                Ok(Some(Err(e))) => {
                    error!("Error reading from client: {}", e);
                    break;
                }
                Ok(None) | Err(tokio::time::error::Elapsed { .. }) => {
                    break; // stream ended or window closed
                }
            }
        }

        // The trailing edge: whatever the window held. What the client sent
        // before a relay.end still goes out, in order — that control frame
        // holds nothing back. The control frame itself never does.
        if !flush_burst(agent_write, &mut burst).await {
            break;
        }
        if end_requested {
            info!("Client requested relay end for session '{}'", session_name);
            return ClientToAgent::ClientRequested;
        }

        last_terminal_input = std::time::Instant::now();
    }

    ClientToAgent::Ended
}

/// Why the agent → client half of the relay stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentToClient {
    /// The agent's stream ended cleanly.
    Ended,
    /// The agent's stream errored.
    Errored,
    /// The client's outbound queue stalled.
    Stalled,
    /// The agent leg went half-open: no frame within the idle deadline (#4065).
    HalfOpen,
}

/// Relay frames from the agent to the client until the agent's stream ends or
/// the idle timeout fires (#4065).
///
/// Extracted from [`relay_bidirectional_via_channel`] so the half-open
/// detection logic can be tested directly. The agent read stream is wrapped in
/// a bounded timeout: if no frame (terminal payload, pong, close, or error)
/// arrives within `agent_idle_timeout`, the leg is declared half-open and the
/// relay terminates.
///
/// The `agent_idle_timeout` parameter allows tests to use a short timeout
/// (e.g., 100ms) to verify the half-open detection without wall-clock delays.
/// Production passes [`AGENT_LEG_IDLE_TIMEOUT`].
async fn relay_agent_to_client<RS, E>(
    agent_read: &mut RS,
    sender: &crate::server::outbound::WsMessageSender,
    agent_idle_timeout: std::time::Duration,
) -> AgentToClient
where
    RS: futures_util::Stream<Item = Result<WsFrame, E>> + Unpin,
    E: std::fmt::Display,
{
    use futures_util::StreamExt;

    loop {
        // Bounded wait: if no frame — terminal payload, pong, close, or
        // error — arrives within the idle deadline, the leg is half-open.
        // Any frame resets the clock, so a slow but responsive Agent that
        // answers the probe inside the window is never spuriously torn down.
        let next = match tokio::time::timeout(agent_idle_timeout, agent_read.next()).await {
            Ok(next) => next,
            Err(_) => {
                // No frame within the deadline, including no pong for the
                // probe pings `forward_client_to_agent` has been sending.
                // The Agent leg is silent; the relay cannot make progress.
                return AgentToClient::HalfOpen;
            }
        };
        let msg = match next {
            Some(Ok(msg)) => msg,
            Some(Err(e)) => {
                error!("Error reading from agent: {}", e);
                // The Agent's end of the tunnel failed while the client was
                // still attached: the terminal will never produce again,
                // and no frame says so (#2179).
                return AgentToClient::Errored;
            }
            // The Agent's stream ended (its socket closed). That is not the
            // client asking to stop — those paths end `client_to_agent`
            // instead — so the client must learn about it from the close.
            None => {
                return AgentToClient::Ended;
            }
        };
        if is_agent_forged_relay_ready(&msg) {
            warn!("Dropped Agent-forged Relay ready notification after attach");
            continue;
        }
        match sender.send_terminal(msg).await {
            Ok(()) => {}
            Err(crate::server::outbound::OutboundError::Stalled) => {
                return AgentToClient::Stalled;
            }
            // The client's own connection is gone; the caller has nothing
            // left to close.
            Err(e) => {
                error!("Failed to forward agent message to client: {}", e);
                return AgentToClient::Ended;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::Sink;
    use serde_json::json;
    use std::pin::Pin;
    use std::task::{Context, Poll};

    #[test]
    fn relay_client_auth_requires_agent_confirmed_exact_browser_identity() {
        let valid = json!({
            "msg_type": "ok",
            "payload": {"status": "success", "message": "ok", "client_id": "browser-a"}
        });
        assert_eq!(
            validate_relay_client_auth_reply(&valid, "browser-a"),
            Ok(())
        );
        assert_eq!(
            validate_relay_client_auth_reply(&valid, "browser-b"),
            Err("agent_auth_wrong_client")
        );
        assert_eq!(
            validate_relay_client_auth_reply(&valid, ""),
            Err("missing_relay_client_identity")
        );
        assert_eq!(
            validate_relay_client_auth_reply(
                &json!({"msg_type":"error","payload":{"status":"success","client_id":"browser-a"}}),
                "browser-a"
            ),
            Err("unexpected_agent_auth_reply")
        );
        assert_eq!(
            validate_relay_client_auth_reply(&json!({"msg_type":"ok"}), "browser-a"),
            Err("missing_agent_auth_payload")
        );
        for payload in [
            json!({"status":"error","client_id":"browser-a"}),
            json!({"status":"success","client_id":"browser-b"}),
            json!({"status":"success"}),
            json!({"status":"success","client_id":""}),
            json!({"status":"success","client_id":null}),
        ] {
            let reply = json!({"msg_type":"ok","payload":payload});
            assert!(validate_relay_client_auth_reply(&reply, "browser-a").is_err());
        }
    }

    #[test]
    fn relay_ready_receipt_has_only_agent_origin_identity_and_unique_route() {
        let accepted = json!({
            "msg_type": "ok", "payload": {
                "session_name": "sess", "subscriber_generation": 41,
                "stream_epoch": 52
            }
        });
        let a = agent_attached_relay_ready(&accepted, "sess", "browser-a", "begin-123")
            .expect("verified Agent subscription");
        let b = agent_attached_relay_ready(&accepted, "sess", "browser-a", "begin-123")
            .expect("fresh route");
        let a: serde_json::Value = serde_json::from_str(a.to_text().unwrap()).unwrap();
        let b: serde_json::Value = serde_json::from_str(b.to_text().unwrap()).unwrap();
        assert_eq!(a["msg_type"], RELAY_SUBSCRIPTION_READY_WIRE);
        assert_eq!(a["payload"]["relay_request_id"], "begin-123");
        assert_eq!(a["payload"]["browser_client_id"], "browser-a");
        assert_eq!(a["payload"]["session_name"], "sess");
        assert_eq!(a["payload"]["subscriber_generation"], 41);
        assert_eq!(a["payload"]["stream_epoch"], 52);
        assert_ne!(a["payload"]["route_id"], b["payload"]["route_id"]);
        assert!(a["payload"].get("credit_enabled").is_none());
        assert!(a["payload"].get("applied_through").is_none());
        assert_eq!(
            agent_attached_relay_ready(&accepted, "other", "browser-a", "begin-123"),
            None
        );
        assert_eq!(
            agent_attached_relay_ready(&accepted, "sess", "", "begin-123"),
            None
        );
        assert_eq!(
            agent_attached_relay_ready(&accepted, "sess", "browser-a", ""),
            None
        );
    }

    #[test]
    fn relay_ready_carries_the_agents_control_lease_when_stated() {
        let accepted = json!({
            "msg_type": "ok", "payload": {
                "session_name": "sess", "subscriber_generation": 41,
                "stream_epoch": 52, "control_role": "observer",
                "control_generation": 7, "controller_client_id": "browser-b"
            }
        });
        let ready = agent_attached_relay_ready(&accepted, "sess", "browser-b", "begin-123")
            .expect("verified Agent subscription");
        let ready: serde_json::Value = serde_json::from_str(ready.to_text().unwrap()).unwrap();
        assert_eq!(ready["payload"]["control_role"], "observer");
        assert_eq!(ready["payload"]["control_generation"], 7);
        assert_eq!(ready["payload"]["controller_client_id"], "browser-b");

        // Legacy Agent: absent fields stay absent rather than being invented.
        let legacy = json!({
            "msg_type": "ok", "payload": {
                "session_name": "sess", "subscriber_generation": 41, "stream_epoch": 52
            }
        });
        let ready = agent_attached_relay_ready(&legacy, "sess", "browser-b", "begin-123")
            .expect("legacy Agent remains on the non-credit relay lane");
        let ready: serde_json::Value = serde_json::from_str(ready.to_text().unwrap()).unwrap();
        assert!(ready["payload"].get("control_role").is_none());
        assert!(ready["payload"].get("control_generation").is_none());
        assert!(ready["payload"].get("controller_client_id").is_none());

        // A malformed role is not forwarded; the rest of the receipt stands.
        let malformed = json!({
            "msg_type": "ok", "payload": {
                "session_name": "sess", "subscriber_generation": 41,
                "stream_epoch": 52, "control_role": "owner",
                "control_generation": "seven", "controller_client_id": ""
            }
        });
        let ready = agent_attached_relay_ready(&malformed, "sess", "browser-b", "begin-123")
            .expect("verified Agent subscription");
        let ready: serde_json::Value = serde_json::from_str(ready.to_text().unwrap()).unwrap();
        assert!(ready["payload"].get("control_role").is_none());
        assert!(ready["payload"].get("control_generation").is_none());
        assert!(ready["payload"].get("controller_client_id").is_none());
    }

    #[test]
    fn relay_ready_forwards_notification_capabilities_verbatim_and_never_invents_them() {
        let stated = json!({
            "msg_type": "ok", "payload": {
                "session_name": "sess", "subscriber_generation": 41,
                "stream_epoch": 52,
                "terminal_capabilities": ["terminal-progress-notifications-v1"]
            }
        });
        let ready = agent_attached_relay_ready(&stated, "sess", "browser-a", "begin-123")
            .expect("verified Agent subscription");
        let ready: serde_json::Value = serde_json::from_str(ready.to_text().unwrap()).unwrap();
        assert_eq!(
            ready["payload"]["terminal_capabilities"],
            json!(["terminal-progress-notifications-v1"]),
            "the Server forwards the Agent's list unchanged"
        );

        // An older Agent states nothing; the receipt must not invent support.
        let legacy = json!({
            "msg_type": "ok", "payload": {
                "session_name": "sess", "subscriber_generation": 41, "stream_epoch": 52
            }
        });
        let ready = agent_attached_relay_ready(&legacy, "sess", "browser-a", "begin-123")
            .expect("legacy Agent remains attachable");
        let ready: serde_json::Value = serde_json::from_str(ready.to_text().unwrap()).unwrap();
        assert!(ready["payload"].get("terminal_capabilities").is_none());

        // A malformed value is not reinterpreted as a capability list.
        let malformed = json!({
            "msg_type": "ok", "payload": {
                "session_name": "sess", "subscriber_generation": 41, "stream_epoch": 52,
                "terminal_capabilities": "terminal-progress-notifications-v1"
            }
        });
        let ready = agent_attached_relay_ready(&malformed, "sess", "browser-a", "begin-123")
            .expect("the rest of the receipt stands");
        let ready: serde_json::Value = serde_json::from_str(ready.to_text().unwrap()).unwrap();
        assert!(ready["payload"].get("terminal_capabilities").is_none());
    }

    #[test]
    fn relay_ready_is_never_minted_from_legacy_partial_or_forged_agent_frames() {
        for reply in [
            json!({"msg_type":"ok","payload":{"session_name":"sess"}}),
            json!({"msg_type":"ok","payload":{"session_name":"sess","stream_epoch":17}}),
            json!({"msg_type":"ok","payload":{"session_name":"sess","subscriber_generation":8}}),
            json!({"msg_type":"ok","payload":{"session_name":"sess","subscriber_generation":0,"stream_epoch":8}}),
            json!({"msg_type":"ok","payload":{"session_name":"sess","subscriber_generation":8,"stream_epoch":9007199254740992u64}}),
            json!({"msg_type":"error","payload":{"session_name":"sess","subscriber_generation":8,"stream_epoch":9}}),
        ] {
            assert!(agent_attached_relay_ready(&reply, "sess", "browser-a", "begin-123").is_none());
        }
        let spoof = WsFrame::Text(
            json!({"msg_type":"server.session.relay.ready", "payload":{"route_id":"forged"}})
                .to_string(),
        );
        assert!(is_agent_forged_relay_ready(&spoof));
        assert!(!is_agent_forged_relay_ready(&WsFrame::Text(
            json!({"msg_type":"agent.terminal.output","data":"ordinary"}).to_string(),
        )));
    }

    #[test]
    fn relay_attach_reply_requires_exact_success_and_session() {
        let success = json!({
            "msg_type": "ok",
            "payload": {
                "session_name": "sess",
                "subscriber_generation": 14,
                "stream_epoch": 25
            }
        });
        assert_eq!(validate_relay_attach_reply(&success, "sess"), Ok(true));
        assert_eq!(
            validate_relay_attach_reply(&success, "other-session"),
            Err("agent_attach_wrong_session")
        );
        assert_eq!(
            validate_relay_attach_reply(
                &json!({"msg_type":"unexpected","payload":{"session_name":"sess"}}),
                "sess"
            ),
            Err("unexpected_agent_attach_reply")
        );
        assert_eq!(
            validate_relay_attach_reply(&json!({"msg_type":"ok"}), "sess"),
            Err("missing_agent_attach_payload")
        );
    }

    #[test]
    fn relay_subscription_proof_is_never_minted_from_legacy_or_invalid_pair() {
        let legacy = json!({"msg_type":"ok", "payload":{"session_name":"sess"}});
        let partial = json!({
            "msg_type":"ok", "payload":{"session_name":"sess","stream_epoch":5}
        });
        assert_eq!(validate_relay_attach_reply(&legacy, "sess"), Ok(false));
        assert_eq!(validate_relay_attach_reply(&partial, "sess"), Ok(false));
        for pair in [
            json!({"subscriber_generation":0,"stream_epoch":1}),
            json!({"subscriber_generation":1,"stream_epoch":0}),
            json!({"subscriber_generation":-1,"stream_epoch":1}),
            json!({"subscriber_generation":1,"stream_epoch":9_007_199_254_740_992_u64}),
            json!({"subscriber_generation":"1","stream_epoch":1}),
        ] {
            let mut frame = json!({"msg_type":"ok","payload":{"session_name":"sess"}});
            if let Some(obj) = frame["payload"].as_object_mut() {
                obj.extend(pair.as_object().cloned().unwrap_or_default());
            }
            assert_eq!(
                validate_relay_attach_reply(&frame, "sess"),
                Err("invalid_agent_attach_subscription_identity")
            );
        }
    }

    /// A window no scheduling stall can cross.
    ///
    /// The real window is 16 ms and these frames are already in memory, so the
    /// tests below would *usually* be inside it — and "usually" is how a test
    /// like this passes without ever running the branch it is about. Widening
    /// the window cannot change any answer here, and it makes "the drain loop
    /// ran" a property of the test. Every test that needs it also pins the same
    /// fact down from the other side, by asserting the coalescing only the
    /// drain loop can produce.
    const WIDE_WINDOW: std::time::Duration = std::time::Duration::from_secs(5);

    /// Records what the relay forwarded, in order.
    #[derive(Default)]
    struct RecordingSink {
        sent: Vec<WsFrame>,
    }

    impl Sink<WsFrame> for RecordingSink {
        type Error = std::convert::Infallible;

        fn poll_ready(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn start_send(self: Pin<&mut Self>, item: WsFrame) -> Result<(), Self::Error> {
            self.get_mut().sent.push(item);
            Ok(())
        }

        fn poll_flush(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(())) // nothing is buffered, so there is nothing to flush
        }

        fn poll_close(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    /// A frame as a client sends one.
    fn frame_with_payload(msg_type: &str, id: &str, payload: serde_json::Value) -> WsFrame {
        WsFrame::Text(
            json!({
                "msg_type": msg_type,
                "id": id,
                "timestamp": 0,
                "payload": payload,
            })
            .to_string(),
        )
    }

    fn frame(msg_type: &str, id: &str) -> WsFrame {
        frame_with_payload(msg_type, id, json!({ "session_name": "sess" }))
    }

    /// A terminal-input frame whose bytes are its own `id`, base64-encoded.
    ///
    /// The bytes matter since `#966`: a burst is *merged* rather than reduced to
    /// its newest frame, so a test that wants to show the window was open has to
    /// say what the agent received — and `frame_data` reads it back. Deriving the
    /// bytes from the id is what makes the order visible.
    fn terminal_input(id: &str) -> WsFrame {
        use base64::Engine as _;
        frame_with_payload(
            TERMINAL_INPUT_WIRE,
            id,
            json!({
                "session_name": "sess",
                "data": base64::engine::general_purpose::STANDARD.encode(id.as_bytes()),
            }),
        )
    }

    /// A terminal-input frame that states a position, as a sequenced sender
    /// sends one (#1307).
    ///
    /// One chunk per frame, which is what `flushInputBuffer` sends: the range
    /// exists in the contract because a frame may cover several chunks, and a
    /// burst is where several frames become one.
    fn sequenced_terminal_input(bytes: &str, epoch: u64, seq: u64) -> WsFrame {
        use base64::Engine as _;
        frame_with_payload(
            TERMINAL_INPUT_WIRE,
            bytes,
            json!({
                "session_name": "sess",
                "data": base64::engine::general_purpose::STANDARD.encode(bytes.as_bytes()),
                "input_epoch": epoch,
                "seq_start": seq,
                "seq_end": seq,
            }),
        )
    }

    /// The three sequence fields of a frame, as the agent reads them.
    ///
    /// `None` for an unsequenced frame, which is not the same answer as zero —
    /// the whole contract keeps those apart.
    fn frame_sequence(msg: &WsFrame) -> (Option<u64>, Option<u64>, Option<u64>) {
        let envelope: serde_json::Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
        let payload = &envelope["payload"];
        (
            payload["input_epoch"].as_u64(),
            payload["seq_start"].as_u64(),
            payload["seq_end"].as_u64(),
        )
    }

    /// The bytes a terminal-input frame carries, decoded.
    fn frame_data(msg: &WsFrame) -> String {
        use base64::Engine as _;
        let envelope: serde_json::Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
        let data = envelope["payload"]["data"].as_str().unwrap();
        String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(data)
                .unwrap(),
        )
        .unwrap()
    }

    fn relay_end(id: &str) -> WsFrame {
        frame(RELAY_END_WIRE, id)
    }

    /// Drive the pump over frames that are already in memory and report what
    /// reached the agent, and why the loop stopped.
    async fn drive(frames: Vec<WsFrame>) -> (Vec<WsFrame>, ClientToAgent) {
        let items: Vec<Result<WsFrame, std::io::Error>> = frames.into_iter().map(Ok).collect();
        let mut client_read = futures_util::stream::iter(items);
        let mut agent_write = RecordingSink::default();

        // Use a very long probe interval so existing tests (which complete
        // quickly) never see a probe ping fire.
        let outcome = forward_client_to_agent(
            &mut client_read,
            &mut agent_write,
            "sess",
            WIDE_WINDOW,
            std::time::Duration::from_secs(3600),
            None,
        )
        .await;

        (agent_write.sent, outcome)
    }

    /// #2877: the response-less progress notification is an ordinary forwarded
    /// wire, not a Server-served unit and not a coalescable input burst.
    ///
    /// The Agent is the only party that may authenticate or credit it; the
    /// Relay must hand it over unchanged, in arrival order, with no synthetic
    /// reply. A classifier that routed `client.*` as a Server unit, or an
    /// input-throttle arm that swallowed it, fails here.
    #[tokio::test]
    async fn a_progress_notification_is_forwarded_unchanged_to_the_agent() {
        let payload = json!({
            "session_name": "sess",
            "subscriber_generation": 41,
            "stream_epoch": 7,
            "renderer_generation": 3,
            "applied_through": 12,
        });
        let (sent, outcome) = drive(vec![frame_with_payload(
            "client.terminal.output.progress",
            "progress-1",
            payload.clone(),
        )])
        .await;

        assert_eq!(
            sent.len(),
            1,
            "the notification reaches the Agent: {sent:?}"
        );
        let forwarded: serde_json::Value =
            serde_json::from_str(sent[0].to_text().unwrap()).unwrap();
        assert_eq!(forwarded["msg_type"], "client.terminal.output.progress");
        assert_eq!(forwarded["id"], "progress-1");
        assert_eq!(forwarded["payload"], payload);
        assert!(matches!(outcome, ClientToAgent::Ended));
    }

    /// #962: a relay end that arrives inside the throttle window ends the relay
    /// rather than being forwarded to the agent.
    ///
    /// A burst the window cannot merge goes out frame by frame — never dropped.
    ///
    /// A terminal-input frame with no readable `data` is not something the merge
    /// can fold in, and the honest answer is to forward the whole burst in order
    /// rather than pick a frame to keep. This is the path that used to lose the
    /// earlier frames silently (`#966`); it now gives up only the frame-count
    /// saving, which is the trade the fix is willing to make and the old
    /// behaviour was not.
    #[tokio::test]
    async fn a_burst_that_cannot_be_merged_is_forwarded_whole() {
        let (sent, _) = drive(vec![
            frame(TERMINAL_INPUT_WIRE, "in-1"),
            frame(TERMINAL_INPUT_WIRE, "in-2"),
            frame(TERMINAL_INPUT_WIRE, "in-3"),
        ])
        .await;

        assert_eq!(
            sent.len(),
            3,
            "three unmergeable frames arrive as three, not as one kept and two lost: {sent:?}"
        );
    }

    /// #1307 SC-05: a merged burst states the range it covers.
    ///
    /// The envelope a merge keeps is the **newest** frame's, so before this the
    /// merged frame carried every byte of `2..=4` while stating `4..=4`. That is
    /// not a cosmetic lie: the Agent advances its applied cursor to whatever a
    /// frame claims and refuses a frame that does not continue it, so the
    /// over-tight range is input that never lands.
    ///
    /// The mutation is the range-rewriting block being absent — which is exactly
    /// the tree before this change — and the failure is on `seq_start`, which
    /// would read `4` instead of `2`.
    #[tokio::test]
    async fn a_merged_burst_states_the_range_it_covers() {
        let (sent, _) = drive(vec![
            // Forwarded on the leading edge; the other three open and join the
            // window.
            sequenced_terminal_input("a", 7, 1),
            sequenced_terminal_input("b", 7, 2),
            sequenced_terminal_input("c", 7, 3),
            sequenced_terminal_input("d", 7, 4),
        ])
        .await;

        assert_eq!(sent.len(), 2, "the held burst is one frame: {sent:?}");
        assert_eq!(frame_data(&sent[0]), "a");
        assert_eq!(
            frame_sequence(&sent[0]),
            (Some(7), Some(1), Some(1)),
            "a lone frame keeps its own position"
        );
        assert_eq!(
            frame_data(&sent[1]),
            "bcd",
            "every byte of the burst survives the merge"
        );
        assert_eq!(
            frame_sequence(&sent[1]),
            (Some(7), Some(2), Some(4)),
            "the merged frame states the first frame's start through the last \
             frame's end, not the newest frame's own range"
        );
    }

    /// #1307 SC-05: an unsequenced burst still merges, and still states nothing.
    ///
    /// The other half of deriving a range rather than inventing one: input from
    /// a sender that has no position — a client built before the contract, or an
    /// agent that stated no epoch — must not acquire one by being merged. This
    /// pins *this* change rather than the behaviour before it (unsequenced
    /// bursts merged then too): a `merged_range` that answered `Unmergeable` for
    /// the all-unsequenced case, or a range written unconditionally, fails here.
    #[tokio::test]
    async fn an_unsequenced_burst_merges_and_states_no_position() {
        let (sent, _) = drive(vec![
            terminal_input("a"),
            terminal_input("b"),
            terminal_input("c"),
        ])
        .await;

        assert_eq!(sent.len(), 2, "the held burst is still one frame: {sent:?}");
        assert_eq!(frame_data(&sent[1]), "bc");
        assert_eq!(
            frame_sequence(&sent[1]),
            (None, None, None),
            "an unsequenced burst must not be given a position by the merge"
        );
    }

    /// #1307 SC-05: a burst that mixes sequenced and unsequenced frames has no
    /// single range, so it is forwarded frame by frame.
    ///
    /// Both orders, because they fail differently. Unsequenced-then-sequenced
    /// invents a position for bytes that never had one — the merged frame would
    /// claim the sequenced frame's chunk while carrying the unsequenced frame's
    /// bytes, and the Agent would mark a chunk applied that the burst did not
    /// carry. Sequenced-then-unsequenced loses the position instead. Either way
    /// the honest answer is the same: no merge.
    #[tokio::test]
    async fn a_burst_that_mixes_sequenced_and_unsequenced_is_forwarded_whole() {
        // Sequenced first, then a sender that states nothing.
        let (sent, _) = drive(vec![
            sequenced_terminal_input("a", 7, 1),
            sequenced_terminal_input("b", 7, 2),
            terminal_input("c"),
        ])
        .await;
        assert_eq!(sent.len(), 3, "mixed burst arrives whole: {sent:?}");
        assert_eq!(frame_sequence(&sent[1]), (Some(7), Some(2), Some(2)));
        assert_eq!(
            frame_sequence(&sent[2]),
            (None, None, None),
            "the unsequenced frame keeps stating nothing"
        );

        // And the other way round: the unsequenced frames are held first.
        // Four frames rather than three, because the first of any burst is
        // forwarded on the leading edge and never joins it — a three-frame
        // drive would leave the unsequenced frame outside the window and the
        // burst all-sequenced, which is a different test that already passes.
        let (sent, _) = drive(vec![
            terminal_input("z"),
            terminal_input("a"),
            sequenced_terminal_input("b", 7, 2),
            sequenced_terminal_input("c", 7, 3),
        ])
        .await;
        assert_eq!(sent.len(), 4, "mixed burst arrives whole: {sent:?}");
        assert_eq!(
            frame_sequence(&sent[1]),
            (None, None, None),
            "the unsequenced frame states nothing"
        );
        assert_eq!(
            frame_sequence(&sent[2]),
            (Some(7), Some(2), Some(2)),
            "the sequenced frame keeps its own range rather than acquiring one \
             that covers the unsequenced bytes beside it"
        );
        assert_eq!(frame_sequence(&sent[3]), (Some(7), Some(3), Some(3)));
    }

    /// #1307 SC-05: frames that disagree on `input_epoch` have no range at all.
    ///
    /// Their numbers count in different runs, so any merged range would have to
    /// pick one epoch's numbering and attribute the other's bytes to it. Both
    /// epochs are live — a client that reconnected mid-burst is exactly this
    /// shape — so there is no "older one" to drop either.
    #[tokio::test]
    async fn frames_that_disagree_on_epoch_are_forwarded_whole() {
        let (sent, _) = drive(vec![
            sequenced_terminal_input("a", 7, 1),
            sequenced_terminal_input("b", 7, 2),
            sequenced_terminal_input("c", 8, 3),
        ])
        .await;

        assert_eq!(sent.len(), 3, "no merge across epochs: {sent:?}");
        assert_eq!(frame_sequence(&sent[1]), (Some(7), Some(2), Some(2)));
        assert_eq!(frame_sequence(&sent[2]), (Some(8), Some(3), Some(3)));
    }

    /// #1307 SC-05: a burst with a hole in it is not one run, so it is not
    /// merged into one range.
    ///
    /// This is the case where a merge does not merely fail to help — it loses
    /// input permanently and silently. A merged frame stating `2..=4` while
    /// carrying chunks 2 and 4 makes the Agent advance its applied cursor to 4,
    /// and the frame that later brings chunk 3 is refused as a duplicate. The
    /// user's bytes are gone and nothing anywhere reports it.
    #[tokio::test]
    async fn a_burst_with_a_hole_is_forwarded_whole() {
        let (sent, _) = drive(vec![
            sequenced_terminal_input("a", 7, 1),
            sequenced_terminal_input("b", 7, 2),
            sequenced_terminal_input("d", 7, 4),
        ])
        .await;

        assert_eq!(
            sent.len(),
            3,
            "a burst whose chunks do not meet cannot state a range covering \
             them: {sent:?}"
        );
        assert_eq!(frame_sequence(&sent[1]), (Some(7), Some(2), Some(2)));
        assert_eq!(
            frame_sequence(&sent[2]),
            (Some(7), Some(4), Some(4)),
            "chunk 4 is not folded into a range that would claim chunk 3 arrived"
        );
    }

    /// The three inputs are what put the control frame inside the window: the
    /// first is a leading-edge forward, the second opens the window, the third
    /// joins it. That the held pair arrives as **one** frame is what proves the
    /// window was open when `relay.end` was read — assert on the *set* alone and
    /// this test would also pass on a machine that never entered the drain loop.
    ///
    /// `#966` changed what being inside the window looks like: the burst used to
    /// collapse to its newest frame, and it now carries every byte. The witness
    /// moved from "`in-2` never reached the agent" to "`in-2` and `in-3` arrived
    /// folded together", which is the same fact about the drain loop.
    #[tokio::test]
    async fn relay_end_inside_the_drain_window_ends_the_relay() {
        let first = terminal_input("in-1");
        let held = terminal_input("in-2");
        let also_held = terminal_input("in-3");
        let end = relay_end("end-1");

        let (sent, outcome) = drive(vec![first.clone(), held, also_held, end.clone()]).await;

        assert!(
            !sent.contains(&end),
            "relay.end must not reach the agent, but was forwarded: {sent:?}"
        );
        assert_eq!(
            sent.len(),
            2,
            "the burst is one merged frame, not one per input and not one kept: {sent:?}"
        );
        assert_eq!(sent[0], first);
        assert_eq!(
            frame_data(&sent[1]),
            "in-2in-3",
            "every byte of the burst, in the order the client sent it"
        );
        assert_eq!(outcome, ClientToAgent::ClientRequested);
    }

    /// #962: a frame read during the window is neither lost nor jumped over
    /// the input that was already being held.
    ///
    /// The resize is the frame that matters: it arrives after `in-3` and must
    /// reach the agent after it. A PTY resized before it receives the bytes
    /// that were written for the old size is a different session, and the old
    /// drain loop forwarded the interrupting frame first and the held input
    /// second.
    ///
    /// The held pair arriving merged (`#966`) is the witness that the window was
    /// open — the previous one was that `in-2` was dropped.
    #[tokio::test]
    async fn a_frame_read_inside_the_window_keeps_its_place_in_the_order() {
        let first = terminal_input("in-1");
        let held = terminal_input("in-2");
        let also_held = terminal_input("in-3");
        // The browser relays this one too: `agent.terminal.resize`, sent by the
        // Server and answered by the Agent.
        let resize = frame("agent.terminal.resize", "resize-1");

        let (sent, outcome) = drive(vec![first.clone(), held, also_held, resize.clone()]).await;

        assert_eq!(sent.len(), 3, "{sent:?}");
        assert_eq!(sent[0], first);
        assert_eq!(
            frame_data(&sent[1]),
            "in-2in-3",
            "the held input goes first, merged"
        );
        assert_eq!(sent[2], resize, "and the frame that interrupted it follows");
        assert_eq!(outcome, ClientToAgent::Ended);
    }

    /// The same control frame read *outside* the window, which the main loop
    /// always handled. It is here because the pump was restructured around it.
    #[tokio::test]
    async fn relay_end_outside_the_window_ends_the_relay() {
        let first = terminal_input("in-1");
        let end = relay_end("end-1");

        let (sent, outcome) = drive(vec![first.clone(), end]).await;

        assert_eq!(sent, vec![first], "the input was forwarded");
        assert_eq!(outcome, ClientToAgent::ClientRequested);
    }

    /// #962: a payload that *mentions* the relay's control wire is not the
    /// control wire.
    ///
    /// The substring half of the bug, and not a hypothetical one for
    /// `relay.end`: the old check read the frame's text, so any frame carrying
    /// that string anywhere — a capture preview of a screen showing it, a
    /// command line quoting it — ended the user's relay and was dropped.
    #[tokio::test]
    async fn a_payload_mentioning_relay_end_is_forwarded_not_obeyed() {
        // Carried on a wire the relay forwards, because that is where the
        // substring defence has to hold: the claim is about the *payload* not
        // deciding anything. (`server.info` would be a Server unit now and is
        // dispatched rather than forwarded — see #1504.)
        let innocent = frame_with_payload(
            "agent.terminal.resize",
            "info-1",
            json!({ "note": RELAY_END_WIRE }),
        );

        // The frame has to carry the literal text for this test to mean
        // anything. serde escapes the quotes, so assert on the wire form the
        // old check actually read.
        let text = innocent.to_text().unwrap_or_default().to_string();
        assert!(
            text.contains("\"server.session.relay.end\""),
            "the payload must contain the literal this test is about: {text}"
        );

        let (sent, outcome) = drive(vec![innocent.clone()]).await;

        assert_eq!(sent, vec![innocent], "forwarded unchanged");
        assert_eq!(
            outcome,
            ClientToAgent::Ended,
            "the stream ended the relay, not the frame's text"
        );
    }

    /// The other half of the same defence: a frame whose payload carries the
    /// text `terminal.input` must not be coalesced.
    ///
    /// The payload is the bare name, not the wire, because that is the string
    /// the substring check searched for — a payload quoting it was read as
    /// terminal data, and three of those inside one window lost the middle one.
    /// Silent data loss on frames that have nothing to do with a terminal.
    #[tokio::test]
    async fn a_payload_mentioning_terminal_input_is_not_coalesced() {
        // Same carrier choice as the relay.end case above: a wire the relay
        // forwards, so what is under test is the payload's irrelevance.
        let each = |id: &str| {
            frame_with_payload(
                "agent.terminal.resize",
                id,
                json!({ "note": "terminal.input" }),
            )
        };
        let (a, b, c) = (each("info-1"), each("info-2"), each("info-3"));

        let text = a.to_text().unwrap_or_default().to_string();
        assert!(
            text.contains("\"terminal.input\""),
            "the payload must contain the literal the old check read: {text}"
        );

        let (sent, outcome) = drive(vec![a.clone(), b.clone(), c.clone()]).await;

        assert_eq!(
            sent,
            vec![a, b, c],
            "every frame is forwarded, and none is treated as coalescable"
        );
        assert_eq!(outcome, ClientToAgent::Ended);
    }

    /// The classification itself: identity comes from `msg_type`, and nothing
    /// else about a frame can change it.
    #[test]
    fn classification_reads_msg_type_and_nothing_else() {
        assert_eq!(
            classify_client_frame(&terminal_input("x")),
            ClientFrame::TerminalInput
        );
        assert_eq!(
            classify_client_frame(&relay_end("x")),
            ClientFrame::RelayEnd
        );

        // Payload text is data. The two literals are the strings the substring
        // check searched for, quoted bare — a payload carrying either used to
        // be routed as that protocol.
        for literal in ["terminal.input", RELAY_END_WIRE] {
            assert_eq!(
                classify_client_frame(&frame_with_payload(
                    "agent.terminal.resize",
                    "x",
                    json!({ "note": literal })
                )),
                ClientFrame::Other,
                "a payload quoting {literal} is not {literal}"
            );
        }

        // And the wire's first segment decides *whose* unit it is: the protocol
        // names the answering runtime there, so this is the rule the relay
        // splits on rather than a list it keeps (#1504). A payload cannot move
        // a frame into or out of that class.
        for payload in [json!({}), json!({ "note": "terminal.input" })] {
            assert_eq!(
                classify_client_frame(&frame_with_payload("server.info", "x", payload)),
                ClientFrame::ServerUnit,
                "a `server.` wire is the Server's unit whatever it carries"
            );
        }
        assert_eq!(
            classify_client_frame(&frame_with_payload("agent.terminal.resize", "x", json!({}))),
            ClientFrame::Other,
            "an agent wire still belongs to the agent"
        );

        // The pre-rename spelling of terminal input is not terminal input. The
        // wire is the one the Agent answers, and accepting a second spelling
        // would be the substring fix in a smaller suit — while a frame this
        // relay does not recognise is forwarded, which is what the tree does
        // with every unrecognised wire.
        assert_eq!(
            classify_client_frame(&frame("terminal.input", "x")),
            ClientFrame::Other
        );

        // Not text, not JSON, not a string `msg_type`: all `Other`, never a
        // guess.
        assert_eq!(
            classify_client_frame(&WsFrame::Binary(vec![1, 2, 3])),
            ClientFrame::Other
        );
        assert_eq!(
            classify_client_frame(&WsFrame::Text("{ not json".to_string())),
            ClientFrame::Other
        );
        assert_eq!(
            classify_client_frame(&WsFrame::Text("{}".to_string())),
            ClientFrame::Other
        );
        assert_eq!(
            classify_client_frame(&WsFrame::Text(r#"{"msg_type":7}"#.to_string())),
            ClientFrame::Other
        );
    }

    #[test]
    fn relay_diagnostics_never_include_the_scoped_credential() {
        let endpoint = "wss://user:pass@agent.example.com:19091/ws?token=scoped-secret";
        let safe = sanitized_endpoint(endpoint);
        assert_eq!(safe, "wss://agent.example.com:19091/ws");
        assert!(!safe.contains("scoped-secret"));
        assert!(!safe.contains("user"));

        assert_eq!(
            sanitized_endpoint("ws://agent.example.com/ws"),
            "ws://agent.example.com/ws"
        );
        assert_eq!(sanitized_endpoint("not a url"), "invalid-endpoint");
    }

    #[test]
    fn relay_failure_reason_is_a_bounded_category() {
        use tokio_tungstenite::tungstenite::Error as Ws;
        assert_eq!(
            relay_failure_reason(&Ws::ConnectionClosed),
            "connection-closed"
        );
        assert_eq!(relay_failure_reason(&Ws::AttackAttempt), "attack-attempt");
        assert_eq!(
            relay_failure_reason(&Ws::Io(std::io::Error::other("boom"))),
            "io"
        );
    }

    /// A Server that cannot build its TLS acceptor must not announce readiness.
    ///
    /// This is the whole reason the announcement sits after the TLS acceptor
    /// rather than at the bind: the listener binds perfectly well with a
    /// certificate that cannot be read, so announcing in [`WebSocketServer::new`]
    /// would report a Server that is about to exit as a successful start — the
    /// defect #1016 removes. Moving the call earlier makes this test fail.
    #[tokio::test]
    async fn an_unreadable_certificate_fails_the_start_without_announcing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let marker = dir.path().join("ready");
        let missing = dir.path().join("missing");
        let config = nession_common::config::ServerConfig {
            // OS-assigned: two runs of this suite must not contend for a port.
            listen_address: "127.0.0.1:0".to_string(),
            db_path: dir.path().join("server.db").to_string_lossy().into_owned(),
            tls_cert_path: missing.with_extension("pem").to_string_lossy().into_owned(),
            tls_key_path: missing.with_extension("key").to_string_lossy().into_owned(),
            ..Default::default()
        };
        let db = Database::new(&config.db_path).await.expect("database");
        let mut server = WebSocketServer::new(config, Arc::new(db))
            .await
            .expect("the listener binds before the certificate is ever read");
        assert!(
            server.local_addr().is_ok(),
            "a bound listener is exactly what makes an early announcement wrong"
        );

        let result = server.run(Readiness::Announced(marker.clone())).await;

        assert!(
            result.is_err(),
            "an unreadable certificate must fail the start, not serve"
        );
        assert!(
            !marker.exists(),
            "a Server that never served must not announce that it did"
        );
    }

    /// #4066 SC-01: the bind owner refuses an unauthenticated remote listener
    /// before any socket binds, so a caller that constructs the listener
    /// directly cannot bypass the startup entrypoint's validation.
    #[tokio::test]
    async fn a_remote_blank_token_listener_is_refused_before_it_binds() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = nession_common::config::ServerConfig {
            listen_address: "0.0.0.0:0".to_string(),
            db_path: dir.path().join("server.db").to_string_lossy().into_owned(),
            ..Default::default()
        };
        let db = Database::new(&config.db_path).await.expect("database");
        let error = match WebSocketServer::new(config, Arc::new(db)).await {
            Ok(_) => panic!("a remote blank-token listener must fail closed"),
            Err(error) => error,
        };
        assert!(
            error.to_string().contains("allow_insecure_remote"),
            "{error}"
        );
    }

    /// SC-01/SC-03 regression: the idle timeout is strictly greater than the probe
    /// interval, so a healthy Agent that responds to probes is never spuriously
    /// disconnected (#4065).
    ///
    /// The probe interval determines how often we ping during idle periods; the
    /// idle timeout determines how long we wait for any frame (including a pong)
    /// before declaring the leg half-open. If the timeout were <= the interval,
    /// a healthy Agent that takes even a moment to respond would be killed.
    ///
    /// This test pins down the invariant that the timeout is at least 2× the
    /// interval, providing substantial margin for slow but responsive Agents.
    /// The actual probe behavior (sending pings during idle, resetting on activity)
    /// is exercised by integration tests that run a full Server+Agent relay with
    /// controlled network conditions.
    #[test]
    fn idle_timeout_exceeds_probe_interval_by_sufficient_margin() {
        let ratio = AGENT_LEG_IDLE_TIMEOUT.as_secs_f64() / AGENT_LEG_PROBE_INTERVAL.as_secs_f64();
        assert!(
            ratio >= 2.0,
            "AGENT_LEG_IDLE_TIMEOUT ({AGENT_LEG_IDLE_TIMEOUT:?}) must be at least 2× AGENT_LEG_PROBE_INTERVAL ({AGENT_LEG_PROBE_INTERVAL:?}) \
             to avoid spuriously disconnecting slow but responsive Agents; got ratio {ratio:.2}"
        );
    }

    /// SC-01 regression: the probe interval is short enough that a half-open
    /// Agent leg is detected within a documented finite bound (#4065).
    ///
    /// The idle timeout is the maximum time the relay will wait without any
    /// frame before declaring the leg half-open. This must be short enough to
    /// provide timely detection but long enough to avoid spurious disconnects.
    /// The documented bound is 45s (3× the 15s probe interval), which balances
    /// detection latency against false positives.
    ///
    /// This test pins down the absolute bound so a future change that
    /// accidentally widens the timeout beyond a reasonable threshold is caught.
    #[test]
    fn idle_timeout_is_bounded_to_documented_threshold() {
        let max_acceptable = std::time::Duration::from_secs(60);
        assert!(
            AGENT_LEG_IDLE_TIMEOUT <= max_acceptable,
            "AGENT_LEG_IDLE_TIMEOUT ({AGENT_LEG_IDLE_TIMEOUT:?}) must not exceed {max_acceptable:?}; a wider bound \
             delays half-open detection beyond the documented 45s threshold"
        );
    }

    /// SC-01 regression: the probe interval is short enough to detect a
    /// half-open leg within the idle timeout (#4065).
    ///
    /// The probe interval determines how often we send a ping during idle
    /// periods. It must be short enough that at least one probe is sent before
    /// the idle timeout fires, giving the Agent a chance to respond with a pong.
    /// If the interval were >= the timeout, no probe would be sent before the
    /// relay gave up, defeating the purpose of the probe mechanism.
    #[test]
    fn probe_interval_is_shorter_than_idle_timeout() {
        assert!(
            AGENT_LEG_PROBE_INTERVAL < AGENT_LEG_IDLE_TIMEOUT,
            "AGENT_LEG_PROBE_INTERVAL ({AGENT_LEG_PROBE_INTERVAL:?}) must be strictly less than \
             AGENT_LEG_IDLE_TIMEOUT ({AGENT_LEG_IDLE_TIMEOUT:?}) so at least one probe is sent before \
             the idle deadline fires"
        );
    }

    /// SC-01 behavioral regression: a probe ping is sent during an idle period
    /// (#4065).
    ///
    /// When the client sends no frames for longer than the probe interval, the
    /// relay must write a WebSocket ping on the Agent leg. This test uses a
    /// short probe interval (100ms) to verify the behavior without wall-clock
    /// delays. A pending stream (never yields) simulates an idle client; after
    /// 150ms, at least one probe ping should have been sent.
    #[tokio::test]
    async fn idle_client_triggers_probe_ping_within_interval() {
        let mut client_read = futures_util::stream::pending::<Result<WsFrame, std::io::Error>>();
        let mut agent_write = RecordingSink::default();
        let probe_interval = std::time::Duration::from_millis(100);

        let relay = async {
            forward_client_to_agent(
                &mut client_read,
                &mut agent_write,
                "sess",
                WIDE_WINDOW,
                probe_interval,
                None,
            )
            .await
        };

        // Race the relay against a 150ms timeout. The relay should send at
        // least one probe ping before the timeout fires.
        let result = tokio::time::timeout(std::time::Duration::from_millis(150), relay).await;

        // The relay should not have completed (the stream is pending).
        assert!(
            result.is_err(),
            "the relay should still be running (pending stream), but it completed: {result:?}"
        );

        // At least one probe ping should have been sent.
        let ping_count = agent_write
            .sent
            .iter()
            .filter(|f| matches!(f, WsFrame::Ping(_)))
            .count();
        assert!(
            ping_count >= 1,
            "expected at least one probe ping after 150ms with a 100ms interval, got {ping_count}; \
             sent frames: {:?}",
            agent_write.sent
        );
    }

    /// #4065 regression: the browser leg's own keepalive Pong is not proof
    /// of an Agent response. Without this test a frequent browser Pong can
    /// keep resetting the 15s Agent Ping interval forever, while the idle
    /// Agent reads no probe and is falsely retired at 45s.
    #[tokio::test]
    async fn browser_pong_does_not_starve_independent_agent_probe() {
        let source = futures_util::stream::unfold((), |_| async {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            Some((Ok::<WsFrame, std::io::Error>(WsFrame::Pong(Vec::new())), ()))
        });
        let mut client_read = Box::pin(source);
        let mut agent_write = RecordingSink::default();
        let outcome = tokio::time::timeout(
            std::time::Duration::from_millis(280),
            forward_client_to_agent(
                &mut client_read,
                &mut agent_write,
                "sess",
                WIDE_WINDOW,
                std::time::Duration::from_millis(100),
                None,
            ),
        )
        .await;
        assert!(outcome.is_err(), "browser Pong must not end the Relay");
        let probes = agent_write
            .sent
            .iter()
            .filter(|frame| matches!(frame, WsFrame::Ping(_)))
            .count();
        assert!(
            probes >= 2,
            "browser Pong starved independent Agent probes: {probes}"
        );
        assert!(
            agent_write
                .sent
                .iter()
                .all(|frame| !matches!(frame, WsFrame::Pong(_))),
            "a browser Pong cannot be forwarded onto a different Agent WebSocket"
        );
    }

    /// SC-03 behavioral regression: client activity suppresses probe pings
    /// (#4065).
    ///
    /// When the client sends frames at intervals shorter than the probe
    /// interval, the relay should forward them without sending probe pings.
    /// This test uses a 200ms probe interval and sends frames every 50ms; no
    /// probe pings should be sent because the ticker is reset on each frame.
    #[tokio::test]
    async fn active_client_suppresses_probe_pings() {
        // Create a stream that yields 3 frames at 50ms intervals.
        let frames = vec![
            frame("client.terminal.input", "frame-1"),
            frame("client.terminal.input", "frame-2"),
            frame("client.terminal.input", "frame-3"),
        ];
        let items: Vec<Result<WsFrame, std::io::Error>> = frames.into_iter().map(Ok).collect();
        let mut client_read = futures_util::stream::iter(items);
        let mut agent_write = RecordingSink::default();
        let probe_interval = std::time::Duration::from_millis(200);

        let outcome = forward_client_to_agent(
            &mut client_read,
            &mut agent_write,
            "sess",
            WIDE_WINDOW,
            probe_interval,
            None,
        )
        .await;

        assert_eq!(
            outcome,
            ClientToAgent::Ended,
            "the relay should complete normally"
        );

        // All three frames should be forwarded.
        assert_eq!(
            agent_write.sent.len(),
            3,
            "expected exactly 3 forwarded frames, got: {:?}",
            agent_write.sent
        );

        // No probe pings should have been sent (the ticker was reset on each frame).
        let ping_count = agent_write
            .sent
            .iter()
            .filter(|f| matches!(f, WsFrame::Ping(_)))
            .count();
        assert_eq!(
            ping_count, 0,
            "expected no probe pings when client is active, got {ping_count}; \
             sent frames: {:?}",
            agent_write.sent
        );
    }

    /// SC-01 behavioral regression: half-open agent leg is detected within the
    /// idle timeout (#4065).
    ///
    /// When the agent's read stream produces no frames (simulating a half-open
    /// TCP connection where the agent is silently partitioned), the relay must
    /// detect this within the idle timeout and return `AgentToClient::HalfOpen`.
    /// This test uses a 100ms timeout to verify the detection without
    /// wall-clock delays.
    #[tokio::test]
    async fn half_open_agent_leg_detected_within_idle_timeout() {
        // Create a pending stream that never yields (simulates half-open agent).
        let mut agent_read = futures_util::stream::pending::<Result<WsFrame, std::io::Error>>();
        let (sender, _rx) = crate::server::outbound::WsMessageSender::new();
        let idle_timeout = std::time::Duration::from_millis(100);

        let start = std::time::Instant::now();
        let outcome = relay_agent_to_client(&mut agent_read, &sender, idle_timeout).await;
        let elapsed = start.elapsed();

        // The relay should detect half-open and return.
        assert_eq!(
            outcome,
            AgentToClient::HalfOpen,
            "expected HalfOpen when agent produces no frames"
        );

        // The detection should happen within roughly the idle timeout.
        // Allow some margin for scheduling overhead.
        assert!(
            elapsed >= idle_timeout,
            "detection happened too fast: {elapsed:?} < {idle_timeout:?}"
        );
        assert!(
            elapsed < idle_timeout + std::time::Duration::from_millis(50),
            "detection took too long: {:?} >= {:?}",
            elapsed,
            idle_timeout + std::time::Duration::from_millis(50)
        );
    }

    /// SC-03 behavioral regression: a responsive agent that sends frames
    /// before the idle timeout is not declared half-open (#4065).
    ///
    /// When the agent's read stream produces frames within the idle timeout,
    /// the relay should forward them and not declare the leg half-open. This
    /// test verifies that a slow but responsive agent (sending frames just
    /// before the timeout) remains connected.
    #[tokio::test]
    async fn slow_but_responsive_agent_not_declared_half_open() {
        // Create a stream that yields one frame after 80ms (within 100ms timeout).
        let frames = vec![frame("agent.terminal.output", "slow-response")];
        let items: Vec<Result<WsFrame, std::io::Error>> = frames.into_iter().map(Ok).collect();

        // Wrap the stream in a delay to simulate slow response.
        let mut agent_read = Box::pin(futures_util::stream::once(async {
            tokio::time::sleep(std::time::Duration::from_millis(80)).await;
            items.into_iter().next().unwrap()
        }));

        let (sender, mut rx) = crate::server::outbound::WsMessageSender::new();
        let idle_timeout = std::time::Duration::from_millis(100);

        let outcome = relay_agent_to_client(&mut agent_read, &sender, idle_timeout).await;

        // The relay should complete normally (agent ended after sending one frame).
        assert_eq!(
            outcome,
            AgentToClient::Ended,
            "expected Ended when agent sends a frame within the timeout"
        );

        // The frame should have been forwarded.
        let queued = rx.try_recv();
        assert!(
            queued.is_ok(),
            "expected the agent's frame to be queued for the client"
        );
    }

    // -----------------------------------------------------------------------
    // #4250 SC-03: legacy route removal + protected compatibility rollback.
    //
    // Exercises the real `http_router` mount decision (the owner of the toggle)
    // rather than a re-composed router: with `legacy_blob_route = false` the
    // proprietary route is unmounted while `/v2/` still serves the verified
    // closure and denies wrong principal/repository/forged digest; the persistent
    // Agent cache and an active mount survive the removal because acquisition is
    // `/v2/`-only; flipping the toggle back to `true` restores the supported legacy
    // reader without relaxing the Server Token or digest checks.
    // -----------------------------------------------------------------------

    const SC03_TOKEN: &str = "sc03-server-token";

    fn sc03_descriptor(
        media_type: &str,
        document: &nession_erofs::oci::RawDocument,
    ) -> nession_erofs::oci::descriptor::Descriptor {
        nession_erofs::oci::descriptor::Descriptor {
            media_type: media_type.to_string(),
            digest: document.digest().to_string(),
            size: document.size().unwrap(),
            urls: None,
            annotations: None,
            platform: None,
            artifact_type: None,
            data: None,
            extra: serde_json::Map::new(),
        }
    }

    struct Sc03Fixture {
        manifest: nession_erofs::oci::RawDocument,
        config: nession_erofs::oci::RawDocument,
        layer: nession_erofs::oci::RawDocument,
    }

    fn sc03_fixture(payload: &[u8]) -> Sc03Fixture {
        use nession_erofs::oci::annotation::{
            MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_MANIFEST,
        };
        use nession_erofs::oci::config::{ImageConfig, RootFs, RuntimeConfig};
        use nession_erofs::oci::manifest::Manifest;
        use nession_erofs::oci::{to_bytes, RawDocument};
        let layer = RawDocument::from_bytes(payload.to_vec());
        let config = ImageConfig {
            created: None,
            author: None,
            architecture: "amd64".to_string(),
            os: "linux".to_string(),
            os_version: None,
            os_features: Some(vec!["erofs".to_string()]),
            variant: None,
            config: RuntimeConfig::default(),
            rootfs: RootFs {
                fs_type: "layers".to_string(),
                diff_ids: vec![layer.digest().to_string()],
                extra: serde_json::Map::new(),
            },
            history: Vec::new(),
            extra: serde_json::Map::new(),
        };
        let config = RawDocument::from_bytes(to_bytes(&config).unwrap());
        let manifest = Manifest {
            schema_version: 2,
            media_type: Some(MEDIA_TYPE_MANIFEST.to_string()),
            config: sc03_descriptor(MEDIA_TYPE_CONFIG, &config),
            layers: vec![sc03_descriptor(MEDIA_TYPE_EROFS, &layer)],
            subject: None,
            artifact_type: None,
            annotations: None,
            extra: serde_json::Map::new(),
        };
        let manifest = RawDocument::from_bytes(to_bytes(&manifest).unwrap());
        Sc03Fixture {
            manifest,
            config,
            layer,
        }
    }

    async fn sc03_manager(
        dir: &std::path::Path,
    ) -> (
        Arc<ImageManager>,
        nession_erofs::blob::store::FsBlobStore,
        sea_orm::DatabaseConnection,
    ) {
        let db = Arc::new(Database::new(":memory:").await.unwrap());
        let blobs = nession_erofs::blob::store::FsBlobStore::new(dir.join("cas")).unwrap();
        let builder = Arc::new(
            nession_erofs::ErofsBuilder::new(
                Arc::new(nession_erofs::ProcessGitRunner::default()),
                Arc::new(nession_erofs::ProcessMkfsRunner::default()),
                blobs.clone(),
                dir.join("build"),
            )
            .unwrap(),
        );
        let manager = Arc::new(
            ImageManager::new(
                Arc::clone(&db),
                builder,
                blobs.clone(),
                ImageManagerOptions {
                    max_concurrent_builds: 1,
                    build_root: dir.join("build"),
                    source_root: None,
                    build_stage_timeout: None,
                    build_log_max_bytes: 1024 * 1024,
                    build_retention_secs: 3600,
                },
            )
            .unwrap(),
        );
        (manager, blobs, db.connection().clone())
    }

    async fn sc03_seed(
        conn: &sea_orm::DatabaseConnection,
        blobs: &nession_erofs::blob::store::FsBlobStore,
        repository: &str,
        tag: &str,
        fixture: &Sc03Fixture,
    ) {
        use nession_erofs::catalog::reference::{
            record_object, record_reference, ObjectKind, StoredObject,
        };
        use nession_erofs::catalog::tag::{set_tag, TagExpectation};
        use nession_erofs::oci::annotation::{
            MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_MANIFEST,
        };
        for (document, kind, media_type) in [
            (&fixture.layer, ObjectKind::Erofs, MEDIA_TYPE_EROFS),
            (&fixture.config, ObjectKind::Config, MEDIA_TYPE_CONFIG),
            (&fixture.manifest, ObjectKind::Manifest, MEDIA_TYPE_MANIFEST),
        ] {
            blobs.put_bytes(document.bytes()).unwrap();
            record_object(
                conn,
                &StoredObject {
                    digest: document.digest().to_string(),
                    media_type: media_type.to_string(),
                    size_bytes: document.size().unwrap(),
                    kind,
                },
                1,
            )
            .await
            .unwrap();
        }
        record_reference(
            conn,
            fixture.manifest.digest(),
            fixture.config.digest(),
            "config",
            1,
        )
        .await
        .unwrap();
        record_reference(
            conn,
            fixture.manifest.digest(),
            fixture.layer.digest(),
            "layer",
            1,
        )
        .await
        .unwrap();
        set_tag(
            conn,
            repository,
            tag,
            fixture.manifest.digest(),
            &TagExpectation::Absent,
            1,
        )
        .await
        .unwrap();
    }

    /// A minimal `ServerContext` whose only exercised routes are the image read
    /// routes; the registries share a fresh in-memory database unrelated to the
    /// seeded image catalog the manager owns.
    async fn sc03_context(
        manager: Arc<ImageManager>,
        auth: nession_protocol::TokenVerifier,
        legacy_blob_route: bool,
    ) -> ServerContext {
        let db = Arc::new(Database::new(":memory:").await.unwrap());
        let agent_registry = Arc::new(AgentRegistry::new(30, Arc::clone(&db)));
        let session_registry = Arc::new(SessionRegistry::new(Arc::clone(&db)));
        let command_broker = Arc::new(CommandBroker::new());
        let extension_tools = Arc::new(
            crate::server::extension_tools::ExtensionToolCatalog::new(
                Arc::clone(&agent_registry),
                Arc::clone(&command_broker),
            )
            .unwrap(),
        );
        let image_http = Arc::new(ImageHttpService::new(Arc::clone(&manager), auth.clone()));
        let image_registry =
            crate::image::registry::build_registry(&manager, auth.clone()).unwrap();
        ServerContext {
            agent_registry,
            session_registry,
            command_broker,
            client_registry: Arc::new(ClientRegistry::new()),
            web_client_registry: Arc::new(WebClientRegistry::new()),
            env_service: EnvService::new(Arc::clone(&db)),
            db,
            mutations: mutation_scheduler(),
            mcp: None,
            extension_tools,
            mcp_enabled: false,
            mcp_path: String::new(),
            image_manager: manager,
            image_http,
            image_registry,
            legacy_blob_route,
            allowed_origins: Arc::new(Vec::new()),
            server_auth: auth,
            heartbeat_interval_secs: 10,
            terminal_cols: 80,
            terminal_web_font_size: 14.0,
            terminal_stall_grace: std::time::Duration::from_secs(5),
            query_concurrency: 4,
            ws_auth_timeout: std::time::Duration::from_secs(10),
        }
    }

    fn sc03_slot() -> AdmissionSlot {
        AdmissionSlot::new(
            Arc::new(tokio::sync::Semaphore::new(1))
                .try_acquire_owned()
                .unwrap(),
        )
    }

    async fn sc03_send(
        router: &Router,
        method: Method,
        uri: &str,
        auth: Option<&str>,
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
        use http_body_util::BodyExt;
        use tower::ServiceExt;
        let mut builder = axum::http::Request::builder().method(method).uri(uri);
        if let Some(token) = auth {
            builder = builder.header("authorization", token);
        }
        let request = builder.body(axum::body::Body::empty()).unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, headers, bytes.to_vec())
    }

    async fn sc03_serve_loopback(router: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (format!("http://{addr}"), handle)
    }

    #[tokio::test]
    async fn sc03_legacy_route_removed_with_protected_rollback() {
        use nession_erofs::cache::fetch::{fetch_manifest_image_v2, ImageObjectGrant};
        use nession_erofs::cache::ErofsCache;
        use nession_erofs::catalog::reference::v2_repository_for_manifest;
        use nession_erofs::oci::annotation::{
            MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_MANIFEST,
        };

        let dir = tempfile::tempdir().unwrap();
        let (manager, blobs, conn) = sc03_manager(dir.path()).await;
        nession_erofs::catalog::migrate(&conn).await.unwrap();
        let fixture = sc03_fixture(b"4250 retirement layer");
        sc03_seed(&conn, &blobs, "team/app", "v1", &fixture).await;
        let repository = v2_repository_for_manifest(&conn, fixture.manifest.digest())
            .await
            .unwrap()
            .expect("a tagged Manifest is /v2/-addressable");
        assert_eq!(repository, "team/app");

        let auth = nession_protocol::TokenVerifier::new(SC03_TOKEN);
        let good = format!("Bearer {SC03_TOKEN}");
        let legacy_layer = format!(
            "{}{}",
            nession_protocol::contracts::image::v1::IMAGE_BLOB_PATH_PREFIX,
            fixture.layer.digest()
        );
        let forged = format!("sha256:{}", "e".repeat(64));

        // --- Removal state: the protected toggle is OFF ---
        let ctx_off = sc03_context(Arc::clone(&manager), auth.clone(), false).await;
        let router_off = http_router(
            ctx_off,
            sc03_slot(),
            Arc::new(tokio::sync::Semaphore::new(8)),
        );

        // The proprietary route is unavailable to a migrated client...
        let (status, _, _) = sc03_send(&router_off, Method::GET, &legacy_layer, Some(&good)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "removed legacy route is 404");
        // ...while standard /v2/ still serves the approved complete closure.
        let (status, _, body) = sc03_send(
            &router_off,
            Method::GET,
            &format!("/v2/{repository}/manifests/{}", fixture.manifest.digest()),
            Some(&good),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, fixture.manifest.bytes());
        let (status, _, body) = sc03_send(
            &router_off,
            Method::GET,
            &format!("/v2/{repository}/blobs/{}", fixture.layer.digest()),
            Some(&good),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, fixture.layer.bytes());
        // Wrong repository: possession of the digest is not authorization.
        let (status, _, _) = sc03_send(
            &router_off,
            Method::GET,
            &format!("/v2/other/app/blobs/{}", fixture.layer.digest()),
            Some(&good),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        // Wrong principal: no credential challenges, a bad token denies.
        let (status, _, _) = sc03_send(&router_off, Method::GET, "/v2/", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _, _) =
            sc03_send(&router_off, Method::GET, "/v2/", Some("Bearer wrong")).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        // Forged digest: absent from the reachable closure.
        let (status, _, _) = sc03_send(
            &router_off,
            Method::GET,
            &format!("/v2/{repository}/blobs/{forged}"),
            Some(&good),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // --- Persistent Agent cache + active mount survive the removal ---
        // The Agent fetches the verified closure over /v2/ only; the legacy route
        // being unmounted cannot disturb its durable cache or a held pin.
        let (base, server) = sc03_serve_loopback(router_off.clone()).await;
        let agent_dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(
            ErofsCache::open(agent_dir.path(), "agent-registry", false)
                .await
                .unwrap(),
        );
        let grants = vec![
            ImageObjectGrant {
                digest: fixture.manifest.digest().to_string(),
                media_type: MEDIA_TYPE_MANIFEST.to_string(),
                size_bytes: fixture.manifest.size().unwrap(),
                path: format!("/v2/{repository}/manifests/{}", fixture.manifest.digest()),
            },
            ImageObjectGrant {
                digest: fixture.config.digest().to_string(),
                media_type: MEDIA_TYPE_CONFIG.to_string(),
                size_bytes: fixture.config.size().unwrap(),
                path: format!("/v2/{repository}/blobs/{}", fixture.config.digest()),
            },
            ImageObjectGrant {
                digest: fixture.layer.digest().to_string(),
                media_type: MEDIA_TYPE_EROFS.to_string(),
                size_bytes: fixture.layer.size().unwrap(),
                path: format!("/v2/{repository}/blobs/{}", fixture.layer.digest()),
            },
        ];
        let cold = fetch_manifest_image_v2(&cache, &grants, &base, SC03_TOKEN, &repository)
            .await
            .expect("authorized /v2/ fetch with the legacy route removed");
        assert_eq!(cold.manifest_digest, fixture.manifest.digest());
        assert_eq!(
            tokio::fs::read(&cold.layer_path).await.unwrap(),
            fixture.layer.bytes()
        );
        let cold_transfers = cache.fetch_count();
        assert_eq!(
            cold_transfers, 3,
            "cold fetch transfers Manifest/Config/EROFS"
        );
        let warm = fetch_manifest_image_v2(&cache, &grants, &base, SC03_TOKEN, &repository)
            .await
            .unwrap();
        assert_eq!(warm.layer_path, cold.layer_path);
        assert_eq!(
            cache.fetch_count(),
            cold_transfers,
            "warm reuse re-transfers nothing"
        );
        let restarted = ErofsCache::open(agent_dir.path(), "agent-registry", false)
            .await
            .unwrap();
        let adopted = fetch_manifest_image_v2(&restarted, &grants, &base, SC03_TOKEN, &repository)
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read(&adopted.layer_path).await.unwrap(),
            fixture.layer.bytes()
        );
        assert_eq!(
            restarted.fetch_count(),
            0,
            "restart adopts the verified blob"
        );
        // An active mount (pin) refuses eviction and stays byte-identical.
        let pin = cache.pin(fixture.layer.digest()).unwrap();
        assert!(
            !cache.evict(fixture.layer.digest()).unwrap(),
            "a pinned blob refuses eviction"
        );
        assert_eq!(
            tokio::fs::read(&cold.layer_path).await.unwrap(),
            fixture.layer.bytes()
        );
        drop(pin);
        assert!(
            cache.evict(fixture.layer.digest()).unwrap(),
            "the released blob is reclaimed"
        );
        server.abort();

        // --- Protected rollback: the toggle ON restores the supported reader ---
        let ctx_on = sc03_context(Arc::clone(&manager), auth.clone(), true).await;
        let router_on = http_router(
            ctx_on,
            sc03_slot(),
            Arc::new(tokio::sync::Semaphore::new(8)),
        );
        let (status, _, body) =
            sc03_send(&router_on, Method::GET, &legacy_layer, Some(&good)).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "rollback restores the legacy reader"
        );
        assert_eq!(body, fixture.layer.bytes());
        // Fail-closed: the rollback relaxes no digest/grant check.
        let (status, _, _) =
            sc03_send(&router_on, Method::GET, &legacy_layer, Some("Bearer wrong")).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _, _) = sc03_send(&router_on, Method::GET, &legacy_layer, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _, _) = sc03_send(
            &router_on,
            Method::GET,
            &format!(
                "{}{forged}",
                nession_protocol::contracts::image::v1::IMAGE_BLOB_PATH_PREFIX
            ),
            Some(&good),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        // /v2/ continues to serve the approved closure after the rollback.
        let (status, _, body) = sc03_send(
            &router_on,
            Method::GET,
            &format!("/v2/{repository}/manifests/{}", fixture.manifest.digest()),
            Some(&good),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, fixture.manifest.bytes());

        println!(
            "#4250 SC-03 measured: with legacy_blob_route=false the proprietary route {} is 404 \
             while /v2/{repository} serves Manifest {} and the EROFS layer byte-identical; foreign \
             repository 404, no-cred 401, bad-token 403, forged digest 404; Agent cold fetch \
             transferred {cold_transfers} objects over /v2/ only, warm reuse and restart adoption \
             re-transferred 0, pinned layer {} refused eviction and was reclaimed on release; \
             rollback legacy_blob_route=true restores the legacy reader (200 exact bytes) while \
             bad/absent token stay 403 and unknown digest 404, with /v2/ still serving the closure",
            legacy_layer,
            fixture.manifest.digest(),
            fixture.layer.digest(),
        );
    }
}
