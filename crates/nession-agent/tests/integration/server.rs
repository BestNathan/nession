//! Integration tests for the agent WebSocket server.
//!
//! These tests exercise the public API of [`AgentServer`] end-to-end:
//! bind, connect, send requests, and receive responses. They require a
//! working tmux installation (same as the tmux manager / pty tests).

use super::TestSession;
use futures_util::{SinkExt, StreamExt};
use nession_agent::config::AttachMode;
use nession_agent::server::websocket::{
    msg_types, new_message, AgentServer, ClientAttachPayload, ClientAttachResponse,
    ClientDetachPayload, ClientDetachResponse, OkPayload, SessionCreatePayload,
    SessionCreateResponse, SessionKillPayload, SessionKillResponse,
};
use nession_agent::tmux::manager::SessionManager;
use serde::Serialize;
use std::net::SocketAddr;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// Start a test server (OS picks a free port) and return the real bound
/// address + handle.
async fn start_server(
    _port: u16,
) -> anyhow::Result<(SocketAddr, nession_agent::server::ServerHandle)> {
    let tmp = Box::leak(Box::new(tempfile::tempdir()?));
    let (_resize_tx, _resize_rx) = tokio::sync::mpsc::unbounded_channel::<(String, u16, u16)>();
    let server = AgentServer::new(
        "127.0.0.1:0",
        "test-agent",
        None,
        "/tmp".to_string(),
        tmp.path().to_string_lossy().as_ref(),
        AttachMode::Plain,
        _resize_tx,
    )?;
    let (handle, addr) = server.start().await?;
    Ok((addr, handle))
}

/// Connect a WebSocket client and return the split sink / stream.
type WsSink = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    WsMessage,
>;
type WsStream = futures_util::stream::SplitStream<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
>;

async fn connect(addr: SocketAddr) -> anyhow::Result<(WsSink, WsStream)> {
    let url = format!("ws://{addr}");
    let (ws, _resp) = connect_async(&url).await?;
    Ok(ws.split())
}

/// Send a request and receive the next text response, deserialised.
async fn round_trip<Req: Serialize, Resp: serde::de::DeserializeOwned>(
    sink: &mut WsSink,
    stream: &mut WsStream,
    req: &nession_agent::server::websocket::Message<Req>,
) -> anyhow::Result<nession_agent::server::websocket::Message<Resp>> {
    use anyhow::Context;

    let json = serde_json::to_string(req)?;
    let request_id = req.id.clone();
    sink.send(WsMessage::Text(json)).await?;
    loop {
        match stream.next().await.context("websocket stream ended")?? {
            WsMessage::Text(text) => {
                // Parse as raw value to check the request id - skip
                // unsolicited messages like terminal.output from
                // background tasks.
                let raw: serde_json::Value = serde_json::from_str(&text)?;
                if raw.get("id").and_then(|v| v.as_str()) == Some(&request_id) {
                    return Ok(serde_json::from_value(raw)?);
                }
            }
            _ => continue,
        }
    }
}

#[tokio::test]
async fn integration_server_startup() {
    // Verify that the server binds, starts, and can be cleanly shut down.
    let (_, handle) = start_server(19081).await.unwrap();
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn integration_session_list() {
    let (addr, handle) = start_server(19082).await.unwrap();
    let (mut sink, mut stream) = connect(addr).await.unwrap();

    let req = new_message(msg_types::SESSION_LIST, serde_json::json!({}));
    let resp: nession_agent::server::websocket::Message<serde_json::Value> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();

    assert_eq!(resp.msg_type, msg_types::OK);
    assert!(resp.payload.get("sessions").is_some());

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_session_create_and_kill() {
    let (addr, handle) = start_server(19083).await.unwrap();
    let (mut sink, mut stream) = connect(addr).await.unwrap();

    let session = TestSession::new("create-kill");
    let session_name = session.name().to_string();
    let create = SessionCreatePayload {
        name: session_name.to_string(),
        width: 80,
        height: 24,
        env_snapshots: Vec::new(),
    };
    let req = new_message(msg_types::SESSION_CREATE, create);
    let resp: nession_agent::server::websocket::Message<SessionCreateResponse> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);
    assert_eq!(resp.payload.name, session_name);

    let kill = SessionKillPayload {
        name: session_name.to_string(),
    };
    let req = new_message(msg_types::SESSION_KILL, kill);
    let resp: nession_agent::server::websocket::Message<SessionKillResponse> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);
    assert_eq!(resp.payload.name, session_name);

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_client_attach_creates_pty() {
    let (addr, handle) = start_server(19084).await.unwrap();
    let (mut sink, mut stream) = connect(addr).await.unwrap();

    let tmux = SessionManager::new();
    let session = TestSession::new("attach");
    let session_name = session.name().to_string();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    // Attach.
    let attach = ClientAttachPayload {
        session_name: session_name.to_string(),
        width: 80,
        height: 24,
        env_snapshots: Vec::new(),
    };
    let req = new_message(msg_types::CLIENT_ATTACH, attach);
    let resp: nession_agent::server::websocket::Message<ClientAttachResponse> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);
    assert_eq!(resp.payload.session_name, session_name);

    // Detach.
    let detach = ClientDetachPayload {
        session_name: session_name.to_string(),
    };
    let req = new_message(msg_types::CLIENT_DETACH, detach);
    let resp: nession_agent::server::websocket::Message<ClientDetachResponse> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);
    assert_eq!(resp.payload.session_name, session_name);

    tmux.kill_session(&session_name).await.ok();
    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_terminal_io_flow() {
    let (addr, handle) = start_server(19085).await.unwrap();
    let (mut sink, mut stream) = connect(addr).await.unwrap();

    let tmux = SessionManager::new();
    let session = TestSession::new("io");
    let session_name = session.name().to_string();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    // Attach.
    let attach = ClientAttachPayload {
        session_name: session_name.to_string(),
        width: 80,
        height: 24,
        env_snapshots: Vec::new(),
    };
    let req = new_message(msg_types::CLIENT_ATTACH, attach);
    let _: nession_agent::server::websocket::Message<ClientAttachResponse> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();

    // Send terminal input immediately — post-attach sleep breaks macOS PTY writes.
    use base64::Engine;
    let input = base64::engine::general_purpose::STANDARD.encode(b"echo hello\n");
    let payload = nession_agent::server::websocket::TerminalInputPayload {
        session_name: session_name.to_string(),
        data: input,
    };
    let req = new_message(msg_types::TERMINAL_INPUT, payload);
    let resp: nession_agent::server::websocket::Message<OkPayload> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);

    // Wait for terminal output.
    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;

    let mut got_hello = false;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(std::time::Duration::from_secs(2), stream.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let msg: nession_agent::server::websocket::Message<serde_json::Value> =
                    serde_json::from_str(&text).unwrap();
                if msg.msg_type == msg_types::TERMINAL_OUTPUT {
                    let b64 = msg.payload.get("data").unwrap().as_str().unwrap();
                    let decoded = base64::engine::general_purpose::STANDARD
                        .decode(b64)
                        .unwrap();
                    if String::from_utf8_lossy(&decoded).contains("hello") {
                        got_hello = true;
                        break;
                    }
                }
            }
            _ => break,
        }
    }

    // Detach and clean up.
    let detach = ClientDetachPayload {
        session_name: session_name.to_string(),
    };
    let req = new_message(msg_types::CLIENT_DETACH, detach);
    let _: nession_agent::server::websocket::Message<serde_json::Value> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();

    tmux.kill_session(&session_name).await.ok();
    handle.shutdown().await.ok();

    assert!(got_hello, "expected terminal output containing 'hello'");
}

// ---------------------------------------------------------------------------
// Web UI compatibility handlers
// ---------------------------------------------------------------------------

use nession_agent::server::websocket::{
    WebAttachInfo, WebSessionCreatePayload, WebSessionCreateResponse, WebSessionKillPayload,
    WebSessionKillResponse, WebSessionsListResponse,
};

#[tokio::test]
async fn integration_web_ui_client_auth() {
    let (addr, handle) = start_server(19086).await.unwrap();
    let (mut sink, mut stream) = connect(addr).await.unwrap();

    let req = new_message(
        msg_types::CLIENT_AUTH,
        serde_json::json!({"auth_token":"tok"}),
    );
    let resp: nession_agent::server::websocket::Message<serde_json::Value> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);
    assert_eq!(resp.payload["status"], "success");

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_web_ui_sessions_list() {
    let (addr, handle) = start_server(19088).await.unwrap();
    let (mut sink, mut stream) = connect(addr).await.unwrap();

    let req = new_message(msg_types::CLIENT_SESSIONS_LIST, serde_json::json!({}));
    let resp: nession_agent::server::websocket::Message<WebSessionsListResponse> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_web_ui_session_create() {
    let (addr, handle) = start_server(19089).await.unwrap();
    let (mut sink, mut stream) = connect(addr).await.unwrap();

    let session = TestSession::new("web-create");
    let payload = WebSessionCreatePayload {
        agent_id: "local-agent".to_string(),
        name: session.name().to_string(),
        width: 80,
        height: 24,
    };
    let req = new_message(msg_types::CLIENT_SESSION_CREATE, payload);
    let resp: nession_agent::server::websocket::Message<WebSessionCreateResponse> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);
    assert!(resp.payload.success);
    // Extract the session name from the response for cleanup.
    let created_name = resp
        .payload
        .session_id
        .as_deref()
        .and_then(|sid| sid.split(':').nth(1))
        .unwrap_or("");
    assert!(!created_name.is_empty());

    // Clean up.
    let tmux = SessionManager::new();
    tmux.kill_session(created_name).await.ok();
    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_web_ui_session_kill() {
    let (addr, handle) = start_server(19090).await.unwrap();
    let (mut sink, mut stream) = connect(addr).await.unwrap();

    // Create a session first.
    let tmux = SessionManager::new();
    let session = TestSession::new("web-kill");
    let session_name = session.name().to_string();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    let payload = WebSessionKillPayload {
        session_id: format!("local-agent:{session_name}"),
    };
    let req = new_message(msg_types::CLIENT_SESSION_KILL, payload);
    let resp: nession_agent::server::websocket::Message<WebSessionKillResponse> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);
    assert!(resp.payload.success);

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_web_ui_session_attach() {
    let (addr, handle) = start_server(19091).await.unwrap();
    let (mut sink, mut stream) = connect(addr).await.unwrap();

    let payload = serde_json::json!({
        "session_id": "local-agent:webui_attach",
        "preferred_mode": "p2p"
    });
    let req = new_message(msg_types::CLIENT_SESSION_ATTACH, payload);
    let resp: nession_agent::server::websocket::Message<WebAttachInfo> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);
    assert_eq!(resp.payload.mode, "p2p");
    assert_eq!(resp.payload.session_name, "webui_attach");

    handle.shutdown().await.ok();
}

// ---------------------------------------------------------------------------
// Detach when not attached, resize when not attached
// ---------------------------------------------------------------------------

#[tokio::test]
async fn integration_detach_not_attached() {
    let (addr, handle) = start_server(19092).await.unwrap();
    let (mut sink, mut stream) = connect(addr).await.unwrap();

    let detach = ClientDetachPayload {
        session_name: "nonexistent".to_string(),
    };
    let req = new_message(msg_types::CLIENT_DETACH, detach);
    let resp: nession_agent::server::websocket::Message<serde_json::Value> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::ERROR);
    assert_eq!(resp.payload["code"], "not_attached");

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_terminal_input_not_attached() {
    let (addr, handle) = start_server(19093).await.unwrap();
    let (mut sink, mut stream) = connect(addr).await.unwrap();

    use base64::Engine;
    let input = base64::engine::general_purpose::STANDARD.encode(b"test");
    let payload = nession_agent::server::websocket::TerminalInputPayload {
        session_name: "ghost".to_string(),
        data: input,
    };
    let req = new_message(msg_types::TERMINAL_INPUT, payload);
    let resp: nession_agent::server::websocket::Message<serde_json::Value> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::ERROR);
    assert_eq!(resp.payload["code"], "not_attached");

    handle.shutdown().await.ok();
}

// ---------------------------------------------------------------------------
// The per-connection execution model (#961 stage A)
// ---------------------------------------------------------------------------
//
// **Characterization, not aspiration.** What is pinned here is what this tree
// does today, and the stage expected to change it is named with it.

/// The same server, with the directory its file sandbox is rooted in.
///
/// The root is the one thing a file-op test must be able to reach into, and
/// `AgentServer::new` canonicalizes it at construction — so the caller has to
/// keep the directory alive for as long as the server runs.
async fn start_server_with_file_root() -> anyhow::Result<(
    SocketAddr,
    nession_agent::server::ServerHandle,
    tempfile::TempDir,
)> {
    let root = tempfile::tempdir()?;
    let (_resize_tx, _resize_rx) = tokio::sync::mpsc::unbounded_channel::<(String, u16, u16)>();
    let server = AgentServer::new(
        "127.0.0.1:0",
        "test-agent",
        None,
        "/tmp".to_string(),
        root.path().to_string_lossy().as_ref(),
        AttachMode::Plain,
        _resize_tx,
    )?;
    let (handle, addr) = server.start().await?;
    Ok((addr, handle, root))
}

/// Create a FIFO. Not tmux, and not spawnable through anything else on this
/// platform without a crate: `mkfifo(1)` is the one tool that makes one.
fn make_fifo(path: &std::path::Path) -> anyhow::Result<()> {
    let status = std::process::Command::new("mkfifo").arg(path).status()?;
    anyhow::ensure!(status.success(), "mkfifo {path:?} failed");
    Ok(())
}

/// The next text frame within `window`, or `None` if none arrived.
async fn next_frame_within(
    stream: &mut WsStream,
    window: std::time::Duration,
) -> anyhow::Result<Option<serde_json::Value>> {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Ok(None);
        }
        match tokio::time::timeout(remaining, stream.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => return Ok(Some(serde_json::from_str(&text)?)),
            Ok(Some(Ok(_))) => {}
            _ => return Ok(None),
        }
    }
}

/// A file request that is still running holds the whole connection — the
/// control path included.
///
/// The slow request is a read of a FIFO, which is the one file operation whose
/// duration the test owns: `fs::read` opens it and then reads to end-of-file,
/// and end-of-file arrives only when the last writer closes. The writer here is
/// the *test*, opened `O_RDWR` before the request is even sent — opening a FIFO
/// for writing alone blocks until a reader appears, and `O_RDWR` does not — so
/// the read is parked until this test drops the handle, with no timing in the
/// arrangement at all.
///
/// The mechanism is `run_message_loop`: `handle_request(...).await` is awaited
/// inline, so the ping's frame is not even *read* while the file operation is
/// in flight. Nothing about the two relates them; they are serial because the
/// connection is.
///
/// **Flips at `#961-D`** (Agent P2P: no lock-across-await, then query
/// concurrency). The expected behaviour is that the ping is answered while the
/// read is still parked, so the first assertion — no frame at all before the
/// release — becomes "the pong arrives, and it is the pong" and the ordering
/// assertion below it becomes `["pong", "read"]`, with each reply still
/// carrying its own id.
#[cfg(unix)]
#[tokio::test]
async fn a_blocked_file_read_holds_the_peer_connection() {
    use std::time::Duration;

    let (addr, handle, root) = start_server_with_file_root().await.unwrap();
    let (mut sink, mut stream) = connect(addr).await.unwrap();

    let fifo = root.path().join("blocked.fifo");
    make_fifo(&fifo).unwrap();
    let writer = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&fifo)
        .expect("hold the fifo open for writing");

    // The slow request, then a control request behind it — written back to
    // back, with nothing waited on in between.
    let read = new_message(
        msg_types::FILE_READ,
        serde_json::json!({ "path": "blocked.fifo" }),
    );
    let ping = new_message(msg_types::CONTROL_PING, serde_json::json!({}));
    for request in [
        serde_json::to_value(&read).unwrap(),
        serde_json::to_value(&ping).unwrap(),
    ] {
        sink.send(WsMessage::Text(request.to_string()))
            .await
            .expect("send to the agent");
    }

    // Nothing answers while the read is parked: the ping has not been read yet,
    // and this connection carries no unsolicited traffic (nothing is attached
    // to it).
    let early = next_frame_within(&mut stream, Duration::from_millis(500))
        .await
        .unwrap();
    assert!(
        early.is_none(),
        "the control path answered while a file request was still running: {early:?}"
    );

    // Release the read: closing the last writer is its end-of-file.
    drop(writer);

    let answered_read = next_frame_within(&mut stream, Duration::from_secs(10))
        .await
        .unwrap()
        .expect("an answer to the file read");
    let answered_ping = next_frame_within(&mut stream, Duration::from_secs(10))
        .await
        .unwrap()
        .expect("an answer to the control ping");

    assert_eq!(answered_read["id"], serde_json::json!(read.id));
    assert_eq!(answered_ping["id"], serde_json::json!(ping.id));
    assert_eq!(
        answered_ping["msg_type"],
        serde_json::json!(msg_types::CONTROL_PONG),
        "the frame behind the read was answered, and it is the pong"
    );

    handle.shutdown().await.ok();
}
