use nession_server::registry::session::{SessionRegistry, SessionInfo, SessionStatus};
use chrono::Utc;

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
