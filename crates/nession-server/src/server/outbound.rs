//! One connection's outbound path: a bounded queue, and the policy that governs
//! each class of message that goes through it.
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

use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{debug, warn};

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

/// What the WebSocket frame header costs beyond the payload `Message::len`
/// reports. Charged so a queue full of small frames is priced honestly.
const FRAME_OVERHEAD: usize = 14;

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

/// One frame waiting to be written, holding the claim on the byte budget that
/// lets it wait there.
///
/// The permit is what makes the queue's bound real: it is released when the
/// writer drops this struct, i.e. after the frame has been handed to the socket,
/// so `budget` bytes is the most that can be queued *and* not yet written.
pub struct QueuedFrame {
    pub message: WsMessage,
    /// This frame's share of [`OUTBOUND_BYTE_BUDGET`]. Held until the writer is
    /// done with it — dropping it early would let producers run ahead of the
    /// socket the budget exists to bound.
    pub budget: OwnedSemaphorePermit,
}

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
/// Per-key queue depth is absent because no keyed queue exists yet: this stage
/// bounds the write path, and the per-key executors are #961-C … #961-E.
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
    awaited: AtomicU64,
    dropped_broadcasts: AtomicU64,
    undelivered_commands: AtomicU64,
    stalled_terminals: AtomicU64,
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
    tx: mpsc::Sender<QueuedFrame>,
    budget: Arc<Semaphore>,
    counters: Arc<Counters>,
    terminal_grace: Duration,
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
        let (tx, rx) = mpsc::channel(OUTBOUND_FRAME_SLOTS);
        (
            Self {
                tx,
                budget: Arc::new(Semaphore::new(OUTBOUND_BYTE_BUDGET)),
                counters: Arc::new(Counters::default()),
                terminal_grace: grace,
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
    /// this frame itself, or the query task it admitted to run it (#961-C) —
    /// and either way waiting stops that connection from reading more: a parked
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
        let len = msg.len();
        let (budget, waited) = self.acquire(len).await.ok_or(OutboundError::Closed)?;
        if waited {
            debug!(
                "outbound: no room for a reply, waiting for the writer \
                 ({} frame(s), {} byte(s) queued)",
                self.queued_frames(),
                self.queued_bytes()
            );
        }
        self.enqueue(msg, budget).await
    }

    /// Relay one terminal frame to the client on the other end of a relay.
    ///
    /// Same lane as [`Self::send_reply`] up to the point where waiting stops
    /// being reasonable. Terminal bytes have the bottleneck that replies do not:
    /// they are *steady* — a busy session produces them whether or not anybody
    /// is watching — so a peer that has stopped draining does not park a
    /// producer that was going to finish anyway, it pins the relay and the
    /// agent's output behind it indefinitely.
    ///
    /// So this waits for room, and gives up after the stall grace. `Stalled` is
    /// the caller's cue to end the relay: terminal output cannot be dropped (the
    /// screen would drift) and cannot be buffered without bound (that is the
    /// queue we just replaced), so the only remaining honest answer is that this
    /// client is no longer attached in any useful sense. The caller closes the
    /// connection, and a client that was merely asleep re-attaches and is handed
    /// a redrawn screen.
    pub async fn send_terminal(&self, msg: WsMessage) -> Result<(), OutboundError> {
        // The grace covers *both* bounds, which is why the whole enqueue is
        // inside the timeout rather than just the byte reservation: the frame
        // already in hand can be waiting on the frame count rather than on the
        // budget (`64` terminal-sized frames are 4 MiB, well inside an 8 MiB
        // budget), and a lane that gave up on one bound but not the other would
        // park here exactly as before.
        match tokio::time::timeout(self.terminal_grace, self.enqueue_reserved(msg)).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                self.counters
                    .stalled_terminals
                    .fetch_add(1, Ordering::Relaxed);
                warn!(
                    "outbound: terminal frame waited {:?} for room and never got it — \
                     the peer has stopped draining ({} frame(s), {} byte(s) queued); \
                     ending the relay",
                    self.terminal_grace,
                    self.queued_frames(),
                    self.queued_bytes()
                );
                Err(OutboundError::Stalled)
            }
        }
    }

    /// Reserve this frame's bytes and hand it to the queue, waiting for both.
    async fn enqueue_reserved(&self, msg: WsMessage) -> Result<(), OutboundError> {
        let len = msg.len();
        let (budget, _) = self.acquire(len).await.ok_or(OutboundError::Closed)?;
        self.enqueue(msg, budget).await
    }

    /// Hand a frame that has already reserved its bytes to the queue, waiting for
    /// a free slot if the count bound is what is full.
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
        OutboundSnapshot {
            queued_bytes: self.queued_bytes(),
            queued_frames: self.queued_frames(),
            byte_budget: OUTBOUND_BYTE_BUDGET,
            frame_slots: OUTBOUND_FRAME_SLOTS,
            awaited: self.counters.awaited.load(Ordering::Relaxed),
            dropped_broadcasts: self.counters.dropped_broadcasts.load(Ordering::Relaxed),
            undelivered_commands: self.counters.undelivered_commands.load(Ordering::Relaxed),
            stalled_terminals: self.counters.stalled_terminals.load(Ordering::Relaxed),
        }
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

    fn try_send(&self, msg: WsMessage, lane: Lane) -> Result<(), OutboundError> {
        let Some(budget) = Arc::clone(&self.budget)
            .try_acquire_many_owned(permits(charge(msg.len())))
            .ok()
        else {
            return Err(self.note_no_room(lane));
        };
        self.tx
            .try_send(QueuedFrame {
                message: msg,
                budget,
            })
            .map_err(|e| {
                // The budget was there and the slots were not — or the writer
                // is gone. Both are "no room" for the caller's purposes, and
                // the counters say which lane was refused.
                if matches!(e, mpsc::error::TrySendError::Closed(_)) {
                    OutboundError::Closed
                } else {
                    self.note_no_room(lane)
                }
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
                    self.queued_bytes(),
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
                    self.queued_bytes(),
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

/// What one frame is charged against the connection's byte budget.
///
/// A single frame larger than the whole budget is charged the whole budget
/// rather than refused: the contract caps these at 1 MiB and a refusal would
/// turn "this reply is big" into "this reply cannot be sent". Charging it
/// everything means at most one such frame is ever queued, and the next producer
/// waits for it to be written — which is the same bound, applied to the case the
/// bound was not sized for.
fn charge(len: usize) -> usize {
    (len + FRAME_OVERHEAD).clamp(1, OUTBOUND_BYTE_BUDGET)
}

/// A byte charge as the permit count a `Semaphore` takes.
///
/// `charge` clamps to [`OUTBOUND_BYTE_BUDGET`], which fits in a `u32`, so this
/// cannot lose anything today — `try_from` rather than `as` so that a budget
/// raised past `u32::MAX` becomes a saturating question rather than a silent
/// truncation that would leave a frame holding almost none of the budget it
/// thinks it holds.
fn permits(bytes: usize) -> u32 {
    u32::try_from(bytes).unwrap_or(u32::MAX)
}

/// The default stall grace: 8 MiB held for 15 s is a floor of ~0.53 MiB/s, below
/// which a peer is not slow, it is gone. Long enough that a burst of
/// backpressure is never mistaken for a verdict; see [`WsMessageSender::send_terminal`].
///
/// Derived from the config field of the same name so the two cannot drift: a
/// deployment that sets `terminal_stall_grace_secs` is choosing this number.
pub const DEFAULT_TERMINAL_STALL_GRACE: Duration =
    Duration::from_secs(nession_common::config::DEFAULT_TERMINAL_STALL_GRACE_SECS);

#[cfg(test)]
mod tests {
    use super::*;
    use tracing::info;
    /// The reply lane's whole reason to exist: a send that finds the queue full
    /// waits, and the frame is there when the consumer catches up. If this ever
    /// returns `Err` or drops the frame, #961's "must not be silently dropped"
    /// is violated and the flood test in `tests/integration/websocket.rs` stops
    /// being an assertion about anything.
    #[tokio::test]
    async fn a_reply_waits_for_room_rather_than_being_dropped() {
        let (sender, mut rx) = WsMessageSender::with_terminal_grace(Duration::from_millis(50));

        // A frame sized so each one takes an equal share of the budget: filling
        // with these reaches both bounds at once.
        let share = OUTBOUND_BYTE_BUDGET / OUTBOUND_FRAME_SLOTS - FRAME_OVERHEAD;
        let frame = WsMessage::Text("x".repeat(share));
        let mut queued = 0;
        while sender.try_send(frame.clone(), Lane::Broadcast).is_ok() {
            queued += 1;
            assert!(
                queued <= OUTBOUND_FRAME_SLOTS,
                "the frame bound never fired"
            );
        }
        assert_eq!(queued, OUTBOUND_FRAME_SLOTS);
        assert_eq!(sender.snapshot().queued_bytes, OUTBOUND_BYTE_BUDGET);

        // The reply lane parks instead of failing...
        let waiter = tokio::spawn({
            let sender = sender.clone();
            async move { sender.send_reply(WsMessage::Text("held".into())).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !waiter.is_finished(),
            "a full queue must park the reply lane, not fail it"
        );
        assert_eq!(sender.snapshot().awaited, 1);

        // ...and completes, whole, once the writer drains.
        for n in 0..queued {
            let written = rx.recv().await.expect("a queued frame went missing");
            assert_eq!(written.message, frame, "frame {n} was not the one queued");
        }
        let last = rx.recv().await.expect("the waiting reply was never queued");
        assert_eq!(last.message, WsMessage::Text("held".into()));
        assert_eq!(waiter.await.expect("reply task panicked"), Ok(()));
        assert_eq!(
            sender.snapshot().dropped_broadcasts,
            1,
            "the one broadcast that found no room was dropped; the reply that found \
             no room was not — it waited and was delivered"
        );
    }

    /// The broadcast lane is the one that drops — and says so in the counters.
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
        assert_eq!(sender.snapshot().undelivered_commands, 1);
    }

    /// The terminal lane waits like a reply, and ends at the grace with a
    /// verdict rather than an unbounded park.
    #[tokio::test]
    async fn a_terminal_frame_that_never_gets_room_stalls() {
        let (sender, _rx) = WsMessageSender::with_terminal_grace(Duration::from_millis(50));
        let frame = WsMessage::Text("t".repeat(OUTBOUND_BYTE_BUDGET));
        assert_eq!(sender.send_terminal(frame.clone()).await, Ok(()));

        let started = std::time::Instant::now();
        assert_eq!(
            sender.send_terminal(frame).await,
            Err(OutboundError::Stalled)
        );
        assert!(
            started.elapsed() >= Duration::from_millis(50),
            "the verdict must come after the grace, not instead of it"
        );
        assert_eq!(sender.snapshot().stalled_terminals, 1);
    }

    /// A closed writer is reported as such on every lane, so the read loop can
    /// tell "this connection is over" from "this connection is full".
    #[tokio::test]
    async fn a_gone_writer_is_closed_on_every_lane() {
        let (sender, rx) = WsMessageSender::new();
        drop(rx);

        assert_eq!(
            sender.send_reply(WsMessage::Text("a".into())).await,
            Err(OutboundError::Closed)
        );
        assert_eq!(
            sender.send_terminal(WsMessage::Text("b".into())).await,
            Err(OutboundError::Closed)
        );
        assert_eq!(
            sender.try_send_command(WsMessage::Text("c".into())),
            Err(OutboundError::Closed)
        );
        assert_eq!(
            sender.try_send_broadcast(WsMessage::Text("d".into())),
            Err(OutboundError::Closed)
        );
    }

    /// A frame bigger than the budget is not refused: it takes the whole budget,
    /// so it can still be sent, and the next producer waits for it.
    #[tokio::test]
    async fn a_frame_larger_than_the_budget_holds_all_of_it() {
        assert_eq!(charge(OUTBOUND_BYTE_BUDGET * 2), OUTBOUND_BYTE_BUDGET);
        assert_eq!(charge(0), FRAME_OVERHEAD);

        let (sender, mut rx) = WsMessageSender::new();
        let huge = WsMessage::Text("h".repeat(OUTBOUND_BYTE_BUDGET * 2));
        assert_eq!(sender.send_reply(huge.clone()).await, Ok(()));
        assert_eq!(sender.snapshot().queued_bytes, OUTBOUND_BYTE_BUDGET);

        let waiter = tokio::spawn({
            let sender = sender.clone();
            async move { sender.send_reply(WsMessage::Text("after".into())).await }
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
        let (sender, mut rx) = WsMessageSender::new();
        assert_eq!(sender.send_reply(WsMessage::Text("q".into())).await, Ok(()));
        assert_eq!(sender.snapshot().queued_bytes, charge(1));

        let frame = rx.recv().await.expect("the frame was queued");
        assert_eq!(
            sender.snapshot().queued_bytes,
            charge(1),
            "the frame is still holding its claim while it is being written"
        );
        drop(frame);
        assert_eq!(sender.snapshot().queued_bytes, 0);
        assert_eq!(sender.snapshot().queued_frames, 0);
    }

    /// `info!`-level observability is not the point of this test; the snapshot
    /// is. Kept so the module has one test that reads a whole snapshot at once,
    /// which is what an operator or a follow-up metric exporter would do.
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
}
