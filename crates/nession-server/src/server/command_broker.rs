use std::collections::HashMap;
use tokio::sync::{oneshot, RwLock};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{debug, info, warn};

/// Sender for outgoing WebSocket messages.
///
/// Wraps an `mpsc::UnboundedSender` so that the concrete sink type (which differs
/// between plain-TCP and TLS paths) is hidden behind a transport-agnostic channel.
/// The WebSocket loop spawns a small relay task that drains the receiver and
/// forwards each message to the real sink.
#[derive(Clone)]
pub struct WsMessageSender(tokio::sync::mpsc::UnboundedSender<WsMessage>);

impl WsMessageSender {
    pub fn new() -> (Self, tokio::sync::mpsc::UnboundedReceiver<WsMessage>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (Self(tx), rx)
    }

    pub fn send(
        &self,
        msg: WsMessage,
    ) -> Result<(), tokio::sync::mpsc::error::SendError<WsMessage>> {
        self.0.send(msg)
    }
}

/// Per-agent control state: the message sender and pending command receivers.
pub struct AgentControl {
    pub sender: WsMessageSender,
    pub pending_commands: HashMap<String, oneshot::Sender<serde_json::Value>>,
}

/// Bridges client requests to agent control connections.
///
/// Uses a nested map: agent_id → (request_id → oneshot::Sender).
/// When an agent disconnects, `unregister_agent` drops the inner map,
/// resolving all pending oneshots with `RecvError` automatically.
pub struct CommandBroker {
    agents: RwLock<HashMap<String, AgentControl>>,
}

impl Default for CommandBroker {
    fn default() -> Self {
        Self::new()
    }
}

impl CommandBroker {
    pub fn new() -> Self {
        Self {
            agents: RwLock::new(HashMap::new()),
        }
    }

    /// Register an agent's control connection sender.
    ///
    /// Re-registering an agent that is already known is a **transport update,
    /// not a state reset** — it only swaps the sender. The websocket loop calls
    /// this on every inbound agent message (see `server/websocket.rs`), so
    /// discarding `pending_commands` here would cancel every in-flight command
    /// and resolve its waiter with `RecvError`, which callers report as
    /// "Agent disconnected" for work the agent may already have completed
    /// (#743). In-flight commands belong to the agent, not to the connection
    /// carrying them; only [`Self::unregister_agent`] ends them.
    pub async fn register_agent(&self, agent_id: &str, sender: WsMessageSender) {
        let mut agents = self.agents.write().await;
        match agents.get_mut(agent_id) {
            Some(existing) => existing.sender = sender,
            None => {
                agents.insert(
                    agent_id.to_string(),
                    AgentControl {
                        sender,
                        pending_commands: HashMap::new(),
                    },
                );
            }
        }
        debug!("CommandBroker: registered agent {}", agent_id);
    }

    /// Remove an agent and resolve all its pending commands with errors.
    pub async fn unregister_agent(&self, agent_id: &str) {
        let mut agents = self.agents.write().await;
        if agents.remove(agent_id).is_some() {
            info!("CommandBroker: unregistered agent {}", agent_id);
        }
    }

    /// Send a command to an agent and return a oneshot receiver for the response.
    ///
    /// If the agent is not found, returns a receiver that immediately errors.
    pub async fn send_command(
        &self,
        agent_id: &str,
        msg_type: &str,
        request_id: &str,
        payload: serde_json::Value,
    ) -> oneshot::Receiver<serde_json::Value> {
        info!(
            "CommandBroker: send_command called for agent {} msg_type {} req {}",
            agent_id, msg_type, request_id
        );
        let (tx, rx) = oneshot::channel();

        let mut agents = self.agents.write().await;
        let agent = match agents.get_mut(agent_id) {
            Some(a) => {
                info!("CommandBroker: found agent {} in registry", agent_id);
                a
            }
            None => {
                warn!("CommandBroker: agent {} not found in registry", agent_id);
                drop(tx);
                return rx;
            }
        };

        agent.pending_commands.insert(request_id.to_string(), tx);
        info!(
            "CommandBroker: inserted pending_command for agent {} req {}",
            agent_id, request_id
        );

        let msg = nession_common::protocol::Message {
            msg_type: msg_type.to_string(),
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            payload,
        };

        let json = match serde_json::to_string(&msg) {
            Ok(j) => j,
            Err(e) => {
                warn!("CommandBroker: failed to serialize command: {}", e);
                agent.pending_commands.remove(request_id);
                return rx;
            }
        };

        let sender = agent.sender.clone();
        drop(agents);

        let req_id = request_id.to_string();
        let aid = agent_id.to_string();
        let mt = msg_type.to_string();

        // Send the command through the channel
        match sender.send(WsMessage::Text(json)) {
            Ok(_) => {
                info!(
                    "CommandBroker: sent {} to agent {} (req: {})",
                    mt, aid, req_id
                );
            }
            Err(e) => {
                warn!(
                    "CommandBroker: failed to send command to agent {}: {}",
                    aid, e
                );
            }
        }

        rx
    }

    /// Resolve a pending command with a response from the agent.
    /// Returns true if a pending command was found and resolved.
    pub async fn resolve_command(
        &self,
        agent_id: &str,
        request_id: &str,
        response: serde_json::Value,
    ) -> bool {
        let mut agents = self.agents.write().await;
        let agent = match agents.get_mut(agent_id) {
            Some(a) => a,
            None => return false,
        };

        if let Some(tx) = agent.pending_commands.remove(request_id) {
            let _ = tx.send(response);
            true
        } else {
            debug!(
                "CommandBroker: no pending command {} for agent {}",
                request_id, agent_id
            );
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Regression #743: the agent WebSocket loop calls `register_agent` on
    /// **every** inbound agent message (see `server/websocket.rs`), so a
    /// re-registration can land while commands are in flight. It is a transport
    /// update, not a state reset: taking the pending map with it resolves every
    /// waiting handler with `RecvError`, and the session-create handler renders
    /// that as "Agent disconnected" — for a command the agent may already have
    /// executed.
    #[tokio::test]
    async fn re_registering_an_agent_keeps_its_pending_commands() {
        let broker = CommandBroker::new();
        let (sender, _keepalive) = WsMessageSender::new();
        broker.register_agent("a1", sender).await;

        let waiter = broker
            .send_command("a1", "server.session.create", "req-1", json!({}))
            .await;

        // An unrelated message from the same agent re-registers its sender.
        let (sender_again, _keepalive_again) = WsMessageSender::new();
        broker.register_agent("a1", sender_again).await;

        assert!(
            broker
                .resolve_command("a1", "req-1", json!({ "success": true }))
                .await,
            "the agent's response must still find the waiter registered for it"
        );

        let response = waiter
            .await
            .expect("re-registering a sender must not cancel an in-flight command");
        assert_eq!(response["success"], json!(true));
    }

    /// The other half of the same contract: an agent that actually disconnects
    /// must still fail its in-flight commands rather than leave them hanging.
    #[tokio::test]
    async fn unregistering_an_agent_still_drops_its_pending_commands() {
        let broker = CommandBroker::new();
        let (sender, _keepalive) = WsMessageSender::new();
        broker.register_agent("a1", sender).await;

        let waiter = broker
            .send_command("a1", "server.session.create", "req-1", json!({}))
            .await;

        broker.unregister_agent("a1").await;

        assert!(
            waiter.await.is_err(),
            "a genuinely disconnected agent must resolve its waiters with an error"
        );
    }
}
