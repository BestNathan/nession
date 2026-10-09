//! tmux control mode session 管理
//!
//! Uses `tmux -C attach` to control a tmux session, parsing structured
//! messages instead of raw PTY output.
//!
//! Terminal size (cols/rows) is bidirectional: the client tells tmux its
//! desired size on attach and when the browser window resizes; tmux confirms
//! the new size on the control channel, and the agent broadcasts it to all
//! attached clients. Last writer wins — the most recent resize sets
//! the size for everyone.
//!
//! **The confirmation is a `%layout-change`, not a `%window-resize`.** This
//! module said the latter for as long as it existed and it was never true of
//! the tmux the image pins: 3.6b emits no `%window-resize` at all (measured
//! 2026-10-01 — a control client attached and resized underneath printed
//! `%layout-change @0 a87d,100x30,0,0,0` and nothing else). Everything here
//! used to depend on that line, including the resize-lane publish, so a peer
//! reflowing the shared window reached no other client (#1349).
//! [`ControlMessage::WindowResize`] is still routed for a tmux that sends it.
//!
//! **That is a decision, not an accident.**
//! `2026-08-15-viewport-fit-terminal-migration-design.md` §2 chose it
//! explicitly ("accept last-writer-wins … No arbitration"), superseding the
//! earlier fixed-200×60 model. The resource being resized is the tmux
//! **window**: one per session, one pane, shared by every attached client.
//!
//! tmux also has a per-client mechanism (`refresh-client -C`), and this
//! backend deliberately does not use it — every attached client is fed the
//! same `%output` byte stream, so per-client viewports could not be rendered
//! coherently. See [`ControlModeSession::resize`].
//!
//! # The bootstrap barrier (#1228)
//!
//! `attach` can take the session's history **on the control channel itself**
//! (`capture_lines`), and that is what makes the snapshot join the live
//! stream exactly. tmux executes a command synchronously between queueing
//! its `%begin` and the response text, and a control client's wire is
//! ordered, so a `%output` queued before the capture's `%begin` is output
//! the pane read includes, and one queued after — including interleaved
//! *inside* a long response block — is output it does not. The reader loop
//! holds pre-barrier output back and drops it when the capture lands; the
//! returned receiver therefore starts where the snapshot ends. Measured on
//! tmux 3.6b: the indices before the response block are exactly the
//! capture's tail, the indices after it start at the next one.
//!
//! The pre-#1228 shape captured from a *separate* tmux process, whose
//! ordering against the control client's `%output` stream nothing
//! constrained: whatever the pane produced between the control attach and
//! the capture arrived twice.

use anyhow::{Context, Result};
use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot, watch};
use tracing::warn;

use super::ops::TmuxDep;
use super::parser::{parse_control_line, unescape_tmux_data, ControlMessage};

/// Buffer capacity for the output channel — bytes-per-batch parsed from tmux.
const OUTPUT_CHANNEL_CAPACITY: usize = 256;

/// Buffer capacity for the resize channel — one (cols, rows) tuple per event.
const RESIZE_CHANNEL_CAPACITY: usize = 16;

/// Cap on `%output` chunks held back while the bootstrap capture is in
/// flight. The capture is written the moment the welcome pair arrives, so
/// the window is milliseconds and this never approaches the cap in practice;
/// an overflow degrades to the pre-#1228 behaviour (flush, no capture) —
/// duplication risk over a gap.
const PRE_BARRIER_BUFFER_CHUNKS: usize = OUTPUT_CHANNEL_CAPACITY;

/// The welcome pair is the tmux server's first write on a local socket, and
/// a child that dies before it drops the sender and skips the wait
/// immediately — 5s is the "something is wrong" bound, not the expectation.
const WELCOME_TIMEOUT: Duration = Duration::from_secs(5);

/// A 5000-line capture over a local socket is milliseconds; 10s bounds the
/// pathological (a flooded reader, a loaded CI runner) without turning a
/// wedged server into a hung attach.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);

/// The size tmux last *reported* for this session's window, shared between the
/// reader task — where the report arrives, as `%layout-change` — and the
/// backend, which decides from it whether a resize is worth issuing.
///
/// `None` means "not known": no report has arrived yet, or the reader has
/// ended. Both are treated the same way — a resize is issued rather than
/// suppressed — because a suppressed resize leaves the pane at a size the
/// client is not looking at, and that is worse than a redundant one.
///
/// It is deliberately **not** "the size this backend last asked for": the
/// window is shared (`window-size latest`), so a peer moving it makes the last
/// request stale, and a guard reading its own request would then skip the
/// resize that puts the pane back where the asking client can see it.
type ObservedWindowSize = Arc<Mutex<Option<(u16, u16)>>>;

/// tmux control mode session — **one per nession session**, shared by every
/// attached web client. The agent's session map is keyed by session name, so a
/// second client attaching joins the existing backend as a subscriber instead
/// of spawning a second `tmux -C attach` (`server/websocket.rs`).
///
/// Spawns a `tmux -C attach` subprocess and pipes structured messages
/// (parsed to raw ANSI bytes) through an mpsc channel. The caller drives
/// input via `write_input` and resizes the shared tmux window via `resize`.
pub struct ControlModeSession {
    session_name: String,
    child: Child,
    stdin: ChildStdin,
    viewport: (u16, u16),
    /// What tmux last said the window's size is — see [`ObservedWindowSize`].
    observed: ObservedWindowSize,
    /// The tmux this client is attached to — held rather than resolved per
    /// call because [`Drop`] cannot reach the process, and a client attached
    /// to one addressing must be detached from the same one (#991 step 6).
    tmux: TmuxDep,
}

impl ControlModeSession {
    /// Attach to a tmux session in control mode.
    ///
    /// First resizes the tmux window to `width`×`height`, then spawns
    /// `tmux -C attach -t <session_name>` and starts a background task
    /// that parses `%output` messages and sends unescaped ANSI bytes on the
    /// returned channel.
    ///
    /// `capture_lines` is the bootstrap barrier (#1228): `Some(n)` takes the
    /// session's history **on the control channel** and returns it as the
    /// fourth tuple element, and the output receiver then yields only
    /// output the capture does not cover — see the module docs for why the
    /// wire's own order makes that exact. `None` skips the capture entirely.
    /// A capture that fails, times out, or comes back empty is also `None`
    /// on the way out — the attach proceeds without a bootstrap, which is
    /// the state every attach was in before #321.
    ///
    /// Returns `(session, output_receiver, resize_receiver, capture)`. The
    /// output receiver yields raw ANSI byte chunks ready to forward to
    /// xterm.js. The resize receiver yields `(cols, rows)` pairs each time
    /// the window's size changes — see the module docs for which notification
    /// that actually is — so the caller can propagate the
    /// new size to clients (e.g. as a `terminal.resize` message). When the
    /// tmux subprocess exits (or the reader task drops the senders), both
    /// receivers close.
    ///
    /// `tmux` is the caller's addressing — the same one the session was
    /// created on, and the one a test substitutes a fake binary into.
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
        // Resize tmux window to client's requested size BEFORE attaching.
        // This ensures tmux renders at the correct dimensions from the first
        // frame, avoiding a flash of wrong-sized content.
        //
        // Through the owner rather than a locally built argument vector: this
        // used to call `util::run_tmux_command(tmux, session, &[...])`, a
        // caller-supplies-the-argv runner whose one caller this was — exactly
        // the `run(args)` shape #991 rules out, since a caller holding the
        // vector can encode a wrong flag or drop the target with nothing to
        // catch it.
        tmux.ops()
            .resize_window(session_name, width, height)
            .await?;

        let mut child = tmux
            .cmd()
            .tokio()
            .args(["-C", "attach", "-t", session_name])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("failed to spawn tmux -C attach -t {session_name}"))?;

        let mut stdin = child.stdin.take().context("child stdin was not piped")?;
        let stdout = child.stdout.take().context("child stdout was not piped")?;

        let (output_tx, output_rx) = mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
        let (resize_tx, resize_rx) = mpsc::channel(RESIZE_CHANNEL_CAPACITY);
        let (decision_tx, decision_rx) = watch::channel(BarrierDecision::Pending);
        let (welcome_tx, welcome_rx) = oneshot::channel();
        let (capture_tx, capture_rx) = oneshot::channel();
        // Seeded with the size `resize_window` just set: that call returned
        // `Ok`, so the window is at it — and tmux does not re-report a size it
        // never saw change, so waiting for a `%layout-change` to confirm what
        // we just did would leave the first re-assertion of that size looking
        // like news.
        let observed: ObservedWindowSize = Arc::new(Mutex::new(Some((width, height))));
        tokio::spawn(read_output_loop(
            stdout,
            output_tx,
            resize_tx,
            Arc::clone(&observed),
            BarrierChannels {
                decision_rx,
                welcome_tx: Some(welcome_tx),
                capture_tx: Some(capture_tx),
            },
        ));

        let capture = match capture_lines {
            None => {
                let _ = decision_tx.send(BarrierDecision::Skipped);
                None
            }
            Some(lines) => {
                // The capture command goes out only after tmux's welcome
                // pair: the first response block a control client gets is
                // the empty one the server opens itself, and waiting for it
                // is what makes the *next* `%begin` unambiguously ours.
                match tokio::time::timeout(WELCOME_TIMEOUT, welcome_rx).await {
                    Ok(Ok(())) => {
                        let _ = decision_tx.send(BarrierDecision::Requested);
                        // The same capture `TmuxOps::capture_pane` runs as a
                        // separate process, spelled for the control channel —
                        // one line, no argv. The flags are `capture_pane_args`'s;
                        // keeping the two in step is a manual act.
                        let cmd =
                            format!("capture-pane -t {session_name} -p -S -{lines} -E - -e -J\n");
                        if let Err(e) = stdin.write_all(cmd.as_bytes()).await {
                            warn!(
                                "bootstrap: control-channel capture write failed for {session_name}: {e:#}"
                            );
                            let _ = decision_tx.send(BarrierDecision::Skipped);
                            None
                        } else {
                            match tokio::time::timeout(CAPTURE_TIMEOUT, capture_rx).await {
                                Ok(Ok(text)) => text.filter(|text| !text.is_empty()),
                                // The sender is gone: the subprocess died
                                // mid-capture. The reader's EOF already let
                                // the buffer go.
                                Ok(Err(_)) => None,
                                Err(_) => {
                                    warn!(
                                        "bootstrap: control-channel capture timed out for {session_name}"
                                    );
                                    let _ = decision_tx.send(BarrierDecision::Skipped);
                                    None
                                }
                            }
                        }
                    }
                    // No welcome: a child that exited instantly (the
                    // fake-binary test seam) arrives here on the dropped
                    // sender, a wedged server on the timeout. No capture;
                    // the decision tells the reader to let the buffer go.
                    _ => {
                        let _ = decision_tx.send(BarrierDecision::Skipped);
                        None
                    }
                }
            }
        };

        let session = Self {
            session_name: session_name.to_string(),
            child,
            stdin,
            viewport: (width, height),
            observed,
            tmux: tmux.clone(),
        };

        Ok((session, output_rx, resize_rx, capture))
    }

    /// Send raw input bytes to the tmux session using `send-keys -H` (hex).
    ///
    /// Using `-H` with hex-encoded bytes avoids shell escaping issues and lets us
    /// forward any byte value (control codes, high bytes, non-UTF-8) unchanged.
    /// `send-keys -l` (literal characters) was insufficient because it required
    /// single-quote escaping AND newlines in the input broke the outer tmux
    /// command framing.
    pub async fn write_input(&mut self, data: &[u8]) -> Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        // Format each byte as two lowercase hex digits, separated by spaces:
        // "hello" -> "68 65 6c 6c 6f"
        let mut hex = String::with_capacity(data.len() * 3);
        for (i, byte) in data.iter().enumerate() {
            if i > 0 {
                hex.push(' ');
            }
            hex.push_str(&format!("{byte:02x}"));
        }
        let cmd = format!("send-keys -t {} -H {}\n", self.session_name, hex);
        self.stdin.write_all(cmd.as_bytes()).await?;
        self.stdin.flush().await?;
        Ok(())
    }

    /// Resize the tmux **window** and trigger a full redraw.
    ///
    /// Sends two commands via control-mode stdin:
    /// 1. `resize-window` — changes the window size (**affects all clients**)
    /// 2. `refresh-client` — triggers a full pane redraw so the reflowed
    ///    content is sent as `%output` messages immediately
    ///
    /// This is not a per-client viewport: one window, one pane, shared by
    /// every client on the session, so this moves the pane for all of them and
    /// the most recent caller wins.  The module docs carry the decision and why
    /// `refresh-client -C` is deliberately not used.
    ///
    /// **Idempotent for the size the window is already at** (#1490). Unlike
    /// `attach`'s one-shot `resize-window` — argv, no client yet, no redraw —
    /// this path is a live control client's and it writes two commands:
    /// `resize-window` on an unchanged size still reflows the pane, and the
    /// `refresh-client` after it repaints **every client of the session**. So a
    /// request that moves nothing still costs a full redraw of a window several
    /// clients may be looking at, and a re-attach asks for the size the pane is
    /// already at — once per reload.
    ///
    /// The comparison is against the size tmux reported, not the one this
    /// backend last asked for — see [`ObservedWindowSize`].
    pub async fn resize(&mut self, width: u16, height: u16) -> Result<()> {
        if self.window_is_at(width, height) {
            // The viewport is still this client's stated size: nothing was
            // written, and a later real resize compares against tmux's report
            // again rather than against this.
            self.viewport = (width, height);
            return Ok(());
        }
        self.viewport = (width, height);
        let cmd = format!(
            "resize-window -t {} -x {} -y {}\nrefresh-client\n",
            self.session_name, width, height
        );
        self.stdin.write_all(cmd.as_bytes()).await?;
        self.stdin.flush().await?;
        // tmux confirms it with a `%layout-change` carrying this same size; in
        // the window before that arrives, a repeat of this request is a repeat
        // of something already done. A write that failed returned above, so
        // this is only ever set for a command tmux received.
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

    /// Close the tmux subprocess gracefully. Idempotent.
    ///
    /// Sends `detach-client` to the control-mode stdin so tmux cleanly
    /// disconnects the client.  SIGKILL is NEVER used because it can crash
    /// the tmux server on macOS (observed with Homebrew tmux 3.6b).
    ///
    /// **Cleanup**, and the three steps are the teardown of a client that is
    /// already on its way out: what ends it is this client's stdin closing
    /// (control mode exits on EOF), which is why the failures below are
    /// dropped rather than propagated, and why `Ok` here is not a claim that
    /// tmux confirmed anything. The one thing the class forbids — masking a
    /// primary error — cannot happen: nothing else in this function can fail.
    pub async fn close(&mut self) -> Result<()> {
        // Send graceful detach — the tmux subprocess will exit cleanly.
        //
        // Not a tmux *spawn*: this is a line written to a control-mode client's
        // stdin, so there is no exit status and no stderr to classify — tmux's
        // answer to a bad line arrives asynchronously on the same pipe the
        // output comes back on, and a failure here means the pipe is already
        // gone (EPIPE), i.e. the client has already detached. `ops.rs`'s module
        // docs carry the same point for why `send-keys -H` over this transport
        // is not `TmuxOps::send_keys`.
        let _ = self.stdin.write_all(b"detach-client\n").await;
        let _ = self.stdin.flush().await;
        // Wait briefly for the subprocess to process the detach and exit.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        // Reap the control-mode child. Not a tmux call — it is the process this
        // backend spawned, so no tmux operation class applies.
        // Use wait() instead of start_kill() to avoid SIGKILL.
        let _ = self.child.wait().await;
        Ok(())
    }
}

impl Drop for ControlModeSession {
    fn drop(&mut self) {
        // **Cleanup** (#991): teardown, so the failure is allowed and the shape
        // is `let _ =` rather than `?` — a `Drop` cannot report anything, and
        // must not panic.
        //
        // It also does not have to succeed: what ends this client is its stdin
        // closing below (control mode exits on EOF), and the SIGKILL route this
        // deliberately avoids is the one with a documented hazard — SIGKILL on
        // a control-mode client crashes the tmux server on macOS (Homebrew tmux
        // 3.6b: "server exited unexpectedly"), so an unclean detach is the
        // lesser risk here but still not a state a caller has to hear about.
        //
        // The target is the client **this backend spawned**, resolved from the
        // child's pid (#1011). It used to name the session, which
        // `detach-client -t` does not accept: measured on tmux 3.6b that
        // answers `can't find client: <session>` (exit 1) and detaches nothing,
        // so the detach was a no-op from the day it was written. `-s <session>`
        // is not the repair — it detaches *every* client of the session,
        // including one a user attached by hand.
        //
        // [`close`](ControlModeSession::close) reaches the same end through the
        // control-mode stdin instead, which is the transport this backend
        // already owns; this path keeps a subprocess because `Drop` cannot
        // await. The class and the silence are unchanged.
        if let Some(pid) = self.child.id() {
            let _ = self.tmux.ops().detach_client_by_pid_blocking(pid);
        }
        // Let the child process exit on its own — drop order will close
        // stdin (EOF → child exits), then child (reaped by tokio/lanchd).
    }
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

/// The attach flow's instruction to the reader loop's bootstrap barrier
/// (#1228), delivered over a `watch` because the reader must react to a
/// change even when the wire is quiet — a skipped capture flushes the
/// buffer immediately rather than at the next `%output`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BarrierDecision {
    /// `attach` has not said yet; `%output` buffers.
    Pending,
    /// A capture command was written; its `%begin` is the barrier.
    Requested,
    /// No capture is coming; flush the buffer and go live.
    Skipped,
}

/// One thing the reader loop must do after the router consumed a line, in
/// wire order.
#[derive(Debug, PartialEq)]
enum Effect {
    /// Bytes for the live output stream.
    Live(Vec<u8>),
    /// The window's size changed — from either notification, see the module
    /// docs.
    Resize(u16, u16),
    /// tmux's welcome pair completed; the capture command may be written.
    WelcomeDone,
    /// The capture resolved: `Some` is the snapshot text (empty when the
    /// pane has no history), `None` is a failed or abandoned capture — the
    /// attach proceeds without a bootstrap.
    CaptureResolved(Option<Vec<u8>>),
    /// The tmux server is gone (`%exit`).
    Exit,
    /// Non-fatal and worth a log line.
    Note(&'static str),
}

/// Where the reader is relative to the capture's `%begin`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BarrierPhase {
    /// The capture's `%begin` has not arrived; `%output` buffers.
    Buffering,
    /// Inside the capture's response block; interleaved `%output` is
    /// post-barrier and therefore live.
    InCapture,
    /// Past the barrier; `%output` forwards.
    Live,
}

/// The line-by-line state machine behind the bootstrap barrier, split from
/// the I/O so the barrier semantics are unit-testable without a tmux.
///
/// The rules, each with its reason:
///
/// * `%output` before the capture's `%begin` is *inside* the capture —
///   tmux executes the command synchronously between queueing `%begin` and
///   the response text, so anything the client was told about earlier is
///   output the pane read includes. Buffered, then dropped when the capture
///   lands, flushed as live if the capture fails or is skipped.
/// * `%output` interleaved *inside* the response block is **post**-barrier:
///   the pane read already happened. Forwarded live.
/// * Response data is raw — tmux does not escape it (measured: a pane line
///   `%begin-fake` arrives verbatim inside a block) — so a block closes only
///   on an `%end`/`%error` whose (timestamp, id, flags) triple matches its
///   `%begin` exactly, and a line inside a block that parses as some other
///   response marker is treated as data. The residue: a pane line spelling
///   `%output ...` inside the capture block is misrouted as a notification,
///   and one spelling the matching triple closes the block early. Both need
///   the line to appear during one command's response; accepted and
///   documented, unfixable at this layer.
struct ControlRouter {
    /// The (timestamp, id, flags) of the response block currently open.
    open_block: Option<(u64, u64, u64)>,
    /// The first block a control client gets is tmux's own empty welcome
    /// pair; only after it can `attach` know the next `%begin` answers its
    /// own command.
    welcomed: bool,
    /// `%output` held back before the barrier, in arrival order.
    pre_barrier: VecDeque<Vec<u8>>,
    /// Data lines of the capture's response block.
    capture_lines: Vec<String>,
    phase: BarrierPhase,
    /// The capture was skipped or its buffer overflowed: the eventual
    /// response block (if one still arrives) is generic.
    capture_abandoned: bool,
    /// The last size this router reported, so the next report of the same size
    /// is not a report (#1349). `None` until one has been seen, which every
    /// first size is news against.
    reported_size: Option<(u16, u16)>,
}

impl ControlRouter {
    fn new() -> Self {
        Self {
            open_block: None,
            welcomed: false,
            pre_barrier: VecDeque::new(),
            capture_lines: Vec::new(),
            phase: BarrierPhase::Buffering,
            capture_abandoned: false,
            reported_size: None,
        }
    }

    /// Note a window size, answering whether it is news.
    ///
    /// A layout change is not always a *size* change — splitting a pane emits
    /// one too — and tmux 3.6b emits **two** `%layout-change` lines for a single
    /// `resize-window` (measured). Neither is a second resize, and what a
    /// consumer of [`Effect::Resize`] needs is how big the window is, so saying
    /// it twice says nothing more. The size is the whole of the dedupe; there is
    /// no per-session state to keep downstream because there is none to keep
    /// here.
    fn note_size(&mut self, cols: u16, rows: u16) -> bool {
        if self.reported_size == Some((cols, rows)) {
            return false;
        }
        self.reported_size = Some((cols, rows));
        true
    }

    /// Consume one line as it arrived on the control channel.
    /// `capture_requested` is the attach flow's current decision.
    fn route(&mut self, line: &str, capture_requested: bool) -> Vec<Effect> {
        let line = strip_eol(line);
        let msg = parse_control_line(line);
        let mut effects = Vec::new();
        if let Some(open) = self.open_block {
            self.route_in_block(open, line, msg, &mut effects);
            return effects;
        }
        match msg {
            Some(ControlMessage::Begin {
                timestamp,
                id,
                flags,
            }) => {
                self.open_block = Some((timestamp, id, flags));
                if capture_requested
                    && self.welcomed
                    && self.phase == BarrierPhase::Buffering
                    && !self.capture_abandoned
                {
                    self.phase = BarrierPhase::InCapture;
                }
            }
            Some(ControlMessage::Output { data, .. }) => {
                self.route_output(unescape_tmux_data(&data), &mut effects);
            }
            Some(ControlMessage::WindowResize { cols, rows, .. }) => {
                if self.note_size(cols, rows) {
                    effects.push(Effect::Resize(cols, rows));
                }
            }
            // **The signal tmux actually sends.** `%window-resize` is not
            // emitted by 3.6b at all — the arm above is kept for a tmux that
            // does, but on the pinned runtime every window size change arrives
            // here instead, and the layout string carries the size (measured:
            // `resize-window` to 100x30 produced `%layout-change @0
            // a87d,100x30,0,0,0`, and no `%window-resize`). Ignoring this is why
            // a peer reflowing the shared window reached no other client
            // (#1349).
            //
            // `note_size` is the dedupe — see its doc: a layout change is not
            // always a size change, and 3.6b sends two lines for one resize.
            Some(ControlMessage::LayoutChange { layout, .. }) => {
                if let Some((cols, rows)) = crate::tmux::parser::layout_size(&layout) {
                    if self.note_size(cols, rows) {
                        effects.push(Effect::Resize(cols, rows));
                    }
                }
            }
            Some(ControlMessage::Exit) => effects.push(Effect::Exit),
            // Stray %end/%error with no open block, session notifications,
            // unknown lines — all ignored, as before #1228.
            _ => {}
        }
        effects
    }

    /// One line inside an open response block. `open` is the block's
    /// (timestamp, id, flags) triple.
    fn route_in_block(
        &mut self,
        open: (u64, u64, u64),
        line: &str,
        msg: Option<ControlMessage>,
        effects: &mut Vec<Effect>,
    ) {
        match msg {
            Some(ControlMessage::End {
                timestamp,
                id,
                flags,
            })
            | Some(ControlMessage::Error {
                timestamp,
                id,
                flags,
            }) if (timestamp, id, flags) == open => {
                self.open_block = None;
                let is_error = matches!(msg, Some(ControlMessage::Error { .. }));
                self.close_block(is_error, effects);
            }
            Some(ControlMessage::Output { data, .. }) => {
                self.route_output(unescape_tmux_data(&data), effects);
            }
            Some(ControlMessage::WindowResize { cols, rows, .. }) => {
                if self.note_size(cols, rows) {
                    effects.push(Effect::Resize(cols, rows));
                }
            }
            Some(ControlMessage::Exit) => effects.push(Effect::Exit),
            // Session/layout notifications keep their pre-#1228 treatment
            // (ignored), interleaved or not.
            Some(ControlMessage::SessionChanged { .. })
            | Some(ControlMessage::LayoutChange { .. }) => {}
            // A %begin, a non-matching %end/%error, or anything unparsed:
            // not a real response marker (tmux never nests blocks), so it is
            // data — collected for the capture, ignored in a generic block.
            _ => {
                if self.phase == BarrierPhase::InCapture && !self.capture_abandoned {
                    self.capture_lines.push(line.to_string());
                }
            }
        }
    }

    /// One `%output`'s bytes, from any block state.
    fn route_output(&mut self, bytes: Vec<u8>, effects: &mut Vec<Effect>) {
        match self.phase {
            BarrierPhase::Live | BarrierPhase::InCapture => effects.push(Effect::Live(bytes)),
            BarrierPhase::Buffering => {
                self.pre_barrier.push_back(bytes);
                if self.pre_barrier.len() > PRE_BARRIER_BUFFER_CHUNKS {
                    // Overflow: degrade to the pre-#1228 behaviour — flush
                    // everything as live and abandon the capture. The window
                    // is milliseconds, so reaching this means the capture is
                    // not coming in any useful sense.
                    effects.extend(self.pre_barrier.drain(..).map(Effect::Live));
                    self.capture_abandoned = true;
                    self.phase = BarrierPhase::Live;
                    effects.push(Effect::CaptureResolved(None));
                    effects.push(Effect::Note(
                        "bootstrap barrier buffer overflowed; capture abandoned",
                    ));
                }
            }
        }
    }

    /// A response block closed. `is_error` distinguishes `%error` from `%end`.
    fn close_block(&mut self, is_error: bool, effects: &mut Vec<Effect>) {
        if !self.welcomed {
            self.welcomed = true;
            effects.push(Effect::WelcomeDone);
        }
        if self.phase != BarrierPhase::InCapture {
            return;
        }
        self.phase = BarrierPhase::Live;
        if self.capture_abandoned {
            return;
        }
        if is_error {
            // No capture: the buffered output is the only copy — flush it.
            effects.extend(self.pre_barrier.drain(..).map(Effect::Live));
            effects.push(Effect::CaptureResolved(None));
        } else {
            // The capture carries everything the buffer holds: drop it.
            self.pre_barrier.clear();
            let mut text = self.capture_lines.join("\n");
            if !text.is_empty() {
                text.push('\n');
            }
            effects.push(Effect::CaptureResolved(Some(text.into_bytes())));
        }
    }

    /// The decision went to `Skipped` — no capture is coming, or the attach
    /// stopped waiting for one. The buffer's contents are live now.
    fn on_skipped(&mut self) -> Vec<Effect> {
        self.capture_abandoned = true;
        if self.phase != BarrierPhase::Live {
            self.phase = BarrierPhase::Live;
        }
        self.pre_barrier.drain(..).map(Effect::Live).collect()
    }
}

/// The parser strips the terminator itself; data lines need the same
/// treatment, and the two must agree on what one is.
fn strip_eol(line: &str) -> &str {
    if let Some(stripped) = line.strip_suffix("\r\n") {
        stripped
    } else if let Some(stripped) = line.strip_suffix('\n') {
        stripped
    } else {
        line
    }
}

/// The oneshots the barrier resolves on, bundled because the reader loop's
/// parameter list is already at the edge of readable.
struct BarrierChannels {
    decision_rx: watch::Receiver<BarrierDecision>,
    welcome_tx: Option<oneshot::Sender<()>>,
    capture_tx: Option<oneshot::Sender<Option<Vec<u8>>>>,
}

/// Background reader: parse control mode lines, forward ANSI bytes and
/// window-resize events, and run the bootstrap barrier (#1228) — see
/// [`ControlRouter`] for the rules.
async fn read_output_loop(
    stdout: ChildStdout,
    output_tx: mpsc::Sender<Vec<u8>>,
    resize_tx: mpsc::Sender<(u16, u16)>,
    observed: ObservedWindowSize,
    mut barrier: BarrierChannels,
) {
    let mut router = ControlRouter::new();
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    'reader: loop {
        line.clear();
        let effects = tokio::select! {
            read = reader.read_line(&mut line) => {
                match read {
                    Ok(0) => break, // EOF - tmux subprocess exited
                    Ok(_) => {
                        let requested =
                            matches!(*barrier.decision_rx.borrow(), BarrierDecision::Requested);
                        router.route(&line, requested)
                    }
                    Err(_) => break,
                }
            }
            changed = barrier.decision_rx.changed() => {
                // The sender is gone (the attach flow died) or the capture
                // was skipped: either way the buffer's contents are live
                // now. `Requested` needs no reaction — the router reads it
                // per line.
                if changed.is_err()
                    || matches!(*barrier.decision_rx.borrow(), BarrierDecision::Skipped)
                {
                    router.on_skipped()
                } else {
                    continue;
                }
            }
        };
        for effect in effects {
            match effect {
                Effect::Live(bytes) => {
                    if output_tx.send(bytes).await.is_err() {
                        // Receiver dropped - session is being torn down.
                        break 'reader;
                    }
                }
                Effect::Resize(cols, rows) => {
                    // tmux is the authority on this window's size, and this is
                    // where it speaks: the backend's resize guard decides from
                    // this value whether a request would move anything
                    // (`ControlModeSession::resize`).
                    //
                    // Scoped so the guard is not held across the send below —
                    // a lock across an await in this loop would stall every
                    // reader behind whoever is asking about the size.
                    if let Ok(mut size) = observed.lock() {
                        *size = Some((cols, rows));
                    }
                    // Best-effort, and **not a tmux result at all**: this is
                    // an internal `mpsc` send to the caller's resize
                    // receiver, whose only failure is "the receiver is
                    // gone". No tmux operation class applies — the tmux
                    // call that produced this event already returned, and
                    // its result was the line above. Keeping the reader
                    // alive after a dropped receiver is the decision: output
                    // continues until the output channel closes too.
                    let _ = resize_tx.send((cols, rows)).await;
                }
                Effect::WelcomeDone => {
                    if let Some(tx) = barrier.welcome_tx.take() {
                        let _ = tx.send(());
                    }
                }
                Effect::CaptureResolved(capture) => {
                    if let Some(tx) = barrier.capture_tx.take() {
                        let _ = tx.send(capture);
                    }
                }
                Effect::Exit => break 'reader,
                Effect::Note(note) => warn!("control-mode reader: {note}"),
            }
        }
    }
    // Nothing is updating this any more, so it stops being a fact a resize can
    // be suppressed with: from here a requested size is issued, not compared.
    if let Ok(mut size) = observed.lock() {
        *size = None;
    }
}

// `attach` spawns a separate `tmux resize-window` process — it runs *before*
// the control-mode client exists, so there is no stdin to write to yet.
// `resize` writes `resize-window` to the control-mode stdin instead. Two
// routes, one shared window. Covered by tests/integration/control_mode.rs.

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn the_injected_tmux_receives_the_control_mode_attach_and_the_detach() {
        // The control-mode backend reaches tmux three ways — `resize-window`
        // through `TmuxOps` before it attaches, `-C attach` as its own child,
        // and `detach-client` on the way out — and all three ran on the
        // process-wide tmux before #991 step 6.
        //
        // **This one runs on macOS too**, which the control-mode integration
        // tests (skipped by `cfg!(target_os = "macos")` because a real tmux
        // server can be crashed by parallel control-mode clients) cannot. There
        // is no server here: every tmux invocation is the fake, which records
        // its argv and exits. So the shape that has no local coverage on this
        // machine — the backend's own wiring — has a test that does, and the
        // macOS skip keeps applying exactly where it was needed: to real tmux.
        let dir = tempfile::tempdir().expect("tempdir");
        let child_pid = dir.path().join("child.pid");
        // `-C attach` records its own pid — the process this backend spawned,
        // which is what it later resolves its client by — and `list-clients`
        // hands it back the way tmux does (measured: `#{client_pid}` is the
        // attaching process, so the client we own is the one carrying it).
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

        // `resize-window` is awaited, `-C attach` is a spawned child that the
        // reader loop may not have seen finish yet.
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

        // `-s <session>` would detach *every* client of the session, including
        // one a user attached by hand, and `-t <session>` detaches nothing at
        // all (#1011). The only correct target is the client this backend owns,
        // named from the pid it spawned.
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
        assert!(
            !calls.iter().any(|args| args
                == &vec![
                    "detach-client".to_string(),
                    "-t".to_string(),
                    "nession-fake-sess".to_string(),
                ]),
            "and never the session, which is the #1011 no-op: {calls:?}"
        );
    }

    /// A requested capture that never gets its welcome — the fake exits
    /// before writing one — resolves to no capture **immediately**, not
    /// after `WELCOME_TIMEOUT`.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_child_that_dies_before_the_welcome_skips_the_capture_at_once() {
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = crate::test_support::FakeTmux::new(dir.path(), "exit 0");
        let started = std::time::Instant::now();
        let (_session, _rx, _resize_rx, capture) =
            ControlModeSession::attach(&fake.dep(), "nession-fake-sess", 80, 24, Some(5000))
                .await
                .expect("the injected binary accepts the resize and the attach");
        assert!(capture.is_none(), "the child died before the welcome");
        assert!(
            started.elapsed() < WELCOME_TIMEOUT,
            "a dead child must not wait out the welcome timeout: {:?}",
            started.elapsed()
        );
    }

    /// A fake whose control client appends everything written to its control
    /// channel — the only place `resize` and the capture reach tmux — so a
    /// test can assert on the commands rather than on the argv of a spawn.
    #[cfg(unix)]
    fn recording_fake(
        dir: &std::path::Path,
        log: &std::path::Path,
        preamble: &str,
    ) -> crate::test_support::FakeTmux {
        crate::test_support::FakeTmux::new(
            dir,
            &format!(
                "case \"$1\" in \
                 attach|-C) {preamble}while IFS= read -r line; do printf '%s\\n' \"$line\" >> \"{log}\"; done; exit 0;; \
                 *) exit 0;; esac",
                log = log.display(),
            ),
        )
    }

    /// Wait for the fake's control-channel log, which the child writes as it
    /// reads: EOF (the session's stdin closing) is what ends it.
    #[cfg(unix)]
    async fn control_channel_log(path: &std::path::Path) -> String {
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(path) {
                if !text.is_empty() {
                    return text;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        std::fs::read_to_string(path).unwrap_or_default()
    }

    /// A resize to the size the window already has writes nothing: the two
    /// commands it would otherwise send reflow the pane and repaint **every**
    /// client of the session, for a size that is already on screen (#1490).
    #[cfg(unix)]
    #[tokio::test]
    async fn a_resize_to_the_size_the_window_already_has_writes_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let log = dir.path().join("control-stdin.log");
        let fake = recording_fake(dir.path(), &log, "");

        let (mut session, _rx, _resize_rx, _capture) =
            ControlModeSession::attach(&fake.dep(), "nession-fake-sess", 80, 24, None)
                .await
                .expect("the injected binary accepts the attach");

        // What a re-attach asks for: the size the window is already at, set by
        // the attach's own `resize-window`.
        session
            .resize(80, 24)
            .await
            .expect("an idempotent resize succeeds");
        // A different size still moves it.
        session
            .resize(100, 30)
            .await
            .expect("a real resize is written");
        // ...and having just been asked for, that is where the window is now.
        session
            .resize(100, 30)
            .await
            .expect("a repeat writes nothing");
        assert_eq!(session.viewport(), (100, 30));
        drop(session);

        let written = control_channel_log(&log).await;
        assert_eq!(
            written.matches("resize-window").count(),
            1,
            "one size change, one resize-window: {written:?}"
        );
        assert!(
            written.contains("resize-window -t nession-fake-sess -x 100 -y 30\n"),
            "the size that did change is the one written: {written:?}"
        );
        assert_eq!(
            written.matches("refresh-client").count(),
            1,
            "and exactly one repaint, for that one change: {written:?}"
        );
    }

    /// The guard reads what tmux reported, not what this backend last asked
    /// for. A peer reflowing the shared window makes the last request stale,
    /// and a client asking for that size must get it back rather than be told
    /// the window is already there.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_peer_moving_the_window_makes_the_next_request_a_real_resize() {
        let dir = tempfile::tempdir().expect("tempdir");
        let log = dir.path().join("control-stdin.log");
        let fake = recording_fake(
            dir.path(),
            &log,
            "printf '%s\\n' '%layout-change @0 a87d,100x30,0,0,0'; ",
        );

        let (mut session, _rx, _resize_rx, _capture) =
            ControlModeSession::attach(&fake.dep(), "nession-fake-sess", 80, 24, None)
                .await
                .expect("the injected binary accepts the attach");

        let mut took_the_report = false;
        for _ in 0..100 {
            if session.window_is_at(100, 30) {
                took_the_report = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(took_the_report, "the reader records the size tmux reports");

        // 80x24 is what this client last asked for — and the window is at the
        // peer's size, so the request is a real resize and must be written.
        session.resize(80, 24).await.expect("the resize is written");
        drop(session);

        let written = control_channel_log(&log).await;
        assert!(
            written.contains("resize-window -t nession-fake-sess -x 80 -y 24\n"),
            "a stale last request must not suppress the resize: {written:?}"
        );
    }

    mod barrier {
        use super::*;

        /// The live bytes a route produced, in order.
        fn live(effects: &[Effect]) -> Vec<Vec<u8>> {
            effects
                .iter()
                .filter_map(|e| match e {
                    Effect::Live(bytes) => Some(bytes.clone()),
                    _ => None,
                })
                .collect()
        }

        fn resolved(effects: &[Effect]) -> Option<&Option<Vec<u8>>> {
            effects.iter().find_map(|e| match e {
                Effect::CaptureResolved(capture) => Some(capture),
                _ => None,
            })
        }

        fn welcome(router: &mut ControlRouter) {
            let effects = router.route("%begin 100 1 0\n", false);
            assert_eq!(effects, vec![], "the welcome block opens quietly");
            let effects = router.route("%end 100 1 0\n", false);
            assert!(
                effects.contains(&Effect::WelcomeDone),
                "the first block's end is the welcome: {effects:?}"
            );
        }

        #[test]
        fn output_before_anything_buffers() {
            let mut router = ControlRouter::new();
            let effects = router.route("%output %0 GAP-001\\012", false);
            assert_eq!(live(&effects), Vec::<Vec<u8>>::new());
            assert_eq!(router.pre_barrier.len(), 1);
        }

        #[test]
        fn the_capture_boundary_drops_what_the_capture_carries() {
            let mut router = ControlRouter::new();
            welcome(&mut router);

            // Two chunks arrive before the capture's %begin: they are inside
            // the capture, so they must never go live.
            router.route("%output %0 GAP-001\\012", true);
            router.route("%output %0 GAP-002\\012", true);

            assert_eq!(router.route("%begin 200 9 1\n", true), vec![]);
            assert_eq!(router.route("GAP-001\n", true), vec![]);
            assert_eq!(router.route("GAP-002\n", true), vec![]);
            let effects = router.route("%end 200 9 1\n", true);

            assert_eq!(
                resolved(&effects),
                Some(&Some(b"GAP-001\nGAP-002\n".to_vec())),
                "the snapshot is the response's data lines: {effects:?}"
            );
            assert_eq!(
                live(&effects),
                Vec::<Vec<u8>>::new(),
                "the pre-barrier buffer is dropped, not replayed"
            );
            assert!(router.pre_barrier.is_empty());
        }

        #[test]
        fn output_interleaved_in_the_capture_block_is_post_barrier() {
            let mut router = ControlRouter::new();
            welcome(&mut router);
            router.route("%begin 200 9 1\n", true);

            let effects = router.route("%output %0 GAP-042\\012", true);
            assert_eq!(
                live(&effects),
                vec![b"GAP-042\n".to_vec()],
                "the pane read happened at %begin, so interleaved output is new"
            );
        }

        #[test]
        fn output_after_the_capture_is_live() {
            let mut router = ControlRouter::new();
            welcome(&mut router);
            router.route("%begin 200 9 1\n", true);
            router.route("GAP-001\n", true);
            router.route("%end 200 9 1\n", true);

            let effects = router.route("%output %0 GAP-002\\012", true);
            assert_eq!(live(&effects), vec![b"GAP-002\n".to_vec()]);
        }

        #[test]
        fn an_errored_capture_flushes_the_buffer_instead_of_dropping_it() {
            let mut router = ControlRouter::new();
            welcome(&mut router);
            router.route("%output %0 GAP-001\\012", true);
            router.route("%output %0 GAP-002\\012", true);
            router.route("%begin 200 9 1\n", true);

            let effects = router.route("%error 200 9 1\n", true);
            assert_eq!(
                live(&effects),
                vec![b"GAP-001\n".to_vec(), b"GAP-002\n".to_vec()],
                "no capture means the buffer is the only copy — in order"
            );
            assert_eq!(resolved(&effects), Some(&None));
        }

        #[test]
        fn a_skipped_capture_flushes_the_buffer() {
            let mut router = ControlRouter::new();
            welcome(&mut router);
            router.route("%output %0 GAP-001\\012", false);

            let effects = router.on_skipped();
            assert_eq!(live(&effects), vec![b"GAP-001\n".to_vec()]);

            let effects = router.route("%output %0 GAP-002\\012", false);
            assert_eq!(live(&effects), vec![b"GAP-002\n".to_vec()]);
        }

        #[test]
        fn a_capture_skipped_mid_block_abandons_it() {
            let mut router = ControlRouter::new();
            welcome(&mut router);
            router.route("%output %0 GAP-001\\012", true);
            router.route("%begin 200 9 1\n", true);
            router.route("GAP-001\n", true);

            // The attach gave up waiting (its timeout) — the buffer is live,
            // and the block's remaining data is ignored.
            let effects = router.on_skipped();
            assert_eq!(live(&effects), vec![b"GAP-001\n".to_vec()]);
            let effects = router.route("GAP-002\n", true);
            assert_eq!(effects, vec![]);
            let effects = router.route("%end 200 9 1\n", true);
            assert_eq!(resolved(&effects), None, "abandoned: nothing resolves");
        }

        #[test]
        fn the_block_closes_only_on_the_exact_triple() {
            let mut router = ControlRouter::new();
            welcome(&mut router);
            router.route("%begin 200 9 1\n", true);
            router.route("GAP-001\n", true);

            // A data line spelling %end with a *different* triple is data —
            // response data is raw, and tmux never nests blocks.
            let effects = router.route("%end 200 9 4\n", true);
            assert_eq!(effects, vec![]);
            let effects = router.route("%end 200 9 1\n", true);
            assert_eq!(
                resolved(&effects),
                Some(&Some(b"GAP-001\n%end 200 9 4\n".to_vec())),
                "the look-alike line is in the capture: {effects:?}"
            );
        }

        #[test]
        fn pane_data_spelling_output_inside_the_block_is_misrouted() {
            // The documented residue: response data is raw, so a pane line
            // spelling `%output ...` during the capture block is forwarded as
            // if tmux had sent it. Pinned so a future protocol fix knows what
            // it is changing.
            let mut router = ControlRouter::new();
            welcome(&mut router);
            router.route("%begin 200 9 1\n", true);
            let effects = router.route("%output %0 not-a-notification", true);
            assert_eq!(live(&effects), vec![b"not-a-notification".to_vec()]);
        }

        #[test]
        fn buffer_overflow_degrades_to_flushing_everything_live() {
            let mut router = ControlRouter::new();
            for _ in 0..PRE_BARRIER_BUFFER_CHUNKS {
                router.route("%output %0 x", false);
            }
            let effects = router.route("%output %0 x", false);
            assert_eq!(
                live(&effects).len(),
                PRE_BARRIER_BUFFER_CHUNKS + 1,
                "the whole buffer flushes on overflow"
            );
            assert_eq!(resolved(&effects), Some(&None));
            assert!(effects.iter().any(|e| matches!(e, Effect::Note(_))));

            let effects = router.route("%output %0 after", false);
            assert_eq!(live(&effects), vec![b"after".to_vec()]);
        }

        #[test]
        fn the_welcome_blocks_data_is_ignored() {
            let mut router = ControlRouter::new();
            router.route("%begin 100 1 0\n", false);
            assert_eq!(router.route("stray\n", false), vec![]);
            let effects = router.route("%end 100 1 0\n", false);
            assert_eq!(effects, vec![Effect::WelcomeDone]);
        }

        #[test]
        fn an_empty_capture_resolves_to_empty_text() {
            let mut router = ControlRouter::new();
            welcome(&mut router);
            router.route("%begin 200 9 1\n", true);
            let effects = router.route("%end 200 9 1\n", true);
            assert_eq!(resolved(&effects), Some(&Some(Vec::new())));
        }

        /// **The path that actually fires on the pinned tmux** (#1349).
        /// `%window-resize` is not emitted by 3.6b at all, so a peer reflowing
        /// the shared window reached no other client until this arm stopped
        /// ignoring `%layout-change`.
        #[test]
        fn a_layout_change_reports_the_window_size() {
            let mut router = ControlRouter::new();
            welcome(&mut router);
            let effects = router.route(
                "%layout-change @0 a87d,100x30,0,0,0 a87d,100x30,0,0,0 *\n",
                true,
            );
            assert_eq!(effects, vec![Effect::Resize(100, 30)]);
        }

        /// A layout change is not always a *size* change, and 3.6b sends **two**
        /// lines for one `resize-window` (measured). Reporting the second would
        /// be telling every client to resize to the size it already has.
        #[test]
        fn the_same_size_twice_is_reported_once() {
            let mut router = ControlRouter::new();
            welcome(&mut router);
            assert_eq!(
                router.route(
                    "%layout-change @0 a87d,100x30,0,0,0 a87d,100x30,0,0,0 *\n",
                    true
                ),
                vec![Effect::Resize(100, 30)]
            );
            assert_eq!(
                router.route(
                    "%layout-change @0 a87d,100x30,0,0,0 a87d,100x30,0,0,0 *\n",
                    true
                ),
                Vec::new()
            );
            // A different size is news again — the dedupe is about repetition,
            // not about reporting once per session.
            assert_eq!(
                router.route(
                    "%layout-change @0 b25d,80x24,0,0,0 b25d,80x24,0,0,0 *\n",
                    true
                ),
                vec![Effect::Resize(80, 24)]
            );
        }

        /// A pane split moves no client, so a layout change with no readable
        /// size must produce nothing rather than a guess.
        #[test]
        fn a_layout_change_with_no_size_reports_nothing() {
            let mut router = ControlRouter::new();
            welcome(&mut router);
            assert_eq!(
                router.route("%layout-change @0 nonsense nonsense *\n", true),
                Vec::new()
            );
        }

        #[test]
        fn resize_events_pass_through_mid_block() {
            let mut router = ControlRouter::new();
            welcome(&mut router);
            router.route("%begin 200 9 1\n", true);
            let effects = router.route("%window-resize @1 120 40\n", true);
            assert_eq!(effects, vec![Effect::Resize(120, 40)]);
        }

        #[test]
        fn the_decision_arriving_after_output_still_flushes_in_order() {
            // Output buffered while Pending, then Skipped: order is arrival
            // order, or the client's screen replays scrambled.
            let mut router = ControlRouter::new();
            router.route("%output %0 one", false);
            router.route("%output %0 two", false);
            let effects = router.on_skipped();
            assert_eq!(live(&effects), vec![b"one".to_vec(), b"two".to_vec()]);
        }
    }
}
