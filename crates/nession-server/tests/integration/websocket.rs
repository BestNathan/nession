use futures_util::{SinkExt, StreamExt};
use nession_server::db::Database;
use nession_server::server::WebSocketServer;
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

/// A server for these tests: no TLS, a known token, default heartbeat cadence.
async fn start_ownership_server(db_name: &str) -> anyhow::Result<OwnershipServer> {
    let (db_dir, db_path) = test_db(db_name)?;
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
    serde_json::json!({
        "agent_id": agent_id,
        "hostname": "test_host",
        "ip_address": "127.0.0.1",
        "port": 8080,
        "auth_token": "test_token",
        "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
        "metadata": {"tmux_version": "3.3a", "os_version": "Linux", "nession_version": "0.1.0"},
    })
}

/// Connect as an agent and register `agent_id` on the connection, returning it
/// once the server has accepted — a live agent control connection.
async fn connect_agent(addr: std::net::SocketAddr, agent_id: &str) -> anyhow::Result<TestWs> {
    let (mut ws, _) = connect_async(format!("ws://{addr}")).await?;
    send_json(
        &mut ws,
        serde_json::json!({
            "msg_type": "server.agent.register",
            "id": format!("register-{agent_id}"),
            "timestamp": current_timestamp(),
            "payload": register_payload(agent_id),
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
