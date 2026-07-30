//! Integration tests for relay mode: browser → server → agent → tmux
//!
//! These tests verify the complete relay chain:
//! 1. Client sends client.session.attach (preferred_mode=relay) to server
//! 2. Server responds with success and enters relay forwarding mode
//! 3. Server connects to agent's internal WS, sends client.attach
//! 4. Agent creates PTY, sends terminal.output
//! 5. Server forwards terminal.output to browser
//! 6. Browser sends terminal.input → server forwards to agent → PTY

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use nession_agent::config::AttachMode;
use nession_agent::connection::ServerClient;
use nession_agent::server::websocket::AgentServer;
use nession_agent::sync::heartbeat::HeartbeatLoop;
use nession_agent::sync::session_watcher::SessionWatcher;
use nession_agent::tmux::manager::SessionManager;
use nession_common::config::ServerConfig;
use nession_common::protocol::AgentMetadata;
use nession_server::db::Database;
use nession_server::server::WebSocketServer;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message as WsMessage;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn ts() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// Build a standard protocol message.
fn msg(msg_type: &str, id: &str, payload: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "msg_type": msg_type,
        "id": id,
        "timestamp": ts(),
        "payload": payload,
    })
}

/// Start the central server on an ephemeral port.
async fn start_server(
    auth_token: &str,
) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>, String) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let id = COUNTER.fetch_add(1, Ordering::Relaxed);
    let db_path = std::env::temp_dir()
        .join(format!("nession_test_relay_{}_{}.db", ts(), id))
        .to_string_lossy()
        .to_string();

    let config = ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: auth_token.to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 30,
        db_path: db_path.clone(),
    };

    let db = Database::new(&db_path).await.unwrap();
    let mut server = WebSocketServer::new(config, Arc::new(db)).await.unwrap();
    let addr = server.local_addr().unwrap();

    let handle = tokio::spawn(async move {
        let _ = server.run().await;
    });

    tokio::time::sleep(Duration::from_millis(100)).await;
    (addr, handle, db_path)
}

/// Start the agent's internal WebSocket server (for P2P/relay connections).
/// OS picks a free port; returns the real bound address.
async fn start_agent(
    agent_id: &str,
) -> (std::net::SocketAddr, nession_agent::server::ServerHandle) {
    let tmp = Box::leak(Box::new(tempfile::tempdir().expect("tempdir")));
    let server = AgentServer::new(
        "127.0.0.1:0",
        agent_id,
        None, // no TLS
        "/tmp".to_string(),
        tmp.path().to_string_lossy().as_ref(),
        AttachMode::Plain,
    )
    .expect("agent server creation");

    let (handle, addr) = server.start().await.expect("agent server start");

    (addr, handle)
}

/// Register an agent with the central server so it shows as Online.
async fn register_agent(
    server_addr: std::net::SocketAddr,
    agent_id: &str,
    auth_token: &str,
    agent_port: u16,
) -> nession_agent::connection::ServerClientHandle {
    let metadata = AgentMetadata {
        tmux_version: "3.3".to_string(),
        os_version: "Linux".to_string(),
        nession_version: "0.1.0".to_string(),
        image_tag: "test".to_string(),
    };

    let client = ServerClient::new(
        format!("ws://{server_addr}"),
        auth_token,
        agent_id,
        "test-host",
        "127.0.0.1",
        agent_port,
        None,   // connect_url
        vec![], // addresses
        None,   // display_name
        metadata,
        Arc::new(SessionManager::new()),
        "/tmp".to_string(),
        None, // extension_registry
    );

    client
        .connect_and_run()
        .await
        .expect("agent registration")
        .0
}

/// Send a JSON text frame and return the next text frame (skipping non-text).
async fn send_and_recv(
    sink: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        WsMessage,
    >,
    stream: &mut futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
    request: &serde_json::Value,
) -> serde_json::Value {
    let request_id = request["id"].as_str().unwrap().to_string();
    sink.send(WsMessage::Text(request.to_string()))
        .await
        .unwrap();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            panic!("timeout waiting for response to {request_id}");
        }
        match tokio::time::timeout(Duration::from_secs(2), stream.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
                if parsed["id"].as_str() == Some(&request_id) {
                    return parsed;
                }
                // Unsolicited message (e.g. terminal.output) — skip.
            }
            Ok(Some(Ok(_))) => continue, // non-text frame
            Ok(Some(Err(e))) => panic!("WS error: {e}"),
            Ok(None) => panic!("stream closed"),
            Err(_timeout) => continue,
        }
    }
}

// ============================================================================
// Relay Mode Integration Tests
// ============================================================================

#[tokio::test]
async fn relay_attach_and_terminal_io() {
    let session_name = "relay_test_io";

    // Pre-clean tmux session from previous crashed run.
    SessionManager::new().kill_session(session_name).await.ok();

    // 1. Start server and agent.
    let (server_addr, server_handle, db_path) = start_server("test-token").await;
    let (agent_addr, agent_handle) = start_agent("relay-test-agent").await;

    // 2. Create a tmux session.
    let tmux = SessionManager::new();
    tmux.create_session(session_name, 80, 24, "/tmp", &[])
        .await
        .expect("create tmux session");

    // 3. Register agent with server so it's Online.
    let client_handle = register_agent(
        server_addr,
        "relay-test-agent",
        "test-token",
        agent_addr.port(),
    )
    .await;

    // 3b. Start heartbeat loop so the server keeps the agent Online.
    let heartbeat = HeartbeatLoop::new(
        client_handle.clone(),
        SessionManager::new(),
        1, // 1s interval for fast test
    );
    let heartbeat_shutdown = heartbeat.shutdown_handle();
    tokio::spawn(async move {
        let _ = heartbeat.run().await;
    });

    // 3c. Start session watcher so the tmux session syncs to the server.
    let watcher = SessionWatcher::new(
        client_handle.clone(),
        SessionManager::new(),
        1, // 1s poll for fast test
    );
    let watcher_shutdown = watcher.shutdown_handle();
    tokio::spawn(async move {
        let _ = watcher.run().await;
    });

    // Give heartbeat + session sync time to propagate.
    tokio::time::sleep(Duration::from_millis(2000)).await;

    // 4. Connect a "browser" client to the server.
    let url = format!("ws://{server_addr}");
    let (ws, _) = connect_async(&url).await.expect("client connect");
    let (mut sink, mut stream) = ws.split();

    // 5. Authenticate.
    let auth_req = msg(
        "client.auth",
        "auth-1",
        serde_json::json!({
            "auth_token": "test-token",
        }),
    );
    let auth_resp = send_and_recv(&mut sink, &mut stream, &auth_req).await;
    assert_eq!(
        auth_resp["payload"]["status"], "success",
        "auth failed: {auth_resp}"
    );

    // 6. Phase 1: query relay — returns addresses + session_name,
    //    but does NOT enter relay forwarding.
    let session_id = format!("relay-test-agent:{session_name}");
    let attach_req = msg(
        "client.session.attach",
        "attach-1",
        serde_json::json!({
            "session_id": session_id,
            "preferred_mode": "relay",
        }),
    );
    let attach_resp = send_and_recv(&mut sink, &mut stream, &attach_req).await;
    assert_eq!(
        attach_resp["payload"]["status"], "success",
        "attach failed: {attach_resp}"
    );
    assert_eq!(attach_resp["payload"]["mode"], "relay");
    assert_eq!(attach_resp["payload"]["session_name"], session_name);

    // 7. Phase 2: begin relay — actually enters relay forwarding.
    //    The Terminal is now "mounted" and subscribed to terminal.output.
    let begin_req = msg(
        "client.session.relay.begin",
        "begin-1",
        serde_json::json!({ "session_id": session_id }),
    );
    sink.send(WsMessage::Text(begin_req.to_string()))
        .await
        .expect("send begin");

    // Give the server time to connect to the agent, send client.attach,
    // and set up bidirectional forwarding.
    tokio::time::sleep(Duration::from_millis(500)).await;

    // 8. Send terminal.input (base64-encoded) through the relay.
    let input_data = base64::engine::general_purpose::STANDARD.encode(b"echo RELAY_TEST_MARKER\n");
    let input_msg = msg(
        "terminal.input",
        "input-1",
        serde_json::json!({
            "session_name": session_name,
            "data": input_data,
        }),
    );
    sink.send(WsMessage::Text(input_msg.to_string()))
        .await
        .expect("send terminal.input");

    // 9. Wait for terminal.output containing the marker.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut got_output = false;
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), stream.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let parsed: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
                let msg_type = parsed["msg_type"].as_str().unwrap_or("");
                if msg_type == "terminal.output" {
                    let b64 = parsed["payload"]["data"].as_str().unwrap_or("");
                    if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(b64) {
                        let output = String::from_utf8_lossy(&decoded);
                        if output.contains("RELAY_TEST_MARKER") {
                            got_output = true;
                            break;
                        }
                    }
                } else if msg_type == "error" {
                    panic!(
                        "relay error: {}",
                        parsed["payload"]["message"].as_str().unwrap_or("unknown")
                    );
                }
            }
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(e))) => {
                eprintln!("WS error while reading output: {e}");
                break;
            }
            Ok(None) => {
                eprintln!("WS stream closed while waiting for output");
                break;
            }
            Err(_) => continue, // timeout, try again
        }
    }

    // 10. Clean up.
    heartbeat_shutdown.shutdown().await.ok();
    watcher_shutdown.shutdown().await.ok();
    tmux.kill_session(session_name).await.ok();
    client_handle.shutdown().await.ok();
    agent_handle.shutdown().await.ok();
    server_handle.abort();
    tokio::fs::remove_file(&db_path).await.ok();

    assert!(
        got_output,
        "expected terminal.output containing 'RELAY_TEST_MARKER'"
    );
}
