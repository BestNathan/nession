//! Tests localized to the server_commands_list_v1 handler (Issue #1258).
use super::*;

#[tokio::test]
async fn commands_list_requires_auth() {
    let mut h = test_handler("tok").await;
    let action = h
        .handle_message(proto_msg("server.commands.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["msg_type"], "server.commands.list");
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("Not authenticated"));
}

#[tokio::test]
async fn commands_list_empty() {
    let mut h = test_handler("tok").await;
    // Auth as client first
    let _ = h
        .handle_message(proto_msg("server.auth", json!({ "auth_token": "tok" })))
        .await
        .unwrap();
    let action = h
        .handle_message(proto_msg("server.commands.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["msg_type"], "server.commands.list");
    assert!(reply["payload"]["commands"].as_array().unwrap().is_empty());
}
