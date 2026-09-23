//! One connection's outbound path: a bounded queue, and the mechanism every
//! policy at the bound is built out of (`#961-B`, `#961-E`, converged in
//! `#961-F`).
//!
//! Before this module each runtime had its own copy — the Server's
//! `server::outbound` and the agent's `server::outbound` — and they were the
//! same queue with the same two bounds, the same three verdicts, the same
//! permit-released-by-the-writer discipline and the same snapshot fields, kept
//! in step by nothing. What differs between them is the *policies*, and the
//! policies are what stayed: see the two modules for which lane drops, which
//! one fails a request, and which one closes a connection.
//!
//! ## The bound
//!
//! Bytes *and* frames, because they bind on different lanes: a reply is one big
//! frame (a capture preview, or an extension read at its contract cap), so the
//! byte budget binds first for it; a terminal frame is a few KiB, so the frame
//! count binds first for it. Whichever is reached first is the effective bound,
//! and both are stated rather than assumed. The two numbers are the calling
//! runtime's — [`Limits`] — and are deliberately not chosen here: a concurrency
//! policy belongs to the runtime that implements it (`#961` constraints).
//!
//! ## What waits, and why
//!
//! [`Outbound::send_reply`] waits for room and never drops, which is the lane
//! `#961` is emphatic about ("a non-droppable command response must not be
//! silently dropped"). Waiting is what makes that true rather than merely
//! likely: there is no path through it that loses the frame, and the cost of the
//! guarantee is that a peer which never drains parks its producer instead of
//! growing the heap. The parked task holds its slot in whatever lane ran it, so
//! a bound one lane up is what stops the connection reading more — which is the
//! backpressure, and it is why the bound is worth having at all.
//!
//! [`Outbound::send_terminal`] waits the same way up to the stall grace and then
//! reports [`OutboundError::Stalled`]. Terminal bytes cannot be dropped (the
//! emulator and the session would disagree about the screen) and cannot be
//! buffered without bound (that is the queue this replaced), so the only honest
//! answer left is a verdict on the *peer* — which the calling runtime turns into
//! whatever ending a connection means for it.
//!
//! ## Who writes
//!
//! The queue is drained by whoever the runtime hands the receiver to, and the
//! permit on each [`QueuedFrame`] is released when that consumer is done with
//! it — after the frame has been handed to the socket, not when it was queued.
//! That is what makes the byte budget a bound on what is *unwritten* rather than
//! on what is merely accepted.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{debug, warn};

/// What the WebSocket frame header costs beyond the payload `Message::len`
/// reports. Charged so a queue full of small frames is priced honestly.
pub const FRAME_OVERHEAD: usize = 14;

/// The verdicts this queue can hand a producer.
///
/// Deliberately one enum rather than one per method: the call sites differ in
/// which variants they can see, but "the connection is over", "there is no room
/// and this lane does not wait", and "there was no room for long enough that the
/// peer is gone" are the same three facts everywhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboundError {
    /// The writer is gone — the connection has ended, and this frame will never
    /// be written by this path.
    Closed,
    /// The queue is at its bound and this lane does not wait for room.
    Saturated,
    /// The queue was at its bound for the whole stall grace. The peer has
    /// stopped draining, which is a statement about the peer and not about us.
    Stalled,
}

impl std::fmt::Display for OutboundError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Closed => write!(f, "the connection's outbound path is closed"),
            Self::Saturated => write!(f, "the outbound queue is at its bound"),
            Self::Stalled => write!(f, "the outbound queue stayed full for the stall grace"),
        }
    }
}

impl std::error::Error for OutboundError {}

/// The two bounds one connection's queue holds to.
///
/// Both, and not one: see the module docs. Which of the two binds first is a
/// property of what a runtime puts on the queue, so neither is derived from the
/// other here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// How many bytes may be queued before producers wait.
    pub bytes: usize,
    /// How many frames may be queued before producers wait.
    pub frames: usize,
}

/// One frame waiting to be written, holding the claim on the byte budget that
/// lets it wait there.
///
/// The permit is what makes the queue's bound real: it is released when the
/// writer drops this struct, i.e. after the frame has been handed to the socket,
/// so `Limits::bytes` is the most that can be queued *and* not yet written.
pub struct QueuedFrame {
    pub message: WsMessage,
    /// This frame's share of the byte budget. Held until the writer is done with
    /// it — dropping it early would let producers run ahead of the socket the
    /// budget exists to bound.
    pub budget: OwnedSemaphorePermit,
}

/// What a caller can see about one connection's outbound path, without the
/// per-runtime policy counters.
///
/// The counts are the observable half of every policy above: `awaited` says the
/// bound was reached and producers waited, `stalled_terminals` says terminal
/// clients were closed. A policy that could not be observed here would be
/// indistinguishable from an outage. The lanes that *drop* or *fail* are the
/// calling runtime's — it keeps their counters — so they are not here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueueSnapshot {
    /// Bytes currently queued, including the frame being written.
    pub queued_bytes: usize,
    /// Frames currently queued, including the frame being written.
    pub queued_frames: usize,
    /// The bounds `queued_*` move within.
    pub byte_budget: usize,
    pub frame_slots: usize,
    /// Reply-lane sends that found the queue full and waited for room.
    pub awaited: u64,
    /// Terminal-lane sends that hit the stall grace.
    pub stalled_terminals: u64,
}

#[derive(Default)]
struct Counters {
    awaited: AtomicU64,
    stalled_terminals: AtomicU64,
}

/// The sending half of one connection's outbound path.
///
/// Cloneable and shared: the connection's own handler, every lane's task, the
/// registries that push state to it and the terminal forwarders all hold one.
/// They are not interchangeable producers — which is why there is no bare
/// `send` here, and why each caller has to say which *class* of message it is
/// sending.
#[derive(Clone)]
pub struct Outbound {
    tx: mpsc::Sender<QueuedFrame>,
    budget: Arc<Semaphore>,
    limits: Limits,
    counters: Arc<Counters>,
    terminal_grace: Duration,
    /// The runtime's name for this path, so its log lines say which connection
    /// is saturated — the same device the lanes use, for the same reason.
    name: &'static str,
}

impl Outbound {
    /// A connection's outbound path at the calling runtime's bounds, and the
    /// receiver its writer drains.
    ///
    /// No defaults: both numbers and the stall grace are the caller's, because
    /// they are the runtime's answer rather than the mechanism's.
    pub fn new(
        name: &'static str,
        limits: Limits,
        terminal_grace: Duration,
    ) -> (Self, mpsc::Receiver<QueuedFrame>) {
        let (tx, rx) = mpsc::channel(limits.frames.max(1));
        (
            Self {
                tx,
                budget: Arc::new(Semaphore::new(limits.bytes)),
                limits,
                counters: Arc::new(Counters::default()),
                terminal_grace,
                name,
            },
            rx,
        )
    }

    /// Send a frame the peer is waiting for: a reply to a request that arrived
    /// on this connection, or a brokered answer being relayed to the client that
    /// asked for it.
    ///
    /// **Waits for room; never drops.** This is the lane `#961` is emphatic
    /// about — "a non-droppable command response must not be silently dropped" —
    /// and waiting is what makes that true rather than merely likely: there is
    /// no path through this method that loses the frame, and the cost of the
    /// guarantee is that a peer which never drains parks its producer instead of
    /// growing the heap.
    pub async fn send_reply(&self, msg: WsMessage) -> Result<(), OutboundError> {
        let len = msg.len();
        let (budget, waited) = self.acquire(len).await.ok_or(OutboundError::Closed)?;
        if waited {
            debug!(
                "{}: no room for a reply, waiting for the writer \
                 ({} frame(s), {} byte(s) queued)",
                self.name,
                self.queued_frames(),
                self.queued_bytes()
            );
        }
        self.enqueue(msg, budget).await
    }

    /// Forward one chunk of terminal output.
    ///
    /// Same lane as [`Self::send_reply`] up to the point where waiting stops
    /// being reasonable. Terminal output has the bottleneck a reply does not: it
    /// is *steady* — a busy session produces it whether or not anybody is
    /// watching — so a peer that has stopped draining does not park a producer
    /// that was going to finish anyway, it pins the relay and the backend's
    /// output behind it indefinitely.
    ///
    /// So this waits for room, and gives up after the stall grace. `Stalled` is
    /// the caller's cue to end the connection — see this module's docs for why
    /// that is the only honest answer left.
    pub async fn send_terminal(&self, msg: WsMessage) -> Result<(), OutboundError> {
        // The grace covers *both* bounds, which is why the whole enqueue is
        // inside the timeout rather than just the byte reservation: a terminal
        // frame can be waiting on the frame count rather than on the budget, and
        // a lane that gave up on one bound but not the other would park here
        // exactly as before.
        match tokio::time::timeout(self.terminal_grace, self.enqueue_reserved(msg)).await {
            Ok(result) => result,
            Err(_) => {
                self.counters
                    .stalled_terminals
                    .fetch_add(1, Ordering::Relaxed);
                warn!(
                    "{}: terminal frame waited {:?} for room and never got it — the peer \
                     has stopped draining ({} frame(s), {} byte(s) queued); ending the \
                     connection",
                    self.name,
                    self.terminal_grace,
                    self.queued_frames(),
                    self.queued_bytes()
                );
                Err(OutboundError::Stalled)
            }
        }
    }

    /// Hand a frame to the queue if there is room for it *now*.
    ///
    /// **No policy, and no counter.** Whether a full queue means "fail the
    /// caller's request", "drop this because a later one restates it", or
    /// something else is the calling runtime's, and so is the record of which
    /// happened — which is why this returns the verdict and stops there. See
    /// `nession-server`'s `server::outbound` and `nession-agent`'s
    /// `server::outbound` for the two answers built on it.
    pub fn try_send(&self, msg: WsMessage) -> Result<(), OutboundError> {
        let Some(budget) = Arc::clone(&self.budget)
            .try_acquire_many_owned(permits(charge(msg.len(), self.limits.bytes)))
            .ok()
        else {
            return Err(OutboundError::Saturated);
        };
        self.tx
            .try_send(QueuedFrame {
                message: msg,
                budget,
            })
            .map_err(|e| {
                // The budget was there and the slots were not — or the writer is
                // gone. Both are "no room" for the caller's purposes.
                if matches!(e, mpsc::error::TrySendError::Closed(_)) {
                    OutboundError::Closed
                } else {
                    OutboundError::Saturated
                }
            })
    }

    /// What this connection's outbound path is doing, for logging and tests.
    pub fn snapshot(&self) -> QueueSnapshot {
        QueueSnapshot {
            queued_bytes: self.queued_bytes(),
            queued_frames: self.queued_frames(),
            byte_budget: self.limits.bytes,
            frame_slots: self.limits.frames,
            awaited: self.counters.awaited.load(Ordering::Relaxed),
            stalled_terminals: self.counters.stalled_terminals.load(Ordering::Relaxed),
        }
    }

    /// Bytes charged so far: the budget minus what is left of it. A frame being
    /// written still holds its claim, so this includes it.
    pub fn queued_bytes(&self) -> usize {
        self.limits
            .bytes
            .saturating_sub(self.budget.available_permits())
    }

    /// Frames charged so far, on the same reasoning as [`Self::queued_bytes`].
    pub fn queued_frames(&self) -> usize {
        self.limits.frames.saturating_sub(self.tx.capacity())
    }

    /// Reserve this frame's bytes and hand it to the queue, waiting for both.
    async fn enqueue_reserved(&self, msg: WsMessage) -> Result<(), OutboundError> {
        let len = msg.len();
        let (budget, _) = self.acquire(len).await.ok_or(OutboundError::Closed)?;
        self.enqueue(msg, budget).await
    }

    /// Hand a frame that has already reserved its bytes to the queue, waiting
    /// for a free slot if the count bound is what is full.
    async fn enqueue(
        &self,
        msg: WsMessage,
        budget: OwnedSemaphorePermit,
    ) -> Result<(), OutboundError> {
        self.tx
            .send(QueuedFrame {
                message: msg,
                budget,
            })
            .await
            .map_err(|_| OutboundError::Closed)
    }

    /// Wait for room. `None` means the budget is closed, which is the queue's
    /// other spelling of "the connection is over". The flag says whether this
    /// call actually had to wait, which is the saturation signal.
    ///
    /// The `available_permits` check is an observability heuristic, not the
    /// mechanism: it can count a call that another producer was about to race
    /// for, or miss one that squeaked in. The bound itself is the semaphore.
    async fn acquire(&self, len: usize) -> Option<(OwnedSemaphorePermit, bool)> {
        let charge = charge(len, self.limits.bytes);
        let waited = self.budget.available_permits() < charge;
        if waited {
            self.counters.awaited.fetch_add(1, Ordering::Relaxed);
        }
        Arc::clone(&self.budget)
            .acquire_many_owned(permits(charge))
            .await
            .ok()
            .map(|permit| (permit, waited))
    }
}

/// What one frame is charged against a connection's byte budget.
///
/// A single frame larger than the whole budget is charged the whole budget
/// rather than refused: the contracts cap these at 1 MiB and a refusal would
/// turn "this reply is big" into "this reply cannot be sent". Charging it
/// everything means at most one such frame is ever queued, and the next producer
/// waits for it to be written — which is the same bound, applied to the case the
/// bound was not sized for.
///
/// Public because a runtime's own tests state the charge arithmetic against its
/// own budget, and that is the number the tests should be written against.
pub fn charge(len: usize, limit: usize) -> usize {
    (len + FRAME_OVERHEAD).clamp(1, limit)
}

/// A byte charge as the permit count a `Semaphore` takes.
///
/// `charge` clamps to the caller's budget, which fits in a `u32` for any budget
/// a connection could have, so this cannot lose anything today — `try_from`
/// rather than `as` so that a budget raised past `u32::MAX` becomes a saturating
/// question rather than a silent truncation that would leave a frame holding
/// almost none of the budget it thinks it holds.
pub fn permits(bytes: usize) -> u32 {
    u32::try_from(bytes).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bound a test states plainly: small enough to fill, large enough to
    /// hold a frame that is not the whole budget.
    const LIMITS: Limits = Limits {
        bytes: 64 * 1024,
        frames: 8,
    };

    fn outbound() -> (Outbound, mpsc::Receiver<QueuedFrame>) {
        Outbound::new("test outbound", LIMITS, Duration::from_millis(50))
    }

    /// The reply lane's whole reason to exist: a send that finds the queue full
    /// waits, and the frame is there when the consumer catches up. If this ever
    /// returns `Err` or drops the frame, #961's "must not be silently dropped"
    /// is violated and the flood test in `tests/integration/websocket.rs` stops
    /// being an assertion about anything.
    #[tokio::test]
    async fn a_reply_waits_for_room_rather_than_being_dropped() {
        let (outbound, mut rx) = outbound();

        // A frame sized so each one takes an equal share of the budget: filling
        // with these reaches both bounds at once.
        let share = LIMITS.bytes / LIMITS.frames - FRAME_OVERHEAD;
        let frame = WsMessage::Text("x".repeat(share));
        let mut queued = 0;
        while outbound.try_send(frame.clone()).is_ok() {
            queued += 1;
            assert!(queued <= LIMITS.frames, "the frame bound never fired");
        }
        assert_eq!(queued, LIMITS.frames);
        assert_eq!(outbound.snapshot().queued_bytes, LIMITS.bytes);

        // The reply lane parks instead of failing...
        let waiter = tokio::spawn({
            let outbound = outbound.clone();
            async move { outbound.send_reply(WsMessage::Text("held".into())).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !waiter.is_finished(),
            "a full queue must park the reply lane, not fail it"
        );
        assert_eq!(outbound.snapshot().awaited, 1);

        // ...and completes, whole, once the writer drains.
        for n in 0..queued {
            let written = rx.recv().await.expect("a queued frame went missing");
            assert_eq!(written.message, frame, "frame {n} was not the one queued");
        }
        let last = rx.recv().await.expect("the waiting reply was never queued");
        assert_eq!(last.message, WsMessage::Text("held".into()));
        assert_eq!(waiter.await.expect("reply task panicked"), Ok(()));
    }

    /// The terminal lane waits like a reply, and ends at the grace with a
    /// verdict rather than an unbounded park.
    #[tokio::test]
    async fn a_terminal_frame_that_never_gets_room_stalls() {
        let (outbound, _rx) = outbound();
        let frame = WsMessage::Text("t".repeat(LIMITS.bytes));
        assert_eq!(outbound.send_terminal(frame.clone()).await, Ok(()));

        let started = std::time::Instant::now();
        assert_eq!(
            outbound.send_terminal(frame).await,
            Err(OutboundError::Stalled)
        );
        assert!(
            started.elapsed() >= Duration::from_millis(50),
            "the verdict must come after the grace, not instead of it"
        );
        assert_eq!(outbound.snapshot().stalled_terminals, 1);
    }

    /// A closed writer is reported as such, so the reader can tell "this
    /// connection is over" from "this connection is full".
    #[tokio::test]
    async fn a_gone_writer_is_closed_on_every_lane() {
        let (outbound, rx) = outbound();
        drop(rx);

        assert_eq!(
            outbound.send_reply(WsMessage::Text("a".into())).await,
            Err(OutboundError::Closed)
        );
        assert_eq!(
            outbound.send_terminal(WsMessage::Text("b".into())).await,
            Err(OutboundError::Closed)
        );
        assert_eq!(
            outbound.try_send(WsMessage::Text("c".into())),
            Err(OutboundError::Closed)
        );
    }

    /// A frame bigger than the budget is not refused: it takes the whole budget,
    /// so it can still be sent, and the next producer waits for it.
    #[tokio::test]
    async fn a_frame_larger_than_the_budget_holds_all_of_it() {
        assert_eq!(charge(LIMITS.bytes * 2, LIMITS.bytes), LIMITS.bytes);
        assert_eq!(charge(0, LIMITS.bytes), FRAME_OVERHEAD);

        let (outbound, mut rx) = outbound();
        let huge = WsMessage::Text("h".repeat(LIMITS.bytes * 2));
        assert_eq!(outbound.send_reply(huge.clone()).await, Ok(()));
        assert_eq!(outbound.snapshot().queued_bytes, LIMITS.bytes);

        let waiter = tokio::spawn({
            let outbound = outbound.clone();
            async move { outbound.send_reply(WsMessage::Text("after".into())).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !waiter.is_finished(),
            "the next producer waits for the oversized frame to be written"
        );
        assert_eq!(
            rx.recv().await.map(|frame| frame.message),
            Some(huge),
            "the oversized frame itself is delivered whole"
        );
        assert!(rx.recv().await.is_some());
        assert_eq!(waiter.await.expect("reply task panicked"), Ok(()));
    }

    /// The budget is released by the *writer*, not by the queued frame: a
    /// producer may only run as far ahead as the socket has been fed.
    #[tokio::test]
    async fn the_budget_is_released_when_the_frame_is_written() {
        let (outbound, mut rx) = outbound();
        assert_eq!(
            outbound.send_reply(WsMessage::Text("q".into())).await,
            Ok(())
        );
        assert_eq!(outbound.snapshot().queued_bytes, charge(1, LIMITS.bytes));

        let frame = rx.recv().await.expect("the frame was queued");
        assert_eq!(
            outbound.snapshot().queued_bytes,
            charge(1, LIMITS.bytes),
            "the frame is still holding its claim while it is being written"
        );
        drop(frame);
        assert_eq!(outbound.snapshot().queued_bytes, 0);
        assert_eq!(outbound.snapshot().queued_frames, 0);
    }

    /// A full queue that is full on *frames* rather than bytes is still a full
    /// queue: the two bounds are both enforced, and reaching either one is what
    /// a producer waits for.
    #[tokio::test]
    async fn the_frame_bound_binds_on_its_own() {
        let (outbound, _rx) = outbound();
        let tiny = WsMessage::Text(".".into());
        for _ in 0..LIMITS.frames {
            assert_eq!(outbound.try_send(tiny.clone()), Ok(()));
        }
        assert_eq!(
            outbound.snapshot().queued_bytes,
            LIMITS.frames * charge(1, LIMITS.bytes),
            "the byte budget is nowhere near spent"
        );
        assert_eq!(
            outbound.try_send(tiny),
            Err(OutboundError::Saturated),
            "the frame count is what bound, and it must still be a bound"
        );
    }
}
