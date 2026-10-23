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
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::warn;

use super::client::{ControlCommand, ControlTransport, TmuxClient, TmuxEvent};
use super::ops::TmuxDep;

/// Buffer capacity for the output channel — bytes-per-batch parsed from tmux.
const OUTPUT_CHANNEL_CAPACITY: usize = 256;
/// Buffer capacity for the resize channel — one (cols, rows) tuple per event.
const RESIZE_CHANNEL_CAPACITY: usize = 16;
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
    /// Returns `(session, output_receiver, resize_receiver, capture)`. The
    /// output receiver yields raw ANSI byte chunks ready to forward to xterm.js.
    /// The resize receiver yields `(cols, rows)` each time the window's size
    /// changes. When the tmux process exits (or the forwarder ends), both
    /// receivers close.
    pub async fn attach(
        tmux: &TmuxDep,
        session_name: &str,
        width: u16,
        height: u16,
        capture_lines: Option<u32>,
    ) -> Result<(
        Self,
        mpsc::Receiver<Vec<u8>>,
        mpsc::Receiver<(u16, u16)>,
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
        let (output_tx, output_rx) = mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
        let (resize_tx, resize_rx) = mpsc::channel(RESIZE_CHANNEL_CAPACITY);

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

    async fn flush(&mut self, output_tx: &mpsc::Sender<Vec<u8>>) {
        for chunk in self.chunks.drain(..) {
            let _ = output_tx.send(chunk).await;
        }
        self.bytes = 0;
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
/// the capture lands; output *inside* or after the response block was generated
/// after the read, so it is live. [`TmuxEvent::CaptureStarted`] is that
/// boundary — dropping everything up to [`TmuxEvent::Capture`] would also drop
/// the interleaved output, which the capture does not contain.
async fn take_bootstrap(
    client: &TmuxClient,
    events: &mut mpsc::Receiver<TmuxEvent>,
    session_name: &str,
    lines: u32,
    output_tx: &mpsc::Sender<Vec<u8>>,
    resize_tx: &mpsc::Sender<(u16, u16)>,
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
            Ok(Some(TmuxEvent::Output(output))) => {
                if abandoned {
                    // The bound was exceeded: the capture is abandoned, so
                    // there is no snapshot this output is covered by.
                    let _ = output_tx.send(output.data).await;
                } else if !buffered.push(output.data) {
                    warn!("bootstrap: pre-capture buffer overflow for {session_name}");
                    buffered.flush(output_tx).await;
                    abandoned = true;
                }
            }
            Ok(Some(TmuxEvent::Resize { cols, rows })) => {
                note_and_forward(resize_tx, observed, cols, rows).await;
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
        buffered.flush(output_tx).await;
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
        buffered.flush(output_tx).await;
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
                buffered.flush(output_tx).await;
                return None;
            }
            Ok(Some(event)) => event,
        };
        match event {
            // The pane read happened here: later output is live.
            TmuxEvent::CaptureStarted => barrier_passed = true,
            TmuxEvent::Output(output) => {
                if barrier_passed || abandoned {
                    let _ = output_tx.send(output.data).await;
                } else if !buffered.push(output.data) {
                    warn!("bootstrap: pre-capture buffer overflow for {session_name}");
                    buffered.flush(output_tx).await;
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
                note_and_forward(resize_tx, observed, cols, rows).await;
            }
            TmuxEvent::Handshaken => {}
            // Caught above, where the buffered output can still be flushed.
            TmuxEvent::Exited | TmuxEvent::SourceLost { .. } => return None,
        }
    }

    // A failed or timed-out capture leaves the held-back output as the only
    // copy of what it covers.
    buffered.flush(output_tx).await;
    None
}

/// Forward source events for the life of the attachment, in client order.
async fn forward_events(
    mut events: mpsc::Receiver<TmuxEvent>,
    output_tx: mpsc::Sender<Vec<u8>>,
    resize_tx: mpsc::Sender<(u16, u16)>,
    observed: ObservedWindowSize,
) {
    while let Some(event) = events.recv().await {
        match event {
            TmuxEvent::Output(output) => {
                if output_tx.send(output.data).await.is_err() {
                    // Receiver dropped — the session is being torn down.
                    break;
                }
            }
            TmuxEvent::Resize { cols, rows } => {
                note_and_forward(&resize_tx, &observed, cols, rows).await;
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

async fn note_and_forward(
    resize_tx: &mpsc::Sender<(u16, u16)>,
    observed: &ObservedWindowSize,
    cols: u16,
    rows: u16,
) {
    // Scoped so the guard is not held across the send: a lock across an await
    // in this loop would stall every later event behind a slow consumer.
    if let Ok(mut size) = observed.lock() {
        *size = Some((cols, rows));
    }
    // Best-effort: an internal send whose only failure is "the receiver is
    // gone". No tmux operation class applies.
    let _ = resize_tx.send((cols, rows)).await;
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
    async fn the_bootstrap_drops_the_output_its_capture_covers_and_keeps_the_interleaved_output() {
        // The barrier's exact cut, without a tmux: output before the capture's
        // `%begin` is inside the pane read (dropped), output inside the
        // response block was generated after it (live).
        let (mut client, mut tmux_rx, mut tmux_tx) = boot_wire();
        let mut events = client.take_events().expect("the test owns the events");
        let (output_tx, mut output_rx) = mpsc::channel(16);
        let (resize_tx, _resize_rx) = mpsc::channel(4);
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
            Some(&b"line one\nline two"[..]),
            "the capture body is the response block's data lines"
        );
        let live = tokio::time::timeout(Duration::from_secs(2), output_rx.recv())
            .await
            .expect("interleaved output is live")
            .expect("the output channel stays open");
        assert_eq!(live, b"inside", "the interleaved output is not covered");
        assert!(
            tokio::time::timeout(Duration::from_millis(100), output_rx.recv())
                .await
                .is_err(),
            "the pre-capture output was dropped, not forwarded"
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
        let (output_tx, mut output_rx) = mpsc::channel(16);
        let (resize_tx, _resize_rx) = mpsc::channel(4);
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
