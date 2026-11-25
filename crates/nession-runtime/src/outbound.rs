//! One connection's classified outbound path: explicit Control / Response /
//! Stream queues, a bounded fair scheduler, and exact accounting (`#4434`).
//!
//! `#961-F` converged three copies of *one* bounded queue. That was the right
//! mechanism while every message on a socket shared a failure mode, but it was
//! never true of the messages themselves: a captured reply, a terminal chunk
//! and a keepalive do not have the same size, the same producer, or the same
//! sensible answer when the queue is full. `#4434` is where the queue stops
//! pretending otherwise.
//!
//! ## Classes, and reserved capacity
//!
//! [`FrameClass`] has three values, and each has its own byte budget and frame
//! budget ([`ClassLimits`]). "Reserved" is literal: the control budget is not
//! reachable by a stream producer, so a backlog of terminal bytes cannot make
//! the next keepalive or command unsendable. That is the fix for the shared
//! 8/4 MiB queue this replaces, where one large reply could occupy the whole
//! byte budget and a state push or a ping would find "no room".
//!
//! Whichever of a class's two bounds is reached first is the effective bound.
//! The arithmetic is explicit rather than clamped:
//!
//! * a frame is charged `payload + FRAME_OVERHEAD` **exactly**;
//! * a frame larger than its class's byte budget is refused with
//!   [`OutboundError::TooLarge`], never charged as though it were smaller.
//!   Supported maximum frame size *is* the class's byte budget, and the owning
//!   wire contracts cap legitimate payloads below it (1 MiB reads, capture
//!   previews in the hundreds of KiB). A caller that legitimately needs to send
//!   more must chunk it under its own wire contract; silently mis-accounting it
//!   is the bug this rule exists to prevent.
//!
//! ## What is counted
//!
//! The byte and frame budgets are held by an [`OwnedSemaphorePermit`] pair on
//! each [`QueuedFrame`], released when the writer drops the frame — *after* it
//! has been handed to the socket. So the budget bounds queued **plus in-flight**
//! bytes, not merely accepted ones. A producer that has reserved its class's
//! bytes and is still waiting for a frame slot is counted too: its reservation
//! is part of what the budget bounds.
//!
//! [`ProcessAccounting`] adds the same two figures across every connection in
//! the process, behind `AtomicUsize` counters. It is accounting, not a second
//! global cap: a per-connection bound is what keeps one peer from costing the
//! machine, and a process figure is what an operator needs to see that cost.
//!
//! ## The scheduler
//!
//! [`OutboundReceiver::recv`] is the only consumer, and it is a scheduler rather
//! than a FIFO:
//!
//! * **Control** is served first, for at most [`SchedulerConfig::control_burst`]
//!   consecutive frames before a lower class gets a turn. Bounded, so a control
//!   flood cannot starve responses or a terminal stream.
//! * **Response** and **Stream** are served by deficit round robin in *bytes*,
//!   with a response quantum that is larger by default. A response is therefore
//!   protected under a continuously backlogged stream, while the stream's own
//!   quantum guarantees it still makes progress under a response burst.
//! * No class is promised preemption of a write already in flight. Physical TCP
//!   head-of-line blocking is bounded by the write deadline in
//!   [`crate::lifecycle`], not hidden by the scheduler.
//!
//! ## Submission verdicts
//!
//! [`Outbound::submit`] returns [`SubmitOutcome`] — accepted, refused with a
//! reason, or closed — rather than a bare result, because "the queue is full and
//! this class does not wait" is a policy fact the caller must be able to turn
//! into the right answer (fail the request, drop a level, or end the peer).
//! [`WaitPolicy`] makes waiting explicit: a non-droppable response may wait
//! until the connection closes; a stream frame waits up to its finite stall
//! grace; a control/state frame never waits. There is no default that silently
//! parks a producer forever.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tokio::sync::{mpsc, Notify, OwnedSemaphorePermit, Semaphore};
use tracing::{debug, warn};

use crate::frame::WsFrame;
use crate::metrics::{self, Direction, Domain, Labels, ReasonKind, ResultKind};

/// What the WebSocket frame header costs beyond the payload `WsFrame::len`
/// reports. Charged so a queue full of small frames is priced honestly.
pub const FRAME_OVERHEAD: usize = 14;

/// The three classes a socket's outbound frames belong to.
///
/// The class is a property of what the frame *is*, not of what it contains: a
/// terminal chunk is always `Stream`, whatever its size, because a slow peer's
/// correct treatment of it is the same every time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FrameClass {
    /// Keepalive, close, command and state-push frames. Reserved capacity;
    /// served first but in a bounded burst; never waits for room at the bound.
    Control,
    /// An answer to a request the peer made. Never silently dropped: waits for
    /// room until the connection closes.
    Response,
    /// Terminal output and other steady, non-droppable streams. Waits up to a
    /// finite stall grace, then becomes a verdict about the peer.
    Stream,
}

impl FrameClass {
    pub const ALL: [FrameClass; 3] = [Self::Control, Self::Response, Self::Stream];

    /// The dispatch domain this class belongs to, for telemetry. A refusal or
    /// write timeout must be attributable to Control, Request or Stream rather
    /// than all being reported as stream events (#4434).
    pub const fn domain(self) -> Domain {
        match self {
            Self::Control => Domain::Control,
            Self::Response => Domain::Request,
            Self::Stream => Domain::Stream,
        }
    }

    pub fn index(self) -> usize {
        match self {
            Self::Control => 0,
            Self::Response => 1,
            Self::Stream => 2,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Control => "control",
            Self::Response => "response",
            Self::Stream => "stream",
        }
    }
}

/// The two bounds one class holds to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClassLimits {
    /// How many bytes may be outstanding (queued, reserved or in flight).
    pub bytes: usize,
    /// How many frames may be outstanding (queued, reserved or in flight).
    pub frames: usize,
}

impl ClassLimits {
    /// Normalize a class's bounds so a zero frame slot cannot deadlock every
    /// producer. A byte budget smaller than one header is raised to it: a class
    /// that could not accept even an empty frame is not a bound, it is an
    /// outage.
    pub const fn normalized(self) -> Self {
        Self {
            bytes: if self.bytes < FRAME_OVERHEAD {
                FRAME_OVERHEAD
            } else {
                self.bytes
            },
            frames: if self.frames == 0 { 1 } else { self.frames },
        }
    }
}

/// One connection's three class bounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClassifiedLimits {
    pub control: ClassLimits,
    pub response: ClassLimits,
    pub stream: ClassLimits,
}

impl ClassifiedLimits {
    /// The same bound for every class.
    ///
    /// Deliberately available but deliberately *not* what a production adapter
    /// should use: a uniform-class call is a statement that the caller has not
    /// decided what each class may cost, which is the shared-queue problem in a
    /// different spelling.
    pub fn uniform(limits: Limits) -> Self {
        let class = ClassLimits {
            bytes: limits.bytes,
            frames: limits.frames,
        };
        Self {
            control: class,
            response: class,
            stream: class,
        }
    }

    pub fn for_class(self, class: FrameClass) -> ClassLimits {
        match class {
            FrameClass::Control => self.control,
            FrameClass::Response => self.response,
            FrameClass::Stream => self.stream,
        }
        .normalized()
    }

    pub fn total_bytes(self) -> usize {
        FrameClass::ALL
            .into_iter()
            .map(|class| self.for_class(class).bytes)
            .sum()
    }

    pub fn total_frames(self) -> usize {
        FrameClass::ALL
            .into_iter()
            .map(|class| self.for_class(class).frames)
            .sum()
    }
}

/// The verdicts this queue can hand a producer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboundError {
    /// The writer is gone — the connection has ended, and this frame will never
    /// be written by this path.
    Closed,
    /// The queue is at its bound and this lane does not wait for room.
    Saturated,
    /// The queue was at its bound for the whole wait the caller allowed. For a
    /// stream frame that is a statement about the peer; for a finite-wait
    /// caller it is a statement about the deadline.
    Stalled,
    /// The frame is larger than its class's supported maximum. Refused rather
    /// than clamped: `size` and `limit` are the real numbers.
    TooLarge { size: usize, limit: usize },
    /// The submission carried a generation that a newer connection has
    /// superseded.
    StaleGeneration,
}

impl std::fmt::Display for OutboundError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Closed => write!(f, "the connection's outbound path is closed"),
            Self::Saturated => write!(f, "the outbound queue is at its bound"),
            Self::Stalled => write!(
                f,
                "the outbound queue stayed full for the wait the caller allowed"
            ),
            Self::TooLarge { size, limit } => write!(
                f,
                "the frame is {size} bytes charged against a {limit}-byte class budget"
            ),
            Self::StaleGeneration => write!(
                f,
                "the submission belongs to a generation the connection has superseded"
            ),
        }
    }
}

impl std::error::Error for OutboundError {}

/// The explicit result of one classified submission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmitOutcome {
    /// The frame is queued (or was handed to the scheduler) and holds its
    /// class's budget.
    Accepted,
    /// The frame was refused, with the reason. Nothing was charged.
    Refused(OutboundError),
    /// The connection's outbound path is over.
    Closed,
}

impl SubmitOutcome {
    pub fn accepted(self) -> bool {
        matches!(self, Self::Accepted)
    }

    /// Fold the explicit verdict into the conventional `Result` the adapters'
    /// policy code already speaks.
    pub fn into_result(self) -> Result<(), OutboundError> {
        match self {
            Self::Accepted => Ok(()),
            Self::Refused(error) => Err(error),
            Self::Closed => Err(OutboundError::Closed),
        }
    }
}

/// How long a submission may wait for room.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitPolicy {
    /// Never wait: refuse if there is no room now. Control/state policy.
    NoWait,
    /// Wait until room appears or the connection closes. Non-droppable
    /// response policy.
    UntilClosed,
    /// Wait at most this long. Stream policy.
    Finite(Duration),
}

/// The two bounds one connection's queue holds to, in the uniform form kept for
/// the coalescing outbox (`nession-agent::connection::outbox`), which is not a
/// socket queue and chooses its own per-class bounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// How many bytes may be queued before producers wait.
    pub bytes: usize,
    /// How many frames may be queued before producers wait.
    pub frames: usize,
}

/// The scheduler's three knobs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SchedulerConfig {
    /// Most consecutive control frames before a lower class gets a turn.
    pub control_burst: usize,
    /// Bytes served to the response class per round.
    pub response_quantum: usize,
    /// Bytes served to the stream class per round.
    pub stream_quantum: usize,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            control_burst: 4,
            response_quantum: 64 * 1024,
            stream_quantum: 32 * 1024,
        }
    }
}

/// One frame waiting to be written, holding every claim that lets it wait
/// there.
#[non_exhaustive]
pub struct QueuedFrame {
    pub class: FrameClass,
    /// The ownership generation this frame was submitted under.
    pub generation: u64,
    pub message: WsFrame,
    /// This frame's exact charge on its class's byte budget. Held until the
    /// writer is done with it.
    pub budget: OwnedSemaphorePermit,
    /// This frame's claim on its class's frame budget, held the same way.
    pub slot: OwnedSemaphorePermit,
    /// The exact bytes charged (payload + header). Public so a test can assert
    /// the arithmetic without recomputing what the frame holds.
    pub charged: usize,
    /// Held only for its `Drop`, which releases the process counters.
    _process: ProcessCharge,
    marker: QueuedMarker,
}

impl QueuedFrame {
    fn mark_dequeued(&mut self) {
        self.marker.dequeue();
    }

    /// Split the frame into its payload and the ownership the writer must hold
    /// for the duration of the write.
    ///
    /// A plain `let QueuedFrame { message, budget, .. } = frame` drops the
    /// class frame slot and the process charge at the end of that statement —
    /// before the write — so the in-flight frame would be invisible to both
    /// bounds and a writer parked in `send` would hold neither (#4434). The
    /// returned [`FrameCharge`] keeps every claim alive until the caller drops
    /// it after the write.
    #[must_use = "the charge must be held across the write; dropping it releases the budgets early"]
    pub fn into_write_parts(self) -> (WsFrame, FrameCharge) {
        let QueuedFrame {
            message,
            budget,
            slot,
            _process,
            ..
        } = self;
        (
            message,
            FrameCharge {
                _budget: budget,
                _slot: slot,
                _process,
            },
        )
    }
}

/// Every resource one in-flight frame holds, kept alive until the write ends.
///
/// The class byte permit, the class frame slot and the process charge are all
/// released together on drop, which is the moment the frame is no longer
/// in flight.
pub struct FrameCharge {
    _budget: OwnedSemaphorePermit,
    _slot: OwnedSemaphorePermit,
    _process: ProcessCharge,
}

/// What makes the in-channel count stop including a frame.
///
/// A field with its own `Drop` rather than an `impl Drop` on [`QueuedFrame`]:
/// the writer's `let QueuedFrame { message, budget, .. } = frame` needs to move
/// the payload and the permits out, and a `Drop` on the outer type would forbid
/// that. The count is released exactly when the frame is deqeued or dropped.
struct QueuedMarker {
    counter: Arc<AtomicUsize>,
    queued: bool,
}

impl QueuedMarker {
    fn dequeue(&mut self) {
        if self.queued {
            self.queued = false;
            self.counter.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

impl Drop for QueuedMarker {
    fn drop(&mut self) {
        self.dequeue();
    }
}

/// Per-connection observable state, including the in-flight frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueueSnapshot {
    /// Bytes outstanding: queued, reserved by a waiting producer, or in flight.
    pub queued_bytes: usize,
    /// Frames outstanding: queued, reserved, or in flight.
    pub queued_frames: usize,
    /// Frames popped by the writer but not yet released.
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
    /// Submissions that found their class full and waited for room.
    pub awaited: u64,
    /// Stream submissions that hit their stall grace.
    pub stalled_terminals: u64,
    pub accepted: u64,
    pub refused: u64,
    pub too_large: u64,
    pub stale_generation: u64,
    /// The same accounting across every connection in this process.
    pub process: ProcessSnapshot,
}

/// The hard process-wide ceilings one outbound charge may not cross (#4504).
///
/// `control_*` capacity is reserved out of the same budget: a non-Control
/// submission may not consume it, so a flood of stream/response frames cannot
/// starve the liveness/close traffic that has to keep flowing. Tune the numbers
/// from the exact-SHA baseline; they are an accounting ceiling, not a claim
/// about process RSS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessLimits {
    pub bytes: usize,
    pub frames: usize,
    pub control_bytes: usize,
    pub control_frames: usize,
}

impl Default for ProcessLimits {
    fn default() -> Self {
        // Conservative fallback: 64 connections at the Server/Agent
        // per-connection budget (4 MiB / 64 frame slots), with one connection's
        // Control capacity held out of the ordinary ceilings. A runtime that
        // owns exact class limits installs its own through
        // [`ProcessAccounting::install`]; the exact-SHA baseline tunes the
        // candidate value, and this is an accounting ceiling, not an RSS claim.
        Self {
            bytes: 256 * 1024 * 1024,
            frames: 4_096,
            control_bytes: 512 * 1024,
            control_frames: 16,
        }
    }
}

impl ProcessLimits {
    /// The process ceilings implied by one connection's class limits over
    /// `connections` concurrent connections, with its Control capacity
    /// reserved. The adapters that own those limits install this at startup.
    pub fn for_connections(limits: ClassifiedLimits, connections: usize) -> Self {
        let connections = connections.max(1);
        Self {
            bytes: limits.total_bytes().saturating_mul(connections),
            frames: limits.total_frames().saturating_mul(connections),
            control_bytes: limits.control.bytes,
            control_frames: limits.control.frames,
        }
    }
}

/// Process-wide aggregate accounting with hard ceilings (#4504).
#[derive(Debug)]
pub struct ProcessAccounting {
    limits: ProcessLimits,
    bytes: AtomicUsize,
    frames: AtomicUsize,
    peak_bytes: AtomicUsize,
    peak_frames: AtomicUsize,
    accepted: AtomicU64,
    refused: AtomicU64,
    too_large: AtomicU64,
}

impl Default for ProcessAccounting {
    fn default() -> Self {
        Self::with_limits(ProcessLimits::default())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessSnapshot {
    pub limit_bytes: usize,
    pub limit_frames: usize,
    pub control_reserve_bytes: usize,
    pub control_reserve_frames: usize,
    pub bytes: usize,
    pub frames: usize,
    pub peak_bytes: usize,
    pub peak_frames: usize,
    pub accepted: u64,
    pub refused: u64,
    pub too_large: u64,
}

static PROCESS_ACCOUNTING: OnceLock<Arc<ProcessAccounting>> = OnceLock::new();

impl ProcessAccounting {
    /// A fresh accounting cell with explicit ceilings. Production uses the
    /// process-wide [`Self::shared`]; tests inject deliberately small limits.
    pub fn with_limits(limits: ProcessLimits) -> Self {
        Self {
            limits,
            bytes: AtomicUsize::new(0),
            frames: AtomicUsize::new(0),
            peak_bytes: AtomicUsize::new(0),
            peak_frames: AtomicUsize::new(0),
            accepted: AtomicU64::new(0),
            refused: AtomicU64::new(0),
            too_large: AtomicU64::new(0),
        }
    }

    /// The process's one aggregate accounting cell.
    pub fn shared() -> Arc<Self> {
        Arc::clone(PROCESS_ACCOUNTING.get_or_init(|| Arc::new(Self::default())))
    }

    /// Install the process cell with the ceilings the owning runtime derived
    /// from its class limits. Called once at startup, before connections exist;
    /// a second call keeps the first cell.
    pub fn install(limits: ProcessLimits) -> Arc<Self> {
        Arc::clone(PROCESS_ACCOUNTING.get_or_init(|| Arc::new(Self::with_limits(limits))))
    }

    pub fn limits(&self) -> ProcessLimits {
        self.limits
    }

    /// Reserve `bytes`, refusing when the non-Control ceiling would be crossed.
    fn try_reserve_bytes(&self, bytes: usize, control: bool) -> bool {
        let ceiling = if control {
            self.limits.bytes
        } else {
            self.limits.bytes.saturating_sub(self.limits.control_bytes)
        };
        let mut current = self.bytes.load(Ordering::Relaxed);
        loop {
            if current.saturating_add(bytes) > ceiling {
                return false;
            }
            match self.bytes.compare_exchange_weak(
                current,
                current + bytes,
                Ordering::AcqRel,
                Ordering::Relaxed,
            ) {
                Ok(_) => {
                    self.note_peaks();
                    return true;
                }
                Err(next) => current = next,
            }
        }
    }

    /// Reserve one frame slot under the same ceilings and Control reserve.
    fn try_reserve_frame(&self, control: bool) -> bool {
        let ceiling = if control {
            self.limits.frames
        } else {
            self.limits
                .frames
                .saturating_sub(self.limits.control_frames)
        };
        let mut current = self.frames.load(Ordering::Relaxed);
        loop {
            if current >= ceiling {
                return false;
            }
            match self.frames.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Relaxed,
            ) {
                Ok(_) => {
                    self.note_peaks();
                    return true;
                }
                Err(next) => current = next,
            }
        }
    }

    pub fn snapshot(&self) -> ProcessSnapshot {
        ProcessSnapshot {
            limit_bytes: self.limits.bytes,
            limit_frames: self.limits.frames,
            control_reserve_bytes: self.limits.control_bytes,
            control_reserve_frames: self.limits.control_frames,
            bytes: self.bytes.load(Ordering::Relaxed),
            frames: self.frames.load(Ordering::Relaxed),
            peak_bytes: self.peak_bytes.load(Ordering::Relaxed),
            peak_frames: self.peak_frames.load(Ordering::Relaxed),
            accepted: self.accepted.load(Ordering::Relaxed),
            refused: self.refused.load(Ordering::Relaxed),
            too_large: self.too_large.load(Ordering::Relaxed),
        }
    }

    fn note_peaks(&self) {
        let bytes = self.bytes.load(Ordering::Relaxed);
        let _ = self.peak_bytes.fetch_max(bytes, Ordering::Relaxed);
        let frames = self.frames.load(Ordering::Relaxed);
        let _ = self.peak_frames.fetch_max(frames, Ordering::Relaxed);
    }
}

/// A frame's claim on [`ProcessAccounting`], released when the frame is.
struct ProcessCharge {
    accounting: Arc<ProcessAccounting>,
    bytes: usize,
    frames: usize,
}

impl ProcessCharge {
    fn reserve_bytes(
        accounting: Arc<ProcessAccounting>,
        bytes: usize,
        control: bool,
    ) -> Result<Self, ()> {
        if !accounting.try_reserve_bytes(bytes, control) {
            return Err(());
        }
        Ok(Self {
            accounting,
            bytes,
            frames: 0,
        })
    }

    fn reserve_frame(&mut self, control: bool) -> Result<(), ()> {
        if !self.accounting.try_reserve_frame(control) {
            return Err(());
        }
        self.frames = 1;
        Ok(())
    }
}

impl Drop for ProcessCharge {
    fn drop(&mut self) {
        self.accounting
            .bytes
            .fetch_sub(self.bytes, Ordering::Relaxed);
        self.accounting
            .frames
            .fetch_sub(self.frames, Ordering::Relaxed);
    }
}

#[derive(Default)]
struct Counters {
    awaited: AtomicU64,
    stalled_terminals: AtomicU64,
    accepted: AtomicU64,
    refused: AtomicU64,
    too_large: AtomicU64,
    stale_generation: AtomicU64,
}

/// One class's reserved capacity and its own counters.
struct ClassCapacity {
    limits: ClassLimits,
    byte_sem: Arc<Semaphore>,
    frame_sem: Arc<Semaphore>,
    /// Frames currently sitting in the channel. Outstanding frames minus this
    /// figure is the in-flight count.
    queued: Arc<AtomicUsize>,
}

impl ClassCapacity {
    fn new(limits: ClassLimits) -> Self {
        let limits = limits.normalized();
        Self {
            limits,
            byte_sem: Arc::new(Semaphore::new(limits.bytes)),
            frame_sem: Arc::new(Semaphore::new(limits.frames)),
            queued: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn used_bytes(&self) -> usize {
        self.limits
            .bytes
            .saturating_sub(self.byte_sem.available_permits())
    }

    fn used_frames(&self) -> usize {
        self.limits
            .frames
            .saturating_sub(self.frame_sem.available_permits())
    }
}

#[derive(Clone)]
struct ClassSenders {
    control: mpsc::UnboundedSender<QueuedFrame>,
    response: mpsc::UnboundedSender<QueuedFrame>,
    stream: mpsc::UnboundedSender<QueuedFrame>,
}

impl ClassSenders {
    fn send(
        &self,
        class: FrameClass,
        frame: QueuedFrame,
    ) -> Result<(), mpsc::error::SendError<QueuedFrame>> {
        match class {
            FrameClass::Control => self.control.send(frame),
            FrameClass::Response => self.response.send(frame),
            FrameClass::Stream => self.stream.send(frame),
        }
    }
}

struct ClassReceivers {
    control: mpsc::UnboundedReceiver<QueuedFrame>,
    response: mpsc::UnboundedReceiver<QueuedFrame>,
    stream: mpsc::UnboundedReceiver<QueuedFrame>,
}

impl ClassReceivers {
    fn get_mut(&mut self, class: FrameClass) -> &mut mpsc::UnboundedReceiver<QueuedFrame> {
        match class {
            FrameClass::Control => &mut self.control,
            FrameClass::Response => &mut self.response,
            FrameClass::Stream => &mut self.stream,
        }
    }
}

struct OutboundInner {
    name: &'static str,
    limits: ClassifiedLimits,
    control_class: ClassCapacity,
    response_class: ClassCapacity,
    stream_class: ClassCapacity,
    senders: ClassSenders,
    terminal_grace: Duration,
    scheduler: SchedulerConfig,
    generation: AtomicU64,
    counters: Counters,
    process: Arc<ProcessAccounting>,
    closed: AtomicBool,
    /// `Arc` so a waiter can clone the handle before any mutable borrow of the
    /// receiver, which is what makes the scheduler's `select!` borrow-clean.
    wake: Arc<Notify>,
}

impl OutboundInner {
    fn class(&self, class: FrameClass) -> &ClassCapacity {
        match class {
            FrameClass::Control => &self.control_class,
            FrameClass::Response => &self.response_class,
            FrameClass::Stream => &self.stream_class,
        }
    }

    fn note_refused(&self, class: FrameClass, error: OutboundError) {
        self.counters.refused.fetch_add(1, Ordering::Relaxed);
        self.process.refused.fetch_add(1, Ordering::Relaxed);
        let reason = match error {
            OutboundError::Closed => ReasonKind::Shutdown,
            OutboundError::Saturated | OutboundError::Stalled => ReasonKind::Saturated,
            OutboundError::TooLarge { .. } => ReasonKind::Capacity,
            OutboundError::StaleGeneration => ReasonKind::Replacement,
        };
        metrics::counter(
            "ws_outbound_refused",
            Labels::new()
                .domain(class.domain())
                .direction(Direction::Outbound)
                .result(ResultKind::Refused)
                .reason(reason),
        );
        if let OutboundError::TooLarge { size, .. } = error {
            self.counters.too_large.fetch_add(1, Ordering::Relaxed);
            self.process.too_large.fetch_add(1, Ordering::Relaxed);
            metrics::record(
                "ws_outbound_too_large",
                Labels::new()
                    .domain(class.domain())
                    .direction(Direction::Outbound)
                    .result(ResultKind::TooLarge)
                    .reason(ReasonKind::Capacity),
                size as f64,
            );
        }
        debug!(
            "{}: refused a {} frame ({error})",
            self.name,
            class.as_str()
        );
    }
}

/// The sending half of one connection's classified outbound path.
#[derive(Clone)]
pub struct Outbound {
    inner: Arc<OutboundInner>,
}

impl Outbound {
    /// A connection's outbound path at the caller's class bounds, and the
    /// scheduler its writer drains.
    pub fn new(
        name: &'static str,
        limits: ClassifiedLimits,
        terminal_grace: Duration,
    ) -> (Self, OutboundReceiver) {
        Self::with_scheduler(name, limits, terminal_grace, SchedulerConfig::default())
    }

    /// The same, with explicit scheduler knobs (tests, and a runtime that has
    /// measured its own traffic).
    pub fn with_scheduler(
        name: &'static str,
        limits: ClassifiedLimits,
        terminal_grace: Duration,
        scheduler: SchedulerConfig,
    ) -> (Self, OutboundReceiver) {
        Self::with_process(
            name,
            limits,
            terminal_grace,
            scheduler,
            ProcessAccounting::shared(),
        )
    }

    /// The same, with an explicit process accounting cell. Tests use a fresh
    /// cell so their exact figures are not disturbed by other tests running in
    /// parallel; production uses [`ProcessAccounting::shared`].
    pub fn with_process(
        name: &'static str,
        limits: ClassifiedLimits,
        terminal_grace: Duration,
        scheduler: SchedulerConfig,
        process: Arc<ProcessAccounting>,
    ) -> (Self, OutboundReceiver) {
        let (control_tx, control_rx) = mpsc::unbounded_channel();
        let (response_tx, response_rx) = mpsc::unbounded_channel();
        let (stream_tx, stream_rx) = mpsc::unbounded_channel();
        let inner = Arc::new(OutboundInner {
            name,
            limits,
            control_class: ClassCapacity::new(limits.control),
            response_class: ClassCapacity::new(limits.response),
            stream_class: ClassCapacity::new(limits.stream),
            senders: ClassSenders {
                control: control_tx,
                response: response_tx,
                stream: stream_tx,
            },
            terminal_grace,
            scheduler: SchedulerConfig {
                control_burst: scheduler.control_burst.max(1),
                response_quantum: scheduler.response_quantum.max(1),
                stream_quantum: scheduler.stream_quantum.max(1),
            },
            generation: AtomicU64::new(1),
            counters: Counters::default(),
            process,
            closed: AtomicBool::new(false),
            wake: Arc::new(Notify::new()),
        });
        (
            Self {
                inner: Arc::clone(&inner),
            },
            OutboundReceiver {
                inner,
                rx: ClassReceivers {
                    control: control_rx,
                    response: response_rx,
                    stream: stream_rx,
                },
                deferred: [None, None, None],
                channel_closed: [false, false, false],
                control_streak: 0,
                response_deficit: 0,
                stream_deficit: 0,
                last_deficit_class: None,
            },
        )
    }

    /// The generation submissions are currently checked against.
    pub fn current_generation(&self) -> u64 {
        self.inner.generation.load(Ordering::Relaxed)
    }

    /// Move the connection to a new ownership generation. Frames submitted
    /// under an older generation are refused from then on.
    pub fn set_generation(&self, generation: u64) {
        self.inner.generation.store(generation, Ordering::Relaxed);
    }

    /// Submit one classified frame with an explicit ownership generation and
    /// wait policy.
    pub async fn submit(
        &self,
        class: FrameClass,
        generation: u64,
        message: WsFrame,
        wait: WaitPolicy,
    ) -> SubmitOutcome {
        self.submit_inner(class, generation, message, wait).await
    }

    /// Submit under the connection's current generation.
    pub async fn submit_current(
        &self,
        class: FrameClass,
        message: WsFrame,
        wait: WaitPolicy,
    ) -> SubmitOutcome {
        let generation = self.current_generation();
        self.submit_inner(class, generation, message, wait).await
    }

    /// Send a frame the peer is waiting for. Waits for room until the
    /// connection closes; never silently drops.
    pub async fn send_reply(&self, msg: WsFrame) -> Result<(), OutboundError> {
        self.submit_current(FrameClass::Response, msg, WaitPolicy::UntilClosed)
            .await
            .into_result()
    }

    /// Forward one chunk of a steady stream (terminal output).
    ///
    /// Waits for room up to the stall grace, then reports [`OutboundError::Stalled`]:
    /// the peer has stopped draining, and that is a verdict for the caller to
    /// turn into the end of the connection.
    pub async fn send_terminal(&self, msg: WsFrame) -> Result<(), OutboundError> {
        let outcome = self
            .submit_current(
                FrameClass::Stream,
                msg,
                WaitPolicy::Finite(self.inner.terminal_grace),
            )
            .await;
        if outcome == SubmitOutcome::Refused(OutboundError::Stalled) {
            self.inner
                .counters
                .stalled_terminals
                .fetch_add(1, Ordering::Relaxed);
            warn!(
                "{}: a stream frame waited {:?} for room and never got it — the peer has \
                 stopped draining ({} frame(s), {} byte(s) outstanding)",
                self.inner.name,
                self.inner.terminal_grace,
                self.queued_frames(),
                self.queued_bytes()
            );
        }
        outcome.into_result()
    }

    /// Send a control frame without waiting. Control has its own reserved
    /// capacity; a refusal means the connection is genuinely gone or the
    /// caller's class is over budget.
    pub fn send_control(&self, msg: WsFrame) -> Result<(), OutboundError> {
        self.try_submit_sync(FrameClass::Control, msg).into_result()
    }

    /// The policy-free `try_send` `#961` introduced, now explicitly the control
    /// class. Kept because the Server's command and state-push lanes and the
    /// agent's state lane build their own answers on top of it.
    pub fn try_send(&self, msg: WsFrame) -> Result<(), OutboundError> {
        self.send_control(msg)
    }

    /// Submit one frame without waiting, whatever its class. Adapters that own
    /// a class-specific policy (fail a command, drop a state level) build on
    /// this rather than on [`Self::send_control`].
    pub fn try_submit(&self, class: FrameClass, msg: WsFrame) -> SubmitOutcome {
        self.try_submit_sync(class, msg)
    }

    /// Whether [`Self::close`] has been called.
    pub fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::SeqCst)
    }

    /// Stop the writer: the scheduler's `recv` returns `None` and any waiters
    /// resolve. The reason belongs to [`crate::lifecycle::ConnectionLifecycle`];
    /// this is only the queue half of the same event.
    pub fn close(&self) {
        if !self.inner.closed.swap(true, Ordering::SeqCst) {
            self.inner.wake.notify_waiters();
        }
    }

    /// What this connection's outbound path is doing, for logging and tests.
    pub fn snapshot(&self) -> QueueSnapshot {
        let control = self.inner.class(FrameClass::Control);
        let response = self.inner.class(FrameClass::Response);
        let stream = self.inner.class(FrameClass::Stream);
        let queued_frames = control.used_frames() + response.used_frames() + stream.used_frames();
        let in_channels = control.queued.load(Ordering::Relaxed)
            + response.queued.load(Ordering::Relaxed)
            + stream.queued.load(Ordering::Relaxed);
        QueueSnapshot {
            queued_bytes: control.used_bytes() + response.used_bytes() + stream.used_bytes(),
            queued_frames,
            in_flight_frames: queued_frames.saturating_sub(in_channels),
            byte_budget: self.inner.limits.total_bytes(),
            frame_slots: self.inner.limits.total_frames(),
            control_bytes: control.used_bytes(),
            control_frames: control.used_frames(),
            response_bytes: response.used_bytes(),
            response_frames: response.used_frames(),
            stream_bytes: stream.used_bytes(),
            stream_frames: stream.used_frames(),
            awaited: self.inner.counters.awaited.load(Ordering::Relaxed),
            stalled_terminals: self
                .inner
                .counters
                .stalled_terminals
                .load(Ordering::Relaxed),
            accepted: self.inner.counters.accepted.load(Ordering::Relaxed),
            refused: self.inner.counters.refused.load(Ordering::Relaxed),
            too_large: self.inner.counters.too_large.load(Ordering::Relaxed),
            stale_generation: self.inner.counters.stale_generation.load(Ordering::Relaxed),
            process: self.inner.process.snapshot(),
        }
    }

    /// Bytes outstanding: queued, reserved by a waiting producer, or in flight.
    pub fn queued_bytes(&self) -> usize {
        self.snapshot().queued_bytes
    }

    /// Frames outstanding: queued, reserved, or in flight.
    pub fn queued_frames(&self) -> usize {
        self.snapshot().queued_frames
    }

    async fn submit_inner(
        &self,
        class: FrameClass,
        generation: u64,
        message: WsFrame,
        wait: WaitPolicy,
    ) -> SubmitOutcome {
        if generation != self.current_generation() {
            self.inner
                .counters
                .stale_generation
                .fetch_add(1, Ordering::Relaxed);
            let error = OutboundError::StaleGeneration;
            self.inner.note_refused(class, error);
            return SubmitOutcome::Refused(error);
        }

        let limit = self.inner.limits.for_class(class);
        let Some(charge) = exact_charge(message.len()) else {
            let error = OutboundError::TooLarge {
                size: usize::MAX,
                limit: limit.bytes,
            };
            self.inner.note_refused(class, error);
            return SubmitOutcome::Refused(error);
        };
        if charge > limit.bytes {
            let error = OutboundError::TooLarge {
                size: charge,
                limit: limit.bytes,
            };
            self.inner.note_refused(class, error);
            return SubmitOutcome::Refused(error);
        }

        let capacity = self.inner.class(class);
        let awaited = capacity.byte_sem.available_permits() < charge
            || capacity.frame_sem.available_permits() == 0;
        if awaited {
            self.inner.counters.awaited.fetch_add(1, Ordering::Relaxed);
            debug!(
                "{}: no room for a {} frame, waiting for the writer ({} frame(s), {} byte(s) outstanding)",
                self.inner.name,
                class.as_str(),
                self.queued_frames(),
                self.queued_bytes()
            );
        }

        let acquired = self.acquire(class, charge, wait).await;
        let (budget, slot, process) = match acquired {
            Ok(parts) => parts,
            Err(error) => {
                self.inner.note_refused(class, error);
                return if error == OutboundError::Closed {
                    SubmitOutcome::Closed
                } else {
                    SubmitOutcome::Refused(error)
                };
            }
        };

        let queued_counter = Arc::clone(&capacity.queued);
        queued_counter.fetch_add(1, Ordering::Relaxed);
        let frame = QueuedFrame {
            class,
            generation,
            message,
            budget,
            slot,
            charged: charge,
            _process: process,
            marker: QueuedMarker {
                counter: queued_counter,
                queued: true,
            },
        };

        match self.inner.senders.send(class, frame) {
            Ok(()) => {
                self.inner.counters.accepted.fetch_add(1, Ordering::Relaxed);
                self.inner.process.accepted.fetch_add(1, Ordering::Relaxed);
                metrics::counter(
                    "ws_outbound_accepted",
                    Labels::new()
                        .domain(class.domain())
                        .direction(Direction::Outbound)
                        .result(ResultKind::Accepted),
                );
                metrics::gauge(
                    "ws_outbound_queued",
                    Labels::new()
                        .domain(class.domain())
                        .direction(Direction::Outbound),
                    self.queued_bytes() as f64,
                );
                self.inner.wake.notify_one();
                SubmitOutcome::Accepted
            }
            Err(_) => {
                // The frame (and its permits) was returned by the failed send
                // and dropped here, which releases the budget and the counters.
                SubmitOutcome::Closed
            }
        }
    }

    fn try_submit_sync(&self, class: FrameClass, message: WsFrame) -> SubmitOutcome {
        if self.is_closed() {
            return SubmitOutcome::Closed;
        }
        let generation = self.current_generation();
        let limit = self.inner.limits.for_class(class);
        let Some(charge) = exact_charge(message.len()) else {
            let error = OutboundError::TooLarge {
                size: usize::MAX,
                limit: limit.bytes,
            };
            self.inner.note_refused(class, error);
            return SubmitOutcome::Refused(error);
        };
        if charge > limit.bytes {
            let error = OutboundError::TooLarge {
                size: charge,
                limit: limit.bytes,
            };
            self.inner.note_refused(class, error);
            return SubmitOutcome::Refused(error);
        }

        let capacity = self.inner.class(class);
        let budget = match Arc::clone(&capacity.byte_sem).try_acquire_many_owned(permits(charge)) {
            Ok(permit) => permit,
            Err(_) => {
                let error = OutboundError::Saturated;
                self.inner.note_refused(class, error);
                return SubmitOutcome::Refused(error);
            }
        };
        let mut process = match ProcessCharge::reserve_bytes(
            Arc::clone(&self.inner.process),
            charge,
            class == FrameClass::Control,
        ) {
            Ok(process) => process,
            Err(()) => {
                let error = OutboundError::Saturated;
                self.inner.note_refused(class, error);
                return SubmitOutcome::Refused(error);
            }
        };
        let slot = match Arc::clone(&capacity.frame_sem).try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                // `process` drops here, releasing the byte reservation.
                let error = OutboundError::Saturated;
                self.inner.note_refused(class, error);
                return SubmitOutcome::Refused(error);
            }
        };
        if process.reserve_frame(class == FrameClass::Control).is_err() {
            let error = OutboundError::Saturated;
            self.inner.note_refused(class, error);
            return SubmitOutcome::Refused(error);
        }

        let queued_counter = Arc::clone(&capacity.queued);
        queued_counter.fetch_add(1, Ordering::Relaxed);
        let frame = QueuedFrame {
            class,
            generation,
            message,
            budget,
            slot,
            charged: charge,
            _process: process,
            marker: QueuedMarker {
                counter: queued_counter,
                queued: true,
            },
        };
        match self.inner.senders.send(class, frame) {
            Ok(()) => {
                self.inner.counters.accepted.fetch_add(1, Ordering::Relaxed);
                self.inner.process.accepted.fetch_add(1, Ordering::Relaxed);
                metrics::counter(
                    "ws_outbound_accepted",
                    Labels::new()
                        .domain(class.domain())
                        .direction(Direction::Outbound)
                        .result(ResultKind::Accepted),
                );
                metrics::gauge(
                    "ws_outbound_queued",
                    Labels::new()
                        .domain(class.domain())
                        .direction(Direction::Outbound),
                    self.queued_bytes() as f64,
                );
                self.inner.wake.notify_one();
                SubmitOutcome::Accepted
            }
            Err(_) => SubmitOutcome::Closed,
        }
    }

    async fn acquire(
        &self,
        class: FrameClass,
        charge: usize,
        wait: WaitPolicy,
    ) -> Result<(OwnedSemaphorePermit, OwnedSemaphorePermit, ProcessCharge), OutboundError> {
        let capacity = self.inner.class(class);
        let bytes = Arc::clone(&capacity.byte_sem);
        let frames = Arc::clone(&capacity.frame_sem);

        // Acquire in one order everywhere (bytes, then frame slot) so two
        // producers cannot deadlock by taking the two resources in opposite
        // orders.
        // The three wait policies map three different "no room" verdicts onto
        // the same result type here; the caller's policy above chose which one.
        let budget: Result<OwnedSemaphorePermit, OutboundError> = match wait {
            WaitPolicy::NoWait => bytes
                .try_acquire_many_owned(permits(charge))
                .map_err(|_| OutboundError::Saturated),
            WaitPolicy::UntilClosed => bytes
                .acquire_many_owned(permits(charge))
                .await
                .map_err(|_| OutboundError::Closed),
            WaitPolicy::Finite(deadline) => {
                match tokio::time::timeout(deadline, bytes.acquire_many_owned(permits(charge)))
                    .await
                {
                    Ok(result) => result.map_err(|_| OutboundError::Closed),
                    Err(_) => Err(OutboundError::Stalled),
                }
            }
        };
        let budget = budget?;

        // The byte reservation is counted from this point on, including while
        // this producer waits for a frame slot below.
        let mut process = ProcessCharge::reserve_bytes(
            Arc::clone(&self.inner.process),
            charge,
            class == FrameClass::Control,
        )
        .map_err(|()| OutboundError::Saturated)?;

        let slot: Result<OwnedSemaphorePermit, OutboundError> = match wait {
            WaitPolicy::NoWait => frames
                .try_acquire_owned()
                .map_err(|_| OutboundError::Saturated),
            WaitPolicy::UntilClosed => frames
                .acquire_owned()
                .await
                .map_err(|_| OutboundError::Closed),
            WaitPolicy::Finite(deadline) => {
                match tokio::time::timeout(deadline, frames.acquire_owned()).await {
                    Ok(result) => result.map_err(|_| OutboundError::Closed),
                    Err(_) => Err(OutboundError::Stalled),
                }
            }
        };
        let slot = slot?;

        process
            .reserve_frame(class == FrameClass::Control)
            .map_err(|()| OutboundError::Saturated)?;
        Ok((budget, slot, process))
    }
}

/// The only consumer of a connection's classified queues, and its scheduler.
///
/// See the module docs for the policy. `recv` is cancel-safe: every arm is an
/// `mpsc` receive, and a frame taken by an arm is parked in this receiver's
/// deferred slot before the next await point.
pub struct OutboundReceiver {
    inner: Arc<OutboundInner>,
    rx: ClassReceivers,
    deferred: [Option<QueuedFrame>; 3],
    channel_closed: [bool; 3],
    control_streak: usize,
    response_deficit: i64,
    stream_deficit: i64,
    /// Which of the deficit classes was served last. Used only to break a tie,
    /// so the byte weighting cannot turn into "response always first".
    last_deficit_class: Option<FrameClass>,
}

impl OutboundReceiver {
    /// A frame that is ready now, without waiting.
    ///
    /// The scheduler's decision applied to the frames currently queued. Tests
    /// and the registries that peek at a connection use this; the writer uses
    /// [`Self::recv`].
    pub fn try_recv(&mut self) -> Result<QueuedFrame, mpsc::error::TryRecvError> {
        match self.take_ready() {
            Some(frame) => Ok(frame),
            None if self.inner.closed.load(Ordering::SeqCst) || self.all_closed() => {
                Err(mpsc::error::TryRecvError::Disconnected)
            }
            None => Err(mpsc::error::TryRecvError::Empty),
        }
    }

    /// The next frame to write, according to the bounded fair scheduler.
    pub async fn recv(&mut self) -> Option<QueuedFrame> {
        loop {
            if let Some(frame) = self.take_ready() {
                return Some(frame);
            }
            if self.inner.closed.load(Ordering::SeqCst) {
                return None;
            }
            if self.all_closed() {
                return None;
            }

            // Register the wake before re-checking, so a close or a submit that
            // lands in between is not a lost wake-up.
            let wake = Arc::clone(&self.inner.wake);
            let notified = wake.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            if let Some(frame) = self.take_ready() {
                return Some(frame);
            }
            if self.inner.closed.load(Ordering::SeqCst) || self.all_closed() {
                return None;
            }

            tokio::select! {
                frame = self.rx.control.recv() => self.defer(FrameClass::Control, frame),
                frame = self.rx.response.recv() => self.defer(FrameClass::Response, frame),
                frame = self.rx.stream.recv() => self.defer(FrameClass::Stream, frame),
                _ = &mut notified => {}
            }
        }
    }

    fn all_closed(&self) -> bool {
        self.channel_closed.iter().all(|closed| *closed)
            && self.deferred.iter().all(Option::is_none)
    }

    fn defer(&mut self, class: FrameClass, frame: Option<QueuedFrame>) {
        let index = class.index();
        match frame {
            Some(frame) => {
                if let Some(slot) = self.deferred.get_mut(index) {
                    *slot = Some(frame);
                }
            }
            None => {
                if let Some(closed) = self.channel_closed.get_mut(index) {
                    *closed = true;
                }
            }
        }
    }

    fn take_from(&mut self, class: FrameClass) -> Option<QueuedFrame> {
        let index = class.index();
        if let Some(mut frame) = self.deferred.get_mut(index).and_then(Option::take) {
            frame.mark_dequeued();
            return Some(frame);
        }
        if self.channel_closed.get(index).copied().unwrap_or(false) {
            return None;
        }
        match self.rx.get_mut(class).try_recv() {
            Ok(mut frame) => {
                frame.mark_dequeued();
                Some(frame)
            }
            Err(mpsc::error::TryRecvError::Empty) => None,
            Err(mpsc::error::TryRecvError::Disconnected) => {
                if let Some(closed) = self.channel_closed.get_mut(index) {
                    *closed = true;
                }
                None
            }
        }
    }

    /// The scheduler's one decision.
    fn take_ready(&mut self) -> Option<QueuedFrame> {
        let burst = self.inner.scheduler.control_burst.max(1);

        // 1. Control, in a bounded burst.
        if self.control_streak < burst {
            if let Some(frame) = self.take_from(FrameClass::Control) {
                self.control_streak += 1;
                return Some(frame);
            }
        }

        // 2. Deficit round robin between response and stream, in bytes.
        //
        // Both classes get their quantum at the start of a round. A class is
        // eligible while its deficit is positive; serving a frame subtracts its
        // exact charge, so a large frame consumes more of the round, which is
        // the "byte-aware" half. Both being eligible is broken by "the one not
        // served last", which keeps the larger response quantum from becoming a
        // strict priority that starves the stream.
        let response_quantum = self.inner.scheduler.response_quantum.max(1) as i64;
        let stream_quantum = self.inner.scheduler.stream_quantum.max(1) as i64;
        if self.response_deficit <= 0 && self.stream_deficit <= 0 {
            self.response_deficit += response_quantum;
            self.stream_deficit += stream_quantum;
        }
        let response_ready = self.response_deficit > 0;
        let stream_ready = self.stream_deficit > 0;
        if response_ready || stream_ready {
            let first = if response_ready && stream_ready {
                match self.last_deficit_class {
                    Some(FrameClass::Response) => FrameClass::Stream,
                    Some(FrameClass::Stream) => FrameClass::Response,
                    _ => FrameClass::Response,
                }
            } else if response_ready {
                FrameClass::Response
            } else {
                FrameClass::Stream
            };
            let fallback = if first == FrameClass::Response {
                FrameClass::Stream
            } else {
                FrameClass::Response
            };
            for class in [first, fallback] {
                if !(class == FrameClass::Response && response_ready
                    || class == FrameClass::Stream && stream_ready)
                {
                    continue;
                }
                if let Some(frame) = self.take_from(class) {
                    if class == FrameClass::Response {
                        self.response_deficit -= frame.charged as i64;
                    } else {
                        self.stream_deficit -= frame.charged as i64;
                    }
                    self.last_deficit_class = Some(class);
                    self.control_streak = 0;
                    return Some(frame);
                }
            }
        }

        // 3. The burst is spent but control is still the only pending class:
        // serve it rather than leaving it behind a class with no frames.
        if self.control_streak >= burst {
            if let Some(frame) = self.take_from(FrameClass::Control) {
                self.control_streak = 1;
                self.response_deficit = 0;
                self.stream_deficit = 0;
                return Some(frame);
            }
        }

        // 4. A class whose deficit is exhausted still gets a frame if it is all
        // that is left, so no class can be parked by an empty peer class.
        if let Some(frame) = self.take_from(FrameClass::Response) {
            self.response_deficit = 0;
            self.control_streak = 0;
            return Some(frame);
        }
        if let Some(frame) = self.take_from(FrameClass::Stream) {
            self.stream_deficit = 0;
            self.control_streak = 0;
            return Some(frame);
        }
        None
    }
}

/// What one frame is charged: payload plus the wire header, exactly.
///
/// `None` only when the payload length overflows `usize`, which is not a frame
/// any transport can carry; it is reported as [`OutboundError::TooLarge`].
pub fn exact_charge(len: usize) -> Option<usize> {
    len.checked_add(FRAME_OVERHEAD)
}

/// What one frame is charged against a *uniform* coalescing budget.
///
/// Kept for `nession-agent::connection::outbox`, which is a coalescing map
/// rather than a socket queue and deliberately chooses a per-class cap for a
/// frame that cannot fit. Socket submissions use [`exact_charge`] and refuse an
/// oversized frame rather than clamping it: see this module's docs.
pub fn charge(len: usize, limit: usize) -> usize {
    (len + FRAME_OVERHEAD).clamp(1, limit)
}

/// A byte charge as the permit count a `Semaphore` takes.
pub fn permits(bytes: usize) -> u32 {
    u32::try_from(bytes).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A test's own process cell, so parallel tests do not disturb its exact
    /// figures.
    fn process() -> Arc<ProcessAccounting> {
        Arc::new(ProcessAccounting::default())
    }

    const LIMITS: ClassifiedLimits = ClassifiedLimits {
        control: ClassLimits {
            bytes: 8 * 1024,
            frames: 4,
        },
        response: ClassLimits {
            bytes: 32 * 1024,
            frames: 4,
        },
        stream: ClassLimits {
            bytes: 32 * 1024,
            frames: 4,
        },
    };

    fn outbound() -> (Outbound, OutboundReceiver) {
        Outbound::with_process(
            "test outbound",
            LIMITS,
            Duration::from_millis(50),
            SchedulerConfig::default(),
            process(),
        )
    }

    fn outbound_with(
        limits: ClassifiedLimits,
        scheduler: SchedulerConfig,
        grace: Duration,
    ) -> (Outbound, OutboundReceiver) {
        Outbound::with_process("test outbound", limits, grace, scheduler, process())
    }

    /// Enough frame slots for the scheduler tests, whose point is order rather
    /// than the bound.
    const ROOMY: ClassifiedLimits = ClassifiedLimits {
        control: ClassLimits {
            bytes: 64 * 1024,
            frames: 16,
        },
        response: ClassLimits {
            bytes: 64 * 1024,
            frames: 16,
        },
        stream: ClassLimits {
            bytes: 64 * 1024,
            frames: 16,
        },
    };

    fn text(len: usize) -> WsFrame {
        WsFrame::Text("x".repeat(len))
    }

    /// Exact count and byte budgets, including the in-flight frame. The old
    /// queue's `queued_frames` was `limit - capacity`, which stopped counting a
    /// frame the moment the writer popped it; this one keeps counting until the
    /// frame (and therefore the wall-clock write) is done.
    #[tokio::test]
    async fn exact_count_and_byte_budgets_include_the_in_flight_frame() {
        let (outbound, mut rx) = outbound();
        let payload = 1024;
        let charged = exact_charge(payload).expect("a small frame charges");

        for n in 0..LIMITS.response.frames {
            assert_eq!(
                outbound
                    .submit_current(FrameClass::Response, text(payload), WaitPolicy::NoWait)
                    .await,
                SubmitOutcome::Accepted,
                "response frame {n} must fit its reserved budget"
            );
        }
        assert_eq!(outbound.snapshot().response_frames, LIMITS.response.frames);
        assert_eq!(
            outbound.snapshot().response_bytes,
            LIMITS.response.frames * charged
        );
        assert_eq!(outbound.snapshot().in_flight_frames, 0);

        // The writer pops one: it is still charged (wrong to release before the
        // socket has it) and now counted as in flight.
        let frame = rx.recv().await.expect("the first frame was queued");
        assert_eq!(
            outbound.snapshot().response_frames,
            LIMITS.response.frames,
            "a frame being written still holds its claim"
        );
        assert_eq!(outbound.snapshot().in_flight_frames, 1);
        assert_eq!(outbound.snapshot().process.frames, LIMITS.response.frames);

        // Only dropping it — which a real writer does after `send` returns —
        // releases the budget.
        drop(frame);
        assert_eq!(
            outbound.snapshot().response_frames,
            LIMITS.response.frames - 1
        );
        assert_eq!(outbound.snapshot().in_flight_frames, 0);
    }

    /// #4434: the split a real writer uses keeps every claim (class bytes,
    /// class frame slot and process charge) alive until the write ends. A plain
    /// `..` destructure released them at the end of the `let` statement, so
    /// `in_flight_frames` read 0 while the writer was parked in `send`.
    #[tokio::test]
    async fn the_write_split_holds_the_in_flight_claim_until_dropped() {
        let (outbound, mut rx) = outbound();
        assert_eq!(
            outbound
                .submit_current(FrameClass::Response, text(1024), WaitPolicy::NoWait)
                .await,
            SubmitOutcome::Accepted
        );
        let frame = rx.recv().await.expect("the frame was queued");

        let (message, charge) = frame.into_write_parts();
        assert!(matches!(message, WsFrame::Text(_)));
        assert_eq!(
            outbound.snapshot().response_frames,
            1,
            "the class frame slot was released before the write"
        );
        assert_eq!(
            outbound.snapshot().in_flight_frames,
            1,
            "the in-flight frame became invisible before the write"
        );

        drop(charge);
        assert_eq!(outbound.snapshot().response_frames, 0);
        assert_eq!(outbound.snapshot().in_flight_frames, 0);
    }

    /// An oversized frame is refused with its real size, never clamped to look
    /// like it fit. This is the accounting rule `#4434` names explicitly.
    #[tokio::test]
    async fn an_oversized_frame_is_refused_not_clamped() {
        let (outbound, _rx) = outbound();
        let too_big = LIMITS.response.bytes - FRAME_OVERHEAD + 1;
        let outcome = outbound
            .submit_current(FrameClass::Response, text(too_big), WaitPolicy::UntilClosed)
            .await;
        assert_eq!(
            outcome,
            SubmitOutcome::Refused(OutboundError::TooLarge {
                size: LIMITS.response.bytes + 1,
                limit: LIMITS.response.bytes,
            })
        );
        let snapshot = outbound.snapshot();
        assert_eq!(snapshot.too_large, 1);
        assert_eq!(snapshot.queued_bytes, 0, "a refusal charges nothing");
        assert_eq!(snapshot.process.bytes, 0);
        assert_eq!(snapshot.process.too_large, 1);
    }

    /// Control's capacity is reserved: filling response and stream to their
    /// bounds does not make a keepalive or state push unsendable.
    #[tokio::test]
    async fn control_capacity_is_reserved_against_response_and_stream_backlogs() {
        let (outbound, _rx) = outbound();
        for class in [FrameClass::Response, FrameClass::Stream] {
            let limit = LIMITS.for_class(class);
            for _ in 0..limit.frames {
                assert!(outbound
                    .submit_current(class, text(1), WaitPolicy::NoWait)
                    .await
                    .accepted());
            }
            assert_eq!(
                outbound
                    .submit_current(class, text(1), WaitPolicy::NoWait)
                    .await,
                SubmitOutcome::Refused(OutboundError::Saturated),
                "the class itself is full"
            );
        }

        assert_eq!(
            outbound
                .submit_current(FrameClass::Control, text(1), WaitPolicy::NoWait)
                .await,
            SubmitOutcome::Accepted,
            "control's reserved budget must survive a full response and stream"
        );
    }

    /// Control is served first, but only for a bounded burst: a continuously
    /// backfilled control queue cannot starve the stream forever.
    #[tokio::test]
    async fn a_control_flood_does_not_starve_a_backlogged_stream() {
        let scheduler = SchedulerConfig {
            control_burst: 3,
            response_quantum: 1,
            stream_quantum: 1,
        };
        let (outbound, mut rx) = outbound_with(ROOMY, scheduler, Duration::from_millis(50));

        for n in 0..10 {
            assert!(outbound
                .submit_current(
                    FrameClass::Control,
                    WsFrame::Text(format!("c{n}")),
                    WaitPolicy::NoWait
                )
                .await
                .accepted());
            assert!(outbound
                .submit_current(
                    FrameClass::Stream,
                    WsFrame::Text(format!("s{n}")),
                    WaitPolicy::NoWait
                )
                .await
                .accepted());
        }

        let mut order = Vec::new();
        for _ in 0..20 {
            let frame = rx.recv().await.expect("both classes had frames left");
            order.push(frame.class);
        }
        assert_eq!(
            order[..3],
            [
                FrameClass::Control,
                FrameClass::Control,
                FrameClass::Control
            ],
            "control's burst is real"
        );
        assert_eq!(
            order[3],
            FrameClass::Stream,
            "a lower class must get the turn the burst cap promises"
        );
        assert!(
            order[..7].contains(&FrameClass::Stream),
            "the stream must keep making progress under a continuous control flood"
        );
    }

    /// A response is protected under a continuously backlogged stream: it is
    /// served as soon as it is available, even though many stream frames were
    /// queued first.
    #[tokio::test]
    async fn a_response_is_protected_under_a_stream_backlog() {
        let (outbound, mut rx) = outbound_with(
            ROOMY,
            SchedulerConfig {
                control_burst: 4,
                response_quantum: 64 * 1024,
                stream_quantum: 32 * 1024,
            },
            Duration::from_millis(50),
        );

        for n in 0..4 {
            assert!(outbound
                .submit_current(
                    FrameClass::Stream,
                    WsFrame::Text(format!("stream-{n}")),
                    WaitPolicy::NoWait
                )
                .await
                .accepted());
        }
        assert!(outbound
            .submit_current(
                FrameClass::Response,
                WsFrame::Text("reply".into()),
                WaitPolicy::NoWait
            )
            .await
            .accepted());

        let first = rx.recv().await.expect("the reply is queued");
        assert_eq!(
            first.class,
            FrameClass::Response,
            "the response must not sit behind the stream backlog"
        );
        assert_eq!(first.message, WsFrame::Text("reply".into()));
    }

    /// The mirror fairness property: a response flood cannot starve a
    /// backlogged stream. Response's larger default quantum gives it a larger
    /// share, not the whole socket.
    #[tokio::test]
    async fn a_stream_is_not_starved_by_a_response_flood() {
        let (outbound, mut rx) = outbound_with(
            ROOMY,
            SchedulerConfig {
                control_burst: 4,
                response_quantum: 2048,
                stream_quantum: 1024,
            },
            Duration::from_millis(50),
        );

        for n in 0..4 {
            let payload = text(256);
            assert!(outbound
                .submit_current(FrameClass::Response, payload, WaitPolicy::NoWait)
                .await
                .accepted());
            assert!(outbound
                .submit_current(
                    FrameClass::Stream,
                    WsFrame::Text(format!("stream-{n}")),
                    WaitPolicy::NoWait
                )
                .await
                .accepted());
        }

        let mut classes = Vec::new();
        for _ in 0..8 {
            classes.push(rx.recv().await.expect("both classes had frames").class);
        }
        assert!(
            classes
                .iter()
                .take(4)
                .any(|class| *class == FrameClass::Stream),
            "the stream must be served inside the first round, not after the flood"
        );
    }

    /// A producer waiting for a frame slot holds its byte reservation, and that
    /// reservation is part of what the class budget bounds.
    #[tokio::test]
    async fn a_producer_held_reservation_is_counted_while_it_waits() {
        let limits = ClassifiedLimits {
            control: ClassLimits {
                bytes: 8 * 1024,
                frames: 4,
            },
            response: ClassLimits {
                bytes: 8 * 1024,
                frames: 1,
            },
            stream: ClassLimits {
                bytes: 8 * 1024,
                frames: 4,
            },
        };
        let (outbound, _rx) = outbound_with(
            limits,
            SchedulerConfig::default(),
            Duration::from_millis(20),
        );
        assert!(outbound
            .submit_current(FrameClass::Response, text(8), WaitPolicy::NoWait)
            .await
            .accepted());

        let waiter = tokio::spawn({
            let outbound = outbound.clone();
            async move {
                outbound
                    .submit_current(
                        FrameClass::Response,
                        text(16),
                        WaitPolicy::Finite(Duration::from_millis(150)),
                    )
                    .await
            }
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
        let snapshot = outbound.snapshot();
        assert_eq!(
            snapshot.response_frames, limits.response.frames,
            "the waiting producer's frame slot claim is not counted until acquired"
        );
        assert_eq!(
            snapshot.response_bytes,
            exact_charge(8).unwrap() + exact_charge(16).unwrap(),
            "but the bytes it reserved while waiting are"
        );

        // The finite wait ends with a verdict, not a park.
        assert_eq!(
            waiter.await.expect("the waiter must not panic"),
            SubmitOutcome::Refused(OutboundError::Stalled)
        );
        assert_eq!(
            outbound.snapshot().response_bytes,
            exact_charge(8).unwrap(),
            "a timed-out reservation is released"
        );
    }

    /// The reply lane's whole reason to exist: a send that finds the queue full
    /// waits, and the frame is there when the consumer catches up.
    #[tokio::test]
    async fn a_reply_waits_for_room_rather_than_being_dropped() {
        let (outbound, mut rx) = outbound();
        let fill = LIMITS.response.frames;
        for _ in 0..fill {
            assert!(outbound
                .submit_current(FrameClass::Response, text(1), WaitPolicy::NoWait)
                .await
                .accepted());
        }

        let waiter = tokio::spawn({
            let outbound = outbound.clone();
            async move { outbound.send_reply(WsFrame::Text("held".into())).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !waiter.is_finished(),
            "a full queue must park the reply lane"
        );
        assert!(outbound.snapshot().awaited >= 1);

        for _ in 0..fill {
            let written = rx.recv().await.expect("a queued frame went missing");
            drop(written);
        }
        let last = rx.recv().await.expect("the waiting reply was never queued");
        assert_eq!(last.message, WsFrame::Text("held".into()));
        assert_eq!(waiter.await.expect("reply task panicked"), Ok(()));
    }

    /// The stream lane waits like a reply, and ends at the grace with a verdict
    /// rather than an unbounded park.
    #[tokio::test]
    async fn a_stream_frame_that_never_gets_room_stalls() {
        let (outbound, _rx) = outbound();
        for _ in 0..LIMITS.stream.frames {
            assert!(outbound
                .submit_current(FrameClass::Stream, text(1), WaitPolicy::NoWait)
                .await
                .accepted());
        }
        let started = std::time::Instant::now();
        assert_eq!(
            outbound.send_terminal(WsFrame::Text("t".into())).await,
            Err(OutboundError::Stalled)
        );
        assert!(
            started.elapsed() >= Duration::from_millis(50),
            "the verdict must come after the grace, not instead of it"
        );
        assert_eq!(outbound.snapshot().stalled_terminals, 1);
    }

    /// A stale generation cannot queue anything on the connection that
    /// superseded it.
    #[tokio::test]
    async fn a_stale_generation_is_refused() {
        let (outbound, _rx) = outbound();
        outbound.set_generation(2);
        assert_eq!(
            outbound
                .submit(FrameClass::Response, 1, text(1), WaitPolicy::NoWait)
                .await,
            SubmitOutcome::Refused(OutboundError::StaleGeneration)
        );
        assert_eq!(outbound.snapshot().stale_generation, 1);
        assert_eq!(
            outbound
                .submit(FrameClass::Response, 2, text(1), WaitPolicy::NoWait)
                .await,
            SubmitOutcome::Accepted
        );
    }

    /// `close` is a fact every handle reads, and it wakes a parked writer.
    #[tokio::test]
    async fn close_wakes_a_parked_writer_and_stops_submissions() {
        let (outbound, mut rx) = outbound();
        let waiter = tokio::spawn(async move { rx.recv().await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!waiter.is_finished());
        outbound.close();
        assert!(tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("close must wake the scheduler")
            .expect("the writer task must not panic")
            .is_none());
        assert!(outbound.is_closed());
        assert_eq!(outbound.send_control(text(1)), Err(OutboundError::Closed));
    }

    /// Process accounting is an aggregate over connections, measured with exact
    /// charges and released when each frame is.
    #[tokio::test]
    async fn process_accounting_aggregates_across_connections() {
        let process = process();
        let (first, first_rx) = Outbound::with_process(
            "first",
            LIMITS,
            Duration::from_millis(50),
            SchedulerConfig::default(),
            Arc::clone(&process),
        );
        let (second, second_rx) = Outbound::with_process(
            "second",
            LIMITS,
            Duration::from_millis(50),
            SchedulerConfig::default(),
            Arc::clone(&process),
        );

        assert!(first
            .submit_current(FrameClass::Response, text(100), WaitPolicy::NoWait)
            .await
            .accepted());
        assert!(second
            .submit_current(FrameClass::Response, text(200), WaitPolicy::NoWait)
            .await
            .accepted());

        let snapshot = process.snapshot();
        assert_eq!(snapshot.frames, 2);
        assert_eq!(
            snapshot.bytes,
            exact_charge(100).unwrap() + exact_charge(200).unwrap()
        );
        assert_eq!(snapshot.accepted, 2);
        assert!(snapshot.peak_bytes >= snapshot.bytes);

        drop(first_rx);
        assert_eq!(
            process.snapshot().frames,
            1,
            "only the live frame is counted"
        );
        drop(second_rx);
        assert_eq!(process.snapshot().frames, 0);
        assert_eq!(process.snapshot().bytes, 0);
    }

    /// #4504: the process ceilings are hard and aggregate across connections.
    ///
    /// Six ordinary frames spend the non-Control process capacity while each
    /// connection's own class still has room; a seventh ordinary submission on
    /// the second connection is refused; a Control frame still fits its
    /// reserved share. Nothing is charged by a refusal, and dropping the frames
    /// returns every reservation to baseline.
    #[tokio::test]
    async fn process_limits_are_hard_and_reserve_control_capacity() {
        let process = Arc::new(ProcessAccounting::with_limits(ProcessLimits {
            bytes: 64 * 1024,
            frames: 8,
            control_bytes: 2 * 1024,
            control_frames: 2,
        }));
        let (first, first_rx) = Outbound::with_process(
            "first",
            ROOMY,
            Duration::from_millis(50),
            SchedulerConfig::default(),
            Arc::clone(&process),
        );
        let (second, second_rx) = Outbound::with_process(
            "second",
            ROOMY,
            Duration::from_millis(50),
            SchedulerConfig::default(),
            Arc::clone(&process),
        );

        // 8 process frames, 2 reserved for Control: six ordinary frames fill
        // the usable share.
        for _ in 0..6 {
            assert!(
                first
                    .submit_current(FrameClass::Stream, text(100), WaitPolicy::NoWait)
                    .await
                    .accepted(),
                "an ordinary frame within the process ceiling was refused"
            );
        }
        assert_eq!(
            second
                .submit_current(FrameClass::Stream, text(100), WaitPolicy::NoWait)
                .await,
            SubmitOutcome::Refused(OutboundError::Saturated),
            "the aggregate process ceiling was not enforced"
        );
        assert!(
            second.snapshot().stream_frames < ROOMY.stream.frames,
            "the refusing connection's own class still has room"
        );
        assert_eq!(
            process.snapshot().frames,
            6,
            "a refused submission reserved process capacity"
        );

        // Control keeps its reserved process share.
        assert!(
            second
                .submit_current(FrameClass::Control, text(10), WaitPolicy::NoWait)
                .await
                .accepted(),
            "the reserved Control capacity was not usable"
        );
        assert_eq!(process.snapshot().frames, 7);

        // Every reservation returns to baseline when the frames are released.
        drop(first_rx);
        drop(second_rx);
        assert_eq!(process.snapshot().frames, 0);
        assert_eq!(process.snapshot().bytes, 0);
        assert!(process.snapshot().peak_frames <= process.snapshot().limit_frames);
        assert!(process.snapshot().peak_bytes <= process.snapshot().limit_bytes);
    }

    /// A gone writer is reported as closed on every lane.
    #[tokio::test]
    async fn a_gone_writer_is_closed_on_every_lane() {
        let (outbound, rx) = outbound();
        drop(rx);

        assert_eq!(
            outbound.send_reply(WsFrame::Text("a".into())).await,
            Err(OutboundError::Closed)
        );
        assert_eq!(
            outbound.send_terminal(WsFrame::Text("b".into())).await,
            Err(OutboundError::Closed)
        );
        assert_eq!(
            outbound.send_control(WsFrame::Text("c".into())),
            Err(OutboundError::Closed)
        );
    }

    /// The uniform charge helper is still the coalescing outbox's: it clamps, on
    /// purpose, because that map is not a socket queue.
    #[test]
    fn the_uniform_charge_helper_still_clamps_for_the_coalescing_outbox() {
        assert_eq!(
            charge(LIMITS.response.bytes * 2, LIMITS.response.bytes),
            LIMITS.response.bytes
        );
        assert_eq!(charge(0, LIMITS.response.bytes), FRAME_OVERHEAD);
        assert_eq!(exact_charge(0), Some(FRAME_OVERHEAD));
    }
}
