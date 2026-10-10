//! Tests localized to the server_agent_command_response_v1 handler (Issue #1258).
use super::*;

#[tokio::test]
async fn command_response_from_unregistered_returns_none() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.agent.command-response",
            json!({ "request_id": "r1", "success": true }),
        ))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
}

#[tokio::test]
async fn command_response_missing_request_id_returns_none() {
    let mut h = test_handler("").await;
    // Register agent
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
            "metadata": { "tmux_version": "3.3", "os_version": "linux", "nession_version": "0.1" },
        }),
    ))
    .await
    .unwrap();
    let action = h
        .handle_message(proto_msg(
            "server.agent.command-response",
            json!({ "request_id": "", "success": true }),
        ))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
}
