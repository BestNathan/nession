use chrono::Utc;
use nession_server::db::Database;
use nession_server::registry::session::{SessionInfo, SessionStatus};
use tempfile::NamedTempFile;

#[tokio::test]
async fn test_database_initialization() {
    let temp_file = NamedTempFile::new().unwrap();
    let db_path = temp_file.path().to_str().unwrap();

    let db = Database::new(db_path).await.unwrap();

    // Verify tables exist
    let agents = db.list_agents().await.unwrap();
    assert_eq!(agents.len(), 0);
}

#[tokio::test]
async fn test_agent_persistence() {
    let temp_file = NamedTempFile::new().unwrap();
    let db_path = temp_file.path().to_str().unwrap();

    let db = Database::new(db_path).await.unwrap();

    // Insert agent
    db.insert_agent(nession_server::db::AgentInsert {
        agent_id: "agent_123",
        hostname: "dev-server",
        ip_address: "192.168.1.10",
        port: 8080,
        auth_token_hash: "hashed_token",
        metadata: r#"{"tmux_version": "3.3a"}"#,
        connect_url: Some("wss://agent.example.com/ws"),
        addresses: r#"[{"url":"wss://agent.example.com/ws","network_type":"tunnel","priority":30}]"#,
    })
    .await
    .unwrap();

    // Retrieve agent
    let agents = db.list_agents().await.unwrap();
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].agent_id, "agent_123");
    assert_eq!(
        agents[0].connect_url.as_deref(),
        Some("wss://agent.example.com/ws")
    );
    assert!(agents[0].addresses.contains("tunnel"));
}

fn make_session_info(id: &str, agent: &str, name: &str) -> SessionInfo {
    SessionInfo {
        session_id: id.to_string(),
        agent_id: agent.to_string(),
        session_name: name.to_string(),
        status: SessionStatus::Active,
        window_count: 1,
        attached_clients: 0,
        created_at: Utc::now(),
        last_activity: Utc::now(),
    }
}

#[tokio::test]
async fn test_insert_session() {
    let db = Database::new(":memory:").await.unwrap();
    let session = make_session_info("agent1:dev", "agent1", "dev");

    db.insert_session(&session, "active").await.unwrap();

    let sessions = db.list_all_sessions().await.unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id, "agent1:dev");
    assert_eq!(sessions[0].agent_id, "agent1");
    assert_eq!(sessions[0].session_name, "dev");
    assert_eq!(sessions[0].status, "active");
}

#[tokio::test]
async fn test_update_session_status() {
    let db = Database::new(":memory:").await.unwrap();
    let session = make_session_info("agent1:dev", "agent1", "dev");
    db.insert_session(&session, "active").await.unwrap();

    db.update_session_status("agent1:dev", "detached")
        .await
        .unwrap();

    let sessions = db.list_all_sessions().await.unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].status, "detached");
}

#[tokio::test]
async fn test_delete_session() {
    let db = Database::new(":memory:").await.unwrap();
    let session = make_session_info("agent1:dev", "agent1", "dev");
    db.insert_session(&session, "active").await.unwrap();
    assert_eq!(db.list_all_sessions().await.unwrap().len(), 1);

    db.delete_session("agent1:dev").await.unwrap();
    assert_eq!(db.list_all_sessions().await.unwrap().len(), 0);
}

#[tokio::test]
async fn test_delete_sessions_by_agent() {
    let db = Database::new(":memory:").await.unwrap();
    db.insert_session(&make_session_info("a1:s1", "a1", "s1"), "active")
        .await
        .unwrap();
    db.insert_session(&make_session_info("a1:s2", "a1", "s2"), "active")
        .await
        .unwrap();
    db.insert_session(&make_session_info("a2:s1", "a2", "s1"), "active")
        .await
        .unwrap();
    assert_eq!(db.list_all_sessions().await.unwrap().len(), 3);

    db.delete_sessions_by_agent("a1").await.unwrap();

    let sessions = db.list_all_sessions().await.unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].agent_id, "a2");
}

#[tokio::test]
async fn test_list_all_sessions_empty() {
    let db = Database::new(":memory:").await.unwrap();
    let sessions = db.list_all_sessions().await.unwrap();
    assert_eq!(sessions.len(), 0);
}

#[tokio::test]
async fn test_list_sessions_older_than() {
    let db = Database::new(":memory:").await.unwrap();

    // Insert sessions (insert_session sets last_activity to now())
    let old_session = make_session_info("old:s1", "a1", "s1");
    db.insert_session(&old_session, "recovering").await.unwrap();
    let recent_session = make_session_info("new:s1", "a1", "s2");
    db.insert_session(&recent_session, "recovering")
        .await
        .unwrap();

    // Query with a very large duration (0 seconds) - should return nothing
    // since both sessions were just inserted with last_activity = now()
    let old_sessions = db.list_sessions_older_than(0).await.unwrap();
    assert_eq!(old_sessions.len(), 0);

    // Query with negative duration (future cutoff) - should return both
    let all_old = db.list_sessions_older_than(-3600).await.unwrap();
    assert_eq!(all_old.len(), 2);
}

#[tokio::test]
async fn test_list_sessions_older_than_excludes_non_recovering() {
    let db = Database::new(":memory:").await.unwrap();

    // Insert an old session with "active" status (should be excluded)
    let mut old_session = make_session_info("old:s1", "a1", "s1");
    old_session.last_activity = Utc::now() - chrono::Duration::hours(2);
    db.insert_session(&old_session, "active").await.unwrap();

    // Query sessions older than 1 hour
    let old_sessions = db.list_sessions_older_than(3600).await.unwrap();
    assert_eq!(old_sessions.len(), 0); // active sessions not included
}

#[tokio::test]
async fn test_insert_session_replaces_existing() {
    let db = Database::new(":memory:").await.unwrap();
    let session = make_session_info("a1:s1", "a1", "s1");
    db.insert_session(&session, "active").await.unwrap();

    // Insert again with different status
    db.insert_session(&session, "detached").await.unwrap();

    let sessions = db.list_all_sessions().await.unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].status, "detached");
}

#[tokio::test]
async fn test_update_nonexistent_session_is_noop() {
    let db = Database::new(":memory:").await.unwrap();
    // Should not error
    db.update_session_status("nonexistent", "detached")
        .await
        .unwrap();
}

#[tokio::test]
async fn test_delete_nonexistent_session_is_noop() {
    let db = Database::new(":memory:").await.unwrap();
    // Should not error
    db.delete_session("nonexistent").await.unwrap();
}
