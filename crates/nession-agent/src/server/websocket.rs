//! Agent WebSocket server implementation.
//!
//! Provides a [`AgentServer`] that listens for P2P client connections over
//! WebSocket (with optional TLS) and routes terminal I/O to/from per-client
//! PTY sessions. Also exposes session management operations (list, create,
//! kill) via the [`SessionManager`].
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
//! | client → agent  | `agent.attach`  | Attach a PTY to a session        |
//! | client → agent  | `agent.detach`  | Detach and close the PTY         |
//! | client → agent  | `terminal.input` | Send keystrokes to the PTY       |
//! | client → agent  | `terminal.resize`| Resize the PTY                   |
//! | agent → client  | `terminal.output`| PTY stdout data (base64)         |
//! | agent → client  | `error`          | Error response                   |
//! | agent → client  | `ok`             | Success response (with payload)  |

use crate::config::AttachMode;
use crate::fs::ops::FileOps;
use crate::protocol::p2p_routes;
use crate::tmux::manager::SessionManager;
use crate::tmux::session::TmuxSession;
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use nession_protocol::contracts::env::v1::EnvSnapshot;
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::WebSocketStream;
use tracing::{debug, error, info, warn};

/// A tmux attach session, shared by all clients attached through this
/// connection. Created on first attach, destroyed on last detach.
///
/// The `backend` is either a plain PTY or a control-mode session, hidden
/// behind [`TmuxSession`] so callers dispatch input/resize/close uniformly.
/// `subscribers` fans terminal output out to every attached client; the
/// control-mode path forwards output directly and leaves this empty.
struct AttachedSession {
    backend: Box<dyn TmuxSession>,
    /// Bounded senders — one per subscribed client. The broadcast task clones
    /// output to all of them; see [`SUBSCRIBER_QUEUE_SLOTS`] for what happens to
    /// one that stops draining.
    subscribers: Vec<mpsc::Sender<Vec<u8>>>,
}

/// How much terminal output one attached client may have waiting (#961).
///
/// This is the terminal lane's slow-consumer policy, and the depth is the
/// policy. The backend's own hop is bounded at 64 chunks of up to 4 KiB
/// ([`crate::tmux::pty`]) before it reaches the broadcast task, so a client that
/// can absorb what tmux produces never fills this: 64 chunks is the same depth
/// the session itself buffers, about 256 KiB.
///
/// What this buys is that the *slowest* client cannot become the pace of the
/// session for everybody else. The broadcast task fans one session's output out
/// to every attached client, so a `send().await` here would park the fan-out on
/// whichever client is behind — the other clients and the PTY reader behind it.
/// A client with a full queue is therefore detached instead: its queue is
/// dropped, its forwarding task sees the receiver close and closes the
/// connection, and it re-attaches to a redrawn screen. That is the same verdict
/// the Server reaches for a relayed client (`server::outbound::send_terminal`),
/// applied where the terminal is actually served.
const SUBSCRIBER_QUEUE_SLOTS: usize = 64;

/// Fan one chunk of terminal output out to every subscriber of a session.
///
/// Returns the number of subscribers **detached** by this call, i.e. dropped
/// for having no room. A subscriber whose queue is closed is pruned too but not
/// counted: that one's connection has already ended, and `spawn_output_forwarder`
/// is on its way out.
///
/// Never waits, and that is the policy rather than an optimisation — see
/// [`SUBSCRIBER_QUEUE_SLOTS`]. A free function so the policy can be tested
/// without a socket, a PTY, or a session: the three cases (room, full, closed)
/// are the whole of it.
fn fan_out(subscribers: &mut Vec<mpsc::Sender<Vec<u8>>>, chunk: &[u8]) -> usize {
    let mut detached = 0usize;
    subscribers.retain(|tx| match tx.try_send(chunk.to_vec()) {
        Ok(()) => true,
        Err(mpsc::error::TrySendError::Full(_)) => {
            detached += 1;
            false
        }
        Err(mpsc::error::TrySendError::Closed(_)) => false,
    });
    detached
}

/// Forward one subscriber's terminal output to this connection's sink, and —
/// when this subscriber was detached for not draining it — close the connection.
///
/// The queue ends in two ways, and they are not the same event:
///
/// * **the session ended** (the PTY or the control-mode reader closed and the
///   fan-out task went with it). This connection may be serving other sessions,
///   so nothing is closed here: the other attachments are still running, and
///   ending their socket because one session exited would be a bug of its own.
/// * **this subscriber was detached** for having no room ([`SUBSCRIBER_QUEUE_SLOTS`]),
///   which is the one case where the client must be told. The session is still
///   there — that is how the two are told apart, by asking the map — and what
///   the client is holding is a terminal that has stopped moving with nothing
///   coming to say so. A `Close` is the only thing this path can say it with,
///   and the client's own reconnect is what turns it into a redrawn screen.
///
/// It used to be one task per subscriber inline in the attach arms, twice, and
/// the only difference between the two was which names the locals had.
fn spawn_output_forwarder(
    mut rx: mpsc::Receiver<Vec<u8>>,
    sink: Arc<Mutex<futures_util::stream::SplitSink<WebSocketStream<TcpOrTls>, WsMessage>>>,
    sessions: Arc<Mutex<SessionMap>>,
    session_name: String,
) {
    tokio::spawn(async move {
        while let Some(bytes) = rx.recv().await {
            use base64::Engine;
            let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
            let output = TerminalOutputPayload {
                session_name: session_name.clone(),
                data: encoded,
            };
            let msg = new_message(msg_types::TERMINAL_OUTPUT, output);
            if let Ok(json) = serde_json::to_string(&msg) {
                let mut s = sink.lock().await;
                if s.send(WsMessage::Text(json)).await.is_err() {
                    return;
                }
            }
        }

        let detached_for_not_draining = sessions.lock().await.contains_key(&session_name);
        if !detached_for_not_draining {
            info!("terminal output for session {session_name} ended");
            return;
        }
        info!(
            "session {session_name}: subscriber was detached for not draining its terminal; \
             closing the connection"
        );
        let mut s = sink.lock().await;
        let _ = s.send(WsMessage::Close(None)).await;
    });
}

/// Per-connection map of attached sessions, keyed by session name.
type SessionMap = std::collections::HashMap<String, AttachedSession>;

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
    pub const SESSION_LIST: &str = "agent.session.list";
    pub const SESSION_CREATE: &str = "agent.session.create";
    pub const SESSION_KILL: &str = "agent.session.kill";
    pub const SESSION_CAPTURE_PREVIEW: &str = "agent.session.capture-preview";
    pub const CLIENT_ATTACH: &str = "agent.attach";
    pub const CLIENT_DETACH: &str = "agent.detach";
    pub const TERMINAL_INPUT: &str = "agent.terminal.input";
    pub const TERMINAL_RESIZE: &str = "agent.terminal.resize";

    // Web UI → Agent (compatibility layer)
    pub const CLIENT_AUTH: &str = "client.auth";
    pub const CLIENT_SESSIONS_LIST: &str = "client.sessions.list";
    pub const CLIENT_SESSION_ATTACH: &str = "client.session.attach";
    pub const CLIENT_SESSION_CREATE: &str = "client.session.create";
    pub const CLIENT_SESSION_KILL: &str = "client.session.kill";

    // File operations
    pub const FILE_LIST: &str = "agent.file.list";
    pub const FILE_READ: &str = "agent.file.read";
    pub const FILE_WRITE: &str = "agent.file.write";
    pub const FILE_DELETE: &str = "agent.file.delete";
    pub const FILE_CREATE_DIR: &str = "agent.file.create-dir";
    pub const FILE_RENAME: &str = "agent.file.rename";
    pub const FILE_CWD: &str = "agent.file.cwd";

    // Control, in both directions. **Not** units, and deliberately not in
    // `p2p_routes!`: a control message is symmetric — any peer may send one,
    // every peer must handle one, and the protocol pairs nothing — which is a
    // different category from an operation (one answerer) or a notification
    // (one emitter). `control.pong` is therefore not this socket's reply to
    // `control.ping`; it is a message of its own, and no router derives a pair
    // from the two. See `docs/architecture/protocol.md` § *Control*.
    pub const CONTROL_PING: &str = "control.ping";
    pub const CONTROL_PONG: &str = "control.pong";
    /// The same wire `connection::server_client::msg_types` declares for the
    /// server connection, declared again here because this module is where
    /// this socket's wires live and that module is private. Declaring a wire
    /// twice is safe in one direction only — `scripts/protocol-gate.mjs`
    /// requires **every** runtime to carry **every** control wire, so a
    /// misspelling here is a wire no other runtime has, reported rather than
    /// silently diverging.
    pub const CONTROL_HEARTBEAT: &str = "control.heartbeat";

    // Agent → Client
    pub const TERMINAL_OUTPUT: &str = "agent.terminal.output";
    pub const OK: &str = "ok";
    pub const ERROR: &str = "error";
}

/// Protocol message envelope — re-exported, not redefined (#678).
///
/// This module used to declare its own `Message<P>` with the same four fields
/// as `nession-common`'s. Two definitions of a framing contract are two answers
/// to "what is a message", kept in step by nothing; the envelope now has one
/// home in the Protocol Kernel, and this is a re-export so every existing path
/// — including `nession_agent::server::websocket::Message` in the integration
/// tests — keeps resolving.
pub use nession_protocol::Message;

// --- Request payloads (client → agent) ---

// --- Web UI compatibility payloads ---

// --- Response payloads (agent → client) ---

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

// --- Client and agent wire shapes, re-exported from the Protocol Kernel (#678) ---
pub use nession_protocol::contracts::agent::v1::{WebAgentInfo, WebAgentsListResponse};
pub use nession_protocol::contracts::client::v1::{AuthResponsePayload, ClientAuthPayload};

// --- Session wire shapes, re-exported from the Protocol Kernel (#678) ---
pub use nession_protocol::contracts::session::v1::{
    ClientAttachPayload, ClientAttachResponse, ClientDetachPayload, ClientDetachResponse,
    SessionCapturePreviewPayload, SessionCapturePreviewResponse, SessionCreatePayload,
    SessionCreateResponse, SessionInfo, SessionKillPayload, SessionKillResponse,
    SessionListResponse, WebAttachInfo, WebSessionAttachPayload, WebSessionCreatePayload,
    WebSessionCreateResponse, WebSessionInfo, WebSessionKillPayload, WebSessionKillResponse,
    WebSessionsListResponse,
};

// --- Wire shapes, re-exported from the Protocol Kernel (#678) ---
//
// These used to be declared here, which made the agent's implementation the
// contract: nothing else could name what a `terminal.input` message is, and the
// kernel — whose job is to own exactly that — could not see it. They live in
// `nession-protocol`'s `contracts/` now, and this is a re-export so every
// existing path in this crate keeps resolving.
pub use nession_protocol::contracts::file::v1::{
    FileCreateDirPayload, FileCwdPayload, FileCwdResponse, FileDeletePayload, FileListPayload,
    FileListResponse, FileMutationResponse, FileReadPayload, FileRenamePayload, FileRenameResponse,
    FileWritePayload, FileWriteResponse,
};
pub use nession_protocol::contracts::terminal::v1::{
    TerminalInputPayload, TerminalOutputPayload, TerminalResizePayload,
};

// --- Protocol helpers ---

fn now_timestamp() -> u64 {
    chrono::Utc::now().timestamp().unsigned_abs()
}

/// Extract the tmux session name from a web UI session_id.
/// Web UI uses "agent_id:session_name" format; strip the prefix if present.
pub(crate) fn extract_session_name(session_id: &str) -> String {
    session_id
        .split_once(':')
        .map(|(_, name)| name.to_string())
        .unwrap_or_else(|| session_id.to_string())
}

/// Query tmux for the current window size of `session_name` using
/// `tmux display-message -p -t <session> '#{window_width} #{window_height}'`.
///
/// Returns `(cols, rows)`. Errors if the command fails, the output cannot
/// be parsed, or the two dimensions cannot both be read as `u16`.
async fn query_window_size(session_name: &str) -> Result<(u16, u16)> {
    let output = crate::tmux::cmd::global()
        .tokio()
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
        cols,
        rows,
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

/// Flatten an `anyhow` error chain into one message.
///
/// `Error::to_string` renders only the outermost context, which hid the actual
/// cause from clients — a failed directory delete reported just the path, not
/// "Directory not empty". Joining the chain keeps the operation context while
/// surfacing the underlying OS error.
fn format_error_chain(error: &anyhow::Error) -> String {
    let mut parts = vec![error.to_string()];
    parts.extend(error.chain().skip(1).map(ToString::to_string));
    parts.join(": ")
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
    tmux_manager: SessionManager,
    file_ops: Arc<FileOps>,
    shutdown_tx: mpsc::Sender<()>,
    shutdown_rx: Option<mpsc::Receiver<()>>,
    tls_acceptor: Option<tokio_rustls::TlsAcceptor>,
    listen_address: String,
    agent_id: String,
    /// Default working directory for new tmux sessions created via P2P.
    default_working_dir: String,
    /// How the agent attaches to tmux sessions (plain PTY or control mode).
    attach_mode: AttachMode,
    /// Sink for forwarding tmux resize events to the central server (relay).
    /// Carries the FULL session id (`agent:name`), cols, rows.
    resize_tx: mpsc::UnboundedSender<(String, u16, u16)>,
}

/// Apply env snapshots to a tmux session via `set-environment`.
/// Returns warnings for keys that failed (non-fatal).
async fn apply_env_snapshots(
    tmux: &SessionManager,
    session_name: &str,
    snapshots: &[EnvSnapshot],
) -> Vec<String> {
    if snapshots.is_empty() {
        return Vec::new();
    }
    // Collect all vars from all snapshots, deduplicating by key (last wins).
    let mut seen = std::collections::HashMap::new();
    for snap in snapshots {
        for (k, v) in &snap.vars {
            seen.insert(k.clone(), v.clone());
        }
    }
    let deduped: Vec<(String, String)> = seen.into_iter().collect();
    match tmux.env().set_environment(session_name, &deduped).await {
        Ok(()) => Vec::new(),
        Err(warnings) => warnings,
    }
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

/// Everything one peer-to-peer request needs in order to be answered.
///
/// The arms of the P2P dispatch used to close over thirteen locals of
/// [`Self::handle_request`]. That is *why* the dispatch could not be
/// declared: a declaration emits both the descriptor list and the
/// dispatcher, and a dispatcher that needs thirteen things in scope cannot
/// be a free function — while a generated one taking thirteen parameters
/// trips `clippy::too_many_arguments`, and the fixes for that are an
/// `#[allow]` or a threshold change, neither of which this repository
/// permits. Bundling them makes it one parameter, which is the whole point.
///
/// The payload is deliberately **not** a field. Eighteen arms *consume* it
/// (`serde_json::from_value`), so a borrowed field would put a clone on
/// every one of them; it travels alongside instead, which also keeps the
/// eventual dispatcher at three parameters.
///
/// Borrowed rather than owned: this lives for the length of one request and
/// the caller already holds every one of these.
pub(crate) struct P2pRequest<'a> {
    /// The request id, echoed on the reply.
    id: &'a str,
    tmux: &'a Arc<SessionManager>,
    sessions: &'a Arc<Mutex<SessionMap>>,
    client_id: &'a Arc<Mutex<Option<String>>>,
    sink: &'a Arc<Mutex<futures_util::stream::SplitSink<WebSocketStream<TcpOrTls>, WsMessage>>>,
    default_working_dir: &'a str,
    file_ops: &'a Arc<FileOps>,
    listen_address: &'a str,
    agent_id: &'a str,
    /// Borrowed rather than held: `AttachMode` is not `Copy`, and taking it by
    /// value would move it out of `handle_request` for every arm that still
    /// names the local directly.
    attach_mode: &'a AttachMode,
    resize_tx: &'a mpsc::UnboundedSender<(String, u16, u16)>,
}

impl P2pRequest<'_> {
    /// The error reply, which was a closure over `id` before it was a field.
    ///
    /// A method rather than a field holding a closure: a closure field would
    /// have to be generic over its captures, and every arm calls this the
    /// same way.
    fn err(&self, code: &str, message: &str) -> String {
        serde_json::to_string(&make_error(self.id, code, message)).unwrap_or_default()
    }
}

// The peer-to-peer surface, declared once (`#678`). Invoked at module scope
// rather than inside `handle_request` so the context type above and the units
// below read together: this is what an agent answers on its own socket, and
// `handle_request` is only the envelope parsing in front of it.
p2p_routes! { ctx, msg_type, payload_value;
            "agent.session.list" => "agent.session.list" => { match ctx.tmux.list_sessions().await {
                Ok(sessions_list) => {
                    let payload = SessionListResponse {
                        sessions: sessions_list,
                        // The agent answers from its own tmux, so nothing is
                        // stale — this field exists for the Server's fan-out.
                        stale_agents: Vec::new(),
                    };
                    serde_json::to_string(&make_response(ctx.id, msg_types::OK, payload))
                        .unwrap_or_default()
                }
                Err(e) => ctx.err("list_failed", &e.to_string()),
            } }
            "agent.session.create" => "agent.session.create" => {
                let payload: SessionCreatePayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return ctx.err("parse_error", &e.to_string()),
                };
                match ctx
                    .tmux
                    .create_session(
                        &payload.name,
                        payload.width,
                        payload.height,
                        ctx.default_working_dir,
                        &[],
                    )
                    .await
                {
                    Ok(()) => {
                        // Applied after creation rather than passed to
                        // `new-session`, which is how the attach path injects
                        // its snapshots too. The field is new here — this
                        // projection had none — and accepting a parameter and
                        // then dropping it is the failure mode the rest of this
                        // change exists to remove.
                        let env_warnings =
                            apply_env_snapshots(ctx.tmux, &payload.name, &payload.env_snapshots)
                                .await;
                        for w in &env_warnings {
                            warn!("env set-environment warning for session {}: {w}", payload.name);
                        }
                        let resp = SessionCreateResponse { name: payload.name };
                        serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    Err(e) => ctx.err("create_failed", &e.to_string()),
                }
            }
            "agent.session.kill" => "agent.session.kill" => {
                let payload: SessionKillPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return ctx.err("parse_error", &e.to_string()),
                };
                match ctx.tmux.kill_session(&payload.name).await {
                    Ok(()) => {
                        let resp = SessionKillResponse { name: payload.name };
                        serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    Err(e) => ctx.err("kill_failed", &e.to_string()),
                }
            }
            "agent.session.capture-preview" => "agent.session.capture-preview" => {
                info!(
                    "agent: received session.capture_preview request id={}",
                    ctx.id
                );
                let payload: SessionCapturePreviewPayload =
                    match serde_json::from_value(payload_value) {
                        Ok(p) => p,
                        Err(e) => {
                            warn!("agent: failed to parse SessionCapturePreviewPayload: {}", e);
                            return ctx.err("parse_error", &e.to_string());
                        }
                    };
                info!(
                    "agent: capture_preview session_name={} lines={}",
                    payload.session_name, payload.lines
                );
                if payload.lines == 0 {
                    warn!("agent: capture_preview invalid lines=0");
                    return ctx.err("invalid_lines", "lines must be > 0");
                }
                if payload.lines > 100_000 {
                    warn!("agent: capture_preview lines too large: {}", payload.lines);
                    return ctx.err("lines_too_large", "lines exceeds 100000 ceiling");
                }
                match crate::tmux::util::capture_scrollback(&payload.session_name, payload.lines)
                    .await
                {
                    Ok(Some((bytes, cols, rows))) => {
                        use base64::Engine;
                        let ansi_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        info!(
                            "agent: capture_preview success, ansi_b64 length={}, cols={}, rows={}",
                            ansi_b64.len(),
                            cols,
                            rows
                        );
                        let resp = SessionCapturePreviewResponse {
                            ansi_b64,
                            cols: Some(cols),
                            rows: Some(rows),
                        };
                        serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    Ok(None) => {
                        info!("agent: capture_preview success but empty (no scrollback)");
                        let resp = SessionCapturePreviewResponse {
                            ansi_b64: String::new(),
                            cols: Some(80),
                            rows: Some(24),
                        };
                        serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    Err(e) => {
                        warn!("agent: capture_preview failed: {}", e);
                        ctx.err("capture_failed", &e.to_string())
                    }
                }
            }
            "agent.attach" => "agent.attach" => {
                let payload: ClientAttachPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return ctx.err("parse_error", &e.to_string()),
                };

                if matches!(ctx.attach_mode, AttachMode::Plain) {
                    // ---- Plain PTY path (session-shared) ----
                    let session_name = payload.session_name.clone();

                    // Apply env snapshots before PTY creation (non-fatal).
                    let env_warnings =
                        apply_env_snapshots(ctx.tmux, &session_name, &payload.env_snapshots).await;
                    if !env_warnings.is_empty() {
                        for w in &env_warnings {
                            warn!(
                                "env set-environment warning for session {}: {w}",
                                session_name
                            );
                        }
                    }

                    let mut sessions_guard = ctx.sessions.lock().await;

                    if let Some(shared) = sessions_guard.get_mut(&session_name) {
                        // Session already exists: add a new subscriber.
                        let (tx, rx) = mpsc::channel(SUBSCRIBER_QUEUE_SLOTS);
                        shared.subscribers.push(tx);
                        drop(sessions_guard);

                        spawn_output_forwarder(
                            rx,
                            Arc::clone(ctx.sink),
                            Arc::clone(ctx.sessions),
                            session_name.clone(),
                        );

                        let resp = ClientAttachResponse {
                            session_name: payload.session_name,
                        };
                        return serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                            .unwrap_or_default();
                    }

                    // Session doesn't exist yet: create PtySession + first subscriber.
                    match crate::tmux::pty::PtySession::attach(
                        &session_name,
                        payload.width,
                        payload.height,
                    ) {
                        Ok((pty_session, mut output_rx)) => {
                            let (tx, rx) = mpsc::channel(SUBSCRIBER_QUEUE_SLOTS);
                            let attached = AttachedSession {
                                backend: Box::new(pty_session),
                                subscribers: vec![tx],
                            };
                            sessions_guard.insert(session_name.clone(), attached);
                            drop(sessions_guard);

                            // Spawn forwarding task for the first subscriber.
                            spawn_output_forwarder(
                                rx,
                                Arc::clone(ctx.sink),
                                Arc::clone(ctx.sessions),
                                session_name.clone(),
                            );

                            // Spawn ONE broadcast task for this session.
                            // It reads from output_rx and fans out to ALL subscribers.
                            let sessions_clone = Arc::clone(ctx.sessions);
                            let session_name_clone = session_name.clone();
                            tokio::spawn(async move {
                                while let Some(bytes) = output_rx.recv().await {
                                    let mut guard = sessions_clone.lock().await;
                                    if let Some(s) = guard.get_mut(&session_name_clone) {
                                        // Fan out to every subscriber, pruning the
                                        // ones that are gone — closed because
                                        // their connection ended, or full because
                                        // they stopped draining. Either way they
                                        // are not attached in any useful sense,
                                        // and the fan-out must not wait for them;
                                        // see `SUBSCRIBER_QUEUE_SLOTS`.
                                        let detached = fan_out(&mut s.subscribers, &bytes);
                                        if detached > 0 {
                                            warn!(
                                                "session {session_name_clone}: detached {detached} \
                                                 subscriber(s) that stopped draining their terminal"
                                            );
                                        }
                                        if s.subscribers.is_empty() {
                                            break;
                                        }
                                    } else {
                                        break; // session removed
                                    }
                                }
                            });

                            let resp = ClientAttachResponse {
                                session_name: payload.session_name,
                            };
                            serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                                .unwrap_or_default()
                        }
                        Err(e) => ctx.err("attach_failed", &e.to_string()),
                    }
                } else {
                    // ---- Control mode path ----

                    // Apply env snapshots before control-mode attach (non-fatal).
                    let env_warnings =
                        apply_env_snapshots(ctx.tmux, &payload.session_name, &payload.env_snapshots)
                            .await;
                    if !env_warnings.is_empty() {
                        for w in &env_warnings {
                            warn!(
                                "env set-environment warning for session {}: {w}",
                                payload.session_name
                            );
                        }
                    }

                    match crate::tmux::control::ControlModeSession::attach(
                        &payload.session_name,
                        payload.width,
                        payload.height,
                    )
                    .await
                    {
                        Ok((session, mut output_rx, mut resize_rx)) => {
                            let session_name = payload.session_name.clone();
                            ctx.sessions.lock().await.insert(
                                session_name.clone(),
                                AttachedSession {
                                    backend: Box::new(session),
                                    subscribers: Vec::new(),
                                },
                            );

                            // Capture scrollback BEFORE starting the live output stream.
                            // Done synchronously (not spawned) to guarantee it arrives
                            // before any live output from the control-mode attach.
                            let scrollback_bytes =
                                match crate::tmux::util::capture_scrollback(&session_name, 2000)
                                    .await
                                {
                                    Ok(Some((bytes, _cols, _rows))) => bytes,
                                    Ok(None) | Err(_) => Vec::new(),
                                };

                            // Send captured scrollback so xterm.js can pre-fill its buffer.
                            if !scrollback_bytes.is_empty() {
                                use base64::Engine;
                                let encoded = base64::engine::general_purpose::STANDARD
                                    .encode(&scrollback_bytes);
                                let output = TerminalOutputPayload {
                                    session_name: session_name.clone(),
                                    data: encoded,
                                };
                                let msg = new_message(msg_types::TERMINAL_OUTPUT, output);
                                if let Ok(json) = serde_json::to_string(&msg) {
                                    let mut s = ctx.sink.lock().await;
                                    let _ = s.send(WsMessage::Text(json)).await;
                                }
                            }

                            // Spawn a background task that consumes the output
                            // channel from the control-mode subprocess and
                            // forwards bytes to the client as `terminal.output`
                            // messages.
                            let sink_clone = Arc::clone(ctx.sink);
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
                            // Each resize is ALSO forwarded upstream to the
                            // central server via `resize_tx` so relay clients
                            // (browser → server → agent) receive the same size
                            // updates through the server's `agent.terminal.resize`
                            // broadcast. The upstream message carries the FULL
                            // session id (`agent:name`); the P2P sink message
                            // keeps the bare session name.
                            let sink_resize = Arc::clone(ctx.sink);
                            let session_name_resize = session_name.clone();
                            let resize_tx_resize = ctx.resize_tx.clone();
                            let agent_id_resize = ctx.agent_id.to_string();
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
                                    let full_id =
                                        format!("{agent_id_resize}:{session_name_resize}");
                                    let _ = resize_tx_resize.send((full_id, cols, rows));
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
                            serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                                .unwrap_or_default()
                        }
                        Err(e) => ctx.err("attach_failed", &e.to_string()),
                    }
                }
            }
            "agent.detach" => "agent.detach" => {
                let payload: ClientDetachPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return ctx.err("parse_error", &e.to_string()),
                };
                let mut sessions_guard = ctx.sessions.lock().await;
                match sessions_guard.get_mut(&payload.session_name) {
                    Some(session) => {
                        // Drop this client's dead subscriber senders. When no
                        // live subscribers remain (always true for control
                        // mode, which keeps none), close the backend and
                        // remove the session so its tmux child is terminated.
                        session.subscribers.retain(|tx| !tx.is_closed());
                        if session.subscribers.is_empty() {
                            if let Some(mut removed) = sessions_guard.remove(&payload.session_name)
                            {
                                if let Err(e) = removed.backend.close().await {
                                    warn!(
                                        "Error closing session {}: {:#}",
                                        payload.session_name, e
                                    );
                                }
                            }
                        }
                        let resp = ClientDetachResponse {
                            session_name: payload.session_name,
                        };
                        serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    None => ctx.err(
                        "not_attached",
                        &format!("not attached to session: {}", payload.session_name),
                    ),
                }
            }
            "agent.terminal.input" => "agent.terminal.input" => {
                let payload: TerminalInputPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return ctx.err("parse_error", &e.to_string()),
                };
                use base64::Engine;
                let data = match base64::engine::general_purpose::STANDARD.decode(&payload.data) {
                    Ok(d) => d,
                    Err(e) => return ctx.err("decode_error", &e.to_string()),
                };
                let mut sessions_guard = ctx.sessions.lock().await;
                match sessions_guard.get_mut(&payload.session_name) {
                    Some(session) => match session.backend.write_input(&data).await {
                        Ok(_) => serde_json::to_string(&make_ok(ctx.id, "ok")).unwrap_or_default(),
                        Err(e) => ctx.err("write_error", &e.to_string()),
                    },
                    None => ctx.err(
                        "not_attached",
                        &format!("not attached to session: {}", payload.session_name),
                    ),
                }
            }
            "agent.terminal.resize" => "agent.terminal.resize" => {
                let payload: TerminalResizePayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return ctx.err("parse_error", &e.to_string()),
                };
                let mut sessions_guard = ctx.sessions.lock().await;
                match sessions_guard.get_mut(&payload.session_name) {
                    Some(session) => match session.backend.resize(payload.cols, payload.rows).await
                    {
                        Ok(_) => serde_json::to_string(&make_ok(ctx.id, "ok")).unwrap_or_default(),
                        Err(e) => ctx.err("resize_error", &e.to_string()),
                    },
                    None => ctx.err(
                        "not_attached",
                        &format!("not attached to session: {}", payload.session_name),
                    ),
                }
            }

            // --- Web UI compatibility handlers ---
            "client.auth" => "client.auth" => {
                let payload: ClientAuthPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => {
                        warn!("Invalid client.auth payload: {e}");
                        let resp = AuthResponsePayload {
                            status: "error".to_string(),
                            message: format!("invalid payload: {e}"),
                            // There is no client id to report — this branch
                            // rejected the payload before one was assigned. It
                            // used to send `String::new()`, which is "absent"
                            // written in the only dialect a required field
                            // allows; with the field relaxed it says so.
                            client_id: None,
                        };
                        return serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                            .unwrap_or_default();
                    }
                };

                // Use provided client_id or generate a new one
                let assigned_client_id = payload
                    .client_id
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

                // Store the client_id for this connection
                {
                    let mut cid = ctx.client_id.lock().await;
                    *cid = Some(assigned_client_id.clone());
                }

                let resp = AuthResponsePayload {
                    status: "success".to_string(),
                    message: "ok".to_string(),
                    client_id: Some(assigned_client_id),
                };
                serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp)).unwrap_or_default()
            }
            "client.sessions.list" => "client.sessions.list" => { match ctx.tmux.list_sessions().await {
                Ok(sessions_list) => {
                    let sessions: Vec<WebSessionInfo> = sessions_list
                        .into_iter()
                        .map(|s| {
                            let session_id = format!("{}:{}", ctx.agent_id, s.name);
                            WebSessionInfo {
                                session_id,
                                agent_id: ctx.agent_id.to_string(),
                                session_name: s.name,
                                status: if s.attached_clients > 0 {
                                    "active".to_string()
                                } else {
                                    "detached".to_string()
                                },
                                window_count: s.window_count,
                                attached_clients: s.attached_clients,
                                // The agent's own `list_sessions` does not
                                // carry the foreground command; the Server
                                // fills it in from a later query.
                                foreground_command: None,
                                last_activity: chrono::Utc::now().to_rfc3339(),
                            }
                        })
                        .collect();
                    let resp = WebSessionsListResponse {
                        sessions,
                        // Nothing to be stale about: this agent answers from
                        // its own tmux.
                        stale_agents: Vec::new(),
                    };
                    serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                        .unwrap_or_default()
                }
                Err(e) => ctx.err("list_failed", &e.to_string()),
            } }
            "client.session.attach" => "client.session.attach" => {
                let payload: WebSessionAttachPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return ctx.err("parse_error", &e.to_string()),
                };
                let session_name = extract_session_name(&payload.session_id);
                let resp = WebAttachInfo {
                    mode: "p2p".to_string(),
                    session_id: payload.session_id,
                    session_name,
                    agent_address: ctx.listen_address.to_string(),
                };
                serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                    .unwrap_or_default()
            }
            "client.session.create" => "client.session.create" => {
                let payload: WebSessionCreatePayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => {
                        let resp = WebSessionCreateResponse {
                            success: false,
                            session_id: None,
                            error: Some(e.to_string()),
                        };
                        return serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                            .unwrap_or_default();
                    }
                };
                match ctx
                    .tmux
                    .create_session(
                        &payload.name,
                        payload.width,
                        payload.height,
                        ctx.default_working_dir,
                        &[],
                    )
                    .await
                {
                    Ok(()) => {
                        let session_id = format!("{}:{}", ctx.agent_id, payload.name);
                        let resp = WebSessionCreateResponse {
                            success: true,
                            session_id: Some(session_id),
                            error: None,
                        };
                        serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    Err(e) => {
                        let resp = WebSessionCreateResponse {
                            success: false,
                            session_id: None,
                            error: Some(e.to_string()),
                        };
                        serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                }
            }
            "client.session.kill" => "client.session.kill" => {
                let payload: WebSessionKillPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => {
                        let resp = WebSessionKillResponse {
                            success: false,
                            error: Some(e.to_string()),
                        };
                        return serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                            .unwrap_or_default();
                    }
                };
                let session_name = extract_session_name(&payload.session_id);
                match ctx.tmux.kill_session(&session_name).await {
                    Ok(()) => {
                        let resp = WebSessionKillResponse {
                            success: true,
                            error: None,
                        };
                        serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    Err(e) => {
                        let resp = WebSessionKillResponse {
                            success: false,
                            error: Some(e.to_string()),
                        };
                        serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                }
            }

            // --- File operations ---
            "agent.file.list" => "agent.file.list" => {
                let payload: FileListPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return ctx.err("parse_error", &e.to_string()),
                };
                match ctx.file_ops.list_dir(&payload.path).await {
                    Ok(entries) => {
                        let resp = FileListResponse { entries };
                        serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    Err(e) => ctx.err("list_failed", &format_error_chain(&e)),
                }
            }
            "agent.file.read" => "agent.file.read" => {
                let payload: FileReadPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return ctx.err("parse_error", &e.to_string()),
                };
                match ctx
                    .file_ops
                    .read_file(&payload.path, payload.offset, payload.limit)
                    .await
                {
                    Ok(data) => serde_json::to_string(&make_response(ctx.id, msg_types::OK, data))
                        .unwrap_or_default(),
                    Err(e) => {
                        let msg = e.to_string();
                        if msg.contains("permission_denied") {
                            ctx.err("permission_denied", &msg)
                        } else if msg.contains("is_directory") {
                            ctx.err("is_directory", &msg)
                        } else if msg.contains("file_too_large") {
                            ctx.err("file_too_large", &msg)
                        } else {
                            ctx.err("io_error", &msg)
                        }
                    }
                }
            }
            "agent.file.write" => "agent.file.write" => {
                let payload: FileWritePayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return ctx.err("parse_error", &e.to_string()),
                };
                let path = payload.path.clone();
                match ctx.file_ops.write_file(&payload.path, &payload.content).await {
                    Ok(written) => {
                        let resp = FileWriteResponse { path, written };
                        serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    Err(e) => ctx.err("write_error", &e.to_string()),
                }
            }
            "agent.file.delete" => "agent.file.delete" => {
                let payload: FileDeletePayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return ctx.err("parse_error", &e.to_string()),
                };
                let path = payload.path.clone();
                match ctx.file_ops.delete(&payload.path, payload.recursive).await {
                    Ok(()) => {
                        let resp = FileMutationResponse {
                            path,
                            success: true,
                        };
                        serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    Err(e) => ctx.err("delete_failed", &format_error_chain(&e)),
                }
            }
            "agent.file.create-dir" => "agent.file.create-dir" => {
                let payload: FileCreateDirPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return ctx.err("parse_error", &e.to_string()),
                };
                let path = payload.path.clone();
                match ctx.file_ops.create_dir(&payload.path).await {
                    Ok(()) => {
                        let resp = FileMutationResponse {
                            path,
                            success: true,
                        };
                        serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    Err(e) => ctx.err("create_dir_failed", &format_error_chain(&e)),
                }
            }
            "agent.file.rename" => "agent.file.rename" => {
                let payload: FileRenamePayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return ctx.err("parse_error", &e.to_string()),
                };
                let from = payload.from.clone();
                let to = payload.to.clone();
                match ctx.file_ops.rename(&payload.from, &payload.to).await {
                    Ok(()) => {
                        let resp = FileRenameResponse {
                            from,
                            to,
                            success: true,
                        };
                        serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    Err(e) => ctx.err("rename_failed", &e.to_string()),
                }
            }
            "agent.file.cwd" => "agent.file.cwd" => {
                let payload: FileCwdPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return ctx.err("parse_error", &e.to_string()),
                };
                let session_name = extract_session_name(&payload.session_id);
                match ctx.tmux.get_session_cwd(&session_name).await {
                    Ok(abs_path) => match ctx.file_ops.relative_path(&abs_path) {
                        Ok(rel_path) => {
                            let resp = FileCwdResponse { path: rel_path };
                            serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                                .unwrap_or_default()
                        }
                        Err(e) => ctx.err("cwd_failed", &e.to_string()),
                    },
                    Err(e) => ctx.err("cwd_failed", &e.to_string()),
                }
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
    /// `attach_mode` controls whether to use plain PTY or control-mode tmux attach.
    /// `resize_tx` forwards `%window-resize` events to the central server (relay).
    pub fn new(
        listen_address: impl Into<String>,
        agent_id: impl Into<String>,
        tls: Option<(
            Vec<rustls::pki_types::CertificateDer<'static>>,
            rustls::pki_types::PrivateKeyDer<'static>,
        )>,
        default_working_dir: String,
        file_root: &str,
        attach_mode: AttachMode,
        resize_tx: mpsc::UnboundedSender<(String, u16, u16)>,
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
            tmux_manager: SessionManager::new(),
            file_ops,
            shutdown_tx,
            shutdown_rx: Some(shutdown_rx),
            tls_acceptor,
            listen_address: listen_address.into(),
            agent_id: agent_id.into(),
            default_working_dir,
            attach_mode,
            resize_tx,
        })
    }

    /// Start accepting connections. Returns a [`ServerHandle`] that can be
    /// used to trigger a graceful shutdown, together with the bound socket
    /// address (useful when the configured address is port 0).
    /// The server runs as a background tokio task until shutdown is signalled
    /// or the process exits.
    pub async fn start(mut self) -> Result<(ServerHandle, std::net::SocketAddr)> {
        let listener = TcpListener::bind(&self.listen_address)
            .await
            .with_context(|| format!("failed to bind {}", self.listen_address))?;

        let local_addr = listener
            .local_addr()
            .context("failed to get local address after bind")?;

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
        let attach_mode = self.attach_mode.clone();
        let resize_tx = self.resize_tx.clone();

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
                                let am = attach_mode.clone();
                                let rtx = resize_tx.clone();
                                tokio::spawn(async move {
                                    if let Err(e) =
                                        Self::handle_connection(stream, addr, tmux, tls, wd, fops, &la, &aid, am, rtx).await
                                    {
                                        // Downgraded from warn: random non-WebSocket clients
                                        // (health checks, scanners) hitting the P2P port are
                                        // expected noise, not actionable alerts.
                                        info!("connection error from {}: {:#}", addr, e);
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

        Ok((handle, local_addr))
    }

    /// Handle a single incoming TCP connection. Performs optional TLS
    /// handshake, upgrades to WebSocket, then enters the per-client
    /// message loop.
    #[allow(clippy::too_many_arguments)]
    async fn handle_connection(
        stream: tokio::net::TcpStream,
        addr: SocketAddr,
        tmux_manager: Arc<SessionManager>,
        tls_acceptor: Option<tokio_rustls::TlsAcceptor>,
        default_working_dir: String,
        file_ops: Arc<FileOps>,
        listen_address: &str,
        agent_id: &str,
        attach_mode: AttachMode,
        resize_tx: mpsc::UnboundedSender<(String, u16, u16)>,
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
            attach_mode,
            resize_tx,
        )
        .await
    }

    /// Drain incoming WebSocket frames and dispatch them.
    #[allow(clippy::too_many_arguments)]
    async fn run_message_loop(
        mut ws_stream: futures_util::stream::SplitStream<WebSocketStream<TcpOrTls>>,
        sink: Arc<Mutex<futures_util::stream::SplitSink<WebSocketStream<TcpOrTls>, WsMessage>>>,
        tmux: Arc<SessionManager>,
        sessions: Arc<Mutex<SessionMap>>,
        client_id: Arc<Mutex<Option<String>>>,
        addr: SocketAddr,
        default_working_dir: String,
        file_ops: Arc<FileOps>,
        listen_address: &str,
        agent_id: &str,
        attach_mode: AttachMode,
        resize_tx: mpsc::UnboundedSender<(String, u16, u16)>,
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
                        attach_mode.clone(),
                        resize_tx.clone(),
                    )
                    .await;
                    // `None` is a control wire that needs no frame written
                    // back; everything else answers, errors included.
                    let Some(response) = response else { continue };
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

        // Close any tmux sessions that were attached through this
        // connection so that the underlying tmux attach children are
        // terminated promptly. Closing also drops the subscriber senders,
        // stopping each session's broadcast task.
        let mut sessions_guard = sessions.lock().await;
        for (name, mut session) in sessions_guard.drain() {
            if let Err(e) = session.backend.close().await {
                warn!("Error closing session {}: {:#}", name, e);
            }
        }

        // Clean up any env scripts sourced by this client
        let client_id_guard = client_id.lock().await;
        if let Some(ref cid) = *client_id_guard {
            tmux.env().cleanup_client_scripts(cid).await;
            info!("Cleaned up env scripts for client {}", cid);
        }

        info!("Client {} disconnected", addr);
        Ok(())
    }

    /// Route a single text request to the appropriate handler.
    #[allow(clippy::too_many_arguments)]
    async fn handle_request(
        text: &str,
        tmux: Arc<SessionManager>,
        sessions: Arc<Mutex<SessionMap>>,
        client_id: Arc<Mutex<Option<String>>>,
        sink: Arc<Mutex<futures_util::stream::SplitSink<WebSocketStream<TcpOrTls>, WsMessage>>>,
        default_working_dir: &str,
        file_ops: Arc<FileOps>,
        listen_address: &str,
        agent_id: &str,
        attach_mode: AttachMode,
        resize_tx: mpsc::UnboundedSender<(String, u16, u16)>,
        // `Option`, because a control wire may produce no frame at all:
        // control has no reply mechanism, so `control.pong` and
        // `control.heartbeat` are handled and answered with silence. Every
        // other wire is answered — including the ones whose answer is an
        // `error` — so `None` is only ever a control arm's return.
    ) -> Option<String> {
        // Try to extract msg_type and id without fully deserialising the
        // payload — we need those even if the payload type is unknown.
        let raw: serde_json::Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => {
                return Some(
                    serde_json::to_string(&make_error(
                        "unknown",
                        "parse_error",
                        &format!("invalid JSON: {e}"),
                    ))
                    .unwrap_or_default(),
                );
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

        // Everything an arm needs to read, borrowed once. Before this the arms
        // named the locals directly, which is how the handler grew a closure
        // per arm to reach `id`; the struct is the same borrows with names.
        let ctx = P2pRequest {
            id: &id,
            tmux: &tmux,
            sessions: &sessions,
            client_id: &client_id,
            sink: &sink,
            default_working_dir,
            file_ops: &file_ops,
            listen_address,
            agent_id,
            attach_mode: &attach_mode,
            resize_tx: &resize_tx,
        };

        // Control wires are handled ahead of the route table, and that is a
        // consequence of the category rather than a preference. `p2p_routes!`
        // emits a *descriptor* per arm and a control wire is not a unit —
        // nothing advertises it, because it is not an offer this peer makes to
        // a caller, it is something every peer must handle. Handling them here
        // is also what keeps `control.ping` out of `dispatch_p2p`'s
        // unknown-wire error, which is the only answer that table has for a
        // name it does not carry.
        //
        // One arm per wire rather than a `starts_with("control.")` test:
        // `scripts/protocol-gate.mjs` checks that every runtime has a branch
        // for every control wire, and a prefix test is not a branch it can
        // read. `control.pong` is not this socket's reply to `control.ping` —
        // the two are independent one-way messages and nothing pairs them —
        // but the id of the ping is carried on the pong, because the envelope
        // belongs to the sender and no router derives a pairing from it.
        match msg_type {
            msg_types::CONTROL_PING => {
                return Some(
                    serde_json::to_string(&make_response(&id, msg_types::CONTROL_PONG, ()))
                        .unwrap_or_default(),
                );
            }
            msg_types::CONTROL_PONG => {
                debug!("control.pong received");
                return None;
            }
            // The arm is here because control is symmetric — every runtime
            // handles every control wire, whether or not today's senders reach
            // this one. The agent sends its heartbeat on the *other* socket.
            msg_types::CONTROL_HEARTBEAT => {
                debug!("control.heartbeat received");
                return None;
            }
            _ => {}
        }

        Some(dispatch_p2p(ctx, msg_type, payload_value).await)
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
    use crate::test_support::TestSession;
    use base64::Engine;
    use futures_util::SinkExt;
    use tokio_tungstenite::connect_async;
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    /// Start a test server (OS picks a free port). Returns the real bound
    /// address and a shutdown handle.
    async fn start_test_server_on(_port: u16) -> (SocketAddr, ServerHandle) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let (_resize_tx, _resize_rx) = mpsc::unbounded_channel::<(String, u16, u16)>();
        let server = AgentServer::new(
            "127.0.0.1:0",
            "test-agent",
            None,
            "/tmp".to_string(),
            tmp.path().to_string_lossy().as_ref(),
            AttachMode::Plain,
            _resize_tx,
        )
        .expect("server creation should succeed");
        // Leak the TempDir so the sandbox root persists for the server lifetime.
        Box::leak(Box::new(tmp));
        let (handle, addr) = server.start().await.expect("start should succeed");
        (addr, handle)
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
        let url = format!("ws://{addr}");
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
        let (_resize_tx, _resize_rx) = mpsc::unbounded_channel::<(String, u16, u16)>();
        let server = AgentServer::new(
            "127.0.0.1:0",
            "test-agent",
            None,
            "/tmp".to_string(),
            tmp.path().to_string_lossy().as_ref(),
            AttachMode::Plain,
            _resize_tx,
        )
        .unwrap();
        let (handle, _addr) = server.start().await.unwrap();

        // Shutdown should complete without error.
        handle.shutdown().await.unwrap();

        // Double shutdown should not panic (the server task just exits).
        // The send will fail because the receiver is gone, but the server
        // itself is already stopped.
        let _ = handle.shutdown().await;
    }

    /// The terminal lane's slow-consumer policy, in full (#961).
    ///
    /// Three subscribers, three outcomes from one fan-out: the one with room
    /// gets the chunk, the one that is full is **detached**, and the one whose
    /// connection is already gone is pruned. The middle case is the policy — it
    /// is what keeps the slowest client from becoming the pace of the session
    /// for every other client and for the PTY reader behind them — and it only
    /// exists because the queues are bounded. With the unbounded senders this
    /// replaced, the middle subscriber was indistinguishable from the first.
    #[tokio::test]
    async fn terminal_output_detaches_a_subscriber_that_stops_draining() {
        let (healthy, mut healthy_rx) = mpsc::channel(SUBSCRIBER_QUEUE_SLOTS);
        let (slow, slow_rx) = mpsc::channel(SUBSCRIBER_QUEUE_SLOTS);
        let (gone, gone_rx) = mpsc::channel(SUBSCRIBER_QUEUE_SLOTS);
        drop(gone_rx);

        // The slow one is filled to its bound, and its receiver is held but
        // never polled — a client that has stopped reading.
        for n in 0..SUBSCRIBER_QUEUE_SLOTS {
            slow.try_send(vec![0u8])
                .unwrap_or_else(|_| panic!("the queue must have room for chunk {n}"));
        }

        let mut subscribers = vec![healthy, slow, gone];
        assert_eq!(
            fan_out(&mut subscribers, b"output"),
            1,
            "exactly the subscriber with no room is detached"
        );
        assert_eq!(
            subscribers.len(),
            1,
            "the detached subscriber and the closed one are both gone"
        );

        // The one that remains is the healthy one — proved by the chunk it takes
        // rather than by identity, which senders do not carry.
        assert_eq!(
            healthy_rx
                .try_recv()
                .expect("the subscriber with room got the chunk"),
            b"output".to_vec()
        );
        subscribers[0]
            .try_send(b"more".to_vec())
            .expect("the remaining subscriber still has room");
        assert_eq!(
            healthy_rx
                .try_recv()
                .expect("the same subscriber got this one"),
            b"more".to_vec()
        );
        drop(slow_rx);
    }

    /// A subscriber that is keeping up is never touched, however long the
    /// session runs: the bound is a bound on backlog, not on volume.
    #[tokio::test]
    async fn terminal_output_keeps_a_subscriber_that_keeps_up() {
        let (keeping_up, mut rx) = mpsc::channel(SUBSCRIBER_QUEUE_SLOTS);
        let mut subscribers = vec![keeping_up];

        for n in 0..(SUBSCRIBER_QUEUE_SLOTS * 4) {
            assert_eq!(
                fan_out(&mut subscribers, b"chunk"),
                0,
                "detached at chunk {n}"
            );
            assert_eq!(
                rx.try_recv().expect("the subscriber is draining"),
                b"chunk".to_vec()
            );
        }
        assert_eq!(subscribers.len(), 1);
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

        let session = TestSession::new("srv-create-kill");
        let session_name = session.name().to_string();

        // Pre-clean any session left over from a previous crashed/aborted run
        // so the create below doesn't hit a duplicate-name failure.
        SessionManager::new().kill_session(&session_name).await.ok();

        // Create a session.
        let create_payload = SessionCreatePayload {
            name: session_name.clone(),
            width: 80,
            height: 24,
            env_snapshots: Vec::new(),
        };
        let create_req = new_message(msg_types::SESSION_CREATE, create_payload);
        let create_resp: Message<SessionCreateResponse> =
            send_and_receive(&mut sink, &mut stream, &create_req).await;

        assert_eq!(create_resp.msg_type, msg_types::OK);
        assert_eq!(create_resp.payload.name, session_name);

        // Kill the session.
        let kill_payload = SessionKillPayload {
            name: session_name.clone(),
        };
        let kill_req = new_message(msg_types::SESSION_KILL, kill_payload);
        let kill_resp: Message<SessionKillResponse> =
            send_and_receive(&mut sink, &mut stream, &kill_req).await;

        assert_eq!(kill_resp.msg_type, msg_types::OK);
        assert_eq!(kill_resp.payload.name, session_name);

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_client_attach_detach() {
        let (addr, handle) = start_test_server_on(18083).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        // Create a real tmux session first so attach has something to
        // connect to.
        let tmux = SessionManager::new();
        let session = TestSession::new("srv-attach");
        let session_name = session.name().to_string();
        // Pre-clean any session left over from a previous crashed/aborted run
        // so the test is re-entrant (tmux rejects a duplicate session name).
        tmux.kill_session(&session_name).await.ok();
        tmux.create_session(&session_name, 80, 24, "/tmp", &[])
            .await
            .unwrap();

        // Attach via WebSocket.
        let attach_payload = ClientAttachPayload {
            session_name: session_name.to_string(),
            width: 80,
            height: 24,
            env_snapshots: Vec::new(),
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
        tmux.kill_session(&session_name).await.ok();
        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_terminal_io_flow() {
        let (addr, handle) = start_test_server_on(18084).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let tmux = SessionManager::new();
        let session = TestSession::new("srv-io");
        let session_name = session.name().to_string();
        tmux.kill_session(&session_name).await.ok();
        tmux.create_session(&session_name, 80, 24, "/tmp", &[])
            .await
            .unwrap();

        // Attach.
        let attach_payload = ClientAttachPayload {
            session_name: session_name.to_string(),
            width: 80,
            height: 24,
            env_snapshots: Vec::new(),
        };
        let attach_req = new_message(msg_types::CLIENT_ATTACH, attach_payload);
        let attach_resp: Message<ClientAttachResponse> =
            send_and_receive(&mut sink, &mut stream, &attach_req).await;
        assert_eq!(attach_resp.msg_type, msg_types::OK);

        // Send terminal input immediately — a post-attach sleep breaks macOS PTY
        // writes (EIO) while Linux CI tolerates either timing.
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
        // Increased from 1s — under LLVM instrumentation the shell startup
        // and command execution are slower.
        tokio::time::sleep(std::time::Duration::from_millis(2000)).await;

        // Read a terminal output message from the stream.
        let mut got_output = false;
        // Increased from 5s — under LLVM instrumentation terminal I/O is slower.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
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

        tmux.kill_session(&session_name).await.ok();
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
    async fn test_capture_preview_lines_zero_rejected() {
        let (addr, handle) = start_test_server_on(0).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let payload = SessionCapturePreviewPayload {
            session_name: "any".to_string(),
            lines: 0,
        };
        let req = new_message(msg_types::SESSION_CAPTURE_PREVIEW, payload);
        let resp: Message<ErrorPayload> = send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.msg_type, msg_types::ERROR);
        assert_eq!(resp.payload.code, "invalid_lines");

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_capture_preview_lines_too_large_rejected() {
        let (addr, handle) = start_test_server_on(0).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let payload = SessionCapturePreviewPayload {
            session_name: "any".to_string(),
            lines: 200_000,
        };
        let req = new_message(msg_types::SESSION_CAPTURE_PREVIEW, payload);
        let resp: Message<ErrorPayload> = send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.msg_type, msg_types::ERROR);
        assert_eq!(resp.payload.code, "lines_too_large");

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_capture_preview_unknown_session_returns_error() {
        let (addr, handle) = start_test_server_on(0).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let payload = SessionCapturePreviewPayload {
            session_name: "nession-test-does-not-exist-xyz".to_string(),
            lines: 100,
        };
        let req = new_message(msg_types::SESSION_CAPTURE_PREVIEW, payload);
        let resp: Message<ErrorPayload> = send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.msg_type, msg_types::ERROR);
        assert_eq!(resp.payload.code, "capture_failed");

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_capture_preview_valid_request_returns_base64() {
        let (addr, handle) = start_test_server_on(0).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let tmux = SessionManager::new();
        let session = TestSession::new("srv-preview");
        let session_name = session.name().to_string();
        tmux.kill_session(&session_name).await.ok();
        tmux.create_session(&session_name, 80, 24, "/tmp", &[])
            .await
            .unwrap();
        crate::tmux::util::send_keys(&session_name, "echo hello-from-preview")
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        let payload = SessionCapturePreviewPayload {
            session_name: session_name.clone(),
            lines: 100,
        };
        let req = new_message(msg_types::SESSION_CAPTURE_PREVIEW, payload);
        let resp: Message<SessionCapturePreviewResponse> =
            send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.msg_type, msg_types::OK);
        assert!(!resp.payload.ansi_b64.is_empty());
        // Decode and check for the marker text.
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&resp.payload.ansi_b64)
            .expect("valid base64");
        let text = String::from_utf8_lossy(&decoded);
        assert!(
            text.contains("hello-from-preview"),
            "expected decoded output to contain marker, got: {text:?}"
        );

        tmux.kill_session(&session_name).await.ok();
        handle.shutdown().await.ok();
    }

    /// A ping is answered with a pong — and the test says only that, because
    /// the two are independent one-way messages rather than a request and its
    /// reply. Nothing in the protocol pairs them; what `send_and_receive` does
    /// here is wait for *a* frame, and the id it filters on is the envelope's
    /// id echoed by the sender, not a correlation the receiver derives.
    #[tokio::test]
    async fn a_control_ping_is_met_with_a_control_pong() {
        let (addr, handle) = start_test_server_on(18092).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let req: Message<serde_json::Value> = Message {
            msg_type: msg_types::CONTROL_PING.to_string(),
            id: "ka-test-123".to_string(),
            timestamp: now_timestamp(),
            payload: serde_json::json!({}),
        };
        let resp: Message<serde_json::Value> = send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.msg_type, msg_types::CONTROL_PONG);
        assert_eq!(resp.id, "ka-test-123");

        handle.shutdown().await.ok();
    }

    /// Every runtime handles every control wire, and the peer-to-peer socket is
    /// one of the three runtimes. The two wires below are the ones this socket
    /// handles without writing anything back — control has no reply mechanism —
    /// and the assertion is that neither is answered *and* neither is refused
    /// as an unknown message, which is what `dispatch_p2p` does with a wire it
    /// does not carry.
    #[tokio::test]
    async fn the_other_control_wires_are_handled_and_answered_with_silence() {
        // The argument is vestigial — `start_test_server_on` ignores it and
        // binds `127.0.0.1:0` — so it is `0` rather than a number that reads
        // like a real port.
        let (addr, handle) = start_test_server_on(0).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        for wire in [msg_types::CONTROL_PONG, msg_types::CONTROL_HEARTBEAT] {
            let req: Message<serde_json::Value> = Message {
                msg_type: wire.to_string(),
                id: format!("ctl-{wire}"),
                timestamp: now_timestamp(),
                payload: serde_json::json!({}),
            };
            sink.send(WsMessage::Text(serde_json::to_string(&req).unwrap()))
                .await
                .unwrap();

            // Nothing may come back. An unhandled wire would be answered with
            // `unknown_message_type` — which is the arm `dispatch_p2p` has for
            // a name it does not carry — so silence is exactly the evidence
            // wanted, and a follow-up ping would not have supplied it: a
            // refusal carries the *control* frame's id and so would be skipped
            // on the way to the pong.
            let quiet =
                tokio::time::timeout(std::time::Duration::from_millis(250), stream.next()).await;
            assert!(
                quiet.is_err(),
                "`{wire}` was answered, but a control wire has no reply"
            );

            // …and the socket is still usable, so the arm consumed the frame
            // rather than wedging the loop.
            let ping: Message<serde_json::Value> = Message {
                msg_type: msg_types::CONTROL_PING.to_string(),
                id: format!("after-{wire}"),
                timestamp: now_timestamp(),
                payload: serde_json::json!({}),
            };
            let pong: Message<serde_json::Value> =
                send_and_receive(&mut sink, &mut stream, &ping).await;
            assert_eq!(pong.msg_type, msg_types::CONTROL_PONG);
            assert_eq!(pong.id, format!("after-{wire}"));
        }

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
            other => panic!("expected text frame, got {other:?}"),
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
                offset: None,
                limit: None,
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

        // full_path carries the absolute on-disk path for "copy full path".
        let full_path = entries[0]
            .get("full_path")
            .and_then(|v| v.as_str())
            .expect("entry should have a full_path");
        assert!(
            full_path.starts_with('/'),
            "full_path must be absolute: {full_path}"
        );
        assert!(
            full_path.ends_with("/rt/from_list.txt"),
            "full_path must reference the entry: {full_path}"
        );

        // 3. Read the file using the path returned by list_dir.
        let read_req = new_message(
            msg_types::FILE_READ,
            FileReadPayload {
                path: entry_path.to_string(),
                offset: None,
                limit: None,
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
                recursive: false,
            },
        );
        let del_resp: Message<serde_json::Value> =
            send_and_receive(&mut sink, &mut stream, &del_req).await;
        assert_eq!(del_resp.msg_type, msg_types::OK);
        assert!(del_resp
            .payload
            .get("success")
            .and_then(serde_json::Value::as_bool)
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
                recursive: false,
            },
        );
        let del_resp: Message<serde_json::Value> =
            send_and_receive(&mut sink, &mut stream, &del_req).await;
        assert_eq!(del_resp.msg_type, msg_types::OK);
        assert!(del_resp
            .payload
            .get("success")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false));

        let read_req = new_message(
            msg_types::FILE_READ,
            FileReadPayload {
                path: "to_delete.txt".to_string(),
                offset: None,
                limit: None,
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
                offset: None,
                limit: None,
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
        assert!(create_resp
            .payload
            .get("success")
            .unwrap()
            .as_bool()
            .unwrap());

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
                recursive: true,
            },
        );
        let _ = send_and_receive::<_, serde_json::Value>(&mut sink, &mut stream, &del_req).await;
        let del_req = new_message(
            msg_types::FILE_DELETE,
            FileDeletePayload {
                path: "test_dir".to_string(),
                recursive: true,
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
        assert!(rename_resp
            .payload
            .get("success")
            .unwrap()
            .as_bool()
            .unwrap());

        // Read from new location
        let read_req = new_message(
            msg_types::FILE_READ,
            FileReadPayload {
                path: "new_name.txt".to_string(),
                offset: None,
                limit: None,
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
                recursive: false,
            },
        );
        let _ = send_and_receive::<_, serde_json::Value>(&mut sink, &mut stream, &del_req).await;

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_terminal_input_invalid_base64() {
        let (addr, handle) = start_test_server_on(18095).await;
        let (mut sink, mut stream) = connect_client(addr).await;

        let tmux = SessionManager::new();
        let session = TestSession::new("srv-invalid-b64");
        let session_name = session.name().to_string();
        tmux.kill_session(&session_name).await.ok();
        tmux.create_session(&session_name, 80, 24, "/tmp", &[])
            .await
            .unwrap();

        // Attach first
        let attach_payload = ClientAttachPayload {
            session_name: session_name.to_string(),
            width: 80,
            height: 24,
            env_snapshots: Vec::new(),
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

        tmux.kill_session(&session_name).await.ok();
        handle.shutdown().await.ok();
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
        // not-protocol: this test is about the envelope, not about any wire.
        let msg = new_message("test.type", serde_json::json!({"key": "value"}));
        assert_eq!(msg.msg_type, "test.type");
        assert!(!msg.id.is_empty());
        assert!(uuid::Uuid::parse_str(&msg.id).is_ok());
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
        assert!(p.env_snapshots.is_empty());
    }

    #[test]
    fn test_client_attach_payload_with_env_snapshots() {
        let json = serde_json::json!({
            "session_name": "s",
            "width": 120,
            "height": 40,
            "env_snapshots": [{
                "name": "test.env",
                "source": "server",
                "vars": [["KEY", "VAL"]],
                "warnings": []
            }]
        });
        let p: ClientAttachPayload = serde_json::from_value(json).unwrap();
        assert_eq!(p.env_snapshots.len(), 1);
        assert_eq!(p.env_snapshots[0].name, "test.env");
        assert_eq!(
            p.env_snapshots[0].vars[0],
            ("KEY".to_string(), "VAL".to_string())
        );
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
        assert_eq!(resp.payload.client_id.as_deref(), Some("my-client-id"));

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
        // The Agent mints an id when the caller sends none, so the *success*
        // branch always has one to name — it is a valid UUID, not a placeholder.
        // `expect` rather than a weaker assertion: a `None` here would mean the
        // branch that is supposed to mint has stopped, which is the thing this
        // test exists to catch.
        let client_id = resp.payload.client_id.expect("success names a client");
        assert!(uuid::Uuid::parse_str(&client_id).is_ok());

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

        let session = TestSession::new("web-create-kill");
        let session_name = session.name().to_string();
        let expected_session_id = format!("test-agent:{session_name}");

        // Pre-clean
        SessionManager::new().kill_session(&session_name).await.ok();

        let create_payload = WebSessionCreatePayload {
            agent_id: "test-agent".to_string(),
            name: session_name.clone(),
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
            Some(expected_session_id.clone())
        );

        // Kill via web UI
        let kill_payload = WebSessionKillPayload {
            session_id: expected_session_id,
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
            cols: 120,
            rows: 40,
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

    // --- The declared P2P surface (#678) ---

    /// Every wire this agent answers on its own socket, as the constants that
    /// name them.
    ///
    /// The response types in `msg_types` — `ok`, `error`, `terminal.output` —
    /// are deliberately absent: they are what an answer looks like, not
    /// something a peer asks for, and a manifest that offered them would be
    /// claiming a call that does not exist. `control.ping` and `control.pong`
    /// are absent for a different reason: they are not units at all, they are
    /// handled ahead of the route table, and their symmetry is checked by
    /// `scripts/protocol-gate.mjs` rather than by a descriptor.
    const REQUEST_WIRES: &[&str] = &[
        msg_types::SESSION_LIST,
        msg_types::SESSION_CREATE,
        msg_types::SESSION_KILL,
        msg_types::SESSION_CAPTURE_PREVIEW,
        msg_types::CLIENT_ATTACH,
        msg_types::CLIENT_DETACH,
        msg_types::TERMINAL_INPUT,
        msg_types::TERMINAL_RESIZE,
        msg_types::CLIENT_AUTH,
        msg_types::CLIENT_SESSIONS_LIST,
        msg_types::CLIENT_SESSION_ATTACH,
        msg_types::CLIENT_SESSION_CREATE,
        msg_types::CLIENT_SESSION_KILL,
        msg_types::FILE_LIST,
        msg_types::FILE_READ,
        msg_types::FILE_WRITE,
        msg_types::FILE_DELETE,
        msg_types::FILE_CREATE_DIR,
        msg_types::FILE_RENAME,
        msg_types::FILE_CWD,
    ];

    #[test]
    fn every_request_wire_the_agent_speaks_is_declared_as_a_unit() {
        // The invocation derives its descriptors and its arms from one list, so
        // "advertised but unrouted" and "routed but unadvertised" cannot happen
        // *inside* it. What this holds is the seam in front: a constant added
        // here and never routed is a wire the rest of the crate can build a
        // request for and the agent will answer `unknown_message_type`.
        for wire in REQUEST_WIRES {
            assert!(
                P2P_WIRES.contains(wire),
                "`{wire}` has a message-type constant but no route — a client can \
                 build this request and nothing answers it"
            );
        }
    }

    #[test]
    fn every_declared_p2p_wire_is_one_the_agent_names() {
        // The other direction of the same seam, and the one that catches an arm
        // whose wire was written as a literal instead of the constant that is
        // supposed to name it.
        for wire in P2P_WIRES {
            assert!(
                REQUEST_WIRES.contains(wire),
                "`{wire}` is routed but has no message-type constant"
            );
        }
    }

    #[test]
    fn the_declared_units_are_the_ones_the_manifest_will_offer() {
        let descriptors = p2p_descriptors().expect("the p2p units name themselves");
        let ids: Vec<&str> = descriptors.iter().map(|d| d.id.as_str()).collect();

        assert_eq!(descriptors.len(), P2P_WIRES.len());
        assert!(ids.contains(&"agent.session.create"));
        assert!(ids.contains(&"agent.terminal.input"));
        assert!(ids.contains(&"agent.file.read"));

        // `ProtocolId` refuses underscores, so three units are spelled
        // differently from the wire they answer. A provider that passed the
        // wire string through would produce an id the registry rejects — which
        // these three would have done silently had `v1_descriptor` not been the
        // only way to build one.
        assert!(ids.contains(&"agent.session.capture-preview"));
        assert!(ids.contains(&"agent.file.create-dir"));
        assert!(
            !ids.contains(&"agent.session.capture_preview"),
            "the wire spelling is not an id — `ProtocolId` refuses underscores, \
             so the hyphenated form is the only one that can exist"
        );
    }
}
