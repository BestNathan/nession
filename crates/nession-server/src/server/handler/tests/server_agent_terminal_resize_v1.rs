//! Tests localized to the server_agent_terminal_resize_v1 handler (Issue #1258).
use super::*;

#[tokio::test]
async fn agent_terminal_resize_broadcasts_to_attached_clients() {
    use crate::server::outbound::WsMessageSender;

    let mut h = test_handler("").await;

    // Registering is what makes a connection able to resize `a1:dev` at all,
    // and the claim is what `server/websocket.rs` makes for it right after —
    // a resize from a connection that never registered is refused, so this
    // setup is part of the case rather than incidental to it.
    register_agent_connection(&mut h, "a1").await;
    let (_sender, _rx) = claim_control_channel(&h).await;

    // Register two clients in the ClientRegistry for the target session
    let client_registry = Arc::clone(&h.client_registry);
    let (sender1, mut rx1) = WsMessageSender::new();
    let (sender2, mut rx2) = WsMessageSender::new();
    client_registry.register("a1:dev", "c1", sender1).await;
    client_registry.register("a1:dev", "c2", sender2).await;

    // Send agent.terminal.resize
    let action = h
        .handle_message(proto_msg(
            "server.agent.terminal-resize",
            json!({
                "session_id": "a1:dev",
                "cols": 120,
                "rows": 40,
            }),
        ))
        .await
        .unwrap();

    // Handler returns Reply(None) — broadcast goes through ClientRegistry
    assert!(matches!(action, HandlerAction::Reply(None)));

    // Both clients should receive the broadcast message
    let msg1 = rx1.try_recv().unwrap();
    let msg2 = rx2.try_recv().unwrap();

    let parsed1: serde_json::Value = serde_json::from_str(msg1.message.to_text().unwrap()).unwrap();
    let parsed2: serde_json::Value = serde_json::from_str(msg2.message.to_text().unwrap()).unwrap();

    assert_eq!(parsed1["msg_type"], "terminal.resize");
    assert_eq!(parsed1["payload"]["session_id"], "a1:dev");
    assert_eq!(parsed1["payload"]["cols"], 120);
    assert_eq!(parsed1["payload"]["rows"], 40);
    assert_eq!(parsed2["msg_type"], "terminal.resize");
    assert_eq!(parsed2["payload"]["session_id"], "a1:dev");
}

#[tokio::test]
async fn agent_terminal_resize_no_attached_clients() {
    let mut h = test_handler("").await;

    // Registered and claimed, so what the frame meets is the absence of
    // clients rather than the absence of authority.
    register_agent_connection(&mut h, "a1").await;
    let (_sender, _rx) = claim_control_channel(&h).await;

    // No clients attached — should still succeed silently
    let action = h
        .handle_message(proto_msg(
            "server.agent.terminal-resize",
            json!({
                "session_id": "a1:dev",
                "cols": 80,
                "rows": 24,
            }),
        ))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
}

#[tokio::test]
async fn agent_terminal_resize_invalid_payload() {
    let mut h = test_handler("").await;

    // As above: the payload is what this test is about, so the connection
    // arrives already authorized for the session it names.
    register_agent_connection(&mut h, "a1").await;
    let (_sender, _rx) = claim_control_channel(&h).await;

    // Missing required fields — should log warning but not crash
    let action = h
        .handle_message(proto_msg(
            "server.agent.terminal-resize",
            json!({ "session_id": "a1:dev" }),
        ))
        .await
        .unwrap();
    assert!(matches!(action, HandlerAction::Reply(None)));
}
