//! Tests localized to the server_agent_session_update_v1 handler (Issue #1258).
use super::*;

#[tokio::test]
async fn session_update_active() {
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
            "server.agent.session-update",
            json!({
                "agent_id": "a1",
                "session_name": "dev",
                "status": "active",
                "window_count": 2,
                "attached_clients": 1,
            }),
        ))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
}

#[tokio::test]
async fn session_update_all_statuses() {
    let mut h = test_handler("").await;
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

    for status in &["active", "detached", "recovering", "orphaned", "zombie"] {
        let action = h
            .handle_message(proto_msg(
                "server.agent.session-update",
                json!({
                    "agent_id": "a1",
                    "session_name": format!("s_{status}"),
                    "status": status,
                    "window_count": 1,
                    "attached_clients": 0,
                }),
            ))
            .await
            .unwrap();
        assert!(matches!(action, HandlerAction::Reply(None)));
    }
}

#[tokio::test]
async fn session_update_unknown_status_returns_none() {
    let mut h = test_handler("").await;
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
            "server.agent.session-update",
            json!({
                "agent_id": "a1",
                "session_name": "dev",
                "status": "invalid_status",
            }),
        ))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
}

#[tokio::test]
async fn session_update_gone_removes_session() {
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
    // Create a session
    h.handle_message(proto_msg(
        "server.agent.session-update",
        json!({
            "agent_id": "a1",
            "session_name": "dev",
            "status": "active",
            "window_count": 1,
            "attached_clients": 0,
        }),
    ))
    .await
    .unwrap();
    // Remove it
    h.handle_message(proto_msg(
        "server.agent.session-update",
        json!({
            "agent_id": "a1",
            "session_name": "dev",
            "status": "gone",
        }),
    ))
    .await
    .unwrap();
    // Session should be gone
    let _action = h
        .handle_message(proto_msg("server.session.list", json!({})))
        .await
        .unwrap();
    // First need to authenticate
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg("server.session.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["sessions"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn session_update_from_unregistered_agent() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.agent.session-update",
            json!({
                "agent_id": "unknown",
                "session_name": "dev",
                "status": "active",
            }),
        ))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
}

/// Session ids are `agent_id:session_name`, so the payload's id chooses the
/// namespace an update writes into — a connection registered as `a1`
/// reporting for `a2` would rewrite another agent's session list.
#[tokio::test]
async fn session_update_for_another_agent_is_refused() {
    let mut h = test_handler("").await;
    register_agent_connection(&mut h, "a1").await;
    register_agent_id(&h, "a2", None).await;

    h.handle_message(proto_msg(
        "server.agent.session-update",
        json!({ "agent_id": "a2", "session_name": "sneaky", "status": "active" }),
    ))
    .await
    .unwrap();

    assert!(
        h.session_registry
            .list()
            .await
            .iter()
            .all(|session| !session.session_id.starts_with("a2:")),
        "a1's connection must not create sessions under a2"
    );
}

/// A message that names no agent is not lying about one: the connection's
/// registered identity supplies the answer, so an agent that sends the id
/// only in its registration is still understood.
#[tokio::test]
async fn session_update_without_an_agent_id_uses_the_connection_identity() {
    let mut h = test_handler("").await;
    register_agent_connection(&mut h, "a1").await;

    h.handle_message(proto_msg(
        "server.agent.session-update",
        json!({ "session_name": "dev", "status": "active", "window_count": 1 }),
    ))
    .await
    .unwrap();

    assert!(
        h.session_registry
            .list()
            .await
            .iter()
            .any(|session| session.session_id == "a1:dev"),
        "the bound identity must be enough to place the update"
    );
}
