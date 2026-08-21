//! Integration tests for session attach command

use nession_cli::commands::client::attach_session;
use nession_common::config::ServerConfig;
use nession_server::db::Database;
use nession_server::server::WebSocketServer;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::sleep;

/// Helper to create a test server config.
///
/// Both the port and the database path are per-run rather than fixed: the port
/// is OS-assigned, and the database lives in a fresh temp dir removed when the
/// returned `TempDir` drops. A shared `/tmp/nession_test_<port>.db` was reused
/// by any concurrent test run.
fn create_test_config() -> anyhow::Result<(tempfile::TempDir, ServerConfig)> {
    let dir = tempfile::tempdir()?;
    let db_path = dir.path().join("server.db").to_string_lossy().into_owned();
    let config = ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: "test_token".to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 30,
        db_path,
        ..Default::default()
    };
    Ok((dir, config))
}

async fn start_test_server(
    config: ServerConfig,
) -> anyhow::Result<(std::net::SocketAddr, tokio::task::JoinHandle<()>)> {
    let db = Database::new(&config.db_path).await?;
    let mut server = WebSocketServer::new(config, Arc::new(db)).await?;
    let addr = server.local_addr()?;
    let handle = tokio::spawn(async move {
        let _ = server.run().await;
    });
    sleep(Duration::from_millis(100)).await;
    Ok((addr, handle))
}

#[tokio::test]
async fn test_attach_session_p2p_mode() {
    // This test requires a full setup with server, agent, and tmux session
    // Since we can't easily set that up in a unit test, we'll just verify
    // the connection flow works up to the point where it would fail

    // Start server
    let (_db_dir, config) = create_test_config().unwrap();

    let (addr, server_handle) = start_test_server(config).await.unwrap();

    // Try to attach - should fail gracefully since no agent/session exists
    let result = attach_session(
        &format!("ws://{addr}"),
        "test_token",
        "agent1:session1",
        Some("p2p"),
    )
    .await;

    // Should fail with "session not found" or similar
    assert!(result.is_err());

    // Clean up
    server_handle.abort();
}

#[tokio::test]
async fn test_attach_session_relay_mode() {
    // Similar to P2P test but with relay mode forced
    let (_db_dir, config) = create_test_config().unwrap();

    let (addr, server_handle) = start_test_server(config).await.unwrap();

    let result = attach_session(
        &format!("ws://{addr}"),
        "test_token",
        "agent1:session1",
        Some("relay"),
    )
    .await;

    // Should fail gracefully
    assert!(result.is_err());

    server_handle.abort();
}

#[tokio::test]
async fn test_attach_session_auto_fallback() {
    // Test that auto mode (None) works
    let (_db_dir, config) = create_test_config().unwrap();

    let (addr, server_handle) = start_test_server(config).await.unwrap();

    let result = attach_session(
        &format!("ws://{addr}"),
        "test_token",
        "agent1:session1",
        None, // Auto mode
    )
    .await;

    // Should fail gracefully
    assert!(result.is_err());

    server_handle.abort();
}

#[tokio::test]
async fn test_attach_session_invalid_mode() {
    let (_db_dir, config) = create_test_config().unwrap();

    let (addr, server_handle) = start_test_server(config).await.unwrap();

    let result = attach_session(
        &format!("ws://{addr}"),
        "test_token",
        "agent1:session1",
        Some("invalid_mode"),
    )
    .await;

    // Should fail with invalid mode error
    assert!(result.is_err());
    let err_msg = result.unwrap_err().to_string();
    assert!(err_msg.contains("Invalid mode") || err_msg.contains("mode"));

    server_handle.abort();
}

#[tokio::test]
async fn test_attach_session_bad_credentials() {
    let (_db_dir, config) = create_test_config().unwrap();

    let (addr, server_handle) = start_test_server(config).await.unwrap();

    let result = attach_session(
        &format!("ws://{addr}"),
        "wrong_token",
        "agent1:session1",
        None,
    )
    .await;

    // Should fail with authentication error
    assert!(result.is_err());

    server_handle.abort();
}
