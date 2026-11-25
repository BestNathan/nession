//! One peer-to-peer connection's classified outbound path (`#4434`).
//!
//! The mechanism — three classes with reserved capacity, a bounded fair
//! scheduler, exact accounting, process aggregates and the write deadline — is
//! [`nession_runtime::outbound`] and [`nession_runtime::lifecycle`]. This module
//! is this socket's *policy*: which producer's frame is which class, and what a
//! refusal means here.
//!
//! | class | what is on it | at the bound |
//! |---|---|---|
//! | [`P2pOutbound::send_reply`] | an answer to a request the peer made | **wait** — it is never dropped |
//! | [`P2pOutbound::send_attach_response`] | the bootstrap / atomic history prefix an attach asked for | **wait, then end the connection** — ordered with the attach reply |
//! | [`P2pOutbound::send_terminal`] | `terminal.output` — a live PTY chunk | **wait, then end the connection** |
//! | [`P2pOutbound::try_send_state`] | `terminal.resize`, a pong | **drop** — a level, and the peer restates it |
//!
//! ## Reserved capacity
//!
//! The previous queue shared one 4 MiB / 64-frame bound between all three
//! lanes, so a scrollback prefill could occupy the byte budget and make the
//! next resize or pong unsendable on a socket that was not unhealthy. The split
//! here is:
//!
//! | class | bytes | frames |
//! |---|---|---|
//! | control | 512 KiB | 16 |
//! | response | 2 MiB | 24 |
//! | stream | 1.5 MiB | 24 |
//!
//! The totals still add up to [`OUTBOUND_BYTE_BUDGET`] / [`OUTBOUND_FRAME_SLOTS`].
//! The stream class is deliberately above the 512 KiB scrollback ceiling's
//! base64 expansion (~683 KiB), so a legitimate bootstrap is never refused as
//! oversized.
//!
//! ## Why the terminal lane ends the connection rather than dropping
//!
//! Terminal bytes cannot be dropped — the emulator and the session would
//! disagree about the screen — and they cannot be buffered without bound. A
//! client that has not drained [`STREAM_FRAME_SLOTS`] frames over
//! [`DEFAULT_TERMINAL_STALL_GRACE`] is not attached in any useful sense. The
//! caller ends the connection, and a client that was merely asleep re-attaches
//! and is handed a redrawn screen.
//!
//! ## The writer and the read half
//!
//! The writer is the only thing that touches the socket, so every lane above can
//! have a timeout, a verdict or a drop without one of them corrupting a frame.
//! It now runs each write under a finite deadline and settles the shared
//! [`ConnectionLifecycle`] when one fails; the read loop races its stream
//! against that settlement, which is what makes a stalled write end the reader
//! too (#2179 was the half-open version of this).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::Sink;
use nession_runtime::frame::WsFrame;
use nession_runtime::lifecycle::{CloseReason, ConnectionLifecycle, WriteFailure, WriteTimeouts};
use nession_runtime::outbound::{
    ClassLimits, ClassifiedLimits, FrameClass, OutboundReceiver, SubmitOutcome, WaitPolicy,
};
use tracing::debug;

use nession_runtime::outbound::Outbound;

use crate::stream::OutboundStreamClass;

/// The one frame type and the three verdicts, re-exported so a call site names
/// this runtime's outbound path rather than the shared crate's.
pub use nession_runtime::outbound::{OutboundError, QueuedFrame};

/// The total bytes one connection may have outstanding.
pub const OUTBOUND_BYTE_BUDGET: usize = 4 * 1024 * 1024;
/// The total frames one connection may have outstanding.
pub const OUTBOUND_FRAME_SLOTS: usize = 64;

/// Control's reserved byte budget: resize levels, pongs, close.
pub const CONTROL_BYTE_BUDGET: usize = 512 * 1024;
pub const CONTROL_FRAME_SLOTS: usize = 16;
/// Response's byte budget: answers the peer is waiting for.
pub const RESPONSE_BYTE_BUDGET: usize = 2 * 1024 * 1024;
pub const RESPONSE_FRAME_SLOTS: usize = 24;
/// Stream's byte budget: terminal chunks and scrollback prefill.
pub const STREAM_BYTE_BUDGET: usize = 1536 * 1024;
pub const STREAM_FRAME_SLOTS: usize = 24;

/// This socket's class bounds.
pub const P2P_CLASS_LIMITS: ClassifiedLimits = ClassifiedLimits {
    control: ClassLimits {
        bytes: CONTROL_BYTE_BUDGET,
        frames: CONTROL_FRAME_SLOTS,
    },
    response: ClassLimits {
        bytes: RESPONSE_BYTE_BUDGET,
        frames: RESPONSE_FRAME_SLOTS,
    },
    stream: ClassLimits {
        bytes: STREAM_BYTE_BUDGET,
        frames: STREAM_FRAME_SLOTS,
    },
};

const _: () = assert!(
    CONTROL_BYTE_BUDGET + RESPONSE_BYTE_BUDGET + STREAM_BYTE_BUDGET == OUTBOUND_BYTE_BUDGET
);
const _: () = assert!(
    CONTROL_FRAME_SLOTS + RESPONSE_FRAME_SLOTS + STREAM_FRAME_SLOTS == OUTBOUND_FRAME_SLOTS
);

/// The default stall grace: 24 stream frames held for 15 s is a floor of
/// ~20 KiB/s, below which a peer is not slow, it is gone.
pub const DEFAULT_TERMINAL_STALL_GRACE: Duration = Duration::from_secs(15);

/// The name this runtime's outbound path puts on its own log lines.
const NAME: &str = "peer-to-peer outbound";

/// What a caller can see about one connection's outbound path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutboundSnapshot {
    pub queued_bytes: usize,
    pub queued_frames: usize,
    pub in_flight_frames: usize,
    pub byte_budget: usize,
    pub frame_slots: usize,
    pub control_bytes: usize,
    pub control_frames: usize,
    pub response_bytes: usize,
    pub response_frames: usize,
    pub stream_bytes: usize,
    pub stream_frames: usize,
    pub awaited: u64,
    pub stalled_terminals: u64,
    /// State-lane sends dropped because the queue was full.
    pub dropped_state: u64,
    /// Frames refused because they exceeded their class's supported maximum.
    pub too_large: u64,
    /// Whether this connection has been settled.
    pub closed: bool,
    /// The settlement verdict, once there is one.
    pub close_reason: Option<CloseReason>,
    /// Process-wide aggregate accounting.
    pub process: nession_runtime::outbound::ProcessSnapshot,
}

/// The sending half of one connection's outbound path.
#[derive(Clone)]
pub struct P2pOutbound {
    queue: Outbound,
    counters: Arc<Counters>,
    lifecycle: Arc<ConnectionLifecycle>,
    timeouts: WriteTimeouts,
}

#[derive(Default)]
struct Counters {
    dropped_state: AtomicU64,
}

impl P2pOutbound {
    /// A connection's outbound path, and the receiver its writer drains.
    pub fn new() -> (Self, OutboundReceiver) {
        Self::with_terminal_grace(DEFAULT_TERMINAL_STALL_GRACE)
    }

    /// The same, with a different stall grace.
    pub fn with_terminal_grace(grace: Duration) -> (Self, OutboundReceiver) {
        Self::with_lifecycle(grace, ConnectionLifecycle::new(1))
    }

    /// The same, with an explicit lifecycle (a connection generation that the
    /// broker and the relay can fence against).
    pub fn with_lifecycle(
        grace: Duration,
        lifecycle: Arc<ConnectionLifecycle>,
    ) -> (Self, OutboundReceiver) {
        let (queue, rx) = Outbound::new(NAME, P2P_CLASS_LIMITS, grace);
        (
            Self {
                queue,
                counters: Arc::new(Counters::default()),
                lifecycle,
                timeouts: WriteTimeouts::default(),
            },
            rx,
        )
    }

    /// Send a frame the peer is waiting for. Waits for room until the
    /// connection closes; never silently drops.
    pub async fn send_reply(&self, msg: WsFrame) -> Result<(), OutboundError> {
        self.queue.send_reply(msg).await
    }

    /// Forward one chunk of terminal output. Waits for room up to the stall
    /// grace, then reports `Stalled`.
    pub async fn send_terminal(&self, msg: WsFrame) -> Result<(), OutboundError> {
        self.queue.send_terminal(msg).await
    }

    /// Send the one-off history a client asked for on attach.
    ///
    /// The bootstrap (and the atomic output prefix that precedes it) is a
    /// **response to the attach**, not live stream data: it must be written
    /// before the attach's `ok` reply (`#321`), and the response class is the
    /// only class that shares the attach reply's FIFO. Putting it on the stream
    /// class lets the scheduler's response protection overtake it, which is the
    /// regression this method exists to prevent.
    ///
    /// It keeps the terminal stall policy — a finite wait — because a client
    /// that cannot drain its snapshot will not drain the session behind it.
    pub async fn send_attach_response(&self, msg: WsFrame) -> Result<(), OutboundError> {
        self.send_response_class(msg).await
    }

    /// Send a terminal-input acknowledgement before its request's `ok` reply.
    ///
    /// The ACK is the frame a client's input cursor advances on. It shares its
    /// exchange with the input request's reply, so it must stay in the same
    /// FIFO: the response class's protection would otherwise overtake it and a
    /// client reading in order would see the *previous* cursor. Same class as
    /// the reply, still non-dropping and still bounded by the stall grace.
    pub async fn send_input_ack(&self, msg: WsFrame) -> Result<(), OutboundError> {
        self.send_response_class(msg).await
    }

    /// Submit on the non-dropping response class with the terminal stall grace.
    async fn send_response_class(&self, msg: WsFrame) -> Result<(), OutboundError> {
        self.queue
            .submit(
                FrameClass::Response,
                self.queue.current_generation(),
                msg,
                WaitPolicy::Finite(DEFAULT_TERMINAL_STALL_GRACE),
            )
            .await
            .into_result()
    }

    /// Send a frame that reports a *level*: `terminal.resize`, a pong.
    ///
    /// **Dropped when there is no room.** A resize is a level, not an edge, and
    /// the peer restates it. `#961` names this class explicitly.
    pub fn try_send_state(&self, msg: WsFrame) -> Result<(), OutboundError> {
        match self.queue.try_submit(FrameClass::Control, msg) {
            SubmitOutcome::Accepted => Ok(()),
            SubmitOutcome::Refused(OutboundError::Saturated) => {
                self.counters.dropped_state.fetch_add(1, Ordering::Relaxed);
                debug!(
                    "{}: no room for a state frame ({} byte(s) outstanding of {}); \
                     dropped — the peer restates it",
                    NAME,
                    self.queue.queued_bytes(),
                    CONTROL_BYTE_BUDGET
                );
                Err(OutboundError::Saturated)
            }
            SubmitOutcome::Refused(error) => Err(error),
            SubmitOutcome::Closed => Err(OutboundError::Closed),
        }
    }

    /// Submit one classified frame with an explicit generation and wait policy.
    /// The adapter's test and diagnostic seam.
    pub async fn submit_classified(
        &self,
        class: FrameClass,
        generation: u64,
        msg: WsFrame,
        wait: WaitPolicy,
    ) -> SubmitOutcome {
        self.queue.submit(class, generation, msg, wait).await
    }

    pub fn current_generation(&self) -> u64 {
        self.queue.current_generation()
    }

    /// Send one frame on the lane its **stream class** requires (#4435).
    ///
    /// This is the class-aware seam over the lanes above, not a fourth policy:
    /// each arm delegates to the same method a caller used to name directly.
    /// Naming the class instead of the mechanic is what keeps a wire's loss
    /// policy with its stream owner rather than at every call site.
    pub async fn send_for_class(
        &self,
        class: OutboundStreamClass,
        msg: WsFrame,
    ) -> Result<(), OutboundError> {
        match class {
            OutboundStreamClass::OrderedOutput => self.send_terminal(msg).await,
            // Stream bookkeeping shares the response class's FIFO with the
            // reply of the exchange it belongs to: an input ACK that loses
            // that order leaves the client reading the previous cursor.
            OutboundStreamClass::FlowControl => self.send_input_ack(msg).await,
            // Attach history is a response to the attach, not live output; it
            // must be written before the attach `ok` (#321).
            OutboundStreamClass::AttachHistory => self.send_attach_response(msg).await,
            OutboundStreamClass::LatestState => self.try_send_state(msg),
            OutboundStreamClass::Reply => self.send_reply(msg).await,
        }
    }

    /// Stop writing to this connection and drop the socket.
    ///
    /// A caller's way to end a connection whose socket it does not own. It is a
    /// drop rather than a queued `Close`: a close frame would wait in exactly
    /// the queue the peer is not draining. The writer stops at its next
    /// opportunity and the peer sees the socket close; the read loop races its
    /// stream against [`Self::wait_closed`], so it ends too.
    pub fn close(&self) {
        self.queue.close();
        self.lifecycle.settle(CloseReason::LocalClose);
    }

    /// Resolve once the connection has been settled, including when it already
    /// was.
    pub async fn wait_closed(&self) {
        self.lifecycle.wait_cancelled().await;
    }

    /// Whether this connection has been settled.
    pub fn is_closed(&self) -> bool {
        self.lifecycle.is_settled()
    }

    pub fn lifecycle(&self) -> &Arc<ConnectionLifecycle> {
        &self.lifecycle
    }

    /// What this connection's outbound path is doing, for logging and tests.
    pub fn snapshot(&self) -> OutboundSnapshot {
        let queue = self.queue.snapshot();
        OutboundSnapshot {
            queued_bytes: queue.queued_bytes,
            queued_frames: queue.queued_frames,
            in_flight_frames: queue.in_flight_frames,
            byte_budget: queue.byte_budget,
            frame_slots: queue.frame_slots,
            control_bytes: queue.control_bytes,
            control_frames: queue.control_frames,
            response_bytes: queue.response_bytes,
            response_frames: queue.response_frames,
            stream_bytes: queue.stream_bytes,
            stream_frames: queue.stream_frames,
            awaited: queue.awaited,
            stalled_terminals: queue.stalled_terminals,
            dropped_state: self.counters.dropped_state.load(Ordering::Relaxed),
            too_large: queue.too_large,
            closed: self.is_closed(),
            close_reason: self.lifecycle.reason(),
            process: queue.process,
        }
    }

    fn settle_write(&self, failure: &WriteFailure) {
        self.lifecycle.settle(match failure {
            WriteFailure::Timeout => CloseReason::WriteTimeout,
            WriteFailure::Sink(_) => CloseReason::WriteError,
        });
    }
}

/// The only thing that touches the socket: drain the scheduler onto it until
/// the connection is settled or the socket fails.
///
/// Dropping this task drops the sink, which is what closes the peer's socket, so
/// "the writer stopped" and "the connection ended" are the same event.
pub async fn run_writer<S>(mut sink: S, mut rx: OutboundReceiver, outbound: P2pOutbound)
where
    S: Sink<WsFrame> + Unpin,
    S::Error: std::fmt::Display,
{
    let timeouts = outbound.timeouts;
    loop {
        if outbound.is_closed() {
            break;
        }
        tokio::select! {
            _ = outbound.lifecycle.wait_cancelled() => break,
            frame = rx.recv() => {
                let Some(frame) = frame else { break };
                // Every claim — class bytes, class frame slot and the process
                // charge — stays alive across the await, so an in-flight frame
                // is visible to both bounds (#4434).
                let (message, charge) = frame.into_write_parts();
                let written =
                    nession_runtime::lifecycle::write_frame(&mut sink, message, timeouts.write)
                        .await;
                drop(charge);
                if let Err(failure) = written {
                    // The peer is gone or unhealthy. Record why, and let the
                    // read loop's cancellation race end that half.
                    outbound.settle_write(&failure);
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fills_control() -> WsFrame {
        WsFrame::Text("y".repeat(CONTROL_BYTE_BUDGET - nession_runtime::outbound::FRAME_OVERHEAD))
    }

    /// The state lane is this runtime's policy: dropped at its own class bound,
    /// counted, and independent of the response/stream budgets.
    #[tokio::test]
    async fn a_state_frame_is_dropped_when_the_control_class_is_full() {
        let (outbound, _rx) = P2pOutbound::new();

        assert_eq!(outbound.try_send_state(fills_control()), Ok(()));
        assert_eq!(
            outbound.try_send_state(fills_control()),
            Err(OutboundError::Saturated)
        );
        let snapshot = outbound.snapshot();
        assert_eq!(snapshot.dropped_state, 1);
        assert_eq!(snapshot.control_frames, 1);
        assert_eq!(snapshot.control_bytes, CONTROL_BYTE_BUDGET);
        assert_eq!(snapshot.response_bytes, 0);
        assert_eq!(snapshot.stream_bytes, 0);
    }

    /// The class-aware seam must not invent a fourth lane: each stream class
    /// lands on exactly the existing mechanic it names.
    #[tokio::test]
    async fn class_aware_send_uses_the_existing_lanes() {
        let (outbound, _rx) = P2pOutbound::new();

        outbound
            .send_for_class(
                OutboundStreamClass::Reply,
                WsFrame::Text("reply".to_owned()),
            )
            .await
            .expect("a reply is queued");
        outbound
            .send_for_class(
                OutboundStreamClass::OrderedOutput,
                WsFrame::Text("output".to_owned()),
            )
            .await
            .expect("ordered output is queued");
        outbound
            .send_for_class(
                OutboundStreamClass::FlowControl,
                WsFrame::Text("ack".to_owned()),
            )
            .await
            .expect("stream bookkeeping is queued");
        outbound
            .send_for_class(
                OutboundStreamClass::AttachHistory,
                WsFrame::Text("history".to_owned()),
            )
            .await
            .expect("attach history is queued");
        assert_eq!(outbound.snapshot().queued_frames, 4);

        // Latest-state is the droppable lane. On an otherwise empty control
        // class the first maximal level fits exactly, and the second must
        // report saturation exactly as `try_send_state` does.
        let (levels, _levels_rx) = P2pOutbound::new();
        let full = fills_control();
        levels
            .send_for_class(OutboundStreamClass::LatestState, full.clone())
            .await
            .expect("the first level fits");
        assert_eq!(
            levels
                .send_for_class(OutboundStreamClass::LatestState, full)
                .await
                .expect_err("the lane is full"),
            OutboundError::Saturated
        );
        assert_eq!(levels.snapshot().dropped_state, 1);
    }

    /// A frame beyond the class maximum is refused, not clamped.
    #[tokio::test]
    async fn an_oversized_state_frame_is_refused() {
        let (outbound, _rx) = P2pOutbound::new();
        let error = outbound
            .try_send_state(WsFrame::Text("x".repeat(CONTROL_BYTE_BUDGET)))
            .expect_err("a frame beyond the control maximum cannot be charged as if smaller");
        assert!(matches!(error, OutboundError::TooLarge { .. }));
        assert_eq!(outbound.snapshot().too_large, 1);
    }

    /// `close` is a fact every handle can read, and it carries a reason.
    #[tokio::test]
    async fn close_is_visible_to_every_handle_and_carries_a_reason() {
        let (outbound, _rx) = P2pOutbound::new();
        let clone = outbound.clone();
        assert!(!clone.is_closed());
        outbound.close();
        assert!(clone.is_closed());
        assert_eq!(clone.lifecycle().reason(), Some(CloseReason::LocalClose));
        assert!(outbound.snapshot().closed);
    }

    /// `close` has to be observable by a task that is *waiting on something
    /// else* (#2179), including when it arrived before the waiter polled.
    #[tokio::test]
    async fn wait_closed_resolves_when_close_arrives_and_when_it_already_did() {
        let (outbound, _rx) = P2pOutbound::new();
        assert!(
            tokio::time::timeout(Duration::from_millis(50), outbound.wait_closed())
                .await
                .is_err(),
            "a live connection must not report itself closed"
        );

        let waiter = outbound.clone();
        let waiting = tokio::spawn(async move { waiter.wait_closed().await });
        outbound.close();
        tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .expect("close must wake a parked reader")
            .expect("the waiter must not panic");

        tokio::time::timeout(Duration::from_millis(50), outbound.wait_closed())
            .await
            .expect("an already-closed outbound must resolve immediately");
    }
}
