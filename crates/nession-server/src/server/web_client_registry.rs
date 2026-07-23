//! Registry of connected web dashboard clients for push notifications.
//!
//! When an agent's heartbeat updates its session count (or any other state),
//! the server broadcasts an `agents.changed` message to all registered web
//! clients so the dashboard stays current without polling.

use std::sync::Arc;
use tokio::sync::RwLock;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{debug, info, warn};

use super::command_broker::WsMessageSender;

/// Tracks connected web dashboard clients so agent state changes can be
/// pushed in real-time (no polling needed).
pub struct WebClientRegistry {
    /// client_id → sender
    clients: RwLock<Vec<(String, WsMessageSender)>>,
}

impl Default for WebClientRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl WebClientRegistry {
    pub fn new() -> Self {
        Self {
            clients: RwLock::new(Vec::new()),
        }
    }

    /// Register a web client connection (called after authentication).
    pub async fn register(&self, client_id: &str, sender: WsMessageSender) {
        let mut clients = self.clients.write().await;
        clients.push((client_id.to_string(), sender));
        info!(
            "WebClientRegistry: registered client {} (total: {})",
            client_id,
            clients.len()
        );
    }

    /// Remove a web client connection.
    pub async fn unregister(&self, client_id: &str) {
        let mut clients = self.clients.write().await;
        clients.retain(|(id, _)| id != client_id);
        debug!(
            "WebClientRegistry: unregistered client {} (total: {})",
            client_id,
            clients.len()
        );
    }

    /// Broadcast a JSON text message to all registered web clients.
    /// Dead senders (disconnected clients) are automatically removed.
    pub async fn broadcast(&self, json: String) {
        let mut clients = self.clients.write().await;
        if clients.is_empty() {
            info!("WebClientRegistry: broadcast skipped — no clients registered");
            return;
        }
        let msg = WsMessage::Text(json);
        let before = clients.len();
        clients.retain(|(client_id, sender)| {
            if let Err(e) = sender.send(msg.clone()) {
                warn!(
                    "WebClientRegistry: client {} disconnected, removing: {}",
                    client_id, e
                );
                false
            } else {
                true
            }
        });
        info!(
            "WebClientRegistry: broadcast to {}/{} clients ({} removed)",
            clients.len(),
            before,
            before - clients.len()
        );
    }

    /// Build an `agents.changed` payload from an Arc<AgentRegistry> and
    /// broadcast it to all connected web clients.
    pub async fn broadcast_agents_changed(
        &self,
        agent_registry: Arc<crate::registry::AgentRegistry>,
    ) {
        let agents = agent_registry.list().await;
        let payload = serde_json::json!({
            "msg_type": "agents.changed",
            "id": "",
            "timestamp": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            "payload": {
                "agents": agents.iter().map(|a| {
                    serde_json::json!({
                        "agent_id": a.agent_id,
                        "hostname": a.hostname,
                        "display_name": a.display_name,
                        "ip_address": a.ip_address,
                        "port": a.port,
                        "status": match a.status {
                            crate::registry::AgentStatus::Online => "online",
                            crate::registry::AgentStatus::Offline => "offline",
                            crate::registry::AgentStatus::Degraded => "degraded",
                        },
                        "session_count": a.session_count,
                        "active_sessions": a.active_sessions,
                        "last_heartbeat": a.last_heartbeat.to_rfc3339(),
                        "registered_at": a.registered_at.to_rfc3339(),
                        "addresses": serde_json::to_value(&a.addresses).unwrap_or(serde_json::json!([])),
                        "metadata": {
                            "nession_version": a.metadata.nession_version,
                            "tmux_version": a.metadata.tmux_version,
                            "os_version": a.metadata.os_version,
                        },
                    })
                }).collect::<Vec<_>>(),
            }
        });
        if let Ok(json) = serde_json::to_string(&payload) {
            self.broadcast(json).await;
        }
    }
}
