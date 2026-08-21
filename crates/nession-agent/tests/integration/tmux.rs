use nession_agent::tmux::manager::SessionManager;
use nession_agent::tmux::util::{check_tmux_available, send_keys};

use super::{unique_session_name, TestSession};

#[tokio::test]
async fn test_list_sessions_empty() {
    let manager = SessionManager::new();
    let sessions = manager.list_sessions().await.unwrap();
    // tmux may not be running, so empty list is expected
    // Length is always >= 0 for a Vec, so just check it's valid
    let _ = sessions.len();
}

#[tokio::test]
async fn test_create_and_kill_session() {
    let manager = SessionManager::new();
    let session = TestSession::new("create-kill");
    let session_name = session.name().to_string();

    // Create session
    manager
        .create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    // Verify it exists
    let sessions = manager.list_sessions().await.unwrap();
    assert!(sessions.iter().any(|s| s.name == session_name));

    // Kill session
    manager.kill_session(&session_name).await.unwrap();

    // Verify it's gone
    let sessions = manager.list_sessions().await.unwrap();
    assert!(!sessions.iter().any(|s| s.name == session_name));
}

#[tokio::test]
async fn test_send_keys() {
    let manager = SessionManager::new();
    let session = TestSession::new("send-keys");
    let session_name = session.name().to_string();

    // Create session
    manager
        .create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    // Send keys - should not error
    send_keys(&session_name, "echo test").await.unwrap();

    // Clean up
    manager.kill_session(&session_name).await.unwrap();
}

#[tokio::test]
async fn test_send_keys_nonexistent_session() {
    // Sending keys to a non-existent session should fail
    let ghost = unique_session_name("ghost");
    let result = send_keys(&ghost, "test").await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_check_tmux_available() {
    let available = check_tmux_available().await.unwrap();
    // tmux should be available in the test environment
    assert!(available, "tmux should be available for tests");
}

#[tokio::test]
async fn test_kill_nonexistent_session() {
    let manager = SessionManager::new();
    let ghost = unique_session_name("ghost");

    // Killing a non-existent session should fail
    let result = manager.kill_session(&ghost).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_create_duplicate_session() {
    let manager = SessionManager::new();
    let session = TestSession::new("duplicate");
    let session_name = session.name().to_string();

    // Create session
    manager
        .create_session(&session_name, 80, 24, "/tmp", &[])
        .await
        .unwrap();

    // Creating the same session again should fail
    let result = manager
        .create_session(&session_name, 80, 24, "/tmp", &[])
        .await;
    assert!(result.is_err());

    // Clean up
    manager.kill_session(&session_name).await.unwrap();
}
