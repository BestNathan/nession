//! Real-time stream domain classification and resource fences (#4435).
//!
//! A wire's **stream class** is a property of what the bytes mean to a live
//! session, and it is deliberately independent of the Protocol Kernel category
//! (operation / notification / control). `agent.terminal.output` is a
//! notification *and* recoverable ordered output; `control.heartbeat` is a
//! control wire *and* latest-state; `agent.terminal.input` is an operation in
//! the router's table *and* loss-intolerant ordered input. Deriving the class
//! from the kernel category would collapse exactly the distinctions this module
//! exists to keep.
//!
//! ## The classes
//!
//! | class | examples | loss policy |
//! |---|---|---|
//! | [`WireClass::ReliableInput`] | `agent.terminal.input` | never silently lost or blindly replayed; overflow is an explicit refusal with the current input cursor restated |
//! | [`WireClass::RecoverableOutput`] | `agent.terminal.output`, recorded `terminal.resize` | ordered; loss is detected as a gap and repaired through the existing replay/checkpoint path |
//! | [`WireClass::LatestState`] | heartbeat, address/session updates, a legacy level resize | coalesced per `(incarnation, key)`; only a newer generation replaces a pending level, and an incompatible incarnation requires a resync rather than a merge |
//! | [`WireClass::StreamFlowControl`] | input ACK, parser progress, reconcile notice | bookkeeping for one stream; never general RPC work and never answered as a unit |
//! | [`WireClass::Control`] | attach/detach, lease acquire, stream resume, resize request | dependency-carrying; the Session owner serializes or rejects stale frames |
//!
//! ## Three budgets, three owners
//!
//! These are deliberately separate numbers, and no admission below consumes
//! another budget's capacity:
//!
//! * **Per-stream window** ([`SUBSCRIBER_WINDOW`], [`INPUT_WINDOW`]) — what one
//!   subscription or one input sender may have in flight. Frames *and* bytes,
//!   because a flood of tiny frames and one oversized frame bind on different
//!   units.
//! * **Per-runtime retention** ([`RUNTIME_RETENTION_EVENTS`],
//!   [`RUNTIME_RETENTION_BYTES`], [`RUNTIME_RETENTION_AGE_SECS`]) — the
//!   Session's bounded replay ring. Its owner is
//!   [`crate::session::terminal::state::SessionStreamState`], not a subscriber.
//! * **General RPC permits** — the connection's reply/terminal lanes
//!   ([`crate::server::outbound`]). A stream admission never blocks or consumes
//!   one, and the physical reader is never parked on a stream decision.
//!
//! ## Events
//!
//! [`StreamEvent`] is the observation vocabulary. Every variant states its unit
//! in its field names: lag is in queued frames and bytes, a gap is in stream
//! sequence ordinals, reconcile names the required frontier, and coalescence
//! counts superseded events and merged bytes. A caller that cannot say the unit
//! cannot report the event.

use std::fmt;

/// What a live wire means to a stream, independent of its kernel category.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WireClass {
    /// Loss and duplication both change the user's command stream.
    ReliableInput,
    /// Ordered output/log events that a provider can replay from its window.
    RecoverableOutput,
    /// A level where only the newest value matters.
    LatestState,
    /// Per-stream flow-control bookkeeping (ACK, parser progress, reconcile).
    StreamFlowControl,
    /// Request/response or dependency-carrying control.
    Control,
}

impl WireClass {
    /// The class name, for logs and evidence.
    pub const fn name(self) -> &'static str {
        match self {
            Self::ReliableInput => "reliable-input",
            Self::RecoverableOutput => "recoverable-output",
            Self::LatestState => "latest-state",
            Self::StreamFlowControl => "stream-flow-control",
            Self::Control => "control",
        }
    }

    /// The outbound lane this class must use, if it has one.
    ///
    /// `None` is the honest answer for [`Self::ReliableInput`]: it travels
    /// inbound, and a caller that tries to send it outbound has made a routing
    /// mistake rather than discovered a new lane.
    pub const fn outbound(self) -> Option<OutboundStreamClass> {
        match self {
            Self::ReliableInput => None,
            Self::RecoverableOutput => Some(OutboundStreamClass::OrderedOutput),
            Self::LatestState => Some(OutboundStreamClass::LatestState),
            Self::StreamFlowControl => Some(OutboundStreamClass::FlowControl),
            Self::Control => Some(OutboundStreamClass::Reply),
        }
    }
}

/// The existing outbound lanes, named by what a stream needs rather than by
/// the queue's internal spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboundStreamClass {
    /// Non-dropping, ordered delivery with the terminal stall deadline.
    OrderedOutput,
    /// Droppable level delivery; the peer restates it.
    LatestState,
    /// Non-dropping stream bookkeeping that must precede its request's reply
    /// (terminal input ACK, lease-change notice).
    FlowControl,
    /// One-off attach history (bootstrap capture, atomic output prefix): a
    /// response to attach, ordered before its `ok`, not steady output.
    AttachHistory,
    /// A reply the peer is waiting for; waits for room and never drops.
    Reply,
}

/// Classify a wire from its `msg_type`.
///
/// Unknown wires are [`WireClass::Control`]: they are forwarded unchanged by the
/// Relay and carry no stream-data guarantee that this module could claim on
/// their behalf. This is a *classification*, never a router.
pub fn classify_wire(msg_type: &str) -> WireClass {
    match msg_type {
        // Inbound terminal bytes.
        "agent.terminal.input" => WireClass::ReliableInput,

        // Ordered output and the authoritative resize that shares its timeline.
        "agent.terminal.output" => WireClass::RecoverableOutput,

        // Per-stream flow control, not general RPC work.
        "agent.terminal.input.ack"
        | "client.terminal.output.progress"
        | "agent.terminal.output.applied"
        | "agent.terminal.reconcile-required" => WireClass::StreamFlowControl,

        // Levels whose newest value is the only one that matters.
        "control.heartbeat"
        | "control.pong"
        | "server.agent.address-update"
        | "server.agent.session-update"
        | "server.agent.git-invalidated" => WireClass::LatestState,

        // Dependency-carrying control. A *recorded* authoritative resize is an
        // ordered timeline event and is sent on the ordered-output lane by the
        // owner that recorded it; the bare wire name cannot distinguish that
        // from a legacy level, so the conservative class is control.
        _ => WireClass::Control,
    }
}

/// Which budget an overflow exceeded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowUnit {
    Frames,
    Bytes,
}

impl WindowUnit {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Frames => "frames",
            Self::Bytes => "bytes",
        }
    }
}

/// A finite stream admission that was refused, with the numbers that refused it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamOverflow {
    pub unit: WindowUnit,
    pub limit: u64,
    pub in_use: u64,
    pub requested: u64,
}

impl fmt::Display for StreamOverflow {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "stream {} limit {} exceeded: {} already in flight, {} requested",
            self.unit.name(),
            self.limit,
            self.in_use,
            self.requested
        )
    }
}

/// One stream's finite frame/byte window.
///
/// Admission is a pure, non-blocking decision: there is no wait, no queue and
/// no "try again later". A refusal is the answer, and the caller decides the
/// recovery (explicit refusal for input, gap/replay for output).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamLimits {
    pub frames: u64,
    pub bytes: u64,
}

impl StreamLimits {
    pub const fn new(frames: u64, bytes: u64) -> Self {
        Self { frames, bytes }
    }

    /// Admit `frames`/`bytes` on top of what is already in flight.
    ///
    /// Frames are checked first because they are the cheaper verdict to state
    /// and the one a flood reaches first; the returned unit says which bound
    /// actually refused the request.
    pub fn try_admit(
        &self,
        in_use_frames: u64,
        in_use_bytes: u64,
        frames: u64,
        bytes: u64,
    ) -> Result<(), StreamOverflow> {
        if in_use_frames.saturating_add(frames) > self.frames {
            return Err(StreamOverflow {
                unit: WindowUnit::Frames,
                limit: self.frames,
                in_use: in_use_frames,
                requested: frames,
            });
        }
        if in_use_bytes.saturating_add(bytes) > self.bytes {
            return Err(StreamOverflow {
                unit: WindowUnit::Bytes,
                limit: self.bytes,
                in_use: in_use_bytes,
                requested: bytes,
            });
        }
        Ok(())
    }

    /// The largest base64-encoded input frame that could decode inside this
    /// byte budget. Checked before decoding so an oversized frame never
    /// allocates its own refusal.
    pub const fn max_base64_bytes(&self) -> u64 {
        // ceil(bytes / 3) * 4, for the standard alphabet with padding.
        self.bytes.div_ceil(3) * 4
    }
}

/// The subscriber window's frame bound, in the unit the channel takes.
pub const SUBSCRIBER_WINDOW_FRAMES: usize = 16_384;
/// The subscriber window's byte bound, in the unit the queue charges.
pub const SUBSCRIBER_WINDOW_BYTES: usize = 2 * 1024 * 1024;

/// One subscription's live queue: 16 384 frames or 2 MiB, whichever binds first.
///
/// The unit is the *dequeued* terminal event. The byte figure is the memory
/// bound; the frame count is the metadata backstop. The owner is the per-peer
/// fan-out in [`crate::session::terminal::runtime`]; this constant is where the
/// number is stated once.
pub const SUBSCRIBER_WINDOW: StreamLimits = StreamLimits::new(
    SUBSCRIBER_WINDOW_FRAMES as u64,
    SUBSCRIBER_WINDOW_BYTES as u64,
);

/// The input window's chunk bound, in the unit an input frame claims.
pub const INPUT_WINDOW_FRAMES: usize = 128;
/// The input window's byte bound, in decoded bytes.
pub const INPUT_WINDOW_BYTES: usize = 1024 * 1024;

/// One input sender's unacknowledged run, mirroring the browser's measured
/// `PendingInputQueue` bounds (128 chunks / 1 MiB).
///
/// The Agent applies one frame whole and advances its cursor by the chunk range
/// the frame claims, so the window is a bound on **how far ahead of the applied
/// cursor one frame may reach** — not on a queue the Agent keeps. Overflow is
/// refused before the PTY write, with the current cursor restated.
pub const INPUT_WINDOW: StreamLimits =
    StreamLimits::new(INPUT_WINDOW_FRAMES as u64, INPUT_WINDOW_BYTES as u64);

/// The Session replay ring's event bound.
pub const RUNTIME_RETENTION_EVENTS: usize = 4096;
/// The Session replay ring's byte bound.
pub const RUNTIME_RETENTION_BYTES: usize = 512 * 1024;
/// The Session replay ring's age bound, in seconds.
pub const RUNTIME_RETENTION_AGE_SECS: u64 = 300;

/// Why a stream needs reconciliation rather than a merge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconcileReason {
    /// The parser reported an epoch this subscription no longer belongs to.
    EpochChanged,
    /// The pinned renderer was replaced without a new subscription.
    RendererReplaced,
    /// The parser claimed a frontier beyond what this subscriber was issued.
    ParserAheadOfIssued,
    /// A latest-state incarnation/key changed, so the old value must not merge.
    IncarnationChanged,
    /// A finite window refused an event; the stream must resync.
    Overflow,
}

/// The stream observation vocabulary. Field names state the unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamEvent {
    /// A subscriber's live queue is behind: frames and bytes pending.
    Lag {
        queued_frames: u64,
        queued_bytes: u64,
    },
    /// A raw sequence gap: `missing_ordinals` ordinals are absent between the
    /// received and expected stream sequence numbers.
    Gap {
        expected_seq: u64,
        received_seq: u64,
        missing_ordinals: u64,
    },
    /// A stream identity/flow inconsistency that requires the named frontier.
    Reconcile {
        reason: ReconcileReason,
        required_through_seq: u64,
    },
    /// A latest-state publish folded into/against what was pending.
    Coalesce {
        superseded_events: u64,
        merged_bytes: u64,
    },
}

impl StreamEvent {
    pub const fn lag(queued_frames: u64, queued_bytes: u64) -> Self {
        Self::Lag {
            queued_frames,
            queued_bytes,
        }
    }

    pub const fn gap(expected_seq: u64, received_seq: u64) -> Self {
        Self::Gap {
            expected_seq,
            received_seq,
            missing_ordinals: received_seq.saturating_sub(expected_seq),
        }
    }

    pub const fn reconcile(reason: ReconcileReason, required_through_seq: u64) -> Self {
        Self::Reconcile {
            reason,
            required_through_seq,
        }
    }

    pub const fn coalesce(superseded_events: u64, merged_bytes: u64) -> Self {
        Self::Coalesce {
            superseded_events,
            merged_bytes,
        }
    }
}

/// The identity a latest-state level belongs to.
///
/// `incarnation` is the resource generation (a stream epoch, a session instance
/// id, a provider incarnation); `key` is the sub-resource inside it. Neither is
/// optional: a level that cannot name its incarnation cannot safely merge with
/// anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LatestStateIdentity {
    pub incarnation: u64,
    pub key: String,
    pub generation: u64,
}

/// What a latest-state publish may do against what is pending.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LatestStateVerdict {
    /// Same incarnation and key, newer generation: replace the pending level.
    Coalesced,
    /// Same incarnation and key, equal or older generation: keep what is
    /// pending and ignore this publish.
    Superseded,
    /// A different incarnation or key: do not merge. Replace and resync.
    ResyncRequired,
}

/// Decide whether one latest-state publish may coalesce with a pending level.
///
/// This is a **decision**, not a queue: the canonical Agent queue remains the
/// central state outbox ([`crate::connection::outbox`]), which already coalesces
/// per key. This function states the compatibility rule that outbox and future
/// Claude/Codex/build providers must share so that a level from a retired
/// incarnation can never be folded into its successor.
pub fn classify_latest_state(
    pending: Option<&LatestStateIdentity>,
    incoming: &LatestStateIdentity,
) -> LatestStateVerdict {
    let Some(pending) = pending else {
        return LatestStateVerdict::Coalesced;
    };
    if pending.incarnation != incoming.incarnation || pending.key != incoming.key {
        return LatestStateVerdict::ResyncRequired;
    }
    if incoming.generation > pending.generation {
        LatestStateVerdict::Coalesced
    } else {
        LatestStateVerdict::Superseded
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_real_time_class_is_distinct_from_the_kernel_route() {
        // The point of the classification: these wires are all *operations* or
        // *notifications* in the Protocol Kernel and still split across three
        // stream classes.
        assert_eq!(
            classify_wire("agent.terminal.input"),
            WireClass::ReliableInput
        );
        assert_eq!(
            classify_wire("agent.terminal.output"),
            WireClass::RecoverableOutput
        );
        assert_eq!(classify_wire("control.heartbeat"), WireClass::LatestState);
        assert_eq!(
            classify_wire("client.terminal.output.progress"),
            WireClass::StreamFlowControl
        );
        assert_eq!(
            classify_wire("agent.terminal.control.acquire"),
            WireClass::Control
        );
        // An unrecognised wire is never claimed as stream data.
        assert_eq!(classify_wire("agent.unknown.thing"), WireClass::Control);
    }

    #[test]
    fn classification_matches_the_wire_constants_the_handlers_use() {
        use crate::server::websocket::msg_types;
        assert_eq!(
            classify_wire(msg_types::TERMINAL_INPUT),
            WireClass::ReliableInput
        );
        assert_eq!(
            classify_wire(msg_types::TERMINAL_OUTPUT),
            WireClass::RecoverableOutput
        );
        assert_eq!(
            classify_wire(msg_types::TERMINAL_INPUT_ACK),
            WireClass::StreamFlowControl
        );
        assert_eq!(
            classify_wire(msg_types::TERMINAL_OUTPUT_PROGRESS),
            WireClass::StreamFlowControl
        );
        assert_eq!(
            classify_wire(msg_types::TERMINAL_RESIZE),
            WireClass::Control
        );
    }

    #[test]
    fn input_has_no_outbound_lane() {
        assert_eq!(WireClass::ReliableInput.outbound(), None);
        assert_eq!(
            WireClass::RecoverableOutput.outbound(),
            Some(OutboundStreamClass::OrderedOutput)
        );
        assert_eq!(
            WireClass::LatestState.outbound(),
            Some(OutboundStreamClass::LatestState)
        );
        assert_eq!(
            WireClass::StreamFlowControl.outbound(),
            Some(OutboundStreamClass::FlowControl)
        );
        assert_eq!(
            WireClass::Control.outbound(),
            Some(OutboundStreamClass::Reply)
        );
    }

    /// Two streams have two windows: saturating one must not refuse the other,
    /// and neither consumes the other's capacity.
    #[test]
    fn finite_stream_admission_is_independent_per_stream() {
        let limits = StreamLimits::new(2, 10);
        let mut slow = (0_u64, 0_u64);
        let healthy = (0_u64, 0_u64);

        assert_eq!(limits.try_admit(slow.0, slow.1, 1, 5), Ok(()));
        slow = (1, 5);
        assert_eq!(limits.try_admit(slow.0, slow.1, 1, 5), Ok(()));
        slow = (2, 10);

        // The slow stream is full; the healthy one still has its whole window.
        let refused = limits
            .try_admit(slow.0, slow.1, 1, 0)
            .expect_err("the slow stream is at its frame bound");
        assert_eq!(refused.unit, WindowUnit::Frames);
        assert_eq!(refused.limit, 2);
        assert_eq!(refused.in_use, 2);
        assert_eq!(refused.requested, 1);
        assert_eq!(limits.try_admit(healthy.0, healthy.1, 1, 5), Ok(()));
        assert_eq!(
            limits.try_admit(0, 0, 3, 0),
            Err(StreamOverflow {
                unit: WindowUnit::Frames,
                limit: 2,
                in_use: 0,
                requested: 3,
            })
        );
    }

    #[test]
    fn the_byte_bound_is_reported_with_its_own_unit() {
        let limits = StreamLimits::new(128, 10);
        let refused = limits
            .try_admit(0, 9, 1, 2)
            .expect_err("the byte bound, not the frame bound, refused this");
        assert_eq!(refused.unit, WindowUnit::Bytes);
        assert_eq!(refused.in_use, 9);
        assert_eq!(refused.requested, 2);
        assert_eq!(
            refused.to_string(),
            "stream bytes limit 10 exceeded: 9 already in flight, 2 requested"
        );
    }

    #[test]
    fn input_window_mirrors_the_measured_client_bounds() {
        assert_eq!(INPUT_WINDOW.frames, 128);
        assert_eq!(INPUT_WINDOW.bytes, 1024 * 1024);
        assert_eq!(SUBSCRIBER_WINDOW.frames, 16_384);
        assert_eq!(SUBSCRIBER_WINDOW.bytes, 2 * 1024 * 1024);
        // A 1 MiB decoded frame can need 1 398 104 base64 characters; the
        // pre-decode check must admit exactly that and refuse one more.
        assert_eq!(INPUT_WINDOW.max_base64_bytes(), 1_398_104);
        assert!(1024 * 1024 <= INPUT_WINDOW.max_base64_bytes());
    }

    fn identity(incarnation: u64, key: &str, generation: u64) -> LatestStateIdentity {
        LatestStateIdentity {
            incarnation,
            key: key.to_string(),
            generation,
        }
    }

    #[test]
    fn latest_state_coalesces_only_within_one_incarnation_and_key() {
        let pending = identity(7, "session-a", 3);
        assert_eq!(
            classify_latest_state(Some(&pending), &identity(7, "session-a", 4)),
            LatestStateVerdict::Coalesced
        );
        assert_eq!(
            classify_latest_state(Some(&pending), &identity(7, "session-a", 3)),
            LatestStateVerdict::Superseded,
            "an equal generation is not newer; the pending level already says it"
        );
        assert_eq!(
            classify_latest_state(Some(&pending), &identity(7, "session-a", 2)),
            LatestStateVerdict::Superseded
        );
        assert_eq!(
            classify_latest_state(Some(&pending), &identity(8, "session-a", 99)),
            LatestStateVerdict::ResyncRequired,
            "a higher generation from a replacement incarnation must not merge"
        );
        assert_eq!(
            classify_latest_state(Some(&pending), &identity(7, "session-b", 99)),
            LatestStateVerdict::ResyncRequired
        );
        assert_eq!(
            classify_latest_state(None, &pending),
            LatestStateVerdict::Coalesced,
            "nothing pending means the first level is accepted"
        );
    }

    #[test]
    fn gap_events_state_the_missing_ordinal_count() {
        assert_eq!(
            StreamEvent::gap(11, 15),
            StreamEvent::Gap {
                expected_seq: 11,
                received_seq: 15,
                missing_ordinals: 4,
            }
        );
        // A received position behind the expectation is not a negative gap.
        assert_eq!(
            StreamEvent::gap(15, 11),
            StreamEvent::Gap {
                expected_seq: 15,
                received_seq: 11,
                missing_ordinals: 0,
            }
        );
    }
}
