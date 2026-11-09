//! The standalone `nession-mcp` host (`#565`).
//!
//! It serves the same tool catalog as the embedded hosts, with explicit
//! backends: a Nession Server for the cluster tools and, optionally, one Agent
//! for `nession_agent_*`. It does not start or embed either of them.
//!
//! ```text
//! nession-mcp --config /etc/nession/mcp.toml
//! ```
//!
//! A failure in the MCP endpoint is logged and answered; it never terminates
//! the program. `SIGINT`/`SIGTERM` stops accepting and drops in-flight
//! connection tasks.

use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpListener;
use tokio::task::JoinSet;
use tokio_rustls::TlsAcceptor;
use tracing::{error, info, warn};

use nession_mcp::http::{self, Response, Sniffed};
use nession_mcp::service::McpService;
use nession_mcp::standalone::StandaloneConfig;

const CONFIG_ENV: &str = "NESSION_MCP_CONFIG";
const DEFAULT_CONFIG: &str = "mcp.toml";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_logging();
    let path = config_path();
    let config = StandaloneConfig::load(&path)?;
    let service = config.build_service()?;
    let tls = match config.tls_material()? {
        Some((cert, key)) => Some(build_tls_acceptor(&cert, &key)?),
        None => None,
    };

    let listener = TcpListener::bind(&config.mcp.listen_address)
        .await
        .map_err(|error| {
            anyhow::anyhow!(
                "failed to bind MCP listener {}: {error}",
                config.mcp.listen_address
            )
        })?;
    let local = listener.local_addr()?;
    info!(
        address = %local,
        path = service.path(),
        tls = tls.is_some(),
        "nession-mcp listening"
    );

    run(listener, tls, service).await
}

fn init_logging() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

fn config_path() -> PathBuf {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--config" {
            if let Some(path) = args.next() {
                return PathBuf::from(path);
            }
        }
        if let Some(path) = arg.strip_prefix("--config=") {
            return PathBuf::from(path);
        }
    }
    std::env::var_os(CONFIG_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG))
}

async fn run(
    listener: TcpListener,
    tls: Option<TlsAcceptor>,
    service: Arc<McpService>,
) -> anyhow::Result<()> {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            _ = shutdown_signal() => {
                info!("shutdown signal received; no longer accepting MCP connections");
                break;
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, address)) => {
                        let service = Arc::clone(&service);
                        let tls = tls.clone();
                        connections.spawn(async move {
                            if let Err(error) = handle_connection(stream, tls, service).await {
                                warn!(%address, %error, "MCP connection ended with an error");
                            }
                        });
                    }
                    Err(error) => {
                        // A refused accept is transient unless the listener is
                        // gone; log and keep serving rather than exiting on a
                        // resource-limit spike.
                        error!(%error, "MCP accept failed");
                    }
                }
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }

    connections.abort_all();
    while connections.join_next().await.is_some() {}
    Ok(())
}

async fn handle_connection(
    stream: tokio::net::TcpStream,
    tls: Option<TlsAcceptor>,
    service: Arc<McpService>,
) -> anyhow::Result<()> {
    let io = match tls {
        Some(acceptor) => Io::Tls(Box::new(acceptor.accept(stream).await?)),
        None => Io::Plain(stream),
    };

    match http::sniff(io, Duration::from_secs(10)).await {
        Ok(Sniffed::Http { head, body }) => service.serve(head, body).await?,
        Ok(Sniffed::WebSocket { mut stream }) => {
            // This listener is the MCP endpoint only; there is no terminal
            // WebSocket behind it.
            http::write_response(&mut stream, Response::empty(400)).await?;
        }
        Err(error) => {
            // A port probe or a scanner is expected noise, not an actionable
            // event; a malformed MCP request is answered (and logged) by the
            // service itself.
            tracing::debug!(%error, "offering a listener request");
        }
    }
    Ok(())
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    match signal(SignalKind::terminate()) {
        Ok(mut terminate) => {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = terminate.recv() => {}
            }
        }
        Err(_) => {
            let _ = tokio::signal::ctrl_c().await;
        }
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

fn build_tls_acceptor(cert_path: &str, key_path: &str) -> anyhow::Result<TlsAcceptor> {
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};
    use rustls::ServerConfig;
    use rustls_pemfile::{certs, private_key};
    use std::fs::File;
    use std::io::BufReader;

    let cert_file = File::open(cert_path)
        .map_err(|error| anyhow::anyhow!("could not open TLS certificate {cert_path}: {error}"))?;
    let mut cert_reader = BufReader::new(cert_file);
    let cert_chain: Vec<CertificateDer<'static>> =
        certs(&mut cert_reader).collect::<Result<Vec<_>, _>>()?;

    let key_file = File::open(key_path)
        .map_err(|error| anyhow::anyhow!("could not open TLS key {key_path}: {error}"))?;
    let mut key_reader = BufReader::new(key_file);
    let key: PrivateKeyDer<'static> =
        private_key(&mut key_reader)?.ok_or_else(|| anyhow::anyhow!("no private key found"))?;

    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(cert_chain, key)?;
    Ok(TlsAcceptor::from(Arc::new(config)))
}

/// Plain or TLS, so one connection handler serves both.
///
/// The TLS arm is boxed: the enum is moved through `sniff`'s generic stream
/// and clippy is right that an unboxed `TlsStream` makes every plain
/// connection carry the TLS variant's footprint.
enum Io {
    Plain(tokio::net::TcpStream),
    Tls(Box<tokio_rustls::server::TlsStream<tokio::net::TcpStream>>),
}

impl AsyncRead for Io {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_read(cx, buf),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for Io {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_write(cx, buf),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_flush(cx),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_shutdown(cx),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_shutdown(cx),
        }
    }
}
