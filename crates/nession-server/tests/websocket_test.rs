use nession_server::server::WebSocketServer;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio_tungstenite::connect_async;
use futures_util::{SinkExt, StreamExt};

fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

#[tokio::test]
async fn test_server_accepts_connection() {
    let config = nession_common::config::ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: "test_token".to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 30,
        db_path: "./test_ws_accept.db".to_string(),
    };

    let mut server = WebSocketServer::new(config).await.unwrap();
    let addr = server.local_addr().unwrap();

    tokio::spawn(async move {
        server.run().await.unwrap();
    });

    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    let url = format!("ws://{}", addr);
    let result = connect_async(&url).await;

    assert!(result.is_ok(), "Server should accept WebSocket connection");

    tokio::fs::remove_file("./test_ws_accept.db").await.ok();
}

#[tokio::test]
async fn test_agent_registration() {
    let config = nession_common::config::ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: "test_token".to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 30,
        db_path: "./test_ws_register.db".to_string(),
    };

    let mut server = WebSocketServer::new(config).await.unwrap();
    let addr = server.local_addr().unwrap();

    tokio::spawn(async move {
        server.run().await.unwrap();
    });

    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    let url = format!("ws://{}", addr);
    let (mut ws_stream, _) = connect_async(&url).await.unwrap();

    let register_msg = serde_json::json!({
        "msg_type": "agent.register",
        "id": "msg_1",
        "timestamp": current_timestamp(),
        "payload": {
            "agent_id": "test_agent",
            "hostname": "test_host",
            "ip_address": "127.0.0.1",
            "port": 8080,
            "auth_token": "test_token",
            "metadata": {
                "tmux_version": "3.3a",
                "os_version": "Linux",
                "nession_version": "0.1.0"
            },
            "protocol_version": "1.0"
        }
    });

    ws_stream.send(tokio_tungstenite::tungstenite::Message::Text(register_msg.to_string())).await.unwrap();

    let response = ws_stream.next().await.unwrap().unwrap();
    let response_text = match response {
        tokio_tungstenite::tungstenite::Message::Text(text) => text,
        _ => panic!("Expected text response"),
    };

    let response_msg: serde_json::Value = serde_json::from_str(&response_text).unwrap();
    assert_eq!(response_msg["msg_type"], "agent.register.response");
    assert_eq!(response_msg["payload"]["status"], "accepted");

    tokio::fs::remove_file("./test_ws_register.db").await.ok();
}

#[tokio::test]
async fn test_invalid_auth_token() {
    let config = nession_common::config::ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: "correct_token".to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 30,
        db_path: "./test_ws_auth.db".to_string(),
    };

    let mut server = WebSocketServer::new(config).await.unwrap();
    let addr = server.local_addr().unwrap();

    tokio::spawn(async move {
        server.run().await.unwrap();
    });

    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    let url = format!("ws://{}", addr);
    let (mut ws_stream, _) = connect_async(&url).await.unwrap();

    let auth_msg = serde_json::json!({
        "msg_type": "client.auth",
        "id": "msg_1",
        "timestamp": current_timestamp(),
        "payload": {
            "auth_token": "wrong_token"
        }
    });

    ws_stream.send(tokio_tungstenite::tungstenite::Message::Text(auth_msg.to_string())).await.unwrap();

    let response = ws_stream.next().await.unwrap().unwrap();
    let response_text = match response {
        tokio_tungstenite::tungstenite::Message::Text(text) => text,
        tokio_tungstenite::tungstenite::Message::Close(_) => {
            panic!("Connection closed instead of sending error response");
        }
        _ => panic!("Expected text response"),
    };

    let response_msg: serde_json::Value = serde_json::from_str(&response_text).unwrap();
    assert_eq!(response_msg["msg_type"], "client.auth.response");
    assert_eq!(response_msg["payload"]["status"], "failed");

    tokio::fs::remove_file("./test_ws_auth.db").await.ok();
}

#[tokio::test]
async fn test_heartbeat_without_registration() {
    let config = nession_common::config::ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: "test_token".to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 30,
        db_path: "./test_ws_heartbeat.db".to_string(),
    };

    let mut server = WebSocketServer::new(config).await.unwrap();
    let addr = server.local_addr().unwrap();

    tokio::spawn(async move {
        server.run().await.unwrap();
    });

    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    let url = format!("ws://{}", addr);
    let (mut ws_stream, _) = connect_async(&url).await.unwrap();

    let heartbeat_msg = serde_json::json!({
        "msg_type": "agent.heartbeat",
        "id": "msg_1",
        "timestamp": current_timestamp(),
        "payload": {
            "agent_id": "unregistered_agent",
            "status": "online",
            "session_count": 0,
            "active_sessions": 0,
            "metadata": {
                "uptime_seconds": 100,
                "load_average": [0.5, 0.3, 0.2]
            }
        }
    });

    ws_stream.send(tokio_tungstenite::tungstenite::Message::Text(heartbeat_msg.to_string())).await.unwrap();

    let result = tokio::time::timeout(
        tokio::time::Duration::from_millis(500),
        ws_stream.next()
    ).await;

    assert!(result.is_err(), "Server should not respond to heartbeat from unregistered agent");

    tokio::fs::remove_file("./test_ws_heartbeat.db").await.ok();
}
