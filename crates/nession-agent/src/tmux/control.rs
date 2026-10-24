//! tmux Control Mode session — the backend one attached nession Session owns.
//!
//! This is the adapter between the Agent's backend trait and
//! [`TmuxClient`](super::client::TmuxClient), which owns the control attachment,
//! its byte framing, ordered command/reply matching and ordered source events.
//! The session adds the two things above the client:
//!
//! - **bootstrap barrier** (#1228/#2124): the capture is written after tmux's
//!   welcome pair and its body is published in stream order between the output
//!   it covers and the output after it, so `attach` can drop exactly the
//!   pre-capture prefix. The ordering is the client's wire order, not a race
//!   between a reader and a waiter;
//! - **window-size guard** (#1490/#1349): a resize to the size tmux last
//!   reported is not written, because the shared window would reflow and every
//!   attached client would repaint for a move that did not happen.
//!
//! Terminal size (cols/rows) is bidirectional: the client tells tmux its
//! desired size on attach and when the browser window resizes; tmux confirms
//! the new size on the control channel, and the agent broadcasts it to all
//! attached clients. Last writer wins — the most recent resize sets the size
//! for everyone.
//!
//! **The confirmation is a `%layout-change`, not a `%window-resize`.** 3.6b
//! emits no `%window-resize` at all (measured 2026-10-01 — a control client
//! attached and resized underneath printed
//! `%layout-change @0 a87d,100x30,0,0,0` and nothing else). The parser still
//! understands `%window-resize` for a tmux that sends it.
//!
//! tmux also has a per-client mechanism (`refresh-client -C`), and this backend
//! deliberately does not use it — every attached client is fed the same
//! `%output` byte stream, so per-client viewports could not be rendered
//! coherently.
//!
//! The wire grammar, byte bounds and Control Mode record decoding live in
//! `tmux::client` (which this module drives) and `tmux::parser`; this module
//! receives typed events and owns the session-level barrier and size guard.
//! It does not decode Control Mode records itself.
//!
//! ## Transport selection (#2307)
//!
//! New control attachments use `tmux -C` over pipes. Setting
//! `NESSION_TMUX_CONTROL_TRANSPORT=pty` selects the `-CC + PTY` transport
//! instead; it is a controlled opt-in for parity evaluation, and any other
//! value (including unset) keeps the production default. A failed `-CC` launch
//! is reported as an error — never a silent fallback to `-C`.

use anyhow::{Context, Result};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, watch, Semaphore};
use tokio::task::JoinHandle;
use tracing::warn;

use super::client::{ControlCommand, ControlTransport, EventStream, TmuxClient, TmuxEvent};
use super::ops::TmuxDep;

/// Buffer capacity for the output channel — bytes-per-batch parsed from tmux.
const OUTPUT_CHANNEL_CAPACITY: usize = 256;
/// Aggregate payload bytes the adapter may hand to the Agent output consumer
/// before it must wait for a take (#2387). The Agent drains this channel into
/// the session stream log; a count-only queue could hold 256 × the 16 MiB
/// control-line bound, so the handoff needs its own byte bound. 32 MiB matches
/// the typed client's ingress budget, which the adaptive pipeline cannot widen
/// by queueing the same payload again downstream.
const DEFAULT_OUTPUT_BUDGET_BYTES: usize = 32 * 1024 * 1024;
/// Per-chunk bookkeeping charged with the payload, so many tiny chunks cannot
/// occupy the credit for free.
const OUTPUT_OVERHEAD_BYTES: usize = 64;
/// How long one output handoff may wait for credit or queue space before the
/// consumer is declared stalled and the source retires (#2387).
const OUTPUT_ADMISSION_TIMEOUT: Duration = Duration::from_secs(10);
/// Bound the aggregate pre-capture replay buffer, not just its event count.
const MAX_PRE_BARRIER_BYTES: usize = 2 * 1024 * 1024;
/// Cap on `%output` chunks held back while the bootstrap capture is in
/// flight. The capture is written the moment the welcome pair arrives, so the
/// window is milliseconds and this never approaches the cap in practice; an
/// overflow degrades to the pre-#1228 behaviour (flush, no capture) —
/// duplication risk over a gap.
const PRE_BARRIER_BUFFER_CHUNKS: usize = OUTPUT_CHANNEL_CAPACITY;

/// The welcome pair is the tmux server's first write on a local socket, and a
/// child that dies before it drops the sender and skips the wait immediately —
/// 5s is the "something is wrong" bound, not the expectation.
const WELCOME_TIMEOUT: Duration = Duration::from_secs(5);
/// A 5000-line capture over a local socket is milliseconds; 10s bounds the
/// pathological (a flooded reader, a loaded CI runner) without turning a wedged
/// server into a hung attach.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);

/// Limits for the ControlModeSession output handoff (#2387).
///
/// Byte credit and the queue are separate resources: the queue is bounded by
/// item count, the credit by aggregate payload. Both legs of one send share an
/// absolute deadline, so a stalled Agent consumer produces a bounded,
/// truthful stream end instead of an uncharged queue or a suspended forwarder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct OutputHandoffLimits {
    max_queued_bytes: usize,
    admission_timeout: Duration,
}

impl Default for OutputHandoffLimits {
    fn default() -> Self {
        Self {
            max_queued_bytes: DEFAULT_OUTPUT_BUDGET_BYTES,
            admission_timeout: OUTPUT_ADMISSION_TIMEOUT,
        }
    }
}

/// One output chunk with the credit it holds until the consumer takes it.
struct BudgetedOutput {
    data: Vec<u8>,
    bytes: u32,
}

/// The Agent's half of the output handoff. Taking a chunk releases exactly the
/// credit that chunk holds, so the adapter's byte accounting cannot drift.
pub struct OutputStream {
    rx: mpsc::Receiver<BudgetedOutput>,
    credit: Arc<Semaphore>,
}

impl OutputStream {
    pub async fn recv(&mut self) -> Option<Vec<u8>> {
        let chunk = self.rx.recv().await?;
        self.credit.add_permits(chunk.bytes as usize);
        Some(chunk.data)
    }

    /// Whether the forwarder has ended (source lost, session retired, or the
    /// handoff stalled past its deadline). Buffered chunks remain readable;
    /// after them `recv` returns `None`.
    pub fn is_closed(&self) -> bool {
        self.rx.is_closed()
    }
}

/// The forwarder's half of the output handoff: byte credit plus the ordered
/// queue, both under one deadline (#2387).
struct OutputSink {
    tx: mpsc::Sender<BudgetedOutput>,
    credit: Arc<Semaphore>,
    limits: OutputHandoffLimits,
}

enum OutputOutcome {
    Sent,
    /// The Agent consumer or the session is gone; no one can take more.
    Closed,
    /// Credit or queue space did not arrive before the deadline.
    Overloaded,
}

impl OutputSink {
    async fn send(&self, data: Vec<u8>) -> OutputOutcome {
        let bytes = data.len().saturating_add(OUTPUT_OVERHEAD_BYTES);
        let Ok(permits) = u32::try_from(bytes) else {
            return OutputOutcome::Overloaded;
        };
        if bytes > self.limits.max_queued_bytes {
            return OutputOutcome::Overloaded;
        }
        let deadline = tokio::time::Instant::now() + self.limits.admission_timeout;
        let permit = match tokio::time::timeout_at(
            deadline,
            Arc::clone(&self.credit).acquire_many_owned(permits),
        )
        .await
        {
            Ok(Ok(permit)) => permit,
            Ok(Err(_)) => return OutputOutcome::Closed,
            Err(_) => return OutputOutcome::Overloaded,
        };
        // A timed-out or cancelled send drops the chunk unsent; dropping the
        // permit then refunds its credit. `forget` transfers the charge to the
        // queued chunk, which `OutputStream::recv` releases.
        match tokio::time::timeout_at(
            deadline,
            self.tx.send(BudgetedOutput {
                data,
                bytes: permits,
            }),
        )
        .await
        {
            Ok(Ok(())) => {
                permit.forget();
                OutputOutcome::Sent
            }
            Ok(Err(_)) => OutputOutcome::Closed,
            Err(_) => OutputOutcome::Overloaded,
        }
    }
}

/// One byte-bounded output handoff and its consumer half.
fn output_handoff(limits: OutputHandoffLimits) -> (OutputSink, OutputStream) {
    let (tx, rx) = mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
    let credit = Arc::new(Semaphore::new(limits.max_queued_bytes));
    (
        OutputSink {
            tx,
            credit: Arc::clone(&credit),
            limits,
        },
        OutputStream { rx, credit },
    )
}

/// Environment variable selecting the transport for new control attachments.
///
/// `-C + Pipe` is the production default; `pty` selects `-CC + PTY`. This is
/// the controlled opt-in parity evaluation uses — not a user setting, and not a
/// fallback: a `-CC` launch that fails is an error.
const TRANSPORT_ENV: &str = "NESSION_TMUX_CONTROL_TRANSPORT";

/// The transport a new attachment uses (#2307 slice D).
fn configured_transport(width: u16, height: u16) -> ControlTransport {
    transport_for(std::env::var(TRANSPORT_ENV).ok().as_deref(), width, height)
}

/// Pure mapping from the selection's value, so the default and the opt-in are
/// testable without mutating process environment.
fn transport_for(value: Option<&str>, width: u16, height: u16) -> ControlTransport {
    match value {
        // The PTY carries the size the window was just set to, so the attach
        // cannot move the shared window as a side effect.
        #[cfg(unix)]
        Some("pty") => ControlTransport::Pty {
            cols: width,
            rows: height,
        },
        _ => ControlTransport::Pipe,
    }
}

/// The size tmux last *reported* for this session's window, shared between the
/// event forwarder — where the report arrives, as `%layout-change` — and the
/// backend, which decides from it whether a resize is worth issuing.
///
/// `None` means "not known": no report has arrived yet, or the source has
/// ended. Both are treated the same way — a resize is issued rather than
/// suppressed — because a suppressed resize leaves the pane at a size the
/// client is not looking at, which is worse than a redundant one.
///
/// It is deliberately **not** "the size this backend last asked for": the
/// window is shared (`window-size latest`), so a peer moving it makes the last
/// request stale, and a guard reading its own request would then skip the
/// resize that puts the pane back where the asking client can see it.
type ObservedWindowSize = Arc<Mutex<Option<(u16, u16)>>>;

/// tmux control mode session — **one per nession session**, shared by every
/// attached web client. The agent's session map is keyed by session name, so a
/// second client attaching joins the existing backend as a subscriber instead
/// of spawning a second attachment.
pub struct ControlModeSession {
    session_name: String,
    client: TmuxClient,
    viewport: (u16, u16),
    /// What tmux last said the window's size is — see [`ObservedWindowSize`].
    observed: ObservedWindowSize,
    /// Forwards client events into the output/resize channels for the rest of
    /// the attachment's life.
    forwarder: Option<JoinHandle<()>>,
    /// The tmux this client is attached to — held rather than resolved per call
    /// because [`Drop`] cannot await, and a client attached to one addressing
    /// must be detached from the same one (#991 step 6).
    tmux: TmuxDep,
}

impl ControlModeSession {
    /// Attach to a tmux session in control mode.
    ///
    /// First resizes the tmux window to `width`×`height`, then attaches through
    /// [`TmuxClient`] and starts forwarding source events.
    ///
    /// `capture_lines` is the bootstrap barrier (#1228): `Some(n)` takes the
    /// session's history **on the control channel** and returns it as the
    /// fourth tuple element, and the output receiver then yields only output
    /// the capture does not cover — see the module docs for why the wire's own
    /// order makes that exact. `None` skips the capture entirely. A capture
    /// that fails, times out, or comes back empty is also `None` on the way
    /// out — the attach proceeds without a bootstrap, which is the state every
    /// attach was in before #321.
    ///
    /// Returns `(session, output_stream, resize_receiver, capture)`. The output
    /// stream yields raw ANSI byte chunks ready to forward to xterm.js, bounded
    /// by aggregate payload bytes (#2387); taking a chunk releases its credit.
    /// The resize receiver is a **level**: it holds the latest authoritative
    /// `(cols, rows)` and `changed()` fires when a new size supersedes it
    /// (#2388). When the tmux process exits, or the output handoff stalls past
    /// its budget, both receivers close.
    pub async fn attach(
        tmux: &TmuxDep,
        session_name: &str,
        width: u16,
        height: u16,
        capture_lines: Option<u32>,
    ) -> Result<(
        Self,
        OutputStream,
        watch::Receiver<(u16, u16)>,
        Option<Vec<u8>>,
    )> {
        // Resize the window before attaching so tmux renders at the right
        // dimensions from the first frame. Through the operation owner, not a
        // locally built argv (#991).
        tmux.ops()
            .resize_window(session_name, width, height)
            .await?;

        let mut client =
            TmuxClient::connect_with(tmux, session_name, configured_transport(width, height))?;
        let mut events = client
            .take_events()
            .context("control client event stream was already taken")?;
        let observed: ObservedWindowSize = Arc::new(Mutex::new(Some((width, height))));
        let (output_tx, output_rx) = output_handoff(OutputHandoffLimits::default());
        // The initial value is the attach size, which is not a change to
        // announce; the first `changed()` is a size tmux actually reported
        // (#2388).
        let (resize_tx, resize_rx) = watch::channel((width, height));

        let capture = match capture_lines {
            None => None,
            Some(lines) => {
                take_bootstrap(
                    &client,
                    &mut events,
                    session_name,
                    lines,
                    &output_tx,
                    &resize_tx,
                    &observed,
                )
                .await
            }
        };

        // The barrier is over (or was not requested): everything still on the
        // stream is live, in the same order the client produced it.
        let forwarder = tokio::spawn(forward_events(
            events,
            output_tx,
            resize_tx,
            Arc::clone(&observed),
        ));

        Ok((
            Self {
                session_name: session_name.to_string(),
                client,
                viewport: (width, height),
                observed,
                forwarder: Some(forwarder),
                tmux: tmux.clone(),
            },
            output_rx,
            resize_rx,
            capture,
        ))
    }

    /// Send raw input bytes to the tmux session using `send-keys -H` (hex).
    ///
    /// The bytes are byte-exact for any value (control codes, high bytes,
    /// non-UTF-8), and this returns once the command is **written** — not when
    /// tmux answers. tmux's answer still occupies its place in the reply order
    /// and is consumed there; waiting for it here would serialize keystrokes
    /// behind a round trip.
    pub async fn write_input(&mut self, data: &[u8]) -> Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        self.client
            .send_command_queued(
                ControlCommand::SendKeysHex {
                    target: self.session_name.clone(),
                    data: data.to_vec(),
                },
                false,
            )
            .await
            .map_err(|err| anyhow::anyhow!("control input failed: {err}"))
    }

    /// Resize the tmux **window** and trigger a full redraw.
    ///
    /// This is not a per-client viewport: one window, one pane, shared by every
    /// client on the session, so this moves the pane for all of them and the
    /// most recent caller wins.
    ///
    /// **Idempotent for the size the window is already at** (#1490). A request
    /// that moves nothing would still reflow the pane and repaint every client,
    /// so the comparison against tmux's own last report decides whether
    /// anything is written.
    pub async fn resize(&mut self, width: u16, height: u16) -> Result<()> {
        if self.window_is_at(width, height) {
            self.viewport = (width, height);
            return Ok(());
        }
        self.viewport = (width, height);
        self.client
            .resize_window(width, height)
            .await
            .map_err(|err| anyhow::anyhow!("control resize failed: {err}"))?;
        // tmux confirms with a `%layout-change` carrying this size; the event
        // forwarder records it. Until then a repeat of this request is treated
        // as already done, because the write above returned.
        if let Ok(mut size) = self.observed.lock() {
            *size = Some((width, height));
        }
        Ok(())
    }

    /// Whether tmux's last report of this window's size is the one asked for.
    ///
    /// A poisoned lock is "not known", which issues the resize: this guard
    /// exists to skip work, never to skip the size a client is looking at.
    fn window_is_at(&self, width: u16, height: u16) -> bool {
        self.observed
            .lock()
            .map(|size| *size == Some((width, height)))
            .unwrap_or(false)
    }

    /// Current viewport (width, height).
    pub fn viewport(&self) -> (u16, u16) {
        self.viewport
    }

    /// Session name this control client is attached to.
    pub fn session_name(&self) -> &str {
        &self.session_name
    }

    /// Close the attachment gracefully. Idempotent.
    ///
    /// The detach is written through the ordered command writer and the child
    /// is waited for; SIGKILL is never used because it can crash the tmux
    /// server on macOS (observed with Homebrew tmux 3.6b).
    pub async fn close(&mut self) -> Result<()> {
        self.client.close().await;
        if let Some(task) = self.forwarder.take() {
            task.abort();
        }
        Ok(())
    }
}

impl Drop for ControlModeSession {
    /// The last-resort detach for a session dropped without `close`.
    ///
    /// `Drop` cannot await, so it uses the same blocking `detach-client -t
    /// client-<pid>` route as before (#1011): `-s <session>` would detach every
    /// client of the session, including one a user attached by hand, and
    /// `-t <session>` detaches nothing at all. The class and silence are
    /// unchanged.
    fn drop(&mut self) {
        if let Some(pid) = self.client.child_pid() {
            let _ = self.tmux.ops().detach_client_by_pid_blocking(pid);
        }
    }
}

/// Output held back while the bootstrap capture is in flight.
///
/// The two exits are different facts: a capture that lands **is** the buffer's
/// content (drop it), while a capture that fails, times out or is skipped
/// leaves the buffer as the only copy (flush it live). Overflow degrades to the
/// pre-#1228 behaviour: flush, abandon the capture — duplication risk over a
/// gap.
struct PreCaptureBuffer {
    chunks: Vec<Vec<u8>>,
    bytes: usize,
}

impl PreCaptureBuffer {
    fn new() -> Self {
        Self {
            chunks: Vec::new(),
            bytes: 0,
        }
    }

    /// Hold one chunk. `false` means the bound was exceeded and the caller
    /// must flush and abandon the capture.
    fn push(&mut self, data: Vec<u8>) -> bool {
        self.bytes = self.bytes.saturating_add(data.len());
        self.chunks.push(data);
        self.chunks.len() <= PRE_BARRIER_BUFFER_CHUNKS && self.bytes <= MAX_PRE_BARRIER_BYTES
    }

    /// Flush the held-back output through the bounded handoff.
    ///
    /// A false result means the Agent consumer stalled past the handoff budget
    /// (or the session retired); the remaining chunks are dropped and the
    /// downstream stream ends, which the Agent turns into a stated
    /// terminal-stream-lost. Never an unbounded await (#2387).
    async fn flush(&mut self, output: &OutputSink) -> bool {
        let mut all_sent = true;
        for chunk in self.chunks.drain(..) {
            if !matches!(output.send(chunk).await, OutputOutcome::Sent) {
                all_sent = false;
                break;
            }
        }
        self.bytes = 0;
        all_sent
    }

    fn clear(&mut self) {
        self.chunks.clear();
        self.bytes = 0;
    }
}

/// Take the bootstrap capture through the ordered stream.
///
/// Returns the capture body, or `None` for a skipped/failed/empty capture.
///
/// The wire order is the barrier (#1228): `%output` before the capture's
/// `%begin` is what the pane read includes, so it is buffered and dropped when
/// the capture lands; output after the block is live. tmux serves control
/// commands synchronously and does not interleave live output inside a
/// response block (measured on both transports, see the transport doc), so the
/// block is entirely capture body. [`TmuxEvent::CaptureStarted`] is the
/// boundary: dropping everything up to [`TmuxEvent::Capture`] would also drop
/// the output that follows the read.
async fn take_bootstrap(
    client: &TmuxClient,
    events: &mut EventStream,
    session_name: &str,
    lines: u32,
    output: &OutputSink,
    resize_tx: &watch::Sender<(u16, u16)>,
    observed: &ObservedWindowSize,
) -> Option<Vec<u8>> {
    let mut buffered = PreCaptureBuffer::new();
    let mut barrier_passed = false;
    let mut abandoned = false;

    // The capture command goes out only after tmux's welcome pair: the first
    // response block is the server's own empty one, and waiting for it is what
    // makes the next block unambiguously ours (#1228). Output cannot precede
    // the welcome on a healthy attachment, but if it does it is pre-barrier
    // output and belongs in the same buffer.
    let handshake_deadline = tokio::time::Instant::now() + WELCOME_TIMEOUT;
    let handshaken = loop {
        match tokio::time::timeout_at(handshake_deadline, events.recv()).await {
            Ok(Some(TmuxEvent::Handshaken)) => break true,
            Ok(Some(TmuxEvent::Output(chunk))) => {
                if abandoned {
                    // The bound was exceeded: the capture is abandoned, so
                    // there is no snapshot this output is covered by.
                    let _ = output.send(chunk.data).await;
                } else if !buffered.push(chunk.data) {
                    warn!("bootstrap: pre-capture buffer overflow for {session_name}");
                    buffered.flush(output).await;
                    abandoned = true;
                }
            }
            Ok(Some(TmuxEvent::Resize { cols, rows })) => {
                note_and_forward(resize_tx, observed, cols, rows);
            }
            // Neither can precede the capture command being written.
            Ok(Some(TmuxEvent::CaptureStarted | TmuxEvent::Capture { .. })) => {}
            Ok(Some(TmuxEvent::Exited | TmuxEvent::SourceLost { .. })) | Ok(None) | Err(_) => {
                break false;
            }
        }
    };
    if !handshaken {
        warn!("bootstrap: control handshake did not complete for {session_name}");
        buffered.flush(output).await;
        return None;
    }
    if abandoned {
        // The bound was already exceeded and the buffer flushed; a capture now
        // would only be a slower way to the same `None`.
        return None;
    }
    if let Err(err) = client
        .send_command_queued(
            ControlCommand::CapturePane {
                target: session_name.to_string(),
                lines,
            },
            true,
        )
        .await
    {
        warn!("bootstrap: control-channel capture write failed for {session_name}: {err}");
        buffered.flush(output).await;
        return None;
    }

    let deadline = tokio::time::Instant::now() + CAPTURE_TIMEOUT;
    loop {
        let event = match tokio::time::timeout_at(deadline, events.recv()).await {
            Err(_) => {
                warn!("bootstrap: control-channel capture timed out for {session_name}");
                break;
            }
            // The source ended mid-capture: no capture will land, and nothing
            // after it will be forwarded either — but the bytes already held
            // back are still the only copy of that output.
            Ok(None) | Ok(Some(TmuxEvent::Exited | TmuxEvent::SourceLost { .. })) => {
                buffered.flush(output).await;
                return None;
            }
            Ok(Some(event)) => event,
        };
        match event {
            // The pane read happened here: later output is live.
            TmuxEvent::CaptureStarted => barrier_passed = true,
            TmuxEvent::Output(chunk) => {
                if barrier_passed || abandoned {
                    let _ = output.send(chunk.data).await;
                } else if !buffered.push(chunk.data) {
                    warn!("bootstrap: pre-capture buffer overflow for {session_name}");
                    buffered.flush(output).await;
                    abandoned = true;
                    barrier_passed = true;
                }
            }
            TmuxEvent::Capture { body } => {
                if abandoned {
                    return None;
                }
                // The capture carries everything the buffer holds: dropping it
                // is the barrier.
                buffered.clear();
                return if body.is_empty() { None } else { Some(body) };
            }
            TmuxEvent::Resize { cols, rows } => {
                note_and_forward(resize_tx, observed, cols, rows);
            }
            TmuxEvent::Handshaken => {}
            // Caught above, where the buffered output can still be flushed.
            TmuxEvent::Exited | TmuxEvent::SourceLost { .. } => return None,
        }
    }

    // A failed or timed-out capture leaves the held-back output as the only
    // copy of what it covers.
    buffered.flush(output).await;
    None
}

/// Forward source events for the life of the attachment, in client order.
///
/// This is the **single ordered consumer**: a blocking wait here stops output,
/// resize and source-loss handling behind it. The output handoff is byte- and
/// deadline-bounded (#2387); resize is a level delivered through a watch
/// channel that never waits (#2388).
async fn forward_events(
    mut events: EventStream,
    output: OutputSink,
    resize_tx: watch::Sender<(u16, u16)>,
    observed: ObservedWindowSize,
) {
    while let Some(event) = events.recv().await {
        match event {
            TmuxEvent::Output(chunk) => {
                if !matches!(output.send(chunk.data).await, OutputOutcome::Sent) {
                    // The Agent consumer stalled past the handoff budget, or
                    // the session is being torn down. Ending the forwarder
                    // closes the output stream, which the Agent turns into a
                    // stated terminal-stream-lost rather than a healthy-looking
                    // freeze.
                    break;
                }
            }
            TmuxEvent::Resize { cols, rows } => {
                note_and_forward(&resize_tx, &observed, cols, rows);
            }
            TmuxEvent::Exited | TmuxEvent::SourceLost { .. } => break,
            // All three belong to a bootstrap capture consumed in
            // `take_bootstrap`; a later one would be a direct caller's reply,
            // not a source fact.
            TmuxEvent::Handshaken | TmuxEvent::CaptureStarted | TmuxEvent::Capture { .. } => {}
        }
    }
    // Nothing is updating this any more, so it stops being a fact a resize can
    // be suppressed with: from here a requested size is issued, not compared.
    if let Ok(mut size) = observed.lock() {
        *size = None;
    }
}

/// Record and publish the window's authoritative size.
///
/// Resize is a **level, not a sequence of records**: the latest size is the
/// authoritative one, and the Agent already publishes it to peers as a level
/// (`SubscriberIssuedFlow`/resize-reporter latest-wins). A watch channel
/// therefore holds the final size without blocking the single forwarder and
/// without inventing a stream cursor; a stalled consumer that never saw an
/// intermediate size is superseded by the final one by definition (#2388).
/// Omitting a *transient* size cannot leave the pane at a size the client is
/// not looking at, because the final report is always delivered.
fn note_and_forward(
    resize_tx: &watch::Sender<(u16, u16)>,
    observed: &ObservedWindowSize,
    cols: u16,
    rows: u16,
) {
    if let Ok(mut size) = observed.lock() {
        *size = Some((cols, rows));
    }
    // Best-effort: the only failure is "the receiver is gone" (session
    // teardown). `send_if_modified` keeps a repeated size from waking the
    // consumer as if it were news.
    let _ = resize_tx.send_if_modified(|current| {
        if *current == (cols, rows) {
            false
        } else {
            *current = (cols, rows);
            true
        }
    });
}

#[async_trait::async_trait]
impl super::session::TmuxSession for ControlModeSession {
    async fn write_input(&mut self, data: &[u8]) -> Result<()> {
        ControlModeSession::write_input(self, data).await
    }

    async fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        ControlModeSession::resize(self, cols, rows).await
    }

    fn viewport(&self) -> (u16, u16) {
        ControlModeSession::viewport(self)
    }

    fn session_name(&self) -> &str {
        ControlModeSession::session_name(self)
    }

    async fn close(&mut self) -> Result<()> {
        ControlModeSession::close(self).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tmux::client::ClientIo;
    use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};

    const WELCOME: &str = "%begin 1 0 0\n%end 1 0 0\n";

    #[test]
    fn the_transport_selection_keeps_pipe_as_the_default() {
        assert_eq!(transport_for(None, 80, 24), ControlTransport::Pipe);
        assert_eq!(transport_for(Some("pipe"), 80, 24), ControlTransport::Pipe);
        assert_eq!(
            transport_for(Some("nonsense"), 80, 24),
            ControlTransport::Pipe,
            "an unrecognized value must not change the production default"
        );
        #[cfg(unix)]
        assert_eq!(
            transport_for(Some("pty"), 120, 40),
            ControlTransport::Pty {
                cols: 120,
                rows: 40
            },
            "the PTY carries the size the window is already at"
        );
    }

    /// A client over an in-memory wire that plays tmux, plus the tmux side.
    fn boot_wire() -> (TmuxClient, BufReader<DuplexStream>, DuplexStream) {
        let (client_reader, tmux_tx) = duplex(1 << 16);
        let (client_writer, tmux_rx) = duplex(1 << 16);
        let io = ClientIo {
            reader: Box::new(client_reader),
            writer: Box::new(client_writer),
            child: None,
        };
        (
            TmuxClient::from_io("work", io, 1),
            BufReader::new(tmux_rx),
            tmux_tx,
        )
    }

    #[tokio::test]
    async fn the_bootstrap_drops_the_output_its_capture_covers_and_keeps_the_output_after_it() {
        // The barrier's exact cut, without a tmux: output before the capture's
        // `%begin` is inside the pane read (dropped), and everything the block
        // contains is the capture body. tmux does not interleave live output
        // inside a response block (measured on -C and -CC), so an
        // output-shaped line there is body bytes, not a second live copy
        // (#2378) — the same contract the typed client enforces.
        let (mut client, mut tmux_rx, mut tmux_tx) = boot_wire();
        let mut events = client.take_events().expect("the test owns the events");
        let (output_tx, mut output_rx) = output_handoff(OutputHandoffLimits {
            max_queued_bytes: 1 << 20,
            admission_timeout: Duration::from_secs(2),
        });
        let (resize_tx, _resize_rx) = watch::channel((80, 24));
        let observed: ObservedWindowSize = Arc::new(Mutex::new(Some((80, 24))));

        let fake = async {
            tmux_tx
                .write_all(WELCOME.as_bytes())
                .await
                .expect("welcome");
            let mut command = String::new();
            tmux_rx
                .read_line(&mut command)
                .await
                .expect("capture command");
            assert_eq!(command, "capture-pane -t work -p -S -10 -E - -e -J\n");
            tmux_tx
                .write_all(b"%output %0 before\n")
                .await
                .expect("pre-capture output");
            tmux_tx
                .write_all(b"%begin 2 1 0\nline one\n%output %0 inside\nline two\n%end 2 1 0\n")
                .await
                .expect("capture block");
            // Written in the same batch: the barrier returns at the capture,
            // so this is what the forwarder sees next.
            tmux_tx
                .write_all(b"%output %0 after\n")
                .await
                .expect("post-capture output");
        };

        let (capture, ()) = tokio::join!(
            take_bootstrap(
                &client,
                &mut events,
                "work",
                10,
                &output_tx,
                &resize_tx,
                &observed,
            ),
            fake,
        );

        assert_eq!(
            capture.as_deref(),
            Some(&b"line one\n%output %0 inside\nline two"[..]),
            "the capture body is every line of the response block"
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(100), output_rx.recv())
                .await
                .is_err(),
            "neither the covered output nor an in-block output-shaped line is forwarded live"
        );
        // What follows the capture in the stream is still in order for the
        // forwarder that takes over after the barrier.
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), events.recv())
                .await
                .expect("post-capture output is published")
                .expect("the event stream stays open"),
            TmuxEvent::Output(crate::tmux::client::PaneOutput {
                pane_id: "%0".to_string(),
                data: b"after".to_vec(),
            }),
        );
        client.close().await;
    }

    #[tokio::test]
    async fn a_capture_that_never_lands_flushes_the_output_it_would_have_covered() {
        // Source loss mid-capture: no snapshot is coming, so the held-back
        // output is the only copy of what it covers.
        let (mut client, mut tmux_rx, mut tmux_tx) = boot_wire();
        let mut events = client.take_events().expect("the test owns the events");
        let (output_tx, mut output_rx) = output_handoff(OutputHandoffLimits {
            max_queued_bytes: 1 << 20,
            admission_timeout: Duration::from_secs(2),
        });
        let (resize_tx, _resize_rx) = watch::channel((80, 24));
        let observed: ObservedWindowSize = Arc::new(Mutex::new(Some((80, 24))));

        let fake = async {
            tmux_tx
                .write_all(WELCOME.as_bytes())
                .await
                .expect("welcome");
            let mut command = String::new();
            tmux_rx
                .read_line(&mut command)
                .await
                .expect("capture command");
            tmux_tx
                .write_all(b"%output %0 before\n")
                .await
                .expect("pre-capture output");
            // End the source without ever closing the capture's block.
            drop(tmux_tx);
        };

        let (capture, ()) = tokio::join!(
            take_bootstrap(
                &client,
                &mut events,
                "work",
                10,
                &output_tx,
                &resize_tx,
                &observed,
            ),
            fake,
        );

        assert!(capture.is_none(), "there was no capture to return");
        let live = tokio::time::timeout(Duration::from_secs(2), output_rx.recv())
            .await
            .expect("the held-back output is flushed")
            .expect("the output channel stays open");
        assert_eq!(live, b"before");
        client.close().await;
    }

    /// #2387 SC-01/SC-02: the output handoff is bounded by aggregate payload
    /// bytes, and a stalled Agent consumer fails the handoff at its deadline
    /// instead of growing an uncharged queue or suspending the forwarder.
    #[tokio::test]
    async fn a_stalled_output_consumer_fails_closed_at_the_handoff_deadline() {
        let (sink, mut stream) = output_handoff(OutputHandoffLimits {
            max_queued_bytes: 1024,
            admission_timeout: Duration::from_millis(150),
        });
        // 400 payload + 64 overhead = 464 charged; two fit in 1024.
        let chunk = vec![b'x'; 400];
        assert!(matches!(
            sink.send(chunk.clone()).await,
            OutputOutcome::Sent
        ));
        assert!(matches!(
            sink.send(chunk.clone()).await,
            OutputOutcome::Sent
        ));

        let started = std::time::Instant::now();
        assert!(
            matches!(sink.send(chunk.clone()).await, OutputOutcome::Overloaded),
            "a stalled consumer must exhaust its credit at the deadline"
        );
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "the handoff outlived its configured deadline: {:?}",
            started.elapsed()
        );

        // Taking one chunk releases exactly its credit; one more send fits.
        assert_eq!(stream.recv().await.as_deref(), Some(&chunk[..]));
        assert!(matches!(sink.send(chunk).await, OutputOutcome::Sent));

        // A payload larger than the whole budget is never admitted.
        let oversized = vec![b'y'; 4096];
        assert!(matches!(
            sink.send(oversized).await,
            OutputOutcome::Overloaded
        ));

        // Dropping the forwarder's half closes the stream after the admitted
        // chunks; every take released its credit.
        drop(sink);
        while stream.recv().await.is_some() {}
    }

    /// #2387 SC-01: byte credit alone does not bound the item-count queue. With
    /// a large byte budget and tiny chunks the queue fills while credit is
    /// free; the send must share the same deadline and fail closed.
    #[tokio::test]
    async fn a_full_output_queue_fails_closed_at_the_handoff_deadline() {
        let (sink, mut stream) = output_handoff(OutputHandoffLimits {
            max_queued_bytes: 1024 * 1024,
            admission_timeout: Duration::from_millis(150),
        });
        for _ in 0..OUTPUT_CHANNEL_CAPACITY {
            assert!(matches!(
                sink.send(vec![b'x'; 8]).await,
                OutputOutcome::Sent
            ));
        }
        let started = std::time::Instant::now();
        assert!(matches!(
            sink.send(vec![b'x'; 8]).await,
            OutputOutcome::Overloaded
        ));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "a full queue pinned the forwarder past its deadline: {:?}",
            started.elapsed()
        );

        // The failed send refunded its credit and freed no slot; taking one
        // chunk frees both, and the next send is admitted in order.
        assert!(stream.recv().await.is_some());
        assert!(matches!(
            sink.send(vec![b'x'; 8]).await,
            OutputOutcome::Sent
        ));
    }

    /// #2388 SC-01: a live-but-stalled resize consumer cannot suspend the
    /// single ordered forwarder; output after more than 16 distinct resizes
    /// still arrives, and the stalled consumer reads the final authoritative
    /// size when it resumes.
    #[tokio::test]
    async fn a_stalled_resize_consumer_does_not_block_output() {
        let (mut client, _tmux_rx, mut tmux_tx) = boot_wire();
        let events = client.take_events().expect("the test owns the events");
        let (output, mut output_rx) = output_handoff(OutputHandoffLimits {
            max_queued_bytes: 1 << 20,
            admission_timeout: Duration::from_secs(2),
        });
        let (resize_tx, mut resize_rx) = watch::channel((80, 24));
        let observed: ObservedWindowSize = Arc::new(Mutex::new(Some((80, 24))));
        let forwarder = tokio::spawn(forward_events(
            events,
            output,
            resize_tx,
            Arc::clone(&observed),
        ));

        // The resize receiver stays alive but is never read (capacity 16 in the
        // old queue): the 17th distinct resize must not strand the forwarder.
        tmux_tx
            .write_all(WELCOME.as_bytes())
            .await
            .expect("welcome");
        for width in 81u16..=101 {
            tmux_tx
                .write_all(format!("%layout-change @0 a87d,{width}x30,0,0,0\n").as_bytes())
                .await
                .expect("resize notification");
        }
        tmux_tx
            .write_all(b"%output %0 AFTER-RESIZES\n")
            .await
            .expect("post-resize output");

        let chunk = tokio::time::timeout(Duration::from_secs(2), output_rx.recv())
            .await
            .expect("output must not wait for the resize consumer")
            .expect("the output stream stays open until the source ends");
        assert!(
            String::from_utf8_lossy(&chunk).contains("AFTER-RESIZES"),
            "the output after 21 distinct resizes was lost"
        );

        // The stalled consumer, once it resumes, reads the final level — not a
        // replay of stale intermediate sizes and not a fabricated cursor.
        assert_eq!(
            *resize_rx.borrow_and_update(),
            (101, 30),
            "the final authoritative size must survive a stalled consumer"
        );

        // The forwarder is still alive and the session still owns the source.
        assert!(!forwarder.is_finished());
        drop(tmux_tx);
        forwarder.abort();
        client.close().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_injected_tmux_receives_the_control_mode_attach_and_the_detach() {
        // The control-mode backend reaches tmux three ways — `resize-window`
        // through `TmuxOps` before it attaches, `-C attach` as its own child,
        // and `detach-client` on the way out — and all three ran on the
        // process-wide tmux before #991 step 6.
        //
        // **This one runs on macOS too**, which the control-mode integration
        // tests (skipped on macOS because a real tmux server can be crashed by
        // parallel control-mode clients) cannot.
        let dir = tempfile::tempdir().expect("tempdir");
        let child_pid = dir.path().join("child.pid");
        let fake = crate::test_support::FakeTmux::new(
            dir.path(),
            &format!(
                "case \"$1\" in \
                 attach|-C) echo $$ > \"{pid}\"; exit 0;; \
                 list-clients) p=$(cat \"{pid}\" 2>/dev/null || echo 0); \
                   echo \"$p client-$p\"; exit 0;; \
                 *) exit 0;; esac",
                pid = child_pid.display(),
            ),
        );

        let (session, _rx, _resize_rx, capture) =
            ControlModeSession::attach(&fake.dep(), "nession-fake-sess", 80, 24, None)
                .await
                .expect("the injected binary accepts the resize and the attach");
        assert_eq!(session.viewport(), (80, 24));
        assert!(capture.is_none(), "no capture was requested");

        let calls = fake
            .wait_for_calls(3, std::time::Duration::from_secs(10))
            .await;
        assert_eq!(
            calls.first(),
            Some(&vec![
                "resize-window".to_string(),
                "-t".to_string(),
                "nession-fake-sess".to_string(),
                "-x".to_string(),
                "80".to_string(),
                "-y".to_string(),
                "24".to_string(),
            ]),
            "the window is resized before the attach, through the injected tmux: {calls:?}"
        );
        assert!(
            calls.iter().any(|args| args
                == &vec![
                    "-C".to_string(),
                    "attach".to_string(),
                    "-t".to_string(),
                    "nession-fake-sess".to_string(),
                ]),
            "the control-mode client is the injected binary: {calls:?}"
        );

        drop(session);
        let calls = fake.calls();
        let pid = std::fs::read_to_string(&child_pid)
            .expect("the attach branch records its pid")
            .trim()
            .to_string();
        assert!(
            calls.iter().any(|args| args
                == &vec![
                    "detach-client".to_string(),
                    "-t".to_string(),
                    format!("client-{pid}"),
                ]),
            "a control-mode client must detach the client it spawned ({pid}), on \
             the tmux it attached to: {calls:?}"
        );
    }
}
