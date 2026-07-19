//! Agent WebSocket server implementation.
//!
//! Provides a [`AgentServer`] that listens for P2P client connections over
//! WebSocket (with optional TLS) and routes terminal I/O to/from per-client
//! PTY sessions. Also exposes session management operations (list, create,
//! kill) via the [`TmuxManager`].
//!
//! # Protocol
//!
//! All messages are JSON-encoded [`Message`] values exchanged as WebSocket
//! text frames. Each message carries a `msg_type` that determines how it is
//! dispatched:
//!
//! | Direction       | `msg_type`       | Purpose                          |
//! |-----------------|------------------|----------------------------------|
//! | client → agent  | `session.list`   | List tmux sessions               |
//! | client → agent  | `session.create` | Create a new tmux session        |
//! | client → agent  | `session.kill`   | Kill a tmux session              |
//! | client → agent  | `client.attach`  | Attach a PTY to a session        |
//! | client → agent  | `client.detach`  | Detach and close the PTY         |
//! | client → agent  | `terminal.input` | Send keystrokes to the PTY       |
//! | client → agent  | `terminal.resize`| Resize the PTY                   |
//! | agent → client  | `terminal.output`| PTY stdout data (base64)         |
//! | agent → client  | `error`          | Error response                   |
//! | agent → client  | `ok`             | Success response (with payload)  |

use crate::fs::ops::FileOps;
use crate::tmux::manager::{SessionInfo, TmuxManager};
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::WebSocketStream;
use tracing::{error, info, warn};

/// Per-connection map of attached tmux control-mode sessions, keyed by session name.
type SessionMap = std::collections::HashMap<String, crate::tmux::control::ControlModeSession>;

/// A stream that can be either plain TCP or TLS-wrapped.
#[allow(clippy::large_enum_variant)]
enum TcpOrTls {
    Plain(tokio::net::TcpStream),
    Tls(tokio_rustls::server::TlsStream<tokio::net::TcpStream>),
}

impl tokio::io::AsyncRead for TcpOrTls {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            TcpOrTls::Plain(s) => Pin::new(s).poll_read(cx, buf),
            TcpOrTls::Tls(s) => Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl tokio::io::AsyncWrite for TcpOrTls {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        match self.get_mut() {
            TcpOrTls::Plain(s) => Pin::new(s).poll_write(cx, buf),
            TcpOrTls::Tls(s) => Pin::new(s).poll_write(cx, buf),
        }
    }

    fn poll_flush(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            TcpOrTls::Plain(s) => Pin::new(s).poll_flush(cx),
            TcpOrTls::Tls(s) => Pin::new(s).poll_flush(cx),
        }
    }

    fn poll_shutdown(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            TcpOrTls::Plain(s) => Pin::new(s).poll_shutdown(cx),
            TcpOrTls::Tls(s) => Pin::new(s).poll_shutdown(cx),
        }
    }
}

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

/// Message type constants for the agent protocol.
pub mod msg_types {
    // Client → Agent
    pub const SESSION_LIST: &str = "session.list";
    pub const SESSION_CREATE: &str = "session.create";
    pub const SESSION_KILL: &str = "session.kill";
    pub const CLIENT_ATTACH: &str = "client.attach";
    pub const CLIENT_DETACH: &str = "client.detach";
    pub const TERMINAL_INPUT: &str = "terminal.input";
    pub const TERMINAL_RESIZE: &str = "terminal.resize";

    // Web UI → Agent (compatibility layer)
    pub const CLIENT_AUTH: &str = "client.auth";
    pub const CLIENT_AGENTS_LIST: &str = "client.agents.list";
    pub const CLIENT_SESSIONS_LIST: &str = "client.sessions.list";
    pub const CLIENT_SESSION_ATTACH: &str = "client.session.attach";
    pub const CLIENT_SESSION_CREATE: &str = "client.session.create";
    pub const CLIENT_SESSION_KILL: &str = "client.session.kill";

    // File operations
    pub const FILE_LIST: &str = "file.list";
    pub const FILE_READ: &str = "file.read";
    pub const FILE_WRITE: &str = "file.write";
    pub const FILE_DELETE: &str = "file.delete";
    pub const FILE_CREATE_DIR: &str = "file.create_dir";
    pub const FILE_RENAME: &str = "file.rename";

    // Keepalive (P2P client → agent)
    pub const KEEPALIVE_PING: &str = "keepalive.ping";
    pub const KEEPALIVE_PONG: &str = "keepalive.pong";

    // Agent → Client
    pub const TERMINAL_OUTPUT: &str = "terminal.output";
    pub const OK: &str = "ok";
    pub const ERROR: &str = "error";
}

/// Protocol message envelope. All messages share this shape; `payload`
/// varies by `msg_type`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message<P> {
    pub msg_type: String,
    pub id: String,
    pub timestamp: u64,
    pub payload: P,
}

// --- Request payloads (client → agent) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionCreatePayload {
    pub name: String,
    #[serde(default = "default_width")]
    pub width: u16,
    #[serde(default = "default_height")]
    pub height: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionKillPayload {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientAttachPayload {
    pub session_name: String,
    #[serde(default = "default_width")]
    pub width: u16,
    #[serde(default = "default_height")]
    pub height: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientDetachPayload {
    pub session_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalInputPayload {
    pub session_name: String,
    /// Base64-encoded binary data.
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalResizePayload {
    pub session_name: String,
    pub width: u16,
    pub height: u16,
}

fn default_width() -> u16 {
    80
}
fn default_height() -> u16 {
    24
}

// --- Web UI compatibility payloads ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientAuthPayload {
    #[serde(default)]
    pub auth_token: String,
    #[serde(default)]
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthResponsePayload {
    pub status: String,
    pub message: String,
    pub client_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebAgentInfo {
    pub agent_id: String,
    pub hostname: String,
    pub ip_address: String,
    pub port: u16,
    pub status: String,
    pub session_count: u32,
    pub last_heartbeat: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebAgentsListResponse {
    pub agents: Vec<WebAgentInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSessionInfo {
    pub session_id: String,
    pub agent_id: String,
    pub session_name: String,
    pub status: String,
    pub window_count: u32,
    pub attached_clients: u32,
    pub last_activity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSessionsListResponse {
    pub sessions: Vec<WebSessionInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSessionAttachPayload {
    pub session_id: String,
    #[serde(default = "default_p2p")]
    pub preferred_mode: String,
}

fn default_p2p() -> String {
    "p2p".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebAttachInfo {
    pub mode: String,
    pub session_id: String,
    pub session_name: String,
    pub agent_address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSessionCreatePayload {
    pub agent_id: String,
    pub name: String,
    #[serde(default = "default_width")]
    pub width: u16,
    #[serde(default = "default_height")]
    pub height: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSessionCreateResponse {
    pub success: bool,
    pub session_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSessionKillPayload {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSessionKillResponse {
    pub success: bool,
    pub error: Option<String>,
}

// --- Response payloads (agent → client) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionListResponse {
    pub sessions: Vec<SessionInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionCreateResponse {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionKillResponse {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientAttachResponse {
    pub session_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientDetachResponse {
    pub session_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalOutputPayload {
    pub session_name: String,
    /// Base64-encoded binary data.
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OkPayload {
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
}

// --- File operation payloads ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileListPayload {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileReadPayload {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileWritePayload {
    pub path: String,
    /// Base64-encoded content.
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileWriteResponse {
    pub path: String,
    pub written: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDeletePayload {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileCreateDirPayload {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRenamePayload {
    pub from: String,
    pub to: String,
}

// --- Protocol helpers ---

fn now_timestamp() -> u64 {
    chrono::Utc::now().timestamp().unsigned_abs()
}

/// Extract the tmux session name from a web UI session_id.
/// Web UI uses "agent_id:session_name" format; strip the prefix if present.
fn extract_session_name(session_id: &str) -> String {
    session_id
        .split_once(':')
        .map(|(_, name)| name.to_string())
        .unwrap_or_else(|| session_id.to_string())
}

/// Parse a `host:port` listen address into an (ip, port) tuple.
/// Supports both IPv4 (`0.0.0.0:9090`) and IPv6 (`[::1]:9090`) formats.
/// Falls back to `("127.0.0.1", 9090)` on parse failure.
fn parse_listen_address(addr: &str) -> (String, u16) {
    match addr.parse::<std::net::SocketAddr>() {
        Ok(sa) => (sa.ip().to_string(), sa.port()),
        Err(_) => {
            warn!(
                "failed to parse listen_address '{}', falling back to 127.0.0.1:9090",
                addr
            );
            ("127.0.0.1".to_string(), 9090)
        }
    }
}

/// Query tmux for the current window size of `session_name` using
/// `tmux display-message -p -t <session> '#{window_width} #{window_height}'`.
///
/// Returns `(cols, rows)`. Errors if the command fails, the output cannot
/// be parsed, or the two dimensions cannot both be read as `u16`.
async fn query_window_size(session_name: &str) -> Result<(u16, u16)> {
    let output = tokio::process::Command::new("tmux")
        .args([
            "display-message",
            "-p",
            "-t",
            session_name,
            "#{window_width} #{window_height}",
        ])
        .output()
        .await
        .with_context(|| format!("failed to spawn tmux display-message for {session_name}"))?;
    if !output.status.success() {
        anyhow::bail!(
            "tmux display-message exited with status {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut parts = text.split_whitespace();
    let cols: u16 = parts
        .next()
        .context("no width in display-message output")?
        .parse()
        .context("failed to parse window width")?;
    let rows: u16 = parts
        .next()
        .context("no height in display-message output")?
        .parse()
        .context("failed to parse window height")?;
    Ok((cols, rows))
}

/// Send a single `terminal.resize` message on the shared WebSocket sink.
/// Returns `true` on success, `false` if the sink is closed (in which case
/// the caller should stop forwarding).
async fn send_terminal_resize_msg(
    sink: &Arc<Mutex<futures_util::stream::SplitSink<WebSocketStream<TcpOrTls>, WsMessage>>>,
    session_name: &str,
    cols: u16,
    rows: u16,
) -> bool {
    let payload = TerminalResizePayload {
        session_name: session_name.to_string(),
        width: cols,
        height: rows,
    };
    let msg = new_message(msg_types::TERMINAL_RESIZE, payload);
    let Ok(json) = serde_json::to_string(&msg) else {
        return true;
    };
    let mut s = sink.lock().await;
    s.send(WsMessage::Text(json)).await.is_ok()
}

pub fn new_message<P: Serialize>(msg_type: &str, payload: P) -> Message<P> {
    Message {
        msg_type: msg_type.to_string(),
        id: uuid::Uuid::new_v4().to_string(),
        timestamp: now_timestamp(),
        payload,
    }
}

/// Create a response message that echoes the request ID for correlation.
fn make_response<P: Serialize>(request_id: &str, msg_type: &str, payload: P) -> Message<P> {
    Message {
        msg_type: msg_type.to_string(),
        id: request_id.to_string(),
        timestamp: now_timestamp(),
        payload,
    }
}

fn make_error(request_id: &str, code: &str, message: &str) -> Message<ErrorPayload> {
    Message {
        msg_type: msg_types::ERROR.to_string(),
        id: request_id.to_string(),
        timestamp: now_timestamp(),
        payload: ErrorPayload {
            code: code.to_string(),
            message: message.to_string(),
        },
    }
}

fn make_ok(request_id: &str, message: &str) -> Message<OkPayload> {
    Message {
        msg_type: msg_types::OK.to_string(),
        id: request_id.to_string(),
        timestamp: now_timestamp(),
        payload: OkPayload {
            message: message.to_string(),
        },
    }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/// WebSocket server that accepts P2P client connections and routes
/// terminal I/O to/from per-client PTY sessions.
pub struct AgentServer {
    tmux_manager: TmuxManager,
    file_ops: Arc<FileOps>,
    shutdown_tx: mpsc::Sender<()>,
    shutdown_rx: Option<mpsc::Receiver<()>>,
    tls_acceptor: Option<tokio_rustls::TlsAcceptor>,
    listen_address: String,
    agent_id: String,
    /// Default working directory for new tmux sessions created via P2P.
    default_working_dir: String,
}

/// Handle to a running [`AgentServer`]. Clone and keep around to request
/// a graceful shutdown. When all handles are dropped the server keeps
/// running until the process exits; call [`ServerHandle::shutdown`] to
/// stop it explicitly.
#[derive(Clone)]
pub struct ServerHandle {
    shutdown_tx: mpsc::Sender<()>,
}

impl ServerHandle {
    /// Request the server to stop accepting new connections and shut down.
    pub async fn shutdown(&self) -> Result<()> {
        self.shutdown_tx
            .send(())
            .await
            .context("failed to send shutdown signal")
    }
}

impl AgentServer {
    /// Create a new agent server.
    ///
    /// `listen_address` is a `host:port` string (e.g. `"0.0.0.0:8080"`).
    /// `agent_id` is the unique identifier for this agent.
    /// Pass `None` for `tls` to run without TLS (plain WebSocket).
    /// `default_working_dir` is the working directory for new tmux sessions.
    /// `file_root` is the sandbox root for file operations.
    pub fn new(
        listen_address: impl Into<String>,
        agent_id: impl Into<String>,
        tls: Option<(
            Vec<rustls::pki_types::CertificateDer<'static>>,
            rustls::pki_types::PrivateKeyDer<'static>,
        )>,
        default_working_dir: String,
        file_root: &str,
    ) -> Result<Self> {
        let tls_acceptor = match tls {
            Some((certs, key)) => {
                let config = tokio_rustls::rustls::ServerConfig::builder()
                    .with_no_client_auth()
                    .with_single_cert(certs, key)
                    .context("failed to build TLS config")?;
                Some(tokio_rustls::TlsAcceptor::from(Arc::new(config)))
            }
            None => None,
        };

        let (shutdown_tx, shutdown_rx) = mpsc::channel(1);

        let sandbox = crate::fs::sandbox::PathSandbox::new(file_root)
            .context("failed to create file sandbox")?;
        let file_ops = Arc::new(crate::fs::ops::FileOps::new(sandbox));

        Ok(Self {
            tmux_manager: TmuxManager::new(),
            file_ops,
            shutdown_tx,
            shutdown_rx: Some(shutdown_rx),
            tls_acceptor,
            listen_address: listen_address.into(),
            agent_id: agent_id.into(),
            default_working_dir,
        })
    }

    /// Start accepting connections. Returns a [`ServerHandle`] that can be
    /// used to trigger a graceful shutdown. The server runs as a background
    /// tokio task until shutdown is signalled or the process exits.
    pub async fn start(mut self) -> Result<ServerHandle> {
        let listener = TcpListener::bind(&self.listen_address)
            .await
            .with_context(|| format!("failed to bind {}", self.listen_address))?;

        let shutdown_rx = self
            .shutdown_rx
            .take()
            .ok_or_else(|| anyhow::anyhow!("shutdown_rx taken twice"))?;
        let handle = ServerHandle {
            shutdown_tx: self.shutdown_tx.clone(),
        };

        let tmux_manager = Arc::new(self.tmux_manager);
        let file_ops = Arc::clone(&self.file_ops);
        let tls_acceptor = self.tls_acceptor;
        let default_working_dir = self.default_working_dir.clone();
        let listen_address = self.listen_address.clone();
        let agent_id = self.agent_id.clone();

        tokio::spawn(async move {
            let shutdown_rx = Mutex::new(shutdown_rx);
            info!("Agent WebSocket server listening on {}", listen_address);

            loop {
                let shutdown_future = async {
                    let mut rx = shutdown_rx.lock().await;
                    rx.recv().await
                };
                tokio::select! {
                    accept_result = listener.accept() => {
                        match accept_result {
                            Ok((stream, addr)) => {
                                let tmux = Arc::clone(&tmux_manager);
                                let fops = Arc::clone(&file_ops);
                                let tls = tls_acceptor.clone();
                                let wd = default_working_dir.clone();
                                let la = listen_address.clone();
                                let aid = agent_id.clone();
                                tokio::spawn(async move {
                                    if let Err(e) =
                                        Self::handle_connection(stream, addr, tmux, tls, wd, fops, &la, &aid).await
                                    {
                                        warn!("connection error from {}: {:#}", addr, e);
                                    }
                                });
                            }
                            Err(e) => {
                                error!("accept error: {:#}", e);
                            }
                        }
                    }
                    _ = shutdown_future => {
                        info!("Agent WebSocket server shutting down");
                        break;
                    }
                }
            }
        });

        Ok(handle)
    }

    /// Handle a single incoming TCP connection. Performs optional TLS
    /// handshake, upgrades to WebSocket, then enters the per-client
    /// message loop.
    #[allow(clippy::too_many_arguments)]
    async fn handle_connection(
        stream: tokio::net::TcpStream,
        addr: SocketAddr,
        tmux_manager: Arc<TmuxManager>,
        tls_acceptor: Option<tokio_rustls::TlsAcceptor>,
        default_working_dir: String,
        file_ops: Arc<FileOps>,
        listen_address: &str,
        agent_id: &str,
    ) -> Result<()> {
        // Box the underlying stream so that TLS and plain connections
        // share a single WebSocket stream type.
        let io: TcpOrTls = if let Some(acceptor) = tls_acceptor {
            let tls_stream = acceptor
                .accept(stream)
                .await
                .context("TLS handshake failed")?;
            info!("TLS connection established from {}", addr);
            TcpOrTls::Tls(tls_stream)
        } else {
            TcpOrTls::Plain(stream)
        };

        let ws = tokio_tungstenite::accept_async(io)
            .await
            .context("WebSocket upgrade failed")?;
        let (ws_sink, ws_stream) = ws.split();

        info!("WebSocket connection from {}", addr);

        // Shared sink so that `handle_request` (which may be invoked for
        // multiple concurrent requests via the terminal I/O task) can
        // send messages back to the client.
        let sink = Arc::new(Mutex::new(ws_sink));
        // Per-client attached PTY sessions keyed by session name.
        let sessions: Arc<Mutex<SessionMap>> =
            Arc::new(Mutex::new(std::collections::HashMap::new()));
        // Per-connection client ID (set during CLIENT_AUTH handshake)
        let client_id: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        Self::run_message_loop(
            ws_stream,
            sink,
            tmux_manager,
            sessions,
            client_id.clone(),
            addr,
            default_working_dir,
            file_ops,
            listen_address,
            agent_id,
        )
        .await
    }

    /// Drain incoming WebSocket frames and dispatch them.
    #[allow(clippy::too_many_arguments)]
    async fn run_message_loop(
        mut ws_stream: futures_util::stream::SplitStream<WebSocketStream<TcpOrTls>>,
        sink: Arc<Mutex<futures_util::stream::SplitSink<WebSocketStream<TcpOrTls>, WsMessage>>>,
        tmux: Arc<TmuxManager>,
        sessions: Arc<Mutex<SessionMap>>,
        client_id: Arc<Mutex<Option<String>>>,
        addr: SocketAddr,
        default_working_dir: String,
        file_ops: Arc<FileOps>,
        listen_address: &str,
        agent_id: &str,
    ) -> Result<()> {
        while let Some(msg) = ws_stream.next().await {
            let msg = match msg {
                Ok(m) => m,
                Err(e) => {
                    warn!("WebSocket read error from {}: {:#}", addr, e);
                    break;
                }
            };

            match msg {
                WsMessage::Text(text) => {
                    let response = Self::handle_request(
                        &text,
                        tmux.clone(),
                        sessions.clone(),
                        client_id.clone(),
                        sink.clone(),
                        &default_working_dir,
                        file_ops.clone(),
                        listen_address,
                        agent_id,
                    )
                    .await;
                    let mut s = sink.lock().await;
                    if let Err(e) = s.send(WsMessage::Text(response)).await {
                        warn!("WebSocket write error to {}: {:#}", addr, e);
                        break;
                    }
                }
                WsMessage::Close(_) => {
                    info!("Client {} sent close frame", addr);
                    break;
                }
                WsMessage::Ping(data) => {
                    let mut s = sink.lock().await;
                    let _ = s.send(WsMessage::Pong(data)).await;
                }
                // Pong, Binary, and Frame are ignored.
                _ => {}
            }
        }

        // Close any PTY sessions that were attached through this
        // connection so that the underlying tmux attach children are
        // terminated promptly.
        let mut sessions_guard = sessions.lock().await;
        for (name, mut session) in sessions_guard.drain() {
            if let Err(e) = session.close().await {
                warn!("Error closing control session {}: {:#}", name, e);
            }
        }

        // Clean up any env scripts sourced by this client
        let client_id_guard = client_id.lock().await;
        if let Some(ref cid) = *client_id_guard {
            tmux.cleanup_client_scripts(cid).await;
            info!("Cleaned up env scripts for client {}", cid);
        }

        info!("Client {} disconnected", addr);
        Ok(())
    }

    /// Route a single text request to the appropriate handler.
    #[allow(clippy::too_many_arguments)]
    async fn handle_request(
        text: &str,
        tmux: Arc<TmuxManager>,
        sessions: Arc<Mutex<SessionMap>>,
        client_id: Arc<Mutex<Option<String>>>,
        sink: Arc<Mutex<futures_util::stream::SplitSink<WebSocketStream<TcpOrTls>, WsMessage>>>,
        default_working_dir: &str,
        file_ops: Arc<FileOps>,
        listen_address: &str,
        agent_id: &str,
    ) -> String {
        // Try to extract msg_type and id without fully deserialising the
        // payload — we need those even if the payload type is unknown.
        let raw: serde_json::Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => {
                return serde_json::to_string(&make_error(
                    "unknown",
                    "parse_error",
                    &format!("invalid JSON: {e}"),
                ))
                .unwrap_or_default();
            }
        };

        let msg_type = raw
            .get("msg_type")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let id = raw
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        // Extract the payload field for deserialisation. Requests that
        // don't need a payload (e.g. session.list) can ignore this.
        let payload_value = raw
            .get("payload")
            .cloned()
            .unwrap_or(serde_json::Value::Null);

        // Helper for building error responses without repeating the
        // serde dance.
        let err = |code: &str, msg: &str| -> String {
            serde_json::to_string(&make_error(&id, code, msg)).unwrap_or_default()
        };

        match msg_type {
            msg_types::SESSION_LIST => match tmux.list_sessions().await {
                Ok(sessions_list) => {
                    let payload = SessionListResponse {
                        sessions: sessions_list,
                    };
                    serde_json::to_string(&make_response(&id, msg_types::OK, payload))
                        .unwrap_or_default()
                }
                Err(e) => err("list_failed", &e.to_string()),
            },

            msg_types::SESSION_CREATE => {
                let payload: SessionCreatePayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return err("parse_error", &e.to_string()),
                };
                match tmux
                    .create_session(
                        &payload.name,
                        payload.width,
                        payload.height,
                        default_working_dir,
                        &[],
                    )
                    .await
                {
                    Ok(()) => {
                        let resp = SessionCreateResponse { name: payload.name };
                        serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    Err(e) => err("create_failed", &e.to_string()),
                }
            }

            msg_types::SESSION_KILL => {
                let payload: SessionKillPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return err("parse_error", &e.to_string()),
                };
                match tmux.kill_session(&payload.name).await {
                    Ok(()) => {
                        let resp = SessionKillResponse { name: payload.name };
                        serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    Err(e) => err("kill_failed", &e.to_string()),
                }
            }

            msg_types::CLIENT_ATTACH => {
                let payload: ClientAttachPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return err("parse_error", &e.to_string()),
                };
                match crate::tmux::control::ControlModeSession::attach(
                    &payload.session_name,
                    payload.width,
                    payload.height,
                )
                .await
                {
                    Ok((session, mut output_rx, mut resize_rx)) => {
                        let session_name = payload.session_name.clone();
                        sessions.lock().await.insert(session_name.clone(), session);

                        // Spawn a background task that consumes the output
                        // channel from the control-mode subprocess and
                        // forwards bytes to the client as `terminal.output`
                        // messages.
                        let sink_clone = Arc::clone(&sink);
                        let session_name_clone = session_name.clone();
                        tokio::spawn(async move {
                            while let Some(bytes) = output_rx.recv().await {
                                use base64::Engine;
                                let encoded =
                                    base64::engine::general_purpose::STANDARD.encode(&bytes);
                                let output = TerminalOutputPayload {
                                    session_name: session_name_clone.clone(),
                                    data: encoded,
                                };
                                let msg = new_message(msg_types::TERMINAL_OUTPUT, output);
                                if let Ok(json) = serde_json::to_string(&msg) {
                                    let mut s = sink_clone.lock().await;
                                    if s.send(WsMessage::Text(json)).await.is_err() {
                                        break;
                                    }
                                }
                            }
                            // Channel closed — tmux subprocess exited or
                            // session was closed by the detach handler.
                        });

                        // Spawn a second task that emits an initial
                        // `terminal.resize` (so xterm.js can size its grid
                        // to match the tmux pane before any output flows
                        // in) and then forwards ongoing `%window-resize`
                        // events on the same message type.
                        //
                        // TODO(follow-up): also forward these events upstream
                        // to the central server via
                        // `sync::terminal::send_terminal_resize` so relay
                        // clients (browser → server → agent) see the same
                        // size updates. That requires threading a
                        // `TransportSink` through here and is intentionally
                        // deferred to keep this diff focused on the P2P path.
                        let sink_resize = Arc::clone(&sink);
                        let session_name_resize = session_name.clone();
                        tokio::spawn(async move {
                            // Initial resize: query tmux for the pane's
                            // current size and forward it as one message.
                            // Runs inside the spawned task so the attach
                            // OK response reaches the client first.
                            match query_window_size(&session_name_resize).await {
                                Ok((cols, rows)) => {
                                    send_terminal_resize_msg(
                                        &sink_resize,
                                        &session_name_resize,
                                        cols,
                                        rows,
                                    )
                                    .await;
                                }
                                Err(e) => warn!(
                                    "failed to query initial window size for {}: {:#}",
                                    session_name_resize, e
                                ),
                            }
                            while let Some((cols, rows)) = resize_rx.recv().await {
                                if !send_terminal_resize_msg(
                                    &sink_resize,
                                    &session_name_resize,
                                    cols,
                                    rows,
                                )
                                .await
                                {
                                    break;
                                }
                            }
                        });

                        let resp = ClientAttachResponse {
                            session_name: payload.session_name,
                        };
                        serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    Err(e) => err("attach_failed", &e.to_string()),
                }
            }

            msg_types::CLIENT_DETACH => {
                let payload: ClientDetachPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return err("parse_error", &e.to_string()),
                };
                let removed = sessions.lock().await.remove(&payload.session_name);
                match removed {
                    Some(mut session) => {
                        if let Err(e) = session.close().await {
                            warn!(
                                "Error closing control session for {}: {:#}",
                                payload.session_name, e
                            );
                        }
                        let resp = ClientDetachResponse {
                            session_name: payload.session_name,
                        };
                        serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    None => err(
                        "not_attached",
                        &format!("not attached to session: {}", payload.session_name),
                    ),
                }
            }

            msg_types::TERMINAL_INPUT => {
                let payload: TerminalInputPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return err("parse_error", &e.to_string()),
                };
                use base64::Engine;
                let data = match base64::engine::general_purpose::STANDARD.decode(&payload.data) {
                    Ok(d) => d,
                    Err(e) => return err("decode_error", &e.to_string()),
                };
                let mut sessions_guard = sessions.lock().await;
                match sessions_guard.get_mut(&payload.session_name) {
                    Some(session) => match session.write_input(&data).await {
                        Ok(_) => serde_json::to_string(&make_ok(&id, "ok")).unwrap_or_default(),
                        Err(e) => err("write_error", &e.to_string()),
                    },
                    None => err(
                        "not_attached",
                        &format!("not attached to session: {}", payload.session_name),
                    ),
                }
            }

            msg_types::TERMINAL_RESIZE => {
                let payload: TerminalResizePayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return err("parse_error", &e.to_string()),
                };
                let mut sessions_guard = sessions.lock().await;
                match sessions_guard.get_mut(&payload.session_name) {
                    Some(session) => match session.resize(payload.width, payload.height).await {
                        Ok(_) => serde_json::to_string(&make_ok(&id, "ok")).unwrap_or_default(),
                        Err(e) => err("resize_error", &e.to_string()),
                    },
                    None => err(
                        "not_attached",
                        &format!("not attached to session: {}", payload.session_name),
                    ),
                }
            }

            // --- Web UI compatibility handlers ---
            msg_types::CLIENT_AUTH => {
                let payload: ClientAuthPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => {
                        warn!("Invalid client.auth payload: {e}");
                        let resp = AuthResponsePayload {
                            status: "error".to_string(),
                            message: format!("invalid payload: {e}"),
                            client_id: String::new(),
                        };
                        return serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                            .unwrap_or_default();
                    }
                };

                // Use provided client_id or generate a new one
                let assigned_client_id = payload
                    .client_id
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

                // Store the client_id for this connection
                {
                    let mut cid = client_id.lock().await;
                    *cid = Some(assigned_client_id.clone());
                }

                let resp = AuthResponsePayload {
                    status: "success".to_string(),
                    message: "ok".to_string(),
                    client_id: assigned_client_id,
                };
                serde_json::to_string(&make_response(&id, msg_types::OK, resp)).unwrap_or_default()
            }

            msg_types::CLIENT_AGENTS_LIST => match tmux.list_sessions().await {
                Ok(sessions_list) => {
                    let hostname =
                        std::env::var("HOSTNAME").unwrap_or_else(|_| "localhost".to_string());
                    let (ip, port) = parse_listen_address(listen_address);
                    let agent = WebAgentInfo {
                        agent_id: agent_id.to_string(),
                        hostname,
                        ip_address: ip,
                        port,
                        status: "online".to_string(),
                        session_count: u32::try_from(sessions_list.len()).unwrap_or(0),
                        last_heartbeat: chrono::Utc::now().to_rfc3339(),
                    };
                    let resp = WebAgentsListResponse {
                        agents: vec![agent],
                    };
                    serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                        .unwrap_or_default()
                }
                Err(e) => err("list_failed", &e.to_string()),
            },

            msg_types::CLIENT_SESSIONS_LIST => match tmux.list_sessions().await {
                Ok(sessions_list) => {
                    let sessions: Vec<WebSessionInfo> = sessions_list
                        .into_iter()
                        .map(|s| {
                            let session_id = format!("{}:{}", agent_id, s.name);
                            WebSessionInfo {
                                session_id,
                                agent_id: agent_id.to_string(),
                                session_name: s.name,
                                status: if s.attached_clients > 0 {
                                    "active".to_string()
                                } else {
                                    "detached".to_string()
                                },
                                window_count: s.window_count,
                                attached_clients: s.attached_clients,
                                last_activity: chrono::Utc::now().to_rfc3339(),
                            }
                        })
                        .collect();
                    let resp = WebSessionsListResponse { sessions };
                    serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                        .unwrap_or_default()
                }
                Err(e) => err("list_failed", &e.to_string()),
            },

            msg_types::CLIENT_SESSION_ATTACH => {
                let payload: WebSessionAttachPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return err("parse_error", &e.to_string()),
                };
                let session_name = extract_session_name(&payload.session_id);
                let resp = WebAttachInfo {
                    mode: "p2p".to_string(),
                    session_id: payload.session_id,
                    session_name,
                    agent_address: listen_address.to_string(),
                };
                serde_json::to_string(&make_response(&id, msg_types::OK, resp)).unwrap_or_default()
            }

            msg_types::CLIENT_SESSION_CREATE => {
                let payload: WebSessionCreatePayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => {
                        let resp = WebSessionCreateResponse {
                            success: false,
                            session_id: None,
                            error: Some(e.to_string()),
                        };
                        return serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                            .unwrap_or_default();
                    }
                };
                match tmux
                    .create_session(
                        &payload.name,
                        payload.width,
                        payload.height,
                        default_working_dir,
                        &[],
                    )
                    .await
                {
                    Ok(()) => {
                        let session_id = format!("{}:{}", agent_id, payload.name);
                        let resp = WebSessionCreateResponse {
                            success: true,
                            session_id: Some(session_id),
                            error: None,
                        };
                        serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    Err(e) => {
                        let resp = WebSessionCreateResponse {
                            success: false,
                            session_id: None,
                            error: Some(e.to_string()),
                        };
                        serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                }
            }

            msg_types::CLIENT_SESSION_KILL => {
                let payload: WebSessionKillPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => {
                        let resp = WebSessionKillResponse {
                            success: false,
                            error: Some(e.to_string()),
                        };
                        return serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                            .unwrap_or_default();
                    }
                };
                let session_name = extract_session_name(&payload.session_id);
                match tmux.kill_session(&session_name).await {
                    Ok(()) => {
                        let resp = WebSessionKillResponse {
                            success: true,
                            error: None,
                        };
                        serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    Err(e) => {
                        let resp = WebSessionKillResponse {
                            success: false,
                            error: Some(e.to_string()),
                        };
                        serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                }
            }

            // --- Keepalive ---
            msg_types::KEEPALIVE_PING => {
                serde_json::to_string(&make_response(&id, msg_types::KEEPALIVE_PONG, ()))
                    .unwrap_or_default()
            }

            // --- File operations ---
            msg_types::FILE_LIST => {
                let payload: FileListPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return err("parse_error", &e.to_string()),
                };
                match file_ops.list_dir(&payload.path).await {
                    Ok(entries) => {
                        let resp = serde_json::json!({ "entries": entries });
                        serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    Err(e) => err("list_failed", &e.to_string()),
                }
            }

            msg_types::FILE_READ => {
                let payload: FileReadPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return err("parse_error", &e.to_string()),
                };
                match file_ops.read_file(&payload.path).await {
                    Ok(data) => serde_json::to_string(&make_response(&id, msg_types::OK, data))
                        .unwrap_or_default(),
                    Err(e) => {
                        let msg = e.to_string();
                        if msg.contains("permission_denied") {
                            err("permission_denied", &msg)
                        } else if msg.contains("is_directory") {
                            err("is_directory", &msg)
                        } else if msg.contains("file_too_large") {
                            err("file_too_large", &msg)
                        } else {
                            err("io_error", &msg)
                        }
                    }
                }
            }

            msg_types::FILE_WRITE => {
                let payload: FileWritePayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return err("parse_error", &e.to_string()),
                };
                let path = payload.path.clone();
                match file_ops.write_file(&payload.path, &payload.content).await {
                    Ok(written) => {
                        let resp = FileWriteResponse { path, written };
                        serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    Err(e) => err("write_error", &e.to_string()),
                }
            }

            msg_types::FILE_DELETE => {
                let payload: FileDeletePayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return err("parse_error", &e.to_string()),
                };
                let path = payload.path.clone();
                match file_ops.delete(&payload.path).await {
                    Ok(()) => {
                        let resp = serde_json::json!({ "path": path, "success": true });
                        serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    Err(e) => err("delete_failed", &e.to_string()),
                }
            }

            msg_types::FILE_CREATE_DIR => {
                let payload: FileCreateDirPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return err("parse_error", &e.to_string()),
                };
                let path = payload.path.clone();
                match file_ops.create_dir(&payload.path).await {
                    Ok(()) => {
                        let resp = serde_json::json!({ "path": path, "success": true });
                        serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    Err(e) => err("create_dir_failed", &e.to_string()),
                }
            }

            msg_types::FILE_RENAME => {
                let payload: FileRenamePayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return err("parse_error", &e.to_string()),
                };
                let from = payload.from.clone();
                let to = payload.to.clone();
                match file_ops.rename(&payload.from, &payload.to).await {
                    Ok(()) => {
                        let resp = serde_json::json!({ "from": from, "to": to, "success": true });
                        serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    Err(e) => err("rename_failed", &e.to_string()),
                }
            }

            unknown => err(
                "unknown_message_type",
                &format!("unknown message type: {unknown}"),
            ),
        }
    }

    /// Build a TLS acceptor from PEM file paths. Returns `None` if both
    /// paths are `None`. Errors if only one is set or the files cannot be
    /// parsed.
    pub fn load_tls(
        cert_path: Option<&str>,
        key_path: Option<&str>,
    ) -> Result<
        Option<(
            Vec<rustls::pki_types::CertificateDer<'static>>,
            rustls::pki_types::PrivateKeyDer<'static>,
        )>,
    > {
        match (cert_path, key_path) {
            (Some(cert_path), Some(key_path)) => {
                let cert_file =
                    std::fs::File::open(cert_path).context("failed to open TLS cert file")?;
                let key_file =
                    std::fs::File::open(key_path).context("failed to open TLS key file")?;

                let mut cert_reader = std::io::BufReader::new(cert_file);
                let mut key_reader = std::io::BufReader::new(key_file);

                let certs: Vec<rustls::pki_types::CertificateDer<'static>> =
                    rustls_pemfile::certs(&mut cert_reader)
                        .collect::<Result<_, _>>()
                        .context("failed to parse TLS certificates")?;

                let key = rustls::pki_types::PrivateKeyDer::Pkcs8(
                    rustls_pemfile::pkcs8_private_keys(&mut key_reader)
                        .next()
                        .context("no PKCS8 private key found")?
                        .context("failed to parse TLS private key")?,
                );

                Ok(Some((certs, key)))
            }
            (None, None) => Ok(None),
            _ => anyhow::bail!("both cert_path and key_path must be set (or both unset)"),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::ops::FileData;
    use base64::Engine;
    use futures_util::SinkExt;
    use tokio_tungstenite::connect_async;
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    /// Start a test server on an ephemeral port and return a handle for
    /// shutdown. Note: the bound address uses port 0, so this helper is
    /// only useful for tests that don't need to connect (e.g. verifying
    /// server construction and shutdown).
    #[allow(dead_code)]
    async fn start_test_server() -> (SocketAddr, ServerHandle) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let server = AgentServer::new(
            "127.0.0.1:0",
            "test-agent",
            None,
            "/tmp".to_string(),
            tmp.path().to_string_lossy().as_ref(),
        )
        .expect("server creation should succeed");
        // Leak the TempDir so the sandbox root persists for the server lifetime.
        Box::leak(Box::new(tmp));
        let handle = server.start().await.expect("start should succeed");
        // Give the accept loop a moment to bind.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        // The port is already bound (we got past bind()), but we don't
        // know it from here. Tests that need the real port should use
        // a known free port instead. For now, 0 won't work for client
        // connections — callers must use `start_test_server_on` with a
        // specific port.
        //
        // This helper is only useful for tests that just verify
        // server construction and shutdown.
        ("127.0.0.1:0".parse().unwrap(), handle)
    }

    /// Start a test server on a specific port. Use this for tests that
    /// need to actually connect.
    async fn start_test_server_on(port: u16) -> (SocketAddr, ServerHandle) {
        let addr_str = format!("127.0.0.1:{}", port);
        let tmp = tempfile::tempdir().expect("tempdir");
        let server = AgentServer::new(
            &addr_str,
            "test-agent",
            None,
            "/tmp".to_string(),
            tmp.path().to_string_lossy().as_ref(),
        )
        .expect("server creation should succeed");
        // Leak the TempDir so the sandbox root persists for the server lifetime.
        Box::leak(Box::new(tmp));
        let handle = server.start().await.expect("start should succeed");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        (addr_str.parse().unwrap(), handle)
    }

    /// Connect a WebSocket client to a test server.
    async fn connect_client(
        addr: SocketAddr,
    ) -> (
        futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            WsMessage,
        >,
        futures_util::stream::SplitStream<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
        >,
    ) {
        let url = format!("ws://{}", addr);
        let (ws_stream, _response) = connect_async(&url).await.expect("connect should succeed");
        ws_stream.split()
    }

    /// Send a JSON request and receive the matching JSON response.
    /// Skips over unsolicited messages (e.g., terminal.output) that may
    /// arrive from background tasks.
    async fn send_and_receive<S, R>(
        sink: &mut futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            WsMessage,
        >,
        stream: &mut futures_util::stream::SplitStream<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
        >,
        request: &Message<S>,
    ) -> Message<R>
    where
        S: Serialize,
        R: for<'de> Deserialize<'de>,
    {
        let json = serde_json::to_string(request).unwrap();
        let request_id = request.id.clone();
        sink.send(WsMessage::Text(json)).await.unwrap();

        loop {
            let msg = stream.next().await.unwrap().unwrap();
            match msg {
                WsMessage::Text(text) => {
                    // Parse as a raw value first to check the ID
                    let raw: serde_json::Value = serde_json::from_str(&text).unwrap();
                    if raw.get("id").and_then(|v| v.as_str()) == Some(&request_id) {
                        return serde_json::from_value(raw).unwrap();
                    }
                    // Skip messages that don't match our request ID
                    // (e.g., terminal.output from background tasks)
                }
                // Skip pings, etc.
                _ => continue,
            }
        }
    }

    #[tokio::test]
    async fn test_server_creation_and_shutdown() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let server = AgentServer::new(
            "127.0.0.1:0",
            "test-agent",
            None,
            "/tmp".to_string(),
            tmp.path().to_string_lossy().as_ref(),
        )
        .unwrap();
        let handle = server.start().await.unwrap();

        // Shutdown should complete without error.
        handle.shutdown().await.unwrap();

        // Double shutdown should not panic (the server task just exits).
        // The send will fail because the receiver is gone, but the server
        // itself is already stopped.
        let _ = handle.shutdown().await;
    }

    #[tokio::test]
    async fn test_session_list_request() {
        let (addr, handle) = start_test_server_on(18081).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let req = new_message(msg_types::SESSION_LIST, serde_json::json!({}));
        let resp: Message<serde_json::Value> = send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.msg_type, msg_types::OK);
        assert_eq!(resp.id, req.id);
        // The response should contain a `sessions` field (may be empty).
        assert!(resp.payload.get("sessions").is_some());

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_session_create_and_kill() {
        let (addr, handle) = start_test_server_on(18082).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        // Pre-clean any session left over from a previous crashed/aborted run
        // so the create below doesn't hit a duplicate-name failure.
        TmuxManager::new()
            .kill_session("server_test_create_kill")
            .await
            .ok();

        // Create a session.
        let create_payload = SessionCreatePayload {
            name: "server_test_create_kill".to_string(),
            width: 80,
            height: 24,
        };
        let create_req = new_message(msg_types::SESSION_CREATE, create_payload);
        let create_resp: Message<SessionCreateResponse> =
            send_and_receive(&mut sink, &mut stream, &create_req).await;

        assert_eq!(create_resp.msg_type, msg_types::OK);
        assert_eq!(create_resp.payload.name, "server_test_create_kill");

        // Kill the session.
        let kill_payload = SessionKillPayload {
            name: "server_test_create_kill".to_string(),
        };
        let kill_req = new_message(msg_types::SESSION_KILL, kill_payload);
        let kill_resp: Message<SessionKillResponse> =
            send_and_receive(&mut sink, &mut stream, &kill_req).await;

        assert_eq!(kill_resp.msg_type, msg_types::OK);
        assert_eq!(kill_resp.payload.name, "server_test_create_kill");

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_client_attach_detach() {
        let (addr, handle) = start_test_server_on(18083).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        // Create a real tmux session first so attach has something to
        // connect to.
        let tmux = TmuxManager::new();
        let session_name = "server_test_attach";
        // Pre-clean any session left over from a previous crashed/aborted run
        // so the test is re-entrant (tmux rejects a duplicate session name).
        tmux.kill_session(session_name).await.ok();
        tmux.create_session(session_name, 80, 24, "/tmp", &[])
            .await
            .unwrap();

        // Attach via WebSocket.
        let attach_payload = ClientAttachPayload {
            session_name: session_name.to_string(),
            width: 80,
            height: 24,
        };
        let attach_req = new_message(msg_types::CLIENT_ATTACH, attach_payload);
        let attach_resp: Message<ClientAttachResponse> =
            send_and_receive(&mut sink, &mut stream, &attach_req).await;

        assert_eq!(attach_resp.msg_type, msg_types::OK);
        assert_eq!(attach_resp.payload.session_name, session_name);

        // Detach.
        let detach_payload = ClientDetachPayload {
            session_name: session_name.to_string(),
        };
        let detach_req = new_message(msg_types::CLIENT_DETACH, detach_payload);
        let detach_resp: Message<ClientDetachResponse> =
            send_and_receive(&mut sink, &mut stream, &detach_req).await;

        assert_eq!(detach_resp.msg_type, msg_types::OK);
        assert_eq!(detach_resp.payload.session_name, session_name);

        // Cleanup the tmux session.
        tmux.kill_session(session_name).await.ok();
        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_terminal_io_flow() {
        let (addr, handle) = start_test_server_on(18084).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let tmux = TmuxManager::new();
        let session_name = "server_test_io";
        tmux.kill_session(session_name).await.ok();
        tmux.create_session(session_name, 80, 24, "/tmp", &[])
            .await
            .unwrap();

        // Attach.
        let attach_payload = ClientAttachPayload {
            session_name: session_name.to_string(),
            width: 80,
            height: 24,
        };
        let attach_req = new_message(msg_types::CLIENT_ATTACH, attach_payload);
        let _attach_resp: Message<ClientAttachResponse> =
            send_and_receive(&mut sink, &mut stream, &attach_req).await;

        // Give the PTY reader task a moment to start.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        // Send terminal input (base64-encoded "echo hello\n").
        use base64::Engine;
        let input_data = base64::engine::general_purpose::STANDARD.encode(b"echo hello\n");
        let input_payload = TerminalInputPayload {
            session_name: session_name.to_string(),
            data: input_data,
        };
        let input_req = new_message(msg_types::TERMINAL_INPUT, input_payload);
        let input_resp: Message<OkPayload> =
            send_and_receive(&mut sink, &mut stream, &input_req).await;
        assert_eq!(input_resp.msg_type, msg_types::OK);

        // Wait for the shell to echo and produce output.
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;

        // Read a terminal output message from the stream.
        let mut got_output = false;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(std::time::Duration::from_secs(2), stream.next()).await {
                Ok(Some(Ok(WsMessage::Text(text)))) => {
                    let msg: Message<serde_json::Value> = serde_json::from_str(&text).unwrap();
                    if msg.msg_type == msg_types::TERMINAL_OUTPUT {
                        let data_b64 = msg.payload.get("data").unwrap().as_str().unwrap();
                        let decoded = base64::engine::general_purpose::STANDARD
                            .decode(data_b64)
                            .unwrap();
                        let output_str = String::from_utf8_lossy(&decoded);
                        if output_str.contains("hello") {
                            got_output = true;
                            break;
                        }
                    }
                }
                Ok(Some(Ok(_))) => continue,
                _ => break,
            }
        }

        // Detach and clean up.
        let detach_payload = ClientDetachPayload {
            session_name: session_name.to_string(),
        };
        let detach_req = new_message(msg_types::CLIENT_DETACH, detach_payload);
        let _ = send_and_receive::<_, serde_json::Value>(&mut sink, &mut stream, &detach_req).await;

        tmux.kill_session(session_name).await.ok();
        handle.shutdown().await.ok();

        assert!(
            got_output,
            "expected to receive terminal output containing 'hello'"
        );
    }

    #[tokio::test]
    async fn test_unknown_message_type_returns_error() {
        let (addr, handle) = start_test_server_on(18085).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let req: Message<serde_json::Value> = Message {
            msg_type: "unknown.type".to_string(),
            id: "test-unknown".to_string(),
            timestamp: now_timestamp(),
            payload: serde_json::json!({}),
        };
        let resp: Message<ErrorPayload> = send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.msg_type, msg_types::ERROR);
        assert_eq!(resp.id, "test-unknown");
        assert_eq!(resp.payload.code, "unknown_message_type");

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_keepalive_ping_returns_pong() {
        let (addr, handle) = start_test_server_on(18092).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let req: Message<serde_json::Value> = Message {
            msg_type: msg_types::KEEPALIVE_PING.to_string(),
            id: "ka-test-123".to_string(),
            timestamp: now_timestamp(),
            payload: serde_json::json!({}),
        };
        let resp: Message<serde_json::Value> = send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.msg_type, msg_types::KEEPALIVE_PONG);
        assert_eq!(resp.id, "ka-test-123");

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_invalid_json_returns_error() {
        let (addr, handle) = start_test_server_on(18086).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        sink.send(WsMessage::Text("not valid json".to_string()))
            .await
            .unwrap();

        let msg = stream.next().await.unwrap().unwrap();
        match msg {
            WsMessage::Text(text) => {
                let resp: Message<ErrorPayload> = serde_json::from_str(&text).unwrap();
                assert_eq!(resp.msg_type, msg_types::ERROR);
                assert_eq!(resp.payload.code, "parse_error");
            }
            other => panic!("expected text frame, got {:?}", other),
        }

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_file_list_root() {
        let (addr, handle) = start_test_server_on(18087).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let req = new_message(
            msg_types::FILE_LIST,
            FileListPayload {
                path: "".to_string(),
            },
        );
        let resp: Message<serde_json::Value> = send_and_receive(&mut sink, &mut stream, &req).await;
        assert_eq!(resp.msg_type, msg_types::OK);
        assert!(resp.payload.get("entries").is_some());

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_file_write_and_read_roundtrip() {
        let (addr, handle) = start_test_server_on(18088).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let content = b"nession file test";
        let b64 = base64::engine::general_purpose::STANDARD.encode(content);
        let write_req = new_message(
            msg_types::FILE_WRITE,
            FileWritePayload {
                path: "roundtrip_test.txt".to_string(),
                content: b64,
            },
        );
        let write_resp: Message<FileWriteResponse> =
            send_and_receive(&mut sink, &mut stream, &write_req).await;
        assert_eq!(write_resp.msg_type, msg_types::OK);
        assert!(write_resp.payload.written > 0);

        let read_req = new_message(
            msg_types::FILE_READ,
            FileReadPayload {
                path: "roundtrip_test.txt".to_string(),
            },
        );
        let read_resp: Message<FileData> =
            send_and_receive(&mut sink, &mut stream, &read_req).await;
        assert_eq!(read_resp.msg_type, msg_types::OK);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&read_resp.payload.content)
            .unwrap();
        assert_eq!(&decoded, content);

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_file_list_then_read_roundtrip() {
        let (addr, handle) = start_test_server_on(18091).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        // 1. Write a file.
        let content = b"roundtrip via list_dir path";
        let b64 = base64::engine::general_purpose::STANDARD.encode(content);
        let write_req = new_message(
            msg_types::FILE_WRITE,
            FileWritePayload {
                path: "rt/from_list.txt".to_string(),
                content: b64,
            },
        );
        let write_resp: Message<FileWriteResponse> =
            send_and_receive(&mut sink, &mut stream, &write_req).await;
        assert_eq!(write_resp.msg_type, msg_types::OK);

        // 2. List the directory to get entry paths.
        let list_req = new_message(
            msg_types::FILE_LIST,
            FileListPayload {
                path: "rt".to_string(),
            },
        );
        let list_resp: Message<serde_json::Value> =
            send_and_receive(&mut sink, &mut stream, &list_req).await;
        assert_eq!(list_resp.msg_type, msg_types::OK);

        let entries = list_resp
            .payload
            .get("entries")
            .and_then(|v| v.as_array())
            .expect("entries should be an array");
        assert_eq!(entries.len(), 1);
        let entry_path = entries[0]
            .get("path")
            .and_then(|v| v.as_str())
            .expect("entry should have a path");
        // Path must be relative, not absolute.
        assert_eq!(entry_path, "rt/from_list.txt");

        // 3. Read the file using the path returned by list_dir.
        let read_req = new_message(
            msg_types::FILE_READ,
            FileReadPayload {
                path: entry_path.to_string(),
            },
        );
        let read_resp: Message<FileData> =
            send_and_receive(&mut sink, &mut stream, &read_req).await;
        assert_eq!(read_resp.msg_type, msg_types::OK);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&read_resp.payload.content)
            .unwrap();
        assert_eq!(&decoded, content);

        // 4. Delete using the path from list_dir.
        let del_req = new_message(
            msg_types::FILE_DELETE,
            FileDeletePayload {
                path: entry_path.to_string(),
            },
        );
        let del_resp: Message<serde_json::Value> =
            send_and_receive(&mut sink, &mut stream, &del_req).await;
        assert_eq!(del_resp.msg_type, msg_types::OK);
        assert!(del_resp
            .payload
            .get("success")
            .and_then(|v| v.as_bool())
            .unwrap_or(false));

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_file_delete() {
        let (addr, handle) = start_test_server_on(18089).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let b64 = base64::engine::general_purpose::STANDARD.encode(b"to delete");
        let write_req = new_message(
            msg_types::FILE_WRITE,
            FileWritePayload {
                path: "to_delete.txt".to_string(),
                content: b64,
            },
        );
        let _: Message<FileWriteResponse> =
            send_and_receive(&mut sink, &mut stream, &write_req).await;

        let del_req = new_message(
            msg_types::FILE_DELETE,
            FileDeletePayload {
                path: "to_delete.txt".to_string(),
            },
        );
        let del_resp: Message<serde_json::Value> =
            send_and_receive(&mut sink, &mut stream, &del_req).await;
        assert_eq!(del_resp.msg_type, msg_types::OK);
        assert!(del_resp
            .payload
            .get("success")
            .and_then(|v| v.as_bool())
            .unwrap_or(false));

        let read_req = new_message(
            msg_types::FILE_READ,
            FileReadPayload {
                path: "to_delete.txt".to_string(),
            },
        );
        let read_resp: Message<ErrorPayload> =
            send_and_receive(&mut sink, &mut stream, &read_req).await;
        assert_eq!(read_resp.msg_type, msg_types::ERROR);

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_file_permission_denied_on_escape() {
        let (addr, handle) = start_test_server_on(18090).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let req = new_message(
            msg_types::FILE_READ,
            FileReadPayload {
                path: "../etc/passwd".to_string(),
            },
        );
        let resp: Message<ErrorPayload> = send_and_receive(&mut sink, &mut stream, &req).await;
        assert_eq!(resp.msg_type, msg_types::ERROR);
        assert!(resp.payload.code == "permission_denied" || resp.payload.code == "io_error");

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_file_create_dir() {
        let (addr, handle) = start_test_server_on(18093).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        // Create a nested directory
        let create_req = new_message(
            msg_types::FILE_CREATE_DIR,
            FileCreateDirPayload {
                path: "test_dir/sub_dir".to_string(),
            },
        );
        let create_resp: Message<serde_json::Value> =
            send_and_receive(&mut sink, &mut stream, &create_req).await;
        assert_eq!(create_resp.msg_type, msg_types::OK);
        assert_eq!(
            create_resp
                .payload
                .get("success")
                .unwrap()
                .as_bool()
                .unwrap(),
            true
        );

        // Verify directory exists by listing it
        let list_req = new_message(
            msg_types::FILE_LIST,
            FileListPayload {
                path: "test_dir/sub_dir".to_string(),
            },
        );
        let list_resp: Message<serde_json::Value> =
            send_and_receive(&mut sink, &mut stream, &list_req).await;
        assert_eq!(list_resp.msg_type, msg_types::OK);

        // Clean up
        let del_req = new_message(
            msg_types::FILE_DELETE,
            FileDeletePayload {
                path: "test_dir/sub_dir".to_string(),
            },
        );
        let _ = send_and_receive::<_, serde_json::Value>(&mut sink, &mut stream, &del_req).await;
        let del_req = new_message(
            msg_types::FILE_DELETE,
            FileDeletePayload {
                path: "test_dir".to_string(),
            },
        );
        let _ = send_and_receive::<_, serde_json::Value>(&mut sink, &mut stream, &del_req).await;

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_file_rename() {
        let (addr, handle) = start_test_server_on(18094).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        // Write a file
        let content = b"rename test";
        let b64 = base64::engine::general_purpose::STANDARD.encode(content);
        let write_req = new_message(
            msg_types::FILE_WRITE,
            FileWritePayload {
                path: "old_name.txt".to_string(),
                content: b64,
            },
        );
        let _ = send_and_receive::<_, FileWriteResponse>(&mut sink, &mut stream, &write_req).await;

        // Rename the file
        let rename_req = new_message(
            msg_types::FILE_RENAME,
            FileRenamePayload {
                from: "old_name.txt".to_string(),
                to: "new_name.txt".to_string(),
            },
        );
        let rename_resp: Message<serde_json::Value> =
            send_and_receive(&mut sink, &mut stream, &rename_req).await;
        assert_eq!(rename_resp.msg_type, msg_types::OK);
        assert_eq!(
            rename_resp
                .payload
                .get("success")
                .unwrap()
                .as_bool()
                .unwrap(),
            true
        );

        // Read from new location
        let read_req = new_message(
            msg_types::FILE_READ,
            FileReadPayload {
                path: "new_name.txt".to_string(),
            },
        );
        let read_resp: Message<FileData> =
            send_and_receive(&mut sink, &mut stream, &read_req).await;
        assert_eq!(read_resp.msg_type, msg_types::OK);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&read_resp.payload.content)
            .unwrap();
        assert_eq!(&decoded, content);

        // Clean up
        let del_req = new_message(
            msg_types::FILE_DELETE,
            FileDeletePayload {
                path: "new_name.txt".to_string(),
            },
        );
        let _ = send_and_receive::<_, serde_json::Value>(&mut sink, &mut stream, &del_req).await;

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_terminal_input_invalid_base64() {
        let (addr, handle) = start_test_server_on(18095).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let tmux = TmuxManager::new();
        let session_name = "server_test_invalid_b64";
        tmux.kill_session(session_name).await.ok();
        tmux.create_session(session_name, 80, 24, "/tmp", &[])
            .await
            .unwrap();

        // Attach first
        let attach_payload = ClientAttachPayload {
            session_name: session_name.to_string(),
            width: 80,
            height: 24,
        };
        let attach_req = new_message(msg_types::CLIENT_ATTACH, attach_payload);
        let _ = send_and_receive::<_, serde_json::Value>(&mut sink, &mut stream, &attach_req).await;

        // Send invalid base64 data
        let input_payload = TerminalInputPayload {
            session_name: session_name.to_string(),
            data: "!!!not-valid-base64!!!".to_string(),
        };
        let input_req = new_message(msg_types::TERMINAL_INPUT, input_payload);
        let input_resp: Message<ErrorPayload> =
            send_and_receive(&mut sink, &mut stream, &input_req).await;
        assert_eq!(input_resp.msg_type, msg_types::ERROR);
        assert_eq!(input_resp.payload.code, "decode_error");

        // Clean up
        let detach_payload = ClientDetachPayload {
            session_name: session_name.to_string(),
        };
        let detach_req = new_message(msg_types::CLIENT_DETACH, detach_payload);
        let _ = send_and_receive::<_, serde_json::Value>(&mut sink, &mut stream, &detach_req).await;

        tmux.kill_session(session_name).await.ok();
        handle.shutdown().await.ok();
    }

    #[test]
    fn test_parse_listen_address_ipv4() {
        let (ip, port) = parse_listen_address("0.0.0.0:8080");
        assert_eq!(ip, "0.0.0.0");
        assert_eq!(port, 8080);
    }

    #[test]
    fn test_parse_listen_address_ipv6() {
        let (ip, port) = parse_listen_address("[::1]:9090");
        // The function strips the brackets from IPv6 addresses
        assert_eq!(ip, "::1");
        assert_eq!(port, 9090);
    }

    #[test]
    fn test_parse_listen_address_invalid() {
        // Invalid format should fall back to default
        let (ip, port) = parse_listen_address("not-a-valid-address");
        assert_eq!(ip, "127.0.0.1");
        assert_eq!(port, 9090);
    }

    #[test]
    fn test_extract_session_name_with_agent_prefix() {
        assert_eq!(extract_session_name("agent1:mysession"), "mysession");
    }

    #[test]
    fn test_extract_session_name_without_prefix() {
        assert_eq!(extract_session_name("mysession"), "mysession");
    }

    #[test]
    fn test_extract_session_name_multiple_colons() {
        // Should take everything after the first colon
        assert_eq!(extract_session_name("agent:session:extra"), "session:extra");
    }

    #[test]
    fn test_make_response_echoes_request_id() {
        let resp = make_response(
            "req-123",
            msg_types::OK,
            OkPayload {
                message: "done".into(),
            },
        );
        assert_eq!(resp.msg_type, msg_types::OK);
        assert_eq!(resp.id, "req-123");
        assert_eq!(resp.payload.message, "done");
        assert!(resp.timestamp > 0);
    }

    #[test]
    fn test_make_error() {
        let resp = make_error("req-456", "not_found", "thing missing");
        assert_eq!(resp.msg_type, msg_types::ERROR);
        assert_eq!(resp.id, "req-456");
        assert_eq!(resp.payload.code, "not_found");
        assert_eq!(resp.payload.message, "thing missing");
    }

    #[test]
    fn test_make_ok() {
        let resp = make_ok("req-789", "success!");
        assert_eq!(resp.msg_type, msg_types::OK);
        assert_eq!(resp.id, "req-789");
        assert_eq!(resp.payload.message, "success!");
    }

    #[test]
    fn test_now_timestamp_is_recent() {
        let ts = now_timestamp();
        // Should be after 2024-01-01
        assert!(ts > 1_704_067_200);
    }

    #[test]
    fn test_new_message_structure() {
        let msg = new_message("test.type", serde_json::json!({"key": "value"}));
        assert_eq!(msg.msg_type, "test.type");
        assert!(!msg.id.is_empty());
        assert!(uuid::Uuid::parse_str(&msg.id).is_ok());
    }

    #[test]
    fn test_default_width_height() {
        assert_eq!(default_width(), 80);
        assert_eq!(default_height(), 24);
    }

    #[test]
    fn test_default_p2p_mode() {
        assert_eq!(default_p2p(), "p2p");
    }

    #[test]
    fn test_session_create_payload_defaults() {
        let json = serde_json::json!({"name": "test"});
        let p: SessionCreatePayload = serde_json::from_value(json).unwrap();
        assert_eq!(p.name, "test");
        assert_eq!(p.width, 80);
        assert_eq!(p.height, 24);
    }

    #[test]
    fn test_client_attach_payload_defaults() {
        let json = serde_json::json!({"session_name": "s"});
        let p: ClientAttachPayload = serde_json::from_value(json).unwrap();
        assert_eq!(p.session_name, "s");
        assert_eq!(p.width, 80);
        assert_eq!(p.height, 24);
    }

    #[test]
    fn test_web_session_attach_default_mode() {
        let json = serde_json::json!({"session_id": "a:b"});
        let p: WebSessionAttachPayload = serde_json::from_value(json).unwrap();
        assert_eq!(p.preferred_mode, "p2p");
    }

    #[tokio::test]
    async fn test_web_ui_client_auth() {
        let (addr, handle) = start_test_server_on(18096).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let auth_payload = ClientAuthPayload {
            auth_token: "test-token".to_string(),
            client_id: Some("my-client-id".to_string()),
        };
        let req = new_message(msg_types::CLIENT_AUTH, auth_payload);
        let resp: Message<AuthResponsePayload> =
            send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.msg_type, msg_types::OK);
        assert_eq!(resp.payload.status, "success");
        assert_eq!(resp.payload.client_id, "my-client-id");

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_web_ui_client_auth_generates_id() {
        let (addr, handle) = start_test_server_on(18097).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let auth_payload = ClientAuthPayload {
            auth_token: "test-token".to_string(),
            client_id: None, // server should generate one
        };
        let req = new_message(msg_types::CLIENT_AUTH, auth_payload);
        let resp: Message<AuthResponsePayload> =
            send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.msg_type, msg_types::OK);
        assert_eq!(resp.payload.status, "success");
        // Generated client_id should be a valid UUID
        assert!(uuid::Uuid::parse_str(&resp.payload.client_id).is_ok());

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_web_ui_agents_list() {
        let (addr, handle) = start_test_server_on(18098).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let req = new_message(msg_types::CLIENT_AGENTS_LIST, serde_json::json!({}));
        let resp: Message<WebAgentsListResponse> =
            send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.msg_type, msg_types::OK);
        assert_eq!(resp.payload.agents.len(), 1);
        assert_eq!(resp.payload.agents[0].agent_id, "test-agent");
        assert_eq!(resp.payload.agents[0].status, "online");

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_web_ui_sessions_list() {
        let (addr, handle) = start_test_server_on(18099).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let req = new_message(msg_types::CLIENT_SESSIONS_LIST, serde_json::json!({}));
        let resp: Message<WebSessionsListResponse> =
            send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.msg_type, msg_types::OK);
        // May be empty if no tmux sessions exist — just verify field exists
        let _ = resp.payload.sessions.len();

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_web_ui_session_attach() {
        let (addr, handle) = start_test_server_on(18100).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let payload = WebSessionAttachPayload {
            session_id: "test-agent:my-session".to_string(),
            preferred_mode: "p2p".to_string(),
        };
        let req = new_message(msg_types::CLIENT_SESSION_ATTACH, payload);
        let resp: Message<WebAttachInfo> = send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.msg_type, msg_types::OK);
        assert_eq!(resp.payload.mode, "p2p");
        assert_eq!(resp.payload.session_name, "my-session");
        assert_eq!(resp.payload.session_id, "test-agent:my-session");

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_web_ui_session_create_and_kill() {
        let (addr, handle) = start_test_server_on(18101).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        // Pre-clean
        TmuxManager::new()
            .kill_session("web_create_kill")
            .await
            .ok();

        let create_payload = WebSessionCreatePayload {
            agent_id: "test-agent".to_string(),
            name: "web_create_kill".to_string(),
            width: 100,
            height: 30,
        };
        let create_req = new_message(msg_types::CLIENT_SESSION_CREATE, create_payload);
        let create_resp: Message<WebSessionCreateResponse> =
            send_and_receive(&mut sink, &mut stream, &create_req).await;

        assert_eq!(create_resp.msg_type, msg_types::OK);
        assert!(create_resp.payload.success);
        assert_eq!(
            create_resp.payload.session_id,
            Some("test-agent:web_create_kill".to_string())
        );

        // Kill via web UI
        let kill_payload = WebSessionKillPayload {
            session_id: "test-agent:web_create_kill".to_string(),
        };
        let kill_req = new_message(msg_types::CLIENT_SESSION_KILL, kill_payload);
        let kill_resp: Message<WebSessionKillResponse> =
            send_and_receive(&mut sink, &mut stream, &kill_req).await;

        assert_eq!(kill_resp.msg_type, msg_types::OK);
        assert!(kill_resp.payload.success);

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_web_ui_session_kill_nonexistent() {
        let (addr, handle) = start_test_server_on(18102).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let kill_payload = WebSessionKillPayload {
            session_id: "agent:nonexistent-session-xyz".to_string(),
        };
        let kill_req = new_message(msg_types::CLIENT_SESSION_KILL, kill_payload);
        let kill_resp: Message<WebSessionKillResponse> =
            send_and_receive(&mut sink, &mut stream, &kill_req).await;

        assert_eq!(kill_resp.msg_type, msg_types::OK);
        assert!(!kill_resp.payload.success);
        assert!(kill_resp.payload.error.is_some());

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_web_ui_session_create_invalid_payload() {
        let (addr, handle) = start_test_server_on(18103).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        // Send a completely invalid payload (missing name field)
        let req = new_message(
            msg_types::CLIENT_SESSION_CREATE,
            serde_json::json!({"wrong_field": 123}),
        );
        let resp: Message<WebSessionCreateResponse> =
            send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.msg_type, msg_types::OK);
        assert!(!resp.payload.success);
        assert!(resp.payload.error.is_some());

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_client_detach_not_attached() {
        let (addr, handle) = start_test_server_on(18104).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let detach_payload = ClientDetachPayload {
            session_name: "never-attached-session".to_string(),
        };
        let req = new_message(msg_types::CLIENT_DETACH, detach_payload);
        let resp: Message<ErrorPayload> = send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.msg_type, msg_types::ERROR);
        assert_eq!(resp.payload.code, "not_attached");

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_terminal_input_not_attached() {
        let (addr, handle) = start_test_server_on(18105).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        use base64::Engine;
        let input_payload = TerminalInputPayload {
            session_name: "no-such-session".to_string(),
            data: base64::engine::general_purpose::STANDARD.encode(b"hello"),
        };
        let req = new_message(msg_types::TERMINAL_INPUT, input_payload);
        let resp: Message<ErrorPayload> = send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.msg_type, msg_types::ERROR);
        assert_eq!(resp.payload.code, "not_attached");

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_terminal_resize_not_attached() {
        let (addr, handle) = start_test_server_on(18106).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let resize_payload = TerminalResizePayload {
            session_name: "no-such-session".to_string(),
            width: 120,
            height: 40,
        };
        let req = new_message(msg_types::TERMINAL_RESIZE, resize_payload);
        let resp: Message<ErrorPayload> = send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.msg_type, msg_types::ERROR);
        assert_eq!(resp.payload.code, "not_attached");

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_tls_load_both_none() {
        let result = AgentServer::load_tls(None, None);
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_tls_load_only_cert_fails() {
        let result = AgentServer::load_tls(Some("/tmp/cert.pem"), None);
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_tls_load_only_key_fails() {
        let result = AgentServer::load_tls(None, Some("/tmp/key.pem"));
        assert!(result.is_err());
    }
}
