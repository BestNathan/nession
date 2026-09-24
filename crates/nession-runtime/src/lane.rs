//! The two lanes a connection's reader dispatches into (`#961-C`, `#961-D`,
//! `#961-E`, converged in `#961-F`).
//!
//! A request is answered whenever it finishes, because the envelope's `id` is
//! what correlates it — the *position* of a reply carries nothing (see
//! `docs/architecture/protocol.md`). What the protocol does need is that some
//! things keep their order and that the work in flight is bounded, and neither
//! of those is "run everything where it stands". So the reader keeps the frames
//! whose ordering is load-bearing for itself and hands the rest to one of two
//! lanes:
//!
//! | lane | what is on it | at the bound |
//! |---|---|---|
//! | [`QueryLane`] | a read-only unit | **wait** — the reader stops reading until a slot frees |
//! | [`KeyedLane`] | a mutation, keyed by the resource it mutates | **wait** — the reader stops reading until that key's queue frees a slot |
//!
//! Neither lane drops, and that is a property of what they carry rather than a
//! preference: every frame on them is a request with an `id` and a caller
//! waiting for an answer, and "the answer is never sent" is not a policy — it is
//! a hang the peer cannot tell from a slow backend. What *is* droppable on these
//! connections is coalesced elsewhere and deliberately (a resize, a state push;
//! see the runtimes' outbound paths).
//!
//! ## Who owns the keyed lane
//!
//! A key is a statement about a *resource*, so the lane that orders work by key
//! belongs at the scope the resource is. [`Lanes::new`] gives a connection a
//! lane of its own, which is the right answer when its keys name only state that
//! connection owns. [`Lanes::shared`] gives every connection of one runtime the
//! *same* lane, and the caller that builds it is the one that owns the
//! resources the keys name — a session manager, a file sandbox, a registry. A
//! lane built per connection around runtime-global resources would promise
//! `same resource + same connection → FIFO`, which says nothing about the case
//! it is meant to cover: two peers mutating one session.
//!
//! The two halves of the lane are not owned at the same scope in
//! [`Lanes::shared`], and that is the point of it rather than an inconsistency:
//!
//! * **ordering** follows the resource — one worker per key, one queue per key,
//!   for the whole runtime;
//! * **admission** follows the connection — the bound on how many mutations one
//!   peer may have in flight is the connection's, because the thing that waits
//!   is the connection's reader and the number it protects is that
//!   connection's tasks. A bound shared by every peer is a budget one peer can
//!   spend on behalf of the others, which is not a bound on the peer at all.
//!
//! Both halves are how `#961`'s "并发必须有界" is met: the number of mutations a
//! connection has in flight is a number, and it is the same number whatever
//! resources the frames name.
//!
//! ## Why the bound is a bound on the *reader*
//!
//! [`QueryLane::dispatch`] and [`KeyedLane::enqueue`] wait when the lane they
//! feed is full, and the waiter is the read loop — so a connection that has
//! filled a lane stops being read from. That is the whole of `#961`'s "no
//! per-message unbounded `tokio::spawn`": the tasks a connection may have in
//! flight is a number, and the way it is enforced is that the frame which would
//! exceed it is not read until there is room for it. The bound is per connection
//! rather than process-wide, because what it protects is the *connection's*
//! ability to make progress, and one busy browser must not consume the fleet's
//! budget — which is why [`Lanes::shared`] keeps its admission bound on the
//! connection even though the ordering lane it feeds is the runtime's.
//!
//! Waiting on a lane does not hold the connection's *writes*: each runtime's
//! outbound path is its own task with its own bound, so a reader parked on a
//! full lane still has its ping written and its terminal frames relayed.
//!
//! ## What a bound does not buy, unless it is asked for
//!
//! A per-key queue bounds how far ahead of the backend one *resource* may get.
//! It does not bound how many resources are being mutated at once: one worker
//! per key still means one worker per resource named, and a peer naming a
//! thousand sessions has a thousand workers, each inside its own depth. That
//! second bound is a separate decision and there are two ways to state it, one
//! per scope:
//!
//! * [`KeyedLane::with_worker_budget`] bounds how many resources one *lane* may
//!   be mutating at once. On a lane a connection owns, that is the connection's
//!   bound; on a lane the runtime owns, it is the runtime's.
//! * [`Lanes::shared`] bounds how many mutations one *connection* may have in
//!   flight while the lane itself stays unbudgeted, which is the same statement
//!   made where the waiter is.
//!
//! Neither is a default, because a per-key queue is a statement about ordering
//! and a runtime whose resources are few does not need a second bound and would
//! not have had one — see the constructors.
//!
//! ## The label
//!
//! Every log line here is prefixed with the calling runtime's name, because the
//! same mechanism serves three connections with three different failure modes
//! and "the lane is full" is not actionable without knowing whose. The Server
//! passes `""`, which is what makes its existing lines read as they did.

use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::future::Future;
use std::hash::Hash;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Mutex, Notify, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;
use tracing::{debug, error, warn};

/// A boxed unit of work, as the key lane carries it.
///
/// Boxed because the key lane keeps work in a queue until a worker can run it,
/// and the futures a reader produces are all different types. One allocation per
/// queued frame, on a path that already parses a JSON envelope.
pub type Work = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

/// What a caller can see about a connection's query lane.
///
/// A bound that cannot be observed is indistinguishable from an outage, and
/// "the lane was full" is the fact a reader of these numbers is looking for.
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

/// What a caller can see about a connection's keyed mutation lane.
///
/// `keys` and `queued` are the two numbers that tell "one resource is flooded"
/// apart from "the connection is busy": the first says how many distinct
/// resources have work, the second how much work is waiting in total. Four
/// mutations queued across four resources is a busy connection, while four
/// queued in *one* resource is one client being scripted ahead of its backend.
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
    /// observable, and it is only meaningful against a key — see this struct's
    /// docs. `keys` and `queued` tell the two cases apart, and this is the depth
    /// of whichever key is furthest ahead. It is `0` for an idle lane.
    pub deepest: usize,
    /// Mutations started since the connection opened.
    pub started: u64,
    /// Mutations that have finished.
    pub completed: u64,
    /// Enqueues that found the key's queue full — or, when there is a worker
    /// budget, found it spent — and made the reader wait.
    pub admission_waits: u64,
}

/// One line describing what a connection's lanes did, for the teardown log.
///
/// The query half is always the connection's. The mutation half is the lane's
/// own numbers, and on a shared lane ([`Lanes::shared`]) that lane is the
/// runtime's rather than this connection's — the counters describe every
/// mutation that went through it. A caller that wants the connection's own
/// share as well has [`Lanes::admission_waits`], and the two together are the
/// honest picture: what the lane ever did, and how often this peer waited.
///
/// `#961`'s backpressure section asks that "metrics/logging can observe queue
/// saturation, in-flight count, per-key queue depth", and until this existed the
/// snapshots above were read by nothing outside the tests that assert on them —
/// a bound whose numbers nobody reads is indistinguishable from a bound nobody
/// checked. This is the production reader: every connection states what its
/// lanes did as it closes, in one line, at the level the lane's own saturation
/// events use.
///
/// The numbers are the *counters* rather than the instantaneous queue depths,
/// and that is what makes a teardown the right place to read them: by the time a
/// connection ends, `queued` is zero because the work is over, while
/// `peak_in_flight` and `admission_waits` still say whether the bound was ever
/// reached and how far the resource queues got. The instantaneous depth, and
/// which key it belonged to, is logged where it happens (`KeyedLane::enqueue`)
/// — the two together are the whole picture.
pub fn summary(queries: &LaneSnapshot, keys: &KeySnapshot) -> String {
    format!(
        "queries: started={} completed={} peak_in_flight={} of {} admission_waits={}; \
         mutations: started={} completed={} queued={} deepest={} of {} admission_waits={}",
        queries.started,
        queries.completed,
        queries.peak_in_flight,
        queries.bound,
        queries.admission_waits,
        keys.started,
        keys.completed,
        keys.queued,
        keys.deepest,
        keys.depth,
        keys.admission_waits,
    )
}

#[derive(Default)]
struct QueryCounters {
    started: AtomicU64,
    completed: AtomicU64,
    peak_in_flight: AtomicU64,
    admission_waits: AtomicU64,
}

/// The read-only frames one connection has in flight.
pub struct QueryLane {
    /// One permit per query in flight.
    permits: Arc<Semaphore>,
    /// The tasks themselves — a `JoinSet` rather than a `Vec<JoinHandle>`
    /// because the reader has to be able to wait for all of them before an
    /// ordered frame, and to end them all when the connection does.
    tasks: JoinSet<()>,
    counters: Arc<QueryCounters>,
    bound: usize,
    label: &'static str,
}

impl QueryLane {
    /// A lane that admits `bound` queries at a time.
    ///
    /// A bound of zero would be a connection that can never answer a query, so
    /// it is raised to one rather than obeyed: the value comes from the calling
    /// runtime (a config field, or its own constant), and "the lane is shut" is
    /// not a thing a deployment can mean.
    pub fn new(bound: usize, label: &'static str) -> Self {
        let bound = bound.max(1);
        Self {
            permits: Arc::new(Semaphore::new(bound)),
            tasks: JoinSet::new(),
            counters: Arc::new(QueryCounters::default()),
            bound,
            label,
        }
    }

    /// Admit one query and run it on its own task, waiting for a slot first.
    ///
    /// The future is not polled until the task starts, so nothing about the work
    /// happens before it has a slot.
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
    /// The barrier in front of an ordered frame calls this: everything read
    /// before that frame has finished by the time it is applied, which is what
    /// makes an identity or a mode transition ordered without making every other
    /// frame ordered too.
    pub async fn drain(&mut self) {
        while let Some(joined) = self.tasks.join_next().await {
            report(&joined, self.label, "query");
        }
    }

    /// End every query in flight and wait for them to stop, for at most `grace`.
    ///
    /// Called when the connection ends. Aborting is what keeps an abandoned
    /// query from writing to a connection that is closing *and* from holding it
    /// open: a query parked in a reply send holds a sender, and the writer only
    /// stops once every sender is gone. The grace is a ceiling on a wait that
    /// should not happen — a task stops at its first await point after the abort
    /// — not a budget anything is expected to use.
    pub async fn shutdown(&mut self, grace: Duration) {
        self.tasks.abort_all();
        if tokio::time::timeout(grace, self.drain()).await.is_err() {
            warn!(
                "{}query lane: {} task(s) did not stop within {grace:?}; abandoning them",
                self.label,
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
    ///
    /// `None` means the semaphore was closed, which nothing in this module does.
    /// It is spelled as an `Option` rather than an `expect` because the runtime
    /// crates deny `expect_used` outside tests, and because the arm does have an
    /// honest answer: the caller has a frame in hand that a client is waiting
    /// on, so it runs — unboundedly, once, rather than dropping a request nobody
    /// would hear about.
    async fn acquire(&mut self) -> Option<OwnedSemaphorePermit> {
        let permits = Arc::clone(&self.permits);
        if let Ok(permit) = Arc::clone(&permits).try_acquire_owned() {
            return Some(permit);
        }
        self.counters
            .admission_waits
            .fetch_add(1, Ordering::Relaxed);
        debug!(
            "{}query lane is full ({} in flight of {}); the connection waits for a slot \
             before reading on",
            self.label,
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
async fn run<F>(work: F, permit: Option<OwnedSemaphorePermit>, counters: Arc<QueryCounters>)
where
    F: Future<Output = ()>,
{
    work.await;
    drop(permit);
    counters.completed.fetch_add(1, Ordering::Relaxed);
}

/// Report a joined task, whichever way it ended.
///
/// A panicked task is a bug in a handler, and the peer's own timeout is where it
/// surfaces; this log line is the only place the panic is visible at all. A
/// cancelled one is the connection ending, which is the design and not news.
fn report(joined: &Result<(), tokio::task::JoinError>, label: &str, lane: &str) {
    match joined {
        Ok(()) => {}
        Err(e) if e.is_panic() => error!("{label}{lane} lane: a task panicked: {e}"),
        Err(e) => debug!("{label}{lane} lane: a task was cancelled: {e}"),
    }
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

/// How many resources may be mutated at once, when a runtime asks for a bound.
///
/// [`KeyedLane::new`] leaves this unset, and that is the honest default: a
/// per-key queue is a statement about *ordering*, and a runtime whose keys are
/// already few (a socket serving one browser's sessions, a Server's own
/// registry) does not need a second bound and would not have had one.
struct WorkerBudget {
    permits: Arc<Semaphore>,
    /// The bound, kept for the log line rather than re-derived: a message that
    /// said `16` because that is today's constant would go on saying it after
    /// the constant moved.
    bound: usize,
}

/// Per-resource FIFO for mutations (`#961-D`, `#961-E`).
///
/// One worker per key, spawned when the key has work and gone when it does not.
/// Work is queued in arrival order and run in that order, so a mutation can
/// never overtake an earlier mutation of the same resource — which is the
/// guarantee `#961` calls "mutation side effects must not become
/// nondeterministic under concurrency". Different keys have different queues and
/// different workers, so they are independent by construction rather than by the
/// reader happening to interleave them.
///
/// An idle key is removed from the map when its worker finishes, so the map
/// holds only the resources actually in flight and cannot grow with everything
/// the connection has ever touched.
///
/// `K` is the runtime's own resource key (its variants name the kinds of
/// resource *that* runtime has) and is used here only for identity and for the
/// log line: the lane never reads a key's text, which is what keeps a session
/// named after an env file from being the same key as that file.
pub struct KeyedLane<K> {
    inner: Arc<KeyInner<K>>,
    /// The worker tasks.
    ///
    /// Behind a lock of its own so that admitting a mutation needs `&self`
    /// rather than `&mut self`: the lane is reached from the reader, and a reader
    /// parked on a full key is *still* reachable from elsewhere. (The tests are
    /// what "elsewhere" is here, and they found it — an exclusive admit would
    /// have made the observation of a full queue a deadlock.) The guard is taken
    /// only to spawn, and never held across an await.
    ///
    /// `drain` and `shutdown` do take `&mut self`, which is honest: only the
    /// reader ever ends a lane, and it has the lane to itself when it does.
    workers: Mutex<JoinSet<()>>,
}

struct KeyInner<K> {
    /// The queues, and the only lock this lane takes. Never held across an
    /// await: every critical section here is a `VecDeque` push or pop.
    queues: Mutex<HashMap<K, KeyQueue>>,
    depth: usize,
    /// One permit per key that may have a worker running, when the runtime asked
    /// for a bound. Taken when a worker is spawned and held until it exits, so it
    /// bounds how many resources are being mutated at once.
    ///
    /// An `Arc` because a worker takes an *owned* permit: it outlives the
    /// method that took it, and a borrow of the lane would make every worker
    /// borrow the lane it belongs to.
    budget: Option<WorkerBudget>,
    /// Signalled whenever a queue loses an entry, and when a key goes idle, so an
    /// enqueue waiting for room and a `drain` waiting for the last mutation both
    /// re-check. Coarse on purpose — it does not say *which* key moved, and a
    /// waiter woken for another key simply waits again.
    room: Notify,
    started: AtomicU64,
    completed: AtomicU64,
    admission_waits: AtomicU64,
    label: &'static str,
}

impl<K> KeyedLane<K>
where
    K: Clone + Eq + Hash + fmt::Display + Send + Sync + 'static,
{
    /// A lane with a per-key queue depth and no global worker budget.
    ///
    /// Both numbers are the caller's: a concurrency policy belongs to the
    /// runtime that implements it (`#961` constraints), so nothing here picks a
    /// default. The depth is raised to one rather than obeyed at zero — a lane
    /// that can never queue a mutation is not a lane.
    pub fn new(depth: usize, label: &'static str) -> Self {
        Self::build(depth, None, label)
    }

    /// The same, with a bound on how many resources may be mutated at once.
    ///
    /// See this module's docs: a per-key depth bounds how far ahead of the
    /// backend one resource may get, and does not bound how many resources are
    /// in flight. A runtime that wants the second bound states it here; the
    /// reader waits for a permit exactly where it waits for queue depth, so
    /// "the reader is what waits" holds for both halves.
    pub fn with_worker_budget(depth: usize, workers: usize, label: &'static str) -> Self {
        Self::build(
            depth,
            Some(WorkerBudget {
                permits: Arc::new(Semaphore::new(workers.max(1))),
                bound: workers.max(1),
            }),
            label,
        )
    }

    fn build(depth: usize, budget: Option<WorkerBudget>, label: &'static str) -> Self {
        Self {
            inner: Arc::new(KeyInner {
                queues: Mutex::new(HashMap::new()),
                depth: depth.max(1),
                budget,
                room: Notify::new(),
                started: AtomicU64::new(0),
                completed: AtomicU64::new(0),
                admission_waits: AtomicU64::new(0),
                label,
            }),
            workers: Mutex::new(JoinSet::new()),
        }
    }

    /// Queue one mutation, waiting for room in that key's queue if it is full.
    ///
    /// The wait is the backpressure: while it lasts the reader is not reading, so
    /// the queue cannot grow with the message count. See this module's docs for
    /// why the waiter is the reader and what that costs.
    pub async fn enqueue(&self, key: K, work: Work) {
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
                    // rather than as an `expect`, which the runtime crates deny.
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
                // the global half of this lane's bound, where the runtime asked
                // for it. Taken *before* the worker exists rather than inside it,
                // so "how many workers" and "how many permits" are the same
                // number and a worker that is merely slow cannot be mistaken for
                // one that is not there.
                let permit = match &self.inner.budget {
                    None => None,
                    Some(budget) => match Arc::clone(&budget.permits).try_acquire_owned() {
                        Ok(permit) => Some(permit),
                        Err(_) => {
                            self.inner.admission_waits.fetch_add(1, Ordering::Relaxed);
                            debug!(
                                "{}key lane: {} resources are already being mutated; the \
                                 connection waits for one of them to finish",
                                self.inner.label, budget.bound
                            );
                            // `acquire` rather than a loop: the semaphore is
                            // never closed here (nothing calls `close` on it),
                            // and a closed one means this lane is over anyway.
                            let Ok(permit) = Arc::clone(&budget.permits).acquire_owned().await
                            else {
                                return;
                            };
                            Some(permit)
                        }
                    },
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
                "{}key lane: `{key}` is at its queue depth ({}); the connection waits \
                 before reading on",
                self.inner.label, self.inner.depth
            );
            room.await;
        }
    }

    /// Wait until every key's queue is empty and every worker has stopped.
    ///
    /// "Stopped" rather than "empty": a worker removes its key's entry as its
    /// last act, so an empty map is the point at which the last mutation has
    /// finished running rather than merely been popped.
    pub async fn drain(&mut self) {
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

    /// End every worker, waiting at most `grace` for them to stop.
    ///
    /// **Queued work is dropped**, and that is the point of the clear at the end
    /// rather than a side effect of it. A worker pops its queue's entries as it
    /// runs them and removes the key when it finds none, so work that was queued
    /// and never started has nobody left to pop it once the workers are gone —
    /// and a lane that reported a non-empty queue after its own shutdown would
    /// be describing work that cannot run. Measured before this was fixed on all
    /// three copies: `queued == 1` after a shutdown that said it dropped the
    /// queue (`#961-F`).
    pub async fn shutdown(&mut self, grace: Duration) {
        {
            let workers = self.workers.get_mut();
            workers.abort_all();
            let stopped = async {
                while let Some(joined) = workers.join_next().await {
                    report(&joined, self.inner.label, "key");
                }
            };
            if tokio::time::timeout(grace, stopped).await.is_err() {
                warn!(
                    "{}key lane: {} worker(s) did not stop within {grace:?}; abandoning them",
                    self.inner.label,
                    workers.len()
                );
            }
        }

        self.inner.queues.lock().await.clear();
    }

    /// What this lane is doing, for logging and tests.
    pub async fn snapshot(&self) -> KeySnapshot {
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
/// when the key goes idle: an enqueue waiting for room is woken by any pop, and a
/// `drain` is woken by the removal that ends the key. Both register before they
/// check, so neither depends on the signal arriving at a particular moment.
async fn work_key<K>(inner: Arc<KeyInner<K>>, key: K)
where
    K: Clone + Eq + Hash + fmt::Display + Send + Sync + 'static,
{
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

/// Where a connection's mutations are ordered.
///
/// Two shapes, and which one a runtime uses is a statement about *who owns* the
/// resources its keys name — see this module's docs. The rest of [`Lanes`] does
/// not care which: a query is admitted the same way either way, and a mutation
/// goes to whichever keyed lane the connection has.
enum Keys<K> {
    /// The lane belongs to this connection, and dies with it.
    Own(KeyedLane<K>),
    /// The lane belongs to the runtime, and outlives every connection that
    /// dispatches into it.
    Shared(SharedKeys<K>),
}

/// One connection's use of a lane the runtime owns.
///
/// The lane is shared; the *bound* is not, and this is what keeps the two
/// statements apart:
///
/// * the connection may have at most `slots` mutations in flight — running or
///   queued — whatever keys they name, which is how "a peer naming a thousand
///   resources" stops being a thousand workers;
/// * the connection's reader is what waits for a slot, so a peer that has spent
///   its own does not spend anyone else's;
/// * and because a slot is held for exactly as long as one dispatched mutation
///   has not finished, taking *all* of them is the barrier an ordered frame
///   stands behind ([`SharedKeys::drain`]). A slot is therefore two things at
///   once, and deliberately: the count of a connection's unfinished mutations is
///   what bounds it and what the barrier waits for. Two mechanisms would be two
///   things to keep in step.
struct SharedKeys<K> {
    lane: Arc<KeyedLane<K>>,
    /// One permit per mutation this connection may have in flight.
    ///
    /// An `Arc` because a dispatched mutation takes an *owned* permit: it
    /// outlives the method that took it, and a borrow of the connection would
    /// make every mutation borrow the connection it belongs to.
    slots: Arc<Semaphore>,
    /// How many permits `slots` was built with, in the width a semaphore counts
    /// permits in. Kept rather than re-derived so the log line below does not go
    /// on saying "16" after the constant moved, and because the barrier has to
    /// ask for exactly this many.
    bound: u32,
    /// Tripped when the connection ends, which is how work this connection
    /// queued into the *shared* lane learns that nobody is waiting for it any
    /// more. Without it a disconnected peer's queued mutations would still run,
    /// and a mutation is not something to run on behalf of someone who left.
    ended: Arc<Ended>,
    admission_waits: AtomicU64,
    label: &'static str,
}

/// A one-way "this is over" signal.
///
/// A `Notify` and a flag rather than a token type from a dependency this crate
/// does not have, and the pair is what makes it safe to await: the flag makes
/// the state durable (a signal that arrived before anyone waited is not lost)
/// and the `Notify` makes waking possible. Every awaiter registers *before* it
/// looks, so the two cannot disagree.
#[derive(Default)]
struct Ended {
    flag: AtomicBool,
    wake: Notify,
}

impl Ended {
    fn end(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.wake.notify_waiters();
    }

    fn is_ended(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    async fn wait(&self) {
        loop {
            let woken = self.wake.notified();
            tokio::pin!(woken);
            woken.as_mut().enable();
            if self.is_ended() {
                return;
            }
            woken.await;
        }
    }
}

impl<K> SharedKeys<K>
where
    K: Clone + Eq + Hash + fmt::Display + Send + Sync + 'static,
{
    /// Admit one mutation, waiting for a slot if this connection is at its
    /// bound, and queue it behind its resource's own queue.
    async fn enqueue(&self, key: K, work: Work) {
        let permit = self.acquire().await;
        let ended = Arc::clone(&self.ended);
        // The slot is released when the mutation has *finished*, which is what
        // makes the count a count of unfinished mutations rather than of
        // queued ones — and what makes `drain` a barrier rather than a
        // statement about the queue. The `select!` is the other half: work this
        // connection queued before it ended does not become work it never
        // asked for.
        let admitted: Work = Box::pin(async move {
            if !ended.is_ended() {
                tokio::select! {
                    () = work => {}
                    () = ended.wait() => {}
                }
            }
            drop(permit);
        });
        self.lane.enqueue(key, admitted).await;
    }

    /// Take a slot, waiting for one if this connection has none left.
    ///
    /// `None` means the semaphore was closed, which nothing in this module does;
    /// see [`QueryLane::acquire`] for why that arm runs the frame rather than
    /// dropping it.
    async fn acquire(&self) -> Option<OwnedSemaphorePermit> {
        let slots = Arc::clone(&self.slots);
        if let Ok(permit) = Arc::clone(&slots).try_acquire_owned() {
            return Some(permit);
        }
        self.admission_waits.fetch_add(1, Ordering::Relaxed);
        debug!(
            "{}key lane: this connection already has {} mutation(s) in flight; it waits \
             for one to finish before reading on",
            self.label, self.bound
        );
        slots.acquire_owned().await.ok()
    }

    /// Wait until nothing this connection dispatched is still running.
    ///
    /// Taking every slot is the barrier, and the permits go straight back: this
    /// is not a shutdown. It is also *only* this connection's work that is
    /// waited for — the lane is shared, and waiting for it to empty would make
    /// one connection's ordered frame wait on another connection's mutations,
    /// which is neither what the barrier is for nor something this connection
    /// could make progress through.
    async fn drain(&self) {
        let Ok(permits) = Arc::clone(&self.slots).acquire_many_owned(self.bound).await else {
            return;
        };
        drop(permits);
    }

    /// Stop this connection's mutations, waiting at most `grace` for the ones
    /// that are running to notice.
    ///
    /// The lane is not this connection's to end. Ending it would end every other
    /// connection's mutations, and clearing its queues would drop work that
    /// belongs to peers that are still here. What ends here is *this
    /// connection's* work, and the `select!` above is how it ends: a mutation
    /// already running stops at its next await point, and one still queued skips
    /// its body when it reaches the front of its key's queue.
    ///
    /// The wait is for the slots to come back, and it is bounded because the
    /// queued half of that wait is not this connection's to bound: a mutation
    /// queued behind *another* connection's long-running work cannot release its
    /// slot until that work finishes. Timing out there is not a failure — the
    /// connection is over either way — which is why it is a debug line rather
    /// than the warning [`KeyedLane::shutdown`] logs.
    async fn shutdown(&self, grace: Duration) {
        self.ended.end();
        if tokio::time::timeout(grace, self.drain()).await.is_err() {
            debug!(
                "{}key lane: {} of this connection's {} mutation(s) were still queued \
                 behind another resource when it ended",
                self.label,
                self.slots.available_permits(),
                self.bound
            );
        }
    }
}

/// The lanes one connection's reader dispatches into.
///
/// One object rather than two fields at the call site, because the reader has
/// exactly three things to do to a lane — admit a query, queue a mutation, wait
/// for everything — and the *barrier* in front of an ordered frame only means
/// anything if it covers both. A reader that drained the query lane and forgot
/// the mutation lane would apply an auth or an attach while a mutation read
/// before it was still running, which is precisely the determinism the barrier
/// exists to provide.
pub struct Lanes<K> {
    queries: QueryLane,
    keys: Keys<K>,
}

impl<K> Lanes<K>
where
    K: Clone + Eq + Hash + fmt::Display + Send + Sync + 'static,
{
    /// The lanes a connection opens with, at the bounds the caller states.
    ///
    /// The key lane is the connection's own, which is the right answer exactly
    /// when the keys name state this connection owns: a lane per connection over
    /// resources the whole runtime shares would promise ordering between two
    /// peers' mutations of one session and deliver nothing — see
    /// [`Lanes::shared`].
    pub fn new(query_bound: usize, key_depth: usize, label: &'static str) -> Self {
        Self {
            queries: QueryLane::new(query_bound, label),
            keys: Keys::Own(KeyedLane::new(key_depth, label)),
        }
    }

    /// The same, with the key lane's global worker budget.
    ///
    /// See [`KeyedLane::with_worker_budget`] for what that is and why it is not
    /// the default.
    pub fn with_key_worker_budget(
        query_bound: usize,
        key_depth: usize,
        key_workers: usize,
        label: &'static str,
    ) -> Self {
        Self {
            queries: QueryLane::new(query_bound, label),
            keys: Keys::Own(KeyedLane::with_worker_budget(key_depth, key_workers, label)),
        }
    }

    /// The lanes of a connection whose mutations are of the *runtime's*
    /// resources rather than its own.
    ///
    /// `mutations` is the lane the caller built once, and every connection that
    /// mutates the same resources passes the same one — so `same resource →
    /// FIFO` is a statement about the resource rather than about which socket
    /// happened to carry the frame. The caller is whoever owns those resources:
    /// the object holding the session manager, the file sandbox, the registry.
    ///
    /// `mutation_bound` is this connection's own admission bound, and it is this
    /// connection's for the reasons [`SharedKeys`] states: a peer may not have
    /// more than that many mutations in flight, whichever resources they name.
    /// A bound of zero is raised to one, as it is everywhere else here: the value
    /// comes from the calling runtime, and "this connection may never mutate
    /// anything" is not a state a deployment can mean. A bound beyond what a
    /// semaphore can count is clamped to what it can, which is a bound no
    /// connection reaches.
    pub fn shared(
        query_bound: usize,
        mutations: Arc<KeyedLane<K>>,
        mutation_bound: usize,
        label: &'static str,
    ) -> Self {
        let bound = u32::try_from(mutation_bound).unwrap_or(u32::MAX).max(1);
        Self {
            queries: QueryLane::new(query_bound, label),
            keys: Keys::Shared(SharedKeys {
                lane: mutations,
                slots: Arc::new(Semaphore::new(bound as usize)),
                bound,
                ended: Arc::new(Ended::default()),
                admission_waits: AtomicU64::new(0),
                label,
            }),
        }
    }

    /// Admit one read-only frame, waiting for a slot if the lane is full.
    pub async fn query<F>(&mut self, work: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        self.queries.dispatch(work).await;
    }

    /// Queue one mutation behind its resource's own queue, waiting for room if
    /// that queue is full — and, on a shared lane, for a slot if this
    /// connection is already at its bound.
    pub async fn key(&mut self, key: K, work: Work) {
        match &self.keys {
            Keys::Own(lane) => lane.enqueue(key, work).await,
            Keys::Shared(shared) => shared.enqueue(key, work).await,
        }
    }

    /// Wait for everything the lanes have: the barrier in front of an ordered
    /// frame.
    pub async fn drain(&mut self) {
        self.queries.drain().await;
        match &mut self.keys {
            Keys::Own(lane) => lane.drain().await,
            Keys::Shared(shared) => shared.drain().await,
        }
    }

    /// End everything in flight, waiting at most `grace` for it to stop.
    ///
    /// Called when the connection ends. Aborting is the policy rather than a
    /// shortcut: the frames in these lanes belong to a peer that is gone, and a
    /// task parked in a reply send holds a sender — the writer only stops once
    /// every sender is gone, so an abandoned task would hold the connection's
    /// shutdown open for as long as the peer's TCP stack took to give up. The
    /// grace is a ceiling on a wait that should not happen, not a budget anything
    /// is expected to use.
    ///
    /// On a shared lane only *this connection's* work is ended; see
    /// [`SharedKeys::shutdown`].
    pub async fn shutdown(&mut self, grace: Duration) {
        self.queries.shutdown(grace).await;
        match &mut self.keys {
            Keys::Own(lane) => lane.shutdown(grace).await,
            Keys::Shared(shared) => shared.shutdown(grace).await,
        }
    }

    /// What both lanes are doing, for logging and tests.
    ///
    /// The query half is always this connection's. The mutation half is the
    /// connection's own lane when it has one, and the *shared* lane's counters
    /// when it does not: those numbers describe the runtime's resources, which
    /// is the scope a mutation of them happens at — see [`Lanes::shared`].
    pub async fn snapshot(&self) -> (LaneSnapshot, KeySnapshot) {
        let keys = match &self.keys {
            Keys::Own(lane) => lane.snapshot().await,
            Keys::Shared(shared) => shared.lane.snapshot().await,
        };
        (self.queries.snapshot(), keys)
    }

    /// How many mutations this connection's reader had to wait to admit.
    ///
    /// Not part of [`Lanes::snapshot`], and the reason is the scope: the lane's
    /// own `admission_waits` counts every wait *the lane* made a reader take,
    /// which on a shared lane includes waits this connection never had. This is
    /// the count from this connection's side — its own per-key depth when it
    /// owns a lane, its own admission slots when the lane is shared — and it is
    /// the number that says whether *this* peer ever reached its bound.
    ///
    /// The two are not the same statement even for a shared lane: a wait this
    /// connection took because the shared lane's per-key depth was reached is in
    /// the lane's count and not in this one, because whether that depth was
    /// reached by this connection or by another is not something the lane
    /// records.
    pub async fn admission_waits(&self) -> u64 {
        match &self.keys {
            Keys::Own(lane) => lane.snapshot().await.admission_waits,
            Keys::Shared(shared) => shared.admission_waits.load(Ordering::Relaxed),
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
    /// choose between the observation and the enqueue. This polls the same state
    /// instead, under the same patience as everything else here, so a lane that
    /// never goes idle is a failure rather than a hang.
    async fn wait_idle<K>(lane: &KeyedLane<K>)
    where
        K: Clone + Eq + Hash + fmt::Display + Send + Sync + 'static,
    {
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

    /// A key with two variants, so "the same text is not the same resource" can
    /// be tested without borrowing a runtime's `ResourceKey`.
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    enum TestKey {
        Session(String),
        File(String),
    }

    impl fmt::Display for TestKey {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            match self {
                Self::Session(id) => write!(f, "session:{id}"),
                Self::File(id) => write!(f, "file:{id}"),
            }
        }
    }

    fn session(name: &str) -> TestKey {
        TestKey::Session(name.to_string())
    }

    // ── The query lane ──────────────────────────────────────────────────────

    /// Two queries run at the same time.
    ///
    /// The two halves wait for *each other*, so a lane that ran them one after
    /// the other would park on the first and never reach the second — which is
    /// what makes this a proof of overlap rather than of promptness, and why the
    /// whole test is under a timeout: the failure it guards against is a hang,
    /// not a wrong value.
    #[tokio::test]
    async fn two_queries_overlap_execution() {
        let mut lane = QueryLane::new(2, "");
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

    /// The lane holds at its bound: the third query does not start while two are
    /// running, and the reader — the caller of `dispatch` — is what waits.
    ///
    /// This is the "task count does not grow with the message count" property.
    /// The witness is that the third query's own body has not run, not that it
    /// arrived late.
    #[tokio::test]
    async fn the_lane_holds_at_its_bound_until_a_query_finishes() {
        // Behind a lock, because the third admission has to be made *while* the
        // test is watching: `dispatch` is the call that waits, so a test that
        // made it from its own task would park instead of observing.
        let lane = Arc::new(Mutex::new(QueryLane::new(2, "")));
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
        // not: it cannot be, because a slot is not free until the gate opens, and
        // the delay is what makes this about the bound rather than about
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
        let mut lane = QueryLane::new(2, "");
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
        let mut lane = QueryLane::new(2, "");
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
        let bound = 4;
        let mut lane = QueryLane::new(bound, "");
        for _ in 0..bound {
            lane.dispatch(async {}).await;
        }
        lane.drain().await;

        let snapshot = lane.snapshot();
        assert_eq!(snapshot.started, bound as u64);
        assert_eq!(snapshot.completed, bound as u64);
        assert_eq!(snapshot.admission_waits, 0);
        assert!(
            snapshot.peak_in_flight <= snapshot.bound as u64,
            "the lane exceeded its own bound: {snapshot:?}"
        );
    }

    // ── The keyed mutation lane ─────────────────────────────────────────────

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
    /// and parked, which is what makes the witness deterministic: the test itself
    /// decides that the first mutation is in flight before the second exists, so
    /// an overtaking worker has nowhere to hide.
    #[tokio::test]
    async fn mutations_of_one_key_never_overlap() {
        let lane = KeyedLane::new(8, "");
        let held = gate();
        let first_finished = Arc::new(AtomicBool::new(false));
        let overlapped = Arc::new(AtomicBool::new(false));
        let order = Arc::new(Mutex::new(Vec::new()));

        let key = session("s1");
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
    /// reach it.
    #[tokio::test]
    async fn different_keys_do_not_wait_for_each_other() {
        let lane = KeyedLane::new(8, "");
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
            lane.enqueue(session("s1"), parked).await;
            lane.enqueue(session("s2"), quick).await;
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
        assert_eq!(lane.snapshot().await.keys, 0, "an idle key was left behind");
    }

    /// A key's queue holds at its depth, and the enqueue — the reader — is what
    /// waits.
    ///
    /// The depth bounds what is *queued*, so the running mutation is not one of
    /// them: the worker pops a mutation out of the queue to run it, which is why
    /// this test waits for the first one to have **started** before filling the
    /// queue behind it. Without that wait the worker would still be holding the
    /// queue full from the test's point of view and popping one would free a slot
    /// before the fourth enqueue ever looked.
    #[tokio::test]
    async fn a_keys_queue_holds_at_its_depth_until_a_mutation_finishes() {
        let lane = Arc::new(KeyedLane::new(2, ""));
        let held = gate();
        let started = Arc::new(AtomicUsize::new(0));
        let key = session("s1");

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

    /// The number of resources being mutated at once is bounded, and the reader
    /// is what waits for room.
    ///
    /// A per-key depth alone does not provide this: a thousand distinct resources
    /// are a thousand keys, each within its own depth, and therefore a thousand
    /// workers. What bounds that is one permit per key with a worker, and this is
    /// the assertion — three keys against a budget of two, with the third's
    /// *worker* (not merely its queue entry) absent until one of the others
    /// finishes.
    ///
    /// The two that are running are parked, so the third cannot be admitted by
    /// anything but a permit being freed. The bounded window is the negative half
    /// and is safe in that direction.
    #[tokio::test]
    async fn only_so_many_resources_are_mutated_at_once() {
        let budget = 2;
        // A depth wide enough that the *key* queues never bind: what is under
        // test is the worker count, not the queue depth.
        let lane = Arc::new(KeyedLane::with_worker_budget(8, budget, ""));
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
                lane.enqueue(session(&format!("s{n}")), parked(&started, &held))
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
                lane.enqueue(session("s3"), parked(&started, &held)).await;
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

    /// A key is reusable: a mutation arriving after its queue drained still runs,
    /// and still runs alone.
    ///
    /// This is what a worker that removed its key's entry too eagerly would
    /// break — the next mutation would find no queue and no worker, and its
    /// ordering guarantee would be gone with them.
    #[tokio::test]
    async fn a_key_can_be_reused_after_its_queue_drains() {
        let lane = KeyedLane::new(8, "");
        let key = session("s1");
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
    /// A session named after a path and a file at that path are not the same
    /// resource, and a lane keyed by the bare string would merge them — which is
    /// the kind of merge that shows up later as an unexplained stall on a session
    /// somebody happened to name after a file.
    #[tokio::test]
    async fn two_kinds_of_resource_of_the_same_name_are_different_keys() {
        let lane = KeyedLane::new(8, "");
        let held = gate();
        let finished = Arc::new(AtomicUsize::new(0));

        within_patience("the file's mutation never ran", async {
            lane.enqueue(
                TestKey::Session("a/b.txt".to_string()),
                Box::pin({
                    let held = Arc::clone(&held);
                    async move { pass(&held).await }
                }),
            )
            .await;
            lane.enqueue(
                TestKey::File("a/b.txt".to_string()),
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
        let mut lanes = Lanes::new(2, 8, "");
        within_patience("an idle lane never drained", lanes.drain()).await;
        lanes.key(session("s1"), nothing()).await;
        within_patience("a one-item lane never drained", lanes.drain()).await;
        let (_, keys) = lanes.snapshot().await;
        assert_eq!(keys.keys, 0);
        assert_eq!(keys.completed, 1);
        assert_eq!(keys.started, 1);
        assert_eq!(keys.depth, 8);
        assert_eq!(
            keys.deepest, 0,
            "an idle lane has no queued work to be deep"
        );
    }

    // ── Both lanes, and the barrier across them ─────────────────────────────

    /// An ordered frame waits for **both** lanes.
    ///
    /// This is why [`Lanes`] is one object: an attach or an auth written after a
    /// mutation must not be applied while that mutation is still running, and a
    /// reader that drained the query lane alone would apply it anyway.
    ///
    /// The two halves are deliberately *different* here, and that is what makes
    /// the test able to fail: the query finishes on its own, so the only thing
    /// the barrier still has to wait for is the parked mutation, and a `drain`
    /// that covered one lane returns early while `finished` is still `1`.
    /// (Measured when this test was written: the first version parked **both**
    /// halves on one gate and opened it before draining, so the mutation's own
    /// task could finish during the query lane's teardown and the assertion
    /// passed with the key lane removed from `drain`. A test that cannot fail is
    /// not one.)
    #[tokio::test]
    async fn drain_returns_only_when_both_lanes_are_idle() {
        let mut lanes = Lanes::new(2, 8, "");
        let key_held = gate();
        let finished = Arc::new(AtomicUsize::new(0));

        within_patience("the query never finished", {
            let finished = Arc::clone(&finished);
            lanes.query(async move {
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
            lanes.key(
                session("s1"),
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

        // Asserted *before* the opener is joined, and that ordering is the whole
        // test: a `drain` that returned early would otherwise get the 20 ms the
        // opener still has to sleep, during which the mutation it was supposed to
        // wait for finishes and the assertion reads `2` anyway. (Measured: with
        // the join first, removing the key lane from `drain` left this test
        // green.)
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

    /// Ending the connection ends its work, and frees the slots while it does.
    ///
    /// The key lane alone, and that is deliberate: with a *query* also in flight,
    /// the query lane's shutdown is what yields to the runtime first, and the
    /// key's worker then pops its queue and removes its key before the key lane
    /// is touched. That was measured on the agent-central copy — the assertion
    /// below passed there with the queue-clearing removed entirely, which is a
    /// test that cannot fail. [`shutdown_drops_work_that_was_never_started`] is
    /// the one that can.
    #[tokio::test]
    async fn shutdown_stops_the_work_in_flight() {
        let mut lanes = Lanes::new(2, 8, "");
        let held = gate();
        let finished = Arc::new(AtomicUsize::new(0));

        within_patience("the work was never admitted", async {
            lanes
                .key(
                    session("s1"),
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
            "the work was let through instead of being ended"
        );
        let (queries, keys) = lanes.snapshot().await;
        assert_eq!(queries.in_flight, 0, "an ended query still holds its slot");
        assert_eq!(
            keys.queued, 0,
            "an ended mutation is still queued, and nothing is left to run it"
        );
    }

    /// The summary line reports the numbers a reader of them is looking for.
    ///
    /// Cheap to assert and worth asserting: this function is the only production
    /// reader of these snapshots (`#961`'s "metrics / logging can observe ..."), so
    /// a field that stopped reaching the log would otherwise be invisible — the
    /// line would still be emitted, still look plausible, and report a number
    /// nobody was measuring any more.
    #[tokio::test]
    async fn the_summary_names_every_counter() {
        let mut lanes = Lanes::new(2, 8, "test ");
        let held = gate();
        let key = session("s1");

        // One query that finishes, and three mutations of one key of which the
        // first is parked: `peak_in_flight` is 1, `deepest` is 2, and the two
        // queued behind the parked one are what `queued` counts.
        lanes.query(async {}).await;
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        lanes
            .key(
                key.clone(),
                Box::pin({
                    let held = Arc::clone(&held);
                    async move {
                        let _ = started_tx.send(());
                        pass(&held).await;
                    }
                }),
            )
            .await;
        started_rx.await.expect("the first mutation started");
        lanes
            .key(key.clone(), {
                let held = Arc::clone(&held);
                Box::pin(async move { pass(&held).await })
            })
            .await;
        lanes
            .key(key.clone(), {
                let held = Arc::clone(&held);
                Box::pin(async move { pass(&held).await })
            })
            .await;

        let (queries, keys) = lanes.snapshot().await;
        let line = summary(&queries, &keys);
        for expected in [
            "queries: started=1",
            "completed=1",
            "peak_in_flight=1 of 2",
            "mutations: started=1",
            "queued=2 deepest=2 of 8",
        ] {
            assert!(
                line.contains(expected),
                "the teardown summary stopped reporting `{expected}`: {line}"
            );
        }

        held.add_permits(3);
        lanes.drain().await;
    }

    /// Shutdown drops the work that was queued and never started.
    ///
    /// The assertion the doc comment on [`KeyedLane::shutdown`] makes, and the
    /// one `#961-F` found a copy of this lane failing: the agent's peer-to-peer
    /// lane aborted its workers and then left the map alone, so `queued` stayed
    /// at its pre-shutdown depth and the lane went on describing work with
    /// nobody left to run it. Measured there: `queued == 1` after a shutdown
    /// whose own doc said "queued work is dropped".
    ///
    /// The witness is the *depth* rather than a single entry, and the first
    /// mutation is parked inside a gate that never opens — so nothing can pop
    /// the two behind it, and a lane that skipped the clear cannot be rescued by
    /// a worker that happens to run during the abort.
    #[tokio::test]
    async fn shutdown_drops_work_that_was_never_started() {
        let mut lanes = Lanes::new(2, 8, "");
        let held = gate();
        let started = Arc::new(AtomicUsize::new(0));
        let key = session("s1");

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
            lanes
                .key(
                    key.clone(),
                    Box::pin({
                        let started = Arc::clone(&started);
                        let held = Arc::clone(&held);
                        async move {
                            let _ = first_started_tx.send(());
                            started.fetch_add(1, Ordering::SeqCst);
                            pass(&held).await;
                        }
                    }),
                )
                .await;
            // The worker has taken the first mutation out of the queue and is
            // parked inside it, so the two below are the whole of the queue and
            // no worker will ever reach them.
            first_started_rx.await.expect("the first mutation started");
            lanes.key(key.clone(), blocked(&started, &held)).await;
            lanes.key(key.clone(), blocked(&started, &held)).await;
            assert_eq!(lanes.snapshot().await.1.queued, 2);
        })
        .await;

        lanes.shutdown(Duration::from_secs(1)).await;

        let (_, keys) = lanes.snapshot().await;
        assert_eq!(
            started.load(Ordering::SeqCst),
            1,
            "only the mutation that had already started ran"
        );
        assert_eq!(
            keys.queued, 0,
            "queued work survived the shutdown that is documented to drop it"
        );
        assert_eq!(keys.keys, 0, "an ended key is still in the map");
    }

    // ── The shared lane (#961 review, findings 1 and 3) ──────────────────────
    //
    // What is tested here is *scope*: who a lane is shared with, and what a
    // connection still owns when it is. The mechanism — one worker per key, FIFO
    // within a key, independence across keys — is the same one the tests above
    // exercise through `Lanes::new`, and those are unchanged.

    /// A mutation that records that it started, parks, and records that it finished.
    fn parking(
        started: &Arc<AtomicUsize>,
        finished: &Arc<AtomicUsize>,
        held: &Arc<Semaphore>,
    ) -> Work {
        let started = Arc::clone(started);
        let finished = Arc::clone(finished);
        let held = Arc::clone(held);
        Box::pin(async move {
            started.fetch_add(1, Ordering::SeqCst);
            pass(&held).await;
            finished.fetch_add(1, Ordering::SeqCst);
        })
    }

    /// Wait for a counter to reach `want`.
    ///
    /// Admitting a mutation spawns its worker; it does not run it. A test that
    /// asserted a counter immediately after admitting would be asserting on
    /// whether the worker had been polled yet, which is a race and not a
    /// property.
    async fn wait_for_count(what: &str, counter: &Arc<AtomicUsize>, want: usize) {
        within_patience(what, async {
            loop {
                if counter.load(Ordering::SeqCst) >= want {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await;
    }

    /// Two connections mutating one resource are ordered against each other, and
    /// two mutating different ones are not.
    ///
    /// This is the guarantee `#961`'s review found missing. A lane per
    /// connection promises `same resource + same connection → FIFO`; what two
    /// peers on one session need is `same resource → FIFO`, and with a lane each
    /// they hold two maps and two sets of workers for one tmux session, neither
    /// ordering the other's frames.
    ///
    /// The witness is the second connection's *own* work: its mutation of the
    /// first connection's key has not run while that one is parked. The
    /// counter-assertion keeps this about the key rather than about the
    /// connections: the second connection's mutation of a *different* key runs at
    /// once, from the same dispatch loop into the same lane.
    #[tokio::test]
    async fn a_shared_lane_orders_two_connections_mutating_one_resource() {
        let lane = Arc::new(KeyedLane::new(8, ""));
        let mut first = Lanes::shared(2, Arc::clone(&lane), 4, "");
        let mut second = Lanes::shared(2, Arc::clone(&lane), 4, "");
        let held = gate();
        let started = Arc::new(AtomicUsize::new(0));
        let finished = Arc::new(AtomicUsize::new(0));

        first
            .key(session("s1"), parking(&started, &finished, &held))
            .await;
        wait_for_count("the first connection's mutation never started", &started, 1).await;

        // The same resource, from the other connection: queued behind it. A
        // different resource, from the same other connection: not queued at all.
        second
            .key(session("s1"), parking(&started, &finished, &held))
            .await;
        second
            .key(session("s2"), parking(&started, &finished, &held))
            .await;

        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            started.load(Ordering::SeqCst),
            2,
            "a second connection's mutation of the resource the first was mutating ran \
at the same time as it: the key orders a resource, so this is either a lane that was \
not shared or one that was not keyed"
        );

        held.add_permits(8);
        wait_idle(&lane).await;
        assert_eq!(
            started.load(Ordering::SeqCst),
            3,
            "the queued mutation never ran: the ordering turned into a loss"
        );
        assert_eq!(finished.load(Ordering::SeqCst), 3);
    }

    /// A flood of *distinct* resources is bounded by the connection's own
    /// admission, not by how many resources it names.
    ///
    /// The bound tests above repeat work for one key, which is the shape
    /// `#961`'s review says was not enough: a per-key queue bounds how far ahead
    /// of *one* resource a peer may get, and 64 distinct keys are 64 queues, each
    /// within its depth, and therefore 64 workers. What bounds that is this
    /// connection's slots, taken before the work reaches the lane.
    ///
    /// The other connection is the second half, and it is why the bound is on the
    /// connection rather than on the lane: a peer that has spent its own slots
    /// has spent nobody else's.
    #[tokio::test]
    async fn a_flood_of_distinct_resources_is_bounded_per_connection() {
        const BOUND: usize = 4;
        const KEYS: usize = 64;

        let lane = Arc::new(KeyedLane::new(8, ""));
        let mut flood = Lanes::shared(2, Arc::clone(&lane), BOUND, "");
        let mut elsewhere = Lanes::shared(2, Arc::clone(&lane), BOUND, "");
        let held = gate();
        let started = Arc::new(AtomicUsize::new(0));
        let finished = Arc::new(AtomicUsize::new(0));
        let neighbour_ran = Arc::new(AtomicUsize::new(0));

        // The flood runs on its own task, because the *reader* is what waits for
        // a slot: a test that enqueued from its own task would park instead of
        // observing. That is the property, not an inconvenience.
        let flooding = tokio::spawn({
            let started = Arc::clone(&started);
            let finished = Arc::clone(&finished);
            let held = Arc::clone(&held);
            async move {
                for n in 0..KEYS {
                    flood
                        .key(
                            session(&format!("s{n}")),
                            parking(&started, &finished, &held),
                        )
                        .await;
                }
            }
        });

        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            started.load(Ordering::SeqCst),
            BOUND,
            "a connection naming {KEYS} distinct resources had more of them in flight \
than its own bound allows: the number of tasks tracks the number of keys, which is the \
unbounded unique-key growth this bound exists for"
        );

        // And a second connection is not behind any of it.
        within_patience(
            "another connection's mutation waited on a neighbour's flood",
            async {
                elsewhere
                    .key(
                        session("elsewhere"),
                        Box::pin({
                            let neighbour_ran = Arc::clone(&neighbour_ran);
                            async move {
                                neighbour_ran.fetch_add(1, Ordering::SeqCst);
                            }
                        }),
                    )
                    .await;
            },
        )
        .await;
        wait_for_count(
            "another connection's mutation never ran behind a neighbour's flood",
            &neighbour_ran,
            1,
        )
        .await;

        held.add_permits(KEYS * 2);
        within_patience("the flood never finished", async {
            flooding.await.expect("the flooding task panicked");
        })
        .await;
        wait_idle(&lane).await;
        assert_eq!(
            started.load(Ordering::SeqCst),
            KEYS,
            "the bound turned into a loss: a mutation the connection dispatched never ran"
        );
        assert_eq!(finished.load(Ordering::SeqCst), KEYS);
    }

    /// A connection's ordered frame does not wait on another connection's
    /// mutations.
    ///
    /// The barrier in front of an `Ordered` frame is what keeps an auth or an
    /// attach from being applied before the work read before it. On a shared lane
    /// "the work read before it" is not "the lane is empty": a barrier that waited
    /// for the lane would wait for a neighbour's traffic, for as long as that
    /// neighbour's backend takes — a stall one peer could inflict on another,
    /// which is what this scope change exists to remove.
    ///
    /// What it waits for is the connection's own outstanding mutations, which is
    /// what the slots count: a connection with nothing in flight drains while a
    /// neighbour's mutation sits parked in the same lane.
    #[tokio::test]
    async fn a_connections_barrier_does_not_wait_for_a_neighbours_mutations() {
        let lane = Arc::new(KeyedLane::new(8, ""));
        let mut busy = Lanes::shared(2, Arc::clone(&lane), 4, "");
        let mut idle = Lanes::shared(2, Arc::clone(&lane), 4, "");
        let held = gate();
        // Counted, so the drain below is asserted while the neighbour's mutation
        // is demonstrably running rather than merely admitted.
        let ran = Arc::new(AtomicUsize::new(0));

        busy.key(
            session("s1"),
            Box::pin({
                let ran = Arc::clone(&ran);
                let held = Arc::clone(&held);
                async move {
                    ran.fetch_add(1, Ordering::SeqCst);
                    pass(&held).await;
                }
            }),
        )
        .await;
        wait_for_count("the neighbour's mutation never started", &ran, 1).await;

        within_patience(
            "an idle connection's ordered frame waited on a neighbour's mutation",
            idle.drain(),
        )
        .await;

        // The half that keeps this from being a test of "drain does nothing":
        // the connection that *did* dispatch still waits for its own work, and
        // returns once it is done.
        let finished = Arc::new(AtomicUsize::new(0));
        busy.key(
            session("s2"),
            Box::pin({
                let finished = Arc::clone(&finished);
                async move {
                    finished.fetch_add(1, Ordering::SeqCst);
                }
            }),
        )
        .await;
        held.add_permits(8);
        within_patience("the busy connection never drained", busy.drain()).await;
        assert_eq!(finished.load(Ordering::SeqCst), 1);
        idle.shutdown(Duration::from_secs(1)).await;
    }

    /// Ending a connection stops its own mutations and leaves the lane running.
    ///
    /// Two claims, because they are the two halves of "this lane is not mine to
    /// end". The work a gone peer queued must not run on its behalf; the work a
    /// neighbour queued into the same lane must not be touched by that.
    ///
    /// The leaving connection's first mutation is parked inside its own key, so
    /// its second is *queued* — the case the cancellation has to reach, since a
    /// queued frame has no task to abort and no reader to notice.
    #[tokio::test]
    async fn ending_a_connection_stops_its_own_mutations_and_not_the_lane() {
        let lane = Arc::new(KeyedLane::new(8, ""));
        let mut leaving = Lanes::shared(2, Arc::clone(&lane), 4, "");
        let mut staying = Lanes::shared(2, Arc::clone(&lane), 4, "");
        let held = gate();
        let leaving_started = Arc::new(AtomicUsize::new(0));
        let leaving_finished = Arc::new(AtomicUsize::new(0));
        let staying_started = Arc::new(AtomicUsize::new(0));
        let staying_finished = Arc::new(AtomicUsize::new(0));

        staying
            .key(
                session("keep"),
                parking(&staying_started, &staying_finished, &held),
            )
            .await;
        wait_for_count(
            "the neighbour's mutation never started",
            &staying_started,
            1,
        )
        .await;

        leaving
            .key(
                session("s1"),
                parking(&leaving_started, &leaving_finished, &held),
            )
            .await;
        wait_for_count(
            "the leaving connection's mutation never started",
            &leaving_started,
            1,
        )
        .await;
        // Queued behind it: the one the cancellation has to reach.
        leaving
            .key(
                session("s1"),
                parking(&leaving_started, &leaving_finished, &held),
            )
            .await;

        leaving.shutdown(Duration::from_secs(2)).await;

        assert_eq!(
            leaving_finished.load(Ordering::SeqCst),
            0,
            "a running mutation was let through after the connection ended"
        );
        assert_eq!(
            staying_started.load(Ordering::SeqCst),
            1,
            "the neighbour's mutation was stopped too: a connection's end must not reach \
work it did not dispatch"
        );
        assert_eq!(staying_finished.load(Ordering::SeqCst), 0);

        // Let the parked work go, so the queue behind it is actually reached. A
        // test that left it parked would be asserting that a *stopped* worker
        // never reached the work behind it, which is true whether or not
        // anything was cancelled — it would pass on an implementation whose
        // queued mutations run normally the moment their key frees.
        held.add_permits(4);
        wait_idle(&lane).await;

        assert_eq!(
            leaving_started.load(Ordering::SeqCst),
            1,
            "a mutation that was still queued when the connection ended ran anyway, on \
behalf of a peer that is gone"
        );
        assert_eq!(
            leaving_finished.load(Ordering::SeqCst),
            0,
            "a running mutation finished after the connection ended"
        );
        assert_eq!(
            staying_finished.load(Ordering::SeqCst),
            1,
            "the neighbour's parked mutation did not finish once its gate opened: the \
lane it is on was ended with the connection that left"
        );
    }
}
