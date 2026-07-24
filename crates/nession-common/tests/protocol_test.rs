use nession_common::protocol::{
    AgentAddress, AgentCommandResponsePayload, AgentHeartbeatPayload, AgentMetadata,
    AgentRegisterPayload, AgentRegisterResponsePayload, AgentStatus, ClientSessionCreatePayload,
    ClientSessionCreateResponsePayload, ClientSessionKillPayload, ClientSessionKillResponsePayload,
    HeartbeatMetadata, Message, NetworkType, ProtocolMessage, ServerHeartbeatAckPayload,
    ServerSessionCreatePayload, ServerSessionKillPayload,
};

#[test]
fn test_message_new() {
    let msg: ProtocolMessage<String> = Message::new(
        "test.type".to_string(),
        "msg-1".to_string(),
        1234567890,
        "hello".to_string(),
    );
    assert_eq!(msg.msg_type, "test.type");
    assert_eq!(msg.id, "msg-1");
    assert_eq!(msg.timestamp, 1234567890);
    assert_eq!(msg.payload, "hello");
}

#[test]
fn test_agent_register_payload_serialization() {
    let payload = AgentRegisterPayload {
        agent_id: "agent-1".to_string(),
        hostname: "server1".to_string(),
        ip_address: "10.0.0.1".to_string(),
        port: 9090,
        auth_token: "secret".to_string(),
        metadata: AgentMetadata {
            tmux_version: "3.3a".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.3.2".to_string(),
            image_tag: "test".to_string(),
        },
        protocol_version: "1.0".to_string(),
        display_name: None,
        connect_url: Some("wss://agent.example.com/ws".to_string()),
        addresses: vec![],
    };

    let json = serde_json::to_string(&payload).unwrap();
    let decoded: AgentRegisterPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.agent_id, "agent-1");
    assert_eq!(decoded.hostname, "server1");
    assert_eq!(decoded.port, 9090);
    assert_eq!(decoded.connect_url.unwrap(), "wss://agent.example.com/ws");
}

#[test]
fn test_agent_register_payload_with_addresses_roundtrip() {
    let payload = AgentRegisterPayload {
        agent_id: "agent-multi".to_string(),
        hostname: "node1".to_string(),
        ip_address: "192.168.1.5".to_string(),
        port: 8080,
        auth_token: "secret".to_string(),
        metadata: AgentMetadata {
            tmux_version: "3.3a".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.5.1".to_string(),
            image_tag: "test".to_string(),
        },
        protocol_version: "1.0".to_string(),
        display_name: None,
        connect_url: None,
        addresses: vec![
            AgentAddress {
                url: "ws://192.168.1.5:8080/ws".to_string(),
                label: Some("LAN".to_string()),
                network_type: NetworkType::Lan,
                priority: 10,
            },
            AgentAddress {
                url: "wss://agent.example.com/ws".to_string(),
                label: Some("Tunnel".to_string()),
                network_type: NetworkType::Tunnel,
                priority: 30,
            },
        ],
    };

    let json = serde_json::to_string(&payload).unwrap();
    let decoded: AgentRegisterPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.addresses.len(), 2);
    assert_eq!(
        decoded.addresses.first().unwrap().network_type,
        NetworkType::Lan
    );
    assert_eq!(
        decoded.addresses.get(1).unwrap().url,
        "wss://agent.example.com/ws"
    );
    // network_type serialises lowercase.
    assert!(json.contains("\"network_type\":\"lan\""));
}

#[test]
fn test_agent_register_payload_legacy_json_defaults_addresses() {
    // An old agent that predates the `addresses` field omits it entirely.
    let legacy = r#"{
        "agent_id": "old-agent",
        "hostname": "legacy",
        "ip_address": "10.0.0.9",
        "port": 8080,
        "auth_token": "tok",
        "metadata": {"tmux_version":"3.2","os_version":"Linux","nession_version":"0.4.0"},
        "protocol_version": "1.0"
    }"#;
    let decoded: AgentRegisterPayload = serde_json::from_str(legacy).unwrap();
    assert!(decoded.addresses.is_empty());
    assert!(decoded.connect_url.is_none());
    assert_eq!(decoded.ip_address, "10.0.0.9");
}

#[test]
fn test_agent_address_priority_defaults_to_zero_when_absent() {
    // `priority` has serde(default); absent → 0 (the "unset" sentinel that
    // finalize_addresses later replaces with the type default).
    let json = r#"{"url":"ws://h:9/ws","network_type":"custom"}"#;
    let decoded: AgentAddress = serde_json::from_str(json).unwrap();
    assert_eq!(decoded.priority, 0);
    assert!(decoded.label.is_none());
    assert_eq!(decoded.network_type, NetworkType::Custom);
}

#[test]
fn test_agent_register_payload_without_connect_url() {
    let payload = AgentRegisterPayload {
        agent_id: "agent-2".to_string(),
        hostname: "server2".to_string(),
        ip_address: "10.0.0.2".to_string(),
        port: 8080,
        auth_token: "".to_string(),
        metadata: AgentMetadata {
            tmux_version: "3.2".to_string(),
            os_version: "macOS".to_string(),
            nession_version: "0.2.0".to_string(),
            image_tag: "test".to_string(),
        },
        protocol_version: "1.0".to_string(),
        display_name: None,
        connect_url: None,
        addresses: vec![],
    };

    let json = serde_json::to_string(&payload).unwrap();
    let decoded: AgentRegisterPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.agent_id, "agent-2");
    assert!(decoded.connect_url.is_none());
    assert!(decoded.auth_token.is_empty());
}

#[test]
fn test_agent_register_response_payload_accepted() {
    let payload = AgentRegisterResponsePayload {
        status: "accepted".to_string(),
        message: "ok".to_string(),
        heartbeat_interval_secs: Some(15),
    };

    let json = serde_json::to_string(&payload).unwrap();
    let decoded: AgentRegisterResponsePayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.status, "accepted");
    assert_eq!(decoded.heartbeat_interval_secs, Some(15));
}

#[test]
fn test_agent_register_response_payload_rejected() {
    let payload = AgentRegisterResponsePayload {
        status: "rejected".to_string(),
        message: "bad token".to_string(),
        heartbeat_interval_secs: None,
    };

    let json = serde_json::to_string(&payload).unwrap();
    let decoded: AgentRegisterResponsePayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.status, "rejected");
    assert!(decoded.heartbeat_interval_secs.is_none());
}

#[test]
fn test_agent_heartbeat_payload_serialization() {
    let payload = AgentHeartbeatPayload {
        agent_id: "agent-1".to_string(),
        status: AgentStatus::Online,
        session_count: 5,
        active_sessions: 3,
        metadata: HeartbeatMetadata {
            uptime_seconds: 3600,
            load_average: [1.0, 2.0, 3.0],
            agent: None,
        },
    };

    let json = serde_json::to_string(&payload).unwrap();
    let decoded: AgentHeartbeatPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.agent_id, "agent-1");
    assert_eq!(decoded.session_count, 5);
    assert_eq!(decoded.active_sessions, 3);
    assert_eq!(decoded.metadata.load_average, [1.0, 2.0, 3.0]);
}

#[test]
fn test_agent_status_serialization() {
    let online: AgentStatus = serde_json::from_str("\"online\"").unwrap();
    assert!(matches!(online, AgentStatus::Online));
    let offline: AgentStatus = serde_json::from_str("\"offline\"").unwrap();
    assert!(matches!(offline, AgentStatus::Offline));
    let degraded: AgentStatus = serde_json::from_str("\"degraded\"").unwrap();
    assert!(matches!(degraded, AgentStatus::Degraded));

    assert_eq!(
        serde_json::to_string(&AgentStatus::Online).unwrap(),
        "\"online\""
    );
}

#[test]
fn test_server_heartbeat_ack_payload() {
    let payload = ServerHeartbeatAckPayload {
        agent_id: "agent-1".to_string(),
        server_time: 1700000000,
    };
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: ServerHeartbeatAckPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.agent_id, "agent-1");
    assert_eq!(decoded.server_time, 1700000000);
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

#[test]
fn test_message_wrapped_in_protocol_envelope() {
    let msg: ProtocolMessage<AgentRegisterPayload> = Message {
        msg_type: "agent.register".to_string(),
        id: "msg-99".to_string(),
        timestamp: 1700000000,
        payload: AgentRegisterPayload {
            agent_id: "a1".to_string(),
            hostname: "h1".to_string(),
            ip_address: "1.2.3.4".to_string(),
            port: 8080,
            auth_token: "tok".to_string(),
            metadata: AgentMetadata {
                tmux_version: "3.3".to_string(),
                os_version: "Linux".to_string(),
                nession_version: "0.1.0".to_string(),
                image_tag: "test".to_string(),
            },
            protocol_version: "1.0".to_string(),
            display_name: None,
            connect_url: None,
            addresses: vec![],
        },
    };

    let json = serde_json::to_string(&msg).unwrap();
    let decoded: ProtocolMessage<AgentRegisterPayload> = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.msg_type, "agent.register");
    assert_eq!(decoded.id, "msg-99");
    assert_eq!(decoded.payload.agent_id, "a1");
    assert_eq!(decoded.payload.metadata.tmux_version, "3.3");
}
