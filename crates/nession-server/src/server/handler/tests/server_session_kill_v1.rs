//! Tests localized to the server_session_kill_v1 handler (Issue #1258).
use super::*;

#[tokio::test]
async fn session_kill_invalid_format() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.session.kill",
            json!({ "session_id": "no-colon" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("Invalid session_id format"));
}

#[tokio::test]
async fn session_kill_agent_not_found() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.session.kill",
            json!({ "session_id": "unknown:s1" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("not found"));
}

#[tokio::test]
async fn session_kill_session_not_found_agent_online() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    // Register agent (it's online)
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
    // Kill a session that doesn't exist — agent is online
    let action = h
        .handle_message(proto_msg(
            "server.session.kill",
            json!({ "session_id": "a1:nonexistent" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("not found"));
}

#[tokio::test]
async fn session_kill_reply_is_what_its_contract_says_it_is() {
    // The one branch worth pinning is the offline-agent one: it used to
    // send `{ "success": true }` with no `error` field, and the type has no
    // `skip_serializing_if`, so it now carries `error: null`. That reads as
    // noise unless you know the Web declares `error?: string` — so this
    // asserts the field is *present and null*, not merely absent, which is
    // the difference a typo in the type would silently remove.
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg("server.session.kill", json!({})))
        .await
        .unwrap();
    let payload = parse_reply(action)["payload"].clone();
    let parsed: WebSessionKillResponse =
        serde_json::from_value(payload.clone()).unwrap_or_else(|e| {
            panic!("server.session.kill replies {payload} but its contract does not accept it: {e}")
        });
    assert!(!parsed.success);
    assert!(parsed.error.is_some(), "a bad session_id says why");
}
