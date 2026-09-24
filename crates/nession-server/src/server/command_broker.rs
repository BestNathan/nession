use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::{oneshot, RwLock};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{debug, info, warn};

use super::outbound::WsMessageSender;

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

/// The connection currently serving an agent's control channel.
struct ActiveControl {
    generation: ConnectionGeneration,
    sender: WsMessageSender,
}

/// Per-agent control state: the owning connection, the message sender, and
/// pending command receivers.
///
/// One record per *agent*, not per connection — which is why the two halves
/// below are separate fields rather than one `Option`. A logical agent outlives
/// its transports: when the connection serving it goes away, the agent is not
/// gone, and the record that says which connection *was* newest is exactly what
/// stops that dead connection's successor-of-predecessor from taking it back.
///
/// * [`Self::high_water_generation`] is that memory, and nothing but
///   [`CommandBroker::forget_agent`] discards it.
/// * [`Self::active`] is who is serving the agent *right now*, and it is
///   legitimately absent — while a liveness verdict is in force
///   ([`CommandBroker::evict_agent`]), and after the owning connection
///   disconnected ([`CommandBroker::release_agent`]).
///
/// Reading only `active` answers "can a command be delivered"; reading only
/// `high_water_generation` answers "is this connection still the agent's current
/// generation" — the question every state-writing message asks, and the one
/// there was no way to ask before `#960`.
struct AgentControl {
    /// The newest generation that has ever claimed this agent.
    high_water_generation: ConnectionGeneration,
    /// The connection currently serving this agent's control channel, if any.
    active: Option<ActiveControl>,
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
    ///   nothing, however many of them arrive — including after the agent's
    ///   entry was *evicted*, because eviction keeps the high-water mark
    ///   (`#960`'s second half; the mark used to go with the entry, and a stale
    ///   generation then reclaimed the agent it had already lost).
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
        let control = agents
            .entry(agent_id.to_string())
            .or_insert_with(|| AgentControl {
                high_water_generation: generation,
                active: None,
                pending_commands: HashMap::new(),
            });

        if control.high_water_generation > generation {
            // This agent already belongs to a newer connection, and nothing an
            // older one says may move it — not its sender, and (via
            // [`Self::is_current_generation`]) not its state either.
            debug!(
                "CommandBroker: ignoring claim on agent {} by {} — owned by {}",
                agent_id, generation, control.high_water_generation
            );
            return;
        }

        control.high_water_generation = generation;
        control.active = Some(ActiveControl { generation, sender });
        debug!(
            "CommandBroker: agent {} claimed by {}",
            agent_id, generation
        );
    }

    /// Whether `generation` may still speak for `agent_id` — as its **current**
    /// generation, for the messages that write the agent's state.
    ///
    /// This is the other half of the ownership rule. [`Self::claim_agent`]
    /// decides where a command goes; this decides whose report about an agent's
    /// heartbeats, sessions and addresses is still believed. They are one
    /// lifecycle read two ways, and before this they disagreed: routing followed
    /// generations while state writes followed nothing but "this connection once
    /// registered the id", so a superseded connection's late session update
    /// re-created the session its replacement's registration had just cleared
    /// (#960).
    ///
    /// True while no **newer** connection has claimed the agent. The comparison
    /// is against the high-water mark rather than against the active owner on
    /// purpose:
    ///
    /// * after a liveness eviction there is no active owner, and the generation
    ///   that was evicted is still the agent's current one — it recovers by
    ///   re-claiming, and until it does, its reports are still its own;
    /// * an agent's entry being absent means no connection has ever claimed it in
    ///   this process, so there is no newer generation to have been superseded
    ///   by, and the connection's own registration is the only authority there
    ///   is. (Registration is where that authority is created — see
    ///   `handler::ConnectionHandler::authorized_agent_id` for the identity half,
    ///   which is checked first and is what makes this arm unreachable for a
    ///   connection that never registered.)
    pub async fn is_current_generation(
        &self,
        agent_id: &str,
        generation: ConnectionGeneration,
    ) -> bool {
        let agents = self.agents.read().await;
        agents
            .get(agent_id)
            .is_none_or(|control| control.high_water_generation <= generation)
    }

    /// Release an agent's control channel **if this connection still owns it**.
    ///
    /// This is the disconnect path, and the generation check is what makes it a
    /// compare-and-remove: a connection that a reconnect has already superseded
    /// releases only its own claim and finds it has none — closing the old
    /// WebSocket cannot unregister the agent its replacement is serving (#960).
    ///
    /// What a matching release removes is the *owner*, not the record: the
    /// high-water mark stays, because the connection on the other end of a
    /// disconnected-but-not-yet-reaped socket is exactly the one whose late
    /// frames this mark exists to refuse. `pending_commands` go with the owner —
    /// the agent has no control channel left, so work still in flight cannot
    /// complete, and resolving its waiters now is more honest than making each
    /// of them wait out its timeout. The record itself is dropped by
    /// [`Self::forget_agent`], when the agent is deleted rather than merely
    /// unreachable.
    ///
    /// Returns whether the caller was still the owner.
    pub async fn release_agent(&self, agent_id: &str, generation: ConnectionGeneration) -> bool {
        let mut agents = self.agents.write().await;
        let Some(control) = agents.get_mut(agent_id) else {
            return false;
        };
        match control.active.as_ref().map(|active| active.generation) {
            Some(current) if current == generation => {
                control.active = None;
                control.pending_commands.clear();
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
    /// there is no owner to compare against.
    ///
    /// It clears the owner and the pending commands — the verdict is that
    /// nothing will answer them — and it **keeps the high-water mark**. That is
    /// the difference between this and `#960`'s first half: removing the whole
    /// record threw away the one number that says which connection is newest, so
    /// the stale generation the mark had been refusing fell through to the
    /// insert arm and took the agent back. A verdict about liveness is not a
    /// statement about *generations*, and it does not get to erase one.
    ///
    /// The state it leaves — an agent with no owner but a known newest
    /// generation — is one that generation may claim again, which is how a live
    /// connection recovers from a sweep that fired on it. A generation *older*
    /// than the mark cannot.
    pub async fn evict_agent(&self, agent_id: &str) {
        let mut agents = self.agents.write().await;
        let Some(control) = agents.get_mut(agent_id) else {
            return;
        };
        let was_held = control.active.take().is_some();
        control.pending_commands.clear();
        if was_held {
            info!("CommandBroker: evicted agent {}", agent_id);
        }
    }

    /// Drop an agent's record entirely — the agent **does not exist** any more.
    ///
    /// The one removal that discards the high-water mark, and the only one that
    /// may: the mark exists to refuse a stale connection of *this* agent, and an
    /// agent that has been deleted has no connections left to refuse. Called
    /// where the registry entry goes, so the broker's map stays the size of the
    /// agents this server knows about rather than the size of every agent id it
    /// has ever seen.
    ///
    /// What a stale connection can still do afterwards is bounded by that: the
    /// registry no longer knows the agent, so its heartbeats, session updates
    /// and address updates are refused there (`handler::ConnectionHandler`).
    pub async fn forget_agent(&self, agent_id: &str) {
        let mut agents = self.agents.write().await;
        if agents.remove(agent_id).is_some() {
            info!("CommandBroker: forgot agent {}", agent_id);
        }
    }

    /// Send a command to an agent and return a oneshot receiver for the response.
    ///
    /// If the agent is not found, returns a receiver that immediately errors.
    /// So does an agent that is *found but unserved*: a record whose owner was
    /// released or evicted and not yet re-claimed. There is no connection to
    /// carry the command, which is the same fact as "not found" from the
    /// caller's side, and inserting a pending entry for it would be a promise
    /// nothing could keep (#960).
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
        let Some(agent) = agents.get_mut(agent_id) else {
            warn!("CommandBroker: agent {} not found in registry", agent_id);
            drop(tx);
            return rx;
        };
        // Taken here, under the same lock as the check, so the sender that is
        // used below is the one that passed it. A record with no owner is an
        // agent with no control connection — released, or evicted and not yet
        // re-claimed — which is the same answer as "not found" from the
        // caller's side: there is nothing to carry the command.
        let Some(sender) = agent.active.as_ref().map(|active| active.sender.clone()) else {
            warn!(
                "CommandBroker: agent {} has no control connection to send {} to",
                agent_id, msg_type
            );
            drop(tx);
            return rx;
        };
        info!("CommandBroker: found agent {} in registry", agent_id);

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

        drop(agents);

        let req_id = request_id.to_string();
        let aid = agent_id.to_string();
        let mt = msg_type.to_string();

        // Send the command through the channel. The command lane does not wait:
        // the connection this is going to belongs to the *agent*, and the caller
        // waiting here belongs to a browser, so waiting would spread one slow
        // agent across everyone talking to the Server. `Err` is the answer to
        // "no room" and to "no connection" alike, and both mean the same thing
        // to the caller — this command cannot be delivered now.
        let undeliverable = match sender.try_send_command(WsMessage::Text(json)) {
            Ok(()) => {
                info!(
                    "CommandBroker: sent {} to agent {} (req: {})",
                    mt, aid, req_id
                );
                false
            }
            Err(e) => {
                warn!(
                    "CommandBroker: failed to send command to agent {}: {}",
                    aid, e
                );
                true
            }
        };

        if undeliverable {
            // The command can never be answered — the transport is gone, or
            // the agent has stopped draining it — and leaving the entry in
            // `pending_commands` is what made the caller wait out its
            // 10/30s timeout to find out. Revoking it drops the oneshot
            // sender, resolving the waiter with `RecvError` now; callers
            // already read that as "Agent disconnected", which is exactly
            // what this is (#960).
            self.revoke_pending(agent_id, request_id).await;
        }

        rx
    }

    /// Take back a command that this call inserted, so its waiter fails now
    /// rather than at the far end of its timeout.
    ///
    /// Request ids are server-generated UUIDs, so this can only ever take back
    /// the caller's own entry: nothing else can be waiting under the same id,
    /// and if a response somehow won the race, the entry is already gone and
    /// there is nothing to remove.
    async fn revoke_pending(&self, agent_id: &str, request_id: &str) {
        let mut agents = self.agents.write().await;
        if let Some(agent) = agents.get_mut(agent_id) {
            agent.pending_commands.remove(request_id);
        }
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

    /// #960, the eviction half: a liveness verdict must not erase the record of
    /// which connection is newest.
    ///
    /// The sweep evicts an agent that has gone quiet. It takes the channel away
    /// whoever holds it — that is what a verdict about the agent means — but the
    /// generation it evicted is still the agent's newest, so:
    ///
    /// * the superseded generation a reconnect had already beaten cannot come
    ///   back through the gap the eviction opened (it used to: the whole record
    ///   went with the sender, so the next stale claim found an empty map and
    ///   inserted itself);
    /// * the generation that was evicted can, because a verdict about liveness
    ///   says nothing about which connection is newer.
    #[tokio::test]
    async fn a_stale_generation_cannot_reclaim_after_a_liveness_eviction() {
        let broker = CommandBroker::new();
        let stale = broker.new_connection_generation();
        let current = broker.new_connection_generation();
        let (stale_sender, mut stale_rx) = WsMessageSender::new();
        let (current_sender, _current_rx) = WsMessageSender::new();
        broker.claim_agent("a1", stale, stale_sender.clone()).await;
        broker.claim_agent("a1", current, current_sender).await;

        broker.evict_agent("a1").await;

        // The stale connection's next frame re-claims, as the loop does for
        // every inbound message.
        broker.claim_agent("a1", stale, stale_sender).await;

        let waiter = broker
            .send_command("a1", "server.session.create", "req-1", json!({}))
            .await;
        assert!(
            stale_rx.try_recv().is_err(),
            "the stale generation must not take the agent back through the eviction"
        );
        assert_fails_now(
            waiter,
            "the eviction left no owner, so nothing can carry the command",
        )
        .await;

        // The generation that was evicted is still the newest one to have
        // claimed the agent, so it — and only it — can take the channel back.
        let (recovered, mut recovered_rx) = WsMessageSender::new();
        broker.claim_agent("a1", current, recovered).await;

        let _waiter = broker
            .send_command("a1", "server.session.create", "req-2", json!({}))
            .await;
        assert!(
            recovered_rx.try_recv().is_ok(),
            "the evicted generation must be able to recover its channel"
        );
        assert!(
            stale_rx.try_recv().is_err(),
            "and the stale generation must still receive nothing"
        );
    }

    /// The disconnect path keeps the mark too.
    ///
    /// Releasing is owner-checked, so this is the owner going away with a
    /// superseded connection still alive behind it. Removing the record here
    /// would reopen the same gap eviction used to: the stale connection's next
    /// frame would find an empty map and claim the agent.
    #[tokio::test]
    async fn a_superseded_connection_cannot_reclaim_after_the_owner_disconnected() {
        let broker = CommandBroker::new();
        let stale = broker.new_connection_generation();
        let owner = broker.new_connection_generation();
        let (stale_sender, mut stale_rx) = WsMessageSender::new();
        let (owner_sender, _owner_rx) = WsMessageSender::new();
        broker.claim_agent("a1", stale, stale_sender.clone()).await;
        broker.claim_agent("a1", owner, owner_sender).await;

        assert!(
            broker.release_agent("a1", owner).await,
            "the owner releases"
        );

        broker.claim_agent("a1", stale, stale_sender).await;

        assert!(
            !broker.is_current_generation("a1", stale).await,
            "the released agent's newest generation is still the one that left"
        );
        let _waiter = broker
            .send_command("a1", "server.session.create", "req-1", json!({}))
            .await;
        assert!(
            stale_rx.try_recv().is_err(),
            "the superseded connection must not take over the agent the owner released"
        );
    }

    /// A record with no owner is "no connection to carry it" — the same answer
    /// as an unknown agent, and not a pending entry that waits for a timeout
    /// that cannot change anything.
    #[tokio::test]
    async fn a_command_for_an_unserved_agent_fails_now() {
        let broker = CommandBroker::new();
        let (sender, receiver) = WsMessageSender::new();
        let generation = broker.new_connection_generation();
        broker.claim_agent("a1", generation, sender).await;
        broker.release_agent("a1", generation).await;
        drop(receiver);

        let waiter = broker
            .send_command("a1", "server.session.create", "req-1", json!({}))
            .await;
        assert_fails_now(waiter, "an agent with no control connection cannot answer").await;

        let agents = broker.agents.read().await;
        assert!(
            agents
                .get("a1")
                .expect("the released agent keeps its generation record")
                .pending_commands
                .is_empty(),
            "nothing may be left waiting on a channel that does not exist"
        );
    }

    /// `forget_agent` is the one removal that drops the record, because the
    /// agent it belonged to does not exist any more: there is no stale
    /// connection of *that* agent left to refuse, and the next connection to use
    /// the id starts a new story.
    #[tokio::test]
    async fn forgetting_an_agent_drops_its_generation_record() {
        let broker = CommandBroker::new();
        let first = broker.new_connection_generation();
        let second = broker.new_connection_generation();
        let (first_sender, _first_rx) = WsMessageSender::new();
        let (second_sender, mut second_rx) = WsMessageSender::new();
        broker.claim_agent("a1", first, first_sender).await;
        broker.claim_agent("a1", second, second_sender).await;

        broker.forget_agent("a1").await;
        assert!(broker.agents.read().await.get("a1").is_none());

        // The oldest generation is claimable again — not because it won
        // anything, but because the agent it belonged to was deleted, and a
        // deleted agent's successor is a new agent as far as generations go.
        let (restarted, mut restarted_rx) = WsMessageSender::new();
        broker.claim_agent("a1", first, restarted).await;

        let _waiter = broker
            .send_command("a1", "server.session.create", "req-1", json!({}))
            .await;
        assert!(
            restarted_rx.try_recv().is_ok(),
            "a deleted agent's id starts a new record"
        );
        assert!(
            second_rx.try_recv().is_err(),
            "and the record that was dropped is not still serving anyone"
        );
    }

    /// A command that cannot be delivered must fail now, not at the far end of
    /// its timeout — the caller's answer cannot change in between.
    async fn assert_fails_now(waiter: oneshot::Receiver<serde_json::Value>, because: &str) {
        match tokio::time::timeout(std::time::Duration::from_millis(100), waiter).await {
            Ok(Err(_)) => {}
            Ok(Ok(response)) => panic!("{because} — but it answered: {response}"),
            Err(_) => panic!("{because} — but it waited for a timeout instead"),
        }
    }
}
