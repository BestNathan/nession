use nession_server::db::Database;
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
    db.insert_agent(
        "agent_123",
        "dev-server",
        "192.168.1.10",
        8080,
        "hashed_token",
        r#"{"tmux_version": "3.3a"}"#
    ).await.unwrap();

    // Retrieve agent
    let agents = db.list_agents().await.unwrap();
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].agent_id, "agent_123");
}
