use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use nession_server::db::Database;
use nession_server::server::WebSocketServer;

use super::current_timestamp;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Helper struct that starts a server on a random port and provides its address.
struct TestServer {
    addr: std::net::SocketAddr,
    db_path: String,
    _handle: tokio::task::JoinHandle<()>,
}

impl TestServer {
    /// Start a test server with the given auth token and wait until it is ready.
    async fn start(auth_token: &str) -> anyhow::Result<Self> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let db_path = std::env::temp_dir()
            .join(format!(
                "nession_test_integration_{}_{}.db",
                current_timestamp(),
                id
            ))
            .to_string_lossy()
            .to_string();

        let config = nession_common::config::ServerConfig {
            listen_address: "127.0.0.1:0".to_string(),
            tls_cert_path: String::new(),
            tls_key_path: String::new(),
            auth_token: auth_token.to_string(),
            heartbeat_interval_secs: 10,
            heartbeat_timeout_secs: 30,
            db_path: db_path.clone(),
            ..Default::default()
        };

        let db = Database::new(&db_path).await?;
        let mut server = WebSocketServer::new(config, Arc::new(db)).await?;
        let addr = server.local_addr()?;

        let handle = tokio::spawn(async move {
            // Errors are expected when tests tear down — ignore them.
            let _ = server.run().await;
        });

        // Give the accept-loop a moment to start.
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

        Ok(Self {
            addr,
            db_path,
            _handle: handle,
        })
    }

    fn ws_url(&self) -> String {
        format!("ws://{}", self.addr)
    }

    /// Connect a raw WebSocket client.
    async fn connect(
        &self,
    ) -> anyhow::Result<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    > {
        let (stream, _) = connect_async(self.ws_url()).await?;
        Ok(stream)
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
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    text: String,
) -> anyhow::Result<()> {
    ws.send(WsMessage::Text(text)).await?;
    Ok(())
}

/// Receive the next text message, panicking if the connection closes or a non-text frame arrives.
async fn recv_text(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> String {
    match ws.next().await {
        Some(Ok(WsMessage::Text(t))) => t,
        Some(Ok(other)) => panic!("Expected text message, got: {other:?}"),
        Some(Err(e)) => panic!("WebSocket error: {e}"),
        None => panic!("WebSocket stream ended unexpectedly"),
    }
}

/// Try to receive a message within `timeout_ms`. Returns `None` on timeout.
async fn try_recv_text(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    timeout_ms: u64,
) -> Option<String> {
    match tokio::time::timeout(tokio::time::Duration::from_millis(timeout_ms), ws.next()).await {
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
    let server = TestServer::start("token").await.unwrap();
    let _ws = server.connect().await.unwrap();
    // If we got here, the server accepted a connection.
}

#[tokio::test]
async fn test_server_accepts_multiple_simultaneous_connections() {
    let server = TestServer::start("token").await.unwrap();

    let mut clients = Vec::new();
    for _ in 0..5 {
        clients.push(server.connect().await.unwrap());
    }
    assert_eq!(clients.len(), 5);
}

// ---------------------------------------------------------------------------
// 2. Agent registration
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_agent_registration_success() {
    let server = TestServer::start("secret").await.unwrap();
    let mut ws = server.connect().await.unwrap();

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

    send_text(&mut ws, msg.to_string()).await.unwrap();
    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();

    assert_eq!(resp["msg_type"], "agent.register.response");
    assert_eq!(resp["payload"]["status"], "accepted");
    assert_eq!(resp["id"], "reg-1");
}

#[tokio::test]
async fn test_agent_registration_rejected_bad_token() {
    let server = TestServer::start("correct_token").await.unwrap();
    let mut ws = server.connect().await.unwrap();

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

    send_text(&mut ws, msg.to_string()).await.unwrap();
    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();

    assert_eq!(resp["msg_type"], "agent.register.response");
    assert_eq!(resp["payload"]["status"], "rejected");
}

#[tokio::test]
async fn test_multiple_agents_register_independently() {
    let server = TestServer::start("shared_token").await.unwrap();

    // Register two agents on separate connections.
    let mut ws1 = server.connect().await.unwrap();
    let mut ws2 = server.connect().await.unwrap();

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

    send_text(&mut ws1, make_reg("agent-A").to_string())
        .await
        .unwrap();
    send_text(&mut ws2, make_reg("agent-B").to_string())
        .await
        .unwrap();

    let resp1: serde_json::Value = serde_json::from_str(&recv_text(&mut ws1).await).unwrap();
    let resp2: serde_json::Value = serde_json::from_str(&recv_text(&mut ws2).await).unwrap();

    assert_eq!(resp1["payload"]["status"], "accepted");
    assert_eq!(resp2["payload"]["status"], "accepted");
}

// ---------------------------------------------------------------------------
// 3. Agent heartbeat
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_heartbeat_after_registration_is_acked() {
    let server = TestServer::start("tok").await.unwrap();
    let mut ws = server.connect().await.unwrap();

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
    send_text(&mut ws, reg.to_string()).await.unwrap();
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
    send_text(&mut ws, hb.to_string()).await.unwrap();

    // The server acknowledges heartbeats so the agent can confirm the link.
    let result = try_recv_text(&mut ws, 500).await;
    let ack = result.expect("Server should ack heartbeat");
    let parsed: serde_json::Value = serde_json::from_str(&ack).unwrap();
    assert_eq!(parsed["msg_type"], "server.heartbeat.ack");
    assert_eq!(parsed["payload"]["agent_id"], "hb-agent");
}

#[tokio::test]
async fn test_heartbeat_without_registration_is_silent() {
    let server = TestServer::start("tok").await.unwrap();
    let mut ws = server.connect().await.unwrap();

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
    send_text(&mut ws, hb.to_string()).await.unwrap();

    let result = try_recv_text(&mut ws, 500).await;
    assert!(
        result.is_none(),
        "Server should not respond to heartbeat from unregistered agent"
    );
}

#[tokio::test]
async fn test_multiple_heartbeats_accepted() {
    let server = TestServer::start("tok").await.unwrap();
    let mut ws = server.connect().await.unwrap();

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
    send_text(&mut ws, reg.to_string()).await.unwrap();
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
        send_text(&mut ws, hb.to_string()).await.unwrap();
    }

    // Each heartbeat should be acknowledged.
    for _ in 0..5 {
        let ack = try_recv_text(&mut ws, 500)
            .await
            .expect("expected heartbeat ack");
        let parsed: serde_json::Value = serde_json::from_str(&ack).unwrap();
        assert_eq!(parsed["msg_type"], "server.heartbeat.ack");
    }
}

// ---------------------------------------------------------------------------
// 4. Client authentication
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_client_auth_success() {
    let server = TestServer::start("client_secret").await.unwrap();
    let mut ws = server.connect().await.unwrap();

    let auth = serde_json::json!({
        "msg_type": "client.auth",
        "id": "auth-1",
        "timestamp": current_timestamp(),
        "payload": {
            "auth_token": "client_secret"
        }
    });
    send_text(&mut ws, auth.to_string()).await.unwrap();

    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert_eq!(resp["msg_type"], "client.auth.response");
    assert_eq!(resp["payload"]["status"], "success");
    assert_eq!(resp["id"], "auth-1");
}

#[tokio::test]
async fn test_client_auth_failure() {
    let server = TestServer::start("real_secret").await.unwrap();
    let mut ws = server.connect().await.unwrap();

    let auth = serde_json::json!({
        "msg_type": "client.auth",
        "id": "auth-2",
        "timestamp": current_timestamp(),
        "payload": {
            "auth_token": "bad_secret"
        }
    });
    send_text(&mut ws, auth.to_string()).await.unwrap();

    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert_eq!(resp["msg_type"], "client.auth.response");
    assert_eq!(resp["payload"]["status"], "failed");
}

#[tokio::test]
async fn test_multiple_clients_auth_simultaneously() {
    let server = TestServer::start("shared_client_tok").await.unwrap();

    let mut ws1 = server.connect().await.unwrap();
    let mut ws2 = server.connect().await.unwrap();

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

    send_text(&mut ws1, auth1.to_string()).await.unwrap();
    send_text(&mut ws2, auth2.to_string()).await.unwrap();

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
    let server = TestServer::start("workflow_token").await.unwrap();

    // --- Step 1: Agent registers ---
    let mut agent_ws = server.connect().await.unwrap();
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
    send_text(&mut agent_ws, reg.to_string()).await.unwrap();
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
    send_text(&mut agent_ws, hb.to_string()).await.unwrap();
    // Heartbeats are acknowledged.
    let hb_result = try_recv_text(&mut agent_ws, 300).await;
    let ack: serde_json::Value =
        serde_json::from_str(&hb_result.expect("expected heartbeat ack")).unwrap();
    assert_eq!(ack["msg_type"], "server.heartbeat.ack");

    // --- Step 3: Client authenticates ---
    let mut client_ws = server.connect().await.unwrap();
    let auth = serde_json::json!({
        "msg_type": "client.auth",
        "id": "wf-auth",
        "timestamp": current_timestamp(),
        "payload": {
            "auth_token": "workflow_token"
        }
    });
    send_text(&mut client_ws, auth.to_string()).await.unwrap();
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
    send_text(&mut agent_ws, hb2.to_string()).await.unwrap();
    let hb2_result = try_recv_text(&mut agent_ws, 300).await;
    let ack2: serde_json::Value =
        serde_json::from_str(&hb2_result.expect("expected second heartbeat ack")).unwrap();
    assert_eq!(ack2["msg_type"], "server.heartbeat.ack");
}

// ---------------------------------------------------------------------------
// 6. Unknown message types
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_unknown_message_type_is_ignored() {
    let server = TestServer::start("tok").await.unwrap();
    let mut ws = server.connect().await.unwrap();

    let unknown = serde_json::json!({
        "msg_type": "totally.unknown",
        "id": "unk-1",
        "timestamp": current_timestamp(),
        "payload": { "foo": "bar" }
    });
    send_text(&mut ws, unknown.to_string()).await.unwrap();

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
    let server = TestServer::start("dual_tok").await.unwrap();
    let mut ws = server.connect().await.unwrap();

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
    send_text(&mut ws, reg.to_string()).await.unwrap();
    let reg_resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert_eq!(reg_resp["payload"]["status"], "accepted");

    // Now also authenticate as a client on the same connection.
    let auth = serde_json::json!({
        "msg_type": "client.auth",
        "id": "dual-auth",
        "timestamp": current_timestamp(),
        "payload": { "auth_token": "dual_tok" }
    });
    send_text(&mut ws, auth.to_string()).await.unwrap();
    let auth_resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert_eq!(auth_resp["payload"]["status"], "success");
}

#[tokio::test]
async fn test_malformed_json_does_not_crash_server() {
    let server = TestServer::start("tok").await.unwrap();
    let mut ws = server.connect().await.unwrap();

    // Send garbage data.
    send_text(&mut ws, "not json at all".to_string())
        .await
        .unwrap();

    // The server should handle the parse error gracefully.
    // The connection may close or the message may be silently dropped.
    // Wait a bit and then verify the server is still up by connecting a new client.
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    let mut ws2 = server.connect().await.unwrap();
    let auth = serde_json::json!({
        "msg_type": "client.auth",
        "id": "post-crash",
        "timestamp": current_timestamp(),
        "payload": { "auth_token": "tok" }
    });
    send_text(&mut ws2, auth.to_string()).await.unwrap();

    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws2).await).unwrap();
    assert_eq!(resp["payload"]["status"], "success");
}

#[tokio::test]
async fn test_response_preserves_message_id() {
    let server = TestServer::start("id_tok").await.unwrap();
    let mut ws = server.connect().await.unwrap();

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
    send_text(&mut ws, reg.to_string()).await.unwrap();
    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert_eq!(resp["id"], unique_id);
}

#[tokio::test]
async fn test_response_includes_timestamp() {
    let server = TestServer::start("ts_tok").await.unwrap();
    let mut ws = server.connect().await.unwrap();

    let before = current_timestamp();

    let auth = serde_json::json!({
        "msg_type": "client.auth",
        "id": "ts-1",
        "timestamp": current_timestamp(),
        "payload": { "auth_token": "ts_tok" }
    });
    send_text(&mut ws, auth.to_string()).await.unwrap();
    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();

    let after = current_timestamp();
    let ts = resp["timestamp"]
        .as_u64()
        .expect("response must include timestamp");
    assert!(
        ts >= before && ts <= after,
        "Timestamp {ts} should be between {before} and {after}"
    );
}

// ---------------------------------------------------------------------------
// 8. Concurrent agent + client stress test
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_concurrent_agent_registrations() {
    let server = TestServer::start("conc_tok").await.unwrap();
    let mut handles = Vec::new();

    // u16 so the port arithmetic below needs no cast (3000 + 9 fits comfortably).
    for i in 0u16..10u16 {
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
                    "port": 3000 + i,
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
    let server = TestServer::start("disc_tok").await.unwrap();

    // Connect and immediately drop (disconnect).
    {
        let _ws = server.connect().await.unwrap();
        // _ws is dropped here.
    }

    // Server should still accept new connections.
    let mut ws = server.connect().await.unwrap();
    let auth = serde_json::json!({
        "msg_type": "client.auth",
        "id": "after-disc",
        "timestamp": current_timestamp(),
        "payload": { "auth_token": "disc_tok" }
    });
    send_text(&mut ws, auth.to_string()).await.unwrap();
    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert_eq!(resp["payload"]["status"], "success");
}

// ---------------------------------------------------------------------------
// 9. Agent session updates
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_agent_session_update_active() {
    let server = TestServer::start("tok").await.unwrap();
    let mut ws = server.connect().await.unwrap();

    // Register agent.
    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type": "agent.register",
            "id": "r1", "timestamp": current_timestamp(),
            "payload": {
                "agent_id": "a1", "hostname": "h", "ip_address": "10.0.0.1",
                "port": 8080, "auth_token": "tok",
                "metadata": {"tmux_version":"3.3","os_version":"Linux","nession_version":"0.1"},
                "protocol_version": "1.0"
            }
        })
        .to_string(),
    )
    .await
    .unwrap();
    let _ = recv_text(&mut ws).await;

    // Send session update.
    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type": "agent.session.update",
            "id": "su1", "timestamp": current_timestamp(),
            "payload": {
                "agent_id": "a1", "session_name": "dev", "status": "active",
                "window_count": 3, "attached_clients": 1
            }
        })
        .to_string(),
    )
    .await
    .unwrap();

    // Session updates are not acknowledged via response (optimistic).
    // Verify silence (no error response).
    let result = try_recv_text(&mut ws, 300).await;
    assert!(
        result.is_none(),
        "Session update should not produce a response"
    );
}

#[tokio::test]
async fn test_agent_session_update_detached() {
    let server = TestServer::start("tok").await.unwrap();
    let mut ws = server.connect().await.unwrap();

    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type": "agent.register","id": "r2","timestamp": current_timestamp(),
            "payload": {"agent_id":"a2","hostname":"h","ip_address":"10.0.0.2",
            "port":8080,"auth_token":"tok",
            "metadata":{"tmux_version":"3.3","os_version":"Linux","nession_version":"0.1"},
            "protocol_version":"1.0"}
        })
        .to_string(),
    )
    .await
    .unwrap();
    let _ = recv_text(&mut ws).await;

    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type": "agent.session.update","id": "su2","timestamp": current_timestamp(),
            "payload": {"agent_id":"a2","session_name":"stale","status":"detached",
            "window_count":1,"attached_clients":0}
        })
        .to_string(),
    )
    .await
    .unwrap();

    let result = try_recv_text(&mut ws, 300).await;
    assert!(result.is_none());
}

#[tokio::test]
async fn test_agent_session_update_gone_removes_session() {
    let server = TestServer::start("tok").await.unwrap();
    let mut ws = server.connect().await.unwrap();

    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type": "agent.register","id":"r3","timestamp":current_timestamp(),
            "payload":{"agent_id":"a3","hostname":"h","ip_address":"10.0.0.3",
            "port":8080,"auth_token":"tok",
            "metadata":{"tmux_version":"3.3","os_version":"Linux","nession_version":"0.1"},
            "protocol_version":"1.0"}
        })
        .to_string(),
    )
    .await
    .unwrap();
    let _ = recv_text(&mut ws).await;

    // Create a session first.
    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type":"agent.session.update","id":"su3","timestamp":current_timestamp(),
            "payload":{"agent_id":"a3","session_name":"temp","status":"active",
            "window_count":1,"attached_clients":0}
        })
        .to_string(),
    )
    .await
    .unwrap();

    // Now remove it.
    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type":"agent.session.update","id":"su4","timestamp":current_timestamp(),
            "payload":{"agent_id":"a3","session_name":"temp","status":"gone",
            "window_count":0,"attached_clients":0}
        })
        .to_string(),
    )
    .await
    .unwrap();

    let result = try_recv_text(&mut ws, 300).await;
    assert!(result.is_none());
}

#[tokio::test]
async fn test_session_update_from_unregistered_agent_is_silent() {
    let server = TestServer::start("tok").await.unwrap();
    let mut ws = server.connect().await.unwrap();

    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type":"agent.session.update","id":"su-ghost","timestamp":current_timestamp(),
            "payload":{"agent_id":"ghost","session_name":"s","status":"active",
            "window_count":0,"attached_clients":0}
        })
        .to_string(),
    )
    .await
    .unwrap();

    let result = try_recv_text(&mut ws, 300).await;
    assert!(result.is_none());
}

// ---------------------------------------------------------------------------
// 10. Client agents list
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_client_agents_list_requires_auth() {
    let server = TestServer::start("tok").await.unwrap();
    let mut ws = server.connect().await.unwrap();

    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type":"client.agents.list","id":"al1","timestamp":current_timestamp(),
            "payload":{}
        })
        .to_string(),
    )
    .await
    .unwrap();

    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert_eq!(resp["payload"]["message"], "Not authenticated");
}

#[tokio::test]
async fn test_client_agents_list_returns_registered_agents() {
    let server = TestServer::start("tok").await.unwrap();

    // Register an agent first.
    let mut agent_ws = server.connect().await.unwrap();
    send_text(
        &mut agent_ws,
        serde_json::json!({
            "msg_type":"agent.register","id":"r-al","timestamp":current_timestamp(),
            "payload":{"agent_id":"list-agent","hostname":"list-host","ip_address":"10.0.0.50",
            "port":8080,"auth_token":"tok",
            "metadata":{"tmux_version":"3.3","os_version":"Linux","nession_version":"0.1"},
            "protocol_version":"1.0"}
        })
        .to_string(),
    )
    .await
    .unwrap();
    let _ = recv_text(&mut agent_ws).await;

    // Client authenticates and lists agents.
    let mut client_ws = server.connect().await.unwrap();
    send_text(
        &mut client_ws,
        serde_json::json!({
            "msg_type":"client.auth","id":"auth-al","timestamp":current_timestamp(),
            "payload":{"auth_token":"tok"}
        })
        .to_string(),
    )
    .await
    .unwrap();
    let _ = recv_text(&mut client_ws).await;

    send_text(
        &mut client_ws,
        serde_json::json!({
            "msg_type":"client.agents.list","id":"list-req","timestamp":current_timestamp(),
            "payload":{}
        })
        .to_string(),
    )
    .await
    .unwrap();

    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut client_ws).await).unwrap();
    assert_eq!(resp["msg_type"], "client.agents.list.response");
    let agents = resp["payload"]["agents"].as_array().unwrap();
    assert!(!agents.is_empty());
    assert_eq!(agents[0]["agent_id"], "list-agent");
    assert_eq!(agents[0]["status"], "online");

    // agents.list now carries the probed address list (issue #51) so clients
    // can latency-probe without an attach round-trip.
    let addresses = agents[0]["addresses"].as_array().unwrap();
    assert!(
        !addresses.is_empty(),
        "expected synthesized address from ip/port"
    );
    assert!(addresses[0]["url"].as_str().unwrap().contains("10.0.0.50"));
}

// ---------------------------------------------------------------------------
// 11. Client sessions list
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_client_sessions_list_requires_auth() {
    let server = TestServer::start("tok").await.unwrap();
    let mut ws = server.connect().await.unwrap();

    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type":"client.sessions.list","id":"sl1","timestamp":current_timestamp(),
            "payload":{}
        })
        .to_string(),
    )
    .await
    .unwrap();

    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert_eq!(resp["payload"]["message"], "Not authenticated");
}

#[tokio::test]
async fn test_client_sessions_list_returns_sessions() {
    let server = TestServer::start("tok").await.unwrap();

    // Register agent and push a session update.
    let mut agent_ws = server.connect().await.unwrap();
    send_text(
        &mut agent_ws,
        serde_json::json!({
            "msg_type":"agent.register","id":"r-sl","timestamp":current_timestamp(),
            "payload":{"agent_id":"sess-agent","hostname":"h","ip_address":"10.0.0.60",
            "port":8080,"auth_token":"tok",
            "metadata":{"tmux_version":"3.3","os_version":"Linux","nession_version":"0.1"},
            "protocol_version":"1.0"}
        })
        .to_string(),
    )
    .await
    .unwrap();
    let _ = recv_text(&mut agent_ws).await;

    send_text(
        &mut agent_ws,
        serde_json::json!({
            "msg_type":"agent.session.update","id":"su-sl","timestamp":current_timestamp(),
            "payload":{"agent_id":"sess-agent","session_name":"my-sess","status":"active",
            "window_count":2,"attached_clients":0}
        })
        .to_string(),
    )
    .await
    .unwrap();

    // Client lists sessions.
    let mut client_ws = server.connect().await.unwrap();
    send_text(
        &mut client_ws,
        serde_json::json!({
            "msg_type":"client.auth","id":"auth-sl","timestamp":current_timestamp(),
            "payload":{"auth_token":"tok"}
        })
        .to_string(),
    )
    .await
    .unwrap();
    let _ = recv_text(&mut client_ws).await;

    send_text(
        &mut client_ws,
        serde_json::json!({
            "msg_type":"client.sessions.list","id":"sl-req","timestamp":current_timestamp(),
            "payload":{}
        })
        .to_string(),
    )
    .await
    .unwrap();

    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut client_ws).await).unwrap();
    let sessions = resp["payload"]["sessions"].as_array().unwrap();
    assert!(!sessions.is_empty());
    assert_eq!(sessions[0]["session_id"], "sess-agent:my-sess");
    assert_eq!(sessions[0]["status"], "active");
}

#[tokio::test]
async fn test_client_sessions_list_filtered_by_agent() {
    let server = TestServer::start("tok").await.unwrap();

    // Register two agents with sessions.
    let mut agent1 = server.connect().await.unwrap();
    send_text(
        &mut agent1,
        serde_json::json!({
            "msg_type":"agent.register","id":"r1","timestamp":current_timestamp(),
            "payload":{"agent_id":"agent-x","hostname":"h","ip_address":"10.0.0.70",
            "port":8080,"auth_token":"tok",
            "metadata":{"tmux_version":"3.3","os_version":"Linux","nession_version":"0.1"},
            "protocol_version":"1.0"}
        })
        .to_string(),
    )
    .await
    .unwrap();
    let _ = recv_text(&mut agent1).await;
    send_text(
        &mut agent1,
        serde_json::json!({
            "msg_type":"agent.session.update","id":"sx","timestamp":current_timestamp(),
            "payload":{"agent_id":"agent-x","session_name":"sess-x","status":"active",
            "window_count":1,"attached_clients":0}
        })
        .to_string(),
    )
    .await
    .unwrap();

    let mut agent2 = server.connect().await.unwrap();
    send_text(
        &mut agent2,
        serde_json::json!({
            "msg_type":"agent.register","id":"r2","timestamp":current_timestamp(),
            "payload":{"agent_id":"agent-y","hostname":"h","ip_address":"10.0.0.71",
            "port":8080,"auth_token":"tok",
            "metadata":{"tmux_version":"3.3","os_version":"Linux","nession_version":"0.1"},
            "protocol_version":"1.0"}
        })
        .to_string(),
    )
    .await
    .unwrap();
    let _ = recv_text(&mut agent2).await;
    send_text(
        &mut agent2,
        serde_json::json!({
            "msg_type":"agent.session.update","id":"sy","timestamp":current_timestamp(),
            "payload":{"agent_id":"agent-y","session_name":"sess-y","status":"detached",
            "window_count":2,"attached_clients":0}
        })
        .to_string(),
    )
    .await
    .unwrap();

    // Client lists sessions filtered by agent-x.
    let mut client = server.connect().await.unwrap();
    send_text(
        &mut client,
        serde_json::json!({
            "msg_type":"client.auth","id":"auth-filt","timestamp":current_timestamp(),
            "payload":{"auth_token":"tok"}
        })
        .to_string(),
    )
    .await
    .unwrap();
    let _ = recv_text(&mut client).await;

    send_text(
        &mut client,
        serde_json::json!({
            "msg_type":"client.sessions.list","id":"filt-req","timestamp":current_timestamp(),
            "payload":{"agent_id":"agent-x"}
        })
        .to_string(),
    )
    .await
    .unwrap();

    // The broadcast channel (capacity 16) may still hold stale
    // `sessions.changed` messages from the agent register path.
    // Skip those so we consume the actual `client.sessions.list.response`.
    let list_resp = loop {
        let raw = recv_text(&mut client).await;
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        if v["msg_type"].as_str() == Some("client.sessions.list.response") {
            break v;
        }
    };
    let sessions = list_resp["payload"]["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["agent_id"], "agent-x");
}

// ---------------------------------------------------------------------------
// 12. Client session attach
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_client_session_attach_requires_auth() {
    let server = TestServer::start("tok").await.unwrap();
    let mut ws = server.connect().await.unwrap();

    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type":"client.session.attach","id":"att1","timestamp":current_timestamp(),
            "payload":{"session_id":"a:sess","preferred_mode":"p2p"}
        })
        .to_string(),
    )
    .await
    .unwrap();

    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert_eq!(resp["payload"]["message"], "Not authenticated");
}

#[tokio::test]
async fn test_client_session_attach_invalid_format() {
    let server = TestServer::start("tok").await.unwrap();
    let mut ws = server.connect().await.unwrap();

    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type":"client.auth","id":"auth","timestamp":current_timestamp(),
            "payload":{"auth_token":"tok"}
        })
        .to_string(),
    )
    .await
    .unwrap();
    let _ = recv_text(&mut ws).await;

    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type":"client.session.attach","id":"att-bad","timestamp":current_timestamp(),
            "payload":{"session_id":"bad_format_no_colon"}
        })
        .to_string(),
    )
    .await
    .unwrap();

    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert!(resp["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("Invalid session_id"));
}

#[tokio::test]
async fn test_client_session_attach_session_not_found() {
    let server = TestServer::start("tok").await.unwrap();
    let mut ws = server.connect().await.unwrap();

    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type":"client.auth","id":"auth","timestamp":current_timestamp(),
            "payload":{"auth_token":"tok"}
        })
        .to_string(),
    )
    .await
    .unwrap();
    let _ = recv_text(&mut ws).await;

    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type":"client.session.attach","id":"att-nf","timestamp":current_timestamp(),
            "payload":{"session_id":"ghost:nonexistent","preferred_mode":"p2p"}
        })
        .to_string(),
    )
    .await
    .unwrap();

    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert!(resp["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("not found"));
}

#[tokio::test]
async fn test_client_session_attach_p2p_mode() {
    let server = TestServer::start("tok").await.unwrap();

    // Register agent with a connect_url.
    let mut agent_ws = server.connect().await.unwrap();
    send_text(
        &mut agent_ws,
        serde_json::json!({
            "msg_type":"agent.register","id":"r","timestamp":current_timestamp(),
            "payload":{"agent_id":"p2p-agent","hostname":"h","ip_address":"10.0.0.80",
            "port":9090,"auth_token":"tok",
            "connect_url":"ws://agent.example.com/ws",
            "metadata":{"tmux_version":"3.3","os_version":"Linux","nession_version":"0.1"},
            "protocol_version":"1.0"}
        })
        .to_string(),
    )
    .await
    .unwrap();
    let _ = recv_text(&mut agent_ws).await;

    // Push session.
    send_text(
        &mut agent_ws,
        serde_json::json!({
            "msg_type":"agent.session.update","id":"su","timestamp":current_timestamp(),
            "payload":{"agent_id":"p2p-agent","session_name":"p2p-sess","status":"active",
            "window_count":1,"attached_clients":0}
        })
        .to_string(),
    )
    .await
    .unwrap();

    // Client attaches.
    let mut client = server.connect().await.unwrap();
    send_text(
        &mut client,
        serde_json::json!({
            "msg_type":"client.auth","id":"auth","timestamp":current_timestamp(),
            "payload":{"auth_token":"tok"}
        })
        .to_string(),
    )
    .await
    .unwrap();
    let _ = recv_text(&mut client).await;

    send_text(
        &mut client,
        serde_json::json!({
            "msg_type":"client.session.attach","id":"att-p2p","timestamp":current_timestamp(),
            "payload":{"session_id":"p2p-agent:p2p-sess","preferred_mode":"p2p"}
        })
        .to_string(),
    )
    .await
    .unwrap();

    // Skip any broadcast messages that arrive before the attach response.
    let attach_resp = loop {
        let raw = recv_text(&mut client).await;
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        if v["msg_type"].as_str() == Some("client.session.attach.response") {
            break v;
        }
    };
    assert_eq!(attach_resp["payload"]["status"], "success");
    assert_eq!(attach_resp["payload"]["mode"], "p2p");
    assert_eq!(
        attach_resp["payload"]["agent_address"],
        "ws://agent.example.com/ws"
    );
    assert!(attach_resp["payload"]["connection_token"]
        .as_str()
        .is_some());
}

// ---------------------------------------------------------------------------
// 13. Session create / kill via handler
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_client_session_create_requires_auth() {
    let server = TestServer::start("tok").await.unwrap();
    let mut ws = server.connect().await.unwrap();

    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type":"client.session.create","id":"c1","timestamp":current_timestamp(),
            "payload":{"agent_id":"a","name":"s"}
        })
        .to_string(),
    )
    .await
    .unwrap();

    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert_eq!(resp["payload"]["error"], "Not authenticated");
}

#[tokio::test]
async fn test_client_session_create_missing_fields() {
    let server = TestServer::start("tok").await.unwrap();
    let mut ws = server.connect().await.unwrap();

    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type":"client.auth","id":"auth","timestamp":current_timestamp(),
            "payload":{"auth_token":"tok"}
        })
        .to_string(),
    )
    .await
    .unwrap();
    let _ = recv_text(&mut ws).await;

    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type":"client.session.create","id":"c-empty","timestamp":current_timestamp(),
            "payload":{"agent_id":"","name":""}
        })
        .to_string(),
    )
    .await
    .unwrap();

    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert!(!resp["payload"]["success"].as_bool().unwrap());
}

#[tokio::test]
async fn test_client_session_kill_requires_auth() {
    let server = TestServer::start("tok").await.unwrap();
    let mut ws = server.connect().await.unwrap();

    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type":"client.session.kill","id":"k1","timestamp":current_timestamp(),
            "payload":{"session_id":"a:s"}
        })
        .to_string(),
    )
    .await
    .unwrap();

    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert_eq!(resp["payload"]["error"], "Not authenticated");
}

#[tokio::test]
async fn test_client_session_kill_invalid_format() {
    let server = TestServer::start("tok").await.unwrap();
    let mut ws = server.connect().await.unwrap();

    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type":"client.auth","id":"auth","timestamp":current_timestamp(),
            "payload":{"auth_token":"tok"}
        })
        .to_string(),
    )
    .await
    .unwrap();
    let _ = recv_text(&mut ws).await;

    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type":"client.session.kill","id":"k-bad","timestamp":current_timestamp(),
            "payload":{"session_id":"badformat"}
        })
        .to_string(),
    )
    .await
    .unwrap();

    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert!(resp["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("Invalid session_id"));
}

#[tokio::test]
async fn test_client_session_kill_agent_not_found() {
    let server = TestServer::start("tok").await.unwrap();
    let mut ws = server.connect().await.unwrap();

    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type":"client.auth","id":"auth","timestamp":current_timestamp(),
            "payload":{"auth_token":"tok"}
        })
        .to_string(),
    )
    .await
    .unwrap();
    let _ = recv_text(&mut ws).await;

    send_text(
        &mut ws,
        serde_json::json!({
            "msg_type":"client.session.kill","id":"k-ghost","timestamp":current_timestamp(),
            "payload":{"session_id":"ghost:session"}
        })
        .to_string(),
    )
    .await
    .unwrap();

    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert!(resp["payload"]["error"]
        .as_str()
        .unwrap()
        .contains("not found"));
}

// ---------------------------------------------------------------------------
// 14. No-auth mode (empty server token)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_no_auth_mode_accepts_any_agent() {
    let server = TestServer::start("").await.unwrap(); // empty token = no-auth mode

    let mut ws = server.connect().await.unwrap();
    let reg = serde_json::json!({
        "msg_type": "agent.register",
        "id": "reg-noauth",
        "timestamp": current_timestamp(),
        "payload": {
            "agent_id": "noauth-agent",
            "hostname": "any",
            "ip_address": "10.0.0.1",
            "port": 8080,
            "auth_token": "anything_works",
            "metadata": {
                "tmux_version": "3.3", "os_version": "Linux", "nession_version": "0.1"
            },
            "protocol_version": "1.0"
        }
    });
    send_text(&mut ws, reg.to_string()).await.unwrap();
    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert_eq!(resp["payload"]["status"], "accepted");
}

#[tokio::test]
async fn test_no_auth_mode_accepts_any_client() {
    let server = TestServer::start("").await.unwrap();
    let mut ws = server.connect().await.unwrap();

    let auth = serde_json::json!({
        "msg_type": "client.auth",
        "id": "auth-noauth",
        "timestamp": current_timestamp(),
        "payload": { "auth_token": "random" }
    });
    send_text(&mut ws, auth.to_string()).await.unwrap();
    let resp: serde_json::Value = serde_json::from_str(&recv_text(&mut ws).await).unwrap();
    assert_eq!(resp["payload"]["status"], "success");
}
