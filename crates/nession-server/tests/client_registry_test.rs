use nession_server::server::client_registry::ClientRegistry;
use nession_server::server::command_broker::WsMessageSender;

#[tokio::test]
async fn test_register_and_broadcast() {
    let registry = ClientRegistry::new();
    let (sender, mut rx) = WsMessageSender::new();

    registry.register("session1", "client1", sender).await;
    assert_eq!(registry.session_client_count("session1").await, 1);

    let msg = r#"{"msg_type":"terminal.resize","payload":{"cols":80,"rows":24}}"#.to_string();
    let sent = registry.broadcast("session1", msg.clone()).await;
    assert_eq!(sent, 1);

    // Verify the message was received
    let received = rx.try_recv();
    assert!(received.is_ok());
}

#[tokio::test]
async fn test_broadcast_to_empty_session() {
    let registry = ClientRegistry::new();
    let msg = r#"{"msg_type":"terminal.resize"}"#.to_string();
    let sent = registry.broadcast("nonexistent", msg).await;
    assert_eq!(sent, 0);
}

#[tokio::test]
async fn test_unregister() {
    let registry = ClientRegistry::new();
    let (sender1, _rx1) = WsMessageSender::new();
    let (sender2, _rx2) = WsMessageSender::new();

    registry.register("session1", "client1", sender1).await;
    registry.register("session1", "client2", sender2).await;
    assert_eq!(registry.session_client_count("session1").await, 2);

    registry.unregister("session1", "client1").await;
    assert_eq!(registry.session_client_count("session1").await, 1);

    registry.unregister("session1", "client2").await;
    assert_eq!(registry.session_client_count("session1").await, 0);
}

#[tokio::test]
async fn test_broadcast_to_multiple_clients() {
    let registry = ClientRegistry::new();
    let (sender1, mut rx1) = WsMessageSender::new();
    let (sender2, mut rx2) = WsMessageSender::new();

    registry.register("session1", "client1", sender1).await;
    registry.register("session1", "client2", sender2).await;

    let msg = r#"{"msg_type":"terminal.resize"}"#.to_string();
    let sent = registry.broadcast("session1", msg).await;
    assert_eq!(sent, 2);

    // Both clients should receive the message
    assert!(rx1.try_recv().is_ok());
    assert!(rx2.try_recv().is_ok());
}

#[tokio::test]
async fn test_different_sessions_isolated() {
    let registry = ClientRegistry::new();
    let (sender1, _rx1) = WsMessageSender::new();
    let (sender2, _rx2) = WsMessageSender::new();

    registry.register("session1", "client1", sender1).await;
    registry.register("session2", "client2", sender2).await;

    assert_eq!(registry.session_client_count("session1").await, 1);
    assert_eq!(registry.session_client_count("session2").await, 1);

    // Broadcast to session1 should only reach client1
    let msg = r#"{"msg_type":"terminal.resize"}"#.to_string();
    let sent = registry.broadcast("session1", msg).await;
    assert_eq!(sent, 1);
}

#[tokio::test]
async fn test_unregister_nonexistent_is_noop() {
    let registry = ClientRegistry::new();
    registry.unregister("nonexistent", "client1").await;
    assert_eq!(registry.session_client_count("nonexistent").await, 0);
}

#[tokio::test]
async fn test_session_client_count_nonexistent() {
    let registry = ClientRegistry::new();
    assert_eq!(registry.session_client_count("nonexistent").await, 0);
}
