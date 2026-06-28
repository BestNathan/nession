//! WebSocket client for connecting to the central nession-server.
//!
//! The [`ServerClient`] establishes a WebSocket connection to the central server,
//! registers the agent, and sends periodic heartbeats and session updates.

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use nession_common::protocol::{
    AgentHeartbeatPayload, AgentMetadata, AgentRegisterPayload, AgentStatus, HeartbeatMetadata,
    Message, ProtocolMessage,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Mutex};
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
}

/// WebSocket client that connects to the central nession-server.
///
/// The client handles:
/// - Initial connection with TLS support
/// - Agent registration
/// - Heartbeat sending
/// - Session updates
/// - Automatic reconnection with exponential backoff
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
    /// WebSocket sink for sending messages.
    sink: Option<Arc<Mutex<WsSink>>>,
    /// Shutdown signal receiver.
    shutdown_rx: Option<mpsc::Receiver<()>>,
    /// Shutdown signal sender (cloneable handle).
    shutdown_tx: mpsc::Sender<()>,
    /// Agent metadata.
    metadata: AgentMetadata,
    /// Tmux manager for handling session commands.
    tmux: Arc<TmuxManager>,
}

/// Handle to a running [`ServerClient`] for sending messages and shutdown.
#[derive(Clone)]
pub struct ServerClientHandle {
    sink: Arc<Mutex<WsSink>>,
    shutdown_tx: mpsc::Sender<()>,
    agent_id: String,
}

impl ServerClientHandle {
    /// Send a heartbeat message to the server.
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
        let json = serde_json::to_string(&msg)?;
        let mut sink = self.sink.lock().await;
        sink.send(WsMessage::Text(json)).await?;
        Ok(())
    }

    /// Send a session update message to the server.
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
        let json = serde_json::to_string(&msg)?;
        let mut sink = self.sink.lock().await;
        sink.send(WsMessage::Text(json)).await?;
        Ok(())
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
    /// * `metadata` - Agent metadata (tmux version, OS version, etc.)
    pub fn new(
        server_url: impl Into<String>,
        auth_token: impl Into<String>,
        agent_id: impl Into<String>,
        hostname: impl Into<String>,
        ip_address: impl Into<String>,
        port: u16,
        metadata: AgentMetadata,
        tmux: Arc<TmuxManager>,
    ) -> Self {
        let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
        Self {
            server_url: server_url.into(),
            auth_token: auth_token.into(),
            agent_id: agent_id.into(),
            hostname: hostname.into(),
            ip_address: ip_address.into(),
            port,
            sink: None,
            shutdown_rx: Some(shutdown_rx),
            shutdown_tx,
            metadata,
            tmux,
        }
    }

    /// Connect to the server and start the message loop.
    ///
    /// This method will attempt to connect to the server, register the agent,
    /// and then enter a message loop to handle server responses. If the connection
    /// is lost, it will automatically reconnect with exponential backoff.
    ///
    /// Returns a [`ServerClientHandle`] that can be used to send messages and
    /// trigger shutdown.
    pub async fn connect_and_run(mut self) -> Result<ServerClientHandle> {
        let mut reconnect_delay = INITIAL_RECONNECT_DELAY;

        loop {
            match self.try_connect().await {
                Ok(handle) => {
                    info!("Connected to server successfully");
                    // Reset reconnect delay on successful connection (for next time).
                    // Note: This assignment is intentional for future reconnection attempts,
                    // even though the value isn't read before returning.
                    #[allow(unused_assignments)]
                    {
                        reconnect_delay = INITIAL_RECONNECT_DELAY;
                    }
                    return Ok(handle);
                }
                Err(e) => {
                    warn!(
                        "Failed to connect to server: {:#}. Reconnecting in {:?}",
                        e, reconnect_delay
                    );
                    tokio::time::sleep(reconnect_delay).await;
                    // Exponential backoff: double the delay, but cap at MAX_RECONNECT_DELAY.
                    reconnect_delay = std::cmp::min(reconnect_delay * 2, MAX_RECONNECT_DELAY);
                }
            }
        }
    }

    /// Attempt to connect to the server once.
    async fn try_connect(&mut self) -> Result<ServerClientHandle> {
        info!("Connecting to server at {}", self.server_url);

        // Connect to WebSocket server.
        let (ws_stream, _) = connect_async(&self.server_url)
            .await
            .context("failed to connect to server")?;

        let (ws_sink, ws_stream) = ws_stream.split();
        let sink = Arc::new(Mutex::new(ws_sink));

        // Register the agent.
        self.register(&sink).await?;

        // Store the sink for later use.
        self.sink = Some(sink.clone());

        // Take the shutdown receiver (only once).
        let shutdown_rx = self
            .shutdown_rx
            .take()
            .context("shutdown_rx already taken")?;

        let handle = ServerClientHandle {
            sink: sink.clone(),
            shutdown_tx: self.shutdown_tx.clone(),
            agent_id: self.agent_id.clone(),
        };

        // Spawn a task to handle incoming messages and shutdown.
        let agent_id = self.agent_id.clone();
        let tmux = self.tmux.clone();
        tokio::spawn(async move {
            Self::run_message_loop(ws_stream, sink, shutdown_rx, agent_id, tmux).await;
        });

        Ok(handle)
    }

    /// Send registration message to the server.
    async fn register(&self, sink: &Arc<Mutex<WsSink>>) -> Result<()> {
        let payload = AgentRegisterPayload {
            agent_id: self.agent_id.clone(),
            hostname: self.hostname.clone(),
            ip_address: self.ip_address.clone(),
            port: self.port,
            auth_token: self.auth_token.clone(),
            metadata: self.metadata.clone(),
            protocol_version: "1.0".to_string(),
        };

        let msg = new_message(msg_types::AGENT_REGISTER, payload);
        let json = serde_json::to_string(&msg)?;

        let mut sink_lock = sink.lock().await;
        sink_lock
            .send(WsMessage::Text(json))
            .await
            .context("failed to send registration message")?;

        info!("Sent registration message for agent {}", self.agent_id);
        Ok(())
    }

    /// Run the message loop to handle incoming messages and shutdown signals.
    async fn run_message_loop(
        mut ws_stream: WsStreamHalf,
        sink: Arc<Mutex<WsSink>>,
        mut shutdown_rx: mpsc::Receiver<()>,
        agent_id: String,
        tmux: Arc<TmuxManager>,
    ) {
        loop {
            tokio::select! {
                // Handle incoming WebSocket messages.
                msg = ws_stream.next() => {
                    match msg {
                        Some(Ok(WsMessage::Text(text))) => {
                            if let Err(e) = Self::handle_server_message(&text, &sink, &agent_id, &tmux).await {
                                warn!("Error handling server message: {:#}", e);
                            }
                        }
                        Some(Ok(WsMessage::Close(_))) => {
                            info!("Server closed connection");
                            break;
                        }
                        Some(Ok(WsMessage::Ping(data))) => {
                            let mut sink_lock = sink.lock().await;
                            let _ = sink_lock.send(WsMessage::Pong(data)).await;
                        }
                        Some(Err(e)) => {
                            error!("WebSocket error: {:#}", e);
                            break;
                        }
                        None => {
                            info!("WebSocket stream ended");
                            break;
                        }
                        _ => {}
                    }
                }
                // Handle shutdown signal.
                _ = shutdown_rx.recv() => {
                    info!("Shutdown signal received");
                    let mut sink_lock = sink.lock().await;
                    let _ = sink_lock.send(WsMessage::Close(None)).await;
                    break;
                }
            }
        }
    }

    /// Handle a message received from the server.
    async fn handle_server_message(
        text: &str,
        sink: &Arc<Mutex<WsSink>>,
        agent_id: &str,
        tmux: &TmuxManager,
    ) -> Result<()> {
        let msg: ProtocolMessage<serde_json::Value> = serde_json::from_str(text)
            .context("failed to parse server message")?;

        match msg.msg_type.as_str() {
            msg_types::AGENT_REGISTER_RESPONSE => {
                let response: RegisterResponsePayload =
                    serde_json::from_value(msg.payload)?;
                if response.status == "accepted" {
                    info!(
                        "Agent {} registration accepted: {}",
                        agent_id, response.message
                    );
                } else {
                    error!(
                        "Agent {} registration rejected: {}",
                        agent_id, response.message
                    );
                }
            }
            "server.session.create" => {
                let request_id = msg.payload["request_id"].as_str().unwrap_or("").to_string();
                let name = msg.payload["name"].as_str().unwrap_or("").to_string();
                let width = msg.payload["width"].as_u64().unwrap_or(80) as u16;
                let height = msg.payload["height"].as_u64().unwrap_or(24) as u16;

                info!("Server requested session create: name={}, width={}, height={}", name, width, height);

                let (success, error, session_name) = match tmux.create_session(&name, width, height).await {
                    Ok(()) => (true, None, Some(name.clone())),
                    Err(e) => (false, Some(e.to_string()), None),
                };

                let response = serde_json::json!({
                    "msg_type": "agent.session.command.response",
                    "id": uuid::Uuid::new_v4().to_string(),
                    "timestamp": chrono::Utc::now().timestamp() as u64,
                    "payload": {
                        "request_id": request_id,
                        "command": "session.create",
                        "success": success,
                        "error": error,
                        "session_name": session_name,
                    }
                });

                let mut sink_lock = sink.lock().await;
                sink_lock.send(WsMessage::Text(response.to_string())).await?;
            }
            "server.session.kill" => {
                let request_id = msg.payload["request_id"].as_str().unwrap_or("").to_string();
                let name = msg.payload["name"].as_str().unwrap_or("").to_string();

                info!("Server requested session kill: name={}", name);

                let (success, error) = match tmux.kill_session(&name).await {
                    Ok(()) => (true, None),
                    Err(e) => (false, Some(e.to_string())),
                };

                let response = serde_json::json!({
                    "msg_type": "agent.session.command.response",
                    "id": uuid::Uuid::new_v4().to_string(),
                    "timestamp": chrono::Utc::now().timestamp() as u64,
                    "payload": {
                        "request_id": request_id,
                        "command": "session.kill",
                        "success": success,
                        "error": error,
                    }
                });

                let mut sink_lock = sink.lock().await;
                sink_lock.send(WsMessage::Text(response.to_string())).await?;
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

/// Helper function to create a new message with a unique ID and timestamp.
fn new_message<P: Serialize>(msg_type: &str, payload: P) -> ProtocolMessage<P> {
    Message {
        msg_type: msg_type.to_string(),
        id: uuid::Uuid::new_v4().to_string(),
        timestamp: chrono::Utc::now().timestamp() as u64,
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
            metadata,
            Arc::new(TmuxManager::new()),
        );

        let handle = client.connect_and_run().await.expect("connect failed");

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
            metadata,
            Arc::new(TmuxManager::new()),
        );

        let handle = client.connect_and_run().await.expect("connect failed");

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
            metadata,
            Arc::new(TmuxManager::new()),
        );

        let handle = client.connect_and_run().await.expect("connect failed");

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
}
