use nession_runtime::frame::WsFrame;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex, OwnedMutexGuard, RwLock};
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
    /// The newest generation that has ever registered or claimed this agent.
    high_water_generation: ConnectionGeneration,
    /// The connection currently serving this agent's control channel, if any.
    active: Option<ActiveControl>,
    /// One entry per in-flight request. The generation is the connection that
    /// inserted it: it is recorded so a late or duplicate reply can be
    /// attributed, but resolution is by the request id (server-generated UUID),
    /// which is what makes a reconnect's in-flight command still answerable
    /// (#743) without letting a late reply touch a different request.
    pub pending_commands: HashMap<String, PendingCommand>,
}

/// One pending request and the connection generation that created it.
struct PendingCommand {
    generation: ConnectionGeneration,
    tx: oneshot::Sender<serde_json::Value>,
}

/// The terminal outcome of a pending request (`#4434`, SC-03).
///
/// Every one of these resolves or removes exactly one pending entry; the
/// broker's counters record which happened, so "the caller timed out" and "the
/// agent disconnected" are not the same silent event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingOutcome {
    /// The agent's response arrived and was delivered.
    Response,
    /// The caller's own deadline expired; the entry is removed so a later
    /// reply is classified as late rather than delivered.
    Timeout,
    /// The caller cancelled (its connection went away, or it stopped waiting).
    Cancelled,
    /// The transport refused the command after it was inserted.
    DeliveryFailed,
    /// A second command reused the same request id; the older waiter was
    /// settled before the new one was inserted.
    Replaced,
    /// The agent disconnected; every pending entry settled with this.
    Disconnected,
}

impl PendingOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Response => "response",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
            Self::DeliveryFailed => "delivery-failed",
            Self::Replaced => "replaced",
            Self::Disconnected => "disconnected",
        }
    }
}

/// Counters for the pending-request lifecycle. Plain `AtomicU64`s: observed by a
/// log line or a metric exporter without any dependency on one.
#[derive(Default)]
pub struct PendingCounters {
    inserted: AtomicU64,
    resolved: AtomicU64,
    timed_out: AtomicU64,
    cancelled: AtomicU64,
    delivery_failed: AtomicU64,
    replaced: AtomicU64,
    disconnected: AtomicU64,
    late: AtomicU64,
}

/// A point-in-time copy of [`PendingCounters`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PendingCounterSnapshot {
    pub inserted: u64,
    pub resolved: u64,
    pub timed_out: u64,
    pub cancelled: u64,
    pub delivery_failed: u64,
    pub replaced: u64,
    pub disconnected: u64,
    pub late: u64,
}

impl PendingCounters {
    fn note(&self, outcome: PendingOutcome) {
        let counter = match outcome {
            PendingOutcome::Response => &self.resolved,
            PendingOutcome::Timeout => &self.timed_out,
            PendingOutcome::Cancelled => &self.cancelled,
            PendingOutcome::DeliveryFailed => &self.delivery_failed,
            PendingOutcome::Replaced => &self.replaced,
            PendingOutcome::Disconnected => &self.disconnected,
        };
        counter.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> PendingCounterSnapshot {
        PendingCounterSnapshot {
            inserted: self.inserted.load(Ordering::Relaxed),
            resolved: self.resolved.load(Ordering::Relaxed),
            timed_out: self.timed_out.load(Ordering::Relaxed),
            cancelled: self.cancelled.load(Ordering::Relaxed),
            delivery_failed: self.delivery_failed.load(Ordering::Relaxed),
            replaced: self.replaced.load(Ordering::Relaxed),
            disconnected: self.disconnected.load(Ordering::Relaxed),
            late: self.late.load(Ordering::Relaxed),
        }
    }
}

/// Proof that a registration holds its agent's registration gate, and so is
/// the only registration of that agent currently publishing state.
///
/// Produced by [`CommandBroker::begin_registration`] and held by the
/// registration handler across every registry, SQLite and session write it
/// makes. Dropping it releases the gate for the next registration of the same
/// agent — which then either proceeds (it is newer) or is refused (it is not).
pub struct RegistrationGuard {
    _gate: OwnedMutexGuard<()>,
}

/// Proof that an Agent deletion holds the same per-agent gate as a
/// registration.
///
/// Deletion is the other transition that can destroy an Agent record, so it
/// must not interleave with a registration of the same id. Held from the
/// Offline revalidation through the last removal, it makes a registration that
/// arrives second wait until the Agent is gone (and then register as a new
/// incarnation), while a registration that arrives first publishes Online
/// before the deletion can revalidate it.
pub struct DeletionGuard {
    _gate: OwnedMutexGuard<()>,
}

/// Proof that a connection's state update holds its Agent's registration gate
/// and that the connection is still the Agent's current generation.
///
/// Produced by [`CommandBroker::begin_address_update`]. An address update is a
/// read-modify-write of the registry's `AgentInfo`, so the generation check and
/// the write must be one ordered transition: holding this guard keeps a newer
/// registration from publishing between them, and a registration that already
/// completed makes the guard acquisition fail before any write (#3723).
pub struct AddressUpdateGuard {
    _gate: OwnedMutexGuard<()>,
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
    /// One lock per agent, held for the whole of that agent's registration
    /// transition — see [`Self::begin_registration`]. Kept beside the records
    /// because it orders *registrations*, while `agents` protects the records
    /// they read and write; conflating the two would mean holding the map lock
    /// across SQLite and session-registry awaits.
    registration_gates: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Source of [`ConnectionGeneration`]s; see that type for why they order.
    generations: AtomicU64,
    /// Pending-request lifecycle counters (`#4434`, SC-03).
    pending_counters: PendingCounters,
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
            registration_gates: Mutex::new(HashMap::new()),
            generations: AtomicU64::new(0),
            pending_counters: PendingCounters::default(),
        }
    }

    /// The pending-request counters, for logging and tests.
    pub fn pending_counters(&self) -> PendingCounterSnapshot {
        self.pending_counters.snapshot()
    }

    /// How many requests are pending for one agent, and the broker's counters.
    pub async fn pending_snapshot(&self, agent_id: &str) -> (usize, PendingCounterSnapshot) {
        let agents = self.agents.read().await;
        let pending = agents
            .get(agent_id)
            .map_or(0, |control| control.pending_commands.len());
        (pending, self.pending_counters.snapshot())
    }

    /// Hand out the identity of a newly accepted connection.
    ///
    /// Called once per connection, when its handler is built. Every ownership
    /// decision afterwards is a comparison against this number.
    pub fn new_connection_generation(&self) -> ConnectionGeneration {
        ConnectionGeneration(self.generations.fetch_add(1, Ordering::Relaxed))
    }

    /// Begin registering `agent_id` at `generation`, or refuse it because a
    /// newer connection has already done so.
    ///
    /// Registration is not just a claim: it is where an agent's **current
    /// generation authority is created**, publishing its advertised endpoint,
    /// metadata and manifest into the registry (and through to SQLite) and
    /// clearing the sessions a previous instance left behind. So the
    /// generation check and those writes have to be **one ordered transition
    /// per agent**, not a check placed before an await:
    ///
    /// * A check alone is a TOCTOU. An older registration can pass it, then a
    ///   newer registration can complete in full — registry, SQLite, sessions
    ///   — and the older one's writes can still land afterwards, restoring
    ///   state the newer registration had just replaced.
    /// * The per-agent gate below is held from the check until the caller has
    ///   finished its writes, so registrations of one agent are serialized.
    ///   The invariant is therefore **the newest generation wins regardless
    ///   of which one reaches the gate first**:
    ///   - older acquires first — it writes first, the newer one then waits,
    ///     and writes last, so the newer state is the final state;
    ///   - newer acquires first — the older one waits, then finds the higher
    ///     high-water mark and is refused here, before it can write anything.
    ///
    /// The high-water mark is written under the registry lock before the
    /// caller's writes begin, so a registration holding this guard is already
    /// the agent's current generation for [`Self::is_current_generation`]. A
    /// later [`Self::claim_agent`] with the same generation is still an
    /// ordinary claim (it is not newer, so it takes the active-sender arm);
    /// a stale connection's claim is still refused by the same mark.
    ///
    /// Returns `None` — with the gate released — when this registration is
    /// stale. The caller must then make no registry, database or session
    /// mutation at all, and must not bind its connection to the agent.
    ///
    /// Dropping the returned guard releases the gate; it must be kept alive
    /// until the last publication write has completed.
    #[must_use = "the guard releases the per-agent registration gate when dropped; hold it until the registration writes are complete"]
    pub async fn begin_registration(
        &self,
        agent_id: &str,
        generation: ConnectionGeneration,
    ) -> Option<RegistrationGuard> {
        // Look up (or create) this agent's gate without holding the map lock
        // across a wait on it: the gate itself is the ordering primitive, and
        // holding the map lock while waiting would serialize unrelated agents.
        let gate = {
            let mut gates = self.registration_gates.lock().await;
            Arc::clone(gates.entry(agent_id.to_string()).or_default())
        };
        let gate_guard = gate.lock_owned().await;

        let mut agents = self.agents.write().await;
        let control = agents
            .entry(agent_id.to_string())
            .or_insert_with(|| AgentControl {
                high_water_generation: generation,
                active: None,
                pending_commands: HashMap::new(),
            });

        if control.high_water_generation > generation {
            debug!(
                "CommandBroker: refusing registration of agent {} by {} — {} has taken it over",
                agent_id, generation, control.high_water_generation
            );
            return None;
        }

        control.high_water_generation = generation;
        debug!(
            "CommandBroker: registration gate held for agent {} by {}",
            agent_id, generation
        );
        Some(RegistrationGuard { _gate: gate_guard })
    }

    /// Take the per-Agent gate that [`Self::begin_registration`] also uses, so
    /// a deletion and a registration of the same Agent cannot interleave.
    ///
    /// Unlike registration this does not read or write the generation
    /// high-water mark: a deletion has no connection identity to record. It
    /// only orders the destructive transition against registrations of the
    /// same id.
    pub async fn begin_deletion(&self, agent_id: &str) -> DeletionGuard {
        let gate = {
            let mut gates = self.registration_gates.lock().await;
            Arc::clone(gates.entry(agent_id.to_string()).or_default())
        };
        DeletionGuard {
            _gate: gate.lock_owned().await,
        }
    }

    /// Take the per-Agent gate that [`Self::begin_registration`] also uses and
    /// verify that `generation` is still the current one.
    ///
    /// This is the fencing primitive for a connection's **state update** (an
    /// address update), as distinct from a registration: it never raises the
    /// high-water mark, because an update does not create a new authority. The
    /// gate is what makes the generation check and the caller's registry write
    /// one ordered transition; a check before the gate would be a TOCTOU
    /// (#3723).
    ///
    /// Returns `None` — with the gate released — when a newer connection has
    /// already registered the Agent. The caller must then make no registry or
    /// database mutation, and must not publish the update.
    #[must_use = "the guard releases the per-agent registration gate when dropped; hold it until the update write is complete"]
    pub async fn begin_address_update(
        &self,
        agent_id: &str,
        generation: ConnectionGeneration,
    ) -> Option<AddressUpdateGuard> {
        let gate = {
            let mut gates = self.registration_gates.lock().await;
            Arc::clone(gates.entry(agent_id.to_string()).or_default())
        };
        let gate_guard = gate.lock_owned().await;

        if !self.is_current_generation(agent_id, generation).await {
            debug!(
                "CommandBroker: refusing address update for agent {} by {} — a newer generation owns it",
                agent_id, generation
            );
            return None;
        }

        Some(AddressUpdateGuard { _gate: gate_guard })
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
    /// * an agent's entry being absent means no connection has ever registered
    ///   or claimed it in this process, so there is no newer generation to have
    ///   been superseded by, and the connection's own registration is the only
    ///   authority there is. (Registration is where that authority is created —
    ///   see `handler::ConnectionHandler::authorized_agent_id` for the identity
    ///   half, which is checked first and is what makes this arm unreachable
    ///   for a connection that never registered.)
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
    /// Settle every pending entry for one agent with a terminal outcome.
    ///
    /// Dropping each oneshot sender resolves its waiter with `RecvError`, which
    /// every caller already reads as "the agent is gone". The counter says how
    /// many that happened to, so a disconnect is observable rather than a
    /// silent fan-out of errors.
    fn settle_all_pending(&self, control: &mut AgentControl, outcome: PendingOutcome) {
        let taken: Vec<PendingCommand> = control
            .pending_commands
            .drain()
            .map(|(_, entry)| entry)
            .collect();
        let settled = taken.len() as u64;
        drop(taken);
        for _ in 0..settled {
            self.pending_counters.note(outcome);
        }
    }

    /// Returns whether the caller was still the owner.
    pub async fn release_agent(&self, agent_id: &str, generation: ConnectionGeneration) -> bool {
        let mut agents = self.agents.write().await;
        let Some(control) = agents.get_mut(agent_id) else {
            return false;
        };
        match control.active.as_ref().map(|active| active.generation) {
            Some(current) if current == generation => {
                control.active = None;
                self.settle_all_pending(control, PendingOutcome::Disconnected);
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
        self.settle_all_pending(control, PendingOutcome::Disconnected);
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
        let (removed, pending) = {
            let mut agents = self.agents.write().await;
            match agents.remove(agent_id) {
                Some(mut control) => {
                    let pending = control.pending_commands.len();
                    self.settle_all_pending(&mut control, PendingOutcome::Disconnected);
                    (true, pending)
                }
                None => (false, 0),
            }
        };
        if removed {
            info!(
                "CommandBroker: forgot agent {} ({} pending command(s) settled)",
                agent_id, pending
            );
        }
        // The registration gate goes with the record: a deleted agent has no
        // generation left for it to order. A registration already holding the
        // gate keeps its own `Arc`, so it still finishes its writes — this is
        // the deletion-versus-registration boundary, which the delete path's
        // "agent is offline" precondition owns, not the gate.
        self.registration_gates.lock().await.remove(agent_id);
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
        let Some((generation, sender)) = agent
            .active
            .as_ref()
            .map(|active| (active.generation, active.sender.clone()))
        else {
            warn!(
                "CommandBroker: agent {} has no control connection to send {} to",
                agent_id, msg_type
            );
            drop(tx);
            return rx;
        };
        info!("CommandBroker: found agent {} in registry", agent_id);

        // A reused request id is a replacement, not a second waiter: settle the
        // older one now (it can never be answered under the new owner) rather
        // than leave it in the map to be resolved by whichever response arrives.
        if let Some(previous) = agent
            .pending_commands
            .insert(request_id.to_string(), PendingCommand { generation, tx })
        {
            drop(previous.tx);
            self.pending_counters.note(PendingOutcome::Replaced);
        }
        self.pending_counters
            .inserted
            .fetch_add(1, Ordering::Relaxed);
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
                self.pending_counters.note(PendingOutcome::DeliveryFailed);
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
        let undeliverable = match sender.try_send_command(WsFrame::Text(json)) {
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
        self.settle_pending(agent_id, request_id, PendingOutcome::DeliveryFailed)
            .await;
    }

    /// Remove one pending entry and resolve its waiter with the given terminal
    /// outcome. Returns `true` when an entry was there.
    ///
    /// Idempotent by construction: a second call finds nothing and reports
    /// `false`, so a duplicate timeout or cancellation cannot turn into a second
    /// settlement. This is the caller-deadline half of SC-03.
    pub async fn settle_pending(
        &self,
        agent_id: &str,
        request_id: &str,
        outcome: PendingOutcome,
    ) -> bool {
        if outcome == PendingOutcome::Response {
            // A response is `resolve_command`'s: it carries a value, and the
            // waiter must receive it rather than an error.
            return false;
        }
        let mut agents = self.agents.write().await;
        let Some(agent) = agents.get_mut(agent_id) else {
            return false;
        };
        match agent.pending_commands.remove(request_id) {
            Some(pending) => {
                drop(pending.tx);
                self.pending_counters.note(outcome);
                debug!(
                    "CommandBroker: settled pending command {} for agent {} as {} (created by {})",
                    request_id,
                    agent_id,
                    outcome.as_str(),
                    pending.generation
                );
                true
            }
            None => false,
        }
    }

    /// The caller's deadline expired: remove the entry so a later reply is
    /// classified as late instead of delivered to a request nobody is waiting
    /// for.
    pub async fn expire_pending(&self, agent_id: &str, request_id: &str) -> bool {
        self.settle_pending(agent_id, request_id, PendingOutcome::Timeout)
            .await
    }

    /// The caller cancelled: same removal, a different recorded reason.
    pub async fn cancel_pending(&self, agent_id: &str, request_id: &str) -> bool {
        self.settle_pending(agent_id, request_id, PendingOutcome::Cancelled)
            .await
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

        if let Some(pending) = agent.pending_commands.remove(request_id) {
            let _ = pending.tx.send(response);
            self.pending_counters.note(PendingOutcome::Response);
            debug!(
                "CommandBroker: resolved pending command {} for agent {} (created by {})",
                request_id, agent_id, pending.generation
            );
            true
        } else {
            // A late or duplicate reply, or one for a request that was timed
            // out, cancelled or replaced. It settles nothing — the request it
            // names is no longer waiting — and is counted so a protocol peer
            // answering twice is observable rather than ignored.
            self.pending_counters.late.fetch_add(1, Ordering::Relaxed);
            debug!(
                "CommandBroker: no pending command {} for agent {} (late or duplicate reply)",
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
        drop(agents);
        assert_eq!(
            broker.pending_counters().delivery_failed,
            1,
            "a transport refusal is its own terminal outcome, not a timeout"
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

    /// #960, the registration boundary: registering publishes an agent's state
    /// as well as deciding which connection owns it, so a newer registration
    /// must never have to race an older one's writes.
    ///
    /// The gate is held from the generation check until the handler's writes
    /// are done, so an older registration that arrives while a newer one is
    /// applying waits here — and then finds the newer high-water mark and is
    /// refused, before its own writes could land.
    #[tokio::test]
    async fn an_older_registration_waits_for_a_newer_one_to_finish() {
        use std::future::Future;
        use std::task::{Context, Waker};

        let broker = CommandBroker::new();
        let older = broker.new_connection_generation();
        let newer = broker.new_connection_generation();

        let newer_guard = broker
            .begin_registration("a1", newer)
            .await
            .expect("the newest generation registers");
        let mut waiting = Box::pin(broker.begin_registration("a1", older));
        let mut cx = Context::from_waker(Waker::noop());
        assert!(
            waiting.as_mut().poll(&mut cx).is_pending(),
            "an older registration must wait for the in-flight newer one, not write beside it"
        );

        // The newer registration finishes its writes and releases the gate.
        drop(newer_guard);
        assert!(
            waiting.await.is_none(),
            "the older generation must be refused once the newer one has published"
        );
        assert!(
            broker.is_current_generation("a1", newer).await,
            "the newest generation remains the agent's current one"
        );
    }

    /// The other legal arrival order: the older registration writes first, and
    /// the newer one writes after it. The final authority is the newer one,
    /// and its later claim is an ordinary claim.
    #[tokio::test]
    async fn a_newer_registration_takes_over_from_an_older_one() {
        let broker = CommandBroker::new();
        let older = broker.new_connection_generation();
        let newer = broker.new_connection_generation();

        assert!(
            broker.begin_registration("a1", older).await.is_some(),
            "the first registration is accepted"
        );
        assert!(
            broker.begin_registration("a1", newer).await.is_some(),
            "a newer generation may register over it"
        );

        assert!(broker.is_current_generation("a1", newer).await);
        assert!(!broker.is_current_generation("a1", older).await);

        // Registration raised the mark; the later claim by the same generation
        // is not refused by it.
        let (sender, mut rx) = WsMessageSender::new();
        broker.claim_agent("a1", newer, sender).await;
        let _waiter = broker
            .send_command("a1", "server.session.create", "req-1", json!({}))
            .await;
        assert!(
            rx.try_recv().is_ok(),
            "the registered and claimed generation receives the agent's commands"
        );
    }

    /// A liveness eviction keeps the high-water mark, and registration reads
    /// the same mark: a stale generation cannot register its way back in
    /// through the gap an eviction opens, while the evicted generation — still
    /// the newest — can register again.
    #[tokio::test]
    async fn a_stale_registration_cannot_reclaim_after_a_liveness_eviction() {
        let broker = CommandBroker::new();
        let stale = broker.new_connection_generation();
        let current = broker.new_connection_generation();

        assert!(broker.begin_registration("a1", current).await.is_some());
        broker.evict_agent("a1").await;

        assert!(
            broker.begin_registration("a1", stale).await.is_none(),
            "the eviction keeps the mark, so a stale registration is still refused"
        );
        assert!(
            broker.begin_registration("a1", current).await.is_some(),
            "the evicted generation is still the newest one and may recover"
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

    /// SC-03: the caller's deadline settles the entry exactly once, and a reply
    /// that arrives afterwards is late — it cannot resolve anything.
    #[tokio::test]
    async fn a_timeout_settles_once_and_a_late_reply_cannot_revive_it() {
        let broker = CommandBroker::new();
        let (sender, _keepalive) = WsMessageSender::new();
        broker
            .claim_agent("a1", broker.new_connection_generation(), sender)
            .await;
        let waiter = broker
            .send_command("a1", "server.session.create", "req-1", json!({}))
            .await;

        assert!(broker.expire_pending("a1", "req-1").await);
        assert!(
            !broker.expire_pending("a1", "req-1").await,
            "a second expiry must not settle a second entry"
        );
        waiter.await.expect_err("the timed-out waiter must be told");

        assert!(
            !broker
                .resolve_command("a1", "req-1", json!({ "success": true }))
                .await,
            "a late reply must not resolve a request that already timed out"
        );
        let counters = broker.pending_counters();
        assert_eq!(counters.timed_out, 1);
        assert_eq!(counters.late, 1);
        assert_eq!(counters.resolved, 0);
        assert_eq!(broker.pending_snapshot("a1").await.0, 0);
    }

    /// SC-03: cancellation is a distinct terminal outcome, idempotent like the
    /// timeout, and counted as itself.
    #[tokio::test]
    async fn a_cancellation_settles_once_and_is_counted_separately() {
        let broker = CommandBroker::new();
        let (sender, _keepalive) = WsMessageSender::new();
        broker
            .claim_agent("a1", broker.new_connection_generation(), sender)
            .await;
        let waiter = broker
            .send_command("a1", "server.session.create", "req-1", json!({}))
            .await;

        assert!(broker.cancel_pending("a1", "req-1").await);
        assert!(!broker.cancel_pending("a1", "req-1").await);
        waiter.await.expect_err("the cancelled waiter must be told");

        let counters = broker.pending_counters();
        assert_eq!(counters.cancelled, 1);
        assert_eq!(counters.timed_out, 0);
        assert_eq!(counters.resolved, 0);
        assert_eq!(broker.pending_snapshot("a1").await.0, 0);
    }

    /// SC-03: replacing a request id settles the old waiter and leaves exactly
    /// one entry, which the response resolves.
    #[tokio::test]
    async fn a_replacement_settles_the_old_waiter_then_the_new_one_resolves() {
        let broker = CommandBroker::new();
        let (sender, _keepalive) = WsMessageSender::new();
        broker
            .claim_agent("a1", broker.new_connection_generation(), sender)
            .await;

        let first = broker
            .send_command("a1", "server.session.create", "req-1", json!({}))
            .await;
        let second = broker
            .send_command("a1", "server.session.create", "req-1", json!({}))
            .await;
        first
            .await
            .expect_err("the replaced waiter must be settled, not left to race the response");

        assert_eq!(
            broker.pending_snapshot("a1").await.0,
            1,
            "a replacement is one entry, not two"
        );
        assert!(
            broker
                .resolve_command("a1", "req-1", json!({ "success": true }))
                .await
        );
        assert_eq!(
            second.await.expect("the new request answers")["success"],
            json!(true)
        );
        let counters = broker.pending_counters();
        assert_eq!(counters.replaced, 1);
        assert_eq!(counters.resolved, 1);
    }

    /// SC-03: a disconnect settles every pending waiter exactly once, and the
    /// reason is recorded rather than only surfacing as a generic `RecvError`.
    #[tokio::test]
    async fn a_disconnect_settles_every_pending_entry_once() {
        let broker = CommandBroker::new();
        let (sender, _keepalive) = WsMessageSender::new();
        let generation = broker.new_connection_generation();
        broker.claim_agent("a1", generation, sender).await;

        let first = broker
            .send_command("a1", "server.session.create", "req-1", json!({}))
            .await;
        let second = broker
            .send_command("a1", "server.session.create", "req-2", json!({}))
            .await;

        assert!(broker.release_agent("a1", generation).await);
        first.await.expect_err("the first waiter is settled");
        second.await.expect_err("the second waiter is settled");
        assert!(
            !broker.release_agent("a1", generation).await,
            "a second release is a no-op and must not settle anything twice"
        );

        let counters = broker.pending_counters();
        assert_eq!(counters.disconnected, 2);
        assert_eq!(broker.pending_snapshot("a1").await.0, 0);
    }

    /// SC-03: a request from an old generation that already timed out cannot
    /// affect the new owner's request, even when the late reply is for the same
    /// agent.
    #[tokio::test]
    async fn an_old_generations_late_reply_cannot_settle_the_new_owners_request() {
        let broker = CommandBroker::new();
        let old = broker.new_connection_generation();
        let (old_sender, _old_keepalive) = WsMessageSender::new();
        broker.claim_agent("a1", old, old_sender).await;
        let old_waiter = broker
            .send_command("a1", "server.session.create", "req-old", json!({}))
            .await;
        assert!(broker.expire_pending("a1", "req-old").await);
        old_waiter
            .await
            .expect_err("the old request ended at its deadline");

        let new = broker.new_connection_generation();
        let (new_sender, _new_keepalive) = WsMessageSender::new();
        broker.claim_agent("a1", new, new_sender).await;
        let new_waiter = broker
            .send_command("a1", "server.session.create", "req-new", json!({}))
            .await;

        assert!(
            !broker
                .resolve_command("a1", "req-old", json!({ "success": false }))
                .await,
            "the old generation's late reply names a request nobody is waiting for"
        );
        assert!(
            broker
                .resolve_command("a1", "req-new", json!({ "success": true }))
                .await,
            "the new owner's request is still waiting"
        );
        assert_eq!(
            new_waiter.await.expect("the new request answers")["success"],
            json!(true)
        );
        assert_eq!(broker.pending_counters().late, 1);
    }
}
