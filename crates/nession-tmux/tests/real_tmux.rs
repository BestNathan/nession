//! Real isolated-tmux proof for the standalone SDK.
//!
//! Every test creates its own tmux server on its own socket, so no test can
//! reach the developer's default tmux server and no shared test state can make
//! another test's attach race a session removal. A missing `tmux` binary is a
//! failure, not a skip: the crate's acceptance matrix claims a real-tmux
//! contract, and a green run without tmux would prove nothing.

use std::time::{Duration, Instant};

use nession_tmux::{ControlCommand, ControlTransport, TmuxClient, TmuxCommand, TmuxEvent};

fn unique_name(prefix: &str) -> String {
    format!("nession-sdk-{prefix}-{}", std::process::id())
}

async fn create_session(command: &TmuxCommand, name: &str) -> anyhow::Result<()> {
    let out = command
        .output(&["new-session", "-d", "-s", name, "-x", "80", "-y", "24"])
        .await?;
    anyhow::ensure!(
        out.status.success(),
        "new-session failed: {}",
        String::from_utf8_lossy(&out.stderr).trim()
    );
    Ok(())
}

async fn kill_session(command: &TmuxCommand, name: &str) {
    let _ = command.output(&["kill-session", "-t", name]).await;
}

/// Attach, consume the welcome pair, and prove a typed command round-trips.
async fn attach_and_echo(
    command: &TmuxCommand,
    name: &str,
    transport: ControlTransport,
) -> anyhow::Result<()> {
    let mut client = TmuxClient::connect_with(command, name, transport)?;
    let mut events = client
        .take_events()
        .ok_or_else(|| anyhow::anyhow!("event stream was already taken"))?;

    let welcome = tokio::time::timeout(Duration::from_secs(10), events.recv())
        .await
        .map_err(|_| anyhow::anyhow!("{transport:?}: no welcome pair within 10s"))?
        .ok_or_else(|| anyhow::anyhow!("{transport:?}: event stream ended before welcome"))?;
    anyhow::ensure!(
        welcome == TmuxEvent::Handshaken,
        "{transport:?}: expected Handshaken, got {welcome:?}"
    );

    let marker = format!("SDK_MARKER_{}", std::process::id());
    client
        .send_input(format!("printf '{marker}\\n'\n").as_bytes())
        .await?;

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let captured = client.capture_pane(100).await?;
        if captured
            .windows(marker.len())
            .any(|window| window == marker.as_bytes())
        {
            break;
        }
        anyhow::ensure!(
            Instant::now() < deadline,
            "{transport:?}: marker {marker} never appeared in the captured pane; last capture: {}",
            String::from_utf8_lossy(&captured)
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // A typed control command with a textual answer (no pane bytes involved).
    let reply = client.command(ControlCommand::RefreshClient).await?;
    anyhow::ensure!(reply.is_empty(), "refresh-client answered {reply:?}");

    client.close().await;
    Ok(())
}

/// `-C` pipe and `-CC` PTY over one real isolated tmux server.
///
/// Sequential on purpose: on macOS, Homebrew tmux can crash its server when
/// control clients disconnect in parallel, which is a property of the host, not
/// of either transport.
#[tokio::test]
async fn real_isolated_tmux_supports_pipe_and_pty_control_attachments() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let command = TmuxCommand::new("tmux", dir.path().join("tmux.sock"));
    command.validate()?;
    let name = unique_name("attach");

    create_session(&command, &name).await?;

    let result = async {
        attach_and_echo(&command, &name, ControlTransport::Pipe).await?;
        #[cfg(unix)]
        attach_and_echo(
            &command,
            &name,
            ControlTransport::Pty { cols: 80, rows: 24 },
        )
        .await?;
        Ok::<(), anyhow::Error>(())
    }
    .await;

    kill_session(&command, &name).await;
    result
}

/// The caller's personal tmux server is never addressed.
///
/// The SDK has no default-socket fallback: a relative or empty socket is
/// refused before any child is spawned.
#[test]
fn a_relative_socket_is_refused_before_spawning() {
    let command = TmuxCommand::new("tmux", "relative/tmux.sock");
    assert!(command.validate().is_err());
}
