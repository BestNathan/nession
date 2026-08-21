//! Client WebSocket connection to central server.

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    connect_async, tungstenite::protocol::Message, MaybeTlsStream, WebSocketStream,
};
use tracing::{debug, info};
use uuid::Uuid;

/// Client connection to the central server.
#[derive(Debug)]
pub struct ClientConnection {
    ws_stream: WebSocketStream<MaybeTlsStream<TcpStream>>,
    authenticated: bool,
}

/// Generate a persistent client ID for this CLI installation.
///
/// This ID is used to track which client sourced which environment variables,
/// allowing proper cleanup when the client disconnects without affecting other
/// clients' environment variables.
///
/// The ID is generated once and cached in memory for the duration of the process.
fn get_or_create_client_id() -> String {
    // For now, generate a new ID each time the process starts.
    // In the future, this could be persisted to a file for true persistence
    // across CLI invocations, similar to the web UI's localStorage approach.
    Uuid::new_v4().to_string()
}

/// Agent information returned from the server.
#[derive(Debug, Clone, serde::Deserialize)]
#[allow(dead_code)]
pub struct AgentInfo {
    pub agent_id: String,
    pub hostname: String,
    pub ip_address: String,
    pub port: u16,
    pub status: String,
    pub session_count: u32,
    pub last_heartbeat: String,
}

/// Session information returned from the server.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct SessionInfo {
    pub session_id: String,
    pub agent_id: String,
    pub session_name: String,
    pub status: String,
    pub window_count: u32,
    pub attached_clients: u32,
}

/// P2P connection info returned from the server for direct agent connection.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct P2PAttachInfo {
    pub agent_address: String,
    #[allow(dead_code)]
    pub connection_token: String,
    pub session_name: String,
}

/// Result of an attach request to the central server.
#[derive(Debug, Clone)]
pub enum AttachResponse {
    /// P2P mode: connect directly to agent at the given address.
    P2P(P2PAttachInfo),
    /// Relay mode: the server is relaying I/O on the existing connection.
    Relay,
}

impl ClientConnection {
    /// Connect to the server with WebSocket (supports TLS).
    pub async fn connect(server_url: &str, auth_token: &str) -> Result<Self> {
        info!("Connecting to server: {}", server_url);

        let (ws_stream, _) = connect_async(server_url)
            .await
            .with_context(|| format!("Failed to connect to server at {server_url}"))?;

        info!("WebSocket connection established");

        let mut conn = Self {
            ws_stream,
            authenticated: false,
        };

        // Generate a persistent client ID for this connection
        let client_id = get_or_create_client_id();
        info!("Using client ID: {}", client_id);

        // Authenticate
        conn.authenticate(auth_token, &client_id).await?;

        Ok(conn)
    }

    /// Authenticate with the server.
    async fn authenticate(&mut self, auth_token: &str, client_id: &str) -> Result<()> {
        let msg_id = format!(
            "auth_{}",
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis()
        );
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();

        let auth_msg = json!({
            "msg_type": "client.auth",
            "id": msg_id,
            "timestamp": timestamp,
            "payload": {
                "auth_token": auth_token,
                "client_id": client_id
            }
        });

        debug!("Sending auth message: {}", auth_msg);
        self.ws_stream
            .send(Message::Text(auth_msg.to_string()))
            .await?;

        // Wait for auth response
        if let Some(msg) = self.ws_stream.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    let response: serde_json::Value = serde_json::from_str(&text)?;
                    let msg_type = response
                        .get("msg_type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");

                    if msg_type == "client.auth.response" {
                        let status = response
                            .get("payload")
                            .and_then(|v| v.get("status"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let message = response
                            .get("payload")
                            .and_then(|v| v.get("message"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("");

                        if status == "success" {
                            self.authenticated = true;
                            info!("Authentication successful");
                            Ok(())
                        } else {
                            anyhow::bail!("Authentication failed: {message}")
                        }
                    } else {
                        anyhow::bail!(
                            "Unexpected response: expected client.auth.response, got {msg_type}"
                        )
                    }
                }
                Ok(_) => anyhow::bail!("Unexpected message type from server"),
                Err(e) => anyhow::bail!("Error receiving auth response: {e}"),
            }
        } else {
            anyhow::bail!("Server closed connection during authentication")
        }
    }

    /// List all agents from the server.
    pub async fn list_agents(&mut self) -> Result<Vec<AgentInfo>> {
        if !self.authenticated {
            anyhow::bail!("Not authenticated");
        }

        let msg_id = format!(
            "agents_{}",
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis()
        );
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();

        let request = json!({
            "msg_type": "client.agents.list",
            "id": msg_id,
            "timestamp": timestamp,
            "payload": {}
        });

        debug!("Sending agents list request: {}", request);
        self.ws_stream
            .send(Message::Text(request.to_string()))
            .await?;

        // Wait for response
        if let Some(msg) = self.ws_stream.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    let response: serde_json::Value = serde_json::from_str(&text)?;
                    let msg_type = response
                        .get("msg_type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");

                    if msg_type == "client.agents.list.response" {
                        let agents: Vec<AgentInfo> = serde_json::from_value(
                            response
                                .get("payload")
                                .and_then(|v| v.get("agents"))
                                .cloned()
                                .unwrap_or(serde_json::Value::Null),
                        )?;
                        Ok(agents)
                    } else {
                        anyhow::bail!(
                            "Unexpected response: expected client.agents.list.response, got {msg_type}"
                        )
                    }
                }
                Ok(_) => anyhow::bail!("Unexpected message type from server"),
                Err(e) => anyhow::bail!("Error receiving agents list: {e}"),
            }
        } else {
            anyhow::bail!("Server closed connection")
        }
    }

    /// List all sessions from the server, optionally filtered by agent_id.
    pub async fn list_sessions(&mut self, agent_id: Option<&str>) -> Result<Vec<SessionInfo>> {
        if !self.authenticated {
            anyhow::bail!("Not authenticated");
        }

        let msg_id = format!(
            "sessions_{}",
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis()
        );
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();

        let mut payload = json!({});
        if let Some(agent) = agent_id {
            if let Some(obj) = payload.as_object_mut() {
                obj.insert("agent_id".to_string(), json!(agent));
            }
        }

        let request = json!({
            "msg_type": "client.sessions.list",
            "id": msg_id,
            "timestamp": timestamp,
            "payload": payload
        });

        debug!("Sending sessions list request: {}", request);
        self.ws_stream
            .send(Message::Text(request.to_string()))
            .await?;

        // Wait for response
        if let Some(msg) = self.ws_stream.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    let response: serde_json::Value = serde_json::from_str(&text)?;
                    let msg_type = response
                        .get("msg_type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");

                    if msg_type == "client.sessions.list.response" {
                        let sessions: Vec<SessionInfo> = serde_json::from_value(
                            response
                                .get("payload")
                                .and_then(|v| v.get("sessions"))
                                .cloned()
                                .unwrap_or(serde_json::Value::Null),
                        )?;
                        Ok(sessions)
                    } else {
                        anyhow::bail!(
                            "Unexpected response: expected client.sessions.list.response, got {msg_type}"
                        )
                    }
                }
                Ok(_) => anyhow::bail!("Unexpected message type from server"),
                Err(e) => anyhow::bail!("Error receiving sessions list: {e}"),
            }
        } else {
            anyhow::bail!("Server closed connection")
        }
    }

    /// Request to attach to a session. Sends `client.session.attach` with the
    /// given preferred mode. Returns either P2P connection info (to connect
    /// directly to the agent) or Relay (the server relays I/O).
    pub async fn request_attach(
        &mut self,
        session_id: &str,
        preferred_mode: &str,
    ) -> Result<AttachResponse> {
        if !self.authenticated {
            anyhow::bail!("Not authenticated");
        }

        let msg_id = format!(
            "attach_{}",
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis()
        );
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();

        let request = json!({
            "msg_type": "client.session.attach",
            "id": msg_id,
            "timestamp": timestamp,
            "payload": {
                "session_id": session_id,
                "preferred_mode": preferred_mode
            }
        });

        debug!("Sending session attach request: {}", request);
        self.ws_stream
            .send(Message::Text(request.to_string()))
            .await?;

        // Wait for response
        if let Some(msg) = self.ws_stream.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    let response: serde_json::Value = serde_json::from_str(&text)?;
                    let msg_type = response
                        .get("msg_type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");

                    if msg_type != "client.session.attach.response" {
                        anyhow::bail!(
                            "Unexpected response: expected client.session.attach.response, got {msg_type}"
                        );
                    }

                    let status = response
                        .get("payload")
                        .and_then(|v| v.get("status"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if status != "success" {
                        let message = response
                            .get("payload")
                            .and_then(|v| v.get("message"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown error");
                        anyhow::bail!("Attach request failed: {message}");
                    }

                    let mode = response
                        .get("payload")
                        .and_then(|v| v.get("mode"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("relay");
                    if mode == "relay" {
                        Ok(AttachResponse::Relay)
                    } else {
                        let p2p: P2PAttachInfo = serde_json::from_value(
                            response
                                .get("payload")
                                .cloned()
                                .unwrap_or(serde_json::Value::Null),
                        )?;
                        Ok(AttachResponse::P2P(p2p))
                    }
                }
                Ok(_) => anyhow::bail!("Unexpected message type from server"),
                Err(e) => anyhow::bail!("Error receiving attach response: {e}"),
            }
        } else {
            anyhow::bail!("Server closed connection")
        }
    }

    /// Split the underlying WebSocket stream for relay-mode terminal I/O.
    /// Returns (sink, stream) halves that can be used as a TerminalTransport.
    pub fn into_relay_transport(self) -> WebSocketStream<MaybeTlsStream<TcpStream>> {
        self.ws_stream
    }

    /// Close the connection gracefully.
    pub async fn close(&mut self) -> Result<()> {
        info!("Closing connection");
        self.ws_stream.close(None).await?;
        Ok(())
    }
}

/// Connect to an agent's WebSocket server for P2P terminal I/O.
/// `agent_address` is a complete WebSocket URL (e.g. "ws://agent.example.com/ws").
/// Returns the WebSocketStream for use as a TerminalTransport.
pub async fn connect_to_agent(
    agent_address: &str,
) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>> {
    info!("Connecting to agent at: {}", agent_address);

    let (ws_stream, _) = connect_async(agent_address)
        .await
        .with_context(|| format!("Failed to connect to agent at {agent_address}"))?;

    info!("Agent WebSocket connection established");
    Ok(ws_stream)
}

/// Create a new tmux session directly on an agent via its WebSocket server.
///
/// Connects to the agent at `agent_address` (host:port), sends a
/// `session.create` message, and waits for the response. The agent does not
/// require authentication for management operations.
///
/// Returns the name of the created session on success.
pub async fn create_session_on_agent(
    agent_address: &str,
    session_name: &str,
    width: u16,
    height: u16,
) -> Result<String> {
    use futures_util::StreamExt;

    let url = format!("ws://{agent_address}");
    info!("Connecting to agent at {} to create session", url);

    let (mut ws_stream, _) = connect_async(&url)
        .await
        .with_context(|| format!("Failed to connect to agent at {url}"))?;

    let msg_id = format!(
        "create_{}",
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis()
    );
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();

    let request = json!({
        "msg_type": "session.create",
        "id": msg_id,
        "timestamp": timestamp,
        "payload": {
            "name": session_name,
            "width": width,
            "height": height
        }
    });

    debug!("Sending session.create to agent: {}", request);
    ws_stream
        .send(Message::Text(request.to_string()))
        .await
        .with_context(|| "Failed to send session.create to agent")?;

    // Wait for response
    if let Some(msg) = ws_stream.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                let response: serde_json::Value = serde_json::from_str(&text)?;
                let resp_type = response
                    .get("msg_type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                if resp_type == "ok" {
                    let name = response
                        .get("payload")
                        .and_then(|v| v.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or(session_name)
                        .to_string();
                    info!("Session '{}' created on agent", name);
                    Ok(name)
                } else if resp_type == "error" {
                    let code = response
                        .get("payload")
                        .and_then(|v| v.get("code"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let message = response
                        .get("payload")
                        .and_then(|v| v.get("message"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown error");
                    anyhow::bail!("Agent error ({code}): {message}")
                } else {
                    anyhow::bail!(
                        "Unexpected response from agent: expected 'ok' or 'error', got '{resp_type}'"
                    )
                }
            }
            Ok(_) => anyhow::bail!("Unexpected message type from agent"),
            Err(e) => anyhow::bail!("Error receiving response from agent: {e}"),
        }
    } else {
        anyhow::bail!("Agent closed connection during session creation")
    }
}

/// Kill a tmux session directly on an agent via its WebSocket server.
///
/// Connects to the agent at `agent_address` (host:port), sends a
/// `session.kill` message, and waits for the response.
///
/// Returns the name of the killed session on success.
pub async fn kill_session_on_agent(agent_address: &str, session_name: &str) -> Result<String> {
    use futures_util::StreamExt;

    let url = format!("ws://{agent_address}");
    info!("Connecting to agent at {} to kill session", url);

    let (mut ws_stream, _) = connect_async(&url)
        .await
        .with_context(|| format!("Failed to connect to agent at {url}"))?;

    let msg_id = format!(
        "kill_{}",
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis()
    );
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();

    let request = json!({
        "msg_type": "session.kill",
        "id": msg_id,
        "timestamp": timestamp,
        "payload": {
            "name": session_name
        }
    });

    debug!("Sending session.kill to agent: {}", request);
    ws_stream
        .send(Message::Text(request.to_string()))
        .await
        .with_context(|| "Failed to send session.kill to agent")?;

    // Wait for response
    if let Some(msg) = ws_stream.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                let response: serde_json::Value = serde_json::from_str(&text)?;
                let resp_type = response
                    .get("msg_type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                if resp_type == "ok" {
                    let name = response
                        .get("payload")
                        .and_then(|v| v.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or(session_name)
                        .to_string();
                    info!("Session '{}' killed on agent", name);
                    Ok(name)
                } else if resp_type == "error" {
                    let code = response
                        .get("payload")
                        .and_then(|v| v.get("code"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let message = response
                        .get("payload")
                        .and_then(|v| v.get("message"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown error");
                    anyhow::bail!("Agent error ({code}): {message}")
                } else {
                    anyhow::bail!(
                        "Unexpected response from agent: expected 'ok' or 'error', got '{resp_type}'"
                    )
                }
            }
            Ok(_) => anyhow::bail!("Unexpected message type from agent"),
            Err(e) => anyhow::bail!("Error receiving response from agent: {e}"),
        }
    } else {
        anyhow::bail!("Agent closed connection during session kill")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    /// Start a mock WebSocket server that accepts connections and echoes messages.
    /// Binds an OS-assigned port. A hardcoded one collides whenever two test
    /// runs overlap — two worktrees, or CI alongside a local run.
    async fn start_mock_server() -> (tokio::task::JoinHandle<()>, SocketAddr) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("failed to bind mock server");
        let addr = listener.local_addr().unwrap();

        let handle = tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                let ws = accept_async(stream).await.expect("failed to accept ws");
                let (mut sink, mut stream) = ws.split();

                // Echo messages back
                while let Some(Ok(msg)) = stream.next().await {
                    if let Message::Text(text) = msg {
                        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
                        let msg_type = parsed
                            .get("msg_type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");

                        let response = match msg_type {
                            "client.auth" => {
                                let token = parsed
                                    .get("payload")
                                    .and_then(|v| v.get("auth_token"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");

                                let client_id = parsed
                                    .get("payload")
                                    .and_then(|v| v.get("client_id"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");

                                if token == "valid_token" {
                                    json!({
                                        "msg_type": "client.auth.response",
                                        "id": parsed.get("id").unwrap(),
                                        "timestamp": 0,
                                        "payload": {
                                            "status": "success",
                                            "message": "ok",
                                            "client_id": client_id
                                        }
                                    })
                                } else {
                                    json!({
                                        "msg_type": "client.auth.response",
                                        "id": parsed.get("id").unwrap(),
                                        "timestamp": 0,
                                        "payload": {
                                            "status": "failed",
                                            "message": "invalid token"
                                        }
                                    })
                                }
                            }
                            "client.agents.list" => {
                                json!({
                                    "msg_type": "client.agents.list.response",
                                    "id": parsed.get("id").unwrap(),
                                    "timestamp": 0,
                                    "payload": {
                                        "agents": [
                                            {
                                                "agent_id": "agent1",
                                                "hostname": "host1",
                                                "ip_address": "127.0.0.1",
                                                "port": 8080,
                                                "status": "online",
                                                "session_count": 2,
                                                "last_heartbeat": "2024-01-01T00:00:00Z"
                                            }
                                        ]
                                    }
                                })
                            }
                            "client.sessions.list" => {
                                json!({
                                    "msg_type": "client.sessions.list.response",
                                    "id": parsed.get("id").unwrap(),
                                    "timestamp": 0,
                                    "payload": {
                                        "sessions": [
                                            {
                                                "session_id": "agent1:session1",
                                                "agent_id": "agent1",
                                                "session_name": "session1",
                                                "status": "active",
                                                "window_count": 1,
                                                "attached_clients": 0
                                            }
                                        ]
                                    }
                                })
                            }
                            "client.session.attach" => {
                                let preferred_mode = parsed
                                    .get("payload")
                                    .and_then(|v| v.get("preferred_mode"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("auto");

                                if preferred_mode == "relay" {
                                    json!({
                                        "msg_type": "client.session.attach.response",
                                        "id": parsed.get("id").unwrap(),
                                        "timestamp": 0,
                                        "payload": {
                                            "status": "success",
                                            "mode": "relay"
                                        }
                                    })
                                } else {
                                    json!({
                                        "msg_type": "client.session.attach.response",
                                        "id": parsed.get("id").unwrap(),
                                        "timestamp": 0,
                                        "payload": {
                                            "status": "success",
                                            "mode": "p2p",
                                            "agent_address": "ws://127.0.0.1:9090",
                                            "connection_token": "token123",
                                            "session_name": "session1"
                                        }
                                    })
                                }
                            }
                            _ => {
                                json!({
                                    "msg_type": "error",
                                    "id": parsed.get("id").unwrap(),
                                    "timestamp": 0,
                                    "payload": {
                                        "code": "unknown_message_type",
                                        "message": format!("unknown message type: {}", msg_type)
                                    }
                                })
                            }
                        };

                        let _ = sink.send(Message::Text(response.to_string())).await;
                    }
                }
            }
        });

        (handle, addr)
    }

    #[tokio::test]
    async fn test_connect_and_authenticate_success() {
        let (server_handle, addr) = start_mock_server().await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let result = ClientConnection::connect(&format!("ws://{addr}"), "valid_token").await;
        assert!(result.is_ok());

        server_handle.abort();
    }

    #[tokio::test]
    async fn test_connect_and_authenticate_failure() {
        let (server_handle, addr) = start_mock_server().await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let result = ClientConnection::connect(&format!("ws://{addr}"), "invalid_token").await;
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Authentication failed"));

        server_handle.abort();
    }

    #[tokio::test]
    async fn test_list_agents() {
        let (server_handle, addr) = start_mock_server().await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let mut conn = ClientConnection::connect(&format!("ws://{addr}"), "valid_token")
            .await
            .unwrap();

        let agents = conn.list_agents().await.unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].agent_id, "agent1");
        assert_eq!(agents[0].hostname, "host1");

        server_handle.abort();
    }

    #[tokio::test]
    async fn test_list_sessions() {
        let (server_handle, addr) = start_mock_server().await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let mut conn = ClientConnection::connect(&format!("ws://{addr}"), "valid_token")
            .await
            .unwrap();

        let sessions = conn.list_sessions(None).await.unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "agent1:session1");
        assert_eq!(sessions[0].session_name, "session1");

        server_handle.abort();
    }

    #[tokio::test]
    async fn test_list_sessions_with_agent_filter() {
        let (server_handle, addr) = start_mock_server().await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let mut conn = ClientConnection::connect(&format!("ws://{addr}"), "valid_token")
            .await
            .unwrap();

        let sessions = conn.list_sessions(Some("agent1")).await.unwrap();
        assert_eq!(sessions.len(), 1);

        server_handle.abort();
    }

    #[tokio::test]
    async fn test_request_attach_p2p() {
        let (server_handle, addr) = start_mock_server().await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let mut conn = ClientConnection::connect(&format!("ws://{addr}"), "valid_token")
            .await
            .unwrap();

        let response = conn.request_attach("agent1:session1", "p2p").await.unwrap();
        match response {
            AttachResponse::P2P(info) => {
                assert_eq!(info.agent_address, "ws://127.0.0.1:9090");
                assert_eq!(info.connection_token, "token123");
                assert_eq!(info.session_name, "session1");
            }
            AttachResponse::Relay => panic!("Expected P2P response"),
        }

        server_handle.abort();
    }

    #[tokio::test]
    async fn test_request_attach_relay() {
        let (server_handle, addr) = start_mock_server().await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let mut conn = ClientConnection::connect(&format!("ws://{addr}"), "valid_token")
            .await
            .unwrap();

        let response = conn
            .request_attach("agent1:session1", "relay")
            .await
            .unwrap();
        match response {
            AttachResponse::Relay => {}
            AttachResponse::P2P(_) => panic!("Expected Relay response"),
        }

        server_handle.abort();
    }

    /// Start a mock agent server for testing create_session_on_agent and kill_session_on_agent
    /// Binds an OS-assigned port, same reasoning as `start_mock_server`.
    async fn start_mock_agent_server() -> (tokio::task::JoinHandle<()>, SocketAddr) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("failed to bind mock agent server");
        let addr = listener.local_addr().unwrap();

        let handle = tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                let ws = accept_async(stream).await.expect("failed to accept ws");
                let (mut sink, mut stream) = ws.split();

                // Echo messages back
                while let Some(Ok(msg)) = stream.next().await {
                    if let Message::Text(text) = msg {
                        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
                        let msg_type = parsed
                            .get("msg_type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");

                        let response = match msg_type {
                            "session.create" => {
                                let name = parsed
                                    .get("payload")
                                    .and_then(|v| v.get("name"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("unknown");

                                json!({
                                    "msg_type": "ok",
                                    "id": parsed.get("id").unwrap(),
                                    "timestamp": 0,
                                    "payload": {
                                        "name": name
                                    }
                                })
                            }
                            "session.kill" => {
                                let name = parsed
                                    .get("payload")
                                    .and_then(|v| v.get("name"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("unknown");

                                json!({
                                    "msg_type": "ok",
                                    "id": parsed.get("id").unwrap(),
                                    "timestamp": 0,
                                    "payload": {
                                        "name": name
                                    }
                                })
                            }
                            _ => {
                                json!({
                                    "msg_type": "error",
                                    "id": parsed.get("id").unwrap(),
                                    "timestamp": 0,
                                    "payload": {
                                        "code": "unknown_message_type",
                                        "message": format!("unknown message type: {}", msg_type)
                                    }
                                })
                            }
                        };

                        let _ = sink.send(Message::Text(response.to_string())).await;
                    }
                }
            }
        });

        (handle, addr)
    }

    #[tokio::test]
    async fn test_create_session_on_agent() {
        let (server_handle, addr) = start_mock_agent_server().await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let result = create_session_on_agent(&format!("{addr}"), "test-session", 80, 24).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "test-session");

        server_handle.abort();
    }

    #[tokio::test]
    async fn test_kill_session_on_agent() {
        let (server_handle, addr) = start_mock_agent_server().await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let result = kill_session_on_agent(&format!("{addr}"), "test-session").await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "test-session");

        server_handle.abort();
    }

    #[tokio::test]
    async fn test_close() {
        let (server_handle, addr) = start_mock_server().await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let mut conn = ClientConnection::connect(&format!("ws://{addr}"), "valid_token")
            .await
            .unwrap();

        let result = conn.close().await;
        assert!(result.is_ok());

        server_handle.abort();
    }
}
