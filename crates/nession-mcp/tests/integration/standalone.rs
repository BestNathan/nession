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
use rmcp::model::{CallToolRequestParams, ProtocolVersion};
use rmcp::service::NotificationContext;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::{ClientHandler, ClientLifecycleMode, ClientServiceExt, RoleClient};
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
    start_server_with_heartbeat(mcp_enabled, 10, 60).await
}

async fn start_server_with_heartbeat(
    mcp_enabled: bool,
    heartbeat_interval_secs: u64,
    heartbeat_timeout_secs: u64,
) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let config = ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        auth_token: SERVER_TOKEN.to_string(),
        heartbeat_interval_secs,
        heartbeat_timeout_secs,
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
        server
            .mount_mcp(&config, agent_token, Vec::new())
            .expect("mount MCP");
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
    let answering_agent = CLUSTER_AGENT.to_string();
    let task = tokio::spawn(async move {
        let mut heartbeat = tokio::time::interval(Duration::from_millis(500));
        loop {
            tokio::select! {
                frame = stream.next() => {
            let Some(Ok(frame)) = frame else { break };
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
            let response = {
                // The mock Agent reports a real convergence status for binding
                // commands, and refuses a binding replacement for Sessions
                // whose name says "fail" so the Server's committed-desired /
                // failed-runtime split is exercised through MCP.
                let is_binding = command.starts_with("agent.session.env.binding.");
                let failing = session_name.contains("fail");
                let success = !(is_binding && command.ends_with(".set") && failing);
                let mut payload = json!({
                    "request_id": request_id,
                    "command": command,
                    "success": success,
                    "error": if success { Value::Null } else { json!("tmux refused the binding") },
                    "session_name": session_name,
                    "sessions": reported,
                    "warnings": []
                });
                if is_binding {
                    payload["observed"] = json!({
                        "applied_revision": if success { 1 } else { 0 },
                        "status": "pending_shell",
                        "profiles": [],
                        "managed_keys": ["BINDING_SECRET"],
                        "shell": "bash",
                        "shell_revision": 0
                    });
                    if failing {
                        payload["observed"]["status"] = json!("error");
                        payload["observed"]["last_error"] = json!("tmux refused the binding");
                    }
                }
                json!({
                    "msg_type": "server.agent.command-response",
                    "id": format!("response-{request_id}"),
                    "timestamp": 0,
                    "payload": payload
                })
            };
            if sink.send(WsMessage::Text(response.to_string())).await.is_err() {
                break;
            }
                }
                _ = heartbeat.tick() => {
                    let beat = json!({
                        "msg_type": "control.heartbeat",
                        "id": uuid::Uuid::new_v4().to_string(),
                        "timestamp": 0,
                        "payload": {
                            "agent_id": answering_agent,
                            "status": "online",
                            "session_count": 0,
                            "active_sessions": 0,
                            "metadata": { "uptime_seconds": 0, "load_average": [0.0, 0.0, 0.0] }
                        }
                    });
                    if sink.send(WsMessage::Text(beat.to_string())).await.is_err() {
                        break;
                    }
                }
            }
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
    assert_eq!(tools.as_array().expect("tools").len(), 11);

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
            .any(|entry| entry["name"] == name),
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

/// The three binding Tools replace/get/reapply one Session through the real
/// Server, keep the durable revision safe under a stale writer, and never put
/// ENV values in a result.
#[tokio::test]
async fn standalone_binds_a_session_with_revision_cas_and_no_value_leakage() {
    let (server_addr, server_task) = start_server_with_mcp(false).await;
    let (mock_agent, broker) = register_and_answer(server_addr).await;

    let dir = tempfile::tempdir().expect("tempdir");
    let config_path = write_routed_config(dir.path(), server_addr);
    let mut child = spawn_standalone(&config_path);
    let mcp_addr = await_listen_addr(&mut child.0).await;
    let session = initialize_with(mcp_addr, MCP_TOKEN).await;

    // The profile's content is a known secret. The binding Tools must never
    // surface it: they report identity, revision and status only.
    let written = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_env_write",
        json!({
            "name": "binding-profile.env",
            "content": "BINDING_SECRET=top-secret-value\n"
        }),
    )
    .await;
    assert_eq!(written["isError"], false, "{written}");

    let name = unique_name("binding");
    let created = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_agent_create_session",
        json!({ "agent_id": CLUSTER_AGENT, "name": name }),
    )
    .await;
    assert_eq!(created["isError"], false, "{created}");
    let session_id = format!("{CLUSTER_AGENT}:{name}");

    let initial = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_session_env_binding_get",
        json!({ "session_id": session_id }),
    )
    .await;
    assert_eq!(initial["isError"], false, "{initial}");
    let initial = text_of(&initial);
    assert_eq!(initial["binding"]["desired_revision"], 0);
    assert_eq!(
        initial["binding"]["desired_profiles"],
        json!([]),
        "a Session that never had a binding is empty, not guessed"
    );

    let applied = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_session_env_binding_set",
        json!({
            "session_id": session_id,
            "expected_revision": 0,
            "profiles": [{ "name": "binding-profile.env" }]
        }),
    )
    .await;
    assert_eq!(applied["isError"], false, "{applied}");
    let applied = text_of(&applied);
    assert_eq!(applied["binding"]["desired_revision"], 1);
    assert_eq!(
        applied["binding"]["desired_profiles"][0]["profile"]["name"],
        "binding-profile.env"
    );
    assert_eq!(applied["binding"]["desired_profiles"][0]["outdated"], false);
    assert_eq!(
        applied["binding"]["observed"]["status"], "pending_shell",
        "an Agent status is reported as-is, not collapsed into success"
    );

    let binding_dispatches = |commands: &[String]| {
        commands
            .iter()
            .filter(|command| command.as_str() == "agent.session.env.binding.set")
            .count()
    };
    let dispatches_before = binding_dispatches(&broker.commands());

    // A writer that read revision 0 loses the race. Nothing durable changes
    // and the Agent is not asked to materialize anything.
    let stale = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_session_env_binding_set",
        json!({
            "session_id": session_id,
            "expected_revision": 0,
            "profiles": []
        }),
    )
    .await;
    assert_eq!(stale["isError"], true, "{stale}");
    let stale = text_of(&stale);
    assert_eq!(stale["refusal"], "revision_conflict");
    assert!(
        stale["error"]
            .as_str()
            .is_some_and(|error| error.contains("revision_conflict")),
        "{stale}"
    );
    assert_eq!(
        binding_dispatches(&broker.commands()),
        dispatches_before,
        "a conflict must not dispatch an Agent mutation"
    );

    let refreshed = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_session_env_binding_get",
        json!({ "session_id": session_id }),
    )
    .await;
    let refreshed = text_of(&refreshed);
    assert_eq!(refreshed["binding"]["desired_revision"], 1);
    assert_eq!(
        refreshed["binding"]["desired_profiles"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        refreshed["binding"]["desired_profiles"][0]["outdated"],
        false
    );
    assert_eq!(
        refreshed["binding"]["observed"]["status"], "pending_shell",
        "the Agent's own status is reported, not guessed as in_sync"
    );
    assert_eq!(
        refreshed["binding"]["observed"]["managed_keys"],
        json!(["BINDING_SECRET"]),
        "managed key names are reported; values are not"
    );

    // A save changes the file, not the Session. The next read shows the
    // profile as outdated at the same materialized revision.
    let save = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_env_write",
        json!({
            "name": "binding-profile.env",
            "content": "BINDING_SECRET=replacement-value\n",
            "overwrite": true,
            "force": true
        }),
    )
    .await;
    assert_eq!(save["isError"], false, "{save}");
    let outdated = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_session_env_binding_get",
        json!({ "session_id": session_id }),
    )
    .await;
    let outdated = text_of(&outdated);
    assert_eq!(
        outdated["binding"]["desired_revision"], 1,
        "a save must not advance the Session binding"
    );
    assert_eq!(
        outdated["binding"]["desired_profiles"][0]["outdated"], true,
        "the edited profile is outdated until an explicit reapply"
    );

    let reapplied = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_session_env_binding_reapply",
        json!({ "session_id": session_id, "expected_revision": 1 }),
    )
    .await;
    assert_eq!(reapplied["isError"], false, "{reapplied}");
    let reapplied = text_of(&reapplied);
    assert_eq!(reapplied["binding"]["desired_revision"], 2);
    assert_eq!(
        reapplied["binding"]["desired_profiles"][0]["profile"]["name"], "binding-profile.env",
        "reapply must not change the selection"
    );
    assert_eq!(
        reapplied["binding"]["desired_profiles"][0]["outdated"], false,
        "reapply materializes the current content"
    );

    let cleared = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_session_env_binding_set",
        json!({
            "session_id": session_id,
            "expected_revision": 2,
            "profiles": []
        }),
    )
    .await;
    assert_eq!(cleared["isError"], false, "{cleared}");
    let cleared = text_of(&cleared);
    assert_eq!(cleared["binding"]["desired_revision"], 3);
    assert_eq!(cleared["binding"]["desired_profiles"], json!([]));

    // A reapply of a Session with no binding at revision 0 is a no-op, but a
    // version-aware caller that expected a later revision is told it lost.
    let missing = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_session_env_binding_reapply",
        json!({ "session_id": format!("{CLUSTER_AGENT}:absent"), "expected_revision": 5 }),
    )
    .await;
    assert_eq!(missing["isError"], true, "{missing}");
    assert_eq!(text_of(&missing)["refusal"], "revision_conflict");

    // A committed desired revision with a failed Agent materialization is
    // inspectable: the MCP result keeps the desired state, reports the failure,
    // and does not replay the mutation. The mock refuses binding replacements
    // for a Session whose name says "fail".
    let failing_name = unique_name("fail");
    let failing_created = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_agent_create_session",
        json!({ "agent_id": CLUSTER_AGENT, "name": failing_name }),
    )
    .await;
    assert_eq!(failing_created["isError"], false, "{failing_created}");
    let failing_id = format!("{CLUSTER_AGENT}:{failing_name}");
    let failed = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_session_env_binding_set",
        json!({
            "session_id": failing_id,
            "expected_revision": 0,
            "profiles": [{ "name": "binding-profile.env" }]
        }),
    )
    .await;
    assert_eq!(failed["isError"], true, "{failed}");
    let failed = text_of(&failed);
    assert_eq!(
        failed["binding"]["desired_revision"], 1,
        "desired intent is committed even when the Agent fails"
    );
    assert!(
        failed["error"]
            .as_str()
            .is_some_and(|error| error.contains("tmux refused")),
        "{failed}"
    );
    let failed_dispatches = broker
        .commands()
        .iter()
        .filter(|command| command.as_str() == "agent.session.env.binding.set")
        .count();
    let observed_failure = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_session_env_binding_get",
        json!({ "session_id": failing_id }),
    )
    .await;
    let observed_failure = text_of(&observed_failure);
    assert_eq!(observed_failure["binding"]["desired_revision"], 1);
    assert_eq!(
        observed_failure["binding"]["observed"]["status"], "error",
        "the failed runtime state is reported truthfully"
    );
    assert_eq!(
        broker
            .commands()
            .iter()
            .filter(|command| command.as_str() == "agent.session.env.binding.set")
            .count(),
        failed_dispatches,
        "an ambiguous/failed call must not be replayed automatically"
    );

    // No result carried the profile's raw content. Managed key *names* are
    // allowed; the value is not.
    for result in [&applied, &refreshed, &outdated, &reapplied, &cleared] {
        let text = serde_json::to_string(result).expect("serialize");
        for secret in ["top-secret-value", "replacement-value"] {
            assert!(
                !text.contains(secret),
                "binding results must never carry ENV values: {text}"
            );
        }
    }

    terminate_and_wait(&mut child.0).await;
    mock_agent.abort();
    server_task.abort();
}

/// ENV file CRUD through the real Server: create-only, explicit overwrite,
/// in-use guards, Agent scoping, traversal refusal, metadata-only listing,
/// and a save that does not advance the Session binding.
#[tokio::test]
async fn standalone_manages_env_files_with_canonical_guards() {
    let (server_addr, server_task) = start_server_with_mcp(false).await;
    let (mock_agent, broker) = register_and_answer(server_addr).await;

    let dir = tempfile::tempdir().expect("tempdir");
    let config_path = write_routed_config(dir.path(), server_addr);
    let mut child = spawn_standalone(&config_path);
    let mcp_addr = await_listen_addr(&mut child.0).await;

    // Authentication is the MCP endpoint's, and an ENV tool is no exception.
    let anonymous = send(
        mcp_addr,
        "POST",
        None,
        None,
        &json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "nession_server_env_list", "arguments": {} }
        })
        .to_string(),
    )
    .await
    .expect("HTTP answer");
    assert_eq!(anonymous.status, 401);

    let session = initialize_with(mcp_addr, MCP_TOKEN).await;

    let created = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_env_write",
        json!({
            "name": "guarded.env",
            "content": "GUARDED_SECRET=shh-secret-value\n"
        }),
    )
    .await;
    assert_eq!(created["isError"], false, "{created}");

    // Create-only by default: the second write is refused, and says why.
    let refused = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_env_write",
        json!({
            "name": "guarded.env",
            "content": "GUARDED_SECRET=replacement\n"
        }),
    )
    .await;
    assert_eq!(refused["isError"], true, "{refused}");
    assert_eq!(text_of(&refused)["exists"], true);

    // Listing is metadata: the file appears, its content does not.
    let listed = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_env_list",
        json!({}),
    )
    .await;
    assert_eq!(listed["isError"], false, "{listed}");
    let listed_text = serde_json::to_string(&listed).expect("serialize");
    assert!(
        !listed_text.contains("shh-secret-value"),
        "listing must not return ENV values: {listed_text}"
    );
    assert!(
        text_of(&listed)["files"]
            .as_array()
            .expect("files")
            .iter()
            .any(|file| file["name"] == "guarded.env"),
        "the created file is missing from the metadata listing: {listed}"
    );

    // Reading is the explicit operation that returns raw content.
    let read = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_env_get",
        json!({ "name": "guarded.env" }),
    )
    .await;
    assert_eq!(read["isError"], false, "{read}");
    assert_eq!(
        text_of(&read)["content"],
        "GUARDED_SECRET=shh-secret-value\n"
    );

    let name = unique_name("env-guard");
    let created_session = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_agent_create_session",
        json!({ "agent_id": CLUSTER_AGENT, "name": name }),
    )
    .await;
    assert_eq!(created_session["isError"], false, "{created_session}");
    let session_id = format!("{CLUSTER_AGENT}:{name}");

    let bound = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_session_env_binding_set",
        json!({
            "session_id": session_id,
            "expected_revision": 0,
            "profiles": [{ "name": "guarded.env" }]
        }),
    )
    .await;
    assert_eq!(bound["isError"], false, "{bound}");
    assert_eq!(text_of(&bound)["binding"]["desired_revision"], 1);

    // Bound to a live Session: an ordinary overwrite is refused.
    let in_use_write = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_env_write",
        json!({
            "name": "guarded.env",
            "content": "GUARDED_SECRET=replacement\n",
            "overwrite": true
        }),
    )
    .await;
    assert_eq!(in_use_write["isError"], true, "{in_use_write}");

    // The explicit force is the only bypass, and it still does not advance the
    // Session's materialized revision: a save is not a reapply.
    let forced_write = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_env_write",
        json!({
            "name": "guarded.env",
            "content": "GUARDED_SECRET=replacement\n",
            "overwrite": true,
            "force": true
        }),
    )
    .await;
    assert_eq!(forced_write["isError"], false, "{forced_write}");
    let after_save = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_session_env_binding_get",
        json!({ "session_id": session_id }),
    )
    .await;
    assert_eq!(
        text_of(&after_save)["binding"]["desired_revision"],
        1,
        "an ordinary save must not advance the Session binding"
    );

    // In-use deletion needs the same explicit force.
    let in_use_delete = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_env_delete",
        json!({ "name": "guarded.env" }),
    )
    .await;
    assert_eq!(in_use_delete["isError"], true, "{in_use_delete}");
    let deleted = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_env_delete",
        json!({ "name": "guarded.env", "force": true }),
    )
    .await;
    assert_eq!(deleted["isError"], false, "{deleted}");
    let gone = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_env_get",
        json!({ "name": "guarded.env" }),
    )
    .await;
    assert_eq!(gone["isError"], true, "{gone}");

    // A traversal-shaped name is refused by the Server's filename rules.
    let traversal = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_env_write",
        json!({ "name": "../escape.env", "content": "A=1\n" }),
    )
    .await;
    assert_eq!(traversal["isError"], true, "{traversal}");

    // Agent-scoped operations reach exactly the named Agent, through the
    // Server's canonical route.
    let agent_write = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_env_write",
        json!({
            "name": "node.env",
            "source": "agent",
            "agent_id": CLUSTER_AGENT,
            "content": "NODE=1\n"
        }),
    )
    .await;
    assert_eq!(agent_write["isError"], false, "{agent_write}");
    assert!(
        broker
            .commands()
            .iter()
            .any(|command| command == "agent.env.write"),
        "the Agent-scoped write never reached the named Agent: {:?}",
        broker.commands()
    );

    let unknown_agent = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_env_write",
        json!({
            "name": "node.env",
            "source": "agent",
            "agent_id": "not-registered",
            "content": "NODE=1\n"
        }),
    )
    .await;
    assert_eq!(unknown_agent["isError"], true, "{unknown_agent}");

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

    assert_eq!(server_tools.as_array().expect("tools").len(), 11);
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
            "nession_server_env_list",
            "nession_server_env_get",
            "nession_server_env_write",
            "nession_server_env_delete",
            "nession_server_session_env_binding_get",
            "nession_server_session_env_binding_set",
            "nession_server_session_env_binding_reapply",
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

    // The Agent-embedded host has no configured Server (`server_url` is empty).
    // Its binding Tools stay advertised and fail truthfully instead of falling
    // back to local Agent state.
    let session = initialize_with(agent_addr, AGENT_TOKEN).await;
    for (tool, arguments) in [
        ("nession_server_env_list", json!({})),
        ("nession_server_env_get", json!({ "name": "any.env" })),
        (
            "nession_server_session_env_binding_get",
            json!({ "session_id": "any-agent:work" }),
        ),
        (
            "nession_server_session_env_binding_set",
            json!({
                "session_id": "any-agent:work",
                "expected_revision": 0,
                "profiles": []
            }),
        ),
        (
            "nession_server_session_env_binding_reapply",
            json!({ "session_id": "any-agent:work", "expected_revision": 0 }),
        ),
    ] {
        let result = call_tool(agent_addr, AGENT_TOKEN, &session, tool, arguments).await;
        assert_eq!(result["isError"], true, "{tool}: {result}");
        assert_eq!(
            text_of(&result)["error"]["kind"],
            "unavailable",
            "{tool} must report the missing Server, not local state: {result}"
        );
    }

    let _ = agent_handle.shutdown().await;
    server_task.abort();
}

/// The fixture Extension Tool manifest a participant advertises (`#3778`).
fn extension_manifest(description: &str, version: u32) -> Value {
    json!({
        "manifest_version": version,
        "tools": [{
            "name": "fixture_extension_echo",
            "provider": "fixture-extension",
            "description": description,
            "input_schema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["agent_id", "message", "session_id"],
                "properties": {
                    "agent_id": { "type": "string", "description": "The owning Agent." },
                    "message": { "type": "string", "description": "The message to echo." },
                    "session_id": { "type": "string", "description": "The owner-specific Session." }
                }
            },
            "output_schema": {
                "type": "object",
                "properties": {
                    "message": { "type": "string", "description": "The echoed message." },
                    "agent": { "type": "string", "description": "The answering Agent." }
                }
            }
        }]
    })
}

/// Register a participant that advertises a contribution manifest and answers
/// the Server's relayed Tool call like the owning Agent would.
///
/// Returns only after the Server accepted the registration, so the manifest is
/// already installed (or refused) when the caller inspects the catalog.
async fn register_extension_agent(
    addr: SocketAddr,
    agent_id: &str,
    manifest: Value,
) -> (tokio::task::JoinHandle<()>, Arc<BrokerLog>) {
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
            "agent_id": agent_id,
            "hostname": "mock",
            "ip_address": "127.0.0.1",
            "port": 19999,
            "auth_token": SERVER_TOKEN,
            "protocol_manifest": { "provider": "test-agent", "protocols": {} },
            "mcp_tool_manifest": manifest,
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
    // The acceptance is sent after the Server installed the manifest, so this
    // wait is the synchronization point for the catalog assertions below.
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(5), stream.next())
            .await
            .expect("registration answer")
            .expect("registration frame")
            .expect("registration frame is valid");
        let text = frame.to_text().expect("text frame");
        let parsed: Value = serde_json::from_str(text).expect("registration JSON");
        if parsed["msg_type"] == "server.agent.register" {
            assert_eq!(parsed["payload"]["status"], "accepted", "{parsed}");
            break;
        }
    }
    let task_log = Arc::clone(&log);
    let answering_agent = agent_id.to_string();
    let task = tokio::spawn(async move {
        let mut heartbeat = tokio::time::interval(Duration::from_millis(500));
        loop {
            tokio::select! {
                frame = stream.next() => {
            let Some(Ok(frame)) = frame else { break };
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
            let payload = if command == "agent.mcp.tool.call" {
                let arguments = &parsed["payload"]["arguments"];
                let message = arguments["message"].as_str().unwrap_or_default();
                let session = arguments["session_id"].as_str().unwrap_or_default();
                if session == "missing-session" {
                    json!({
                        "request_id": request_id,
                        "command": command,
                        "success": false,
                        "error": {
                            "kind": "not_found",
                            "message": format!("Session '{session}' does not exist")
                        },
                    })
                } else {
                    json!({
                        "request_id": request_id,
                        "command": command,
                        "success": true,
                        "result": { "message": message, "agent": answering_agent },
                    })
                }
            } else {
                json!({
                    "request_id": request_id,
                    "command": command,
                    "success": true,
                    "sessions": [],
                })
            };
            let response = json!({
                "msg_type": "server.agent.command-response",
                "id": format!("response-{request_id}"),
                "timestamp": 0,
                "payload": payload
            });
            if sink.send(WsMessage::Text(response.to_string())).await.is_err() {
                break;
            }
                }
                _ = heartbeat.tick() => {
                    let beat = json!({
                        "msg_type": "control.heartbeat",
                        "id": uuid::Uuid::new_v4().to_string(),
                        "timestamp": 0,
                        "payload": {
                            "agent_id": answering_agent,
                            "status": "online",
                            "session_count": 0,
                            "active_sessions": 0,
                            "metadata": { "uptime_seconds": 0, "load_average": [0.0, 0.0, 0.0] }
                        }
                    });
                    if sink.send(WsMessage::Text(beat.to_string())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });
    (task, log)
}

/// `#3778` SC-03: one contributed Tool, advertised by its owning Agent,
/// invoked through Server-embedded and Standalone hosts, with wrong-target and
/// conflicting/stale manifests failing closed.
#[tokio::test]
async fn extension_tool_routes_to_the_named_agent_across_hosts() {
    // A one-second liveness window makes the offline transition observable in
    // this test without a sixty-second wait.
    let (server_addr, server_task) = start_server_with_heartbeat(true, 1, 1).await;
    let (first_agent, first_log) = register_extension_agent(
        server_addr,
        CLUSTER_AGENT,
        extension_manifest("Echo one message.", 1),
    )
    .await;

    let server_tools = tools_of(server_addr, SERVER_TOKEN).await;
    let tool = server_tools
        .as_array()
        .expect("tools")
        .iter()
        .find(|tool| tool["name"] == "fixture_extension_echo")
        .expect("the contributed Tool is advertised");
    assert_eq!(tool["description"], "Echo one message.");
    assert_eq!(tool["inputSchema"]["additionalProperties"], false);
    assert_eq!(
        tool["inputSchema"]["required"],
        json!(["agent_id", "message", "session_id"])
    );
    assert_eq!(
        tool["outputSchema"]["properties"]["agent"]["description"],
        "The answering Agent."
    );

    let server_session = initialize_with(server_addr, SERVER_TOKEN).await;
    let called = call_tool(
        server_addr,
        SERVER_TOKEN,
        &server_session,
        "fixture_extension_echo",
        json!({ "agent_id": CLUSTER_AGENT, "message": "hello", "session_id": "s1" }),
    )
    .await;
    assert_eq!(called["isError"], false, "{called}");
    assert_eq!(
        text_of(&called),
        json!({ "message": "hello", "agent": CLUSTER_AGENT })
    );
    assert_eq!(
        first_log.commands(),
        vec!["agent.mcp.tool.call".to_string()],
        "the Server brokered exactly one call to the owning Agent"
    );

    // A different Agent is not silently substituted.
    let wrong = call_tool(
        server_addr,
        SERVER_TOKEN,
        &server_session,
        "fixture_extension_echo",
        json!({ "agent_id": "other-agent", "message": "hello", "session_id": "s1" }),
    )
    .await;
    assert_eq!(wrong["isError"], true, "{wrong}");
    assert_eq!(text_of(&wrong)["error"]["kind"], "not_found", "{wrong}");

    // Owner-specific addressing is forwarded and the owner decides: an
    // unknown Session is refused by the Agent, never guessed or rerouted.
    let unknown_session = call_tool(
        server_addr,
        SERVER_TOKEN,
        &server_session,
        "fixture_extension_echo",
        json!({ "agent_id": CLUSTER_AGENT, "message": "hello", "session_id": "missing-session" }),
    )
    .await;
    assert_eq!(unknown_session["isError"], true, "{unknown_session}");
    assert_eq!(
        text_of(&unknown_session)["error"]["kind"],
        "not_found",
        "{unknown_session}"
    );

    // A second Agent advertising the same name with a different contract is
    // refused as a manifest. The first contract stays advertised and the second
    // Agent cannot be routed to it.
    let (second_agent, _) = register_extension_agent(
        server_addr,
        "second-agent",
        extension_manifest("Different semantics.", 1),
    )
    .await;
    let after_conflict = tools_of(server_addr, SERVER_TOKEN).await;
    let tool = after_conflict
        .as_array()
        .expect("tools")
        .iter()
        .find(|tool| tool["name"] == "fixture_extension_echo")
        .expect("the contributed Tool is still advertised");
    assert_eq!(
        tool["description"], "Echo one message.",
        "a conflicting manifest must not replace the live contract"
    );
    let conflicted = call_tool(
        server_addr,
        SERVER_TOKEN,
        &server_session,
        "fixture_extension_echo",
        json!({ "agent_id": "second-agent", "message": "hello", "session_id": "s1" }),
    )
    .await;
    assert_eq!(conflicted["isError"], true, "{conflicted}");
    assert_eq!(
        text_of(&conflicted)["error"]["kind"],
        "not_found",
        "the refused Agent's contribution is not routable"
    );

    // An unsupported manifest version is refused the same way.
    let (third_agent, _) = register_extension_agent(
        server_addr,
        "third-agent",
        extension_manifest("Stale semantics.", 99),
    )
    .await;
    let stale = call_tool(
        server_addr,
        SERVER_TOKEN,
        &server_session,
        "fixture_extension_echo",
        json!({ "agent_id": "third-agent", "message": "hello", "session_id": "s1" }),
    )
    .await;
    assert_eq!(stale["isError"], true, "{stale}");
    assert_eq!(text_of(&stale)["error"]["kind"], "not_found", "{stale}");

    // Standalone reads the Server's validated manifest at startup and invokes
    // the same Tool against the same explicitly named Agent.
    let dir = tempfile::tempdir().expect("tempdir");
    let config_path = write_routed_config(dir.path(), server_addr);
    let mut standalone = spawn_standalone(&config_path);
    let standalone_addr = await_listen_addr(&mut standalone.0).await;
    let standalone_tools = tools_of(standalone_addr, MCP_TOKEN).await;
    assert!(
        standalone_tools
            .as_array()
            .expect("tools")
            .iter()
            .any(|tool| tool["name"] == "fixture_extension_echo"),
        "standalone must advertise the Server's contributed Tool: {standalone_tools}"
    );
    // Same name means the same schema and description in every hosting mode.
    let server_contribution = tools_of(server_addr, SERVER_TOKEN)
        .await
        .as_array()
        .expect("tools")
        .iter()
        .find(|tool| tool["name"] == "fixture_extension_echo")
        .cloned()
        .expect("the Server still advertises the contribution");
    let standalone_contribution = standalone_tools
        .as_array()
        .expect("tools")
        .iter()
        .find(|tool| tool["name"] == "fixture_extension_echo")
        .cloned()
        .expect("the standalone host advertises the contribution");
    assert_eq!(
        standalone_contribution, server_contribution,
        "the contributed Tool definition must be identical across hosts"
    );
    let standalone_session = initialize_with(standalone_addr, MCP_TOKEN).await;
    let via_standalone = call_tool(
        standalone_addr,
        MCP_TOKEN,
        &standalone_session,
        "fixture_extension_echo",
        json!({ "agent_id": CLUSTER_AGENT, "message": "via standalone", "session_id": "s1" }),
    )
    .await;
    assert_eq!(via_standalone["isError"], false, "{via_standalone}");
    assert_eq!(
        text_of(&via_standalone),
        json!({ "message": "via standalone", "agent": CLUSTER_AGENT })
    );

    // An Agent going offline keeps its Tool listed and answers the truth for
    // the named target; it never reroutes to another Agent or a local guess.
    first_agent.abort();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let listed = call_tool(
            server_addr,
            SERVER_TOKEN,
            &server_session,
            "nession_server_list_agents",
            json!({}),
        )
        .await;
        let status = text_of(&listed)["agents"]
            .as_array()
            .and_then(|agents| {
                agents
                    .iter()
                    .find(|agent| agent["agent_id"] == CLUSTER_AGENT)
            })
            .map(|agent| agent["status"].clone());
        if status == Some(json!("offline")) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the Server never observed the Agent's disconnect: {listed}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let offline = call_tool(
        server_addr,
        SERVER_TOKEN,
        &server_session,
        "fixture_extension_echo",
        json!({ "agent_id": CLUSTER_AGENT, "message": "hello", "session_id": "s1" }),
    )
    .await;
    assert_eq!(offline["isError"], true, "{offline}");
    assert_eq!(
        text_of(&offline)["error"]["kind"],
        "unavailable",
        "{offline}"
    );
    let after_offline = tools_of(server_addr, SERVER_TOKEN).await;
    assert!(
        after_offline
            .as_array()
            .expect("tools")
            .iter()
            .any(|tool| tool["name"] == "fixture_extension_echo"),
        "an offline owner keeps its capability advertised: {after_offline}"
    );

    second_agent.abort();
    third_agent.abort();
    server_task.abort();
}

fn catalog_revision(tools: &rmcp::model::ListToolsResult) -> u64 {
    tools
        .meta
        .as_ref()
        .and_then(|meta| meta.0.get("nession/catalogRevision"))
        .and_then(Value::as_u64)
        .expect("every tools/list carries the catalog revision")
}

/// Records a legacy session's `notifications/tools/list_changed`.
struct ToolListWatcher {
    changed: tokio::sync::mpsc::UnboundedSender<()>,
}

impl ClientHandler for ToolListWatcher {
    fn on_tool_list_changed(
        &self,
        _context: NotificationContext<RoleClient>,
    ) -> impl std::future::Future<Output = ()> + rmcp::service::MaybeSendFuture + '_ {
        let _ = self.changed.send(());
        std::future::ready(())
    }
}

/// `#3778` SC-02: an explicit manifest update is observable and notifies a
/// connected legacy session; ordinary catalog reads and calls do not churn the
/// generation, and a stateless modern client sees the same revision.
#[tokio::test]
async fn catalog_revision_and_list_changed_are_explicit_and_runtime_state_does_not_churn() {
    let (server_addr, server_task) = start_server_with_heartbeat(true, 1, 1).await;
    let uri = format!("http://{server_addr}/mcp");
    let (changed_tx, mut changed_rx) = tokio::sync::mpsc::unbounded_channel();
    let legacy = ToolListWatcher {
        changed: changed_tx,
    }
    .serve_with_lifecycle(
        StreamableHttpClientTransport::from_config(
            StreamableHttpClientTransportConfig::with_uri(uri.clone()).auth_header(SERVER_TOKEN),
        ),
        ClientLifecycleMode::Initialize,
    )
    .await
    .expect("legacy client");

    let first = legacy.list_tools(None).await.expect("tools/list");
    let first_revision = catalog_revision(&first);
    assert_eq!(first.tools.len(), 11);

    // Reading and calling do not alter the catalog generation.
    let _ = legacy
        .call_tool(CallToolRequestParams::new("nession_server_list_agents"))
        .await
        .expect("tools/call");
    let stable = legacy.list_tools(None).await.expect("tools/list");
    assert_eq!(catalog_revision(&stable), first_revision);
    assert_eq!(stable.tools.len(), 11);

    // Ordinary Session runtime work is not a catalog event either.
    let _ = legacy
        .call_tool(
            CallToolRequestParams::new("nession_agent_create_session").with_arguments(
                json!({ "agent_id": CLUSTER_AGENT, "name": "runtime-churn" })
                    .as_object()
                    .expect("arguments")
                    .clone(),
            ),
        )
        .await
        .expect("session create");
    let after_session = legacy.list_tools(None).await.expect("tools/list");
    assert_eq!(catalog_revision(&after_session), first_revision);
    assert_eq!(after_session.tools.len(), 11);

    // Installing a manifest is an explicit catalog change: the connected
    // legacy session receives the list-change notification and the next list
    // carries the new generation.
    let (agent, _) = register_extension_agent(
        server_addr,
        CLUSTER_AGENT,
        extension_manifest("Echo one message.", 1),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(5), changed_rx.recv())
        .await
        .expect("a list-change notification must arrive")
        .expect("the notification channel stays open");
    let changed = legacy.list_tools(None).await.expect("tools/list");
    let changed_revision = catalog_revision(&changed);
    assert!(
        changed_revision > first_revision,
        "{changed_revision} <= {first_revision}"
    );
    assert!(changed
        .tools
        .iter()
        .any(|tool| tool.name == "fixture_extension_echo"));

    // The same generation is visible to a stateless modern client, which has
    // no notification channel and relies on the revision and TTL.
    let modern = ()
        .serve_with_lifecycle(
            StreamableHttpClientTransport::from_config(
                StreamableHttpClientTransportConfig::with_uri(uri).auth_header(SERVER_TOKEN),
            ),
            ClientLifecycleMode::Discover {
                preferred_versions: vec![ProtocolVersion::V_2026_07_28],
            },
        )
        .await
        .expect("modern client");
    let modern_tools = modern.list_tools(None).await.expect("tools/list");
    assert_eq!(catalog_revision(&modern_tools), changed_revision);
    assert!(modern_tools
        .tools
        .iter()
        .any(|tool| tool.name == "fixture_extension_echo"));
    modern.cancel().await.expect("cancel modern");
    legacy.cancel().await.expect("cancel legacy");
    agent.abort();
    server_task.abort();
}
