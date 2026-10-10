//! Tests localized to the server_session_env_apply_v1 handler (Issue #1258).
use super::*;

#[tokio::test]
async fn session_env_apply_unauthenticated() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.session.env.apply",
            json!({ "session_id": "a1:s1", "env_files": [] }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["error"], "Not authenticated");
}

#[tokio::test]
async fn session_env_apply_invalid_session_id() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.session.env.apply",
            json!({ "session_id": "no-colon", "env_files": [] }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("Invalid session_id"));
}
