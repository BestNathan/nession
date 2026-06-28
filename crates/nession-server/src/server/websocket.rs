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
) -> anyhow::Result<()> {
    if let Some(acceptor) = tls_acceptor {
        let tls_stream = acceptor.accept(tcp_stream).await?;
        handle_ws_stream(tls_stream, agent_registry, session_registry, command_broker, auth_token).await
    } else {
        handle_ws_stream(tcp_stream, agent_registry, session_registry, command_broker, auth_token).await
    }
}

async fn handle_ws_stream<S>(
    stream: S,
    agent_registry: Arc<AgentRegistry>,
    session_registry: Arc<SessionRegistry>,
    command_broker: Arc<CommandBroker>,
    auth_token: String,
) -> anyhow::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let ws_stream = accept_async(stream).await?;
    let (mut write, mut read) = ws_stream.split();
    let mut handler = ConnectionHandler::new(agent_registry, session_registry, command_broker, auth_token);

    use futures_util::StreamExt;
    use futures_util::SinkExt;

    while let Some(msg) = read.next().await {
        let msg = msg?;
        match handler.handle_message(msg).await? {
            HandlerAction::Reply(Some(response)) => {
                write.send(response).await?;
            }
            HandlerAction::Reply(None) => {
                // No response needed, continue
            }
            HandlerAction::Relay { agent_ws_url } => {
                // Enter relay mode: connect to agent and forward messages bidirectionally
                relay_bidirectional(&mut write, &mut read, &agent_ws_url).await?;
                break; // Exit main loop after relay
            }
            HandlerAction::Close => {
                break;
            }
        }
    }

    Ok(())
}

/// Relay mode: connect to agent WebSocket and forward messages bidirectionally
/// between client and agent.
async fn relay_bidirectional<WS, RS>(
    client_write: &mut WS,
    client_read: &mut RS,
    agent_ws_url: &str,
) -> anyhow::Result<()>
where
    WS: futures_util::Sink<tokio_tungstenite::tungstenite::Message> + Unpin,
    <WS as futures_util::Sink<tokio_tungstenite::tungstenite::Message>>::Error: std::fmt::Display,
    RS: futures_util::Stream<Item = Result<tokio_tungstenite::tungstenite::Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    use futures_util::StreamExt;
    use futures_util::SinkExt;

    info!("Entering relay mode, connecting to agent at {}", agent_ws_url);

    // Connect to agent WebSocket
    let (agent_ws, _) = tokio_tungstenite::connect_async(agent_ws_url).await?;
    let (mut agent_write, mut agent_read) = agent_ws.split();

    info!("Relay connection established");

    // Spawn task to forward client -> agent
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

    // Forward agent -> client in current task
    let agent_to_client = async {
        while let Some(msg) = agent_read.next().await {
            match msg {
                Ok(msg) => {
                    if let Err(e) = client_write.send(msg).await {
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

    // Run both directions concurrently, exit when either completes
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
