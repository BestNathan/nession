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
    pub async fn register_agent(&self, agent_id: &str, sender: WsMessageSender) {
        let mut agents = self.agents.write().await;
        agents.insert(
            agent_id.to_string(),
            AgentControl {
                sender,
                pending_commands: HashMap::new(),
            },
        );
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
        let (tx, rx) = oneshot::channel();

        let mut agents = self.agents.write().await;
        let agent = match agents.get_mut(agent_id) {
            Some(a) => a,
            None => {
                warn!("CommandBroker: agent {} not found", agent_id);
                drop(tx);
                return rx;
            }
        };

        agent.pending_commands.insert(request_id.to_string(), tx);

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
                debug!(
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
