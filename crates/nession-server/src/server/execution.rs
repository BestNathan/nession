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
//! | [`ExecutionPolicy::Ordered`] | `server.auth`, `server.agent.register`, `server.session.attach`, `server.relay.*` | waits for the queries in flight, then runs it — so it is applied, and answered, *after* everything read before it |
//! | [`ExecutionPolicy::Inline`] | every other unit, every control wire, every frame this Server only forwards, and anything that is not a protocol frame | runs it where it stands |
//! | [`ExecutionPolicy::Query`] | the read-only units | admits it to a bounded lane and reads the next frame |
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
//! [`QueryLane::acquire`] waits when the lane is full, and the waiter is the
//! read loop — so a connection that has filled its lane stops being read from.
//! That is the whole of #961's "no per-message unbounded `tokio::spawn`": the
//! tasks a connection may have in flight is a number, and the way it is
//! enforced is that the frame which would exceed it is not read until there is
//! room for it. The bound is per connection rather than process-wide, because
//! what it protects is the *connection's* ability to make progress, and one
//! busy browser must not consume the fleet's budget.

use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};
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

/// How the reader dispatches one frame.
///
/// The policy is a property of the **Protocol Unit**, declared beside the unit
/// in the one `server_routes!` invocation that also produces the manifest and
/// the dispatcher — so a unit cannot be added without stating how it is
/// dispatched, and nothing here has to know what an `extension.*` wire is. The
/// requirement is explicit that the policy "must act on a Protocol Unit" and
/// must not be hardcoded as a prefix or a core special case; a table keyed by
/// what the Server serves is the difference between the two.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionPolicy {
    /// Serial, and ordered against everything already read on this connection:
    /// the frame is not run until the queries in flight have finished.
    ///
    /// This is the lane for messages whose *effect* later frames depend on —
    /// authentication, agent registration, session attach, the relay mode
    /// transitions — and for the same reason it is the lane whose replies must
    /// not overtake the replies of frames read before it.
    Ordered,
    /// Serial, and not ordered against the queries in flight: the reader runs
    /// it where it stands.
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
}

/// The policy one wire is dispatched under.
///
/// A unit's policy comes from the declaration; anything else is
/// [`ExecutionPolicy::Inline`] — see that variant for why an undeclared wire is
/// not guessed at.
pub fn policy_for_wire(wire: &str) -> ExecutionPolicy {
    unit_policy(wire).unwrap_or(ExecutionPolicy::Inline)
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

    /// Run one query-lane frame and answer it through the connection's reply
    /// lane.
    ///
    /// `handler` is the connection's clone, taken when the frame was read: the
    /// query sees the connection's identity as of that moment, and cannot move
    /// it.
    pub async fn dispatch_query(
        &mut self,
        mut handler: ConnectionHandler,
        msg: ProtocolMessage<serde_json::Value>,
        sender: WsMessageSender,
    ) {
        self.dispatch(async move {
            match handler.handle_protocol_message(msg).await {
                Ok(HandlerAction::Reply(Some(reply))) => {
                    // The reply lane waits for room and never drops, so the only
                    // error here is the connection being over — in which case
                    // there is nobody left to answer.
                    if sender.send_reply(reply).await.is_err() {
                        debug!("the connection ended before a query's answer could be written");
                    }
                }
                Ok(HandlerAction::Reply(None)) => {}
                Ok(HandlerAction::Close) | Ok(HandlerAction::Relay { .. }) => error!(
                    "a unit declared `Query` answered with a connection action; a query must \
                     answer and nothing else — see `ExecutionPolicy::Query`"
                ),
                Err(e) => error!("a query failed: {e:#}"),
            }
        })
        .await;
    }

    /// Wait for every query in flight.
    ///
    /// The reader calls this before an [`ExecutionPolicy::Ordered`] frame:
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
        assert_eq!(
            policy_for_wire("git.status"),
            ExecutionPolicy::Inline,
            "a wire this Server does not serve has no declaration to read"
        );
        assert_eq!(
            policy_for_wire("control.heartbeat"),
            ExecutionPolicy::Inline
        );
    }
}
