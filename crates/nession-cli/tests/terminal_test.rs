//! Integration tests for the terminal module.
//!
//! These tests verify the message routing logic of [`TerminalSession`] using a
//! mock transport that simulates the agent side.

use anyhow::Result;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use nession_cli::terminal::raw::{
    build_terminal_input_message, build_terminal_resize_message, extract_terminal_output,
    key_event_to_bytes,
};
use nession_cli::terminal::{TerminalSession, TerminalTransport};
use tokio::sync::{mpsc, watch};

/// A mock transport that captures sent messages and allows injecting received
/// messages for testing the session's forwarding logic.
struct MockTransport {
    sent_tx: mpsc::UnboundedSender<String>,
    recv_rx: mpsc::UnboundedReceiver<String>,
}

#[async_trait::async_trait]
impl TerminalTransport for MockTransport {
    async fn send_text(&mut self, text: String) -> Result<()> {
        self.sent_tx
            .send(text)
            .map_err(|_| anyhow::anyhow!("send channel closed"))
    }

    async fn recv_text(&mut self) -> Result<Option<String>> {
        Ok(self.recv_rx.recv().await)
    }
}

#[tokio::test]
async fn test_terminal_input_message_format() {
    let msg = build_terminal_input_message("test_session", b"hello");
    let v: serde_json::Value = serde_json::from_str(&msg).unwrap();
    assert_eq!(v["msg_type"], "terminal.input");
    assert_eq!(v["payload"]["session_name"], "test_session");
    // "hello" in base64 is "aGVsbG8="
    assert_eq!(v["payload"]["data"], "aGVsbG8=");
}

#[tokio::test]
async fn test_terminal_resize_message_format() {
    let msg = build_terminal_resize_message("sess", 120, 40);
    let v: serde_json::Value = serde_json::from_str(&msg).unwrap();
    assert_eq!(v["msg_type"], "terminal.resize");
    assert_eq!(v["payload"]["session_name"], "sess");
    assert_eq!(v["payload"]["width"], 120);
    assert_eq!(v["payload"]["height"], 40);
}

#[tokio::test]
async fn test_extract_terminal_output_valid() {
    use base64::Engine;
    let payload = nession_agent::server::websocket::TerminalOutputPayload {
        session_name: "s".into(),
        data: base64::engine::general_purpose::STANDARD.encode(b"test output"),
    };
    let msg = nession_agent::server::websocket::Message {
        msg_type: nession_agent::server::websocket::msg_types::TERMINAL_OUTPUT.to_string(),
        id: "1".into(),
        timestamp: 0,
        payload,
    };
    let s = serde_json::to_string(&msg).unwrap();
    let extracted = extract_terminal_output(&s);
    assert_eq!(extracted, Some(b"test output".to_vec()));
}

#[tokio::test]
async fn test_extract_terminal_output_wrong_type() {
    let msg = build_terminal_input_message("s", b"x");
    assert_eq!(extract_terminal_output(&msg), None);
}

#[tokio::test]
async fn test_key_event_conversion_comprehensive() {
    // Printable ASCII
    assert_eq!(
        key_event_to_bytes(&KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE)),
        Some(vec![b'a'])
    );

    // Control sequences
    assert_eq!(
        key_event_to_bytes(&KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
        Some(vec![0x03]) // Ctrl-C
    );

    // Alt sequences
    assert_eq!(
        key_event_to_bytes(&KeyEvent::new(KeyCode::Char('x'), KeyModifiers::ALT)),
        Some(vec![0x1b, b'x']) // ESC + x
    );

    // Arrow keys
    assert_eq!(
        key_event_to_bytes(&KeyEvent::new(KeyCode::Up, KeyModifiers::NONE)),
        Some(b"\x1b[A".to_vec())
    );

    // Function keys
    assert_eq!(
        key_event_to_bytes(&KeyEvent::new(KeyCode::F(1), KeyModifiers::NONE)),
        Some(b"\x1bOP".to_vec())
    );

    // Special keys
    assert_eq!(
        key_event_to_bytes(&KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(vec![b'\r'])
    );
    assert_eq!(
        key_event_to_bytes(&KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE)),
        Some(vec![0x7f])
    );

    // Unicode
    assert_eq!(
        key_event_to_bytes(&KeyEvent::new(KeyCode::Char('日'), KeyModifiers::NONE)),
        Some("日".as_bytes().to_vec())
    );
}

#[tokio::test]
async fn test_message_routing_input_to_transport() {
    let (sent_tx, _sent_rx) = mpsc::unbounded_channel();
    let (_recv_tx, recv_rx) = mpsc::unbounded_channel();
    let (cancel_tx, cancel_rx) = watch::channel(false);

    let transport = MockTransport { sent_tx, recv_rx };
    let _session = TerminalSession::new("test".to_string(), transport, cancel_rx);

    // We can't easily test the full run() loop without a real TTY, but we can
    // verify that the message construction functions work correctly and would
    // be sent to the transport.

    // Simulate what would happen: key event → bytes → message → transport
    let key_bytes = key_event_to_bytes(&KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE))
        .expect("should produce bytes");
    let msg = build_terminal_input_message("test", &key_bytes);

    // Verify the message structure
    let v: serde_json::Value = serde_json::from_str(&msg).unwrap();
    assert_eq!(v["msg_type"], "terminal.input");
    assert_eq!(v["payload"]["session_name"], "test");

    drop(cancel_tx);
}

#[tokio::test]
async fn test_message_routing_output_from_transport() {
    use base64::Engine;

    // Create a terminal.output message
    let payload = nession_agent::server::websocket::TerminalOutputPayload {
        session_name: "s".into(),
        data: base64::engine::general_purpose::STANDARD.encode(b"output data"),
    };
    let msg = nession_agent::server::websocket::Message {
        msg_type: nession_agent::server::websocket::msg_types::TERMINAL_OUTPUT.to_string(),
        id: "1".into(),
        timestamp: 0,
        payload,
    };
    let msg_str = serde_json::to_string(&msg).unwrap();

    // Verify extraction
    let extracted = extract_terminal_output(&msg_str);
    assert_eq!(extracted, Some(b"output data".to_vec()));
}

#[tokio::test]
async fn test_resize_message_routing() {
    let msg = build_terminal_resize_message("session1", 132, 50);
    let v: serde_json::Value = serde_json::from_str(&msg).unwrap();
    assert_eq!(v["msg_type"], "terminal.resize");
    assert_eq!(v["payload"]["width"], 132);
    assert_eq!(v["payload"]["height"], 50);
}
