use chrono::Utc;
use nession_server::registry::session::{SessionInfo, SessionRegistry, SessionStatus};

#[tokio::test]
async fn test_session_update() {
    let registry = SessionRegistry::new();

    let session = SessionInfo {
        session_id: "agent_123:dev-work".to_string(),
        agent_id: "agent_123".to_string(),
        session_name: "dev-work".to_string(),
        status: SessionStatus::Active,
        window_count: 3,
        attached_clients: 1,
        last_activity: Utc::now(),
    };

    registry.update_session(session.clone()).await;

    let retrieved = registry.get("agent_123:dev-work").await;
    assert!(retrieved.is_some());
    assert_eq!(retrieved.unwrap().session_name, "dev-work");
}

#[tokio::test]
async fn test_list_sessions_by_agent() {
    let registry = SessionRegistry::new();

    let session1 = SessionInfo {
        session_id: "agent_123:session1".to_string(),
        agent_id: "agent_123".to_string(),
        session_name: "session1".to_string(),
        status: SessionStatus::Active,
        window_count: 1,
        attached_clients: 0,
        last_activity: Utc::now(),
    };

    let session2 = SessionInfo {
        session_id: "agent_456:session2".to_string(),
        agent_id: "agent_456".to_string(),
        session_name: "session2".to_string(),
        status: SessionStatus::Active,
        window_count: 1,
        attached_clients: 0,
        last_activity: Utc::now(),
    };

    registry.update_session(session1).await;
    registry.update_session(session2).await;

    let agent1_sessions = registry.list_by_agent("agent_123").await;
    assert_eq!(agent1_sessions.len(), 1);
    assert_eq!(agent1_sessions[0].session_name, "session1");
}

#[tokio::test]
async fn test_session_remove() {
    let registry = SessionRegistry::new();
    let session = SessionInfo {
        session_id: "agent_1:sess".to_string(),
        agent_id: "agent_1".to_string(),
        session_name: "sess".to_string(),
        status: SessionStatus::Active,
        window_count: 1,
        attached_clients: 0,
        last_activity: Utc::now(),
    };
    registry.update_session(session).await;
    assert!(registry.get("agent_1:sess").await.is_some());

    registry.remove("agent_1:sess").await;
    assert!(registry.get("agent_1:sess").await.is_none());
}

#[tokio::test]
async fn test_session_remove_by_agent() {
    let registry = SessionRegistry::new();
    for name in &["s1", "s2", "s3"] {
        registry
            .update_session(SessionInfo {
                session_id: format!("agent_x:{}", name),
                agent_id: "agent_x".to_string(),
                session_name: name.to_string(),
                status: SessionStatus::Detached,
                window_count: 1,
                attached_clients: 0,
                last_activity: Utc::now(),
            })
            .await;
    }
    // Also add a session for another agent
    registry
        .update_session(SessionInfo {
            session_id: "agent_y:s1".to_string(),
            agent_id: "agent_y".to_string(),
            session_name: "s1".to_string(),
            status: SessionStatus::Active,
            window_count: 1,
            attached_clients: 0,
            last_activity: Utc::now(),
        })
        .await;

    assert_eq!(registry.list().await.len(), 4);

    registry.remove_by_agent("agent_x").await;

    let remaining = registry.list().await;
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].agent_id, "agent_y");
}

#[tokio::test]
async fn test_session_list_empty() {
    let registry = SessionRegistry::new();
    assert!(registry.list().await.is_empty());
}

#[tokio::test]
async fn test_session_list_by_agent_empty() {
    let registry = SessionRegistry::new();
    assert!(registry.list_by_agent("nobody").await.is_empty());
}

#[tokio::test]
async fn test_session_update_overwrites() {
    let registry = SessionRegistry::new();
    let s1 = SessionInfo {
        session_id: "a:s".to_string(),
        agent_id: "a".to_string(),
        session_name: "s".to_string(),
        status: SessionStatus::Detached,
        window_count: 1,
        attached_clients: 0,
        last_activity: Utc::now(),
    };
    registry.update_session(s1).await;

    let s2 = SessionInfo {
        session_id: "a:s".to_string(),
        agent_id: "a".to_string(),
        session_name: "s".to_string(),
        status: SessionStatus::Active,
        window_count: 3,
        attached_clients: 2,
        last_activity: Utc::now(),
    };
    registry.update_session(s2).await;

    let updated = registry.get("a:s").await.unwrap();
    assert_eq!(updated.status, SessionStatus::Active);
    assert_eq!(updated.window_count, 3);
    assert_eq!(updated.attached_clients, 2);
}

#[tokio::test]
async fn test_session_default_impl() {
    let _registry = SessionRegistry::default();
    // Verify default() creates the same as new()
    let registry = SessionRegistry::default();
    assert!(registry.list().await.is_empty());
}

#[tokio::test]
async fn test_remove_nonexistent_session_is_noop() {
    let registry = SessionRegistry::new();
    registry.remove("ghost:session").await;
    // Should not panic
}
