//! Integration tests for the agent WebSocket server.
//!
//! These tests exercise the public API of [`AgentServer`] end-to-end:
//! bind, connect, send requests, and receive responses. They require a
//! working tmux installation (same as the tmux manager / pty tests).

use super::{
    browser_scope, connect, connect_all_sessions, connect_for, mint_credential,
    unique_session_name, TestSession, WsSink, WsStream, TEST_AGENT_ID, TEST_CREDENTIAL,
};
use futures_util::{SinkExt, StreamExt};
use nession_agent::config::AttachMode;
use nession_agent::p2p_credentials::P2pCredentials;
use nession_agent::server::websocket::{
    msg_types, new_message, AgentServer, AgentServerContext, ClientAttachPayload,
    ClientAttachResponse, ClientDetachPayload, ClientDetachResponse, OkPayload,
    SessionCreatePayload, SessionCreateResponse, SessionKillPayload, SessionKillResponse,
};
use nession_agent::tmux::manager::SessionManager;
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// Start a test server (OS picks a free port) and return the real bound
/// address + handle, together with the credential store its listener checks.
///
/// The store is returned rather than kept here because a credential bound to a
/// session's **name** can only be minted once the test has generated that name —
/// see [`connect_for`]. It is the same `Arc` the listener holds, so a grant made
/// after this returns is one the listener honours.
async fn start_server(
    _port: u16,
) -> anyhow::Result<(
    SocketAddr,
    nession_agent::server::ServerHandle,
    Arc<P2pCredentials>,
)> {
    let tmp = Box::leak(Box::new(tempfile::tempdir()?));
    let (resize, _resize_updates) = nession_agent::server::ResizeReporter::new();
    // Built, granted into, and only then handed to the listener — the store the
    // listener checks has to be the one the credential was granted into
    // ([`mint_credential`]).
    let credentials = Arc::new(P2pCredentials::new());
    mint_credential(
        &credentials,
        TEST_AGENT_ID,
        TEST_CREDENTIAL,
        browser_scope(),
    )?;
    let server = AgentServer::new(
        "127.0.0.1:0",
        TEST_AGENT_ID,
        None,
        "/tmp".to_string(),
        tmp.path().to_string_lossy().as_ref(),
        AttachMode::Plain,
        AgentServerContext {
            resize,
            credentials: Arc::clone(&credentials),
            mutations: nession_agent::execution::mutation_scheduler(),
        },
    )?;
    let (handle, addr) = server.start().await?;
    Ok((addr, handle, credentials))
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
    let (_, handle, _) = start_server(19081).await.unwrap();
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn integration_session_list() {
    let (addr, handle, credentials) = start_server(19082).await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

    let req = new_message(msg_types::SESSION_LIST, serde_json::json!({}));
    let resp: nession_agent::server::websocket::Message<serde_json::Value> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();

    assert_eq!(resp.msg_type, msg_types::OK);
    assert!(resp.payload.get("sessions").is_some());

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_session_create_and_kill() {
    let (addr, handle, credentials) = start_server(19083).await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

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

/// The user-visible half of #980: a snapshot sent over the wire reaches tmux.
///
/// The unit-level roundtrip in `tmux.rs` proves `env.rs` encodes
/// `set-environment` correctly; this proves the whole chain the user actually
/// exercises — `agent.session.create` → `apply_env_snapshots` → `EnvManager` →
/// tmux — and it is asserted against tmux rather than against the reply,
/// because the reply was the thing that lied. Before the fix this create
/// answered `ok` and tmux held nothing.
#[tokio::test]
async fn integration_session_create_env_snapshot_lands_in_tmux() {
    use std::time::Duration;

    let (addr, handle, credentials) = start_server(0).await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

    let session = TestSession::new("env-lands");
    let name = session.name().to_string();
    let create = new_message(
        msg_types::SESSION_CREATE,
        serde_json::json!({
            "name": name,
            "width": 80,
            "height": 24,
            "env_snapshots": [{
                "name": "snap",
                "source": "agent",
                "vars": [
                    ["NESSON_LANDS", "through-the-wire"],
                    ["NESSON_LANDS_SPACED", "a b  c"],
                ],
                "warnings": [],
            }],
        }),
    );
    sink.send(WsMessage::Text(
        serde_json::to_value(&create).unwrap().to_string(),
    ))
    .await
    .expect("send the create");

    let answered = answer_for(&mut stream, &create.id, Duration::from_secs(30))
        .await
        .expect("the create was never answered");
    assert_eq!(
        answered["msg_type"],
        serde_json::json!(msg_types::OK),
        "a create carrying a well-formed snapshot was not answered ok: {answered}"
    );

    assert_eq!(
        super::tmux_show_environment(&name, "NESSON_LANDS")
            .await
            .as_deref(),
        Some("through-the-wire"),
        "the create answered ok while tmux held nothing — the reply was believed \
         instead of the session"
    );
    assert_eq!(
        super::tmux_show_environment(&name, "NESSON_LANDS_SPACED")
            .await
            .as_deref(),
        Some("a b  c"),
        "the value was not passed to tmux as one argv value"
    );

    handle.shutdown().await.ok();
}

/// A required env mutation tmux refuses is an error reply, not a warning.
///
/// #980's second half, and the reason the first half survived: failures here
/// were a `Vec<String>` of warnings that every caller logged before answering
/// `ok`. A repair that only fixed the grammar would leave #980's real lesson
/// in place — the agent could still report a mutation it did not perform.
///
/// The variable is deliberately one tmux refuses *for its own sake*
/// (`variable name contains =`, exit 1 — measured on tmux 3.6b), so what is
/// under test is the propagation and not the grammar: this payload fails
/// whether `env.rs` encodes `set-environment` correctly or not, and the only
/// way it can answer `ok` is if a required failure was downgraded to a log
/// line. That is what it did before the fix.
#[tokio::test]
async fn a_refused_env_mutation_is_an_error_reply_not_a_warning() {
    use std::time::Duration;

    let (addr, handle, credentials) = start_server(0).await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

    let session = TestSession::new("env-refused");
    let create = new_message(
        msg_types::SESSION_CREATE,
        serde_json::json!({
            "name": session.name(),
            "width": 80,
            "height": 24,
            "env_snapshots": [{
                "name": "bad",
                "source": "agent",
                "vars": [["NESSON_BAD=NAME", "value"]],
                "warnings": [],
            }],
        }),
    );
    sink.send(WsMessage::Text(
        serde_json::to_value(&create).unwrap().to_string(),
    ))
    .await
    .expect("send the create");

    let answered = answer_for(&mut stream, &create.id, Duration::from_secs(30))
        .await
        .expect("the create was never answered");

    assert_eq!(
        answered["msg_type"],
        serde_json::json!(msg_types::ERROR),
        "a required env mutation the tmux layer refused was converted into protocol \
         success: {answered}"
    );
    assert_eq!(
        answered["payload"]["code"],
        serde_json::json!("env_apply_failed"),
        "the failure was reported as something other than the env mutation: {answered}"
    );
    // tmux's own words, which `stderr(Stdio::null())` used to discard — without
    // them the caller learns that something failed and nothing about what.
    assert!(
        answered["payload"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("contains =")),
        "the error does not retain tmux's diagnostic: {answered}"
    );

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_client_attach_creates_pty() {
    let (addr, handle, credentials) = start_server(19084).await.unwrap();

    let tmux = SessionManager::new();
    let session = TestSession::new("attach");
    let session_name = session.name().to_string();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    // The dial comes after the session does: the credential it presents is
    // bound to `session_name`, which is generated per run.
    let (mut sink, mut stream) = connect_for(&credentials, addr, &session_name)
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
    let (addr, handle, credentials) = start_server(19085).await.unwrap();

    let tmux = SessionManager::new();
    let session = TestSession::new("io");
    let session_name = session.name().to_string();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    // The dial comes after the session does: the credential it presents is
    // bound to `session_name`, which is generated per run.
    let (mut sink, mut stream) = connect_for(&credentials, addr, &session_name)
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
    let (addr, handle, credentials) = start_server(19086).await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

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
    let (addr, handle, credentials) = start_server(19088).await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

    let req = new_message(msg_types::CLIENT_SESSIONS_LIST, serde_json::json!({}));
    let resp: nession_agent::server::websocket::Message<WebSessionsListResponse> =
        round_trip(&mut sink, &mut stream, &req).await.unwrap();
    assert_eq!(resp.msg_type, msg_types::OK);

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_web_ui_session_create() {
    let (addr, handle, credentials) = start_server(19089).await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

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
    let (addr, handle, credentials) = start_server(19090).await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

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
    let (addr, handle, credentials) = start_server(19091).await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

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
    let (addr, handle, credentials) = start_server(19092).await.unwrap();
    let (mut sink, mut stream) = connect_for(&credentials, addr, "nonexistent")
        .await
        .unwrap();

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
    let (addr, handle, credentials) = start_server(19093).await.unwrap();
    let (mut sink, mut stream) = connect_for(&credentials, addr, "ghost").await.unwrap();

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
///
/// The credential store comes back with it, for the same reason
/// [`start_server`] returns one.
async fn start_server_with_file_root() -> anyhow::Result<(
    SocketAddr,
    nession_agent::server::ServerHandle,
    tempfile::TempDir,
    Arc<P2pCredentials>,
)> {
    let root = tempfile::tempdir()?;
    let (resize, _resize_updates) = nession_agent::server::ResizeReporter::new();
    let credentials = Arc::new(P2pCredentials::new());
    mint_credential(
        &credentials,
        TEST_AGENT_ID,
        TEST_CREDENTIAL,
        browser_scope(),
    )?;
    let server = AgentServer::new(
        "127.0.0.1:0",
        TEST_AGENT_ID,
        None,
        "/tmp".to_string(),
        root.path().to_string_lossy().as_ref(),
        AttachMode::Plain,
        AgentServerContext {
            resize,
            credentials: Arc::clone(&credentials),
            mutations: nession_agent::execution::mutation_scheduler(),
        },
    )?;
    let (handle, addr) = server.start().await?;
    Ok((addr, handle, root, credentials))
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

    let (addr, handle, root, credentials) = start_server_with_file_root().await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

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

// ---------------------------------------------------------------------------
// Mutation ordering across connections, and the coarse filesystem key
// (#961 review, findings 1 and 2)
// ---------------------------------------------------------------------------
//
// Three tests, and the arrangement they share is what makes them deterministic
// rather than lucky:
//
// * the park is always *inside the mutation's own key*, so what the second
//   mutation waits for is the ordering and not the backend;
// * the park is opened by a **handshake the test polls for** — an env variable
//   that has landed, a tree that has started to shrink — so "the first mutation
//   is running" is a fact before the second frame is written, and never two
//   sockets racing to be read first;
// * the second mutation's *own reply* is the witness. It cannot arrive while the
//   first holds the key, and the window it is given is several times shorter
//   than the park, so a correct implementation cannot answer it early and a
//   broken one cannot answer it late.

/// One `tmux set-environment` per variable, and the attach that carries them
/// parks inside its own session key for the length of that loop.
///
/// One `tmux` spawn per variable, measured at ~2.5 ms per spawn on the machine
/// this was written on, so 1 500 of them park the key for several seconds — more
/// than an order of magnitude past the window below. What the park needs is the
/// spawns; whether each one also lands is not what it measures, and the count is
/// unchanged either way. (When this was written every one of them failed — the
/// `-e` flag bug of #980, fixed since — which is why the original note here read
/// "the loop fails every call". The session exists, so they succeed now.)
///
/// The park is never waited out: the test that uses it ends the connection that
/// dispatched the work, which is what the queue behind it is released by.
const LONG_PARK_VARS: usize = 1_500;

/// How long a test watches for a reply that must not come.
///
/// Two orders of magnitude longer than the work of a mutation that was *not*
/// queued behind anything — the witness it serves is the absence of an answer
/// that a broken lane produces in well under a millisecond — and an order of
/// magnitude shorter than any park these tests arrange.
const WINDOW: std::time::Duration = std::time::Duration::from_millis(100);

/// An `agent.attach` whose env snapshots park its own key.
fn attach_with_long_park(session_name: &str) -> serde_json::Value {
    let vars: Vec<serde_json::Value> = (0..LONG_PARK_VARS)
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

// What sequences the two peers, and why it is the reader rather than tmux.
//
// The reader itself: it reads frames in order and *awaits* each admission, so a
// query written behind the attach on the first peer's own connection cannot be
// answered until the attach has reached the lane. That reply is the handshake,
// and it is causal — no clock is consulted, and neither socket is racing the
// other.
//
// A handshake read back out of tmux (`show-environment`) was impossible when
// this was written, and that is why it is the reader: `EnvManager::
// set_environment` spawned `set-environment -t <session> -e KEY=VALUE`, and
// `-e` is not a flag that subcommand takes, so no variable it set ever landed.
// That bug is #980 and it is fixed — `set_environment` now passes `name` and
// `value` as separate argv values, and `tests/integration/tmux.rs` reads a
// written variable back out of tmux to prove it. The reader-based handshake is
// kept as it is: it is causal, it does not depend on which of the two mechanisms
// happens to work, and re-sequencing a passing ordering test is not #980's.

/// Fail if the frame with `id` is answered within `window`.
async fn no_answer_within(
    stream: &mut WsStream,
    id: &str,
    window: std::time::Duration,
) -> anyhow::Result<()> {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Ok(());
        }
        match tokio::time::timeout(remaining, stream.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let parsed: serde_json::Value = serde_json::from_str(&text)?;
                anyhow::ensure!(
                    parsed.get("id").and_then(serde_json::Value::as_str) != Some(id),
                    "a mutation was answered while an earlier mutation of the same \
                     resource was still running: {parsed}"
                );
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => return Err(e.into()),
            Ok(None) => anyhow::bail!("connection closed while checking that {id} went unanswered"),
            Err(_) => return Ok(()),
        }
    }
}

/// The first answer to any of `ids`, whichever arrives — for a connection where
/// the *order* of two replies is the thing under test, and where asserting it
/// needs no clock: a lane that ordered the two would produce them in this order
/// and no lane that did not could.
async fn first_answer(
    stream: &mut WsStream,
    ids: &[&str],
    window: std::time::Duration,
) -> anyhow::Result<serde_json::Value> {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        anyhow::ensure!(
            !remaining.is_zero(),
            "none of {ids:?} was answered within {window:?}"
        );
        match tokio::time::timeout(remaining, stream.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let parsed: serde_json::Value = serde_json::from_str(&text)?;
                let id = parsed.get("id").and_then(serde_json::Value::as_str);
                if id.is_some_and(|id| ids.contains(&id)) {
                    return Ok(parsed);
                }
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => return Err(e.into()),
            Ok(None) => anyhow::bail!("connection closed while waiting for one of {ids:?}"),
            Err(_) => anyhow::bail!("none of {ids:?} was answered within {window:?}"),
        }
    }
}

/// The answer to `id`, or a failure naming what arrived instead.
async fn answer_for(
    stream: &mut WsStream,
    id: &str,
    window: std::time::Duration,
) -> anyhow::Result<serde_json::Value> {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        anyhow::ensure!(!remaining.is_zero(), "no answer to {id} within {window:?}");
        match tokio::time::timeout(remaining, stream.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let parsed: serde_json::Value = serde_json::from_str(&text)?;
                if parsed.get("id").and_then(serde_json::Value::as_str) == Some(id) {
                    return Ok(parsed);
                }
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => return Err(e.into()),
            Ok(None) => anyhow::bail!("connection closed while waiting for {id}"),
            Err(_) => anyhow::bail!("no answer to {id} within {window:?}"),
        }
    }
}

/// How many entries the delete park's tree holds.
///
/// The park is the delete's own duration, so its size is the test's clock.
/// Measured when this was written: removing 20 000 small files takes ~1.1 s on
/// the machine it was written on, so 30 000 is comfortably over a second — an
/// order of magnitude past the window above, and a slower machine moves the
/// margin the safe way.
///
const PARK_ENTRIES: usize = 30_000;

/// The same, for the test whose witness needs no window.
///
/// [`a_file_mutation_is_ordered_against_every_other_file_mutation`] asserts the
/// *order* of two replies on one stream rather than the absence of one within a
/// window, so its park only has to outlast a rename's own work — microseconds.
/// A smaller tree keeps that test cheap.
const SHORT_PARK_ENTRIES: usize = 4_000;

/// Build the tree a recursive delete parks on, and return its path.
///
/// Empty files, one `write` each. Hard links to one file were tried first and
/// measured *slower* to create (172 µs each against 70 µs on APFS), which is the
/// wrong way for a tree that exists to be built and then removed.
fn make_big_tree(
    root: &std::path::Path,
    name: &str,
    entries: usize,
) -> anyhow::Result<std::path::PathBuf> {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir)?;
    for i in 0..entries {
        std::fs::write(dir.join(format!("entry-{i}")), b"x")?;
    }
    Ok(dir)
}

/// Wait until the recursive delete has begun: entries have started to disappear.
///
/// The same handshake as the env park, for the same reason — the fact is about
/// the agent, and polling for it is what keeps the window below from being a race
/// between two connections.
async fn wait_for_delete_to_start(dir: &std::path::Path, entries: usize) -> anyhow::Result<()> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        anyhow::ensure!(
            tokio::time::Instant::now() < deadline,
            "the recursive delete never started: {} still has every entry",
            dir.display()
        );
        let remaining = std::fs::read_dir(dir).map(Iterator::count);
        match remaining {
            Ok(n) if n < entries => return Ok(()),
            // Gone entirely is the delete having *finished*, which is past the
            // point this can be observed from.
            Ok(_) => {}
            Err(e) => anyhow::bail!("the tree being deleted became unreadable: {e}"),
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
}

/// Two peers mutating one session are ordered against each other.
///
/// `#961`'s review, finding 1, on the socket it names second: two peer-to-peer
/// connections mutate one tmux session through two `ExecutionLanes` that used to
/// be two independent maps of queues and workers. What that ordered was `same
/// session + same connection`; what a browser attached to a session another
/// browser is also attached to needs is `same session`.
///
/// The first peer's `attach` is parked inside the session's own key by its env
/// snapshots ([`LONG_PARK_VARS`]), and the second peer's `terminal.input` — for
/// the same session name, on its own connection — must not be answered until
/// that attach is. The handshake is the first environment variable landing, so
/// the ordering is established before the second frame is even written.
#[tokio::test]
async fn two_peers_mutating_one_session_are_ordered() {
    use std::time::Duration;

    let (addr, handle, credentials) = start_server(0).await.unwrap();
    let tmux = SessionManager::new();
    let session = TestSession::new("peers");
    let name = session.name().to_string();
    tmux.create_session(&name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    // Both peers act on the same session, so both present a credential bound to
    // it — on their own connections, since one credential covers one session.
    let (mut sink_a, mut stream_a) = connect_for(&credentials, addr, &name).await.unwrap();
    let (mut sink_b, mut stream_b) = connect_for(&credentials, addr, &name).await.unwrap();

    let attach = new_message(msg_types::CLIENT_ATTACH, attach_with_long_park(&name));
    let probe = new_message(msg_types::SESSION_LIST, serde_json::json!({}));
    let input = new_message(msg_types::TERMINAL_INPUT, one_byte_input(&name));

    // The first peer's attach, and a query behind it on the same connection. The
    // reader dispatches in order and awaits the admission, so the query's reply
    // is proof that the attach is in the lane — see the note above for why the
    // handshake cannot come from tmux.
    for request in [
        serde_json::to_value(&attach).unwrap(),
        serde_json::to_value(&probe).unwrap(),
    ] {
        sink_a
            .send(WsMessage::Text(request.to_string()))
            .await
            .expect("send to the first peer");
    }
    let answered_probe = answer_for(&mut stream_a, &probe.id, Duration::from_secs(30))
        .await
        .expect("the first peer's query was never answered");
    assert_eq!(answered_probe["msg_type"], serde_json::json!(msg_types::OK));

    // The second peer, for the same session's key, on its own connection.
    sink_b
        .send(WsMessage::Text(
            serde_json::to_value(&input).unwrap().to_string(),
        ))
        .await
        .expect("send the terminal input");

    // It cannot be answered while the first peer's attach holds the key, and the
    // attach's park is seconds long against this window. A lane per connection
    // answers it in well under a millisecond — the arm is a map lookup — which
    // is what this asserts the absence of.
    no_answer_within(&mut stream_b, &input.id, WINDOW)
        .await
        .unwrap();

    // Then the first peer's connection ends, which ends the work it dispatched,
    // and the queue behind it moves: the second peer's input is admitted and
    // answered. The attach's own reply is deliberately never read — it is the
    // end of a park of several seconds, and this test does not wait for it.
    drop(sink_a);
    drop(stream_a);
    let answered_input = answer_for(&mut stream_b, &input.id, Duration::from_secs(30))
        .await
        .expect("the input was never answered once the attach it queued behind ended");
    assert_eq!(
        answered_input["payload"]["code"],
        serde_json::json!("not_attached"),
        "the input was answered with something other than the second peer's own \
         attachment state: {:?}",
        answered_input["payload"]
    );

    handle.shutdown().await.ok();
}

/// A rename cannot be overtaken by a file mutation read before it.
///
/// `#961`'s review, finding 2: `agent.file.rename` was keyed by `from` and
/// everything else by `path`, so `rename A -> B` and a mutation of `B` were two
/// keys — and even on one connection, where the reader dispatches in order, they
/// ran concurrently. What the key names now is the *filesystem*, one resource for
/// this agent, which is what makes a rename ordered against a write of its
/// destination and a recursive delete ordered against a write of a descendant.
///
/// The park is the delete of a large tree: a file mutation has no gate to hold
/// (the query tests' FIFO trick does not work here — `write_file` writes a temp
/// file and renames it, so a FIFO is replaced rather than blocked on), and a
/// recursive delete's duration is the test's to choose.
///
/// The order asserted is `delete` then `rename` then `write b.txt`, and the last
/// step is what makes the rename's own effect checkable: the write is dispatched
/// last, so a rename that had overtaken it would leave `b.txt` holding the
/// renamed content.
///
/// The witness for the first step needs no clock, and that is why this test is
/// the one that states the ordering rather than the window: both replies arrive
/// on *one* stream, and a rename that was ordered behind the delete it was read
/// behind cannot be answered first. A lane that keyed them by path answers the
/// rename in microseconds and hands this test the rename's answer, whatever the
/// delete takes.
#[tokio::test]
async fn a_file_mutation_is_ordered_against_every_other_file_mutation() {
    use std::time::Duration;

    let (addr, handle, root, credentials) = start_server_with_file_root().await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

    make_big_tree(root.path(), "big", SHORT_PARK_ENTRIES).unwrap();
    std::fs::write(root.path().join("a.txt"), b"renamed").unwrap();

    let delete = new_message(
        msg_types::FILE_DELETE,
        serde_json::json!({ "path": "big", "recursive": true }),
    );
    let rename = new_message(
        msg_types::FILE_RENAME,
        serde_json::json!({ "from": "a.txt", "to": "b.txt" }),
    );
    for request in [
        serde_json::to_value(&delete).unwrap(),
        serde_json::to_value(&rename).unwrap(),
    ] {
        sink.send(WsMessage::Text(request.to_string()))
            .await
            .expect("send to the agent");
    }

    let first = first_answer(
        &mut stream,
        &[&delete.id, &rename.id],
        Duration::from_secs(60),
    )
    .await
    .expect("neither file mutation was answered");
    assert_eq!(
        first["id"],
        serde_json::json!(delete.id),
        "the rename was answered while the delete it was read behind was still running: \
         the two are one resource, so this is a key that is not the filesystem's"
    );
    let answered_delete = first;
    assert_eq!(
        answered_delete["msg_type"],
        serde_json::json!(msg_types::OK),
        "the delete failed: {:?}",
        answered_delete["payload"]
    );
    let answered_rename = answer_for(&mut stream, &rename.id, Duration::from_secs(30))
        .await
        .expect("the rename was never answered");
    assert_eq!(
        answered_rename["msg_type"],
        serde_json::json!(msg_types::OK),
        "the rename failed: {:?}",
        answered_rename["payload"]
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("b.txt")).unwrap(),
        "renamed"
    );
    assert!(
        !root.path().join("a.txt").exists(),
        "the rename left its source behind"
    );

    // And the other direction: the write was dispatched last, so its content is
    // what `b.txt` ends up holding.
    let write = new_message(
        msg_types::FILE_WRITE,
        serde_json::json!({ "path": "b.txt", "content": write_content("written") }),
    );
    sink.send(WsMessage::Text(
        serde_json::to_value(&write).unwrap().to_string(),
    ))
    .await
    .expect("send the write");
    let answered_write = answer_for(&mut stream, &write.id, Duration::from_secs(30))
        .await
        .expect("the write was never answered");
    assert_eq!(answered_write["msg_type"], serde_json::json!(msg_types::OK));
    assert_eq!(
        std::fs::read_to_string(root.path().join("b.txt")).unwrap(),
        "written",
        "a write dispatched after the rename was applied before it"
    );

    handle.shutdown().await.ok();
}

/// Base64 content for a `file.write`.
fn write_content(text: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(text.as_bytes())
}

/// Two peers mutating one file are ordered against each other.
///
/// Finding 1 again, for the filesystem: two connections, one resource, and a
/// *descendant* of the path the first peer is removing — the case finding 2
/// names, where an exact-path key cannot express that the second mutation is
/// inside the first one's scope.
///
/// The handshake is the tree starting to shrink, and it is what makes this a
/// statement about the shared key rather than about which connection's reader
/// happened to run first.
#[tokio::test]
async fn two_peers_mutating_one_file_are_ordered() {
    use std::time::Duration;

    let (addr, handle, root, credentials) = start_server_with_file_root().await.unwrap();
    let (mut sink_a, mut stream_a) = connect(&credentials, addr).await.unwrap();
    let (mut sink_b, mut stream_b) = connect(&credentials, addr).await.unwrap();

    let big = make_big_tree(root.path(), "big", PARK_ENTRIES).unwrap();

    let delete = new_message(
        msg_types::FILE_DELETE,
        serde_json::json!({ "path": "big", "recursive": true }),
    );
    let write = new_message(
        msg_types::FILE_WRITE,
        serde_json::json!({ "path": "big/inside.txt", "content": write_content("written") }),
    );

    let sent = std::time::Instant::now();
    sink_a
        .send(WsMessage::Text(
            serde_json::to_value(&delete).unwrap().to_string(),
        ))
        .await
        .expect("send the delete");
    wait_for_delete_to_start(&big, PARK_ENTRIES)
        .await
        .expect("the delete never started");

    sink_b
        .send(WsMessage::Text(
            serde_json::to_value(&write).unwrap().to_string(),
        ))
        .await
        .expect("send the write");

    // A write into a tree that is being removed: with one key for the sandbox it
    // is queued behind the delete, and with a key per path it is a different
    // resource and runs straight into the removal.
    no_answer_within(&mut stream_b, &write.id, WINDOW)
        .await
        .unwrap();

    let answered_delete = answer_for(&mut stream_a, &delete.id, Duration::from_secs(60))
        .await
        .expect("the delete was never answered");
    // The window above is only an assertion if the park outlasts it, so the park
    // is measured rather than assumed: the second peer's frame was written once
    // the handshake showed the delete had begun, and this is the park that frame
    // was queued behind.
    let parked = sent.elapsed();
    assert!(
        parked > WINDOW,
        "the delete held its key for {parked:?}, which is not longer than the {WINDOW:?} \
         window the ordering above was asserted over"
    );
    assert_eq!(
        answered_delete["msg_type"],
        serde_json::json!(msg_types::OK)
    );
    let answered_write = answer_for(&mut stream_b, &write.id, Duration::from_secs(60))
        .await
        .expect("the write was never answered");
    assert_eq!(
        answered_write["msg_type"],
        serde_json::json!(msg_types::OK),
        "the write failed: {:?}",
        answered_write["payload"]
    );

    // Applied in that order: the write recreated the directory the delete had
    // removed, so the file is there and it is the second mutation's content.
    assert_eq!(
        std::fs::read_to_string(root.path().join("big/inside.txt")).unwrap(),
        "written"
    );

    handle.shutdown().await.ok();
}

/// A peer naming many distinct sessions gets a worker for a bounded number of
/// them.
///
/// `#961`'s review, finding 3, on the socket it names first: `ExecutionLanes`
/// was built with the no-budget constructor, so a peer naming a thousand sessions
/// had a thousand keys, a thousand queues and a thousand workers — each one
/// inside its own depth. The bound tests repeat work for one key; this is the
/// flood.
///
/// Each create parks inside its own key on [`LONG_PARK_VARS`] environment
/// variables *after* creating its session, so a session that exists in tmux is a
/// mutation that was admitted — which is what the count below reads. The flood
/// is larger than the bound, so a runtime without one shows every session.
#[tokio::test]
async fn a_peer_naming_many_sessions_gets_workers_for_a_bounded_number_of_them() {
    use std::time::Duration;

    const FLOOD: usize = 48;
    const PARK_VARS: usize = 400;

    let (addr, handle, credentials) = start_server(0).await.unwrap();
    let (mut sink, _stream) = connect(&credentials, addr).await.unwrap();
    let tmux = SessionManager::new();
    let prefix = unique_session_name("flood");

    let vars: Vec<serde_json::Value> = (0..PARK_VARS)
        .map(|i| serde_json::json!([format!("NESSION_FLOOD_{i}"), "1"]))
        .collect();
    for n in 0..FLOOD {
        let create = new_message(
            msg_types::SESSION_CREATE,
            serde_json::json!({
                "name": format!("{prefix}-{n}"),
                "width": 80,
                "height": 24,
                "env_snapshots": [{
                    "name": "park",
                    "source": "agent",
                    "vars": vars,
                    "warnings": [],
                }],
            }),
        );
        sink.send(WsMessage::Text(
            serde_json::to_value(&create).unwrap().to_string(),
        ))
        .await
        .expect("send the create");
    }

    // Long enough for every admitted mutation to have created its session (the
    // create comes first, the park second) and far shorter than the park, so the
    // count below is the bound rather than the rate.
    tokio::time::sleep(Duration::from_millis(500)).await;

    let bound = nession_agent::server::execution::DEFAULT_MUTATIONS_IN_FLIGHT;
    let created = tmux
        .list_sessions()
        .await
        .expect("list the flood's sessions")
        .into_iter()
        .filter(|session| session.name.starts_with(&prefix))
        .count();

    assert!(
        created < FLOOD,
        "a peer naming {FLOOD} distinct sessions had a worker for every one of them: the \
         tasks in flight track the number of keys, which is the unbounded unique-key \
         growth this bound exists for"
    );
    assert!(
        created <= bound,
        "the flood was admitted for {created} sessions, past this connection's bound of \
         {bound}"
    );
    assert!(
        created > 0,
        "not one of the flood's sessions was created: nothing was measured"
    );

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

    let (addr, handle, root, credentials) = start_server_with_file_root().await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

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

    let (addr, handle, root, credentials) = start_server_with_file_root().await.unwrap();
    let (mut sink, mut stream) = connect(&credentials, addr).await.unwrap();

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

    let (addr, handle, credentials) = start_server(0).await.unwrap();
    let tmux = SessionManager::new();
    let session = TestSession::new("ordered");
    let session_name = session.name().to_string();
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    let (mut sink, mut stream) = connect_for(&credentials, addr, &session_name)
        .await
        .unwrap();
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

    let (addr, handle, credentials) = start_server(0).await.unwrap();
    let tmux = SessionManager::new();
    let slow = TestSession::new("keyslow");
    let slow_name = slow.name().to_string();
    tmux.create_session(&slow_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    // One connection naming **two** sessions, which no browser-shaped credential
    // can present: its terminal binding holds one name and the scope gate
    // compares names (#1013). The credential that can is the node-wide one —
    // `CredentialScope::for_standalone`, the shape an agent with no Server
    // honours — and using it here is what lets this test keep asserting the
    // per-key lanes rather than what it can reach. Every other dial in this file
    // is session-bound ([`connect_for`]).
    let (mut sink, mut stream) = connect_all_sessions(&credentials, addr).await.unwrap();
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
