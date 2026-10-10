//! Tests localized to the server_env_delete_v1 handler (Issue #1258).
use super::*;

#[tokio::test]
async fn env_delete_reply_and_request_are_what_their_contract_says() {
    // `delete`'s reply is an exact match on every branch, so unlike the
    // other two this is a plain regression guard. Its *request* is where
    // the work was: `force` was read off `Value` beside the parser for
    // years, and a missing `source` was defaulted.
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.env.delete",
            json!({ "name": "x.env", "force": true }),
        ))
        .await
        .unwrap();
    let payload = parse_reply(action)["payload"].clone();
    let parsed: ClientEnvDeleteResponsePayload = serde_json::from_value(payload.clone())
        .unwrap_or_else(|e| {
            panic!("server.env.delete replies {payload} but its contract does not accept it: {e}")
        });
    assert!(!parsed.success);
    assert!(parsed.error.is_some(), "an unauthenticated delete says why");

    let with_force: ClientEnvDeletePayload =
        serde_json::from_value(json!({ "name": "x.env", "force": true }))
            .expect("`force` is a declared field, and the Web has always sent it");
    assert!(with_force.force);

    let no_source: ClientEnvDeletePayload = serde_json::from_value(json!({ "name": "x.env" }))
        .expect("a missing source defaults to the server, as parse_env_ref did");
    assert_eq!(no_source.source, EnvSource::Server);
}

#[tokio::test]
async fn env_delete_unauthenticated() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.env.delete",
            json!({ "name": "test.env" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["error"], "Not authenticated");
}

#[tokio::test]
async fn env_delete_missing_name() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg("server.env.delete", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("required"));
}

#[tokio::test]
async fn env_delete_server_file() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    h.handle_message(proto_msg(
        "server.env.write",
        json!({ "name": "del.env", "content": "X=1", "overwrite": false }),
    ))
    .await
    .unwrap();
    let action = h
        .handle_message(proto_msg(
            "server.env.delete",
            json!({ "name": "del.env", "source": "server" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], true);
}

#[tokio::test]
async fn env_delete_blocked_when_in_use() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    // Write a file first
    h.handle_message(proto_msg(
        "server.env.write",
        json!({ "name": "used.env", "content": "X=1", "overwrite": false }),
    ))
    .await
    .unwrap();
    // Record usage
    h.env_service.usage.record_create(
        "a1:s1",
        &[nession_protocol::contracts::env::v1::EnvFileRef {
            name: "used.env".to_string(),
            source: EnvSource::Server,
            agent_id: None,
        }],
        None,
    );
    // Try to delete — should fail
    let action = h
        .handle_message(proto_msg(
            "server.env.delete",
            json!({ "name": "used.env", "source": "server" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("in use"));
}

#[tokio::test]
async fn env_delete_force_skips_lock() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    // Write a file first
    h.handle_message(proto_msg(
        "server.env.write",
        json!({ "name": "used.env", "content": "X=1", "overwrite": false }),
    ))
    .await
    .unwrap();
    // Record usage
    h.env_service.usage.record_create(
        "a1:s1",
        &[nession_protocol::contracts::env::v1::EnvFileRef {
            name: "used.env".to_string(),
            source: EnvSource::Server,
            agent_id: None,
        }],
        None,
    );
    // Delete with force — should succeed despite being in use
    let action = h
        .handle_message(proto_msg(
            "server.env.delete",
            json!({ "name": "used.env", "source": "server", "force": true }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], true);
}

#[tokio::test]
async fn env_delete_agent_without_agent_id() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.env.delete",
            json!({ "name": "test.env", "source": "agent" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("agent_id is required"));
}
