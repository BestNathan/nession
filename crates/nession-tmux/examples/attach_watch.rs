//! Attach to an existing tmux session over Control Mode and print its output.
//!
//! ```bash
//! cargo run -p nession-tmux --example attach_watch -- /tmp/my-app/tmux.sock work
//! ```
//!
//! The socket must already host a tmux server with the named session. This
//! example deliberately does not create one: the typed administration API
//! arrives in the next migration slice.

use nession_tmux::{ControlTransport, TmuxClient, TmuxCommand, TmuxEvent};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let socket = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("usage: attach_watch <absolute-socket> <session>"))?;
    let session = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("usage: attach_watch <absolute-socket> <session>"))?;

    let command = TmuxCommand::new("tmux", socket);
    command.validate()?;

    let mut client = TmuxClient::connect_with(&command, &session, ControlTransport::Pipe)?;
    let mut events = client
        .take_events()
        .ok_or_else(|| anyhow::anyhow!("event stream already taken"))?;

    while let Some(event) = events.recv().await {
        match event {
            TmuxEvent::Handshaken => eprintln!("attached to {session}"),
            TmuxEvent::Output(chunk) => {
                use std::io::Write;
                std::io::stdout().write_all(&chunk.data)?;
            }
            TmuxEvent::SourceLost { reason } => {
                eprintln!("source lost: {reason}");
                break;
            }
            other => eprintln!("event: {other:?}"),
        }
    }

    client.close().await;
    Ok(())
}
