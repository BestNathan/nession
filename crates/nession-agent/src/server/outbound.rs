//! One peer-to-peer connection's outbound path: a bounded queue, and the policy
//! that governs each class of message that goes through it (`#961-E`).
//!
//! This is the last of the three outbound paths `#961`'s backpressure section is
//! about, and it was the one still missing a bound. The Server's write path got
//! one in `#961-B` and the agent's *terminal fan-out* in `#961-D`; what remained
//! was the socket a browser is attached to — a bare
//! `Arc<Mutex<SplitSink>>` with no byte budget, no frame budget and no stall
//! policy, where "backpressure" was whatever happened when a task parked on the
//! mutex and the answer to a slow peer was to park one more producer behind it.
//!
//! The bound is one number and the interesting part is again what happens at it,
//! and again that cannot be one answer, because the messages sharing this socket
//! do not share a failure mode:
//!
//! | lane | what is on it | at the bound |
//! |---|---|---|
//! | [`P2pOutbound::send_reply`] | an answer to a request the peer made | **wait** — it is never dropped |
//! | [`P2pOutbound::send_terminal`] | `terminal.output` — a PTY chunk, or a scrollback prefill | **wait, then end the connection** |
//! | [`P2pOutbound::try_send_state`] | `terminal.resize`, a pong | **drop** — a level, and the peer restates it |
//!
//! ## Why the terminal lane ends the connection rather than dropping
//!
//! Terminal bytes cannot be dropped — the emulator and the session would
//! disagree about the screen — and they cannot be buffered without bound, which
//! is the queue this replaces. What is left is the honest verdict: a client that
//! has not drained `OUTBOUND_FRAME_SLOTS` terminal frames over
//! [`OUTBOUND_TERMINAL_STALL_GRACE`] is not attached in any useful sense. The
//! caller ends the connection, and a client that was merely asleep re-attaches
//! and is handed a redrawn screen.
//!
//! That is the same verdict, reached the same way, as the Server's
//! `server::outbound::send_terminal` — and it is *also* what this socket's
//! subscriber policy already said, one hop up: `server::websocket` detaches a
//! subscriber whose `SUBSCRIBER_QUEUE_SLOTS` queue is full. That detach is only
//! reachable if the forwarder ever gets to observe its receiver closing, and a
//! forwarder parked on an unbounded socket write never does — so the stall
//! verdict here is what makes the upper policy *effective* rather than merely
//! stated.
//!
//! ## The bound
//!
//! Bytes *and* frames, because they bind on different lanes: a reply is one big
//! frame (a capture preview, or an extension read at its 1 MiB cap), so the byte
//! budget binds first for it; a terminal frame is a few KiB, so the frame count
//! binds first for it. Whichever is reached first is the effective bound, and
//! both are stated rather than assumed.
//!
//! ## Who writes
//!
//! A task of its own, which owns the sink. That is not a detail of style: a
//! producer that waits for room on a *queue* is cancel-safe, while a producer
//! that waits for a socket under a mutex is not — a timed-out `send` on a
//! half-written frame leaves the socket in a state nothing can repair. The
//! writer is the only thing that touches the socket, so every lane above can
//! have a timeout, a verdict, or a drop without one of them corrupting a frame.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{Sink, SinkExt};
use tokio::sync::{mpsc, Notify, OwnedSemaphorePermit, Semaphore};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{debug, warn};

/// How many bytes one connection may have queued before its producers wait.
///
/// The largest legitimate single frame on this socket is an extension read at
/// the contracts' 1 MiB cap, or a 2000-line scrollback capture; a budget of four
/// of those plus a burst behind them is what one stalled browser may cost. Small
/// on purpose: an agent serves one connection per attached client, and a node
/// with twenty browsers is a node whose memory this multiplies by twenty.
pub const OUTBOUND_BYTE_BUDGET: usize = 4 * 1024 * 1024;

/// How many frames one connection may have queued before its producers wait.
///
/// The byte budget alone would let a flood of tiny frames through, and the frame
/// count alone would let four 1 MiB answers through; both are enforced. For the
/// terminal lane it is this one that binds: 64 frames of the ~5.5 KiB a base64'd
/// 4 KiB PTY chunk produces is ~350 KiB, well inside the budget, so the count is
/// what a slow terminal client reaches first.
pub const OUTBOUND_FRAME_SLOTS: usize = 64;

/// What the WebSocket frame header costs beyond the payload `Message::len`
/// reports. Charged so a queue full of small frames is priced honestly.
const FRAME_OVERHEAD: usize = 14;

/// The default stall grace: 64 terminal frames held for 15 s is a floor of
/// ~23 KiB/s, below which a peer is not slow, it is gone. Long enough that a
/// burst of backpressure is never mistaken for a verdict.
pub const DEFAULT_TERMINAL_STALL_GRACE: Duration = Duration::from_secs(15);

/// The verdicts this queue can hand a producer.
///
/// Deliberately one enum rather than one per method, the same three facts the
/// Server's `server::outbound` names: "the connection is over", "there is no
/// room and this lane does not wait", and "there was no room for long enough
/// that the peer is gone".
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

/// One frame waiting to be written, holding the claim on the byte budget that
/// lets it wait there.
pub struct QueuedFrame {
    pub message: WsMessage,
    /// This frame's share of [`OUTBOUND_BYTE_BUDGET`], released when the writer
    /// has handed the frame to the socket.
    pub budget: OwnedSemaphorePermit,
}

/// What a caller can see about one connection's outbound path (#961: "metrics /
/// logging can observe queue saturation, in-flight count, per-key queue depth").
///
/// The per-key half of that sentence lives with the keyed lane
/// (`crate::server::execution`'s `KeySnapshot`), which is the only place a key
/// exists. What is observable here is the *write* path: how much is queued, how
/// often a producer had to wait for room, and how many frames each non-waiting
/// lane refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutboundSnapshot {
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
    /// State-lane sends dropped because the queue was full.
    pub dropped_state: u64,
    /// Whether this connection's write path has been closed.
    pub closed: bool,
}

#[derive(Default)]
struct Counters {
    awaited: AtomicU64,
    stalled_terminals: AtomicU64,
    dropped_state: AtomicU64,
}

/// The sending half of one connection's outbound path.
///
/// Cloneable and shared: the reader, every lane's task, the terminal
/// forwarders, the resize reporter and the control-mode output task all hold
/// one. They are not interchangeable producers — which is why the constructor
/// does not hand out a bare `send`, and why each caller has to say which *class*
/// of message it is sending.
#[derive(Clone)]
pub struct P2pOutbound {
    tx: mpsc::Sender<QueuedFrame>,
    budget: Arc<Semaphore>,
    counters: Arc<Counters>,
    /// Signalled when the connection should stop being written to. See
    /// [`Self::close`].
    stop: Arc<Notify>,
    closed: Arc<AtomicBool>,
    terminal_grace: Duration,
}

impl P2pOutbound {
    /// A connection's outbound path, and the receiver its writer drains.
    pub fn new() -> (Self, mpsc::Receiver<QueuedFrame>) {
        Self::with_terminal_grace(DEFAULT_TERMINAL_STALL_GRACE)
    }

    /// The same, with a different stall grace — the one policy number a test
    /// needs to differ on, since waiting out the production grace is waiting out
    /// the calendar.
    pub fn with_terminal_grace(grace: Duration) -> (Self, mpsc::Receiver<QueuedFrame>) {
        let (tx, rx) = mpsc::channel(OUTBOUND_FRAME_SLOTS);
        (
            Self {
                tx,
                budget: Arc::new(Semaphore::new(OUTBOUND_BYTE_BUDGET)),
                counters: Arc::new(Counters::default()),
                stop: Arc::new(Notify::new()),
                closed: Arc::new(AtomicBool::new(false)),
                terminal_grace: grace,
            },
            rx,
        )
    }

    /// Send a frame the peer is waiting for: the answer to a request that
    /// arrived on this connection.
    ///
    /// **Waits for room; never drops.** This is the lane #961 is emphatic about
    /// — "不可丢的 command response 不允许静默 drop" — and waiting is what makes
    /// that true rather than merely likely: there is no path through this method
    /// that loses the frame. What the wait costs is bounded, and the bound is not
    /// here: a task parked in this method holds its slot in whatever lane ran it
    /// (`crate::server::execution`), so a peer that never drains eventually fills
    /// its lane and stops the connection from reading — which is the
    /// backpressure, one lane deeper.
    pub async fn send_reply(&self, msg: WsMessage) -> Result<(), OutboundError> {
        let len = msg.len();
        let (budget, waited) = self.acquire(len).await.ok_or(OutboundError::Closed)?;
        if waited {
            debug!(
                "peer-to-peer outbound: no room for a reply, waiting for the writer \
                 ({} frame(s), {} byte(s) queued)",
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
    /// that was going to finish anyway, it pins one forwarder per attached
    /// session indefinitely, and behind them the PTY readers.
    ///
    /// So this waits for room, and gives up after the stall grace. `Stalled` is
    /// the caller's cue to end the connection — see this module's docs for why
    /// that is the only honest answer left, and [`Self::close`] for how.
    pub async fn send_terminal(&self, msg: WsMessage) -> Result<(), OutboundError> {
        // The grace covers *both* bounds, which is why the whole enqueue is
        // inside the timeout rather than just the byte reservation: a terminal
        // frame can be waiting on the frame count rather than on the budget
        // (that is the bound it reaches first), and a lane that gave up on one
        // bound but not the other would park here exactly as before.
        match tokio::time::timeout(self.terminal_grace, self.enqueue_reserved(msg)).await {
            Ok(result) => result,
            Err(_) => {
                self.counters
                    .stalled_terminals
                    .fetch_add(1, Ordering::Relaxed);
                warn!(
                    "peer-to-peer outbound: terminal frame waited {:?} for room and never \
                     got it — the client has stopped draining ({} frame(s), {} byte(s) \
                     queued); ending the connection",
                    self.terminal_grace,
                    self.queued_frames(),
                    self.queued_bytes()
                );
                Err(OutboundError::Stalled)
            }
        }
    }

    /// Send a frame that reports a *level*: `terminal.resize`, and the pong that
    /// answers a ping.
    ///
    /// **Dropped when there is no room.** A resize is a level, not an edge — a
    /// client too far behind to accept one is too far behind to render the frame
    /// it changes, and it restates its own size when its viewport moves or when
    /// it re-attaches. `#961` names this class explicitly ("可合并的高频状态(如
    /// resize)允许 coalesce"). A pong rides the same lane for the same reason:
    /// the peer's next ping restates the question, and a connection that cannot
    /// take a pong has nothing left to keep alive anyway.
    pub fn try_send_state(&self, msg: WsMessage) -> Result<(), OutboundError> {
        let Some(budget) = Arc::clone(&self.budget)
            .try_acquire_many_owned(permits(charge(msg.len())))
            .ok()
        else {
            return Err(self.note_no_room());
        };
        self.tx
            .try_send(QueuedFrame {
                message: msg,
                budget,
            })
            .map_err(|e| {
                // The budget was there and the slots were not — or the writer is
                // gone. Both are "no room" for this lane's purposes.
                match e {
                    mpsc::error::TrySendError::Closed(_) => OutboundError::Closed,
                    mpsc::error::TrySendError::Full(_) => self.note_no_room(),
                }
            })
    }

    /// Stop writing to this connection and drop the socket.
    ///
    /// The verdict a stalled terminal lane delivers, and the one place a
    /// *caller* can end a connection whose socket it does not own. It is a drop
    /// rather than a `Close` frame on purpose, and for the reason
    /// `server::websocket` records for the same decision: a `Close` sent through
    /// the queue would have to wait for room in exactly the queue this peer is
    /// not draining, so the frame that says "you are not reading" would be the
    /// one that never gets written.
    ///
    /// The writer stops at its next opportunity — before its next frame, or when
    /// the frame it is writing completes — and the peer sees the socket close.
    /// The reader ends with it, because its stream ends; that is the whole
    /// teardown, and it needs no signal back to the reader.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.stop.notify_waiters();
    }

    /// Whether [`Self::close`] has been called on this connection.
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// What this connection's outbound path is doing, for logging and tests.
    pub fn snapshot(&self) -> OutboundSnapshot {
        OutboundSnapshot {
            queued_bytes: self.queued_bytes(),
            queued_frames: self.queued_frames(),
            byte_budget: OUTBOUND_BYTE_BUDGET,
            frame_slots: OUTBOUND_FRAME_SLOTS,
            awaited: self.counters.awaited.load(Ordering::Relaxed),
            stalled_terminals: self.counters.stalled_terminals.load(Ordering::Relaxed),
            dropped_state: self.counters.dropped_state.load(Ordering::Relaxed),
            closed: self.is_closed(),
        }
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

    /// Bytes charged so far: the budget minus what is left of it. A frame being
    /// written still holds its claim, so this includes it.
    fn queued_bytes(&self) -> usize {
        OUTBOUND_BYTE_BUDGET.saturating_sub(self.budget.available_permits())
    }

    fn queued_frames(&self) -> usize {
        OUTBOUND_FRAME_SLOTS.saturating_sub(self.tx.capacity())
    }

    /// Wait for room. `None` means the budget is closed, which is the queue's
    /// other spelling of "the connection is over". The flag says whether this
    /// call actually had to wait, which is the saturation signal.
    ///
    /// The `available_permits` check is an observability heuristic, not the
    /// mechanism: it can count a call that another producer was about to race
    /// for, or miss one that squeaked in. The bound itself is the semaphore.
    async fn acquire(&self, len: usize) -> Option<(OwnedSemaphorePermit, bool)> {
        let waited = self.budget.available_permits() < charge(len);
        if waited {
            self.counters.awaited.fetch_add(1, Ordering::Relaxed);
        }
        Arc::clone(&self.budget)
            .acquire_many_owned(permits(charge(len)))
            .await
            .ok()
            .map(|permit| (permit, waited))
    }

    fn note_no_room(&self) -> OutboundError {
        self.counters.dropped_state.fetch_add(1, Ordering::Relaxed);
        debug!(
            "peer-to-peer outbound: no room for a state frame ({} byte(s) queued of {}); \
             dropped — the peer restates it",
            self.queued_bytes(),
            OUTBOUND_BYTE_BUDGET
        );
        OutboundError::Saturated
    }
}

/// What one frame is charged against the connection's byte budget.
///
/// A single frame larger than the whole budget is charged the whole budget
/// rather than refused: the contracts cap these at 1 MiB and a refusal would
/// turn "this answer is big" into "this answer cannot be sent". Charging it
/// everything means at most one such frame is ever queued, and the next producer
/// waits for it to be written.
fn charge(len: usize) -> usize {
    (len + FRAME_OVERHEAD).clamp(1, OUTBOUND_BYTE_BUDGET)
}

/// A byte charge as the permit count a `Semaphore` takes.
fn permits(bytes: usize) -> u32 {
    u32::try_from(bytes).unwrap_or(u32::MAX)
}

/// The only thing that touches the socket: drain the queue onto it, until the
/// connection is closed or the socket fails.
///
/// Dropping this task drops the sink, which is what closes the peer's socket —
/// so "the writer stopped" and "the connection ended" are the same event, and
/// nothing else has to be told.
///
/// Generic over the sink rather than naming the connection's own type: what this
/// function implements is a *policy* about a queue, and the socket it drains it
/// onto is the caller's business. (`websocket.rs` splits a `TcpOrTls` stream and
/// hands the write half here; that enum does not have to be visible for this to
/// work, and it is not.)
pub async fn run_writer<S>(mut sink: S, mut rx: mpsc::Receiver<QueuedFrame>, outbound: P2pOutbound)
where
    S: Sink<WsMessage> + Unpin,
{
    loop {
        if outbound.is_closed() {
            break;
        }
        // Registered before the check above is *repeated* below, so a `close`
        // that lands between the two is not a lost wake-up.
        let stop = outbound.stop.notified();
        tokio::pin!(stop);
        stop.as_mut().enable();

        if outbound.is_closed() {
            break;
        }

        tokio::select! {
            _ = &mut stop => break,
            frame = rx.recv() => {
                let Some(frame) = frame else { break };
                // Split so the budget claim is released *after* the write, not
                // before it: `budget` stays alive across the await and drops at
                // the end of the arm.
                let QueuedFrame { message, budget } = frame;
                let written = sink.send(message).await;
                drop(budget);
                if written.is_err() {
                    // The peer is gone. Nothing to say to it, and the reading
                    // half finds out when its own stream ends.
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reply lane's whole reason to exist: a send that finds the queue full
    /// waits, and the frame is there when the consumer catches up. If this ever
    /// returns `Err` or drops the frame, #961's "must not be silently dropped"
    /// is violated for the agent's own answers.
    #[tokio::test]
    async fn a_reply_waits_for_room_rather_than_being_dropped() {
        let (outbound, mut rx) = P2pOutbound::with_terminal_grace(Duration::from_millis(50));

        // A frame sized so each one takes an equal share of the budget: filling
        // with these reaches both bounds at once.
        let share = OUTBOUND_BYTE_BUDGET / OUTBOUND_FRAME_SLOTS - FRAME_OVERHEAD;
        let frame = WsMessage::Text("x".repeat(share));
        let mut queued = 0;
        while outbound.try_send_state(frame.clone()).is_ok() {
            queued += 1;
            assert!(
                queued <= OUTBOUND_FRAME_SLOTS,
                "the frame bound never fired"
            );
        }
        assert_eq!(queued, OUTBOUND_FRAME_SLOTS);
        assert_eq!(outbound.snapshot().queued_bytes, OUTBOUND_BYTE_BUDGET);

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
        assert_eq!(
            outbound.snapshot().dropped_state,
            1,
            "the one state frame that found no room was dropped; the reply that found \
             no room was not — it waited and was delivered"
        );
    }

    /// The state lane is the one that drops — and says so in the counters.
    #[tokio::test]
    async fn a_state_frame_is_dropped_when_the_queue_is_full() {
        let (outbound, _rx) = P2pOutbound::new();
        let frame = WsMessage::Text("y".repeat(OUTBOUND_BYTE_BUDGET));

        assert_eq!(outbound.try_send_state(frame.clone()), Ok(()));
        assert_eq!(
            outbound.try_send_state(frame),
            Err(OutboundError::Saturated),
            "the second frame cannot fit in a budget already charged in full"
        );
        let snapshot = outbound.snapshot();
        assert_eq!(snapshot.dropped_state, 1);
        assert_eq!(snapshot.queued_frames, 1);
        assert_eq!(snapshot.queued_bytes, OUTBOUND_BYTE_BUDGET);
    }

    /// The terminal lane waits like a reply, and ends at the grace with a
    /// verdict rather than an unbounded park.
    #[tokio::test]
    async fn a_terminal_frame_that_never_gets_room_stalls() {
        let (outbound, _rx) = P2pOutbound::with_terminal_grace(Duration::from_millis(50));
        let frame = WsMessage::Text("t".repeat(OUTBOUND_BYTE_BUDGET));
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

    /// A closed writer is reported as such on every lane, so a lane task can
    /// tell "this connection is over" from "this connection is full".
    #[tokio::test]
    async fn a_gone_writer_is_closed_on_every_lane() {
        let (outbound, rx) = P2pOutbound::new();
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
            outbound.try_send_state(WsMessage::Text("c".into())),
            Err(OutboundError::Closed)
        );
    }

    /// `close` is a fact every handle can read, which is what a caller checks
    /// before deciding whether a failed send is worth retrying.
    #[tokio::test]
    async fn close_is_visible_to_every_handle() {
        let (outbound, _rx) = P2pOutbound::new();
        let clone = outbound.clone();
        assert!(!clone.is_closed());
        outbound.close();
        assert!(clone.is_closed());
        assert!(outbound.snapshot().closed);
    }

    /// A frame bigger than the budget is not refused: it takes the whole budget,
    /// so it can still be sent, and the next producer waits for it.
    #[tokio::test]
    async fn a_frame_larger_than_the_budget_holds_all_of_it() {
        assert_eq!(charge(OUTBOUND_BYTE_BUDGET * 2), OUTBOUND_BYTE_BUDGET);
        assert_eq!(charge(0), FRAME_OVERHEAD);

        let (outbound, mut rx) = P2pOutbound::new();
        let huge = WsMessage::Text("h".repeat(OUTBOUND_BYTE_BUDGET * 2));
        assert_eq!(outbound.send_reply(huge.clone()).await, Ok(()));
        assert_eq!(outbound.snapshot().queued_bytes, OUTBOUND_BYTE_BUDGET);

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
        let (outbound, mut rx) = P2pOutbound::new();
        assert_eq!(
            outbound.send_reply(WsMessage::Text("q".into())).await,
            Ok(())
        );
        assert_eq!(outbound.snapshot().queued_bytes, charge(1));

        let frame = rx.recv().await.expect("the frame was queued");
        assert_eq!(
            outbound.snapshot().queued_bytes,
            charge(1),
            "the frame is still holding its claim while it is being written"
        );
        drop(frame);
        assert_eq!(outbound.snapshot().queued_bytes, 0);
        assert_eq!(outbound.snapshot().queued_frames, 0);
    }
}
