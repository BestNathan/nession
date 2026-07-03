//! Integration test: client → server → mock agent session create/kill flow.

use futures_util::{SinkExt, StreamExt};
use nession_common::config::ServerConfig;
use nession_server::db::Database;
use nession_server::server::WebSocketServer;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// Start a real server on a random port.
async fn start_server() -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let config = ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        auth_token: "test".to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 60,
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        db_path: String::new(),
    };

    let db = Database::new(":memory:").await.unwrap();
    let mut server = WebSocketServer::new(config, Arc::new(db)).await.unwrap();
    let addr = server.local_addr().unwrap();

    let handle = tokio::spawn(async move {
        let _ = server.run().await;
    });

    tokio::time::sleep(Duration::from_millis(100)).await;
    (addr, handle)
}

#[tokio::test]
async fn test_session_create_flow() {
    let (addr, _server_handle) = start_server().await;

    // Connect mock agent
    let (agent_ws, _) = tokio_tungstenite::connect_async(format!("ws://{}", addr))
        .await
        .unwrap();
    let (mut agent_sink, mut agent_stream) = agent_ws.split();

    // Register agent
    let reg = serde_json::json!({
        "msg_type": "agent.register",
        "id": "reg-1",
        "timestamp": 0,
        "payload": {
            "agent_id": "agent-1",
            "hostname": "test-host",
            "ip_address": "127.0.0.1",
            "port": 19999,
            "auth_token": "test",
            "metadata": {"tmux_version": "3.3", "os_version": "Linux", "nession_version": "0.1.0"},
            "protocol_version": "1.0"
        }
    });
    agent_sink
        .send(WsMessage::Text(reg.to_string()))
        .await
        .unwrap();
    let _ = agent_stream.next().await; // register response

    // Connect client
    let (client_ws, _) = tokio_tungstenite::connect_async(format!("ws://{}", addr))
        .await
        .unwrap();
    let (mut client_sink, mut client_stream) = client_ws.split();

    // Authenticate
    let auth = serde_json::json!({
        "msg_type": "client.auth",
        "id": "auth-1",
        "timestamp": 0,
        "payload": {"auth_token": "test"}
    });
    client_sink
        .send(WsMessage::Text(auth.to_string()))
        .await
        .unwrap();
    let _ = client_stream.next().await; // auth response

    // Send session create
    let create = serde_json::json!({
        "msg_type": "client.session.create",
        "id": "create-1",
        "timestamp": 0,
        "payload": {"agent_id": "agent-1", "name": "my-session"}
    });
    client_sink
        .send(WsMessage::Text(create.to_string()))
        .await
        .unwrap();

    // Agent receives the command
    let agent_msg = agent_stream.next().await.unwrap().unwrap();
    let agent_text = match agent_msg {
        WsMessage::Text(t) => t,
        _ => panic!("expected text"),
    };
    let agent_parsed: serde_json::Value = serde_json::from_str(&agent_text).unwrap();
    assert_eq!(agent_parsed["msg_type"], "server.session.create");
    assert_eq!(agent_parsed["payload"]["name"], "my-session");
    let request_id = agent_parsed["payload"]["request_id"].as_str().unwrap();

    // Agent sends response
    let response = serde_json::json!({
        "msg_type": "agent.session.command.response",
        "id": "resp-1",
        "timestamp": 0,
        "payload": {
            "request_id": request_id,
            "command": "session.create",
            "success": true,
            "session_name": "my-session"
        }
    });
    agent_sink
        .send(WsMessage::Text(response.to_string()))
        .await
        .unwrap();

    // Client receives the response
    let client_msg = client_stream.next().await.unwrap().unwrap();
    let client_text = match client_msg {
        WsMessage::Text(t) => t,
        _ => panic!("expected text"),
    };
    let client_parsed: serde_json::Value = serde_json::from_str(&client_text).unwrap();
    assert_eq!(client_parsed["msg_type"], "client.session.create.response");
    assert_eq!(client_parsed["payload"]["success"], true);
    assert_eq!(client_parsed["payload"]["session_id"], "agent-1:my-session");
}

#[tokio::test]
async fn test_session_kill_flow() {
    let (addr, _server_handle) = start_server().await;

    // Connect mock agent
    let (agent_ws, _) = tokio_tungstenite::connect_async(format!("ws://{}", addr))
        .await
        .unwrap();
    let (mut agent_sink, mut agent_stream) = agent_ws.split();

    // Register agent
    let reg = serde_json::json!({
        "msg_type": "agent.register",
        "id": "reg-1",
        "timestamp": 0,
        "payload": {
            "agent_id": "agent-1",
            "hostname": "test-host",
            "ip_address": "127.0.0.1",
            "port": 19999,
            "auth_token": "test",
            "metadata": {"tmux_version": "3.3", "os_version": "Linux", "nession_version": "0.1.0"},
            "protocol_version": "1.0"
        }
    });
    agent_sink
        .send(WsMessage::Text(reg.to_string()))
        .await
        .unwrap();
    let _ = agent_stream.next().await;

    // Connect & auth client
    let (client_ws, _) = tokio_tungstenite::connect_async(format!("ws://{}", addr))
        .await
        .unwrap();
    let (mut client_sink, mut client_stream) = client_ws.split();
    let auth = serde_json::json!({
        "msg_type": "client.auth",
        "id": "auth-1",
        "timestamp": 0,
        "payload": {"auth_token": "test"}
    });
    client_sink
        .send(WsMessage::Text(auth.to_string()))
        .await
        .unwrap();
    let _ = client_stream.next().await;

    // Register a session in the server's registry via agent.session.update
    let update = serde_json::json!({
        "msg_type": "agent.session.update",
        "id": "update-1",
        "timestamp": 0,
        "payload": {
            "agent_id": "agent-1",
            "session_name": "my-session",
            "status": "detached",
            "window_count": 1,
            "attached_clients": 0
        }
    });
    agent_sink
        .send(WsMessage::Text(update.to_string()))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Send session kill
    let kill = serde_json::json!({
        "msg_type": "client.session.kill",
        "id": "kill-1",
        "timestamp": 0,
        "payload": {"session_id": "agent-1:my-session"}
    });
    client_sink
        .send(WsMessage::Text(kill.to_string()))
        .await
        .unwrap();

    // Agent receives kill command
    let agent_msg = agent_stream.next().await.unwrap().unwrap();
    let agent_text = match agent_msg {
        WsMessage::Text(t) => t,
        _ => panic!("expected text"),
    };
    let agent_parsed: serde_json::Value = serde_json::from_str(&agent_text).unwrap();
    assert_eq!(agent_parsed["msg_type"], "server.session.kill");
    assert_eq!(agent_parsed["payload"]["name"], "my-session");
    let request_id = agent_parsed["payload"]["request_id"].as_str().unwrap();

    // Agent sends success response
    let response = serde_json::json!({
        "msg_type": "agent.session.command.response",
        "id": "resp-1",
        "timestamp": 0,
        "payload": {
            "request_id": request_id,
            "command": "session.kill",
            "success": true
        }
    });
    agent_sink
        .send(WsMessage::Text(response.to_string()))
        .await
        .unwrap();

    // Client receives response
    let client_msg = client_stream.next().await.unwrap().unwrap();
    let client_text = match client_msg {
        WsMessage::Text(t) => t,
        _ => panic!("expected text"),
    };
    let client_parsed: serde_json::Value = serde_json::from_str(&client_text).unwrap();
    assert_eq!(client_parsed["msg_type"], "client.session.kill.response");
    assert_eq!(client_parsed["payload"]["success"], true);
}

#[tokio::test]
async fn test_create_with_offline_agent_returns_error() {
    let (addr, _server_handle) = start_server().await;

    // Connect & auth client (no agent registered)
    let (client_ws, _) = tokio_tungstenite::connect_async(format!("ws://{}", addr))
        .await
        .unwrap();
    let (mut client_sink, mut client_stream) = client_ws.split();
    let auth = serde_json::json!({
        "msg_type": "client.auth",
        "id": "auth-1",
        "timestamp": 0,
        "payload": {"auth_token": "test"}
    });
    client_sink
        .send(WsMessage::Text(auth.to_string()))
        .await
        .unwrap();
    let _ = client_stream.next().await;

    // Try to create session on non-existent agent
    let create = serde_json::json!({
        "msg_type": "client.session.create",
        "id": "create-1",
        "timestamp": 0,
        "payload": {"agent_id": "nonexistent", "name": "test"}
    });
    client_sink
        .send(WsMessage::Text(create.to_string()))
        .await
        .unwrap();

    // Should get immediate error
    let resp = client_stream.next().await.unwrap().unwrap();
    let text = match resp {
        WsMessage::Text(t) => t,
        _ => panic!("expected text"),
    };
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["msg_type"], "client.session.create.response");
    assert_eq!(parsed["payload"]["success"], false);
    assert!(parsed["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("not found"));
}
