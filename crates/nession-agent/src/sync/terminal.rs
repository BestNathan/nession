//! Terminal resize message sending for the nession agent.
//!
//! Provides a helper to construct and send `agent.terminal.resize` messages
//! over an async WebSocket writer, used when tmux reports window size changes.

use nession_common::protocol::{AgentTerminalResizePayload, Message};

/// Send terminal resize event to server.
///
/// Constructs an [`AgentTerminalResizePayload`], wraps it in a [`Message`] with
/// msg_type `"agent.terminal.resize"`, serializes to JSON and writes it
/// (newline-terminated) to the provided async writer.
pub async fn send_terminal_resize(
    writer: &mut (impl tokio::io::AsyncWriteExt + Unpin),
    session_id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    let payload = AgentTerminalResizePayload {
        session_id: session_id.to_string(),
        cols,
        rows,
    };
    let msg = Message::new(
        "agent.terminal.resize".to_string(),
        uuid::Uuid::new_v4().to_string(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs(),
        payload,
    );
    let json = serde_json::to_string(&msg)?;
    writer.write_all(json.as_bytes()).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await?;
    Ok(())
}
