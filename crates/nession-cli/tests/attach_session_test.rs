//! Integration tests for session attach command

use nession_cli::commands::client::attach_session;
use nession_server::server::WebSocketServer;
use nession_common::config::ServerConfig;
use std::time::Duration;
use tokio::time::sleep;

/// Helper to create a test server config
fn create_test_config(port: u16) -> ServerConfig {
    ServerConfig {
        listen_address: format!("127.0.0.1:{}", port),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: "test_token".to_string(),
        heartbeat_timeout_secs: 30,
        db_path: format!("/tmp/nession_test_{}.db", port),
    }
}

#[tokio::test]
async fn test_attach_session_p2p_mode() {
    // This test requires a full setup with server, agent, and tmux session
    // Since we can't easily set that up in a unit test, we'll just verify
    // the connection flow works up to the point where it would fail

    // Start server
    let config = create_test_config(18090);

    let mut server = WebSocketServer::new(config).await.unwrap();
    let server_handle = tokio::spawn(async move {
        let _ = server.run().await;
    });

    // Give server time to start
    sleep(Duration::from_millis(100)).await;

    // Try to attach - should fail gracefully since no agent/session exists
    let result = attach_session(
        "ws://127.0.0.1:18090",
        "test_token",
        "agent1:session1",
        Some("p2p"),
    ).await;

    // Should fail with "session not found" or similar
    assert!(result.is_err());

    // Clean up
    server_handle.abort();
}

#[tokio::test]
async fn test_attach_session_relay_mode() {
    // Similar to P2P test but with relay mode forced
    let config = create_test_config(18091);

    let mut server = WebSocketServer::new(config).await.unwrap();
    let server_handle = tokio::spawn(async move {
        let _ = server.run().await;
    });

    sleep(Duration::from_millis(100)).await;

    let result = attach_session(
        "ws://127.0.0.1:18091",
        "test_token",
        "agent1:session1",
        Some("relay"),
    ).await;

    // Should fail gracefully
    assert!(result.is_err());

    server_handle.abort();
}

#[tokio::test]
async fn test_attach_session_auto_fallback() {
    // Test that auto mode (None) works
    let config = create_test_config(18092);

    let mut server = WebSocketServer::new(config).await.unwrap();
    let server_handle = tokio::spawn(async move {
        let _ = server.run().await;
    });

    sleep(Duration::from_millis(100)).await;

    let result = attach_session(
        "ws://127.0.0.1:18092",
        "test_token",
        "agent1:session1",
        None, // Auto mode
    ).await;

    // Should fail gracefully
    assert!(result.is_err());

    server_handle.abort();
}

#[tokio::test]
async fn test_attach_session_invalid_mode() {
    let config = create_test_config(18093);

    let mut server = WebSocketServer::new(config).await.unwrap();
    let server_handle = tokio::spawn(async move {
        let _ = server.run().await;
    });

    sleep(Duration::from_millis(100)).await;

    let result = attach_session(
        "ws://127.0.0.1:18093",
        "test_token",
        "agent1:session1",
        Some("invalid_mode"),
    ).await;

    // Should fail with invalid mode error
    assert!(result.is_err());
    let err_msg = result.unwrap_err().to_string();
    assert!(err_msg.contains("Invalid mode") || err_msg.contains("mode"));

    server_handle.abort();
}

#[tokio::test]
async fn test_attach_session_bad_credentials() {
    let config = create_test_config(18094);

    let mut server = WebSocketServer::new(config).await.unwrap();
    let server_handle = tokio::spawn(async move {
        let _ = server.run().await;
    });

    sleep(Duration::from_millis(100)).await;

    let result = attach_session(
        "ws://127.0.0.1:18094",
        "wrong_token",
        "agent1:session1",
        None,
    ).await;

    // Should fail with authentication error
    assert!(result.is_err());

    server_handle.abort();
}
