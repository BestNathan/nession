//! Tests localized to the server_session_metadata_v1 handler (#2789).
//!
//! The Server authorizes and routes; the Agent owns the store. These tests pin
//! the routing payloads, the refusal classes the Web renders, and the rule that
//! a failed or malformed Agent answer never becomes a claimed success.
use super::*;

fn metadata_json() -> serde_json::Value {
    json!({
        "revision": 4,
        "title": "Release triage",
        "description": "Fix the staging run",
        "tags": ["release", "staging"],
        "created_at": 1_762_300_000_u64,
        "updated_at": 1_762_303_600_u64,
    })
}

#[tokio::test]
async fn metadata_get_requires_an_authenticated_client() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.session.metadata.get",
            json!({ "session_id": "a1:s1" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert_eq!(reply["payload"]["error_kind"], "unauthorized");
    assert_eq!(reply["payload"]["error"], "Not authenticated");
    assert!(reply["payload"]
        .get("metadata")
        .is_none_or(serde_json::Value::is_null));
}

#[tokio::test]
async fn a_malformed_session_id_is_refused_before_any_agent_is_asked() {
    let mut h = handler_with_online_agent().await;
    let action = h
        .handle_message(proto_msg(
            "server.session.metadata.get",
            json!({ "session_id": "not-a-joined-id" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert_eq!(reply["payload"]["error_kind"], "invalid");
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("Expected 'agent_id:session_name'"));
}

#[tokio::test]
async fn an_unknown_agent_is_not_found() {
    let mut h = handler_with_online_agent().await;
    let action = h
        .handle_message(proto_msg(
            "server.session.metadata.update",
            json!({
                "session_id": "missing:s1",
                "title": null,
                "description": null,
                "tags": [],
                "expected_revision": 0
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert_eq!(reply["payload"]["error_kind"], "not_found");
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("not found"));
}

#[tokio::test]
async fn a_get_forwards_only_the_session_name_and_returns_the_agents_metadata() {
    let mut h = handler_with_online_agent().await;
    let (sender, mut rx) = crate::server::outbound::WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;

    let broker = Arc::clone(&h.command_broker);
    let request = h.handle_message(proto_msg(
        "server.session.metadata.get",
        json!({ "session_id": "a1:s1" }),
    ));
    let agent = async move {
        let text = rx
            .recv()
            .await
            .expect("the agent receives the metadata read")
            .message
            .to_text()
            .unwrap()
            .to_string();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["msg_type"], "agent.session.metadata.get");
        assert_eq!(parsed["payload"]["name"], "s1");
        let request_id = parsed["payload"]["request_id"]
            .as_str()
            .unwrap()
            .to_string();
        broker
            .resolve_command(
                "a1",
                &request_id,
                json!({ "success": true, "metadata": metadata_json() }),
            )
            .await;
    };

    let (action, ()) = tokio::join!(request, agent);
    let reply = parse_reply(action.unwrap());
    assert_eq!(reply["payload"]["success"], true);
    assert_eq!(reply["payload"]["metadata"]["revision"], 4);
    assert_eq!(reply["payload"]["metadata"]["title"], "Release triage");
    assert_eq!(reply["payload"]["metadata"]["tags"][1], "staging");
}

#[tokio::test]
async fn an_update_forwards_the_revision_guard_and_the_full_replacement() {
    let mut h = handler_with_online_agent().await;
    let (sender, mut rx) = crate::server::outbound::WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;

    let broker = Arc::clone(&h.command_broker);
    let request = h.handle_message(proto_msg(
        "server.session.metadata.update",
        json!({
            "session_id": "a1:s1",
            "title": "New title",
            "description": null,
            "tags": ["release"],
            "expected_revision": 4
        }),
    ));
    let agent = async move {
        let text = rx
            .recv()
            .await
            .expect("the agent receives the metadata write")
            .message
            .to_text()
            .unwrap()
            .to_string();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["msg_type"], "agent.session.metadata.update");
        assert_eq!(parsed["payload"]["name"], "s1");
        assert_eq!(parsed["payload"]["title"], "New title");
        assert_eq!(parsed["payload"]["description"], serde_json::Value::Null);
        assert_eq!(parsed["payload"]["tags"][0], "release");
        assert_eq!(parsed["payload"]["expected_revision"], 4);
        let request_id = parsed["payload"]["request_id"]
            .as_str()
            .unwrap()
            .to_string();
        broker
            .resolve_command(
                "a1",
                &request_id,
                json!({ "success": true, "metadata": {
                    "revision": 5,
                    "title": "New title",
                    "description": null,
                    "tags": ["release"],
                    "created_at": 1_762_300_000_u64,
                    "updated_at": 1_762_303_600_u64,
                } }),
            )
            .await;
    };

    let (action, ()) = tokio::join!(request, agent);
    let reply = parse_reply(action.unwrap());
    assert_eq!(reply["payload"]["success"], true);
    assert_eq!(reply["payload"]["metadata"]["revision"], 5);
    assert_eq!(reply["payload"]["metadata"]["title"], "New title");
}

#[tokio::test]
async fn an_agents_conflict_keeps_its_kind_and_detail() {
    let mut h = handler_with_online_agent().await;
    let (sender, mut rx) = crate::server::outbound::WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;

    let broker = Arc::clone(&h.command_broker);
    let request = h.handle_message(proto_msg(
        "server.session.metadata.update",
        json!({
            "session_id": "a1:s1",
            "title": null,
            "description": null,
            "tags": [],
            "expected_revision": 1
        }),
    ));
    let agent = async move {
        let text = rx
            .recv()
            .await
            .expect("the agent receives the metadata write")
            .message
            .to_text()
            .unwrap()
            .to_string();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        let request_id = parsed["payload"]["request_id"]
            .as_str()
            .unwrap()
            .to_string();
        broker
            .resolve_command(
                "a1",
                &request_id,
                json!({
                    "success": false,
                    "error": "expected revision 1, current revision 4",
                    "error_kind": "conflict",
                }),
            )
            .await;
    };

    let (action, ()) = tokio::join!(request, agent);
    let reply = parse_reply(action.unwrap());
    assert_eq!(reply["payload"]["success"], false);
    assert_eq!(reply["payload"]["error_kind"], "conflict");
    assert_eq!(
        reply["payload"]["error"],
        "expected revision 1, current revision 4"
    );
}

#[tokio::test]
async fn a_success_without_metadata_is_a_refusal_not_a_second_hand_success() {
    let mut h = handler_with_online_agent().await;
    let (sender, mut rx) = crate::server::outbound::WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;

    let broker = Arc::clone(&h.command_broker);
    let request = h.handle_message(proto_msg(
        "server.session.metadata.get",
        json!({ "session_id": "a1:s1" }),
    ));
    let agent = async move {
        let text = rx
            .recv()
            .await
            .expect("the agent receives the metadata read")
            .message
            .to_text()
            .unwrap()
            .to_string();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        let request_id = parsed["payload"]["request_id"]
            .as_str()
            .unwrap()
            .to_string();
        broker
            .resolve_command("a1", &request_id, json!({ "success": true }))
            .await;
    };

    let (action, ()) = tokio::join!(request, agent);
    let reply = parse_reply(action.unwrap());
    assert_eq!(reply["payload"]["success"], false);
    assert_eq!(reply["payload"]["error_kind"], "unavailable");
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("without Session metadata"));
}

#[tokio::test]
async fn an_incomplete_update_payload_is_refused_without_asking_anyone() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.session.metadata.update",
            json!({ "session_id": "a1:s1" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert_eq!(reply["payload"]["error_kind"], "invalid");
}
