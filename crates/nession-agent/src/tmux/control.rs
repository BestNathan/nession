//! tmux control mode session 管理
//!
//! Uses `tmux -C attach` to control a tmux session, parsing structured
//! messages instead of raw PTY output. Each client sets an independent
//! viewport via `refresh-client -C`.

use anyhow::{Context, Result};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;

use super::parser::{parse_control_line, unescape_tmux_data, ControlMessage};

/// Buffer capacity for the output channel — bytes-per-batch parsed from tmux.
const OUTPUT_CHANNEL_CAPACITY: usize = 256;

/// tmux control mode session — one per attached web client.
///
/// Spawns a `tmux -C attach` subprocess and pipes structured messages
/// (parsed to raw ANSI bytes) through an mpsc channel. The caller drives
/// input via `write_input` and viewport changes via `resize`.
pub struct ControlModeSession {
    session_name: String,
    child: Child,
    stdin: ChildStdin,
    viewport: (u16, u16),
}

impl ControlModeSession {
    /// Attach to a tmux session in control mode.
    ///
    /// Spawns `tmux -C attach -t <session_name>`, starts a background task
    /// that parses `%output` messages and sends unescaped ANSI bytes on the
    /// returned channel, and sets the initial viewport via `refresh-client -C`.
    ///
    /// Returns `(session, output_receiver)`. The receiver yields raw ANSI
    /// byte chunks ready to forward to xterm.js. When the tmux subprocess
    /// exits (or the reader task drops the sender), the receiver closes.
    pub async fn attach(
        session_name: &str,
        width: u16,
        height: u16,
    ) -> Result<(Self, mpsc::Receiver<Vec<u8>>)> {
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
        tokio::spawn(read_output_loop(stdout, output_tx));

        let mut session = Self {
            session_name: session_name.to_string(),
            child,
            stdin,
            viewport: (width, height),
        };
        session.send_refresh(width, height).await?;

        Ok((session, output_rx))
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

    /// Resize the client viewport. Only affects THIS control client; other
    /// clients attached to the same session keep their own sizes.
    pub async fn resize(&mut self, width: u16, height: u16) -> Result<()> {
        self.send_refresh(width, height).await?;
        self.viewport = (width, height);
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

    async fn send_refresh(&mut self, width: u16, height: u16) -> Result<()> {
        let cmd = format!("refresh-client -C {width},{height}\n");
        self.stdin.write_all(cmd.as_bytes()).await?;
        self.stdin.flush().await?;
        Ok(())
    }
}

impl Drop for ControlModeSession {
    fn drop(&mut self) {
        // Best-effort kill. Drop is sync so we can't await the wait().
        let _ = self.child.start_kill();
    }
}

/// Background reader: parse control mode lines, forward ANSI bytes.
async fn read_output_loop(stdout: ChildStdout, output_tx: mpsc::Sender<Vec<u8>>) {
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
                    ControlMessage::Exit => break,
                    _ => {} // Ignore other messages (begin/end/session-changed/etc.)
                }
            }
            Err(_) => break,
        }
    }
}
