use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
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

/// Identity of one accepted WebSocket connection, handed out by
/// [`CommandBroker::new_connection_generation`].
///
/// An agent is a *logical* identity that outlives its connections: the same
/// `agent_id` comes back on a brand-new WebSocket, and by the time the new
/// connection has registered, the old one can still be alive — half-closed, or
/// simply not yet reaped — and still sending. Keying ownership on `agent_id`
/// alone therefore cannot answer the question every late message asks: *which*
/// connection owns this agent now (#960).
///
/// The number is a counter rather than a random id so that it orders as well as
/// identifies: a connection accepted later always has the higher generation,
/// which is the rule that lets a reconnect take its agent over while leaving a
/// superseded connection unable to take it back. Random ids would identify
/// without ordering, and the ordering is what the ownership rule reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ConnectionGeneration(u64);

impl std::fmt::Display for ConnectionGeneration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "conn#{}", self.0)
    }
}

/// Per-agent control state: the owning connection, the message sender, and
/// pending command receivers.
pub struct AgentControl {
    /// The connection this agent's control channel currently belongs to. Only a
    /// newer connection may take it over; see [`CommandBroker::claim_agent`].
    generation: ConnectionGeneration,
    pub sender: WsMessageSender,
    pub pending_commands: HashMap<String, oneshot::Sender<serde_json::Value>>,
}

/// Bridges client requests to agent control connections.
///
/// Uses a nested map: agent_id → (request_id → oneshot::Sender).
/// When an agent disconnects, [`Self::release_agent`] drops the inner map,
/// resolving all pending oneshots with `RecvError` automatically.
///
/// The map is keyed by agent, but *owned* by a connection: see
/// [`ConnectionGeneration`] for why that distinction is the difference between
/// a working reconnect and an agent nobody can reach.
pub struct CommandBroker {
    agents: RwLock<HashMap<String, AgentControl>>,
    /// Source of [`ConnectionGeneration`]s; see that type for why they order.
    generations: AtomicU64,
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
            generations: AtomicU64::new(0),
        }
    }

    /// Hand out the identity of a newly accepted connection.
    ///
    /// Called once per connection, when its handler is built. Every ownership
    /// decision afterwards is a comparison against this number.
    pub fn new_connection_generation(&self) -> ConnectionGeneration {
        ConnectionGeneration(self.generations.fetch_add(1, Ordering::Relaxed))
    }

    /// Point an agent's control channel at this connection's sender.
    ///
    /// Called for every inbound message from a registered agent connection —
    /// the same call site as before #960, where it was unconditional. It is
    /// conditional now because that is the whole bug: re-registering on every
    /// message meant any late message from a superseded connection stamped its
    /// dead sender back over its replacement, and a command aimed at the agent
    /// went nowhere.
    ///
    /// So ownership follows the **highest generation that has spoken**:
    ///
    /// * A reconnect claims the agent outright — it is a brand-new connection,
    ///   hence the highest generation, and the agent is now served from it.
    /// * A superseded connection's late heartbeat or session update changes
    ///   nothing, however many of them arrive.
    /// * The current owner re-asserts its own claim harmlessly.
    ///
    /// That last case is not decoration. A connection re-asserting ownership is
    /// also how it *recovers* from [`Self::evict_agent`]: an agent registers
    /// once, when it connects, so if the heartbeat sweep evicted a live
    /// connection's entry and nothing could re-install it, that agent would
    /// stay unreachable for commands until it happened to reconnect.
    ///
    /// Installing a sender never discards `pending_commands`: in-flight
    /// commands belong to the agent, not to the connection carrying them, and
    /// resolving their waiters with `RecvError` would report "Agent
    /// disconnected" for work the agent may already have completed (#743).
    pub async fn claim_agent(
        &self,
        agent_id: &str,
        generation: ConnectionGeneration,
        sender: WsMessageSender,
    ) {
        let mut agents = self.agents.write().await;
        match agents.get_mut(agent_id) {
            Some(existing) if existing.generation > generation => {
                // This agent already belongs to a newer connection, and nothing
                // an older one says may move it.
                debug!(
                    "CommandBroker: ignoring claim on agent {} by {} — owned by {}",
                    agent_id, generation, existing.generation
                );
            }
            Some(existing) => {
                existing.generation = generation;
                existing.sender = sender;
                debug!(
                    "CommandBroker: agent {} claimed by {}",
                    agent_id, generation
                );
            }
            None => {
                agents.insert(
                    agent_id.to_string(),
                    AgentControl {
                        generation,
                        sender,
                        pending_commands: HashMap::new(),
                    },
                );
                debug!(
                    "CommandBroker: agent {} claimed by {}",
                    agent_id, generation
                );
            }
        }
    }

    /// Release an agent's control channel **if this connection still owns it**.
    ///
    /// This is the disconnect path, and the generation check is what makes it a
    /// compare-and-remove: a connection that a reconnect has already superseded
    /// releases only its own claim and finds it has none — closing the old
    /// WebSocket cannot unregister the agent its replacement is serving (#960).
    /// Dropping the map for a release that *does* match still resolves every
    /// pending command of that agent with `RecvError`, which is the intended
    /// meaning: the agent is gone, and work still in flight cannot complete.
    ///
    /// Returns whether the caller was still the owner.
    pub async fn release_agent(&self, agent_id: &str, generation: ConnectionGeneration) -> bool {
        let mut agents = self.agents.write().await;
        match agents.get(agent_id).map(|control| control.generation) {
            Some(current) if current == generation => {
                agents.remove(agent_id);
                info!(
                    "CommandBroker: agent {} released by {}",
                    agent_id, generation
                );
                true
            }
            Some(current) => {
                debug!(
                    "CommandBroker: {} tried to release agent {}, owned by {} — ignored",
                    generation, agent_id, current
                );
                false
            }
            None => false,
        }
    }

    /// Drop an agent's control channel on a **liveness** verdict.
    ///
    /// Not the disconnect path — that is [`Self::release_agent`], and it is
    /// owner-checked. This one is for the verdicts that are about the *agent*
    /// rather than about any connection: the heartbeat sweep marking a silent
    /// agent offline, and a client deleting an agent the registry reports as
    /// offline. Whoever holds the channel is by definition not answering, so
    /// there is no owner to compare against and no generation to preserve.
    ///
    /// It is the one removal that ignores generations. The state it leaves — an
    /// agent with no owner — is one any connection may claim again, which is
    /// how a live connection recovers from a sweep that fired on it; the window
    /// it leaves, between the sweep's verdict and this call, is bounded by the
    /// heartbeat timeout and belongs to the sweep rather than to the broker.
    pub async fn evict_agent(&self, agent_id: &str) {
        let mut agents = self.agents.write().await;
        if agents.remove(agent_id).is_some() {
            info!("CommandBroker: evicted agent {}", agent_id);
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

        let msg = nession_protocol::Message {
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
                // The transport is already gone, so this command can never be
                // answered — and leaving the entry in `pending_commands` is
                // what made the caller wait out its 10/30s timeout to find out.
                // Revoking it drops the oneshot sender, resolving the waiter
                // with `RecvError` now; callers already read that as "Agent
                // disconnected", which is exactly what this is (#960).
                //
                // Request ids are server-generated UUIDs, so this removal can
                // only ever take back this call's own entry: nothing else can
                // be waiting under the same id, and if the response somehow won
                // the race, the entry is already gone and there is nothing to
                // remove.
                let mut agents = self.agents.write().await;
                if let Some(agent) = agents.get_mut(agent_id) {
                    agent.pending_commands.remove(request_id);
                }
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

    /// Regression #743: the agent WebSocket loop claims `a1` on **every**
    /// inbound agent message (see `server/websocket.rs`), so a re-claim can land
    /// while commands are in flight — and a reconnect claims it outright. The
    /// claim is a transport update, not a state reset: taking the pending map
    /// with it resolves every waiting handler with `RecvError`, and the
    /// session-create handler renders that as "Agent disconnected" — for a
    /// command the agent may already have executed.
    #[tokio::test]
    async fn reconnecting_an_agent_keeps_its_pending_commands() {
        let broker = CommandBroker::new();
        let (sender, _keepalive) = WsMessageSender::new();
        broker
            .claim_agent("a1", broker.new_connection_generation(), sender)
            .await;

        let waiter = broker
            .send_command("a1", "agent.session.create", "req-1", json!({}))
            .await;

        // The agent reconnects: a brand-new connection claims the same agent id
        // while the command is still waiting for an answer.
        let (sender_again, _keepalive_again) = WsMessageSender::new();
        broker
            .claim_agent("a1", broker.new_connection_generation(), sender_again)
            .await;

        assert!(
            broker
                .resolve_command("a1", "req-1", json!({ "success": true }))
                .await,
            "the agent's response must still find the waiter registered for it"
        );

        let response = waiter
            .await
            .expect("a reconnect must not cancel a command that is still in flight");
        assert_eq!(response["success"], json!(true));
    }

    /// #960, the late-message half: a connection that a reconnect has
    /// superseded may keep talking — a half-closed socket still delivers — and
    /// none of those messages may take the agent back. Before the generation
    /// check, every one of them re-registered its dead sender, so a command
    /// aimed at the agent went to a connection nobody was reading.
    #[tokio::test]
    async fn a_superseded_connection_cannot_take_the_agent_back() {
        let broker = CommandBroker::new();
        let old = broker.new_connection_generation();
        let new = broker.new_connection_generation();
        let (old_sender, mut old_rx) = WsMessageSender::new();
        let (new_sender, mut new_rx) = WsMessageSender::new();
        broker.claim_agent("a1", old, old_sender.clone()).await;
        broker.claim_agent("a1", new, new_sender).await;

        // Whatever the superseded connection says next, the loop claims with it.
        broker.claim_agent("a1", old, old_sender.clone()).await;

        // Nothing to assert about the answer — the question here is *where* the
        // command was delivered, not whether it was answered.
        let _rx = broker
            .send_command("a1", "agent.session.create", "req-1", json!({}))
            .await;
        assert!(
            new_rx.try_recv().is_ok(),
            "the command must reach the connection that owns the agent"
        );
        assert!(
            old_rx.try_recv().is_err(),
            "the superseded connection must receive nothing"
        );
    }

    /// #960, the disconnect half: closing the old WebSocket must not unregister
    /// the agent the new one is serving. The generation check turns the release
    /// into a compare-and-remove, so the old connection removes only its own
    /// claim — and it no longer has one.
    #[tokio::test]
    async fn a_superseded_connection_cannot_release_the_agent() {
        let broker = CommandBroker::new();
        let old = broker.new_connection_generation();
        let new = broker.new_connection_generation();
        let (old_sender, _keepalive) = WsMessageSender::new();
        let (new_sender, mut new_rx) = WsMessageSender::new();
        broker.claim_agent("a1", old, old_sender).await;
        broker.claim_agent("a1", new, new_sender).await;

        assert!(
            !broker.release_agent("a1", old).await,
            "the superseded connection is not the owner, so its release must be a no-op"
        );

        let _rx = broker
            .send_command("a1", "agent.session.create", "req-1", json!({}))
            .await;
        assert!(
            new_rx.try_recv().is_ok(),
            "the new connection must still own the agent after the old one closed"
        );

        assert!(
            broker.release_agent("a1", new).await,
            "the owner's own release must still unregister the agent"
        );
    }

    /// The other half of the same contract: an agent that actually disconnects
    /// must still fail its in-flight commands rather than leave them hanging.
    #[tokio::test]
    async fn disconnecting_an_agent_still_drops_its_pending_commands() {
        let broker = CommandBroker::new();
        let (sender, _keepalive) = WsMessageSender::new();
        let generation = broker.new_connection_generation();
        broker.claim_agent("a1", generation, sender).await;

        let waiter = broker
            .send_command("a1", "agent.session.create", "req-1", json!({}))
            .await;

        broker.release_agent("a1", generation).await;

        assert!(
            waiter.await.is_err(),
            "a genuinely disconnected agent must resolve its waiters with an error"
        );
    }

    /// #960, the enqueue half: a send that the transport refuses has already
    /// decided the command's fate, so the caller must hear it now rather than
    /// after a 10/30s timeout that cannot change the answer. The pending entry
    /// must go with it — leaving it behind is what made the caller wait.
    #[tokio::test]
    async fn a_failed_send_revokes_the_pending_command() {
        let broker = CommandBroker::new();
        // A connection whose receiving end is already gone: the channel is
        // closed, so this is a transport that cannot send, not an agent that is
        // slow to answer.
        let (sender, receiver) = WsMessageSender::new();
        drop(receiver);
        broker
            .claim_agent("a1", broker.new_connection_generation(), sender)
            .await;

        let waiter = broker
            .send_command("a1", "agent.session.create", "req-1", json!({}))
            .await;

        match tokio::time::timeout(std::time::Duration::from_millis(100), waiter).await {
            Ok(Err(_)) => {}
            Ok(Ok(response)) => {
                panic!("a command whose send failed must fail, not answer: {response}")
            }
            Err(_) => panic!("a command whose send failed must not wait for a timeout"),
        }

        let agents = broker.agents.read().await;
        assert!(
            agents
                .get("a1")
                .expect("the agent stays claimed: only the command was revoked")
                .pending_commands
                .is_empty(),
            "the revoked command must not be left in the pending map"
        );
    }
}
