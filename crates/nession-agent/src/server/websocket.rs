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
use crate::p2p_credentials::{ConnectionAuthority, P2pCredentials, WireScope};
use crate::protocol::p2p_routes;
use crate::server::execution::ExecutionPolicy::{Inline, Key, Ordered, Query};
use crate::server::execution::{
    ExecutionLanes, ResourceKey, DEFAULT_MUTATIONS_IN_FLIGHT, SHUTDOWN_GRACE,
};
use crate::server::session_terminal;
// The lanes' boxed work is the shared type, and the constructors take this
// socket's own bounds — see `nession_runtime::lane`.
use crate::server::outbound::{self, OutboundError, P2pOutbound};
use crate::server::resize::ResizeReporter;
use crate::tmux::manager::SessionManager;
use crate::tmux::session::TmuxSession;
use anyhow::{Context, Result};
use futures_util::StreamExt;
use nession_protocol::contracts::env::v1::EnvSnapshot;
use nession_runtime::lane::{KeyedLane, Work};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::handshake::server::{
    Request as UpgradeRequest, Response as UpgradeResponse,
};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::WebSocketStream;
use tracing::{debug, error, info, warn};

// The socket itself belongs to `crate::server::outbound`'s writer, and every
// caller here holds a `P2pOutbound` handle: a bounded queue with a policy per
// lane (`#961-E`). It used to be a bare `Arc<Mutex<SplitSink>>` — see that
// module for what an unbounded socket write turns into, and why the writer task
// is a task rather than a lock.

/// A tmux attach session, shared by all clients attached through this
/// connection. Created on first attach, destroyed on last detach.
///
/// The `backend` is either a plain PTY or a control-mode session, hidden
/// behind [`TmuxSession`] so callers dispatch input/resize/close uniformly.
/// `subscribers` fans terminal output out to every attached client; the
/// control-mode path forwards output directly and leaves this empty.
type OutputChunk = (Vec<u8>, u64, u64);

#[derive(Clone)]
struct SessionPeer {
    client_id: String,
    outbound: P2pOutbound,
    /// PTY multi-client fan-out; `None` for control-mode (direct outbound).
    output_tx: Option<mpsc::Sender<OutputChunk>>,
    /// Set by [`fan_out_peers`] when it drops this peer for a full queue.
    ///
    /// The forwarder's receiver ends for several reasons — the session ended,
    /// a newer attach of the same client replaced this peer, an explicit
    /// detach, this eviction — and only the eviction may close the connection
    /// (#1226). The cause therefore travels with the channel instead of being
    /// re-derived from the session map at the receiver's end, where "the peer
    /// is gone" and "the peer was replaced" used to be indistinguishable.
    detached_for_not_draining: Arc<AtomicBool>,
}

struct AttachedSession {
    /// The backend, behind its *own* lock (`#961-D`).
    ///
    /// This is what keeps the connection's `SessionMap` mutex short: a frame
    /// takes the map lock only long enough to find the session and clone this
    /// `Arc`, and the backend's I/O — a PTY write, a control-mode resize, a
    /// close that kills a tmux child — happens with the map lock released. The
    /// lock that *is* held across that I/O is this one, and it is the
    /// per-session resource rather than the connection's index of sessions.
    ///
    /// Two frames cannot contend for it: `attach`, `detach`, `terminal.input`
    /// and `terminal.resize` all carry the same resource key, so the key lane
    /// runs at most one of them at a time for a given session name.
    backend: Arc<Mutex<Box<dyn TmuxSession>>>,
    /// Live connections for this session (output fan-out + control notifications).
    peers: Vec<SessionPeer>,
    control: session_terminal::SessionControlState,
    stream: session_terminal::SessionStreamState,
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
#[cfg(test)]
fn fan_out(subscribers: &mut Vec<mpsc::Sender<OutputChunk>>, chunk: OutputChunk) -> usize {
    let mut detached = 0usize;
    subscribers.retain(|tx| match tx.try_send(chunk.clone()) {
        Ok(()) => true,
        Err(mpsc::error::TrySendError::Full(_)) => {
            detached += 1;
            false
        }
        Err(mpsc::error::TrySendError::Closed(_)) => false,
    });
    detached
}

fn fan_out_peers(peers: &mut Vec<SessionPeer>, chunk: OutputChunk) -> usize {
    let mut detached = 0usize;
    peers.retain(|peer| {
        let Some(tx) = &peer.output_tx else {
            return true;
        };
        match tx.try_send(chunk.clone()) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                // Tell the forwarder *why* its channel is ending before the
                // drop ends it — the one cause that must reach the client as
                // a closed connection (#1226).
                peer.detached_for_not_draining
                    .store(true, Ordering::Release);
                detached += 1;
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        }
    });
    detached
}

async fn connection_client_id(client_id: &Arc<Mutex<Option<String>>>) -> String {
    client_id
        .lock()
        .await
        .clone()
        .unwrap_or_else(|| "unknown-client".to_string())
}

fn client_attach_response(
    session_name: String,
    session: &AttachedSession,
    client_id: &str,
) -> ClientAttachResponse {
    let role = session.control.role_of(client_id);
    ClientAttachResponse {
        session_name,
        control_generation: Some(session.control.generation),
        control_role: Some(
            if role == session_terminal::TerminalRole::Controller {
                "controller"
            } else {
                "observer"
            }
            .to_string(),
        ),
        controller_client_id: session.control.controller_client_id.clone(),
        stream_epoch: Some(session.stream.epoch),
        stream_cursor: Some(session.stream.cursor()),
    }
}

async fn notify_control_changed(peers: &[SessionPeer], payload: TerminalControlChangedPayload) {
    let msg = new_message(msg_types::TERMINAL_CONTROL_CHANGED, payload);
    let Ok(json) = serde_json::to_string(&msg) else {
        return;
    };
    for peer in peers {
        let _ = peer
            .outbound
            .send_terminal(WsMessage::Text(json.clone()))
            .await;
    }
}

/// Forward one subscriber's terminal output to this connection's sink, and —
/// only when this subscriber was detached for not draining it — close the
/// connection.
///
/// The receiver ends for several reasons, and they are not the same event:
///
/// * **the session ended** (the PTY or the control-mode reader closed and the
///   fan-out task went with it). This connection may be serving other sessions,
///   so nothing is closed here: the other attachments are still running, and
///   ending their socket because one session exited would be a bug of its own.
/// * **the peer was replaced** — a newer `agent.attach` of the same client
///   superseded it (`already_attached`), or the client sent `agent.detach`.
///   The client already knows, or has a fresh forwarder of its own; closing
///   here would take that fresh attach's connection down with no reply
///   (#1226, where "the peer is gone" was misread as the next case).
/// * **this subscriber was detached** for having no room ([`SUBSCRIBER_QUEUE_SLOTS`]),
///   which is the one case where the client must be told. What the client is
///   holding is a terminal that has stopped moving with nothing coming to say
///   so. A `Close` is the only thing this path can say it with, and the
///   client's own reconnect is what turns it into a redrawn screen.
///
/// The verdict is not re-derived from the session map: `fan_out_peers` sets
/// `detached_for_not_draining` when it evicts this subscriber, and the flag
/// is the whole of the third case. Any state-based check has to tell "the
/// peer is gone" apart from "a peer with the same client id is back" under
/// one lock, and both of those are true of a replacement.
///
/// It used to be one task per subscriber inline in the attach arms, twice, and
/// the only difference between the two was which names the locals had.
fn spawn_output_forwarder(
    mut rx: mpsc::Receiver<OutputChunk>,
    outbound: P2pOutbound,
    session_name: String,
    detached_for_not_draining: Arc<AtomicBool>,
) {
    tokio::spawn(async move {
        while let Some((bytes, stream_epoch, stream_seq)) = rx.recv().await {
            use base64::Engine;
            let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
            let output = TerminalOutputPayload {
                session_name: session_name.clone(),
                data: encoded,
                stream_epoch: Some(stream_epoch),
                stream_seq: Some(stream_seq),
                // Live output, not the session's history: the bootstrap
                // marker lands here in S4b (#321).
                bootstrap: None,
            };
            let msg = new_message(msg_types::TERMINAL_OUTPUT, output);
            if let Ok(json) = serde_json::to_string(&msg) {
                // Terminal output goes on the terminal lane, which waits for
                // room and gives up at the stall grace. A verdict there is not
                // this forwarder's to act on twice — another session's
                // forwarder may reach it first — so the connection is closed
                // and this task ends with it.
                match outbound.send_terminal(WsMessage::Text(json)).await {
                    Ok(()) => {}
                    Err(OutboundError::Stalled) => {
                        outbound.close();
                        return;
                    }
                    Err(_) => return,
                }
            }
        }

        if detached_for_not_draining.load(Ordering::Acquire) {
            info!(
                "session {session_name}: subscriber was detached for not draining its terminal; \
                 closing the connection"
            );
            outbound.close();
            return;
        }
        info!("terminal output for session {session_name} ended");
    });
}

/// Per-connection map of attached sessions, keyed by session name.
type SessionMap = std::collections::HashMap<String, AttachedSession>;

/// The connection's map of attached sessions, and the reason it is a **std**
/// mutex rather than a `tokio` one (`#961-D`).
///
/// `#961` asks for a stronger thing than "the map lock is usually short": it
/// asks that no backend I/O ever happens with the map held, because a `close`
/// that terminates a tmux child or a PTY write that waits on a full pipe then
/// becomes a lock that every other frame on the connection waits behind. A
/// `tokio::sync::Mutex` cannot express that — it is *made* to be held across an
/// await, and `clippy::await_holding_lock` deliberately does not look at it.
///
/// A `std::sync::Mutex` can: its guard is not `Send`, so a guard held across an
/// await makes the enclosing future non-`Send`, and every task that carries one
/// of these arms is spawnable only if it is `Send` ([`Work`], and
/// `tokio::spawn` for the fan-out and forwarder tasks). The discipline is
/// therefore checked by the compiler and by `clippy::await_holding_lock` (deny
/// in this workspace) rather than by whoever reads the arm next.
///
/// The cost is a second mutex type in one file, and it is paid deliberately:
/// the sections here are `HashMap` operations, so the blocking is bounded by
/// another thread's insert — while the thing being prevented has no bound at
/// all.
type SessionMapLock = std::sync::Mutex<SessionMap>;

/// Take the connection's session map.
///
/// Poisoning is ignored, as in `server::resize`: every section under this lock
/// is a map operation that cannot leave the map half-written, so a panic
/// somewhere else must not turn into a connection that can never touch its own
/// sessions again.
fn sessions_lock(sessions: &SessionMapLock) -> std::sync::MutexGuard<'_, SessionMap> {
    sessions
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

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
    pub const TERMINAL_CONTROL_ACQUIRE: &str = "agent.terminal.control.acquire";
    pub const TERMINAL_STREAM_RESUME: &str = "agent.terminal.stream.resume";

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
    pub const TERMINAL_CONTROL_CHANGED: &str = "agent.terminal.control.changed";
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
    TerminalBootstrapPayload, TerminalControlAcquirePayload, TerminalControlAcquireResponse,
    TerminalControlChangedPayload, TerminalInputPayload, TerminalOutputPayload,
    TerminalResizePayload, TerminalStreamResumePayload, TerminalStreamResumeResponse,
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

/// The wire frame for a `terminal.resize`, carrying the stream position it was
/// recorded at when it has one (#1303).
///
/// `position` is the whole distinction the payload's two stream fields draw: a
/// resize that **consumed a sequence number** is an event in the session's
/// timeline and must reach the client as one, while a resize that only reports
/// a size is a **level** and carries no position — which is byte-for-byte the
/// frame this produced before those fields existed.
fn terminal_resize_frame(
    session_name: &str,
    cols: u16,
    rows: u16,
    position: Option<(u64, u64)>,
) -> Option<String> {
    let payload = TerminalResizePayload {
        session_name: session_name.to_string(),
        cols,
        rows,
        control_generation: None,
        stream_epoch: position.map(|(epoch, _)| epoch),
        stream_seq: position.map(|(_, seq)| seq),
    };
    let msg = new_message(msg_types::TERMINAL_RESIZE, payload);
    serde_json::to_string(&msg).ok()
}

/// Send a single `terminal.resize` message on this connection's outbound path.
/// Returns `true` while the connection is usable, `false` once it is over.
///
/// A resize is a *level*, so it rides the lane that is allowed to drop it
/// ([`outbound::P2pOutbound::try_send_state`]): a client too far behind to take
/// one is too far behind to render the frame it changes, and it restates its own
/// size when its viewport moves or when it re-attaches. `Saturated` is therefore
/// not a failure — the connection is still good — which is why only `Closed`
/// stops the caller.
///
/// **Levels only.** A resize the agent *recorded* consumed a sequence number,
/// and dropping that frame is what opens the hole #1303 is about — so the
/// recorded one goes through [`send_recorded_resize_msg`] instead, which is the
/// same frame on the lane that does not drop.
async fn send_terminal_resize_msg(
    outbound: &P2pOutbound,
    session_name: &str,
    cols: u16,
    rows: u16,
) -> bool {
    let Some(json) = terminal_resize_frame(session_name, cols, rows, None) else {
        return true;
    };
    !matches!(
        outbound.try_send_state(WsMessage::Text(json)),
        Err(OutboundError::Closed)
    )
}

/// Send the resize the agent just recorded, so the sequence number it consumed
/// reaches the client that has to account for it (#1303).
///
/// `record_resize` bumps `next_seq`, and the client's cursor is contiguous by
/// construction: every sequence number has to arrive, in order, or the next
/// live frame is held until a resume round trip fills the hole. Not sending one
/// was therefore not a lost frame but a **guaranteed** hole — measured as one
/// per attach, because the client fits its terminal and resizes on the way in,
/// so the hole sat at seq 1 between the attach's seeded cursor and the first
/// output frame.
///
/// The **terminal lane** rather than the level lane, for the reason above: a
/// dropped event is a hole, and [`P2pOutbound::send_terminal`] is the only lane
/// that never silently drops. A stall is not acted on here — the reply this
/// handler writes immediately afterwards is the verdict on a peer that stopped
/// draining, and it is the reader that ends the connection on a failed write
/// (`Routed::serve`).
async fn send_recorded_resize_msg(
    outbound: &P2pOutbound,
    session_name: &str,
    cols: u16,
    rows: u16,
    position: (u64, u64),
) {
    let Some(json) = terminal_resize_frame(session_name, cols, rows, Some(position)) else {
        return;
    };
    if outbound.send_terminal(WsMessage::Text(json)).await.is_err() {
        debug!(
            "session {session_name}: the resize at seq {} did not reach a peer that stopped \
             draining; the reply that follows carries the verdict",
            position.1
        );
    }
}

/// Take `session`'s history from a separate tmux process — the capture for
/// the backends that have no control channel to take it on (#1228).
///
/// The Control arm's capture is exact: taken on the control channel, where
/// tmux's own wire order says what the snapshot covers and the live stream
/// the caller is about to spawn starts after it by construction. Here nothing
/// orders the capture against that stream: a producer racing it can put a
/// line in both, the window #1228 was opened for. The duplication is bounded
/// (attach-to-capture), and the alternative — no bootstrap — is worse, so
/// these arms accept it; the exact barrier belongs to the channel that can
/// have one.
///
/// A failure is logged and flattens to `None`: a client with no history is a
/// client with an empty screen, the state every attach was in before #321.
async fn capture_for_bootstrap(
    tmux: &crate::tmux::ops::TmuxDep,
    session_name: &str,
    lines: u32,
) -> Option<Vec<u8>> {
    match tmux.ops().capture_pane(session_name, lines).await {
        Ok(capture) => capture,
        Err(e) => {
            warn!("bootstrap: capture for {session_name} failed: {e:#}");
            None
        }
    }
}

/// Send `session`'s history to one connection, marked as a **bootstrap** (#321).
///
/// Awaited, and in order, before the caller starts live forwarding. That
/// ordering *is* the barrier on the send side: the live producer does not
/// exist yet and the outbound queue is FIFO, so nothing the session produces
/// can overtake the snapshot — there is no gap to close and nothing to
/// reconcile afterwards. The alternative, a cursor plus a reconciliation
/// pass, is the shape #1148 measured going wrong.
///
/// `capture` is the snapshot, and where it came from is the barrier's other
/// half (#1228): the Control arm's is taken **on the control channel**
/// (`ControlModeSession::attach`), where tmux's own wire order makes "what
/// the snapshot covers" exact; the PTY arms' comes from a separate tmux
/// process (`capture_for_bootstrap`), where a racing producer can put a line
/// in both snapshot and stream.
///
/// **Not recorded in the stream log.** A bootstrap is a snapshot taken *before*
/// the stream, not an event in it. Giving it a `stream_seq` would put it inside
/// `agent.terminal.stream.resume`'s replay window, which is duplication by
/// construction. It carries no epoch or seq for the same reason — see
/// `TerminalOutputPayload::bootstrap`.
///
/// Returns `false` once the connection is over. **A missing capture is not
/// that**: `None` is a capture that failed, came back empty, or was never
/// requested — a client with no history is a client with an empty screen,
/// which is the state every attach was in before this existed. No frame is
/// sent and the attach proceeds.
async fn send_bootstrap(
    outbound: &P2pOutbound,
    tmux: &crate::tmux::ops::TmuxDep,
    session_name: &str,
    capture: Option<Vec<u8>>,
) -> bool {
    let lines = crate::tmux::HISTORY_LIMIT_LINES;
    let Some(mut capture) = capture else {
        return true;
    };
    // The pane's modes, prepended to the text — see
    // `bootstrap::mode_escapes` for what a capture cannot carry. A query that
    // fails costs the modes and not the history: a client with the session's
    // text and default modes is strictly better off than one with nothing, and
    // that is the same judgement the capture failure above makes.
    let modes = match tmux.ops().pane_mode_flags(session_name).await {
        Ok(flags) => crate::server::bootstrap::mode_escapes(&flags),
        Err(e) => {
            warn!("bootstrap: pane modes for {session_name} failed: {e:#}");
            Vec::new()
        }
    };
    // The pane's unwritten screen is dropped before anything else, so what
    // follows counts history rather than geometry — `capture-pane` ends at the
    // bottom of the visible pane, and on a shell that has not filled its screen
    // most of what it returns is rows nothing was ever written to.
    crate::server::bootstrap::strip_trailing_blank_rows(&mut capture);
    // The ceiling is applied to the *capture*, before the two translations
    // below. Both of them grow the frame — the escapes by under 100 bytes, the
    // CRs by one per line — and counting either against the ceiling would make
    // it a different number of history bytes depending on which modes happened
    // to be on and how the lines happened to be split.
    let bounded = crate::server::bootstrap::bound(capture);
    let text = crate::server::bootstrap::as_terminal_stream(&bounded.bytes);
    let mut bytes = Vec::with_capacity(modes.len() + text.len());
    // Modes first, so the application's screen is entered before its text is
    // written into it.
    bytes.extend_from_slice(&modes);
    bytes.extend_from_slice(&text);
    let bounded = crate::server::bootstrap::Bounded {
        bytes,
        truncated: bounded.truncated,
    };
    use base64::Engine;
    let payload = TerminalOutputPayload {
        session_name: session_name.to_string(),
        data: base64::engine::general_purpose::STANDARD.encode(&bounded.bytes),
        stream_epoch: None,
        stream_seq: None,
        bootstrap: Some(TerminalBootstrapPayload {
            requested_lines: lines,
            truncated: bounded.truncated,
        }),
    };
    let msg = new_message(msg_types::TERMINAL_OUTPUT, payload);
    let Ok(json) = serde_json::to_string(&msg) else {
        return true;
    };
    match outbound.send_terminal(WsMessage::Text(json)).await {
        Ok(()) => true,
        Err(OutboundError::Stalled) => {
            // The honest verdict, and the same one the live-output task takes:
            // a client that cannot drain a one-off snapshot is not going to
            // drain the session behind it.
            warn!("bootstrap: client stalled on the snapshot for {session_name}");
            outbound.close();
            false
        }
        Err(_) => false,
    }
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
/// What the runtime composition lends this server, as opposed to what it
/// configures it with.
///
/// Grouped because they travel together and for no other reason: `runtime.rs`
/// builds each of them exactly once and hands the *same* values to the
/// `ServerClient`, because a second instance of either is a second, emptier
/// one — a resize lane nothing reads, a credential store nothing writes grants
/// into. Passing them separately was one parameter past the lint's limit and
/// eight positional arguments at every call site, which is the smell the lint
/// exists to report rather than a rule to get around.
pub struct AgentServerContext {
    /// The lane resize events are published to for the central server (relay).
    pub resize: ResizeReporter,
    /// The credentials this agent will honour on its P2P listener (#1013).
    pub credentials: Arc<P2pCredentials>,
    /// The **process's** mutation lane (`#1021`).
    ///
    /// Built once by the runtime and handed to the central connection as well
    /// as to this server, so a session mutated over either path queues in one
    /// lane and `same resource → FIFO` is a statement about the session rather
    /// than about which socket carried the frame. That this arrives through the
    /// context rather than being built here is the fix: this object used to mint
    /// its own, which is precisely why the two paths could interleave.
    pub mutations: Arc<KeyedLane<ResourceKey>>,
    /// Memory threshold percentage (0-100) for rejecting new sessions.
    /// Passed to the `SessionManager` so `create_session` can check memory
    /// pressure before starting a new tmux session.
    pub memory_threshold_percent: Option<u8>,
}

pub struct AgentServer {
    tmux_manager: SessionManager,
    file_ops: Arc<FileOps>,
    /// The one mutation lane every peer-to-peer connection of this agent
    /// dispatches into. Built here because the resources its keys name — one
    /// tmux server, one file sandbox — are here. See
    /// `server::execution::mutation_scheduler`.
    mutations: Arc<KeyedLane<ResourceKey>>,
    shutdown_tx: mpsc::Sender<()>,
    shutdown_rx: Option<mpsc::Receiver<()>>,
    tls_acceptor: Option<tokio_rustls::TlsAcceptor>,
    listen_address: String,
    agent_id: String,
    /// Default working directory for new tmux sessions created via P2P.
    default_working_dir: String,
    /// How the agent attaches to tmux sessions (plain PTY or control mode).
    attach_mode: AttachMode,
    /// The lane tmux resize events are published to for the central server
    /// (relay). Carries the FULL session id (`agent:name`), cols, rows, and
    /// keeps only the latest size per session — see [`crate::server::resize`]
    /// for why a level-valued signal gets a coalescing lane rather than a
    /// queue.
    resize: ResizeReporter,
    /// What this agent will honour on its P2P listener (#1013).
    ///
    /// **The same store the Server connection writes grants into**, not a copy:
    /// the connection is where a grant arrives and this is where it is checked,
    /// and two stores would mean a credential that is issued and never honoured
    /// with nothing to show for it. `runtime.rs` constructs it once for that
    /// reason.
    credentials: Arc<P2pCredentials>,
}

/// Apply env snapshots to a tmux session via `set-environment`.
///
/// **Required** (#991): these are variables a user asked for, so "the session
/// has them" and "it does not" are different outcomes and only the caller can
/// tell the user which happened. This used to return a `Vec<String>` of
/// warnings that every caller logged before answering `ok` — a required
/// mutation silently downgraded to a log line, which is the second half of
/// #980 and the reason nothing noticed the first half. The failure travels as
/// a `Result` now, and no caller is allowed to turn it back into success.
async fn apply_env_snapshots(
    tmux: &SessionManager,
    session_name: &str,
    snapshots: &[EnvSnapshot],
) -> anyhow::Result<()> {
    if snapshots.is_empty() {
        return Ok(());
    }
    // Collect all vars from all snapshots, deduplicating by key (last wins).
    let mut seen = std::collections::HashMap::new();
    for snap in snapshots {
        for (k, v) in &snap.vars {
            seen.insert(k.clone(), v.clone());
        }
    }
    let deduped: Vec<(String, String)> = seen.into_iter().collect();
    tmux.env().set_environment(session_name, &deduped).await
}

/// The size an attach should give the session.
///
/// A client that has measured its viewport says so, and its `width`/`height`
/// are used as they always were. A client that has **not** — a page that has
/// not laid its terminal out yet — can only send the payload's placeholder,
/// and acting on it resizes the **shared** window to 80×24 and back: two real
/// size changes, each of which makes an inline-drawing application repaint its
/// screen into the scrollback the user then reads it from (#1265).
///
/// Inheriting the pane's current size makes the attach a no-op for the
/// geometry, so the client's first real measurement is the only resize — and
/// it is the size the client is about to be looking at, rather than one it
/// never measured.
///
/// A read that fails keeps the placeholder. The session is very often about to
/// be reported missing by the attach itself, and *that* is the error worth
/// surfacing; substituting a size here would only hide which of the two
/// happened.
async fn resolve_attach_size(
    tmux: &SessionManager,
    session_name: &str,
    payload: &ClientAttachPayload,
) -> (u16, u16) {
    let authoritative = payload.size_is_authoritative();
    // The read is skipped entirely for a client that measured: its size is the
    // instruction, and asking tmux for the current one would only be a fact
    // nobody uses.
    let pane = if authoritative {
        None
    } else {
        tmux.tmux_dep().ops().window_size(session_name).await.ok()
    };
    choose_attach_size(authoritative, (payload.width, payload.height), pane)
}

/// The decision [`resolve_attach_size`] makes, separated from the tmux read so
/// it can be tested without a server — and so the rule is one expression rather
/// than something a reader has to reassemble from two branches.
///
/// `pane` is the session's current size, or `None` when it could not be read.
/// A read that fails keeps the stated size: the session is very often about to
/// be reported missing by the attach itself, and *that* is the error worth
/// surfacing.
fn choose_attach_size(
    authoritative: bool,
    stated: (u16, u16),
    pane: Option<(u16, u16)>,
) -> (u16, u16) {
    if authoritative {
        stated
    } else {
        pane.unwrap_or(stated)
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
    sessions: &'a Arc<SessionMapLock>,
    client_id: &'a Arc<Mutex<Option<String>>>,
    outbound: &'a P2pOutbound,
    default_working_dir: &'a str,
    file_ops: &'a Arc<FileOps>,
    listen_address: &'a str,
    agent_id: &'a str,
    /// Borrowed rather than held: `AttachMode` is not `Copy`, and taking it by
    /// value would move it out of `handle_request` for every arm that still
    /// names the local directly.
    attach_mode: &'a AttachMode,
    /// The agent's resize lane, which this socket publishes
    /// `%window-resize` events into (`#961-D`). See
    /// [`crate::server::resize`].
    resize: &'a ResizeReporter,
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

/// Everything one peer-to-peer connection hands every frame it reads.
///
/// Owned, and shared by `Arc`: the frames themselves now outlive the reader's
/// loop iteration — a query runs on its own task, a mutation waits in a key
/// lane — so what used to be thirteen borrowed locals of the message loop is
/// ten fields plus an `Arc` clone per frame.
///
/// This is as far as `#961`'s `ConnectionContext` split goes here, and the
/// stopping point is deliberate: what a frame needs is one object, and the
/// Server's half of that same split converges across stages that are not this
/// one. The fields are the connection's *resources* — services it borrows for
/// the length of a frame — while the per-connection state that a reply depends
/// on (`sessions`, `client_id`) is still owned here, because both are this
/// connection's and nothing else's.
struct Connection {
    tmux: Arc<SessionManager>,
    sessions: Arc<SessionMapLock>,
    client_id: Arc<Mutex<Option<String>>>,
    outbound: P2pOutbound,
    default_working_dir: String,
    file_ops: Arc<FileOps>,
    listen_address: String,
    agent_id: String,
    attach_mode: AttachMode,
    resize: ResizeReporter,
    addr: SocketAddr,
    /// What this connection proved about itself at the upgrade (#1013).
    ///
    /// Immutable for the connection's life, and the thing every later
    /// authorization question is answered from — the shape the Server already
    /// uses for `registered_agent_id`: a per-connection fact established once
    /// and consulted by every gate, rather than re-derived per handler.
    authority: ConnectionAuthority,
}

/// The refusal an uncredentialed peer gets, and **the only one they get**.
///
/// One status, one body, whatever the reason — no credential, an unknown one, an
/// expired one, one issued for a different agent. They are separated in
/// `P2pCredentials::Refusal` for the log and collapsed here, because a body that
/// distinguished them would tell a caller which of its guesses was closest. The
/// wording says nothing about credentials at all; a peer that reached the agent
/// port by accident gets no vocabulary from this to aim at.
fn unauthorized_upgrade() -> tokio_tungstenite::tungstenite::handshake::server::ErrorResponse {
    use tokio_tungstenite::tungstenite::http::{header, Response, StatusCode};
    let mut refusal = Response::new(Some("connection not authorized".to_string()));
    *refusal.status_mut() = StatusCode::UNAUTHORIZED;
    refusal.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("text/plain"),
    );
    refusal
}

/// One text frame, parsed as far as routing needs, and the connection it came
/// in on.
struct Frame {
    id: String,
    msg_type: String,
    payload: serde_json::Value,
    connection: Arc<Connection>,
}

/// What a frame is, before any lane sees it.
enum Routed {
    /// Not a control wire: an operation, and it goes to a lane.
    Operation,
    /// A control wire with nothing to answer.
    Silent,
    /// A control wire with an answer to write.
    Answer(String),
}

impl Frame {
    /// The envelope, or the reply to write for a frame that is not one.
    ///
    /// `msg_type` and `id` are extracted without fully deserialising the
    /// payload, because both are needed even when the payload turns out to be a
    /// type nobody here knows.
    fn parse(text: &str, connection: Arc<Connection>) -> Result<Self, String> {
        let raw: serde_json::Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => {
                return Err(serde_json::to_string(&make_error(
                    "unknown",
                    "parse_error",
                    &format!("invalid JSON: {e}"),
                ))
                .unwrap_or_default());
            }
        };

        Ok(Self {
            id: raw
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string(),
            msg_type: raw
                .get("msg_type")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string(),
            // The payload field, for deserialisation. Requests that don't need
            // a payload (e.g. session.list) can ignore this.
            payload: raw
                .get("payload")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
            connection,
        })
    }

    /// Control wires are handled ahead of the route table, and that is a
    /// consequence of the category rather than a preference. `p2p_routes!`
    /// emits a *descriptor* per arm and a control wire is not a unit —
    /// nothing advertises it, because it is not an offer this peer makes to
    /// a caller, it is something every peer must handle. Handling them here
    /// is also what keeps `control.ping` out of `dispatch_p2p`'s
    /// unknown-wire error, which is the only answer that table has for a
    /// name it does not carry — and what keeps a ping from queueing behind a
    /// file read (`#961-D`): the reader answers this one itself.
    ///
    /// One arm per wire rather than a `starts_with("control.")` test:
    /// `scripts/protocol-gate.mjs` checks that every runtime has a branch
    /// for every control wire, and a prefix test is not a branch it can
    /// read. `control.pong` is not this socket's reply to `control.ping` —
    /// the two are independent one-way messages and nothing pairs them —
    /// but the id of the ping is carried on the pong, because the envelope
    /// belongs to the sender and no router derives a pairing from it.
    fn route(&self) -> Routed {
        match self.msg_type.as_str() {
            msg_types::CONTROL_PING => Routed::Answer(
                serde_json::to_string(&make_response(&self.id, msg_types::CONTROL_PONG, ()))
                    .unwrap_or_default(),
            ),
            msg_types::CONTROL_PONG => {
                debug!("control.pong received");
                Routed::Silent
            }
            // The arm is here because control is symmetric — every runtime
            // handles every control wire, whether or not today's senders reach
            // this one. The agent sends its heartbeat on the *other* socket.
            msg_types::CONTROL_HEARTBEAT => {
                debug!("control.heartbeat received");
                Routed::Silent
            }
            // The scope gate (#1013), and this is the only place it can go.
            //
            // It runs on the reader task, before any lane handoff and before
            // `p2p_policy` is consulted, so the decision is made once, per frame,
            // in the order the frames arrived — which is what makes "this
            // credential was valid" stop implying "every later operation on this
            // connection is allowed". Putting it in `serve` would run it on a
            // lane task, concurrently with sibling frames and after the policy
            // had already picked a lane for a frame that turns out to be
            // forbidden; putting it in the arms is the ~30 scattered inline
            // checks the Server has and that #879 died of.
            //
            // A refusal **answers and keeps the connection**: a caller that
            // strayed outside its scope has made an ordinary mistake, and
            // tearing the socket down would turn it into a reattach storm. The
            // reply names the wire and says nothing about the credential — the
            // reason goes to the log, where the operator can see it and a
            // guessing peer cannot.
            _ => match p2p_scope(&self.msg_type, &self.payload) {
                Some(required) if !self.connection.authority.covers(&required) => {
                    warn!(
                        wire = %self.msg_type,
                        credential = %self.connection.authority.credential_id,
                        session = %self.connection.authority.session_id,
                        "refusing a peer-to-peer wire outside the credential's scope"
                    );
                    Routed::Answer(
                        serde_json::to_string(&make_error(
                            &self.id,
                            "forbidden",
                            &format!("not permitted for this credential: {}", self.msg_type),
                        ))
                        .unwrap_or_default(),
                    )
                }
                _ => Routed::Operation,
            },
        }
    }

    /// Answer this frame and write the reply to the connection's sink.
    ///
    /// Returns whether the connection is still usable — `false` is a failed
    /// write, which is the reader's cue to end it. A lane task has no reader to
    /// tell, so it drops the answer; see [`lane_work`].
    async fn serve(self) -> bool {
        let Self {
            id,
            msg_type,
            payload,
            connection,
        } = self;

        // Everything an arm needs to read, borrowed once. Before this the arms
        // named the locals directly, which is how the handler grew a closure
        // per arm to reach `id`; the struct is the same borrows with names.
        let ctx = P2pRequest {
            id: &id,
            tmux: &connection.tmux,
            sessions: &connection.sessions,
            client_id: &connection.client_id,
            outbound: &connection.outbound,
            default_working_dir: &connection.default_working_dir,
            file_ops: &connection.file_ops,
            listen_address: &connection.listen_address,
            agent_id: &connection.agent_id,
            attach_mode: &connection.attach_mode,
            resize: &connection.resize,
        };

        let reply = dispatch_p2p(ctx, &msg_type, payload).await;
        write_frame(&connection, Some(reply)).await
    }
}

/// The lane's view of a frame: serve it, and drop the answer.
///
/// That answer is "is this connection still usable", and only the reader can
/// act on it — a lane task has no loop to break out of. A failed write is
/// logged where it happens, and the reader finds out on its next read, which is
/// the frame that will not arrive.
fn lane_work(frame: Frame) -> Work {
    Box::pin(async move {
        frame.serve().await;
    })
}

/// Write one frame, and say whether the connection is still usable.
///
/// `None` is a control wire that needs no frame written back; everything else
/// answers, errors included.
///
/// The frame goes on the reply lane, which waits for room and never drops. The
/// only failure it can report is the connection being over — the one failure a
/// caller can act on, and the one that used to be spelled "the socket write
/// returned an error".
async fn write_frame(connection: &Connection, frame: Option<String>) -> bool {
    let Some(text) = frame else { return true };
    match connection.outbound.send_reply(WsMessage::Text(text)).await {
        Ok(()) => true,
        Err(e) => {
            warn!("WebSocket write to {} did not go out: {e}", connection.addr);
            false
        }
    }
}

// ---------------------------------------------------------------------------
// Resource keys (`#961-D`)
// ---------------------------------------------------------------------------
//
// Which resource a mutation is ordered against, read from the request's own
// payload. One function per *field*, not one per wire, because the field is the
// part that varies: four different session wires name their session
// `session_name`, two name it `name`, two carry it inside a `session_id`, and
// the file wires name a path. A single "guess the session out of this JSON"
// helper would have to try all three spellings and be wrong for whichever wire
// used the fourth.
//
// They are read from the payload *before* it is consumed, so each takes it by
// reference — see `p2p_routes!` for why the policy half sees a reference where
// the body sees the value.

/// The session a frame names as `session_name`.
///
/// Missing or not a string is the empty key: a malformed payload has no
/// resource to order against, and one shared key is the honest answer — those
/// frames are about to be answered `parse_error`, and serialising them against
/// each other costs nothing.
fn session_named(payload_value: &serde_json::Value) -> ResourceKey {
    ResourceKey::Session(
        payload_value
            .get("session_name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    )
}

/// The terminal scope a frame needs: the session it names as `session_name`.
///
/// The scope column's counterpart to [`session_named`], and deliberately not
/// derived from it. They read the same field and answer different questions —
/// which lane orders this frame, and which session's PTY it may touch — and the
/// two coincide here only by current convention. Deriving one from the other
/// would make the day they diverge (`client.session.attach` already differs: it
/// resolves a session rather than binding to it) a silent mis-scoping.
///
/// A frame that names no session yields `Session("")`, which no credential
/// covers: [`ConnectionAuthority::covers`] refuses an unnamed session rather
/// than treating it as "any". Failing closed is the only reading that cannot be
/// turned into a way around the check.
fn terminal_scope(payload_value: &serde_json::Value) -> WireScope {
    WireScope::Session(
        payload_value
            .get("session_name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    )
}

/// The session a frame names as `name` — `session.create` and `session.kill`,
/// whose payloads were written around the session rather than around a client.
fn session_by(payload_value: &serde_json::Value) -> ResourceKey {
    ResourceKey::Session(
        payload_value
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    )
}

/// The session a frame names inside a `session_id`, which carries the
/// `<agent_id>:<name>` form the Web UI speaks.
fn session_by_id(payload_value: &serde_json::Value) -> ResourceKey {
    ResourceKey::Session(
        payload_value
            .get("session_id")
            .and_then(|v| v.as_str())
            .map(extract_session_name)
            .unwrap_or_default(),
    )
}

// The file wires have no key helper, and that is the statement rather than an
// omission: every one of them carries [`ResourceKey::Filesystem`], the sandbox
// as one resource, so there is no field to read. See that variant for why the
// key space is that coarse — a rename touches two paths, a recursive delete
// touches every path under one, and a path is therefore not the whole of what a
// file mutation touches.

// The peer-to-peer surface, declared once (`#678`). Invoked at module scope
// rather than inside `handle_request` so the context type above and the units
// below read together: this is what an agent answers on its own socket, and
// `handle_request` is only the envelope parsing in front of it.
//
// The third `=>` of each arm is the **execution policy** (`#961-D`): how the
// connection's reader hands this unit to a lane. The key helpers above are what
// the `Key` policies are written in terms of.
p2p_routes! { ctx, msg_type, payload_value;
            "agent.session.list" => "agent.session.list" => 1 => WireScope::Sessions => Query => { match ctx.tmux.list_sessions().await {
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
            "agent.session.create" => "agent.session.create" => 1 => WireScope::Sessions => Key(session_by(payload_value)) => {
                let payload: SessionCreatePayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return ctx.err("parse_error", &e.to_string()),
                };
                let working_dir = match payload.working_dir.as_deref() {
                    Some(wd) => match SessionManager::validate_initial_working_dir(wd) {
                        Ok(path) => path,
                        Err(e) => return ctx.err("invalid_working_dir", &e.to_string()),
                    },
                    None => ctx.default_working_dir.to_string(),
                };
                match ctx
                    .tmux
                    .create_session(
                        &payload.name,
                        payload.width,
                        payload.height,
                        &working_dir,
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
                        if let Err(e) =
                            apply_env_snapshots(ctx.tmux, &payload.name, &payload.env_snapshots)
                                .await
                        {
                            // A create whose environment did not land is not the
                            // create that was asked for, so this cannot answer
                            // `ok`. The session itself is left in place: this
                            // reports the failure, it does not add a rollback
                            // policy (no caller had one before, and choosing one
                            // is #991's, not #980's).
                            warn!(
                                "env set-environment failed for session {}: {e:#}",
                                payload.name
                            );
                            return ctx.err("env_apply_failed", &format!("{e:#}"));
                        }
                        let resp = SessionCreateResponse { name: payload.name };
                        serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                            .unwrap_or_default()
                    }
                    Err(e) => ctx.err("create_failed", &e.to_string()),
                }
            }
            "agent.session.kill" => "agent.session.kill" => 1 => WireScope::Sessions => Key(session_by(payload_value)) => {
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
            "agent.session.capture-preview" => "agent.session.capture-preview" => 1 => terminal_scope(payload_value) => Query => {
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
                let capture_tmux = ctx.tmux.tmux_dep();
                match crate::tmux::util::capture_scrollback(
                    &capture_tmux,
                    &payload.session_name,
                    payload.lines,
                )
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
            "agent.attach" => "agent.attach" => 1 => terminal_scope(payload_value) => Key(session_named(payload_value)) => {
                let payload: ClientAttachPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return ctx.err("parse_error", &e.to_string()),
                };

                if matches!(ctx.attach_mode, AttachMode::Plain) {
                    // ---- Plain PTY path (session-shared) ----
                    let session_name = payload.session_name.clone();

                    // Apply env snapshots before PTY creation. Required: the
                    // client asked for these variables, and an attach that
                    // proceeds without them answers `ok` for a session that
                    // does not have the environment it was told to have.
                    if let Err(e) =
                        apply_env_snapshots(ctx.tmux, &session_name, &payload.env_snapshots).await
                    {
                        warn!("env set-environment failed for session {session_name}: {e:#}");
                        return ctx.err("env_apply_failed", &format!("{e:#}"));
                    }

                    // Whether this connection is the session's first subscriber
                    // is asked and answered under one lock; the PTY itself is
                    // attached with none held. The gap between the two is not a
                    // race this arm has to close, and that is a property of the
                    // lane rather than of this code: `agent.attach`,
                    // `agent.detach`, `agent.terminal.input` and
                    // `agent.terminal.resize` all carry the session's own
                    // resource key, so no two of them run at once for one
                    // session name.
                    let already_attached = sessions_lock(ctx.sessions).contains_key(&session_name);

                    if already_attached {
                        // Session already exists: add a new subscriber.
                        let client_id = connection_client_id(ctx.client_id).await;
                        let (tx, rx) = mpsc::channel(SUBSCRIBER_QUEUE_SLOTS);
                        let detached_for_not_draining = Arc::new(AtomicBool::new(false));
                        let wants_bootstrap = payload.needs_bootstrap.unwrap_or(false);
                        let resp = {
                            let mut guard = sessions_lock(ctx.sessions);
                            let Some(shared) = guard.get_mut(&session_name) else {
                                return ctx.err("not_attached", "session ended during attach");
                            };
                            // The peer this drops is *replaced*, not evicted:
                            // its flag stays unset, so its forwarder ends
                            // quietly instead of closing the connection this
                            // attach is about to answer on (#1226).
                            shared.peers.retain(|p| p.client_id != client_id);
                            // When a bootstrap is coming, leave `output_tx` unset
                            // until the snapshot is on the wire. The broadcast
                            // task is already running and would otherwise queue
                            // live bytes that the capture also covers — the
                            // duplicate window #1228 measured on subsequent attach
                            // (#321 SC4).
                            shared.peers.push(SessionPeer {
                                client_id: client_id.clone(),
                                outbound: ctx.outbound.clone(),
                                output_tx: if wants_bootstrap {
                                    None
                                } else {
                                    Some(tx.clone())
                                },
                                detached_for_not_draining: Arc::clone(
                                    &detached_for_not_draining,
                                ),
                            });
                            client_attach_response(payload.session_name.clone(), shared, &client_id)
                        };

                        // The session's history, before the live forwarder
                        // exists — `send_bootstrap` carries why that ordering is
                        // the whole barrier.
                        //
                        // Asked of the **client**, because the agent cannot
                        // answer it: this arm runs whenever the backend is
                        // already attached, which is equally true of a page that
                        // reattached over a surviving socket (its xterm still
                        // holds the history, and re-sending would duplicate it
                        // on screen) and of one whose xterm was rebuilt (it
                        // holds nothing). Absent means "the backend is attached,
                        // so no" — the behaviour an older client already has.
                        if wants_bootstrap {
                            let bootstrap_tmux = ctx.tmux.tmux_dep();
                            let capture = capture_for_bootstrap(
                                &bootstrap_tmux,
                                &session_name,
                                crate::tmux::HISTORY_LIMIT_LINES,
                            )
                            .await;
                            if !send_bootstrap(ctx.outbound, &bootstrap_tmux, &session_name, capture)
                                .await
                            {
                                return ctx.err(
                                    "bootstrap_stalled",
                                    "the client stalled while its history was being sent",
                                );
                            }
                            {
                                let mut guard = sessions_lock(ctx.sessions);
                                if let Some(shared) = guard.get_mut(&session_name) {
                                    if let Some(peer) = shared
                                        .peers
                                        .iter_mut()
                                        .find(|p| p.client_id == client_id)
                                    {
                                        peer.output_tx = Some(tx);
                                    }
                                }
                            }
                        }

                        spawn_output_forwarder(
                            rx,
                            ctx.outbound.clone(),
                            session_name.clone(),
                            detached_for_not_draining,
                        );

                        return serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                            .unwrap_or_default();
                    }

                    // Session doesn't exist yet: create PtySession + first subscriber.
                    // The backend is handed this manager's tmux addressing rather
                    // than resolving the process-wide one, so a substituted
                    // binary reaches the attach too (#991 step 6).
                    let (width, height) =
                        resolve_attach_size(ctx.tmux, &session_name, &payload).await;
                    match crate::tmux::pty::PtySession::attach(
                        &ctx.tmux.tmux_dep(),
                        &session_name,
                        width,
                        height,
                    ) {
                        Ok((pty_session, mut output_rx)) => {
                            let client_id = connection_client_id(ctx.client_id).await;
                            let (tx, rx) = mpsc::channel(SUBSCRIBER_QUEUE_SLOTS);
                            let detached_for_not_draining = Arc::new(AtomicBool::new(false));
                            let mut control = session_terminal::SessionControlState::new();
                            control.ensure_controller(&client_id);
                            let stream = session_terminal::SessionStreamState::new();
                            let attached = AttachedSession {
                                backend: Arc::new(Mutex::new(Box::new(pty_session))),
                                peers: vec![SessionPeer {
                                    client_id: client_id.clone(),
                                    outbound: ctx.outbound.clone(),
                                    output_tx: Some(tx),
                                    detached_for_not_draining: Arc::clone(
                                        &detached_for_not_draining,
                                    ),
                                }],
                                control,
                                stream,
                            };
                            let resp = client_attach_response(
                                payload.session_name.clone(),
                                &attached,
                                &client_id,
                            );
                            sessions_lock(ctx.sessions).insert(session_name.clone(), attached);

                            // The session's history, before the live forwarder
                            // exists — the same barrier the Control arm below
                            // uses and `send_bootstrap` documents.
                            //
                            // It matters more here than there. A tmux *client*
                            // paints its own screen and never replays the pane's
                            // scrollback into xterm's, and it enters the
                            // alternate screen on the way in — so under Plain
                            // this snapshot is the only history the browser's
                            // scrollback will ever hold. The client's redraw
                            // comes after it and covers the viewport; what the
                            // snapshot bought is everything above it.
                            //
                            // This is the session's **first** attach, so the
                            // backend was not attached before it and the history
                            // belongs to a client that has none: absent means
                            // yes, the same default the Control arm takes. An
                            // explicit `false` is honoured — a client that says
                            // it already has this does.
                            let bootstrap_tmux = ctx.tmux.tmux_dep();
                            let capture = if payload.needs_bootstrap.unwrap_or(true) {
                                capture_for_bootstrap(
                                    &bootstrap_tmux,
                                    &session_name,
                                    crate::tmux::HISTORY_LIMIT_LINES,
                                )
                                .await
                            } else {
                                None
                            };
                            if !send_bootstrap(ctx.outbound, &bootstrap_tmux, &session_name, capture)
                                .await
                            {
                                return ctx.err(
                                    "bootstrap_stalled",
                                    "the client stalled while its history was being sent",
                                );
                            }

                            // Spawn forwarding task for the first subscriber.
                            spawn_output_forwarder(
                                rx,
                                ctx.outbound.clone(),
                                session_name.clone(),
                                detached_for_not_draining,
                            );

                            // Spawn ONE broadcast task for this session.
                            // It reads from output_rx and fans out to ALL subscribers.
                            let sessions_clone = Arc::clone(ctx.sessions);
                            let session_name_clone = session_name.clone();
                            tokio::spawn(async move {
                                while let Some(bytes) = output_rx.recv().await {
                                    let mut guard = sessions_lock(&sessions_clone);
                                    if let Some(s) = guard.get_mut(&session_name_clone) {
                                        use base64::Engine;
                                        let encoded = base64::engine::general_purpose::STANDARD
                                            .encode(&bytes);
                                        let (epoch, seq) = s.stream.record_output(
                                            &session_name_clone,
                                            encoded,
                                        );
                                        // Fan out to every subscriber, pruning the
                                        // ones that are gone — closed because
                                        // their connection ended, or full because
                                        // they stopped draining. Either way they
                                        // are not attached in any useful sense,
                                        // and the fan-out must not wait for them;
                                        // see `SUBSCRIBER_QUEUE_SLOTS`.
                                        let detached =
                                            fan_out_peers(&mut s.peers, (bytes, epoch, seq));
                                        if detached > 0 {
                                            warn!(
                                                "session {session_name_clone}: detached {detached} \
                                                 subscriber(s) that stopped draining their terminal"
                                            );
                                        }
                                        if !s
                                            .peers
                                            .iter()
                                            .any(|p| p.output_tx.is_some())
                                        {
                                            break;
                                        }
                                    } else {
                                        break; // session removed
                                    }
                                }
                            });

                            serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                                .unwrap_or_default()
                        }
                        Err(e) => ctx.err("attach_failed", &e.to_string()),
                    }
                } else {
                    // ---- Control mode path ----

                    // Apply env snapshots before control-mode attach. Required,
                    // for the same reason as the PTY path above.
                    if let Err(e) = apply_env_snapshots(
                        ctx.tmux,
                        &payload.session_name,
                        &payload.env_snapshots,
                    )
                    .await
                    {
                        warn!(
                            "env set-environment failed for session {}: {e:#}",
                            payload.session_name
                        );
                        return ctx.err("env_apply_failed", &format!("{e:#}"));
                    }

                    // `needs_bootstrap` is answered at the attach itself: the
                    // capture is taken on the control channel as part of it
                    // (#1228), so a client that says `false` must not pay for
                    // a snapshot it will not be sent. This is the session's
                    // *first* attach on this connection, so absent means yes —
                    // the backend was not attached before it, and the history
                    // belongs to a client that has none.
                    let wants_bootstrap = payload.needs_bootstrap.unwrap_or(true);
                    let (width, height) =
                        resolve_attach_size(ctx.tmux, &payload.session_name, &payload).await;
                    match crate::tmux::control::ControlModeSession::attach(
                        &ctx.tmux.tmux_dep(),
                        &payload.session_name,
                        width,
                        height,
                        if wants_bootstrap {
                            Some(crate::tmux::HISTORY_LIMIT_LINES)
                        } else {
                            None
                        },
                    )
                    .await
                    {
                        Ok((session, mut output_rx, mut resize_rx, capture)) => {
                            let session_name = payload.session_name.clone();
                            let client_id = connection_client_id(ctx.client_id).await;
                            let mut control = session_terminal::SessionControlState::new();
                            control.ensure_controller(&client_id);
                            let stream = session_terminal::SessionStreamState::new();
                            let attached = AttachedSession {
                                backend: Arc::new(Mutex::new(Box::new(session))),
                                peers: vec![SessionPeer {
                                    client_id: client_id.clone(),
                                    outbound: ctx.outbound.clone(),
                                    output_tx: None,
                                    // Control-mode output goes straight to the
                                    // connection's outbound, so nothing reads
                                    // this flag here — a peer with no channel
                                    // is never fanned out to.
                                    detached_for_not_draining: Arc::new(AtomicBool::new(false)),
                                }],
                                control,
                                stream,
                            };
                            let resp = client_attach_response(
                                payload.session_name.clone(),
                                &attached,
                                &client_id,
                            );
                            // The insert is its own statement, so the map's
                            // guard is released before the scrollback capture
                            // below rather than living until the end of the
                            // block that holds this arm's locals.
                            sessions_lock(ctx.sessions).insert(session_name.clone(), attached);

                            // The session's history, before the live output
                            // stream is spawned — `send_bootstrap` carries why
                            // that ordering is the send-side barrier, and why
                            // the frame is no longer recorded in the stream
                            // log. The capture itself is the attach's, taken
                            // on the control channel: tmux's own wire order
                            // makes it the other half of the barrier (#1228) —
                            // the output stream about to be spawned starts
                            // exactly where this snapshot ends.
                            let bootstrap_tmux = ctx.tmux.tmux_dep();
                            if !send_bootstrap(ctx.outbound, &bootstrap_tmux, &session_name, capture)
                                .await
                            {
                                return ctx.err(
                                    "bootstrap_stalled",
                                    "the client stalled while its history was being sent",
                                );
                            }

                            // Spawn a background task that consumes the output
                            // channel from the control-mode subprocess and
                            // forwards bytes to the client as `terminal.output`
                            // messages.
                            let outbound_clone = ctx.outbound.clone();
                            let session_name_clone = session_name.clone();
                            let sessions_for_output = Arc::clone(ctx.sessions);
                            tokio::spawn(async move {
                                while let Some(bytes) = output_rx.recv().await {
                                    use base64::Engine;
                                    let encoded =
                                        base64::engine::general_purpose::STANDARD.encode(&bytes);
                                    let (stream_epoch, stream_seq) = {
                                        let mut guard = sessions_lock(&sessions_for_output);
                                        guard
                                            .get_mut(&session_name_clone)
                                            .map(|s| {
                                                s.stream.record_output(
                                                    &session_name_clone,
                                                    encoded.clone(),
                                                )
                                            })
                                            .unwrap_or((1, 0))
                                    };
                                    let output = TerminalOutputPayload {
                                        session_name: session_name_clone.clone(),
                                        data: encoded,
                                        stream_epoch: Some(stream_epoch),
                                        stream_seq: Some(stream_seq),
                                    // Live output; the prefill above is what
                                    // becomes the bootstrap in S4b (#321).
                                    bootstrap: None,
                                    };
                                    let msg = new_message(msg_types::TERMINAL_OUTPUT, output);
                                    if let Ok(json) = serde_json::to_string(&msg) {
                                        // Same terminal lane as the subscriber
                                        // forwarders, and the same verdict: a
                                        // control-mode client that has stopped
                                        // draining loses the connection rather
                                        // than pinning the tmux reader.
                                        match outbound_clone
                                            .send_terminal(WsMessage::Text(json))
                                            .await
                                        {
                                            Ok(()) => {}
                                            Err(OutboundError::Stalled) => {
                                                outbound_clone.close();
                                                return;
                                            }
                                            Err(_) => return,
                                        }
                                    }
                                }
                                // Channel closed — tmux subprocess exited or
                                // session was closed by the detach handler.
                            });

                            // Spawn a second task that forwards
                            // `%window-resize` events as `terminal.resize`.
                            //
                            // Each resize is ALSO published to the agent's
                            // resize lane so relay clients (browser → server →
                            // agent) receive the same size updates through the
                            // server's `agent.terminal.resize` broadcast. The
                            // upstream message carries the FULL session id
                            // (`agent:name`); the P2P sink message keeps the
                            // bare session name.
                            //
                            // `publish`, not `send`: the upstream half is a
                            // *level* — the session's current size — and the
                            // lane keeps only the latest one per session, so a
                            // central connection that falls behind costs a stale
                            // intermediate size rather than a queue that grows
                            // without bound. See `crate::server::resize`.
                            let outbound_resize = ctx.outbound.clone();
                            let session_name_resize = session_name.clone();
                            let resize_reporter = ctx.resize.clone();
                            let agent_id_resize = ctx.agent_id.to_string();
                            tokio::spawn(async move {
                                // **No initial size announcement.** This arm
                                // used to query the pane's size and send it, so
                                // the attaching client would know what xterm.js
                                // should expect. It cannot know that: the query
                                // answers *now*, and the client is still
                                // measuring. Measured on CI (#1187), verbatim
                                // from a run's WebSocket capture:
                                //
                                //   2072.0  client → server   relay.begin {cols:124, rows:26}
                                //   2090.1  client → agent    resize     {cols:124, rows:26}
                                //   2146.8  agent  → client   resize     {cols:80,  rows:24}
                                //
                                // The backend was created at 80×24 — the
                                // Server's default for a client that had not
                                // measured yet — so that is what the query
                                // returned, and it arrived *after* the client's
                                // own fit. The client applied it (that arm
                                // resizes xterm directly and sends nothing
                                // back), leaving a grid of 80×24 over a pane of
                                // 124×26, for good. Both halves were always true
                                // of the old comment's worry — "an 80×24 that
                                // was never asked for would show as a real
                                // resize" — it just did not follow that
                                // `window_size` returning `Ok` makes the answer
                                // current by the time it is read.
                                //
                                // The attaching client is the one actor that
                                // cannot need this: it is the authority on its
                                // own viewport, and every size it will ever want
                                // it sends itself. A *peer* reflowing the pane
                                // is a different actor, and still arrives
                                // through `resize_rx` below.
                                while let Some((cols, rows)) = resize_rx.recv().await {
                                    let full_id =
                                        format!("{agent_id_resize}:{session_name_resize}");
                                    resize_reporter.publish(&full_id, cols, rows);
                                    if !send_terminal_resize_msg(
                                        &outbound_resize,
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

                            serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                                .unwrap_or_default()
                        }
                        Err(e) => ctx.err("attach_failed", &e.to_string()),
                    }
                }
            }
            "agent.detach" => "agent.detach" => 1 => terminal_scope(payload_value) => Key(session_named(payload_value)) => {
                let payload: ClientDetachPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return ctx.err("parse_error", &e.to_string()),
                };
                // The map's lock is taken to *find and take* the session, and
                // released before the backend is closed: `close` is backend
                // I/O — for control mode it terminates a tmux child — and
                // holding the connection's index of sessions across it is the
                // lock-across-await `#961-D` exists to remove.
                let client_id = connection_client_id(ctx.client_id).await;
                let (removed, control_notify) = {
                    let mut sessions_guard = sessions_lock(ctx.sessions);
                    match sessions_guard.get_mut(&payload.session_name) {
                        Some(session) => {
                            if !session
                                .peers
                                .iter()
                                .any(|p| p.client_id == client_id)
                            {
                                return ctx.err(
                                    "not_attached",
                                    &format!(
                                        "not attached to session: {}",
                                        payload.session_name
                                    ),
                                );
                            }
                            let before_controller =
                                session.control.controller_client_id.clone();
                            session
                                .peers
                                .retain(|p| p.client_id != client_id);
                            session.control.release_if_holder(&client_id);
                            let notify = if before_controller
                                != session.control.controller_client_id
                            {
                                Some((
                                    session.peers.clone(),
                                    TerminalControlChangedPayload {
                                        session_name: payload.session_name.clone(),
                                        generation: session.control.generation,
                                        controller_client_id: session
                                            .control
                                            .controller_client_id
                                            .clone(),
                                    },
                                ))
                            } else {
                                None
                            };
                            let removed = if session.peers.is_empty() {
                                sessions_guard.remove(&payload.session_name)
                            } else {
                                None
                            };
                            (removed, notify)
                        }
                        None => {
                            return ctx.err(
                                "not_attached",
                                &format!("not attached to session: {}", payload.session_name),
                            );
                        }
                    }
                };

                if let Some((peers, changed)) = control_notify {
                    notify_control_changed(&peers, changed).await;
                }

                if let Some(removed) = removed {
                    if let Err(e) = removed.backend.lock().await.close().await {
                        warn!("Error closing session {}: {:#}", payload.session_name, e);
                    }
                }

                let resp = ClientDetachResponse {
                    session_name: payload.session_name,
                };
                serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                    .unwrap_or_default()
            }
            "agent.terminal.control.acquire" => "agent.terminal.control.acquire" => 1 => terminal_scope(payload_value) => Key(session_named(payload_value)) => {
                let payload: TerminalControlAcquirePayload =
                    match serde_json::from_value(payload_value) {
                        Ok(p) => p,
                        Err(e) => return ctx.err("parse_error", &e.to_string()),
                    };
                let client_id = connection_client_id(ctx.client_id).await;
                let (resp, peers, changed) = {
                    let mut guard = sessions_lock(ctx.sessions);
                    let Some(session) = guard.get_mut(&payload.session_name) else {
                        return ctx.err(
                            "not_attached",
                            &format!("not attached to session: {}", payload.session_name),
                        );
                    };
                    if !session.peers.iter().any(|p| p.client_id == client_id) {
                        return ctx.err(
                            "not_attached",
                            &format!("client not attached to session: {}", payload.session_name),
                        );
                    }
                    let generation = session.control.acquire(&client_id);
                    let role = session.control.role_of(&client_id);
                    let resp = TerminalControlAcquireResponse {
                        session_name: payload.session_name.clone(),
                        generation,
                        role: if role == session_terminal::TerminalRole::Controller {
                            "controller"
                        } else {
                            "observer"
                        }
                        .to_string(),
                        controller_client_id: session.control.controller_client_id.clone(),
                    };
                    let changed = TerminalControlChangedPayload {
                        session_name: payload.session_name.clone(),
                        generation,
                        controller_client_id: session.control.controller_client_id.clone(),
                    };
                    (resp, session.peers.clone(), changed)
                };
                notify_control_changed(&peers, changed).await;
                serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                    .unwrap_or_default()
            }
            "agent.terminal.stream.resume" => "agent.terminal.stream.resume" => 1 => terminal_scope(payload_value) => Key(session_named(payload_value)) => {
                let payload: TerminalStreamResumePayload =
                    match serde_json::from_value(payload_value) {
                        Ok(p) => p,
                        Err(e) => return ctx.err("parse_error", &e.to_string()),
                    };
                let resp = {
                    let guard = sessions_lock(ctx.sessions);
                    let Some(session) = guard.get(&payload.session_name) else {
                        return ctx.err(
                            "not_attached",
                            &format!("not attached to session: {}", payload.session_name),
                        );
                    };
                    let epoch_match = session.stream.epoch == payload.stream_epoch;
                    let events = if epoch_match {
                        session
                            .stream
                            .events_since(payload.stream_epoch, payload.after_seq)
                            .unwrap_or_default()
                    } else {
                        Vec::new()
                    };
                    TerminalStreamResumeResponse {
                        session_name: payload.session_name.clone(),
                        stream_epoch: session.stream.epoch,
                        epoch_match,
                        events,
                    }
                };
                serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                    .unwrap_or_default()
            }
            "agent.terminal.input" => "agent.terminal.input" => 1 => terminal_scope(payload_value) => Key(session_named(payload_value)) => {
                let payload: TerminalInputPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return ctx.err("parse_error", &e.to_string()),
                };
                let client_id = connection_client_id(ctx.client_id).await;
                let authorized = sessions_lock(ctx.sessions)
                    .get(&payload.session_name)
                    .map(|session| {
                        session
                            .control
                            .authorize_mutation(&client_id, payload.control_generation)
                    });
                match authorized {
                    Some(true) => {}
                    Some(false) => {
                        return ctx.err(
                            "not_controller",
                            "terminal input requires an active controller lease",
                        );
                    }
                    None => {
                        return ctx.err(
                            "not_attached",
                            &format!("not attached to session: {}", payload.session_name),
                        );
                    }
                }
                use base64::Engine;
                let data = match base64::engine::general_purpose::STANDARD.decode(&payload.data) {
                    Ok(d) => d,
                    Err(e) => return ctx.err("decode_error", &e.to_string()),
                };
                // Find the session under the map's lock, then write with it
                // released. The lock held across the write is the session's own
                // — see `AttachedSession::backend` — and the key lane is what
                // makes it uncontended.
                let backend = sessions_lock(ctx.sessions)
                    .get(&payload.session_name)
                    .map(|session| Arc::clone(&session.backend));
                match backend {
                    Some(backend) => match backend.lock().await.write_input(&data).await {
                        Ok(_) => serde_json::to_string(&make_ok(ctx.id, "ok")).unwrap_or_default(),
                        Err(e) => ctx.err("write_error", &e.to_string()),
                    },
                    None => ctx.err(
                        "not_attached",
                        &format!("not attached to session: {}", payload.session_name),
                    ),
                }
            }
            "agent.terminal.resize" => "agent.terminal.resize" => 1 => terminal_scope(payload_value) => Key(session_named(payload_value)) => {
                let payload: TerminalResizePayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return ctx.err("parse_error", &e.to_string()),
                };
                let client_id = connection_client_id(ctx.client_id).await;
                let role_and_backend = sessions_lock(ctx.sessions)
                    .get(&payload.session_name)
                    .map(|session| {
                        (
                            session.control.role_of(&client_id),
                            session
                                .control
                                .authorize_mutation(&client_id, payload.control_generation),
                            Arc::clone(&session.backend),
                        )
                    });
                match role_and_backend {
                    Some((session_terminal::TerminalRole::Observer, _, _)) => {
                        return ctx.err(
                            "observer_resize",
                            "observers must not resize the live session",
                        );
                    }
                    Some((_, false, _)) => {
                        return ctx.err(
                            "not_controller",
                            "terminal resize requires an active controller lease",
                        );
                    }
                    Some((_, true, backend)) => {
                        // The guard is scoped here rather than written as the
                        // `match` scrutinee, because a scrutinee's temporaries
                        // live until the end of the **whole match** — so
                        // `match backend.lock().await.resize(..).await` would
                        // hold this session's backend across the fan-out below,
                        // and `send_terminal` waits out the stall grace. A peer
                        // that stopped draining would then park every other
                        // operation that takes this backend (#1352). What the
                        // lock is for is the backend's own I/O and nothing else:
                        // see `AttachedSession::backend`.
                        let resized = {
                            let mut backend = backend.lock().await;
                            backend.resize(payload.cols, payload.rows).await
                        };
                        match resized {
                            Ok(_) => {
                                // `record_resize` consumes a sequence number,
                                // and a number the client never receives is a
                                // hole it can only close with a round trip, so
                                // the frame below carries that position (#1303).
                                // The session may have ended across the
                                // resize's own `await`, in which case nothing
                                // was recorded and there is no position to
                                // report.
                                let recorded = sessions_lock(ctx.sessions)
                                    .get_mut(&payload.session_name)
                                    .map(|session| {
                                        session.stream.record_resize(
                                            &payload.session_name,
                                            payload.cols,
                                            payload.rows,
                                        )
                                    });
                                if let Some(position) = recorded {
                                    send_recorded_resize_msg(
                                        ctx.outbound,
                                        &payload.session_name,
                                        payload.cols,
                                        payload.rows,
                                        position,
                                    )
                                    .await;
                                }
                                serde_json::to_string(&make_ok(ctx.id, "ok"))
                                    .unwrap_or_default()
                            }
                            Err(e) => ctx.err("resize_error", &e.to_string()),
                        }
                    }
                    None => ctx.err(
                        "not_attached",
                        &format!("not attached to session: {}", payload.session_name),
                    ),
                }
            }

            // --- Web UI compatibility handlers ---
            "client.auth" => "client.auth" => 1 => WireScope::Connection => Ordered => {
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
            "client.sessions.list" => "client.sessions.list" => 1 => WireScope::Sessions => Query => { match ctx.tmux.list_sessions().await {
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
                                working_dir: None,
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
            "client.session.attach" => "client.session.attach" => 1 => WireScope::Sessions => Inline => {
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
            "client.session.create" => "client.session.create" => 1 => WireScope::Sessions => Key(session_by(payload_value)) => {
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
                let working_dir = match payload.working_dir.as_deref() {
                    Some(wd) => match SessionManager::validate_initial_working_dir(wd) {
                        Ok(path) => path,
                        Err(e) => {
                            let resp = WebSessionCreateResponse {
                                success: false,
                                session_id: None,
                                error: Some(e.to_string()),
                            };
                            return serde_json::to_string(&make_response(ctx.id, msg_types::OK, resp))
                                .unwrap_or_default();
                        }
                    },
                    None => ctx.default_working_dir.to_string(),
                };
                match ctx
                    .tmux
                    .create_session(
                        &payload.name,
                        payload.width,
                        payload.height,
                        &working_dir,
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
            "client.session.kill" => "client.session.kill" => 1 => WireScope::Sessions => Key(session_by_id(payload_value)) => {
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
            "agent.file.list" => "agent.file.list" => 1 => WireScope::Files => Query => {
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
            "agent.file.read" => "agent.file.read" => 1 => WireScope::Files => Query => {
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
            "agent.file.write" => "agent.file.write" => 1 => WireScope::Files => Key(ResourceKey::Filesystem) => {
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
            "agent.file.delete" => "agent.file.delete" => 1 => WireScope::Files => Key(ResourceKey::Filesystem) => {
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
            "agent.file.create-dir" => "agent.file.create-dir" => 1 => WireScope::Files => Key(ResourceKey::Filesystem) => {
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
            "agent.file.rename" => "agent.file.rename" => 1 => WireScope::Files => Key(ResourceKey::Filesystem) => {
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
            "agent.file.cwd" => "agent.file.cwd" => 1 => WireScope::Files => Query => {
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
    /// `context` carries the values the runtime builds once and shares; see
    /// [`AgentServerContext`] for why they arrive together.
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
        context: AgentServerContext,
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

        let mut tmux_manager = SessionManager::new();
        tmux_manager.with_memory_threshold(context.memory_threshold_percent);

        Ok(Self {
            tmux_manager,
            file_ops,
            mutations: context.mutations,
            shutdown_tx,
            shutdown_rx: Some(shutdown_rx),
            tls_acceptor,
            listen_address: listen_address.into(),
            agent_id: agent_id.into(),
            default_working_dir,
            attach_mode,
            resize: context.resize,
            credentials: context.credentials,
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
        let mutations = Arc::clone(&self.mutations);
        let tls_acceptor = self.tls_acceptor;
        let default_working_dir = self.default_working_dir.clone();
        let listen_address = self.listen_address.clone();
        let agent_id = self.agent_id.clone();
        let attach_mode = self.attach_mode.clone();
        let resize = self.resize.clone();
        let credentials = Arc::clone(&self.credentials);

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
                                let lanes = Arc::clone(&mutations);
                                let tls = tls_acceptor.clone();
                                let wd = default_working_dir.clone();
                                let la = listen_address.clone();
                                let aid = agent_id.clone();
                                let am = attach_mode.clone();
                                let rtx = resize.clone();
                                let creds = Arc::clone(&credentials);
                                tokio::spawn(async move {
                                    if let Err(e) =
                                        Self::handle_connection(
                                            stream, addr, tmux, tls, wd, fops, lanes, &la, &aid,
                                            am, rtx, creds,
                                        )
                                        .await
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
        mutations: Arc<KeyedLane<ResourceKey>>,
        listen_address: &str,
        agent_id: &str,
        attach_mode: AttachMode,
        resize: ResizeReporter,
        credentials: Arc<P2pCredentials>,
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

        // The half of #1013 that asks *is there a credential, and is it this
        // agent's*, decided at the upgrade rather than after it.
        //
        // `accept_hdr_async` because its callback can **refuse**: returning
        // `Err` rejects the upgrade, so a caller with no credential never has a
        // WebSocket, never has a connection, and cannot leave one in a
        // half-authenticated state — the property is structural rather than
        // something every later handler has to keep honouring.
        //
        // The callback is **synchronous** (verified in the vendored
        // tungstenite: `Callback::on_request` is an `FnOnce`, not an async fn),
        // which is why the credential store is a `std::sync::RwLock` and why the
        // authority has to come back out through a cell the closure wrote to.
        // `OnceLock` rather than a `Mutex`: it is written once, on the path that
        // returns `Ok`, and read once below.
        let authority: Arc<OnceLock<ConnectionAuthority>> = Arc::new(OnceLock::new());
        let captured = Arc::clone(&authority);
        let store = Arc::clone(&credentials);
        let ws = tokio_tungstenite::accept_hdr_async(
            io,
            move |request: &UpgradeRequest, response: UpgradeResponse| {
                let presented = request
                    .uri()
                    .query()
                    .and_then(nession_protocol::contracts::p2p::credential_from_query);

                match presented.as_deref().map(|token| store.authorize(token)) {
                    Some(Ok(found)) => {
                        let _ = captured.set(found);
                        Ok(response)
                    }
                    refusal => {
                        // One line, one shape, whatever the reason. `refusal` is
                        // `None` for "nothing presented" and `Some(Err(_))` for
                        // unknown, expired and wrong-agent alike, and they are
                        // deliberately indistinguishable to the peer: a message
                        // that said "expired" would tell a caller which of its
                        // guesses was closest. The reason is logged and not sent.
                        warn!(
                            %addr,
                            reason = ?refusal,
                            "refusing a peer-to-peer connection: no valid credential"
                        );
                        Err(unauthorized_upgrade())
                    }
                }
            },
        )
        .await
        .context("WebSocket upgrade failed")?;
        let (ws_sink, ws_stream) = ws.split();

        // The callback sets this on every path that returns `Ok`. A `None` here
        // would mean a connection that passed the upgrade with no record of what
        // it may do, so it ends rather than running on an assumed scope — there
        // is no safe default, and "assume it is allowed" is exactly the
        // anonymous fallback this design forbids.
        let Some(authority) = authority.get().cloned() else {
            anyhow::bail!("upgrade completed without a credential authority");
        };

        info!(
            "WebSocket connection from {} (credential {}, session {})",
            addr, authority.credential_id, authority.session_id
        );

        // The outbound path: a bounded queue with a policy per lane, and one
        // writer task that owns the socket (`#961-E`). Every lane's task — and
        // the reader — holds a handle to it and says which *class* of message it
        // is sending, because the classes do not share a failure mode; see
        // `server::outbound`.
        let (outbound, outbound_rx) = P2pOutbound::new();
        let writer = tokio::spawn(outbound::run_writer(ws_sink, outbound_rx, outbound.clone()));

        // Per-client attached PTY sessions keyed by session name.
        let sessions: Arc<SessionMapLock> =
            Arc::new(SessionMapLock::new(std::collections::HashMap::new()));
        // Per-connection client ID (set during CLIENT_AUTH handshake)
        let client_id: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        // Everything a frame of this connection needs, owned once and shared by
        // reference: one `Arc` clone per frame rather than a copy of the ten
        // things a handler reads.
        let connection = Arc::new(Connection {
            tmux: tmux_manager,
            sessions,
            client_id,
            outbound,
            default_working_dir,
            file_ops,
            listen_address: listen_address.to_string(),
            agent_id: agent_id.to_string(),
            attach_mode,
            resize,
            addr,
            authority,
        });

        let result = Self::run_message_loop(ws_stream, connection, mutations).await;

        // The connection is over, so the writer goes with it — dropping the sink
        // and closing the peer's socket. The writer also stops by itself when it
        // is told to (`P2pOutbound::close`, which is how a stalled terminal lane
        // ends a connection) or when the socket fails; this is the path where
        // the *reader* ended first, and without it the task would outlive the
        // connection it belongs to.
        writer.abort();
        let _ = writer.await;

        result
    }

    /// Drain incoming WebSocket frames and dispatch them (`#961-D`).
    ///
    /// The reader's job is now **routing and nothing else**. It parses the
    /// envelope, answers the frames that have to be answered here, and hands
    /// every other frame to a lane — it never awaits a business handler, which
    /// is what makes a parked file read invisible to the rest of the
    /// connection.
    ///
    /// What still runs here runs here for a reason:
    ///
    /// * a **control** wire, because `control.ping` is the peer asking whether
    ///   this connection is alive, and answering it from behind a queue would
    ///   answer a different question;
    /// * an [`ExecutionPolicy::Ordered`] frame, once the lanes have drained —
    ///   see that variant for why the barrier is what keeps an identity
    ///   transition ahead of the operations that depend on it;
    /// * WebSocket's own ping, which belongs to the transport.
    async fn run_message_loop(
        mut ws_stream: futures_util::stream::SplitStream<WebSocketStream<TcpOrTls>>,
        connection: Arc<Connection>,
        mutations: Arc<KeyedLane<ResourceKey>>,
    ) -> Result<()> {
        let addr = connection.addr;
        // The lanes this connection reads into, and the only thing that admits
        // to them. The query lane is this connection's own — it is admission,
        // and what it protects is this connection's progress — while the key
        // lane is the agent's, shared with every other connection that mutates
        // the same tmux sessions and the same file sandbox. What stays private
        // to this connection is its *bound* on mutations in flight, which is
        // what makes the number of resources one peer can be ahead of a number
        // (see `server::execution`). Both are dropped with the loop, which is
        // what ends this connection's share of them.
        let mut lanes = ExecutionLanes::shared(
            crate::server::execution::DEFAULT_QUERY_CONCURRENCY,
            mutations,
            DEFAULT_MUTATIONS_IN_FLIGHT,
            crate::server::execution::LANE_LABEL,
        );

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
                    let frame = match Frame::parse(&text, Arc::clone(&connection)) {
                        Ok(frame) => frame,
                        Err(reply) => {
                            // A frame that is not JSON has no `id` to echo, so
                            // the error names `unknown` — there is nothing
                            // better to say, and it is what this path said when
                            // it was part of `handle_request`.
                            if !write_frame(&connection, Some(reply)).await {
                                break;
                            }
                            continue;
                        }
                    };

                    match frame.route() {
                        Routed::Answer(reply) => {
                            if !write_frame(&connection, Some(reply)).await {
                                break;
                            }
                        }
                        // A control wire with nothing to answer: handled, and
                        // deliberately silent.
                        Routed::Silent => {}
                        Routed::Operation => {
                            // The lane is a property of the unit, declared
                            // beside it in `p2p_routes!`. A wire this socket
                            // does not serve has no declaration to read, and
                            // the honest default for a message whose semantics
                            // belong to someone else is the one that does not
                            // reorder it.
                            let policy =
                                p2p_policy(&frame.msg_type, &frame.payload).unwrap_or(Inline);
                            match policy {
                                Ordered => {
                                    lanes.drain().await;
                                    if !frame.serve().await {
                                        break;
                                    }
                                }
                                Inline => {
                                    if !frame.serve().await {
                                        break;
                                    }
                                }
                                Query => lanes.query(lane_work(frame)).await,
                                Key(key) => lanes.key(key, lane_work(frame)).await,
                            }
                        }
                    }
                }
                WsMessage::Close(_) => {
                    info!("Client {} sent close frame", addr);
                    break;
                }
                WsMessage::Ping(data) => {
                    // A pong rides the state lane, which is allowed to drop it:
                    // the peer's next ping restates the question, and a
                    // connection that cannot take a pong has nothing left for
                    // the pong to keep alive.
                    let _ = connection.outbound.try_send_state(WsMessage::Pong(data));
                }
                // Pong, Binary, and Frame are ignored.
                _ => {}
            }
        }

        // End the lanes before the sessions. Work still running would write to
        // a backend that is about to be closed and to a socket that is closing,
        // and it belongs to a peer that is gone — see
        // `ExecutionLanes::shutdown` for why ending is the policy rather than
        // waiting.
        lanes.shutdown(SHUTDOWN_GRACE).await;

        // What this connection's bounds ever did, read by something that is not
        // a test — `#961`'s "metrics/logging can observe queue saturation,
        // in-flight count, per-key queue depth". The lane's own saturation
        // events say *when* a bound was reached and which key reached it; this
        // says how far the connection ever got.
        {
            let (queries, keys) = lanes.snapshot().await;
            debug!(
                "peer-to-peer connection closed — lanes: {} (the mutation half is the \
                 agent's shared scheduler, which this connection dispatched into); its \
                 own mutation admissions waited {} time(s)",
                nession_runtime::lane::summary(&queries, &keys),
                lanes.admission_waits().await
            );
        }
        debug!(
            "peer-to-peer connection closed — outbound: {:?}",
            connection.outbound.snapshot()
        );

        // Close any tmux sessions that were attached through this
        // connection so that the underlying tmux attach children are
        // terminated promptly. Closing also drops the subscriber senders,
        // stopping each session's broadcast task.
        //
        // The map is drained under its lock and the backends are closed outside
        // it. It used to close them *inside*, so a `close` that takes
        // milliseconds — it terminates a tmux child — held the connection's
        // index of sessions for its whole duration (`#961-D`).
        let drained: Vec<(String, AttachedSession)> = {
            let mut sessions_guard = sessions_lock(&connection.sessions);
            sessions_guard.drain().collect()
        };
        for (name, session) in drained {
            if let Err(e) = session.backend.lock().await.close().await {
                warn!("Error closing session {}: {:#}", name, e);
            }
        }

        // Clean up any env scripts sourced by this client. The client id is
        // taken under the lock and used outside it, for the same reason.
        let client_id = {
            let client_id_guard = connection.client_id.lock().await;
            client_id_guard.clone()
        };
        if let Some(cid) = client_id {
            connection.tmux.env().cleanup_client_scripts(&cid).await;
            info!("Cleaned up env scripts for client {}", cid);
        }

        info!("Client {} disconnected", addr);
        Ok(())
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
    use nession_protocol::contracts::p2p::agent_url_with_credential;
    use nession_protocol::contracts::p2p::v1::{CredentialScope, P2pGrantPayload};
    use std::time::Duration;
    use tokio_tungstenite::connect_async;
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    /// The halves of a dialed connection, named once: this module has three dial
    /// helpers, and a signature that spells them out runs to twelve lines.
    type WsSink = futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        WsMessage,
    >;
    type WsStream = futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >;

    /// The credential every dial through [`connect_client`] presents.
    ///
    /// A fixed value, not a fresh UUID: each test's server has its own store, so
    /// a per-test token would be unique in a place where nothing else is shared
    /// — and the alternative is threading a returned token through thirty-odd
    /// call sites, which is a large mechanical diff for no property.
    const TEST_CREDENTIAL: &str = "test-credential";

    /// The session [`TEST_CREDENTIAL`]'s terminal binding names.
    ///
    /// A placeholder, and deliberately one **no frame in this module carries**:
    /// the scope gate compares the name in the frame against the name in the
    /// credential, so a credential bound here reaches no session at all. That is
    /// what makes it the right credential for the thirty-odd tests that touch no
    /// terminal wire, and it is why a test that sends one of the five
    /// session-scoped wires waits until it knows its session's name and dials
    /// through [`connect_client_for`] instead.
    const PLACEHOLDER_SESSION: &str = "test";

    /// A valid credential that is deliberately narrow: terminal for one session,
    /// no session management, no file sandbox. Minted by the same helper, so a
    /// test can tell "the credential was refused" apart from "the credential was
    /// not valid" — the two are the same 401 and would be one test otherwise.
    const NARROW_CREDENTIAL: &str = "narrow-credential";

    /// Grant a credential into a test server's store (#1013).
    ///
    /// Goes through [`P2pCredentials::grant`], the method the Server's
    /// `agent.p2p.grant` calls, so the handshake and the scope gate these tests
    /// exercise are the production ones — only *delivery* differs. There is no
    /// `AgentServer` helper for this because the only one possible would sit
    /// behind a cargo feature, and `scripts/filtered-test.sh` runs
    /// `cargo test --workspace` with no features at all: a minter that does not
    /// exist in the gate's build tests nothing on the day the gate runs.
    fn grant_credential(credentials: &P2pCredentials, credential: &str, scope: CredentialScope) {
        credentials
            .grant(
                "test-agent",
                &P2pGrantPayload {
                    request_id: "test-grant".to_string(),
                    credential: credential.to_string(),
                    agent_id: "test-agent".to_string(),
                    session_id: "test-agent:test".to_string(),
                    scope,
                    expires_at: (chrono::Utc::now() + chrono::Duration::seconds(300)).to_rfc3339(),
                },
            )
            .expect("the agent accepts a credential it minted for itself");
    }

    async fn start_test_server_on(_port: u16) -> (SocketAddr, ServerHandle, Arc<P2pCredentials>) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let (resize, _resize_updates) = ResizeReporter::new();
        // Granted **before** `start`, which consumes the server: the store is an
        // `Arc` shared with the running listener, so a credential granted here
        // is the one the listener checks.
        let credentials = Arc::new(P2pCredentials::new());
        grant_credential(
            &credentials,
            TEST_CREDENTIAL,
            CredentialScope::for_attach(PLACEHOLDER_SESSION),
        );
        // And one that deliberately lacks the two management scopes, so the
        // gate can be tested against a credential that is valid but narrow.
        grant_credential(
            &credentials,
            NARROW_CREDENTIAL,
            CredentialScope::for_relay(PLACEHOLDER_SESSION),
        );
        let server = AgentServer::new(
            "127.0.0.1:0",
            "test-agent",
            None,
            "/tmp".to_string(),
            tmp.path().to_string_lossy().as_ref(),
            AttachMode::Plain,
            AgentServerContext {
                resize,
                credentials: Arc::clone(&credentials),
                mutations: crate::execution::mutation_scheduler(),
                memory_threshold_percent: None,
            },
        )
        .expect("server creation should succeed");
        // Leak the TempDir so the sandbox root persists for the server lifetime.
        Box::leak(Box::new(tmp));
        let (handle, addr) = server.start().await.expect("start should succeed");
        (addr, handle, credentials)
    }

    /// Dial `addr`, presenting `credential`.
    ///
    /// The store is asked first, so a dial presenting something it never minted
    /// fails here with that sentence rather than as the opaque refused upgrade
    /// this socket gives a peer — `HandshakeIncomplete`, with nothing in it
    /// about which end said no.
    async fn dial_presenting(
        credentials: &P2pCredentials,
        addr: SocketAddr,
        credential: &str,
    ) -> (WsSink, WsStream) {
        assert!(
            credentials.authorize(credential).is_ok(),
            "the credential a test dial presents must be one its server's store honours"
        );
        let url = agent_url_with_credential(&format!("ws://{addr}"), credential);
        let (ws_stream, _response) = connect_async(&url).await.expect("connect should succeed");
        ws_stream.split()
    }

    /// Connect a WebSocket client to a test server.
    ///
    /// Presents [`TEST_CREDENTIAL`], the credential `start_test_server_on`
    /// granted, and so reaches every wire **except** the five the scope gate
    /// binds to a session name (#1013). A test that sends one of those says which
    /// session it means through [`connect_client_for`].
    async fn connect_client(credentials: &P2pCredentials, addr: SocketAddr) -> (WsSink, WsStream) {
        dial_presenting(credentials, addr, TEST_CREDENTIAL).await
    }

    /// Connect presenting a credential bound to `session`.
    ///
    /// Mints into the server's own store, so the credential these tests present
    /// is one the production `grant` path accepted — and mints it *here* rather
    /// than at `start_test_server_on`, because the session names these tests
    /// attach to are generated per run and do not exist yet when the server
    /// starts.
    ///
    /// The credential string is derived from the session name: the store is per
    /// server and the servers are per test, so uniqueness only has to hold within
    /// one test, and a second dial for the same session re-grants the same value
    /// instead of needing a counter.
    async fn connect_client_for(
        credentials: &P2pCredentials,
        addr: SocketAddr,
        session: &str,
    ) -> (WsSink, WsStream) {
        let credential = format!("credential-for-{session}");
        grant_credential(
            credentials,
            &credential,
            CredentialScope::for_attach(session),
        );
        dial_presenting(credentials, addr, &credential).await
    }

    /// Send a JSON request and receive the matching JSON response.
    /// Skips over unsolicited messages (e.g., terminal.output) that may
    /// arrive from background tasks.
    async fn send_and_receive<S, R>(
        sink: &mut WsSink,
        stream: &mut WsStream,
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
        let (resize, _resize_updates) = ResizeReporter::new();
        let server = AgentServer::new(
            "127.0.0.1:0",
            "test-agent",
            None,
            "/tmp".to_string(),
            tmp.path().to_string_lossy().as_ref(),
            AttachMode::Plain,
            AgentServerContext {
                resize,
                credentials: Arc::new(P2pCredentials::new()),
                mutations: crate::execution::mutation_scheduler(),
                memory_threshold_percent: None,
            },
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
            slow.try_send((vec![0u8], 1, n as u64))
                .unwrap_or_else(|_| panic!("the queue must have room for chunk {n}"));
        }

        let mut subscribers = vec![healthy, slow, gone];
        let chunk = (b"output".to_vec(), 1_u64, 1_u64);
        assert_eq!(
            fan_out(&mut subscribers, chunk),
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
                .expect("the subscriber with room got the chunk")
                .0,
            b"output".to_vec()
        );
        subscribers[0]
            .try_send((b"more".to_vec(), 1, 2))
            .expect("the remaining subscriber still has room");
        assert_eq!(
            healthy_rx
                .try_recv()
                .expect("the same subscriber got this one")
                .0,
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
                fan_out(&mut subscribers, (b"chunk".to_vec(), 1, n as u64)),
                0,
                "detached at chunk {n}"
            );
            assert_eq!(
                rx.try_recv().expect("the subscriber is draining").0,
                b"chunk".to_vec()
            );
        }
        assert_eq!(subscribers.len(), 1);
    }

    /// The detach above is only a policy if a client ever hears about it.
    ///
    /// A detached subscriber's forwarder has exactly one thing left to do:
    /// close the connection, so the client re-attaches and is handed a redrawn
    /// screen. This is that half, driven end to end through the production
    /// path: `fan_out_peers` evicts the saturated subscriber, and the flag it
    /// sets on the way out is what turns the receiver's end into the verdict
    /// (#1226).
    ///
    /// The socket is not real here and does not need to be: what is asserted is
    /// the *verdict*, and `P2pOutbound::close` is where a verdict becomes a
    /// connection ending.
    #[tokio::test]
    async fn a_detached_subscriber_closes_the_connection() {
        let (outbound, _rx) = P2pOutbound::new();
        let (tx, rx) = mpsc::channel::<OutputChunk>(SUBSCRIBER_QUEUE_SLOTS);
        let detached_for_not_draining = Arc::new(AtomicBool::new(false));
        let (peer_outbound, _) = P2pOutbound::new();
        let mut peers = vec![SessionPeer {
            client_id: "test-client".to_string(),
            outbound: peer_outbound,
            output_tx: Some(tx.clone()),
            detached_for_not_draining: Arc::clone(&detached_for_not_draining),
        }];

        spawn_output_forwarder(
            rx,
            outbound.clone(),
            "s1".to_string(),
            detached_for_not_draining,
        );

        // Saturate the subscriber queue, then let one more chunk evict it —
        // the production trigger, not a re-enactment of it.
        for n in 0..SUBSCRIBER_QUEUE_SLOTS {
            tx.try_send((b"chunk".to_vec(), 1, n as u64))
                .expect("room before the bound");
        }
        assert_eq!(
            fan_out_peers(&mut peers, (b"one too many".to_vec(), 1, 0)),
            1,
            "the saturated subscriber is detached"
        );
        assert!(peers.is_empty(), "the eviction removes the peer");
        drop(tx);

        let closed = tokio::time::timeout(Duration::from_secs(5), async {
            while !outbound.is_closed() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(
            closed.is_ok(),
            "a detached subscriber left the connection open: the client keeps a \
             terminal that has stopped moving, with nothing coming to say so"
        );
    }

    /// The #1226 half: the receiver also ends when a newer attach of the same
    /// client *replaces* this peer, and that end must be quiet.
    ///
    /// Driven exactly the way the `already_attached` arm drives it: the peer's
    /// sender is dropped with its flag never set. The old verdict — "the
    /// session is still in the map" — closed the connection here, which is
    /// the bug: the replacement attach's own reply then had no socket left to
    /// arrive on.
    #[tokio::test]
    async fn a_superseded_forwarder_leaves_the_connection_open() {
        let (outbound, _rx) = P2pOutbound::new();
        let (tx, rx) = mpsc::channel::<OutputChunk>(SUBSCRIBER_QUEUE_SLOTS);

        spawn_output_forwarder(
            rx,
            outbound.clone(),
            "s1".to_string(),
            Arc::new(AtomicBool::new(false)),
        );

        // `already_attached` drops the old peer's sender without setting the
        // flag — that is the whole of "replaced, not evicted".
        drop(tx);

        // The forwarder gets its chance to misjudge, then the verdict: still
        // open. An absent close can only be waited out.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            !outbound.is_closed(),
            "a replaced peer's forwarder closed the connection: the attach that \
             superseded it has no socket left to answer on (#1226)"
        );
    }

    /// A terminal lane that never gets room ends the connection rather than
    /// parking a forwarder forever.
    ///
    /// This is `#961`'s backpressure requirement for this socket, end to end:
    /// the queue is bounded, the policy at the bound is stated, and the verdict
    /// reaches the connection. What it replaces is a forwarder parked on an
    /// unbounded socket write — where the *upper* policy (`SUBSCRIBER_QUEUE_SLOTS`
    /// detaching this subscriber) could never be delivered, because the
    /// forwarder never got to observe its own receiver closing.
    ///
    /// The queue is saturated with one oversized state frame — `charge` clamps a
    /// frame larger than the budget to the whole of it — so the next terminal
    /// frame has no room and the grace is what decides. The grace is shortened
    /// because waiting out a production number is waiting out the calendar; the
    /// bound still has to be reached first, which is what the saturation
    /// arranges.
    #[tokio::test]
    async fn a_terminal_forwarder_that_cannot_drain_closes_the_connection() {
        use crate::server::outbound::OUTBOUND_BYTE_BUDGET;

        let (outbound, _rx) = P2pOutbound::with_terminal_grace(Duration::from_millis(50));
        assert_eq!(
            outbound.try_send_state(WsMessage::Text("x".repeat(OUTBOUND_BYTE_BUDGET))),
            Ok(()),
            "the whole byte budget is one frame's worth"
        );

        let (tx, rx) = mpsc::channel::<OutputChunk>(SUBSCRIBER_QUEUE_SLOTS);
        spawn_output_forwarder(
            rx,
            outbound.clone(),
            "s1".to_string(),
            Arc::new(AtomicBool::new(false)),
        );

        tx.send((b"chunk".to_vec(), 1, 1))
            .await
            .expect("the chunk is sent");
        let closed = tokio::time::timeout(Duration::from_secs(5), async {
            while !outbound.is_closed() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(
            closed.is_ok(),
            "a terminal frame waited out the grace and the connection stayed open: \
             the forwarder is parked on a queue nobody is draining"
        );
        assert_eq!(
            outbound.snapshot().stalled_terminals,
            1,
            "the verdict was reached, and the counter is where it is visible"
        );
    }

    #[tokio::test]
    async fn test_session_list_request() {
        let (addr, handle, credentials) = start_test_server_on(18081).await;
        let (mut sink, mut stream) = connect_client(&credentials, addr).await;

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
        let (addr, handle, credentials) = start_test_server_on(18082).await;
        let (mut sink, mut stream) = connect_client(&credentials, addr).await;

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
            working_dir: None,
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
        let (addr, handle, credentials) = start_test_server_on(18083).await;

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

        // The dial comes after the session does: the credential it presents is
        // bound to `session_name`, which is generated per run.
        let (mut sink, mut stream) = connect_client_for(&credentials, addr, &session_name).await;

        // Attach via WebSocket.
        let attach_payload = ClientAttachPayload {
            session_name: session_name.to_string(),
            width: 80,
            height: 24,
            // Stated, therefore authoritative: these tests mean the size they
            // write, which is what a client predating the field says by saying
            // nothing (#1265).
            size_known: None,
            env_snapshots: Vec::new(),
            needs_bootstrap: None,
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
        let (addr, handle, credentials) = start_test_server_on(18084).await;

        let tmux = SessionManager::new();
        let session = TestSession::new("srv-io");
        let session_name = session.name().to_string();
        tmux.kill_session(&session_name).await.ok();
        tmux.create_session(&session_name, 80, 24, "/tmp", &[])
            .await
            .unwrap();

        // The dial comes after the session does: the credential it presents is
        // bound to `session_name`, which is generated per run.
        let (mut sink, mut stream) = connect_client_for(&credentials, addr, &session_name).await;

        // Attach.
        let attach_payload = ClientAttachPayload {
            session_name: session_name.to_string(),
            width: 80,
            height: 24,
            // Stated, therefore authoritative: these tests mean the size they
            // write, which is what a client predating the field says by saying
            // nothing (#1265).
            size_known: None,
            env_snapshots: Vec::new(),
            needs_bootstrap: None,
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
            control_generation: None,
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
        let (addr, handle, credentials) = start_test_server_on(18085).await;
        let (mut sink, mut stream) = connect_client(&credentials, addr).await;

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
        let (addr, handle, credentials) = start_test_server_on(0).await;
        let (mut sink, mut stream) = connect_client_for(&credentials, addr, "any").await;

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
        let (addr, handle, credentials) = start_test_server_on(0).await;
        let (mut sink, mut stream) = connect_client_for(&credentials, addr, "any").await;

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
        let (addr, handle, credentials) = start_test_server_on(0).await;
        let (mut sink, mut stream) =
            connect_client_for(&credentials, addr, "nession-test-does-not-exist-xyz").await;

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
        let (addr, handle, credentials) = start_test_server_on(0).await;

        let tmux = SessionManager::new();
        let session = TestSession::new("srv-preview");
        let session_name = session.name().to_string();
        tmux.kill_session(&session_name).await.ok();
        tmux.create_session(&session_name, 80, 24, "/tmp", &[])
            .await
            .unwrap();
        crate::tmux::ops::TmuxOps::global()
            .send_keys(&session_name, "echo hello-from-preview")
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        // The dial comes after the session does: the credential it presents is
        // bound to `session_name`, which is generated per run.
        let (mut sink, mut stream) = connect_client_for(&credentials, addr, &session_name).await;

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
        let (addr, handle, credentials) = start_test_server_on(18092).await;
        let (mut sink, mut stream) = connect_client(&credentials, addr).await;

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
        let (addr, handle, credentials) = start_test_server_on(0).await;
        let (mut sink, mut stream) = connect_client(&credentials, addr).await;

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
        let (addr, handle, credentials) = start_test_server_on(18086).await;
        let (mut sink, mut stream) = connect_client(&credentials, addr).await;

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
        let (addr, handle, credentials) = start_test_server_on(18087).await;
        let (mut sink, mut stream) = connect_client(&credentials, addr).await;

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
        let (addr, handle, credentials) = start_test_server_on(18088).await;
        let (mut sink, mut stream) = connect_client(&credentials, addr).await;

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
        let (addr, handle, credentials) = start_test_server_on(18091).await;
        let (mut sink, mut stream) = connect_client(&credentials, addr).await;

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
        let (addr, handle, credentials) = start_test_server_on(18089).await;
        let (mut sink, mut stream) = connect_client(&credentials, addr).await;

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
        let (addr, handle, credentials) = start_test_server_on(18090).await;
        let (mut sink, mut stream) = connect_client(&credentials, addr).await;

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
        let (addr, handle, credentials) = start_test_server_on(18093).await;
        let (mut sink, mut stream) = connect_client(&credentials, addr).await;

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
        let (addr, handle, credentials) = start_test_server_on(18094).await;
        let (mut sink, mut stream) = connect_client(&credentials, addr).await;

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
        let (addr, handle, credentials) = start_test_server_on(18095).await;

        let tmux = SessionManager::new();
        let session = TestSession::new("srv-invalid-b64");
        let session_name = session.name().to_string();
        tmux.kill_session(&session_name).await.ok();
        tmux.create_session(&session_name, 80, 24, "/tmp", &[])
            .await
            .unwrap();

        // The dial comes after the session does: the credential it presents is
        // bound to `session_name`, which is generated per run.
        let (mut sink, mut stream) = connect_client_for(&credentials, addr, &session_name).await;

        // Attach first
        let attach_payload = ClientAttachPayload {
            session_name: session_name.to_string(),
            width: 80,
            height: 24,
            // Stated, therefore authoritative: these tests mean the size they
            // write, which is what a client predating the field says by saying
            // nothing (#1265).
            size_known: None,
            env_snapshots: Vec::new(),
            needs_bootstrap: None,
        };
        let attach_req = new_message(msg_types::CLIENT_ATTACH, attach_payload);
        let _ = send_and_receive::<_, serde_json::Value>(&mut sink, &mut stream, &attach_req).await;

        // Send invalid base64 data
        let input_payload = TerminalInputPayload {
            session_name: session_name.to_string(),
            data: "!!!not-valid-base64!!!".to_string(),
            control_generation: None,
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
        // The placeholder's columns are still authoritative to a client that
        // says nothing about them: absence is the *old* meaning, and every
        // client written before `size_known` sends exactly this (#1265).
        assert_eq!(p.size_known, None);
        assert!(p.size_is_authoritative());
    }

    /// The one thing a client can say that changes how its size is treated.
    ///
    /// Without this, the field could be inverted (or read as `unwrap_or(false)`)
    /// and every test above would still pass while an unmeasured client went
    /// back to resizing the shared window to 80×24 (#1265).
    #[test]
    fn an_unmeasured_size_is_the_only_one_that_is_not_authoritative() {
        let read = |known: Option<bool>| {
            let mut json = serde_json::json!({"session_name": "s", "width": 120, "height": 40});
            if let Some(known) = known {
                json["size_known"] = serde_json::json!(known);
            }
            let p: ClientAttachPayload = serde_json::from_value(json).unwrap();
            p.size_is_authoritative()
        };
        assert!(read(None), "absent must preserve the old meaning");
        assert!(read(Some(true)));
        assert!(!read(Some(false)));
    }

    /// The decision the two attach arms make, in the three cases that matter.
    ///
    /// `Some(false)` is what a page that has not laid its Terminal out says, and
    /// the pane's size is what it must get: the alternative is resizing the
    /// **shared** window to the payload's placeholder and back, which repaints
    /// an inline-drawing application into the scrollback the user reads (#1265).
    #[test]
    fn an_unmeasured_attach_inherits_the_panes_size() {
        let stated = (80, 24);
        assert_eq!(
            choose_attach_size(true, stated, Some((101, 31))),
            stated,
            "a measured client's own columns are the instruction, not the pane's"
        );
        assert_eq!(
            choose_attach_size(false, stated, Some((101, 31))),
            (101, 31),
            "an unmeasured attach kept the placeholder instead of inheriting"
        );
        assert_eq!(
            choose_attach_size(false, stated, None),
            stated,
            "a pane that could not be read must leave the attach its stated \
             size — the attach's own error is the one worth surfacing"
        );
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
        let (addr, handle, credentials) = start_test_server_on(18096).await;
        let (mut sink, mut stream) = connect_client(&credentials, addr).await;

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
        let (addr, handle, credentials) = start_test_server_on(18097).await;
        let (mut sink, mut stream) = connect_client(&credentials, addr).await;

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
        let (addr, handle, credentials) = start_test_server_on(18099).await;
        let (mut sink, mut stream) = connect_client(&credentials, addr).await;

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
        let (addr, handle, credentials) = start_test_server_on(18100).await;
        let (mut sink, mut stream) = connect_client(&credentials, addr).await;

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
        let (addr, handle, credentials) = start_test_server_on(18101).await;
        let (mut sink, mut stream) = connect_client(&credentials, addr).await;

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
            working_dir: None,
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
        let (addr, handle, credentials) = start_test_server_on(18102).await;
        let (mut sink, mut stream) = connect_client(&credentials, addr).await;

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
        let (addr, handle, credentials) = start_test_server_on(18103).await;
        let (mut sink, mut stream) = connect_client(&credentials, addr).await;

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
        let (addr, handle, credentials) = start_test_server_on(18104).await;
        let (mut sink, mut stream) =
            connect_client_for(&credentials, addr, "never-attached-session").await;

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
        let (addr, handle, credentials) = start_test_server_on(18105).await;
        let (mut sink, mut stream) =
            connect_client_for(&credentials, addr, "no-such-session").await;

        use base64::Engine;
        let input_payload = TerminalInputPayload {
            session_name: "no-such-session".to_string(),
            data: base64::engine::general_purpose::STANDARD.encode(b"hello"),
            control_generation: None,
        };
        let req = new_message(msg_types::TERMINAL_INPUT, input_payload);
        let resp: Message<ErrorPayload> = send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.msg_type, msg_types::ERROR);
        assert_eq!(resp.payload.code, "not_attached");

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_terminal_resize_not_attached() {
        let (addr, handle, credentials) = start_test_server_on(18106).await;
        let (mut sink, mut stream) =
            connect_client_for(&credentials, addr, "no-such-session").await;

        let resize_payload = TerminalResizePayload {
            session_name: "no-such-session".to_string(),
            cols: 120,
            rows: 40,
            control_generation: None,
            stream_epoch: None,
            stream_seq: None,
        };
        let req = new_message(msg_types::TERMINAL_RESIZE, resize_payload);
        let resp: Message<ErrorPayload> = send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.msg_type, msg_types::ERROR);
        assert_eq!(resp.payload.code, "not_attached");

        handle.shutdown().await.ok();
    }

    /// A resize must not hold this session's backend while its fan-out waits for
    /// room (#1352).
    ///
    /// A `match` scrutinee's temporaries live to the end of the **whole match**,
    /// so writing the resize as the scrutinee —
    /// `match backend.lock().await.resize(..).await { Ok(_) => { ..await.. } }` —
    /// keeps the guard alive across `send_recorded_resize_msg`, and
    /// `send_terminal` waits out the stall grace. A peer that has stopped
    /// draining then parks the session's backend for that whole window, which is
    /// the opposite of what `AttachedSession::backend` documents the lock is for.
    ///
    /// **The assertion is the lock, not the code shape.** `charge` clamps a frame
    /// to the byte budget, so one oversized frame on the connection's outbound is
    /// enough to leave no room for the next send; the fan-out then parks, and the
    /// test asks for the backend and fails if it does not get it. Scoping the
    /// guard is the only thing that makes it available.
    ///
    /// Two preconditions keep this from passing vacuously: the fan-out must
    /// actually have had to wait (`awaited` rose — a timeout would otherwise be
    /// indistinguishable from a handler that returned early), and the dispatch
    /// must still be running when the lock is asked for.
    #[tokio::test]
    async fn a_stalled_fan_out_does_not_hold_the_session_backend() {
        use crate::server::outbound::OUTBOUND_BYTE_BUDGET;
        use crate::tmux::session::TmuxSession;

        /// Only `resize` is reached; the rest exist because the arm holds a
        /// `Box<dyn TmuxSession>`.
        struct Resizing;
        #[async_trait::async_trait]
        impl TmuxSession for Resizing {
            async fn write_input(&mut self, _data: &[u8]) -> anyhow::Result<()> {
                Ok(())
            }
            async fn resize(&mut self, _cols: u16, _rows: u16) -> anyhow::Result<()> {
                Ok(())
            }
            fn viewport(&self) -> (u16, u16) {
                (80, 24)
            }
            fn session_name(&self) -> &str {
                "resize-lock"
            }
            async fn close(&mut self) -> anyhow::Result<()> {
                Ok(())
            }
        }

        const SESSION: &str = "resize-lock";
        let client_id = "test-client".to_string();

        let backend: Arc<Mutex<Box<dyn TmuxSession>>> = Arc::new(Mutex::new(Box::new(Resizing)));
        let mut control = session_terminal::SessionControlState::new();
        control.ensure_controller(&client_id);
        let sessions: Arc<SessionMapLock> = Arc::new(SessionMapLock::new(
            [(
                SESSION.to_string(),
                AttachedSession {
                    backend: Arc::clone(&backend),
                    peers: Vec::new(),
                    control,
                    stream: session_terminal::SessionStreamState::new(),
                },
            )]
            .into_iter()
            .collect(),
        ));

        // The connection's outbound, with nothing draining it. One frame at the
        // byte budget's own size takes the whole budget (`charge` clamps to it),
        // so the fan-out's send has no room and waits.
        let (outbound, _outbound_rx) = P2pOutbound::new();
        outbound
            .try_send_state(WsMessage::Text("x".repeat(OUTBOUND_BYTE_BUDGET)))
            .expect("the first frame fits the budget it is about to exhaust");

        let tmux = Arc::new(SessionManager::new());
        let file_ops = Arc::new(crate::fs::ops::FileOps::new(
            crate::fs::sandbox::PathSandbox::new("/tmp").expect("a sandbox root"),
        ));
        let (resize, _resize_updates) = ResizeReporter::new();
        let client: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(Some(client_id.clone())));
        let attach_mode = AttachMode::Plain;
        let probe = outbound.clone();
        let payload = serde_json::json!({
            "session_name": SESSION,
            "cols": 100,
            "rows": 30,
        });

        // Through the real routing table, not a copy of the arm: a helper called
        // directly would leave the arm's own wiring — which is where the guard
        // is taken — unpinned.
        let dispatch = tokio::spawn(async move {
            let ctx = P2pRequest {
                id: "resize-1",
                tmux: &tmux,
                sessions: &sessions,
                client_id: &client,
                outbound: &outbound,
                default_working_dir: "/tmp",
                file_ops: &file_ops,
                listen_address: "127.0.0.1:0",
                agent_id: "test-agent",
                attach_mode: &attach_mode,
                resize: &resize,
            };
            dispatch_p2p(ctx, msg_types::TERMINAL_RESIZE, payload).await
        });

        let parked = tokio::time::timeout(Duration::from_secs(5), async {
            while probe.snapshot().awaited == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(
            parked.is_ok(),
            "the fan-out never had to wait, so nothing was asserted: the \
             connection's outbound still had room for the resize frame"
        );
        assert!(
            !dispatch.is_finished(),
            "the handler returned before the fan-out parked, so nothing was asserted"
        );

        let free = tokio::time::timeout(Duration::from_secs(1), backend.lock()).await;
        dispatch.abort();
        assert!(
            free.is_ok(),
            "the session's backend is unavailable while the fan-out waits for a peer that is \
             not draining: the guard lives to the end of the match it was taken in, so every \
             other operation on this session queues behind the stall grace"
        );
    }

    /// A resize that consumed no sequence number must stay **byte-identical**
    /// to the frame this produced before resizes could carry a position
    /// (#1303).
    ///
    /// Every `%window-resize` echo and every frame the Server forwards is a
    /// level, and `terminal_resize_frame` is the one place either is built. The
    /// property is not free: emitting `"stream_epoch":null` for them would hand
    /// an older reader a null it has to tolerate, which is exactly what the
    /// payload's `skip_serializing_if` pair exists to prevent — and it is
    /// asserted against the descriptor rather than against a round trip,
    /// because a round trip passes for any self-consistent shape.
    #[test]
    fn a_level_resize_frame_carries_no_position() {
        let json = terminal_resize_frame("work", 80, 24, None).expect("a resize frame serialises");
        let frame: serde_json::Value = serde_json::from_str(&json).unwrap();
        let payload = frame.get("payload").expect("the frame carries a payload");
        assert!(
            payload.get("stream_epoch").is_none() && payload.get("stream_seq").is_none(),
            "a level resize emitted a stream position: {json}"
        );

        let json =
            terminal_resize_frame("work", 80, 24, Some((7, 9))).expect("a resize frame serialises");
        let frame: serde_json::Value = serde_json::from_str(&json).unwrap();
        let payload = frame.get("payload").expect("the frame carries a payload");
        assert_eq!(
            payload
                .get("stream_epoch")
                .and_then(serde_json::Value::as_u64),
            Some(7)
        );
        assert_eq!(
            payload
                .get("stream_seq")
                .and_then(serde_json::Value::as_u64),
            Some(9)
        );
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
        msg_types::TERMINAL_CONTROL_ACQUIRE,
        msg_types::TERMINAL_STREAM_RESUME,
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

    // ── The P2P credential (#1013) ──────────────────────────────────────────
    //
    // Two layers, one test each, because they answer different questions and a
    // suite that tested only one would pass with the other absent: the
    // **upgrade** asks whether there is a credential at all, and the **gate in
    // `Frame::route`** asks whether this credential covers this wire.

    /// A dial with no credential is refused at the upgrade.
    ///
    /// Refused *before* a WebSocket exists, which is the property worth having:
    /// there is no connection to leave in a half-authenticated state, and no
    /// later handler that has to remember to check. `connect_async` failing here
    /// is the whole assertion — if the upgrade had succeeded, this call would
    /// have returned a socket.
    #[tokio::test]
    async fn a_connection_with_no_credential_is_refused() {
        let (addr, handle, _) = start_test_server_on(0).await;

        let refused = connect_async(format!("ws://{addr}")).await;

        assert!(
            refused.is_err(),
            "a peer that presented nothing must not get a WebSocket"
        );

        handle.shutdown().await.ok();
    }

    /// A credential nobody issued is refused, and refused the same way.
    ///
    /// The second half is the one worth stating: the peer is told nothing about
    /// *why*, so "unknown", "expired" and "issued for another agent" are
    /// indistinguishable from out here. A message that distinguished them would
    /// tell a caller which of its guesses was closest.
    #[tokio::test]
    async fn a_credential_nobody_issued_is_refused() {
        let (addr, handle, _) = start_test_server_on(0).await;

        let url = agent_url_with_credential(&format!("ws://{addr}"), "a-guess");
        let refused = connect_async(&url).await;

        assert!(refused.is_err(), "an invented credential must not connect");

        handle.shutdown().await.ok();
    }

    /// The credential the server minted is accepted — the other direction.
    ///
    /// Without this, both tests above pass for a listener that refuses
    /// everything, which is a different bug with the same green.
    #[tokio::test]
    async fn the_minted_credential_is_accepted() {
        let (addr, handle, credentials) = start_test_server_on(0).await;

        // `connect_client` presents `TEST_CREDENTIAL`, which
        // `start_test_server_on` minted; reaching the next line is the assertion.
        let (mut sink, mut stream) = connect_client(&credentials, addr).await;
        let req: Message<serde_json::Value> = Message {
            msg_type: msg_types::CONTROL_PING.to_string(),
            id: "cred-ok".to_string(),
            timestamp: now_timestamp(),
            payload: serde_json::json!({}),
        };
        let resp: Message<serde_json::Value> = send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.msg_type, msg_types::CONTROL_PONG);

        handle.shutdown().await.ok();
    }

    /// A scope refusal answers the frame and **keeps the connection**.
    ///
    /// The wire is refused, the reason is not the peer's, and the socket still
    /// works for the next frame — which is what separates a scope check from a
    /// hangup. A caller that strayed outside its credential has made an ordinary
    /// mistake, and closing the connection would turn it into a reattach storm
    /// that reports nothing about the cause.
    #[tokio::test]
    async fn a_frame_outside_the_scope_is_refused_and_the_connection_survives() {
        let (addr, handle, _) = start_test_server_on(0).await;

        // A relay credential: terminal for one session, and neither session
        // management nor the file sandbox. Presented directly rather than
        // through `connect_client`, which mints the broad one — the point here
        // is the narrow credential.
        let url = agent_url_with_credential(&format!("ws://{addr}"), NARROW_CREDENTIAL);
        let (ws, _response) = connect_async(&url)
            .await
            .expect("a granted credential connects");
        let (mut sink, mut stream) = ws.split();

        // `agent.file.list` needs the file sandbox, which this credential does
        // not have — and which is a real boundary rather than a precaution,
        // because the relay leg never touches a file.
        let req: Message<serde_json::Value> = Message {
            msg_type: msg_types::FILE_LIST.to_string(),
            id: "scope-1".to_string(),
            timestamp: now_timestamp(),
            payload: serde_json::json!({ "path": "." }),
        };
        let resp: Message<ErrorPayload> = send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.msg_type, msg_types::ERROR);
        assert_eq!(resp.id, "scope-1");
        assert_eq!(resp.payload.code, "forbidden");
        assert!(
            !resp.payload.message.contains("token"),
            "the reply must not hand the peer vocabulary about credentials: {}",
            resp.payload.message
        );

        // Still usable.
        let ping: Message<serde_json::Value> = Message {
            msg_type: msg_types::CONTROL_PING.to_string(),
            id: "scope-2".to_string(),
            timestamp: now_timestamp(),
            payload: serde_json::json!({}),
        };
        let pong: Message<serde_json::Value> =
            send_and_receive(&mut sink, &mut stream, &ping).await;
        assert_eq!(
            pong.msg_type,
            msg_types::CONTROL_PONG,
            "a scope refusal must leave the connection usable"
        );

        handle.shutdown().await.ok();
    }

    /// A wire this socket does not carry is still reported as unknown, not
    /// forbidden.
    ///
    /// The two answers mean different things and the gate has to keep them
    /// apart: `p2p_scope` returns `None` for a name no arm carries, and routing
    /// that as a permission failure would be a false statement about why the
    /// call failed — it would send a caller to look at its credential when the
    /// problem is the wire name.
    #[tokio::test]
    async fn an_unknown_wire_is_not_reported_as_a_scope_refusal() {
        let (addr, handle, credentials) = start_test_server_on(0).await;
        let (mut sink, mut stream) = connect_client(&credentials, addr).await;

        let req: Message<serde_json::Value> = Message {
            msg_type: "agent.nothing.here".to_string(),
            id: "unknown-1".to_string(),
            timestamp: now_timestamp(),
            payload: serde_json::json!({}),
        };
        let resp: Message<ErrorPayload> = send_and_receive(&mut sink, &mut stream, &req).await;

        assert_eq!(resp.payload.code, "unknown_message_type");

        handle.shutdown().await.ok();
    }

    /// A credential for one agent is refused by another.
    ///
    /// The credential is well formed, unexpired, and minted through the same
    /// production `grant` — it simply names someone else. Two agents, two
    /// stores, and the second has never heard of this token.
    #[tokio::test]
    async fn one_agents_credential_is_refused_by_another() {
        let (addr_a, handle_a, credentials_a) = start_test_server_on(0).await;
        let (addr_b, handle_b, _) = start_test_server_on(0).await;

        // Both servers mint `TEST_CREDENTIAL` for their own `test-agent` id, so
        // the tokens are equal strings in two stores — which is exactly why the
        // refusal has to come from the *store*, not from the string. Presenting
        // b's address with the credential a minted must fail.
        let url =
            agent_url_with_credential(&format!("ws://{addr_b}"), "a-credential-b-never-issued");
        assert!(
            connect_async(&url).await.is_err(),
            "an agent must refuse a credential it never issued"
        );
        // And a's own credential still works, so the refusal above is about the
        // credential rather than about the server.
        let _ok = connect_client(&credentials_a, addr_a).await;

        handle_a.shutdown().await.ok();
        handle_b.shutdown().await.ok();
    }
}
