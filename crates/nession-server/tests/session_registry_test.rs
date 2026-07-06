use std::sync::Arc;

use chrono::Utc;
use nession_server::db::Database;
use nession_server::registry::session::{SessionInfo, SessionRegistry, SessionStatus};

async fn make_registry() -> SessionRegistry {
    let db = Database::new(":memory:").await.unwrap();
    SessionRegistry::new(Arc::new(db))
}

fn make_session(id: &str, agent: &str, name: &str, status: SessionStatus) -> SessionInfo {
    SessionInfo {
        session_id: id.to_string(),
        agent_id: agent.to_string(),
        session_name: name.to_string(),
        status,
        window_count: 1,
        attached_clients: 0,
        created_at: Utc::now(),
        last_activity: Utc::now(),
    }
}

#[tokio::test]
async fn test_session_update() {
    let registry = make_registry().await;

    let session = make_session(
        "agent_123:dev-work",
        "agent_123",
        "dev-work",
        SessionStatus::Active,
    );

    registry.update_session(session.clone()).await;

    let retrieved = registry.get("agent_123:dev-work").await;
    assert!(retrieved.is_some());
    assert_eq!(retrieved.unwrap().session_name, "dev-work");
}

#[tokio::test]
async fn test_list_sessions_by_agent() {
    let registry = make_registry().await;

    let session1 = make_session(
        "agent_123:session1",
        "agent_123",
        "session1",
        SessionStatus::Active,
    );
    let session2 = make_session(
        "agent_456:session2",
        "agent_456",
        "session2",
        SessionStatus::Active,
    );

    registry.update_session(session1).await;
    registry.update_session(session2).await;

    let agent1_sessions = registry.list_by_agent("agent_123").await;
    assert_eq!(agent1_sessions.len(), 1);
    assert_eq!(agent1_sessions[0].session_name, "session1");
}

#[tokio::test]
async fn test_session_remove() {
    let registry = make_registry().await;
    let session = make_session("agent_1:sess", "agent_1", "sess", SessionStatus::Active);
    registry.update_session(session).await;
    assert!(registry.get("agent_1:sess").await.is_some());

    registry.remove("agent_1:sess").await;
    assert!(registry.get("agent_1:sess").await.is_none());
}

#[tokio::test]
async fn test_session_remove_by_agent() {
    let registry = make_registry().await;
    for (i, name) in ["s1", "s2", "s3"].iter().enumerate() {
        let mut session = make_session(
            &format!("agent_x:{}", name),
            "agent_x",
            name,
            SessionStatus::Detached,
        );
        session.window_count = 1 + i as u32;
        registry.update_session(session).await;
    }
    // Also add a session for another agent
    registry
        .update_session(make_session(
            "agent_y:s1",
            "agent_y",
            "s1",
            SessionStatus::Active,
        ))
        .await;

    assert_eq!(registry.list().await.len(), 4);

    registry.remove_by_agent("agent_x").await;

    let remaining = registry.list().await;
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].agent_id, "agent_y");
}

#[tokio::test]
async fn test_session_list_empty() {
    let registry = make_registry().await;
    assert!(registry.list().await.is_empty());
}

#[tokio::test]
async fn test_session_list_by_agent_empty() {
    let registry = make_registry().await;
    assert!(registry.list_by_agent("nobody").await.is_empty());
}

#[tokio::test]
async fn test_session_update_overwrites() {
    let registry = make_registry().await;
    registry
        .update_session(make_session("a:s", "a", "s", SessionStatus::Detached))
        .await;

    registry
        .update_session(SessionInfo {
            status: SessionStatus::Active,
            window_count: 3,
            attached_clients: 2,
            ..make_session("a:s", "a", "s", SessionStatus::Active)
        })
        .await;

    let updated = registry.get("a:s").await.unwrap();
    assert_eq!(updated.status, SessionStatus::Active);
    assert_eq!(updated.window_count, 3);
    assert_eq!(updated.attached_clients, 2);
}

#[tokio::test]
async fn test_remove_nonexistent_session_is_noop() {
    let registry = make_registry().await;
    registry.remove("ghost:session").await;
    // Should not panic
}

#[tokio::test]
async fn test_session_recovery_empty_db() {
    let registry = make_registry().await;
    registry.load_from_db().await;
    assert!(registry.list().await.is_empty());
}

#[tokio::test]
async fn test_load_from_db_with_populated_data() {
    // Create a DB with pre-populated sessions
    let db = Database::new(":memory:").await.unwrap();
    let db = Arc::new(db);

    // Insert sessions with different statuses
    let s1 = make_session("a1:s1", "a1", "s1", SessionStatus::Active);
    let s2 = make_session("a1:s2", "a1", "s2", SessionStatus::Detached);
    db.insert_session(&s1, "active").await.unwrap();
    db.insert_session(&s2, "detached").await.unwrap();

    // Create registry and load from DB
    let registry = SessionRegistry::new(db);
    registry.load_from_db().await;

    // Verify sessions were loaded
    let sessions = registry.list().await;
    assert_eq!(sessions.len(), 2);

    // Verify status mapping
    let loaded_s1 = registry.get("a1:s1").await.unwrap();
    assert_eq!(loaded_s1.status, SessionStatus::Active);
    assert_eq!(loaded_s1.session_name, "s1");

    let loaded_s2 = registry.get("a1:s2").await.unwrap();
    assert_eq!(loaded_s2.status, SessionStatus::Detached);
    assert_eq!(loaded_s2.session_name, "s2");
}

#[tokio::test]
async fn test_load_from_db_status_mapping() {
    let db = Database::new(":memory:").await.unwrap();
    let db = Arc::new(db);

    // Insert sessions with various status strings
    let base = make_session("a:s", "a", "s", SessionStatus::Active);
    db.insert_session(&base, "active").await.unwrap();

    let base = make_session("a:d", "a", "d", SessionStatus::Detached);
    db.insert_session(&base, "detached").await.unwrap();

    let base = make_session("a:z", "a", "z", SessionStatus::Zombie);
    db.insert_session(&base, "zombie").await.unwrap();

    // Unknown status should map to Recovering
    let base = make_session("a:u", "a", "u", SessionStatus::Recovering);
    db.insert_session(&base, "unknown_status").await.unwrap();

    // Also test "recovering" status
    let base = make_session("a:r", "a", "r", SessionStatus::Recovering);
    db.insert_session(&base, "recovering").await.unwrap();

    let registry = SessionRegistry::new(db);
    registry.load_from_db().await;

    assert_eq!(
        registry.get("a:s").await.unwrap().status,
        SessionStatus::Active
    );
    assert_eq!(
        registry.get("a:d").await.unwrap().status,
        SessionStatus::Detached
    );
    assert_eq!(
        registry.get("a:z").await.unwrap().status,
        SessionStatus::Zombie
    );
    assert_eq!(
        registry.get("a:u").await.unwrap().status,
        SessionStatus::Recovering
    );
    assert_eq!(
        registry.get("a:r").await.unwrap().status,
        SessionStatus::Recovering
    );
}

#[tokio::test]
async fn test_load_from_db_preserves_window_count_and_clients() {
    let db = Database::new(":memory:").await.unwrap();
    let db = Arc::new(db);

    let mut session = make_session("a:s", "a", "s", SessionStatus::Active);
    session.window_count = 5;
    session.attached_clients = 3;
    db.insert_session(&session, "active").await.unwrap();

    let registry = SessionRegistry::new(db);
    registry.load_from_db().await;

    let loaded = registry.get("a:s").await.unwrap();
    assert_eq!(loaded.window_count, 5);
    assert_eq!(loaded.attached_clients, 3);
}
