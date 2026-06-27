//! Integration tests for the agent WebSocket server.
//!
//! These tests exercise the public API of [`AgentServer`] end-to-end:
//! bind, connect, send requests, and receive responses. They require a
//! working tmux installation (same as the tmux manager / pty tests).

use futures_util::{SinkExt, StreamExt};
use nession_agent::server::websocket::{
    msg_types, new_message, AgentServer, ClientAttachPayload, ClientAttachResponse,
    ClientDetachPayload, ClientDetachResponse, OkPayload, SessionCreatePayload,
    SessionCreateResponse, SessionKillPayload, SessionKillResponse,
};
use nession_agent::tmux::manager::TmuxManager;
use serde::Serialize;
use std::net::SocketAddr;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// Start a test server on a specific port and return the address + handle.
async fn start_server(port: u16) -> (SocketAddr, nession_agent::server::ServerHandle) {
    let addr_str = format!("127.0.0.1:{}", port);
    let server = AgentServer::new(&addr_str, None).expect("server creation should succeed");
    let handle = server.start().await.expect("start should succeed");
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    (addr_str.parse().unwrap(), handle)
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

    let session_name = "integration_create_kill";
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

    let tmux = TmuxManager::new();
    let session_name = "integration_attach";
    tmux.create_session(session_name, 80, 24).await.unwrap();

    // Attach.
    let attach = ClientAttachPayload {
        session_name: session_name.to_string(),
        width: 80,
        height: 24,
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

    tmux.kill_session(session_name).await.ok();
    handle.shutdown().await.ok();
}

#[tokio::test]
async fn integration_terminal_io_flow() {
    let (addr, handle) = start_server(19085).await;
    let (mut sink, mut stream) = connect(addr).await;

    let tmux = TmuxManager::new();
    let session_name = "integration_io";
    tmux.create_session(session_name, 80, 24).await.unwrap();

    // Attach.
    let attach = ClientAttachPayload {
        session_name: session_name.to_string(),
        width: 80,
        height: 24,
    };
    let req = new_message(msg_types::CLIENT_ATTACH, attach);
    let _: nession_agent::server::websocket::Message<ClientAttachResponse> =
        round_trip(&mut sink, &mut stream, &req).await;

    // Give the output reader a moment to start.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    // Send terminal input (base64 of "echo hello\n").
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

    tmux.kill_session(session_name).await.ok();
    handle.shutdown().await.ok();

    assert!(got_hello, "expected terminal output containing 'hello'");
}
