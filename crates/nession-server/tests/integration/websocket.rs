use futures_util::{SinkExt, StreamExt};
use nession_server::db::Database;
use nession_server::server::WebSocketServer;
use std::sync::Arc;
use tokio_tungstenite::connect_async;

use super::current_timestamp;

fn test_db_path(name: &str) -> String {
    std::env::temp_dir()
        .join(name)
        .to_string_lossy()
        .to_string()
}

async fn start_test_server(
    config: nession_common::config::ServerConfig,
) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let db = Database::new(&config.db_path).await.unwrap();
    let mut server = WebSocketServer::new(config, Arc::new(db)).await.unwrap();
    let addr = server.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        server.run().await.unwrap();
    });
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    (addr, handle)
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
        db_path: test_db_path("test_ws_accept.db"),
        ..Default::default()
    };

    let (addr, _handle) = start_test_server(config).await;

    let url = format!("ws://{addr}");
    let result = connect_async(&url).await;

    assert!(result.is_ok(), "Server should accept WebSocket connection");

    tokio::fs::remove_file(&test_db_path("test_ws_accept.db"))
        .await
        .ok();
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
        db_path: test_db_path("test_ws_register.db"),
        ..Default::default()
    };

    let (addr, _handle) = start_test_server(config).await;

    let url = format!("ws://{addr}");
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

    ws_stream
        .send(tokio_tungstenite::tungstenite::Message::Text(
            register_msg.to_string(),
        ))
        .await
        .unwrap();

    let response = ws_stream.next().await.unwrap().unwrap();
    let response_text = match response {
        tokio_tungstenite::tungstenite::Message::Text(text) => text,
        _ => panic!("Expected text response"),
    };

    let response_msg: serde_json::Value = serde_json::from_str(&response_text).unwrap();
    assert_eq!(response_msg["msg_type"], "agent.register.response");
    assert_eq!(response_msg["payload"]["status"], "accepted");

    tokio::fs::remove_file(&test_db_path("test_ws_register.db"))
        .await
        .ok();
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
        db_path: test_db_path("test_ws_auth.db"),
        ..Default::default()
    };

    let (addr, _handle) = start_test_server(config).await;

    let url = format!("ws://{addr}");
    let (mut ws_stream, _) = connect_async(&url).await.unwrap();

    let auth_msg = serde_json::json!({
        "msg_type": "client.auth",
        "id": "msg_1",
        "timestamp": current_timestamp(),
        "payload": {
            "auth_token": "wrong_token"
        }
    });

    ws_stream
        .send(tokio_tungstenite::tungstenite::Message::Text(
            auth_msg.to_string(),
        ))
        .await
        .unwrap();

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

    tokio::fs::remove_file(&test_db_path("test_ws_auth.db"))
        .await
        .ok();
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
        db_path: test_db_path("test_ws_heartbeat.db"),
        ..Default::default()
    };

    let (addr, _handle) = start_test_server(config).await;

    let url = format!("ws://{addr}");
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

    ws_stream
        .send(tokio_tungstenite::tungstenite::Message::Text(
            heartbeat_msg.to_string(),
        ))
        .await
        .unwrap();

    let result =
        tokio::time::timeout(tokio::time::Duration::from_millis(500), ws_stream.next()).await;

    assert!(
        result.is_err(),
        "Server should not respond to heartbeat from unregistered agent"
    );

    tokio::fs::remove_file(&test_db_path("test_ws_heartbeat.db"))
        .await
        .ok();
}

#[tokio::test]
async fn test_client_agents_list_unauthenticated() {
    let config = nession_common::config::ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: "test_token".to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 30,
        db_path: test_db_path("test_ws_alist.db"),
        ..Default::default()
    };

    let (addr, _handle) = start_test_server(config).await;

    let url = format!("ws://{addr}");
    let (mut ws, _) = connect_async(&url).await.unwrap();

    let msg = serde_json::json!({
        "msg_type": "client.agents.list",
        "id": "al1", "timestamp": current_timestamp(),
        "payload": {}
    });
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        msg.to_string(),
    ))
    .await
    .unwrap();

    let resp = ws.next().await.unwrap().unwrap();
    let text = match resp {
        tokio_tungstenite::tungstenite::Message::Text(t) => t,
        _ => panic!("Expected text response"),
    };
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["payload"]["message"], "Not authenticated");

    tokio::fs::remove_file(&test_db_path("test_ws_alist.db"))
        .await
        .ok();
}

#[tokio::test]
async fn test_close_frame_triggers_disconnect() {
    let config = nession_common::config::ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: "test_token".to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 30,
        db_path: test_db_path("test_ws_close.db"),
        ..Default::default()
    };

    let (addr, _handle) = start_test_server(config).await;

    let url = format!("ws://{addr}");
    let (mut ws, _) = connect_async(&url).await.unwrap();

    // Send a close frame.
    ws.send(tokio_tungstenite::tungstenite::Message::Close(None))
        .await
        .unwrap();

    // The server should handle the close gracefully.
    tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

    // Verify server is still running by connecting again.
    let (_ws2, _) = connect_async(&url).await.unwrap();

    tokio::fs::remove_file(&test_db_path("test_ws_close.db"))
        .await
        .ok();
}

#[tokio::test]
async fn test_agent_registration_with_connect_url() {
    let config = nession_common::config::ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: "test_token".to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 30,
        db_path: test_db_path("test_ws_connect_url.db"),
        ..Default::default()
    };

    let (addr, _handle) = start_test_server(config).await;

    let url = format!("ws://{addr}");
    let (mut ws, _) = connect_async(&url).await.unwrap();

    let msg = serde_json::json!({
        "msg_type": "agent.register",
        "id": "cu1", "timestamp": current_timestamp(),
        "payload": {
            "agent_id": "cu-agent", "hostname": "h", "ip_address": "10.0.0.1",
            "port": 9090, "auth_token": "test_token",
            "connect_url": "wss://custom.example.com/ws",
            "metadata": {
                "tmux_version": "3.3", "os_version": "Linux", "nession_version": "0.1"
            },
            "protocol_version": "1.0"
        }
    });
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        msg.to_string(),
    ))
    .await
    .unwrap();

    let resp = ws.next().await.unwrap().unwrap();
    let text = match resp {
        tokio_tungstenite::tungstenite::Message::Text(t) => t,
        _ => panic!("Expected text"),
    };
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["payload"]["status"], "accepted");

    tokio::fs::remove_file(&test_db_path("test_ws_connect_url.db"))
        .await
        .ok();
}

#[tokio::test]
async fn test_server_local_addr() {
    let config = nession_common::config::ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: "test_token".to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 30,
        db_path: test_db_path("test_ws_local_addr.db"),
        ..Default::default()
    };

    let db = Database::new(&config.db_path).await.unwrap();
    let server = WebSocketServer::new(config, Arc::new(db)).await.unwrap();
    let addr = server.local_addr().unwrap();

    assert_eq!(addr.ip().to_string(), "127.0.0.1");
    assert!(addr.port() > 0);

    tokio::fs::remove_file(&test_db_path("test_ws_local_addr.db"))
        .await
        .ok();
}

#[tokio::test]
async fn test_client_sessions_list_authenticated() {
    let config = nession_common::config::ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        auth_token: "test_token".to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 30,
        db_path: test_db_path("test_ws_sessions_list.db"),
        ..Default::default()
    };

    let (addr, _handle) = start_test_server(config).await;

    let url = format!("ws://{addr}");
    let (mut ws_stream, _) = connect_async(&url).await.unwrap();

    // Authenticate
    let auth_msg = serde_json::json!({
        "msg_type": "client.auth",
        "id": "msg_auth",
        "timestamp": current_timestamp(),
        "payload": {
            "auth_token": "test_token"
        }
    });

    ws_stream
        .send(tokio_tungstenite::tungstenite::Message::Text(
            auth_msg.to_string(),
        ))
        .await
        .unwrap();

    let response = ws_stream.next().await.unwrap().unwrap();
    let response_text = match response {
        tokio_tungstenite::tungstenite::Message::Text(text) => text,
        _ => panic!("Expected text response"),
    };

    let response_msg: serde_json::Value = serde_json::from_str(&response_text).unwrap();
    assert_eq!(response_msg["payload"]["status"], "success");

    // Request sessions list
    let sessions_msg = serde_json::json!({
        "msg_type": "client.sessions.list",
        "id": "msg_sessions",
        "timestamp": current_timestamp(),
        "payload": {}
    });

    ws_stream
        .send(tokio_tungstenite::tungstenite::Message::Text(
            sessions_msg.to_string(),
        ))
        .await
        .unwrap();

    let response = ws_stream.next().await.unwrap().unwrap();
    let response_text = match response {
        tokio_tungstenite::tungstenite::Message::Text(text) => text,
        _ => panic!("Expected text response"),
    };

    let response_msg: serde_json::Value = serde_json::from_str(&response_text).unwrap();
    assert_eq!(response_msg["msg_type"], "client.sessions.list.response");
    assert!(response_msg["payload"]["sessions"].is_array());

    tokio::fs::remove_file(&test_db_path("test_ws_sessions_list.db"))
        .await
        .ok();
}
