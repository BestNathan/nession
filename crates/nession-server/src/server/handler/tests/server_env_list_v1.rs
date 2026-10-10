//! Tests localized to the server_env_list_v1 handler (Issue #1258).
use super::*;

#[tokio::test]
async fn env_list_unauthenticated() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg("server.env.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["error"], "Not authenticated");
}

#[tokio::test]
async fn env_list_reply_is_what_its_contract_says_it_is() {
    // The test `server.auth` never had. That unit's contract requires a
    // `client_id` its handler has never sent, so a consumer reading that
    // reply as its own declared type fails — and nothing noticed, because
    // the handler built the payload with `json!` and no test ever asked the
    // type what it expected.
    //
    // So this asks: take the reply off the wire and read it the way the
    // contract says it is. It is the difference between "the handler uses
    // the type" being a claim about the source and being a checked fact —
    // and it is what the identity-only entries were missing, since a unit
    // with `request: None` cannot have this test at all.
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg("server.env.list", json!({})))
        .await
        .unwrap();
    let payload = parse_reply(action)["payload"].clone();
    let parsed: ClientEnvListResponsePayload = serde_json::from_value(payload.clone())
        .unwrap_or_else(|e| {
            panic!("server.env.list replies {payload} but its contract does not accept it: {e}")
        });

    assert!(
        parsed.error.is_some(),
        "an unauthenticated caller is told why rather than handed an empty list"
    );
}

#[tokio::test]
async fn env_list_server_files() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    // Write a file first
    h.handle_message(proto_msg(
        "server.env.write",
        json!({
            "name": "test.env",
            "content": "X=1",
            "overwrite": false,
        }),
    ))
    .await
    .unwrap();
    let action = h
        .handle_message(proto_msg("server.env.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    let files = reply["payload"]["files"].as_array().unwrap();
    assert!(!files.is_empty());
}
