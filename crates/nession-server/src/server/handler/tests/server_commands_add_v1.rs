//! Tests localized to the server_commands_add_v1 handler (Issue #1258).
use super::*;

#[tokio::test]
async fn commands_add_requires_auth() {
    let mut h = test_handler("tok").await;
    let action = h
        .handle_message(proto_msg(
            "server.commands.add",
            json!({ "label": "test", "command": "echo hi" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(!reply["payload"]["success"].as_bool().unwrap());
}

#[tokio::test]
async fn commands_add_and_list() {
    let mut h = test_handler("tok").await;
    // Auth as client
    let _ = h
        .handle_message(proto_msg("server.auth", json!({ "auth_token": "tok" })))
        .await
        .unwrap();
    // Add a command
    let action = h
        .handle_message(proto_msg(
            "server.commands.add",
            json!({ "label": "My Cmd", "command": "echo hello" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["success"].as_bool().unwrap());
    let cmd_id = reply["payload"]["id"].as_str().unwrap().to_string();

    // List should include it
    let action = h
        .handle_message(proto_msg("server.commands.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    let cmds = reply["payload"]["commands"].as_array().unwrap();
    assert_eq!(cmds.len(), 1);
    assert_eq!(cmds[0]["label"], "My Cmd");
    assert_eq!(cmds[0]["command"], "echo hello");

    // Remove it
    let action = h
        .handle_message(proto_msg("server.commands.remove", json!({ "id": cmd_id })))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["success"].as_bool().unwrap());

    // List should be empty again
    let action = h
        .handle_message(proto_msg("server.commands.list", json!({})))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert!(reply["payload"]["commands"].as_array().unwrap().is_empty());
}
