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

use anyhow::{Context, Result};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;

use super::parser::{parse_control_line, unescape_tmux_data, ControlMessage};
use super::util::run_tmux_command;

/// Buffer capacity for the output channel — bytes-per-batch parsed from tmux.
const OUTPUT_CHANNEL_CAPACITY: usize = 256;

/// Buffer capacity for the resize channel — one (cols, rows) tuple per event.
const RESIZE_CHANNEL_CAPACITY: usize = 16;

/// tmux control mode session — one per attached web client.
///
/// Spawns a `tmux -C attach` subprocess and pipes structured messages
/// (parsed to raw ANSI bytes) through an mpsc channel. The caller drives
/// input via `write_input` and resizes the tmux window via `resize`.
pub struct ControlModeSession {
    session_name: String,
    child: Child,
    stdin: ChildStdin,
    viewport: (u16, u16),
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
    pub async fn attach(
        session_name: &str,
        width: u16,
        height: u16,
    ) -> Result<(Self, mpsc::Receiver<Vec<u8>>, mpsc::Receiver<(u16, u16)>)> {
        // Resize tmux window to client's requested size BEFORE attaching.
        // This ensures tmux renders at the correct dimensions from the first
        // frame, avoiding a flash of wrong-sized content.
        run_tmux_command(
            session_name,
            &[
                "resize-window",
                "-x",
                &width.to_string(),
                "-y",
                &height.to_string(),
            ],
        )
        .await?;

        let mut child = Command::new("tmux")
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

    /// Resize the tmux window and trigger a full redraw.
    ///
    /// Sends two commands via control-mode stdin:
    /// 1. `resize-window` — changes the window size (affects all clients)
    /// 2. `refresh-client` — triggers a full pane redraw so the reflowed
    ///    content is sent as `%output` messages immediately
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

    /// Close the tmux subprocess. Idempotent.
    pub async fn close(&mut self) -> Result<()> {
        // start_kill instead of kill().await to avoid waiting if the child
        // is already gone.
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
        Ok(())
    }
}

impl Drop for ControlModeSession {
    fn drop(&mut self) {
        // Best-effort kill. Drop is sync so we can't await the wait().
        let _ = self.child.start_kill();
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
                        // Best-effort: if the receiver is gone the client
                        // has detached but we keep reading output until
                        // the output channel also closes.
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

// resize() spawns a separate `tmux resize-window` process; covered by
// integration tests (test_resize_updates_viewport, etc.).
