//! Client WebSocket connection to central server.

use anyhow::{Context, Result};
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    connect_async, tungstenite::protocol::Message, MaybeTlsStream, WebSocketStream,
};
use futures_util::{SinkExt, StreamExt};
use tracing::{debug, info};

/// Client connection to the central server.
pub struct ClientConnection {
    ws_stream: WebSocketStream<MaybeTlsStream<TcpStream>>,
    authenticated: bool,
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
            .with_context(|| format!("Failed to connect to server at {}", server_url))?;

        info!("WebSocket connection established");

        let mut conn = Self {
            ws_stream,
            authenticated: false,
        };

        // Authenticate
        conn.authenticate(auth_token).await?;

        Ok(conn)
    }

    /// Authenticate with the server.
    async fn authenticate(&mut self, auth_token: &str) -> Result<()> {
        let msg_id = format!("auth_{}", SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_millis());
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_secs();

        let auth_msg = json!({
            "msg_type": "client.auth",
            "id": msg_id,
            "timestamp": timestamp,
            "payload": {
                "auth_token": auth_token
            }
        });

        debug!("Sending auth message: {}", auth_msg);
        self.ws_stream.send(Message::Text(auth_msg.to_string())).await?;

        // Wait for auth response
        if let Some(msg) = self.ws_stream.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    let response: serde_json::Value = serde_json::from_str(&text)?;
                    let msg_type = response["msg_type"].as_str().unwrap_or("");

                    if msg_type == "client.auth.response" {
                        let status = response["payload"]["status"].as_str().unwrap_or("");
                        let message = response["payload"]["message"].as_str().unwrap_or("");

                        if status == "success" {
                            self.authenticated = true;
                            info!("Authentication successful");
                            Ok(())
                        } else {
                            anyhow::bail!("Authentication failed: {}", message)
                        }
                    } else {
                        anyhow::bail!("Unexpected response: expected client.auth.response, got {}", msg_type)
                    }
                }
                Ok(_) => anyhow::bail!("Unexpected message type from server"),
                Err(e) => anyhow::bail!("Error receiving auth response: {}", e),
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

        let msg_id = format!("agents_{}", SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_millis());
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_secs();

        let request = json!({
            "msg_type": "client.agents.list",
            "id": msg_id,
            "timestamp": timestamp,
            "payload": {}
        });

        debug!("Sending agents list request: {}", request);
        self.ws_stream.send(Message::Text(request.to_string())).await?;

        // Wait for response
        if let Some(msg) = self.ws_stream.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    let response: serde_json::Value = serde_json::from_str(&text)?;
                    let msg_type = response["msg_type"].as_str().unwrap_or("");

                    if msg_type == "client.agents.list.response" {
                        let agents: Vec<AgentInfo> = serde_json::from_value(response["payload"]["agents"].clone())?;
                        Ok(agents)
                    } else {
                        anyhow::bail!("Unexpected response: expected client.agents.list.response, got {}", msg_type)
                    }
                }
                Ok(_) => anyhow::bail!("Unexpected message type from server"),
                Err(e) => anyhow::bail!("Error receiving agents list: {}", e),
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

        let msg_id = format!("sessions_{}", SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_millis());
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_secs();

        let mut payload = json!({});
        if let Some(agent) = agent_id {
            payload["agent_id"] = json!(agent);
        }

        let request = json!({
            "msg_type": "client.sessions.list",
            "id": msg_id,
            "timestamp": timestamp,
            "payload": payload
        });

        debug!("Sending sessions list request: {}", request);
        self.ws_stream.send(Message::Text(request.to_string())).await?;

        // Wait for response
        if let Some(msg) = self.ws_stream.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    let response: serde_json::Value = serde_json::from_str(&text)?;
                    let msg_type = response["msg_type"].as_str().unwrap_or("");

                    if msg_type == "client.sessions.list.response" {
                        let sessions: Vec<SessionInfo> = serde_json::from_value(response["payload"]["sessions"].clone())?;
                        Ok(sessions)
                    } else {
                        anyhow::bail!("Unexpected response: expected client.sessions.list.response, got {}", msg_type)
                    }
                }
                Ok(_) => anyhow::bail!("Unexpected message type from server"),
                Err(e) => anyhow::bail!("Error receiving sessions list: {}", e),
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

        let msg_id = format!("attach_{}", SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_millis());
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_secs();

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
        self.ws_stream.send(Message::Text(request.to_string())).await?;

        // Wait for response
        if let Some(msg) = self.ws_stream.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    let response: serde_json::Value = serde_json::from_str(&text)?;
                    let msg_type = response["msg_type"].as_str().unwrap_or("");

                    if msg_type != "client.session.attach.response" {
                        anyhow::bail!(
                            "Unexpected response: expected client.session.attach.response, got {}",
                            msg_type
                        );
                    }

                    let status = response["payload"]["status"].as_str().unwrap_or("");
                    if status != "success" {
                        let message = response["payload"]["message"].as_str().unwrap_or("unknown error");
                        anyhow::bail!("Attach request failed: {}", message);
                    }

                    let mode = response["payload"]["mode"].as_str().unwrap_or("relay");
                    if mode == "relay" {
                        Ok(AttachResponse::Relay)
                    } else {
                        let p2p: P2PAttachInfo = serde_json::from_value(response["payload"].clone())?;
                        Ok(AttachResponse::P2P(p2p))
                    }
                }
                Ok(_) => anyhow::bail!("Unexpected message type from server"),
                Err(e) => anyhow::bail!("Error receiving attach response: {}", e),
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
/// Returns the WebSocketStream for use as a TerminalTransport.
pub async fn connect_to_agent(agent_address: &str) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>> {
    let url = format!("ws://{}", agent_address);
    info!("Connecting to agent at: {}", url);

    let (ws_stream, _) = connect_async(&url)
        .await
        .with_context(|| format!("Failed to connect to agent at {}", url))?;

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

    let url = format!("ws://{}", agent_address);
    info!("Connecting to agent at {} to create session", url);

    let (mut ws_stream, _) = connect_async(&url)
        .await
        .with_context(|| format!("Failed to connect to agent at {}", url))?;

    let msg_id = format!(
        "create_{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_millis()
    );
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_secs();

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
                let resp_type = response["msg_type"].as_str().unwrap_or("");

                if resp_type == "ok" {
                    let name = response["payload"]["name"]
                        .as_str()
                        .unwrap_or(session_name)
                        .to_string();
                    info!("Session '{}' created on agent", name);
                    Ok(name)
                } else if resp_type == "error" {
                    let code = response["payload"]["code"].as_str().unwrap_or("unknown");
                    let message = response["payload"]["message"]
                        .as_str()
                        .unwrap_or("unknown error");
                    anyhow::bail!("Agent error ({}): {}", code, message)
                } else {
                    anyhow::bail!(
                        "Unexpected response from agent: expected 'ok' or 'error', got '{}'",
                        resp_type
                    )
                }
            }
            Ok(_) => anyhow::bail!("Unexpected message type from agent"),
            Err(e) => anyhow::bail!("Error receiving response from agent: {}", e),
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
pub async fn kill_session_on_agent(
    agent_address: &str,
    session_name: &str,
) -> Result<String> {
    use futures_util::StreamExt;

    let url = format!("ws://{}", agent_address);
    info!("Connecting to agent at {} to kill session", url);

    let (mut ws_stream, _) = connect_async(&url)
        .await
        .with_context(|| format!("Failed to connect to agent at {}", url))?;

    let msg_id = format!(
        "kill_{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_millis()
    );
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_secs();

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
                let resp_type = response["msg_type"].as_str().unwrap_or("");

                if resp_type == "ok" {
                    let name = response["payload"]["name"]
                        .as_str()
                        .unwrap_or(session_name)
                        .to_string();
                    info!("Session '{}' killed on agent", name);
                    Ok(name)
                } else if resp_type == "error" {
                    let code = response["payload"]["code"].as_str().unwrap_or("unknown");
                    let message = response["payload"]["message"]
                        .as_str()
                        .unwrap_or("unknown error");
                    anyhow::bail!("Agent error ({}): {}", code, message)
                } else {
                    anyhow::bail!(
                        "Unexpected response from agent: expected 'ok' or 'error', got '{}'",
                        resp_type
                    )
                }
            }
            Ok(_) => anyhow::bail!("Unexpected message type from agent"),
            Err(e) => anyhow::bail!("Error receiving response from agent: {}", e),
        }
    } else {
        anyhow::bail!("Agent closed connection during session kill")
    }
}
