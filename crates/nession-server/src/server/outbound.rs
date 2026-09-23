//! One Server connection's outbound path, and the policy that governs each
//! class of message that goes through it.
//!
//! Before this module the path was a single `mpsc::unbounded_channel` drained by
//! a writer task (#961). An unbounded queue is not a policy — it is the absence
//! of one — and it made every producer's failure mode "grow the heap": a peer
//! that stopped reading pinned as much memory as the rest of the system was
//! willing to hand over, and a producer never learned anything about it.
//!
//! The bound is therefore one number, and the interesting part is what happens
//! at it. That answer cannot be a single one, because the messages that share
//! this queue do not share a failure mode:
//!
//! | lane | what is on it | at the bound |
//! |---|---|---|
//! | [`WsMessageSender::send_reply`] | an answer to a request the peer made | **wait** — it is never dropped |
//! | [`WsMessageSender::try_send_command`] | a command the Server sends an agent | **fail the request** — the caller answers its own client |
//! | [`WsMessageSender::try_send_broadcast`] | registry state pushes, `terminal.resize` | **drop** — a later push restates the state |
//! | [`WsMessageSender::send_terminal`] | relayed terminal bytes | **wait, then close the peer** |
//!
//! Three of those four are about *not losing things the peer is waiting for*;
//! the fourth is about not pretending a terminal is alive when it is not. See
//! each method for the reasoning, and [`WsMessageSender::snapshot`] for what is
//! observable while it happens.
//!
//! ## The queue itself is shared
//!
//! The queue, its two bounds, the three verdicts and the byte arithmetic are the
//! same mechanism the agent's peer-to-peer socket runs on, so they are one
//! implementation rather than two: [`nession_runtime::outbound`]. What stays
//! here is what is the *Server's* answer rather than the mechanism's — which
//! lanes exist, what each does at the bound, and the counters that record it.
//!
//! ## The bound
//!
//! Bytes, not frames: this queue carries a `server.session.capture-preview`
//! answer, a file read, and a terminal frame, and their sizes differ by four
//! orders of magnitude. A frame *count* would bound nothing a reader cares
//! about — 64 frames is 12 KiB of pings or 64 MiB of file contents.
//!
//! [`OUTBOUND_BYTE_BUDGET`] is 8 MiB, and that number is an answer to "what may
//! one stalled peer cost us": large enough to hold the largest legitimate single
//! reply (the extension contracts cap a file read at 1 MiB, and a 2000-line
//! scrollback capture is a few hundred KiB) plus a burst behind it, small enough
//! that a thousand stalled connections cost 8 GiB rather than the machine.
//! [`OUTBOUND_FRAME_SLOTS`] guards the *other* axis — a million empty frames are
//! 8 MiB of budget and 100 MB of per-frame overhead — so both are enforced and
//! the effective bound is whichever is reached first.
//!
//! Which one is reached first depends on the lane, and that is worth knowing
//! rather than assuming: a reply is one big frame, so the budget binds (8 frames
//! of 1 MiB); a relayed terminal frame is tens of KiB, so the *count* binds (64
//! frames is ~4 MiB of a 64 KiB-per-frame terminal), and the terminal lane's
//! stall grace is therefore 64 frames' worth of drain, not 8 MiB's. Both are
//! bounded, which is the property that matters; a lane that sized itself by
//! assumption would have found this out by parking.
//!
//! Memory is not the only thing the budget buys. Because producers wait instead
//! of dropping, a saturated connection stops *reading* its socket, which closes
//! the TCP receive window, which stops the sender: the bound is a flow-control
//! signal all the way back to whoever is generating the traffic. That is the
//! whole difference between this and the unbounded channel it replaces, and it is
//! why the reply lane waits rather than failing fast.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{debug, warn};

use nession_runtime::outbound::{Limits, Outbound};

/// The one frame type and the three verdicts, re-exported so a call site names
/// this runtime's outbound path rather than the shared crate's.
///
/// [`charge`] too: a test that states the charge arithmetic states it against
/// *this* runtime's budget, which is the number it should be written against.
pub use nession_runtime::outbound::{charge, OutboundError, QueuedFrame};

/// How many bytes one connection may have queued before its producers wait.
///
/// See the module docs for the arithmetic. This is a *policy* number, not a
/// tuned one: it is the point past which the Server would rather apply
/// backpressure to a peer than absorb its backlog.
pub const OUTBOUND_BYTE_BUDGET: usize = 8 * 1024 * 1024;

/// How many frames one connection may have queued before its producers wait.
///
/// The byte budget alone would let a flood of tiny frames through: a control
/// message is ~100 bytes, so 8 MiB of budget is ~84000 of them, and each costs
/// far more than 100 bytes to hold. This bounds the count; the budget bounds the
/// payload. Whichever is reached first is the effective bound — and for the
/// terminal lane, whose frames are tens of KiB, it is this one.
pub const OUTBOUND_FRAME_SLOTS: usize = 64;

/// The name this runtime's outbound path puts on its own log lines.
const NAME: &str = "outbound";

/// What a caller can see about one connection's outbound path (#961: "metrics /
/// logging can observe queue saturation, in-flight count, per-key queue depth").
///
/// The counts are the observable half of every policy above: `awaited` says the
/// bound was reached and producers waited, `dropped_broadcasts` says state was
/// dropped for a peer that was not draining, `undelivered_commands` says
/// requests were failed rather than left to time out, `stalled_terminals` says
/// terminal clients were closed. A policy that could not be observed here would
/// be indistinguishable from an outage.
///
/// The queue's own half is [`nession_runtime::outbound::QueueSnapshot`]; the two
/// lanes that are *this* runtime's are counted here, because what to do at the
/// bound — and therefore what to count — is the policy this module owns.
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
    /// Broadcast-lane sends dropped because the queue was full.
    pub dropped_broadcasts: u64,
    /// Command-lane sends that failed because the queue was full.
    pub undelivered_commands: u64,
    /// Terminal-lane sends that hit the stall grace.
    pub stalled_terminals: u64,
}

#[derive(Default)]
struct Counters {
    dropped_broadcasts: AtomicU64,
    undelivered_commands: AtomicU64,
}

/// The sending half of one connection's outbound path.
///
/// Cloneable and shared: the connection's own handler, the agent control broker
/// (when the peer is an agent), and the per-session client registries all hold
/// one. They are not interchangeable producers — which is why the constructor
/// does not hand out a bare `send`, and why each caller has to say which
/// *class* of message it is sending.
#[derive(Clone)]
pub struct WsMessageSender {
    queue: Outbound,
    counters: Arc<Counters>,
}

impl WsMessageSender {
    /// A connection's outbound path with the standard bounds and stall grace.
    pub fn new() -> (Self, mpsc::Receiver<QueuedFrame>) {
        Self::with_terminal_grace(DEFAULT_TERMINAL_STALL_GRACE)
    }

    /// The same, with a different stall grace — the one policy number a caller
    /// may reasonably differ on (the Server reads it from its config so a
    /// deployment can trade a slower terminal for a later verdict; tests use it
    /// to reach the verdict without waiting out a production grace).
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
            },
            rx,
        )
    }

    /// Send a frame the peer is waiting for: a reply to a request that arrived
    /// on this connection, or a brokered answer being relayed to the client that
    /// asked for it.
    ///
    /// **Waits for room; never drops.** This is the lane #961 is emphatic about
    /// — "a non-droppable command response must not be silently dropped" — and
    /// waiting is what makes that true rather than merely likely: there is no
    /// path through this method that loses the frame, and the cost of the
    /// guarantee is that a peer which never drains parks its producer instead of
    /// growing the heap. The parked task is the connection's reader — reading
    /// this frame itself, or the query task it admitted to run it (#961-C) — and
    /// either way waiting stops that connection from reading more: a parked
    /// query holds its slot in the query lane, the lane fills, and the reader
    /// parks on the next frame. That is the backpressure the bound exists to
    /// apply, one lane deeper than it was when this was written.
    ///
    /// Relay terminal bytes come through here too. They are on this lane for the
    /// same reason as replies — dropping bytes out of a terminal stream leaves
    /// the emulator and the session disagreeing about the screen — and the
    /// *terminal* slow-consumer policy lives where a terminal is served rather
    /// than where it is piped: on the agent that owns the PTY, which detaches a
    /// subscriber that stops draining (`server::websocket`), and on this
    /// connection's [`Self::send_terminal`], which ends a relay that has stopped
    /// draining.
    pub async fn send_reply(&self, msg: WsMessage) -> Result<(), OutboundError> {
        self.queue.send_reply(msg).await
    }

    /// Relay one terminal frame to the client on the other end of a relay.
    ///
    /// Same lane as [`Self::send_reply`] up to the point where waiting stops
    /// being reasonable, and it ends there with a verdict: `Stalled` is the
    /// caller's cue to end the relay. Terminal output cannot be dropped (the
    /// screen would drift) and cannot be buffered without bound (that is the
    /// queue we just replaced), so the only remaining honest answer is that this
    /// client is no longer attached in any useful sense. The caller closes the
    /// connection, and a client that was merely asleep re-attaches and is handed
    /// a redrawn screen.
    pub async fn send_terminal(&self, msg: WsMessage) -> Result<(), OutboundError> {
        self.queue.send_terminal(msg).await
    }

    /// Send a command to the agent on the other end of this connection.
    ///
    /// **Fails instead of waiting or dropping.** The producer here is a *client's*
    /// handler, on a different connection from the one that is saturated: the
    /// agent stopped draining, and parking the browser's request behind it would
    /// spread one unhealthy agent across everyone talking to the Server. Dropping
    /// is worse still — the client would learn about it by timing out.
    ///
    /// So the send is a `try_send`, and the `Err` is the whole point: the caller
    /// (`CommandBroker::send_command`) revokes the pending command, which
    /// resolves its waiter *now* and answers the client with a failure instead of
    /// fifteen seconds of nothing (#960's contract, reused).
    pub fn try_send_command(&self, msg: WsMessage) -> Result<(), OutboundError> {
        self.try_send(msg, Lane::Command)
    }

    /// Push state to a peer: `server.agents.changed`, `server.sessions.changed`,
    /// `server.commands.changed`, `terminal.resize`.
    ///
    /// **Dropped when there is no room.** These are pushes nobody asked for, and
    /// the state ones are built from the registry as it is *now* — a dropped
    /// `agents.changed` is not a fact the peer lost, because the next one
    /// restates the whole list. `WebClientRegistry` already documents this
    /// ("slow clients may miss messages (lagged)") and its broadcast channel
    /// drops for laggards, so this lane only makes the existing policy explicit
    /// at the last hop.
    ///
    /// `terminal.resize` rides the same reasoning from the other direction: a
    /// resize is a *level*, not an edge. A client too far behind to accept one
    /// is too far behind to render the frame it changes, and it restates its own
    /// size when its viewport moves or when it re-attaches.
    pub fn try_send_broadcast(&self, msg: WsMessage) -> Result<(), OutboundError> {
        self.try_send(msg, Lane::Broadcast)
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
            dropped_broadcasts: self.counters.dropped_broadcasts.load(Ordering::Relaxed),
            undelivered_commands: self.counters.undelivered_commands.load(Ordering::Relaxed),
            stalled_terminals: queue.stalled_terminals,
        }
    }

    /// The queue's `try_send`, with this runtime's answer to "there was no room".
    ///
    /// `Closed` passes through: it is not a statement about room, and the caller
    /// has to be able to tell "this connection is over" from "this connection is
    /// full".
    fn try_send(&self, msg: WsMessage, lane: Lane) -> Result<(), OutboundError> {
        self.queue.try_send(msg).map_err(|e| match e {
            OutboundError::Saturated => self.note_no_room(lane),
            e => e,
        })
    }

    fn note_no_room(&self, lane: Lane) -> OutboundError {
        match lane {
            Lane::Command => {
                self.counters
                    .undelivered_commands
                    .fetch_add(1, Ordering::Relaxed);
                warn!(
                    "outbound: no room for a command ({} byte(s) queued of {}); \
                     failing the request so its caller answers instead of timing out",
                    self.queue.queued_bytes(),
                    OUTBOUND_BYTE_BUDGET
                );
                OutboundError::Saturated
            }
            Lane::Broadcast => {
                self.counters
                    .dropped_broadcasts
                    .fetch_add(1, Ordering::Relaxed);
                debug!(
                    "outbound: no room for a state push ({} byte(s) queued of {}); dropped — \
                     the next push restates it",
                    self.queue.queued_bytes(),
                    OUTBOUND_BYTE_BUDGET
                );
                OutboundError::Saturated
            }
        }
    }
}

/// Which policy a `try_send` follows when there is no room. Only the two
/// non-waiting lanes need one: the waiting lanes have room by construction.
#[derive(Clone, Copy)]
enum Lane {
    Command,
    Broadcast,
}

/// The default stall grace: 8 MiB held for 15 s is a floor of ~0.53 MiB/s, below
/// which a peer is not slow, it is gone. Long enough that a burst of
/// backpressure is never mistaken for a verdict; see
/// [`WsMessageSender::send_terminal`].
///
/// Derived from the config field of the same name so the two cannot drift: a
/// deployment that sets `terminal_stall_grace_secs` is choosing this number.
pub const DEFAULT_TERMINAL_STALL_GRACE: Duration =
    Duration::from_secs(nession_common::config::DEFAULT_TERMINAL_STALL_GRACE_SECS);

#[cfg(test)]
mod tests {
    use super::*;
    use tracing::info;

    /// The sibling of `a_reply_waits_for_room_rather_than_being_dropped`
    /// (`nession_runtime::outbound`), and the half that is this runtime's: the
    /// two *non-waiting* lanes, and the counters that say which one was refused.
    ///
    /// The mechanism — the two bounds, the three verdicts, the oversized frame —
    /// is tested where it lives. What is tested here is the Server's answer at
    /// the bound, which is a policy and not a mechanism.
    #[tokio::test]
    async fn a_state_push_is_dropped_when_the_queue_is_full() {
        let (sender, _rx) = WsMessageSender::new();
        let frame = WsMessage::Text("y".repeat(OUTBOUND_BYTE_BUDGET));

        assert_eq!(sender.try_send_broadcast(frame.clone()), Ok(()));
        assert_eq!(
            sender.try_send_broadcast(frame),
            Err(OutboundError::Saturated),
            "the second frame cannot fit in a budget already charged in full"
        );
        let snapshot = sender.snapshot();
        assert_eq!(snapshot.dropped_broadcasts, 1);
        assert_eq!(snapshot.queued_frames, 1);
        assert_eq!(snapshot.queued_bytes, OUTBOUND_BYTE_BUDGET);
        assert_eq!(
            snapshot.undelivered_commands, 0,
            "the broadcast lane is the one that dropped, and the counters say which"
        );
    }

    /// A command that finds no room fails *now*: the caller revokes the pending
    /// command and answers its client, instead of the client waiting out its
    /// timeout for an answer that was never going to be sent.
    #[tokio::test]
    async fn a_command_with_no_room_fails_the_request() {
        let (sender, _rx) = WsMessageSender::new();
        let frame = WsMessage::Text("z".repeat(OUTBOUND_BYTE_BUDGET));

        assert_eq!(sender.try_send_command(frame.clone()), Ok(()));
        assert_eq!(
            sender.try_send_command(frame),
            Err(OutboundError::Saturated)
        );
        let snapshot = sender.snapshot();
        assert_eq!(snapshot.undelivered_commands, 1);
        assert_eq!(
            snapshot.dropped_broadcasts, 0,
            "the command lane failed the request; it did not drop a push"
        );
    }

    /// `info!`-level observability is not the point of this test; the snapshot
    /// is. Kept so the module has one test that reads a whole snapshot at once,
    /// which is what an operator or a metric exporter would do.
    #[tokio::test]
    async fn the_snapshot_names_every_policy() {
        let (sender, _rx) = WsMessageSender::with_terminal_grace(Duration::from_millis(10));
        let frame = WsMessage::Text("s".repeat(OUTBOUND_BYTE_BUDGET));

        assert_eq!(sender.send_terminal(frame.clone()).await, Ok(()));
        let _ = sender.send_terminal(frame.clone()).await;
        let _ = sender.try_send_broadcast(frame.clone());
        let _ = sender.try_send_command(frame);

        let snapshot = sender.snapshot();
        assert_eq!(snapshot.byte_budget, OUTBOUND_BYTE_BUDGET);
        assert_eq!(snapshot.frame_slots, OUTBOUND_FRAME_SLOTS);
        assert_eq!(snapshot.queued_frames, 1);
        assert!(snapshot.awaited >= 1);
        assert_eq!(snapshot.stalled_terminals, 1);
        assert_eq!(snapshot.dropped_broadcasts, 1);
        assert_eq!(snapshot.undelivered_commands, 1);
        info!("{snapshot:?}");
    }

    /// The charge arithmetic is stated against *this* runtime's budget, which is
    /// what makes it this module's test and not the shared crate's: a budget of
    /// 8 MiB and one of 4 MiB clamp a frame of the same size differently.
    #[test]
    fn a_frame_larger_than_this_budget_is_charged_the_whole_of_it() {
        assert_eq!(
            charge(OUTBOUND_BYTE_BUDGET * 2, OUTBOUND_BYTE_BUDGET),
            OUTBOUND_BYTE_BUDGET
        );
        assert_eq!(charge(0, OUTBOUND_BYTE_BUDGET), 14);
    }
}
