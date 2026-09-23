//! How one connection's frames are scheduled (`#961-C`).
//!
//! Before this module the read loop *was* the scheduler: `read.next()` →
//! `handle_message(..).await` → `read.next()`. A request that waited on an
//! agent therefore held every later frame on that connection behind it,
//! including requests that had nothing to do with it — and the protocol has
//! never needed that. A reply is matched by the envelope's `id`, so the
//! *position* of a reply carries nothing (see `docs/architecture/protocol.md`).
//!
//! What the serial loop did buy is ordering, and ordering is real — but for a
//! much smaller set of frames than it was applied to. So the loop keeps the
//! frames whose ordering is load-bearing for itself and hands the rest to a
//! lane, and which frames those are is **declared per Protocol Unit** in the
//! single `server_routes!` invocation (see [`ExecutionPolicy`] for why that is
//! the only place it can honestly live):
//!
//! | policy | frames | what the reader does |
//! |---|---|---|
//! | [`ExecutionPolicy::Ordered`] | `server.auth`, `server.agent.register`, `server.session.attach`, `server.relay.*` | waits for both lanes, then runs it — so it is applied, and answered, *after* everything read before it |
//! | [`ExecutionPolicy::Inline`] | every other unit, every control wire, every frame this Server only forwards, and anything that is not a protocol frame | runs it where it stands |
//! | [`ExecutionPolicy::Query`] | the read-only units | admits it to a bounded lane and reads the next frame |
//! | [`ExecutionPolicy::Key`] | the units that mutate a resource | queues it behind that resource's own queue and reads the next frame |
//!
//! ## The keyed mutation lane (`#961-E`)
//!
//! A mutation cannot be admitted the way a query is. Two of them for one
//! session have an order the *client* meant: `session.create` then
//! `session.kill` is a session that was created and then killed, and running
//! them on two tasks makes the outcome depend on who won a scheduling race —
//! which is the "mutation side effects must not become nondeterministic under
//! concurrency" the requirement names. Nor may they be serialised against each
//! other: two sessions have nothing to do with each other, and making one wait
//! on the other is the head-of-line blocking this stage exists to remove, one
//! resource domain up.
//!
//! [`KeyedLane`] is the middle: work is queued under a [`ResourceKey`], and one
//! worker per key runs that key's work in arrival order. Same key, serial and
//! in order; different keys, independent. Which key a unit is queued under is
//! read from the operation's own semantics — never guessed from the wire name;
//! see [`ResourceKey`].
//!
//! ## Why the ordered lane waits, and for how long
//!
//! The barrier in front of an `Ordered` frame is what keeps its guarantee
//! ("auth must take effect before the operations that depend on it") true in a
//! connection that is no longer serial. Without it, `before / auth / after`
//! written back to back would have the auth applied before the first query had
//! even been *scheduled* — the query would then be served by an authentication
//! it predates, and its refusal (or the auth's own reply) would arrive in an
//! order nothing could predict. It is bounded, because every query in flight is
//! bounded: each one is a handler that times out (10 s, 15 s, 3 s) rather than
//! waiting forever.
//!
//! ## Why the bound is a bound on the *reader*
//!
//! [`QueryLane::acquire`] and [`KeyedLane::enqueue`] wait when the lane they
//! feed is full, and the waiter is the read loop — so a connection that has
//! filled a lane stops being read from. That is the whole of #961's "no
//! per-message unbounded `tokio::spawn`": the tasks a connection may have in
//! flight is a number, and the way it is enforced is that the frame which would
//! exceed it is not read until there is room for it. The bound is per connection
//! rather than process-wide, because what it protects is the *connection's*
//! ability to make progress, and one busy browser must not consume the fleet's
//! budget.
//!
//! Waiting on a lane does not hold the connection's *writes*: the outbound path
//! is its own task with its own bound (`server::outbound`), so a reader parked
//! on a full lane still has its ping written and its terminal frames relayed.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Mutex, Notify, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;
use tracing::{debug, error, warn};

use crate::server::handler::{unit_policy, ConnectionHandler, HandlerAction};
use crate::server::outbound::WsMessageSender;
use nession_protocol::ProtocolMessage;

/// The default number of queries one connection may have in flight.
///
/// Derived from the config field of the same name so the two cannot drift: a
/// deployment that sets `query_concurrency_per_connection` is choosing this
/// number. See [`QueryLane`] for what reaching it does.
pub const DEFAULT_QUERY_CONCURRENCY: usize =
    nession_common::config::DEFAULT_QUERY_CONCURRENCY_PER_CONNECTION;

/// How many mutations one resource may have queued before the reader waits.
///
/// A *depth per key*, not a total: the bound that matters is "how far ahead of
/// the provider may one client get on one resource", and a total would let one
/// flooded session consume the budget of every other session on the connection.
/// Eight queued mutations for one session is already a client scripting a
/// session faster than the agent that owns it can act on it — a client that is
/// merely clicking in the UI never approaches it.
///
/// The agent's own socket states the same number for the same reason
/// (`nession-agent`'s `server::execution`), and the two are deliberately not
/// derived from one constant: a concurrency policy belongs to the runtime that
/// implements it (#961 constraints), and these are two runtimes with two
/// workloads.
pub const DEFAULT_KEY_QUEUE_DEPTH: usize = 8;

/// How long a connection's lanes are given to stop when it ends.
///
/// The lanes are *aborted* rather than drained (see [`Lanes::shutdown`]), so
/// this is a ceiling on a wait that should not happen — a task stops at its
/// first await point after the abort — not a budget anything is expected to use.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

/// The resource a mutation is ordered against.
///
/// A key is what makes two mutations "the same thing": same key, they run one
/// after the other in arrival order; different keys, they do not wait for each
/// other at all.
///
/// The variants name the *kind* of resource because the same string can be
/// both — an agent called `notes` and an env file called `notes` are not the
/// same resource, and a bare `String` key would merge them.
///
/// ## Where a key comes from
///
/// From the operation's own payload, in the same `server_routes!` arm that
/// declares the unit's policy — never from the wire name. `#961` states this
/// directly ("具体 key 规则应由 operation semantics 决定，而不是由 transport
/// 猜测"), and the payloads make the point on their own: `server.session.create`
/// names its target with an `agent_id` and a `name`, `server.session.kill` names
/// the *same* resource with one joined `session_id`, and nothing about either
/// wire says so. A transport that guessed would either merge the two spellings
/// (two keys for one session, and the create's ordering lost) or split them
/// wrongly.
///
/// The joined form is what the key uses, because the joined form is what the
/// session registry already calls that resource (`agent_id:session_name`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ResourceKey {
    /// A tmux session, by `agent_id:session_name`.
    Session(String),
    /// An env file, by the source it lives on and its name.
    Env(String),
}

impl std::fmt::Display for ResourceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Session(id) => write!(f, "session:{id}"),
            Self::Env(id) => write!(f, "env:{id}"),
        }
    }
}

/// How the reader dispatches one frame.
///
/// The policy is a property of the **Protocol Unit**, declared beside the unit
/// in the one `server_routes!` invocation that also produces the manifest and
/// the dispatcher — so a unit cannot be added without stating how it is
/// dispatched, and nothing here has to know what an `extension.*` wire is. The
/// requirement is explicit that the policy "must act on a Protocol Unit" and
/// must not be hardcoded as a prefix or a core special case; a table keyed by
/// what the Server serves is the difference between the two.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutionPolicy {
    /// Serial, and ordered against everything already read on this connection:
    /// the frame is not run until the work in flight has finished.
    ///
    /// This is the lane for messages whose *effect* later frames depend on —
    /// authentication, agent registration, session attach, the relay mode
    /// transitions — and for the same reason it is the lane whose replies must
    /// not overtake the replies of frames read before it.
    Ordered,
    /// Serial, and not ordered against the work in flight: the reader runs it
    /// where it stands.
    ///
    /// Every frame that is *not* a unit lands here, and so does every unit that
    /// is not in the table above: a control wire, a wire this Server only
    /// forwards to an agent, a wire it does not serve at all, and anything that
    /// is not a protocol frame (a close, a ping, a binary blob). A forwarded
    /// wire is here on purpose — the Server cannot state a scheduling policy for
    /// a unit it does not own, and the honest default for a message whose
    /// semantics belong to someone else is the one that does not reorder it.
    Inline,
    /// Bounded parallel: admitted to [`QueryLane`], run on its own task, and
    /// answered whenever it finishes.
    ///
    /// **Read-only units only.** A query's handler runs against a *snapshot* of
    /// the connection ([`ConnectionHandler`] is cloned for it), so anything it
    /// changed about the connection itself would be changed in the snapshot and
    /// lost. It may of course read and write the shared registries — that is
    /// what a query does — but it answers, and it does nothing else: a `Close`
    /// or a `Relay` from a query is a declaration error and is logged as one.
    Query,
    /// A mutation: queued behind every other mutation of the same
    /// [`ResourceKey`], and independent of every other key's.
    ///
    /// Carries its key because the key is half of what the policy *is*: "how is
    /// this dispatched" cannot be answered for a mutation without saying what it
    /// is ordered against. Like a query, it runs against a snapshot of the
    /// connection, for the same reason and with the same consequence — a
    /// mutation a connection depends on (auth, register, attach, relay mode) is
    /// a connection transition and belongs on [`ExecutionPolicy::Ordered`], not
    /// here. Every unit declared `Key` today is a registry mutation
    /// (session create/kill), an agent mutation, or an env-file mutation, and
    /// none of them changes what this connection *is*.
    Key(ResourceKey),
}

/// The policy one wire is dispatched under.
///
/// A unit's policy comes from the declaration; anything else is
/// [`ExecutionPolicy::Inline`] — see that variant for why an undeclared wire is
/// not guessed at.
///
/// The payload is what a `Key` policy reads its resource out of, so this takes
/// it by reference: the same asymmetry the agent's `p2p_policy` has, and for the
/// same reason — the policy is read *before* the arm runs, and the arm consumes
/// the payload.
pub fn policy_for_wire(wire: &str, payload: &serde_json::Value) -> ExecutionPolicy {
    unit_policy(wire, payload).unwrap_or(ExecutionPolicy::Inline)
}

/// The queries one connection has in flight: the bound, the tasks, and what can
/// be observed about them while they run.
///
/// Owned by the connection's read loop, which is also the only thing that
/// admits to it.
pub struct QueryLane {
    /// One permit per query in flight. See [`Self::acquire`] for why the waiter
    /// is the reader.
    permits: Arc<Semaphore>,
    /// The tasks themselves. A `JoinSet` rather than a bare `Vec<JoinHandle>`:
    /// the reader has to be able to *wait for all of them* before an ordered
    /// frame, and it has to be able to end them all when the connection does,
    /// and both of those are things a join set is.
    tasks: JoinSet<()>,
    counters: Arc<Counters>,
    bound: usize,
}

/// What a caller can see about a connection's query lane.
///
/// The same idea as [`crate::server::outbound::OutboundSnapshot`], for the same
/// reason: a bound that cannot be observed is indistinguishable from an outage,
/// and "the lane was full" is the fact a reader of these numbers is looking for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaneSnapshot {
    /// Queries running right now.
    pub in_flight: usize,
    /// The bound `in_flight` moves within.
    pub bound: usize,
    /// Queries admitted since the connection opened.
    pub started: u64,
    /// Queries that have finished, answered or not.
    pub completed: u64,
    /// The most that were ever in flight at once.
    pub peak_in_flight: u64,
    /// Admissions that found the lane full and made the reader wait.
    pub admission_waits: u64,
}

/// What a caller can see about a connection's keyed mutation lane (`#961-E`).
///
/// `keys` and `queued` are the two numbers that tell "one session is flooded"
/// apart from "the connection is busy": the first says how many distinct
/// resources have work, the second how much work is waiting in total. A bound
/// that could not be observed would be indistinguishable from an outage, and
/// "this resource's queue was full" is the fact a reader of these numbers is
/// looking for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeySnapshot {
    /// Resources with a worker running or work queued.
    pub keys: usize,
    /// Mutations queued and not yet started.
    pub queued: usize,
    /// The bound one key's queue moves within.
    pub depth: usize,
    /// The deepest single key's queue: the per-key depth that is furthest ahead.
    ///
    /// `#961`'s backpressure section asks for per-key queue depth to be
    /// observable, and it is only meaningful against a key: eight mutations
    /// queued across eight resources is a busy connection, while eight queued
    /// in *one* resource is one session being flooded. `keys` and `queued` tell
    /// those apart, and this is the depth of whichever key is furthest ahead.
    pub deepest: usize,
    /// Mutations started since the connection opened.
    pub started: u64,
    /// Mutations that have finished.
    pub completed: u64,
    /// Enqueues that found the key's queue full and made the reader wait.
    pub admission_waits: u64,
}

#[derive(Default)]
struct Counters {
    started: AtomicU64,
    completed: AtomicU64,
    peak_in_flight: AtomicU64,
    admission_waits: AtomicU64,
}

impl QueryLane {
    /// A lane that admits `bound` queries at a time.
    ///
    /// A bound of zero would be a connection that can never answer a query, so
    /// it is raised to one rather than obeyed: the value comes from config, and
    /// "the lane is shut" is not a thing a deployment can mean.
    pub fn new(bound: usize) -> Self {
        let bound = bound.max(1);
        Self {
            permits: Arc::new(Semaphore::new(bound)),
            tasks: JoinSet::new(),
            counters: Arc::new(Counters::default()),
            bound,
        }
    }

    /// Admit one query and run it on its own task.
    ///
    /// Waits for a slot first, which is the backpressure described in the module
    /// docs. The future is not polled until the task starts, so nothing about
    /// the work happens before it has a slot.
    pub async fn dispatch<F>(&mut self, work: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let permit = self.acquire().await;
        self.counters.started.fetch_add(1, Ordering::Relaxed);
        self.counters
            .peak_in_flight
            .fetch_max(self.in_flight() as u64, Ordering::Relaxed);
        self.tasks
            .spawn(run(work, permit, Arc::clone(&self.counters)));
    }

    /// Wait for every query in flight.
    ///
    /// [`Lanes::drain`] calls this before an [`ExecutionPolicy::Ordered`] frame:
    /// everything read before that frame has finished by the time it is applied,
    /// which is what makes the identity and mode transitions ordered without
    /// making every other frame ordered too.
    pub async fn drain(&mut self) {
        while let Some(joined) = self.tasks.join_next().await {
            if let Err(e) = joined {
                if e.is_panic() {
                    // A query that panicked is a bug in that handler, and the
                    // connection is not where it should surface: the peer gets
                    // no reply and its own timeout, and this is the only place
                    // the panic is visible.
                    error!("a query panicked: {e}");
                } else {
                    debug!("a query was cancelled: {e}");
                }
            }
        }
    }

    /// End every query in flight and wait for them to stop, for at most `grace`.
    ///
    /// Called when the connection ends. Aborting is what keeps an abandoned
    /// query from writing to a connection that is closing *and* from holding it
    /// open: a query parked in `send_reply` holds a sender, and the writer only
    /// stops once every sender is gone — the same unbounded wait the outbound
    /// bound removed, one level up. The grace is a ceiling on a wait that should
    /// not happen (a task stops at its first await point after the abort), not a
    /// budget anything is expected to use.
    pub async fn shutdown(&mut self, grace: Duration) {
        self.tasks.abort_all();
        if tokio::time::timeout(grace, self.drain()).await.is_err() {
            warn!(
                "query lane: {} task(s) did not stop within {grace:?}; abandoning them",
                self.tasks.len()
            );
        }
    }

    /// What this lane is doing, for logging and tests.
    pub fn snapshot(&self) -> LaneSnapshot {
        LaneSnapshot {
            in_flight: self.in_flight(),
            bound: self.bound,
            started: self.counters.started.load(Ordering::Relaxed),
            completed: self.counters.completed.load(Ordering::Relaxed),
            peak_in_flight: self.counters.peak_in_flight.load(Ordering::Relaxed),
            admission_waits: self.counters.admission_waits.load(Ordering::Relaxed),
        }
    }

    /// Queries holding a slot: the bound minus what is left of the permits. A
    /// task that has been aborted but not yet polled still holds its slot, which
    /// is why this is read from the semaphore rather than from a task count —
    /// it is the same number a producer would wait for.
    fn in_flight(&self) -> usize {
        self.bound.saturating_sub(self.permits.available_permits())
    }

    /// Take a slot for one query, waiting for one if the lane is full.
    ///
    /// `None` means the semaphore was closed, which nothing in this module does
    /// (there is no `close` call on it). It is spelled as an `Option` rather
    /// than an `expect` because the crate denies `expect_used` outside tests,
    /// and because the arm does have an honest answer: the caller has a frame in
    /// hand that a client is waiting on, so it runs — unboundedly, once, rather
    /// than dropping a request nobody would hear about.
    async fn acquire(&mut self) -> Option<OwnedSemaphorePermit> {
        let permits = Arc::clone(&self.permits);
        if let Ok(permit) = Arc::clone(&permits).try_acquire_owned() {
            return Some(permit);
        }
        self.counters
            .admission_waits
            .fetch_add(1, Ordering::Relaxed);
        debug!(
            "query lane is full ({} in flight of {}); the connection waits for a slot \
             before reading on",
            self.in_flight(),
            self.bound
        );
        permits.acquire_owned().await.ok()
    }
}

/// Run the work while holding its slot, and count it when it ends.
///
/// The permit is held for the whole of `work`, which is what makes `in_flight`
/// mean "running" rather than "admitted", and dropped explicitly so the slot is
/// free before the completion is counted rather than after.
async fn run<F>(work: F, permit: Option<OwnedSemaphorePermit>, counters: Arc<Counters>)
where
    F: Future<Output = ()>,
{
    work.await;
    drop(permit);
    counters.completed.fetch_add(1, Ordering::Relaxed);
}

/// The lanes one connection's reader dispatches into.
///
/// One object rather than two fields at the call site, because the reader has
/// exactly three things to do to a lane — admit a query, queue a mutation, wait
/// for everything — and the *barrier* in front of an [`ExecutionPolicy::Ordered`]
/// frame only means anything if it covers both. A reader that drained the query
/// lane and forgot the mutation lane would apply an `auth` or an `attach` while
/// a mutation read before it was still running, which is precisely the
/// determinism the barrier exists to provide.
pub struct Lanes {
    queries: QueryLane,
    keys: KeyedLane,
}

impl Lanes {
    /// The lanes a connection opens with.
    pub fn new(query_concurrency: usize) -> Self {
        Self {
            queries: QueryLane::new(query_concurrency),
            keys: KeyedLane::new(DEFAULT_KEY_QUEUE_DEPTH),
        }
    }

    /// Admit one read-only frame, waiting for a slot if the lane is full.
    ///
    /// `handler` is the connection's clone, taken when the frame was read: the
    /// query sees the connection's identity as of that moment, and cannot move
    /// it.
    pub async fn dispatch_query(
        &mut self,
        handler: ConnectionHandler,
        msg: ProtocolMessage<serde_json::Value>,
        sender: WsMessageSender,
    ) {
        self.queries
            .dispatch(answer(handler, msg, sender, "a query"))
            .await;
    }

    /// Queue one mutation behind its resource's own queue, waiting for room if
    /// that queue is full.
    ///
    /// The same handler contract as [`Self::dispatch_query`], and for the same
    /// reason: a mutation declared `Key` runs against a snapshot of the
    /// connection, because every one of them mutates a *registry* and none of
    /// them changes what this connection is.
    pub async fn dispatch_mutation(
        &mut self,
        key: ResourceKey,
        handler: ConnectionHandler,
        msg: ProtocolMessage<serde_json::Value>,
        sender: WsMessageSender,
    ) {
        self.keys
            .enqueue(key, Box::pin(answer(handler, msg, sender, "a mutation")))
            .await;
    }

    /// Wait for everything the lanes have: the barrier in front of an
    /// [`ExecutionPolicy::Ordered`] frame.
    pub async fn drain(&mut self) {
        self.queries.drain().await;
        self.keys.drain().await;
    }

    /// End everything in flight, waiting at most `grace` for it to stop.
    ///
    /// Called when the connection ends. Aborting is the policy rather than a
    /// shortcut: the frames in these lanes belong to a peer that is gone, and a
    /// task parked in `send_reply` holds a sender — the writer only stops once
    /// every sender is gone, so an abandoned task would hold the connection's
    /// shutdown open for as long as the peer's TCP stack took to give up. The
    /// grace is a ceiling on a wait that should not happen (a task stops at its
    /// first await point after the abort), not a budget anything is expected to
    /// use.
    pub async fn shutdown(&mut self, grace: Duration) {
        self.queries.shutdown(grace).await;
        self.keys.shutdown(grace).await;
    }

    /// What both lanes are doing, for logging and tests.
    pub async fn snapshot(&self) -> (LaneSnapshot, KeySnapshot) {
        (self.queries.snapshot(), self.keys.snapshot().await)
    }
}

/// Run one lane's frame and answer it through the connection's reply lane.
///
/// Shared by both lanes because the two differ in *when* they may run, not in
/// what they do with the handler. `lane` names the declaration in the failure
/// message, so a unit that answers with a connection action says which of the
/// two lanes it was declared on.
async fn answer(
    mut handler: ConnectionHandler,
    msg: ProtocolMessage<serde_json::Value>,
    sender: WsMessageSender,
    lane: &'static str,
) {
    match handler.handle_protocol_message(msg).await {
        Ok(HandlerAction::Reply(Some(reply))) => {
            // The reply lane waits for room and never drops, so the only error
            // here is the connection being over — in which case there is nobody
            // left to answer.
            if sender.send_reply(reply).await.is_err() {
                debug!("the connection ended before a lane's answer could be written");
            }
        }
        Ok(HandlerAction::Reply(None)) => {}
        Ok(HandlerAction::Close) | Ok(HandlerAction::Relay { .. }) => error!(
            "a unit declared as {lane} answered with a connection action; a lane runs \
             against a snapshot of the connection, so a connection transition has to be \
             declared `Ordered` — see `ExecutionPolicy`"
        ),
        Err(e) => error!("{lane} failed: {e:#}"),
    }
}

/// One boxed unit of work, as the key lane carries it.
///
/// Boxed because the key lane keeps work in a queue until a worker can run it,
/// and the futures the reader produces are all different types. One allocation
/// per queued frame, on a path that already parses a JSON envelope.
type Work = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

/// One resource's pending mutations and the worker that runs them.
#[derive(Default)]
struct KeyQueue {
    pending: VecDeque<Work>,
    /// Whether a worker task exists for this key.
    ///
    /// The flag and the queue live under the same lock, which is what makes
    /// "exactly one worker per key" a fact rather than a race: whoever flips it
    /// is the one that spawns, and whoever reads it `true` only enqueues.
    worker: bool,
}

/// Per-resource FIFO for mutations (`#961-E`).
///
/// One worker per key, spawned when the key has work and gone when it does not.
/// Work is queued in arrival order and run in that order, so a mutation can
/// never overtake an earlier mutation of the same resource — which is the
/// guarantee `#961` calls "mutation side effects must not become
/// nondeterministic under concurrency". Different keys have different queues and
/// different workers, so they are independent by construction rather than by
/// the reader happening to interleave them.
///
/// An idle key is removed from the map when its worker finishes, so the map
/// holds only the resources actually in flight and cannot grow with everything
/// the connection has ever touched.
struct KeyedLane {
    inner: Arc<KeyInner>,
    /// The worker tasks.
    ///
    /// Behind a lock of its own so that admitting a mutation needs `&self`
    /// rather than `&mut self`: the lane is reached from the reader, and a
    /// reader parked on a full key is *still* reachable from elsewhere. (The
    /// tests are what "elsewhere" is here, and they found it — an exclusive
    /// admit would have made the observation of a full queue a deadlock.) The
    /// guard is taken only to spawn, and never held across an await.
    ///
    /// `drain` and `shutdown` do take `&mut self`, which is honest: only the
    /// reader ever ends a lane, and it has the lane to itself when it does.
    workers: Mutex<JoinSet<()>>,
}

struct KeyInner {
    /// The queues, and the only lock this lane takes. Never held across an
    /// await: every critical section here is a `VecDeque` push or pop.
    queues: Mutex<HashMap<ResourceKey, KeyQueue>>,
    depth: usize,
    /// Signalled whenever a queue loses an entry, and when a key goes idle, so
    /// an enqueue waiting for room and a `drain` waiting for the last mutation
    /// both re-check. Coarse on purpose — it does not say *which* key moved, and
    /// a waiter woken for another key simply waits again.
    room: Notify,
    started: AtomicU64,
    completed: AtomicU64,
    admission_waits: AtomicU64,
}

impl KeyedLane {
    fn new(depth: usize) -> Self {
        Self {
            inner: Arc::new(KeyInner {
                queues: Mutex::new(HashMap::new()),
                depth: depth.max(1),
                room: Notify::new(),
                started: AtomicU64::new(0),
                completed: AtomicU64::new(0),
                admission_waits: AtomicU64::new(0),
            }),
            workers: Mutex::new(JoinSet::new()),
        }
    }

    /// Queue one mutation, waiting for room in that key's queue if it is full.
    ///
    /// The wait is the backpressure: while it lasts the reader is not reading,
    /// so the queue cannot grow with the message count. See this module's docs
    /// for why the waiter is the reader and what that costs.
    async fn enqueue(&self, key: ResourceKey, work: Work) {
        let mut work = Some(work);
        loop {
            // Register for the wake-up *before* looking, so a queue that frees
            // its last slot between the look and the await is not a lost
            // wake-up. `enable` is what makes the registration happen here
            // rather than at the first poll.
            let room = self.inner.room.notified();
            tokio::pin!(room);
            room.as_mut().enable();

            let spawn = {
                let mut queues = self.inner.queues.lock().await;
                let queue = queues.entry(key.clone()).or_default();
                if queue.pending.len() < self.inner.depth {
                    // `work` is `None` only after a successful push, and that
                    // path returns; this arm is unreachable, and spelled so
                    // rather than as an `expect`, which this crate denies.
                    let Some(queued) = work.take() else { return };
                    queue.pending.push_back(queued);
                    if queue.worker {
                        false
                    } else {
                        queue.worker = true;
                        true
                    }
                } else {
                    false
                }
            };

            if spawn {
                self.inner.started.fetch_add(1, Ordering::Relaxed);
                let inner = Arc::clone(&self.inner);
                let worker_key = key;
                let mut workers = self.workers.lock().await;
                workers.spawn(async move { work_key(inner, worker_key).await });
                return;
            }
            if work.is_none() {
                return;
            }
            self.inner.admission_waits.fetch_add(1, Ordering::Relaxed);
            debug!(
                "key lane: `{key}` is at its queue depth ({}); the connection waits \
                 before reading on",
                self.inner.depth
            );
            room.await;
        }
    }

    /// Wait until every key's queue is empty and every worker has stopped.
    ///
    /// "Stopped" rather than "empty": a worker removes its key's entry as its
    /// last act, so an empty map is the point at which the last mutation has
    /// finished running rather than merely been popped.
    async fn drain(&mut self) {
        loop {
            let room = self.inner.room.notified();
            tokio::pin!(room);
            room.as_mut().enable();
            if self.inner.queues.lock().await.is_empty() {
                return;
            }
            room.await;
        }
    }

    /// End every worker, waiting at most `grace`. Queued work is dropped.
    async fn shutdown(&mut self, grace: Duration) {
        {
            let workers = self.workers.get_mut();
            workers.abort_all();
            let stopped = async {
                while let Some(joined) = workers.join_next().await {
                    if let Err(e) = joined {
                        if !e.is_cancelled() {
                            error!("a key worker ended abnormally: {e}");
                        }
                    }
                }
            };
            if tokio::time::timeout(grace, stopped).await.is_err() {
                warn!(
                    "key lane: {} worker(s) did not stop within {grace:?}; abandoning them",
                    workers.len()
                );
            }
        }

        // Dropped here rather than left in the map. A worker pops its queue's
        // entries as it runs them and removes the key when it finds none, so
        // work that was never started has nobody left to pop it once the
        // workers are gone — and a lane that reported a non-empty queue after
        // its own shutdown would be describing work that cannot run.
        self.inner.queues.lock().await.clear();
    }

    async fn snapshot(&self) -> KeySnapshot {
        let queues = self.inner.queues.lock().await;
        KeySnapshot {
            keys: queues.len(),
            queued: queues.values().map(|q| q.pending.len()).sum(),
            depth: self.inner.depth,
            deepest: queues.values().map(|q| q.pending.len()).max().unwrap_or(0),
            started: self.inner.started.load(Ordering::Relaxed),
            completed: self.inner.completed.load(Ordering::Relaxed),
            admission_waits: self.inner.admission_waits.load(Ordering::Relaxed),
        }
    }
}

/// Run one key's queued mutations, one at a time, until the queue is empty.
///
/// The wake-up is signalled after the lock is released on every turn, not only
/// when the key goes idle: an enqueue waiting for room is woken by any pop, and
/// a `drain` is woken by the removal that ends the key. Both register before
/// they check, so neither depends on the signal arriving at a particular moment.
async fn work_key(inner: Arc<KeyInner>, key: ResourceKey) {
    loop {
        let next = {
            let mut queues = inner.queues.lock().await;
            match queues
                .get_mut(&key)
                .and_then(|queue| queue.pending.pop_front())
            {
                Some(work) => Some(work),
                None => {
                    queues.remove(&key);
                    None
                }
            }
        };
        inner.room.notify_waiters();

        match next {
            Some(work) => {
                work.await;
                inner.completed.fetch_add(1, Ordering::Relaxed);
            }
            None => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// A gate a test opens by handing out permits.
    ///
    /// A semaphore rather than a `Notify` because permits are *retained*: a
    /// test that opens the gate before a query has parked is not a lost
    /// wake-up, so these tests have no ordering to get wrong.
    fn gate() -> Arc<Semaphore> {
        Arc::new(Semaphore::new(0))
    }

    /// Wait for the gate to open.
    async fn pass(gate: &Arc<Semaphore>) {
        let _ = gate.acquire().await;
    }

    /// How long a lane test may take before it is a failure rather than a hang.
    ///
    /// `dispatch` is the call that waits when the lane is full and it is the call
    /// that runs the work when the lane is not a lane at all — a serialised
    /// `dispatch` parks on its first query and never reaches the second. That is
    /// the behaviour these tests exist to detect, and a test suite that hangs
    /// instead of failing reports nothing, so every one of them runs under this.
    const PATIENCE: Duration = Duration::from_secs(5);

    /// Run a lane test body, turning a parked lane into a legible failure.
    async fn within_patience<F>(what: &str, body: F)
    where
        F: std::future::Future<Output = ()>,
    {
        tokio::time::timeout(PATIENCE, body).await.unwrap_or_else(|_| {
            panic!("{what} did not finish within {PATIENCE:?}: the lane parked instead of dispatching")
        });
    }

    /// Two queries run at the same time.
    ///
    /// The two halves wait for *each other*, so a lane that ran them one after
    /// the other would park on the first and never reach the second — which is
    /// what makes this a proof of overlap rather than of promptness, and why the
    /// whole test is under a timeout: the failure it guards against is a hang,
    /// not a wrong value.
    #[tokio::test]
    async fn two_queries_overlap_execution() {
        let mut lane = QueryLane::new(2);
        let (a_ready_tx, a_ready_rx) = tokio::sync::oneshot::channel();
        let (b_ready_tx, b_ready_rx) = tokio::sync::oneshot::channel();

        within_patience("the two queries never both ran", async {
            lane.dispatch(async move {
                let _ = a_ready_tx.send(());
                let _ = b_ready_rx.await;
            })
            .await;
            lane.dispatch(async move {
                let _ = b_ready_tx.send(());
                let _ = a_ready_rx.await;
            })
            .await;
            lane.drain().await;
        })
        .await;

        let snapshot = lane.snapshot();
        assert_eq!(snapshot.started, 2);
        assert_eq!(snapshot.completed, 2);
        assert_eq!(snapshot.peak_in_flight, 2);
        assert_eq!(snapshot.in_flight, 0);
    }

    /// The lane holds at its bound: the third query does not start while two
    /// are running, and the reader — the caller of `dispatch` — is what waits.
    ///
    /// This is the "task count does not grow with the message count" property.
    /// The witness is that the third query's own body has not run, not that it
    /// arrived late.
    #[tokio::test]
    async fn the_lane_holds_at_its_bound_until_a_query_finishes() {
        // Behind a lock, because the third admission has to be made *while* the
        // test is watching: `dispatch` is the call that waits, so a test that
        // made it from its own task would park instead of observing.
        let lane = Arc::new(tokio::sync::Mutex::new(QueryLane::new(2)));
        let held = gate();
        let started = Arc::new(AtomicUsize::new(0));

        let blocked = |started: &Arc<AtomicUsize>, held: &Arc<Semaphore>| {
            let started = Arc::clone(started);
            let held = Arc::clone(held);
            async move {
                started.fetch_add(1, Ordering::SeqCst);
                pass(&held).await;
            }
        };

        within_patience("the lane never filled", async {
            let mut lane = lane.lock().await;
            lane.dispatch(blocked(&started, &held)).await;
            lane.dispatch(blocked(&started, &held)).await;
            let snapshot = lane.snapshot();
            assert_eq!(snapshot.in_flight, 2, "the two queries were not admitted");
            assert_eq!(snapshot.bound, 2);
            assert_eq!(snapshot.started, 2);
        })
        .await;

        let third = tokio::spawn({
            let lane = Arc::clone(&lane);
            let started = Arc::clone(&started);
            let held = Arc::clone(&held);
            async move {
                let mut lane = lane.lock().await;
                lane.dispatch(blocked(&started, &held)).await;
            }
        });

        // Give the third every chance to be admitted before asserting it was
        // not: it cannot be, because a slot is not free until the gate opens,
        // and the delay is what makes this about the bound rather than about
        // scheduling. The counter is admission's, not the work's, so it cannot
        // move for any other reason.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            started.load(Ordering::SeqCst),
            2,
            "a query was admitted while the lane was full"
        );

        // One finishes: the slot is free and the waiting admission proceeds.
        held.add_permits(3);
        third.await.expect("the third dispatcher's task panicked");

        let mut lane = lane.lock().await;
        lane.drain().await;
        let snapshot = lane.snapshot();
        assert_eq!(started.load(Ordering::SeqCst), 3);
        assert_eq!(snapshot.started, 3);
        assert_eq!(snapshot.completed, 3);
        assert_eq!(snapshot.in_flight, 0);
        assert_eq!(
            snapshot.admission_waits, 1,
            "exactly one admission had to wait"
        );
    }

    /// `drain` really waits: when it returns, the queries that were in flight
    /// have run to completion.
    ///
    /// Each query records that it finished, so the assertion is about the work
    /// having happened — and the queries are gated, so there is no race that
    /// could let them finish early and make a non-waiting `drain` look correct.
    #[tokio::test]
    async fn drain_returns_only_when_the_queries_in_flight_have_finished() {
        let mut lane = QueryLane::new(2);
        let held = gate();
        let finished = Arc::new(AtomicUsize::new(0));

        within_patience("the two queries were never admitted", async {
            for _ in 0..2 {
                let finished = Arc::clone(&finished);
                let held = Arc::clone(&held);
                lane.dispatch(async move {
                    pass(&held).await;
                    finished.fetch_add(1, Ordering::SeqCst);
                })
                .await;
            }
        })
        .await;

        held.add_permits(2);
        lane.drain().await;

        assert_eq!(
            finished.load(Ordering::SeqCst),
            2,
            "drain returned while queries were still running"
        );
        assert_eq!(lane.snapshot().in_flight, 0);
    }

    /// Ending the connection ends its queries, and frees their slots while it
    /// does.
    #[tokio::test]
    async fn shutdown_stops_the_queries_in_flight() {
        let mut lane = QueryLane::new(2);
        let held = gate();
        let finished = Arc::new(AtomicUsize::new(0));

        within_patience("the two queries were never admitted", async {
            for _ in 0..2 {
                let finished = Arc::clone(&finished);
                let held = Arc::clone(&held);
                lane.dispatch(async move {
                    pass(&held).await;
                    finished.fetch_add(1, Ordering::SeqCst);
                })
                .await;
            }
        })
        .await;

        lane.shutdown(Duration::from_secs(1)).await;

        assert_eq!(
            finished.load(Ordering::SeqCst),
            0,
            "the queries were let through instead of being ended"
        );
        assert_eq!(
            lane.snapshot().in_flight,
            0,
            "an ended query still holds its slot, so the connection could never close"
        );
    }

    /// A lane that is never full never makes the reader wait — the counters say
    /// which of the two happened, so a bound that is silently never reached is
    /// visible rather than assumed.
    #[tokio::test]
    async fn a_lane_with_room_never_makes_the_reader_wait() {
        let mut lane = QueryLane::new(DEFAULT_QUERY_CONCURRENCY);
        for _ in 0..DEFAULT_QUERY_CONCURRENCY {
            lane.dispatch(async {}).await;
        }
        lane.drain().await;

        let snapshot = lane.snapshot();
        assert_eq!(snapshot.started, DEFAULT_QUERY_CONCURRENCY as u64);
        assert_eq!(snapshot.completed, DEFAULT_QUERY_CONCURRENCY as u64);
        assert_eq!(snapshot.admission_waits, 0);
        assert!(
            snapshot.peak_in_flight <= snapshot.bound as u64,
            "the lane exceeded its own bound: {snapshot:?}"
        );
    }

    /// A policy is read from the declaration, and an undeclared wire is not
    /// guessed at.
    #[test]
    fn an_undeclared_wire_is_dispatched_inline() {
        let nothing = serde_json::json!({});
        assert_eq!(
            policy_for_wire("git.status", &nothing),
            ExecutionPolicy::Inline,
            "a wire this Server does not serve has no declaration to read"
        );
        assert_eq!(
            policy_for_wire("control.heartbeat", &nothing),
            ExecutionPolicy::Inline
        );
    }

    // ── The keyed mutation lane (#961-E) ────────────────────────────────────

    /// Wait for a key lane to have no work left: nothing queued, no worker.
    ///
    /// `KeyedLane::drain` is the reader's method and takes the lane exclusively,
    /// which a test holding it in an `Arc` cannot do — and a test that could not
    /// observe the lane while a concurrent enqueue was parked would have to
    /// choose between the observation and the enqueue. This polls the same
    /// state instead, under the same patience as everything else here, so a lane
    /// that never goes idle is a failure rather than a hang.
    async fn wait_idle(lane: &KeyedLane) {
        within_patience("the lane never went idle", async {
            loop {
                if lane.snapshot().await.keys == 0 {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
    }

    /// A boxed no-op, so a test states only what it is about.
    fn nothing_work() -> Work {
        Box::pin(async {})
    }

    /// Two mutations of one resource never run at once, and run in arrival
    /// order.
    ///
    /// The witness is a fact the second mutation records about the *first*:
    /// whether it had finished by the time the second started. That is the whole
    /// of "a mutation of one resource never runs alongside another mutation of
    /// the same resource", and it is deterministic in a way that observing the
    /// order they finish in is not — the second's body cannot run before the
    /// first's future has been dropped, so `finished` is either set or the lane
    /// broke its promise.
    ///
    /// The second mutation is enqueued only once the first is *already running*
    /// and parked, which is what makes the witness deterministic: the test
    /// itself decides that the first mutation is in flight before the second
    /// exists, so an overtaking worker has nowhere to hide.
    #[tokio::test]
    async fn mutations_of_one_key_never_overlap() {
        let lane = KeyedLane::new(DEFAULT_KEY_QUEUE_DEPTH);
        let held = gate();
        let first_finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let overlapped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let order = Arc::new(tokio::sync::Mutex::new(Vec::new()));

        let key = ResourceKey::Session("a1:s1".to_string());
        let (first_started_tx, first_started_rx) = tokio::sync::oneshot::channel();
        within_patience("the first mutation never started", async {
            lane.enqueue(
                key.clone(),
                Box::pin({
                    let held = Arc::clone(&held);
                    let first_finished = Arc::clone(&first_finished);
                    let order = Arc::clone(&order);
                    async move {
                        let _ = first_started_tx.send(());
                        pass(&held).await;
                        order.lock().await.push(1);
                        // Set last: "finished" means the whole mutation, not the
                        // part before its last await.
                        first_finished.store(true, Ordering::SeqCst);
                    }
                }),
            )
            .await;
            first_started_rx.await.expect("the first mutation started");
            lane.enqueue(
                key.clone(),
                Box::pin({
                    let first_finished = Arc::clone(&first_finished);
                    let overlapped = Arc::clone(&overlapped);
                    let order = Arc::clone(&order);
                    async move {
                        if !first_finished.load(Ordering::SeqCst) {
                            overlapped.store(true, Ordering::SeqCst);
                        }
                        order.lock().await.push(2);
                    }
                }),
            )
            .await;
        })
        .await;

        held.add_permits(1);
        wait_idle(&lane).await;

        assert!(
            !overlapped.load(Ordering::SeqCst),
            "a mutation of a key ran while an earlier mutation of the same key was \
             still running"
        );
        assert_eq!(*order.lock().await, vec![1, 2]);
    }

    /// Two resources are independent: work queued behind one is not behind the
    /// other.
    ///
    /// The proof is mutual waiting — the second resource's mutation *finishes*
    /// while the first's is parked, so a lane with a single queue would never
    /// reach it. That is `#961`'s "不同 resource keys 可以并行" and the reason a
    /// keyed lane is not a serial lane.
    #[tokio::test]
    async fn different_keys_do_not_wait_for_each_other() {
        let lane = KeyedLane::new(DEFAULT_KEY_QUEUE_DEPTH);
        let held = gate();
        let finished = Arc::new(AtomicUsize::new(0));

        let parked = {
            let held = Arc::clone(&held);
            Box::pin(async move { pass(&held).await }) as Work
        };
        let quick = {
            let finished = Arc::clone(&finished);
            Box::pin(async move {
                finished.fetch_add(1, Ordering::SeqCst);
            }) as Work
        };

        within_patience("the second key's mutation never ran", async {
            lane.enqueue(ResourceKey::Session("a1:s1".to_string()), parked)
                .await;
            lane.enqueue(ResourceKey::Session("a1:s2".to_string()), quick)
                .await;
            // The only thing that can stop this from being 1 is the two keys
            // sharing a queue, in which case `quick` sits behind `parked`.
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert_eq!(
                finished.load(Ordering::SeqCst),
                1,
                "a mutation of one resource waited on a mutation of another"
            );
        })
        .await;

        held.add_permits(1);
        wait_idle(&lane).await;
    }

    /// A key's queue holds at its depth, and the enqueue — the reader — is what
    /// waits.
    ///
    /// The depth bounds what is *queued*, so the running mutation is not one of
    /// them: the worker pops a mutation out of the queue to run it, which is why
    /// this test waits for the first one to have **started** before filling the
    /// queue behind it.
    #[tokio::test]
    async fn a_keys_queue_holds_at_its_depth_until_a_mutation_finishes() {
        let lane = Arc::new(KeyedLane::new(2));
        let held = gate();
        let started = Arc::new(AtomicUsize::new(0));
        let key = ResourceKey::Session("a1:s1".to_string());

        let blocked = |started: &Arc<AtomicUsize>, held: &Arc<Semaphore>| {
            let started = Arc::clone(started);
            let held = Arc::clone(held);
            Box::pin(async move {
                started.fetch_add(1, Ordering::SeqCst);
                pass(&held).await;
            }) as Work
        };

        let (first_started_tx, first_started_rx) = tokio::sync::oneshot::channel();
        within_patience("the first mutation never started", async {
            lane.enqueue(key.clone(), {
                let started = Arc::clone(&started);
                let held = Arc::clone(&held);
                Box::pin(async move {
                    let _ = first_started_tx.send(());
                    started.fetch_add(1, Ordering::SeqCst);
                    pass(&held).await;
                })
            })
            .await;
            // The worker has taken the first mutation out of the queue and is
            // parked inside it, so what follows is the whole of the queue.
            first_started_rx.await.expect("the first mutation started");
            lane.enqueue(key.clone(), blocked(&started, &held)).await;
            lane.enqueue(key.clone(), blocked(&started, &held)).await;
            assert_eq!(lane.snapshot().await.queued, 2);
        })
        .await;

        let fourth = tokio::spawn({
            let lane = Arc::clone(&lane);
            let started = Arc::clone(&started);
            let held = Arc::clone(&held);
            let key = key.clone();
            async move { lane.enqueue(key, blocked(&started, &held)).await }
        });

        tokio::time::sleep(Duration::from_millis(100)).await;
        let snapshot = lane.snapshot().await;
        assert_eq!(
            snapshot.queued, 2,
            "a third mutation was queued while the key's queue was full"
        );
        assert_eq!(
            snapshot.deepest, 2,
            "the per-key depth is what a reader of these numbers is looking for"
        );
        assert_eq!(
            started.load(Ordering::SeqCst),
            1,
            "a mutation started while the key was already running one"
        );

        held.add_permits(4);
        fourth.await.expect("the fourth enqueue's task panicked");
        wait_idle(&lane).await;
        assert_eq!(lane.snapshot().await.admission_waits, 1);
        assert_eq!(lane.snapshot().await.completed, 4);
    }

    /// An ordered frame waits for **both** lanes.
    ///
    /// This is why [`Lanes`] is one object: an `attach` or an `auth` written
    /// after a mutation must not be applied while that mutation is still
    /// running, and a reader that drained the query lane alone would apply it
    /// anyway.
    ///
    /// The two halves are deliberately *different* here, and that is what makes
    /// the test able to fail: the query finishes on its own, so the only thing
    /// the barrier still has to wait for is the parked mutation, and a `drain`
    /// that covered one lane returns early while `finished` is still `1`.
    /// (Measured: the first version of this test parked **both** halves on one
    /// gate and opened it before draining, so the mutation's own task could
    /// finish during the query lane's teardown and the assertion passed with
    /// the key lane removed from `drain`. A test that cannot fail is not one.)
    #[tokio::test]
    async fn drain_returns_only_when_both_lanes_are_idle() {
        let mut lanes = Lanes::new(2);
        let key_held = gate();
        let finished = Arc::new(AtomicUsize::new(0));

        within_patience("the query never finished", {
            let finished = Arc::clone(&finished);
            lanes.queries.dispatch(async move {
                finished.fetch_add(1, Ordering::SeqCst);
            })
        })
        .await;

        // The mutation is parked, and the test waits until it is *inside* its
        // body, so `drain` cannot be reading an empty queue by luck.
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        within_patience("the mutation was never admitted", {
            let key_held = Arc::clone(&key_held);
            let finished = Arc::clone(&finished);
            lanes.keys.enqueue(
                ResourceKey::Session("a1:s1".to_string()),
                Box::pin(async move {
                    let _ = started_tx.send(());
                    pass(&key_held).await;
                    finished.fetch_add(1, Ordering::SeqCst);
                }),
            )
        })
        .await;
        started_rx.await.expect("the mutation started");

        // Opened *while* `drain` is parked, so the barrier has to be waiting for
        // this rather than arriving after it has already happened.
        let opener = tokio::spawn({
            let key_held = Arc::clone(&key_held);
            async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                key_held.add_permits(1);
            }
        });

        within_patience("drain never returned", lanes.drain()).await;

        // Asserted *before* the opener is joined, and that ordering is the
        // whole test: a `drain` that returned early would otherwise get the
        // 20 ms the opener still has to sleep, during which the mutation it was
        // supposed to wait for finishes and the assertion reads `2` anyway.
        // (Measured: with the join first, removing the key lane from `drain`
        // left this test green.)
        assert_eq!(
            finished.load(Ordering::SeqCst),
            2,
            "drain returned while the key lane was still running"
        );
        opener.await.expect("the opener panicked");
        let (queries, keys) = lanes.snapshot().await;
        assert_eq!(queries.in_flight, 0);
        assert_eq!(keys.keys, 0);
    }

    /// Ending the connection ends its mutations, and counts what it dropped.
    #[tokio::test]
    async fn shutdown_stops_the_work_in_flight() {
        let mut lanes = Lanes::new(2);
        let held = gate();
        let finished = Arc::new(AtomicUsize::new(0));

        within_patience("the mutation was never admitted", async {
            lanes
                .keys
                .enqueue(
                    ResourceKey::Session("a1:s1".to_string()),
                    Box::pin({
                        let held = Arc::clone(&held);
                        let finished = Arc::clone(&finished);
                        async move {
                            pass(&held).await;
                            finished.fetch_add(1, Ordering::SeqCst);
                        }
                    }),
                )
                .await;
        })
        .await;

        lanes.shutdown(Duration::from_secs(1)).await;

        assert_eq!(
            finished.load(Ordering::SeqCst),
            0,
            "the mutation was let through instead of being ended"
        );
        assert_eq!(lanes.snapshot().await.1.queued, 0);
    }

    /// A key is reusable: a mutation arriving after its queue drained still
    /// runs, and still runs alone.
    ///
    /// This is what a worker that removed its key's entry too eagerly would
    /// break — the next mutation would find no queue and no worker, and its
    /// ordering guarantee would be gone with them.
    #[tokio::test]
    async fn a_key_can_be_reused_after_its_queue_drains() {
        let lane = KeyedLane::new(DEFAULT_KEY_QUEUE_DEPTH);
        let key = ResourceKey::Session("a1:s1".to_string());
        let runs = Arc::new(AtomicUsize::new(0));

        for _ in 0..3 {
            let runs = Arc::clone(&runs);
            lane.enqueue(
                key.clone(),
                Box::pin(async move {
                    runs.fetch_add(1, Ordering::SeqCst);
                }),
            )
            .await;
            wait_idle(&lane).await;
        }

        assert_eq!(runs.load(Ordering::SeqCst), 3);
        assert_eq!(lane.snapshot().await.keys, 0);
    }

    /// The two key spaces are told apart by the key, not by its text.
    ///
    /// A session named after an env file and an env file with that name are not
    /// the same resource, and a lane keyed by the bare string would merge them —
    /// which is the kind of merge that shows up later as an unexplained stall on
    /// a session somebody happened to name after a file.
    #[tokio::test]
    async fn a_session_and_an_env_file_of_the_same_name_are_different_keys() {
        let lane = KeyedLane::new(DEFAULT_KEY_QUEUE_DEPTH);
        let held = gate();
        let finished = Arc::new(AtomicUsize::new(0));

        within_patience("the env file's mutation never ran", async {
            lane.enqueue(
                ResourceKey::Session("staging.env".to_string()),
                Box::pin({
                    let held = Arc::clone(&held);
                    async move { pass(&held).await }
                }),
            )
            .await;
            lane.enqueue(
                ResourceKey::Env("staging.env".to_string()),
                Box::pin({
                    let finished = Arc::clone(&finished);
                    async move {
                        finished.fetch_add(1, Ordering::SeqCst);
                    }
                }),
            )
            .await;
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert_eq!(finished.load(Ordering::SeqCst), 1);
        })
        .await;

        held.add_permits(1);
        wait_idle(&lane).await;
    }

    /// An idle lane drains immediately: an ordered frame does not wait for a
    /// queue nobody filled.
    #[tokio::test]
    async fn an_idle_lane_drains_without_waiting_for_a_signal() {
        let mut lanes = Lanes::new(2);
        within_patience("an idle lane never drained", lanes.drain()).await;
        lanes
            .keys
            .enqueue(ResourceKey::Env("a.env".to_string()), nothing_work())
            .await;
        within_patience("a one-item lane never drained", lanes.drain()).await;
        let (_, keys) = lanes.snapshot().await;
        assert_eq!(keys.keys, 0);
        assert_eq!(keys.completed, 1);
        assert_eq!(keys.started, 1);
        assert_eq!(keys.depth, DEFAULT_KEY_QUEUE_DEPTH);
        assert_eq!(
            keys.deepest, 0,
            "an idle lane has no queued work to be deep"
        );
    }
}
