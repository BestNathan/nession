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
async fn start_server(_port: u16) -> (SocketAddr, nession_agent::server::ServerHandle) {
    let tmp = Box::leak(Box::new(tempfile::tempdir().expect("tempdir")));
    let (_resize_tx, _resize_rx) = tokio::sync::mpsc::unbounded_channel::<(String, u16, u16)>();
    let server = AgentServer::new(
        "127.0.0.1:0",
        "test-agent",
        None,
        "/tmp".to_string(),
        tmp.path().to_string_lossy().as_ref(),
        AttachMode::Plain,
        _resize_tx,
    )
    .expect("server creation should succeed");
    let (handle, addr) = server.start().await.expect("start should succeed");
    (addr, handle)
}

/// Connect a WebSocket client and return the split sink / stream.
type WsSink = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    WsMessage,
>;
type WsStream = futures_util::stream::SplitStream<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
>;

async fn connect(addr: SocketAddr) -> (WsSink, WsStream) {
    let url = format!("ws://{}", addr);
    let (ws, _resp) = connect_async(&url).await.expect("connect should succeed");
    ws.split()
}

/// Send a request and receive the next text response, deserialised.
async fn round_trip<Req: Serialize, Resp: serde::de::DeserializeOwned>(
    sink: &mut WsSink,
    stream: &mut WsStream,
    req: &nession_agent::server::websocket::Message<Req>,
) -> nession_agent::server::websocket::Message<Resp> {
    let json = serde_json::to_string(req).unwrap();
    let request_id = req.id.clone();
    sink.send(WsMessage::Text(json)).await.unwrap();
    loop {
        match stream.next().await.unwrap().unwrap() {
            WsMessage::Text(text) => {
                // Parse as raw value to check the request id - skip
                // unsolicited messages like terminal.output from
                // background tasks.
                let raw: serde_json::Value = serde_json::from_str(&text).unwrap();
                if raw.get("id").and_then(|v| v.as_str()) == Some(&request_id) {
                    return serde_json::from_value(raw).unwrap();
                }
            }
            _ => continue,
        }
    }
}

#[tokio::test]
async fn integration_server_startup() {
    // Verify that the server binds, starts, and can be cleanly shut down.
    let (_, handle) = start_server(19081).await;
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn integration_session_list() {
    let (addr, handle) = start_server(19082).await;
    let (mut sink, mut stream) = connect(addr).await;

    let req = new_message(msg_types::SESSION_LIST, serde_json::json!({}));
    let resp: nession_agent::server::websocket::Message<serde_json::Value> =
        round_trip(&mut sink, &mut stream, &req).await;

    assert_eq!(resp.msg_type, msg_types::OK);
    assert!(resp.payload.get("sessions").is_some());

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_session_create_and_kill() {
    let (addr, handle) = start_server(19083).await;
    let (mut sink, mut stream) = connect(addr).await;

    let session = TestSession::new("create-kill");
    let session_name = session.name().to_string();
    let create = SessionCreatePayload {
        name: session_name.to_string(),
        width: 80,
        height: 24,
    };
    let req = new_message(msg_types::SESSION_CREATE, create);
    let resp: nession_agent::server::websocket::Message<SessionCreateResponse> =
        round_trip(&mut sink, &mut stream, &req).await;
    assert_eq!(resp.msg_type, msg_types::OK);
    assert_eq!(resp.payload.name, session_name);

    let kill = SessionKillPayload {
        name: session_name.to_string(),
    };
    let req = new_message(msg_types::SESSION_KILL, kill);
    let resp: nession_agent::server::websocket::Message<SessionKillResponse> =
        round_trip(&mut sink, &mut stream, &req).await;
    assert_eq!(resp.msg_type, msg_types::OK);
    assert_eq!(resp.payload.name, session_name);

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_client_attach_creates_pty() {
    let (addr, handle) = start_server(19084).await;
    let (mut sink, mut stream) = connect(addr).await;

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
        round_trip(&mut sink, &mut stream, &req).await;
    assert_eq!(resp.msg_type, msg_types::OK);
    assert_eq!(resp.payload.session_name, session_name);

    // Detach.
    let detach = ClientDetachPayload {
        session_name: session_name.to_string(),
    };
    let req = new_message(msg_types::CLIENT_DETACH, detach);
    let resp: nession_agent::server::websocket::Message<ClientDetachResponse> =
        round_trip(&mut sink, &mut stream, &req).await;
    assert_eq!(resp.msg_type, msg_types::OK);
    assert_eq!(resp.payload.session_name, session_name);

    tmux.kill_session(&session_name).await.ok();
    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_terminal_io_flow() {
    let (addr, handle) = start_server(19085).await;
    let (mut sink, mut stream) = connect(addr).await;

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
        round_trip(&mut sink, &mut stream, &req).await;

    // Send terminal input immediately — post-attach sleep breaks macOS PTY writes.
    use base64::Engine;
    let input = base64::engine::general_purpose::STANDARD.encode(b"echo hello\n");
    let payload = nession_agent::server::websocket::TerminalInputPayload {
        session_name: session_name.to_string(),
        data: input,
    };
    let req = new_message(msg_types::TERMINAL_INPUT, payload);
    let resp: nession_agent::server::websocket::Message<OkPayload> =
        round_trip(&mut sink, &mut stream, &req).await;
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
        round_trip(&mut sink, &mut stream, &req).await;

    tmux.kill_session(&session_name).await.ok();
    handle.shutdown().await.ok();

    assert!(got_hello, "expected terminal output containing 'hello'");
}

// ---------------------------------------------------------------------------
// Web UI compatibility handlers
// ---------------------------------------------------------------------------

use nession_agent::server::websocket::{
    WebAgentsListResponse, WebAttachInfo, WebSessionCreatePayload, WebSessionCreateResponse,
    WebSessionKillPayload, WebSessionKillResponse, WebSessionsListResponse,
};

#[tokio::test]
async fn integration_web_ui_client_auth() {
    let (addr, handle) = start_server(19086).await;
    let (mut sink, mut stream) = connect(addr).await;

    let req = new_message(
        msg_types::CLIENT_AUTH,
        serde_json::json!({"auth_token":"tok"}),
    );
    let resp: nession_agent::server::websocket::Message<serde_json::Value> =
        round_trip(&mut sink, &mut stream, &req).await;
    assert_eq!(resp.msg_type, msg_types::OK);
    assert_eq!(resp.payload["status"], "success");

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_web_ui_agents_list() {
    let (addr, handle) = start_server(19087).await;
    let (mut sink, mut stream) = connect(addr).await;

    let req = new_message(msg_types::CLIENT_AGENTS_LIST, serde_json::json!({}));
    let resp: nession_agent::server::websocket::Message<WebAgentsListResponse> =
        round_trip(&mut sink, &mut stream, &req).await;
    assert_eq!(resp.msg_type, msg_types::OK);
    assert!(!resp.payload.agents.is_empty());
    assert_eq!(resp.payload.agents[0].agent_id, "test-agent");

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_web_ui_sessions_list() {
    let (addr, handle) = start_server(19088).await;
    let (mut sink, mut stream) = connect(addr).await;

    let req = new_message(msg_types::CLIENT_SESSIONS_LIST, serde_json::json!({}));
    let resp: nession_agent::server::websocket::Message<WebSessionsListResponse> =
        round_trip(&mut sink, &mut stream, &req).await;
    assert_eq!(resp.msg_type, msg_types::OK);

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_web_ui_session_create() {
    let (addr, handle) = start_server(19089).await;
    let (mut sink, mut stream) = connect(addr).await;

    let session = TestSession::new("web-create");
    let payload = WebSessionCreatePayload {
        agent_id: "local-agent".to_string(),
        name: session.name().to_string(),
        width: 80,
        height: 24,
    };
    let req = new_message(msg_types::CLIENT_SESSION_CREATE, payload);
    let resp: nession_agent::server::websocket::Message<WebSessionCreateResponse> =
        round_trip(&mut sink, &mut stream, &req).await;
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
    let (addr, handle) = start_server(19090).await;
    let (mut sink, mut stream) = connect(addr).await;

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
        round_trip(&mut sink, &mut stream, &req).await;
    assert_eq!(resp.msg_type, msg_types::OK);
    assert!(resp.payload.success);

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_web_ui_session_attach() {
    let (addr, handle) = start_server(19091).await;
    let (mut sink, mut stream) = connect(addr).await;

    let payload = serde_json::json!({
        "session_id": "local-agent:webui_attach",
        "preferred_mode": "p2p"
    });
    let req = new_message(msg_types::CLIENT_SESSION_ATTACH, payload);
    let resp: nession_agent::server::websocket::Message<WebAttachInfo> =
        round_trip(&mut sink, &mut stream, &req).await;
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
    let (addr, handle) = start_server(19092).await;
    let (mut sink, mut stream) = connect(addr).await;

    let detach = ClientDetachPayload {
        session_name: "nonexistent".to_string(),
    };
    let req = new_message(msg_types::CLIENT_DETACH, detach);
    let resp: nession_agent::server::websocket::Message<serde_json::Value> =
        round_trip(&mut sink, &mut stream, &req).await;
    assert_eq!(resp.msg_type, msg_types::ERROR);
    assert_eq!(resp.payload["code"], "not_attached");

    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_terminal_input_not_attached() {
    let (addr, handle) = start_server(19093).await;
    let (mut sink, mut stream) = connect(addr).await;

    use base64::Engine;
    let input = base64::engine::general_purpose::STANDARD.encode(b"test");
    let payload = nession_agent::server::websocket::TerminalInputPayload {
        session_name: "ghost".to_string(),
        data: input,
    };
    let req = new_message(msg_types::TERMINAL_INPUT, payload);
    let resp: nession_agent::server::websocket::Message<serde_json::Value> =
        round_trip(&mut sink, &mut stream, &req).await;
    assert_eq!(resp.msg_type, msg_types::ERROR);
    assert_eq!(resp.payload["code"], "not_attached");

    handle.shutdown().await.ok();
}
