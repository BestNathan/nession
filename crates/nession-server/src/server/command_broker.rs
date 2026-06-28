use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock, oneshot};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{warn, debug};

/// Type alias for the WebSocket sink write half.
pub type WsSinkBox = Arc<Mutex<futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>
    >,
    WsMessage,
>>>;

/// Per-agent control state: the writable sink and pending command receivers.
pub struct AgentControl {
    pub sink: WsSinkBox,
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

impl CommandBroker {
    pub fn new() -> Self {
        Self {
            agents: RwLock::new(HashMap::new()),
        }
    }

    /// Register an agent's control connection sink.
    pub async fn register_agent(&self, agent_id: &str, sink: WsSinkBox) {
        let mut agents = self.agents.write().await;
        agents.insert(agent_id.to_string(), AgentControl {
            sink,
            pending_commands: HashMap::new(),
        });
        debug!("CommandBroker: registered agent {}", agent_id);
    }

    /// Remove an agent and resolve all its pending commands with errors.
    pub async fn unregister_agent(&self, agent_id: &str) {
        let mut agents = self.agents.write().await;
        if agents.remove(agent_id).is_some() {
            debug!("CommandBroker: unregistered agent {}", agent_id);
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
                .unwrap()
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

        let sink = agent.sink.clone();
        drop(agents);

        let req_id = request_id.to_string();
        let aid = agent_id.to_string();
        let mt = msg_type.to_string();
        tokio::spawn(async move {
            use futures_util::SinkExt;
            let mut sink_lock = sink.lock().await;
            if let Err(e) = sink_lock.send(WsMessage::Text(json)).await {
                warn!("CommandBroker: failed to send command to agent {}: {}", aid, e);
            } else {
                debug!("CommandBroker: sent {} to agent {} (req: {})", mt, aid, req_id);
            }
        });

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
