use super::v1::*;

#[test]
fn test_default_attach_mode() {
    assert_eq!(default_attach_mode(), "p2p");
}

#[test]
fn test_terminal_resize_payload_serde() {
    let payload = AgentTerminalResizePayload {
        session_id: "session-123".to_string(),
        cols: 120,
        rows: 40,
    };
    let json = serde_json::to_string(&payload).unwrap();
    let deserialized: AgentTerminalResizePayload = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.session_id, "session-123");
    assert_eq!(deserialized.cols, 120);
    assert_eq!(deserialized.rows, 40);
}

#[test]
fn test_server_terminal_resize_payload_serde() {
    let payload = ServerTerminalResizePayload {
        session_id: "session-123".to_string(),
        cols: 120,
        rows: 40,
    };
    let json = serde_json::to_string(&payload).unwrap();
    let deserialized: ServerTerminalResizePayload = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.session_id, "session-123");
    assert_eq!(deserialized.cols, 120);
    assert_eq!(deserialized.rows, 40);
}

#[test]
fn test_client_session_attach_payload_default_env_snapshots() {
    let json = serde_json::json!({
        "session_id": "agent:session",
        "preferred_mode": "relay"
    });
    let payload: ClientSessionAttachPayload = serde_json::from_value(json).unwrap();
    assert_eq!(payload.session_id, "agent:session");
    assert_eq!(payload.preferred_mode, "relay");
    assert!(payload.env_snapshots.is_empty());
}

#[test]
fn test_client_session_attach_payload_with_env_snapshots() {
    let json = serde_json::json!({
        "session_id": "agent:session",
        "preferred_mode": "relay",
        "env_snapshots": [{
            "name": "staging.env",
            "source": "server",
            "vars": [["NODE_ENV", "staging"], ["DEBUG", "true"]],
            "warnings": []
        }]
    });
    let payload: ClientSessionAttachPayload = serde_json::from_value(json).unwrap();
    assert_eq!(payload.env_snapshots.len(), 1);
    assert_eq!(payload.env_snapshots[0].name, "staging.env");
    assert_eq!(payload.env_snapshots[0].vars.len(), 2);
}

#[test]
fn test_server_session_create_payload() {
    let payload = ServerSessionCreatePayload {
        request_id: "req-1".to_string(),
        name: "my-session".to_string(),
        width: 120,
        height: 40,
        env_snapshots: Vec::new(),
    };
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: ServerSessionCreatePayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.request_id, "req-1");
    assert_eq!(decoded.name, "my-session");
    assert_eq!(decoded.width, 120);
    assert_eq!(decoded.height, 40);
}

#[test]
fn test_server_session_create_default_dimensions() {
    let json = r#"{"request_id":"req-1","name":"sess"}"#;
    let decoded: ServerSessionCreatePayload = serde_json::from_str(json).unwrap();
    assert_eq!(decoded.width, 80);
    assert_eq!(decoded.height, 24);
}

#[test]
fn test_server_session_kill_payload() {
    let payload = ServerSessionKillPayload {
        request_id: "req-2".to_string(),
        name: "doomed".to_string(),
    };
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: ServerSessionKillPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.request_id, "req-2");
    assert_eq!(decoded.name, "doomed");
}

#[test]
fn test_agent_command_response_payload() {
    let payload = AgentCommandResponsePayload {
        request_id: "req-1".to_string(),
        command: "session.create".to_string(),
        success: true,
        error: None,
        session_name: Some("new-session".to_string()),
    };
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: AgentCommandResponsePayload = serde_json::from_str(&json).unwrap();
    assert!(decoded.success);
    assert_eq!(decoded.session_name, Some("new-session".to_string()));
}

#[test]
fn test_agent_command_response_payload_failure() {
    let payload = AgentCommandResponsePayload {
        request_id: "req-2".to_string(),
        command: "session.create".to_string(),
        success: false,
        error: Some("session already exists".to_string()),
        session_name: None,
    };
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: AgentCommandResponsePayload = serde_json::from_str(&json).unwrap();
    assert!(!decoded.success);
    assert_eq!(decoded.error, Some("session already exists".to_string()));
    assert!(decoded.session_name.is_none());
}

#[test]
fn test_client_session_create_payload() {
    let payload = ClientSessionCreatePayload {
        agent_id: "agent-1".to_string(),
        name: "new-session".to_string(),
    };
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: ClientSessionCreatePayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.agent_id, "agent-1");
    assert_eq!(decoded.name, "new-session");
}

#[test]
fn test_client_session_kill_payload() {
    let payload = ClientSessionKillPayload {
        session_id: "agent-1:doomed".to_string(),
    };
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: ClientSessionKillPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.session_id, "agent-1:doomed");
}

#[test]
fn test_client_session_create_response_payload() {
    let payload = ClientSessionCreateResponsePayload {
        success: true,
        session_id: Some("agent-1:new-sess".to_string()),
        error: None,
    };
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: ClientSessionCreateResponsePayload = serde_json::from_str(&json).unwrap();
    assert!(decoded.success);
    assert_eq!(decoded.session_id, Some("agent-1:new-sess".to_string()));
}

#[test]
fn test_client_session_kill_response_payload() {
    let payload = ClientSessionKillResponsePayload {
        success: true,
        error: None,
    };
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: ClientSessionKillResponsePayload = serde_json::from_str(&json).unwrap();
    assert!(decoded.success);
}
