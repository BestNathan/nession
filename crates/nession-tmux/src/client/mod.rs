//! A persistent, typed tmux Control Mode client (#2307).
//!
//! This module owns **one attached control client**: the byte-framed reader, the
//! ordered command/response matcher and the single ordered source-event stream.
//! The lifetime of the attachment belongs to the caller: a subscriber coming
//! and going must not create or destroy the tmux attachment.
//!
//! Deliberate boundaries:
//!
//! - [`ControlCommand`] is the control-channel encoding of tmux operations. It
//!   introduces no semantics of its own; the one-shot operation owner lives
//!   beside it in this crate.
//! - Session stream epochs, sequence numbers, replay and ACK stay with the
//!   caller. The client emits [`TmuxEvent`]s in source order and assigns
//!   nothing.
//! - The byte framing and the `Control Mode` message grammar are **not
//!   re-implemented here**: the reader reuses `framing` and
//!   [`crate::parser`], including the bounded-byte contract and its
//!   fatal/forward-compatible record split.
//!
//! ## Transports
//!
//! [`ControlTransport::Pipe`] (`tmux -C`) is the production default;
//! [`ControlTransport::Pty`] (`tmux -CC`) runs the identical protocol over a
//! PTY. `-CC` brackets the stream with terminal framing (DCS/ST) and writes
//! `CRLF` line endings; the transport removes that framing before this module
//! sees a byte, so the grammar, matcher and events are the same on both. Both
//! spawn through [`TmuxCommand`], and a failed launch is an error — never a
//! silent fallback to the other transport.
//!
//! ## Command matching
//!
//! tmux executes control commands in the order it receives them and answers
//! each with one `%begin … %end`/`%error` block on the same byte stream. The
//! client keeps a FIFO of pending commands and resolves the **front** when a
//! block closes. It does not invent a client-side serial: the wire order is the
//! authority. A command that times out leaves a **tombstone** at its place, so
//! its late reply is consumed by the command that asked for it instead of being
//! delivered to the next waiter. The first block a control client receives is
//! tmux's own empty welcome pair; it is consumed without a waiter.
//!
//! ## Lifecycle
//!
//! A read failure, an oversized/malformed known record, or a body that exceeds
//! its bound is **source loss**: every pending command fails, no later event is
//! produced, and the event stream says so. A dropped/stalled *subscriber* must
//! never be confused with source loss; this type does not know subscribers.
//! Call [`TmuxClient::close`] to detach and reap the child; dropping the client
//! only closes the byte streams (the agent's shutdown path must close).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Notify};
use tokio::task::JoinHandle;

use crate::parser::{decode_tmux_output, layout_size, parse_control_line_bytes, ControlMessage};
use crate::process::TmuxCommand;

pub mod commands;
pub mod events;
mod framing;
pub mod transport;

pub use commands::ControlCommand;
pub use events::{PaneOutput, TmuxEvent};
use framing::{malformed_known_record, read_control_line};
#[cfg(unix)]
pub use transport::PtyTransport;
pub use transport::{ClientChild, ClientIo, ControlTransport, PipeTransport};

/// Bound on commands awaiting a reply. A caller at this bound gets
/// [`TmuxClientError::QueueFull`] instead of an unbounded queue: the control
/// channel is a finite resource and a backlog means the caller is not reading
/// its own replies.
pub const MAX_PENDING_COMMANDS: usize = 256;
/// Bound on the bytes one command's response body may carry (`capture-pane`).
/// The pane capture itself is bounded by its requested line count; this is the
/// wire-level guard for a server that ignores it.
const MAX_RESPONSE_BODY_BYTES: usize = 4 * 1024 * 1024;
/// Default per-command budget. tmux over a local socket answers in
/// milliseconds; a capture of a full history is the slow case and still far
/// under this.
pub const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
/// Ordered event backlog. The Agent's stream owner drains this into its own
/// bounded log; the channel is the hand-off, not a second retention window.
const EVENT_CHANNEL_CAPACITY: usize = 256;
/// Aggregate payload bytes the reader may hand to the stream owner at once.
/// The event **count** is bounded separately by `EVENT_CHANNEL_CAPACITY`;
/// without a byte limit, 256 records of the 16 MiB line bound could be held in
/// decoded payload (#2380). 32 MiB fits two maximum-size control lines while
/// staying well inside the Agent container's memory envelope.
pub const DEFAULT_EVENT_BUDGET_BYTES: usize = 32 * 1024 * 1024;
/// Per-event bookkeeping charged in addition to its payload, so a flood of
/// small events cannot consume the budget for free.
const EVENT_OVERHEAD_BYTES: usize = 64;
/// How long the reader waits for byte credit before it declares the consumer
/// stalled. Past this the attachment fails closed with an explicit source loss
/// rather than blocking source accounting indefinitely (#2380).
pub const DEFAULT_EVENT_ADMISSION_TIMEOUT: Duration = Duration::from_secs(10);
/// Bound for delivering a terminal event (SourceLost/Exited) when the budget
/// cannot admit it.
const EVENT_TERMINAL_EMIT_TIMEOUT: Duration = Duration::from_secs(2);
const WRITE_CHANNEL_CAPACITY: usize = 64;
/// How long `close` may spend offering `detach-client` to a writer whose
/// channel is full before it proceeds to reaping/aborting (#2379).
const CLOSE_SEND_TIMEOUT: Duration = Duration::from_secs(2);
/// How long `close` waits for the ordered writer to observe `Close` before it
/// aborts that task (#2379).
const CLOSE_TASK_TIMEOUT: Duration = Duration::from_secs(2);

/// Identity source for production attachments (see [`TmuxClient::connect`]).
/// One process, one sequence; it only has to order attachments against each
/// other, so process start is the right origin.
static NEXT_ATTACHMENT_GENERATION: AtomicU64 = AtomicU64::new(1);

/// Why a command did not produce a tmux reply.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TmuxClientError {
    /// The attachment is closed or its source was lost. Nothing was written.
    #[error("tmux control attachment is closed")]
    Closed,
    /// The bounded pending-command queue is full. Nothing was written.
    #[error("tmux control command queue is full ({MAX_PENDING_COMMANDS} pending)")]
    QueueFull,
    /// No reply block arrived within the budget. The command **was admitted**
    /// and may still execute; its late reply is consumed by a tombstone and
    /// never delivered elsewhere.
    #[error("tmux command timed out after {0:?}")]
    Timeout(Duration),
    /// The command could not be handed to the ordered writer before the
    /// deadline. Nothing was written and no reply is owed (#2379).
    #[error("tmux command admission timed out after {0:?}")]
    AdmissionTimeout(Duration),
    /// tmux answered with `%error`; the body is tmux's own message.
    #[error("tmux rejected the command: {0}")]
    Rejected(String),
    /// The byte source failed or violated the protocol; nothing later is valid.
    #[error("tmux control source lost: {0}")]
    SourceLost(String),
    /// The transport could not write the command.
    #[error("tmux control transport error: {0}")]
    Transport(String),
}

struct PendingCommand {
    id: u64,
    /// The caller stopped waiting; the reply is still owed to this slot.
    abandoned: bool,
    /// This command's response body is a bootstrap capture. Its completed body
    /// is also published as an ordered `TmuxEvent::Capture`, which is what the
    /// capture barrier consumes: the event and the output around it share one
    /// stream, so no post-capture output can be mistaken for pre-capture data.
    capture: bool,
    reply: Option<oneshot::Sender<Result<Vec<u8>, TmuxClientError>>>,
}

impl PendingCommand {
    fn resolve(mut self, result: Result<Vec<u8>, TmuxClientError>) {
        if let Some(reply) = self.reply.take() {
            let _ = reply.send(result);
        }
    }
}

/// Limits for the ordered event ingress (#2380).
///
/// Count and aggregate bytes are both bounded: `max_queued_bytes` is the
/// payload the reader may hand to the stream owner before it must wait for the
/// consumer to take an event; `admission_timeout` is how long it waits before
/// the attachment fails closed with an explicit source loss.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EventIngressLimits {
    pub max_queued_bytes: usize,
    pub admission_timeout: Duration,
}

impl Default for EventIngressLimits {
    fn default() -> Self {
        Self {
            max_queued_bytes: DEFAULT_EVENT_BUDGET_BYTES,
            admission_timeout: DEFAULT_EVENT_ADMISSION_TIMEOUT,
        }
    }
}

/// Aggregate byte credit shared by the reader and the event stream.
struct EventBudget {
    limit: usize,
    queued: AtomicUsize,
    closed: AtomicBool,
    /// The failure that ended the source, kept until the consumer can be told.
    /// A terminal event normally carries it in order; when the queue is full a
    /// stopped consumer cannot receive that event, so the record lets
    /// [`EventStream::recv`] state the loss when the stream ends instead of
    /// presenting a clean EOF (#2380 SC-02).
    failure: Mutex<Option<String>>,
    notify: Notify,
}

impl EventBudget {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            queued: AtomicUsize::new(0),
            closed: AtomicBool::new(false),
            failure: Mutex::new(None),
            notify: Notify::new(),
        }
    }

    fn record_failure(&self, reason: &str) {
        if let Ok(mut failure) = self.failure.lock() {
            *failure = Some(reason.to_string());
        }
    }

    fn clear_failure(&self) {
        if let Ok(mut failure) = self.failure.lock() {
            *failure = None;
        }
    }

    fn take_failure(&self) -> Option<String> {
        self.failure
            .lock()
            .ok()
            .and_then(|mut failure| failure.take())
    }

    /// Reserve `bytes` before `deadline` for the consumer to release credit.
    ///
    /// The granted permit owns the charge until it is disarmed: a send that
    /// times out, fails or is cancelled refunds it by dropping the permit
    /// (#2380 SC-02). An oversized event, an exhausted budget and a closed
    /// ingress are told apart so the caller can state the right outcome.
    async fn acquire_until(&self, bytes: usize, deadline: tokio::time::Instant) -> Admission<'_> {
        if bytes > self.limit {
            return Admission::Overloaded;
        }
        loop {
            if self.closed.load(Ordering::Acquire) {
                return Admission::Closed;
            }
            let current = self.queued.load(Ordering::Acquire);
            if current.saturating_add(bytes) <= self.limit
                && self
                    .queued
                    .compare_exchange(
                        current,
                        current + bytes,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    )
                    .is_ok()
            {
                return Admission::Granted(BytePermit {
                    budget: self,
                    bytes,
                    armed: true,
                });
            }
            match tokio::time::timeout_at(deadline, self.notify.notified()).await {
                Ok(()) => continue,
                Err(_) => return Admission::Overloaded,
            }
        }
    }

    fn release(&self, bytes: usize) {
        self.queued.fetch_sub(bytes, Ordering::AcqRel);
        // `notify_one` stores a permit, so a release that races the reader's
        // registration cannot be lost; `notify_waiters` would drop it.
        self.notify.notify_one();
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.notify.notify_one();
    }
}

/// Result of trying to reserve aggregate byte credit.
enum Admission<'a> {
    /// Credit is held and refunded unless the permit is disarmed.
    Granted(BytePermit<'a>),
    /// The budget is exhausted, the event is oversized, or the deadline passed.
    Overloaded,
    /// The ingress is closed; nothing will be delivered.
    Closed,
}

/// Owns one event's byte charge until the queued event takes it over.
///
/// `disarm` transfers the charge to the `BudgetedEvent` (released by
/// [`EventStream::recv`]); dropping an armed permit refunds it, which is what
/// keeps accounting honest when a queue send fails, times out or is cancelled.
struct BytePermit<'a> {
    budget: &'a EventBudget,
    bytes: usize,
    armed: bool,
}

impl BytePermit<'_> {
    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for BytePermit<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.budget.release(self.bytes);
        }
    }
}

struct BudgetedEvent {
    event: TmuxEvent,
    bytes: usize,
}

/// The one ordered source-event stream (#2380).
///
/// Taking an event releases its byte credit; a consumer that stops taking
/// events makes the reader wait, then fail closed at its admission deadline.
pub struct EventStream {
    rx: mpsc::Receiver<BudgetedEvent>,
    budget: Arc<EventBudget>,
}

impl EventStream {
    /// The next event in wire order.
    ///
    /// A source that failed states the loss exactly once: either as the
    /// terminal event that was enqueued, or — when the queue was too full to
    /// carry it — as a final `SourceLost` synthesized from the recorded
    /// failure before the stream reports its end.
    pub async fn recv(&mut self) -> Option<TmuxEvent> {
        match self.rx.recv().await {
            Some(budgeted) => {
                self.budget.release(budgeted.bytes);
                Some(budgeted.event)
            }
            None => self
                .budget
                .take_failure()
                .map(|reason| TmuxEvent::SourceLost { reason }),
        }
    }
}

/// The reader's half of the ingress: budget admission plus the ordered send.
struct EventSink {
    tx: mpsc::Sender<BudgetedEvent>,
    budget: Arc<EventBudget>,
    admission_timeout: Duration,
}

enum EmitOutcome {
    Sent,
    Closed,
    Overloaded,
}

impl EventSink {
    /// Admit and enqueue one event under **one absolute deadline**.
    ///
    /// Byte credit and the queue are separate resources: a large byte budget
    /// with tiny events fills the count-bounded channel while plenty of credit
    /// remains, so bounding only the credit acquisition leaves a send that can
    /// park forever behind a live-but-stalled consumer (#2380 SC-02 reopened).
    /// Both legs share the same deadline, and a failed or cancelled send
    /// refunds the charge through the permit.
    async fn send(&self, event: TmuxEvent) -> EmitOutcome {
        let bytes = event_bytes(&event);
        let deadline = tokio::time::Instant::now() + self.admission_timeout;
        let permit = match self.budget.acquire_until(bytes, deadline).await {
            Admission::Granted(permit) => permit,
            Admission::Closed => return EmitOutcome::Closed,
            Admission::Overloaded => return EmitOutcome::Overloaded,
        };
        // `mpsc::Sender::send` is cancel-safe: a timeout drops the unsent
        // message, and dropping the still-armed permit refunds its credit.
        match tokio::time::timeout_at(deadline, self.tx.send(BudgetedEvent { event, bytes })).await
        {
            Ok(Ok(())) => {
                permit.disarm();
                EmitOutcome::Sent
            }
            Ok(Err(_)) => EmitOutcome::Closed,
            Err(_) => EmitOutcome::Overloaded,
        }
    }

    /// Deliver a terminal event even when the configured budget cannot admit
    /// it. Bounded so a stopped consumer cannot pin the reader here either.
    /// Returns whether the event was enqueued; `false` means the consumer
    /// still learns the loss from [`EventStream::recv`]'s recorded failure.
    async fn send_terminal(&self, event: TmuxEvent) -> bool {
        let budgeted = BudgetedEvent { event, bytes: 0 };
        match self.tx.try_send(budgeted) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(budgeted)) => {
                tokio::time::timeout(EVENT_TERMINAL_EMIT_TIMEOUT, self.tx.send(budgeted))
                    .await
                    .is_ok_and(|sent| sent.is_ok())
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        }
    }

    /// State a source loss both in order (when the queue can carry it) and in
    /// the budget's failure record (when it cannot).
    async fn fail_source_loss(&self, reason: &str) {
        self.budget.record_failure(reason);
        if self
            .send_terminal(TmuxEvent::SourceLost {
                reason: reason.to_string(),
            })
            .await
        {
            self.budget.clear_failure();
        }
    }
}

fn event_bytes(event: &TmuxEvent) -> usize {
    EVENT_OVERHEAD_BYTES
        + match event {
            TmuxEvent::Output(output) => output.data.len() + output.pane_id.len(),
            TmuxEvent::Capture { body } => body.len(),
            TmuxEvent::SourceLost { reason } => reason.len(),
            _ => 0,
        }
}

struct ClientState {
    pending: Mutex<VecDeque<PendingCommand>>,
    closed: AtomicBool,
    next_id: AtomicU64,
}

impl ClientState {
    fn new() -> Self {
        Self {
            pending: Mutex::new(VecDeque::new()),
            closed: AtomicBool::new(false),
            next_id: AtomicU64::new(1),
        }
    }

    /// Whether the next block to close answers a live bootstrap capture.
    ///
    /// The front of the queue is the command the next block replies to. An
    /// abandoned (timed-out) capture is a tombstone, not a barrier: its block
    /// still has to be consumed, and nothing is waiting for its body.
    fn next_block_is_capture(&self) -> bool {
        self.lock()
            .front()
            .map(|entry| entry.capture && !entry.abandoned)
            .unwrap_or(false)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, VecDeque<PendingCommand>> {
        // A poisoned lock here means a thread panicked between a push and the
        // matching write. The queue is still a plain deque, and treating it as
        // empty would misdeliver every later reply, so the data is used as-is.
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Keep the timed-out command's place in the reply order.
    fn abandon(&self, id: u64) {
        let mut pending = self.lock();
        if let Some(entry) = pending.iter_mut().find(|entry| entry.id == id) {
            entry.abandoned = true;
            entry.reply = None;
        }
    }

    /// Resolve every waiter, then mark the client closed.
    fn fail_all(&self, error: TmuxClientError) {
        self.closed.store(true, Ordering::Release);
        let drained: Vec<PendingCommand> = self.lock().drain(..).collect();
        for entry in drained {
            if !entry.abandoned {
                entry.resolve(Err(error.clone()));
            }
        }
    }
}

enum WriteOp {
    Command {
        line: Vec<u8>,
        pending: PendingCommand,
    },
    /// A command whose caller does not wait for the reply. The acknowledgement
    /// only says the command was registered and written, which is the fact an
    /// input frame needs; its tmux reply is still consumed in order.
    Queued {
        line: Vec<u8>,
        pending: PendingCommand,
        accepted: oneshot::Sender<Result<(), TmuxClientError>>,
    },
    Close,
}

/// One attached tmux Control Mode client.
pub struct TmuxClient {
    session_name: String,
    /// Monotonic identity of this attachment; a replaced client's handle is
    /// distinguishable even before its tasks finish.
    generation: u64,
    state: Arc<ClientState>,
    write_tx: mpsc::Sender<WriteOp>,
    events: Option<EventStream>,
    child: Option<ClientChild>,
    reader_task: Option<JoinHandle<()>>,
    writer_task: Option<JoinHandle<()>>,
}

impl TmuxClient {
    /// Attach over the production default (`tmux -C` pipes).
    ///
    /// The attachment's identity is minted here rather than by the caller: it
    /// only has to distinguish a replacement from its predecessor, and the
    /// process is the scope that outlives both. Tests construct through
    /// [`TmuxClient::from_io`] with an explicit generation when they need a
    /// fixed one.
    pub fn connect(tmux: &TmuxCommand, session_name: &str) -> anyhow::Result<Self> {
        Self::connect_with(tmux, session_name, ControlTransport::Pipe)
    }

    /// Attach over an explicitly chosen transport.
    ///
    /// `-C + Pipe` is the default; `-CC + PTY` is the same client API over the
    /// other transport (#2307 slice D). A failed launch returns the transport's
    /// error and never falls back to the other transport.
    pub fn connect_with(
        tmux: &TmuxCommand,
        session_name: &str,
        transport: ControlTransport,
    ) -> anyhow::Result<Self> {
        let io = match transport {
            ControlTransport::Pipe => PipeTransport::connect(tmux, session_name)?,
            #[cfg(unix)]
            ControlTransport::Pty { cols, rows } => {
                PtyTransport::connect(tmux, session_name, cols, rows)?
            }
        };
        Ok(Self::from_io_with_limits(
            session_name,
            io,
            NEXT_ATTACHMENT_GENERATION.fetch_add(1, Ordering::Relaxed),
            EventIngressLimits::default(),
        ))
    }

    /// As [`Self::connect_with`], with explicit ingress limits (#2380).
    pub fn connect_with_limits(
        tmux: &TmuxCommand,
        session_name: &str,
        transport: ControlTransport,
        limits: EventIngressLimits,
    ) -> anyhow::Result<Self> {
        let io = match transport {
            ControlTransport::Pipe => PipeTransport::connect(tmux, session_name)?,
            #[cfg(unix)]
            ControlTransport::Pty { cols, rows } => {
                PtyTransport::connect(tmux, session_name, cols, rows)?
            }
        };
        Ok(Self::from_io_with_limits(
            session_name,
            io,
            NEXT_ATTACHMENT_GENERATION.fetch_add(1, Ordering::Relaxed),
            limits,
        ))
    }

    /// The transport-independent constructor: the same client over any byte
    /// stream pair. Tests use an in-memory duplex; the PTY transport constructs
    /// this same type over a real PTY.
    pub fn from_io(session_name: &str, io: ClientIo, generation: u64) -> Self {
        Self::from_io_with_limits(session_name, io, generation, EventIngressLimits::default())
    }

    /// The transport-independent constructor with explicit ingress limits
    /// (#2380). Tests use a small budget to exercise stalling deterministically.
    pub fn from_io_with_limits(
        session_name: &str,
        io: ClientIo,
        generation: u64,
        limits: EventIngressLimits,
    ) -> Self {
        let state = Arc::new(ClientState::new());
        let budget = Arc::new(EventBudget::new(limits.max_queued_bytes));
        let (events_tx, events_rx) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
        let events = EventStream {
            rx: events_rx,
            budget: Arc::clone(&budget),
        };
        let sink = EventSink {
            tx: events_tx,
            budget,
            admission_timeout: limits.admission_timeout,
        };
        let (write_tx, write_rx) = mpsc::channel(WRITE_CHANNEL_CAPACITY);
        let reader_task = tokio::spawn(run_reader(io.reader, Arc::clone(&state), sink));
        let writer_task = tokio::spawn(run_writer(io.writer, Arc::clone(&state), write_rx));
        Self {
            session_name: session_name.to_string(),
            generation,
            state,
            write_tx,
            events: Some(events),
            child: io.child,
            reader_task: Some(reader_task),
            writer_task: Some(writer_task),
        }
    }

    pub fn session_name(&self) -> &str {
        &self.session_name
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// The attached process, for the drop-path detach fallback (#1011). The
    /// client itself never kills it; only `close` reaps it after a graceful
    /// detach.
    pub fn child_pid(&self) -> Option<u32> {
        self.child.as_ref().and_then(ClientChild::pid)
    }

    pub fn is_closed(&self) -> bool {
        self.state.closed.load(Ordering::Acquire)
    }

    /// The one ordered source-event stream. Handshake, output, capture,
    /// authoritative resize, exit and source loss arrive here in wire order.
    ///
    /// There is one consumer by design: taking the stream moves it to the task
    /// that forwards it into the Agent's stream owner; taking an event releases
    /// its ingress byte credit (#2380).
    pub fn take_events(&mut self) -> Option<EventStream> {
        self.events.take()
    }

    /// Borrow the event stream for a caller that forwards it inline.
    pub fn events(&mut self) -> Option<&mut EventStream> {
        self.events.as_mut()
    }

    /// Run one typed command and wait for its `%end`/`%error`.
    pub async fn command(&self, command: ControlCommand) -> Result<Vec<u8>, TmuxClientError> {
        self.command_with_timeout(command, DEFAULT_COMMAND_TIMEOUT)
            .await
    }

    /// As [`Self::command`], with an explicit reply budget.
    ///
    /// On timeout the caller gets [`TmuxClientError::Timeout`] and the command
    /// keeps a tombstone in the reply order; the eventual reply is dropped
    /// there. A later command is never handed an earlier command's body.
    pub async fn command_with_timeout(
        &self,
        command: ControlCommand,
        timeout: Duration,
    ) -> Result<Vec<u8>, TmuxClientError> {
        self.command_with_options(command, timeout, false).await
    }

    async fn command_with_options(
        &self,
        command: ControlCommand,
        timeout: Duration,
        capture: bool,
    ) -> Result<Vec<u8>, TmuxClientError> {
        if self.is_closed() {
            return Err(TmuxClientError::Closed);
        }
        // One end-to-end deadline covers admission into the ordered writer,
        // the write itself, and the reply (#2379). `mpsc::Sender::send` is
        // cancel-safe: a send cancelled by the deadline is not queued, so an
        // admission timeout truthfully means nothing was written.
        let deadline = tokio::time::Instant::now() + timeout;
        let id = self.state.next_id.fetch_add(1, Ordering::Relaxed);
        let (reply, reply_rx) = oneshot::channel();
        let line = command.encode();
        let op = WriteOp::Command {
            line,
            pending: PendingCommand {
                id,
                abandoned: false,
                capture,
                reply: Some(reply),
            },
        };
        match tokio::time::timeout_at(deadline, self.write_tx.send(op)).await {
            Err(_) => return Err(TmuxClientError::AdmissionTimeout(timeout)),
            Ok(Err(_)) => return Err(TmuxClientError::Closed),
            Ok(Ok(())) => {}
        }
        match tokio::time::timeout_at(deadline, reply_rx).await {
            Ok(Ok(result)) => result,
            // The writer resolves the waiter on a write failure or queue-full;
            // a dropped sender means the writer task ended without resolving
            // this command, which only happens after the source is marked lost.
            Ok(Err(_)) => Err(TmuxClientError::Closed),
            Err(_) => {
                // The command was admitted and may have reached tmux: keep its
                // place so a late reply can never be handed to the next caller.
                self.state.abandon(id);
                Err(TmuxClientError::Timeout(timeout))
            }
        }
    }

    /// Queue a typed command without waiting for tmux's reply.
    ///
    /// The command still occupies its place in the reply order (its block is
    /// consumed there); the caller only learns that it was **written**, which
    /// is what input needs. A full queue or a closed transport is reported
    /// before the caller assumes the bytes left.
    pub async fn send_command_queued(
        &self,
        command: ControlCommand,
        capture: bool,
    ) -> Result<(), TmuxClientError> {
        self.send_command_queued_within(command, capture, DEFAULT_COMMAND_TIMEOUT)
            .await
    }

    /// As [`Self::send_command_queued`], with an explicit end-to-end budget for
    /// admission and the writer's acknowledgement (#2379).
    ///
    /// A timeout after admission means the command may already have reached
    /// tmux; its reply keeps its ordered slot and is consumed there.
    pub async fn send_command_queued_within(
        &self,
        command: ControlCommand,
        capture: bool,
        timeout: Duration,
    ) -> Result<(), TmuxClientError> {
        if self.is_closed() {
            return Err(TmuxClientError::Closed);
        }
        let deadline = tokio::time::Instant::now() + timeout;
        let id = self.state.next_id.fetch_add(1, Ordering::Relaxed);
        let (accepted, accepted_rx) = oneshot::channel();
        let op = WriteOp::Queued {
            line: command.encode(),
            pending: PendingCommand {
                id,
                abandoned: false,
                capture,
                reply: None,
            },
            accepted,
        };
        match tokio::time::timeout_at(deadline, self.write_tx.send(op)).await {
            Err(_) => return Err(TmuxClientError::AdmissionTimeout(timeout)),
            Ok(Err(_)) => return Err(TmuxClientError::Closed),
            Ok(Ok(())) => {}
        }
        match tokio::time::timeout_at(deadline, accepted_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(TmuxClientError::Closed),
            Err(_) => Err(TmuxClientError::Timeout(timeout)),
        }
    }

    /// Byte-exact input to the attached session's active pane.
    pub async fn send_input(&self, data: &[u8]) -> Result<Vec<u8>, TmuxClientError> {
        self.command(ControlCommand::SendKeysHex {
            target: self.session_name.clone(),
            data: data.to_vec(),
        })
        .await
    }

    /// Move the shared window to `cols`×`rows` and ask for a redraw.
    ///
    /// Two tmux commands, therefore two completions. The caller that owns the
    /// size guard (#1490/#1349) decides whether to send at all.
    pub async fn resize_window(&self, cols: u16, rows: u16) -> Result<(), TmuxClientError> {
        self.command(ControlCommand::ResizeWindow {
            target: self.session_name.clone(),
            cols,
            rows,
        })
        .await?;
        self.command(ControlCommand::RefreshClient).await?;
        Ok(())
    }

    /// Capture the session's history through the control channel.
    ///
    /// The body is the response block's raw lines joined with `\n` (no trailing
    /// newline), which is what the bootstrap barrier forwards.
    pub async fn capture_pane(&self, lines: u32) -> Result<Vec<u8>, TmuxClientError> {
        self.command_with_options(
            ControlCommand::CapturePane {
                target: self.session_name.clone(),
                lines,
            },
            DEFAULT_COMMAND_TIMEOUT,
            true,
        )
        .await
    }

    /// Detach, then reap the child. Idempotent.
    ///
    /// The detach goes through the ordered writer so it cannot overtake an
    /// input frame already queued; the child is waited for (never killed, for
    /// the macOS tmux reason `ControlModeSession::close` documents). The wait is
    /// transport-specific and bounded by [`ClientChild::reap`].
    pub async fn close(&mut self) {
        // Every phase is bounded (#2379): a full write channel or a child that
        // stopped draining stdin cannot postpone the detach deadline. When the
        // ordered writer does not observe Close in time it is aborted rather
        // than left owning stdin after `close` returned.
        let _ = tokio::time::timeout(CLOSE_SEND_TIMEOUT, self.write_tx.send(WriteOp::Close)).await;
        if let Some(child) = self.child.take() {
            child.reap().await;
        }
        if let Some(mut task) = self.writer_task.take() {
            if tokio::time::timeout(CLOSE_TASK_TIMEOUT, &mut task)
                .await
                .is_err()
            {
                task.abort();
                let _ = task.await;
            }
        }
        self.state.fail_all(TmuxClientError::Closed);
        // Unblock a reader waiting for ingress credit only after the waiters
        // have their `Closed`: the attachment is going away and no further
        // event can be admitted (#2380).
        if let Some(events) = self.events.as_ref() {
            events.budget.close();
        }
        if let Some(task) = self.reader_task.take() {
            task.abort();
        }
    }
}

/// The writer owns stdin. Registration and the write happen in one ordered
/// step, so a reply cannot arrive before its waiter is visible to the reader.
async fn run_writer<W: AsyncWrite + Unpin>(
    mut writer: W,
    state: Arc<ClientState>,
    mut rx: mpsc::Receiver<WriteOp>,
) {
    while let Some(op) = rx.recv().await {
        // A retired attachment must not execute operations that were still
        // queued when its source was lost or it was closed (#2379). Dropping
        // the operation resolves its waiter through the closed channel, which
        // is the scoped "not delivered" outcome; it is never written.
        if state.closed.load(Ordering::Acquire) {
            drop(op);
            continue;
        }
        match op {
            WriteOp::Command { line, pending } => {
                {
                    let mut queue = state.lock();
                    if queue.len() >= MAX_PENDING_COMMANDS {
                        drop(queue);
                        pending.resolve(Err(TmuxClientError::QueueFull));
                        continue;
                    }
                    queue.push_back(pending);
                }
                if let Err(err) = writer.write_all(&line).await {
                    state.fail_all(TmuxClientError::Transport(err.to_string()));
                    return;
                }
                if let Err(err) = writer.flush().await {
                    state.fail_all(TmuxClientError::Transport(err.to_string()));
                    return;
                }
            }
            WriteOp::Queued {
                line,
                pending,
                accepted,
            } => {
                {
                    let mut queue = state.lock();
                    if queue.len() >= MAX_PENDING_COMMANDS {
                        drop(queue);
                        let _ = accepted.send(Err(TmuxClientError::QueueFull));
                        continue;
                    }
                    queue.push_back(pending);
                }
                if let Err(err) = writer.write_all(&line).await {
                    let error = TmuxClientError::Transport(err.to_string());
                    let _ = accepted.send(Err(error.clone()));
                    state.fail_all(error);
                    return;
                }
                if let Err(err) = writer.flush().await {
                    let error = TmuxClientError::Transport(err.to_string());
                    let _ = accepted.send(Err(error.clone()));
                    state.fail_all(error);
                    return;
                }
                let _ = accepted.send(Ok(()));
            }
            WriteOp::Close => {
                let _ = writer.write_all(b"detach-client\n").await;
                let _ = writer.flush().await;
                return;
            }
        }
    }
}

/// The reader owns stdout and is the only producer of [`TmuxEvent`]s.
async fn run_reader<R: AsyncRead + Unpin>(reader: R, state: Arc<ClientState>, events: EventSink) {
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    let mut open: Option<OpenBlock> = None;
    let mut welcomed = false;
    let mut reported_size: Option<(u16, u16)> = None;

    loop {
        let read = match read_control_line(&mut reader, &mut line).await {
            Ok(read) => read,
            Err(err) => {
                lose(&state, &events, format!("control frame read failed: {err}")).await;
                return;
            }
        };
        if read == 0 {
            lose(&state, &events, "control stream ended".to_string()).await;
            return;
        }
        let record = strip_eol(&line).to_vec();
        line.clear();
        let message = parse_control_line_bytes(&record);
        // Computed before the match moves `message`: the catch-all arm still
        // needs to tell a malformed known record from a forward-compatible
        // unknown notification.
        let malformed = message.is_none() && malformed_known_record(&record);
        let triple = open.as_ref().map(|block| block.triple);

        if let Some(open_triple) = triple {
            match message {
                Some(ControlMessage::End {
                    timestamp,
                    id,
                    flags,
                }) if (timestamp, id, flags) == open_triple => {
                    let Some(block) = open.take() else {
                        lose(&state, &events, "response block closed twice".to_string()).await;
                        return;
                    };
                    match close_block(&state, block, false, &mut welcomed) {
                        BlockOutcome::Desync => {
                            lose(
                                &state,
                                &events,
                                "response block with no pending command".to_string(),
                            )
                            .await;
                            return;
                        }
                        BlockOutcome::Handshaken => {
                            if !emit(&state, &events, TmuxEvent::Handshaken).await {
                                return;
                            }
                        }
                        BlockOutcome::Capture(body) => {
                            if !emit(&state, &events, TmuxEvent::Capture { body }).await {
                                return;
                            }
                        }
                        BlockOutcome::Delivered => {}
                    }
                }
                Some(ControlMessage::Error {
                    timestamp,
                    id,
                    flags,
                }) if (timestamp, id, flags) == open_triple => {
                    let Some(block) = open.take() else {
                        lose(&state, &events, "response block closed twice".to_string()).await;
                        return;
                    };
                    if matches!(
                        close_block(&state, block, true, &mut welcomed),
                        BlockOutcome::Desync
                    ) {
                        lose(
                            &state,
                            &events,
                            "response block with no pending command".to_string(),
                        )
                        .await;
                        return;
                    }
                }
                _ => {
                    // Measured on tmux 3.6b for both `-C` and `-CC` (see
                    // docs/architecture/agent-tmux-control-transport.md):
                    // command output is not escaped and tmux does not
                    // interleave notifications inside an open response block —
                    // an independently generated resize landed after `%end`.
                    // A captured pane line may therefore be exactly `%exit`,
                    // `%output …`, `%layout-change …` or `%window-resize …`,
                    // and routing it as that notification would lose the
                    // captured bytes, fabricate output/resize, or close the
                    // attachment (#2378). Inside the block only the matching
                    // terminator is protocol; every other line is response
                    // body. A real `%exit` that raced an open block is still
                    // bounded by the following EOF, which is a stated source
                    // loss.
                    let Some(block) = open.as_mut() else {
                        continue;
                    };
                    if !block.push(&record) {
                        lose(
                            &state,
                            &events,
                            format!("response body exceeded {MAX_RESPONSE_BODY_BYTES} bytes"),
                        )
                        .await;
                        return;
                    }
                }
            }
            continue;
        }

        match message {
            Some(ControlMessage::Begin {
                timestamp,
                id,
                flags,
            }) => {
                open = Some(OpenBlock {
                    triple: (timestamp, id, flags),
                    body: Vec::new(),
                    has_line: false,
                });
                // The block that just opened answers the queue's front. If that
                // is a live bootstrap capture, this is the barrier: `%output`
                // from here on was generated after the pane read.
                if welcomed
                    && state.next_block_is_capture()
                    && !emit(&state, &events, TmuxEvent::CaptureStarted).await
                {
                    return;
                }
            }
            Some(ControlMessage::Output { pane_id, data }) => {
                if !emit_output(&state, &events, pane_id, &data).await {
                    return;
                }
            }
            Some(ControlMessage::LayoutChange { layout, .. }) => {
                if let Some((cols, rows)) = layout_size(&layout) {
                    if note_size(&mut reported_size, cols, rows)
                        && !emit(&state, &events, TmuxEvent::Resize { cols, rows }).await
                    {
                        return;
                    }
                }
            }
            Some(ControlMessage::WindowResize { cols, rows, .. }) => {
                if note_size(&mut reported_size, cols, rows)
                    && !emit(&state, &events, TmuxEvent::Resize { cols, rows }).await
                {
                    return;
                }
            }
            Some(ControlMessage::Exit) => {
                finish_with_exit(&state, &events).await;
                return;
            }
            // Stray `%end`/`%error`, session notifications and unknown lines
            // are ignored, as before the Client existed.
            _ => {
                if malformed {
                    lose(
                        &state,
                        &events,
                        "malformed tmux Control Mode record".to_string(),
                    )
                    .await;
                    return;
                }
            }
        }
    }
}

struct OpenBlock {
    triple: (u64, u64, u64),
    body: Vec<u8>,
    /// Whether a response line has been observed. Separate from `body.is_empty()`:
    /// an empty line appends zero bytes but is still a line, and every later
    /// line needs the separator that proves it (#2378).
    has_line: bool,
}

impl OpenBlock {
    fn push(&mut self, line: &[u8]) -> bool {
        let needed = line.len() + usize::from(self.has_line);
        if self.body.len().saturating_add(needed) > MAX_RESPONSE_BODY_BYTES {
            return false;
        }
        if self.has_line {
            self.body.push(b'\n');
        }
        self.body.extend_from_slice(line);
        self.has_line = true;
        true
    }
}

/// Resolve the head waiter for one completed block. A block with no waiter
/// after the welcome pair is a desync, not a reply.
fn close_block(
    state: &Arc<ClientState>,
    block: OpenBlock,
    is_error: bool,
    welcomed: &mut bool,
) -> BlockOutcome {
    // The first block a control client receives is tmux's own empty welcome
    // pair; it answers no command, whatever is already queued behind it.
    if !*welcomed {
        *welcomed = true;
        return BlockOutcome::Handshaken;
    }
    let Some(entry) = state.lock().pop_front() else {
        return BlockOutcome::Desync;
    };
    let capture = entry.capture;
    if entry.abandoned {
        return BlockOutcome::Delivered;
    }
    if is_error {
        entry.resolve(Err(TmuxClientError::Rejected(
            String::from_utf8_lossy(&block.body).into_owned(),
        )));
        return BlockOutcome::Delivered;
    }
    entry.resolve(Ok(block.body.clone()));
    if capture {
        BlockOutcome::Capture(block.body)
    } else {
        BlockOutcome::Delivered
    }
}

enum BlockOutcome {
    /// A command reply (or an abandoned/tombstoned one) was consumed.
    Delivered,
    /// The welcome pair closed; no command was answered.
    Handshaken,
    /// A capture body completed and must be published in stream order.
    Capture(Vec<u8>),
    /// The block had no waiter after the welcome: a desync.
    Desync,
}

fn note_size(reported: &mut Option<(u16, u16)>, cols: u16, rows: u16) -> bool {
    if *reported == Some((cols, rows)) {
        return false;
    }
    *reported = Some((cols, rows));
    true
}

async fn emit_output(
    state: &Arc<ClientState>,
    events: &EventSink,
    pane_id: String,
    data: &[u8],
) -> bool {
    match decode_tmux_output(data) {
        Some(bytes) => {
            emit(
                state,
                events,
                TmuxEvent::Output(PaneOutput {
                    pane_id,
                    data: bytes,
                }),
            )
            .await
        }
        None => {
            lose(state, events, "invalid tmux output escape".to_string()).await;
            false
        }
    }
}

async fn emit(state: &Arc<ClientState>, events: &EventSink, event: TmuxEvent) -> bool {
    match events.send(event).await {
        EmitOutcome::Sent => true,
        // A retired attachment (normal close) needs no further loss statement;
        // its callers already received `Closed`.
        EmitOutcome::Closed | EmitOutcome::Overloaded if state.closed.load(Ordering::Acquire) => {
            false
        }
        EmitOutcome::Closed => {
            // Nobody is reading the source facts any more; the attachment is no
            // longer useful to anyone and pending commands must not hang.
            state.fail_all(TmuxClientError::SourceLost(
                "event consumer dropped".to_string(),
            ));
            false
        }
        EmitOutcome::Overloaded => {
            let reason = "event ingress budget exhausted; consumer stalled".to_string();
            // Resolve waiters first: delivering the terminal event is bounded
            // but may itself wait out its budget behind a full queue.
            state.fail_all(TmuxClientError::SourceLost(reason.clone()));
            events.fail_source_loss(&reason).await;
            false
        }
    }
}

async fn finish_with_exit(state: &Arc<ClientState>, events: &EventSink) {
    state.fail_all(TmuxClientError::Closed);
    let _ = events.send_terminal(TmuxEvent::Exited).await;
}

async fn lose(state: &Arc<ClientState>, events: &EventSink, reason: String) {
    state.fail_all(TmuxClientError::SourceLost(reason.clone()));
    events.fail_source_loss(&reason).await;
}

fn strip_eol(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\r\n")
        .or_else(|| line.strip_suffix(b"\n"))
        .unwrap_or(line)
}

#[cfg(test)]
mod tests;
