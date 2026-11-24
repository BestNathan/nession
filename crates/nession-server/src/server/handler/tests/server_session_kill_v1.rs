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

/// #4302: a guarded kill forwards the caller-observed incarnation on the
/// canonical Agent command and propagates the Agent's classified conflict
/// without removing the Session from the registry.
#[tokio::test]
async fn session_kill_forwards_the_precondition_and_propagates_a_conflict() {
    let mut h = handler_with_online_agent().await;
    add_session(&mut h, "a1", "s1").await;

    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;

    let broker = Arc::clone(&h.command_broker);
    let registry = Arc::clone(&h.session_registry);
    let kill = h.handle_message(proto_msg(
        "server.session.kill",
        json!({ "session_id": "a1:s1", "expected_instance_id": "instance-a" }),
    ));
    let agent = async move {
        let wire = rx
            .recv()
            .await
            .expect("the Agent receives the kill command");
        let request: serde_json::Value =
            serde_json::from_str(wire.message.to_text().unwrap()).unwrap();
        assert_eq!(request["msg_type"], "agent.session.kill");
        assert_eq!(request["payload"]["name"], "s1");
        assert_eq!(
            request["payload"]["expected_instance_id"], "instance-a",
            "the Server route must carry the precondition to the Agent"
        );
        let request_id = request["payload"]["request_id"].as_str().unwrap();
        broker
            .resolve_command(
                "a1",
                request_id,
                json!({
                    "success": false,
                    "error": "expected instance instance-a, current instance instance-b",
                    "error_kind": "conflict"
                }),
            )
            .await;
    };
    let (action, ()) = tokio::join!(kill, agent);
    let reply = parse_reply(action.unwrap());
    assert_eq!(reply["payload"]["success"], false);
    assert_eq!(reply["payload"]["error_kind"], "conflict");
    assert!(
        registry.get("a1:s1").await.is_some(),
        "a refused kill must not remove the Session from the registry"
    );
}

/// #4302: the legacy name-only kill keeps its command shape and its
/// unclassified reply, and a successful kill still clears the registry.
#[tokio::test]
async fn session_kill_legacy_command_stays_name_addressed() {
    let mut h = handler_with_online_agent().await;
    add_session(&mut h, "a1", "s1").await;

    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;

    let broker = Arc::clone(&h.command_broker);
    let registry = Arc::clone(&h.session_registry);
    let kill = h.handle_message(proto_msg(
        "server.session.kill",
        json!({ "session_id": "a1:s1" }),
    ));
    let agent = async move {
        let wire = rx
            .recv()
            .await
            .expect("the Agent receives the kill command");
        let request: serde_json::Value =
            serde_json::from_str(wire.message.to_text().unwrap()).unwrap();
        assert!(
            request["payload"].get("expected_instance_id").is_none(),
            "a legacy kill must not invent a precondition"
        );
        let request_id = request["payload"]["request_id"].as_str().unwrap();
        broker
            .resolve_command("a1", request_id, json!({ "success": true }))
            .await;
    };
    let (action, ()) = tokio::join!(kill, agent);
    let reply = parse_reply(action.unwrap());
    assert_eq!(reply["payload"]["success"], true);
    assert!(
        reply["payload"].get("error_kind").is_none(),
        "a legacy success carries no refusal classification"
    );
    assert!(
        registry.get("a1:s1").await.is_none(),
        "a successful kill clears the registry entry"
    );
}

/// #4302: a guarded kill cannot verify identity on an offline Agent, so it
/// refuses truthfully instead of the legacy "consider it gone" success.
#[tokio::test]
async fn session_kill_guarded_refuses_an_offline_agent() {
    let mut h = handler_with_online_agent().await;
    add_session(&mut h, "a1", "s1").await;
    let mut info = h.agent_registry.get("a1").await.expect("registered");
    info.status = AgentStatus::Offline;
    h.agent_registry.register(info).await;

    let action = h
        .handle_message(proto_msg(
            "server.session.kill",
            json!({ "session_id": "a1:s1", "expected_instance_id": "instance-a" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert_eq!(reply["payload"]["error_kind"], "unavailable");
    assert!(
        h.session_registry.get("a1:s1").await.is_some(),
        "the guarded refusal must not clean up registry state"
    );

    // The legacy name-only kill keeps its documented offline semantics for a
    // Session the registry does not know: "consider it gone". (The registered
    // s1 above would still route to the offline Agent and report the
    // disconnect — the guarded refusal changed none of that.)
    let action = h
        .handle_message(proto_msg(
            "server.session.kill",
            json!({ "session_id": "a1:never-registered" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], true);
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
