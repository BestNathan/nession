//! tmux control mode session 管理
//!
//! Uses `tmux -C attach` to control a tmux session, parsing structured
//! messages instead of raw PTY output.
//!
//! Terminal size (cols/rows) is bidirectional: the client tells tmux its
//! desired size on attach and when the browser window resizes; tmux confirms
//! the new size via `%window-resize` events, which the agent broadcasts to
//! all attached clients. Last writer wins — the most recent resize sets
//! the size for everyone.
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

use anyhow::{Context, Result};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::mpsc;

use super::ops::TmuxDep;
use super::parser::{parse_control_line, unescape_tmux_data, ControlMessage};

/// Buffer capacity for the output channel — bytes-per-batch parsed from tmux.
const OUTPUT_CHANNEL_CAPACITY: usize = 256;

/// Buffer capacity for the resize channel — one (cols, rows) tuple per event.
const RESIZE_CHANNEL_CAPACITY: usize = 16;

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
    /// Returns `(session, output_receiver, resize_receiver)`. The output
    /// receiver yields raw ANSI byte chunks ready to forward to xterm.js.
    /// The resize receiver yields `(cols, rows)` pairs each time tmux emits
    /// a `%window-resize` event so the caller can propagate the new size to
    /// clients (e.g. as a `terminal.resize` message). When the tmux
    /// subprocess exits (or the reader task drops the senders), both
    /// receivers close.
    ///
    /// `tmux` is the caller's addressing — the same one the session was
    /// created on, and the one a test substitutes a fake binary into.
    pub async fn attach(
        tmux: &TmuxDep,
        session_name: &str,
        width: u16,
        height: u16,
    ) -> Result<(Self, mpsc::Receiver<Vec<u8>>, mpsc::Receiver<(u16, u16)>)> {
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

        let stdin = child.stdin.take().context("child stdin was not piped")?;
        let stdout = child.stdout.take().context("child stdout was not piped")?;

        let (output_tx, output_rx) = mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
        let (resize_tx, resize_rx) = mpsc::channel(RESIZE_CHANNEL_CAPACITY);
        tokio::spawn(read_output_loop(stdout, output_tx, resize_tx));

        let session = Self {
            session_name: session_name.to_string(),
            child,
            stdin,
            viewport: (width, height),
            tmux: tmux.clone(),
        };

        Ok((session, output_rx, resize_rx))
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
    /// the most recent caller wins. The module docs carry the decision and why
    /// `refresh-client -C` is deliberately not used.
    pub async fn resize(&mut self, width: u16, height: u16) -> Result<()> {
        self.viewport = (width, height);
        let cmd = format!(
            "resize-window -t {} -x {} -y {}\nrefresh-client\n",
            self.session_name, width, height
        );
        self.stdin.write_all(cmd.as_bytes()).await?;
        self.stdin.flush().await?;
        Ok(())
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

/// Background reader: parse control mode lines, forward ANSI bytes and
/// window-resize events.
async fn read_output_loop(
    stdout: ChildStdout,
    output_tx: mpsc::Sender<Vec<u8>>,
    resize_tx: mpsc::Sender<(u16, u16)>,
) {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break, // EOF - tmux subprocess exited
            Ok(_) => {
                let Some(msg) = parse_control_line(&line) else {
                    continue;
                };
                match msg {
                    ControlMessage::Output { data, .. } => {
                        let bytes = unescape_tmux_data(&data);
                        if output_tx.send(bytes).await.is_err() {
                            // Receiver dropped - session is being torn down.
                            break;
                        }
                    }
                    ControlMessage::WindowResize { cols, rows, .. } => {
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
                    ControlMessage::Exit => break,
                    _ => {} // Ignore other messages (begin/end/session-changed/etc.)
                }
            }
            Err(_) => break,
        }
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

        let (session, _rx, _resize_rx) =
            ControlModeSession::attach(&fake.dep(), "nession-fake-sess", 80, 24)
                .await
                .expect("the injected binary accepts the resize and the attach");
        assert_eq!(session.viewport(), (80, 24));

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
}
