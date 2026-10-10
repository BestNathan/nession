//! Tests localized to the server_env_get_v1 handler (Issue #1258).
use super::*;

#[tokio::test]
async fn env_get_reply_is_what_its_contract_says_it_is() {
    // The same guard as `env_list_reply_is_what_its_contract_says_it_is`,
    // on the unit whose `in_use_by` had to become optional: two branches
    // answer before it is computed. Both forms have to round-trip, and
    // which form each branch produces is the part that is easy to get
    // wrong by hand.
    let mut h = test_handler("").await;

    let action = h
        .handle_message(proto_msg("server.env.get", json!({ "name": "x.env" })))
        .await
        .unwrap();
    let payload = parse_reply(action)["payload"].clone();
    let parsed: ClientEnvGetResponsePayload = serde_json::from_value(payload.clone())
        .unwrap_or_else(|e| {
            panic!("server.env.get replies {payload} but its contract does not accept it: {e}")
        });
    assert!(!parsed.success);
    assert!(
        parsed.in_use_by.is_none(),
        "an unauthenticated caller is not told what is in use — absent, not empty"
    );

    // Authenticated, and past the point where usage is computed.
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.env.get",
            json!({ "name": "missing.env" }),
        ))
        .await
        .unwrap();
    let payload = parse_reply(action)["payload"].clone();
    let parsed: ClientEnvGetResponsePayload = serde_json::from_value(payload.clone())
        .unwrap_or_else(|e| {
            panic!("server.env.get replies {payload} but its contract does not accept it: {e}")
        });
    assert!(
        parsed.in_use_by.is_some(),
        "a request that reached the lookup reports usage, even when empty"
    );
}

#[tokio::test]
async fn env_get_unauthenticated() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg("server.env.get", json!({ "name": "test.env" })))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["error"], "Not authenticated");
}

#[tokio::test]
async fn env_get_missing_name() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg("server.env.get", json!({})))
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
async fn env_get_agent_without_agent_id() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.env.get",
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
