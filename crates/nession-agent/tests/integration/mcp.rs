// Integration-test target: `clippy.toml` allows `unwrap`/`expect` and slice
// indexing in tests, but clippy does not recognise a separate integration
// test binary as "tests" for the `*-in-tests` configuration. Restate the same
// policy for this file instead of contorting every helper to return Result.
#![allow(clippy::expect_used, clippy::indexing_slicing)]

//! Integration tests for the Agent-hosted MCP endpoint (`#565`).
//!
//! These start a real `AgentServer`, mount MCP on its P2P listener, and drive
//! both tool families over HTTP. Node tools use the Agent's real tmux service;
//! cluster tools answer with a structured "standalone" error because this
//! fixture has no Server, which is exactly SC-07's local-tools-still-work case.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use nession_agent::config::{AgentConfig, AttachMode};
use nession_agent::p2p_credentials::P2pCredentials;
use nession_agent::server::websocket::{AgentServer, AgentServerContext};
use nession_agent::session::metadata::SessionMetadataStore;
use nession_agent::tmux::manager::SessionManager;
use nession_common::config::McpConfig;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::{unique_session_name, TEST_AGENT_ID};

const TOKEN: &str = "agent-mcp-token";

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

    fn json(&self) -> Value {
        serde_json::from_str(&self.body).expect("a JSON body")
    }
}

async fn start_agent_with_mcp() -> (SocketAddr, nession_agent::server::ServerHandle) {
    let tmp = Box::leak(Box::new(tempfile::tempdir().expect("tempdir")));
    let (resize, _resize_updates) = nession_agent::server::ResizeReporter::new();
    let tmux = Arc::new(SessionManager::new());
    let mut server = AgentServer::new(
        "127.0.0.1:0",
        TEST_AGENT_ID,
        None,
        tmp.path().to_string_lossy().into_owned(),
        tmp.path().to_string_lossy().as_ref(),
        AttachMode::Plain,
        AgentServerContext {
            resize,
            credentials: Arc::new(P2pCredentials::new()),
            mutations: nession_agent::execution::mutation_scheduler(),
            tmux: Arc::clone(&tmux),
            session_metadata: Arc::new(SessionMetadataStore::with_root(
                Arc::clone(&tmux),
                tmp.path().join("sessions"),
            )),
            terminal_cols: nession_common::config::DEFAULT_TERMINAL_COLS,
            handshake_policy: Default::default(),
        },
    )
    .expect("agent server");

    let config = AgentConfig {
        // Empty: this fixture is a standalone Agent. Cluster tools must
        // report that rather than silently reaching a host that is not there.
        server_url: String::new(),
        auth_token: String::new(),
        agent_token: TOKEN.to_string(),
        mcp: McpConfig {
            enabled: true,
            ..Default::default()
        },
        ..Default::default()
    };
    server.mount_mcp(&config).expect("mount MCP");
    let (handle, addr) = server.start().await.expect("start");
    tokio::time::sleep(Duration::from_millis(50)).await;
    (addr, handle)
}

async fn send(
    addr: SocketAddr,
    method: &str,
    token: Option<&str>,
    session: Option<&str>,
    body: &str,
) -> Option<HttpResponse> {
    let mut stream = TcpStream::connect(addr).await.ok()?;
    let mut head = format!(
        "{method} /mcp HTTP/1.1\r\nHost: test\r\nContent-Length: {}\r\nConnection: close\r\n",
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
                .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
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
    let response = send(addr, "POST", Some(TOKEN), None, &body)
        .await
        .expect("initialize response");
    assert_eq!(response.status, 200, "{}", response.body);
    response
        .header("Mcp-Session-Id")
        .expect("session")
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
    let response = send(addr, "POST", Some(TOKEN), Some(session), &body)
        .await
        .expect("tool response");
    assert_eq!(response.status, 200, "{}", response.body);
    response.json()["result"].clone()
}

fn text_of(result: &Value) -> Value {
    let text = result["content"][0]["text"].as_str().expect("text content");
    serde_json::from_str(text).expect("tool text is JSON")
}

#[tokio::test]
async fn agent_mcp_serves_local_tools_and_reports_a_missing_server() {
    let (addr, handle) = start_agent_with_mcp().await;
    let name = unique_session_name("mcp");

    let session = initialize(addr).await;

    let created = call_tool(
        addr,
        &session,
        "nession_agent_create_session",
        json!({ "agent_id": TEST_AGENT_ID, "name": name }),
    )
    .await;
    assert_eq!(created["isError"], false, "{created}");
    assert_eq!(text_of(&created)["name"], name);

    let listed = call_tool(
        addr,
        &session,
        "nession_agent_list_sessions",
        json!({ "agent_id": TEST_AGENT_ID }),
    )
    .await;
    assert_eq!(listed["isError"], false, "{listed}");
    let listed = text_of(&listed);
    assert!(
        listed["sessions"]
            .as_array()
            .expect("sessions")
            .iter()
            .any(|entry| entry["name"] == name),
        "the real tmux Session is missing from Agent truth: {listed}"
    );

    // A different Agent must be refused, never silently redirected to this one.
    let wrong_target = call_tool(
        addr,
        &session,
        "nession_agent_list_sessions",
        json!({ "agent_id": "some-other-agent" }),
    )
    .await;
    assert_eq!(wrong_target["isError"], true);

    // Cluster tools remain listed but report the missing Server explicitly.
    let cluster = call_tool(addr, &session, "nession_server_get_info", json!({})).await;
    assert_eq!(cluster["isError"], true, "{cluster}");
    let text = cluster["content"][0]["text"]
        .as_str()
        .expect("text content");
    assert!(text.contains("standalone"), "{text}");

    let killed = call_tool(
        addr,
        &session,
        "nession_agent_kill_session",
        json!({ "agent_id": TEST_AGENT_ID, "name": name }),
    )
    .await;
    assert_eq!(killed["isError"], false, "{killed}");
    assert_eq!(text_of(&killed)["name"], name);

    let _ = handle.shutdown().await;
}

#[tokio::test]
async fn agent_mcp_refuses_an_anonymous_request() {
    let (addr, handle) = start_agent_with_mcp().await;
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }).to_string();
    let response = send(addr, "POST", None, None, &body)
        .await
        .expect("HTTP answer");
    assert_eq!(response.status, 401);
    let _ = handle.shutdown().await;
}
