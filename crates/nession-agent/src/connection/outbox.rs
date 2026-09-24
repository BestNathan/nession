//! The agent's central-connection outbox: one bounded, coalescing lane per
//! class of business notification (`#961`, finding 4).
//!
//! `ServerClientHandle` used to hold `mpsc::UnboundedSender<WsMessage>`, and the
//! finding that reopened `#961` is that an unbounded queue is not a policy. The
//! producers pause while the connection is *known* to be down
//! (`ServerClientHandle::is_connected`), but that says nothing about the case
//! `#961`'s backpressure section is actually about: a socket that still counts
//! as connected while its writer is stalled in `send().await`. Everything
//! published behind that writer kept accumulating, and the only thing bounding
//! the agent's memory was how long the Server stayed away.
//!
//! ## The four classes, and what each does at its bound
//!
//! They do not share a failure mode, so they do not share a lane — which is the
//! same reason [`nession_runtime::outbound::Outbound`] has no bare `send`, and
//! why every publisher here has to name its class:
//!
//! | class | key | at the bound |
//! |---|---|---|
//! | `control.heartbeat` | the agent | **replace** — a heartbeat is a liveness *level*, and a newer one supersedes the one waiting |
//! | `server.agent.address-update` | the agent | **replace** — the advertised address list is a level, not a sequence of changes |
//! | `server.agent.session-update` | the session | **replace** per session; **drop a new session** at the lane's bound, and mark the view for re-derivation |
//! | `agent.terminal.resize` | the session | **replace** per session; **drop a new session** at the lane's bound |
//!
//! Nothing on this outbox is a request. Every frame here is answered by no one
//! and waited on by no one, which is what makes a *level* lane the right shape
//! for all four of them — and it is why the non-droppable lane `#961` is
//! emphatic about is not here at all. A command response is a reply to a request
//! with an `id` and a Server waiting for it, so it rides `ServerClient`'s own
//! bounded `responses` channel (`AGENT_RESPONSE_QUEUE_SLOTS`) and never this.
//!
//! ## Why coalescing rather than dropping
//!
//! A queue bounded by dropping drops the frame it just accepted — the *newest*
//! one — and the Server then keeps whichever stale value happened to be in
//! flight. For a level that is backwards: the newest value is the only one worth
//! delivering. So a publish into a key that is already pending **replaces**
//! instead, and the two properties that matter fall out together:
//!
//! * the lane can never hold more than one frame per key, so its size is a
//!   function of how many resources it names and never of how long the writer
//!   has been away — which is the bound this module exists for;
//! * the newest value always survives, however far behind the writer is.
//!
//! This is the shape `crate::server::resize` already gives the agent's own
//! resize lane (`#961-D`): one slot per session, superseded in place. What is
//! new here is that the same shape is applied per *class*, on the transport that
//! carries three other classes as well.
//!
//! ## The bound is two numbers, and both are hard
//!
//! [`Limits`] and the charge arithmetic are `nession_runtime::outbound`'s — the
//! same vocabulary the Server's write path and the agent's peer-to-peer socket
//! state their own bounds in, reused rather than restated. Bytes *and* frames,
//! because they bind on different things: a session-update frame is a few
//! hundred bytes, so the frame count is what 256 sessions reach first, while a
//! single oversized frame is what only the byte budget catches — it is charged
//! the whole budget rather than refused, exactly as it is there.
//!
//! Both are invariants of the pending state rather than estimates, and the
//! test `a_stalled_writer_never_grows_the_outbox` asserts them against a writer
//! that never drains at all.
//!
//! ## What a full lane leaves behind
//!
//! A refused publish is counted and logged, and for the session-state class it
//! also marks the connection's `sync_needed` flag — the one `SessionWatcher`
//! already reads to force a full re-report. So a drop is *recovered* rather than
//! merely admitted: the next poll re-states every session there is, and the flag
//! stays set — the drop path sets it again — until a pass gets through with room
//! to spare. A session whose update was dropped and that then never changes again
//! would otherwise leave the Server's registry stale for good; this is what stops
//! that.
//!
//! The resize class is not marked for resync, deliberately: a pane size is
//! re-established by the attach path (its initial `TmuxOps::window_size`
//! query), not by the session registry.
//!
//! ## Who publishes, who writes
//!
//! Publishing never blocks and never waits for room: it takes the pending lock
//! for as long as it takes to move one map entry, and returns. That is what
//! keeps this out of the read half's way — `read_loop` is the only half of a
//! connection allowed to park on a bound (`connection::execution`), and it never
//! names this type. `run_connection` is the write half: it owns the socket and
//! drains this outbox between frames, and nothing a publisher does can park it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};

use anyhow::{anyhow, Result};
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{debug, warn};

use nession_runtime::outbound::{charge, Limits};

/// The bound the heartbeat class holds to.
///
/// One slot, because a heartbeat is the agent's liveness *level* and the Server
/// wants the latest one: a second heartbeat waiting behind the first is the same
/// fact, older. The byte figure is part of the bound rather than decoration —
/// `charge` clamps to it, so no heartbeat is charged more than this however
/// large its payload is.
pub const HEARTBEAT_LIMITS: Limits = Limits {
    bytes: 64 * 1024,
    frames: 1,
};

/// The bound the address class holds to.
///
/// One slot, for the heartbeat's reason: the advertised address list is a level,
/// and a re-scan that produced a new one has superseded the old.
pub const ADDRESS_LIMITS: Limits = Limits {
    bytes: 64 * 1024,
    frames: 1,
};

/// The bound the session-state class holds to.
///
/// A slot *per session*, because two sessions are two levels: one slot for both
/// would let session B's update supersede session A's, and A would then be stale
/// at the Server until something happened to change it again. That is the
/// per-key argument `crate::server::resize` makes for the resize lane, and it
/// holds here unchanged.
///
/// The frame count is what binds in practice — a session-update frame is a few
/// hundred bytes, so 256 of them are around 80 KiB against the 256 KiB budget,
/// which is the half that catches a single oversized one.
pub const SESSION_STATE_LIMITS: Limits = Limits {
    bytes: 256 * 1024,
    frames: 256,
};

/// The bound the resize class holds to.
///
/// Per session, on the session-state class's reasoning. A resize frame is
/// smaller than a session update, so a tighter byte budget is the honest figure
/// rather than a copy of the one above.
pub const RESIZE_LIMITS: Limits = Limits {
    bytes: 64 * 1024,
    frames: 256,
};

/// The key the two whole-agent classes publish under.
///
/// There is one agent per connection, so neither a heartbeat nor an address list
/// has a resource to be keyed by — the *class* is the key. Both singletons use
/// this spelling so that all four classes run through one admission rule, one
/// set of counters and one snapshot shape, rather than two shapes that would have
/// to be kept agreeing.
const AGENT: &str = "(agent)";

/// One class of business notification this connection publishes.
///
/// Private: a publisher names its class by calling the method for it, which makes
/// "every frame on this outbox says which class it is" a property of the API
/// rather than a convention — the same device
/// [`nession_runtime::outbound::Outbound`] uses, for the same reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    Heartbeat,
    Addresses,
    SessionState,
    Resize,
}

impl Class {
    /// Every class, in the order the writer drains them.
    const ALL: [Self; 4] = [
        Self::Heartbeat,
        Self::Addresses,
        Self::SessionState,
        Self::Resize,
    ];

    /// This class's pending frames *and* its counters, together.
    ///
    /// Both from one accessor because the admission rule moves them together and
    /// two separate `&mut State` borrows could not be held at once.
    ///
    /// Named fields rather than an array of four, and that is the point rather
    /// than a style: the class *is* the field, so "this class read another
    /// class's lane" — a whole class of mistake an index makes available — has
    /// no spelling. A crossing written out by hand is still possible, and
    /// `each_class_counts_its_own_publishes` is what witnesses that.
    fn parts(self, state: &mut State) -> (&mut Room, &mut ClassCounters) {
        match self {
            Self::Heartbeat => (&mut state.heartbeat, &mut state.counters.heartbeat),
            Self::Addresses => (&mut state.addresses, &mut state.counters.addresses),
            Self::SessionState => (&mut state.session_state, &mut state.counters.session_state),
            Self::Resize => (&mut state.resize, &mut state.counters.resize),
        }
    }

    /// What this class is holding, read from one instant of the pending state.
    fn snapshot(self, state: &State) -> ClassSnapshot {
        let (room, counters) = match self {
            Self::Heartbeat => (&state.heartbeat, &state.counters.heartbeat),
            Self::Addresses => (&state.addresses, &state.counters.addresses),
            Self::SessionState => (&state.session_state, &state.counters.session_state),
            Self::Resize => (&state.resize, &state.counters.resize),
        };
        let limits = self.limits();
        ClassSnapshot {
            pending: room.entries.len(),
            frame_slots: limits.frames,
            charged_bytes: room.charged_bytes,
            byte_budget: limits.bytes,
            superseded: counters.superseded,
            dropped: counters.dropped,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Heartbeat => "heartbeat",
            Self::Addresses => "addresses",
            Self::SessionState => "session-state",
            Self::Resize => "resize",
        }
    }

    /// The two numbers this class's pending frames move within.
    fn limits(self) -> Limits {
        match self {
            Self::Heartbeat => HEARTBEAT_LIMITS,
            Self::Addresses => ADDRESS_LIMITS,
            Self::SessionState => SESSION_STATE_LIMITS,
            Self::Resize => RESIZE_LIMITS,
        }
    }

    /// Whether a frame of this class being refused leaves the Server's view of
    /// this agent re-derivable rather than merely stale.
    ///
    /// True for the session registry only: that is what `sync_needed` re-states.
    fn needs_resync(self) -> bool {
        matches!(self, Self::SessionState)
    }
}

/// One frame waiting for the writer, and what it was charged.
///
/// The charge is carried with the frame rather than recomputed when it is taken,
/// so the refund on the way out is exact by construction instead of being the
/// same arithmetic written twice.
struct PendingFrame {
    message: WsMessage,
    charged: usize,
}

/// One class's pending frames, and what they were charged against its budget.
///
/// A map rather than a queue, and that *is* the bound: a second frame for a key
/// that is already pending replaces it, so this holds at most one per key
/// whatever the writer is doing.
#[derive(Default)]
struct Room {
    entries: HashMap<String, PendingFrame>,
    /// The sum of the entries' charges, kept incrementally so the budget can be
    /// enforced and asserted without walking the map. The invariant is exact:
    /// superseding an entry refunds what that entry charged.
    charged_bytes: usize,
}

/// One class's counters.
#[derive(Default)]
struct ClassCounters {
    /// Publishes that replaced a frame still pending for the same key.
    superseded: u64,
    /// Publishes refused because the class was at its bound.
    dropped: u64,
}

/// Plain counters, read and written under the pending lock.
///
/// Deliberately not atomics: every one of them moves inside a critical section
/// that already exists, and the snapshot then reads the frames and the counters
/// that describe them from one instant rather than from two.
#[derive(Default)]
struct Counters {
    heartbeat: ClassCounters,
    addresses: ClassCounters,
    session_state: ClassCounters,
    resize: ClassCounters,
}

/// What one class of the outbox is holding, and what it has done.
///
/// The observable half of every policy above: `superseded` and `dropped` are the
/// two verdicts a full lane can hand a publisher, and a policy that could not be
/// observed here would be indistinguishable from an outage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClassSnapshot {
    /// Frames pending for this class right now.
    pub pending: usize,
    /// The frame bound `pending` moves within.
    pub frame_slots: usize,
    /// Bytes the pending frames were charged.
    pub charged_bytes: usize,
    /// The byte bound `charged_bytes` moves within.
    pub byte_budget: usize,
    /// Publishes that superseded a frame still pending for the same key.
    pub superseded: u64,
    /// Publishes refused because the class was at its bound.
    pub dropped: u64,
}

/// What this outbox is holding, by class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutboxSnapshot {
    pub heartbeat: ClassSnapshot,
    pub addresses: ClassSnapshot,
    pub session_state: ClassSnapshot,
    pub resize: ClassSnapshot,
}

impl OutboxSnapshot {
    /// Every class's numbers, in one line, for the connection's teardown log.
    ///
    /// The production reader of these counters, on the same reasoning as
    /// `nession_runtime::lane::summary`: a bound whose numbers nobody reads is
    /// indistinguishable from a bound nobody checked. It is read as a connection
    /// ends, which is when `pending` has settled while the two verdicts still say
    /// whether the bound was ever reached.
    pub fn summary(&self) -> String {
        let classes = [
            ("heartbeat", &self.heartbeat),
            ("addresses", &self.addresses),
            ("session-state", &self.session_state),
            ("resize", &self.resize),
        ];
        let rendered: Vec<String> = classes
            .iter()
            .map(|(name, class)| {
                format!(
                    "{name} {}/{} {}B (superseded {}, dropped {})",
                    class.pending,
                    class.frame_slots,
                    class.charged_bytes,
                    class.superseded,
                    class.dropped,
                )
            })
            .collect();
        format!("outbox: {}", rendered.join("; "))
    }
}

/// Everything the pending frames need, behind one lock.
#[derive(Default)]
struct State {
    heartbeat: Room,
    addresses: Room,
    session_state: Room,
    resize: Room,
    counters: Counters,
}

/// What a publish did, once the pending lock is released.
enum Verdict {
    /// The frame is pending under its key: queued, or replacing what was there.
    Pending,
    /// The frame was refused. The count is this class's total, so the caller can
    /// warn once and then be quiet.
    Refused { total: u64 },
}

struct Shared {
    state: Arc<StdMutex<State>>,
    /// Signalled on every publish that changed what is pending.
    available: Arc<Notify>,
    /// Set when the writing half is dropped; see [`OutboxFrames`]'s `Drop`.
    closed: AtomicBool,
    /// Set when a session-state publish is refused, because the Server's registry
    /// is then not what this agent last tried to say it was.
    ///
    /// The same flag the supervisor sets after a reconnection, and the same
    /// question it asks — is the Server's view re-derivable? A reconnection makes
    /// it unknown; a refused publish makes it known-stale. `SessionWatcher` reads
    /// it the same way in either case; see this module's docs.
    sync_needed: Arc<AtomicBool>,
}

/// The publishing half: what every producer of a business notification holds.
///
/// Cloneable and shared, and every clone publishes into the same four lanes,
/// because the lanes are a property of the connection and not of a caller.
#[derive(Clone)]
pub struct Outbox {
    shared: Arc<Shared>,
}

/// The draining half: what the connection's writer owns.
///
/// Deliberately not `Clone`. One writer drains a connection's outbox once, and a
/// second would see a *different* subset of the pending frames rather than a copy
/// of them.
pub struct OutboxFrames {
    /// The frames themselves, held directly rather than through [`Shared`], so
    /// that what was published before the last producer was dropped is still owed
    /// to the writer — the ordering `crate::server::resize`'s consumer keeps when
    /// it drains before ending.
    state: Arc<StdMutex<State>>,
    /// A clone of the wake-up, held so the writer can wait without keeping
    /// [`Shared`] alive: the drop that ends this lane is what it waits to observe.
    available: Arc<Notify>,
    /// Liveness only — "is there anyone left who could publish again?" — and
    /// weak, because holding it strongly would be the drop that answers that
    /// question never happening.
    shared: Weak<Shared>,
}

impl Outbox {
    /// An outbox and the one writer that drains it.
    ///
    /// `sync_needed` is the flag a refused session-state publish marks. It is the
    /// connection's existing one, because the question it answers — may the
    /// Server's view of this agent be stale? — is the same question.
    pub fn new(sync_needed: Arc<AtomicBool>) -> (Self, OutboxFrames) {
        let state = Arc::new(StdMutex::new(State::default()));
        let available = Arc::new(Notify::new());
        let shared = Arc::new(Shared {
            state: Arc::clone(&state),
            available: Arc::clone(&available),
            closed: AtomicBool::new(false),
            sync_needed,
        });
        (
            Self {
                shared: Arc::clone(&shared),
            },
            OutboxFrames {
                state,
                available,
                shared: Arc::downgrade(&shared),
            },
        )
    }

    /// Publish a heartbeat, superseding any heartbeat still pending.
    pub fn send_heartbeat(&self, msg: WsMessage) -> Result<()> {
        self.publish(Class::Heartbeat, AGENT, msg)
    }

    /// Publish the agent's advertised address list, superseding any still
    /// pending.
    pub fn send_address_update(&self, msg: WsMessage) -> Result<()> {
        self.publish(Class::Addresses, AGENT, msg)
    }

    /// Publish one session's state, superseding any update still pending for that
    /// session.
    pub fn send_session_update(&self, session: &str, msg: WsMessage) -> Result<()> {
        self.publish(Class::SessionState, session, msg)
    }

    /// Publish one session's terminal size, superseding any resize still pending
    /// for it.
    ///
    /// Keyed by the **full** `agent:name` session id, because that is what the
    /// Server's relay path looks the session up by — see
    /// `ServerClientHandle::send_terminal_resize`.
    pub fn send_terminal_resize(&self, session_id: &str, msg: WsMessage) -> Result<()> {
        self.publish(Class::Resize, session_id, msg)
    }

    /// Put one frame into one class, superseding what is pending for its key.
    ///
    /// The one admission rule all four classes share, and the whole of what a
    /// publisher can observe: `Ok` means the frame is pending under its key (it
    /// was queued, or it replaced one that was), `Err` means this outbox has no
    /// writer any more — the supervisor is gone. Each class's own counters say
    /// what a refusal left behind, and publishing never waits for room, so there
    /// is no third outcome and nothing for a caller to retry.
    fn publish(&self, class: Class, key: &str, msg: WsMessage) -> Result<()> {
        if self.shared.closed.load(Ordering::SeqCst) {
            return Err(anyhow!("server client supervisor has stopped"));
        }

        let limits = class.limits();
        let charged = charge(msg.len(), limits.bytes);

        let verdict = {
            let mut state = lock(&self.shared.state);
            // The class's own frames and its own counters, from one accessor: the
            // admission rule below moves both.
            let (room, counters) = class.parts(&mut state);

            if let Some(pending) = room.entries.get_mut(key) {
                // A key that is already pending keeps its slot whatever the
                // bounds say, because the frame replacing it is the *newer* fact
                // and the lane is holding one either way. What can still be
                // refused is a replacement that does not fit even with the entry
                // it supersedes refunded — a key whose lane is at its bound like
                // any other, and the verdict below is then the same one.
                let refunded = room.charged_bytes.saturating_sub(pending.charged);
                if refunded.saturating_add(charged) <= limits.bytes {
                    room.charged_bytes = refunded + charged;
                    pending.charged = charged;
                    pending.message = msg;
                    counters.superseded += 1;
                    Verdict::Pending
                } else {
                    counters.dropped += 1;
                    Verdict::Refused {
                        total: counters.dropped,
                    }
                }
            } else if room.entries.len() < limits.frames
                && room.charged_bytes.saturating_add(charged) <= limits.bytes
            {
                room.charged_bytes += charged;
                room.entries.insert(
                    key.to_string(),
                    PendingFrame {
                        message: msg,
                        charged,
                    },
                );
                Verdict::Pending
            } else {
                counters.dropped += 1;
                Verdict::Refused {
                    total: counters.dropped,
                }
            }
        };

        match verdict {
            Verdict::Pending => {
                self.shared.available.notify_waiters();
            }
            Verdict::Refused { total } => {
                if class.needs_resync() {
                    self.shared.sync_needed.store(true, Ordering::SeqCst);
                }
                // What the peer does about it, per class: the session registry
                // has no way to ask again, which is why it marks the view; a
                // pane size is re-established by the attach path on its own.
                let closure = if class.needs_resync() {
                    "; the Server's view will be re-derived by a full session re-sync"
                } else {
                    "; the peer restates it"
                };
                // One warning per class per connection, then debug: a lane at its
                // bound is news the first time and a flood after that, and
                // `#961`'s "metrics can observe queue saturation" is served by
                // the counter either way.
                if total == 1 {
                    warn!(
                        "central outbox: the {} lane is at its bound — dropped the update \
                         for {:?}{closure} ({total} dropped)",
                        class.name(),
                        key,
                    );
                } else {
                    debug!(
                        "central outbox: the {} lane is at its bound — dropped the update \
                         for {:?}{closure} ({total} dropped)",
                        class.name(),
                        key,
                    );
                }
            }
        }
        Ok(())
    }

    /// What this outbox is holding, for logging and tests.
    pub fn snapshot(&self) -> OutboxSnapshot {
        snapshot(&self.shared.state)
    }
}

impl OutboxFrames {
    /// The next pending frame, waiting until one is published.
    ///
    /// `None` means no producer is left and nothing is pending — the outbox has
    /// ended, which is what the writer treats as a shutdown. Cancel-safe: it takes
    /// a frame only in the poll that returns it, and a wait that is dropped
    /// re-registers and looks again rather than losing the wake-up it was waiting
    /// for. The pending state is what is true; the notification is only how the
    /// writer finds out.
    pub async fn next(&mut self) -> Option<WsMessage> {
        loop {
            // Register before looking, so a publish that lands between the look
            // and the wait is not a lost wake-up.
            let available = Arc::clone(&self.available);
            let notified = available.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            if let Some(frame) = self.try_next() {
                return Some(frame);
            }
            // Nothing pending: is there anyone left who could publish again? The
            // order matters and is the one `crate::server::resize` uses — a frame
            // published while a writer existed is still owed to it, so draining
            // comes first and this is the end-of-lane check.
            self.shared.upgrade()?;

            notified.await;
        }
    }

    /// The next pending frame, if one is ready now.
    ///
    /// The classes are drained in a fixed order — heartbeats, addresses, session
    /// state, then resizes — so that a lane holding many sessions cannot keep the
    /// agent's liveness level behind them. *Which* pending session comes out first
    /// is not specified, on the same reasoning as `crate::server::resize`: each key
    /// holds one frame, so a caller's job is the same for any of them.
    pub fn try_next(&mut self) -> Option<WsMessage> {
        let mut state = lock(&self.state);
        for class in Class::ALL {
            let (room, _) = class.parts(&mut state);
            if let Some(frame) = take(room) {
                return Some(frame);
            }
        }
        None
    }

    /// What this outbox is holding, for logging and tests.
    pub fn snapshot(&self) -> OutboxSnapshot {
        snapshot(&self.state)
    }
}

impl Drop for OutboxFrames {
    fn drop(&mut self) {
        // The writer is gone, so nothing will ever be written from here. The flag
        // is what makes a publish say so instead of quietly filling a map nobody
        // drains — the same fact the channel this replaced reported by failing the
        // send.
        if let Some(shared) = self.shared.upgrade() {
            shared.closed.store(true, Ordering::SeqCst);
        }
    }
}

/// Take one frame out of a room, whichever key it belongs to.
fn take(room: &mut Room) -> Option<WsMessage> {
    let key = room.entries.keys().next()?.clone();
    let pending = room.entries.remove(&key)?;
    room.charged_bytes = room.charged_bytes.saturating_sub(pending.charged);
    Some(pending.message)
}

/// Every class's numbers, read from one instant.
fn snapshot(state: &Arc<StdMutex<State>>) -> OutboxSnapshot {
    let state = lock(state);
    OutboxSnapshot {
        heartbeat: Class::Heartbeat.snapshot(&state),
        addresses: Class::Addresses.snapshot(&state),
        session_state: Class::SessionState.snapshot(&state),
        resize: Class::Resize.snapshot(&state),
    }
}

/// The lock's contents, whether or not a panicking writer poisoned it.
///
/// There is nothing here that a panic could leave half-written — every section
/// moves one map entry and the counters beside it — so a poisoned lock still holds
/// exactly the frames it held, and refusing to read them would turn a panic
/// somewhere else into a permanently stalled outbox.
fn lock(state: &Arc<StdMutex<State>>) -> std::sync::MutexGuard<'_, State> {
    state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nession_runtime::outbound::FRAME_OVERHEAD;
    use std::time::Duration;

    /// An outbox, the writer that drains it, and the flag a refused
    /// session-state publish marks.
    fn outbox() -> (Outbox, OutboxFrames, Arc<AtomicBool>) {
        let sync_needed = Arc::new(AtomicBool::new(false));
        let (outbox, frames) = Outbox::new(Arc::clone(&sync_needed));
        (outbox, frames, sync_needed)
    }

    fn text(body: &str) -> WsMessage {
        WsMessage::Text(body.to_string())
    }

    /// The delivered frame's body, or a panic that says what arrived instead.
    fn body(frame: WsMessage) -> String {
        match frame {
            WsMessage::Text(text) => text,
            other => panic!("expected a text frame, got {other:?}"),
        }
    }

    /// A key's second publish replaces the first rather than queueing behind it.
    ///
    /// This is the whole difference between this and the unbounded queue it
    /// replaces, and the assertion is on *what was delivered*, not merely on how
    /// many: a lane that queued three heartbeats would deliver all three, and one
    /// that queued and dropped would deliver the stalest.
    #[test]
    fn a_second_publish_for_a_key_supersedes_the_first() {
        let (outbox, mut frames, _) = outbox();
        for n in 0..3 {
            outbox
                .send_heartbeat(text(&format!("heartbeat-{n}")))
                .expect("publish failed");
        }

        // Counted before the writer takes it: three publishes, one frame held.
        let snapshot = frames.snapshot();
        assert_eq!(snapshot.heartbeat.pending, 1);
        assert_eq!(snapshot.heartbeat.superseded, 2);
        assert_eq!(snapshot.heartbeat.dropped, 0, "superseding is not a drop");

        assert_eq!(
            body(frames.try_next().expect("nothing pending")),
            "heartbeat-2"
        );
        assert!(
            frames.try_next().is_none(),
            "a superseded heartbeat was still pending"
        );
        assert_eq!(frames.snapshot().heartbeat.pending, 0);
    }

    /// Two sessions are two levels: a publish for one does not supersede the
    /// other.
    ///
    /// The negative half is what a single slot for the whole lane would fail:
    /// with one slot, session B's update would replace session A's and A would
    /// never be delivered at all (one delivery, not two).
    #[test]
    fn two_sessions_do_not_supersede_each_other() {
        let (outbox, mut frames, _) = outbox();
        for (session, status) in [("s1", "active"), ("s2", "detached")] {
            outbox
                .send_session_update(session, text(&format!("{session}:{status}")))
                .expect("publish failed");
        }

        let mut delivered = vec![
            body(frames.try_next().expect("nothing pending")),
            body(frames.try_next().expect("only one session was delivered")),
        ];
        delivered.sort();
        assert_eq!(delivered, vec!["s1:active", "s2:detached"]);
        assert_eq!(frames.snapshot().session_state.pending, 0);
    }

    /// A flood of session updates holds one frame per session — never one per
    /// publish. This is the bound the unbounded channel did not have: with a
    /// producer that keeps polling, a stalled writer used to hold every
    /// intermediate state of every session.
    #[test]
    fn a_flood_of_session_updates_holds_one_frame_per_session() {
        let (outbox, frames, sync_needed) = outbox();
        const SESSIONS: usize = 4;
        const PUBLISHES: usize = 10_000;

        for n in 0..PUBLISHES {
            outbox
                .send_session_update(&format!("s{}", n % SESSIONS), text(&format!("update-{n}")))
                .expect("publish failed");
        }

        let snapshot = frames.snapshot().session_state;
        assert_eq!(
            snapshot.pending, SESSIONS,
            "the lane queued instead of holding"
        );
        assert_eq!(snapshot.superseded, (PUBLISHES - SESSIONS) as u64);
        assert_eq!(snapshot.dropped, 0);
        assert!(
            !sync_needed.load(Ordering::SeqCst),
            "nothing was refused, so nothing needs re-deriving"
        );
    }

    /// The resize class coalesces per session too, and for the same reason: a
    /// pane size is a level, so `#961`'s "可合并的高频状态（如 resize）允许
    /// coalesce" applies here exactly as it does to the agent's own resize lane.
    #[test]
    fn a_flood_of_resizes_holds_one_frame_per_session() {
        let (outbox, mut frames, _) = outbox();
        for n in 0..5_000u32 {
            let session = format!("agent-1:s{}", n % 3);
            outbox
                .send_terminal_resize(&session, text(&format!("{session}:{n}")))
                .expect("publish failed");
        }

        let snapshot = frames.snapshot().resize;
        assert_eq!(snapshot.pending, 3);
        assert_eq!(snapshot.dropped, 0);
        // The last publish for each session is the one that survived.
        let mut delivered = vec![
            body(frames.try_next().expect("nothing pending")),
            body(frames.try_next().expect("nothing pending")),
            body(frames.try_next().expect("nothing pending")),
        ];
        delivered.sort();
        assert_eq!(
            delivered,
            ["agent-1:s0:4998", "agent-1:s1:4999", "agent-1:s2:4997"].map(str::to_string)
        );
    }

    /// The finding, driven directly: a writer that never drains at all.
    ///
    /// No timing is involved — the writer is *absent*, which is the stalled
    /// socket's limit case — and the assertion is the pair of hard invariants
    /// every class holds to. Against the unbounded channel this replaced,
    /// `pending` would be every one of these publishes.
    #[test]
    fn a_stalled_writer_never_grows_the_outbox() {
        let (outbox, frames, _) = outbox();
        const KEYS: usize = 5_000;
        const ROUNDS: usize = 10;

        for n in 0..KEYS * ROUNDS {
            let session = format!("s{n}");
            outbox
                .send_session_update(&session, text("state"))
                .expect("publish failed");
            outbox
                .send_terminal_resize(&session, text("80x24"))
                .expect("publish failed");
            outbox.send_heartbeat(text("beat")).expect("publish failed");
            outbox
                .send_address_update(text("[]"))
                .expect("publish failed");
        }

        let snapshot = frames.snapshot();
        for class in Class::ALL {
            let class_snapshot = match class {
                Class::Heartbeat => snapshot.heartbeat,
                Class::Addresses => snapshot.addresses,
                Class::SessionState => snapshot.session_state,
                Class::Resize => snapshot.resize,
            };
            assert!(
                class_snapshot.pending <= class_snapshot.frame_slots,
                "{} held {} frames, past its {} bound",
                class.name(),
                class_snapshot.pending,
                class_snapshot.frame_slots,
            );
            assert!(
                class_snapshot.charged_bytes <= class_snapshot.byte_budget,
                "{} charged {} bytes, past its {} budget",
                class.name(),
                class_snapshot.charged_bytes,
                class_snapshot.byte_budget,
            );
        }
        // And the bound was actually *reached*: a test that never touches its
        // bound would pass against an unbounded implementation too.
        assert!(
            snapshot.session_state.dropped > 0,
            "the frame bound never fired"
        );
        assert!(snapshot.resize.dropped > 0, "the frame bound never fired");
    }

    /// A resource the lane is not holding, with no room for it, is dropped —
    /// and because the dropped class is the session registry, the connection is
    /// marked so the Server's view is re-derived rather than left stale.
    #[test]
    fn a_new_session_is_dropped_at_the_bound_and_marks_the_view() {
        let (outbox, mut frames, sync_needed) = outbox();
        for n in 0..SESSION_STATE_LIMITS.frames {
            outbox
                .send_session_update(&format!("s{n}"), text("state"))
                .expect("publish failed");
        }
        assert_eq!(
            frames.snapshot().session_state.pending,
            SESSION_STATE_LIMITS.frames
        );
        assert!(
            !sync_needed.load(Ordering::SeqCst),
            "the lane was not at its bound yet"
        );

        outbox
            .send_session_update("one-too-many", text("state"))
            .expect("a refused publish is not a failure");

        let snapshot = frames.snapshot().session_state;
        assert_eq!(snapshot.dropped, 1);
        assert_eq!(
            snapshot.pending, SESSION_STATE_LIMITS.frames,
            "a refused publish must not evict what was already there"
        );
        // The frame is still there for its own key: only the new one was refused.
        let mut remaining = 0;
        while frames.try_next().is_some() {
            remaining += 1;
        }
        assert_eq!(remaining, SESSION_STATE_LIMITS.frames);
        assert!(
            sync_needed.load(Ordering::SeqCst),
            "a dropped session update leaves the Server's view stale"
        );
    }

    /// The resize class is refused the same way, and deliberately does **not**
    /// mark the session view: a pane size is re-established by the attach path,
    /// not by re-reporting the session registry.
    #[test]
    fn a_dropped_resize_does_not_mark_the_view() {
        let (outbox, frames, sync_needed) = outbox();
        for n in 0..RESIZE_LIMITS.frames {
            outbox
                .send_terminal_resize(&format!("agent-1:s{n}"), text("80x24"))
                .expect("publish failed");
        }
        outbox
            .send_terminal_resize("agent-1:one-too-many", text("80x24"))
            .expect("a refused publish is not a failure");

        assert_eq!(frames.snapshot().resize.dropped, 1);
        assert!(
            !sync_needed.load(Ordering::SeqCst),
            "a resize is not session state and must not mark the session view"
        );
    }

    /// The byte budget binds on its own, on a lane with room to spare by frame
    /// count. A frame larger than the budget is charged the whole of it rather
    /// than refused — `charge`'s clamp, the same arithmetic
    /// `nession_runtime::outbound` states — so one such frame is what closes the
    /// lane to new keys.
    #[test]
    fn a_class_at_its_byte_budget_refuses_a_new_key() {
        let (outbox, frames, _) = outbox();
        let huge = "r".repeat(RESIZE_LIMITS.bytes);

        outbox
            .send_terminal_resize("agent-1:s1", text(&huge))
            .expect("the oversized frame is admitted, charged the whole budget");

        let snapshot = frames.snapshot().resize;
        assert_eq!(snapshot.charged_bytes, RESIZE_LIMITS.bytes);
        assert!(
            snapshot.pending < snapshot.frame_slots,
            "the frame count is nowhere near spent, so this is the byte bound"
        );

        outbox
            .send_terminal_resize("agent-1:s2", text("80x24"))
            .expect("a refused publish is not a failure");
        assert_eq!(frames.snapshot().resize.dropped, 1);
    }

    /// A replacement that does not fit even with the entry it supersedes
    /// refunded is refused like any other, and the frame already pending stays.
    ///
    /// The narrow case the delta rule exists for: the key keeps its slot
    /// normally, so the byte invariant has to be checked against what the
    /// *difference* costs rather than against an empty lane.
    #[test]
    fn a_replacement_that_does_not_fit_is_refused_and_keeps_the_pending_frame() {
        let (outbox, mut frames, _) = outbox();
        // Fill the budget exactly with two keys: the first large, the second
        // everything the first did not take.
        let big = "a".repeat(40 * 1024);
        let rest = "b"
            .repeat(RESIZE_LIMITS.bytes - FRAME_OVERHEAD - charge(big.len(), RESIZE_LIMITS.bytes));
        outbox
            .send_terminal_resize("agent-1:a", text(&big))
            .expect("publish failed");
        outbox
            .send_terminal_resize("agent-1:b", text(&rest))
            .expect("publish failed");
        assert_eq!(frames.snapshot().resize.charged_bytes, RESIZE_LIMITS.bytes);

        // Replacing the first with a frame that charges the whole budget would
        // need 40 KiB more than there is, even after refunding the 40 KiB it holds.
        outbox
            .send_terminal_resize("agent-1:a", text(&"c".repeat(RESIZE_LIMITS.bytes)))
            .expect("a refused publish is not a failure");

        let snapshot = frames.snapshot().resize;
        assert_eq!(snapshot.dropped, 1);
        assert_eq!(
            snapshot.superseded, 0,
            "the replacement was refused, not applied"
        );
        assert_eq!(
            snapshot.charged_bytes, RESIZE_LIMITS.bytes,
            "a refused replacement must not change what is charged"
        );

        // And the refused replacement changed nothing: the old frame is what is
        // pending.
        let mut bodies: Vec<String> = Vec::new();
        while let Some(frame) = frames.try_next() {
            bodies.push(body(frame));
        }
        bodies.sort_by_key(String::len);
        assert_eq!(bodies, [rest, big]);
    }

    /// The liveness class is drained first, so a lane holding many sessions
    /// cannot keep a heartbeat behind them.
    #[test]
    fn the_writer_drains_the_liveness_class_first() {
        let (outbox, mut frames, _) = outbox();
        for session in ["s1", "s2", "s3"] {
            outbox
                .send_session_update(session, text("state"))
                .expect("publish failed");
        }
        outbox.send_heartbeat(text("beat")).expect("publish failed");

        assert_eq!(body(frames.try_next().expect("nothing pending")), "beat");
    }

    /// Taking a frame gives its charge back, so a drained lane has its whole
    /// budget again. Without this the byte budget would only ever shrink, and a
    /// long-lived connection would close its own lanes.
    #[test]
    fn the_writer_taking_a_frame_returns_its_charge() {
        let (outbox, mut frames, _) = outbox();
        let huge = "r".repeat(RESIZE_LIMITS.bytes);
        outbox
            .send_terminal_resize("agent-1:s1", text(&huge))
            .expect("publish failed");
        assert_eq!(frames.snapshot().resize.charged_bytes, RESIZE_LIMITS.bytes);
        assert!(frames.try_next().is_some());

        let snapshot = frames.snapshot().resize;
        assert_eq!(snapshot.pending, 0);
        assert_eq!(snapshot.charged_bytes, 0, "the charge was not returned");

        // And the budget is usable again: a second key is admitted, not refused.
        outbox
            .send_terminal_resize("agent-1:s2", text("80x24"))
            .expect("publish failed");
        assert_eq!(frames.snapshot().resize.dropped, 0);
    }

    /// Every clone publishes into the same lanes: the lanes belong to the
    /// connection, not to a handle.
    #[test]
    fn every_clone_publishes_into_the_same_lanes() {
        let (outbox, mut frames, _) = outbox();
        let clone = outbox.clone();
        outbox
            .send_session_update("s1", text("first"))
            .expect("publish failed");
        clone
            .send_session_update("s1", text("second"))
            .expect("publish failed");

        assert_eq!(body(frames.try_next().expect("nothing pending")), "second");
        assert_eq!(frames.snapshot().session_state.pending, 0);
    }

    /// A writer that is gone is reported to the publisher rather than absorbed:
    /// without this, a publish would fill a map nobody will ever drain.
    #[test]
    fn a_closed_outbox_fails_every_publisher() {
        let (outbox, frames, _) = outbox();
        drop(frames);

        assert!(outbox.send_heartbeat(text("beat")).is_err());
        assert!(outbox.send_address_update(text("[]")).is_err());
        assert!(outbox.send_session_update("s1", text("state")).is_err());
        assert!(outbox
            .send_terminal_resize("agent-1:s1", text("80x24"))
            .is_err());
    }

    /// What was published before the last publisher left is still owed to the
    /// writer, and then the lane ends rather than parking forever.
    ///
    /// Both halves in this order, and read through `next` rather than
    /// `try_next`: the writer here is in the state it spends most of its life
    /// in — no publisher left, frames still pending — so a `next` that checked
    /// liveness before looking would end the lane with the frames still in it.
    #[tokio::test]
    async fn the_writer_drains_and_then_ends_when_the_last_publisher_is_dropped() {
        let sync_needed = Arc::new(AtomicBool::new(false));
        let (outbox, mut frames) = Outbox::new(Arc::clone(&sync_needed));
        outbox.send_heartbeat(text("beat")).expect("publish failed");
        outbox
            .send_session_update("s1", text("state"))
            .expect("publish failed");
        drop(outbox);

        let mut delivered = Vec::new();
        for _ in 0..2 {
            delivered.push(body(
                frames
                    .next()
                    .await
                    .expect("a published frame was lost to the drop"),
            ));
        }
        delivered.sort();
        assert_eq!(delivered, vec!["beat", "state"]);

        assert_eq!(
            frames.next().await,
            None,
            "a lane with no publisher must end its writer"
        );
    }

    /// A writer parked on an empty lane is woken by a publish — the case the
    /// notification exists for, and the one an implementation that only checked
    /// the map on the way in would miss.
    #[tokio::test]
    async fn a_parked_writer_is_woken_by_a_publish() {
        let (outbox, mut frames, _) = outbox();
        let writer = tokio::spawn(async move { frames.next().await });

        // Give the task every chance to park before the publish it must observe.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!writer.is_finished(), "the writer was not parked");

        outbox.send_heartbeat(text("beat")).expect("publish failed");

        let woken = tokio::time::timeout(Duration::from_secs(5), writer)
            .await
            .expect("the parked writer was never woken")
            .expect("the writer's task panicked");
        assert_eq!(woken.map(body), Some("beat".to_string()));
    }

    /// The teardown line names every class, because a bound whose numbers
    /// nobody reads is indistinguishable from a bound nobody checked.
    #[test]
    fn the_summary_names_every_class() {
        let (outbox, frames, _) = outbox();
        outbox
            .send_session_update("s1", text("state"))
            .expect("publish failed");
        let summary = frames.snapshot().summary();

        for class in Class::ALL {
            assert!(
                summary.contains(class.name()),
                "the summary does not name {}: {summary}",
                class.name()
            );
        }
        assert!(summary.starts_with("outbox: "), "{summary}");
        assert!(
            summary.contains(&format!("session-state 1/{}", SESSION_STATE_LIMITS.frames)),
            "{summary}"
        );
    }

    /// Each class holds and counts only its own publishes.
    ///
    /// All four classes are published into, with *different* counts and one
    /// extra key on the session-state lane, so a class reading another's frames
    /// or counters has to disagree about at least one number — a crossed mapping
    /// that happened to have equal counts would slip past this, which is why the
    /// counts are deliberately not equal.
    #[test]
    fn each_class_counts_its_own_publishes() {
        let (outbox, frames, _) = outbox();
        for _ in 0..2 {
            outbox.send_heartbeat(text("beat")).expect("publish failed");
        }
        for _ in 0..3 {
            outbox
                .send_address_update(text("[]"))
                .expect("publish failed");
        }
        for _ in 0..2 {
            outbox
                .send_session_update("s1", text("state"))
                .expect("publish failed");
        }
        for _ in 0..2 {
            outbox
                .send_terminal_resize("agent-1:s1", text("80x24"))
                .expect("publish failed");
        }
        outbox
            .send_session_update("s2", text("state"))
            .expect("publish failed");

        let snapshot = frames.snapshot();
        let expected = [
            ("heartbeat", snapshot.heartbeat, 1, 1),
            ("addresses", snapshot.addresses, 1, 2),
            ("session-state", snapshot.session_state, 2, 1),
            ("resize", snapshot.resize, 1, 1),
        ];
        for (name, class, pending, superseded) in expected {
            assert_eq!(class.pending, pending, "{name} reports the wrong frames");
            assert_eq!(
                class.superseded, superseded,
                "{name} counts the wrong supersessions"
            );
            assert_eq!(class.dropped, 0, "{name} counts a drop that never happened");
        }
    }
}
