use std::sync::Arc;
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::accept_async;
use tracing::{info, error};

use crate::registry::{AgentRegistry, SessionRegistry};
use nession_common::config::ServerConfig;
use super::handler::ConnectionHandler;

pub struct WebSocketServer {
    config: ServerConfig,
    agent_registry: Arc<AgentRegistry>,
    session_registry: Arc<SessionRegistry>,
    listener: Option<TcpListener>,
}

impl WebSocketServer {
    pub async fn new(config: ServerConfig) -> anyhow::Result<Self> {
        let listener = TcpListener::bind(&config.listen_address).await?;
        let agent_registry = Arc::new(AgentRegistry::new(config.heartbeat_timeout_secs));
        let session_registry = Arc::new(SessionRegistry::new());

        Ok(Self {
            config,
            agent_registry,
            session_registry,
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
            let auth_token = self.config.auth_token.clone();
            let tls_acceptor = tls_acceptor.clone();

            tokio::spawn(async move {
                if let Err(e) = handle_connection(
                    tcp_stream,
                    tls_acceptor,
                    agent_registry,
                    session_registry,
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
    auth_token: String,
) -> anyhow::Result<()> {
    if let Some(acceptor) = tls_acceptor {
        let tls_stream = acceptor.accept(tcp_stream).await?;
        handle_ws_stream(tls_stream, agent_registry, session_registry, auth_token).await
    } else {
        handle_ws_stream(tcp_stream, agent_registry, session_registry, auth_token).await
    }
}

async fn handle_ws_stream<S>(
    stream: S,
    agent_registry: Arc<AgentRegistry>,
    session_registry: Arc<SessionRegistry>,
    auth_token: String,
) -> anyhow::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let ws_stream = accept_async(stream).await?;
    let (mut write, mut read) = ws_stream.split();
    let mut handler = ConnectionHandler::new(agent_registry, session_registry, auth_token);

    use futures_util::StreamExt;
    while let Some(msg) = read.next().await {
        let msg = msg?;
        if let Some(response) = handler.handle_message(msg).await? {
            use futures_util::SinkExt;
            write.send(response).await?;
        }
    }

    Ok(())
}
