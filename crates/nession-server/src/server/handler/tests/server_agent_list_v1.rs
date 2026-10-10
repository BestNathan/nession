//! Tests localized to the server_agent_list_v1 handler (Issue #1258).
use super::*;

#[tokio::test]
async fn agents_list_returns_registered() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    // Register an agent
    h.handle_message(proto_msg(
        "server.agent.register",
        json!({
            "agent_id": "a1",
            "hostname": "host",
            "ip_address": "1.2.3.4",
            "port": 19091,
            "auth_token": "",
            "protocol_manifest": {"provider": "test-agent", "protocols": {"git.status": {"versions": [1], "wire": ["git.status"]}}},
            "addresses": [],
            "connect_url": null,
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1", "image_tag": "sha-abc123" },
        }),
    ))
    .await
    .unwrap();

    let action = h
        .handle_message(proto_msg("server.agent.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    let agents = reply["payload"]["agents"].as_array().unwrap();
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0]["agent_id"], "a1");
    assert_eq!(agents[0]["status"], "online");
    // image_tag must be forwarded to clients (regression: it was dropped
    // from the metadata JSON, so the UI showed "unknown").
    assert_eq!(agents[0]["metadata"]["image_tag"], "sha-abc123");
}

#[tokio::test]
async fn agents_list_empty() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg("server.agent.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["agents"].as_array().unwrap().is_empty());
}
