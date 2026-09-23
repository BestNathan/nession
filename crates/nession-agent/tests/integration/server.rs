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
    let (resize, _resize_updates) = nession_agent::server::ResizeReporter::new();
    let server = AgentServer::new(
        "127.0.0.1:0",
        "test-agent",
        None,
        "/tmp".to_string(),
        tmp.path().to_string_lossy().as_ref(),
        AttachMode::Plain,
        resize,
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
    let (resize, _resize_updates) = nession_agent::server::ResizeReporter::new();
    let server = AgentServer::new(
        "127.0.0.1:0",
        "test-agent",
        None,
        "/tmp".to_string(),
        root.path().to_string_lossy().as_ref(),
        AttachMode::Plain,
        resize,
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

/// Release a read that is parked on a FIFO **that has never had a writer**.
///
/// The park is `open`: `fs::read` opens the FIFO for reading, and with no writer
/// anywhere that open blocks — before the read, before anything. The release is
/// the writer arriving and leaving: opening for writing unblocks the reader (the
/// two rendezvous in the kernel), and closing is its end-of-file.
///
/// This is the arrangement to reach for when a test has to release two parks
/// independently, and the reason is the rendezvous. Holding a writer open from
/// the start and closing it to release — what the single-park test above does —
/// has a window the test cannot close: if the writer is closed before the
/// reader's `open` has happened, that open blocks forever, and the failure
/// arrives as a hung test binary rather than as a failed assertion. I hit
/// exactly that writing the two-park test below. Here the writer's open *cannot
/// complete* until a reader is present, so there is no such window.
///
/// A thread, not an `await`: the writer's open blocks until the reader is there,
/// and that wait belongs to neither the test's task nor the runtime's blocking
/// pool. If the reader never comes the thread stays parked and the process exits
/// without it — whereas a blocking-pool task in the same state would hold the
/// runtime's own shutdown open and turn a failing test into a hanging one.
fn release_parked_fifo(path: std::path::PathBuf) {
    std::thread::spawn(move || {
        // `File::create` is the blocking open; the guard closes on return.
        let _ = std::fs::File::create(path);
    });
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

/// A file request that is still running no longer holds the connection.
///
/// The slow request is a read of a FIFO, which is the one file operation whose
/// duration the test owns: `fs::read` opens it and then reads to end-of-file,
/// and end-of-file arrives only when the last writer closes. The writer here is
/// the *test*, opened `O_RDWR` before the request is even sent — opening a FIFO
/// for writing alone blocks until a reader appears, and `O_RDWR` does not — so
/// the read is parked until this test drops the handle, with no timing in the
/// arrangement at all.
///
/// This test used to pin the opposite, under the name
/// `a_blocked_file_read_holds_the_peer_connection`: the reader awaited
/// `handle_request(..)` inline, so the ping's frame was not even *read* while
/// the file operation was in flight, and the first assertion was that no frame
/// arrived at all before the release. `#961-D` moved `agent.file.read` onto the
/// query lane and the control path into the reader, so what is asserted now is
/// the two halves of that change:
///
/// * the ping is answered while the read is still parked — the reader is not
///   waiting for the query it admitted;
/// * the read's own reply is *not* sent early. It is parked on the FIFO, and
///   that is what makes the first assertion a statement about the read rather
///   than about the ping: an implementation that answered the ping by
///   *cancelling* or *failing* the read would pass the first half and fail
///   here.
///
/// Each reply still carries its own `id`, which is the protocol's answer to
/// "which reply is which" — this test no longer depends on their arrival order
/// for correlation, only for the one thing ordering still means here: the read
/// was still in flight when the pong was written.
#[cfg(unix)]
#[tokio::test]
async fn a_blocked_file_read_no_longer_holds_the_peer_connection() {
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

    let answered_ping = next_frame_within(&mut stream, Duration::from_secs(10))
        .await
        .unwrap()
        .expect("the control path answered while a file request was still running");
    assert_eq!(answered_ping["id"], serde_json::json!(ping.id));
    assert_eq!(
        answered_ping["msg_type"],
        serde_json::json!(msg_types::CONTROL_PONG),
        "the frame behind the read was answered, and it is the pong"
    );

    // The read is still parked, so nothing else can have been written. This is
    // a negative assertion, and it is the one that would catch "concurrency"
    // bought by answering a request the agent has not finished: the FIFO has
    // no end-of-file until the writer below is dropped, and there is no other
    // frame this connection could be carrying (nothing is attached to it).
    let early = next_frame_within(&mut stream, Duration::from_millis(300))
        .await
        .unwrap();
    assert!(
        early.is_none(),
        "the parked read answered before its file did: {early:?}"
    );

    // Release the read: closing the last writer is its end-of-file.
    drop(writer);

    let answered_read = next_frame_within(&mut stream, Duration::from_secs(10))
        .await
        .unwrap()
        .expect("an answer to the file read");
    assert_eq!(answered_read["id"], serde_json::json!(read.id));
    assert_eq!(answered_read["msg_type"], serde_json::json!(msg_types::OK));

    handle.shutdown().await.ok();
}

/// Two parked queries overlap: the second finishes while the first is still
/// running.
///
/// The witness is causal rather than temporal. Query B's reply can only be
/// written after B's FIFO is released, and A's is released after that — so an
/// implementation that ran B behind A (the reader awaiting each handler, or one
/// worker for the whole lane) could not produce B's reply at all, and this test
/// fails on the first assertion rather than on a stopwatch. Both FIFOs are
/// parked the race-free way: neither has a writer until the test releases it
/// (see [`release_parked_fifo`]).
#[cfg(unix)]
#[tokio::test]
async fn independent_queries_overlap_execution() {
    use std::time::Duration;

    let (addr, handle, root) = start_server_with_file_root().await.unwrap();
    let (mut sink, mut stream) = connect(addr).await.unwrap();

    for name in ["first.fifo", "second.fifo"] {
        make_fifo(&root.path().join(name)).unwrap();
    }

    let first = new_message(
        msg_types::FILE_READ,
        serde_json::json!({ "path": "first.fifo" }),
    );
    let second = new_message(
        msg_types::FILE_READ,
        serde_json::json!({ "path": "second.fifo" }),
    );
    for request in [
        serde_json::to_value(&first).unwrap(),
        serde_json::to_value(&second).unwrap(),
    ] {
        sink.send(WsMessage::Text(request.to_string()))
            .await
            .expect("send to the agent");
    }

    // Release only the second, and read: the reply that arrives now can only
    // be its, because the first read is parked on a FIFO with no writer.
    //
    // The first is released *before* the assertions below, and that ordering is
    // deliberate: it keeps this test's failure mode a failure. A read left
    // parked at the end of a test parks a `spawn_blocking` task, and the
    // runtime's own shutdown waits for it — so a run that never answered would
    // hang the test binary instead of reporting. (It did, before this.)
    release_parked_fifo(root.path().join("second.fifo"));
    let answered = next_frame_within(&mut stream, Duration::from_secs(10))
        .await
        .unwrap();
    release_parked_fifo(root.path().join("first.fifo"));

    let answered = answered.expect("the second query never ran while the first was parked");
    assert_eq!(
        answered["id"],
        serde_json::json!(second.id),
        "the frame that arrived is not the second query's answer"
    );

    let answered_first = next_frame_within(&mut stream, Duration::from_secs(30))
        .await
        .unwrap()
        .expect("an answer to the first file read");
    assert_eq!(answered_first["id"], serde_json::json!(first.id));

    handle.shutdown().await.ok();
}

/// An identity transition is applied after everything read before it.
///
/// `client.auth` is this socket's one `Ordered` frame — it establishes the
/// connection's identity, and a frame written after it is entitled to be served
/// by that identity rather than by whatever the connection was before. The
/// barrier is what makes that true on a connection that is no longer serial, and
/// it is what this asserts: the auth's reply cannot be written while a query
/// read before it is still in flight.
///
/// The parked query is a FIFO read, so the window is the test's to close. Both
/// orderings are asserted: nothing answers for as long as the read is parked,
/// and then the read's reply comes before the auth's.
#[cfg(unix)]
#[tokio::test]
async fn an_identity_transition_waits_for_the_frames_read_before_it() {
    use std::time::Duration;

    let (addr, handle, root) = start_server_with_file_root().await.unwrap();
    let (mut sink, mut stream) = connect(addr).await.unwrap();

    make_fifo(&root.path().join("auth.fifo")).unwrap();
    let read = new_message(
        msg_types::FILE_READ,
        serde_json::json!({ "path": "auth.fifo" }),
    );
    let auth = new_message(
        msg_types::CLIENT_AUTH,
        serde_json::json!({ "auth_token": "tok" }),
    );
    for request in [
        serde_json::to_value(&read).unwrap(),
        serde_json::to_value(&auth).unwrap(),
    ] {
        sink.send(WsMessage::Text(request.to_string()))
            .await
            .expect("send to the agent");
    }

    // The query is parked, and the auth is behind the barrier that waits for it.
    let early = next_frame_within(&mut stream, Duration::from_millis(300))
        .await
        .unwrap();
    // Released before the assertion, as in the overlap test: a read left parked
    // when a test panics parks a `spawn_blocking` task, and the runtime's own
    // shutdown waits for it — so the failure would be a hung test binary instead
    // of a reported one. (It was, when this assertion came first.)
    release_parked_fifo(root.path().join("auth.fifo"));
    assert!(
        early.is_none(),
        "the identity transition was applied while a frame read before it was \
         still running: {early:?}"
    );

    let answered_read = next_frame_within(&mut stream, Duration::from_secs(10))
        .await
        .unwrap()
        .expect("an answer to the file read");
    assert_eq!(answered_read["id"], serde_json::json!(read.id));

    let answered_auth = next_frame_within(&mut stream, Duration::from_secs(10))
        .await
        .unwrap()
        .expect("an answer to the auth");
    assert_eq!(answered_auth["id"], serde_json::json!(auth.id));
    assert_eq!(
        answered_auth["payload"]["status"],
        serde_json::json!("success")
    );

    handle.shutdown().await.ok();
}

/// How many environment variables the ordering tests' attach applies before it
/// registers the session.
///
/// Each one is a `tmux set-environment` subprocess, and the loop that runs them
/// is inside the attach *arm* — so this is a park inside the attach's own
/// resource key, not a pause in front of it. The frame these tests read behind
/// that attach is answered in microseconds (a map lookup), so the window is
/// three orders of magnitude wide rather than a scheduling accident.
///
/// It is a park and not an assertion: what the tests assert is which reply
/// carries which `id`, and a reply's `id` does not depend on how long its
/// predecessor took. This only decides how wide the window is that the ordering
/// is observed across.
const ORDERING_PARK_VARS: usize = 20;

/// An `agent.attach` payload whose arm will be slow, for the ordering tests.
///
/// Built as JSON rather than as `ClientAttachPayload` because the env snapshots
/// are the point and `EnvSnapshot` carries a `source` discriminant that this
/// test has no opinion about; the wire is the contract, and it is what the
/// agent parses.
fn attach_parked(session_name: &str) -> serde_json::Value {
    let vars: Vec<serde_json::Value> = (0..ORDERING_PARK_VARS)
        .map(|i| serde_json::json!([format!("NESSION_PARK_{i}"), "1"]))
        .collect();
    serde_json::json!({
        "session_name": session_name,
        "width": 80,
        "height": 24,
        "env_snapshots": [{
            "name": "park",
            "source": "agent",
            "vars": vars,
            "warnings": [],
        }],
    })
}

/// A `terminal.input` payload carrying one byte.
fn one_byte_input(session_name: &str) -> serde_json::Value {
    use base64::Engine;
    serde_json::json!({
        "session_name": session_name,
        "data": base64::engine::general_purpose::STANDARD.encode(b"x"),
    })
}

/// Frames for one session are applied in the order they were read, even when
/// the earlier one is slow.
///
/// The witness is the second frame's *answer*: `terminal.input` on a session
/// whose attach has not finished can only be `not_attached`, so an `ok` is
/// possible only if the attach was applied first. The attach is held inside its
/// own arm for the length of [`ORDERING_PARK_VARS`] subprocess spawns, which is
/// what makes the losing side of an unordered dispatch lose every time rather
/// than most of the time.
#[cfg(unix)]
#[tokio::test]
async fn a_sessions_frames_are_applied_in_order() {
    use std::time::Duration;

    let (addr, handle) = start_server(0).await.unwrap();
    let tmux = SessionManager::new();
    let session = TestSession::new("ordered");
    let session_name = session.name().to_string();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    let (mut sink, mut stream) = connect(addr).await.unwrap();
    let attach = new_message(msg_types::CLIENT_ATTACH, attach_parked(&session_name));
    let input = new_message(msg_types::TERMINAL_INPUT, one_byte_input(&session_name));
    for request in [
        serde_json::to_value(&attach).unwrap(),
        serde_json::to_value(&input).unwrap(),
    ] {
        sink.send(WsMessage::Text(request.to_string()))
            .await
            .expect("send to the agent");
    }

    let answered_attach = next_frame_within(&mut stream, Duration::from_secs(30))
        .await
        .unwrap()
        .expect("an answer to the attach");
    assert_eq!(
        answered_attach["id"],
        serde_json::json!(attach.id),
        "the input was answered before the attach it was read behind"
    );

    let answered_input = next_frame_within(&mut stream, Duration::from_secs(30))
        .await
        .unwrap()
        .expect("an answer to the terminal input");
    assert_eq!(answered_input["id"], serde_json::json!(input.id));
    assert_eq!(
        answered_input["msg_type"],
        serde_json::json!(msg_types::OK),
        "the input was applied before the attach that creates the attachment: \
         {:?}",
        answered_input["payload"]
    );

    handle.shutdown().await.ok();
}

/// A slow mutation of one session does not delay another session's frames.
///
/// Session A's attach is parked inside its own arm; session B's input is
/// answered immediately — `not_attached`, since B has nothing attached. The
/// assertion is the *order* of the two replies, which is the whole of "per
/// resource key": B's work is not queued behind A's, because A's key is not
/// B's. A lane with one queue for every session answers A first, every time.
#[cfg(unix)]
#[tokio::test]
async fn a_slow_sessions_mutation_does_not_delay_another_sessions_frame() {
    use std::time::Duration;

    let (addr, handle) = start_server(0).await.unwrap();
    let tmux = SessionManager::new();
    let slow = TestSession::new("keyslow");
    let slow_name = slow.name().to_string();
    tmux.create_session(&slow_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    let (mut sink, mut stream) = connect(addr).await.unwrap();
    let attach = new_message(msg_types::CLIENT_ATTACH, attach_parked(&slow_name));
    // A session that is attached to nothing: its `not_attached` is built from
    // the map alone, so it answers as soon as the reader hands it over.
    let other_input = new_message(
        msg_types::TERMINAL_INPUT,
        one_byte_input("nession-test-keyslow-other"),
    );
    for request in [
        serde_json::to_value(&attach).unwrap(),
        serde_json::to_value(&other_input).unwrap(),
    ] {
        sink.send(WsMessage::Text(request.to_string()))
            .await
            .expect("send to the agent");
    }

    let first = next_frame_within(&mut stream, Duration::from_secs(30))
        .await
        .unwrap()
        .expect("an answer to the second session's input");
    assert_eq!(
        first["id"],
        serde_json::json!(other_input.id),
        "the other session's frame waited on this session's attach"
    );
    assert_eq!(first["payload"]["code"], serde_json::json!("not_attached"));

    let second = next_frame_within(&mut stream, Duration::from_secs(30))
        .await
        .unwrap()
        .expect("an answer to the attach");
    assert_eq!(second["id"], serde_json::json!(attach.id));

    handle.shutdown().await.ok();
}
