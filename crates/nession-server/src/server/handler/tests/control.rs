//! Tests localized to the control handler (Issue #1258).
use super::*;

#[tokio::test]
async fn control_heartbeat_registered_is_handled_and_answered_with_nothing() {
    let mut h = test_handler("").await;
    // Register first
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
            "control.heartbeat",
            json!({
                "agent_id": "a1",
                "session_count": 3,
                "active_sessions": 1,
            }),
        ))
        .await
        .unwrap();
    // Handled, and answered with nothing: control has no acknowledgement,
    // so there is no `server.heartbeat.ack` for this to be the request half
    // of. `Reply(None)` rather than a frame is the whole assertion.
    assert!(matches!(action, HandlerAction::Reply(None)));

    // The bookkeeping the heartbeat exists for still happened.
    let agent = h.agent_registry.get("a1").await.expect("registered agent");
    assert_eq!(agent.session_count, 3);
    assert_eq!(agent.active_sessions, 1);
}

#[tokio::test]
async fn control_heartbeat_unregistered_returns_none() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "control.heartbeat",
            json!({
                "agent_id": "unknown",
                "session_count": 0,
                "active_sessions": 0,
            }),
        ))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
}

#[tokio::test]
async fn control_heartbeat_missing_fields_defaults_to_zero() {
    let mut h = test_handler("").await;
    // Register
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
    // Heartbeat with no session_count / active_sessions
    let action = h
        .handle_message(proto_msg("control.heartbeat", json!({ "agent_id": "a1" })))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
    let agent = h.agent_registry.get("a1").await.expect("registered agent");
    assert_eq!(agent.session_count, 0);
    assert_eq!(agent.active_sessions, 0);
}
