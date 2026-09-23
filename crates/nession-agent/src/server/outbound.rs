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
//! ## The queue itself is shared
//!
//! The queue, its two bounds, the three verdicts and the byte arithmetic are the
//! same mechanism the Server's write path runs on, so they are one
//! implementation rather than two: [`nession_runtime::outbound`]. What stays
//! here is what is this socket's answer rather than the mechanism's — which lanes
//! exist, what each does at the bound, the counters that record it, and
//! [`P2pOutbound::close`].
//!
//! ## Why the terminal lane ends the connection rather than dropping
//!
//! Terminal bytes cannot be dropped — the emulator and the session would
//! disagree about the screen — and they cannot be buffered without bound, which
//! is the queue this replaces. What is left is the honest verdict: a client that
//! has not drained `OUTBOUND_FRAME_SLOTS` terminal frames over
//! [`DEFAULT_TERMINAL_STALL_GRACE`] is not attached in any useful sense. The
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
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::debug;

use nession_runtime::outbound::{Limits, Outbound};

/// The one frame type and the three verdicts, re-exported so a call site names
/// this runtime's outbound path rather than the shared crate's.
pub use nession_runtime::outbound::{OutboundError, QueuedFrame};

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

/// The default stall grace: 64 terminal frames held for 15 s is a floor of
/// ~23 KiB/s, below which a peer is not slow, it is gone. Long enough that a
/// burst of backpressure is never mistaken for a verdict.
pub const DEFAULT_TERMINAL_STALL_GRACE: Duration = Duration::from_secs(15);

/// The name this runtime's outbound path puts on its own log lines.
///
/// This agent runs two independent connections, and the Server's write path is a
/// third: see `nession_runtime::outbound`'s module docs.
const NAME: &str = "peer-to-peer outbound";

/// What a caller can see about one connection's outbound path (#961: "metrics /
/// logging can observe queue saturation, in-flight count, per-key queue depth").
///
/// The per-key half of that sentence lives with the keyed lane
/// (`nession_runtime::lane`'s `KeySnapshot`), which is the only place a key
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

/// The sending half of one connection's outbound path.
///
/// Cloneable and shared: the reader, every lane's task, the terminal
/// forwarders, the resize reporter and the control-mode output task all hold
/// one. They are not interchangeable producers — which is why the constructor
/// does not hand out a bare `send`, and why each caller has to say which *class*
/// of message it is sending.
#[derive(Clone)]
pub struct P2pOutbound {
    queue: Outbound,
    counters: Arc<Counters>,
    /// Signalled when the connection should stop being written to. See
    /// [`Self::close`].
    stop: Arc<Notify>,
    closed: Arc<AtomicBool>,
}

#[derive(Default)]
struct Counters {
    dropped_state: AtomicU64,
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
        let (queue, rx) = Outbound::new(
            NAME,
            Limits {
                bytes: OUTBOUND_BYTE_BUDGET,
                frames: OUTBOUND_FRAME_SLOTS,
            },
            grace,
        );
        (
            Self {
                queue,
                counters: Arc::new(Counters::default()),
                stop: Arc::new(Notify::new()),
                closed: Arc::new(AtomicBool::new(false)),
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
    /// (`nession_runtime::lane`), so a peer that never drains eventually fills
    /// its lane and stops the connection from reading — which is the
    /// backpressure, one lane deeper.
    pub async fn send_reply(&self, msg: WsMessage) -> Result<(), OutboundError> {
        self.queue.send_reply(msg).await
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
        self.queue.send_terminal(msg).await
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
        self.queue.try_send(msg).map_err(|e| match e {
            OutboundError::Saturated => self.note_no_room(),
            e => e,
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
    /// It lives here rather than in the shared queue because it is this socket's
    /// policy: the Server has no such caller, and its connection ends by dropping
    /// the socket (`#961-F`).
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
        let queue = self.queue.snapshot();
        OutboundSnapshot {
            queued_bytes: queue.queued_bytes,
            queued_frames: queue.queued_frames,
            byte_budget: queue.byte_budget,
            frame_slots: queue.frame_slots,
            awaited: queue.awaited,
            stalled_terminals: queue.stalled_terminals,
            dropped_state: self.counters.dropped_state.load(Ordering::Relaxed),
            closed: self.is_closed(),
        }
    }

    fn note_no_room(&self) -> OutboundError {
        self.counters.dropped_state.fetch_add(1, Ordering::Relaxed);
        debug!(
            "{}: no room for a state frame ({} byte(s) queued of {}); \
             dropped — the peer restates it",
            NAME,
            self.queue.queued_bytes(),
            OUTBOUND_BYTE_BUDGET
        );
        OutboundError::Saturated
    }
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
///
/// Not shared with the Server's writer, and deliberately: the Server's is a
/// `select!` against a ping ticker it has to keep writing through a saturated
/// business queue, which is a different job. What the two share is the queue
/// ([`nession_runtime::outbound`]), and that is the part that had to be one
/// thing.
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

    /// The sibling of `a_state_frame_is_dropped_when_the_queue_is_full` in the
    /// Server's copy, and the half that is this runtime's: the state lane, the
    /// counter that says it dropped, and whether the connection was closed.
    ///
    /// The mechanism — the two bounds, the three verdicts, the oversized frame,
    /// the budget released by the writer — is tested where it lives
    /// (`nession_runtime::outbound`).
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
}
