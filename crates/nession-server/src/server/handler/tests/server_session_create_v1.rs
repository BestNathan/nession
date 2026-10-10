//! Tests localized to the server_session_create_v1 handler (Issue #1258).
use super::*;

/// Regression #743: the agent WebSocket loop claims the agent for its
/// connection on **every** inbound agent message (`server/websocket.rs`),
/// so that can happen while a command is in flight. It is a transport
/// update and must not cancel the command — otherwise the client is told
/// "Agent disconnected" for a session the agent actually created, and the
/// real response is discarded when it arrives.
#[tokio::test]
async fn session_create_survives_an_intervening_agent_message() {
    let mut h = handler_with_online_agent().await;

    let (sender, mut rx) = WsMessageSender::new();
    let generation = h.command_broker.new_connection_generation();
    h.command_broker.claim_agent("a1", generation, sender).await;

    let broker = Arc::clone(&h.command_broker);
    let create_fut = h.handle_message(proto_msg(
        "server.session.create",
        json!({ "agent_id": "a1", "name": "regression-743" }),
    ));
    let agent_fut = async move {
        let text = rx
            .recv()
            .await
            .expect("agent should receive session.create")
            .message
            .to_text()
            .unwrap()
            .to_string();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        let request_id = parsed["payload"]["request_id"]
            .as_str()
            .unwrap()
            .to_string();

        // An unrelated inbound message from the same agent arrives first;
        // the loop claims the agent for the connection that sent it — a
        // newer one here, standing in for a reconnect.
        let (sender_again, _keepalive) = WsMessageSender::new();
        let generation = broker.new_connection_generation();
        broker.claim_agent("a1", generation, sender_again).await;

        broker
            .resolve_command("a1", &request_id, json!({ "success": true }))
            .await;
    };
    let (action, ()) = tokio::join!(create_fut, agent_fut);
    let reply = parse_reply(action.unwrap());

    assert_eq!(
        reply["payload"]["success"],
        json!(true),
        "an intervening agent message must not turn a completed create into a reported failure"
    );
    assert_eq!(reply["payload"]["session_id"], json!("a1:regression-743"));
}

#[tokio::test]
async fn session_create_missing_fields() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.session.create",
            json!({ "agent_id": "", "name": "" }),
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
async fn session_create_agent_not_found() {
    let mut h = test_handler("").await;
    h.authenticated_client = true;
    let action = h
        .handle_message(proto_msg(
            "server.session.create",
            json!({ "agent_id": "nonexistent", "name": "dev" }),
        ))
        .await
        .unwrap();
    let reply = parse_reply(action);
    assert_eq!(reply["payload"]["success"], false);
    assert!(reply["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("not found"));
}
