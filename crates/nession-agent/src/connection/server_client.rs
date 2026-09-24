//! WebSocket client for connecting to the central nession-server.
//!
//! The [`ServerClient`] runs a supervisor task that connects to the central
//! server, registers the agent, and then services the connection. If the
//! connection drops for any reason, the supervisor reconnects with exponential
//! backoff and re-registers — the loop never exits until shutdown is requested.
//!
//! Outgoing messages (heartbeats, session updates) are queued on an unbounded
//! channel rather than written to the socket directly. The supervisor drains
//! the queue onto whatever connection is currently live; while disconnected,
//! queued messages are dropped. This means callers never observe a "broken
//! pipe" — sending always succeeds locally and delivery resumes after reconnect.
//!
//! ## The two halves of a live connection (`#961-E`)
//!
//! Servicing a connection is two jobs, and until this stage one `select!` loop
//! did both: reading frames and writing them. That was fine while every frame
//! became a detached task, because nothing the loop did could block for long —
//! and it stops being fine the moment dispatch is *bounded*, because the bound
//! is enforced by not reading, and a loop that stops reading also stops
//! draining the outbox. A heartbeat is an outbox message, so a reader parked on
//! a full lane would have been a heartbeat that stops when a session's queue is
//! full: precisely the regression `#961` says must not happen.
//!
//! So they are two tasks now, with one owner each:
//!
//! * [`ServerClient::write_loop`] owns the socket, and drains the outbox and
//!   the response channel. Nothing it does can be parked by business work.
//! * [`ServerClient::read_loop`] owns the stream and the lanes
//!   (`connection::execution`), and is the only half that may park on a bound.
//!
//! The comments on each say what the split makes true.

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use nession_protocol::contracts::agent::v1::{
    AgentAddress, AgentAddressUpdatePayload, AgentHeartbeatPayload, AgentMetadata,
    AgentRegisterPayload, AgentStatus, HeartbeatMetadata,
};
use nession_protocol::contracts::env::v1::{EnvFileRef, EnvSnapshot};
use nession_protocol::contracts::session::v1::{
    AgentSessionUpdatePayload, AgentTerminalResizePayload, ServerSessionCreatePayload,
    ServerSessionEnvApplyPayload, ServerSessionEnvUnsetPayload,
};
use nession_protocol::{Message, ProtocolMessage};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::{
    connect_async, tungstenite::protocol::Message as WsMessage, MaybeTlsStream, WebSocketStream,
};
use tracing::{debug, error, info, warn};

use crate::connection::execution::{self, Lanes, ResourceKey, SHUTDOWN_GRACE};
// The lanes' boxed work is the shared type: the lane that carries it knows
// nothing about this connection, which is the point of `nession-runtime`.
use nession_runtime::lane::Work;
// The three policies by name, because the `core_routes!` invocation at the
// bottom of this file declares one per unit and the names are the column there.
use crate::connection::execution::ExecutionPolicy::{Inline, Key, Query};
use crate::env::EnvStore;
use crate::extension::ExtensionRegistry;
use crate::protocol::core_routes;
use crate::tmux::manager::SessionManager;

/// Type alias for the WebSocket stream.
type WsStream = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// Type alias for the split sink (write half).
type WsSink = futures_util::stream::SplitSink<WsStream, WsMessage>;

/// Type alias for the split stream (read half).
type WsStreamHalf = futures_util::stream::SplitStream<WsStream>;

/// Maximum delay for exponential backoff (30 seconds).
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(30);

/// Initial delay for exponential backoff (1 second).
const INITIAL_RECONNECT_DELAY: Duration = Duration::from_secs(1);

/// How many command responses may be waiting for the socket at once (#961).
///
/// The queue carries one frame per command the Server sent, and a command is
/// answered by the handler task that received it — so this is really a bound on
/// "answers computed but not yet written". Deep enough that an ordinary
/// request/reply exchange never touches it; shallow enough that a Server which
/// has stopped reading cannot make the agent hold more than this many answers in
/// memory. At the extension contracts' 1 MiB read cap that is 32 MiB of frames
/// rather than the unbounded channel's "as much as the Server can ask for".
const AGENT_RESPONSE_QUEUE_SLOTS: usize = 32;

/// Message type constants for agent-to-server protocol.
pub mod msg_types {
    /// The registration operation, in both directions: the agent sends it, and
    /// the server's acceptance is a *reply* under the same name. One wire per
    /// operation — a reply is told from a request by the envelope's `id`, not
    /// by a `.response` suffix it no longer carries.
    pub const AGENT_REGISTER: &str = "server.agent.register";
    /// Control, not an operation: the agent sends it, the server handles it,
    /// and nothing answers it. It used to be `server.agent.heartbeat` — a
    /// spelling that read as "the server answers this", which stopped being
    /// true the moment the acknowledgement was recognised as a message of its
    /// own rather than a reply. See `docs/architecture/protocol.md` § *Control*.
    pub const CONTROL_HEARTBEAT: &str = "control.heartbeat";
    /// Control, same category as the heartbeat, and declared here because this
    /// module is where the agent's server-connection wires live. The runtime
    /// that answers a ping with a pong is the peer-to-peer one
    /// (`server::websocket`), and both of them — and the server — handle all
    /// three control wires, because control is symmetric.
    pub const CONTROL_PING: &str = "control.ping";
    pub const CONTROL_PONG: &str = "control.pong";
    pub const AGENT_SESSION_UPDATE: &str = "server.agent.session-update";
    pub const AGENT_ADDRESS_UPDATE: &str = "server.agent.address-update";
    /// Server asks the agent for its live tmux session list. Used by the web
    /// UI's force-refresh so the server can rebuild its registry from the
    /// agent's actual state instead of waiting for the next watcher poll.
    pub const SERVER_SESSIONS_LIST: &str = "agent.session.report";
}

// `SessionUpdatePayload` used to be declared here, beside the code that sends
// it. It is [`AgentSessionUpdatePayload`] now, in `contracts/session/v1.rs` —
// a wire type with a private definition is a second answer to a question the
// contract already owns, and nothing keeps the two agreeing. Its doc comment
// carries the full account.

/// Payload for registration response from server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterResponsePayload {
    pub status: String,
    pub message: String,
    /// Heartbeat interval the server wants this agent to use, in seconds.
    #[serde(default)]
    pub heartbeat_interval_secs: Option<u64>,
}

/// WebSocket client that connects to the central nession-server.
///
/// The client owns a supervisor task that handles connection, registration,
/// the message loop, and automatic reconnection with exponential backoff.
pub struct ServerClient {
    /// Server URL (e.g., "wss://server.example.com:8443").
    server_url: String,
    /// Authentication token for the server.
    auth_token: String,
    /// Agent identifier.
    agent_id: String,
    /// Hostname of the machine running the agent.
    hostname: String,
    /// IP address of the agent.
    ip_address: String,
    /// Port where the agent's WebSocket server is listening.
    port: u16,
    /// Public WebSocket URL for clients (e.g. "wss://agent.example.com/ws").
    /// When set, the server returns this to clients on session attach.
    connect_url: Option<String>,
    /// All advertised endpoints (detected NICs + config-declared), finalised
    /// (deduped, priority-ordered, capped). Sent in the register payload.
    addresses: Vec<AgentAddress>,
    /// Human-readable display name for the web UI (from agent config).
    display_name: Option<String>,
    /// Default working directory for new tmux sessions.
    default_working_dir: String,
    /// Registry for dispatching the units the composed providers declare.
    extension_registry: Option<Arc<ExtensionRegistry>>,
    /// Agent metadata.
    metadata: AgentMetadata,
    /// Tmux manager for handling session commands.
    tmux: Arc<SessionManager>,
    /// Store for agent-local env files under `~/.nession/agent/envs`.
    env_store: EnvStore,
    /// Track sourced env files per session (session_id -> Vec<EnvFileRef>)
    sourced_envs: std::sync::Mutex<HashMap<String, Vec<EnvFileRef>>>,
}

/// Handle to a running [`ServerClient`] for sending messages and shutdown.
///
/// Messages are queued on a channel and delivered by the supervisor task to
/// the live connection. Sends never fail due to a dropped connection.
#[derive(Clone)]
pub struct ServerClientHandle {
    outbox: mpsc::UnboundedSender<WsMessage>,
    shutdown_tx: mpsc::Sender<()>,
    agent_id: String,
    /// Agent version info — included in each heartbeat.
    metadata: AgentMetadata,
    /// Set by the supervisor after a reconnection so that the
    /// SessionWatcher can force a full session re-sync to the server.
    sync_needed: Arc<AtomicBool>,
    /// Set by the supervisor to indicate whether the connection is currently live.
    /// The SessionWatcher checks this to skip sending updates while disconnected.
    connected: Arc<AtomicBool>,
}

impl ServerClientHandle {
    /// Mark that a full session sync is needed (called by supervisor on reconnect).
    pub fn mark_sync_needed(&self) {
        self.sync_needed.store(true, Ordering::SeqCst);
    }

    /// Check and clear the sync-needed flag. Returns `true` if a full
    /// session re-sync is required (server-side registry may be stale).
    pub fn take_sync_needed(&self) -> bool {
        self.sync_needed.swap(false, Ordering::SeqCst)
    }

    /// Returns `true` when the supervisor has an active connection to the server.
    /// The SessionWatcher uses this to skip sending updates while disconnected,
    /// avoiding accumulation of stale messages in the outbox channel.
    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    /// Queue a heartbeat message for delivery to the server.
    pub async fn send_heartbeat(
        &self,
        status: AgentStatus,
        session_count: u32,
        active_sessions: u32,
        uptime_seconds: u64,
        load_average: [f64; 3],
    ) -> Result<()> {
        let payload = AgentHeartbeatPayload {
            agent_id: self.agent_id.clone(),
            status,
            session_count,
            active_sessions,
            metadata: HeartbeatMetadata {
                uptime_seconds,
                load_average,
                agent: Some(self.metadata.clone()),
            },
        };
        let msg = new_message(msg_types::CONTROL_HEARTBEAT, payload);
        self.enqueue(&msg)
    }

    /// Queue a session update message for delivery to the server.
    pub async fn send_session_update(
        &self,
        session_name: &str,
        status: &str,
        window_count: u32,
        attached_clients: u32,
        foreground_command: Option<&str>,
    ) -> Result<()> {
        let payload = AgentSessionUpdatePayload {
            agent_id: self.agent_id.clone(),
            session_name: session_name.to_string(),
            status: status.to_string(),
            window_count,
            attached_clients,
            foreground_command: foreground_command.map(std::string::ToString::to_string),
        };
        let msg = new_message(msg_types::AGENT_SESSION_UPDATE, payload);
        self.enqueue(&msg)
    }

    /// Queue an address-update message for delivery to the server.
    ///
    /// Called by the network watcher when interfaces change. The server
    /// replaces the agent's advertised address list and re-probes
    /// reachability.
    pub async fn send_address_update(&self, addresses: Vec<AgentAddress>) -> Result<()> {
        let payload = AgentAddressUpdatePayload {
            agent_id: self.agent_id.clone(),
            addresses,
        };
        let msg = new_message(msg_types::AGENT_ADDRESS_UPDATE, payload);
        self.enqueue(&msg)
    }

    /// Queue a terminal resize event for delivery to the central server, which
    /// broadcasts it to relay clients attached to the session.
    ///
    /// `session_id` is the FULL `agent:name` id — the server's
    /// `handle_agent_terminal_resize` looks up relay clients by `payload.session_id`
    /// (not the bare session name).
    pub async fn send_terminal_resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<()> {
        let payload = AgentTerminalResizePayload {
            session_id: session_id.to_string(),
            cols,
            rows,
        };
        let msg = new_message("agent.terminal.resize", payload);
        self.enqueue(&msg)
    }

    /// Serialize and enqueue a protocol message. A closed outbox (supervisor
    /// gone) is the only failure; a merely-disconnected socket is not.
    fn enqueue<P: Serialize>(&self, msg: &ProtocolMessage<P>) -> Result<()> {
        let json = serde_json::to_string(msg)?;
        self.outbox
            .send(WsMessage::Text(json))
            .map_err(|_| anyhow::anyhow!("server client supervisor has stopped"))
    }

    /// Request the client to shut down.
    pub async fn shutdown(&self) -> Result<()> {
        self.shutdown_tx
            .send(())
            .await
            .context("failed to send shutdown signal")
    }
}

impl ServerClient {
    /// Create a new server client.
    ///
    /// # Arguments
    /// * `server_url` - WebSocket URL of the server (e.g., "wss://server.example.com:8443")
    /// * `auth_token` - Authentication token for the server
    /// * `agent_id` - Unique identifier for this agent
    /// * `hostname` - Hostname of the machine
    /// * `ip_address` - IP address of the agent
    /// * `port` - Port where the agent's WebSocket server is listening
    /// * `connect_url` - Public WebSocket URL for P2P client connections
    /// * `addresses` - Finalised advertised endpoints (detected + declared)
    /// * `metadata` - Agent metadata (tmux version, OS version, etc.)
    /// * `tmux` - Tmux manager for handling session commands
    /// * `default_working_dir` - Default working directory for new tmux sessions
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        server_url: impl Into<String>,
        auth_token: impl Into<String>,
        agent_id: impl Into<String>,
        hostname: impl Into<String>,
        ip_address: impl Into<String>,
        port: u16,
        connect_url: Option<String>,
        addresses: Vec<AgentAddress>,
        display_name: Option<String>,
        metadata: AgentMetadata,
        tmux: Arc<SessionManager>,
        default_working_dir: String,
        extension_registry: Option<Arc<ExtensionRegistry>>,
    ) -> Self {
        let env_root = nession_common::paths::agent_envs_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from(".nession/agent/envs"));
        Self {
            server_url: server_url.into(),
            auth_token: auth_token.into(),
            agent_id: agent_id.into(),
            hostname: hostname.into(),
            ip_address: ip_address.into(),
            port,
            connect_url,
            addresses,
            display_name,
            default_working_dir,
            extension_registry,
            metadata,
            tmux,
            env_store: EnvStore::new(env_root),
            sourced_envs: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Start the supervisor task and return a handle plus the heartbeat
    /// interval the server requested on first registration.
    ///
    /// The supervisor connects, registers, services the connection, and
    /// reconnects with exponential backoff whenever the link drops — it runs
    /// until [`ServerClientHandle::shutdown`] is called. This call waits for
    /// the first successful connect+register so the returned interval reflects
    /// the server's configured cadence; on the (unlikely) event the supervisor
    /// stops before the first registration it falls back to `None`.
    pub async fn connect_and_run(self) -> Result<(ServerClientHandle, Option<u64>)> {
        let (outbox_tx, outbox_rx) = mpsc::unbounded_channel();
        let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
        // One-shot-ish channel to learn the heartbeat interval from the first
        // registration. Using a bounded channel of 1 keeps it simple.
        // The first attempt's outcome: the heartbeat interval on acceptance,
        // `Ok(None)` on a transient failure, or the server's reason for
        // refusing. `Err` is terminal and travels to the caller.
        let (interval_tx, mut interval_rx) = mpsc::channel::<Result<Option<u64>, String>>(1);
        let sync_needed = Arc::new(AtomicBool::new(false));
        let connected = Arc::new(AtomicBool::new(false));

        let handle = ServerClientHandle {
            outbox: outbox_tx,
            shutdown_tx,
            agent_id: self.agent_id.clone(),
            metadata: self.metadata.clone(),
            sync_needed: sync_needed.clone(),
            connected: connected.clone(),
        };

        // Spawn the supervisor; it owns the reconnect loop and never returns
        // until shutdown.
        tokio::spawn(async move {
            self.supervise(outbox_rx, shutdown_rx, interval_tx, sync_needed, connected)
                .await;
        });

        // Wait (briefly) for the first attempt to report its outcome. A refusal
        // is returned rather than turned into `Ok`: the supervisor runs in a
        // spawned task, so anything it swallows here is invisible to the
        // caller — which is how an agent could report a healthy connection
        // while the server was refusing every message it sent.
        match interval_rx.recv().await {
            Some(Ok(interval)) => Ok((handle, interval)),
            Some(Err(message)) => Err(anyhow::Error::new(RegistrationRejected(message))),
            // The supervisor stopped before reporting, which it does not do
            // except on shutdown. `Ok` matches what this returned before.
            None => Ok((handle, None)),
        }
    }

    /// Supervisor loop: connect → register → service → reconnect, forever.
    async fn supervise(
        self,
        mut outbox_rx: mpsc::UnboundedReceiver<WsMessage>,
        mut shutdown_rx: mpsc::Receiver<()>,
        interval_tx: mpsc::Sender<Result<Option<u64>, String>>,
        sync_needed: Arc<AtomicBool>,
        connected: Arc<AtomicBool>,
    ) {
        let mut reconnect_delay = INITIAL_RECONNECT_DELAY;
        let mut reported_interval = false;

        let this = Arc::new(self);

        loop {
            // Bail out immediately if shutdown was requested between attempts.
            if shutdown_rx.try_recv().is_ok() {
                info!("Server client shutting down before reconnect");
                return;
            }

            match this.connect_once().await {
                Ok((sink, stream, interval)) => {
                    info!("Connected to server successfully");
                    reconnect_delay = INITIAL_RECONNECT_DELAY;
                    connected.store(true, Ordering::SeqCst);

                    // Notify the SessionWatcher that a full re-sync is needed
                    // because the server-side session registry may be stale.
                    sync_needed.store(true, Ordering::SeqCst);

                    // Report the heartbeat interval from the first connection so
                    // connect_and_run can unblock.
                    if !reported_interval {
                        let _ = interval_tx.try_send(Ok(interval));
                        reported_interval = true;
                    }

                    // Service the live connection until it drops or shutdown.
                    let outcome = this
                        .clone()
                        .run_connection(sink, stream, &mut outbox_rx, &mut shutdown_rx)
                        .await;
                    // Connection dropped — mark as disconnected so the
                    // SessionWatcher pauses sending updates until reconnected.
                    connected.store(false, Ordering::SeqCst);
                    match outcome {
                        ConnectionOutcome::Shutdown => {
                            info!("Server client shut down");
                            return;
                        }
                        ConnectionOutcome::Disconnected => {
                            warn!("Disconnected from server; will reconnect");
                        }
                    }
                }
                Err(e) => {
                    // A refusal is permanent, so it must not be retried and it
                    // must not be swallowed. Stop, and hand the reason to
                    // whoever is waiting on the first attempt.
                    if let Some(rejected) = e.downcast_ref::<RegistrationRejected>() {
                        // No `reported_interval = true` here: this returns, so
                        // nothing would read it.
                        if !reported_interval {
                            let _ = interval_tx.try_send(Err(rejected.0.clone()));
                        }
                        warn!("{e}. Not reconnecting — this agent must be upgraded.");
                        return;
                    }

                    // Make sure connect_and_run doesn't block forever if the
                    // very first connection fails. `Ok(None)` rather than an
                    // error: a connection failure is transient and the loop
                    // below keeps trying.
                    if !reported_interval {
                        let _ = interval_tx.try_send(Ok(None));
                        reported_interval = true;
                    }
                    warn!(
                        "Failed to connect to server: {:#}. Reconnecting in {:?}",
                        e, reconnect_delay
                    );
                    tokio::select! {
                        _ = tokio::time::sleep(reconnect_delay) => {}
                        _ = shutdown_rx.recv() => {
                            info!("Server client shutting down during backoff");
                            return;
                        }
                    }
                    reconnect_delay = std::cmp::min(reconnect_delay * 2, MAX_RECONNECT_DELAY);
                }
            }
        }
    }

    /// Establish one connection and register. Returns the split sink/stream and
    /// the heartbeat interval the server advertised (if any).
    async fn connect_once(&self) -> Result<(WsSink, WsStreamHalf, Option<u64>)> {
        info!("Connecting to server at {}", self.server_url);

        let (ws_stream, _) = connect_async(&self.server_url)
            .await
            .context("failed to connect to server")?;

        let (mut sink, mut stream) = ws_stream.split();

        // Send registration.
        let payload = AgentRegisterPayload {
            agent_id: self.agent_id.clone(),
            hostname: self.hostname.clone(),
            ip_address: self.ip_address.clone(),
            port: self.port,
            auth_token: self.auth_token.clone(),
            metadata: self.metadata.clone(),
            display_name: self.display_name.clone(),
            connect_url: self.connect_url.clone(),
            addresses: self.addresses.clone(),
            // Derived from the providers this agent actually composed.
            //
            // `None` when it composed none, and the server now **refuses** that
            // (`#678` is a breaking upgrade): a peer it cannot route for does
            // not connect. A real agent always composes at least one provider —
            // `main.rs` builds a non-empty list — so this maps to `Some` on
            // every path that ships. It stays an `Option` on the wire so an old
            // agent gets a clear rejection rather than a parse error.
            protocol_manifest: self
                .extension_registry
                .as_ref()
                .map(|registry| registry.manifest().clone()),
        };
        let msg = new_message(msg_types::AGENT_REGISTER, payload);
        let json = serde_json::to_string(&msg)?;
        sink.send(WsMessage::Text(json))
            .await
            .context("failed to send registration message")?;
        info!("Sent registration message for agent {}", self.agent_id);

        // Wait for the registration response so we can learn the heartbeat
        // interval and confirm acceptance before reporting "connected".
        let interval;
        loop {
            match stream.next().await {
                Some(Ok(WsMessage::Text(text))) => {
                    let resp: ProtocolMessage<serde_json::Value> = serde_json::from_str(&text)
                        .context("failed to parse registration response")?;
                    // The acceptance arrives under the wire this agent sent,
                    // which is what makes the name enough here: nothing else
                    // sends `server.agent.register` to an agent.
                    if resp.msg_type == msg_types::AGENT_REGISTER {
                        let payload: RegisterResponsePayload =
                            serde_json::from_value(resp.payload)?;
                        if payload.status == "accepted" {
                            info!(
                                "Agent {} registration accepted: {}",
                                self.agent_id, payload.message
                            );
                            interval = payload.heartbeat_interval_secs;
                            break;
                        } else {
                            return Err(anyhow::Error::new(RegistrationRejected(payload.message)));
                        }
                    }
                    // Ignore any other message arriving before the response.
                }
                Some(Ok(WsMessage::Ping(data))) => {
                    sink.send(WsMessage::Pong(data)).await.ok();
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => {
                    return Err(
                        anyhow::Error::from(e).context("error awaiting registration response")
                    )
                }
                None => anyhow::bail!("connection closed before registration response"),
            }
        }

        Ok((sink, stream, interval))
    }

    /// Service a live connection until it drops or shutdown.
    ///
    /// This half is the **writer**: it owns the socket, drains the outbox
    /// (heartbeats, session updates) and the response channel onto it, and
    /// watches for shutdown. The reading half — and everything a frame's
    /// dispatch can park on — is [`Self::read_loop`], on a task of its own, for
    /// the reason this module's docs give.
    ///
    /// Returns whether the loop ended due to shutdown or a dropped connection.
    async fn run_connection(
        self: Arc<Self>,
        mut sink: WsSink,
        stream: WsStreamHalf,
        outbox_rx: &mut mpsc::UnboundedReceiver<WsMessage>,
        shutdown_rx: &mut mpsc::Receiver<()>,
    ) -> ConnectionOutcome {
        // Handler tasks write their responses here; this half drains them onto
        // the socket.
        //
        // Bounded, with the policy of #961's backpressure section: a full queue
        // makes the *handler* wait, never lose its answer. The handler is one
        // of the read half's lane tasks — a bounded number of them, see
        // `connection::execution` — so parking it costs a lane slot rather than
        // a detached task per message, and this loop keeps writing throughout.
        //
        // The producer side is what the old comment here was protecting, and the
        // bound is chosen to keep protecting it: `AGENT_RESPONSE_QUEUE_SLOTS`
        // replies of a few hundred bytes are the ordinary case, and a burst of
        // those never parks anybody. What is *gone* is the case the unbounded
        // channel actually existed for — an agent whose Server stopped reading
        // growing its heap for as long as the Server stayed away.
        let (resp_tx, mut resp_rx) = mpsc::channel::<WsMessage>(AGENT_RESPONSE_QUEUE_SLOTS);

        // The reading half, and the signal that says how it ended. A channel
        // rather than joining the handle here: the handle is only needed to
        // *stop* a reader that is parked, and a `JoinHandle` polled after it has
        // completed panics.
        let (read_done_tx, mut read_done_rx) = mpsc::channel::<ConnectionOutcome>(1);
        let reader = tokio::spawn(
            self.clone()
                .read_loop(stream, resp_tx.clone(), read_done_tx),
        );

        let outcome = loop {
            tokio::select! {
                // Outgoing: drain the outbox (heartbeats, session updates).
                outgoing = outbox_rx.recv() => {
                    match outgoing {
                        Some(msg) => {
                            if let Err(e) = sink.send(msg).await {
                                warn!("Failed to send to server: {:#}", e);
                                break ConnectionOutcome::Disconnected;
                            }
                        }
                        None => {
                            // Outbox closed: handle dropped, treat as shutdown.
                            break ConnectionOutcome::Shutdown;
                        }
                    }
                }
                // Command responses from the reading half's lanes.
                response = resp_rx.recv() => {
                    match response {
                        Some(msg) => {
                            if let Err(e) = sink.send(msg).await {
                                warn!("Failed to send to server: {:#}", e);
                                break ConnectionOutcome::Disconnected;
                            }
                        }
                        None => {
                            // Unreachable while this loop holds a `resp_tx` clone;
                            // kept as a defensive disconnect.
                            break ConnectionOutcome::Disconnected;
                        }
                    }
                }
                // The reading half ended: its stream closed, or a write to
                // `resp_tx` failed. Either way this connection is over.
                done = read_done_rx.recv() => {
                    break done.unwrap_or(ConnectionOutcome::Disconnected);
                }
                // Shutdown: close the socket and stop the supervisor.
                _ = shutdown_rx.recv() => {
                    info!("Shutdown signal received");
                    let _ = sink.send(WsMessage::Close(None)).await;
                    break ConnectionOutcome::Shutdown;
                }
            }
        };

        // Stop the reader, however this ended. It owns the lanes, and a reader
        // parked on a full key's queue would otherwise outlive the connection
        // that owns it — one leaked task per reconnect. Aborting is enough:
        // dropping the lanes drops their work, and `read_loop` is where the
        // lanes get the chance to end their own tasks in an orderly way when
        // the stream ends by itself.
        reader.abort();
        let _ = reader.await;
        outcome
    }

    /// Read this connection's frames and dispatch them, until the stream ends.
    ///
    /// The reading half of a live connection, and the only half that may park:
    /// a lane at its bound is enforced by the reader not reading, which is the
    /// bound `#961` asks for. It never writes to the socket — answers go to
    /// `responses`, which `run_connection` drains.
    ///
    /// The split is what keeps the two regressions this stage exists around
    /// from being traded for one another: dispatch is bounded, and the heartbeat
    /// still flows, because the task that sends heartbeats is not this one.
    async fn read_loop(
        self: Arc<Self>,
        mut stream: WsStreamHalf,
        responses: mpsc::Sender<WsMessage>,
        done: mpsc::Sender<ConnectionOutcome>,
    ) {
        // The lanes this connection reads into, and the only thing that admits
        // to them. Dropped with the loop, which is what ends their tasks.
        let mut lanes = Lanes::with_key_worker_budget(
            execution::DEFAULT_QUERY_CONCURRENCY,
            execution::DEFAULT_KEY_QUEUE_DEPTH,
            execution::DEFAULT_KEY_WORKERS,
            execution::LANE_LABEL,
        );

        let outcome = loop {
            match stream.next().await {
                Some(Ok(WsMessage::Text(text))) => {
                    // Decoded here rather than in the task that serves it,
                    // because the unit's execution policy is read from the
                    // envelope and the dispatch decision comes first. A frame
                    // that does not decode is ignored and logged, which is what
                    // it was before: the parse used to happen inside the
                    // per-message task, and its failure was logged there.
                    let msg: ProtocolMessage<serde_json::Value> = match serde_json::from_str(&text)
                    {
                        Ok(msg) => msg,
                        Err(e) => {
                            warn!("Error handling server message: {:#}", e);
                            continue;
                        }
                    };

                    let policy = match core_policy(&msg) {
                        Some(policy) => policy,
                        // Not a unit this connection serves. Control is not an
                        // operation and not a request anybody is waiting on —
                        // its whole handler is a log line — so it is applied
                        // where it stands. See `is_control`.
                        None if is_control(&msg.msg_type) => Inline,
                        // Everything else is an extension's own command unit:
                        // a request the Server is waiting for an answer to,
                        // whose handler does backend I/O. See
                        // `execution::UNSERVED`.
                        None => execution::UNSERVED,
                    };

                    let this = Arc::clone(&self);
                    let tx = responses.clone();
                    let work: Work = Box::pin(async move {
                        if let Err(e) = this.handle_server_message(msg, &tx).await {
                            warn!("Error handling server message: {:#}", e);
                        }
                    });

                    match policy {
                        Inline => work.await,
                        Query => lanes.query(work).await,
                        Key(key) => lanes.key(key, work).await,
                    }
                }
                Some(Ok(WsMessage::Ping(data))) => {
                    // The pong is handed to the writing half rather than
                    // written here, because the socket has one owner and this
                    // is not it. It rides the response channel, which in
                    // ordinary operation is empty — a full one means the
                    // Server is not draining, and a pong it is not reading
                    // would not have kept the connection alive either.
                    if responses.send(WsMessage::Pong(data)).await.is_err() {
                        break ConnectionOutcome::Disconnected;
                    }
                }
                Some(Ok(WsMessage::Close(_))) => {
                    info!("Server closed connection");
                    break ConnectionOutcome::Disconnected;
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => {
                    error!("WebSocket error: {:#}", e);
                    break ConnectionOutcome::Disconnected;
                }
                None => {
                    info!("WebSocket stream ended");
                    break ConnectionOutcome::Disconnected;
                }
            }
        };

        // End the lanes' work before saying the connection is over. It belongs
        // to a Server that is gone — or to a connection this agent is closing —
        // and a mutation parked on a resource nobody is waiting for any more
        // must not write to a socket that is closing. Queued work that never
        // started is dropped with the lane.
        lanes.shutdown(SHUTDOWN_GRACE).await;

        // What this connection's bounds ever did, read by something that is not
        // a test — `#961`'s "metrics/logging can observe queue saturation,
        // in-flight count, per-key queue depth". The lane's own saturation
        // events say *when* a bound was reached and which key reached it; this
        // says how far the connection ever got.
        {
            let (queries, keys) = lanes.snapshot().await;
            debug!(
                "central connection closed — lanes: {}",
                nession_runtime::lane::summary(&queries, &keys)
            );
        }

        let _ = done.send(outcome).await;
    }

    /// Handle one message received from the server, writing any response to the
    /// `responses` queue (drained onto the socket by [`Self::run_connection`]).
    ///
    /// Takes the message **decoded**, because its execution policy — which lane
    /// it is dispatched on, and therefore which task calls this at all — is read
    /// from the envelope before the dispatch decision is made. See
    /// [`Self::read_loop`].
    ///
    /// `responses` is bounded, so a send here can wait for room — which is the
    /// intended policy rather than a hazard: this method runs on a lane task,
    /// and waiting costs a lane slot rather than a detached task per message.
    /// See the queue's construction in [`Self::run_connection`].
    async fn handle_server_message(
        &self,
        msg: ProtocolMessage<serde_json::Value>,
        responses: &mpsc::Sender<WsMessage>,
    ) -> Result<()> {
        // Extension dispatch first, decided by the registry rather than by the
        // message type's spelling.
        //
        // This used to read `msg.msg_type.starts_with("extension.")`, which was
        // correct while wires carried an `extension.*` namespace. `#912` deleted
        // that namespace — the wire *is* the protocol id now — and left this
        // gate behind, so every relayed extension call (`git.status`,
        // `claude-code.read`) failed the prefix test, failed `CORE_WIRES`, and
        // was swallowed by the control match below: nothing logged, nothing
        // answered, and the server's `agent_command` timing out ten seconds
        // later.
        //
        // The registry's own `Option` is the gate. `routes` is built from the
        // extension half only (`extension.rs` collision-checks the core half
        // without inserting it), so a core or control wire returns `None` here
        // and falls through exactly as before. Re-testing the spelling as well
        // would be a second copy of a rule the routes already own, and two
        // copies are what let them disagree.
        if let Some(ref ext_registry) = self.extension_registry {
            if let Some(result) = ext_registry
                .dispatch(&msg.msg_type, msg.payload.clone())
                .await
            {
                let payload_value = match result {
                    Ok(value) => value,
                    Err(e) => {
                        warn!("Extension handler error: {:#}", e);
                        serde_json::json!({
                            "error": e.to_string(),
                            "available": false,
                        })
                    }
                };

                let response = serde_json::json!({
                    "msg_type": "server.agent.command-response",
                    "id": uuid::Uuid::new_v4().to_string(),
                    "timestamp": chrono::Utc::now().timestamp().unsigned_abs(),
                    "payload": {
                        "request_id": msg.payload.get("request_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or(""),
                        "command": msg.msg_type,
                        "result": payload_value,
                    }
                });
                responses
                    .send(WsMessage::Text(response.to_string()))
                    .await?;
                return Ok(());
            }
        }
        // One list, not two: `CORE_WIRES` and `dispatch_core` are generated
        // from the same `core_routes!` invocation, so a unit cannot be
        // advertised without a handler or handled without being advertised.
        if CORE_WIRES.contains(&msg.msg_type.as_str()) {
            return dispatch_core(self, &msg, responses).await;
        }
        // Control wires, handled beside the route table rather than in it:
        // `core_routes!` emits a descriptor per arm and control wires are not
        // units — nothing offers one, because a control message is not
        // something a caller asks *this* peer for, it is something every peer
        // must handle.
        //
        // All three arms are here, including the two this runtime has no
        // sender for: control is symmetric, so each runtime handles every
        // control wire whether or not today's senders reach it, and
        // `scripts/protocol-gate.mjs` holds every runtime to that. The arm for
        // `control.pong` used to be this loop's `server.heartbeat.ack` arm —
        // the ack is gone, because control has no acknowledgement, and what
        // arrives here is now a message a peer sent on its own initiative.
        match msg.msg_type.as_str() {
            msg_types::AGENT_REGISTER => {
                // Already handled during connect; log late/duplicate responses.
                debug!("Late registration response ignored");
            }
            msg_types::CONTROL_HEARTBEAT => {
                // An agent does not receive its own heartbeat; the arm is the
                // symmetry above, not a path a sender takes today.
                debug!("control.heartbeat received");
            }
            msg_types::CONTROL_PING => {
                debug!("control.ping received");
            }
            msg_types::CONTROL_PONG => {
                debug!("control.pong received");
            }
            _ => {}
        }

        Ok(())
    }
}

/// The server refused this agent's registration (`#678`).
///
/// Its own type, not an `anyhow` message, because it is a different *kind* of
/// failure from a connection error and the supervisor has to tell them apart:
///
/// - A connection error is **transient** — the server is down, the network
///   blipped — and retrying is exactly right.
/// - A refusal is **permanent**. The server routes only by manifest, this agent
///   has none, and reconnecting will be refused identically. Retrying forever
///   would bury the one line that says why in a stream of reconnect warnings.
///
/// It also has to reach the caller. The supervisor runs in a spawned task, so
/// before this existed a refusal left `connect_and_run` returning `Ok` — an
/// agent that logged "Connected to central server" while every message it sent
/// went nowhere. That is the failure `#678` exists to make impossible, and
/// refusing without saying so would have been a new instance of it.
#[derive(Debug, thiserror::Error)]
#[error("registration rejected by server: {0}")]
pub struct RegistrationRejected(pub String);

/// Why [`ServerClient::run_connection`] returned.
enum ConnectionOutcome {
    /// Shutdown was requested (or the handle was dropped).
    Shutdown,
    /// The connection dropped; the supervisor should reconnect.
    Disconnected,
}

/// Helper function to create a new message with a unique ID and timestamp.
fn new_message<P: Serialize>(msg_type: &str, payload: P) -> ProtocolMessage<P> {
    Message {
        msg_type: msg_type.to_string(),
        id: uuid::Uuid::new_v4().to_string(),
        timestamp: chrono::Utc::now().timestamp().unsigned_abs(),
        payload,
    }
}

/// Extract a string field from a JSON payload, defaulting to empty.
fn str_field(payload: &serde_json::Value, key: &str) -> String {
    payload
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// List env file refs currently sourced on any tmux session.
///
/// Returns the tracked EnvFileRef information from sourced_envs map.
/// If no files are tracked, returns an empty list.
impl ServerClient {
    fn get_sourced_env_files(&self) -> Vec<EnvFileRef> {
        if let Ok(sourced) = self.sourced_envs.lock() {
            sourced.values().flatten().cloned().collect()
        } else {
            vec![]
        }
    }
}

/// Flatten multiple env-file snapshots into a single ordered variable list.
///
/// Files are applied in order; within the merged result the last occurrence of
/// a key wins (later files override earlier ones), while first-seen position is
/// preserved for stable ordering.
fn flatten_snapshots(snapshots: &[EnvSnapshot]) -> Vec<(String, String)> {
    let mut vars: Vec<(String, String)> = Vec::new();
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for snap in snapshots {
        for (key, value) in &snap.vars {
            if let Some(slot) = index.get(key).and_then(|&i| vars.get_mut(i)) {
                slot.1 = value.clone();
            } else {
                index.insert(key.clone(), vars.len());
                vars.push((key.clone(), value.clone()));
            }
        }
    }
    vars
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestSession;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    /// Start a mock WebSocket server that accepts connections and echoes messages.
    /// Ask the OS for a free port, then release it.
    ///
    /// For tests that must point the client at an address where nothing is
    /// listening. Re-use of the number is a small race against the rest of the
    /// machine, but far better than a hardcoded port that races every
    /// concurrent test run.
    async fn free_port() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("failed to reserve a port");
        let port = listener.local_addr().expect("local_addr").port();
        drop(listener);
        port
    }

    async fn start_mock_server() -> (
        std::net::SocketAddr,
        tokio::task::JoinHandle<()>,
        mpsc::Receiver<String>,
    ) {
        let (msg_tx, msg_rx) = mpsc::channel(100);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("failed to bind mock server");
        let addr = listener.local_addr().expect("mock server local_addr");

        let handle = tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                let ws = accept_async(stream).await.expect("failed to accept ws");
                let (mut sink, mut stream) = ws.split();

                // Send a registration response.
                let response = serde_json::json!({
                    "msg_type": "server.agent.register",
                    "id": "test-id",
                    "timestamp": 1234567890,
                    "payload": {
                        "status": "accepted",
                        "message": "Registration successful"
                    }
                });
                let _ = sink.send(WsMessage::Text(response.to_string())).await;

                // Echo messages back and forward them to the receiver.
                while let Some(Ok(msg)) = stream.next().await {
                    if let WsMessage::Text(text) = msg {
                        let _ = msg_tx.send(text.clone()).await;
                        // Echo back.
                        let _ = sink.send(WsMessage::Text(text)).await;
                    }
                }
            }
        });

        (addr, handle, msg_rx)
    }

    #[tokio::test]
    async fn test_connection_and_registration() {
        let (addr, server_handle, mut msg_rx) = start_mock_server().await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let metadata = AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
            image_tag: "test".to_string(),
        };

        let client = ServerClient::new(
            format!("ws://{addr}"),
            "test-token",
            "test-agent-1",
            "test-host",
            "127.0.0.1",
            8080,
            None,   // connect_url
            vec![], // addresses
            None,   // display_name
            metadata,
            Arc::new(SessionManager::new()),
            "/tmp".to_string(),
            None,
        );

        let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

        // Wait for registration message.
        let msg = tokio::time::timeout(Duration::from_secs(5), msg_rx.recv())
            .await
            .expect("timeout waiting for registration")
            .expect("no message received");

        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(parsed["msg_type"], "server.agent.register");
        assert_eq!(parsed["payload"]["agent_id"], "test-agent-1");
        assert_eq!(parsed["payload"]["hostname"], "test-host");
        assert_eq!(parsed["payload"]["port"], 8080);

        handle.shutdown().await.ok();
        server_handle.abort();
    }

    #[tokio::test]
    async fn test_heartbeat_message_format() {
        let (addr, server_handle, mut msg_rx) = start_mock_server().await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let metadata = AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
            image_tag: "test".to_string(),
        };

        let client = ServerClient::new(
            format!("ws://{addr}"),
            "test-token",
            "test-agent-2",
            "test-host",
            "127.0.0.1",
            8080,
            None,   // connect_url
            vec![], // addresses
            None,   // display_name
            metadata,
            Arc::new(SessionManager::new()),
            "/tmp".to_string(),
            None,
        );

        let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

        // Skip registration message.
        let _ = msg_rx.recv().await;

        // Send heartbeat.
        handle
            .send_heartbeat(AgentStatus::Online, 5, 2, 3600, [1.0, 2.0, 3.0])
            .await
            .expect("heartbeat failed");

        let msg = tokio::time::timeout(Duration::from_secs(5), msg_rx.recv())
            .await
            .expect("timeout waiting for heartbeat")
            .expect("no message received");

        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(parsed["msg_type"], "control.heartbeat");
        assert_eq!(parsed["payload"]["agent_id"], "test-agent-2");
        assert_eq!(parsed["payload"]["status"], "online");
        assert_eq!(parsed["payload"]["session_count"], 5);
        assert_eq!(parsed["payload"]["active_sessions"], 2);
        assert_eq!(parsed["payload"]["metadata"]["uptime_seconds"], 3600);

        handle.shutdown().await.ok();
        server_handle.abort();
    }

    #[tokio::test]
    async fn test_session_update_message_format() {
        let (addr, server_handle, mut msg_rx) = start_mock_server().await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let metadata = AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
            image_tag: "test".to_string(),
        };

        let client = ServerClient::new(
            format!("ws://{addr}"),
            "test-token",
            "test-agent-3",
            "test-host",
            "127.0.0.1",
            8080,
            None,   // connect_url
            vec![], // addresses
            None,   // display_name
            metadata,
            Arc::new(SessionManager::new()),
            "/tmp".to_string(),
            None,
        );

        let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

        // Skip registration message.
        let _ = msg_rx.recv().await;

        // Send session update.
        handle
            .send_session_update("test-session", "active", 3, 1, Some("claude"))
            .await
            .expect("session update failed");

        let msg = tokio::time::timeout(Duration::from_secs(5), msg_rx.recv())
            .await
            .expect("timeout waiting for session update")
            .expect("no message received");

        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(parsed["msg_type"], "server.agent.session-update");
        assert_eq!(parsed["payload"]["agent_id"], "test-agent-3");
        assert_eq!(parsed["payload"]["session_name"], "test-session");
        assert_eq!(parsed["payload"]["status"], "active");
        assert_eq!(parsed["payload"]["window_count"], 3);
        assert_eq!(parsed["payload"]["attached_clients"], 1);

        handle.shutdown().await.ok();
        server_handle.abort();
    }

    /// Mock server that advertises a heartbeat interval in its register
    /// response, then (after `accepts` connections) stays idle.
    async fn start_mock_server_with_interval(
        interval_secs: u64,
    ) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("failed to bind mock server");
        let addr = listener.local_addr().expect("mock server local_addr");
        let handle = tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                let ws = accept_async(stream).await.expect("failed to accept ws");
                let (mut sink, mut stream) = ws.split();
                let response = serde_json::json!({
                    "msg_type": "server.agent.register",
                    "id": "test-id",
                    "timestamp": 1234567890,
                    "payload": {
                        "status": "accepted",
                        "message": "ok",
                        "heartbeat_interval_secs": interval_secs
                    }
                });
                let _ = sink.send(WsMessage::Text(response.to_string())).await;
                while let Some(Ok(_)) = stream.next().await {}
            }
        });
        (addr, handle)
    }

    #[tokio::test]
    async fn test_register_response_conveys_heartbeat_interval() {
        let (addr, server_handle) = start_mock_server_with_interval(42).await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let metadata = AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
            image_tag: "test".to_string(),
        };
        let client = ServerClient::new(
            format!("ws://{addr}"),
            "test-token",
            "test-agent-iv",
            "test-host",
            "127.0.0.1",
            8080,
            None,   // connect_url
            vec![], // addresses
            None,   // display_name
            metadata,
            Arc::new(SessionManager::new()),
            "/tmp".to_string(),
            None,
        );

        let (handle, interval) = client.connect_and_run().await.expect("connect failed");
        assert_eq!(interval, Some(42));

        handle.shutdown().await.ok();
        server_handle.abort();
    }

    #[tokio::test]
    async fn test_supervisor_reconnects_after_drop() {
        // Server that accepts a first connection, registers, then drops it;
        // accepts a second connection and forwards the agent_id of whatever it
        // receives so the test can confirm a re-registration happened.
        let (re_tx, mut re_rx) = mpsc::channel::<String>(4);
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("mock server local_addr");
        let server_handle = tokio::spawn(async move {
            for round in 0..2u32 {
                if let Ok((stream, _)) = listener.accept().await {
                    let ws = accept_async(stream).await.expect("accept ws");
                    let (mut sink, mut stream) = ws.split();
                    let response = serde_json::json!({
                        "msg_type": "server.agent.register",
                        "id": "test-id",
                        "timestamp": 1,
                        "payload": { "status": "accepted", "message": "ok" }
                    });
                    let _ = sink.send(WsMessage::Text(response.to_string())).await;

                    // Read the register message and report it.
                    if let Some(Ok(WsMessage::Text(text))) = stream.next().await {
                        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
                        if parsed["msg_type"] == "server.agent.register" {
                            let _ = re_tx
                                .send(
                                    parsed["payload"]["agent_id"]
                                        .as_str()
                                        .unwrap_or("")
                                        .to_string(),
                                )
                                .await;
                        }
                    }

                    // On the first round, drop the connection to force a reconnect.
                    if round == 0 {
                        drop(sink);
                        drop(stream);
                    } else {
                        while let Some(Ok(_)) = stream.next().await {}
                    }
                }
            }
        });
        tokio::time::sleep(Duration::from_millis(100)).await;

        let metadata = AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
            image_tag: "test".to_string(),
        };
        let client = ServerClient::new(
            format!("ws://{addr}"),
            "test-token",
            "reconnect-agent",
            "test-host",
            "127.0.0.1",
            8080,
            None,   // connect_url
            vec![], // addresses
            None,   // display_name
            metadata,
            Arc::new(SessionManager::new()),
            "/tmp".to_string(),
            None,
        );
        let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

        // First registration.
        let first = tokio::time::timeout(Duration::from_secs(5), re_rx.recv())
            .await
            .expect("timeout on first register")
            .expect("no first register");
        assert_eq!(first, "reconnect-agent");

        // After the server drops the connection, the supervisor should
        // reconnect and re-register within the backoff window.
        let second = tokio::time::timeout(Duration::from_secs(5), re_rx.recv())
            .await
            .expect("timeout on re-register (supervisor did not reconnect)")
            .expect("no second register");
        assert_eq!(second, "reconnect-agent");

        handle.shutdown().await.ok();
        server_handle.abort();
    }

    /// Mock server that sends a session create command after registration.
    async fn start_mock_server_with_session_create(
        session_name: String,
    ) -> (
        std::net::SocketAddr,
        tokio::task::JoinHandle<()>,
        mpsc::Receiver<String>,
    ) {
        let (msg_tx, msg_rx) = mpsc::channel(100);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("failed to bind mock server");
        let addr = listener.local_addr().expect("mock server local_addr");

        let handle = tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                let ws = accept_async(stream).await.expect("failed to accept ws");
                let (mut sink, mut stream) = ws.split();

                // Send registration response.
                let response = serde_json::json!({
                    "msg_type": "server.agent.register",
                    "id": "test-id",
                    "timestamp": 1234567890,
                    "payload": {
                        "status": "accepted",
                        "message": "ok"
                    }
                });
                let _ = sink.send(WsMessage::Text(response.to_string())).await;

                // Skip registration message from client.
                let _ = stream.next().await;

                // Send session create command.
                let create_cmd = serde_json::json!({
                    "msg_type": "agent.session.create",
                    "id": "cmd-1",
                    "timestamp": 1234567891,
                    "payload": {
                        "request_id": "req-123",
                        "name": session_name,
                        "width": 100,
                        "height": 30
                    }
                });
                let _ = sink.send(WsMessage::Text(create_cmd.to_string())).await;

                // Collect response.
                while let Some(Ok(msg)) = stream.next().await {
                    if let WsMessage::Text(text) = msg {
                        let _ = msg_tx.send(text.clone()).await;
                    }
                }
            }
        });

        (addr, handle, msg_rx)
    }

    #[tokio::test]
    async fn test_server_session_create_command() {
        let session = TestSession::new("server-create");
        let session_name = session.name().to_string();

        let (addr, server_handle, mut msg_rx) =
            start_mock_server_with_session_create(session_name.clone()).await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let metadata = AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
            image_tag: "test".to_string(),
        };

        let client = ServerClient::new(
            format!("ws://{addr}"),
            "test-token",
            "test-agent-create",
            "test-host",
            "127.0.0.1",
            8080,
            None,
            vec![], // addresses
            None,   // display_name
            metadata,
            Arc::new(SessionManager::new()),
            "/tmp".to_string(),
            None,
        );

        let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

        // Wait for the command response.
        let msg = tokio::time::timeout(Duration::from_secs(5), msg_rx.recv())
            .await
            .expect("timeout waiting for command response")
            .expect("no message received");

        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(parsed["msg_type"], "server.agent.command-response");
        assert_eq!(parsed["payload"]["request_id"], "req-123");
        assert_eq!(parsed["payload"]["command"], "session.create");
        assert_eq!(parsed["payload"]["success"], true);
        assert_eq!(parsed["payload"]["session_name"], session_name.as_str());

        // Clean up the created session.
        let tmux = SessionManager::new();
        let _ = tmux.kill_session(&session_name).await;

        handle.shutdown().await.ok();
        server_handle.abort();
    }

    /// Mock server that sends a session kill command after registration.
    async fn start_mock_server_with_session_kill(
        session_name: String,
    ) -> (
        std::net::SocketAddr,
        tokio::task::JoinHandle<()>,
        mpsc::Receiver<String>,
    ) {
        let (msg_tx, msg_rx) = mpsc::channel(100);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("failed to bind mock server");
        let addr = listener.local_addr().expect("mock server local_addr");

        let handle = tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                let ws = accept_async(stream).await.expect("failed to accept ws");
                let (mut sink, mut stream) = ws.split();

                // Send registration response.
                let response = serde_json::json!({
                    "msg_type": "server.agent.register",
                    "id": "test-id",
                    "timestamp": 1234567890,
                    "payload": {
                        "status": "accepted",
                        "message": "ok"
                    }
                });
                let _ = sink.send(WsMessage::Text(response.to_string())).await;

                // Skip registration message from client.
                let _ = stream.next().await;

                // First create a session to kill.
                let tmux = SessionManager::new();
                let _ = tmux
                    .create_session(&session_name, 80, 24, "/tmp", &[])
                    .await;

                // Send session kill command.
                let kill_cmd = serde_json::json!({
                    "msg_type": "agent.session.kill",
                    "id": "cmd-2",
                    "timestamp": 1234567892,
                    "payload": {
                        "request_id": "req-456",
                        "name": session_name,
                    }
                });
                let _ = sink.send(WsMessage::Text(kill_cmd.to_string())).await;

                // Collect response.
                while let Some(Ok(msg)) = stream.next().await {
                    if let WsMessage::Text(text) = msg {
                        let _ = msg_tx.send(text.clone()).await;
                    }
                }
            }
        });

        (addr, handle, msg_rx)
    }

    #[tokio::test]
    async fn test_server_session_kill_command() {
        let session = TestSession::new("server-kill");
        let session_name = session.name().to_string();
        let (addr, server_handle, mut msg_rx) =
            start_mock_server_with_session_kill(session_name.clone()).await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let metadata = AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
            image_tag: "test".to_string(),
        };

        let client = ServerClient::new(
            format!("ws://{addr}"),
            "test-token",
            "test-agent-kill",
            "test-host",
            "127.0.0.1",
            8080,
            None,
            vec![], // addresses
            None,   // display_name
            metadata,
            Arc::new(SessionManager::new()),
            "/tmp".to_string(),
            None,
        );

        let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

        // Wait for the command response.
        let msg = tokio::time::timeout(Duration::from_secs(5), msg_rx.recv())
            .await
            .expect("timeout waiting for command response")
            .expect("no message received");

        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(parsed["msg_type"], "server.agent.command-response");
        assert_eq!(parsed["payload"]["request_id"], "req-456");
        assert_eq!(parsed["payload"]["command"], "session.kill");
        assert_eq!(parsed["payload"]["success"], true);

        handle.shutdown().await.ok();
        server_handle.abort();
    }

    /// Mock server that sends an unsolicited control wire after registration.
    async fn start_mock_server_with_a_control_wire() -> (
        std::net::SocketAddr,
        tokio::task::JoinHandle<()>,
        mpsc::Receiver<String>,
    ) {
        let (_msg_tx, msg_rx) = mpsc::channel(100);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("failed to bind mock server");
        let addr = listener.local_addr().expect("mock server local_addr");

        let handle = tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                let ws = accept_async(stream).await.expect("failed to accept ws");
                let (mut sink, mut stream) = ws.split();

                // Send registration response.
                let response = serde_json::json!({
                    "msg_type": "server.agent.register",
                    "id": "test-id",
                    "timestamp": 1234567890,
                    "payload": {
                        "status": "accepted",
                        "message": "ok"
                    }
                });
                let _ = sink.send(WsMessage::Text(response.to_string())).await;

                // Skip registration message from client.
                let _ = stream.next().await;

                // Send a control wire, unprompted. This used to be the
                // heartbeat acknowledgement (`server.heartbeat.ack`), which the
                // server sent on every heartbeat; control has no
                // acknowledgement, so what the mock exercises now is the
                // category's other half — a control message arriving at a
                // runtime that has no sender for it, which every runtime has to
                // handle anyway.
                let pong = serde_json::json!({
                    "msg_type": "control.pong",
                    "id": "ctl-1",
                    "timestamp": 1234567893,
                    "payload": {}
                });
                let _ = sink.send(WsMessage::Text(pong.to_string())).await;

                // Keep connection alive.
                while let Some(Ok(_)) = stream.next().await {}
            }
        });

        (addr, handle, msg_rx)
    }

    #[tokio::test]
    async fn a_control_wire_the_agent_sent_nothing_for_is_handled_rather_than_refused() {
        let (addr, server_handle, _msg_rx) = start_mock_server_with_a_control_wire().await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let metadata = AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
            image_tag: "test".to_string(),
        };

        let client = ServerClient::new(
            format!("ws://{addr}"),
            "test-token",
            "test-agent-control",
            "test-host",
            "127.0.0.1",
            8080,
            None,
            vec![], // addresses
            None,   // display_name
            metadata,
            Arc::new(SessionManager::new()),
            "/tmp".to_string(),
            None,
        );

        let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

        // Just verify the connection stays alive — the control arm handled the
        // frame, and an unhandled wire would be ignored by the same loop, so
        // what this pins is that the arm exists and does not break the loop.
        tokio::time::sleep(Duration::from_millis(200)).await;

        handle.shutdown().await.ok();
        server_handle.abort();
    }

    /// An extension that declares exactly one wire and answers recognisably.
    struct DeclaredExtension {
        name: &'static str,
        id: &'static str,
        wire: &'static str,
    }

    #[async_trait::async_trait]
    impl nession_common::extension::AgentExtension for DeclaredExtension {
        fn name(&self) -> &'static str {
            self.name
        }

        fn descriptors(
            &self,
        ) -> Result<Vec<nession_protocol::ProtocolDescriptor>, nession_protocol::IdentityError>
        {
            Ok(vec![nession_protocol::ProtocolDescriptor::new(
                self.id,
                "test",
                vec![nession_protocol::ContractDescriptor::new(
                    nession_protocol::ContractVersion::V1,
                    &[self.wire],
                )],
            )?])
        }

        async fn handle_command(
            &self,
            command: &str,
            _payload: serde_json::Value,
        ) -> anyhow::Result<serde_json::Value> {
            Ok(serde_json::json!({ "answered": command }))
        }
    }

    /// Accept one connection, register it, then push `wire` as a command.
    async fn start_mock_server_pushing_a_wire(
        wire: &'static str,
    ) -> (
        std::net::SocketAddr,
        tokio::task::JoinHandle<()>,
        mpsc::Receiver<String>,
    ) {
        let (msg_tx, msg_rx) = mpsc::channel(100);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("failed to bind mock server");
        let addr = listener.local_addr().expect("mock server local_addr");

        let handle = tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                let ws = accept_async(stream).await.expect("failed to accept ws");
                let (mut sink, mut stream) = ws.split();

                let response = serde_json::json!({
                    "msg_type": "server.agent.register",
                    "id": "test-id",
                    "timestamp": 1234567890,
                    "payload": { "status": "accepted", "message": "ok" }
                });
                let _ = sink.send(WsMessage::Text(response.to_string())).await;

                // Skip the registration message from the client.
                let _ = stream.next().await;

                // The relay's shape, verbatim: `command_broker` puts the
                // caller's `msg_type` on the frame with no wrapper wire.
                let command = serde_json::json!({
                    "msg_type": wire,
                    "id": "cmd-1",
                    "timestamp": 1234567891,
                    "payload": { "request_id": "req-1", "session": "a:work" }
                });
                let _ = sink.send(WsMessage::Text(command.to_string())).await;

                // Forward what the agent sends back, which is how the test
                // observes the answer. Without this the response channel has no
                // writer and every assertion sees an empty list — a test that
                // fails for its own reasons and cannot tell a drop from a bug.
                while let Some(Ok(msg)) = stream.next().await {
                    if let WsMessage::Text(text) = msg {
                        let _ = msg_tx.send(text.clone()).await;
                    }
                }
            }
        });

        (addr, handle, msg_rx)
    }

    /// A `ServerClient` whose registry composes `extensions`, connected to `addr`.
    async fn client_with_extensions(
        addr: std::net::SocketAddr,
        agent_id: &str,
        extensions: Vec<Box<dyn nession_common::extension::AgentExtension>>,
    ) -> crate::connection::server_client::ServerClientHandle {
        let registry = Arc::new(
            ExtensionRegistry::new(agent_id.to_string(), extensions, Vec::new())
                .expect("the test's extensions compose"),
        );
        let client = ServerClient::new(
            format!("ws://{addr}"),
            "test-token",
            agent_id,
            "test-host",
            "127.0.0.1",
            8080,
            None,
            vec![],
            None,
            metadata_for_tests(),
            Arc::new(SessionManager::new()),
            "/tmp".to_string(),
            Some(registry),
        );
        client.connect_and_run().await.expect("connect failed").0
    }

    /// The regression this pins (`#912`).
    ///
    /// `d5e75793` deleted the `extension.` namespace from every wire — the wire
    /// *is* the protocol id now — and `handle_server_message` kept gating
    /// extension dispatch on `starts_with("extension.")`. So a relayed
    /// `git.status` failed the prefix test, failed `CORE_WIRES`, and was
    /// swallowed by the control match's `_ => {}`: no log, no reply, and the
    /// server's `agent_command` timing out ten seconds later.
    ///
    /// Nothing caught it because `ExtensionRegistry::dispatch` has exactly one
    /// production caller — inside that gate — while `extension.rs`'s own tests
    /// call `dispatch` *directly* and so never pass through the gate at all.
    #[tokio::test]
    async fn a_relayed_extension_wire_reaches_its_handler() {
        let (addr, server_handle, mut msg_rx) =
            start_mock_server_pushing_a_wire("git.status").await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let handle = client_with_extensions(
            addr,
            "test-agent-extension-wire",
            vec![Box::new(DeclaredExtension {
                name: "git",
                id: "git.status",
                wire: "git.status",
            })],
        )
        .await;

        let responses = responses_within(&mut msg_rx, Duration::from_secs(2)).await;
        assert_eq!(
            responses.len(),
            1,
            "a relayed `git.status` must be answered by the extension that \
             declared it; got {responses:#?}"
        );
        assert_eq!(responses[0]["payload"]["command"], "git.status");
        assert_eq!(responses[0]["payload"]["result"]["answered"], "git.status");
        assert_eq!(responses[0]["payload"]["request_id"], "req-1");

        handle.shutdown().await.ok();
        server_handle.abort();
    }

    /// The other half, and the reason the fix is a registry lookup rather than
    /// a wider string test: a wire no extension declared must still fall
    /// through. A gate that answered everything would be the same defect
    /// pointing the other way.
    #[tokio::test]
    async fn a_wire_no_extension_declared_is_not_dispatched() {
        let (addr, server_handle, mut msg_rx) =
            start_mock_server_pushing_a_wire("not.a.unit").await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let handle = client_with_extensions(
            addr,
            "test-agent-unknown-wire",
            vec![Box::new(DeclaredExtension {
                name: "git",
                id: "git.status",
                wire: "git.status",
            })],
        )
        .await;

        let responses = responses_within(&mut msg_rx, Duration::from_secs(1)).await;
        assert!(
            responses.is_empty(),
            "an undeclared wire must not be answered by an extension; got {responses:#?}"
        );

        handle.shutdown().await.ok();
        server_handle.abort();
    }

    // -----------------------------------------------------------------------
    // Unit tests for pure functions and handle methods
    // -----------------------------------------------------------------------

    #[test]
    fn flatten_snapshots_empty() {
        let result = flatten_snapshots(&[]);
        assert!(result.is_empty());
    }

    #[test]
    fn flatten_snapshots_single_snapshot() {
        let snapshots = vec![EnvSnapshot {
            name: "a.env".to_string(),
            source: nession_protocol::contracts::env::v1::EnvSource::Server,
            agent_id: None,
            vars: vec![("FOO".into(), "bar".into()), ("BAZ".into(), "qux".into())],
            warnings: vec![],
        }];
        let result = flatten_snapshots(&snapshots);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0], ("FOO".to_string(), "bar".to_string()));
        assert_eq!(result[1], ("BAZ".to_string(), "qux".to_string()));
    }

    #[test]
    fn flatten_snapshots_later_overrides_earlier() {
        let snapshots = vec![
            EnvSnapshot {
                name: "first.env".to_string(),
                source: nession_protocol::contracts::env::v1::EnvSource::Server,
                agent_id: None,
                vars: vec![
                    ("KEY".into(), "first_value".into()),
                    ("ONLY".into(), "1".into()),
                ],
                warnings: vec![],
            },
            EnvSnapshot {
                name: "second.env".to_string(),
                source: nession_protocol::contracts::env::v1::EnvSource::Server,
                agent_id: None,
                vars: vec![("KEY".into(), "second_value".into())],
                warnings: vec![],
            },
        ];
        let result = flatten_snapshots(&snapshots);
        // KEY should be overridden in place (position 0)
        assert_eq!(result.len(), 2);
        assert_eq!(result[0], ("KEY".to_string(), "second_value".to_string()));
        assert_eq!(result[1], ("ONLY".to_string(), "1".to_string()));
    }

    #[test]
    fn flatten_snapshots_preserves_insertion_order() {
        let snapshots = vec![
            EnvSnapshot {
                name: "a.env".to_string(),
                source: nession_protocol::contracts::env::v1::EnvSource::Server,
                agent_id: None,
                vars: vec![("B".into(), "1".into()), ("A".into(), "2".into())],
                warnings: vec![],
            },
            EnvSnapshot {
                name: "b.env".to_string(),
                source: nession_protocol::contracts::env::v1::EnvSource::Server,
                agent_id: None,
                vars: vec![("C".into(), "3".into())],
                warnings: vec![],
            },
        ];
        let result = flatten_snapshots(&snapshots);
        let keys: Vec<&str> = result.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, vec!["B", "A", "C"]);
    }

    #[test]
    fn str_field_extracts_string() {
        let value = serde_json::json!({"request_id": "abc", "name": "test"});
        assert_eq!(str_field(&value, "request_id"), "abc");
        assert_eq!(str_field(&value, "name"), "test");
    }

    #[test]
    fn str_field_missing_returns_empty() {
        let value = serde_json::json!({"other": "val"});
        assert_eq!(str_field(&value, "missing"), "");
    }

    #[test]
    fn str_field_non_string_returns_empty() {
        let value = serde_json::json!({"num": 42});
        assert_eq!(str_field(&value, "num"), "");
    }

    #[test]
    fn new_message_has_correct_type_and_payload() {
        // not-protocol: this test is about the envelope, not about any wire.
        let msg = new_message("test.type", serde_json::json!({"key": "value"}));
        assert_eq!(msg.msg_type, "test.type");
        assert_eq!(msg.payload, serde_json::json!({"key": "value"}));
        // ID should be a valid UUID string
        assert!(!msg.id.is_empty());
        assert!(uuid::Uuid::parse_str(&msg.id).is_ok());
        // Timestamp should be recent
        assert!(msg.timestamp > 0);
    }

    #[test]
    fn server_client_handle_sync_needed_flag() {
        let (outbox_tx, _outbox_rx) = mpsc::unbounded_channel();
        let (shutdown_tx, _shutdown_rx) = mpsc::channel(1);
        let handle = ServerClientHandle {
            outbox: outbox_tx,
            shutdown_tx,
            agent_id: "test".to_string(),
            sync_needed: Arc::new(AtomicBool::new(false)),
            metadata: AgentMetadata {
                tmux_version: String::new(),
                os_version: String::new(),
                nession_version: String::new(),
                image_tag: String::new(),
            },
            connected: Arc::new(AtomicBool::new(false)),
        };

        // Initially not sync needed
        assert!(!handle.take_sync_needed());

        // Mark and take
        handle.mark_sync_needed();
        assert!(handle.take_sync_needed());

        // Take clears the flag
        assert!(!handle.take_sync_needed());
    }

    #[test]
    fn server_client_handle_connected_flag() {
        let (outbox_tx, _outbox_rx) = mpsc::unbounded_channel();
        let (shutdown_tx, _shutdown_rx) = mpsc::channel(1);
        let handle = ServerClientHandle {
            outbox: outbox_tx,
            shutdown_tx,
            agent_id: "test".to_string(),
            metadata: AgentMetadata {
                tmux_version: String::new(),
                os_version: String::new(),
                nession_version: String::new(),
                image_tag: String::new(),
            },
            sync_needed: Arc::new(AtomicBool::new(false)),
            connected: Arc::new(AtomicBool::new(false)),
        };

        assert!(!handle.is_connected());

        handle.connected.store(true, Ordering::SeqCst);
        assert!(handle.is_connected());

        handle.connected.store(false, Ordering::SeqCst);
        assert!(!handle.is_connected());
    }

    #[tokio::test]
    async fn server_client_handle_enqueue_after_drop_fails() {
        let (outbox_tx, outbox_rx) = mpsc::unbounded_channel();
        let (shutdown_tx, _shutdown_rx) = mpsc::channel(1);
        let handle = ServerClientHandle {
            outbox: outbox_tx,
            shutdown_tx,
            agent_id: "test".to_string(),
            metadata: AgentMetadata {
                tmux_version: String::new(),
                os_version: String::new(),
                nession_version: String::new(),
                image_tag: String::new(),
            },
            sync_needed: Arc::new(AtomicBool::new(false)),
            connected: Arc::new(AtomicBool::new(false)),
        };

        // Drop the receiver so the channel is closed
        drop(outbox_rx);

        // Enqueue should fail because supervisor is gone.
        // not-protocol: this test is about the outbox, not about any wire.
        let msg = new_message("test", serde_json::json!({}));
        let result = handle.enqueue(&msg);
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn server_client_handle_send_terminal_resize() {
        let (outbox_tx, mut outbox_rx) = mpsc::unbounded_channel();
        let (shutdown_tx, _shutdown_rx) = mpsc::channel(1);
        let handle = ServerClientHandle {
            outbox: outbox_tx,
            shutdown_tx,
            agent_id: "test".to_string(),
            metadata: AgentMetadata {
                tmux_version: String::new(),
                os_version: String::new(),
                nession_version: String::new(),
                image_tag: String::new(),
            },
            sync_needed: Arc::new(AtomicBool::new(false)),
            connected: Arc::new(AtomicBool::new(false)),
        };

        handle
            .send_terminal_resize("agent-1:sess-1", 120, 40)
            .await
            .unwrap();

        let msg = outbox_rx.recv().await.expect("no message in outbox");
        let WsMessage::Text(text) = msg else {
            panic!("expected WsMessage::Text, got {msg:?}");
        };
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["msg_type"], "agent.terminal.resize");
        assert_eq!(parsed["payload"]["session_id"], "agent-1:sess-1");
        assert_eq!(parsed["payload"]["cols"], 120);
        assert_eq!(parsed["payload"]["rows"], 40);
    }

    /// Mock server that sends env.list command after registration.
    async fn start_mock_server_env_list() -> (
        std::net::SocketAddr,
        tokio::task::JoinHandle<()>,
        mpsc::Receiver<String>,
    ) {
        let (msg_tx, msg_rx) = mpsc::channel(100);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("failed to bind mock server");
        let addr = listener.local_addr().expect("mock server local_addr");

        let handle = tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                let ws = accept_async(stream).await.expect("failed to accept ws");
                let (mut sink, mut stream) = ws.split();

                let response = serde_json::json!({
                    "msg_type": "server.agent.register",
                    "id": "test-id",
                    "timestamp": 1234567890,
                    "payload": { "status": "accepted", "message": "ok" }
                });
                let _ = sink.send(WsMessage::Text(response.to_string())).await;
                let _ = stream.next().await;

                let cmd = serde_json::json!({
                    "msg_type": "agent.env.list",
                    "id": "cmd-env-list",
                    "timestamp": 1234567891,
                    "payload": { "request_id": "req-env-list-1" }
                });
                let _ = sink.send(WsMessage::Text(cmd.to_string())).await;

                while let Some(Ok(msg)) = stream.next().await {
                    if let WsMessage::Text(text) = msg {
                        let _ = msg_tx.send(text.clone()).await;
                    }
                }
            }
        });

        (addr, handle, msg_rx)
    }

    #[tokio::test]
    async fn test_server_env_list_command() {
        let (addr, server_handle, mut msg_rx) = start_mock_server_env_list().await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let metadata = AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
            image_tag: "test".to_string(),
        };

        let client = ServerClient::new(
            format!("ws://{addr}"),
            "test-token",
            "test-agent-env-list",
            "test-host",
            "127.0.0.1",
            8080,
            None,
            vec![],
            None, // display_name
            metadata,
            Arc::new(SessionManager::new()),
            "/tmp".to_string(),
            None,
        );

        let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

        let msg = tokio::time::timeout(Duration::from_secs(5), msg_rx.recv())
            .await
            .expect("timeout waiting for env.list response")
            .expect("no message received");

        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(parsed["payload"]["command"], "env.list");
        assert_eq!(parsed["payload"]["success"], true);
        assert!(parsed["payload"]["files"].is_array());

        handle.shutdown().await.ok();
        server_handle.abort();
    }

    /// Mock server that sends sessions.list command after registration.
    async fn start_mock_server_sessions_list() -> (
        std::net::SocketAddr,
        tokio::task::JoinHandle<()>,
        mpsc::Receiver<String>,
    ) {
        let (msg_tx, msg_rx) = mpsc::channel(100);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("failed to bind mock server");
        let addr = listener.local_addr().expect("mock server local_addr");

        let handle = tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                let ws = accept_async(stream).await.expect("failed to accept ws");
                let (mut sink, mut stream) = ws.split();

                let response = serde_json::json!({
                    "msg_type": "server.agent.register",
                    "id": "test-id",
                    "timestamp": 1234567890,
                    "payload": { "status": "accepted", "message": "ok" }
                });
                let _ = sink.send(WsMessage::Text(response.to_string())).await;
                let _ = stream.next().await;

                let cmd = serde_json::json!({
                    "msg_type": "agent.session.report",
                    "id": "cmd-sessions-list",
                    "timestamp": 1234567891,
                    "payload": { "request_id": "req-sessions-list-1" }
                });
                let _ = sink.send(WsMessage::Text(cmd.to_string())).await;

                while let Some(Ok(msg)) = stream.next().await {
                    if let WsMessage::Text(text) = msg {
                        let _ = msg_tx.send(text.clone()).await;
                    }
                }
            }
        });

        (addr, handle, msg_rx)
    }

    /// The agent answers `server.sessions.list` with its live tmux sessions.
    /// An empty list is a success, not an error — so this test passes whether
    /// or not tmux is available on the machine running it.
    #[tokio::test]
    async fn test_server_sessions_list_command() {
        let (addr, server_handle, mut msg_rx) = start_mock_server_sessions_list().await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let metadata = AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
            image_tag: "test".to_string(),
        };

        let client = ServerClient::new(
            format!("ws://{addr}"),
            "test-token",
            "test-agent-sessions-list",
            "test-host",
            "127.0.0.1",
            8080,
            None,
            vec![],
            None, // display_name
            metadata,
            Arc::new(SessionManager::new()),
            "/tmp".to_string(),
            None,
        );

        let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

        let msg = tokio::time::timeout(Duration::from_secs(5), msg_rx.recv())
            .await
            .expect("timeout waiting for sessions.list response")
            .expect("no message received");

        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(parsed["msg_type"], "server.agent.command-response");
        assert_eq!(parsed["payload"]["request_id"], "req-sessions-list-1");
        assert_eq!(parsed["payload"]["command"], "sessions.list");
        assert_eq!(parsed["payload"]["success"], true);
        assert!(parsed["payload"]["sessions"].is_array());

        handle.shutdown().await.ok();
        server_handle.abort();
    }

    /// Mock server that sends env.query command after registration.
    async fn start_mock_server_env_query() -> (
        std::net::SocketAddr,
        tokio::task::JoinHandle<()>,
        mpsc::Receiver<String>,
    ) {
        let (msg_tx, msg_rx) = mpsc::channel(100);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("failed to bind mock server");
        let addr = listener.local_addr().expect("mock server local_addr");

        let handle = tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                let ws = accept_async(stream).await.expect("failed to accept ws");
                let (mut sink, mut stream) = ws.split();

                let response = serde_json::json!({
                    "msg_type": "server.agent.register",
                    "id": "test-id",
                    "timestamp": 1234567890,
                    "payload": { "status": "accepted", "message": "ok" }
                });
                let _ = sink.send(WsMessage::Text(response.to_string())).await;
                let _ = stream.next().await;

                let cmd = serde_json::json!({
                    "msg_type": "agent.env.query",
                    "id": "cmd-env-query",
                    "timestamp": 1234567891,
                    "payload": { "request_id": "req-env-query-1" }
                });
                let _ = sink.send(WsMessage::Text(cmd.to_string())).await;

                while let Some(Ok(msg)) = stream.next().await {
                    if let WsMessage::Text(text) = msg {
                        let _ = msg_tx.send(text.clone()).await;
                    }
                }
            }
        });

        (addr, handle, msg_rx)
    }

    #[tokio::test]
    async fn test_server_env_query_command() {
        let (addr, server_handle, mut msg_rx) = start_mock_server_env_query().await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let metadata = AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
            image_tag: "test".to_string(),
        };

        let client = ServerClient::new(
            format!("ws://{addr}"),
            "test-token",
            "test-agent-env-query",
            "test-host",
            "127.0.0.1",
            8080,
            None,
            vec![],
            None, // display_name
            metadata,
            Arc::new(SessionManager::new()),
            "/tmp".to_string(),
            None,
        );

        let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

        let msg = tokio::time::timeout(Duration::from_secs(5), msg_rx.recv())
            .await
            .expect("timeout waiting for env.query response")
            .expect("no message received");

        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(parsed["payload"]["command"], "env.query");
        assert_eq!(parsed["payload"]["success"], true);
        assert!(parsed["payload"]["sourced_files"].is_array());

        handle.shutdown().await.ok();
        server_handle.abort();
    }

    /// Mock server that sends server.session.env.unset command.
    async fn start_mock_server_env_unset(
        session_name: String,
    ) -> (
        std::net::SocketAddr,
        tokio::task::JoinHandle<()>,
        mpsc::Receiver<String>,
    ) {
        let (msg_tx, msg_rx) = mpsc::channel(100);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("failed to bind mock server");
        let addr = listener.local_addr().expect("mock server local_addr");

        let handle = tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                let ws = accept_async(stream).await.expect("failed to accept ws");
                let (mut sink, mut stream) = ws.split();

                let response = serde_json::json!({
                    "msg_type": "server.agent.register",
                    "id": "test-id",
                    "timestamp": 1234567890,
                    "payload": { "status": "accepted", "message": "ok" }
                });
                let _ = sink.send(WsMessage::Text(response.to_string())).await;
                let _ = stream.next().await;

                // First create a session to apply env to
                let tmux = SessionManager::new();
                let _ = tmux
                    .create_session(&session_name, 80, 24, "/tmp", &[])
                    .await;

                let cmd = serde_json::json!({
                    "msg_type": "agent.session.env.unset",
                    "id": "cmd-env-unset",
                    "timestamp": 1234567891,
                    "payload": {
                        "request_id": "req-env-unset-1",
                        "name": session_name,
                        "keys": ["FOO", "BAR"],
                        "client_id": "test-client"
                    }
                });
                let _ = sink.send(WsMessage::Text(cmd.to_string())).await;

                while let Some(Ok(msg)) = stream.next().await {
                    if let WsMessage::Text(text) = msg {
                        let _ = msg_tx.send(text.clone()).await;
                    }
                }
            }
        });

        (addr, handle, msg_rx)
    }

    #[tokio::test]
    async fn test_server_session_env_unset_command() {
        let session = TestSession::new("env-unset");
        let session_name = session.name().to_string();
        let (addr, server_handle, mut msg_rx) =
            start_mock_server_env_unset(session_name.clone()).await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let metadata = AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
            image_tag: "test".to_string(),
        };

        let client = ServerClient::new(
            format!("ws://{addr}"),
            "test-token",
            "test-agent-env-unset",
            "test-host",
            "127.0.0.1",
            8080,
            None,
            vec![],
            None, // display_name
            metadata,
            Arc::new(SessionManager::new()),
            "/tmp".to_string(),
            None,
        );

        let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

        let msg = tokio::time::timeout(Duration::from_secs(5), msg_rx.recv())
            .await
            .expect("timeout waiting for env.unset response")
            .expect("no message received");

        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(parsed["payload"]["command"], "session.env.unset");
        assert_eq!(parsed["payload"]["request_id"], "req-env-unset-1");

        // Clean up
        let tmux = SessionManager::new();
        let _ = tmux.kill_session(&session_name).await;

        handle.shutdown().await.ok();
        server_handle.abort();
    }

    #[tokio::test]
    async fn test_supervisor_shutdown_during_backoff() {
        // Connect to a port that doesn't exist — the supervisor will enter backoff.
        // Then shutdown during backoff.
        // Don't start a server — connect will fail immediately
        let port = free_port().await;

        let metadata = AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
            image_tag: "test".to_string(),
        };

        let client = ServerClient::new(
            format!("ws://127.0.0.1:{port}"),
            "test-token",
            "test-agent-backoff",
            "test-host",
            "127.0.0.1",
            8080,
            None,
            vec![],
            None, // display_name
            metadata,
            Arc::new(SessionManager::new()),
            "/tmp".to_string(),
            None,
        );

        let (handle, interval) = client.connect_and_run().await.expect("connect failed");
        // The first connection fails, so interval should be None
        assert_eq!(interval, None);

        // Shutdown should succeed quickly (during backoff)
        handle.shutdown().await.ok();
    }

    #[test]
    fn register_response_payload_with_interval() {
        let json = serde_json::json!({
            "status": "accepted",
            "message": "ok",
            "heartbeat_interval_secs": 30
        });
        let resp: RegisterResponsePayload = serde_json::from_value(json).unwrap();
        assert_eq!(resp.status, "accepted");
        assert_eq!(resp.heartbeat_interval_secs, Some(30));
    }

    #[test]
    fn register_response_payload_without_interval() {
        let json = serde_json::json!({
            "status": "accepted",
            "message": "ok"
        });
        let resp: RegisterResponsePayload = serde_json::from_value(json).unwrap();
        assert_eq!(resp.heartbeat_interval_secs, None);
    }

    #[test]
    fn session_update_payload_serialization() {
        let payload = AgentSessionUpdatePayload {
            agent_id: "a1".to_string(),
            session_name: "s1".to_string(),
            status: "active".to_string(),
            window_count: 3,
            attached_clients: 1,
            foreground_command: Some("claude".to_string()),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["agent_id"], "a1");
        assert_eq!(json["session_name"], "s1");
        assert_eq!(json["status"], "active");
        assert_eq!(json["window_count"], 3);
        assert_eq!(json["attached_clients"], 1);
    }

    /// Write an executable `tmux` shim script that dispatches on `$1`.
    ///
    /// The shim is prefixed with the same `-S <socket>` strip a real tmux does,
    /// because every command nession builds carries that flag (see
    /// `crate::tmux::cmd`). Without the strip, `$1` would be `-S` and a script
    /// matching on subcommands would silently fall through to its catch-all —
    /// the shim would "work" while testing nothing.
    #[cfg(unix)]
    fn write_fake_tmux(dir: &std::path::Path, script: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("tmux");
        std::fs::write(
            &path,
            format!("#!/bin/sh\nif [ \"$1\" = \"-S\" ]; then shift 2; fi\n{script}\n"),
        )
        .unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path.to_string_lossy().into_owned()
    }

    /// Shared AgentMetadata for the new tests.
    fn metadata_for_tests() -> AgentMetadata {
        AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
            image_tag: "test".to_string(),
        }
    }

    /// Mock server that sends `server.session.create` immediately followed by
    /// `server.sessions.list`, then forwards all client responses.
    async fn start_mock_server_create_then_list(
        session_name: String,
    ) -> (
        std::net::SocketAddr,
        tokio::task::JoinHandle<()>,
        mpsc::Receiver<String>,
    ) {
        let (msg_tx, msg_rx) = mpsc::channel(100);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("failed to bind mock server");
        let addr = listener.local_addr().expect("mock server local_addr");

        let handle = tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                let ws = accept_async(stream).await.expect("failed to accept ws");
                let (mut sink, mut stream) = ws.split();

                let response = serde_json::json!({
                    "msg_type": "server.agent.register",
                    "id": "test-id",
                    "timestamp": 1234567890,
                    "payload": { "status": "accepted", "message": "ok" }
                });
                let _ = sink.send(WsMessage::Text(response.to_string())).await;
                let _ = stream.next().await; // skip registration

                let create_cmd = serde_json::json!({
                    "msg_type": "agent.session.create",
                    "id": "cmd-create",
                    "timestamp": 1234567891,
                    "payload": {
                        "request_id": "req-create",
                        "name": session_name,
                        "width": 100,
                        "height": 30
                    }
                });
                let _ = sink.send(WsMessage::Text(create_cmd.to_string())).await;

                let list_cmd = serde_json::json!({
                    "msg_type": "agent.session.report",
                    "id": "cmd-list",
                    "timestamp": 1234567892,
                    "payload": { "request_id": "req-list" }
                });
                let _ = sink.send(WsMessage::Text(list_cmd.to_string())).await;

                while let Some(Ok(msg)) = stream.next().await {
                    if let WsMessage::Text(text) = msg {
                        let _ = msg_tx.send(text.clone()).await;
                    }
                }
            }
        });

        (addr, handle, msg_rx)
    }

    /// A hung `list-sessions` (30s timeout, 5s actual hang) must not block a
    /// heartbeat from reaching the server.
    #[cfg(unix)]
    #[tokio::test]
    async fn heartbeat_flows_while_tmux_command_hangs() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("list-started");
        let shim = write_fake_tmux(
            dir.path(),
            &format!(
                "case \"$1\" in list-sessions) touch {}; sleep 5;; *) exit 0;; esac",
                marker.display()
            ),
        );

        let tmux = {
            let mut m = SessionManager::new();
            m.with_tmux_bin(shim).with_timeouts(
                Duration::from_secs(30),
                Duration::from_secs(5),
                Duration::from_secs(10),
            );
            Arc::new(m)
        };

        let (addr, server_handle, mut msg_rx) = start_mock_server_sessions_list().await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let client = ServerClient::new(
            format!("ws://{addr}"),
            "test-token",
            "test-agent-hang",
            "test-host",
            "127.0.0.1",
            8080,
            None,
            vec![],
            None,
            metadata_for_tests(),
            tmux,
            "/tmp".to_string(),
            None,
        );
        let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

        // Wait until the agent has actually started the hung list-sessions call.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !marker.exists() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(marker.exists(), "agent never started the hung tmux command");

        // Send a heartbeat while list-sessions is still sleeping.
        handle
            .send_heartbeat(AgentStatus::Online, 1, 0, 0, [0.0, 0.0, 0.0])
            .await
            .unwrap();

        // The heartbeat must arrive promptly (well before the 5s hang ends).
        let delivered = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let msg = msg_rx.recv().await.expect("server closed");
                let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
                if parsed.get("msg_type").and_then(|v| v.as_str()) == Some("control.heartbeat") {
                    return;
                }
            }
        })
        .await;
        assert!(
            delivered.is_ok(),
            "heartbeat was blocked by the hung tmux command"
        );

        handle.shutdown().await.ok();
        server_handle.abort();
    }

    /// `server.sessions.list` must answer ahead of a slow-but-not-timed-out
    /// `server.session.create` that is still in flight, rather than queueing
    /// behind it.
    #[cfg(unix)]
    #[tokio::test]
    async fn sessions_list_responds_while_create_is_slow() {
        let dir = tempfile::tempdir().unwrap();
        // new-session is slow (2s, under the 10s create timeout); list is fast.
        let shim = write_fake_tmux(
            dir.path(),
            "case \"$1\" in new-session) sleep 2;; *) exit 0;; esac",
        );

        let tmux = {
            let mut m = SessionManager::new();
            m.with_tmux_bin(shim).with_timeouts(
                Duration::from_secs(30),
                Duration::from_secs(5),
                Duration::from_secs(10),
            );
            Arc::new(m)
        };

        let (addr, server_handle, mut msg_rx) =
            start_mock_server_create_then_list("slow-create-test".to_string()).await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let client = ServerClient::new(
            format!("ws://{addr}"),
            "test-token",
            "test-agent-slow-create",
            "test-host",
            "127.0.0.1",
            8080,
            None,
            vec![],
            None,
            metadata_for_tests(),
            tmux,
            "/tmp".to_string(),
            None,
        );
        let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

        // Assert ordering, not elapsed time. Were the list queued behind the
        // create, the create's response would necessarily come back first — so
        // "which answered first" proves concurrency on its own. A wall-clock
        // budget would instead race the machine: connect, register and two
        // command round trips all had to land inside it, which is not a
        // property of the code under test.
        let first = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let msg = msg_rx.recv().await.expect("server closed");
                let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
                let command = parsed
                    .get("payload")
                    .and_then(|p| p.get("command"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                if command == "sessions.list" || command == "session.create" {
                    return parsed;
                }
            }
        })
        .await
        .expect("neither sessions.list nor session.create ever answered");

        let payload = first.get("payload").expect("response carries a payload");
        assert_eq!(
            payload.get("command").and_then(|v| v.as_str()),
            Some("sessions.list"),
            "sessions.list was queued behind the slow session.create"
        );
        assert_eq!(
            payload.get("request_id").and_then(|v| v.as_str()),
            Some("req-list")
        );
        assert_eq!(
            payload.get("success").and_then(serde_json::Value::as_bool),
            Some(true)
        );

        handle.shutdown().await.ok();
        server_handle.abort();
    }

    // ── The central connection's execution model (#961 stages A and E) ───────
    //
    // Stage A wrote these as **characterization**: they pinned what this path
    // did then — a detached task per server message, no limit and no ordering —
    // and each named the stage expected to change its answer. Stage E changed
    // two of the four, and the pair that flipped is the pair the requirement's
    // success criteria are written against (bounded; ordered per resource key).
    // The other two are guards, and they are guards *because* the model changed:
    // see each one's comment.
    //
    // What they all have in common is the instrument: a `tmux` that parks every
    // invocation until the test says otherwise, so "how many mutations are in
    // flight at once" is a number read off a file rather than an inference from
    // elapsed time.

    /// A `tmux` that logs each mutation it is asked to run and then holds.
    ///
    /// The hold is what makes concurrency observable. With every invocation
    /// parked, the number of lines in the log *is* the number of mutations the
    /// agent has in flight at once, and a serialized implementation cannot
    /// produce the second line while the first is parked — it has nowhere to
    /// hide. An elapsed-time assertion could not tell "these overlapped" from
    /// "these were quick".
    struct BlockingTmux {
        // Kept alive for the whole test: the shim, the log and the release file
        // all live in here.
        _dir: tempfile::TempDir,
        release_path: std::path::PathBuf,
        log: std::path::PathBuf,
        manager: Arc<SessionManager>,
    }

    impl BlockingTmux {
        fn new() -> Self {
            Self::with_timeouts(
                Duration::from_secs(20),
                Duration::from_secs(20),
                Duration::from_secs(20),
            )
        }

        /// The same, with a short `create` timeout — for the test about a
        /// command that gives up while its tmux call is still running.
        fn with_create_timeout(create: Duration) -> Self {
            Self::with_timeouts(Duration::from_secs(20), Duration::from_secs(20), create)
        }

        fn with_timeouts(list: Duration, kill: Duration, create: Duration) -> Self {
            let dir = tempfile::tempdir().expect("tempdir");
            let release_path = dir.path().join("release");
            let log = dir.path().join("tmux-calls");

            // The bound on the wait is the shim's own safety net, not the
            // test's timing: a test that fails its assertion before releasing
            // leaves a parked `sh` behind, and this is what stops it lingering
            // for the rest of the run. 400 × 50 ms is far longer than any of the
            // deadlines below.
            let script = format!(
                r#"case "$1" in
  new-session|kill-session|list-sessions)
    printf '%s\n' "$1" >> {log}
    i=0
    while [ ! -e {release} ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done
    ;;
esac"#,
                log = log.display(),
                release = release_path.display(),
            );
            let shim = write_fake_tmux(dir.path(), &script);

            let mut manager = SessionManager::new();
            manager
                .with_tmux_bin(shim)
                .with_timeouts(list, kill, create);

            Self {
                _dir: dir,
                release_path,
                log,
                manager: Arc::new(manager),
            }
        }

        fn tmux(&self) -> Arc<SessionManager> {
            Arc::clone(&self.manager)
        }

        /// How many tmux invocations have started.
        fn started(&self) -> usize {
            std::fs::read_to_string(&self.log)
                .map(|log| log.lines().count())
                .unwrap_or(0)
        }

        /// Wait for `n` invocations to start, and report how many ever did.
        ///
        /// An invocation either starts or never will, so this waits for a fact;
        /// the deadline only bounds how long a serialized implementation is
        /// given to prove that it is one.
        async fn started_within(&self, n: usize, within: Duration) -> usize {
            let deadline = std::time::Instant::now() + within;
            loop {
                let started = self.started();
                if started >= n || std::time::Instant::now() >= deadline {
                    return started;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }

        /// Let every parked invocation finish.
        fn release(&self) {
            std::fs::write(&self.release_path, b"go").expect("write release file");
        }
    }

    /// `agent.session.create` as the server sends it.
    fn create_command(id: &str, request_id: &str, name: &str) -> serde_json::Value {
        serde_json::json!({
            "msg_type": "agent.session.create",
            "id": id,
            "timestamp": 1,
            "payload": { "request_id": request_id, "name": name, "width": 80, "height": 24 },
        })
    }

    /// `agent.session.kill` as the server sends it.
    fn kill_command(id: &str, request_id: &str, name: &str) -> serde_json::Value {
        serde_json::json!({
            "msg_type": "agent.session.kill",
            "id": id,
            "timestamp": 1,
            "payload": { "request_id": request_id, "name": name },
        })
    }

    /// `agent.session.report` — the read-only one, which reaches tmux too.
    fn sessions_list_command(id: &str, request_id: &str) -> serde_json::Value {
        serde_json::json!({
            "msg_type": "agent.session.report",
            "id": id,
            "timestamp": 1,
            "payload": { "request_id": request_id },
        })
    }

    /// A mock server that signs `commands` in one burst, then forwards every
    /// response the agent sends.
    ///
    /// The burst is the point: several commands in flight at once is what a
    /// reader that spawns per message produces and a serialized one cannot.
    /// Nothing waits between them, so the agent's own dispatch is the only
    /// thing deciding how many run at once.
    ///
    /// The returned sender sends further commands later, which is how a test
    /// asks a question *after* the answers above it have been observed rather
    /// than guessing at a delay.
    async fn start_mock_server_sending_commands(
        commands: Vec<serde_json::Value>,
    ) -> MockCommandServer {
        let (msg_tx, msg_rx) = mpsc::channel(100);
        let (command_tx, mut command_rx) = mpsc::channel::<serde_json::Value>(10);
        let keepalive = command_tx.clone();
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("failed to bind mock server");
        let addr = listener.local_addr().expect("mock server local_addr");

        let handle = tokio::spawn(async move {
            // Held so `command_rx.recv()` never resolves to `None`, which would
            // otherwise spin this loop the moment the test's copy is dropped.
            let _keepalive = keepalive;

            if let Ok((stream, _)) = listener.accept().await {
                let ws = accept_async(stream).await.expect("failed to accept ws");
                let (mut sink, mut stream) = ws.split();

                let response = serde_json::json!({
                    "msg_type": "server.agent.register",
                    "id": "test-id",
                    "timestamp": 1234567890,
                    "payload": { "status": "accepted", "message": "ok" }
                });
                let _ = sink.send(WsMessage::Text(response.to_string())).await;
                let _ = stream.next().await; // skip registration

                for command in commands {
                    let _ = sink.send(WsMessage::Text(command.to_string())).await;
                }

                loop {
                    tokio::select! {
                        incoming = stream.next() => match incoming {
                            Some(Ok(WsMessage::Text(text))) => {
                                let _ = msg_tx.send(text).await;
                            }
                            Some(Ok(_)) => {}
                            _ => break,
                        },
                        more = command_rx.recv() => {
                            let Some(command) = more else { continue };
                            if sink.send(WsMessage::Text(command.to_string())).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            }
        });

        (addr, handle, msg_rx, command_tx)
    }

    /// A running [`start_mock_server_sending_commands`]: where the agent should
    /// connect, the handle that keeps the mock alive, the responses it forwards,
    /// and the channel that sends it more commands.
    type MockCommandServer = (
        std::net::SocketAddr,
        tokio::task::JoinHandle<()>,
        mpsc::Receiver<String>,
        mpsc::Sender<serde_json::Value>,
    );

    /// Every command response that arrives within `window`.
    async fn responses_within(
        msg_rx: &mut mpsc::Receiver<String>,
        window: Duration,
    ) -> Vec<serde_json::Value> {
        let mut responses = Vec::new();
        let deadline = std::time::Instant::now() + window;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return responses;
            }
            match tokio::time::timeout(remaining, msg_rx.recv()).await {
                Ok(Some(text)) => {
                    let parsed: serde_json::Value =
                        serde_json::from_str(&text).expect("the agent sends JSON");
                    if parsed.get("msg_type").and_then(|v| v.as_str())
                        == Some("server.agent.command-response")
                    {
                        responses.push(parsed);
                    }
                }
                Ok(None) | Err(_) => return responses,
            }
        }
    }

    /// Collect `count` command responses, in the order they arrived.
    async fn collect_responses(
        msg_rx: &mut mpsc::Receiver<String>,
        count: usize,
        within: Duration,
    ) -> Vec<serde_json::Value> {
        let mut responses = Vec::new();
        let deadline = std::time::Instant::now() + within;
        while responses.len() < count {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            assert!(
                !remaining.is_zero(),
                "only {} of {count} command responses arrived",
                responses.len()
            );
            let batch = responses_within(msg_rx, remaining.min(Duration::from_millis(200))).await;
            responses.extend(batch);
        }
        responses
    }

    /// A `ServerClient` connected to the mock server, using `tmux`.
    async fn connected_client(
        addr: std::net::SocketAddr,
        agent_id: &str,
        tmux: Arc<SessionManager>,
    ) -> crate::connection::server_client::ServerClientHandle {
        let client = ServerClient::new(
            format!("ws://{addr}"),
            "test-token",
            agent_id,
            "test-host",
            "127.0.0.1",
            8080,
            None,
            vec![],
            None,
            metadata_for_tests(),
            tmux,
            "/tmp".to_string(),
            None,
        );
        client.connect_and_run().await.expect("connect failed").0
    }

    /// Two mutations for **different** sessions run at the same time.
    ///
    /// Sessions `s1` and `s2` share no state, so this is the concurrency the
    /// requirement keeps: dispatch is bounded and ordered *by resource key*, and
    /// different keys stay parallel under that model.
    ///
    /// **Must not flip.** It is the "不同 resource keys 可以并行" half of the
    /// success criteria; a red here means a keyed scheduler has collapsed
    /// unrelated resources onto one lane. It has not been changed since stage A
    /// wrote it, and that is the point — the keyed lane kept it true.
    #[cfg(unix)]
    #[tokio::test]
    async fn mutations_for_different_sessions_run_at_the_same_time() {
        let tmux = BlockingTmux::new();
        let (addr, server_handle, mut msg_rx, _commands) =
            start_mock_server_sending_commands(vec![
                create_command("cmd-1", "req-1", "s1"),
                create_command("cmd-2", "req-2", "s2"),
            ])
            .await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let handle = connected_client(addr, "test-agent-different-sessions", tmux.tmux()).await;

        // Both tmux invocations start while neither has finished: the first is
        // parked on a release file the test has not written yet, so a dispatch
        // that waited for it could never produce the second.
        let started = tmux.started_within(2, Duration::from_secs(10)).await;
        assert_eq!(
            started, 2,
            "only {started} of 2 tmux invocations started — the second session's \
             mutation waited for the first"
        );

        tmux.release();
        let responses = collect_responses(&mut msg_rx, 2, Duration::from_secs(15)).await;
        let mut answered: Vec<&str> = responses
            .iter()
            .filter_map(|r| r["payload"]["request_id"].as_str())
            .collect();
        answered.sort_unstable();
        assert_eq!(answered, vec!["req-1", "req-2"]);

        handle.shutdown().await.ok();
        server_handle.abort();
    }

    /// Two mutations for the **same** session run one at a time, in the order
    /// they arrived.
    ///
    /// `create` then `kill` for one session is the ordering the requirement
    /// calls out by name ("create + kill same session | preserve resource
    /// ordering"). Stage A's name for this test was
    /// `mutations_for_one_session_are_not_ordered`, and it was true: both were
    /// detached tasks, so the kill reached tmux while the create was still
    /// running and the session that survived was whichever task won.
    ///
    /// `#961-E` flipped it, and the assertion flipped with it: the same
    /// instrument reads `1` instead of `2`. The witness is the log of tmux
    /// invocations — the first is parked on a release file the test has not
    /// written yet, so a second invocation *cannot* exist while the key lane is
    /// doing its job, and there is nowhere for an overtaking worker to hide.
    ///
    /// The bounded window is the negative half and is safe in that direction:
    /// it can only go red when the second mutation ran while the first was
    /// still running. The positive half that follows it is deterministic — after
    /// the release, the second invocation exists, so the ordering is a delay
    /// rather than a loss.
    #[cfg(unix)]
    #[tokio::test]
    async fn mutations_of_one_session_are_ordered() {
        let tmux = BlockingTmux::new();
        let (addr, server_handle, mut msg_rx, _commands) =
            start_mock_server_sending_commands(vec![
                create_command("cmd-1", "req-1", "s1"),
                kill_command("cmd-2", "req-2", "s1"),
            ])
            .await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let handle = connected_client(addr, "test-agent-same-session", tmux.tmux()).await;

        // The first mutation is in flight and parked.
        let started = tmux.started_within(1, Duration::from_secs(10)).await;
        assert_eq!(started, 1, "the first mutation never started");

        // The second is written and read — it is in the key's queue, not on the
        // wire — and it must not have reached tmux.
        let started = tmux.started_within(2, Duration::from_millis(500)).await;
        assert_eq!(
            started, 1,
            "the same session's second mutation ran while the first was still \
             running: {started} tmux invocations, and the first has not been \
             released"
        );

        // Releasing the first lets the key's worker take the second.
        tmux.release();
        let started = tmux.started_within(2, Duration::from_secs(10)).await;
        assert_eq!(
            started, 2,
            "the second mutation never ran after the first finished: ordering \
             turned into a loss"
        );

        let responses = collect_responses(&mut msg_rx, 2, Duration::from_secs(15)).await;
        let mut answered: Vec<&str> = responses
            .iter()
            .filter_map(|r| r["payload"]["request_id"].as_str())
            .collect();
        answered.sort_unstable();
        assert_eq!(answered, vec!["req-1", "req-2"]);

        handle.shutdown().await.ok();
        server_handle.abort();
    }

    /// How many commands the central connection runs at once is **bounded**.
    ///
    /// Stage A's name for this test was
    /// `nothing_caps_the_commands_in_flight_on_the_central_connection`, and it
    /// was true: every server message became a detached task, so the number in
    /// flight tracked the number of messages and nothing else. `#961-E` replaced
    /// that with a bounded lane, and this is the assertion it left behind —
    /// `#961`'s "concurrency upper bound test, 证明 task 数不会随消息无限增长".
    ///
    /// `CONCURRENT_COMMANDS` stays at 12, above the bound the stage chose
    /// (`DEFAULT_QUERY_CONCURRENCY`, 8), which is what leaves the bound
    /// observable at all: a message count at or below the bound could not tell a
    /// lane from a `tokio::spawn`. Stage A's own note on this test said exactly
    /// that the number moves only if the bound is above it.
    ///
    /// The three phases are the whole policy: the lane fills (positive), a
    /// twelfth command does not start while it is full (the bound), and
    /// releasing it lets every remaining command through, each answering its own
    /// request (a bound that drops would show up as a missing id).
    #[cfg(unix)]
    #[tokio::test]
    async fn the_central_connection_holds_at_its_bound_and_then_drains() {
        const CONCURRENT_COMMANDS: usize = 12;
        let bound = crate::connection::execution::DEFAULT_QUERY_CONCURRENCY;

        let tmux = BlockingTmux::new();
        let commands: Vec<serde_json::Value> = (0..CONCURRENT_COMMANDS)
            .map(|n| sessions_list_command(&format!("cmd-{n}"), &format!("req-{n}")))
            .collect();
        let (addr, server_handle, mut msg_rx, _commands) =
            start_mock_server_sending_commands(commands).await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let handle = connected_client(addr, "test-agent-bounded", tmux.tmux()).await;

        let started = tmux.started_within(bound, Duration::from_secs(15)).await;
        assert_eq!(
            started, bound,
            "the lane did not fill: {started} of {bound} commands ran"
        );

        // The bound is what the reader waits on: the command that would exceed
        // it is not read, so no twelfth invocation can exist.
        let started = tmux
            .started_within(CONCURRENT_COMMANDS, Duration::from_millis(500))
            .await;
        assert_eq!(
            started, bound,
            "{started} of {CONCURRENT_COMMANDS} commands ran at once against a bound \
             of {bound}: dispatch is not bounded by the lane"
        );

        tmux.release();
        let started = tmux
            .started_within(CONCURRENT_COMMANDS, Duration::from_secs(15))
            .await;
        assert_eq!(
            started, CONCURRENT_COMMANDS,
            "only {started} of {CONCURRENT_COMMANDS} commands ever ran: the bound \
             turned into a loss rather than a delay"
        );

        let responses =
            collect_responses(&mut msg_rx, CONCURRENT_COMMANDS, Duration::from_secs(20)).await;
        let mut answered: Vec<&str> = responses
            .iter()
            .filter_map(|r| r["payload"]["request_id"].as_str())
            .collect();
        answered.sort_unstable();
        // Sorted the same way `answered` is, which is lexicographic and not
        // numeric: `req-10` sorts before `req-2`, and comparing a sorted list
        // against an unsorted one would fail on the ordering of the *test's*
        // own generator rather than on anything the agent did.
        let mut expected: Vec<String> = (0..CONCURRENT_COMMANDS)
            .map(|n| format!("req-{n}"))
            .collect();
        expected.sort_unstable();
        assert_eq!(
            answered,
            expected.iter().map(String::as_str).collect::<Vec<&str>>(),
            "a command's answer went missing behind the bound"
        );

        handle.shutdown().await.ok();
        server_handle.abort();
    }

    /// A command that gives up does not answer twice when its tmux call
    /// finally finishes.
    ///
    /// The edge case is "request timeout but handler finishes later". The
    /// manager's own timeout ends the command while the tmux process it
    /// started is still running — `create_session` races the call against
    /// `create_timeout`, and the child outlives the future that dropped it.
    ///
    /// What the agent does with that late completion is nothing at all: the
    /// response is built from the timed-out call, the child's later exit is
    /// seen by nobody, and the connection carries on. One response per request
    /// id, and the next command on the same connection is answered normally.
    ///
    /// **Must not flip.** Keyed executors and cancellation ownership are the
    /// stages most likely to change it, and the requirement's edge-case row is
    /// explicit that a late completion must not corrupt another request.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_timed_out_command_does_not_answer_twice_when_tmux_finishes() {
        // A short create timeout, so the manager gives up while its tmux
        // invocation is still parked on the release file.
        let tmux = BlockingTmux::with_create_timeout(Duration::from_millis(300));
        let (addr, server_handle, mut msg_rx, commands) =
            start_mock_server_sending_commands(vec![create_command("cmd-1", "req-1", "s1")]).await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let handle = connected_client(addr, "test-agent-timeout", tmux.tmux()).await;

        // Only the manager's own timeout can produce this: the tmux call it
        // started is still running, and nothing but the release file ends it.
        let responses = collect_responses(&mut msg_rx, 1, Duration::from_secs(10)).await;
        assert_eq!(
            responses[0]["payload"]["request_id"],
            serde_json::json!("req-1")
        );
        assert_eq!(
            responses[0]["payload"]["success"],
            serde_json::json!(false),
            "a create that timed out must report failure: {}",
            responses[0]
        );
        assert!(
            responses[0]["payload"]["error"]
                .as_str()
                .unwrap_or_default()
                .contains("timed out"),
            "the failure has to say what happened: {}",
            responses[0]
        );

        // Now let the abandoned tmux call finish. Nothing correlates it any
        // more — its response went out when the timeout fired.
        tmux.release();
        tokio::time::sleep(Duration::from_millis(300)).await;

        // The connection is still good: a request handled after the late
        // completion is answered, with its own id.
        commands
            .send(sessions_list_command("cmd-2", "req-2"))
            .await
            .expect("mock server gone");
        let responses = collect_responses(&mut msg_rx, 1, Duration::from_secs(10)).await;
        assert_eq!(
            responses[0]["payload"]["request_id"],
            serde_json::json!("req-2")
        );
        assert_eq!(responses[0]["payload"]["success"], serde_json::json!(true));

        // And the timed-out command did not answer a second time: another
        // response for it would have arrived here.
        let late = responses_within(&mut msg_rx, Duration::from_millis(500)).await;
        assert!(
            late.is_empty(),
            "the late tmux completion produced another response: {late:?}"
        );

        handle.shutdown().await.ok();
        server_handle.abort();
    }
}

// ── The Protocol Units this agent serves ──
//
// The third `=>` of each arm is the **execution policy** (`#961-E`): how the
// connection's reader hands this unit to a lane. The key helpers above are what
// the `Key` policies are written in terms of. What the policies mean is
// `crate::connection::execution`'s to say.
/// The tmux session a payload names, by the name this agent knows it by.
///
/// Every session unit on this connection names its target in a field called
/// `name` — `session.create`, `session.kill`, and both `session.env.*` — so
/// unlike the Server's side there is no second spelling to reconcile and no
/// joined form to agree on. What the helper exists for is the *kind*: the
/// envelope says `agent.session.kill`, and that is not what turns the string
/// into a session key.
fn session_by_name(payload: &serde_json::Value) -> ResourceKey {
    ResourceKey::Session(str_field(payload, "name"))
}

/// The locally stored env file a payload names.
///
/// A separate function from [`session_by_name`] although it reads the same
/// field, because the *field* is not the thing: `agent.env.write` names an env
/// file in `name` and `agent.session.env.apply` names a session in `name`, and
/// one helper that read `name` for both would be right about the spelling and
/// wrong about the resource — the two would share a queue, and a write to an
/// env file would wait behind a mutation of a session that happened to have
/// that name.
fn env_file_by_name(payload: &serde_json::Value) -> ResourceKey {
    ResourceKey::Env(str_field(payload, "name"))
}

/// Whether a wire is one of the three control messages.
///
/// Control is not an operation (`docs/architecture/protocol.md` § *What is not
/// a Protocol Unit*): nothing offers it, nothing answers it, and every runtime
/// handles it. The route table below cannot carry it — an arm there is a
/// descriptor, and a descriptor is an offer this agent would be making — so the
/// reader reads the category here, beside the constants that name it, rather
/// than adding a column for something that is not a unit.
fn is_control(wire: &str) -> bool {
    matches!(
        wire,
        msg_types::CONTROL_HEARTBEAT | msg_types::CONTROL_PING | msg_types::CONTROL_PONG
    )
}

core_routes!(agent, msg, responses;
    "agent.session.create" => "agent.session.create" => Key(session_by_name(&msg.payload)) => {
                    let payload: ServerSessionCreatePayload =
                        match serde_json::from_value(msg.payload.clone()) {
                            Ok(p) => p,
                            Err(e) => {
                                warn!("Invalid server.session.create payload: {e}");
                                return Ok(());
                            }
                        };
                    let request_id = payload.request_id.clone();
                    let name = payload.name.clone();
                    let env = flatten_snapshots(&payload.env_snapshots);

                    info!(
                        "Server requested session create: name={}, width={}, height={}, env_files={}",
                        name,
                        payload.width,
                        payload.height,
                        payload.env_snapshots.len()
                    );

                    let (success, error, session_name) = match agent
                        .tmux
                        .create_session(
                            &name,
                            payload.width,
                            payload.height,
                            &agent.default_working_dir,
                            &env,
                        )
                        .await
                    {
                        Ok(()) => (true, None, Some(name.clone())),
                        Err(e) => (false, Some(e.to_string()), None),
                    };

                    let response = serde_json::json!({
                        "msg_type": "server.agent.command-response",
                        "id": uuid::Uuid::new_v4().to_string(),
                        "timestamp": chrono::Utc::now().timestamp().unsigned_abs(),
                        "payload": {
                            "request_id": request_id,
                            "command": "session.create",
                            "success": success,
                            "error": error,
                            "session_name": session_name,
                        }
                    });
                    responses.send(WsMessage::Text(response.to_string())).await?;
    }
    "agent.env.list" => "agent.env.list" => Query => {
                    let request_id = str_field(&msg.payload, "request_id");
                    let files = agent
                        .env_store
                        .list(&agent.agent_id)
                        .await
                        .unwrap_or_default();
                    let response = serde_json::json!({
                        "msg_type": "server.agent.command-response",
                        "id": uuid::Uuid::new_v4().to_string(),
                        "timestamp": chrono::Utc::now().timestamp().unsigned_abs(),
                        "payload": {
                            "request_id": request_id,
                            "command": "env.list",
                            "success": true,
                            "files": files,
                        }
                    });
                    responses.send(WsMessage::Text(response.to_string())).await?;
    }
    "agent.env.get" => "agent.env.get" => Query => {
                    let request_id = str_field(&msg.payload, "request_id");
                    let name = str_field(&msg.payload, "name");
                    let (success, content, error) = match agent.env_store.read(&name).await {
                        Ok(c) => (true, Some(c), None),
                        Err(e) => (false, None, Some(e.to_string())),
                    };
                    let response = serde_json::json!({
                        "msg_type": "server.agent.command-response",
                        "id": uuid::Uuid::new_v4().to_string(),
                        "timestamp": chrono::Utc::now().timestamp().unsigned_abs(),
                        "payload": {
                            "request_id": request_id,
                            "command": "env.get",
                            "success": success,
                            "content": content,
                            "error": error,
                        }
                    });
                    responses.send(WsMessage::Text(response.to_string())).await?;
    }
    "agent.env.write" => "agent.env.write" => Key(env_file_by_name(&msg.payload)) => {
                    let request_id = str_field(&msg.payload, "request_id");
                    let name = str_field(&msg.payload, "name");
                    let content = str_field(&msg.payload, "content");
                    let overwrite = msg
                        .payload
                        .get("overwrite")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false);
                    let (success, exists, error) =
                        match agent.env_store.write(&name, &content, overwrite).await {
                            Ok(true) => (true, false, None),
                            Ok(false) => (false, true, None),
                            Err(e) => (false, false, Some(e.to_string())),
                        };
                    let warnings = nession_common::env_file::parse_env(&content).warnings;
                    let response = serde_json::json!({
                        "msg_type": "server.agent.command-response",
                        "id": uuid::Uuid::new_v4().to_string(),
                        "timestamp": chrono::Utc::now().timestamp().unsigned_abs(),
                        "payload": {
                            "request_id": request_id,
                            "command": "env.write",
                            "success": success,
                            "exists": exists,
                            "error": error,
                            "warnings": warnings,
                        }
                    });
                    responses.send(WsMessage::Text(response.to_string())).await?;
    }
    "agent.env.delete" => "agent.env.delete" => Key(env_file_by_name(&msg.payload)) => {
                    let request_id = str_field(&msg.payload, "request_id");
                    let name = str_field(&msg.payload, "name");
                    let (success, error) = match agent.env_store.delete(&name).await {
                        Ok(()) => (true, None),
                        Err(e) => (false, Some(e.to_string())),
                    };
                    let response = serde_json::json!({
                        "msg_type": "server.agent.command-response",
                        "id": uuid::Uuid::new_v4().to_string(),
                        "timestamp": chrono::Utc::now().timestamp().unsigned_abs(),
                        "payload": {
                            "request_id": request_id,
                            "command": "env.delete",
                            "success": success,
                            "error": error,
                        }
                    });
                    responses.send(WsMessage::Text(response.to_string())).await?;
    }
    "agent.session.env.apply" => "agent.session.env.apply" => Key(session_by_name(&msg.payload)) => {
                    let payload: ServerSessionEnvApplyPayload =
                        match serde_json::from_value(msg.payload.clone()) {
                            Ok(p) => p,
                            Err(e) => {
                                warn!("Invalid server.session.env.apply payload: {e}");
                                return Ok(());
                            }
                        };
                    // Extract client_id or use "unknown" if not provided
                    let client_id = payload.client_id.as_deref().unwrap_or("unknown");
                    // One source script per snapshot (env file), sent via send-keys
                    // to the session. Each command is hidden from view with tput.
                    let mut error: Option<String> = None;
                    for snap in &payload.snapshots {
                        if let Err(e) = agent
                            .tmux
                            .env()
                            .source_env(client_id, &payload.name, &snap.name, &snap.vars)
                            .await
                        {
                            error = Some(e.to_string());
                            break;
                        }
                    }
                    // Track sourced env files if no error occurred
                    if error.is_none() && !payload.env_files.is_empty() {
                        if let Ok(mut sourced) = agent.sourced_envs.lock() {
                            sourced
                                .entry(payload.name.clone())
                                .or_insert_with(Vec::new)
                                .extend(payload.env_files.clone());
                        }
                    }
                    let response = serde_json::json!({
                        "msg_type": "server.agent.command-response",
                        "id": uuid::Uuid::new_v4().to_string(),
                        "timestamp": chrono::Utc::now().timestamp().unsigned_abs(),
                        "payload": {
                            "request_id": payload.request_id,
                            "command": "session.env.apply",
                            "success": error.is_none(),
                            "error": error,
                        }
                    });
                    responses.send(WsMessage::Text(response.to_string())).await?;
    }
    "agent.session.env.unset" => "agent.session.env.unset" => Key(session_by_name(&msg.payload)) => {
                    let payload: ServerSessionEnvUnsetPayload =
                        match serde_json::from_value(msg.payload.clone()) {
                            Ok(p) => p,
                            Err(e) => {
                                warn!("Invalid server.session.env.unset payload: {e}");
                                return Ok(());
                            }
                        };
                    // Extract client_id or use "unknown" if not provided
                    let client_id = payload.client_id.as_deref().unwrap_or("unknown");
                    let mut error: Option<String> = None;
                    if let Err(e) = agent
                        .tmux
                        .env()
                        .unsource_env(client_id, &payload.name, "all", &payload.keys)
                        .await
                    {
                        error = Some(e.to_string());
                    }
                    let response = serde_json::json!({
                        "msg_type": "server.agent.command-response",
                        "id": uuid::Uuid::new_v4().to_string(),
                        "timestamp": chrono::Utc::now().timestamp().unsigned_abs(),
                        "payload": {
                            "request_id": payload.request_id,
                            "command": "session.env.unset",
                            "success": error.is_none(),
                            "error": error,
                        }
                    });
                    responses.send(WsMessage::Text(response.to_string())).await?;
    }
    "agent.env.query" => "agent.env.query" => Query => {
                    let request_id = str_field(&msg.payload, "request_id");
                    let sourced_files = agent.get_sourced_env_files();
                    let response = serde_json::json!({
                        "msg_type": "server.agent.command-response",
                        "id": uuid::Uuid::new_v4().to_string(),
                        "timestamp": chrono::Utc::now().timestamp().unsigned_abs(),
                        "payload": {
                            "request_id": request_id,
                            "command": "env.query",
                            "success": true,
                            "sourced_files": sourced_files,
                        }
                    });
                    responses.send(WsMessage::Text(response.to_string())).await?;
    }
    "agent.session.kill" => "agent.session.kill" => Key(session_by_name(&msg.payload)) => {
                    let request_id = msg
                        .payload
                        .get("request_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name = msg
                        .payload
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();

                    info!("Server requested session kill: name={}", name);

                    let (success, error) = match agent.tmux.kill_session(&name).await {
                        Ok(()) => (true, None),
                        Err(e) => (false, Some(e.to_string())),
                    };

                    let response = serde_json::json!({
                        "msg_type": "server.agent.command-response",
                        "id": uuid::Uuid::new_v4().to_string(),
                        "timestamp": chrono::Utc::now().timestamp().unsigned_abs(),
                        "payload": {
                            "request_id": request_id,
                            "command": "session.kill",
                            "success": success,
                            "error": error,
                        }
                    });
                    responses.send(WsMessage::Text(response.to_string())).await?;
    }
    "agent.session.capture-preview" => "agent.session.capture-preview" => Query => {
                    let request_id = str_field(&msg.payload, "request_id");
                    let session_name = str_field(&msg.payload, "session_name");
                    let lines = u32::try_from(
                        msg.payload
                            .get("lines")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(2000),
                    )
                    .unwrap_or(u32::MAX);

                    info!(
                        "Server requested session capture_preview: session_name={}, lines={}",
                        session_name, lines
                    );

                    let (success, ansi_b64, cols, rows, error) = if lines == 0 {
                        (
                            false,
                            None,
                            None,
                            None,
                            Some("invalid_lines: lines must be > 0".to_string()),
                        )
                    } else if lines > 100_000 {
                        (
                            false,
                            None,
                            None,
                            None,
                            Some("lines_too_large: lines exceeds 100000 ceiling".to_string()),
                        )
                    } else {
                        match crate::tmux::util::capture_scrollback(&session_name, lines).await {
                            Ok(Some((bytes, c, r))) => {
                                use base64::Engine;
                                let ansi_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                                info!(
                                    "capture_preview success: session_name={}, ansi_b64 length={}, cols={}, rows={}",
                                    session_name,
                                    ansi_b64.len(),
                                    c,
                                    r
                                );
                                (true, Some(ansi_b64), Some(c), Some(r), None)
                            }
                            Ok(None) => {
                                info!(
                                    "capture_preview success but empty (no scrollback): session_name={}",
                                    session_name
                                );
                                (true, Some(String::new()), Some(80), Some(24), None)
                            }
                            Err(e) => {
                                warn!(
                                    "capture_preview failed: session_name={}, error={}",
                                    session_name, e
                                );
                                (false, None, None, None, Some(e.to_string()))
                            }
                        }
                    };

                    let response = serde_json::json!({
                        "msg_type": "server.agent.command-response",
                        "id": uuid::Uuid::new_v4().to_string(),
                        "timestamp": chrono::Utc::now().timestamp().unsigned_abs(),
                        "payload": {
                            "request_id": request_id,
                            "command": "agent.session.capture-preview",
                            "success": success,
                            "ansi_b64": ansi_b64,
                            "cols": cols,
                            "rows": rows,
                            "error": error,
                        }
                    });
                    responses.send(WsMessage::Text(response.to_string())).await?;
    }
    "agent.session.report" => "agent.session.report" => Query => {
                    let request_id = str_field(&msg.payload, "request_id");

                    // An empty list is a legitimate answer ("no sessions here"),
                    // not a failure — `list_sessions` already maps tmux's
                    // "no server running" to an empty Vec. Only report the raw
                    // fields; the server derives status from `attached_clients`
                    // so the rule lives in exactly one place.
                    let sessions = match agent.tmux.list_sessions().await {
                        Ok(s) => s,
                        Err(e) => {
                            warn!("tmux list-sessions failed: {:#}", e);
                            vec![]
                        }
                    };

                    debug!(
                        "Server requested session list: returning {} session(s)",
                        sessions.len()
                    );

                    let sessions_json: Vec<serde_json::Value> = sessions
                        .iter()
                        .map(|s| {
                            serde_json::json!({
                                "name": s.name,
                                "created_at": s.created_at,
                                "window_count": s.window_count,
                                "attached_clients": s.attached_clients,
                                "foreground_command": s.foreground_command,
                            })
                        })
                        .collect();

                    let response = serde_json::json!({
                        "msg_type": "server.agent.command-response",
                        "id": uuid::Uuid::new_v4().to_string(),
                        "timestamp": chrono::Utc::now().timestamp().unsigned_abs(),
                        "payload": {
                            "request_id": request_id,
                            "command": "sessions.list",
                            "success": true,
                            "sessions": sessions_json,
                        }
                    });
                    responses.send(WsMessage::Text(response.to_string())).await?;
    }
);
