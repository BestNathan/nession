use futures_util::{SinkExt, StreamExt};
use nession_server::server::command_broker::{CommandBroker, WsMessageSender};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// Start a mock agent WebSocket server and return (addr, captured messages).
async fn start_mock_agent() -> (
    std::net::SocketAddr,
    Arc<Mutex<Vec<String>>>,
    tokio::task::JoinHandle<()>,
) {
    let captured = Arc::new(Mutex::new(Vec::new()));
    let captured_clone = captured.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let handle = tokio::spawn(async move {
        if let Ok((stream, _)) = listener.accept().await {
            let ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let (mut sink, mut stream) = ws.split();
            let _ = sink
                .send(WsMessage::Text(
                    serde_json::json!({
                        "msg_type": "agent.register.response",
                        "id": "test",
                        "timestamp": 0,
                        "payload": {"status": "accepted", "message": "ok"}
                    })
                    .to_string(),
                ))
                .await;

            while let Some(Ok(WsMessage::Text(text))) = stream.next().await {
                captured_clone.lock().await.push(text);
            }
        }
    });

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    (addr, captured, handle)
}

#[tokio::test]
async fn test_register_and_send_command() {
    let (addr, captured, _handle) = start_mock_agent().await;
    let broker = CommandBroker::new();

    let (ws_stream, _) = tokio_tungstenite::connect_async(format!("ws://{}", addr))
        .await
        .unwrap();
    let (mut sink, _stream) = ws_stream.split();

    // Create channel-based sender and spawn relay task
    let (sender, mut ch_rx) = WsMessageSender::new();
    tokio::spawn(async move {
        while let Some(msg) = ch_rx.recv().await {
            let _ = sink.send(msg).await;
        }
    });

    broker.register_agent("agent-1", sender).await;

    let _rx = broker
        .send_command(
            "agent-1",
            "server.session.create",
            "req-1",
            serde_json::json!({"request_id": "req-1", "name": "test", "width": 80, "height": 24}),
        )
        .await;

    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let msgs = captured.lock().await;
    assert_eq!(msgs.len(), 1);
    let sent: serde_json::Value = serde_json::from_str(&msgs[0]).unwrap();
    assert_eq!(sent["msg_type"], "server.session.create");
    assert_eq!(sent["payload"]["request_id"], "req-1");
    assert_eq!(sent["payload"]["name"], "test");
}

#[tokio::test]
async fn test_resolve_command() {
    let (addr, _captured, _handle) = start_mock_agent().await;
    let broker = CommandBroker::new();

    let (ws_stream, _) = tokio_tungstenite::connect_async(format!("ws://{}", addr))
        .await
        .unwrap();
    let (mut sink, _stream) = ws_stream.split();

    // Create channel-based sender and spawn relay task
    let (sender, mut ch_rx) = WsMessageSender::new();
    tokio::spawn(async move {
        while let Some(msg) = ch_rx.recv().await {
            let _ = sink.send(msg).await;
        }
    });

    broker.register_agent("agent-1", sender).await;

    let rx = broker
        .send_command(
            "agent-1",
            "server.session.create",
            "req-1",
            serde_json::json!({"request_id": "req-1", "name": "test"}),
        )
        .await;

    let response = serde_json::json!({
        "request_id": "req-1",
        "command": "session.create",
        "success": true,
        "session_name": "test"
    });
    let resolved = broker.resolve_command("agent-1", "req-1", response).await;
    assert!(
        resolved,
        "should have found and resolved the pending command"
    );

    let result = rx.await.unwrap();
    assert_eq!(result["success"], true);
    assert_eq!(result["session_name"], "test");
}

#[tokio::test]
async fn test_unregister_agent_resolves_pending() {
    let (addr, _captured, _handle) = start_mock_agent().await;
    let broker = CommandBroker::new();

    let (ws_stream, _) = tokio_tungstenite::connect_async(format!("ws://{}", addr))
        .await
        .unwrap();
    let (mut sink, _stream) = ws_stream.split();

    // Create channel-based sender and spawn relay task
    let (sender, mut ch_rx) = WsMessageSender::new();
    tokio::spawn(async move {
        while let Some(msg) = ch_rx.recv().await {
            let _ = sink.send(msg).await;
        }
    });

    broker.register_agent("agent-1", sender).await;

    let rx = broker
        .send_command(
            "agent-1",
            "server.session.create",
            "req-1",
            serde_json::json!({"request_id": "req-1", "name": "test"}),
        )
        .await;

    broker.unregister_agent("agent-1").await;

    let result = rx.await;
    assert!(result.is_err(), "should fail when agent disconnects");
}

#[tokio::test]
async fn test_send_command_unknown_agent() {
    let broker = CommandBroker::new();

    let rx = broker
        .send_command(
            "unknown-agent",
            "server.session.create",
            "req-1",
            serde_json::json!({}),
        )
        .await;

    let result = rx.await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_multiple_concurrent_commands() {
    let (addr, _captured, _handle) = start_mock_agent().await;
    let broker = CommandBroker::new();

    let (ws_stream, _) = tokio_tungstenite::connect_async(format!("ws://{}", addr))
        .await
        .unwrap();
    let (mut sink, _stream) = ws_stream.split();

    // Create channel-based sender and spawn relay task
    let (sender, mut ch_rx) = WsMessageSender::new();
    tokio::spawn(async move {
        while let Some(msg) = ch_rx.recv().await {
            let _ = sink.send(msg).await;
        }
    });

    broker.register_agent("agent-1", sender).await;

    let rx1 = broker
        .send_command(
            "agent-1",
            "server.session.create",
            "req-1",
            serde_json::json!({"request_id": "req-1", "name": "s1"}),
        )
        .await;

    let rx2 = broker
        .send_command(
            "agent-1",
            "server.session.create",
            "req-2",
            serde_json::json!({"request_id": "req-2", "name": "s2"}),
        )
        .await;

    broker.resolve_command("agent-1", "req-2", serde_json::json!({
        "request_id": "req-2", "command": "session.create", "success": true, "session_name": "s2"
    })).await;

    broker.resolve_command("agent-1", "req-1", serde_json::json!({
        "request_id": "req-1", "command": "session.create", "success": true, "session_name": "s1"
    })).await;

    let r1 = rx1.await.unwrap();
    let r2 = rx2.await.unwrap();
    assert_eq!(r1["session_name"], "s1");
    assert_eq!(r2["session_name"], "s2");
}
