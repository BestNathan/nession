use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use nession_server::server::WebSocketServer;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// Helper struct that starts a server on a random port and provides its address.
struct TestServer {
    addr: std::net::SocketAddr,
    db_path: String,
    _handle: tokio::task::JoinHandle<()>,
}

impl TestServer {
    /// Start a test server with the given auth token and wait until it is ready.
    async fn start(auth_token: &str) -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let db_path = format!("./test_integration_{}_{}.db", current_timestamp(), id);

        let config = nession_common::config::ServerConfig {
            listen_address: "127.0.0.1:0".to_string(),
            tls_cert_path: String::new(),
            tls_key_path: String::new(),
            auth_token: auth_token.to_string(),
            heartbeat_timeout_secs: 30,
            db_path: db_path.clone(),
        };

        let mut server = WebSocketServer::new(config).await.unwrap();
        let addr = server.local_addr().unwrap();

        let handle = tokio::spawn(async move {
            // Errors are expected when tests tear down — ignore them.
            let _ = server.run().await;
        });

        // Give the accept-loop a moment to start.
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

        Self {
            addr,
            db_path,
            _handle: handle,
        }
    }

    fn ws_url(&self) -> String {
        format!("ws://{}", self.addr)
    }

    /// Connect a raw WebSocket client.
    async fn connect(&self) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
        let (stream, _) = connect_async(self.ws_url()).await.unwrap();
        stream
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        let path = self.db_path.clone();
        tokio::spawn(async move {
            tokio::fs::remove_file(&path).await.ok();
        });
    }
}

/// Send a text message over a WebSocket stream.
async fn send_text(
    ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    text: String,
) {
    ws.send(WsMessage::Text(text)).await.unwrap();
}

/// Receive the next text message, panicking if the connection closes or a non-text frame arrives.
async fn recv_text(
    ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
) -> String {
    match ws.next().await {
        Some(Ok(WsMessage::Text(t))) => t,
        Some(Ok(other)) => panic!("Expected text message, got: {:?}", other),
        Some(Err(e)) => panic!("WebSocket error: {}", e),
        None => panic!("WebSocket stream ended unexpectedly"),
    }
}

/// Try to receive a message within `timeout_ms`. Returns `None` on timeout.
async fn try_recv_text(
    ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    timeout_ms: u64,
) -> Option<String> {
    match tokio::time::timeout(
        tokio::time::Duration::from_millis(timeout_ms),
        ws.next(),
    )
    .await
    {
        Ok(Some(Ok(WsMessage::Text(t)))) => Some(t),
        Ok(Some(Ok(_))) => None,
        Ok(Some(Err(_))) => None,
        Ok(None) => None,
        Err(_) => None, // timeout
    }
}

// ---------------------------------------------------------------------------
// 1. Server startup
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_server_starts_and_accepts_connections() {
    let server = TestServer::start("token").await;
    let _ws = server.connect().await;
    // If we got here, the server accepted a connection.
}

#[tokio::test]
async fn test_server_accepts_multiple_simultaneous_connections() {
    let server = TestServer::start("token").await;

    let mut clients = Vec::new();
    for _ in 0..5 {
        clients.push(server.connect().await);
    }
    assert_eq!(clients.len(), 5);
}

// ---------------------------------------------------------------------------
// 2. Agent registration
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_agent_registration_success() {
    let server = TestServer::start("secret").await;
    let mut ws = server.connect().await;

    let msg = serde_json::json!({
        "msg_type": "agent.register",
        "id": "reg-1",
        "timestamp": current_timestamp(),
        "payload": {
            "agent_id": "agent-001",
            "hostname": "devbox",
            "ip_address": "10.0.0.1",
            "port": 9090,
            "auth_token": "secret",
            "metadata": {
                "tmux_version": "3.3a",
                "os_version": "Linux 6.1",
                "nession_version": "0.1.0"
            },
            "protocol_version": "1.0"
        }
    });

    send_text(&mut ws, msg.to_string()).await;
    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();

    assert_eq!(resp["msg_type"], "agent.register.response");
    assert_eq!(resp["payload"]["status"], "accepted");
    assert_eq!(resp["id"], "reg-1");
}

#[tokio::test]
async fn test_agent_registration_rejected_bad_token() {
    let server = TestServer::start("correct_token").await;
    let mut ws = server.connect().await;

    let msg = serde_json::json!({
        "msg_type": "agent.register",
        "id": "reg-2",
        "timestamp": current_timestamp(),
        "payload": {
            "agent_id": "agent-bad",
            "hostname": "evil",
            "ip_address": "10.0.0.2",
            "port": 9090,
            "auth_token": "wrong_token",
            "metadata": {
                "tmux_version": "3.3a",
                "os_version": "Linux",
                "nession_version": "0.1.0"
            },
            "protocol_version": "1.0"
        }
    });

    send_text(&mut ws, msg.to_string()).await;
    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();

    assert_eq!(resp["msg_type"], "agent.register.response");
    assert_eq!(resp["payload"]["status"], "rejected");
}

#[tokio::test]
async fn test_multiple_agents_register_independently() {
    let server = TestServer::start("shared_token").await;

    // Register two agents on separate connections.
    let mut ws1 = server.connect().await;
    let mut ws2 = server.connect().await;

    let make_reg = |agent_id: &str| {
        serde_json::json!({
            "msg_type": "agent.register",
            "id": format!("reg-{}", agent_id),
            "timestamp": current_timestamp(),
            "payload": {
                "agent_id": agent_id,
                "hostname": "host",
                "ip_address": "127.0.0.1",
                "port": 8080,
                "auth_token": "shared_token",
                "metadata": {
                    "tmux_version": "3.3a",
                    "os_version": "Linux",
                    "nession_version": "0.1.0"
                },
                "protocol_version": "1.0"
            }
        })
    };

    send_text(&mut ws1, make_reg("agent-A").to_string()).await;
    send_text(&mut ws2, make_reg("agent-B").to_string()).await;

    let resp1: serde_json::Value = serde_json::from_str(&recv_text(&mut ws1).await).unwrap();
    let resp2: serde_json::Value = serde_json::from_str(&recv_text(&mut ws2).await).unwrap();

    assert_eq!(resp1["payload"]["status"], "accepted");
    assert_eq!(resp2["payload"]["status"], "accepted");
}

// ---------------------------------------------------------------------------
// 3. Agent heartbeat
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_heartbeat_after_registration_is_silent() {
    let server = TestServer::start("tok").await;
    let mut ws = server.connect().await;

    // Register first.
    let reg = serde_json::json!({
        "msg_type": "agent.register",
        "id": "reg-hb",
        "timestamp": current_timestamp(),
        "payload": {
            "agent_id": "hb-agent",
            "hostname": "hb-host",
            "ip_address": "10.0.0.5",
            "port": 7070,
            "auth_token": "tok",
            "metadata": {
                "tmux_version": "3.3a",
                "os_version": "Linux",
                "nession_version": "0.1.0"
            },
            "protocol_version": "1.0"
        }
    });
    send_text(&mut ws, reg.to_string()).await;
    let _ = recv_text(&mut ws).await; // consume the registration response

    // Send a heartbeat.
    let hb = serde_json::json!({
        "msg_type": "agent.heartbeat",
        "id": "hb-1",
        "timestamp": current_timestamp(),
        "payload": {
            "agent_id": "hb-agent",
            "status": "online",
            "session_count": 3,
            "active_sessions": 1,
            "metadata": {
                "uptime_seconds": 3600,
                "load_average": [0.1, 0.2, 0.3]
            }
        }
    });
    send_text(&mut ws, hb.to_string()).await;

    // The server should NOT respond to heartbeats.
    let result = try_recv_text(&mut ws, 500).await;
    assert!(result.is_none(), "Server should not respond to heartbeat");
}

#[tokio::test]
async fn test_heartbeat_without_registration_is_silent() {
    let server = TestServer::start("tok").await;
    let mut ws = server.connect().await;

    let hb = serde_json::json!({
        "msg_type": "agent.heartbeat",
        "id": "hb-unreg",
        "timestamp": current_timestamp(),
        "payload": {
            "agent_id": "ghost-agent",
            "status": "online",
            "session_count": 0,
            "active_sessions": 0
        }
    });
    send_text(&mut ws, hb.to_string()).await;

    let result = try_recv_text(&mut ws, 500).await;
    assert!(
        result.is_none(),
        "Server should not respond to heartbeat from unregistered agent"
    );
}

#[tokio::test]
async fn test_multiple_heartbeats_accepted() {
    let server = TestServer::start("tok").await;
    let mut ws = server.connect().await;

    // Register.
    let reg = serde_json::json!({
        "msg_type": "agent.register",
        "id": "reg-multi-hb",
        "timestamp": current_timestamp(),
        "payload": {
            "agent_id": "multi-hb-agent",
            "hostname": "host",
            "ip_address": "10.0.0.6",
            "port": 7070,
            "auth_token": "tok",
            "metadata": {
                "tmux_version": "3.3a",
                "os_version": "Linux",
                "nession_version": "0.1.0"
            },
            "protocol_version": "1.0"
        }
    });
    send_text(&mut ws, reg.to_string()).await;
    let _ = recv_text(&mut ws).await; // consume registration response

    // Send several heartbeats.
    for i in 0..5 {
        let hb = serde_json::json!({
            "msg_type": "agent.heartbeat",
            "id": format!("hb-{}", i),
            "timestamp": current_timestamp(),
            "payload": {
                "agent_id": "multi-hb-agent",
                "status": "online",
                "session_count": i,
                "active_sessions": i
            }
        });
        send_text(&mut ws, hb.to_string()).await;
    }

    // None of them should produce a response.
    let result = try_recv_text(&mut ws, 500).await;
    assert!(result.is_none(), "No heartbeat should produce a response");
}

// ---------------------------------------------------------------------------
// 4. Client authentication
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_client_auth_success() {
    let server = TestServer::start("client_secret").await;
    let mut ws = server.connect().await;

    let auth = serde_json::json!({
        "msg_type": "client.auth",
        "id": "auth-1",
        "timestamp": current_timestamp(),
        "payload": {
            "auth_token": "client_secret"
        }
    });
    send_text(&mut ws, auth.to_string()).await;

    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert_eq!(resp["msg_type"], "client.auth.response");
    assert_eq!(resp["payload"]["status"], "success");
    assert_eq!(resp["id"], "auth-1");
}

#[tokio::test]
async fn test_client_auth_failure() {
    let server = TestServer::start("real_secret").await;
    let mut ws = server.connect().await;

    let auth = serde_json::json!({
        "msg_type": "client.auth",
        "id": "auth-2",
        "timestamp": current_timestamp(),
        "payload": {
            "auth_token": "bad_secret"
        }
    });
    send_text(&mut ws, auth.to_string()).await;

    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert_eq!(resp["msg_type"], "client.auth.response");
    assert_eq!(resp["payload"]["status"], "failed");
}

#[tokio::test]
async fn test_multiple_clients_auth_simultaneously() {
    let server = TestServer::start("shared_client_tok").await;

    let mut ws1 = server.connect().await;
    let mut ws2 = server.connect().await;

    let auth1 = serde_json::json!({
        "msg_type": "client.auth",
        "id": "auth-c1",
        "timestamp": current_timestamp(),
        "payload": { "auth_token": "shared_client_tok" }
    });
    let auth2 = serde_json::json!({
        "msg_type": "client.auth",
        "id": "auth-c2",
        "timestamp": current_timestamp(),
        "payload": { "auth_token": "shared_client_tok" }
    });

    send_text(&mut ws1, auth1.to_string()).await;
    send_text(&mut ws2, auth2.to_string()).await;

    let resp1: serde_json::Value = serde_json::from_str(&recv_text(&mut ws1).await).unwrap();
    let resp2: serde_json::Value = serde_json::from_str(&recv_text(&mut ws2).await).unwrap();

    assert_eq!(resp1["payload"]["status"], "success");
    assert_eq!(resp2["payload"]["status"], "success");
}

// ---------------------------------------------------------------------------
// 5. Full workflow — agent + client on the same server
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_full_workflow_agent_and_client() {
    let server = TestServer::start("workflow_token").await;

    // --- Step 1: Agent registers ---
    let mut agent_ws = server.connect().await;
    let reg = serde_json::json!({
        "msg_type": "agent.register",
        "id": "wf-reg",
        "timestamp": current_timestamp(),
        "payload": {
            "agent_id": "wf-agent",
            "hostname": "workflow-host",
            "ip_address": "10.0.0.10",
            "port": 5050,
            "auth_token": "workflow_token",
            "metadata": {
                "tmux_version": "3.3a",
                "os_version": "macOS 15",
                "nession_version": "0.1.0"
            },
            "protocol_version": "1.0"
        }
    });
    send_text(&mut agent_ws, reg.to_string()).await;
    let reg_resp: serde_json::Value =
        serde_json::from_str(&recv_text(&mut agent_ws).await).unwrap();
    assert_eq!(reg_resp["payload"]["status"], "accepted");

    // --- Step 2: Agent sends heartbeat ---
    let hb = serde_json::json!({
        "msg_type": "agent.heartbeat",
        "id": "wf-hb",
        "timestamp": current_timestamp(),
        "payload": {
            "agent_id": "wf-agent",
            "status": "online",
            "session_count": 2,
            "active_sessions": 1,
            "metadata": {
                "uptime_seconds": 600,
                "load_average": [0.5, 0.4, 0.3]
            }
        }
    });
    send_text(&mut agent_ws, hb.to_string()).await;
    // Heartbeats are silent — no response expected.
    let hb_result = try_recv_text(&mut agent_ws, 300).await;
    assert!(hb_result.is_none(), "Heartbeat should not produce a response");

    // --- Step 3: Client authenticates ---
    let mut client_ws = server.connect().await;
    let auth = serde_json::json!({
        "msg_type": "client.auth",
        "id": "wf-auth",
        "timestamp": current_timestamp(),
        "payload": {
            "auth_token": "workflow_token"
        }
    });
    send_text(&mut client_ws, auth.to_string()).await;
    let auth_resp: serde_json::Value =
        serde_json::from_str(&recv_text(&mut client_ws).await).unwrap();
    assert_eq!(auth_resp["payload"]["status"], "success");

    // --- Step 4: Agent sends another heartbeat after client connected ---
    let hb2 = serde_json::json!({
        "msg_type": "agent.heartbeat",
        "id": "wf-hb-2",
        "timestamp": current_timestamp(),
        "payload": {
            "agent_id": "wf-agent",
            "status": "online",
            "session_count": 3,
            "active_sessions": 2
        }
    });
    send_text(&mut agent_ws, hb2.to_string()).await;
    let hb2_result = try_recv_text(&mut agent_ws, 300).await;
    assert!(hb2_result.is_none(), "Second heartbeat should also be silent");
}

// ---------------------------------------------------------------------------
// 6. Unknown message types
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_unknown_message_type_is_ignored() {
    let server = TestServer::start("tok").await;
    let mut ws = server.connect().await;

    let unknown = serde_json::json!({
        "msg_type": "totally.unknown",
        "id": "unk-1",
        "timestamp": current_timestamp(),
        "payload": { "foo": "bar" }
    });
    send_text(&mut ws, unknown.to_string()).await;

    let result = try_recv_text(&mut ws, 500).await;
    assert!(
        result.is_none(),
        "Unknown message type should be silently ignored"
    );
}

// ---------------------------------------------------------------------------
// 7. Edge cases
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_agent_can_register_then_authenticate_as_client() {
    // A single connection that first registers as an agent, then sends client.auth.
    let server = TestServer::start("dual_tok").await;
    let mut ws = server.connect().await;

    // Register as agent.
    let reg = serde_json::json!({
        "msg_type": "agent.register",
        "id": "dual-reg",
        "timestamp": current_timestamp(),
        "payload": {
            "agent_id": "dual-agent",
            "hostname": "dual-host",
            "ip_address": "10.0.0.20",
            "port": 6060,
            "auth_token": "dual_tok",
            "metadata": {
                "tmux_version": "3.3a",
                "os_version": "Linux",
                "nession_version": "0.1.0"
            },
            "protocol_version": "1.0"
        }
    });
    send_text(&mut ws, reg.to_string()).await;
    let reg_resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert_eq!(reg_resp["payload"]["status"], "accepted");

    // Now also authenticate as a client on the same connection.
    let auth = serde_json::json!({
        "msg_type": "client.auth",
        "id": "dual-auth",
        "timestamp": current_timestamp(),
        "payload": { "auth_token": "dual_tok" }
    });
    send_text(&mut ws, auth.to_string()).await;
    let auth_resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert_eq!(auth_resp["payload"]["status"], "success");
}

#[tokio::test]
async fn test_malformed_json_does_not_crash_server() {
    let server = TestServer::start("tok").await;
    let mut ws = server.connect().await;

    // Send garbage data.
    send_text(&mut ws, "not json at all".to_string()).await;

    // The server should handle the parse error gracefully.
    // The connection may close or the message may be silently dropped.
    // Wait a bit and then verify the server is still up by connecting a new client.
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    let mut ws2 = server.connect().await;
    let auth = serde_json::json!({
        "msg_type": "client.auth",
        "id": "post-crash",
        "timestamp": current_timestamp(),
        "payload": { "auth_token": "tok" }
    });
    send_text(&mut ws2, auth.to_string()).await;

    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws2).await).unwrap();
    assert_eq!(resp["payload"]["status"], "success");
}

#[tokio::test]
async fn test_response_preserves_message_id() {
    let server = TestServer::start("id_tok").await;
    let mut ws = server.connect().await;

    let unique_id = "unique-msg-id-42";
    let reg = serde_json::json!({
        "msg_type": "agent.register",
        "id": unique_id,
        "timestamp": current_timestamp(),
        "payload": {
            "agent_id": "id-agent",
            "hostname": "host",
            "ip_address": "10.0.0.30",
            "port": 4040,
            "auth_token": "id_tok",
            "metadata": {
                "tmux_version": "3.3a",
                "os_version": "Linux",
                "nession_version": "0.1.0"
            },
            "protocol_version": "1.0"
        }
    });
    send_text(&mut ws, reg.to_string()).await;
    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert_eq!(resp["id"], unique_id);
}

#[tokio::test]
async fn test_response_includes_timestamp() {
    let server = TestServer::start("ts_tok").await;
    let mut ws = server.connect().await;

    let before = current_timestamp();

    let auth = serde_json::json!({
        "msg_type": "client.auth",
        "id": "ts-1",
        "timestamp": current_timestamp(),
        "payload": { "auth_token": "ts_tok" }
    });
    send_text(&mut ws, auth.to_string()).await;
    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();

    let after = current_timestamp();
    let ts = resp["timestamp"].as_u64().expect("response must include timestamp");
    assert!(
        ts >= before && ts <= after,
        "Timestamp {} should be between {} and {}",
        ts, before, after
    );
}

// ---------------------------------------------------------------------------
// 8. Concurrent agent + client stress test
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_concurrent_agent_registrations() {
    let server = TestServer::start("conc_tok").await;
    let mut handles = Vec::new();

    for i in 0..10 {
        let url = format!("ws://{}", server.addr);
        let handle = tokio::spawn(async move {
            let (mut ws, _) = connect_async(&url).await.unwrap();

            let reg = serde_json::json!({
                "msg_type": "agent.register",
                "id": format!("conc-reg-{}", i),
                "timestamp": current_timestamp(),
                "payload": {
                    "agent_id": format!("agent-{}", i),
                    "hostname": format!("host-{}", i),
                    "ip_address": "127.0.0.1",
                    "port": 3000 + i as u16,
                    "auth_token": "conc_tok",
                    "metadata": {
                        "tmux_version": "3.3a",
                        "os_version": "Linux",
                        "nession_version": "0.1.0"
                    },
                    "protocol_version": "1.0"
                }
            });

            ws.send(WsMessage::Text(reg.to_string())).await.unwrap();
            let resp = ws.next().await.unwrap().unwrap();
            let text = match resp {
                WsMessage::Text(t) => t,
                _ => panic!("Expected text"),
            };
            let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(parsed["payload"]["status"], "accepted");
        });
        handles.push(handle);
    }

    for h in handles {
        h.await.unwrap();
    }
}

#[tokio::test]
async fn test_connection_disconnect_does_not_affect_others() {
    let server = TestServer::start("disc_tok").await;

    // Connect and immediately drop (disconnect).
    {
        let _ws = server.connect().await;
        // _ws is dropped here.
    }

    // Server should still accept new connections.
    let mut ws = server.connect().await;
    let auth = serde_json::json!({
        "msg_type": "client.auth",
        "id": "after-disc",
        "timestamp": current_timestamp(),
        "payload": { "auth_token": "disc_tok" }
    });
    send_text(&mut ws, auth.to_string()).await;
    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert_eq!(resp["payload"]["status"], "success");
}
