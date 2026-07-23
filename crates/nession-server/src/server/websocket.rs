use std::sync::Arc;
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::accept_async;
use tracing::{error, info, warn};

use super::handler::{ConnectionHandler, HandlerAction};
use crate::db::Database;
use crate::env::EnvService;
use crate::registry::{AgentRegistry, AgentStatus, SessionRegistry};
use crate::server::client_registry::ClientRegistry;
use crate::server::command_broker::CommandBroker;
use crate::server::web_client_registry::WebClientRegistry;
use nession_common::config::ServerConfig;
use nession_common::protocol::EnvSnapshot;

pub struct WebSocketServer {
    config: ServerConfig,
    agent_registry: Arc<AgentRegistry>,
    session_registry: Arc<SessionRegistry>,
    command_broker: Arc<CommandBroker>,
    client_registry: Arc<ClientRegistry>,
    web_client_registry: Arc<WebClientRegistry>,
    env_service: Arc<EnvService>,
    db: Arc<Database>,
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

        let env_root = nession_common::paths::server_envs_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from(".nession/server/envs"));
        let env_service = EnvService::new(env_root);

        Ok(Self {
            config,
            agent_registry,
            session_registry,
            command_broker,
            client_registry,
            web_client_registry,
            env_service,
            db,
            listener: Some(listener),
        })
    }

    pub async fn run(&mut self) -> anyhow::Result<()> {
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
                        command_broker.unregister_agent(&agent_id).await;

                        // Schedule session cleanup after 30s grace period.
                        // If the agent reconnects before the grace period
                        // expires, its sessions are preserved.
                        let session_registry = Arc::clone(&session_registry);
                        let agent_registry = Arc::clone(&agent_registry);
                        let env_service = Arc::clone(&env_service);
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
                auth_token: self.config.auth_token.clone(),
                heartbeat_interval_secs,
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
    auth_token: String,
    heartbeat_interval_secs: u64,
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
    use crate::server::command_broker::WsMessageSender;
    use futures_util::SinkExt;
    use futures_util::StreamExt;

    let ServerContext {
        agent_registry,
        session_registry,
        command_broker,
        client_registry,
        web_client_registry,
        env_service,
        auth_token,
        heartbeat_interval_secs,
    } = ctx;

    let ws_stream = accept_async(stream).await?;
    let (mut write, mut read) = ws_stream.split();

    // Create the outgoing-message channel BEFORE the handler so the handler
    // can register its sender for broadcasts (e.g. terminal resize).
    let (sender, mut rx) = WsMessageSender::new();

    let mut handler = ConnectionHandler::new(
        agent_registry,
        session_registry,
        command_broker.clone(),
        client_registry.clone(),
        web_client_registry.clone(),
        env_service,
        crate::server::handler::ConnectionHandlerConfig {
            server_auth_token: auth_token,
            heartbeat_interval_secs,
        },
    );
    handler.set_client_sender(sender.clone());

    // Spawn a relay task that drains the receiver and forwards to the actual
    // write sink. A periodic WebSocket Ping keeps the TCP path alive through
    // intermediaries and lets us detect a dead peer quickly.
    let ping_period = std::time::Duration::from_secs(heartbeat_interval_secs.max(1));
    let relay_task = tokio::spawn(async move {
        let mut ping_ticker = tokio::time::interval(ping_period);
        ping_ticker.tick().await; // consume the immediate first tick
        loop {
            tokio::select! {
                maybe_msg = rx.recv() => {
                    match maybe_msg {
                        Some(msg) => {
                            if let Err(e) = write.send(msg).await {
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

    while let Some(msg) = read.next().await {
        let msg = msg?;

        let action = handler.handle_message(msg).await?;

        // Register the agent's sender with CommandBroker.  Always replace
        // the previous sender (if any) because on reconnect the old sender
        // was already unregistered — failing to re-register here causes
        // "agent not found" on the first command after reconnect.
        if let Some(agent_id) = handler.registered_agent_id() {
            command_broker
                .register_agent(agent_id, sender.clone())
                .await;
        }

        match action {
            HandlerAction::Reply(Some(response)) => {
                sender.send(response)?;
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
            } => {
                relay_bidirectional_via_channel(
                    &mut read,
                    sender.clone(),
                    &agent_ws_urls,
                    &session_name,
                    &env_snapshots,
                    cols,
                    rows,
                )
                .await?;
                // Relay ended — clean up the client registration so the
                // cleanup block below (WS-close path) doesn't double-free.
                client_registry.unregister(&session_id, &client_id).await;
                // Don't break — the WebSocket stays open for dashboard use.
                continue;
            }
            HandlerAction::Close => {
                break;
            }
        }
    }

    // Clean up: unregister agent from CommandBroker on disconnect
    if let Some(agent_id) = handler.registered_agent_id() {
        command_broker.unregister_agent(agent_id).await;
    }

    // Clean up: unregister client from ClientRegistry on disconnect
    if let (Some(session_id), Some(client_id)) = (
        handler.attached_session_id().map(String::from),
        handler.attached_client_id().map(String::from),
    ) {
        client_registry.unregister(&session_id, &client_id).await;
    }

    // Drop the sender to signal the relay task to exit
    drop(sender);
    // Wait for the relay task to finish
    let _ = relay_task.await;

    Ok(())
}

/// Relay mode using channel-based sender for client writes.
/// Used when the write sink is managed by a relay task.
///
/// Tries each URL in `agent_ws_urls` with a fast 2s connect timeout
/// until one succeeds.  This avoids long hangs when the first address
/// is unreachable (common in k8s where pod IPs are not routable).
async fn relay_bidirectional_via_channel<RS>(
    client_read: &mut RS,
    sender: crate::server::command_broker::WsMessageSender,
    agent_ws_urls: &[String],
    session_name: &str,
    env_snapshots: &[EnvSnapshot],
    cols: u16,
    rows: u16,
) -> anyhow::Result<()>
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

    // ── Step 1: Send client.attach to the agent ──
    let attach_msg = serde_json::json!({
        "msg_type": "client.attach",
        "id": uuid::Uuid::new_v4().to_string(),
        "timestamp": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        "payload": {
            "session_name": session_name,
            "width": cols,
            "height": rows,
            "env_snapshots": env_snapshots,
        }
    });
    agent_write
        .send(tokio_tungstenite::tungstenite::Message::Text(
            attach_msg.to_string(),
        ))
        .await?;

    // Wait for ok/error response from agent (10s timeout).
    let attach_response =
        tokio::time::timeout(std::time::Duration::from_secs(10), agent_read.next()).await;
    match attach_response {
        Ok(Some(Ok(msg))) => {
            if let Ok(text) = msg.to_text() {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(text) {
                    let resp_type = parsed
                        .get("msg_type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if resp_type == "error" {
                        let err_msg = parsed
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
                        let _ = sender.send(client_error);
                        return Ok(());
                    }
                    info!(
                        "Agent confirmed attach for session '{}' (msg_type={})",
                        session_name, resp_type
                    );
                }
            }
        }
        Ok(Some(Err(e))) => {
            error!("WebSocket error waiting for attach response: {}", e);
            return Err(anyhow::anyhow!("Agent connection error during attach: {e}",));
        }
        Ok(None) => {
            error!("Agent closed connection during attach");
            return Err(anyhow::anyhow!(
                "Agent closed connection before accepting attach"
            ));
        }
        Err(_) => {
            error!("Timeout waiting for agent attach response (10s)");
            return Err(anyhow::anyhow!(
                "Timeout waiting for agent to accept attach for session '{session_name}'",
            ));
        }
    }

    info!("Relay established for session '{}'", session_name);

    // ── Step 2: Bidirectional forwarding ──

    // Helper: detect terminal.input JSON messages.
    fn is_terminal_input(msg: &tokio_tungstenite::tungstenite::Message) -> bool {
        msg.to_text()
            .ok()
            .map(|t| t.contains("\"terminal.input\""))
            .unwrap_or(false)
    }

    // Helper: detect client.session.relay.end — client wants to stop the
    // relay without closing the WebSocket.
    fn is_relay_end(msg: &tokio_tungstenite::tungstenite::Message) -> bool {
        msg.to_text()
            .ok()
            .map(|t| t.contains("\"client.session.relay.end\""))
            .unwrap_or(false)
    }

    // Forward client -> agent, with trailing-edge rate limiting on
    // terminal.input to protect against mouse-tracking floods.
    const INPUT_THROTTLE_MS: u64 = 16;
    let mut last_terminal_input = std::time::Instant::now()
        .checked_sub(std::time::Duration::from_secs(60))
        .unwrap_or(std::time::Instant::now());

    let client_to_agent = async {
        while let Some(msg) = client_read.next().await {
            let msg = match msg {
                Ok(m) => m,
                Err(e) => {
                    error!("Error reading from client: {}", e);
                    break;
                }
            };

            // Non-terminal.input passes through immediately.
            if !is_terminal_input(&msg) {
                // Client wants to stop relay without closing the WebSocket.
                if is_relay_end(&msg) {
                    info!("Client requested relay end for session '{}'", session_name);
                    return;
                }
                if let Err(e) = agent_write.send(msg).await {
                    error!("Failed to forward client message to agent: {}", e);
                    break;
                }
                continue;
            }

            // Terminal.input: trailing-edge throttle.
            let elapsed = last_terminal_input.elapsed();
            if elapsed < std::time::Duration::from_millis(INPUT_THROTTLE_MS) {
                let drain_deadline =
                    last_terminal_input + std::time::Duration::from_millis(INPUT_THROTTLE_MS);
                let mut latest = msg;

                loop {
                    let remaining =
                        drain_deadline.saturating_duration_since(std::time::Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    match tokio::time::timeout(remaining, client_read.next()).await {
                        Ok(Some(Ok(m))) if is_terminal_input(&m) => {
                            latest = m; // keep only latest mouse event
                        }
                        Ok(Some(Ok(m))) => {
                            // Non-terminal.input message during drain:
                            // forward it now, then break to send latest.
                            let _ = agent_write.send(m).await;
                            break;
                        }
                        Ok(Some(Err(e))) => {
                            error!("Error reading from client: {}", e);
                            break;
                        }
                        Ok(None) | Err(tokio::time::error::Elapsed { .. }) => {
                            break; // stream ended or timeout
                        }
                    }
                }

                // Send the latest buffered terminal.input.
                if let Err(e) = agent_write.send(latest).await {
                    error!("Failed to forward client message to agent: {}", e);
                    break;
                }
                last_terminal_input = std::time::Instant::now();
            } else {
                // Outside throttle window — send immediately (leading edge).
                last_terminal_input = std::time::Instant::now();
                if let Err(e) = agent_write.send(msg).await {
                    error!("Failed to forward client message to agent: {}", e);
                    break;
                }
            }
        }
    };

    // Forward agent -> client (via channel sender)
    let agent_to_client = async {
        while let Some(msg) = agent_read.next().await {
            match msg {
                Ok(msg) => {
                    if let Err(e) = sender.send(msg) {
                        error!("Failed to forward agent message to client: {}", e);
                        break;
                    }
                }
                Err(e) => {
                    error!("Error reading from agent: {}", e);
                    break;
                }
            }
        }
    };

    tokio::select! {
        _ = client_to_agent => {
            info!("Client to agent relay ended for session '{}'", session_name);
        }
        _ = agent_to_client => {
            info!("Agent to client relay ended for session '{}'", session_name);
        }
    }

    // ── Step 3: Send client.detach on exit (best-effort, fresh connection) ──
    // The original agent WS was split+consumed, so we open a fresh connection
    // to the same URL that worked for the attach.
    if let Some(ref url) = connected_url {
        if let Ok((mut detach_ws, _)) = tokio_tungstenite::connect_async(url).await {
            let detach_msg = serde_json::json!({
                "msg_type": "client.detach",
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
    Ok(())
}
