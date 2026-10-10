//! Tests localized to the server_commands_update_v1 handler (Issue #1258).
use super::*;

#[tokio::test]
async fn commands_update_nonexistent() {
    let mut h = test_handler("tok").await;
    // Auth as client
    let _ = h
        .handle_message(proto_msg("server.auth", json!({ "auth_token": "tok" })))
        .await
        .unwrap();
    // Update a nonexistent command
    let action = h
        .handle_message(proto_msg(
            "server.commands.update",
            json!({ "id": "missing", "label": "Nope" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(!reply["payload"]["success"].as_bool().unwrap());
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("not found"));
}
