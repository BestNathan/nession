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
use nession_agent::connection::{ServerClient, ServerClientHandle};
use nession_agent::extension::ExtensionRegistry;
use nession_agent::p2p_auth::P2pAuth;
use nession_agent::server::websocket::{AgentServer, AgentServerContext};
use nession_agent::session::metadata::SessionMetadataStore;
use nession_agent::tmux::manager::SessionManager;
use nession_common::config::{McpConfig, ServerConfig};
use nession_common::SecretString;
use nession_protocol::contracts::agent::v1::AgentMetadata;
use nession_protocol::contracts::project::v1::{ProjectLocation, ProjectSessionDefaults};
use nession_server::db::{Database, ProjectRow};
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
/// A real tmux-backed Agent registered over the central Server connection.
const PROJECT_AGENT: &str = "project-agent";
/// A syntactically valid Server-minted Project identity.
const PROJECT_ID: &str = "project-123e4567-e89b-42d3-a456-426614174000";

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

async fn start_server_with_mcp(
    mcp_enabled: bool,
) -> (SocketAddr, tokio::task::JoinHandle<()>, Arc<Database>) {
    start_server_with_heartbeat(mcp_enabled, 10, 60).await
}

async fn start_server_with_heartbeat(
    mcp_enabled: bool,
    heartbeat_interval_secs: u64,
    heartbeat_timeout_secs: u64,
) -> (SocketAddr, tokio::task::JoinHandle<()>, Arc<Database>) {
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
    let db = Arc::new(db);
    let mut server = WebSocketServer::new(config, Arc::clone(&db))
        .await
        .expect("server");
    let addr = server.local_addr().expect("address");
    let handle = tokio::spawn(async move {
        let _ = server
            .run(nession_common::readiness::Readiness::Unwatched)
            .await;
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    (addr, handle, db)
}

async fn start_agent(
    agent_token: &str,
    mcp_enabled: bool,
) -> (SocketAddr, nession_agent::server::ServerHandle) {
    let tmp = Box::leak(Box::new(tempfile::tempdir().expect("tempdir")));
    let tmux = Arc::new(SessionManager::new());
    let store = Arc::new(SessionMetadataStore::with_root(
        Arc::clone(&tmux),
        tmp.path().join("sessions"),
    ));
    start_agent_with(
        agent_token,
        mcp_enabled,
        AGENT_ID,
        Arc::clone(&tmux),
        store,
        tmp.path().to_string_lossy().into_owned(),
    )
    .await
}

/// The same real Agent over explicitly shared tmux/metadata owners.
///
/// A production Agent serves its P2P endpoint and its central connection from
/// one process, one tmux server and one metadata store. Tests that compare
/// those two surfaces must share the same owners, or the metadata files land
/// under different roots for one incarnation.
async fn start_agent_with(
    agent_token: &str,
    mcp_enabled: bool,
    agent_id: &str,
    tmux: Arc<SessionManager>,
    session_metadata: Arc<SessionMetadataStore>,
    data_dir: String,
) -> (SocketAddr, nession_agent::server::ServerHandle) {
    let (resize, _resize_updates) = nession_agent::server::ResizeReporter::new();
    let mut server = AgentServer::new(
        "127.0.0.1:0",
        agent_id,
        None,
        data_dir.clone(),
        data_dir.as_str(),
        AttachMode::Plain,
        AgentServerContext {
            resize,
            auth: Arc::new(P2pAuth::new(agent_token)),
            mutations: nession_agent::execution::mutation_scheduler(),
            tmux,
            session_metadata,
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

/// Register a real tmux-backed Agent with the Server over its central
/// connection.
///
/// The Server's canonical `server.session.create`/list routes then reach this
/// Agent's real `SessionManager`, which is what makes the Project-context
/// proof a Server+Agent+tmux runtime Case rather than a projection test.
async fn register_real_agent(server_addr: SocketAddr) -> (ServerClientHandle, Arc<SessionManager>) {
    let tmux = Arc::new(SessionManager::new());
    // The store's root must outlive the registration; this TempDir is bounded
    // by the run root the test harness owns.
    let root = Box::leak(Box::new(
        tempfile::tempdir().expect("metadata fixture root"),
    ));
    let store = Arc::new(SessionMetadataStore::with_root(
        Arc::clone(&tmux),
        root.path().join("sessions"),
    ));
    let handle =
        register_real_agent_with(server_addr, PROJECT_AGENT, Arc::clone(&tmux), store).await;
    (handle, tmux)
}

/// Register one Agent id using explicitly shared tmux/metadata owners.
async fn register_real_agent_with(
    server_addr: SocketAddr,
    agent_id: &str,
    tmux: Arc<SessionManager>,
    session_metadata: Arc<SessionMetadataStore>,
) -> ServerClientHandle {
    let metadata = AgentMetadata {
        tmux_version: "3.3".to_string(),
        os_version: "test".to_string(),
        nession_version: "0.1.0".to_string(),
        image_tag: "test".to_string(),
        architecture: String::new(),
        os: String::new(),
        variant: None,
    };
    let registry = ExtensionRegistry::new(
        agent_id,
        Vec::new(),
        nession_agent::protocol::served_descriptors().expect("served descriptors"),
    )
    .expect("extension registry");
    let client = ServerClient::new(
        format!("ws://{server_addr}"),
        SERVER_TOKEN,
        agent_id,
        "test-host",
        "127.0.0.1",
        19998,
        None,
        Vec::new(),
        None,
        metadata,
        tmux,
        "/tmp".to_string(),
        Some(Arc::new(registry)),
        SecretString::new(AGENT_TOKEN),
        nession_agent::execution::mutation_scheduler(),
    )
    .with_session_metadata(session_metadata);
    let (handle, _interval) = client.connect_and_run().await.expect("register agent");
    handle
}

/// Send one authenticated Server request on a fresh WebSocket.
///
/// This is how a Web client reaches the real `server_routes!` table. The
/// connection is closed after the reply; only the reply payload is returned.
async fn server_call(addr: SocketAddr, wire: &str, payload: Value) -> Value {
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
        .await
        .expect("server socket");
    let (mut sink, mut stream) = ws.split();
    let auth = json!({
        "msg_type": "server.auth",
        "id": "auth-1",
        "timestamp": 0,
        "payload": { "auth_token": SERVER_TOKEN, "client_id": "project-test" }
    });
    sink.send(WsMessage::Text(auth.to_string()))
        .await
        .expect("send auth");
    let reply = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(Ok(frame)) = stream.next().await {
            let parsed: Value =
                serde_json::from_str(frame.to_text().expect("text frame")).expect("auth JSON");
            if parsed["id"] == "auth-1" {
                return parsed;
            }
        }
        panic!("the Server closed before answering auth");
    })
    .await
    .expect("auth reply timeout");
    assert_eq!(reply["payload"]["status"], "success", "{reply}");

    let id = format!("call-{}", uuid::Uuid::new_v4());
    let request = json!({ "msg_type": wire, "id": id, "timestamp": 0, "payload": payload });
    sink.send(WsMessage::Text(request.to_string()))
        .await
        .expect("send request");
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(Ok(frame)) = stream.next().await {
            let parsed: Value =
                serde_json::from_str(frame.to_text().expect("text frame")).expect("reply JSON");
            if parsed["id"] == id.as_str() {
                return parsed["payload"].clone();
            }
        }
        panic!("the Server closed before answering {wire}");
    })
    .await
    .unwrap_or_else(|_| panic!("{wire} reply timeout"))
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
    send_to(addr, "/mcp", method, token, session, body).await
}

async fn send_to(
    addr: SocketAddr,
    target: &str,
    method: &str,
    token: Option<&str>,
    session: Option<&str>,
    body: &str,
) -> Option<HttpResponse> {
    let mut stream = TcpStream::connect(addr).await.ok()?;
    let mut head = format!(
        "{method} {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: application/json, \
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
    /// The `expected_instance_id` each routed kill carried (#4302), so a test
    /// can prove the precondition survives the Server route, not just the Tool.
    kill_preconditions: Mutex<Vec<Option<String>>>,
}

impl BrokerLog {
    fn commands(&self) -> Vec<String> {
        self.commands.lock().expect("broker log").clone()
    }

    fn kill_preconditions(&self) -> Vec<Option<String>> {
        self.kill_preconditions.lock().expect("broker log").clone()
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
                    "agent.session.kill" => {
                        sessions.retain(|name| name != session_name);
                        task_log
                            .kill_preconditions
                            .lock()
                            .expect("broker log")
                            .push(
                                parsed["payload"]["expected_instance_id"]
                                    .as_str()
                                    .map(str::to_owned),
                            );
                    }
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

/// An actual standalone process supports headerless clients only when explicitly enabled.
#[tokio::test]
async fn standalone_query_token_authentication_is_opt_in() {
    let (server_addr, server_task, _db) = start_server_with_mcp(false).await;
    let dir = tempfile::tempdir().expect("tempdir");
    let config_path = write_routed_config(dir.path(), server_addr);
    let mut child = spawn_standalone(&config_path);
    let addr = await_listen_addr(&mut child.0).await;
    let initialize = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": { "name": "query-test", "version": "1" }
        }
    })
    .to_string();

    let disabled = send_to(
        addr,
        "/mcp?token=mcp-inbound-token",
        "POST",
        None,
        None,
        &initialize,
    )
    .await
    .expect("default HTTP response");
    assert_eq!(disabled.status, 401);
    assert!(!disabled.body.contains(MCP_TOKEN));
    assert_eq!(
        send(addr, "POST", Some(MCP_TOKEN), None, &initialize)
            .await
            .expect("header authentication")
            .status,
        200
    );
    terminate_and_wait(&mut child.0).await;

    let original = std::fs::read_to_string(&config_path).expect("read standalone config");
    let enabled = original.replacen(
        &format!("auth_token = \"{MCP_TOKEN}\""),
        &format!("auth_token = \"{MCP_TOKEN}\"\nallow_query_token = true"),
        1,
    );
    std::fs::write(&config_path, enabled).expect("enable query authentication");
    let mut child = spawn_standalone(&config_path);
    let addr = await_listen_addr(&mut child.0).await;
    let query = "/mcp?token=mcp%2Dinbound%2Dtoken";
    let initialized = send_to(addr, query, "POST", None, None, &initialize)
        .await
        .expect("query HTTP response");
    assert_eq!(initialized.status, 200, "{}", initialized.body);
    let session = initialized
        .header("Mcp-Session-Id")
        .expect("legacy MCP session");
    let listed = send_to(
        addr,
        query,
        "POST",
        None,
        Some(session),
        &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }).to_string(),
    )
    .await
    .expect("query-only tools/list");
    assert_eq!(listed.status, 200, "{}", listed.body);
    assert_eq!(
        listed.json()["result"]["tools"]
            .as_array()
            .expect("tools")
            .len(),
        17
    );

    for target in [
        "/mcp?token=wrong",
        "/mcp?token=",
        "/mcp?token=mcp-inbound-token&token=mcp-inbound-token",
        "/mcp?token=mcp-inbound-token%",
    ] {
        let denied = send_to(addr, target, "POST", None, None, &initialize)
            .await
            .expect("refusal");
        assert_eq!(denied.status, 401, "{target}");
        assert!(!denied.body.contains(MCP_TOKEN));
    }
    let conflict = send_to(addr, query, "POST", Some("wrong"), None, &initialize)
        .await
        .expect("conflicting header");
    assert_eq!(conflict.status, 401);
    assert_eq!(
        send_to(addr, query, "POST", Some(MCP_TOKEN), None, &initialize)
            .await
            .expect("matching credentials")
            .status,
        200
    );
    assert_eq!(
        send_to(
            addr,
            "/other?token=mcp-inbound-token",
            "POST",
            None,
            None,
            &initialize
        )
        .await
        .expect("wrong path")
        .status,
        404
    );
    assert_eq!(
        send(addr, "POST", Some(MCP_TOKEN), None, &initialize)
            .await
            .expect("legacy bearer")
            .status,
        200
    );

    terminate_and_wait(&mut child.0).await;
    server_task.abort();
}

#[tokio::test]
async fn standalone_routes_agent_session_tools_through_the_server() {
    let (server_addr, server_task, _db) = start_server_with_mcp(false).await;
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
    assert_eq!(tools.as_array().expect("tools").len(), 17);

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
        json!({
            "agent_id": CLUSTER_AGENT,
            "name": name,
            "expected_instance_id": "instance-a"
        }),
    )
    .await;
    assert_eq!(killed["isError"], false, "{killed}");
    assert_eq!(
        broker.kill_preconditions(),
        vec![Some("instance-a".to_string())],
        "the Server route must forward the caller-observed incarnation (#4302)"
    );

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
async fn project_context_sessions_use_server_association_and_real_agent_runtime() {
    let (server_addr, server_task, db) = start_server_with_mcp(true).await;
    let (agent_handle, tmux) = register_real_agent(server_addr).await;

    let project_dir = tempfile::tempdir().expect("project directory");
    let project_path = project_dir.path().to_string_lossy().into_owned();
    db.insert_project(&ProjectRow {
        project_id: PROJECT_ID.to_string(),
        name: "MCP Project".to_string(),
        description: Some("a Project-context Session test".to_string()),
        source: None,
        locations: vec![ProjectLocation {
            agent_id: PROJECT_AGENT.to_string(),
            path: project_path.clone(),
        }],
        session_defaults: Some(ProjectSessionDefaults {
            shell: None,
            env_profile_ids: vec!["base.env".to_string()],
            sandbox_policy_ref: None,
        }),
        image_digest: None,
        created_at: 1,
        updated_at: 2,
    })
    .await
    .expect("insert Project");

    let dir = tempfile::tempdir().expect("tempdir");
    let config_path = write_routed_config(dir.path(), server_addr);
    let mut child = spawn_standalone(&config_path);
    let mcp_addr = await_listen_addr(&mut child.0).await;
    let session = initialize_with(mcp_addr, MCP_TOKEN).await;

    let env = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_env_write",
        json!({ "name": "base.env", "content": "PUBLIC=1\n" }),
    )
    .await;
    assert_eq!(env["isError"], false, "{env}");

    // Discovery is Server-owned and independent of the Agent's live state.
    let projects = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_project_list",
        json!({}),
    )
    .await;
    assert_eq!(projects["isError"], false, "{projects}");
    let projects = text_of(&projects);
    assert!(
        projects["projects"]
            .as_array()
            .expect("projects")
            .iter()
            .any(|project| project["project_id"] == PROJECT_ID),
        "{projects}"
    );

    let project = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_project_get",
        json!({ "project_id": PROJECT_ID }),
    )
    .await;
    assert_eq!(project["isError"], false, "{project}");
    assert_eq!(text_of(&project)["locations"][0]["path"], project_path);

    // SC-02/SC-03: create through the Project, inheriting its ENV defaults,
    // and confirm the persisted association through both MCP projections.
    let name = unique_name("project");
    let created = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_project_session_create",
        json!({
            "project_id": PROJECT_ID,
            "agent_id": PROJECT_AGENT,
            "name": name,
            "target": { "kind": "existing", "working_dir": project_path }
        }),
    )
    .await;
    assert_eq!(created["isError"], false, "{created}");
    let created = text_of(&created);
    assert_eq!(created["project_id"], PROJECT_ID);
    assert_eq!(created["session_id"], format!("{PROJECT_AGENT}:{name}"));

    let scoped = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_project_session_list",
        json!({ "project_id": PROJECT_ID, "force": true }),
    )
    .await;
    assert_eq!(scoped["isError"], false, "{scoped}");
    let scoped = text_of(&scoped);
    assert!(
        scoped["sessions"]
            .as_array()
            .expect("project sessions")
            .iter()
            .any(|entry| entry["name"] == name && entry["agent_id"] == PROJECT_AGENT),
        "{scoped}"
    );

    let agent_sessions = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_agent_list_sessions",
        json!({ "agent_id": PROJECT_AGENT }),
    )
    .await;
    assert_eq!(agent_sessions["isError"], false, "{agent_sessions}");
    let agent_sessions = text_of(&agent_sessions);
    let project_entry = agent_sessions["sessions"]
        .as_array()
        .expect("agent sessions")
        .iter()
        .find(|entry| entry["name"] == name)
        .cloned()
        .expect("the Project Session is live on the Agent");
    assert_eq!(project_entry["project_id"], PROJECT_ID);
    let instance_before = project_entry["instance_id"].clone();

    // A Session created through the Agent seam is explicitly unassociated.
    let plain = unique_name("plain");
    let plain_created = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_agent_create_session",
        json!({ "agent_id": PROJECT_AGENT, "name": plain }),
    )
    .await;
    assert_eq!(plain_created["isError"], false, "{plain_created}");
    let agent_sessions = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_agent_list_sessions",
        json!({ "agent_id": PROJECT_AGENT }),
    )
    .await;
    let agent_sessions = text_of(&agent_sessions);
    let plain_entry = agent_sessions["sessions"]
        .as_array()
        .expect("agent sessions")
        .iter()
        .find(|entry| entry["name"] == plain)
        .cloned()
        .expect("the plain Session is live on the Agent");
    assert_eq!(
        plain_entry["project_id"],
        Value::Null,
        "a confirmed non-association must be explicit null"
    );

    // SC-04: Web reassociation moves both projections without touching the
    // Agent's Session runtime.
    let rebind = server_call(
        server_addr,
        "server.session.project.set",
        json!({
            "session_id": format!("{PROJECT_AGENT}:{plain}"),
            "project_id": PROJECT_ID
        }),
    )
    .await;
    assert_eq!(rebind["success"], true, "{rebind}");

    let scoped = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_project_session_list",
        json!({ "project_id": PROJECT_ID, "force": true }),
    )
    .await;
    let scoped = text_of(&scoped);
    let scoped_names: Vec<&str> = scoped["sessions"]
        .as_array()
        .expect("project sessions")
        .iter()
        .filter_map(|entry| entry["name"].as_str())
        .collect();
    assert!(scoped_names.contains(&plain.as_str()), "{scoped}");
    assert!(scoped_names.contains(&name.as_str()), "{scoped}");

    let unbind = server_call(
        server_addr,
        "server.session.project.set",
        json!({
            "session_id": format!("{PROJECT_AGENT}:{name}"),
            "project_id": null
        }),
    )
    .await;
    assert_eq!(unbind["success"], true, "{unbind}");

    let scoped = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_project_session_list",
        json!({ "project_id": PROJECT_ID, "force": true }),
    )
    .await;
    let scoped = text_of(&scoped);
    let scoped_names: Vec<&str> = scoped["sessions"]
        .as_array()
        .expect("project sessions")
        .iter()
        .filter_map(|entry| entry["name"].as_str())
        .collect();
    assert!(!scoped_names.contains(&name.as_str()), "{scoped}");
    assert!(scoped_names.contains(&plain.as_str()), "{scoped}");

    let agent_sessions = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_agent_list_sessions",
        json!({ "agent_id": PROJECT_AGENT }),
    )
    .await;
    let agent_sessions = text_of(&agent_sessions);
    let project_entry = agent_sessions["sessions"]
        .as_array()
        .expect("agent sessions")
        .iter()
        .find(|entry| entry["name"] == name)
        .cloned()
        .expect("the unbound Session is still live");
    assert_eq!(project_entry["project_id"], Value::Null);
    assert_eq!(
        project_entry["instance_id"], instance_before,
        "Web membership changes must not replace the Session incarnation"
    );
    let live = tmux.list_sessions().await.expect("tmux sessions");
    assert!(
        live.iter().any(|session| session.name == name),
        "Web membership changes must not touch the Agent Session runtime"
    );

    // SC-02: the Server remains the validator. An undeclared location, an
    // unknown Project and a Managed target without a Project image are
    // refusals, never unqualified successful creates.
    let undeclared = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_project_session_create",
        json!({
            "project_id": PROJECT_ID,
            "agent_id": PROJECT_AGENT,
            "name": unique_name("undeclared"),
            "target": { "kind": "existing", "working_dir": "/not/a/declared/location" }
        }),
    )
    .await;
    assert_eq!(undeclared["isError"], true, "{undeclared}");
    assert!(
        undeclared["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("not an Existing Location"),
        "{undeclared}"
    );

    let unknown_project = "project-223e4567-e89b-42d3-a456-426614174000";
    let unknown = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_project_session_create",
        json!({
            "project_id": unknown_project,
            "agent_id": PROJECT_AGENT,
            "name": unique_name("unknown"),
            "target": { "kind": "existing", "working_dir": project_path }
        }),
    )
    .await;
    assert_eq!(unknown["isError"], true, "{unknown}");
    assert!(
        unknown["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("not found"),
        "{unknown}"
    );

    let missing = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_project_get",
        json!({ "project_id": unknown_project }),
    )
    .await;
    assert_eq!(missing["isError"], true, "{missing}");

    let managed = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_project_session_create",
        json!({
            "project_id": PROJECT_ID,
            "agent_id": PROJECT_AGENT,
            "name": unique_name("managed"),
            "target": {
                "kind": "managed",
                "base_digest": format!("sha256:{}", "a".repeat(64))
            }
        }),
    )
    .await;
    assert_eq!(managed["isError"], true, "{managed}");
    assert!(
        managed["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("does not pin an EROFS image"),
        "{managed}"
    );

    // Cleanup kills are guarded too (#4302): bind each one to the incarnation
    // the Agent currently reports for that name.
    let live = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_agent_list_sessions",
        json!({ "agent_id": PROJECT_AGENT }),
    )
    .await;
    let live = text_of(&live);
    for session_name in [&name, &plain] {
        let instance = live["sessions"]
            .as_array()
            .expect("agent sessions")
            .iter()
            .find(|entry| entry["name"] == session_name.as_str())
            .and_then(|entry| entry["instance_id"].as_str());
        if let Some(instance) = instance {
            let _ = call_tool(
                mcp_addr,
                MCP_TOKEN,
                &session,
                "nession_agent_kill_session",
                json!({
                    "agent_id": PROJECT_AGENT,
                    "name": session_name,
                    "expected_instance_id": instance
                }),
            )
            .await;
        }
    }
    let _ = agent_handle.shutdown().await;
    terminate_and_wait(&mut child.0).await;
    server_task.abort();
}

#[tokio::test]
async fn standalone_binds_a_session_with_revision_cas_and_no_value_leakage() {
    let (server_addr, server_task, _db) = start_server_with_mcp(false).await;
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
    let (server_addr, server_task, _db) = start_server_with_mcp(false).await;
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
    let (server_addr, server_task, _db) = start_server_with_mcp(false).await;
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

    // Project Tools are Server-owned even in explicit direct-Agent mode: the
    // configured Server answers them and the direct Agent route never does.
    let projects = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_server_project_list",
        json!({}),
    )
    .await;
    assert_eq!(projects["isError"], false, "{projects}");
    assert_eq!(text_of(&projects)["projects"], json!([]));

    // #4302: the direct-Agent route surfaces the owner's classified conflict
    // for a stale incarnation, and the current Session keeps running.
    let stale = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_agent_kill_session",
        json!({
            "agent_id": AGENT_ID,
            "name": name,
            "expected_instance_id": "00000000-0000-4000-8000-000000000000"
        }),
    )
    .await;
    assert_eq!(stale["isError"], true, "{stale}");
    assert_eq!(text_of(&stale)["error"]["kind"], "conflict", "{stale}");
    let listed = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_agent_list_sessions",
        json!({ "agent_id": AGENT_ID }),
    )
    .await;
    assert!(
        text_of(&listed)["sessions"]
            .as_array()
            .expect("sessions")
            .iter()
            .any(|entry| entry["name"] == name),
        "the refused kill must not terminate the current Session"
    );

    let instance = text_of(&created)["instance_id"]
        .as_str()
        .expect("the create reports its durable instance")
        .to_string();
    let killed = call_tool(
        mcp_addr,
        MCP_TOKEN,
        &session,
        "nession_agent_kill_session",
        json!({
            "agent_id": AGENT_ID,
            "name": name,
            "expected_instance_id": instance
        }),
    )
    .await;
    assert_eq!(killed["isError"], false, "{killed}");

    terminate_and_wait(&mut child.0).await;
    let _ = agent_handle.shutdown().await;
    server_task.abort();
}

/// #4007 SC-02/03/04: the metadata Tools answer the same Agent-owned truth from
/// Server-embedded, Agent-embedded, Server-routed standalone and explicit
/// direct-Agent standalone hosts. The partial update keeps omitted fields, the
/// revision/incarnation preconditions refuse stale writers, and the list
/// summary distinguishes a confirmed-empty record from a failed lookup.
#[tokio::test]
async fn session_metadata_tools_share_owner_truth_across_hosts() {
    let (server_addr, server_task, _db) = start_server_with_mcp(true).await;
    // One production-shaped Agent: the P2P/embedded surface and the central
    // connection share one tmux server and one metadata store, so a record
    // written through any host is the same record the others read.
    let shared = Box::leak(Box::new(tempfile::tempdir().expect("shared dir")));
    let shared_tmux = Arc::new(SessionManager::new());
    let shared_store = Arc::new(SessionMetadataStore::with_root(
        Arc::clone(&shared_tmux),
        shared.path().join("sessions"),
    ));
    let (agent_addr, agent_handle) = start_agent_with(
        AGENT_TOKEN,
        true,
        AGENT_ID,
        Arc::clone(&shared_tmux),
        Arc::clone(&shared_store),
        shared.path().to_string_lossy().into_owned(),
    )
    .await;
    let server_client = register_real_agent_with(
        server_addr,
        AGENT_ID,
        Arc::clone(&shared_tmux),
        Arc::clone(&shared_store),
    )
    .await;
    let routed_dir = tempfile::tempdir().expect("routed dir");
    let mut routed = spawn_standalone(&write_routed_config(routed_dir.path(), server_addr));
    let routed_addr = await_listen_addr(&mut routed.0).await;
    let direct_dir = tempfile::tempdir().expect("direct dir");
    let mut direct = spawn_standalone(&write_direct_config(
        direct_dir.path(),
        server_addr,
        agent_addr,
    ));
    let direct_addr = await_listen_addr(&mut direct.0).await;

    let server_session = initialize_with(server_addr, SERVER_TOKEN).await;
    let agent_session = initialize_with(agent_addr, AGENT_TOKEN).await;
    let routed_session = initialize_with(routed_addr, MCP_TOKEN).await;
    let direct_session = initialize_with(direct_addr, MCP_TOKEN).await;

    // The Server only routes to an Agent after its registration arrives.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let listed = call_tool(
            server_addr,
            SERVER_TOKEN,
            &server_session,
            "nession_server_list_agents",
            json!({}),
        )
        .await;
        let text = text_of(&listed);
        let online = text["agents"].as_array().is_some_and(|agents| {
            agents
                .iter()
                .any(|agent| agent["agent_id"] == AGENT_ID && agent["status"] == "online")
        });
        if online {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "Agent never registered with the Server: {text}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    let name = unique_name("metadata-hosts");
    let legacy_name = unique_name("metadata-empty");
    for created_name in [&name, &legacy_name] {
        let created = call_tool(
            server_addr,
            SERVER_TOKEN,
            &server_session,
            "nession_agent_create_session",
            json!({ "agent_id": AGENT_ID, "name": created_name }),
        )
        .await;
        assert_eq!(created["isError"], false, "server: {created}");
    }

    // Four routes, one revision-0 answer and one authoritative identity.
    let mut identity: Option<String> = None;
    for (addr, token, session, label) in [
        (server_addr, SERVER_TOKEN, &server_session, "server"),
        (agent_addr, AGENT_TOKEN, &agent_session, "agent"),
        (routed_addr, MCP_TOKEN, &routed_session, "routed"),
        (direct_addr, MCP_TOKEN, &direct_session, "direct"),
    ] {
        let got = call_tool(
            addr,
            token,
            session,
            "nession_agent_get_session_metadata",
            json!({ "agent_id": AGENT_ID, "name": name }),
        )
        .await;
        assert_eq!(got["isError"], false, "{label}: {got}");
        let text = text_of(&got);
        assert_eq!(text["session_id"], format!("{AGENT_ID}:{name}"));
        assert_eq!(text["metadata"]["revision"], 0);
        let id = text["instance_id"]
            .as_str()
            .unwrap_or_else(|| panic!("{label}: no instance identity in {text}"))
            .to_string();
        match &identity {
            None => identity = Some(id),
            Some(existing) => assert_eq!(existing, &id, "{label} reported another identity"),
        }
    }
    let identity = identity.expect("one authoritative instance identity");

    // A description-only patch through the Server route leaves title/tags
    // omitted (preserved) and commits at the owner.
    let patched = call_tool(
        server_addr,
        SERVER_TOKEN,
        &server_session,
        "nession_agent_update_session_metadata",
        json!({
            "agent_id": AGENT_ID,
            "name": name,
            "expected_instance_id": identity,
            "expected_revision": 0,
            "patch": { "description": "Goal: ChatGPT OAuth support." }
        }),
    )
    .await;
    assert_eq!(patched["isError"], false, "{patched}");
    assert_eq!(text_of(&patched)["metadata"]["revision"], 1);

    // Title and tags replace at revision 1 through the direct-Agent host; the
    // description survives the partial merge.
    let patched = call_tool(
        direct_addr,
        MCP_TOKEN,
        &direct_session,
        "nession_agent_update_session_metadata",
        json!({
            "agent_id": AGENT_ID,
            "name": name,
            "expected_instance_id": identity,
            "expected_revision": 1,
            "patch": { "title": "OAuth work", "tags": ["oauth", "mcp"] }
        }),
    )
    .await;
    assert_eq!(patched["isError"], false, "{patched}");
    let committed = text_of(&patched);
    assert_eq!(committed["metadata"]["revision"], 2);
    assert_eq!(
        committed["metadata"]["description"],
        "Goal: ChatGPT OAuth support."
    );
    assert_eq!(committed["metadata"]["title"], "OAuth work");
    assert_eq!(committed["metadata"]["tags"], json!(["oauth", "mcp"]));

    // A stale revision and a stale incarnation both refuse without writing.
    let stale_revision = call_tool(
        routed_addr,
        MCP_TOKEN,
        &routed_session,
        "nession_agent_update_session_metadata",
        json!({
            "agent_id": AGENT_ID,
            "name": name,
            "expected_instance_id": identity,
            "expected_revision": 1,
            "patch": { "title": "stale revision" }
        }),
    )
    .await;
    assert_eq!(stale_revision["isError"], true, "{stale_revision}");
    assert_eq!(text_of(&stale_revision)["error"]["kind"], "conflict");

    let stale_instance = call_tool(
        server_addr,
        SERVER_TOKEN,
        &server_session,
        "nession_agent_update_session_metadata",
        json!({
            "agent_id": AGENT_ID,
            "name": name,
            "expected_instance_id": "00000000-0000-4000-8000-000000000000",
            "expected_revision": 2,
            "patch": { "title": "stale instance" }
        }),
    )
    .await;
    assert_eq!(stale_instance["isError"], true, "{stale_instance}");
    assert_eq!(text_of(&stale_instance)["error"]["kind"], "conflict");

    // Re-reading the full record through every host proves neither refusal
    // wrote anything and that the committed partial update is one owner record.
    for (addr, token, session, label) in [
        (server_addr, SERVER_TOKEN, &server_session, "server"),
        (agent_addr, AGENT_TOKEN, &agent_session, "agent"),
        (routed_addr, MCP_TOKEN, &routed_session, "routed"),
        (direct_addr, MCP_TOKEN, &direct_session, "direct"),
    ] {
        let reread = call_tool(
            addr,
            token,
            session,
            "nession_agent_get_session_metadata",
            json!({ "agent_id": AGENT_ID, "name": name }),
        )
        .await;
        assert_eq!(reread["isError"], false, "{label}: {reread}");
        let record = text_of(&reread);
        assert_eq!(record["metadata"]["revision"], 2, "{label}");
        assert_eq!(record["metadata"]["title"], "OAuth work", "{label}");
        assert_eq!(
            record["metadata"]["description"], "Goal: ChatGPT OAuth support.",
            "{label}"
        );
        assert_eq!(
            record["metadata"]["tags"],
            json!(["oauth", "mcp"]),
            "{label}"
        );
        assert_eq!(record["instance_id"], identity, "{label}");
    }

    // Every host's list carries the same bounded summary; the Session with no
    // saved metadata is a confirmed revision 0, not a failed lookup. The full
    // description never rides the list.
    for (addr, token, session, label) in [
        (server_addr, SERVER_TOKEN, &server_session, "server"),
        (agent_addr, AGENT_TOKEN, &agent_session, "agent"),
        (routed_addr, MCP_TOKEN, &routed_session, "routed"),
        (direct_addr, MCP_TOKEN, &direct_session, "direct"),
    ] {
        let listed = call_tool(
            addr,
            token,
            session,
            "nession_agent_list_sessions",
            json!({ "agent_id": AGENT_ID }),
        )
        .await;
        assert_eq!(listed["isError"], false, "{label}: {listed}");
        let text = text_of(&listed);
        let sessions = text["sessions"].as_array().expect("sessions");
        let saved = sessions
            .iter()
            .find(|entry| entry["name"] == name)
            .unwrap_or_else(|| panic!("{label}: saved Session missing from {text}"));
        assert_eq!(saved["metadata"]["state"], "available", "{label}");
        assert_eq!(saved["metadata"]["summary"]["revision"], 2, "{label}");
        assert_eq!(
            saved["metadata"]["summary"]["title"], "OAuth work",
            "{label}"
        );
        assert_eq!(
            saved["metadata"]["summary"]["tags"],
            json!(["oauth", "mcp"]),
            "{label}"
        );
        assert!(
            saved["metadata"]["summary"].get("description").is_none(),
            "{label}: description must stay behind Get"
        );

        let empty = sessions
            .iter()
            .find(|entry| entry["name"] == legacy_name)
            .unwrap_or_else(|| panic!("{label}: empty Session missing from {text}"));
        assert_eq!(empty["metadata"]["state"], "available", "{label}");
        assert_eq!(empty["metadata"]["summary"]["revision"], 0, "{label}");
        assert!(
            empty["metadata"]["summary"].get("title").is_none(),
            "{label}: a confirmed empty record has no title"
        );
    }

    // A missing Session is not an empty successful read.
    let missing = call_tool(
        server_addr,
        SERVER_TOKEN,
        &server_session,
        "nession_agent_get_session_metadata",
        json!({ "agent_id": AGENT_ID, "name": "no-such-session" }),
    )
    .await;
    assert_eq!(missing["isError"], true, "{missing}");
    assert_eq!(text_of(&missing)["error"]["kind"], "not_found");

    // #4302 SC-02: every hosting route surfaces the same classified conflict
    // for a stale-incarnation kill, and none terminates the current Session.
    for (addr, token, session, label) in [
        (server_addr, SERVER_TOKEN, &server_session, "server"),
        (agent_addr, AGENT_TOKEN, &agent_session, "agent"),
        (routed_addr, MCP_TOKEN, &routed_session, "routed"),
        (direct_addr, MCP_TOKEN, &direct_session, "direct"),
    ] {
        let stale = call_tool(
            addr,
            token,
            session,
            "nession_agent_kill_session",
            json!({
                "agent_id": AGENT_ID,
                "name": name,
                "expected_instance_id": "00000000-0000-4000-8000-000000000000"
            }),
        )
        .await;
        assert_eq!(stale["isError"], true, "{label}: {stale}");
        assert_eq!(
            text_of(&stale)["error"]["kind"],
            "conflict",
            "{label}: {stale}"
        );
    }
    let still = shared_tmux.list_sessions().await.expect("real Agent list");
    assert!(
        still.iter().any(|session| session.name == name),
        "a refused stale kill must not terminate the current Session"
    );

    for kill_name in [&name, &legacy_name] {
        // #4302: read the current incarnation, then bind the kill to it.
        let read = call_tool(
            server_addr,
            SERVER_TOKEN,
            &server_session,
            "nession_agent_get_session_metadata",
            json!({ "agent_id": AGENT_ID, "name": kill_name }),
        )
        .await;
        assert_eq!(read["isError"], false, "{read}");
        let instance = text_of(&read)["instance_id"]
            .as_str()
            .expect("the read reports the durable instance")
            .to_string();
        let killed = call_tool(
            server_addr,
            SERVER_TOKEN,
            &server_session,
            "nession_agent_kill_session",
            json!({
                "agent_id": AGENT_ID,
                "name": kill_name,
                "expected_instance_id": instance
            }),
        )
        .await;
        assert_eq!(killed["isError"], false, "{killed}");
    }
    terminate_and_wait(&mut routed.0).await;
    terminate_and_wait(&mut direct.0).await;
    let _ = server_client.shutdown().await;
    let _ = agent_handle.shutdown().await;
    server_task.abort();
}

/// #4081 SC-02/SC-04: one valid Create input carrying initial work context
/// through Server-embedded, Agent-embedded, Server-routed standalone and
/// explicit direct-Agent standalone hosts results in the same normalized
/// record on the one targeted Agent; Get and the list summary see it
/// immediately, without a separate update call. An unavailable/unauthorized
/// target is refused and never falls back to the MCP host's Agent.
#[tokio::test]
async fn session_metadata_creation_is_equivalent_across_hosts() {
    let (server_addr, server_task, _db) = start_server_with_mcp(true).await;
    let shared = Box::leak(Box::new(tempfile::tempdir().expect("shared dir")));
    let shared_tmux = Arc::new(SessionManager::new());
    let shared_store = Arc::new(SessionMetadataStore::with_root(
        Arc::clone(&shared_tmux),
        shared.path().join("sessions"),
    ));
    let (agent_addr, agent_handle) = start_agent_with(
        AGENT_TOKEN,
        true,
        AGENT_ID,
        Arc::clone(&shared_tmux),
        Arc::clone(&shared_store),
        shared.path().to_string_lossy().into_owned(),
    )
    .await;
    let server_client = register_real_agent_with(
        server_addr,
        AGENT_ID,
        Arc::clone(&shared_tmux),
        Arc::clone(&shared_store),
    )
    .await;
    let routed_dir = tempfile::tempdir().expect("routed dir");
    let mut routed = spawn_standalone(&write_routed_config(routed_dir.path(), server_addr));
    let routed_addr = await_listen_addr(&mut routed.0).await;
    let direct_dir = tempfile::tempdir().expect("direct dir");
    let mut direct = spawn_standalone(&write_direct_config(
        direct_dir.path(),
        server_addr,
        agent_addr,
    ));
    let direct_addr = await_listen_addr(&mut direct.0).await;

    let server_session = initialize_with(server_addr, SERVER_TOKEN).await;
    let agent_session = initialize_with(agent_addr, AGENT_TOKEN).await;
    let routed_session = initialize_with(routed_addr, MCP_TOKEN).await;
    let direct_session = initialize_with(direct_addr, MCP_TOKEN).await;

    // The Server only routes to an Agent after its registration arrives.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let listed = call_tool(
            server_addr,
            SERVER_TOKEN,
            &server_session,
            "nession_server_list_agents",
            json!({}),
        )
        .await;
        let text = text_of(&listed);
        let online = text["agents"].as_array().is_some_and(|agents| {
            agents
                .iter()
                .any(|agent| agent["agent_id"] == AGENT_ID && agent["status"] == "online")
        });
        if online {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "Agent never registered with the Server: {text}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    let initial = json!({
        "title": "OAuth implementation",
        "description": "Goal: implement and validate the OAuth flow.",
        "tags": ["backend", "oauth"]
    });
    // One create through each hosting mode, with the same valid input.
    let mut created_names = Vec::new();
    for (addr, token, session, label) in [
        (server_addr, SERVER_TOKEN, &server_session, "server"),
        (agent_addr, AGENT_TOKEN, &agent_session, "agent"),
        (routed_addr, MCP_TOKEN, &routed_session, "routed"),
        (direct_addr, MCP_TOKEN, &direct_session, "direct"),
    ] {
        let name = unique_name(&format!("metadata-create-{label}"));
        let created = call_tool(
            addr,
            token,
            session,
            "nession_agent_create_session",
            json!({ "agent_id": AGENT_ID, "name": name, "metadata": initial }),
        )
        .await;
        assert_eq!(created["isError"], false, "{label}: {created}");
        let created = text_of(&created);
        assert_eq!(created["name"], name, "{label}");
        assert_eq!(created["metadata"]["revision"], 1, "{label}: {created}");
        assert_eq!(
            created["metadata"]["title"], "OAuth implementation",
            "{label}: {created}"
        );
        let instance = created["instance_id"]
            .as_str()
            .unwrap_or_else(|| panic!("{label}: no instance identity: {created}"))
            .to_string();
        created_names.push((name, instance));
    }

    // Every host sees the committed record and its identity immediately.
    for (addr, token, session, label) in [
        (server_addr, SERVER_TOKEN, &server_session, "server"),
        (agent_addr, AGENT_TOKEN, &agent_session, "agent"),
        (routed_addr, MCP_TOKEN, &routed_session, "routed"),
        (direct_addr, MCP_TOKEN, &direct_session, "direct"),
    ] {
        let listed = call_tool(
            addr,
            token,
            session,
            "nession_agent_list_sessions",
            json!({ "agent_id": AGENT_ID }),
        )
        .await;
        assert_eq!(listed["isError"], false, "{label}: {listed}");
        let text = text_of(&listed);
        let sessions = text["sessions"].as_array().expect("sessions");
        for (name, instance) in &created_names {
            let got = call_tool(
                addr,
                token,
                session,
                "nession_agent_get_session_metadata",
                json!({ "agent_id": AGENT_ID, "name": name }),
            )
            .await;
            assert_eq!(got["isError"], false, "{label}: {got}");
            let record = text_of(&got);
            assert_eq!(record["metadata"]["revision"], 1, "{label}: {record}");
            assert_eq!(
                record["metadata"]["title"], "OAuth implementation",
                "{label}: {record}"
            );
            assert_eq!(
                record["metadata"]["description"], "Goal: implement and validate the OAuth flow.",
                "{label}: {record}"
            );
            assert_eq!(
                record["metadata"]["tags"],
                json!(["backend", "oauth"]),
                "{label}: {record}"
            );
            assert_eq!(record["instance_id"], *instance, "{label}");

            let summary = sessions
                .iter()
                .find(|entry| entry["name"] == *name)
                .unwrap_or_else(|| panic!("{label}: created Session missing from {text}"));
            assert_eq!(summary["metadata"]["state"], "available", "{label}");
            assert_eq!(
                summary["metadata"]["summary"]["revision"], 1,
                "{label}: {summary}"
            );
            assert_eq!(
                summary["metadata"]["summary"]["title"], "OAuth implementation",
                "{label}: {summary}"
            );
            assert!(
                summary["metadata"]["summary"].get("description").is_none(),
                "{label}: the list summary never carries the description"
            );
        }
    }

    // An explicit target this direct host does not own is refused; nothing is
    // created on the host Agent instead.
    let refused = call_tool(
        direct_addr,
        MCP_TOKEN,
        &direct_session,
        "nession_agent_create_session",
        json!({
            "agent_id": "some-other-agent",
            "name": unique_name("metadata-foreign"),
            "metadata": initial
        }),
    )
    .await;
    assert_eq!(refused["isError"], true, "{refused}");
    let real = shared_tmux.list_sessions().await.expect("real Agent list");
    assert!(
        !real.iter().any(|session| session
            .name
            .starts_with("nession-test-mcp-metadata-foreign")),
        "a refused target must not create a Session on the host Agent"
    );

    for (name, _) in &created_names {
        // #4302: bind each cleanup kill to the incarnation the Agent reports.
        let read = call_tool(
            server_addr,
            SERVER_TOKEN,
            &server_session,
            "nession_agent_get_session_metadata",
            json!({ "agent_id": AGENT_ID, "name": name }),
        )
        .await;
        assert_eq!(read["isError"], false, "{read}");
        let instance = text_of(&read)["instance_id"]
            .as_str()
            .expect("the read reports the durable instance")
            .to_string();
        let killed = call_tool(
            server_addr,
            SERVER_TOKEN,
            &server_session,
            "nession_agent_kill_session",
            json!({
                "agent_id": AGENT_ID,
                "name": name,
                "expected_instance_id": instance
            }),
        )
        .await;
        assert_eq!(killed["isError"], false, "{killed}");
    }
    terminate_and_wait(&mut routed.0).await;
    terminate_and_wait(&mut direct.0).await;
    let _ = server_client.shutdown().await;
    let _ = agent_handle.shutdown().await;
    server_task.abort();
}

/// SC-03: all three hosts serve one catalog, byte for byte.
#[tokio::test]
async fn all_three_hosts_share_one_tool_catalog() {
    let (server_addr, server_task, _db) = start_server_with_mcp(true).await;
    let (agent_addr, agent_handle) = start_agent(AGENT_TOKEN, true).await;
    let dir = tempfile::tempdir().expect("tempdir");
    let config_path = write_routed_config(dir.path(), server_addr);
    let mut standalone = spawn_standalone(&config_path);
    let standalone_addr = await_listen_addr(&mut standalone.0).await;

    let server_tools = tools_of(server_addr, SERVER_TOKEN).await;
    let agent_tools = tools_of(agent_addr, AGENT_TOKEN).await;
    let standalone_tools = tools_of(standalone_addr, MCP_TOKEN).await;

    assert_eq!(server_tools.as_array().expect("tools").len(), 17);
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
            "nession_server_project_list",
            "nession_server_project_get",
            "nession_server_project_session_list",
            "nession_server_project_session_create",
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
            "nession_agent_get_session_metadata",
            "nession_agent_update_session_metadata",
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
    let (server_addr, server_task, _db) = start_server_with_heartbeat(true, 1, 1).await;
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
    let (server_addr, server_task, _db) = start_server_with_heartbeat(true, 1, 1).await;
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
    assert_eq!(first.tools.len(), 17);

    // Reading and calling do not alter the catalog generation.
    let _ = legacy
        .call_tool(CallToolRequestParams::new("nession_server_list_agents"))
        .await
        .expect("tools/call");
    let stable = legacy.list_tools(None).await.expect("tools/list");
    assert_eq!(catalog_revision(&stable), first_revision);
    assert_eq!(stable.tools.len(), 17);

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
    assert_eq!(after_session.tools.len(), 17);

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
