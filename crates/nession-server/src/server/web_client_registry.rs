//! Broadcast channel for pushing agent state changes to web clients.
//!
//! Uses a `tokio::sync::broadcast` channel so every authenticated web
//! client connection subscribes once and receives `agents.changed` pushes
//! without the server needing to track individual senders.

use std::sync::Arc;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{debug, error, info};

use super::command_broker::WsMessageSender;

/// Shared broadcast channel for agent state pushes. A single sender is held
/// by the server; every web-client connection spawns a relay task that
/// forwards each broadcast to its own `WsMessageSender`.
pub struct WebClientRegistry {
    tx: broadcast::Sender<String>,
}

impl Default for WebClientRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl WebClientRegistry {
    /// Create a new registry with room for 16 unread messages per subscriber.
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(16);
        Self { tx }
    }

    /// Subscribe a newly-authenticated web client. Spawns a background task
    /// that forwards every broadcast to `sender` until the client disconnects
    /// (the receiver is dropped / lagged).
    pub fn subscribe(&self, sender: WsMessageSender) {
        let mut rx = self.tx.subscribe();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(json) => {
                        if sender.send(WsMessage::Text(json)).is_err() {
                            debug!("WebClientRegistry: subscriber sender closed");
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        info!(
                            "WebClientRegistry: subscriber lagged by {} messages, skipping",
                            n
                        );
                        // Continue — the next recv will get the latest.
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        info!(
            "WebClientRegistry: new subscriber (total capacity: {})",
            self.tx.len()
        );
    }

    /// Push an `agents.changed` JSON payload to all connected web clients.
    /// This is a non-blocking send — slow clients may miss messages (lagged).
    pub fn broadcast(&self, json: String) {
        match self.tx.send(json) {
            Ok(n) => debug!("WebClientRegistry: broadcast to {} subscribers", n),
            Err(broadcast::error::SendError(_)) => {
                // No subscribers — perfectly normal, just skip.
                debug!("WebClientRegistry: broadcast skipped — no subscribers");
            }
        }
    }

    /// Build an `agents.changed` payload from the agent registry and push it.
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
        match serde_json::to_string(&payload) {
            Ok(json) => self.broadcast(json),
            Err(e) => error!(
                "WebClientRegistry: failed to serialize agents.changed: {}",
                e
            ),
        }
    }
}
