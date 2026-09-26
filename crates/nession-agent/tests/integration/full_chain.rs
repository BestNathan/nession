//! End-to-end integration tests for the nession agent system.
//!
//! These tests verify the agent works correctly as a complete system:
//! - Full registration flow with central server
//! - Session management through agent
//! - Client P2P connections to agent
//! - Terminal I/O through the full chain
//! - Heartbeat and session sync between agent and server
//! - Graceful shutdown

use super::{
    browser_scope, connect, connect_for, mint_credential, TestSession, TEST_AGENT_ID,
    TEST_CREDENTIAL,
};
use futures_util::{SinkExt, StreamExt};
use nession_agent::config::AttachMode;
use nession_agent::connection::ServerClient;
use nession_agent::p2p_credentials::P2pCredentials;
use nession_agent::server::websocket::{
    msg_types as agent_msg_types, new_message, AgentServer, AgentServerContext,
    ClientAttachPayload, ClientDetachPayload, SessionCreatePayload, SessionKillPayload,
};
use nession_agent::sync::heartbeat::HeartbeatLoop;
use nession_agent::sync::session_watcher::SessionWatcher;
use nession_agent::tmux::manager::SessionManager;
use nession_common::config::ServerConfig;
use nession_protocol::contracts::agent::v1::AgentMetadata;
use nession_server::db::Database;
use nession_server::server::WebSocketServer;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message as WsMessage;

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/// Start a real nession-server on a random port and return its address.
/// The database lives in its own `TempDir`, returned so the caller keeps it
/// alive; dropping it removes the `.db` and its WAL/SHM sidecars. The previous
/// name — `temp_dir()/<prefix>_<unix_secs>_<counter>.db` — collided between
/// concurrent test runs: two processes starting in the same second both begin
/// their counter at 0, so they opened the *same* SQLite file and failed with
/// "database is locked" or "UNIQUE constraint failed: seaql_migrations.version".
async fn start_test_server(
    auth_token: &str,
) -> anyhow::Result<(
    std::net::SocketAddr,
    tokio::task::JoinHandle<()>,
    tempfile::TempDir,
)> {
    let db_dir = tempfile::tempdir()?;
    let db_path = db_dir
        .path()
        .join("server.db")
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
        ..Default::default()
    };

    let db = Database::new(&db_path).await?;
    let mut server = WebSocketServer::new(config, Arc::new(db)).await?;
    let addr = server.local_addr()?;

    let handle = tokio::spawn(async move {
        let _ = server
            .run(nession_common::readiness::Readiness::Unwatched)
            .await;
    });

    // Give the server time to start accepting connections.
    tokio::time::sleep(Duration::from_millis(100)).await;

    Ok((addr, handle, db_dir))
}

/// Start a real agent WebSocket server on an OS-assigned port.
/// Read half of a connected client, named so a helper can take one.
type WsStreamHalf = futures_util::stream::SplitStream<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
>;

/// The next text frame, or a panic naming what it was waiting for.
///
/// A **deadline rather than a single timeout**, because every wait this
/// replaces is for an *external process* to answer: `tmux new-session` spawns a
/// server and a pane, and `list-sessions` and `kill-session` round-trip through
/// it. A bare two-second timeout on that is not an assertion about the
/// lifecycle — it is a bet on how loaded the machine is, and it loses under an
/// instrumented `just coverage` run. Measured 2026-09-24: three failures in one
/// session, each passing on an immediate re-run of the identical tree, twice
/// blocking a push.
///
/// Five seconds is not a new tolerance. It is the one the rest of this file
/// already uses for exactly this kind of wait — the attach response and the
/// terminal-output poll both run a five-second deadline — so this applies the
/// file's own rule to three waits that had been given a tighter one for no
/// stated reason. The assertions are on the reply's *contents*; the deadline
/// was never the subject.
///
/// It also refuses to skip the assertion. The call sites this replaces wrapped
/// their check in `if let WsMessage::Text(text)`, so a non-text frame arriving
/// first made the assertion silently not run and the test pass — which is a
/// worse failure than the timeout it was hiding.
async fn next_text_frame(stream: &mut WsStreamHalf, what: &str) -> String {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        match tokio::time::timeout(Duration::from_millis(500), stream.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => return text,
            // Ping, Pong and Binary are not the reply; keep waiting for it.
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => panic!("error while waiting for {what}: {e}"),
            Ok(None) => panic!("stream ended while waiting for {what}"),
            Err(_) if tokio::time::Instant::now() >= deadline => {
                panic!("timed out waiting for {what}")
            }
            Err(_) => {}
        }
    }
}

/// Start a real agent WebSocket server on an OS-assigned port, and mint the
/// broad credential its listener honours.
///
/// The **store** comes back with the address, not the credential string: a dial
/// that has to name a session (the terminal wires, #1013) can only mint its
/// credential once the test has generated that name — see [`connect_for`]. It is
/// the same `Arc` the listener holds.
async fn start_test_agent_server() -> anyhow::Result<(
    std::net::SocketAddr,
    nession_agent::server::ServerHandle,
    Arc<P2pCredentials>,
)> {
    let tmp = Box::leak(Box::new(tempfile::tempdir()?));
    // Nothing drains this connection's resize lane, which is the point of the
    // lane: an unread resize costs one superseded value per session.
    let (resize, _resize_updates) = nession_agent::server::ResizeReporter::new();
    // Granted into before it is handed to the listener — see [`mint_credential`].
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
        },
    )?;
    let (handle, addr) = server.start().await?;

    Ok((addr, handle, credentials))
}

/// Connect to central server and register an agent, returning the handle.
async fn register_agent_with_server(
    server_addr: std::net::SocketAddr,
    agent_id: &str,
    auth_token: &str,
    agent_port: u16,
) -> anyhow::Result<nession_agent::connection::ServerClientHandle> {
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
        // A real registry: this chain goes through a real nession-server, which
        // refuses a registration with no manifest. `served_descriptors` is what
        // `main` composes, so this chain carries the manifest an agent really
        // sends rather than a subset of it.
        Some(Arc::new(nession_agent::extension::ExtensionRegistry::new(
            agent_id,
            Vec::new(),
            nession_agent::protocol::served_descriptors()?,
        )?)),
        Arc::new(nession_agent::p2p_credentials::P2pCredentials::new()),
    );

    Ok(client.connect_and_run().await?.0)
}

// ---------------------------------------------------------------------------
// 1. Full Agent-Server Integration
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_full_agent_server_integration() {
    // Start a real central server.
    let (server_addr, server_handle, _db_dir) = start_test_server("test-token").await.unwrap();

    // Start a real agent server.
    let (agent_addr, agent_handle, _) = start_test_agent_server().await.unwrap();

    // Register agent with central server.
    let client_handle =
        register_agent_with_server(server_addr, "e2e-agent-1", "test-token", agent_addr.port())
            .await
            .unwrap();

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
    agent_handle.shutdown().await.ok();
    server_handle.abort();

    // Clean up database.
}

// ---------------------------------------------------------------------------
// 2. Client Connects to Agent via P2P
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_client_connects_to_agent_via_p2p() {
    // Start agent server.
    let (agent_addr, agent_handle, credentials) = start_test_agent_server().await.unwrap();

    // Connect a client directly to the agent.
    let (mut sink, mut stream) = connect(&credentials, agent_addr).await.unwrap();

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
    let session = TestSession::new("e2e-io");
    let session_name = session.name().to_string();

    // Create a tmux session.
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    // Start agent server.
    let (agent_addr, agent_handle, credentials) = start_test_agent_server().await.unwrap();

    // The dial comes after the session does: the credential it presents is bound
    // to `session_name`, which is generated per run.
    let (mut sink, mut stream) = connect_for(&credentials, agent_addr, &session_name)
        .await
        .unwrap();

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

    // Send terminal input immediately — post-attach sleep breaks macOS PTY writes.
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
    tmux.kill_session(&session_name).await.ok();
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
    let (agent_addr, agent_handle, credentials) = start_test_agent_server().await.unwrap();

    // Connect client.
    let (mut sink, mut stream) = connect(&credentials, agent_addr).await.unwrap();

    // Create a session.
    let session = TestSession::new("e2e-lifecycle");
    let session_name = session.name().to_string();
    let create = SessionCreatePayload {
        name: session_name.to_string(),
        width: 80,
        height: 24,
        env_snapshots: Vec::new(),
    };
    let req = new_message(agent_msg_types::SESSION_CREATE, create);
    let json = serde_json::to_string(&req).unwrap();
    sink.send(WsMessage::Text(json)).await.unwrap();

    // Wait for response.
    let text = next_text_frame(&mut stream, "the create-session reply").await;
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["msg_type"], agent_msg_types::OK);

    // List sessions.
    let req = new_message(agent_msg_types::SESSION_LIST, serde_json::json!({}));
    let json = serde_json::to_string(&req).unwrap();
    sink.send(WsMessage::Text(json)).await.unwrap();

    let text = next_text_frame(&mut stream, "the session-list reply").await;
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["msg_type"], agent_msg_types::OK);
    let sessions = parsed["payload"]["sessions"].as_array().unwrap();
    assert!(sessions.iter().any(|s| s["name"] == session_name.as_str()));

    // Kill the session.
    let kill = SessionKillPayload {
        name: session_name.to_string(),
    };
    let req = new_message(agent_msg_types::SESSION_KILL, kill);
    let json = serde_json::to_string(&req).unwrap();
    sink.send(WsMessage::Text(json)).await.unwrap();

    let text = next_text_frame(&mut stream, "the kill-session reply").await;
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["msg_type"], agent_msg_types::OK);

    agent_handle.shutdown().await.ok();
}

// ---------------------------------------------------------------------------
// 5. Agent Reconnects After Server Restart
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_agent_reconnects_after_server_restart() {
    let (server_addr1, server_handle1, db_dir1) =
        start_test_server("reconnect-token").await.unwrap();

    // Start agent server.
    let (agent_addr, agent_handle, _) = start_test_agent_server().await.unwrap();

    // Register with first server.
    let client_handle = register_agent_with_server(
        server_addr1,
        "reconnect-agent",
        "reconnect-token",
        agent_addr.port(),
    )
    .await
    .unwrap();

    tokio::time::sleep(Duration::from_millis(200)).await;

    // Kill the first server.
    server_handle1.abort();
    drop(db_dir1); // removes server 1's database, as before

    // Start a new server on a different port.
    let (server_addr2, server_handle2, _db_dir2) =
        start_test_server("reconnect-token").await.unwrap();

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
    .await
    .unwrap();

    tokio::time::sleep(Duration::from_millis(200)).await;

    // Clean up.
    client_handle2.shutdown().await.ok();
    agent_handle.shutdown().await.ok();
    server_handle2.abort();
}

// ---------------------------------------------------------------------------
// 6. Multiple Agents Register
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_multiple_agents_register() {
    let (server_addr, server_handle, _db_dir) = start_test_server("multi-token").await.unwrap();

    // Start multiple agent servers.
    let (agent_addr1, agent_handle1, _) = start_test_agent_server().await.unwrap();
    let (agent_addr2, agent_handle2, _) = start_test_agent_server().await.unwrap();
    let (agent_addr3, agent_handle3, _) = start_test_agent_server().await.unwrap();

    // Register all agents.
    let handle1 = register_agent_with_server(
        server_addr,
        "multi-agent-1",
        "multi-token",
        agent_addr1.port(),
    )
    .await
    .unwrap();

    let handle2 = register_agent_with_server(
        server_addr,
        "multi-agent-2",
        "multi-token",
        agent_addr2.port(),
    )
    .await
    .unwrap();

    let handle3 = register_agent_with_server(
        server_addr,
        "multi-agent-3",
        "multi-token",
        agent_addr3.port(),
    )
    .await
    .unwrap();

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
}

// ---------------------------------------------------------------------------
// 7. Graceful Shutdown
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_graceful_shutdown() {
    let (server_addr, server_handle, _db_dir) = start_test_server("shutdown-token").await.unwrap();
    let (agent_addr, agent_handle, _) = start_test_agent_server().await.unwrap();

    // Register agent.
    let client_handle = register_agent_with_server(
        server_addr,
        "shutdown-agent",
        "shutdown-token",
        agent_addr.port(),
    )
    .await
    .unwrap();

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
}
