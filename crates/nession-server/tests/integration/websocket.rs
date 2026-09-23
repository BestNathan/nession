use futures_util::{SinkExt, StreamExt};
use nession_server::db::Database;
use nession_server::server::WebSocketServer;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio_tungstenite::connect_async;

use super::current_timestamp;

/// A database path inside a fresh temp dir, unique per call.
///
/// The caller keeps the returned `TempDir` alive; dropping it removes the file
/// and its WAL/SHM sidecars, so no test needs an explicit `remove_file` — which
/// only ran on the happy path anyway. A fixed `temp_dir()/<name>` was shared by
/// every concurrent test run on the machine.
fn test_db(name: &str) -> anyhow::Result<(tempfile::TempDir, String)> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join(name).to_string_lossy().into_owned();
    Ok((dir, path))
}

async fn start_test_server(
    config: nession_common::config::ServerConfig,
) -> anyhow::Result<(std::net::SocketAddr, tokio::task::JoinHandle<()>)> {
    let db = Database::new(&config.db_path).await?;
    let mut server = WebSocketServer::new(config, Arc::new(db)).await?;
    let addr = server.local_addr()?;
    let handle = tokio::spawn(async move {
        server
            .run()
            .await
            .unwrap_or_else(|e| panic!("test server run failed: {e}"));
    });
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    Ok((addr, handle))
}

#[tokio::test]
async fn test_server_accepts_connection() {
    let (_db_dir, db_path) = test_db("test_ws_accept.db").unwrap();
    let config = nession_common::config::ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: "test_token".to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 30,
        db_path,
        ..Default::default()
    };

    let (addr, _handle) = start_test_server(config).await.unwrap();

    let url = format!("ws://{addr}");
    let result = connect_async(&url).await;

    assert!(result.is_ok(), "Server should accept WebSocket connection");
}

#[tokio::test]
async fn test_agent_registration() {
    let (_db_dir, db_path) = test_db("test_ws_register.db").unwrap();
    let config = nession_common::config::ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: "test_token".to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 30,
        db_path,
        ..Default::default()
    };

    let (addr, _handle) = start_test_server(config).await.unwrap();

    let url = format!("ws://{addr}");
    let (mut ws_stream, _) = connect_async(&url).await.unwrap();

    let register_msg = serde_json::json!({
        "msg_type": "server.agent.register",
        "id": "msg_1",
        "timestamp": current_timestamp(),
        "payload": {
            "agent_id": "test_agent",
            "hostname": "test_host",
            "ip_address": "127.0.0.1",
            "port": 8080,
            "auth_token": "test_token",
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "metadata": {
                "tmux_version": "3.3a",
                "os_version": "Linux",
                "nession_version": "0.1.0"
            },
        }
    });

    ws_stream
        .send(tokio_tungstenite::tungstenite::Message::Text(
            register_msg.to_string(),
        ))
        .await
        .unwrap();

    let response = ws_stream.next().await.unwrap().unwrap();
    let response_text = match response {
        tokio_tungstenite::tungstenite::Message::Text(text) => text,
        _ => panic!("Expected text response"),
    };

    let response_msg: serde_json::Value = serde_json::from_str(&response_text).unwrap();
    assert_eq!(response_msg["msg_type"], "server.agent.register");
    assert_eq!(response_msg["payload"]["status"], "accepted");
}

#[tokio::test]
async fn test_invalid_auth_token() {
    let (_db_dir, db_path) = test_db("test_ws_auth.db").unwrap();
    let config = nession_common::config::ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: "correct_token".to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 30,
        db_path,
        ..Default::default()
    };

    let (addr, _handle) = start_test_server(config).await.unwrap();

    let url = format!("ws://{addr}");
    let (mut ws_stream, _) = connect_async(&url).await.unwrap();

    let auth_msg = serde_json::json!({
        "msg_type": "server.auth",
        "id": "msg_1",
        "timestamp": current_timestamp(),
        "payload": {
            "auth_token": "wrong_token"
        }
    });

    ws_stream
        .send(tokio_tungstenite::tungstenite::Message::Text(
            auth_msg.to_string(),
        ))
        .await
        .unwrap();

    let response = ws_stream.next().await.unwrap().unwrap();
    let response_text = match response {
        tokio_tungstenite::tungstenite::Message::Text(text) => text,
        tokio_tungstenite::tungstenite::Message::Close(_) => {
            panic!("Connection closed instead of sending error response");
        }
        _ => panic!("Expected text response"),
    };

    let response_msg: serde_json::Value = serde_json::from_str(&response_text).unwrap();
    assert_eq!(response_msg["msg_type"], "server.auth");
    assert_eq!(response_msg["payload"]["status"], "failed");
}

#[tokio::test]
async fn test_heartbeat_without_registration() {
    let (_db_dir, db_path) = test_db("test_ws_heartbeat.db").unwrap();
    let config = nession_common::config::ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: "test_token".to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 30,
        db_path,
        ..Default::default()
    };

    let (addr, _handle) = start_test_server(config).await.unwrap();

    let url = format!("ws://{addr}");
    let (mut ws_stream, _) = connect_async(&url).await.unwrap();

    let heartbeat_msg = serde_json::json!({
        "msg_type": "control.heartbeat",
        "id": "msg_1",
        "timestamp": current_timestamp(),
        "payload": {
            "agent_id": "unregistered_agent",
            "status": "online",
            "session_count": 0,
            "active_sessions": 0,
            "metadata": {
                "uptime_seconds": 100,
                "load_average": [0.5, 0.3, 0.2]
            }
        }
    });

    ws_stream
        .send(tokio_tungstenite::tungstenite::Message::Text(
            heartbeat_msg.to_string(),
        ))
        .await
        .unwrap();

    let result =
        tokio::time::timeout(tokio::time::Duration::from_millis(500), ws_stream.next()).await;

    assert!(
        result.is_err(),
        "Server should not respond to heartbeat from unregistered agent"
    );
}

#[tokio::test]
async fn test_client_agents_list_unauthenticated() {
    let (_db_dir, db_path) = test_db("test_ws_alist.db").unwrap();
    let config = nession_common::config::ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: "test_token".to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 30,
        db_path,
        ..Default::default()
    };

    let (addr, _handle) = start_test_server(config).await.unwrap();

    let url = format!("ws://{addr}");
    let (mut ws, _) = connect_async(&url).await.unwrap();

    let msg = serde_json::json!({
        "msg_type": "server.agent.list",
        "id": "al1", "timestamp": current_timestamp(),
        "payload": {}
    });
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        msg.to_string(),
    ))
    .await
    .unwrap();

    let resp = ws.next().await.unwrap().unwrap();
    let text = match resp {
        tokio_tungstenite::tungstenite::Message::Text(t) => t,
        _ => panic!("Expected text response"),
    };
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["payload"]["message"], "Not authenticated");
}

#[tokio::test]
async fn test_close_frame_triggers_disconnect() {
    let (_db_dir, db_path) = test_db("test_ws_close.db").unwrap();
    let config = nession_common::config::ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: "test_token".to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 30,
        db_path,
        ..Default::default()
    };

    let (addr, _handle) = start_test_server(config).await.unwrap();

    let url = format!("ws://{addr}");
    let (mut ws, _) = connect_async(&url).await.unwrap();

    // Send a close frame.
    ws.send(tokio_tungstenite::tungstenite::Message::Close(None))
        .await
        .unwrap();

    // The server should handle the close gracefully.
    tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

    // Verify server is still running by connecting again.
    let (_ws2, _) = connect_async(&url).await.unwrap();
}

#[tokio::test]
async fn test_agent_registration_with_connect_url() {
    let (_db_dir, db_path) = test_db("test_ws_connect_url.db").unwrap();
    let config = nession_common::config::ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: "test_token".to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 30,
        db_path,
        ..Default::default()
    };

    let (addr, _handle) = start_test_server(config).await.unwrap();

    let url = format!("ws://{addr}");
    let (mut ws, _) = connect_async(&url).await.unwrap();

    let msg = serde_json::json!({
        "msg_type": "server.agent.register",
        "id": "cu1", "timestamp": current_timestamp(),
        "payload": {
            "agent_id": "cu-agent", "hostname": "h", "ip_address": "10.0.0.1",
            "port": 9090, "auth_token": "test_token",
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "connect_url": "wss://custom.example.com/ws",
            "metadata": {
                "tmux_version": "3.3", "os_version": "Linux", "nession_version": "0.1"
            },
        }
    });
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        msg.to_string(),
    ))
    .await
    .unwrap();

    let resp = ws.next().await.unwrap().unwrap();
    let text = match resp {
        tokio_tungstenite::tungstenite::Message::Text(t) => t,
        _ => panic!("Expected text"),
    };
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["payload"]["status"], "accepted");
}

#[tokio::test]
async fn test_server_local_addr() {
    let (_db_dir, db_path) = test_db("test_ws_local_addr.db").unwrap();
    let config = nession_common::config::ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: "test_token".to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 30,
        db_path,
        ..Default::default()
    };

    let db = Database::new(&config.db_path).await.unwrap();
    let server = WebSocketServer::new(config, Arc::new(db)).await.unwrap();
    let addr = server.local_addr().unwrap();

    assert_eq!(addr.ip().to_string(), "127.0.0.1");
    assert!(addr.port() > 0);
}

#[tokio::test]
async fn test_client_sessions_list_authenticated() {
    let (_db_dir, db_path) = test_db("test_ws_sessions_list.db").unwrap();
    let config = nession_common::config::ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: "test_token".to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 30,
        db_path,
        ..Default::default()
    };

    let (addr, _handle) = start_test_server(config).await.unwrap();

    let url = format!("ws://{addr}");
    let (mut ws_stream, _) = connect_async(&url).await.unwrap();

    // Authenticate
    let auth_msg = serde_json::json!({
        "msg_type": "server.auth",
        "id": "msg_auth",
        "timestamp": current_timestamp(),
        "payload": {
            "auth_token": "test_token"
        }
    });

    ws_stream
        .send(tokio_tungstenite::tungstenite::Message::Text(
            auth_msg.to_string(),
        ))
        .await
        .unwrap();

    let response = ws_stream.next().await.unwrap().unwrap();
    let response_text = match response {
        tokio_tungstenite::tungstenite::Message::Text(text) => text,
        _ => panic!("Expected text response"),
    };

    let response_msg: serde_json::Value = serde_json::from_str(&response_text).unwrap();
    assert_eq!(response_msg["payload"]["status"], "success");

    // Request sessions list
    let sessions_msg = serde_json::json!({
        "msg_type": "server.session.list",
        "id": "msg_sessions",
        "timestamp": current_timestamp(),
        "payload": {}
    });

    ws_stream
        .send(tokio_tungstenite::tungstenite::Message::Text(
            sessions_msg.to_string(),
        ))
        .await
        .unwrap();

    let response = ws_stream.next().await.unwrap().unwrap();
    let response_text = match response {
        tokio_tungstenite::tungstenite::Message::Text(text) => text,
        _ => panic!("Expected text response"),
    };

    let response_msg: serde_json::Value = serde_json::from_str(&response_text).unwrap();
    assert_eq!(response_msg["msg_type"], "server.session.list");
    assert!(response_msg["payload"]["sessions"].is_array());
}

// ── Agent control ownership across a reconnect (#960) ────────────────────────
//
// These drive the real server over real sockets, because the bug they pin is
// about *which* connection the server serves an agent from. The reproduction is
// the one in the issue: register on `c1`, register the same agent on `c2`, then
// have `c1` do what a half-closed connection does — keep talking, or finally
// close — and check that the agent is still served from `c2`.

/// A WebSocket held by a test, on either side of the connection.
type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// A running server, plus the temp dir holding its database — which the caller
/// must keep alive for the test's duration.
type OwnershipServer = (
    tempfile::TempDir,
    std::net::SocketAddr,
    tokio::task::JoinHandle<()>,
);

/// A server for these tests: no TLS, a known token, default heartbeat cadence,
/// the production terminal stall grace.
async fn start_ownership_server(db_name: &str) -> anyhow::Result<OwnershipServer> {
    start_ownership_server_with_grace(
        db_name,
        nession_common::config::DEFAULT_TERMINAL_STALL_GRACE_SECS,
    )
    .await
}

/// The same, with `#961-B`'s terminal stall grace shortened.
///
/// The grace is a production policy number (8 MiB held for 15 s), and a test
/// that waited it out would be testing the calendar. Shortening it here changes
/// only *when* the verdict comes, never what it is: the queue's bound still has
/// to be reached first, which is what the test arranges.
async fn start_ownership_server_with_grace(
    db_name: &str,
    stall_grace_secs: u64,
) -> anyhow::Result<OwnershipServer> {
    let (db_dir, db_path) = test_db(db_name)?;
    let config = nession_common::config::ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: "test_token".to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 30,
        db_path,
        terminal_stall_grace_secs: stall_grace_secs,
        ..Default::default()
    };
    let (addr, handle) = start_test_server(config).await?;
    Ok((db_dir, addr, handle))
}

/// The next frame as JSON. `Err` for anything else: these tests assert on
/// protocol messages, so a close or a binary frame where one is expected is the
/// answer, not a frame to skip past.
async fn next_json(ws: &mut TestWs) -> anyhow::Result<serde_json::Value> {
    match ws.next().await {
        Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
            Ok(serde_json::from_str(&text)?)
        }
        other => anyhow::bail!("expected a JSON text frame, got {other:?}"),
    }
}

/// Send one frame, failing the test if it cannot be written.
async fn send_frame(
    ws: &mut TestWs,
    frame: tokio_tungstenite::tungstenite::Message,
) -> anyhow::Result<()> {
    ws.send(frame).await?;
    Ok(())
}

/// Send a protocol message, i.e. the message as JSON text.
async fn send_json(ws: &mut TestWs, value: serde_json::Value) -> anyhow::Result<()> {
    send_frame(
        ws,
        tokio_tungstenite::tungstenite::Message::Text(value.to_string()),
    )
    .await
}

/// The payload of a reply of the expected type.
fn payload_of(reply: &serde_json::Value, msg_type: &str) -> anyhow::Result<serde_json::Value> {
    anyhow::ensure!(
        reply.get("msg_type").and_then(serde_json::Value::as_str) == Some(msg_type),
        "expected a {msg_type} reply, got {reply}"
    );
    reply
        .get("payload")
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("reply has no payload: {reply}"))
}

/// What an agent sends to register — used by `connect_agent`, and by the test
/// that has an already-registered connection register again.
fn register_payload(agent_id: &str) -> serde_json::Value {
    register_payload_on_port(agent_id, 8080)
}

/// The same registration, advertising a specific P2P port.
///
/// The port is not decoration: the relay dials `ws://<ip>:<port>/ws` when the
/// agent advertised no address list, so a test that wants the Server to dial
/// *its* endpoint has to say so here.
fn register_payload_on_port(agent_id: &str, port: u16) -> serde_json::Value {
    serde_json::json!({
        "agent_id": agent_id,
        "hostname": "test_host",
        "ip_address": "127.0.0.1",
        "port": port,
        "auth_token": "test_token",
        "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
        "metadata": {"tmux_version": "3.3a", "os_version": "Linux", "nession_version": "0.1.0"},
    })
}

/// Connect as an agent and register `agent_id` on the connection, returning it
/// once the server has accepted — a live agent control connection.
async fn connect_agent(addr: std::net::SocketAddr, agent_id: &str) -> anyhow::Result<TestWs> {
    connect_agent_on_port(addr, agent_id, 8080).await
}

/// The same, advertising a specific P2P port — which is the address the relay
/// will dial, so a test that wants the Server to call *its* endpoint says so
/// here.
async fn connect_agent_on_port(
    addr: std::net::SocketAddr,
    agent_id: &str,
    port: u16,
) -> anyhow::Result<TestWs> {
    let (mut ws, _) = connect_async(format!("ws://{addr}")).await?;
    send_json(
        &mut ws,
        serde_json::json!({
            "msg_type": "server.agent.register",
            "id": format!("register-{agent_id}"),
            "timestamp": current_timestamp(),
            "payload": register_payload_on_port(agent_id, port),
        }),
    )
    .await?;

    let reply = next_json(&mut ws).await?;
    let payload = payload_of(&reply, "server.agent.register")?;
    anyhow::ensure!(
        payload.get("status").and_then(serde_json::Value::as_str) == Some("accepted"),
        "agent registration must be accepted: {reply}"
    );
    Ok(ws)
}

/// Connect as a browser client and authenticate.
async fn connect_client(addr: std::net::SocketAddr) -> anyhow::Result<TestWs> {
    let (mut ws, _) = connect_async(format!("ws://{addr}")).await?;
    send_json(
        &mut ws,
        serde_json::json!({
            "msg_type": "server.auth",
            "id": "auth-1",
            "timestamp": current_timestamp(),
            "payload": { "auth_token": "test_token" },
        }),
    )
    .await?;
    let reply = next_json(&mut ws).await?;
    let payload = payload_of(&reply, "server.auth")?;
    anyhow::ensure!(
        payload.get("status").and_then(serde_json::Value::as_str) == Some("success"),
        "client authentication must succeed: {reply}"
    );
    Ok(ws)
}

/// One client → server → agent → server → client command round trip, and the
/// answer to "which connection is the agent served from?".
///
/// The command is a brokered one (`capture-preview`): the server hands it to
/// whichever connection owns the agent, waits for that connection's
/// `server.agent.command-response`, and relays the answer back. So a reply
/// proves *who* the server thinks the agent is — a command delivered elsewhere
/// never comes back, and the client is told the agent disconnected instead.
///
/// `other`, when given, must receive nothing: the negative half of the claim.
async fn command_round_trip(
    client: &mut TestWs,
    owner: &mut TestWs,
    other: Option<&mut TestWs>,
    session_id: &str,
) -> anyhow::Result<serde_json::Value> {
    send_json(
        client,
        serde_json::json!({
            "msg_type": "server.session.capture-preview",
            "id": "preview-1",
            "timestamp": current_timestamp(),
            "payload": { "session_id": session_id, "lines": 10 },
        }),
    )
    .await?;

    // The owner is the only connection that can answer, so this wait is the
    // assertion: a command delivered to the other connection never arrives.
    let command = tokio::time::timeout(tokio::time::Duration::from_secs(5), next_json(owner))
        .await
        .map_err(|_| {
            anyhow::anyhow!("the server never delivered the command to the agent's owner")
        })??;
    let request_id = payload_of(&command, "agent.session.capture-preview")?
        .get("request_id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("the command carries no request id: {command}"))?
        .to_string();

    if let Some(other) = other {
        anyhow::ensure!(
            tokio::time::timeout(tokio::time::Duration::from_millis(200), other.next())
                .await
                .is_err(),
            "a superseded connection must not be sent the agent's commands"
        );
    }

    send_json(
        owner,
        serde_json::json!({
            "msg_type": "server.agent.command-response",
            "id": "response-1",
            "timestamp": current_timestamp(),
            "payload": {
                "request_id": request_id,
                "success": true,
                "echo": "the-owner-answered",
            },
        }),
    )
    .await?;

    let reply = tokio::time::timeout(tokio::time::Duration::from_secs(5), next_json(client))
        .await
        .map_err(|_| {
            anyhow::anyhow!("the client got no answer to a command the owner answered")
        })??;
    payload_of(&reply, "server.session.capture-preview")
}

/// A message from the connection that used to serve the agent must not take it
/// back — and it keeps sending, because a half-closed socket delivers for a
/// while.
///
/// The late message here is a heartbeat, which is what such a connection really
/// sends; the re-registration after it is the barrier that makes this
/// deterministic rather than merely likely. Registering is answered, so waiting
/// for the answer proves the server has processed **both** messages — the
/// heartbeat first, since one connection's frames are handled in order — before
/// the probe is sent. Without it the probe could outrun the late message and
/// the test would pass for the wrong reason.
#[tokio::test]
async fn old_connection_late_message_does_not_take_the_agent_back() -> anyhow::Result<()> {
    let (_db_dir, addr, _handle) =
        start_ownership_server("test_ws_agent_generation_late.db").await?;

    let mut old = connect_agent(addr, "a1").await?;
    let mut new = connect_agent(addr, "a1").await?;

    send_json(
        &mut old,
        serde_json::json!({
            "msg_type": "control.heartbeat",
            "id": "late-heartbeat",
            "timestamp": current_timestamp(),
            "payload": { "agent_id": "a1", "session_count": 7, "active_sessions": 2 },
        }),
    )
    .await?;
    send_json(
        &mut old,
        serde_json::json!({
            "msg_type": "server.agent.register",
            "id": "late-register",
            "timestamp": current_timestamp(),
            "payload": register_payload("a1"),
        }),
    )
    .await?;
    let barrier = next_json(&mut old).await?;
    assert_eq!(barrier["msg_type"], "server.agent.register");

    let mut client = connect_client(addr).await?;
    let reply = command_round_trip(&mut client, &mut new, Some(&mut old), "a1:dev").await?;

    assert_eq!(
        reply["echo"],
        serde_json::json!("the-owner-answered"),
        "the agent must still be answering on the connection that registered last"
    );
    Ok(())
}

/// The disconnect half: the old connection closing must not unregister the
/// agent its replacement is serving. Releasing is owner-checked, so a
/// superseded connection's cleanup finds nothing of its own to release.
#[tokio::test]
async fn old_connection_disconnect_does_not_unregister_the_new_one() -> anyhow::Result<()> {
    let (_db_dir, addr, _handle) =
        start_ownership_server("test_ws_agent_generation_close.db").await?;

    let mut old = connect_agent(addr, "a1").await?;
    let mut new = connect_agent(addr, "a1").await?;

    // Close it, and wait for the server to hang up on its side: the cleanup
    // runs before the socket goes away, so an observable EOF means the release
    // has been attempted. Then the probe must still find the agent — it is
    // served from `new` now, and only the old connection was closed.
    send_frame(
        &mut old,
        tokio_tungstenite::tungstenite::Message::Close(None),
    )
    .await?;
    let _ = tokio::time::timeout(tokio::time::Duration::from_secs(5), old.next()).await;

    let mut client = connect_client(addr).await?;
    let reply = command_round_trip(&mut client, &mut new, None, "a1:dev").await?;

    assert_eq!(
        reply["echo"],
        serde_json::json!("the-owner-answered"),
        "closing the superseded connection must not unregister the agent"
    );
    Ok(())
}

// ── The per-connection execution model (#961 stage A) ────────────────────────
//
// **Characterization, not aspiration.** Every test below pins what this tree
// does *now*, and each one names the stage expected to change its answer. The
// point of writing them this way is that they are live: the model the
// requirement asks for (`#961-C` … `#961-E`) is not what the code does, so a
// suite written against the requirement could only land `#[ignore]`d — and an
// ignored test cannot fail.
//
// What that buys is a flip per stage: when one of these goes red, the stage
// that changed the execution model is named in the failure, and the assertion
// it was holding is the one that stage is responsible for.

/// A request for a brokered read.
///
/// The Server forwards this to the agent that owns the session and waits up to
/// 15s for that agent's answer (`agent_command_with_timeout`), which makes it
/// the one request in this file whose *duration the test controls*: the agent
/// in these tests is the test.
fn capture_preview_request(id: &str, session_id: &str) -> serde_json::Value {
    serde_json::json!({
        "msg_type": "server.session.capture-preview",
        "id": id,
        "timestamp": current_timestamp(),
        "payload": { "session_id": session_id, "lines": 10 },
    })
}

/// A server-served query that depends on no agent and no mutation.
fn session_list_request(id: &str) -> serde_json::Value {
    serde_json::json!({
        "msg_type": "server.session.list",
        "id": id,
        "timestamp": current_timestamp(),
        "payload": {},
    })
}

/// The same for the agent registry.
fn agent_list_request(id: &str) -> serde_json::Value {
    serde_json::json!({
        "msg_type": "server.agent.list",
        "id": id,
        "timestamp": current_timestamp(),
        "payload": {},
    })
}

/// The agent's half of a brokered command: an answer carrying the request id
/// the Server correlates it by. `echo` is what the client sees back, so a test
/// can prove a reply belongs to the request it answers.
fn command_answer(request_id: &str, echo: &str) -> serde_json::Value {
    serde_json::json!({
        "msg_type": "server.agent.command-response",
        "id": format!("answer-{request_id}"),
        "timestamp": current_timestamp(),
        "payload": { "request_id": request_id, "success": true, "echo": echo },
    })
}

/// Read protocol frames until every id in `expected` has arrived, and return
/// those frames in the order they arrived.
///
/// Frames are matched by the id they carry, not by arrival position, and
/// everything else is skipped: an authenticated client is pushed
/// `server.agents.changed` / `server.sessions.changed` as agents and sessions
/// move, and the socket is pinged on the heartbeat cadence. Neither is an
/// answer to anything here.
async fn replies_in_arrival_order(
    ws: &mut TestWs,
    expected: &[&str],
) -> anyhow::Result<Vec<serde_json::Value>> {
    let mut seen: Vec<serde_json::Value> = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);

    while seen.len() < expected.len() {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        anyhow::ensure!(
            !remaining.is_zero(),
            "only {} of {expected:?} arrived before the deadline: {:?}",
            seen.len(),
            ids_of(&seen)
        );
        // `Ok(None)` and `Close` are failures, not things to skip past: a
        // connection that ended cannot deliver the replies still being waited
        // on, and looping on a closed stream would only burn the deadline.
        match tokio::time::timeout(remaining, ws.next()).await {
            Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text)))) => {
                let parsed: serde_json::Value = serde_json::from_str(&text)?;
                if let Some(id) = parsed.get("id").and_then(serde_json::Value::as_str) {
                    if expected.contains(&id) {
                        seen.push(parsed);
                    }
                }
            }
            Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Close(frame)))) => {
                anyhow::bail!("connection closed while waiting for {expected:?}: {frame:?}")
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => return Err(e.into()),
            Ok(None) => anyhow::bail!("connection closed while waiting for {expected:?}"),
            Err(_) => anyhow::bail!(
                "timed out with {} of {expected:?} arrived: {:?}",
                seen.len(),
                ids_of(&seen)
            ),
        }
    }
    Ok(seen)
}

/// The ids of a set of frames, in order.
fn ids_of(frames: &[serde_json::Value]) -> Vec<String> {
    frames
        .iter()
        .filter_map(|frame| frame.get("id").and_then(serde_json::Value::as_str))
        .map(str::to_string)
        .collect()
}

/// A request that waits on an agent holds every later request on the same
/// connection — the independent ones included.
///
/// The slow request is brokered, so the test is the agent: it holds the answer
/// until it has already sent the fast request, which is what makes "the fast
/// one answered second" a property of the test rather than of the machine.
///
/// The mechanism is `handle_ws_stream`'s loop — `handler.handle_message(msg).await`
/// is awaited inline, so the second frame is not *read* while the first is in
/// flight. Nothing about the two requests relates them; they are serialized
/// because the connection is.
///
/// **Flips at `#961-C`** (Server query lane). Both requests are read-only — a
/// capture preview is named there explicitly — so the expected behaviour is
/// that the list is answered while the capture is still outstanding, and this
/// assertion becomes `["fast-1", "slow-1"]` with each reply still carrying its
/// own id.
#[tokio::test]
async fn a_slow_command_holds_the_connection_it_arrived_on() -> anyhow::Result<()> {
    let (_db_dir, addr, _handle) = start_ownership_server("test_ws_hol_blocking.db").await?;

    let mut agent = connect_agent(addr, "a1").await?;
    let mut client = connect_client(addr).await?;

    // The slow one goes first, and stays unanswered: the Server is inside this
    // handler for as long as the test keeps quiet.
    send_json(&mut client, capture_preview_request("slow-1", "a1:dev")).await?;
    let command = tokio::time::timeout(std::time::Duration::from_secs(5), next_json(&mut agent))
        .await
        .map_err(|_| anyhow::anyhow!("the server never forwarded the capture command"))??;
    let request_id = payload_of(&command, "agent.session.capture-preview")?
        .get("request_id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("the command carries no request id: {command}"))?
        .to_string();

    // The fast, independent one — written while the slow one is in flight.
    send_json(&mut client, session_list_request("fast-1")).await?;

    // Now the agent answers the first.
    send_json(&mut agent, command_answer(&request_id, "slow-1-answered")).await?;

    let replies = replies_in_arrival_order(&mut client, &["slow-1", "fast-1"]).await?;

    assert_eq!(
        ids_of(&replies),
        vec!["slow-1".to_string(), "fast-1".to_string()],
        "the list was answered out of order — the connection is no longer serial"
    );
    assert_eq!(
        replies[0]["payload"]["echo"],
        serde_json::json!("slow-1-answered")
    );
    assert_eq!(replies[1]["msg_type"], "server.session.list");
    anyhow::ensure!(
        replies[1]["payload"]["sessions"].is_array(),
        "the second reply is not a session list: {}",
        replies[1]
    );
    Ok(())
}

/// Authentication is ordered before the frames that depend on it.
///
/// Three frames are written back to back and never waited on: a session list
/// *before* authenticating, the auth itself, and the same list again. The
/// answers come back in that order, the first refused and the third served —
/// which is only possible if each frame was handled to completion before the
/// next was read.
///
/// **Must not flip.** `#961-C` keeps auth on the connection-ordered lane for
/// exactly this reason. If this goes red while a query lane is being opened, a
/// message a later message depends on has been moved into the parallel
/// executor.
#[tokio::test]
async fn authentication_takes_effect_for_the_next_frame_on_the_connection() -> anyhow::Result<()> {
    let (_db_dir, addr, _handle) = start_ownership_server("test_ws_auth_ordering.db").await?;

    // Connected raw, not through `connect_client`: this test is about what
    // happens when the frames are *not* separated by a response.
    let (mut client, _) = connect_async(format!("ws://{addr}")).await?;

    send_json(&mut client, session_list_request("before-1")).await?;
    send_json(
        &mut client,
        serde_json::json!({
            "msg_type": "server.auth",
            "id": "auth-2",
            "timestamp": current_timestamp(),
            "payload": { "auth_token": "test_token" },
        }),
    )
    .await?;
    send_json(&mut client, session_list_request("after-3")).await?;

    let replies = replies_in_arrival_order(&mut client, &["before-1", "auth-2", "after-3"]).await?;

    assert_eq!(
        ids_of(&replies),
        vec![
            "before-1".to_string(),
            "auth-2".to_string(),
            "after-3".to_string()
        ],
        "the connection's frames were not handled in order"
    );
    assert_eq!(
        replies[0]["payload"]["message"],
        serde_json::json!("Not authenticated"),
        "a request written before the auth must be refused by it"
    );
    assert_eq!(
        replies[1]["payload"]["status"],
        serde_json::json!("success")
    );
    anyhow::ensure!(
        replies[2]["payload"]["sessions"].is_array(),
        "the list written after the auth was not served: {}",
        replies[2]
    );
    Ok(())
}

/// An agent's registration is ordered before the state that agent reports.
///
/// The heartbeat is written immediately behind the registration, on the same
/// connection and never separated by a response, and carries
/// `session_count: 7`. That number is the witness: `handle_control_heartbeat`
/// refuses a heartbeat from a connection that has not registered
/// (`bound_agent_id`), and a payload `agent_id` is checked against the identity
/// the connection registered with — so a heartbeat *reordered ahead of* the
/// registration is dropped silently, and 7 never reaches the registry.
///
/// The registry is read from a second connection, so the value is polled
/// rather than awaited: what is being asserted is that the heartbeat was
/// applied under the identity its own connection established, and that is a
/// settled fact the moment it appears. The failure it catches is an *absent*
/// value, never a late one — which is why the deadline is generous and the
/// check is not a latency budget.
///
/// **Must not flip.** Same lane as the test above; an agent registering is the
/// control-lane case the requirement names first.
#[tokio::test]
async fn registration_is_ordered_before_the_state_the_agent_reports() -> anyhow::Result<()> {
    let (_db_dir, addr, _handle) = start_ownership_server("test_ws_register_ordering.db").await?;

    let (mut agent, _) = connect_async(format!("ws://{addr}")).await?;
    send_json(
        &mut agent,
        serde_json::json!({
            "msg_type": "server.agent.register",
            "id": "register-1",
            "timestamp": current_timestamp(),
            "payload": register_payload("a1"),
        }),
    )
    .await?;
    send_json(
        &mut agent,
        serde_json::json!({
            "msg_type": "control.heartbeat",
            "id": "heartbeat-2",
            "timestamp": current_timestamp(),
            "payload": {
                "agent_id": "a1",
                "status": "online",
                "session_count": 7,
                "active_sessions": 2,
            },
        }),
    )
    .await?;

    let mut client = connect_client(addr).await?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut attempt = 0usize;

    loop {
        let probe_id = format!("probe-{attempt}");
        attempt += 1;
        send_json(&mut client, agent_list_request(&probe_id)).await?;
        let replies = replies_in_arrival_order(&mut client, &[&probe_id]).await?;
        let agents = replies[0]["payload"]["agents"]
            .as_array()
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("not an agent list: {}", replies[0]))?;
        let listed = agents
            .iter()
            .find(|a| a["agent_id"] == serde_json::json!("a1"))
            .cloned()
            .unwrap_or(serde_json::Value::Null);

        if listed["session_count"] == serde_json::json!(7) {
            return Ok(());
        }
        anyhow::ensure!(
            tokio::time::Instant::now() < deadline,
            "the heartbeat behind the registration never reached the registry \
             (last seen: {listed}) — the registration was not in effect when it \
             was handled"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

/// A client that stops reading **parks dispatch, and loses nothing**.
///
/// Stage A's `a_client_that_stops_reading_neither_stalls_nor_loses_replies`,
/// re-asserted for `#961-B`. The first half of that name is no longer true and
/// this test now asserts the opposite of it: with a bounded outbound path,
/// dispatch *does* stop when the client stops draining — that is the bound
/// working, not a regression. The second half survives unchanged, and it is the
/// half that matters: nothing is lost.
///
/// The client writes `FLOOD_REQUESTS` brokered requests and then reads nothing,
/// while the agent answers each one with a payload of `FLOOD_PAYLOAD_BYTES`.
/// The queued total is larger than the outbound budget, so the bound is reached
/// and the read loop parks in `send_reply` — a reply is not droppable, so it
/// waits for room rather than failing or being discarded.
///
/// Both halves are the assertion:
///
/// * the command count **plateaus below `FLOOD_REQUESTS`** — the read loop is
///   parked on a queue the client is not draining. If every command still got
///   through, the path is unbounded again, which is the regression this test
///   exists to catch (measured with the bound in place: 10 of 16, i.e. the 8 MiB
///   budget's worth of 1 MiB answers plus what the socket buffered).
/// * once the client reads, **the count completes and every reply arrives**,
///   whole and distinct — so the park was a park, not a drop. A reply lost to
///   the bound would show up here as a missing id or a stalled count.
///
/// The gap between the two halves is also the flow-control claim: the client
/// draining is what lets dispatch resume, with nothing dropped in between.
#[tokio::test]
async fn a_client_that_stops_reading_parks_dispatch_and_loses_nothing() -> anyhow::Result<()> {
    const FLOOD_REQUESTS: usize = 16;
    const FLOOD_PAYLOAD_BYTES: usize = 1024 * 1024;
    /// How long the command count must stop moving before it counts as the
    /// bound rather than as the agent being between commands.
    const PLATEAU_HOLD: std::time::Duration = std::time::Duration::from_secs(2);

    let (_db_dir, addr, _handle) = start_ownership_server("test_ws_outbound_flood.db").await?;

    let agent = connect_agent(addr, "a1").await?;
    let mut client = connect_client(addr).await?;

    let answered = Arc::new(AtomicUsize::new(0));
    tokio::spawn(answer_capture_commands(
        agent,
        FLOOD_PAYLOAD_BYTES,
        Arc::clone(&answered),
    ));

    // Written and never read: the client stays parked here until the first half
    // has been observed, so MiBs pile up against a reader that is not there.
    for n in 0..FLOOD_REQUESTS {
        send_json(&mut client, capture_preview_request(&flood_id(n), "a1:dev")).await?;
    }

    // ── The bound: dispatch stops. ──
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
    let mut last = answered.load(Ordering::SeqCst);
    let mut held_since = tokio::time::Instant::now();
    while held_since.elapsed() < PLATEAU_HOLD {
        anyhow::ensure!(
            tokio::time::Instant::now() < deadline,
            "the command count never stopped moving (reached {} of {FLOOD_REQUESTS})",
            answered.load(Ordering::SeqCst)
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let now = answered.load(Ordering::SeqCst);
        if now != last {
            last = now;
            held_since = tokio::time::Instant::now();
        }
    }
    let parked_at = answered.load(Ordering::SeqCst);
    assert!(
        parked_at < FLOOD_REQUESTS,
        "nothing drained {FLOOD_REQUESTS} MiB, yet all {FLOOD_REQUESTS} commands were \
         dispatched — the outbound path is not bounded"
    );

    // ── No loss: draining resumes it, and every answer arrives. ──
    let expected: Vec<String> = (0..FLOOD_REQUESTS).map(flood_id).collect();
    let expected_refs: Vec<&str> = expected.iter().map(String::as_str).collect();
    let replies = replies_in_arrival_order(&mut client, &expected_refs).await?;

    // One reply per request, each addressed to its own id. Arrival *order* is
    // deliberately not asserted here — that is `#961-C`'s subject, and this
    // test is about the outbound path — but the set has to be complete, which
    // is the "nothing was dropped" half.
    let mut arrived_ids = ids_of(&replies);
    arrived_ids.sort();
    let mut sorted_expected = expected.clone();
    sorted_expected.sort();
    assert_eq!(
        arrived_ids, sorted_expected,
        "the client did not get exactly one reply per request"
    );

    // And every payload is whole, from its own command: the agent marks each
    // answer with its own sequence number, so 16 distinct markers of the full
    // length is 16 answers that arrived intact rather than 16 truncated or
    // duplicated frames.
    let mut markers: Vec<String> = replies
        .iter()
        .map(|reply| {
            let echo = reply["payload"]["echo"].as_str().unwrap_or_default();
            assert_eq!(
                echo.len(),
                FLOOD_PAYLOAD_BYTES,
                "a reply payload did not survive the queue intact"
            );
            echo.get(..answer_marker_len())
                .unwrap_or_default()
                .to_string()
        })
        .collect();
    markers.sort();
    let expected_markers: Vec<String> = (0..FLOOD_REQUESTS).map(answer_marker).collect();
    assert_eq!(
        markers, expected_markers,
        "the same command was answered twice, or one answer came back twice"
    );

    // The parked half is what makes the count's completion meaningful: the
    // commands that had been waiting for room were dispatched *because* the
    // client started reading, and the agent saw every one of them.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    while answered.load(Ordering::SeqCst) < FLOOD_REQUESTS {
        anyhow::ensure!(
            tokio::time::Instant::now() < deadline,
            "dispatch never resumed after the client drained ({} of {FLOOD_REQUESTS} \
             commands reached the agent, {parked_at} had when it parked)",
            answered.load(Ordering::SeqCst)
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    Ok(())
}

/// A flood id, unique per request.
fn flood_id(n: usize) -> String {
    format!("flood-{n:03}")
}

/// What the agent stamps into its n-th answer: 3 digits of sequence number,
/// which is what makes "16 intact, distinct answers" checkable.
fn answer_marker(n: usize) -> String {
    format!("{n:03}")
}

fn answer_marker_len() -> usize {
    3
}

/// Answer every brokered capture command the Server forwards, with an `echo` of
/// `echo_bytes`, and count the commands answered.
///
/// The size is what accumulates against a client that is not reading, so the
/// count reaching its target is evidence about the Server's read loop rather
/// than about the agent.
async fn answer_capture_commands(mut agent: TestWs, echo_bytes: usize, answered: Arc<AtomicUsize>) {
    use tokio_tungstenite::tungstenite::Message;

    while let Some(Ok(Message::Text(text))) = agent.next().await {
        let Ok(command) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        if command.get("msg_type").and_then(serde_json::Value::as_str)
            != Some("agent.session.capture-preview")
        {
            continue;
        }
        let Some(request_id) = command
            .get("payload")
            .and_then(|payload| payload.get("request_id"))
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };

        // Distinct per answer — the sequence number is what the test counts —
        // and big, because the size is what piles up against a client that is
        // not reading.
        let mut echo = answer_marker(answered.load(Ordering::SeqCst));
        echo.push_str(&"x".repeat(echo_bytes.saturating_sub(echo.len())));
        let reply = serde_json::json!({
            "msg_type": "server.agent.command-response",
            "id": format!("answer-{request_id}"),
            "timestamp": current_timestamp(),
            "payload": { "request_id": request_id, "success": true, "echo": echo },
        });

        answered.fetch_add(1, Ordering::SeqCst);
        if agent.send(Message::Text(reply.to_string())).await.is_err() {
            return;
        }
    }
}

// ── Relay mode owns the connection it runs on (#961 stage A) ─────────────────

/// A stand-in for the agent's *own* WebSocket endpoint — the one the Server
/// dials when it relays.
///
/// `connect_agent` above is the other direction: a connection the test opens to
/// the Server, which is what an agent's control channel is. The relay is the
/// case where the Server is the client, so this one has to be a listener.
struct MockAgentEndpoint {
    addr: std::net::SocketAddr,
    frames: tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
}

async fn start_mock_agent_endpoint() -> anyhow::Result<MockAgentEndpoint> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let (tx, frames) = tokio::sync::mpsc::unbounded_channel();

    tokio::spawn(async move {
        // Accepts for as long as the test runs, and not once: the relay opens a
        // *second* connection at the end, to send the best-effort
        // `agent.detach`. A listener that stopped after the first connection
        // would turn that into a connect error rather than a fact about the
        // relay.
        while let Ok((stream, _)) = listener.accept().await {
            let tx = tx.clone();
            tokio::spawn(async move {
                let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
                    return;
                };
                let (mut sink, mut stream) = ws.split();
                while let Some(Ok(message)) = stream.next().await {
                    let tokio_tungstenite::tungstenite::Message::Text(text) = message else {
                        continue;
                    };
                    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) else {
                        continue;
                    };
                    // The relay waits for this answer before it forwards
                    // anything at all, so it is the one frame that has to be
                    // replied to rather than just recorded.
                    if parsed.get("msg_type").and_then(serde_json::Value::as_str)
                        == Some("agent.attach")
                    {
                        let answer = serde_json::json!({
                            "msg_type": "agent.attach",
                            "id": parsed.get("id").cloned().unwrap_or(serde_json::Value::Null),
                            "timestamp": current_timestamp(),
                            "payload": parsed
                                .get("payload")
                                .cloned()
                                .unwrap_or(serde_json::Value::Null),
                        });
                        if sink
                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                answer.to_string(),
                            ))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                    if tx.send(parsed).is_err() {
                        return;
                    }
                }
            });
        }
    });

    Ok(MockAgentEndpoint { addr, frames })
}

/// An agent endpoint whose session produces terminal output forever, for the
/// terminal-lane test: it answers `agent.attach` like the one above, and then
/// streams `chunk_bytes`-sized frames without ever stopping or waiting to be
/// asked.
///
/// `offered` counts the frames it *has handed to its own sink* — the agent's
/// side of the backpressure claim, and the reason the test can say "the Server
/// stopped taking this" rather than only "the client stopped receiving". It is
/// what an agent with a busy terminal looks like when nobody is draining it: it
/// keeps producing, and what it can push shrinks to whatever the Server will
/// still read.
async fn start_streaming_mock_agent_endpoint(
    chunk_bytes: usize,
) -> anyhow::Result<(MockAgentEndpoint, Arc<AtomicUsize>)> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let (tx, frames) = tokio::sync::mpsc::unbounded_channel();
    let offered = Arc::new(AtomicUsize::new(0));

    let counter = Arc::clone(&offered);
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let tx = tx.clone();
            let counter = Arc::clone(&counter);
            tokio::spawn(async move {
                let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
                    return;
                };
                let (mut sink, mut stream) = ws.split();

                // Wait for the attach and answer it; nothing else is expected
                // from the Server on this connection.
                while let Some(Ok(message)) = stream.next().await {
                    let tokio_tungstenite::tungstenite::Message::Text(text) = message else {
                        continue;
                    };
                    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) else {
                        continue;
                    };
                    if parsed.get("msg_type").and_then(serde_json::Value::as_str)
                        == Some("agent.attach")
                    {
                        let answer = serde_json::json!({
                            "msg_type": "agent.attach",
                            "id": parsed.get("id").cloned().unwrap_or(serde_json::Value::Null),
                            "timestamp": current_timestamp(),
                            "payload": parsed
                                .get("payload")
                                .cloned()
                                .unwrap_or(serde_json::Value::Null),
                        });
                        if sink
                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                answer.to_string(),
                            ))
                            .await
                            .is_err()
                        {
                            return;
                        }
                        if tx.send(parsed).is_err() {
                            return;
                        }
                        break;
                    }
                }

                // The terminal, running whether or not anyone is watching. Each
                // frame is a fresh chunk so no layer can deduplicate it, and the
                // loop ends only when the write fails — which is the Server
                // having closed the connection under it.
                let chunk = "t".repeat(chunk_bytes);
                loop {
                    let frame = serde_json::json!({
                        "msg_type": "terminal.output",
                        "id": uuid::Uuid::new_v4().to_string(),
                        "timestamp": current_timestamp(),
                        "payload": { "session_name": "dev", "data": chunk },
                    });
                    counter.fetch_add(1, Ordering::SeqCst);
                    if sink
                        .send(tokio_tungstenite::tungstenite::Message::Text(
                            frame.to_string(),
                        ))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            });
        }
    });

    Ok((MockAgentEndpoint { addr, frames }, offered))
}

/// The next frame of a given type the endpoint received, skipping others.
async fn expect_frame_of_type(
    frames: &mut tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
    msg_type: &str,
    within: std::time::Duration,
) -> anyhow::Result<serde_json::Value> {
    let deadline = tokio::time::Instant::now() + within;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        anyhow::ensure!(
            !remaining.is_zero(),
            "the agent never received a {msg_type} frame"
        );
        match tokio::time::timeout(remaining, frames.recv()).await {
            Ok(Some(frame))
                if frame.get("msg_type").and_then(serde_json::Value::as_str) == Some(msg_type) =>
            {
                return Ok(frame)
            }
            Ok(Some(_)) => {}
            Ok(None) => anyhow::bail!("the endpoint's frame channel closed"),
            Err(_) => anyhow::bail!("the agent never received a {msg_type} frame"),
        }
    }
}

/// Assert that nothing replying to `id` arrives within `window`.
///
/// The negative half of an ordering claim, and safe in that direction: it can
/// only go red when the Server starts answering what it did not answer before.
/// Frames that are not replies are skipped, because an authenticated client is
/// pushed session and agent changes.
async fn no_reply_for(
    ws: &mut TestWs,
    id: &str,
    window: std::time::Duration,
) -> anyhow::Result<()> {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Ok(());
        }
        match tokio::time::timeout(remaining, ws.next()).await {
            Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text)))) => {
                let parsed: serde_json::Value = serde_json::from_str(&text)?;
                anyhow::ensure!(
                    parsed.get("id").and_then(serde_json::Value::as_str) != Some(id),
                    "the server answered {id} on a connection the relay owns: {parsed}"
                );
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => return Err(e.into()),
            Ok(None) => anyhow::bail!("connection closed while checking that {id} went unanswered"),
            Err(_) => return Ok(()),
        }
    }
}

/// What an agent sends when a session appears on it. Sessions reach the
/// registry this way, and `relay.begin` refuses a session that is not there.
fn session_update(agent_id: &str, session_name: &str) -> serde_json::Value {
    serde_json::json!({
        "msg_type": "server.agent.session-update",
        "id": format!("update-{session_name}"),
        "timestamp": current_timestamp(),
        "payload": {
            "agent_id": agent_id,
            "session_name": session_name,
            "status": "active",
            "window_count": 1,
            "attached_clients": 0,
        },
    })
}

/// Wait until the Server's session list carries `session_id`.
///
/// A session reaches the registry through the agent's own report, on a
/// *different* connection from the client that wants to relay to one, and that
/// report is unacknowledged — so there is no ordering to lean on and this is a
/// poll rather than a barrier. It is a wait for a settled fact, not a latency
/// budget: `relay.begin` refuses a session the registry does not have, so the
/// failure it guards against is an absent session, never a late one.
async fn wait_for_session(client: &mut TestWs, session_id: &str) -> anyhow::Result<()> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut attempt = 0usize;

    loop {
        let probe = format!("session-probe-{attempt}");
        attempt += 1;
        send_json(client, session_list_request(&probe)).await?;
        let replies = replies_in_arrival_order(client, &[&probe]).await?;
        let payload = replies
            .first()
            .and_then(|reply| reply.get("payload"))
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let listed = payload
            .get("sessions")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|sessions| {
                sessions.iter().any(|session| {
                    session
                        .get("session_id")
                        .and_then(serde_json::Value::as_str)
                        == Some(session_id)
                })
            });

        if listed {
            return Ok(());
        }
        anyhow::ensure!(
            tokio::time::Instant::now() < deadline,
            "the agent's session {session_id} never reached the registry: {payload}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

/// While the relay is on, the connection's frames belong to it.
///
/// This is the "relay mode entered" edge case, and what it characterizes is
/// stronger than the requirement asks for: it is not that the ordinary
/// dispatcher is kept from *competing* for these frames, it is that there is no
/// dispatcher on this connection at all while the mode is on. `relay.begin`
/// hands the read half of the socket to `relay_bidirectional_via_channel`, so
/// `handle_ws_stream` is parked inside the relay until the relay returns — and
/// a unit the Server itself serves, sent meanwhile, is forwarded to the agent
/// like any other frame.
///
/// The witness is positive: the agent *has* the frame. The negative half (the
/// client was answered nothing for it) is what makes this about ownership
/// rather than about a slow Server.
///
/// **Must not flip.** `#961-B`/`#961-C` restructure this loop into a reader
/// plus lanes, and the mode transition is exactly what has to keep the relay's
/// exclusivity when they do. A red here means a frame was dispatched by the
/// Server while the relay believed it owned the connection — which is the
/// "mode transition" invariant the requirement lists as connection-ordered.
#[tokio::test]
async fn relay_mode_owns_the_connections_frames_until_it_ends() -> anyhow::Result<()> {
    let (_db_dir, addr, _handle) = start_ownership_server("test_ws_relay_lane.db").await?;
    let mut endpoint = start_mock_agent_endpoint().await?;

    // The agent: a control connection the Server sees, and an endpoint it will
    // dial.
    let mut agent = connect_agent_on_port(addr, "a1", endpoint.addr.port()).await?;
    send_json(&mut agent, session_update("a1", "dev")).await?;

    let mut client = connect_client(addr).await?;
    wait_for_session(&mut client, "a1:dev").await?;
    send_json(
        &mut client,
        serde_json::json!({
            "msg_type": "server.session.relay.begin",
            "id": "begin-1",
            "timestamp": current_timestamp(),
            "payload": { "session_id": "a1:dev", "cols": 80, "rows": 24 },
        }),
    )
    .await?;

    // The Server dials the agent and asks it to attach. Nothing is forwarded
    // until that answer arrives, so this frame is also the proof the relay is
    // live before the frame below is sent.
    let attach = expect_frame_of_type(
        &mut endpoint.frames,
        "agent.attach",
        std::time::Duration::from_secs(5),
    )
    .await?;
    assert_eq!(attach["payload"]["session_name"], serde_json::json!("dev"));

    // A unit the *Server* serves, written during relay mode: it goes to the
    // agent, which is the whole point.
    send_json(&mut client, session_list_request("in-relay-1")).await?;
    let forwarded = expect_frame_of_type(
        &mut endpoint.frames,
        "server.session.list",
        std::time::Duration::from_secs(5),
    )
    .await?;
    assert_eq!(forwarded["id"], serde_json::json!("in-relay-1"));
    no_reply_for(
        &mut client,
        "in-relay-1",
        std::time::Duration::from_millis(500),
    )
    .await?;

    // And the transition back: `relay.end` returns the connection to the
    // ordinary dispatcher, so the same request is now answered by the Server.
    send_json(
        &mut client,
        serde_json::json!({
            "msg_type": "server.session.relay.end",
            "id": "end-2",
            "timestamp": current_timestamp(),
            "payload": { "session_id": "a1:dev" },
        }),
    )
    .await?;
    send_json(&mut client, session_list_request("after-relay-3")).await?;
    let replies = replies_in_arrival_order(&mut client, &["after-relay-3"]).await?;
    assert_eq!(replies[0]["msg_type"], "server.session.list");
    anyhow::ensure!(
        replies[0]["payload"]["sessions"].is_array(),
        "the frame written after the relay ended was not dispatched: {}",
        replies[0]
    );
    Ok(())
}

/// A terminal client that stops draining is closed, not buffered for (#961-B).
///
/// This is the terminal lane's own policy, and the lane is the one that cannot
/// borrow the reply lane's answer: terminal bytes cannot be dropped (the screen
/// would drift from the session) and cannot be buffered without bound (that is
/// the queue this stage replaced). What is left is a verdict — the relay
/// forwards while there is room, and a client that has not taken the queue's
/// worth within the stall grace is not attached in any useful sense. The Server
/// ends the relay and closes the connection; the client re-attaches, which is
/// where a redrawn screen comes from.
///
/// The agent here never stops producing: its loop ends only when a write fails,
/// so "the connection ended" cannot be explained by the agent finishing or
/// hanging up. What ended it is the policy.
///
/// Three things are asserted, and they are three views of the same fact:
///
/// * the **agent's own writes stop** — the Server closed that connection too, so
///   the busy producer is paused while nothing else changes. This is the
///   backpressure the bound exists to send, and it is the witness that the
///   verdict landed (`offered` stops moving);
/// * the client, reading at last, **finds the connection closed** — the Server
///   ended it while the client had detached nothing and the agent was still
///   writing;
/// * everything the client eventually reads is **within the queue's bound plus
///   socket buffers** — the Server never accumulated more than the bound for a
///   peer that was not reading it.
#[tokio::test]
async fn a_terminal_client_that_stops_draining_is_closed_by_the_bound() -> anyhow::Result<()> {
    use nession_server::server::outbound::OUTBOUND_BYTE_BUDGET;
    use tokio_tungstenite::tungstenite::Message;

    const CHUNK_BYTES: usize = 64 * 1024;
    /// Short enough to reach in a test, and it changes only *when* the verdict
    /// comes: the queue's bound still has to be reached first, which is what the
    /// client not reading arranges.
    const STALL_GRACE_SECS: u64 = 1;
    /// What the queue cannot hold and the two sockets can. Generous on purpose:
    /// the claim being tested is that the Server's own accumulation is bounded
    /// by its queue, not that a kernel buffer has a particular size.
    const SOCKET_SLACK_BYTES: usize = 4 * 1024 * 1024;

    let (_db_dir, addr, _handle) =
        start_ownership_server_with_grace("test_ws_relay_stall.db", STALL_GRACE_SECS).await?;
    let (mut endpoint, offered) = start_streaming_mock_agent_endpoint(CHUNK_BYTES).await?;

    let mut agent = connect_agent_on_port(addr, "a1", endpoint.addr.port()).await?;
    send_json(&mut agent, session_update("a1", "dev")).await?;

    let mut client = connect_client(addr).await?;
    wait_for_session(&mut client, "a1:dev").await?;
    send_json(
        &mut client,
        serde_json::json!({
            "msg_type": "server.session.relay.begin",
            "id": "begin-1",
            "timestamp": current_timestamp(),
            "payload": { "session_id": "a1:dev", "cols": 80, "rows": 24 },
        }),
    )
    .await?;

    // The relay is live: the Server has dialled the agent and been told the
    // attach succeeded, which is also the start of the stream.
    expect_frame_of_type(
        &mut endpoint.frames,
        "agent.attach",
        std::time::Duration::from_secs(5),
    )
    .await?;

    // From here the client reads nothing at all. The witness that the verdict
    // has landed is on the agent's side, where nothing else can be happening:
    // the Server closed that connection, so the streaming write fails and the
    // frames the agent has offered stop moving.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut last = offered.load(Ordering::SeqCst);
    let mut held_since = tokio::time::Instant::now();
    while held_since.elapsed() < std::time::Duration::from_secs(2) {
        anyhow::ensure!(
            tokio::time::Instant::now() < deadline,
            "the agent's stream never stopped: the Server kept taking terminal output \
             ({last} frame(s) offered) from a client that was not draining it"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let now = offered.load(Ordering::SeqCst);
        if now != last {
            last = now;
            held_since = tokio::time::Instant::now();
        }
    }
    let offered_bytes = last.saturating_mul(CHUNK_BYTES);
    anyhow::ensure!(
        offered_bytes > 0,
        "the agent never streamed anything, so nothing was ever under pressure"
    );

    // Reading at last: what the client finds is the end of the connection, with
    // whatever was queued for it still in front of it. The deadline is absolute
    // rather than per-frame: the agent in this test produces without end, so a
    // verdict that never came would be an endless stream of frames to read, not
    // a quiet socket.
    let mut received_bytes = 0usize;
    let read_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    let ended = loop {
        let remaining = read_deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break false;
        }
        match tokio::time::timeout(remaining, client.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => received_bytes += text.len(),
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) => break true,
            Ok(Some(Err(_))) => break true,
            Ok(Some(Ok(_))) => {}
            Err(_) => break false,
        }
    };
    assert!(
        ended,
        "the Server never closed the connection of a terminal client that stopped \
         draining (it read {received_bytes} byte(s) and is still open)"
    );
    assert!(
        received_bytes <= OUTBOUND_BYTE_BUDGET + SOCKET_SLACK_BYTES,
        "the Server held {received_bytes} byte(s) for a client that was not reading — \
         more than the {OUTBOUND_BYTE_BUDGET}-byte bound plus {SOCKET_SLACK_BYTES} of \
         socket buffers"
    );
    Ok(())
}
