//! End-to-end integration tests for the nession agent system.
//!
//! These tests verify the agent works correctly as a complete system:
//! - Full registration flow with central server
//! - Session management through agent
//! - Client P2P connections to agent
//! - Terminal I/O through the full chain
//! - Heartbeat and session sync between agent and server
//! - Graceful shutdown

use futures_util::{SinkExt, StreamExt};
use nession_agent::config::AttachMode;
use nession_agent::connection::ServerClient;
use nession_agent::server::websocket::{
    msg_types as agent_msg_types, new_message, AgentServer, ClientAttachPayload,
    ClientDetachPayload, SessionCreatePayload, SessionKillPayload,
};
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
// Test Helpers
// ---------------------------------------------------------------------------

/// Start a real nession-server on a random port and return its address.
async fn start_test_server(
    auth_token: &str,
) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>, String) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let id = COUNTER.fetch_add(1, Ordering::Relaxed);
    let db_path = std::env::temp_dir()
        .join(format!(
            "nession_test_e2e_{}_{}.db",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            id
        ))
        .to_string_lossy()
        .into_owned();

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

    // Give the server time to start accepting connections.
    tokio::time::sleep(Duration::from_millis(100)).await;

    (addr, handle, db_path)
}

/// Remove a test database and its SQLite WAL/SHM sidecar files.
///
/// WAL mode leaves `-wal`/`-shm` files next to the main `.db`; deleting only
/// the main file leaves them behind as stray artifacts.
async fn cleanup_db(db_path: &str) {
    tokio::fs::remove_file(db_path).await.ok();
    tokio::fs::remove_file(format!("{db_path}-wal")).await.ok();
    tokio::fs::remove_file(format!("{db_path}-shm")).await.ok();
}

/// Start a real agent WebSocket server on a specific port.
async fn start_test_agent_server() -> (std::net::SocketAddr, nession_agent::server::ServerHandle) {
    use std::sync::atomic::{AtomicU16, Ordering};
    static PORT_COUNTER: AtomicU16 = AtomicU16::new(40000);
    let port = PORT_COUNTER.fetch_add(1, Ordering::Relaxed);
    let addr_str = format!("127.0.0.1:{}", port);

    let tmp = Box::leak(Box::new(tempfile::tempdir().expect("tempdir")));
    let server = AgentServer::new(
        &addr_str,
        "test-agent",
        None,
        "/tmp".to_string(),
        tmp.path().to_string_lossy().as_ref(),
        AttachMode::Plain,
    )
    .expect("server creation should succeed");
    let handle = server.start().await.expect("start should succeed");
    tokio::time::sleep(Duration::from_millis(50)).await;

    let addr = addr_str.parse().unwrap();
    (addr, handle)
}

/// Connect to central server and register an agent, returning the handle.
async fn register_agent_with_server(
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
        format!("ws://{}", server_addr),
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
    );

    client
        .connect_and_run()
        .await
        .expect("agent registration failed")
        .0
}

// ---------------------------------------------------------------------------
// 1. Full Agent-Server Integration
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_full_agent_server_integration() {
    // Start a real central server.
    let (server_addr, server_handle, db_path) = start_test_server("test-token").await;

    // Start a real agent server.
    let (agent_addr, agent_server_handle) = start_test_agent_server().await;

    // Register agent with central server.
    let client_handle =
        register_agent_with_server(server_addr, "e2e-agent-1", "test-token", agent_addr.port())
            .await;

    // Give it time to register.
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Start heartbeat loop.
    let heartbeat = HeartbeatLoop::new(
        client_handle.clone(),
        SessionManager::new(),
        1, // 1 second for testing
    );
    let heartbeat_shutdown = heartbeat.shutdown_handle();
    tokio::spawn(async move {
        let _ = heartbeat.run().await;
    });

    // Wait for a heartbeat to be sent.
    tokio::time::sleep(Duration::from_millis(1500)).await;

    // Clean shutdown.
    heartbeat_shutdown.shutdown().await.ok();
    client_handle.shutdown().await.ok();
    agent_server_handle.shutdown().await.ok();
    server_handle.abort();

    // Clean up database.
    cleanup_db(&db_path).await;
}

// ---------------------------------------------------------------------------
// 2. Client Connects to Agent via P2P
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_client_connects_to_agent_via_p2p() {
    // Start agent server.
    let (agent_addr, agent_handle) = start_test_agent_server().await;

    // Connect a client directly to the agent.
    let url = format!("ws://{}", agent_addr);
    let (ws, _) = connect_async(&url).await.expect("client connection failed");
    let (mut sink, mut stream) = ws.split();

    // Send a session.list request.
    let req = new_message(agent_msg_types::SESSION_LIST, serde_json::json!({}));
    let json = serde_json::to_string(&req).unwrap();
    sink.send(WsMessage::Text(json)).await.unwrap();

    // Wait for response.
    let response = tokio::time::timeout(Duration::from_secs(2), stream.next())
        .await
        .expect("timeout waiting for response")
        .expect("stream ended")
        .expect("websocket error");

    if let WsMessage::Text(text) = response {
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["msg_type"], agent_msg_types::OK);
        assert!(parsed["payload"]["sessions"].is_array());
    } else {
        panic!("Expected text message");
    }

    agent_handle.shutdown().await.ok();
}

// ---------------------------------------------------------------------------
// 3. Terminal I/O Through Full Chain
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_terminal_io_through_full_chain() {
    let tmux = SessionManager::new();
    let session_name = "e2e_terminal_io";

    // Create a tmux session.
    tmux.create_session(session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    // Start agent server.
    let (agent_addr, agent_handle) = start_test_agent_server().await;

    // Connect client.
    let url = format!("ws://{}", agent_addr);
    let (ws, _) = connect_async(&url).await.expect("connection failed");
    let (mut sink, mut stream) = ws.split();

    // Attach to session.
    let attach = ClientAttachPayload {
        session_name: session_name.to_string(),
        width: 80,
        height: 24,
        env_snapshots: Vec::new(),
    };
    let req = new_message(agent_msg_types::CLIENT_ATTACH, attach);
    let json = serde_json::to_string(&req).unwrap();
    sink.send(WsMessage::Text(json)).await.unwrap();

    // Wait for attach response.  The agent may send terminal.output
    // (scrollback capture) and terminal.resize (initial size query) before
    // the ok response.  Read until we see ok.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let response = tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .expect("timeout waiting for attach response")
            .expect("stream ended")
            .expect("error reading attach response");

        if let WsMessage::Text(text) = response {
            let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
            let msg_type = parsed["msg_type"].as_str().unwrap_or("");
            if msg_type == agent_msg_types::OK {
                break;
            }
            // Skip scrollback capture and initial resize messages.
        }
        if tokio::time::Instant::now() > deadline {
            panic!("timed out waiting for ok response to client.attach");
        }
    }

    // Give output reader time to start.
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Send terminal input.
    use base64::Engine;
    let input = base64::engine::general_purpose::STANDARD.encode(b"echo test123\n");
    let payload = nession_agent::server::websocket::TerminalInputPayload {
        session_name: session_name.to_string(),
        data: input,
    };
    let req = new_message(agent_msg_types::TERMINAL_INPUT, payload);
    let json = serde_json::to_string(&req).unwrap();
    sink.send(WsMessage::Text(json)).await.unwrap();

    // Wait for terminal output.
    tokio::time::sleep(Duration::from_millis(1000)).await;

    let mut got_output = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), stream.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let msg: nession_agent::server::websocket::Message<serde_json::Value> =
                    serde_json::from_str(&text).unwrap();
                if msg.msg_type == agent_msg_types::TERMINAL_OUTPUT {
                    let b64 = msg.payload.get("data").unwrap().as_str().unwrap();
                    let decoded = base64::engine::general_purpose::STANDARD
                        .decode(b64)
                        .unwrap();
                    if String::from_utf8_lossy(&decoded).contains("test123") {
                        got_output = true;
                        break;
                    }
                }
            }
            _ => break,
        }
    }

    // Detach.
    let detach = ClientDetachPayload {
        session_name: session_name.to_string(),
    };
    let req = new_message(agent_msg_types::CLIENT_DETACH, detach);
    let json = serde_json::to_string(&req).unwrap();
    sink.send(WsMessage::Text(json)).await.unwrap();

    // Clean up.
    tmux.kill_session(session_name).await.ok();
    agent_handle.shutdown().await.ok();

    assert!(got_output, "expected terminal output containing 'test123'");
}

// ---------------------------------------------------------------------------
// 4. Session Lifecycle
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_session_lifecycle() {
    let _tmux = SessionManager::new();

    // Start agent server.
    let (agent_addr, agent_handle) = start_test_agent_server().await;

    // Connect client.
    let url = format!("ws://{}", agent_addr);
    let (ws, _) = connect_async(&url).await.expect("connection failed");
    let (mut sink, mut stream) = ws.split();

    // Create a session.
    let session_name = "e2e_lifecycle";
    let create = SessionCreatePayload {
        name: session_name.to_string(),
        width: 80,
        height: 24,
    };
    let req = new_message(agent_msg_types::SESSION_CREATE, create);
    let json = serde_json::to_string(&req).unwrap();
    sink.send(WsMessage::Text(json)).await.unwrap();

    // Wait for response.
    let response = tokio::time::timeout(Duration::from_secs(2), stream.next())
        .await
        .expect("timeout")
        .expect("stream ended")
        .expect("error");

    if let WsMessage::Text(text) = response {
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["msg_type"], agent_msg_types::OK);
    }

    // List sessions.
    let req = new_message(agent_msg_types::SESSION_LIST, serde_json::json!({}));
    let json = serde_json::to_string(&req).unwrap();
    sink.send(WsMessage::Text(json)).await.unwrap();

    let response = tokio::time::timeout(Duration::from_secs(2), stream.next())
        .await
        .expect("timeout")
        .expect("stream ended")
        .expect("error");

    if let WsMessage::Text(text) = response {
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["msg_type"], agent_msg_types::OK);
        let sessions = parsed["payload"]["sessions"].as_array().unwrap();
        assert!(sessions.iter().any(|s| s["name"] == session_name));
    }

    // Kill the session.
    let kill = SessionKillPayload {
        name: session_name.to_string(),
    };
    let req = new_message(agent_msg_types::SESSION_KILL, kill);
    let json = serde_json::to_string(&req).unwrap();
    sink.send(WsMessage::Text(json)).await.unwrap();

    let response = tokio::time::timeout(Duration::from_secs(2), stream.next())
        .await
        .expect("timeout")
        .expect("stream ended")
        .expect("error");

    if let WsMessage::Text(text) = response {
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["msg_type"], agent_msg_types::OK);
    }

    agent_handle.shutdown().await.ok();
}

// ---------------------------------------------------------------------------
// 5. Agent Reconnects After Server Restart
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_agent_reconnects_after_server_restart() {
    let (server_addr1, server_handle1, db_path1) = start_test_server("reconnect-token").await;

    // Start agent server.
    let (agent_addr, agent_handle) = start_test_agent_server().await;

    // Register with first server.
    let client_handle = register_agent_with_server(
        server_addr1,
        "reconnect-agent",
        "reconnect-token",
        agent_addr.port(),
    )
    .await;

    tokio::time::sleep(Duration::from_millis(200)).await;

    // Kill the first server.
    server_handle1.abort();
    cleanup_db(&db_path1).await;

    // Start a new server on a different port.
    let (server_addr2, server_handle2, db_path2) = start_test_server("reconnect-token").await;

    // The agent's ServerClient has automatic reconnection, but we need to manually
    // reconnect for this test since we changed server addresses.
    client_handle.shutdown().await.ok();
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Reconnect to new server.
    let client_handle2 = register_agent_with_server(
        server_addr2,
        "reconnect-agent",
        "reconnect-token",
        agent_addr.port(),
    )
    .await;

    tokio::time::sleep(Duration::from_millis(200)).await;

    // Clean up.
    client_handle2.shutdown().await.ok();
    agent_handle.shutdown().await.ok();
    server_handle2.abort();
    cleanup_db(&db_path2).await;
}

// ---------------------------------------------------------------------------
// 6. Multiple Agents Register
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_multiple_agents_register() {
    let (server_addr, server_handle, db_path) = start_test_server("multi-token").await;

    // Start multiple agent servers.
    let (agent_addr1, agent_handle1) = start_test_agent_server().await;
    let (agent_addr2, agent_handle2) = start_test_agent_server().await;
    let (agent_addr3, agent_handle3) = start_test_agent_server().await;

    // Register all agents.
    let handle1 = register_agent_with_server(
        server_addr,
        "multi-agent-1",
        "multi-token",
        agent_addr1.port(),
    )
    .await;

    let handle2 = register_agent_with_server(
        server_addr,
        "multi-agent-2",
        "multi-token",
        agent_addr2.port(),
    )
    .await;

    let handle3 = register_agent_with_server(
        server_addr,
        "multi-agent-3",
        "multi-token",
        agent_addr3.port(),
    )
    .await;

    tokio::time::sleep(Duration::from_millis(300)).await;

    // All agents should be registered (we can't easily verify this without
    // querying the server, but the test ensures no errors occur).

    // Clean up.
    handle1.shutdown().await.ok();
    handle2.shutdown().await.ok();
    handle3.shutdown().await.ok();
    agent_handle1.shutdown().await.ok();
    agent_handle2.shutdown().await.ok();
    agent_handle3.shutdown().await.ok();
    server_handle.abort();
    cleanup_db(&db_path).await;
}

// ---------------------------------------------------------------------------
// 7. Graceful Shutdown
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_graceful_shutdown() {
    let (server_addr, server_handle, db_path) = start_test_server("shutdown-token").await;
    let (agent_addr, agent_handle) = start_test_agent_server().await;

    // Register agent.
    let client_handle = register_agent_with_server(
        server_addr,
        "shutdown-agent",
        "shutdown-token",
        agent_addr.port(),
    )
    .await;

    // Start heartbeat.
    let heartbeat = HeartbeatLoop::new(client_handle.clone(), SessionManager::new(), 10);
    let heartbeat_shutdown = heartbeat.shutdown_handle();
    tokio::spawn(async move {
        let _ = heartbeat.run().await;
    });

    // Start session watcher.
    let watcher = SessionWatcher::new(client_handle.clone(), SessionManager::new(), 5);
    let watcher_shutdown = watcher.shutdown_handle();
    tokio::spawn(async move {
        let _ = watcher.run().await;
    });

    tokio::time::sleep(Duration::from_millis(200)).await;

    // Send shutdown signals in reverse order.
    watcher_shutdown.shutdown().await.ok();
    heartbeat_shutdown.shutdown().await.ok();
    client_handle.shutdown().await.ok();
    agent_handle.shutdown().await.ok();
    server_handle.abort();

    // Give everything time to shut down cleanly.
    tokio::time::sleep(Duration::from_millis(100)).await;

    cleanup_db(&db_path).await;
}
