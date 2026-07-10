use chrono::Utc;
use nession_common::protocol::AgentMetadata;
use nession_server::db::Database;
use nession_server::registry::agent::{AgentInfo, AgentRegistry, AgentStatus};
use std::sync::Arc;
use tempfile::NamedTempFile;

/// Build an `AgentRegistry` backed by a throwaway on-disk SQLite DB. The temp
/// file guard must be kept alive for the registry's lifetime.
async fn test_registry(timeout_secs: u64) -> (AgentRegistry, NamedTempFile) {
    let temp_file = NamedTempFile::new().unwrap();
    let db_path = temp_file.path().to_str().unwrap().to_string();
    let db = Database::new(&db_path).await.unwrap();
    (AgentRegistry::new(timeout_secs, Arc::new(db)), temp_file)
}

#[tokio::test]
async fn test_agent_registration() {
    let (registry, _db_guard) = test_registry(30).await;

    let agent = AgentInfo {
        agent_id: "agent_123".to_string(),
        hostname: "dev-server".to_string(),
        ip_address: "192.168.1.10".to_string(),
        port: 8080,
        connect_url: None,
        addresses: vec![],
        registered_at: Utc::now(),
        last_heartbeat: Utc::now(),
        status: AgentStatus::Online,
        metadata: AgentMetadata {
            tmux_version: "3.3a".to_string(),
            os_version: "Ubuntu 22.04".to_string(),
            nession_version: "0.1.0".to_string(),
        },
        session_count: 0,
        active_sessions: 0,
    };

    registry.register(agent.clone()).await;

    let retrieved = registry.get("agent_123").await;
    assert!(retrieved.is_some());
    assert_eq!(retrieved.unwrap().hostname, "dev-server");
}

#[tokio::test]
async fn test_agent_heartbeat_update() {
    let (registry, _db_guard) = test_registry(30).await;

    let agent = AgentInfo {
        agent_id: "agent_123".to_string(),
        hostname: "dev-server".to_string(),
        ip_address: "192.168.1.10".to_string(),
        port: 8080,
        connect_url: None,
        addresses: vec![],
        registered_at: Utc::now(),
        last_heartbeat: Utc::now(),
        status: AgentStatus::Online,
        metadata: AgentMetadata {
            tmux_version: "3.3a".to_string(),
            os_version: "Ubuntu 22.04".to_string(),
            nession_version: "0.1.0".to_string(),
        },
        session_count: 0,
        active_sessions: 0,
    };

    registry.register(agent).await;

    // Update heartbeat
    registry.update_heartbeat("agent_123", 5, 3).await;

    let updated = registry.get("agent_123").await.unwrap();
    assert_eq!(updated.session_count, 5);
    assert_eq!(updated.active_sessions, 3);
}

#[tokio::test]
async fn test_agent_list_all() {
    let (registry, _db_guard) = test_registry(30).await;
    registry
        .register(AgentInfo {
            agent_id: "a1".to_string(),
            hostname: "h1".to_string(),
            ip_address: "10.0.0.1".to_string(),
            port: 8080,
            connect_url: None,
            addresses: vec![],
            registered_at: Utc::now(),
            last_heartbeat: Utc::now(),
            status: AgentStatus::Online,
            metadata: AgentMetadata {
                tmux_version: "3.3".to_string(),
                os_version: "Linux".to_string(),
                nession_version: "0.1.0".to_string(),
            },
            session_count: 0,
            active_sessions: 0,
        })
        .await;
    registry
        .register(AgentInfo {
            agent_id: "a2".to_string(),
            hostname: "h2".to_string(),
            ip_address: "10.0.0.2".to_string(),
            port: 8080,
            connect_url: None,
            addresses: vec![],
            registered_at: Utc::now(),
            last_heartbeat: Utc::now(),
            status: AgentStatus::Online,
            metadata: AgentMetadata {
                tmux_version: "3.4".to_string(),
                os_version: "Linux".to_string(),
                nession_version: "0.1.0".to_string(),
            },
            session_count: 0,
            active_sessions: 0,
        })
        .await;

    let list = registry.list().await;
    assert_eq!(list.len(), 2);
}

#[tokio::test]
async fn test_agent_unregister() {
    let (registry, _db_guard) = test_registry(30).await;
    registry
        .register(AgentInfo {
            agent_id: "to_remove".to_string(),
            hostname: "h".to_string(),
            ip_address: "10.0.0.1".to_string(),
            port: 8080,
            connect_url: None,
            addresses: vec![],
            registered_at: Utc::now(),
            last_heartbeat: Utc::now(),
            status: AgentStatus::Online,
            metadata: AgentMetadata {
                tmux_version: "3.3".to_string(),
                os_version: "Linux".to_string(),
                nession_version: "0.1.0".to_string(),
            },
            session_count: 0,
            active_sessions: 0,
        })
        .await;

    assert!(registry.get("to_remove").await.is_some());
    registry.unregister("to_remove").await;
    assert!(registry.get("to_remove").await.is_none());
}

#[tokio::test]
async fn test_agent_check_offline() {
    let (registry, _db_guard) = test_registry(1).await;

    let agent = AgentInfo {
        agent_id: "stale".to_string(),
        hostname: "stale-host".to_string(),
        ip_address: "10.0.0.99".to_string(),
        port: 8080,
        connect_url: None,
        addresses: vec![],
        registered_at: Utc::now(),
        last_heartbeat: Utc::now() - chrono::Duration::seconds(5), // 5 seconds ago
        status: AgentStatus::Online,
        metadata: AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
        },
        session_count: 0,
        active_sessions: 0,
    };
    registry.register(agent.clone()).await;

    let offline = registry.check_offline_agents().await;
    assert_eq!(offline, vec!["stale"]);

    let updated = registry.get("stale").await.unwrap();
    assert_eq!(updated.status, AgentStatus::Offline);
}

#[tokio::test]
async fn test_agent_check_offline_skips_already_offline() {
    let (registry, _db_guard) = test_registry(1).await;

    let agent = AgentInfo {
        agent_id: "already_off".to_string(),
        hostname: "off-host".to_string(),
        ip_address: "10.0.0.1".to_string(),
        port: 8080,
        connect_url: None,
        addresses: vec![],
        registered_at: Utc::now(),
        last_heartbeat: Utc::now() - chrono::Duration::seconds(100),
        status: AgentStatus::Offline,
        metadata: AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
        },
        session_count: 0,
        active_sessions: 0,
    };
    registry.register(agent).await;

    // Should return empty — already offline
    let offline = registry.check_offline_agents().await;
    assert!(offline.is_empty());
}

#[tokio::test]
async fn test_update_heartbeat_nonexistent_agent_is_noop() {
    let (registry, _db_guard) = test_registry(30).await;
    // Should not panic
    registry.update_heartbeat("nonexistent", 0, 0).await;
}

#[tokio::test]
async fn test_get_nonexistent_agent_returns_none() {
    let (registry, _db_guard) = test_registry(30).await;
    assert!(registry.get("ghost").await.is_none());
}
