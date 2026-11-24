//! One Server connection's classified outbound path (`#4434`).
//!
//! The mechanism — three classes with reserved capacity, a bounded fair
//! scheduler, exact accounting and process aggregates — is
//! [`nession_runtime::outbound`]. This module is the Server's *policy*: which
//! producer's frame is which class, and what a refusal means at each call site.
//!
//! | class | what is on it | at the bound |
//! |---|---|---|
//! | [`WsMessageSender::send_reply`] | an answer to a request the peer made | **wait** — it is never dropped |
//! | [`WsMessageSender::try_send_command`] | a command the Server sends an agent | **fail the request** — the caller answers its own client |
//! | [`WsMessageSender::try_send_broadcast`] | registry state pushes, `terminal.resize`, pings | **drop** — a later push restates the state |
//! | [`WsMessageSender::send_terminal`] | relayed terminal bytes | **wait, then close the peer** |
//!
//! ## Reserved capacity, not one shared budget
//!
//! The queue this replaces had one 8 MiB / 64-frame bound for every class. A
//! single large reply could then be the whole byte budget, and the next
//! `server.agents.changed`, a command to an agent, or a keepalive would find
//! "no room" on a connection that was not actually unhealthy. Here the byte and
//! frame budgets are split and reserved:
//!
//! | class | bytes | frames |
//! |---|---|---|
//! | control | 1 MiB | 16 |
//! | response | 4 MiB | 24 |
//! | stream | 3 MiB | 24 |
//!
//! The totals still add up to the documented [`OUTBOUND_BYTE_BUDGET`] and
//! [`OUTBOUND_FRAME_SLOTS`], so a test or operator that reasons about the
//! connection's cost sees the same ceiling; what changed is that one class can
//! no longer spend another's share.
//!
//! ## Supported maximum frame size
//!
//! A class's byte budget *is* its supported maximum frame size. A larger frame
//! is refused with [`OutboundError::TooLarge`] rather than charged as though it
//! were smaller — the clamp that used to make a 20 MiB allocation look like 8 MiB
//! of accounting is gone. The wire contracts keep legitimate frames below these
//! numbers (a file read is capped at 1 MiB; a 2000-line capture is a few hundred
//! KiB), and a producer that needs more must chunk under its own contract.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use nession_runtime::frame::WsFrame;
use nession_runtime::outbound::{
    ClassLimits, ClassifiedLimits, FrameClass, SubmitOutcome, WaitPolicy,
};
use tracing::{debug, warn};

use nession_runtime::outbound::Outbound;

pub use nession_runtime::outbound::{
    charge, OutboundError, OutboundReceiver, ProcessSnapshot, QueueSnapshot, QueuedFrame,
    SchedulerConfig,
};

/// The total bytes one connection may have outstanding (`#4434`).
///
/// The split below adds up to this: what one stalled peer may cost the process
/// is unchanged; what changed is that the classes no longer compete for it.
pub const OUTBOUND_BYTE_BUDGET: usize = 8 * 1024 * 1024;

/// The total frames one connection may have outstanding.
pub const OUTBOUND_FRAME_SLOTS: usize = 64;

/// Control's reserved byte budget: keepalives, state pushes, agent commands.
pub const CONTROL_BYTE_BUDGET: usize = 1024 * 1024;
/// Control's reserved frame slots.
pub const CONTROL_FRAME_SLOTS: usize = 16;
/// Response's byte budget: answers the peer is waiting for.
pub const RESPONSE_BYTE_BUDGET: usize = 4 * 1024 * 1024;
/// Response's frame slots.
pub const RESPONSE_FRAME_SLOTS: usize = 24;
/// Stream's byte budget: relayed terminal bytes.
pub const STREAM_BYTE_BUDGET: usize = 3 * 1024 * 1024;
/// Stream's frame slots.
pub const STREAM_FRAME_SLOTS: usize = 24;

/// The Server's class bounds.
pub const SERVER_CLASS_LIMITS: ClassifiedLimits = ClassifiedLimits {
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

/// The name this runtime's outbound path puts on its own log lines.
const NAME: &str = "outbound";

/// What a caller can see about one connection's outbound path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutboundSnapshot {
    /// Bytes outstanding: queued, reserved or in flight.
    pub queued_bytes: usize,
    /// Frames outstanding: queued, reserved or in flight.
    pub queued_frames: usize,
    /// Frames the writer has popped and not yet released.
    pub in_flight_frames: usize,
    /// The summed class bounds `queued_*` move within.
    pub byte_budget: usize,
    pub frame_slots: usize,
    pub control_bytes: usize,
    pub control_frames: usize,
    pub response_bytes: usize,
    pub response_frames: usize,
    pub stream_bytes: usize,
    pub stream_frames: usize,
    /// Reply/stream sends that found the queue full and waited for room.
    pub awaited: u64,
    /// Broadcast-lane sends dropped because the queue was full.
    pub dropped_broadcasts: u64,
    /// Command-lane sends that failed because the queue was full.
    pub undelivered_commands: u64,
    /// Stream-lane sends that hit the stall grace.
    pub stalled_terminals: u64,
    /// Frames refused because they exceeded their class's supported maximum.
    pub too_large: u64,
    /// Submissions refused for a superseded ownership generation.
    pub stale_generation: u64,
    /// Process-wide aggregate accounting.
    pub process: ProcessSnapshot,
}

#[derive(Default)]
struct Counters {
    dropped_broadcasts: AtomicU64,
    undelivered_commands: AtomicU64,
}

/// The sending half of one connection's outbound path.
#[derive(Clone)]
pub struct WsMessageSender {
    queue: Outbound,
    counters: Arc<Counters>,
}

impl WsMessageSender {
    /// A connection's outbound path with the standard bounds and stall grace.
    pub fn new() -> (Self, OutboundReceiver) {
        Self::with_terminal_grace(DEFAULT_TERMINAL_STALL_GRACE)
    }

    /// The same, with a different stall grace.
    pub fn with_terminal_grace(grace: Duration) -> (Self, OutboundReceiver) {
        let (queue, rx) = Outbound::new(NAME, SERVER_CLASS_LIMITS, grace);
        (
            Self {
                queue,
                counters: Arc::new(Counters::default()),
            },
            rx,
        )
    }

    /// Submit one classified frame with explicit generation and wait policy.
    ///
    /// This is the `#4434` public seam: callers that own a connection generation
    /// can fence a submission the same way the broker fences state writes.
    pub async fn submit_classified(
        &self,
        class: FrameClass,
        generation: u64,
        msg: WsFrame,
        wait: WaitPolicy,
    ) -> SubmitOutcome {
        let outcome = self.queue.submit(class, generation, msg, wait).await;
        self.note_outcome(class, outcome);
        outcome
    }

    /// Submit a frame the peer is waiting for; waits until the connection
    /// closes.
    pub async fn send_reply(&self, msg: WsFrame) -> Result<(), OutboundError> {
        self.queue.send_reply(msg).await
    }

    /// Relay one terminal frame to the client on the other end of a relay.
    ///
    /// Waits for room up to the stream class's stall grace, then reports
    /// `Stalled`: the caller closes the relay.
    pub async fn send_terminal(&self, msg: WsFrame) -> Result<(), OutboundError> {
        self.queue.send_terminal(msg).await
    }

    /// Send a command to the agent on the other end of this connection.
    ///
    /// **Fails instead of waiting or dropping.** The producer is a *client's*
    /// handler on a different connection; parking the browser behind a slow
    /// agent would spread one unhealthy peer across everyone. The caller
    /// (`CommandBroker::send_command`) revokes the pending command and answers
    /// the client with a failure instead of fifteen seconds of nothing (#960).
    pub fn try_send_command(&self, msg: WsFrame) -> Result<(), OutboundError> {
        self.try_send(msg, Lane::Command)
    }

    /// Push state to a peer. **Dropped when there is no room**: these are
    /// levels, and the next push restates the whole value.
    pub fn try_send_broadcast(&self, msg: WsFrame) -> Result<(), OutboundError> {
        self.try_send(msg, Lane::Broadcast)
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
            dropped_broadcasts: self.counters.dropped_broadcasts.load(Ordering::Relaxed),
            undelivered_commands: self.counters.undelivered_commands.load(Ordering::Relaxed),
            stalled_terminals: queue.stalled_terminals,
            too_large: queue.too_large,
            stale_generation: queue.stale_generation,
            process: queue.process,
        }
    }

    /// Mark this connection closed so the scheduler stops and waiters resolve.
    pub fn close(&self) {
        self.queue.close();
    }

    /// Queue a control frame without waiting (the control class's reserved
    /// capacity). Used for the terminal Close a deadline verdict must deliver.
    pub fn send_control(&self, msg: WsFrame) -> Result<(), OutboundError> {
        self.queue.send_control(msg)
    }

    /// The queue's control-class `try_send`, with this runtime's answer to "no
    /// room". `Closed` and `TooLarge` pass through: they are not statements
    /// about room, and the caller must be able to tell them apart.
    fn try_send(&self, msg: WsFrame, lane: Lane) -> Result<(), OutboundError> {
        let outcome = self.queue.try_submit(FrameClass::Control, msg);
        match outcome {
            SubmitOutcome::Accepted => Ok(()),
            SubmitOutcome::Refused(OutboundError::Saturated) => Err(self.note_no_room(lane)),
            SubmitOutcome::Refused(error) => Err(error),
            SubmitOutcome::Closed => Err(OutboundError::Closed),
        }
    }

    fn note_outcome(&self, class: FrameClass, outcome: SubmitOutcome) {
        let SubmitOutcome::Refused(OutboundError::Saturated) = outcome else {
            return;
        };
        match class {
            FrameClass::Control => {
                // `try_send_command`/`try_send_broadcast` count their own
                // refusals below; a direct `submit_classified` control refusal
                // is still a fact worth recording, but there is no lane to
                // attribute it to. The queue's own `refused` counter has it.
            }
            FrameClass::Response => warn!(
                "{}: a response submission was refused for lack of room on the response class",
                NAME
            ),
            FrameClass::Stream => warn!(
                "{}: a stream submission was refused for lack of room on the stream class",
                NAME
            ),
        }
    }

    fn note_no_room(&self, lane: Lane) -> OutboundError {
        match lane {
            Lane::Command => {
                self.counters
                    .undelivered_commands
                    .fetch_add(1, Ordering::Relaxed);
                warn!(
                    "outbound: no room for a command ({} byte(s) outstanding of {}); \
                     failing the request so its caller answers instead of timing out",
                    self.queue.queued_bytes(),
                    CONTROL_BYTE_BUDGET
                );
                OutboundError::Saturated
            }
            Lane::Broadcast => {
                self.counters
                    .dropped_broadcasts
                    .fetch_add(1, Ordering::Relaxed);
                debug!(
                    "outbound: no room for a state push ({} byte(s) outstanding of {}); dropped — \
                     the next push restates it",
                    self.queue.queued_bytes(),
                    CONTROL_BYTE_BUDGET
                );
                OutboundError::Saturated
            }
        }
    }
}

/// Which policy a `try_send` follows when there is no room.
#[derive(Clone, Copy)]
enum Lane {
    Command,
    Broadcast,
}

/// The default stall grace: 3 MiB held for 15 s is a floor of ~0.2 MiB/s, below
/// which a peer is not slow, it is gone.
pub const DEFAULT_TERMINAL_STALL_GRACE: Duration =
    Duration::from_secs(nession_common::config::DEFAULT_TERMINAL_STALL_GRACE_SECS);

#[cfg(test)]
mod tests {
    use super::*;
    use tracing::info;

    /// A frame that fills its class's byte budget exactly.
    fn fills_class(bytes: usize) -> WsFrame {
        WsFrame::Text("y".repeat(bytes - nession_runtime::outbound::FRAME_OVERHEAD))
    }

    /// The state-push lane is this runtime's policy: it is dropped at the bound,
    /// and its counter says so. The class is control, so filling it does not
    /// depend on the response or stream lanes.
    #[tokio::test]
    async fn a_state_push_is_dropped_when_the_control_class_is_full() {
        let (sender, _rx) = WsMessageSender::new();
        let frame = fills_class(CONTROL_BYTE_BUDGET);

        assert_eq!(sender.try_send_broadcast(frame.clone()), Ok(()));
        assert_eq!(
            sender.try_send_broadcast(frame),
            Err(OutboundError::Saturated),
            "the second frame cannot fit in a class budget already charged in full"
        );
        let snapshot = sender.snapshot();
        assert_eq!(snapshot.dropped_broadcasts, 1);
        assert_eq!(snapshot.control_frames, 1);
        assert_eq!(snapshot.control_bytes, CONTROL_BYTE_BUDGET);
        assert_eq!(
            snapshot.undelivered_commands, 0,
            "the broadcast lane is the one that dropped, and the counters say which"
        );
        assert_eq!(
            snapshot.response_bytes, 0,
            "control exhaustion must not touch the response budget"
        );
        assert_eq!(snapshot.stream_bytes, 0);
    }

    /// A command that finds no room fails *now*.
    #[tokio::test]
    async fn a_command_with_no_room_fails_the_request() {
        let (sender, _rx) = WsMessageSender::new();
        let frame = fills_class(CONTROL_BYTE_BUDGET);

        assert_eq!(sender.try_send_command(frame.clone()), Ok(()));
        assert_eq!(
            sender.try_send_command(frame),
            Err(OutboundError::Saturated)
        );
        let snapshot = sender.snapshot();
        assert_eq!(snapshot.undelivered_commands, 1);
        assert_eq!(snapshot.dropped_broadcasts, 0);
    }

    /// A frame beyond the class's supported maximum is refused with its real
    /// size, not clamped into the budget.
    #[tokio::test]
    async fn an_oversized_reply_is_refused_rather_than_clamped() {
        let (sender, _rx) = WsMessageSender::new();
        let result = sender
            .send_reply(WsFrame::Text("z".repeat(RESPONSE_BYTE_BUDGET)))
            .await;
        assert!(matches!(result, Err(OutboundError::TooLarge { .. })));
        assert_eq!(sender.snapshot().too_large, 1);
        assert_eq!(sender.snapshot().queued_bytes, 0);
    }

    /// The snapshot names every policy and every class's own figures.
    #[tokio::test]
    async fn the_snapshot_names_every_policy_and_class() {
        let (sender, _rx) = WsMessageSender::with_terminal_grace(Duration::from_millis(10));

        assert_eq!(
            sender.send_terminal(WsFrame::Text("s".into())).await,
            Ok(())
        );
        assert_eq!(sender.try_send_broadcast(WsFrame::Text("c".into())), Ok(()));
        assert_eq!(sender.try_send_command(WsFrame::Text("k".into())), Ok(()));
        assert_eq!(sender.send_reply(WsFrame::Text("r".into())).await, Ok(()));

        let snapshot = sender.snapshot();
        assert_eq!(snapshot.byte_budget, OUTBOUND_BYTE_BUDGET);
        assert_eq!(snapshot.frame_slots, OUTBOUND_FRAME_SLOTS);
        assert_eq!(snapshot.control_frames, 2);
        assert_eq!(snapshot.response_frames, 1);
        assert_eq!(snapshot.stream_frames, 1);
        assert_eq!(snapshot.queued_frames, 4);
        assert_eq!(snapshot.in_flight_frames, 0);
        assert!(snapshot.process.bytes >= snapshot.queued_bytes);
        info!("{snapshot:?}");
    }

    /// The charge arithmetic is stated against this runtime's class budget: a
    /// budget of 4 MiB and one of 8 MiB clamp a frame of the same size
    /// differently, which is why this test lives here.
    #[test]
    fn a_frame_larger_than_this_class_budget_is_charged_the_whole_of_it() {
        assert_eq!(
            charge(RESPONSE_BYTE_BUDGET * 2, RESPONSE_BYTE_BUDGET),
            RESPONSE_BYTE_BUDGET
        );
        assert_eq!(
            nession_runtime::outbound::exact_charge(0),
            Some(nession_runtime::outbound::FRAME_OVERHEAD)
        );
    }
}
