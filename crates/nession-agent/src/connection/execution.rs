//! How one central-server connection's frames are scheduled (`#961-E`).
//!
//! Before this module the read loop was the *dispatcher*: every server message
//! became a detached `tokio::spawn`, which is the one shape `#961` rules out by
//! name ("禁止 per-message unbounded `tokio::spawn`"). What that bought was real
//! and is kept — a `tmux` command that takes ten seconds does not hold the
//! heartbeat or the next frame — but it bought it *unboundedly*: the number of
//! tasks an agent could be running tracked the number of messages a Server
//! chose to send, and an agent whose Server stopped waiting for answers grew a
//! task per command until something gave.
//!
//! What replaces it is a bounded executor with per-resource ordering:
//!
//! * **bounded** is the same mechanism both other runtimes in this change use
//!   (the Server's `server::execution`, the agent's own peer-to-peer
//!   `server::execution`): a frame that would exceed a lane is not *taken off
//!   the socket* until there is room for it. The tasks a connection can have in
//!   flight is a number, and the number is enforced by not reading past it.
//! * **per-resource ordering** is [`KeyedLane`]: work is queued under a
//!   [`ResourceKey`], and one worker per key runs that key's work in the order
//!   the frames arrived. Same key, serial and in order; different keys,
//!   independent.
//!
//! ## The policies
//!
//! Which lane a wire goes to is a property of its **Protocol Unit**, declared
//! beside the arm that serves it in the one `core_routes!` invocation that also
//! produces the manifest and the dispatcher — the same column-on-the-row shape
//! the other two runtimes use, for the same reason: a unit cannot be handled
//! without being advertised, or advertised without a lane, and nothing here has
//! to know what an `extension.*` wire is.
//!
//! | policy | frames | what the reader does |
//! |---|---|---|
//! | [`ExecutionPolicy::Inline`] | the control wires, and nothing else | runs it where it stands |
//! | [`ExecutionPolicy::Query`] | the read-only units — the two lists, the env reads, the report, the capture | admits it to a bounded lane and reads on |
//! | [`ExecutionPolicy::Key`] | the mutations — session create/kill, session env apply/unset, env write/delete | queues it behind that resource's own queue and reads on |
//!
//! ## Why `Inline` is control and not the default
//!
//! This runtime's default is [`UNSERVED`], and it is *not* `Inline` — which is
//! where it differs from both other runtimes, and deliberately. What the Server
//! does not serve is a wire it only forwards; what *this* connection does not
//! serve is an extension's own command unit — a request the Server is waiting
//! for an answer to, whose handler reads files or walks a repository. Running
//! those where they stand is exactly the head-of-line blocking this stage
//! removes, so an unserved frame takes a bounded lane.
//!
//! A control wire is the opposite case: it is not an offer, nobody is waiting
//! for an answer to it, and its whole handler is a log line. It goes where it
//! stands, which is also the point of `#961`'s "control message 与普通 Protocol
//! Unit operation 分离" — a heartbeat must not be queued behind a session's
//! mutations.
//!
//! ## The bound, and what waits
//!
//! Both lanes are bounded, and in both the thing that waits is the **reader**.
//! Waiting there is only safe because the reader is not what writes to the
//! Server: the connection's socket is owned by a writer task
//! (`connection::server_client`'s `write_loop`) draining the outbox and the
//! response channel, so a reader parked on a full lane still sends heartbeats
//! and still writes the answers already computed. Before that split the single
//! loop did both jobs, and parking it on a bound would have stalled the
//! heartbeat — the one regression `#961` says must not happen.
//!
//! Neither lane drops: every frame on them is a request with an id and a Server
//! waiting for its answer, and "the answer is never sent" is not a policy — it
//! is a hang the peer cannot tell from a slow agent.
//!
//! A key's queue being full therefore parks the reader, including for frames
//! bound for *other* keys. That is a real cost, and it is the one this design
//! accepts: at that point the connection is flooding one resource faster than
//! this agent can mutate it, and the alternative — buffering without limit — is
//! the failure mode this whole change exists to remove.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Mutex, Notify, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;
use tracing::{debug, error, warn};

/// A boxed unit of work, as the lanes carry it.
///
/// Boxed because the lanes keep work in a queue until a worker can run it, and
/// the futures the reader produces are all different types. One allocation per
/// queued frame, on a path that already parses a JSON envelope.
pub type Work = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

/// The default number of queries one connection may have running.
///
/// Not a shared number with the peer-to-peer socket's
/// (`crate::server::execution::DEFAULT_QUERY_CONCURRENCY`), even though the two
/// are equal: a concurrency policy belongs to the runtime that implements it
/// (`#961` constraints), and the peer-to-peer socket serves browsers while this
/// one serves the Server. They are equal because both are "a handful of
/// independent reads in flight", not because one is derived from the other.
pub const DEFAULT_QUERY_CONCURRENCY: usize = 8;

/// How many mutations one resource may have queued before the reader waits.
///
/// A *depth per key*, not a total: the bound that matters is "how far ahead of
/// the backend may the Server get on one resource", and a total would let one
/// flooded session consume the budget of every other session on the connection.
/// Eight queued mutations for one session is already a Server scripting a
/// session faster than `tmux` can act on it.
pub const DEFAULT_KEY_QUEUE_DEPTH: usize = 8;

/// How many resources one central connection may have a worker running for.
///
/// [`DEFAULT_KEY_QUEUE_DEPTH`] bounds how far ahead of the backend the Server
/// may get on *one* resource; this bounds how many resources are being mutated
/// at once, and it is what makes "the tasks this connection has in flight" a
/// number rather than a function of how many distinct resources the Server
/// chooses to name. A per-key queue alone does not: a peer naming a thousand
/// sessions would have a thousand workers, one per key, each of them within its
/// own depth.
///
/// With [`DEFAULT_QUERY_CONCURRENCY`] this is the connection's whole in-flight
/// budget — eight read-only units running plus sixteen resources being mutated
/// — and `#961` asks for exactly that ("有明确 global in-flight limit"). The
/// bound waits where the others do: the reader parks until a key's worker has
/// finished.
///
/// Sixteen rather than eight because these are the units that *must* make
/// progress for the Server's view of the fleet to be right: a batch of session
/// creates for the sessions a browser is opening should not be half-serialised
/// behind each other.
pub const DEFAULT_KEY_WORKERS: usize = 16;

/// How long a connection's lanes are given to stop when it ends.
///
/// The lanes are *aborted* rather than drained (see
/// [`Lanes::shutdown`]), so this is a ceiling on a wait that should not happen —
/// a task stops at its first await point after the abort — not a budget
/// anything is expected to use.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

/// The resource a mutation is ordered against.
///
/// A key is what makes two mutations "the same thing": same key, they run one
/// after the other in arrival order; different keys, they do not wait for each
/// other at all. The variants name the *kind* of resource because the same
/// string can be both — a session called `staging.env` and an env file called
/// `staging.env` are not the same resource, and a bare `String` key would merge
/// them.
///
/// The key is derived from the request payload, per unit, in the same
/// `core_routes!` invocation that declares everything else about the unit. It is
/// never inferred from the wire name: that is the `extension.*`-shaped guess the
/// constraints rule out, and it would also be wrong — every unit on this
/// connection names its target in a field called `name`, whether that target is
/// a tmux session or an env file, and nothing about either wire says which.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ResourceKey {
    /// A tmux session, by the name this agent knows it by.
    Session(String),
    /// A locally stored env file, by name.
    Env(String),
}

impl std::fmt::Display for ResourceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Session(name) => write!(f, "session:{name}"),
            Self::Env(name) => write!(f, "env:{name}"),
        }
    }
}

/// How the reader dispatches one frame.
///
/// Declared per Protocol Unit, beside the unit, in the one `core_routes!`
/// invocation — see this module's docs for why that is the only place it can
/// honestly live.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutionPolicy {
    /// Run where it stands, and answered when it finishes.
    ///
    /// The lane for the frames that are **not** operations: on this connection
    /// that is the control wires, whose reception is a log line. See this
    /// module's docs for why this is not the default here, where it is the
    /// default on both other runtimes.
    Inline,
    /// Read-only: admitted to [`QueryLane`], run on its own task, answered
    /// whenever it finishes.
    Query,
    /// A mutation: queued behind every other mutation of the same
    /// [`ResourceKey`], and independent of every other key's.
    Key(ResourceKey),
}

/// The lane a frame this connection does not serve is dispatched on.
///
/// See this module's docs: what this connection does not serve is an
/// extension's own command unit — a request the Server is waiting for an answer
/// to, whose handler does backend I/O — so it takes a bounded lane rather than
/// the reader.
///
/// It is the *query* lane rather than a lane of their own because a key is
/// something a unit declares and an extension declares none, and every
/// extension unit this agent composes today is read-only (`claude-code.list`,
/// `claude-code.read`, `git.status` and its siblings). An extension that grew a
/// **mutation** would be dispatched here unordered — a real hole, and also the
/// point at which the extension declaration has to grow a policy column. That
/// is a change to what a provider declares, which is not this stage's to make.
pub const UNSERVED: ExecutionPolicy = ExecutionPolicy::Query;

/// What one connection's query lane looks like from outside.
///
/// The same idea as the Server's `LaneSnapshot`, for the same reason: a bound
/// that cannot be observed is indistinguishable from an outage, and "the lane
/// was full" is the fact a reader of these numbers is looking for.
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

/// What the key lane looks like from outside (`#961-E`).
///
/// Per-key queue depth is the number `#961`'s backpressure section asks to be
/// able to observe, and it is [`Self::deepest`] read together with
/// [`Self::keys`] and [`Self::queued`]: eight mutations queued across eight
/// resources is a busy connection, while eight queued in *one* resource is one
/// session being flooded, and only the three together tell those apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeySnapshot {
    /// Resources with a worker running or work queued.
    pub keys: usize,
    /// Mutations queued and not yet started.
    pub queued: usize,
    /// The bound one key's queue moves within.
    pub depth: usize,
    /// The deepest single key's queue: the per-key depth that is furthest ahead.
    pub deepest: usize,
    /// Mutations started since the connection opened.
    pub started: u64,
    /// Mutations that have finished.
    pub completed: u64,
    /// Enqueues that found the key's queue full and made the reader wait.
    pub admission_waits: u64,
}

/// The lanes one connection reads into.
pub struct Lanes {
    queries: QueryLane,
    keys: KeyedLane,
}

impl Lanes {
    /// The lanes a connection opens with.
    pub fn new() -> Self {
        Self {
            queries: QueryLane::new(DEFAULT_QUERY_CONCURRENCY),
            keys: KeyedLane::with_bounds(DEFAULT_KEY_QUEUE_DEPTH, DEFAULT_KEY_WORKERS),
        }
    }

    /// Admit one read-only frame, waiting for a slot if the lane is full.
    pub async fn query(&mut self, work: Work) {
        self.queries.dispatch(work).await;
    }

    /// Queue one mutation behind its resource's own queue.
    pub async fn key(&mut self, key: ResourceKey, work: Work) {
        self.keys.enqueue(key, work).await;
    }

    /// Wait for everything the lanes have.
    pub async fn drain(&mut self) {
        self.queries.drain().await;
        self.keys.drain().await;
    }

    /// End everything in flight, waiting at most `grace` for it to stop.
    ///
    /// Aborting is the policy rather than a shortcut: the frames in these lanes
    /// belong to a Server that is gone (or to a connection this agent is
    /// closing), and a mutation parked on a resource nobody is waiting for any
    /// more must not hold the connection's teardown open — nor write to a
    /// socket that is closing. A task stops at its first await point after the
    /// abort, so the grace is a ceiling on something that should not take
    /// measurable time. Queued work that was never started is dropped with the
    /// lane.
    pub async fn shutdown(&mut self, grace: Duration) {
        self.queries.shutdown(grace).await;
        self.keys.shutdown(grace).await;
    }

    /// What both lanes are doing, for logging and tests.
    pub async fn snapshot(&self) -> (LaneSnapshot, KeySnapshot) {
        (self.queries.snapshot(), self.keys.snapshot().await)
    }
}

impl Default for Lanes {
    fn default() -> Self {
        Self::new()
    }
}

/// The read-only frames one connection has in flight.
pub struct QueryLane {
    /// One permit per query in flight.
    permits: Arc<Semaphore>,
    /// The tasks themselves — a `JoinSet` rather than a `Vec<JoinHandle>`
    /// because the reader has to be able to end them all when the connection
    /// does, and to wait for them before an ordered frame.
    tasks: JoinSet<()>,
    counters: Arc<QueryCounters>,
    bound: usize,
}

#[derive(Default)]
struct QueryCounters {
    started: AtomicU64,
    completed: AtomicU64,
    peak_in_flight: AtomicU64,
    admission_waits: AtomicU64,
}

impl QueryLane {
    /// A lane that admits `bound` queries at a time.
    ///
    /// A bound of zero would be a connection that can never answer a query, so
    /// it is raised to one: "the lane is shut" is not a thing this can mean.
    pub fn new(bound: usize) -> Self {
        let bound = bound.max(1);
        Self {
            permits: Arc::new(Semaphore::new(bound)),
            tasks: JoinSet::new(),
            counters: Arc::new(QueryCounters::default()),
            bound,
        }
    }

    /// Admit one query and run it on its own task, waiting for a slot first.
    ///
    /// The future is not polled until the task starts, so nothing about the work
    /// happens before it has a slot.
    pub async fn dispatch(&mut self, work: Work) {
        let permit = self.acquire().await;
        self.counters.started.fetch_add(1, Ordering::Relaxed);
        self.counters
            .peak_in_flight
            .fetch_max(self.in_flight() as u64, Ordering::Relaxed);
        self.tasks
            .spawn(run(work, permit, Arc::clone(&self.counters)));
    }

    /// Wait for every query in flight.
    pub async fn drain(&mut self) {
        while let Some(joined) = self.tasks.join_next().await {
            if let Err(e) = joined {
                // A panicked task is a bug in a handler, and the peer's own
                // timeout is where it surfaces; this is the only place the panic
                // is visible at all.
                error!("a command task panicked: {e}");
            }
        }
    }

    /// End every query in flight, waiting at most `grace`.
    pub async fn shutdown(&mut self, grace: Duration) {
        self.tasks.abort_all();
        if tokio::time::timeout(grace, self.drain()).await.is_err() {
            warn!(
                "central query lane: {} task(s) did not stop within {grace:?}; \
                 abandoning them",
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

    /// Queries holding a slot: the bound minus the permits left. Read from the
    /// semaphore rather than from a task count, because a task that has been
    /// aborted but not yet polled still holds its slot — and this is the number
    /// a producer would wait for.
    fn in_flight(&self) -> usize {
        self.bound.saturating_sub(self.permits.available_permits())
    }

    /// Take a slot for one query, waiting for one if the lane is full.
    async fn acquire(&mut self) -> Option<OwnedSemaphorePermit> {
        let permits = Arc::clone(&self.permits);
        if let Ok(permit) = Arc::clone(&permits).try_acquire_owned() {
            return Some(permit);
        }
        self.counters
            .admission_waits
            .fetch_add(1, Ordering::Relaxed);
        debug!(
            "central query lane is full ({} in flight of {}); the connection waits \
             for a slot before reading on",
            self.in_flight(),
            self.bound
        );
        permits.acquire_owned().await.ok()
    }
}

/// Run the work while holding its slot, and count it when it ends.
///
/// The permit is dropped before the completion is counted, so `in_flight` means
/// "running" rather than "admitted", and a slot is free the moment the work is.
async fn run(work: Work, permit: Option<OwnedSemaphorePermit>, counters: Arc<QueryCounters>) {
    work.await;
    drop(permit);
    counters.completed.fetch_add(1, Ordering::Relaxed);
}

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
    /// One permit per key that may have a worker running. Taken when a worker
    /// is spawned and held until it exits, so it bounds how many resources are
    /// being mutated at once — see [`DEFAULT_KEY_WORKERS`].
    ///
    /// An `Arc` because a worker takes an *owned* permit: it outlives this
    /// method, and a borrow of the lane would make every lane's worker borrow
    /// the lane it belongs to.
    workers_budget: Arc<Semaphore>,
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
    /// A lane with the per-key depth and the key-worker bound stated.
    ///
    /// Both are raised to one rather than obeyed at zero: a lane that can
    /// never run a mutation is not a lane, and neither bound is a knob a
    /// deployment sets through this path.
    fn with_bounds(depth: usize, workers: usize) -> Self {
        Self {
            inner: Arc::new(KeyInner {
                queues: Mutex::new(HashMap::new()),
                depth: depth.max(1),
                workers_budget: Arc::new(Semaphore::new(workers.max(1))),
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
                // Room for one more key's worker, or the reader waits for one —
                // the global half of this lane's bound. Taken *before* the
                // worker exists rather than inside it, so "how many workers"
                // and "how many permits" are the same number and a worker that
                // is merely slow cannot be mistaken for one that is not there.
                let permit = match Arc::clone(&self.inner.workers_budget).try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        self.inner.admission_waits.fetch_add(1, Ordering::Relaxed);
                        debug!(
                            "central key lane: {} resources are already being mutated; the                              connection waits for one of them to finish",
                            DEFAULT_KEY_WORKERS
                        );
                        // `acquire` rather than a loop: the semaphore is never
                        // closed here (nothing calls `close` on it), and a
                        // closed one means this lane is over anyway.
                        let Ok(permit) =
                            Arc::clone(&self.inner.workers_budget).acquire_owned().await
                        else {
                            return;
                        };
                        permit
                    }
                };
                self.inner.started.fetch_add(1, Ordering::Relaxed);
                let inner = Arc::clone(&self.inner);
                let worker_key = key;
                let mut workers = self.workers.lock().await;
                workers.spawn(async move {
                    let _permit = permit;
                    work_key(inner, worker_key).await
                });
                return;
            }
            if work.is_none() {
                return;
            }
            self.inner.admission_waits.fetch_add(1, Ordering::Relaxed);
            debug!(
                "central key lane: `{key}` is at its queue depth ({}); the connection \
                 waits before reading on",
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
                            error!("a central key worker ended abnormally: {e}");
                        }
                    }
                }
            };
            if tokio::time::timeout(grace, stopped).await.is_err() {
                warn!(
                    "central key lane: {} worker(s) did not stop within {grace:?}; \
                     abandoning them",
                    workers.len()
                );
            }
        }

        // Dropped here rather than left in the map: a worker pops its queue's
        // entries as it runs them and removes the key when it finds none, so
        // work that was never started has nobody left to pop it once the
        // workers are gone.
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
    use std::sync::atomic::{AtomicBool, AtomicUsize};

    /// A gate a test opens by handing out permits.
    ///
    /// A semaphore rather than a `Notify` because permits are *retained*: a test
    /// that opens the gate before the work has parked is not a lost wake-up, so
    /// these tests have no ordering to get wrong.
    fn gate() -> Arc<Semaphore> {
        Arc::new(Semaphore::new(0))
    }

    /// Wait for the gate to open.
    async fn pass(gate: &Arc<Semaphore>) {
        let _ = gate.acquire().await;
    }

    /// How long a lane test may take before it is a failure rather than a hang.
    ///
    /// A lane that serialises what it should not parks on its first item and
    /// never reaches the second, and a test suite that hangs instead of failing
    /// reports nothing — so every one of these runs under this.
    const PATIENCE: Duration = Duration::from_secs(5);

    /// Run a lane test body, turning a parked lane into a legible failure.
    async fn within_patience<F>(what: &str, body: F)
    where
        F: Future<Output = ()>,
    {
        tokio::time::timeout(PATIENCE, body).await.unwrap_or_else(|_| {
            panic!("{what} did not finish within {PATIENCE:?}: the lane parked instead of dispatching")
        });
    }

    /// A boxed no-op, so a test states only what it is about.
    fn nothing() -> Work {
        Box::pin(async {})
    }

    /// Wait for a key lane to have no work left: nothing queued, no worker.
    ///
    /// `KeyedLane::drain` is the reader's method and takes the lane exclusively,
    /// which a test holding it in an `Arc` cannot do — and a test that could not
    /// observe the lane while a concurrent enqueue was parked would have to
    /// choose between the observation and the enqueue. This polls the same
    /// state instead, under the same patience as everything else here.
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

    /// Mutations of one key run one after the other, in arrival order.
    ///
    /// The witness is a fact the second mutation records about the *first*:
    /// whether it had finished by the time the second started. That is the whole
    /// of "a mutation of one resource never runs alongside another mutation of
    /// the same resource", and it is deterministic in a way that observing the
    /// order they finish in is not — the second's body cannot run before the
    /// first's future has been dropped, so `finished` is either set or the lane
    /// broke its promise.
    #[tokio::test]
    async fn mutations_of_one_key_never_overlap() {
        let lane = KeyedLane::with_bounds(DEFAULT_KEY_QUEUE_DEPTH, DEFAULT_KEY_WORKERS);
        let held = gate();
        let first_finished = Arc::new(AtomicBool::new(false));
        let overlapped = Arc::new(AtomicBool::new(false));
        let order = Arc::new(tokio::sync::Mutex::new(Vec::new()));

        let key = ResourceKey::Session("s1".to_string());
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

    /// Two keys are independent: work queued behind one is not behind the other.
    ///
    /// The proof is mutual waiting — the second key's mutation *finishes* while
    /// the first key's is parked, so a lane with a single queue would never
    /// reach it.
    #[tokio::test]
    async fn different_keys_do_not_wait_for_each_other() {
        let lane = KeyedLane::with_bounds(DEFAULT_KEY_QUEUE_DEPTH, DEFAULT_KEY_WORKERS);
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
            lane.enqueue(ResourceKey::Session("s1".to_string()), parked)
                .await;
            lane.enqueue(ResourceKey::Session("s2".to_string()), quick)
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
    /// the two: the worker pops a mutation out of the queue to run it, which is
    /// why this test waits for the first one to have **started** before filling
    /// the queue behind it.
    #[tokio::test]
    async fn a_keys_queue_holds_at_its_depth_until_a_mutation_finishes() {
        let lane = Arc::new(KeyedLane::with_bounds(2, DEFAULT_KEY_WORKERS));
        let held = gate();
        let started = Arc::new(AtomicUsize::new(0));
        let key = ResourceKey::Session("s1".to_string());

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
    }

    /// The number of resources being mutated at once is bounded, and the
    /// reader is what waits for room.
    ///
    /// This is `#961`'s "有明确 global in-flight limit" for this connection. The
    /// per-key depth alone does not provide it: a thousand distinct resources
    /// are a thousand keys, each within its own depth, and therefore a thousand
    /// workers. What bounds that is one permit per key with a worker, and this
    /// is the assertion — three keys against a budget of two, with the third's
    /// *worker* (not merely its queue entry) absent until one of the others
    /// finishes.
    ///
    /// The two that are running are parked, so the third cannot be admitted by
    /// anything but a permit being freed. The bounded window is the negative
    /// half and is safe in that direction.
    #[tokio::test]
    async fn only_so_many_resources_are_mutated_at_once() {
        let budget = 2;
        // A depth wide enough that the *key* queues never bind: what is under
        // test is the worker count, not the queue depth.
        let lane = Arc::new(KeyedLane::with_bounds(8, budget));
        let held = gate();
        let started = Arc::new(AtomicUsize::new(0));

        let parked = |started: &Arc<AtomicUsize>, held: &Arc<Semaphore>| {
            let started = Arc::clone(started);
            let held = Arc::clone(held);
            Box::pin(async move {
                started.fetch_add(1, Ordering::SeqCst);
                pass(&held).await;
            }) as Work
        };

        within_patience("the two workers never started", async {
            for n in 0..budget {
                lane.enqueue(
                    ResourceKey::Session(format!("s{n}")),
                    parked(&started, &held),
                )
                .await;
            }
            assert_eq!(lane.snapshot().await.started, budget as u64);
        })
        .await;

        // A third resource: its worker cannot start, so the enqueue waits.
        let third = tokio::spawn({
            let lane = Arc::clone(&lane);
            let started = Arc::clone(&started);
            let held = Arc::clone(&held);
            async move {
                lane.enqueue(
                    ResourceKey::Session("s3".to_string()),
                    parked(&started, &held),
                )
                .await;
            }
        });

        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            lane.snapshot().await.started,
            budget as u64,
            "a third resource got a worker while the budget was spent: the number of \
             mutations in flight tracks the number of resources named, not a bound"
        );

        held.add_permits(3);
        third.await.expect("the third enqueue's task panicked");
        wait_idle(&lane).await;
        assert_eq!(
            started.load(Ordering::SeqCst),
            budget + 1,
            "the waiting resource's mutation never ran: the bound turned into a loss"
        );
        assert_eq!(lane.snapshot().await.admission_waits, 1);
    }

    /// An ordered frame waits for both lanes, so nothing read before it can
    /// still be running when it is applied.
    ///
    /// The two halves are deliberately *different*, and that is what makes the
    /// test able to fail: the query finishes on its own, so the only thing the
    /// barrier still has to wait for is the parked mutation, and a `drain` that
    /// covered one lane returns early while `finished` is still `1`.
    #[tokio::test]
    async fn drain_returns_only_when_both_lanes_are_idle() {
        let mut lanes = Lanes::new();
        let key_held = gate();
        let finished = Arc::new(AtomicUsize::new(0));

        within_patience("the query never finished", {
            let finished = Arc::clone(&finished);
            lanes.query(Box::pin(async move {
                finished.fetch_add(1, Ordering::SeqCst);
            }))
        })
        .await;

        // The mutation is parked, and the test waits until it is *inside* its
        // body, so `drain` cannot be reading an empty queue by luck.
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        within_patience("the mutation was never admitted", {
            let key_held = Arc::clone(&key_held);
            let finished = Arc::clone(&finished);
            lanes.key(
                ResourceKey::Session("s1".to_string()),
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

        // Asserted *before* the opener is joined: a `drain` that returned early
        // would otherwise get the 20 ms the opener still has to sleep, during
        // which the mutation it was supposed to wait for finishes and the
        // assertion reads `2` anyway.
        assert_eq!(
            finished.load(Ordering::SeqCst),
            2,
            "drain returned while the key lane was still running"
        );
        opener.await.expect("the opener panicked");
    }

    /// Ending the connection ends its work, and frees the slots while it does.
    #[tokio::test]
    async fn shutdown_stops_the_work_in_flight() {
        let mut lanes = Lanes::new();
        let held = gate();
        let finished = Arc::new(AtomicUsize::new(0));

        let blocked = |held: &Arc<Semaphore>, finished: &Arc<AtomicUsize>| {
            let held = Arc::clone(held);
            let finished = Arc::clone(finished);
            Box::pin(async move {
                pass(&held).await;
                finished.fetch_add(1, Ordering::SeqCst);
            }) as Work
        };

        // The key lane alone, and that is a correction rather than a
        // simplification: with a *query* also in flight, the query lane's
        // shutdown is what yields to the runtime first, and the key's worker
        // then pops its queue and removes its key before the key lane is
        // touched. The assertion below passed with the queue-clearing removed
        // entirely — measured — which is a test that cannot fail.
        within_patience("the work was never admitted", async {
            lanes
                .key(
                    ResourceKey::Session("s1".to_string()),
                    blocked(&held, &finished),
                )
                .await;
        })
        .await;

        lanes.shutdown(Duration::from_secs(1)).await;

        assert_eq!(
            finished.load(Ordering::SeqCst),
            0,
            "the work was let through instead of being ended"
        );
        let (queries, keys) = lanes.snapshot().await;
        assert_eq!(queries.in_flight, 0, "an ended query still holds its slot");
        assert_eq!(
            keys.queued, 0,
            "an ended mutation is still queued, and nothing is left to run it"
        );
    }

    /// A key is reusable: a mutation arriving after its queue drained still
    /// runs, and still runs alone.
    ///
    /// This is what a worker that removed its key's entry too eagerly would
    /// break — the next mutation would find no queue and no worker.
    #[tokio::test]
    async fn a_key_can_be_reused_after_its_queue_drains() {
        let lane = KeyedLane::with_bounds(DEFAULT_KEY_QUEUE_DEPTH, DEFAULT_KEY_WORKERS);
        let key = ResourceKey::Env("staging.env".to_string());
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
    /// Every unit on this connection names its target in a field called `name`,
    /// and what that name *means* is the unit's business: a session called after
    /// an env file and the env file itself are not the same resource, and a lane
    /// keyed by the bare string would merge them.
    #[tokio::test]
    async fn a_session_and_an_env_file_of_the_same_name_are_different_keys() {
        let lane = KeyedLane::with_bounds(DEFAULT_KEY_QUEUE_DEPTH, DEFAULT_KEY_WORKERS);
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

    /// An idle lane drains immediately: nothing waits for a queue nobody filled.
    #[tokio::test]
    async fn an_idle_lane_drains_without_waiting_for_a_signal() {
        let mut lanes = Lanes::new();
        within_patience("an idle lane never drained", lanes.drain()).await;
        lanes
            .key(ResourceKey::Session("s".to_string()), nothing())
            .await;
        within_patience("a one-item lane never drained", lanes.drain()).await;
        let (_, keys) = lanes.snapshot().await;
        assert_eq!(keys.keys, 0);
        assert_eq!(keys.completed, 1);
        assert_eq!(keys.started, 1);
        assert_eq!(
            keys.deepest, 0,
            "an idle lane has no queued work to be deep"
        );
    }
}
