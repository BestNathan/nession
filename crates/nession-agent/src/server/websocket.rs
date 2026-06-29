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

/// A stream that can be either plain TCP or TLS-wrapped.
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthResponsePayload {
    pub status: String,
    pub message: String,
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

// --- Protocol helpers ---

fn now_timestamp() -> u64 {
    chrono::Utc::now().timestamp() as u64
}

/// Extract the tmux session name from a web UI session_id.
/// Web UI uses "agent_id:session_name" format; strip the prefix if present.
fn extract_session_name(session_id: &str) -> String {
    session_id
        .split_once(':')
        .map(|(_, name)| name.to_string())
        .unwrap_or_else(|| session_id.to_string())
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
    shutdown_tx: mpsc::Sender<()>,
    shutdown_rx: Option<mpsc::Receiver<()>>,
    tls_acceptor: Option<tokio_rustls::TlsAcceptor>,
    listen_address: String,
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
    /// Pass `None` for `tls` to run without TLS (plain WebSocket).
    pub fn new(
        listen_address: impl Into<String>,
        tls: Option<(
            Vec<rustls::pki_types::CertificateDer<'static>>,
            rustls::pki_types::PrivateKeyDer<'static>,
        )>,
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

        Ok(Self {
            tmux_manager: TmuxManager::new(),
            shutdown_tx,
            shutdown_rx: Some(shutdown_rx),
            tls_acceptor,
            listen_address: listen_address.into(),
        })
    }

    /// Start accepting connections. Returns a [`ServerHandle`] that can be
    /// used to trigger a graceful shutdown. The server runs as a background
    /// tokio task until shutdown is signalled or the process exits.
    pub async fn start(mut self) -> Result<ServerHandle> {
        let listener = TcpListener::bind(&self.listen_address)
            .await
            .with_context(|| format!("failed to bind {}", self.listen_address))?;

        let shutdown_rx = self.shutdown_rx.take().expect("shutdown_rx taken twice");
        let handle = ServerHandle {
            shutdown_tx: self.shutdown_tx.clone(),
        };

        let tmux_manager = Arc::new(self.tmux_manager);
        let tls_acceptor = self.tls_acceptor;
        let listen_address = self.listen_address;

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
                                let tls = tls_acceptor.clone();
                                tokio::spawn(async move {
                                    if let Err(e) =
                                        Self::handle_connection(stream, addr, tmux, tls).await
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
    async fn handle_connection(
        stream: tokio::net::TcpStream,
        addr: SocketAddr,
        tmux_manager: Arc<TmuxManager>,
        tls_acceptor: Option<tokio_rustls::TlsAcceptor>,
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
        let sessions: Arc<Mutex<std::collections::HashMap<String, crate::tmux::pty::PtySession>>> =
            Arc::new(Mutex::new(std::collections::HashMap::new()));

        Self::run_message_loop(ws_stream, sink, tmux_manager, sessions, addr).await
    }

    /// Drain incoming WebSocket frames and dispatch them.
    async fn run_message_loop(
        mut ws_stream: futures_util::stream::SplitStream<WebSocketStream<TcpOrTls>>,
        sink: Arc<Mutex<futures_util::stream::SplitSink<WebSocketStream<TcpOrTls>, WsMessage>>>,
        tmux: Arc<TmuxManager>,
        sessions: Arc<Mutex<std::collections::HashMap<String, crate::tmux::pty::PtySession>>>,
        addr: SocketAddr,
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
                    let response = Self::handle_request(&text, tmux.clone(), sessions.clone(), sink.clone()).await;
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
        for (name, session) in sessions_guard.drain() {
            if let Err(e) = session.close().await {
                warn!("Error closing PTY session {}: {:#}", name, e);
            }
        }

        info!("Client {} disconnected", addr);
        Ok(())
    }

    /// Route a single text request to the appropriate handler.
    async fn handle_request(
        text: &str,
        tmux: Arc<TmuxManager>,
        sessions: Arc<
            Mutex<std::collections::HashMap<String, crate::tmux::pty::PtySession>>,
        >,
        sink: Arc<Mutex<futures_util::stream::SplitSink<WebSocketStream<TcpOrTls>, WsMessage>>>,
    ) -> String {
        // Try to extract msg_type and id without fully deserialising the
        // payload — we need those even if the payload type is unknown.
        let raw: serde_json::Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => {
                return serde_json::to_string(&make_error(
                    "unknown",
                    "parse_error",
                    &format!("invalid JSON: {}", e),
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
                    serde_json::to_string(&make_response(&id, msg_types::OK, payload)).unwrap_or_default()
                }
                Err(e) => err("list_failed", &e.to_string()),
            },

            msg_types::SESSION_CREATE => {
                let payload: SessionCreatePayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return err("parse_error", &e.to_string()),
                };
                match tmux
                    .create_session(&payload.name, payload.width, payload.height)
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
                match crate::tmux::pty::PtySession::attach(
                    &payload.session_name,
                    payload.width,
                    payload.height,
                )
                .await
                {
                    Ok(session) => {
                        let session_name = payload.session_name.clone();
                        sessions
                            .lock()
                            .await
                            .insert(session_name.clone(), session);

                        // Spawn a background task that continuously reads
                        // PTY output and pushes it to the client as
                        // `terminal.output` messages.
                        let sink_clone = Arc::clone(&sink);
                        let sessions_for_output = Arc::clone(&sessions);
                        let session_name_clone = session_name.clone();
                        tokio::spawn(async move {
                            let mut buf = [0u8; 4096];
                            loop {
                                // Borrow the session from the map so we
                                // don't hold the map lock during the
                                // blocking read.
                                let read_result = {
                                    let map = sessions_for_output.lock().await;
                                    match map.get(&session_name_clone) {
                                        Some(session) => {
                                            session.read_output(&mut buf, 100).await
                                        }
                                        None => break,
                                    }
                                };
                                match read_result {
                                    Ok(0) => {
                                        break; // EOF
                                    }
                                    Ok(n) => {
                                        use base64::Engine;
                                        let encoded =
                                            base64::engine::general_purpose::STANDARD
                                                .encode(&buf[..n]);
                                        let output = TerminalOutputPayload {
                                            session_name: session_name_clone.clone(),
                                            data: encoded,
                                        };
                                        let msg =
                                            new_message(msg_types::TERMINAL_OUTPUT, output);
                                        if let Ok(json) = serde_json::to_string(&msg) {
                                            let mut s = sink_clone.lock().await;
                                            if s.send(WsMessage::Text(json)).await.is_err() {
                                                break;
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        // Check if it's a timeout error — if so, continue
                                        if e.to_string().contains("PTY_READ_TIMEOUT") {
                                            continue;
                                        }
                                        break;
                                    }
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
                    Some(session) => {
                        if let Err(e) = session.close().await {
                            warn!(
                                "Error closing PTY for {}: {:#}",
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
                let sessions_guard = sessions.lock().await;
                match sessions_guard.get(&payload.session_name) {
                    Some(session) => match session.write_input(&data).await {
                        Ok(_) => {
                            serde_json::to_string(&make_ok(&id, "ok")).unwrap_or_default()
                        }
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
                let sessions_guard = sessions.lock().await;
                match sessions_guard.get(&payload.session_name) {
                    Some(session) => match session.resize(payload.width, payload.height).await {
                        Ok(_) => {
                            serde_json::to_string(&make_ok(&id, "ok")).unwrap_or_default()
                        }
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
                let resp = AuthResponsePayload {
                    status: "success".to_string(),
                    message: "ok".to_string(),
                };
                serde_json::to_string(&make_response(&id, msg_types::OK, resp)).unwrap_or_default()
            }

            msg_types::CLIENT_AGENTS_LIST => match tmux.list_sessions().await {
                Ok(sessions_list) => {
                    let hostname = std::env::var("HOSTNAME")
                        .unwrap_or_else(|_| "localhost".to_string());
                    let agent = WebAgentInfo {
                        agent_id: "local-agent".to_string(),
                        hostname,
                        ip_address: "127.0.0.1".to_string(),
                        port: 9090,
                        status: "online".to_string(),
                        session_count: sessions_list.len() as u32,
                        last_heartbeat: chrono::Utc::now().to_rfc3339(),
                    };
                    let resp = WebAgentsListResponse { agents: vec![agent] };
                    serde_json::to_string(&make_response(&id, msg_types::OK, resp)).unwrap_or_default()
                }
                Err(e) => err("list_failed", &e.to_string()),
            },

            msg_types::CLIENT_SESSIONS_LIST => match tmux.list_sessions().await {
                Ok(sessions_list) => {
                    let sessions: Vec<WebSessionInfo> = sessions_list
                        .into_iter()
                        .map(|s| {
                            let session_id = format!("local-agent:{}", s.name);
                            WebSessionInfo {
                                session_id: session_id.clone(),
                                agent_id: "local-agent".to_string(),
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
                    serde_json::to_string(&make_response(&id, msg_types::OK, resp)).unwrap_or_default()
                }
                Err(e) => err("list_failed", &e.to_string()),
            },

            msg_types::CLIENT_SESSION_ATTACH => {
                let payload: WebSessionAttachPayload =
                    match serde_json::from_value(payload_value) {
                        Ok(p) => p,
                        Err(e) => return err("parse_error", &e.to_string()),
                    };
                let session_name = extract_session_name(&payload.session_id);
                let resp = WebAttachInfo {
                    mode: "p2p".to_string(),
                    session_id: payload.session_id,
                    session_name: session_name.clone(),
                    agent_address: "127.0.0.1:9090".to_string(),
                };
                serde_json::to_string(&make_response(&id, msg_types::OK, resp)).unwrap_or_default()
            }

            msg_types::CLIENT_SESSION_CREATE => {
                let payload: WebSessionCreatePayload =
                    match serde_json::from_value(payload_value) {
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
                match tmux.create_session(&payload.name, payload.width, payload.height).await {
                    Ok(()) => {
                        let session_id = format!("local-agent:{}", payload.name);
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

            unknown => err(
                "unknown_message_type",
                &format!("unknown message type: {}", unknown),
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
    use futures_util::SinkExt;
    use tokio_tungstenite::connect_async;
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    /// Start a test server on an ephemeral port and return a handle for
    /// shutdown. Note: the bound address uses port 0, so this helper is
    /// only useful for tests that don't need to connect (e.g. verifying
    /// server construction and shutdown).
    #[allow(dead_code)]
    async fn start_test_server() -> (SocketAddr, ServerHandle) {
        let server =
            AgentServer::new("127.0.0.1:0", None).expect("server creation should succeed");
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
        let server = AgentServer::new(&addr_str, None)
            .expect("server creation should succeed");
        let handle = server.start().await.expect("start should succeed");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        (addr_str.parse().unwrap(), handle)
    }

    /// Connect a WebSocket client to a test server.
    async fn connect_client(
        addr: SocketAddr,
    ) -> (
        futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
            WsMessage,
        >,
        futures_util::stream::SplitStream<
            tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        >,
    ) {
        let url = format!("ws://{}", addr);
        let (ws_stream, _response) =
            connect_async(&url).await.expect("connect should succeed");
        ws_stream.split()
    }

    /// Send a JSON request and receive the matching JSON response.
    /// Skips over unsolicited messages (e.g., terminal.output) that may
    /// arrive from background tasks.
    async fn send_and_receive<S, R>(
        sink: &mut futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
            WsMessage,
        >,
        stream: &mut futures_util::stream::SplitStream<
            tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
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
        let server = AgentServer::new("127.0.0.1:0", None).unwrap();
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
        let resp: Message<serde_json::Value> =
            send_and_receive(&mut sink, &mut stream, &req).await;

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
        tmux.create_session(session_name, 80, 24).await.unwrap();

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
        tmux.create_session(session_name, 80, 24).await.unwrap();

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
        let deadline =
            tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(
                std::time::Duration::from_secs(2),
                stream.next(),
            )
            .await
            {
                Ok(Some(Ok(WsMessage::Text(text)))) => {
                    let msg: Message<serde_json::Value> =
                        serde_json::from_str(&text).unwrap();
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
        let resp: Message<ErrorPayload> =
            send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.msg_type, msg_types::ERROR);
        assert_eq!(resp.id, "test-unknown");
        assert_eq!(resp.payload.code, "unknown_message_type");

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
}
