//! Broadcast channel for pushing agent state changes to web clients.
//!
//! Uses a `tokio::sync::broadcast` channel so every authenticated web
//! client connection subscribes once and receives `server.agents.changed`
//! pushes without the server needing to track individual senders.
//!
//! Every wire sent from here is a **notification**:
//! `<emitter>.<subject>.<event>`, where the first segment names the runtime
//! that sends it — this one — and not, as an operation's first segment does,
//! the runtime that answers. Nothing answers a notification; see
//! `docs/architecture/protocol.md` § *Notification*.

use std::sync::Arc;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{debug, error, info};

use super::outbound::{OutboundError, WsMessageSender};

/// The wires this module pushes, declared where they are sent.
///
/// A notification is carried by no contract, so `just codegen` emits nothing
/// for it and there is no binding to import — the declaration beside the
/// sender is the only statement of the name, and `scripts/protocol-gate.mjs`
/// reads it as one (rule 1: a call site may name these; rule 4: the first
/// segment says which runtime emits them, and that is what these constants
/// make checkable rather than a matter of reading the code).
///
/// They are used at the two ends of every push below — the `msg_type` and the
/// `error!` beside it — so a rename cannot leave half of it behind.
pub const AGENTS_CHANGED: &str = "server.agents.changed";
pub const SESSIONS_CHANGED: &str = "server.sessions.changed";
pub const COMMANDS_CHANGED: &str = "server.commands.changed";

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
    ///
    /// The last hop is a broadcast too — a dropped push is this registry's
    /// existing semantic one hop earlier, so a client that has stopped draining
    /// is skipped rather than waited for. See
    /// `outbound::WsMessageSender::try_send_broadcast`.
    pub fn subscribe(&self, sender: WsMessageSender) {
        let mut rx = self.tx.subscribe();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(json) => {
                        // A closed queue is this subscriber's connection being
                        // gone: end the task rather than forwarding into a queue
                        // nobody will ever drain. A full queue is only this
                        // subscriber being behind, and the next push restates
                        // the state it missed.
                        if let Err(e) = sender.try_send_broadcast(WsMessage::Text(json)) {
                            if e == OutboundError::Closed {
                                debug!("WebClientRegistry: subscriber sender closed");
                                break;
                            }
                            debug!("WebClientRegistry: subscriber skipped a push: {e}");
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

    /// Push a `server.agents.changed` JSON payload to all connected web clients.
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

    /// Build a `server.agents.changed` payload from the agent registry and push it.
    pub async fn broadcast_agents_changed(
        &self,
        agent_registry: Arc<crate::registry::AgentRegistry>,
    ) {
        let agents = agent_registry.list().await;
        let payload = serde_json::json!({
            "msg_type": AGENTS_CHANGED,
            "id": "",
            "timestamp": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            "payload": {
                // Not hand-built, and that is a fix rather than a tidy-up: this
                // block used to be a second `json!` with its own field list, and
                // it had already lost `protocols` and `metadata.image_tag`
                // relative to `server.agent.list`. A client that had resolved a
                // contract version from the list lost it on the next push. See
                // `agent_view`.
                "agents": agents.iter().map(super::agent_view::agent_json).collect::<Vec<_>>(),
            }
        });
        match serde_json::to_string(&payload) {
            Ok(json) => self.broadcast(json),
            Err(e) => error!(
                "WebClientRegistry: failed to serialize {AGENTS_CHANGED}: {}",
                e
            ),
        }
    }

    /// Build a `server.sessions.changed` payload from the session registry and push
    /// it to every connected web client.
    ///
    /// Web clients only fetch the session list on mount, so without this push
    /// any change made elsewhere (another browser, an agent reconnecting, a
    /// session dying) would stay invisible until a manual refresh. The session
    /// JSON is produced by the same helper as `server.session.list`,
    /// so both paths always carry an identical field set.
    pub async fn broadcast_sessions_changed(
        &self,
        session_registry: Arc<crate::registry::SessionRegistry>,
    ) {
        let sessions = session_registry.list().await;
        let payload = serde_json::json!({
            "msg_type": SESSIONS_CHANGED,
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
                "WebClientRegistry: failed to serialize {SESSIONS_CHANGED}: {}",
                e
            ),
        }
    }

    /// Broadcast `server.commands.changed` to all connected web clients to
    /// notify them that the quick-command list has been modified.
    pub async fn broadcast_commands_changed(&self) {
        let payload = serde_json::json!({
            "msg_type": COMMANDS_CHANGED,
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
                "WebClientRegistry: failed to serialize {COMMANDS_CHANGED}: {}",
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
            foreground_command: None,
            created_at: chrono::Utc::now(),
            last_activity: chrono::Utc::now(),
        }
    }

    /// A subscribed web client receives the pushed session list with the same
    /// field set `server.session.list` uses — the browser feeds both
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
        let parsed: serde_json::Value =
            serde_json::from_str(msg.message.to_text().unwrap()).unwrap();

        assert_eq!(parsed["msg_type"], SESSIONS_CHANGED);
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
        let parsed: serde_json::Value =
            serde_json::from_str(msg.message.to_text().unwrap()).unwrap();

        assert_eq!(parsed["msg_type"], SESSIONS_CHANGED);
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
