//! Tests localized to the server_auth_v1 handler (Issue #1258).
use super::*;

#[tokio::test]
async fn client_auth_success() {
    let mut h = test_handler("secret").await;
    let action = h
        .handle_message(proto_msg("server.auth", json!({ "auth_token": "secret" })))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "success");
}

#[tokio::test]
async fn client_auth_failure() {
    let mut h = test_handler("secret").await;
    let action = h
        .handle_message(proto_msg("server.auth", json!({ "auth_token": "wrong" })))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "failed");
}

#[tokio::test]
async fn client_auth_no_auth_mode() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.auth",
            json!({ "auth_token": "anything" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["status"], "success");
}
