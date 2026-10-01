use std::sync::Arc;
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, error, info, warn};

use super::handler::{ConnectionHandler, HandlerAction};
use crate::db::Database;
use crate::env::EnvService;
use crate::registry::{AgentRegistry, AgentStatus, SessionRegistry};
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
use nession_runtime::lane::KeyedLane;

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
    /// The P2P credential ledger (#1013).
    ///
    /// Held here because a credential outlives the attach that minted it, and
    /// because the process that checks it is an *Agent* rather than this one —
    /// so this side is only the issuer's record, kept for expiry.
    p2p_broker: Arc<crate::broker::ConnectionBroker>,
    listener: Option<TcpListener>,
}

impl WebSocketServer {
    pub async fn new(config: ServerConfig, db: Arc<Database>) -> anyhow::Result<Self> {
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

        // The ledger's expiry is the revocation window (#1013): how long a
        // credential the Server has already forgotten stays useful to whoever
        // is holding it.
        let p2p_broker = Arc::new(crate::broker::ConnectionBroker::new(
            config.p2p_token_expiry_secs,
        ));

        Ok(Self {
            config,
            p2p_broker,
            agent_registry,
            session_registry,
            command_broker,
            client_registry,
            web_client_registry,
            env_service,
            db,
            mutations: mutation_scheduler(),
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
                    for agent_id in offline {
                        info!("Agent {} marked offline (heartbeat timeout)", agent_id);
                        // A liveness verdict, not a disconnect: nobody is
                        // heartbeating for this agent, so there is no owner to
                        // compare against — see `CommandBroker::evict_agent`.
                        // A connection that is still alive re-claims on its next
                        // message, which is the only way back for an agent that
                        // went quiet without dropping its WebSocket.
                        command_broker.evict_agent(&agent_id).await;

                        // Schedule session cleanup after 30s grace period.
                        // If the agent reconnects before the grace period
                        // expires, its sessions are preserved.
                        let session_registry = Arc::clone(&session_registry);
                        let agent_registry = Arc::clone(&agent_registry);
                        let env_service = Arc::clone(&env_service);
                        let web_client_registry = Arc::clone(&web_client_registry);
                        let agent_id_clone = agent_id.clone();
                        tokio::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                            // Only clean if agent is still offline after grace period.
                            if let Some(agent) = agent_registry.get(&agent_id_clone).await {
                                if agent.status == AgentStatus::Offline {
                                    info!(
                                        "Cleaning sessions for offline agent {} (grace period expired)",
                                        agent_id_clone
                                    );
                                    // Collect session IDs first so we can clear their
                                    // env usage locks after removal.
                                    let removed =
                                        session_registry.remove_by_agent(&agent_id_clone).await;
                                    for session_id in &removed {
                                        env_service.usage.clear_session(session_id);
                                    }
                                    if !removed.is_empty() {
                                        // Push the shrunken list so browsers stop
                                        // showing sessions that are now gone.
                                        web_client_registry
                                            .broadcast_sessions_changed(Arc::clone(
                                                &session_registry,
                                            ))
                                            .await;
                                    }
                                }
                            }
                        });
                    }
                }
            });
        }

        // Background sweep: periodically clean up orphaned sessions whose
        // agent has been unreachable for more than 24 hours.
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
                    // 24 hours in seconds
                    let cutoff = 24 * 3600i64;
                    match db.list_sessions_older_than(cutoff).await {
                        Ok(rows) => {
                            if rows.is_empty() {
                                continue;
                            }
                            for row in &rows {
                                info!(
                                    "Cleaning orphaned session {} (agent: {}, last activity: {})",
                                    row.session_id, row.agent_id, row.last_activity
                                );
                                session_registry.remove(&row.session_id).await;
                                // Release env usage locks held by this session.
                                env_service.usage.clear_session(&row.session_id);
                            }
                            tracing::info!("Cleaned {} orphaned sessions", rows.len());
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

        loop {
            let (tcp_stream, addr) = listener.accept().await?;
            info!("New connection from: {}", addr);

            let ctx = ServerContext {
                agent_registry: Arc::clone(&self.agent_registry),
                session_registry: Arc::clone(&self.session_registry),
                command_broker: Arc::clone(&self.command_broker),
                client_registry: Arc::clone(&self.client_registry),
                web_client_registry: Arc::clone(&self.web_client_registry),
                env_service: Arc::clone(&self.env_service),
                db: Arc::clone(&self.db),
                mutations: Arc::clone(&self.mutations),
                p2p_broker: Arc::clone(&self.p2p_broker),
                auth_token: self.config.auth_token.clone(),
                heartbeat_interval_secs,
                terminal_stall_grace: std::time::Duration::from_secs(
                    self.config.terminal_stall_grace_secs,
                ),
                query_concurrency: self.config.query_concurrency_per_connection,
            };
            let tls_acceptor = tls_acceptor.clone();

            tokio::spawn(async move {
                if let Err(e) = handle_connection(tcp_stream, tls_acceptor, ctx).await {
                    error!("Connection error: {}", e);
                }
            });
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
    p2p_broker: Arc<crate::broker::ConnectionBroker>,
    auth_token: String,
    heartbeat_interval_secs: u64,
    terminal_stall_grace: std::time::Duration,
    /// How many queries one connection may have in flight (`#961-C`). Bound
    /// here rather than read per frame so a connection's lane is fixed for its
    /// lifetime: see `nession_runtime::lane::QueryLane`.
    query_concurrency: usize,
}

async fn handle_connection(
    tcp_stream: tokio::net::TcpStream,
    tls_acceptor: Option<TlsAcceptor>,
    ctx: ServerContext,
) -> anyhow::Result<()> {
    if let Some(acceptor) = tls_acceptor {
        let tls_stream = acceptor.accept(tcp_stream).await?;
        handle_ws_stream(tls_stream, ctx).await
    } else {
        handle_ws_stream(tcp_stream, ctx).await
    }
}

async fn handle_ws_stream<S>(stream: S, ctx: ServerContext) -> anyhow::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    use futures_util::SinkExt;
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
        auth_token,
        heartbeat_interval_secs,
        terminal_stall_grace,
        query_concurrency,
        p2p_broker,
    } = ctx;

    let ws_stream = accept_async(stream).await?;
    let (mut write, mut read) = ws_stream.split();

    // Create the outgoing-message queue BEFORE the handler so the handler can
    // register its sender for broadcasts (e.g. terminal resize). The queue is
    // bounded and its policies belong to the messages rather than to the
    // connection: see `server::outbound`.
    let (sender, mut rx) = WsMessageSender::with_terminal_grace(terminal_stall_grace);

    let mut handler = ConnectionHandler::new(
        crate::server::handler::ConnectionHandlerDeps {
            agent_registry,
            session_registry,
            command_broker: command_broker.clone(),
            client_registry: client_registry.clone(),
            web_client_registry: web_client_registry.clone(),
            env_service,
            db,
            p2p_broker,
        },
        crate::server::handler::ConnectionHandlerConfig {
            server_auth_token: auth_token,
            heartbeat_interval_secs,
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
    // parked, so a stalled business frame never delays a ping.
    let ping_period = std::time::Duration::from_secs(heartbeat_interval_secs.max(1));
    let mut relay_task = tokio::spawn(async move {
        let mut ping_ticker = tokio::time::interval(ping_period);
        ping_ticker.tick().await; // consume the immediate first tick
        loop {
            tokio::select! {
                maybe_msg = rx.recv() => {
                    match maybe_msg {
                        Some(frame) => {
                            // Split so the budget claim is released *after* the
                            // write, not before it: `budget` stays alive across
                            // the await and drops at the end of the arm.
                            let crate::server::outbound::QueuedFrame { message, budget } = frame;
                            let written = write.send(message).await;
                            drop(budget);
                            if let Err(e) = written {
                                error!("Failed to send WebSocket message: {}", e);
                                break;
                            }
                        }
                        None => break,
                    }
                }
                _ = ping_ticker.tick() => {
                    if write.send(tokio_tungstenite::tungstenite::Message::Ping(Vec::new())).await.is_err() {
                        // Connection closed — expected during shutdown, no need to log.
                        break;
                    }
                }
            }
        }
    });

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

    while let Some(frame) = read.next().await {
        let frame = frame?;

        // Not a protocol message: a close, a ping, a pong, a binary frame.
        // Connection lifecycle, handled where it stands *and ahead of the
        // barrier below*, because a slow operation must not hold the connection
        // open — the requirement names ping and close explicitly. The work
        // still in flight is ended with the connection, further down.
        let Message::Text(text) = frame else {
            if let HandlerAction::Close = handler.handle_message(frame).await? {
                break;
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
        let msg: ProtocolMessage<serde_json::Value> = serde_json::from_str(&text)?;
        let policy = policy_for_wire(&msg.msg_type, &msg.payload);

        match policy {
            ExecutionPolicy::Query => {
                // The claim comes first: it is what binds this connection as the
                // agent's control channel, and a query may reach for the broker
                // as soon as its task is scheduled.
                claim_agent_channel(&handler, &command_broker, &sender).await;
                // `query` waits here when the connection's lane is
                // full. That wait is the bound the requirement asks for: the
                // frame that would exceed the lane is not *read* until there is
                // room for it, so a connection cannot grow tasks with its
                // message count.
                lanes
                    .query(answer(handler.clone(), msg, sender.clone(), "a query"))
                    .await;
                continue;
            }
            ExecutionPolicy::Key(key) => {
                // Claimed here for the same reason as a query's: the mutation
                // reaches for the broker as soon as its key's worker runs it,
                // and the claim is about *this* connection rather than about the
                // frame that prompted it.
                claim_agent_channel(&handler, &command_broker, &sender).await;
                // Waits only when that resource's own queue is at its depth. The
                // wait parks the reader, which is the backpressure — see
                // `server::execution`. A mutation for another resource is not
                // behind it.
                lanes
                    .key(
                        key,
                        Box::pin(answer(handler.clone(), msg, sender.clone(), "a mutation")),
                    )
                    .await;
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

        let action = handler.handle_protocol_message(msg).await?;
        claim_agent_channel(&handler, &command_broker, &sender).await;

        match action {
            HandlerAction::Reply(Some(response)) => {
                // A reply is not droppable, so it waits for room rather than
                // failing. The only error left is the queue being closed, which
                // means this connection is over: leave the loop by the normal
                // exit so the cleanup below still runs, instead of returning
                // through `?` and skipping it.
                if sender.send_reply(response).await.is_err() {
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
                client_id,
                env_snapshots,
                cols,
                rows,
                size_known,
                needs_bootstrap,
            } => {
                let outcome = relay_bidirectional_via_channel(
                    &mut read,
                    sender.clone(),
                    RelayRequest {
                        agent_ws_urls: &agent_ws_urls,
                        session_name: &session_name,
                        env_snapshots: &env_snapshots,
                        cols,
                        rows,
                        size_known,
                        needs_bootstrap,
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
                            "Relay for session '{}' ended: the client stopped draining its \
                             terminal; closing the connection",
                            session_name
                        );
                        break;
                    }
                    Err(e) => return Err(e),
                }
            }
            HandlerAction::Close => {
                break;
            }
        }
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
        command_broker
            .release_agent(agent_id, handler.connection_generation())
            .await;
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
    drop(sender);
    if tokio::time::timeout(terminal_stall_grace, &mut relay_task)
        .await
        .is_err()
    {
        warn!(
            "outbound: writer still parked after {:?} with frames undelivered; \
             aborting it so the connection can close",
            terminal_stall_grace
        );
        relay_task.abort();
    }

    Ok(())
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
    /// The relay stopped for an ordinary reason: the client detached, the agent
    /// closed, or either side's socket ended. The WebSocket stays open.
    Ended,
    /// The client stopped draining the terminal lane long enough that the
    /// Server declared it gone. The caller closes the connection.
    ClientStalled,
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
}

/// Relay mode using the connection's queued outbound path for client writes.
/// Used when the write sink is managed by a relay task.
///
/// Tries each URL in `request.agent_ws_urls` with a fast 2s connect timeout
/// until one succeeds.  This avoids long hangs when the first address
/// is unreachable (common in k8s where pod IPs are not routable).
async fn relay_bidirectional_via_channel<RS>(
    client_read: &mut RS,
    sender: crate::server::outbound::WsMessageSender,
    request: RelayRequest<'_>,
) -> anyhow::Result<RelayEnd>
where
    RS: futures_util::Stream<
            Item = Result<
                tokio_tungstenite::tungstenite::Message,
                tokio_tungstenite::tungstenite::Error,
            >,
        > + Unpin,
{
    use futures_util::SinkExt;
    use futures_util::StreamExt;

    let RelayRequest {
        agent_ws_urls,
        session_name,
        env_snapshots,
        cols,
        rows,
        size_known,
        needs_bootstrap,
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
        info!("Relay: trying {}", url);
        match tokio::time::timeout(
            std::time::Duration::from_secs(2),
            tokio_tungstenite::connect_async(url),
        )
        .await
        {
            Ok(Ok((ws, _))) => {
                info!("Relay: connected to {}", url);
                agent_ws = Some(ws);
                connected_url = Some(url.clone());
                break;
            }
            Ok(Err(ref e)) => {
                warn!("Relay: connect to {} failed: {:#}", url, e);
            }
            Err(_) => {
                warn!("Relay: connect to {} timed out (2s)", url);
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

    let (mut agent_write, mut agent_read) = agent_ws.split();

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
        .send(tokio_tungstenite::tungstenite::Message::Text(
            attach_msg.to_string(),
        ))
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
    let attach_response = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let Some(frame) = agent_read.next().await else {
                return Err("Agent closed connection before accepting attach".to_string());
            };
            let msg = match frame {
                Ok(msg) => msg,
                Err(e) => return Err(format!("Agent connection error during attach: {e}")),
            };
            let parsed = msg
                .to_text()
                .ok()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok());
            match parsed {
                Some(value)
                    if value.get("id").and_then(|v| v.as_str()) == Some(attach_id.as_str()) =>
                {
                    return Ok(value);
                }
                // Not the reply — including a frame that could not be read at
                // all, which is forwarded rather than guessed at. An unknown
                // wire is ignored everywhere else in this tree; here "ignored"
                // and "dropped on the floor" are the same thing, so it goes on.
                _ => {}
            }
            match sender.send_terminal(msg).await {
                Ok(()) => {}
                Err(crate::server::outbound::OutboundError::Stalled) => {
                    return Err("Client stalled while the agent was still attaching".to_string());
                }
                Err(e) => return Err(format!("Failed to forward agent message: {e}")),
            }
        }
    })
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
        let client_error = tokio_tungstenite::tungstenite::Message::Text(
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
    info!(
        "Agent confirmed attach for session '{}' (msg_type={})",
        session_name, resp_type
    );

    info!("Relay established for session '{}'", session_name);

    // ── Step 2: Bidirectional forwarding ──

    let client_to_agent =
        forward_client_to_agent(client_read, &mut agent_write, session_name, INPUT_THROTTLE);

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
    let agent_to_client = async {
        while let Some(msg) = agent_read.next().await {
            match msg {
                Ok(msg) => match sender.send_terminal(msg).await {
                    Ok(()) => {}
                    Err(crate::server::outbound::OutboundError::Stalled) => {
                        stalled = true;
                        break;
                    }
                    Err(e) => {
                        error!("Failed to forward agent message to client: {}", e);
                        break;
                    }
                },
                Err(e) => {
                    error!("Error reading from agent: {}", e);
                    break;
                }
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
                "Could not connect to agent for client.detach for session '{}'",
                session_name
            );
        }
    }

    info!("Relay mode ended for session '{}'", session_name);
    Ok(if stalled {
        RelayEnd::ClientStalled
    } else {
        RelayEnd::Ended
    })
}

/// The terminal-input throttle window: a burst of input arriving inside it is
/// collapsed to its newest frame. 16 ms ≈ 60 fps — faster than a mouse-tracking
/// flood, slower than anything a person types.
const INPUT_THROTTLE: std::time::Duration = std::time::Duration::from_millis(16);

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
fn classify_client_frame(msg: &Message) -> ClientFrame {
    let Ok(text) = msg.to_text() else {
        return ClientFrame::Other;
    };
    let Ok(envelope) = serde_json::from_str::<RelayEnvelope<'_>>(text) else {
        return ClientFrame::Other;
    };
    match envelope.msg_type {
        Some(TERMINAL_INPUT_WIRE) => ClientFrame::TerminalInput,
        Some(RELAY_END_WIRE) => ClientFrame::RelayEnd,
        _ => ClientFrame::Other,
    }
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
fn merge_terminal_input(frames: &[Message]) -> Option<Message> {
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
    Some(Message::Text(envelope.to_string()))
}

/// Forward a burst that the throttle window held, in order and losing nothing.
///
/// Returns `false` when a send failed, which is how the caller learns to stop.
async fn flush_burst<AS>(agent_write: &mut AS, burst: &mut Vec<Message>) -> bool
where
    AS: futures_util::Sink<Message> + Unpin,
    AS::Error: std::fmt::Display,
{
    use futures_util::SinkExt as _;

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
                    if let Err(e) = agent_write.send(frame).await {
                        error!("Failed to forward client message to agent: {}", e);
                        return false;
                    }
                }
                return true;
            }
        },
    };

    match merged {
        Some(frame) => match agent_write.send(frame).await {
            Ok(()) => true,
            Err(e) => {
                error!("Failed to forward client message to agent: {}", e);
                false
            }
        },
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
async fn forward_client_to_agent<RS, AS>(
    client_read: &mut RS,
    agent_write: &mut AS,
    session_name: &str,
    input_throttle: std::time::Duration,
) -> ClientToAgent
where
    RS: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
    AS: futures_util::Sink<Message> + Unpin,
    AS::Error: std::fmt::Display,
{
    use futures_util::SinkExt;
    use futures_util::StreamExt;

    // 60 s in the past, so the first input of a relay is never throttled: the
    // keystroke that opens a session must not wait out a window.
    let mut last_terminal_input = std::time::Instant::now()
        .checked_sub(std::time::Duration::from_secs(60))
        .unwrap_or_else(std::time::Instant::now);

    'forward: while let Some(msg) = client_read.next().await {
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
            ClientFrame::Other => {
                if let Err(e) = agent_write.send(msg).await {
                    error!("Failed to forward client message to agent: {}", e);
                    break;
                }
                continue;
            }
            ClientFrame::TerminalInput => {}
        }

        // Terminal input outside the window — forward it now (leading edge).
        // This is the common path and the one that has to stay zero-latency.
        if last_terminal_input.elapsed() >= input_throttle {
            last_terminal_input = std::time::Instant::now();
            if let Err(e) = agent_write.send(msg).await {
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
        let mut burst: Vec<Message> = vec![msg];
        let mut end_requested = false;

        loop {
            let remaining = drain_deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match tokio::time::timeout(remaining, client_read.next()).await {
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
                    // Not coalescable, and sent *after* the frame being held:
                    // flush the held frame first, so the agent sees frames in
                    // the order the client sent them, then hand this one on and
                    // go back to reading outside the window.
                    ClientFrame::Other => {
                        if !flush_burst(agent_write, &mut burst).await {
                            break 'forward;
                        }
                        if let Err(e) = agent_write.send(m).await {
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

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::Sink;
    use serde_json::json;
    use std::pin::Pin;
    use std::task::{Context, Poll};

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
        sent: Vec<Message>,
    }

    impl Sink<Message> for RecordingSink {
        type Error = std::convert::Infallible;

        fn poll_ready(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn start_send(self: Pin<&mut Self>, item: Message) -> Result<(), Self::Error> {
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
    fn frame_with_payload(msg_type: &str, id: &str, payload: serde_json::Value) -> Message {
        Message::Text(
            json!({
                "msg_type": msg_type,
                "id": id,
                "timestamp": 0,
                "payload": payload,
            })
            .to_string(),
        )
    }

    fn frame(msg_type: &str, id: &str) -> Message {
        frame_with_payload(msg_type, id, json!({ "session_name": "sess" }))
    }

    /// A terminal-input frame whose bytes are its own `id`, base64-encoded.
    ///
    /// The bytes matter since `#966`: a burst is *merged* rather than reduced to
    /// its newest frame, so a test that wants to show the window was open has to
    /// say what the agent received — and `frame_data` reads it back. Deriving the
    /// bytes from the id is what makes the order visible.
    fn terminal_input(id: &str) -> Message {
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
    fn sequenced_terminal_input(bytes: &str, epoch: u64, seq: u64) -> Message {
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
    fn frame_sequence(msg: &Message) -> (Option<u64>, Option<u64>, Option<u64>) {
        let envelope: serde_json::Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
        let payload = &envelope["payload"];
        (
            payload["input_epoch"].as_u64(),
            payload["seq_start"].as_u64(),
            payload["seq_end"].as_u64(),
        )
    }

    /// The bytes a terminal-input frame carries, decoded.
    fn frame_data(msg: &Message) -> String {
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

    fn relay_end(id: &str) -> Message {
        frame(RELAY_END_WIRE, id)
    }

    /// Drive the pump over frames that are already in memory and report what
    /// reached the agent, and why the loop stopped.
    async fn drive(frames: Vec<Message>) -> (Vec<Message>, ClientToAgent) {
        let items: Vec<Result<Message, tokio_tungstenite::tungstenite::Error>> =
            frames.into_iter().map(Ok).collect();
        let mut client_read = futures_util::stream::iter(items);
        let mut agent_write = RecordingSink::default();

        let outcome =
            forward_client_to_agent(&mut client_read, &mut agent_write, "sess", WIDE_WINDOW).await;

        (agent_write.sent, outcome)
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
        let innocent =
            frame_with_payload("server.info", "info-1", json!({ "note": RELAY_END_WIRE }));

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
        let each =
            |id: &str| frame_with_payload("server.info", id, json!({ "note": "terminal.input" }));
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
                    "server.info",
                    "x",
                    json!({ "note": literal })
                )),
                ClientFrame::Other,
                "a payload quoting {literal} is not {literal}"
            );
        }

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
            classify_client_frame(&Message::Binary(vec![1, 2, 3])),
            ClientFrame::Other
        );
        assert_eq!(
            classify_client_frame(&Message::Text("{ not json".to_string())),
            ClientFrame::Other
        );
        assert_eq!(
            classify_client_frame(&Message::Text("{}".to_string())),
            ClientFrame::Other
        );
        assert_eq!(
            classify_client_frame(&Message::Text(r#"{"msg_type":7}"#.to_string())),
            ClientFrame::Other
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
}
