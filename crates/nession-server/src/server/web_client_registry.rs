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

    /// Build a `sessions.changed` payload from the session registry and push
    /// it to every connected web client.
    ///
    /// Web clients only fetch the session list on mount, so without this push
    /// any change made elsewhere (another browser, an agent reconnecting, a
    /// session dying) would stay invisible until a manual refresh. The session
    /// JSON is produced by the same helper as `client.sessions.list.response`,
    /// so both paths always carry an identical field set.
    pub async fn broadcast_sessions_changed(
        &self,
        session_registry: Arc<crate::registry::SessionRegistry>,
    ) {
        let sessions = session_registry.list().await;
        let payload = serde_json::json!({
            "msg_type": "sessions.changed",
            "id": "",
            "timestamp": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            "payload": {
                "sessions": sessions
                    .iter()
                    .map(crate::server::handler::session_to_json)
                    .collect::<Vec<_>>(),
            }
        });
        match serde_json::to_string(&payload) {
            Ok(json) => self.broadcast(json),
            Err(e) => error!(
                "WebClientRegistry: failed to serialize sessions.changed: {}",
                e
            ),
        }
    }

    /// Broadcast `server.commands.changed` to all connected web clients to
    /// notify them that the quick-command list has been modified.
    pub async fn broadcast_commands_changed(&self) {
        let payload = serde_json::json!({
            "msg_type": "server.commands.changed",
            "id": "",
            "timestamp": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            "payload": {},
        });
        match serde_json::to_string(&payload) {
            Ok(json) => self.broadcast(json),
            Err(e) => error!(
                "WebClientRegistry: failed to serialize server.commands.changed: {}",
                e
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::registry::{SessionInfo, SessionRegistry, SessionStatus};

    async fn new_session_registry() -> Arc<SessionRegistry> {
        let db = Arc::new(Database::new(":memory:").await.unwrap());
        Arc::new(SessionRegistry::new(db))
    }

    fn make_session(agent_id: &str, name: &str, attached: u32) -> SessionInfo {
        SessionInfo {
            session_id: format!("{agent_id}:{name}"),
            agent_id: agent_id.to_string(),
            session_name: name.to_string(),
            status: if attached > 0 {
                SessionStatus::Active
            } else {
                SessionStatus::Detached
            },
            window_count: 2,
            attached_clients: attached,
            created_at: chrono::Utc::now(),
            last_activity: chrono::Utc::now(),
        }
    }

    /// A subscribed web client receives the pushed session list with the same
    /// field set `client.sessions.list.response` uses — the browser feeds both
    /// into one state setter, so a mismatch would silently yield `undefined`.
    #[tokio::test]
    async fn broadcast_sessions_changed_reaches_subscriber() {
        let registry = WebClientRegistry::new();
        let (sender, mut rx) = WsMessageSender::new();
        registry.subscribe(sender);

        let sessions = new_session_registry().await;
        sessions.update_session(make_session("a1", "s1", 1)).await;

        registry
            .broadcast_sessions_changed(Arc::clone(&sessions))
            .await;

        let msg = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .expect("timeout waiting for broadcast")
            .expect("channel closed");
        let parsed: serde_json::Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();

        assert_eq!(parsed["msg_type"], "sessions.changed");
        let list = parsed["payload"]["sessions"].as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["session_id"], "a1:s1");
        assert_eq!(list[0]["agent_id"], "a1");
        assert_eq!(list[0]["session_name"], "s1");
        assert_eq!(list[0]["status"], "active");
        assert_eq!(list[0]["window_count"], 2);
        assert_eq!(list[0]["attached_clients"], 1);
        assert!(list[0]["last_activity"].is_string());
    }

    /// An empty registry still pushes a well-formed empty list — that is how a
    /// client learns its last session disappeared.
    #[tokio::test]
    async fn broadcast_sessions_changed_pushes_empty_list() {
        let registry = WebClientRegistry::new();
        let (sender, mut rx) = WsMessageSender::new();
        registry.subscribe(sender);

        registry
            .broadcast_sessions_changed(new_session_registry().await)
            .await;

        let msg = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .expect("timeout waiting for broadcast")
            .expect("channel closed");
        let parsed: serde_json::Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();

        assert_eq!(parsed["msg_type"], "sessions.changed");
        assert!(parsed["payload"]["sessions"].as_array().unwrap().is_empty());
    }

    /// Broadcasting with nobody listening must not panic or error — the server
    /// pushes on every mutation regardless of whether a browser is open.
    #[tokio::test]
    async fn broadcast_with_no_subscribers_is_harmless() {
        let registry = WebClientRegistry::new();
        registry
            .broadcast_sessions_changed(new_session_registry().await)
            .await;
    }
}
