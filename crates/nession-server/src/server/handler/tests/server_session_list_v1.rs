//! Tests localized to the server_session_list_v1 handler (Issue #1258).
use super::*;

#[tokio::test]
async fn sessions_list_with_filter() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
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
    // Create sessions
    for name in &["s1", "s2"] {
        h.handle_message(proto_msg(
            "server.agent.session-update",
            json!({
                "agent_id": "a1",
                "session_name": name,
                "status": "active",
                "window_count": 1,
                "attached_clients": 0,
            }),
        ))
        .await
        .unwrap();
    }
    // Filter by agent_id
    let action = h
        .handle_message(proto_msg(
            "server.session.list",
            json!({ "agent_id": "a1" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    let sessions = reply["payload"]["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2);
}

#[tokio::test]
async fn force_refresh_with_no_agents_is_a_noop() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg("server.session.list", json!({ "force": true })))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["sessions"].as_array().unwrap().is_empty());
    assert!(reply["payload"]["stale_agents"]
        .as_array()
        .unwrap()
        .is_empty());
}

/// The core failure-semantics guarantee: an agent that cannot answer keeps
/// its sessions and is reported stale, rather than having live sessions
/// deleted because of a transient blip.
#[tokio::test]
async fn force_refresh_keeps_sessions_of_unreachable_agent_and_marks_stale() {
    let mut h = handler_with_online_agent().await;
    add_session(&mut h, "a1", "s1").await;

    let action = h
        .handle_message(proto_msg("server.session.list", json!({ "force": true })))
        .await
        .unwrap();
    let reply = parse_reply(action);

    // Session survived.
    let sessions = reply["payload"]["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["session_id"], "a1:s1");
    // And the agent is flagged so the UI can warn.
    let stale = reply["payload"]["stale_agents"].as_array().unwrap();
    assert_eq!(stale.len(), 1);
    assert_eq!(stale[0], "a1");
}

/// The `agent_id` filter narrows the fan-out targets: an id matching no
/// agent contacts nobody, so nothing is stale and nothing is returned.
#[tokio::test]
async fn force_refresh_scopes_fanout_to_the_requested_agent() {
    let mut h = handler_with_online_agent().await;
    add_session(&mut h, "a1", "s1").await;

    let action = h
        .handle_message(proto_msg(
            "server.session.list",
            json!({ "force": true, "agent_id": "nonexistent" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);

    assert!(reply["payload"]["stale_agents"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(reply["payload"]["sessions"].as_array().unwrap().is_empty());
    // a1's session was left alone — it was never a refresh target.
    assert_eq!(h.session_registry.list().await.len(), 1);
}

/// The happy path: the agent answers with its live tmux state and the
/// registry is rebuilt from it — stale entries dropped, real ones kept,
/// and the agent is not reported stale.
#[tokio::test]
async fn force_refresh_rebuilds_registry_from_agent_reply() {
    let mut h = handler_with_online_agent().await;
    // Registry believes "ghost" exists; tmux will say otherwise.
    add_session(&mut h, "a1", "ghost").await;

    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;

    let broker = Arc::clone(&h.command_broker);
    let list_fut = h.handle_message(proto_msg("server.session.list", json!({ "force": true })));
    let agent_fut = async move {
        let text = rx
            .recv()
            .await
            .expect("agent should receive sessions.list")
            .message
            .to_text()
            .unwrap()
            .to_string();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["msg_type"], "agent.session.report");
        let request_id = parsed["payload"]["request_id"]
            .as_str()
            .unwrap()
            .to_string();
        broker
            .resolve_command(
                "a1",
                &request_id,
                json!({
                    "success": true,
                    "sessions": [
                        {
                            "name": "real",
                            "window_count": 2,
                            "attached_clients": 1,
                            "created_at": 1000,
                            "foreground_command": "claude",
                        },
                    ],
                }),
            )
            .await;
    };
    let (action, ()) = tokio::join!(list_fut, agent_fut);
    let reply = parse_reply(action.unwrap());

    let sessions = reply["payload"]["sessions"].as_array().unwrap();
    assert_eq!(
        sessions.len(),
        1,
        "ghost should be gone, real should remain"
    );
    assert_eq!(sessions[0]["session_id"], "a1:real");
    assert_eq!(sessions[0]["status"], "active");
    assert_eq!(sessions[0]["window_count"], 2);
    assert_eq!(
        sessions[0]["foreground_command"], "claude",
        "the agent-reported pane command must survive the refresh into the wire payload"
    );
    assert!(reply["payload"]["stale_agents"]
        .as_array()
        .unwrap()
        .is_empty());
}
