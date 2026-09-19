use super::v1::*;
use crate::{Message, ProtocolMessage};

#[test]
fn an_agent_register_rides_in_the_envelope_and_comes_back_intact() {
    // The kernel's own tests pin the envelope; this pins the envelope *with a
    // contract payload in it*, which is the pair every real message is. A
    // rename on either side that the other's tests do not see fails here.
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
            protocol_manifest: None,
        },
    };

    let json = serde_json::to_string(&msg).unwrap();
    let decoded: ProtocolMessage<AgentRegisterPayload> = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.msg_type, "agent.register");
    assert_eq!(decoded.id, "msg-99");
    assert_eq!(decoded.payload.agent_id, "a1");
    assert_eq!(decoded.payload.metadata.tmux_version, "3.3");
}

#[test]
fn test_agent_address_update_payload_serde() {
    let payload = AgentAddressUpdatePayload {
        agent_id: "agent-1".to_string(),
        addresses: vec![AgentAddress {
            url: "ws://192.168.1.5:8080/ws".to_string(),
            label: Some("LAN (eth0)".to_string()),
            network_type: NetworkType::Lan,
            priority: 10,
        }],
    };
    let json = serde_json::to_string(&payload).unwrap();
    let deserialized: AgentAddressUpdatePayload = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.agent_id, "agent-1");
    assert_eq!(deserialized.addresses.len(), 1);
    assert_eq!(deserialized.addresses[0].url, "ws://192.168.1.5:8080/ws");
    assert_eq!(deserialized.addresses[0].network_type, NetworkType::Lan);
}

#[test]
fn test_network_type_as_str() {
    assert_eq!(NetworkType::Lan.as_str(), "lan");
    assert_eq!(NetworkType::Vpn.as_str(), "vpn");
    assert_eq!(NetworkType::Tunnel.as_str(), "tunnel");
    assert_eq!(NetworkType::Public.as_str(), "public");
    assert_eq!(NetworkType::Custom.as_str(), "custom");
}

#[test]
fn test_network_type_serde() {
    let t: NetworkType = serde_json::from_str("\"lan\"").unwrap();
    assert_eq!(t, NetworkType::Lan);
    let json = serde_json::to_string(&NetworkType::Tunnel).unwrap();
    assert_eq!(json, "\"tunnel\"");
}

#[test]
fn test_address_status_as_str() {
    assert_eq!(AddressStatus::Unknown.as_str(), "unknown");
    assert_eq!(AddressStatus::Reachable.as_str(), "reachable");
    assert_eq!(AddressStatus::Unreachable.as_str(), "unreachable");
}

#[test]
fn test_agent_register_payload_serde() {
    let payload = AgentRegisterPayload {
        agent_id: "agent-1".to_string(),
        hostname: "host".to_string(),
        ip_address: "127.0.0.1".to_string(),
        port: 8080,
        auth_token: "token".to_string(),
        metadata: AgentMetadata {
            tmux_version: "3.4".to_string(),
            os_version: "linux".to_string(),
            nession_version: "0.1.0".to_string(),
            image_tag: "test".to_string(),
        },
        protocol_version: "1.0".to_string(),
        display_name: Some("my-agent".to_string()),
        connect_url: None,
        addresses: vec![],
        protocol_manifest: None,
    };
    let json = serde_json::to_string(&payload).unwrap();
    let deserialized: AgentRegisterPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.agent_id, "agent-1");
    assert_eq!(deserialized.port, 8080);
    assert!(deserialized.connect_url.is_none());
}

#[test]
fn test_agent_register_payload_no_display_name() {
    // Old agents without display_name should deserialize to None (backward compat)
    let json = serde_json::json!({
        "agent_id": "agent-1",
        "hostname": "host",
        "ip_address": "127.0.0.1",
        "port": 8080,
        "auth_token": "token",
        "addresses": [],
        "metadata": {
            "tmux_version": "3.4",
            "os_version": "linux",
            "nession_version": "0.1.0"
        }
    });
    let payload: AgentRegisterPayload = serde_json::from_value(json).unwrap();
    assert_eq!(payload.agent_id, "agent-1");
    assert!(payload.display_name.is_none());
}

#[test]
fn test_agent_metadata_image_tag_default() {
    let json = r#"{"tmux_version":"3.3","os_version":"Linux","nession_version":"0.1.0"}"#;
    let meta: AgentMetadata = serde_json::from_str(json).unwrap();
    assert_eq!(meta.image_tag, "unknown"); // serde default
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
        protocol_manifest: None,
    };

    let json = serde_json::to_string(&payload).unwrap();
    let decoded: AgentRegisterPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.agent_id, "agent-1");
    assert_eq!(decoded.hostname, "server1");
    assert_eq!(decoded.port, 9090);
    assert_eq!(decoded.connect_url.unwrap(), "wss://agent.example.com/ws");
}

#[test]
fn a_pre_678_agent_registers_exactly_as_it_always_did() {
    // #678 put the manifest in `agent.register` rather than a separate discovery
    // message, and the design's condition for that was that an old agent's
    // register still parses. This is that condition, as a test: the payload has
    // no `protocol_manifest` key at all.
    let from_an_old_agent = serde_json::json!({
        "agent_id": "legacy",
        "hostname": "old-box",
        "ip_address": "10.0.0.9",
        "port": 8080,
        "auth_token": "tok",
        "metadata": {
            "tmux_version": "3.3",
            "os_version": "Linux",
            "nession_version": "0.30.0",
            "image_tag": "test"
        },
        "protocol_version": "1.0",
    });

    let decoded: AgentRegisterPayload = serde_json::from_value(from_an_old_agent).unwrap();
    assert_eq!(decoded.agent_id, "legacy");
    assert!(
        decoded.protocol_manifest.is_none(),
        "an absent manifest means Legacy Peer — never 'supports everything'"
    );
}

#[test]
fn an_absent_manifest_is_omitted_from_the_wire_rather_than_null() {
    // `null` would read as "this agent has a manifest and it is empty", which is
    // a different claim from "this agent predates manifests". The server
    // resolves the two differently, so the wire must distinguish them.
    let payload = AgentRegisterPayload {
        agent_id: "a".to_string(),
        hostname: "h".to_string(),
        ip_address: "1.2.3.4".to_string(),
        port: 8080,
        auth_token: "t".to_string(),
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
        protocol_manifest: None,
    };

    let json = serde_json::to_value(&payload).unwrap();
    assert!(json.get("protocol_manifest").is_none(), "got {json}");
}

#[test]
fn a_manifest_rides_along_in_the_register_payload() {
    // The composed manifest, as an agent would send it. One unit, one version —
    // and the version comes back as an integer, so a peer reading this in any
    // language sees the same thing.
    let manifest: crate::ProtocolManifest = serde_json::from_value(serde_json::json!({
        "provider": "agent-1",
        "protocols": { "git.status": { "versions": [1] } }
    }))
    .unwrap();

    let payload = AgentRegisterPayload {
        agent_id: "agent-1".to_string(),
        hostname: "h".to_string(),
        ip_address: "1.2.3.4".to_string(),
        port: 8080,
        auth_token: "t".to_string(),
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
        protocol_manifest: Some(manifest),
    };

    let json = serde_json::to_value(&payload).unwrap();
    assert_eq!(
        json["protocol_manifest"]["protocols"]["git.status"]["versions"][0],
        1
    );

    let decoded: AgentRegisterPayload = serde_json::from_value(json).unwrap();
    let manifest = decoded
        .protocol_manifest
        .expect("the manifest survives the round trip");
    let id = crate::ProtocolId::new("git.status").unwrap();
    assert!(manifest.offers(&id), "and still names the unit it carried");
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
        protocol_manifest: None,
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
        protocol_manifest: None,
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
