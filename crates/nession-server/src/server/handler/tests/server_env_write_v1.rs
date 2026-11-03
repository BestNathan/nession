//! Tests localized to the server_env_write_v1 handler (Issue #1258).
use super::*;

#[tokio::test]
async fn env_write_unauthenticated() {
    let mut h = test_handler("").await;
    let action = h
        .handle_message(proto_msg(
            "server.env.write",
            json!({ "name": "test.env", "content": "X=1" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["error"], "Not authenticated");
}

#[tokio::test]
async fn env_write_and_read_server_file() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    // Write
    let action = h
        .handle_message(proto_msg(
            "server.env.write",
            json!({
                "name": "test.env",
                "content": "FOO=bar\nBAZ=qux",
                "overwrite": false,
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], true);
    // Read back
    let action = h
        .handle_message(proto_msg(
            "server.env.get",
            json!({ "name": "test.env", "source": "server" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], true);
    assert!(reply["payload"]["content"]
        .as_str()
        .unwrap()
        .contains("FOO=bar"));
}

#[tokio::test]
async fn env_write_missing_name() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.env.write",
            json!({ "name": "", "content": "X=1" }),
        ))
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
async fn env_write_blocked_when_in_use() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    // Write a file first
    h.handle_message(proto_msg(
        "server.env.write",
        json!({ "name": "locked.env", "content": "X=1", "overwrite": false }),
    ))
    .await
    .unwrap();
    // Bind the Session to the file.
    bind_for_test(
        &h,
        "a1:s1",
        &[nession_protocol::contracts::env::v1::EnvFileRef {
            name: "locked.env".to_string(),
            source: EnvSource::Server,
            agent_id: None,
        }],
    )
    .await;
    // Try to overwrite — should fail
    let action = h
        .handle_message(proto_msg(
            "server.env.write",
            json!({
                "name": "locked.env",
                "content": "X=2",
                "overwrite": true,
                "source": "server",
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("in use"));
    assert_eq!(reply["payload"]["in_use_by"], json!(["a1:s1"]));
}

#[tokio::test]
async fn env_write_force_skips_lock_without_mutating_sessions() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;

    // Write a file first so the store has it.
    h.handle_message(proto_msg(
        "server.env.write",
        json!({ "name": "forced.env", "content": "X=1", "overwrite": false }),
    ))
    .await
    .unwrap();

    // A Session is bound to this file.
    bind_for_test(
        &h,
        "a1:s1",
        &[EnvFileRef {
            name: "forced.env".to_string(),
            source: EnvSource::Server,
            agent_id: None,
        }],
    )
    .await;

    // `force` bypasses the in-use lock, but a profile save is not a Session
    // mutation (#170): no Agent is contacted, and the Session keeps the
    // revision it materialized until an explicit Reapply.
    let action = h
        .handle_message(proto_msg(
            "server.env.write",
            json!({
                "name": "forced.env",
                "content": "X=2",
                "overwrite": true,
                "force": true,
                "source": "server",
            }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);

    assert_eq!(reply["payload"]["success"], true);
    assert_eq!(reply["payload"]["re_sourced"], json!([]));
    assert_eq!(reply["payload"]["re_source_errors"], json!([]));
    let stored = h.env_service.store.read("forced.env").await.unwrap();
    assert_eq!(stored, "X=2");
}

#[tokio::test]
async fn env_write_agent_without_agent_id() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.env.write",
            json!({ "name": "test.env", "content": "X=1", "source": "agent" }),
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
