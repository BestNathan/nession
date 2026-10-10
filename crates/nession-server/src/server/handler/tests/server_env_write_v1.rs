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
    // Record usage
    h.env_service.usage.record_create(
        "a1:s1",
        &[nession_protocol::contracts::env::v1::EnvFileRef {
            name: "locked.env".to_string(),
            source: EnvSource::Server,
            agent_id: None,
        }],
        None,
    );
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
async fn env_write_force_skips_lock_and_re_sources() {
    use crate::server::outbound::WsMessageSender;

    let mut h = test_handler("").await;
    h.authenticated_client = true;

    // Write a file first so the store has it.
    h.handle_message(proto_msg(
        "server.env.write",
        json!({ "name": "forced.env", "content": "X=1", "overwrite": false }),
    ))
    .await
    .unwrap();

    // Register an agent control channel so `agent_command` can be answered.
    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;

    // Record usage for a session bound to this file.
    h.env_service.usage.record_create(
        "a1:s1",
        &[EnvFileRef {
            name: "forced.env".to_string(),
            source: EnvSource::Server,
            agent_id: None,
        }],
        None,
    );

    // Run the force write concurrently with a mock agent that answers the
    // re-source (`agent.env.resource`) command.
    let broker = Arc::clone(&h.command_broker);
    let send_fut = h.handle_message(proto_msg(
        "server.env.write",
        json!({
            "name": "forced.env",
            "content": "X=2",
            "overwrite": true,
            "force": true,
            "source": "server",
        }),
    ));
    let resolve_fut = async move {
        let text = rx
            .recv()
            .await
            .expect("agent should receive a command")
            .message
            .to_text()
            .unwrap()
            .to_string();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();

        // The wire matters as much as the response. This mock used to answer
        // whatever arrived, and so passed while the server was asking for
        // `agent.env.resource` — a wire no agent has ever handled, which made
        // every forced write report a re-source failure while the session
        // kept its old values. Asserting the wire is what keeps the mock
        // honest; without it the test cannot tell the fix from the bug.
        assert_eq!(
            parsed["msg_type"], "agent.session.env.apply",
            "the re-source must use the wire the agent answers"
        );
        // The session name without its `<agent>:` prefix, and the content
        // the forced write just stored — not the pre-write content.
        assert_eq!(parsed["payload"]["name"], "s1");
        assert_eq!(
            parsed["payload"]["snapshots"][0]["vars"],
            json!([["X", "2"]]),
            "the re-source must carry the file's current content"
        );

        let request_id = parsed["payload"]["request_id"]
            .as_str()
            .unwrap()
            .to_string();
        broker
            .resolve_command("a1", &request_id, json!({ "success": true }))
            .await;
    };
    let (action, _) = tokio::join!(send_fut, resolve_fut);
    let reply = parse_reply(action.unwrap());

    assert_eq!(reply["payload"]["success"], true);
    assert_eq!(reply["payload"]["re_sourced"], json!(["a1:s1"]));
    assert_eq!(reply["payload"]["re_source_errors"], json!([]));
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
