//! A persistent, typed tmux Control Mode client (#2307).
//!
//! This module owns **one attached control client**: the byte-framed reader, the
//! ordered command/response matcher and the single ordered source-event stream.
//! It is session-owned, not WebSocket-owned: a P2P/Relay subscriber coming and
//! going must not create or destroy the tmux attachment.
//!
//! Deliberate boundaries:
//!
//! - [`TmuxOps`](crate::tmux::ops::TmuxOps) stays the operation-semantics owner;
//!   [`ControlCommand`] is the control-channel encoding of the same operations.
//! - `SessionStreamState`/epoch/seq/replay/ACK stay with the Agent stream owner.
//!   The client emits [`TmuxEvent`]s in source order and assigns nothing.
//! - The byte framing and the `Control Mode` message grammar are **not
//!   re-implemented here**: the reader reuses `control::read_control_line` and
//!   the parser in `tmux::parser`, including the #2300 bounded-byte contract
//!   and its fatal/forward-compatible record split.
//!
//! ## Transports
//!
//! [`ControlTransport::Pipe`] (`tmux -C`) is the production default;
//! [`ControlTransport::Pty`] (`tmux -CC`) runs the identical protocol over a
//! PTY. `-CC` brackets the stream with terminal framing (DCS/ST) and writes
//! `CRLF` line endings; the transport removes that framing before this module
//! sees a byte, so the grammar, matcher and events are the same on both. Both
//! spawn through `TmuxCmd`, and a failed launch is an error — never a silent
//! fallback to the other transport.
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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use super::control::{malformed_known_record, read_control_line};
use super::ops::TmuxDep;
use super::parser::{decode_tmux_output, layout_size, parse_control_line_bytes, ControlMessage};

pub mod commands;
pub mod events;
pub mod transport;

pub use commands::ControlCommand;
pub use events::{PaneOutput, TmuxEvent};
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
const WRITE_CHANNEL_CAPACITY: usize = 64;

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
    /// No reply block arrived within the budget. The command may still execute;
    /// its late reply is consumed by a tombstone and never delivered elsewhere.
    #[error("tmux command timed out after {0:?}")]
    Timeout(Duration),
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
    events: Option<mpsc::Receiver<TmuxEvent>>,
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
    pub fn connect(tmux: &TmuxDep, session_name: &str) -> anyhow::Result<Self> {
        Self::connect_with(tmux, session_name, ControlTransport::Pipe)
    }

    /// Attach over an explicitly chosen transport.
    ///
    /// `-C + Pipe` is the default; `-CC + PTY` is the same client API over the
    /// other transport (#2307 slice D). A failed launch returns the transport's
    /// error and never falls back to the other transport.
    pub fn connect_with(
        tmux: &TmuxDep,
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
        Ok(Self::from_io(
            session_name,
            io,
            NEXT_ATTACHMENT_GENERATION.fetch_add(1, Ordering::Relaxed),
        ))
    }

    /// The transport-independent constructor: the same client over any byte
    /// stream pair. Tests use an in-memory duplex; the PTY transport constructs
    /// this same type over a real PTY.
    pub fn from_io(session_name: &str, io: ClientIo, generation: u64) -> Self {
        let state = Arc::new(ClientState::new());
        let (events_tx, events) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
        let (write_tx, write_rx) = mpsc::channel(WRITE_CHANNEL_CAPACITY);
        let reader_task = tokio::spawn(run_reader(io.reader, Arc::clone(&state), events_tx));
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
    /// There is one consumer by design: taking the receiver moves the stream to
    /// the task that forwards it into the Agent's stream owner.
    pub fn take_events(&mut self) -> Option<mpsc::Receiver<TmuxEvent>> {
        self.events.take()
    }

    /// Borrow the event stream for a caller that forwards it inline.
    pub fn events(&mut self) -> Option<&mut mpsc::Receiver<TmuxEvent>> {
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
        let id = self.state.next_id.fetch_add(1, Ordering::Relaxed);
        let (reply, reply_rx) = oneshot::channel();
        let line = command.encode();
        self.write_tx
            .send(WriteOp::Command {
                line,
                pending: PendingCommand {
                    id,
                    abandoned: false,
                    capture,
                    reply: Some(reply),
                },
            })
            .await
            .map_err(|_| TmuxClientError::Closed)?;
        match tokio::time::timeout(timeout, reply_rx).await {
            Ok(Ok(result)) => result,
            // The writer resolves the waiter on a write failure or queue-full;
            // a dropped sender means the writer task ended without resolving
            // this command, which only happens after the source is marked lost.
            Ok(Err(_)) => Err(TmuxClientError::Closed),
            Err(_) => {
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
        if self.is_closed() {
            return Err(TmuxClientError::Closed);
        }
        let id = self.state.next_id.fetch_add(1, Ordering::Relaxed);
        let (accepted, accepted_rx) = oneshot::channel();
        self.write_tx
            .send(WriteOp::Queued {
                line: command.encode(),
                pending: PendingCommand {
                    id,
                    abandoned: false,
                    capture,
                    reply: None,
                },
                accepted,
            })
            .await
            .map_err(|_| TmuxClientError::Closed)?;
        match accepted_rx.await {
            Ok(result) => result,
            Err(_) => Err(TmuxClientError::Closed),
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
        let _ = self.write_tx.send(WriteOp::Close).await;
        if let Some(child) = self.child.take() {
            child.reap().await;
        }
        if let Some(task) = self.writer_task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
        }
        if let Some(task) = self.reader_task.take() {
            task.abort();
        }
        self.state.fail_all(TmuxClientError::Closed);
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
async fn run_reader<R: AsyncRead + Unpin>(
    reader: R,
    state: Arc<ClientState>,
    events: mpsc::Sender<TmuxEvent>,
) {
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
                Some(ControlMessage::Begin { .. }) => {
                    lose(&state, &events, "nested response block".to_string()).await;
                    return;
                }
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
                    if record.first() == Some(&b'%') {
                        // Unknown/forward-compatible notification.
                        continue;
                    }
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
}

impl OpenBlock {
    fn push(&mut self, line: &[u8]) -> bool {
        let needed = line.len() + usize::from(!self.body.is_empty());
        if self.body.len().saturating_add(needed) > MAX_RESPONSE_BODY_BYTES {
            return false;
        }
        if !self.body.is_empty() {
            self.body.push(b'\n');
        }
        self.body.extend_from_slice(line);
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
    events: &mpsc::Sender<TmuxEvent>,
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

async fn emit(
    state: &Arc<ClientState>,
    events: &mpsc::Sender<TmuxEvent>,
    event: TmuxEvent,
) -> bool {
    if events.send(event).await.is_err() {
        // Nobody is reading the source facts any more; the attachment is no
        // longer useful to anyone and pending commands must not hang.
        state.fail_all(TmuxClientError::SourceLost(
            "event consumer dropped".to_string(),
        ));
        return false;
    }
    true
}

async fn finish_with_exit(state: &Arc<ClientState>, events: &mpsc::Sender<TmuxEvent>) {
    state.fail_all(TmuxClientError::Closed);
    let _ = events.send(TmuxEvent::Exited).await;
}

async fn lose(state: &Arc<ClientState>, events: &mpsc::Sender<TmuxEvent>, reason: String) {
    state.fail_all(TmuxClientError::SourceLost(reason.clone()));
    let _ = events.send(TmuxEvent::SourceLost { reason }).await;
}

fn strip_eol(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\r\n")
        .or_else(|| line.strip_suffix(b"\n"))
        .unwrap_or(line)
}

#[cfg(test)]
mod tests;
