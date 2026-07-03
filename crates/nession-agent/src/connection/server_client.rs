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

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use nession_common::protocol::{
    AgentHeartbeatPayload, AgentMetadata, AgentRegisterPayload, AgentStatus, HeartbeatMetadata,
    Message, ProtocolMessage,
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::{
    connect_async, tungstenite::protocol::Message as WsMessage, MaybeTlsStream, WebSocketStream,
};
use tracing::{debug, error, info, warn};

use crate::tmux::manager::TmuxManager;

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

/// Message type constants for agent-to-server protocol.
pub mod msg_types {
    pub const AGENT_REGISTER: &str = "agent.register";
    pub const AGENT_REGISTER_RESPONSE: &str = "agent.register.response";
    pub const AGENT_HEARTBEAT: &str = "agent.heartbeat";
    pub const AGENT_SESSION_UPDATE: &str = "agent.session.update";
    pub const SERVER_HEARTBEAT_ACK: &str = "server.heartbeat.ack";
}

/// Payload for session update messages.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionUpdatePayload {
    pub agent_id: String,
    pub session_name: String,
    pub status: String,
    pub window_count: u32,
    pub attached_clients: u32,
}

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
    /// Default working directory for new tmux sessions.
    default_working_dir: String,
    /// Agent metadata.
    metadata: AgentMetadata,
    /// Tmux manager for handling session commands.
    tmux: Arc<TmuxManager>,
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
            },
        };
        let msg = new_message(msg_types::AGENT_HEARTBEAT, payload);
        self.enqueue(&msg)
    }

    /// Queue a session update message for delivery to the server.
    pub async fn send_session_update(
        &self,
        session_name: &str,
        status: &str,
        window_count: u32,
        attached_clients: u32,
    ) -> Result<()> {
        let payload = SessionUpdatePayload {
            agent_id: self.agent_id.clone(),
            session_name: session_name.to_string(),
            status: status.to_string(),
            window_count,
            attached_clients,
        };
        let msg = new_message(msg_types::AGENT_SESSION_UPDATE, payload);
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
        metadata: AgentMetadata,
        tmux: Arc<TmuxManager>,
        default_working_dir: String,
    ) -> Self {
        Self {
            server_url: server_url.into(),
            auth_token: auth_token.into(),
            agent_id: agent_id.into(),
            hostname: hostname.into(),
            ip_address: ip_address.into(),
            port,
            connect_url,
            default_working_dir,
            metadata,
            tmux,
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
        let (interval_tx, mut interval_rx) = mpsc::channel::<Option<u64>>(1);
        let sync_needed = Arc::new(AtomicBool::new(false));
        let connected = Arc::new(AtomicBool::new(false));

        let handle = ServerClientHandle {
            outbox: outbox_tx,
            shutdown_tx,
            agent_id: self.agent_id.clone(),
            sync_needed: sync_needed.clone(),
            connected: connected.clone(),
        };

        // Spawn the supervisor; it owns the reconnect loop and never returns
        // until shutdown.
        tokio::spawn(async move {
            self.supervise(outbox_rx, shutdown_rx, interval_tx, sync_needed, connected)
                .await;
        });

        // Wait (briefly) for the first registration to report the interval.
        let interval = interval_rx.recv().await.flatten();
        Ok((handle, interval))
    }

    /// Supervisor loop: connect → register → service → reconnect, forever.
    async fn supervise(
        self,
        mut outbox_rx: mpsc::UnboundedReceiver<WsMessage>,
        mut shutdown_rx: mpsc::Receiver<()>,
        interval_tx: mpsc::Sender<Option<u64>>,
        sync_needed: Arc<AtomicBool>,
        connected: Arc<AtomicBool>,
    ) {
        let mut reconnect_delay = INITIAL_RECONNECT_DELAY;
        let mut reported_interval = false;

        loop {
            // Bail out immediately if shutdown was requested between attempts.
            if shutdown_rx.try_recv().is_ok() {
                info!("Server client shutting down before reconnect");
                return;
            }

            match self.connect_once().await {
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
                        let _ = interval_tx.try_send(interval);
                        reported_interval = true;
                    }

                    // Service the live connection until it drops or shutdown.
                    let outcome = self
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
                    // Make sure connect_and_run doesn't block forever if the
                    // very first connection fails.
                    if !reported_interval {
                        let _ = interval_tx.try_send(None);
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
            protocol_version: "1.0".to_string(),
            connect_url: self.connect_url.clone(),
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
                    if resp.msg_type == msg_types::AGENT_REGISTER_RESPONSE {
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
                            anyhow::bail!("registration rejected by server: {}", payload.message);
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

    /// Service a live connection: forward queued outgoing messages, handle
    /// incoming server messages, respond to pings, and watch for shutdown.
    /// Returns whether the loop ended due to shutdown or a dropped connection.
    async fn run_connection(
        &self,
        mut sink: WsSink,
        mut stream: WsStreamHalf,
        outbox_rx: &mut mpsc::UnboundedReceiver<WsMessage>,
        shutdown_rx: &mut mpsc::Receiver<()>,
    ) -> ConnectionOutcome {
        loop {
            tokio::select! {
                // Outgoing: drain the outbox onto the live socket.
                outgoing = outbox_rx.recv() => {
                    match outgoing {
                        Some(msg) => {
                            if let Err(e) = sink.send(msg).await {
                                warn!("Failed to send to server: {:#}", e);
                                return ConnectionOutcome::Disconnected;
                            }
                        }
                        None => {
                            // Outbox closed: handle dropped, treat as shutdown.
                            return ConnectionOutcome::Shutdown;
                        }
                    }
                }
                // Incoming: server messages, pings, close.
                incoming = stream.next() => {
                    match incoming {
                        Some(Ok(WsMessage::Text(text))) => {
                            if let Err(e) = self.handle_server_message(&text, &mut sink).await {
                                warn!("Error handling server message: {:#}", e);
                            }
                        }
                        Some(Ok(WsMessage::Ping(data))) => {
                            let _ = sink.send(WsMessage::Pong(data)).await;
                        }
                        Some(Ok(WsMessage::Close(_))) => {
                            info!("Server closed connection");
                            return ConnectionOutcome::Disconnected;
                        }
                        Some(Ok(_)) => {}
                        Some(Err(e)) => {
                            error!("WebSocket error: {:#}", e);
                            return ConnectionOutcome::Disconnected;
                        }
                        None => {
                            info!("WebSocket stream ended");
                            return ConnectionOutcome::Disconnected;
                        }
                    }
                }
                // Shutdown: close the socket and stop the supervisor.
                _ = shutdown_rx.recv() => {
                    info!("Shutdown signal received");
                    let _ = sink.send(WsMessage::Close(None)).await;
                    return ConnectionOutcome::Shutdown;
                }
            }
        }
    }

    /// Handle a message received from the server, writing any response directly
    /// to the connection's sink.
    async fn handle_server_message(&self, text: &str, sink: &mut WsSink) -> Result<()> {
        let msg: ProtocolMessage<serde_json::Value> =
            serde_json::from_str(text).context("failed to parse server message")?;

        match msg.msg_type.as_str() {
            msg_types::AGENT_REGISTER_RESPONSE => {
                // Already handled during connect; log late/duplicate responses.
                debug!("Late registration response ignored");
            }
            msg_types::SERVER_HEARTBEAT_ACK => {
                debug!("Heartbeat acknowledged by server");
            }
            "server.session.create" => {
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
                let width = u16::try_from(
                    msg.payload
                        .get("width")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(80),
                )
                .unwrap_or(80);
                let height = u16::try_from(
                    msg.payload
                        .get("height")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(24),
                )
                .unwrap_or(24);

                info!(
                    "Server requested session create: name={}, width={}, height={}",
                    name, width, height
                );

                let (success, error, session_name) = match self
                    .tmux
                    .create_session(&name, width, height, &self.default_working_dir)
                    .await
                {
                    Ok(()) => (true, None, Some(name.clone())),
                    Err(e) => (false, Some(e.to_string()), None),
                };

                let response = serde_json::json!({
                    "msg_type": "agent.session.command.response",
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
                sink.send(WsMessage::Text(response.to_string())).await?;
            }
            "server.session.kill" => {
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

                let (success, error) = match self.tmux.kill_session(&name).await {
                    Ok(()) => (true, None),
                    Err(e) => (false, Some(e.to_string())),
                };

                let response = serde_json::json!({
                    "msg_type": "agent.session.command.response",
                    "id": uuid::Uuid::new_v4().to_string(),
                    "timestamp": chrono::Utc::now().timestamp().unsigned_abs(),
                    "payload": {
                        "request_id": request_id,
                        "command": "session.kill",
                        "success": success,
                        "error": error,
                    }
                });
                sink.send(WsMessage::Text(response.to_string())).await?;
            }
            _ => {
                debug!(
                    "Received message from server: {} (id: {})",
                    msg.msg_type, msg.id
                );
            }
        }

        Ok(())
    }
}

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    /// Start a mock WebSocket server that accepts connections and echoes messages.
    async fn start_mock_server(port: u16) -> (tokio::task::JoinHandle<()>, mpsc::Receiver<String>) {
        let (msg_tx, msg_rx) = mpsc::channel(100);
        let listener = TcpListener::bind(format!("127.0.0.1:{}", port))
            .await
            .expect("failed to bind mock server");

        let handle = tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                let ws = accept_async(stream).await.expect("failed to accept ws");
                let (mut sink, mut stream) = ws.split();

                // Send a registration response.
                let response = serde_json::json!({
                    "msg_type": "agent.register.response",
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

        (handle, msg_rx)
    }

    #[tokio::test]
    async fn test_connection_and_registration() {
        let port = 28081;
        let (server_handle, mut msg_rx) = start_mock_server(port).await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let metadata = AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
        };

        let client = ServerClient::new(
            format!("ws://127.0.0.1:{}", port),
            "test-token",
            "test-agent-1",
            "test-host",
            "127.0.0.1",
            8080,
            None, // connect_url
            metadata,
            Arc::new(TmuxManager::new()),
            "/tmp".to_string(),
        );

        let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

        // Wait for registration message.
        let msg = tokio::time::timeout(Duration::from_secs(2), msg_rx.recv())
            .await
            .expect("timeout waiting for registration")
            .expect("no message received");

        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(parsed["msg_type"], "agent.register");
        assert_eq!(parsed["payload"]["agent_id"], "test-agent-1");
        assert_eq!(parsed["payload"]["hostname"], "test-host");
        assert_eq!(parsed["payload"]["port"], 8080);

        handle.shutdown().await.ok();
        server_handle.abort();
    }

    #[tokio::test]
    async fn test_heartbeat_message_format() {
        let port = 28082;
        let (server_handle, mut msg_rx) = start_mock_server(port).await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let metadata = AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
        };

        let client = ServerClient::new(
            format!("ws://127.0.0.1:{}", port),
            "test-token",
            "test-agent-2",
            "test-host",
            "127.0.0.1",
            8080,
            None, // connect_url
            metadata,
            Arc::new(TmuxManager::new()),
            "/tmp".to_string(),
        );

        let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

        // Skip registration message.
        let _ = msg_rx.recv().await;

        // Send heartbeat.
        handle
            .send_heartbeat(AgentStatus::Online, 5, 2, 3600, [1.0, 2.0, 3.0])
            .await
            .expect("heartbeat failed");

        let msg = tokio::time::timeout(Duration::from_secs(2), msg_rx.recv())
            .await
            .expect("timeout waiting for heartbeat")
            .expect("no message received");

        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(parsed["msg_type"], "agent.heartbeat");
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
        let port = 28083;
        let (server_handle, mut msg_rx) = start_mock_server(port).await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let metadata = AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
        };

        let client = ServerClient::new(
            format!("ws://127.0.0.1:{}", port),
            "test-token",
            "test-agent-3",
            "test-host",
            "127.0.0.1",
            8080,
            None, // connect_url
            metadata,
            Arc::new(TmuxManager::new()),
            "/tmp".to_string(),
        );

        let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

        // Skip registration message.
        let _ = msg_rx.recv().await;

        // Send session update.
        handle
            .send_session_update("test-session", "active", 3, 1)
            .await
            .expect("session update failed");

        let msg = tokio::time::timeout(Duration::from_secs(2), msg_rx.recv())
            .await
            .expect("timeout waiting for session update")
            .expect("no message received");

        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(parsed["msg_type"], "agent.session.update");
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
        port: u16,
        interval_secs: u64,
    ) -> tokio::task::JoinHandle<()> {
        let listener = TcpListener::bind(format!("127.0.0.1:{}", port))
            .await
            .expect("failed to bind mock server");
        tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                let ws = accept_async(stream).await.expect("failed to accept ws");
                let (mut sink, mut stream) = ws.split();
                let response = serde_json::json!({
                    "msg_type": "agent.register.response",
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
        })
    }

    #[tokio::test]
    async fn test_register_response_conveys_heartbeat_interval() {
        let port = 28084;
        let server_handle = start_mock_server_with_interval(port, 42).await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let metadata = AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
        };
        let client = ServerClient::new(
            format!("ws://127.0.0.1:{}", port),
            "test-token",
            "test-agent-iv",
            "test-host",
            "127.0.0.1",
            8080,
            None, // connect_url
            metadata,
            Arc::new(TmuxManager::new()),
            "/tmp".to_string(),
        );

        let (handle, interval) = client.connect_and_run().await.expect("connect failed");
        assert_eq!(interval, Some(42));

        handle.shutdown().await.ok();
        server_handle.abort();
    }

    #[tokio::test]
    async fn test_supervisor_reconnects_after_drop() {
        let port = 28085;

        // Server that accepts a first connection, registers, then drops it;
        // accepts a second connection and forwards the agent_id of whatever it
        // receives so the test can confirm a re-registration happened.
        let (re_tx, mut re_rx) = mpsc::channel::<String>(4);
        let listener = TcpListener::bind(format!("127.0.0.1:{}", port))
            .await
            .expect("bind");
        let server_handle = tokio::spawn(async move {
            for round in 0..2u32 {
                if let Ok((stream, _)) = listener.accept().await {
                    let ws = accept_async(stream).await.expect("accept ws");
                    let (mut sink, mut stream) = ws.split();
                    let response = serde_json::json!({
                        "msg_type": "agent.register.response",
                        "id": "test-id",
                        "timestamp": 1,
                        "payload": { "status": "accepted", "message": "ok" }
                    });
                    let _ = sink.send(WsMessage::Text(response.to_string())).await;

                    // Read the register message and report it.
                    if let Some(Ok(WsMessage::Text(text))) = stream.next().await {
                        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
                        if parsed["msg_type"] == "agent.register" {
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
        };
        let client = ServerClient::new(
            format!("ws://127.0.0.1:{}", port),
            "test-token",
            "reconnect-agent",
            "test-host",
            "127.0.0.1",
            8080,
            None, // connect_url
            metadata,
            Arc::new(TmuxManager::new()),
            "/tmp".to_string(),
        );
        let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

        // First registration.
        let first = tokio::time::timeout(Duration::from_secs(2), re_rx.recv())
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
}
