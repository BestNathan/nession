use std::process::Command;

#[test]
fn test_cli_help() {
    let output = Command::new("cargo")
        .args(["run", "--bin", "nession", "--", "--help"])
        .output()
        .expect("Failed to execute command");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Distributed tmux session management system"));
    assert!(stdout.contains("agents"));
    assert!(stdout.contains("sessions"));
}

#[test]
fn test_agents_list_help() {
    let output = Command::new("cargo")
        .args(["run", "--bin", "nession", "--", "agents", "list", "--help"])
        .output()
        .expect("Failed to execute command");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("List all agents"));
}

#[test]
fn test_sessions_list_help() {
    let output = Command::new("cargo")
        .args([
            "run", "--bin", "nession", "--", "sessions", "list", "--help",
        ])
        .output()
        .expect("Failed to execute command");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("List all sessions"));
    assert!(stdout.contains("--agent-id"));
}

#[test]
fn test_agents_list_no_server() {
    // Should fail gracefully when server is not running
    let output = Command::new("cargo")
        .args([
            "run",
            "--bin",
            "nession",
            "--",
            "--server-url",
            "ws://localhost:59999",
            "agents",
            "list",
        ])
        .output()
        .expect("Failed to execute command");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Failed to connect") || stderr.contains("Connection refused"));
}

#[test]
fn test_sessions_list_no_server() {
    // Should fail gracefully when server is not running
    let output = Command::new("cargo")
        .args([
            "run",
            "--bin",
            "nession",
            "--",
            "--server-url",
            "ws://localhost:59999",
            "sessions",
            "list",
        ])
        .output()
        .expect("Failed to execute command");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Failed to connect") || stderr.contains("Connection refused"));
}

#[test]
fn test_agent_info_deserialization() {
    use nession_cli::client::connection::AgentInfo;

    let json_data = r#"{
        "agent_id": "agent_001",
        "hostname": "dev-server-01",
        "ip_address": "192.168.1.100",
        "port": 8080,
        "status": "online",
        "session_count": 5,
        "last_heartbeat": "2024-01-15T10:30:00Z"
    }"#;

    let agent: AgentInfo = serde_json::from_str(json_data).expect("Failed to deserialize");
    assert_eq!(agent.agent_id, "agent_001");
    assert_eq!(agent.hostname, "dev-server-01");
    assert_eq!(agent.status, "online");
    assert_eq!(agent.session_count, 5);
}

#[test]
fn test_session_info_deserialization() {
    use nession_cli::client::connection::SessionInfo;

    let json_data = r#"{
        "session_id": "agent_001:dev-work",
        "agent_id": "agent_001",
        "session_name": "dev-work",
        "status": "active",
        "window_count": 3,
        "attached_clients": 1
    }"#;

    let session: SessionInfo = serde_json::from_str(json_data).expect("Failed to deserialize");
    assert_eq!(session.session_id, "agent_001:dev-work");
    assert_eq!(session.agent_id, "agent_001");
    assert_eq!(session.session_name, "dev-work");
    assert_eq!(session.status, "active");
    assert_eq!(session.window_count, 3);
    assert_eq!(session.attached_clients, 1);
}
