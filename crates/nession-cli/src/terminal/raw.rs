//! Terminal raw mode handling and bidirectional I/O forwarding.
//!
//! [`RawTerminal`] is a RAII guard that enters raw mode and the alternate
//! screen buffer on construction and unconditionally restores both on drop —
//! including on panic. This is critical: if the CLI crashes while still in raw
//! mode, the user is left with a broken terminal.
//!
//! [`TerminalSession`] ties a [`RawTerminal`] to a WebSocket transport and
//! forwards keyboard input to the remote agent and remote stdout back to the
//! local stdout, multiplexed via `tokio::select!`. Resize events are detected
//! and forwarded as `terminal.resize` messages.

use std::io::{self, Write};

use anyhow::{Context, Result};
use crossterm::{
    cursor,
    event::{
        poll as term_poll, read as term_read, DisableMouseCapture, EnableMouseCapture, Event,
        KeyCode, KeyEvent, KeyModifiers,
    },
    execute,
    terminal::{self, EnterAlternateScreen, LeaveAlternateScreen},
};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::protocol::Message as WsMessage};
use tracing::{debug, trace, warn};

use nession_agent::server::websocket::{
    Message, TerminalInputPayload, TerminalOutputPayload, TerminalResizePayload, msg_types,
};

// ---------------------------------------------------------------------------
// RawTerminal
// ---------------------------------------------------------------------------

/// RAII guard that enters raw mode + alternate screen and restores them on drop.
///
/// Drop is unconditionally safe: it calls `disable_raw_mode` and emits the
/// `LeaveAlternateScreen` escape sequence. If either fails, the error is
/// logged (a broken terminal is already worse than this) and drop continues.
pub struct RawTerminal {
    /// Set to `true` once we have successfully entered raw mode and must
    /// perform cleanup in `Drop`.
    active: bool,
    /// If we captured the mouse, track that so we release on drop.
    mouse_captured: bool,
}

impl RawTerminal {
    /// Enter raw mode, switch to the alternate screen buffer, and enable mouse
    /// capture. Returns a guard that restores the terminal on drop.
    pub fn enter() -> Result<Self> {
        terminal::enable_raw_mode().context("enable_raw_mode failed — is stdin a TTY?")?;
        let mut stdout = io::stdout();
        execute!(stdout, EnterAlternateScreen, EnableMouseCapture)
            .context("failed to enter alternate screen / enable mouse capture")?;
        stdout.flush().ok();
        debug!("raw terminal mode entered");
        Ok(Self {
            active: true,
            mouse_captured: true,
        })
    }

    /// Query the current terminal size (cols × rows).
    pub fn size() -> Result<(u16, u16)> {
        terminal::size().context("terminal::size failed")
    }

    /// Poll for an input event with a timeout. Returns `Ok(None)` on timeout.
    /// This is a thin wrapper around `crossterm::event::poll` that converts
    /// the `io::Error` to `anyhow`.
    pub fn poll_input(timeout: std::time::Duration) -> Result<bool> {
        term_poll(timeout).context("crossterm poll failed")
    }

    /// Read a single input event (blocking).
    pub fn read_input() -> Result<Event> {
        term_read().context("crossterm read failed")
    }

    /// Write raw bytes to stdout. Used for forwarding agent output.
    pub fn write_output(data: &[u8]) -> Result<()> {
        let mut stdout = io::stdout();
        stdout.write_all(data).context("stdout write_all failed")?;
        stdout.flush().context("stdout flush failed")?;
        Ok(())
    }

    /// Manually deactivate the guard. This runs the cleanup now so that the
    /// subsequent `Drop` becomes a no-op. Useful if you need to restore the
    /// terminal before dropping the guard (e.g. to print a final message on
    /// the normal screen).
    pub fn deactivate(&mut self) {
        if self.active {
            self.restore();
        }
    }

    fn restore(&mut self) {
        self.active = false;
        let mut stdout = io::stdout();
        if self.mouse_captured {
            if let Err(e) = execute!(stdout, DisableMouseCapture) {
                warn!("failed to disable mouse capture on exit: {e}");
            }
        }
        if let Err(e) = execute!(stdout, LeaveAlternateScreen, cursor::Show) {
            warn!("failed to leave alternate screen on exit: {e}");
        }
        if let Err(e) = terminal::disable_raw_mode() {
            warn!("failed to disable raw mode on exit: {e}");
        }
        let _ = stdout.flush();
        debug!("raw terminal mode restored");
    }
}

impl Drop for RawTerminal {
    fn drop(&mut self) {
        if self.active {
            // Drop must never panic; swallowing errors in `restore` is fine
            // because there's nothing useful the caller can do about them at
            // this point.
            self.restore();
        }
    }
}

// ---------------------------------------------------------------------------
// Keyboard → bytes
// ---------------------------------------------------------------------------

/// Convert a `KeyEvent` into the byte sequence that would be sent to a real
/// terminal. This is a deliberately small subset — tmux / the remote PTY will
/// do the normal ANSI interpretation.
///
/// Returns `None` for events we want to swallow (e.g. bare modifier presses).
pub fn key_event_to_bytes(ev: &KeyEvent) -> Option<Vec<u8>> {
    let ctrl = ev.modifiers.contains(KeyModifiers::CONTROL);
    let alt = ev.modifiers.contains(KeyModifiers::ALT);

    let mut out = Vec::new();

    match ev.code {
        KeyCode::Char(c) => {
            if ctrl {
                // Ctrl+A → 0x01 … Ctrl+Z → 0x1A
                let c_lower = c.to_ascii_lowercase();
                if ('a'..='z').contains(&c_lower) {
                    out.push(c_lower as u8 - b'a' + 1);
                } else {
                    // Pass other Ctrl combos through as UTF-8; the remote side
                    // can decide what to do.
                    let mut buf = [0u8; 4];
                    out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
                }
            } else if alt {
                out.push(0x1b); // ESC prefix for Alt+key
                let mut buf = [0u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            } else {
                let mut buf = [0u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            }
        }
        KeyCode::Enter => out.push(b'\r'),
        KeyCode::Backspace => out.push(0x7f),
        KeyCode::Tab => out.push(b'\t'),
        KeyCode::Esc => out.push(0x1b),
        KeyCode::Up => out.extend_from_slice(b"\x1b[A"),
        KeyCode::Down => out.extend_from_slice(b"\x1b[B"),
        KeyCode::Right => out.extend_from_slice(b"\x1b[C"),
        KeyCode::Left => out.extend_from_slice(b"\x1b[D"),
        KeyCode::Home => out.extend_from_slice(b"\x1b[H"),
        KeyCode::End => out.extend_from_slice(b"\x1b[F"),
        KeyCode::PageUp => out.extend_from_slice(b"\x1b[5~"),
        KeyCode::PageDown => out.extend_from_slice(b"\x1b[6~"),
        KeyCode::Delete => out.extend_from_slice(b"\x1b[3~"),
        KeyCode::Insert => out.extend_from_slice(b"\x1b[2~"),
        KeyCode::F(n) => {
            // Standard VT-style F-key sequences.
            let seq: &[u8] = match n {
                1 => b"\x1bOP",
                2 => b"\x1bOQ",
                3 => b"\x1bOR",
                4 => b"\x1bOS",
                5 => b"\x1b[15~",
                6 => b"\x1b[17~",
                7 => b"\x1b[18~",
                8 => b"\x1b[19~",
                9 => b"\x1b[20~",
                10 => b"\x1b[21~",
                11 => b"\x1b[23~",
                12 => b"\x1b[24~",
                _ => return None,
            };
            out.extend_from_slice(seq);
        }
        // Null → ignore
        KeyCode::Null => return None,
        _ => return None,
    }

    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

// ---------------------------------------------------------------------------
// Message construction helpers
// ---------------------------------------------------------------------------

/// Build a `terminal.input` message. `data` is raw bytes; we base64-encode
/// them into the payload.
pub fn build_terminal_input_message(session_name: &str, data: &[u8]) -> String {
    use base64::Engine;
    let payload = TerminalInputPayload {
        session_name: session_name.to_string(),
        data: base64::engine::general_purpose::STANDARD.encode(data),
    };
    let msg = Message {
        msg_type: msg_types::TERMINAL_INPUT.to_string(),
        id: uuid::Uuid::new_v4().to_string(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        payload,
    };
    serde_json::to_string(&msg).expect("terminal.input message serialization cannot fail")
}

/// Build a `terminal.resize` message.
pub fn build_terminal_resize_message(session_name: &str, width: u16, height: u16) -> String {
    let payload = TerminalResizePayload {
        session_name: session_name.to_string(),
        width,
        height,
    };
    let msg = Message {
        msg_type: msg_types::TERMINAL_RESIZE.to_string(),
        id: uuid::Uuid::new_v4().to_string(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        payload,
    };
    serde_json::to_string(&msg).expect("terminal.resize message serialization cannot fail")
}

/// Try to extract `terminal.output` data from a JSON message. Returns `None`
/// for non-output messages or messages that fail to decode.
pub fn extract_terminal_output(msg_text: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let msg: Message<TerminalOutputPayload> = serde_json::from_str(msg_text).ok()?;
    if msg.msg_type != msg_types::TERMINAL_OUTPUT {
        return None;
    }
    base64::engine::general_purpose::STANDARD
        .decode(&msg.payload.data)
        .ok()
}

// ---------------------------------------------------------------------------
// TerminalSession
// ---------------------------------------------------------------------------

/// The transport half of a [`TerminalSession`]. We're generic over this so we
/// can swap in a mock during tests.
#[async_trait::async_trait]
pub trait TerminalTransport: Send + 'static {
    /// Send a text frame to the remote.
    async fn send_text(&mut self, text: String) -> Result<()>;
    /// Receive the next text frame, or `None` if the transport closed.
    async fn recv_text(&mut self) -> Result<Option<String>>;
}

/// Bidirectional terminal session.
///
/// Owns a [`RawTerminal`] guard and a transport. `run` multiplexes:
/// - Keyboard events → `terminal.input` to the transport
/// - Resize events → `terminal.resize` to the transport
/// - Incoming `terminal.output` → local stdout
///
/// Exits cleanly when `cancel` is signalled (e.g. by a ctrl-c handler) or
/// when the transport closes.
pub struct TerminalSession<T: TerminalTransport> {
    session_name: String,
    transport: T,
    cancel: watch::Receiver<bool>,
}

/// WebSocket-based terminal transport. Wraps a WebSocket connection to an
/// agent (P2P or relay mode).
pub struct WebSocketTransport {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl WebSocketTransport {
    /// Create a new transport wrapping an existing WebSocket connection.
    pub fn new(ws: WebSocketStream<MaybeTlsStream<TcpStream>>) -> Self {
        Self { ws }
    }
}

#[async_trait::async_trait]
impl TerminalTransport for WebSocketTransport {
    async fn send_text(&mut self, text: String) -> Result<()> {
        self.ws
            .send(WsMessage::Text(text))
            .await
            .context("WebSocket send failed")
    }

    async fn recv_text(&mut self) -> Result<Option<String>> {
        loop {
            match self.ws.next().await {
                Some(Ok(WsMessage::Text(text))) => return Ok(Some(text)),
                Some(Ok(WsMessage::Ping(data))) => {
                    // Respond to pings to keep the connection alive.
                    let _ = self.ws.send(WsMessage::Pong(data)).await;
                }
                Some(Ok(_)) => {
                    // Ignore binary, pong, close frames (keep looping)
                }
                Some(Err(e)) => return Err(anyhow::Error::from(e).context("WebSocket recv error")),
                None => return Ok(None), // Connection closed
            }
        }
    }
}

impl<T: TerminalTransport> TerminalSession<T> {
    pub fn new(session_name: String, transport: T, cancel: watch::Receiver<bool>) -> Self {
        Self {
            session_name,
            transport,
            cancel,
        }
    }

    /// Run the forwarding loop. Enters raw mode for the duration of the call
    /// and restores the terminal before returning — including on error.
    ///
    /// `detach_key` is a key sequence (default `Ctrl-b d`) that triggers a
    /// graceful detach. When the user presses it, we send no bytes to the
    /// remote and instead return `Ok(())`.
    pub async fn run(mut self, detach_key: Option<KeyEvent>) -> Result<()> {
        let mut raw = RawTerminal::enter()?;
        let (cols, rows) = RawTerminal::size().unwrap_or((80, 24));

        // Announce initial size.
        if let Err(e) = self
            .transport
            .send_text(build_terminal_resize_message(&self.session_name, cols, rows))
            .await
        {
            raw.deactivate();
            return Err(e).context("initial terminal.resize send failed");
        }

        // Buffer for partial multi-byte detach key matches.
        let detach_buf: Vec<u8> = detach_key
            .as_ref()
            .and_then(|k| key_event_to_bytes(k))
            .unwrap_or_default();

        // Per-byte cursor into detach_buf: if the user types the prefix of
        // the detach key we hold those bytes back until we know whether the
        // full sequence arrives.
        let mut pending_detach: Vec<u8> = Vec::new();

        let result = self
            .forward_loop(&mut raw, detach_buf, &mut pending_detach)
            .await;

        // Always restore the terminal, even on error.
        raw.deactivate();
        result
    }

    async fn forward_loop(
        &mut self,
        _raw: &mut RawTerminal,
        detach_buf: Vec<u8>,
        pending_detach: &mut Vec<u8>,
    ) -> Result<()> {
        loop {
            tokio::select! {
                // Cancellation (e.g. ctrl-c).
                _ = self.cancel.changed() => {
                    if *self.cancel.borrow() {
                        debug!("terminal session cancelled");
                        return Ok(());
                    }
                }

                // Keyboard / resize input.
                input = tokio::task::spawn_blocking(|| {
                    // Block until an event is available; crossterm's poll uses
                    // a small internal timeout internally, so this is
                    // interruptible by tokio's blocking pool.
                    match term_poll(std::time::Duration::from_millis(100)) {
                        Ok(true) => term_read().map(Some).map_err(anyhow::Error::from),
                        Ok(false) => Ok(None), // timeout, no event
                        Err(e) => Err(anyhow::Error::from(e)),
                    }
                }) => {
                    match input {
                        Ok(Ok(Some(Event::Key(kev)))) => {
                            let bytes = match key_event_to_bytes(&kev) {
                                Some(b) => b,
                                None => continue,
                            };
                            // Detach-key handling: hold bytes back until the
                            // sequence is confirmed or broken.
                            if !detach_buf.is_empty() {
                                let flushed =
                                    feed_detach(&bytes, &detach_buf, pending_detach);
                                if flushed.is_detach() {
                                    debug!("detach key pressed, ending session");
                                    return Ok(());
                                }
                                if !flushed.bytes_to_send.is_empty() {
                                    if let Err(e) = self
                                        .transport
                                        .send_text(build_terminal_input_message(
                                            &self.session_name,
                                            &flushed.bytes_to_send,
                                        ))
                                        .await
                                    {
                                        return Err(e).context("terminal.input send failed");
                                    }
                                }
                                if flushed.is_detach() {
                                    return Ok(());
                                }
                            } else {
                                if let Err(e) = self
                                    .transport
                                    .send_text(build_terminal_input_message(
                                        &self.session_name,
                                        &bytes,
                                    ))
                                    .await
                                {
                                    return Err(e).context("terminal.input send failed");
                                }
                            }
                        }
                        Ok(Ok(Some(Event::Resize(w, h)))) => {
                            trace!("resize: {w}x{h}");
                            if let Err(e) = self
                                .transport
                                .send_text(build_terminal_resize_message(&self.session_name, w, h))
                                .await
                            {
                                return Err(e).context("terminal.resize send failed");
                            }
                        }
                        Ok(Ok(Some(_))) => { /* mouse / focus / paste — ignore */ }
                        Ok(Ok(None)) => { /* poll timeout */ }
                        Ok(Err(e)) => {
                            warn!("input read error: {e:#}");
                            // Don't hard-fail on transient input errors; loop.
                        }
                        Err(e) => {
                            return Err(anyhow::Error::from(e)).context("input blocking task failed");
                        }
                    }
                }

                // Remote output.
                msg = self.transport.recv_text() => {
                    match msg {
                        Ok(Some(text)) => {
                            if let Some(data) = extract_terminal_output(&text) {
                                if let Err(e) = std::io::Write::write_all(&mut std::io::stdout(), &data) {
                                    return Err(e).context("stdout write failed");
                                }
                                let _ = std::io::Write::flush(&mut std::io::stdout());
                            }
                            // Other message types are silently ignored here;
                            // higher layers (session management) handle them.
                        }
                        Ok(None) => {
                            debug!("transport closed");
                            return Ok(());
                        }
                        Err(e) => {
                            return Err(e).context("transport recv failed");
                        }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Detach-key state machine
// ---------------------------------------------------------------------------

struct DetachFlush {
    /// Bytes that have been confirmed as NOT the detach sequence and should
    /// now be forwarded.
    bytes_to_send: Vec<u8>,
    /// True if the full detach sequence was matched.
    detach: bool,
}

impl DetachFlush {
    fn is_detach(&self) -> bool {
        self.detach
    }
}

/// Feed `incoming` bytes into the detach-key matcher. Returns bytes that are
/// now known to be "not the detach key" (should be forwarded) plus a flag if
/// the full detach key was matched.
fn feed_detach(incoming: &[u8], detach_buf: &[u8], pending: &mut Vec<u8>) -> DetachFlush {
    if detach_buf.is_empty() {
        return DetachFlush {
            bytes_to_send: incoming.to_vec(),
            detach: false,
        };
    }
    let mut flushed = Vec::new();
    for &b in incoming {
        pending.push(b);
        // Is `pending` still a prefix of `detach_buf`?
        let is_prefix = pending.len() <= detach_buf.len()
            && pending.iter().zip(detach_buf.iter()).all(|(a, b)| a == b);
        if is_prefix {
            if pending.len() == detach_buf.len() {
                // Full match → detach.
                pending.clear();
                return DetachFlush {
                    bytes_to_send: flushed,
                    detach: true,
                };
            }
            // Still a prefix; keep buffering.
        } else {
            // Mismatch: flush everything we had buffered, including this byte.
            flushed.extend_from_slice(pending);
            pending.clear();
        }
    }
    DetachFlush {
        bytes_to_send: flushed,
        detach: false,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    #[test]
    fn key_event_to_bytes_printable_ascii() {
        let ev = KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE);
        assert_eq!(key_event_to_bytes(&ev), Some(vec![b'a']));
    }

    #[test]
    fn key_event_to_bytes_ctrl_c() {
        let ev = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(key_event_to_bytes(&ev), Some(vec![0x03]));
    }

    #[test]
    fn key_event_to_bytes_ctrl_a() {
        let ev = KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL);
        assert_eq!(key_event_to_bytes(&ev), Some(vec![0x01]));
    }

    #[test]
    fn key_event_to_bytes_alt_x() {
        let ev = KeyEvent::new(KeyCode::Char('x'), KeyModifiers::ALT);
        assert_eq!(key_event_to_bytes(&ev), Some(vec![0x1b, b'x']));
    }

    #[test]
    fn key_event_to_bytes_enter() {
        let ev = KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(key_event_to_bytes(&ev), Some(vec![b'\r']));
    }

    #[test]
    fn key_event_to_bytes_backspace() {
        let ev = KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE);
        assert_eq!(key_event_to_bytes(&ev), Some(vec![0x7f]));
    }

    #[test]
    fn key_event_to_bytes_arrow_keys() {
        let up = KeyEvent::new(KeyCode::Up, KeyModifiers::NONE);
        assert_eq!(key_event_to_bytes(&up), Some(b"\x1b[A".to_vec()));
        let down = KeyEvent::new(KeyCode::Down, KeyModifiers::NONE);
        assert_eq!(key_event_to_bytes(&down), Some(b"\x1b[B".to_vec()));
        let right = KeyEvent::new(KeyCode::Right, KeyModifiers::NONE);
        assert_eq!(key_event_to_bytes(&right), Some(b"\x1b[C".to_vec()));
        let left = KeyEvent::new(KeyCode::Left, KeyModifiers::NONE);
        assert_eq!(key_event_to_bytes(&left), Some(b"\x1b[D".to_vec()));
    }

    #[test]
    fn key_event_to_bytes_f_keys() {
        let f1 = KeyEvent::new(KeyCode::F(1), KeyModifiers::NONE);
        assert_eq!(key_event_to_bytes(&f1), Some(b"\x1bOP".to_vec()));
        let f12 = KeyEvent::new(KeyCode::F(12), KeyModifiers::NONE);
        assert_eq!(key_event_to_bytes(&f12), Some(b"\x1b[24~".to_vec()));
    }

    #[test]
    fn key_event_to_bytes_unicode() {
        let ev = KeyEvent::new(KeyCode::Char('日'), KeyModifiers::NONE);
        assert_eq!(key_event_to_bytes(&ev), Some("日".as_bytes().to_vec()));
    }

    #[test]
    fn build_terminal_input_message_is_valid_json() {
        let msg = build_terminal_input_message("foo", b"hello");
        let v: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(v["msg_type"], "terminal.input");
        assert_eq!(v["payload"]["session_name"], "foo");
        // "hello" → base64 is "aGVsbG8="
        assert_eq!(v["payload"]["data"], "aGVsbG8=");
    }

    #[test]
    fn build_terminal_resize_message_is_valid_json() {
        let msg = build_terminal_resize_message("s", 120, 40);
        let v: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(v["msg_type"], "terminal.resize");
        assert_eq!(v["payload"]["width"], 120);
        assert_eq!(v["payload"]["height"], 40);
    }

    #[test]
    fn extract_terminal_output_roundtrip() {
        use base64::Engine;
        let payload = TerminalOutputPayload {
            session_name: "s".into(),
            data: base64::engine::general_purpose::STANDARD.encode(b"hi"),
        };
        let msg = Message {
            msg_type: msg_types::TERMINAL_OUTPUT.to_string(),
            id: "1".into(),
            timestamp: 0,
            payload,
        };
        let s = serde_json::to_string(&msg).unwrap();
        assert_eq!(extract_terminal_output(&s), Some(b"hi".to_vec()));
    }

    #[test]
    fn extract_terminal_output_ignores_other_types() {
        let msg = build_terminal_input_message("s", b"x");
        assert_eq!(extract_terminal_output(&msg), None);
    }

    // -- Detach-key state machine -------------------------------------------

    #[test]
    fn feed_detach_empty_detach_buf_passes_through() {
        let mut pending = Vec::new();
        let result = feed_detach(b"abc", &[], &mut pending);
        assert_eq!(result.bytes_to_send, b"abc");
        assert!(!result.is_detach());
    }

    #[test]
    fn feed_detach_full_match() {
        // Detach sequence = ESC (0x1b)
        let detach = vec![0x1b];
        let mut pending = Vec::new();
        let result = feed_detach(&[0x1b], &detach, &mut pending);
        assert!(result.is_detach());
        assert!(result.bytes_to_send.is_empty());
    }

    #[test]
    fn feed_detach_mismatch_flushes() {
        // Detach sequence is two bytes: ESC [
        let detach = vec![0x1b, b'['];
        let mut pending = Vec::new();
        // Feed 'x' — immediately mismatches the first byte.
        let result = feed_detach(b"x", &detach, &mut pending);
        assert!(!result.is_detach());
        assert_eq!(result.bytes_to_send, b"x");
    }

    #[test]
    fn feed_detach_partial_then_mismatch_flushes() {
        // Detach sequence is two bytes: ESC [
        let detach = vec![0x1b, b'['];
        let mut pending = Vec::new();
        // First byte matches the prefix.
        let r1 = feed_detach(&[0x1b], &detach, &mut pending);
        assert!(!r1.is_detach());
        assert!(r1.bytes_to_send.is_empty());
        // Second byte mismatches; both bytes flush.
        let r2 = feed_detach(b"x", &detach, &mut pending);
        assert!(!r2.is_detach());
        assert_eq!(r2.bytes_to_send, &[0x1b, b'x']);
    }

    #[test]
    fn feed_detach_multi_byte_input_partial_match_then_full_match() {
        // Detach = "AB"
        let detach = vec![b'A', b'B'];
        let mut pending = Vec::new();
        // Feed "A" — prefix match.
        let r1 = feed_detach(b"A", &detach, &mut pending);
        assert!(!r1.is_detach());
        assert!(r1.bytes_to_send.is_empty());
        // Feed "B" — full match.
        let r2 = feed_detach(b"B", &detach, &mut pending);
        assert!(r2.is_detach());
    }
}
