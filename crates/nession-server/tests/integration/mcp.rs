// Integration-test target: `clippy.toml` allows `unwrap`/`expect` and slice
// indexing in tests, but clippy does not recognise a separate integration
// test binary as "tests" for the `*-in-tests` configuration. Restate the same
// policy for this file instead of contorting every helper to return Result.
#![allow(clippy::expect_used, clippy::indexing_slicing)]

//! Integration tests for the Server-hosted MCP endpoint (`#565`).
//!
//! These exercise the real listener, real auth and the real route table. The
//! HTTP client is hand-rolled on a TCP socket because the property under test
//! is the transport contract itself: one request head, `Connection: close`,
//! bearer auth and JSON responses.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use nession_common::config::{McpConfig, ServerConfig};
use nession_server::db::Database;
use nession_server::server::WebSocketServer;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;

const TOKEN: &str = "server-test-token";

struct HttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl HttpResponse {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn decoded_body(&self) -> String {
        let chunked = self
            .header("transfer-encoding")
            .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"));
        if !chunked {
            return self.body.clone();
        }
        let mut decoded = String::new();
        let mut rest = self.body.as_str();
        while let Some((size_line, tail)) = rest.split_once("\r\n") {
            let size = usize::from_str_radix(size_line.trim(), 16).unwrap_or(0);
            if size == 0 {
                break;
            }
            let Some(chunk) = tail.get(..size) else {
                break;
            };
            decoded.push_str(chunk);
            let Some(next) = tail.get(size + 2..) else {
                break;
            };
            rest = next;
        }
        decoded
    }

    fn json(&self) -> Value {
        let body = self.decoded_body();
        if let Ok(value) = serde_json::from_str::<Value>(&body) {
            return value;
        }
        for event in body.split("\n\n") {
            let mut data = String::new();
            for line in event.lines() {
                if let Some(rest) = line.strip_prefix("data:") {
                    if !data.is_empty() {
                        data.push('\n');
                    }
                    data.push_str(rest.trim_start());
                }
            }
            if let Ok(value) = serde_json::from_str::<Value>(&data) {
                return value;
            }
        }
        panic!("no JSON payload in response: {}", self.body)
    }
}

async fn start_server(mcp: McpConfig) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let config = ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        auth_token: "server-test-token".to_string(),
        heartbeat_interval_secs: 10,
        heartbeat_timeout_secs: 60,
        image_blob_dir: std::env::temp_dir()
            .join(format!("nession-test-images-{}", uuid::Uuid::new_v4()))
            .join("blobs")
            .to_string_lossy()
            .into_owned(),
        image_build_dir: std::env::temp_dir()
            .join(format!("nession-test-images-{}", uuid::Uuid::new_v4()))
            .join("build")
            .to_string_lossy()
            .into_owned(),
        db_path: String::new(),
        mcp,
        ..Default::default()
    };
    let db = Database::new(":memory:").await.expect("database");
    let mut server = WebSocketServer::new(config, Arc::new(db))
        .await
        .expect("server");
    let addr = server.local_addr().expect("address");
    let handle = tokio::spawn(async move {
        let _ = server
            .run(nession_common::readiness::Readiness::Unwatched)
            .await;
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    (addr, handle)
}

fn enabled_mcp() -> McpConfig {
    McpConfig {
        enabled: true,
        ..Default::default()
    }
}

async fn send(
    addr: SocketAddr,
    method: &str,
    path: &str,
    token: Option<&str>,
    session: Option<&str>,
    body: &str,
) -> Option<HttpResponse> {
    let mut stream = TcpStream::connect(addr).await.ok()?;
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: application/json, \
         text/event-stream\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
         Connection: close\r\n",
        body.len()
    );
    if let Some(token) = token {
        head.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    if let Some(session) = session {
        head.push_str(&format!("Mcp-Session-Id: {session}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await.ok()?;
    stream.write_all(body.as_bytes()).await.ok()?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.ok()?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text.split_once("\r\n\r\n")?;
    let mut lines = head.split("\r\n");
    let status = lines
        .next()?
        .split_whitespace()
        .nth(1)?
        .parse::<u16>()
        .ok()?;
    let headers = lines
        .filter_map(|line| {
            line.split_once(':')
                .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        })
        .collect();
    Some(HttpResponse {
        status,
        headers,
        body: body.to_string(),
    })
}

async fn initialize(addr: SocketAddr) -> String {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": { "name": "test", "version": "1" }
        }
    })
    .to_string();
    let response = send(addr, "POST", "/mcp", Some(TOKEN), None, &body)
        .await
        .expect("initialize response");
    assert_eq!(response.status, 200, "{}", response.body);
    response
        .header("Mcp-Session-Id")
        .expect("initialize assigns a session")
        .to_string()
}

async fn call_tool(addr: SocketAddr, session: &str, name: &str, arguments: Value) -> Value {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": { "name": name, "arguments": arguments }
    })
    .to_string();
    let response = send(addr, "POST", "/mcp", Some(TOKEN), Some(session), &body)
        .await
        .expect("tool response");
    assert_eq!(response.status, 200, "{}", response.body);
    response.json()["result"].clone()
}

fn text_of(result: &Value) -> Value {
    let text = result["content"][0]["text"].as_str().expect("text content");
    serde_json::from_str(text).expect("tool text is JSON")
}

async fn register_agent(
    addr: SocketAddr,
    agent_id: &str,
    ip: &str,
    port: u16,
) -> (
    futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
        WsMessage,
    >,
    futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
    >,
) {
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
        .await
        .expect("agent socket");
    let (mut sink, stream) = ws.split();
    let register = json!({
        "msg_type": "server.agent.register",
        "id": "register-1",
        "timestamp": 0,
        "payload": {
            "agent_id": agent_id,
            "hostname": "test-host",
            "ip_address": ip,
            "port": port,
            "auth_token": "server-test-token",
            "protocol_manifest": { "provider": "test-agent", "protocols": {} },
            "metadata": {
                "tmux_version": "3.3",
                "os_version": "Linux",
                "nession_version": "0.1.0"
            }
        }
    });
    sink.send(WsMessage::Text(register.to_string()))
        .await
        .expect("register");
    (sink, stream)
}

/// Answer one command from the Server's command broker.
async fn answer_command(
    sink: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
        WsMessage,
    >,
    frame: &WsMessage,
    payload: Value,
) {
    let Ok(text) = frame.to_text() else {
        return;
    };
    let Ok(parsed) = serde_json::from_str::<Value>(text) else {
        return;
    };
    let Some(request_id) = parsed["payload"]["request_id"].as_str() else {
        return;
    };
    let command = parsed["msg_type"].as_str().unwrap_or_default();
    let response = json!({
        "msg_type": "server.agent.command-response",
        "id": format!("response-{request_id}"),
        "timestamp": 0,
        "payload": {
            "request_id": request_id,
            "command": command,
            "success": true,
            "error": null,
            "session_name": payload.get("session_name").cloned().unwrap_or(Value::Null),
            "warnings": [],
            "sessions": payload.get("sessions").cloned().unwrap_or(json!([])),
            "stale_agents": [],
        }
    });
    let _ = sink.send(WsMessage::Text(response.to_string())).await;
}

#[tokio::test]
async fn mcp_disabled_registers_no_http_route() {
    let (addr, _server) = start_server(McpConfig::default()).await;
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }).to_string();
    let response = send(addr, "POST", "/mcp", Some(TOKEN), None, &body).await;
    // The listener is a WebSocket listener: without MCP the request reaches
    // tungstenite, which closes rather than answering JSON.
    assert!(
        response.is_none_or(|response| response.status != 200),
        "MCP disabled must not serve /mcp"
    );
}

#[tokio::test]
async fn embedded_mcp_authenticates_and_lists_the_shared_catalog() {
    let (addr, _server) = start_server(enabled_mcp()).await;

    let anonymous = send(
        addr,
        "POST",
        "/mcp",
        None,
        None,
        &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }).to_string(),
    )
    .await
    .expect("HTTP answer");
    assert_eq!(anonymous.status, 401);
    assert_eq!(anonymous.header("WWW-Authenticate"), Some("Bearer"));

    let session = initialize(addr).await;
    let body = json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" }).to_string();
    let response = send(addr, "POST", "/mcp", Some(TOKEN), Some(&session), &body)
        .await
        .expect("list response");
    assert_eq!(response.status, 200);
    let tools = response.json()["result"]["tools"]
        .as_array()
        .expect("tools")
        .clone();
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert_eq!(
        names,
        vec![
            "nession_server_list_agents",
            "nession_agent_list_sessions",
            "nession_agent_create_session",
            "nession_agent_kill_session",
        ]
    );
    for removed in [
        "nession_server_list_sessions",
        "nession_server_get_info",
        "nession_server_capture_session_preview",
        "nession_server_get_session_attach_info",
        "nession_server_create_session",
        "nession_server_kill_session",
        "nession_server_rename_agent",
        "nession_server_delete_agent",
    ] {
        assert!(
            !names.contains(&removed),
            "removed Tool {removed} is still advertised"
        );
    }
}

#[tokio::test]
async fn embedded_mcp_does_not_displace_the_websocket_connection() {
    let (addr, _server) = start_server(enabled_mcp()).await;
    let session = initialize(addr).await;

    // A Web client's handshake and management calls still use the same
    // listener with MCP enabled.
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
        .await
        .expect("websocket");
    let (mut sink, mut stream) = ws.split();
    sink.send(WsMessage::Text(
        json!({
            "msg_type": "server.auth",
            "id": "auth-1",
            "timestamp": 0,
            "payload": { "auth_token": TOKEN, "client_id": "mcp-coexist" }
        })
        .to_string(),
    ))
    .await
    .expect("auth frame");
    let reply = stream.next().await.expect("auth reply").expect("frame");
    let reply: Value = serde_json::from_str(reply.to_text().expect("text")).expect("json");
    assert_eq!(reply["payload"]["status"], "success");

    sink.send(WsMessage::Text(
        json!({
            "msg_type": "server.agent.list",
            "id": "agents-1",
            "timestamp": 0,
            "payload": {}
        })
        .to_string(),
    ))
    .await
    .expect("agent list frame");
    let reply = stream
        .next()
        .await
        .expect("agent list reply")
        .expect("frame");
    let reply: Value = serde_json::from_str(reply.to_text().expect("text")).expect("json");
    assert_eq!(reply["payload"]["agents"], json!([]));

    // The MCP endpoint is still serving on the same listener.
    let agents = call_tool(addr, &session, "nession_server_list_agents", json!({})).await;
    assert_eq!(agents["isError"], false, "{agents}");
}

#[tokio::test]
async fn embedded_mcp_answers_server_owned_discovery_from_the_registry() {
    let (addr, _server) = start_server(enabled_mcp()).await;
    let session = initialize(addr).await;

    let agents = call_tool(addr, &session, "nession_server_list_agents", json!({})).await;
    assert_eq!(agents["isError"], false);
    assert_eq!(text_of(&agents)["agents"], json!([]));
}

#[tokio::test]
async fn embedded_mcp_node_tools_route_to_the_named_agent() {
    let (addr, _server) = start_server(enabled_mcp()).await;
    let (mut agent_sink, mut agent_stream) =
        register_agent(addr, "agent-1", "127.0.0.1", 19999).await;
    // The register acknowledgement.
    let _ = agent_stream.next().await;

    let server_task = tokio::spawn(async move {
        while let Some(Ok(frame)) = agent_stream.next().await {
            let Ok(text) = frame.to_text() else { continue };
            let Ok(parsed) = serde_json::from_str::<Value>(text) else {
                continue;
            };
            match parsed["msg_type"].as_str() {
                Some("agent.session.list") => {
                    answer_command(
                        &mut agent_sink,
                        &frame,
                        json!({ "sessions": [{
                            "name": "work",
                            "created_at": 1,
                            "window_count": 1,
                            "attached_clients": 0,
                            "width": 96,
                            "height": 24
                        }] }),
                    )
                    .await;
                }
                Some("agent.session.create") => {
                    let name = parsed["payload"]["name"].as_str().unwrap_or("work");
                    answer_command(&mut agent_sink, &frame, json!({ "session_name": name })).await;
                }
                Some("agent.session.kill") => {
                    answer_command(&mut agent_sink, &frame, json!({})).await;
                }
                _ => {}
            }
        }
    });

    let session = initialize(addr).await;
    let listed = call_tool(
        addr,
        &session,
        "nession_agent_list_sessions",
        json!({ "agent_id": "agent-1" }),
    )
    .await;
    assert_eq!(listed["isError"], false, "{listed}");
    let listed = text_of(&listed);
    assert_eq!(listed["sessions"][0]["name"], "work");

    // A different Agent is refused rather than redirected.
    let refused = call_tool(
        addr,
        &session,
        "nession_agent_list_sessions",
        json!({ "agent_id": "agent-2" }),
    )
    .await;
    assert_eq!(refused["isError"], true);

    let created = call_tool(
        addr,
        &session,
        "nession_agent_create_session",
        json!({ "agent_id": "agent-1", "name": "work" }),
    )
    .await;
    assert_eq!(created["isError"], false, "{created}");

    let killed = call_tool(
        addr,
        &session,
        "nession_agent_kill_session",
        json!({ "agent_id": "agent-1", "name": "work" }),
    )
    .await;
    assert_eq!(killed["isError"], false, "{killed}");

    server_task.abort();
}

#[tokio::test]
async fn embedded_mcp_refuses_an_unknown_session() {
    let (addr, _server) = start_server(enabled_mcp()).await;
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }).to_string();
    let response = send(addr, "POST", "/mcp", Some(TOKEN), Some("unknown"), &body)
        .await
        .expect("HTTP answer");
    assert_eq!(response.status, 404);
}

#[tokio::test]
async fn embedded_mcp_terminates_a_session_and_then_refuses_it() {
    let (addr, _server) = start_server(enabled_mcp()).await;
    let session = initialize(addr).await;
    let deleted = send(addr, "DELETE", "/mcp", Some(TOKEN), Some(&session), "")
        .await
        .expect("delete response");
    assert!(deleted.status < 300, "DELETE returned {}", deleted.status);

    let body = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }).to_string();
    let reused = send(addr, "POST", "/mcp", Some(TOKEN), Some(&session), &body)
        .await
        .expect("HTTP answer");
    assert_eq!(reused.status, 404);
}
