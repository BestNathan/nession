//! Integration tests for the server connection client.
//!
//! These tests verify the agent's ability to connect to a mock server,
//! send registration/heartbeat/session update messages, and handle responses.

use futures_util::{SinkExt, StreamExt};
use nession_agent::connection::{msg_types, ServerClient};
use nession_agent::tmux::manager::SessionManager;
use nession_common::protocol::{AgentMetadata, AgentStatus};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::{accept_async, tungstenite::protocol::Message as WsMessage};

/// Start a mock WebSocket server on an OS-assigned port and capture messages.
///
/// The port is never hardcoded: two concurrent test runs — two worktrees, or CI
/// alongside a local run — would otherwise fight over the same number.
async fn start_mock_server() -> anyhow::Result<(
    std::net::SocketAddr,
    tokio::task::JoinHandle<()>,
    mpsc::Receiver<String>,
)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let (handle, msg_rx) = serve_mock(listener);
    Ok((addr, handle, msg_rx))
}

/// Ask the OS for a free port, then release it.
///
/// Only for the reconnection test, which must hand the client an address where
/// nothing is listening *yet*, so the port cannot stay bound. Re-binding it
/// later is a small race against the rest of the machine, but far better than a
/// hardcoded number that races every concurrent test run.
async fn free_port() -> anyhow::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// Start the mock server on a port obtained earlier from [`free_port`].
async fn start_mock_server_on(
    port: u16,
) -> anyhow::Result<(tokio::task::JoinHandle<()>, mpsc::Receiver<String>)> {
    let listener = TcpListener::bind(format!("127.0.0.1:{port}")).await?;
    Ok(serve_mock(listener))
}

fn serve_mock(listener: TcpListener) -> (tokio::task::JoinHandle<()>, mpsc::Receiver<String>) {
    let (msg_tx, msg_rx) = mpsc::channel(100);

    let handle = tokio::spawn(async move {
        if let Ok((stream, _)) = listener.accept().await {
            let ws = accept_async(stream)
                .await
                .unwrap_or_else(|e| panic!("failed to accept ws: {e}"));
            let (mut sink, mut stream) = ws.split();

            // Send a registration response.
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

            // Capture all messages and forward them to the receiver.
            while let Some(Ok(msg)) = stream.next().await {
                if let WsMessage::Text(text) = msg {
                    let _ = msg_tx.send(text.clone()).await;
                }
            }
        }
    });

    (handle, msg_rx)
}

#[tokio::test]
async fn integration_connection_to_mock_server() {
    let (addr, server_handle, _msg_rx) = start_mock_server().await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    let metadata = AgentMetadata {
        tmux_version: "3.3".to_string(),
        os_version: "Linux".to_string(),
        nession_version: "0.1.0".to_string(),
        image_tag: "test".to_string(),
    };

    let client = ServerClient::new(
        format!("ws://{addr}"),
        "test-token",
        "integration-agent-1",
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

    let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

    // Give it a moment to register.
    tokio::time::sleep(Duration::from_millis(100)).await;

    handle.shutdown().await.ok();
    server_handle.abort();
}

#[tokio::test]
async fn integration_registration_message_format() {
    let (addr, server_handle, mut msg_rx) = start_mock_server().await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    let metadata = AgentMetadata {
        tmux_version: "3.3".to_string(),
        os_version: "Linux".to_string(),
        nession_version: "0.1.0".to_string(),
        image_tag: "test".to_string(),
    };

    let client = ServerClient::new(
        format!("ws://{addr}"),
        "secret-token-123",
        "integration-agent-2",
        "my-hostname",
        "192.168.1.100",
        9090,
        None,   // connect_url
        vec![], // addresses
        None,   // display_name
        metadata,
        Arc::new(SessionManager::new()),
        "/tmp".to_string(),
        None, // extension_registry
    );

    let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

    // Wait for registration message.
    let msg = tokio::time::timeout(Duration::from_secs(2), msg_rx.recv())
        .await
        .expect("timeout waiting for registration")
        .expect("no message received");

    let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();

    // Verify message envelope.
    assert_eq!(parsed["msg_type"], msg_types::AGENT_REGISTER);
    assert!(parsed["id"].as_str().is_some());
    assert!(parsed["timestamp"].as_u64().is_some());

    // Verify payload.
    let payload = &parsed["payload"];
    assert_eq!(payload["agent_id"], "integration-agent-2");
    assert_eq!(payload["hostname"], "my-hostname");
    assert_eq!(payload["ip_address"], "192.168.1.100");
    assert_eq!(payload["port"], 9090);
    assert_eq!(payload["auth_token"], "secret-token-123");
    assert_eq!(payload["protocol_version"], "1.0");

    // Verify metadata.
    assert!(payload["metadata"].is_object());
    assert_eq!(payload["metadata"]["tmux_version"], "3.3");
    assert_eq!(payload["metadata"]["os_version"], "Linux");
    assert_eq!(payload["metadata"]["nession_version"], "0.1.0");

    handle.shutdown().await.ok();
    server_handle.abort();
}

#[tokio::test]
async fn integration_heartbeat_message_format() {
    let (addr, server_handle, mut msg_rx) = start_mock_server().await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    let metadata = AgentMetadata {
        tmux_version: "3.3".to_string(),
        os_version: "Linux".to_string(),
        nession_version: "0.1.0".to_string(),
        image_tag: "test".to_string(),
    };

    let client = ServerClient::new(
        format!("ws://{addr}"),
        "test-token",
        "integration-agent-3",
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

    let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

    // Skip registration message.
    let _ = msg_rx.recv().await;

    // Send heartbeat.
    handle
        .send_heartbeat(AgentStatus::Online, 10, 3, 7200, [0.5, 1.0, 1.5])
        .await
        .expect("heartbeat failed");

    // Wait for heartbeat message.
    let msg = tokio::time::timeout(Duration::from_secs(2), msg_rx.recv())
        .await
        .expect("timeout waiting for heartbeat")
        .expect("no message received");

    let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();

    // Verify message envelope.
    assert_eq!(parsed["msg_type"], msg_types::AGENT_HEARTBEAT);
    assert!(parsed["id"].as_str().is_some());
    assert!(parsed["timestamp"].as_u64().is_some());

    // Verify payload.
    let payload = &parsed["payload"];
    assert_eq!(payload["agent_id"], "integration-agent-3");
    assert_eq!(payload["status"], "online");
    assert_eq!(payload["session_count"], 10);
    assert_eq!(payload["active_sessions"], 3);

    // Verify metadata.
    assert!(payload["metadata"].is_object());
    assert_eq!(payload["metadata"]["uptime_seconds"], 7200);
    let load_avg = payload["metadata"]["load_average"].as_array().unwrap();
    assert_eq!(load_avg.len(), 3);
    assert_eq!(load_avg[0].as_f64().unwrap(), 0.5);
    assert_eq!(load_avg[1].as_f64().unwrap(), 1.0);
    assert_eq!(load_avg[2].as_f64().unwrap(), 1.5);

    handle.shutdown().await.ok();
    server_handle.abort();
}

#[tokio::test]
async fn integration_session_update_message_format() {
    let (addr, server_handle, mut msg_rx) = start_mock_server().await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    let metadata = AgentMetadata {
        tmux_version: "3.3".to_string(),
        os_version: "Linux".to_string(),
        nession_version: "0.1.0".to_string(),
        image_tag: "test".to_string(),
    };

    let client = ServerClient::new(
        format!("ws://{addr}"),
        "test-token",
        "integration-agent-4",
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

    let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

    // Skip registration message.
    let _ = msg_rx.recv().await;

    // Send session update.
    handle
        .send_session_update("my-session", "active", 5, 2)
        .await
        .expect("session update failed");

    // Wait for session update message.
    let msg = tokio::time::timeout(Duration::from_secs(2), msg_rx.recv())
        .await
        .expect("timeout waiting for session update")
        .expect("no message received");

    let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();

    // Verify message envelope.
    assert_eq!(parsed["msg_type"], msg_types::AGENT_SESSION_UPDATE);
    assert!(parsed["id"].as_str().is_some());
    assert!(parsed["timestamp"].as_u64().is_some());

    // Verify payload.
    let payload = &parsed["payload"];
    assert_eq!(payload["agent_id"], "integration-agent-4");
    assert_eq!(payload["session_name"], "my-session");
    assert_eq!(payload["status"], "active");
    assert_eq!(payload["window_count"], 5);
    assert_eq!(payload["attached_clients"], 2);

    handle.shutdown().await.ok();
    server_handle.abort();
}

#[tokio::test]
async fn integration_reconnection_logic() {
    // This test verifies that the client attempts to reconnect when the server
    // is not available. We'll start with no server, verify the client keeps
    // trying, then start a server and verify it connects.

    // A port nothing is listening on yet — the client must fail and back off
    // before the server appears below.
    let port = free_port().await.unwrap();

    let metadata = AgentMetadata {
        tmux_version: "3.3".to_string(),
        os_version: "Linux".to_string(),
        nession_version: "0.1.0".to_string(),
        image_tag: "test".to_string(),
    };

    let client = ServerClient::new(
        format!("ws://127.0.0.1:{port}"),
        "test-token",
        "integration-agent-5",
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

    // Spawn the client connection attempt in the background.
    let client_handle =
        tokio::spawn(async move { client.connect_and_run().await.expect("connect failed").0 });

    // Give it time to fail a few times (exponential backoff: 1s, 2s, 4s...).
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Now start the server.
    let (server_handle, mut msg_rx) = start_mock_server_on(port).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;

    // The client should eventually connect and send registration.
    let msg = tokio::time::timeout(Duration::from_secs(5), msg_rx.recv())
        .await
        .expect("timeout waiting for registration after server start")
        .expect("no message received");

    let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
    assert_eq!(parsed["msg_type"], msg_types::AGENT_REGISTER);
    assert_eq!(parsed["payload"]["agent_id"], "integration-agent-5");

    let handle = client_handle.await.expect("client task failed");
    handle.shutdown().await.ok();
    server_handle.abort();
}
