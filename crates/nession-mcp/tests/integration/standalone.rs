// Integration-test target: `clippy.toml` allows `unwrap`/`expect` and slice
// indexing in tests, but clippy does not recognise a separate integration
// test binary as "tests" for the `*-in-tests` configuration. Restate the same
// policy for this file instead of contorting every helper to return Result.
#![allow(clippy::expect_used, clippy::indexing_slicing)]

//! End-to-end standalone host (`#3264` SC-01/SC-04/SC-07).
//!
//! The real `nession-mcp` binary is started against a real Nession Server and
//! a real Agent. The Server route is observed through a broker participant
//! that registers like an Agent, while the direct-Agent mode is exercised
//! against the Agent's real tmux Sessions.

use std::net::SocketAddr;
use std::path::Path;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use nession_agent::config::{AgentConfig, AttachMode};
use nession_agent::p2p_auth::P2pAuth;
use nession_agent::server::websocket::{AgentServer, AgentServerContext};
use nession_agent::session::metadata::SessionMetadataStore;
use nession_agent::tmux::manager::SessionManager;
use nession_common::config::{McpConfig, ServerConfig};
use nession_server::db::Database;
use nession_server::server::WebSocketServer;
use rand::Rng;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;

const MCP_TOKEN: &str = "mcp-inbound-token";
const SERVER_TOKEN: &str = "server-token";
const AGENT_TOKEN: &str = "agent-token";
const AGENT_ID: &str = "standalone-agent";
const CLUSTER_AGENT: &str = "cluster-agent";

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

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
        Value::Null
    }
}

async fn start_server_with_mcp(mcp_enabled: bool) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let config = ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        auth_token: SERVER_TOKEN.to_string(),
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
        mcp: McpConfig {
            enabled: mcp_enabled,
            ..Default::default()
        },
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

async fn start_agent(
    agent_token: &str,
    mcp_enabled: bool,
) -> (SocketAddr, nession_agent::server::ServerHandle) {
    let tmp = Box::leak(Box::new(tempfile::tempdir().expect("tempdir")));
    let (resize, _resize_updates) = nession_agent::server::ResizeReporter::new();
    let tmux = Arc::new(SessionManager::new());
    let mut server = AgentServer::new(
        "127.0.0.1:0",
        AGENT_ID,
        None,
        tmp.path().to_string_lossy().into_owned(),
        tmp.path().to_string_lossy().as_ref(),
        AttachMode::Plain,
        AgentServerContext {
            resize,
            auth: Arc::new(P2pAuth::new(agent_token)),
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
    if mcp_enabled {
        let config = AgentConfig {
            server_url: String::new(),
            auth_token: String::new(),
            agent_token: agent_token.to_string(),
            mcp: McpConfig {
                enabled: true,
                ..Default::default()
            },
            ..Default::default()
        };
        server.mount_mcp(&config, agent_token).expect("mount MCP");
    }
    let (handle, addr) = server.start().await.expect("start agent");
    tokio::time::sleep(Duration::from_millis(50)).await;
    (addr, handle)
}

fn spawn_standalone(config_path: &Path) -> ChildGuard {
    // not-tmux: this starts the standalone MCP host, which owns no tmux
    // server or Session and spawns no tmux process.
    let child = Command::new(env!("CARGO_BIN_EXE_nession-mcp"))
        .arg("--config")
        .arg(config_path)
        .env("RUST_LOG", "warn")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn nession-mcp");
    ChildGuard(child)
}

/// Read the bound address the standalone binary prints after it binds.
async fn await_listen_addr(child: &mut Child) -> SocketAddr {
    let stdout = child.stdout.take().expect("piped stdout");
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if let Some(addr) = line.strip_prefix("nession-mcp listening on ") {
                        let _ = sender.send(Some(addr.trim().to_string()));
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = sender.send(None);
    });
    let read = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::task::spawn_blocking(move || receiver.recv()),
    )
    .await
    .expect("the standalone listener did not announce itself")
    .expect("the stdout reader panicked");
    read.expect("the stdout reader ended without a result")
        .expect("the standalone listener printed no address")
        .parse()
        .expect("the announced address is a SocketAddr")
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
        "{method} /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: application/json, \
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
    let _ = stream.read_to_end(&mut raw).await;
    if raw.is_empty() {
        return None;
    }
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

async fn initialize_with(addr: SocketAddr, token: &str) -> String {
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
    let response = send(addr, "POST", Some(token), None, &body)
        .await
        .expect("initialize response");
    assert_eq!(response.status, 200, "{}", response.body);
    response
        .header("Mcp-Session-Id")
        .expect("session")
        .to_string()
}

async fn call_tool(
    addr: SocketAddr,
    token: &str,
    session: &str,
    name: &str,
    arguments: Value,
) -> Value {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": { "name": name, "arguments": arguments }
    })
    .to_string();
    let response = send(addr, "POST", Some(token), Some(session), &body)
        .await
        .expect("tool response");
    assert_eq!(response.status, 200, "{}", response.body);
    response.json()["result"].clone()
}

async fn tools_of(addr: SocketAddr, token: &str) -> Value {
    let session = initialize_with(addr, token).await;
    let body = json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" }).to_string();
    let response = send(addr, "POST", Some(token), Some(&session), &body)
        .await
        .expect("tools/list response");
    assert_eq!(response.status, 200, "{}", response.body);
    response.json()["result"]["tools"].clone()
}

fn text_of(result: &Value) -> Value {
    let text = result["content"][0]["text"].as_str().expect("text content");
    serde_json::from_str(text).expect("tool text is JSON")
}

#[derive(Default)]
struct BrokerLog {
    commands: Mutex<Vec<String>>,
    sessions: Mutex<Vec<String>>,
}

impl BrokerLog {
    fn commands(&self) -> Vec<String> {
        self.commands.lock().expect("broker log").clone()
    }
}

/// Register a participant that answers like an Agent and records the commands
/// the Server routes to it.
async fn register_and_answer(addr: SocketAddr) -> (tokio::task::JoinHandle<()>, Arc<BrokerLog>) {
    let log = Arc::new(BrokerLog::default());
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
        .await
        .expect("mock agent socket");
    let (mut sink, mut stream) = ws.split();
    let register = json!({
        "msg_type": "server.agent.register",
        "id": "register-1",
        "timestamp": 0,
        "payload": {
            "agent_id": CLUSTER_AGENT,
            "hostname": "mock",
            "ip_address": "127.0.0.1",
            "port": 19999,
            "auth_token": SERVER_TOKEN,
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
    let task_log = Arc::clone(&log);
    let task = tokio::spawn(async move {
        while let Some(Ok(frame)) = stream.next().await {
            let Ok(text) = frame.to_text() else { continue };
            let Ok(parsed) = serde_json::from_str::<Value>(text) else {
                continue;
            };
            let Some(request_id) = parsed["payload"]["request_id"].as_str() else {
                continue;
            };
            let command = parsed["msg_type"].as_str().unwrap_or_default().to_string();
            task_log
                .commands
                .lock()
                .expect("broker log")
                .push(command.clone());
            let session_name = parsed["payload"]["name"].as_str().unwrap_or("work");
            let reported: Vec<Value> = {
                let mut sessions = task_log.sessions.lock().expect("broker sessions");
                match command.as_str() {
                    "agent.session.create" => sessions.push(session_name.to_string()),
                    "agent.session.kill" => sessions.retain(|name| name != session_name),
                    _ => {}
                }
                sessions
                    .iter()
                    .map(|name| json!({ "name": name }))
                    .collect()
            };
            let response = json!({
                "msg_type": "server.agent.command-response",
                "id": format!("response-{request_id}"),
                "timestamp": 0,
                "payload": {
                    "request_id": request_id,
                    "command": command,
                    "success": true,
                    "error": null,
                    "session_name": session_name,
                    "sessions": reported,
                    "warnings": []
                }
            });
            let _ = sink.send(WsMessage::Text(response.to_string())).await;
        }
    });
    (task, log)
}

fn unique_name(prefix: &str) -> String {
    let suffix: u32 = rand::thread_rng().gen();
    format!("nession-test-mcp-{prefix}-{suffix}")
}

fn write_routed_config(dir: &Path, server_addr: SocketAddr) -> std::path::PathBuf {
    let config_path = dir.join("mcp.toml");
    std::fs::write(
        &config_path,
        format!(
            "[mcp]\n\
             listen_address = \"127.0.0.1:0\"\n\
             auth_token = \"{MCP_TOKEN}\"\n\
             \n\
             [backend.server]\n\
             endpoint = \"ws://{server_addr}\"\n\
             auth_token = \"{SERVER_TOKEN}\"\n"
        ),
    )
    .expect("write config");
    config_path
}

fn write_direct_config(
    dir: &Path,
    server_addr: SocketAddr,
    agent_addr: SocketAddr,
) -> std::path::PathBuf {
    let config_path = dir.join("mcp.toml");
    std::fs::write(
        &config_path,
        format!(
            "[mcp]\n\
             listen_address = \"127.0.0.1:0\"\n\
             auth_token = \"{MCP_TOKEN}\"\n\
             \n\
             [backend.server]\n\
             endpoint = \"ws://{server_addr}\"\n\
             auth_token = \"{SERVER_TOKEN}\"\n\
             \n\
             [backend.agent]\n\
             endpoint = \"ws://{agent_addr}\"\n\
             auth_token = \"{AGENT_TOKEN}\"\n\
             agent_id = \"{AGENT_ID}\"\n"
        ),
    )
    .expect("write config");
    config_path
}

/// Send `SIGTERM` and require the program to exit on its own.
async fn terminate_and_wait(child: &mut Child) {
    let status = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .expect("signal the process");
    assert!(status.success(), "kill -TERM failed");
    for _ in 0..100 {
        match child.try_wait() {
            Ok(Some(status)) => {
                assert!(status.success(), "nession-mcp exited with {status}");
                return;
            }
            Ok(None) => tokio::time::sleep(Duration::from_millis(50)).await,
            Err(error) => panic!("waiting for nession-mcp failed: {error}"),
        }
    }
    panic!("nession-mcp did not exit after SIGTERM");
}

#[tokio::test]
async fn standalone_routes_agent_session_tools_through_the_server() {
    let (server_addr, server_task) = start_server_with_mcp(false).await;
    let (mock_agent, broker) = register_and_answer(server_addr).await;

    let dir = tempfile::tempdir().expect("tempdir");
    let config_path = write_routed_config(dir.path(), server_addr);
    let mut child = spawn_standalone(&config_path);
    let mcp_addr = await_listen_addr(&mut child.0).await;

    let anonymous = send(
        mcp_addr,
        "POST",
        None,
        None,
        &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }).to_string(),
    )
    .await
    .expect("HTTP answer");
    assert_eq!(anonymous.status, 401);

    let session = initialize_with(mcp_addr, MCP_TOKEN).await;
    let tools = tools_of(mcp_addr, MCP_TOKEN).await;
    assert_eq!(tools.as_array().expect("tools").len(), 4);

    let agents = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_list_agents",
        json!({}),
    )
    .await;
    assert_eq!(agents["isError"], false, "{agents}");
    assert_eq!(text_of(&agents)["agents"][0]["agent_id"], CLUSTER_AGENT);

    // No [backend.agent] is configured: the Session operation must still reach
    // the named Agent, through the Server's canonical route.
    let name = unique_name("routed");
    let created = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_agent_create_session",
        json!({ "agent_id": CLUSTER_AGENT, "name": name }),
    )
    .await;
    assert_eq!(created["isError"], false, "{created}");

    let listed = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_agent_list_sessions",
        json!({ "agent_id": CLUSTER_AGENT }),
    )
    .await;
    assert_eq!(listed["isError"], false, "{listed}");
    assert!(
        text_of(&listed)["sessions"]
            .as_array()
            .expect("sessions")
            .iter()
            .any(|entry| entry["session_name"] == name),
        "the Server-routed Agent truth is missing the created Session: {listed}"
    );

    let killed = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_agent_kill_session",
        json!({ "agent_id": CLUSTER_AGENT, "name": name }),
    )
    .await;
    assert_eq!(killed["isError"], false, "{killed}");

    let commands = broker.commands();
    assert!(
        commands
            .iter()
            .any(|command| command == "agent.session.create"),
        "the Server route never asked the Agent to create: {commands:?}"
    );
    assert!(
        commands
            .iter()
            .any(|command| command == "agent.session.report"),
        "the Server route never asked the Agent for live Session state: {commands:?}"
    );
    assert!(
        commands
            .iter()
            .any(|command| command == "agent.session.kill"),
        "the Server route never asked the Agent to kill: {commands:?}"
    );

    let wrong = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_agent_list_sessions",
        json!({ "agent_id": "not-registered" }),
    )
    .await;
    assert_eq!(wrong["isError"], true, "{wrong}");

    terminate_and_wait(&mut child.0).await;
    mock_agent.abort();
    server_task.abort();
}

#[tokio::test]
async fn standalone_direct_agent_mode_uses_the_real_agent_tmux() {
    let (server_addr, server_task) = start_server_with_mcp(false).await;
    let (agent_addr, agent_handle) = start_agent(AGENT_TOKEN, false).await;
    let dir = tempfile::tempdir().expect("tempdir");
    let config_path = write_direct_config(dir.path(), server_addr, agent_addr);
    let mut child = spawn_standalone(&config_path);
    let mcp_addr = await_listen_addr(&mut child.0).await;
    let session = initialize_with(mcp_addr, MCP_TOKEN).await;

    let name = unique_name("direct");
    let created = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_agent_create_session",
        json!({ "agent_id": AGENT_ID, "name": name }),
    )
    .await;
    assert_eq!(created["isError"], false, "{created}");

    let listed = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_agent_list_sessions",
        json!({ "agent_id": AGENT_ID }),
    )
    .await;
    assert_eq!(listed["isError"], false, "{listed}");
    assert!(
        text_of(&listed)["sessions"]
            .as_array()
            .expect("sessions")
            .iter()
            .any(|entry| entry["name"] == name),
        "the direct Agent's real tmux Session is missing"
    );

    let wrong = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_agent_list_sessions",
        json!({ "agent_id": "not-this-agent" }),
    )
    .await;
    assert_eq!(wrong["isError"], true);

    let killed = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_agent_kill_session",
        json!({ "agent_id": AGENT_ID, "name": name }),
    )
    .await;
    assert_eq!(killed["isError"], false, "{killed}");

    terminate_and_wait(&mut child.0).await;
    let _ = agent_handle.shutdown().await;
    server_task.abort();
}

/// SC-03: all three hosts serve one catalog, byte for byte.
#[tokio::test]
async fn all_three_hosts_share_one_tool_catalog() {
    let (server_addr, server_task) = start_server_with_mcp(true).await;
    let (agent_addr, agent_handle) = start_agent(AGENT_TOKEN, true).await;
    let dir = tempfile::tempdir().expect("tempdir");
    let config_path = write_routed_config(dir.path(), server_addr);
    let mut standalone = spawn_standalone(&config_path);
    let standalone_addr = await_listen_addr(&mut standalone.0).await;

    let server_tools = tools_of(server_addr, SERVER_TOKEN).await;
    let agent_tools = tools_of(agent_addr, AGENT_TOKEN).await;
    let standalone_tools = tools_of(standalone_addr, MCP_TOKEN).await;

    assert_eq!(server_tools.as_array().expect("tools").len(), 4);
    let names: Vec<_> = server_tools
        .as_array()
        .expect("tools")
        .iter()
        .map(|tool| tool["name"].as_str().expect("name"))
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
    assert_eq!(
        server_tools, agent_tools,
        "Agent embedded must serve the same catalog as the Server"
    );
    assert_eq!(
        server_tools, standalone_tools,
        "Standalone must serve the same catalog as the Server"
    );

    let _ = agent_handle.shutdown().await;
    server_task.abort();
}
