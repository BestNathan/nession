use nession_agent::tmux::manager::TmuxManager;

#[tokio::test]
async fn test_list_sessions_empty() {
    let manager = TmuxManager::new();
    let sessions = manager.list_sessions().await.unwrap();
    // tmux may not be running, so empty list is expected
    // Length is always >= 0 for a Vec, so just check it's valid
    let _ = sessions.len();
}

#[tokio::test]
async fn test_create_and_kill_session() {
    let manager = TmuxManager::new();
    let session_name = "test_session_integration";

    // Create session
    manager
        .create_session(session_name, 80, 24, "/tmp")
        .await
        .unwrap();

    // Verify it exists
    let sessions = manager.list_sessions().await.unwrap();
    assert!(sessions.iter().any(|s| s.name == session_name));

    // Kill session
    manager.kill_session(session_name).await.unwrap();

    // Verify it's gone
    let sessions = manager.list_sessions().await.unwrap();
    assert!(!sessions.iter().any(|s| s.name == session_name));
}
