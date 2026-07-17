use std::collections::HashMap;
use tokio::sync::RwLock;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{debug, warn};

use super::command_broker::WsMessageSender;

/// Tracks connected web clients per session, enabling server-initiated
/// broadcasts (e.g. terminal resize events from the agent).
///
/// A client is registered when it enters relay mode for a session and
/// unregistered when the connection drops.
pub struct ClientRegistry {
    /// session_id → (client_id → sender)
    clients: RwLock<HashMap<String, HashMap<String, WsMessageSender>>>,
}

impl Default for ClientRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ClientRegistry {
    pub fn new() -> Self {
        Self {
            clients: RwLock::new(HashMap::new()),
        }
    }

    /// Register a client connection for a session.
    pub async fn register(&self, session_id: &str, client_id: &str, sender: WsMessageSender) {
        let mut clients = self.clients.write().await;
        clients
            .entry(session_id.to_string())
            .or_default()
            .insert(client_id.to_string(), sender);
        debug!(
            "ClientRegistry: registered client {} for session {}",
            client_id, session_id
        );
    }

    /// Remove a client connection from a session.
    pub async fn unregister(&self, session_id: &str, client_id: &str) {
        let mut clients = self.clients.write().await;
        if let Some(session_clients) = clients.get_mut(session_id) {
            session_clients.remove(client_id);
            if session_clients.is_empty() {
                clients.remove(session_id);
            }
        }
        debug!(
            "ClientRegistry: unregistered client {} from session {}",
            client_id, session_id
        );
    }

    /// Broadcast a text message to all clients attached to a session.
    /// Returns the number of clients the message was sent to.
    pub async fn broadcast(&self, session_id: &str, msg: String) -> usize {
        let clients = self.clients.read().await;
        let Some(session_clients) = clients.get(session_id) else {
            return 0;
        };

        let ws_msg = WsMessage::Text(msg);
        let mut sent = 0;
        for (client_id, sender) in session_clients {
            match sender.send(ws_msg.clone()) {
                Ok(_) => sent += 1,
                Err(e) => {
                    warn!(
                        "ClientRegistry: failed to send to client {} in session {}: {}",
                        client_id, session_id, e
                    );
                }
            }
        }
        sent
    }

    /// Count of clients attached to a session.
    pub async fn session_client_count(&self, session_id: &str) -> usize {
        let clients = self.clients.read().await;
        clients.get(session_id).map_or(0, HashMap::len)
    }
}
