//! Integration tests for the sync module (heartbeat loop and session watcher).

use super::TestSession;
use futures_util::{SinkExt, StreamExt};
use nession_agent::connection::{ServerClient, ServerClientHandle};
use nession_agent::sync::heartbeat::HeartbeatLoop;
use nession_agent::sync::session_watcher::SessionWatcher;
use nession_agent::tmux::manager::SessionManager;
use nession_common::protocol::AgentMetadata;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

/// Start a mock WebSocket server that collects incoming messages.
/// Returns a receiver that yields each text message the client sends.
async fn start_mock_server(
    port: u16,
) -> anyhow::Result<(tokio::task::JoinHandle<()>, mpsc::Receiver<String>)> {
    let (msg_tx, msg_rx) = mpsc::channel(200);
    let listener = TcpListener::bind(format!("127.0.0.1:{port}")).await?;

    let handle = tokio::spawn(async move {
        if let Ok((stream, _)) = listener.accept().await {
            let ws = accept_async(stream)
                .await
                .unwrap_or_else(|e| panic!("failed to accept ws: {e}"));
            let (mut sink, mut stream) = ws.split();

            // Send registration response.
            let response = serde_json::json!({
                "msg_type": "agent.register.response",
                "id": "test-id",
                "timestamp": 1234567890,
                "payload": {
                    "status": "accepted",
                    "message": "Registration successful"
                }
            });
            let _ = sink.send(WsMessage::Text(response.to_string())).await;

            // Forward all incoming messages to the receiver.
            while let Some(Ok(msg)) = stream.next().await {
                if let WsMessage::Text(text) = msg {
                    if msg_tx.send(text).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    Ok((handle, msg_rx))
}

/// Connect to the mock server and return a ServerClientHandle.
async fn get_handle(port: u16) -> anyhow::Result<ServerClientHandle> {
    let metadata = AgentMetadata {
        tmux_version: "3.3".to_string(),
        os_version: "Linux".to_string(),
        nession_version: "0.1.0".to_string(),
        image_tag: "test".to_string(),
    };

    let client = ServerClient::new(
        format!("ws://127.0.0.1:{port}"),
        "test-token",
        "test-agent-sync",
        "test-host",
        "127.0.0.1",
        8080,
        None,   // connect_url
        vec![], // addresses
        None,   // display_name
        metadata,
        Arc::new(SessionManager::new()),
        "/tmp".to_string(),
        None, // extension_registry
    );

    Ok(client.connect_and_run().await?.0)
}

// ---------------------------------------------------------------------------
// Heartbeat tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_heartbeat_loop_sends_heartbeat() {
    let port = 29091;
    let (server_handle, mut msg_rx) = start_mock_server(port).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    let handle = get_handle(port).await.unwrap();

    // Skip registration message.
    let _ = tokio::time::timeout(Duration::from_secs(2), msg_rx.recv())
        .await
        .expect("timeout waiting for registration");

    // Create heartbeat loop with 1-second interval.
    let tmux = SessionManager::new();
    let loop_handle = {
        let hl = HeartbeatLoop::new(handle.clone(), tmux, 1);
        let shutdown = hl.shutdown_handle();
        tokio::spawn(hl.run());
        shutdown
    };

    // Wait for a heartbeat message.
    let msg = tokio::time::timeout(Duration::from_secs(5), msg_rx.recv())
        .await
        .expect("timeout waiting for heartbeat")
        .expect("no heartbeat message");

    let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
    assert_eq!(parsed["msg_type"], "agent.heartbeat");
    assert_eq!(parsed["payload"]["agent_id"], "test-agent-sync");
    assert_eq!(parsed["payload"]["status"], "online");

    // Shut down.
    loop_handle.shutdown().await.ok();
    handle.shutdown().await.ok();
    server_handle.abort();
}

#[tokio::test]
async fn test_heartbeat_loop_respects_interval() {
    let port = 29092;
    let (server_handle, mut msg_rx) = start_mock_server(port).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    let handle = get_handle(port).await.unwrap();

    // Skip registration message.
    let _ = tokio::time::timeout(Duration::from_secs(2), msg_rx.recv())
        .await
        .expect("timeout waiting for registration");

    // Create heartbeat loop with 2-second interval.
    let tmux = SessionManager::new();
    let shutdown = {
        let hl = HeartbeatLoop::new(handle.clone(), tmux, 2);
        let sd = hl.shutdown_handle();
        tokio::spawn(hl.run());
        sd
    };

    // First heartbeat should arrive around t=1s (not the full 2s interval).
    // The heartbeat loop sends the first heartbeat after a short 1s delay
    // instead of waiting for the full interval, to reduce the window where
    // an agent is registered but hasn't heartbeated yet.
    let start = tokio::time::Instant::now();
    let _ = tokio::time::timeout(Duration::from_secs(5), msg_rx.recv())
        .await
        .expect("timeout waiting for first heartbeat");
    let first_elapsed = start.elapsed();

    // Should be at least 0.8 seconds (some tolerance for CI).
    assert!(
        first_elapsed >= Duration::from_millis(800),
        "first heartbeat came too early: {first_elapsed:?}"
    );

    // But should arrive well before the full 2s interval.
    assert!(
        first_elapsed < Duration::from_millis(1800),
        "first heartbeat came too late: {first_elapsed:?}"
    );

    shutdown.shutdown().await.ok();
    handle.shutdown().await.ok();
    server_handle.abort();
}

#[tokio::test]
async fn test_heartbeat_loop_shutdown() {
    let port = 29093;
    let (server_handle, mut msg_rx) = start_mock_server(port).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    let handle = get_handle(port).await.unwrap();

    // Skip registration.
    let _ = tokio::time::timeout(Duration::from_secs(2), msg_rx.recv()).await;

    // Use a long interval so we can verify shutdown stops the loop promptly.
    let tmux = SessionManager::new();
    let (shutdown, task) = {
        let hl = HeartbeatLoop::new(handle.clone(), tmux, 60);
        let sd = hl.shutdown_handle();
        let t = tokio::spawn(hl.run());
        (sd, t)
    };

    // Shut down immediately.
    shutdown.shutdown().await.ok();

    // The task should finish within 2 seconds.
    let result = tokio::time::timeout(Duration::from_secs(2), task).await;
    assert!(result.is_ok(), "heartbeat task did not exit after shutdown");

    handle.shutdown().await.ok();
    server_handle.abort();
}

// ---------------------------------------------------------------------------
// Session watcher tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_session_watcher_detects_new_session() {
    let port = 29094;
    let (server_handle, mut msg_rx) = start_mock_server(port).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    let handle = get_handle(port).await.unwrap();

    // Skip registration.
    let _ = tokio::time::timeout(Duration::from_secs(2), msg_rx.recv()).await;

    let tmux = SessionManager::new();
    let session = TestSession::new("watcher-new");
    let session_name = session.name().to_string();

    // Create the session before starting the watcher.
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .expect("failed to create tmux session");

    let shutdown = {
        let sw = SessionWatcher::new(handle.clone(), SessionManager::new(), 1);
        let sd = sw.shutdown_handle();
        tokio::spawn(sw.run());
        sd
    };

    // Wait for a session update message.
    let found = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(msg) = msg_rx.recv().await {
            let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
            if parsed["msg_type"] == "agent.session.update"
                && parsed["payload"]["session_name"] == session_name
            {
                return parsed;
            }
        }
        unreachable!("channel closed before session update received")
    })
    .await;

    // Clean up.
    tmux.kill_session(&session_name).await.ok();
    shutdown.shutdown().await.ok();
    handle.shutdown().await.ok();
    server_handle.abort();

    let update = found.expect("did not receive session update for new session");
    assert_eq!(update["payload"]["session_name"], session_name.as_str());
    // No clients attached, so status should be "detached".
    assert_eq!(update["payload"]["status"], "detached");
    assert_eq!(update["payload"]["window_count"], 1);
}

#[tokio::test]
async fn test_session_watcher_detects_removed_session() {
    let port = 29095;
    let (server_handle, mut msg_rx) = start_mock_server(port).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    let handle = get_handle(port).await.unwrap();

    // Skip registration.
    let _ = tokio::time::timeout(Duration::from_secs(2), msg_rx.recv()).await;

    let tmux = SessionManager::new();
    let session = TestSession::new("watcher-removed");
    let session_name = session.name().to_string();

    // Create the session before starting the watcher.
    tmux.create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .expect("failed to create tmux session");

    let shutdown = {
        let sw = SessionWatcher::new(handle.clone(), SessionManager::new(), 1);
        let sd = sw.shutdown_handle();
        tokio::spawn(sw.run());
        sd
    };

    // Wait for the "new session" update to be processed (status=detached).
    let mut saw_create = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(2), msg_rx.recv()).await {
            Ok(Some(msg)) => {
                let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
                if parsed["msg_type"] == "agent.session.update"
                    && parsed["payload"]["session_name"] == session_name
                    && parsed["payload"]["status"] == "detached"
                {
                    saw_create = true;
                    break;
                }
            }
            _ => break,
        }
    }
    assert!(saw_create, "did not see initial session creation update");

    // Now kill the session; the watcher should detect removal.
    tmux.kill_session(&session_name).await.ok();

    // Wait for "gone" update.
    let found = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(msg) = msg_rx.recv().await {
            let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
            if parsed["msg_type"] == "agent.session.update"
                && parsed["payload"]["session_name"] == session_name
                && parsed["payload"]["status"] == "gone"
            {
                return parsed;
            }
        }
        unreachable!("channel closed before removal update received")
    })
    .await;

    shutdown.shutdown().await.ok();
    handle.shutdown().await.ok();
    server_handle.abort();

    let update = found.expect("did not receive session removal update");
    assert_eq!(update["payload"]["session_name"], session_name.as_str());
    assert_eq!(update["payload"]["status"], "gone");
    assert_eq!(update["payload"]["window_count"], 0);
    assert_eq!(update["payload"]["attached_clients"], 0);
}
