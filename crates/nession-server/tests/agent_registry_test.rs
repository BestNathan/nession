use nession_server::registry::agent::{AgentInfo, AgentRegistry, AgentStatus};
use nession_common::protocol::AgentMetadata;
use chrono::Utc;

#[tokio::test]
async fn test_agent_registration() {
    let registry = AgentRegistry::new(30);

    let agent = AgentInfo {
        agent_id: "agent_123".to_string(),
        hostname: "dev-server".to_string(),
        ip_address: "192.168.1.10".to_string(),
        port: 8080,
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
    let registry = AgentRegistry::new(30);

    let agent = AgentInfo {
        agent_id: "agent_123".to_string(),
        hostname: "dev-server".to_string(),
        ip_address: "192.168.1.10".to_string(),
        port: 8080,
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
