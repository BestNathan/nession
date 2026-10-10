//! Tests localized to the server_agent_address_update_v1 handler (Issue #1258).
use super::*;

#[tokio::test]
async fn agent_address_update_updates_addresses() {
    let mut h = test_handler("").await;
    // Register an agent with an initial address.
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "1.2.3.4",
            "port": 19091,
            "auth_token": "",
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [
                { "url": "ws://1.2.3.4:19091/ws", "network_type": "lan" }
            ],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
        }),
    ))
    .await
    .unwrap();

    // Send an address update with new addresses.
    let action = h
        .handle_message(proto_msg(
            "server.agent.address-update",
            json!({
                "agent_id": "a1",
                "addresses": [
                    { "url": "ws://10.0.0.5:19091/ws", "network_type": "lan" },
                    { "url": "wss://tunnel.example.com/ws", "network_type": "tunnel" },
                ],
            }),
        ))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));

    // Verify the agent's addresses were updated.
    let agent = h.agent_registry.get("a1").await.unwrap();
    assert_eq!(agent.addresses.len(), 2);

    let urls: Vec<&str> = agent
        .addresses
        .iter()
        .map(|p| p.address.url.as_str())
        .collect();
    assert!(urls.contains(&"ws://10.0.0.5:19091/ws"));
    assert!(urls.contains(&"wss://tunnel.example.com/ws"));
}

#[tokio::test]
async fn agent_address_update_unknown_agent_is_noop() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.agent.address-update",
            json!({
                "agent_id": "nonexistent",
                "addresses": [],
            }),
        ))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
}
