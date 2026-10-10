//! Tests localized to the server_agent_register_v1 handler (Issue #1258).
use super::*;

#[tokio::test]
async fn agent_register_no_auth_mode() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "anything",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "accepted");
    assert_eq!(h.registered_agent_id(), Some(&"a1".to_string()));
}

#[tokio::test]
async fn agent_register_valid_token() {
    let mut h = test_handler("secret").await;
    let action = h
        .handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "secret",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "accepted");
}

#[tokio::test]
async fn agent_register_without_a_manifest_is_rejected() {
    // `#678` is a breaking upgrade: an agent this server cannot route for
    // does not connect. Refusing here rather than at the first relay is the
    // difference between an agent that never comes up and one that
    // connects, looks healthy, and silently drops every request aimed at
    // it.
    //
    // A valid auth token, so the rejection can only be the missing
    // manifest — otherwise this test would pass for the wrong reason.
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "old-agent",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "rejected");
    assert!(
        reply["payload"]["message"]
            .as_str()
            .unwrap()
            .contains("no protocol manifest"),
        "the rejection must name the missing manifest: {reply}"
    );
    // And nothing was registered, so no later call can reach it.
    assert!(
        h.agent_registry.get("old-agent").await.is_none(),
        "a rejected agent must not be in the registry"
    );
}

#[tokio::test]
async fn agent_register_invalid_token_rejected() {
    let mut h = test_handler("secret").await;
    let action = h
        .handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "wrong",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "rejected");
    assert!(reply["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("Invalid auth token"));
}

#[tokio::test]
async fn agent_register_with_addresses() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.agent.register",
            json!({
                "agent_id": "a1",
                "hostname": "host",
                "ip_address": "1.2.3.4",
                "port": 19091,
                "auth_token": "",
                "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
                "addresses": [
                    { "url": "ws://1.2.3.4:19091/ws", "network_type": "lan", "label": "" }
                ],
                "connect_url": null,
                "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "accepted");
    // Verify heartbeat_interval_secs is present
    assert_eq!(reply["payload"]["heartbeat_interval_secs"], 30);
}
