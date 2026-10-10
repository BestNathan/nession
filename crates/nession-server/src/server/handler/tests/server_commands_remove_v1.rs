//! Tests localized to the server_commands_remove_v1 handler (Issue #1258).
use super::*;

#[tokio::test]
async fn commands_remove_nonexistent() {
    let mut h = test_handler("tok").await;
    // Auth as client
    let _ = h
        .handle_message(proto_msg("server.auth", json!({ "auth_token": "tok" })))
        .await
        .unwrap();
    // Remove an id that doesn't exist (should still succeed — idempotent)
    let action = h
        .handle_message(proto_msg(
            "server.commands.remove",
            json!({ "id": "nonexistent" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["success"].as_bool().unwrap());
}
