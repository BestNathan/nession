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

    /// Close the connection gracefully.
    pub async fn close(&mut self) -> Result<()> {
        info!("Closing connection");
        self.ws_stream.close(None).await?;
        Ok(())
    }
}
