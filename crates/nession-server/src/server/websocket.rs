use std::sync::Arc;
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::accept_async;
use tracing::{info, error};

use crate::registry::{AgentRegistry, SessionRegistry};
use crate::server::command_broker::CommandBroker;
use nession_common::config::ServerConfig;
use super::handler::{ConnectionHandler, HandlerAction};

pub struct WebSocketServer {
    config: ServerConfig,
    agent_registry: Arc<AgentRegistry>,
    session_registry: Arc<SessionRegistry>,
    command_broker: Arc<CommandBroker>,
    listener: Option<TcpListener>,
}

impl WebSocketServer {
    pub async fn new(config: ServerConfig) -> anyhow::Result<Self> {
        let listener = TcpListener::bind(&config.listen_address).await?;
        let agent_registry = Arc::new(AgentRegistry::new(config.heartbeat_timeout_secs));
        let session_registry = Arc::new(SessionRegistry::new());
        let command_broker = Arc::new(CommandBroker::new());

        Ok(Self {
            config,
            agent_registry,
            session_registry,
            command_broker,
            listener: Some(listener),
        })
    }

    pub async fn run(&mut self) -> anyhow::Result<()> {
        let listener = self.listener.take()
            .ok_or_else(|| anyhow::anyhow!("Server already running or not initialized"))?;

        info!("WebSocket server listening on {}", listener.local_addr()?);

        let tls_acceptor = if !self.config.tls_cert_path.is_empty() {
            Some(build_tls_acceptor(&self.config.tls_cert_path, &self.config.tls_key_path)?)
        } else {
            None
        };

        let heartbeat_interval_secs = self.config.heartbeat_interval_secs;

        // Background sweeper: periodically mark agents that have missed their
        // heartbeat window as offline so clients stop targeting dead agents.
        {
            let agent_registry = Arc::clone(&self.agent_registry);
            let command_broker = Arc::clone(&self.command_broker);
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
                    }
                }
            });
        }

        loop {
            let (tcp_stream, addr) = listener.accept().await?;
            info!("New connection from: {}", addr);

            let agent_registry = Arc::clone(&self.agent_registry);
            let session_registry = Arc::clone(&self.session_registry);
            let command_broker = Arc::clone(&self.command_broker);
            let auth_token = self.config.auth_token.clone();
            let tls_acceptor = tls_acceptor.clone();

            tokio::spawn(async move {
                if let Err(e) = handle_connection(
                    tcp_stream,
                    tls_acceptor,
                    agent_registry,
                    session_registry,
                    command_broker,
                    auth_token,
                    heartbeat_interval_secs,
                ).await {
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
            .map_err(|e| anyhow::anyhow!("Failed to get local address: {}", e))
    }
}

fn build_tls_acceptor(cert_path: &str, key_path: &str) -> anyhow::Result<TlsAcceptor> {
    use std::fs::File;
    use std::io::BufReader;
    use rustls_pemfile::{certs, private_key};
    use rustls::ServerConfig;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};

    let cert_file = File::open(cert_path)?;
    let mut cert_reader = BufReader::new(cert_file);
    let cert_chain: Vec<CertificateDer<'static>> = certs(&mut cert_reader)
        .collect::<Result<Vec<_>, _>>()?;

    let key_file = File::open(key_path)?;
    let mut key_reader = BufReader::new(key_file);
    let key: PrivateKeyDer<'static> = private_key(&mut key_reader)?
        .ok_or_else(|| anyhow::anyhow!("No private key found"))?;

    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(cert_chain, key)?;

    Ok(TlsAcceptor::from(Arc::new(config)))
}

async fn handle_connection(
    tcp_stream: tokio::net::TcpStream,
    tls_acceptor: Option<TlsAcceptor>,
    agent_registry: Arc<AgentRegistry>,
    session_registry: Arc<SessionRegistry>,
    command_broker: Arc<CommandBroker>,
    auth_token: String,
    heartbeat_interval_secs: u64,
) -> anyhow::Result<()> {
    if let Some(acceptor) = tls_acceptor {
        let tls_stream = acceptor.accept(tcp_stream).await?;
        handle_ws_stream(tls_stream, agent_registry, session_registry, command_broker, auth_token, heartbeat_interval_secs).await
    } else {
        handle_ws_stream(tcp_stream, agent_registry, session_registry, command_broker, auth_token, heartbeat_interval_secs).await
    }
}

async fn handle_ws_stream<S>(
    stream: S,
    agent_registry: Arc<AgentRegistry>,
    session_registry: Arc<SessionRegistry>,
    command_broker: Arc<CommandBroker>,
    auth_token: String,
    heartbeat_interval_secs: u64,
) -> anyhow::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    use crate::server::command_broker::WsMessageSender;
    use futures_util::StreamExt;
    use futures_util::SinkExt;

    let ws_stream = accept_async(stream).await?;
    let (mut write, mut read) = ws_stream.split();
    let mut handler = ConnectionHandler::new(
        agent_registry,
        session_registry,
        command_broker.clone(),
        auth_token,
        heartbeat_interval_secs,
    );

    // Create a channel-based sender for CommandBroker to send commands
    let (sender, mut rx) = WsMessageSender::new();

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
                    if let Err(e) = write.send(tokio_tungstenite::tungstenite::Message::Ping(Vec::new())).await {
                        error!("Failed to send WebSocket ping: {}", e);
                        break;
                    }
                }
            }
        }
    });

    while let Some(msg) = read.next().await {
        let msg = msg?;

        // Track agent registration changes
        let prev_agent_id = handler.registered_agent_id().cloned();

        let action = handler.handle_message(msg).await?;

        // If a new agent just registered, register its sender with CommandBroker
        let new_agent_id = handler.registered_agent_id().cloned();
        if new_agent_id.is_some() && new_agent_id != prev_agent_id {
            command_broker.register_agent(
                new_agent_id.as_ref().unwrap(),
                sender.clone(),
            ).await;
        }

        match action {
            HandlerAction::Reply(Some(response)) => {
                sender.send(response)?;
            }
            HandlerAction::Reply(None) => {
                // No response needed, continue
            }
            HandlerAction::Relay { agent_ws_url } => {
                relay_bidirectional_via_channel(&mut read, sender.clone(), &agent_ws_url).await?;
                break;
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

    // Drop the sender to signal the relay task to exit
    drop(sender);
    // Wait for the relay task to finish
    let _ = relay_task.await;

    Ok(())
}

/// Relay mode using channel-based sender for client writes.
/// Used when the write sink is managed by a relay task.
async fn relay_bidirectional_via_channel<RS>(
    client_read: &mut RS,
    sender: crate::server::command_broker::WsMessageSender,
    agent_ws_url: &str,
) -> anyhow::Result<()>
where
    RS: futures_util::Stream<Item = Result<tokio_tungstenite::tungstenite::Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    use futures_util::StreamExt;
    use futures_util::SinkExt;

    info!("Entering relay mode, connecting to agent at {}", agent_ws_url);

    let (agent_ws, _) = tokio_tungstenite::connect_async(agent_ws_url).await?;
    let (mut agent_write, mut agent_read) = agent_ws.split();

    info!("Relay connection established");

    // Forward client -> agent
    let client_to_agent = async {
        while let Some(msg) = client_read.next().await {
            match msg {
                Ok(msg) => {
                    if let Err(e) = agent_write.send(msg).await {
                        error!("Failed to forward client message to agent: {}", e);
                        break;
                    }
                }
                Err(e) => {
                    error!("Error reading from client: {}", e);
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
            info!("Client to agent relay ended");
        }
        _ = agent_to_client => {
            info!("Agent to client relay ended");
        }
    }

    info!("Relay mode ended");
    Ok(())
}
