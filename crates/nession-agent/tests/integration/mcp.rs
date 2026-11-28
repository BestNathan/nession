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
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use nession_agent::config::{AgentConfig, AttachMode};
use nession_agent::execution::ResourceKey;
use nession_agent::p2p_auth::P2pAuth;
use nession_agent::server::websocket::{AgentServer, AgentServerContext};
use nession_agent::session::metadata::SessionMetadataStore;
use nession_agent::tmux::manager::SessionManager;
use nession_common::config::McpConfig;
use nession_mcp::provider::{McpToolProvider, ToolProviderError};
use nession_mcp::tool::{parse_arguments, reply_value, schema_for, ToolContext, ToolHandler};
use nession_mcp::ToolError;
use nession_runtime::lane::KeyedLane;
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

async fn start_agent_with_mcp() -> (SocketAddr, nession_agent::server::ServerHandle) {
    start_agent_with_mcp_using(nession_agent::execution::mutation_scheduler(), 60).await
}

async fn start_agent_with_mcp_using(
    mutations: Arc<KeyedLane<ResourceKey>>,
    tool_timeout_secs: u64,
) -> (SocketAddr, nession_agent::server::ServerHandle) {
    start_agent_with_providers(mutations, tool_timeout_secs, Vec::new()).await
}

/// Start the real Agent listener with an explicit MCP Tool composition.
async fn start_agent_with_providers(
    mutations: Arc<KeyedLane<ResourceKey>>,
    tool_timeout_secs: u64,
    tool_providers: Vec<Arc<dyn McpToolProvider>>,
) -> (SocketAddr, nession_agent::server::ServerHandle) {
    start_agent_with_provider_factory(mutations, tool_timeout_secs, |_| tool_providers, None).await
}

/// Start the real Agent listener with a post-create preparation hook (`#4073`).
async fn start_agent_with_session_created_hook(
    hook: nession_agent::session_created::SharedSessionCreatedHook,
) -> (SocketAddr, nession_agent::server::ServerHandle) {
    start_agent_with_provider_factory(
        nession_agent::execution::mutation_scheduler(),
        60,
        |_| Vec::new(),
        Some(hook),
    )
    .await
}

/// Start the real Agent listener with a provider composition that receives the
/// listener's own tmux Session manager.
///
/// A provider that executes a Session-scoped Protocol Unit must observe the
/// same tmux truth the MCP endpoint serves; handing it a second manager would
/// make the test pass against Sessions the endpoint never created.
async fn start_agent_with_provider_factory<F>(
    mutations: Arc<KeyedLane<ResourceKey>>,
    tool_timeout_secs: u64,
    tool_providers: F,
    session_created: Option<nession_agent::session_created::SharedSessionCreatedHook>,
) -> (SocketAddr, nession_agent::server::ServerHandle)
where
    F: FnOnce(Arc<SessionManager>) -> Vec<Arc<dyn McpToolProvider>>,
{
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
            // The same durable Agent Token MCP mounts below: one secret gates
            // both the P2P listener and the embedded MCP endpoint (#3440).
            auth: Arc::new(P2pAuth::new(TOKEN)),
            mutations,
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
    if let Some(hook) = session_created {
        server = server.with_session_created_hook(hook);
    }

    let config = AgentConfig {
        // Empty: this fixture is a standalone Agent. Cluster tools must
        // report that rather than silently reaching a host that is not there.
        server_url: String::new(),
        auth_token: String::new(),
        agent_token: TOKEN.to_string(),
        mcp: McpConfig {
            enabled: true,
            tool_timeout_secs,
            ..Default::default()
        },
        ..Default::default()
    };
    server
        .mount_mcp(&config, TOKEN, tool_providers(Arc::clone(&tmux)))
        .expect("mount MCP");
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
    send_path(addr, method, "/mcp", token, session, body).await
}

async fn send_path(
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

async fn list_tools(addr: SocketAddr, session: &str) -> Vec<Value> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/list",
        "params": {}
    })
    .to_string();
    let response = send(addr, "POST", Some(TOKEN), Some(session), &body)
        .await
        .expect("tools response");
    assert_eq!(response.status, 200, "{}", response.body);
    response.json()["result"]["tools"]
        .as_array()
        .expect("tools")
        .clone()
}

fn text_of(result: &Value) -> Value {
    let text = result["content"][0]["text"].as_str().expect("text content");
    serde_json::from_str(text).expect("tool text is JSON")
}

/// A fixture Extension Tool contributed through the explicit provider seam
/// (`#3778` SC-01). It owns its typed input/output contract and execution;
/// the Agent only composes the provider and the shared MCP host advertises it.
#[derive(serde::Serialize, schemars::JsonSchema)]
struct ExtensionEchoOutput {
    /// The message the Extension echoed.
    message: String,
    /// The provider that answered.
    provider: String,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct ExtensionEchoInput {
    /// The Agent this call names.
    agent_id: String,
    /// The message to echo.
    message: String,
}

struct ExtensionEchoTool;

#[async_trait::async_trait]
impl ToolHandler for ExtensionEchoTool {
    fn name(&self) -> &'static str {
        "fixture_extension_echo"
    }

    fn description(&self) -> &'static str {
        "Echo one message through the shared MCP catalog"
    }

    fn input_schema(&self) -> serde_json::Map<String, Value> {
        schema_for::<ExtensionEchoInput>()
    }

    fn output_schema(&self) -> serde_json::Map<String, Value> {
        schema_for::<ExtensionEchoOutput>()
    }

    async fn call(
        &self,
        _context: &ToolContext,
        arguments: serde_json::Map<String, Value>,
    ) -> Result<Value, ToolError> {
        let input = parse_arguments::<ExtensionEchoInput>(arguments)?;
        nession_mcp::tool::non_empty(&input.agent_id, "agent_id")?;
        reply_value(&ExtensionEchoOutput {
            message: input.message,
            provider: "fixture-extension".to_string(),
        })
    }
}

#[derive(Default)]
struct FixtureExtensionProvider {
    enumerations: AtomicUsize,
}

impl McpToolProvider for FixtureExtensionProvider {
    fn provider_name(&self) -> &str {
        "fixture-extension"
    }

    fn tools(&self) -> Result<Vec<Arc<dyn ToolHandler>>, ToolProviderError> {
        self.enumerations.fetch_add(1, Ordering::SeqCst);
        Ok(vec![Arc::new(ExtensionEchoTool)])
    }
}

/// Send one business frame on an authenticated direct P2P connection.
async fn p2p_request(addr: SocketAddr, payload: Value) -> Value {
    use futures_util::{SinkExt, StreamExt};
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
        .await
        .expect("p2p socket");
    let (mut sink, mut stream) = ws.split();
    let auth = json!({
        "msg_type": "client.auth",
        "id": "auth-1",
        "timestamp": 0,
        "payload": { "auth_token": TOKEN, "client_id": null }
    });
    sink.send(tokio_tungstenite::tungstenite::Message::Text(
        auth.to_string(),
    ))
    .await
    .expect("client.auth");
    loop {
        let frame = stream.next().await.expect("auth frame").expect("frame");
        let parsed: Value = serde_json::from_str(frame.to_text().expect("text")).expect("JSON");
        if parsed["id"] == "auth-1" {
            assert_eq!(parsed["msg_type"], "ok", "{parsed}");
            break;
        }
    }
    let request = json!({
        "msg_type": "agent.mcp.tool.call",
        "id": "call-1",
        "timestamp": 0,
        "payload": payload
    });
    sink.send(tokio_tungstenite::tungstenite::Message::Text(
        request.to_string(),
    ))
    .await
    .expect("tool call");
    loop {
        let frame = stream.next().await.expect("call frame").expect("frame");
        let parsed: Value = serde_json::from_str(frame.to_text().expect("text")).expect("JSON");
        if parsed["id"] == "call-1" {
            return parsed["payload"].clone();
        }
    }
}

#[tokio::test]
async fn agent_p2p_mcp_tool_call_executes_its_own_contribution() {
    let (addr, handle) = start_agent_with_providers(
        nession_agent::execution::mutation_scheduler(),
        60,
        vec![Arc::new(FixtureExtensionProvider::default())],
    )
    .await;

    let reply = p2p_request(
        addr,
        json!({
            "agent_id": TEST_AGENT_ID,
            "tool": "fixture_extension_echo",
            "arguments": { "agent_id": TEST_AGENT_ID, "message": "p2p" }
        }),
    )
    .await;
    assert_eq!(reply["success"], true, "{reply}");
    assert_eq!(
        reply["result"],
        json!({ "message": "p2p", "provider": "fixture-extension" })
    );

    // A call naming a different Agent is refused, never executed locally.
    let foreign = p2p_request(
        addr,
        json!({
            "agent_id": "other-agent",
            "tool": "fixture_extension_echo",
            "arguments": { "agent_id": "other-agent", "message": "p2p" }
        }),
    )
    .await;
    assert_eq!(foreign["success"], false, "{foreign}");
    assert_eq!(foreign["error"]["kind"], "invalid_argument", "{foreign}");

    // A Tool this Agent does not advertise is refused, not looked up on a
    // baseline or a neighbour.
    let unknown = p2p_request(
        addr,
        json!({
            "agent_id": TEST_AGENT_ID,
            "tool": "missing_tool",
            "arguments": { "agent_id": TEST_AGENT_ID }
        }),
    )
    .await;
    assert_eq!(unknown["success"], false, "{unknown}");
    assert_eq!(unknown["error"]["kind"], "not_found", "{unknown}");

    let _ = handle.shutdown().await;
}

/// Records post-create preparation calls and contributes a warning (`#4073`).
struct RecordingSessionCreatedHook {
    calls: AtomicUsize,
}

#[async_trait::async_trait]
impl nession_agent::session_created::SessionCreatedHook for RecordingSessionCreatedHook {
    async fn session_created(&self, _agent_id: &str, _session_name: &str) -> Option<String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Some("fixture create warning".to_string())
    }
}

#[tokio::test]
async fn a_created_session_reaches_the_composed_preparation_hook() {
    let hook = Arc::new(RecordingSessionCreatedHook {
        calls: AtomicUsize::new(0),
    });
    let (addr, handle) = start_agent_with_session_created_hook(hook.clone()).await;
    let session = initialize(addr).await;
    let name = unique_session_name("hook");
    let created = call_tool(
        addr,
        &session,
        "nession_agent_create_session",
        json!({ "agent_id": TEST_AGENT_ID, "name": name }),
    )
    .await;
    assert_eq!(created["isError"], false, "{created}");
    assert_eq!(
        hook.calls.load(Ordering::SeqCst),
        1,
        "the create must reach the composed hook exactly once"
    );
    assert!(
        text_of(&created)["warnings"]
            .as_array()
            .expect("warnings")
            .iter()
            .any(|warning| warning == "fixture create warning"),
        "the hook's warning belongs to the create reply: {}",
        text_of(&created)
    );
    // This test shares the run's private tmux socket with every other test
    // binary. Leaving the Session behind would make an unrelated test that
    // asserts a fresh Agent sees no tmux Sessions fail intermittently under
    // the parallel coverage run, so clean up through the same Tool.
    let killed = call_tool(
        addr,
        &session,
        "nession_agent_kill_session",
        json!({
            "agent_id": TEST_AGENT_ID,
            "name": name,
            "expected_instance_id": text_of(&created)["instance_id"]
                .as_str()
                .expect("the create reports its durable instance")
        }),
    )
    .await;
    assert_eq!(killed["isError"], false, "{killed}");
    let _ = handle.shutdown().await;
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
    assert_eq!(
        created["structuredContent"],
        text_of(&created),
        "a successful Tool call carries the declared structured output"
    );

    let listed = call_tool(
        addr,
        &session,
        "nession_agent_list_sessions",
        json!({ "agent_id": TEST_AGENT_ID }),
    )
    .await;
    assert_eq!(listed["isError"], false, "{listed}");
    let structured = listed["structuredContent"].clone();
    let listed = text_of(&listed);
    assert_eq!(structured, listed, "text must represent structuredContent");
    assert!(
        listed["sessions"]
            .as_array()
            .expect("sessions")
            .iter()
            .any(|entry| entry["name"] == name),
        "the real tmux Session is missing from Agent truth: {listed}"
    );
    // Nession-owned transport fields are snake_case (#3371). The MCP result is
    // Nession's own object, so its multi-word key must use the contract
    // spelling, and the retired camelCase argument spelling must be refused
    // rather than silently ignored.
    assert!(
        listed["stale_agents"].is_array() && listed.get("staleAgents").is_none(),
        "the MCP result must use the contract's snake_case key: {listed}"
    );
    let camel = call_tool(
        addr,
        &session,
        "nession_agent_list_sessions",
        json!({ "agentId": TEST_AGENT_ID }),
    )
    .await;
    assert_eq!(camel["isError"], true, "{camel}");
    assert!(
        camel.get("structuredContent").is_none(),
        "an error result must not carry success structuredContent"
    );
    let camel_text = camel["content"][0]["text"].as_str().expect("text content");
    assert!(
        camel_text.contains("agent_id"),
        "the refusal must name the contract argument: {camel_text}"
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

    // The Server-owned Tool remains listed but reports the missing Server
    // explicitly instead of inventing a local registry view.
    let cluster = call_tool(addr, &session, "nession_server_list_agents", json!({})).await;
    assert_eq!(cluster["isError"], true, "{cluster}");
    let text = cluster["content"][0]["text"]
        .as_str()
        .expect("text content");
    assert!(text.contains("standalone"), "{text}");

    // Project Tools are Server-owned too: a standalone Agent lists them and
    // fails truthfully rather than projecting Project metadata from local tmux.
    let projects = call_tool(addr, &session, "nession_server_project_list", json!({})).await;
    assert_eq!(projects["isError"], true, "{projects}");
    let text = projects["content"][0]["text"]
        .as_str()
        .expect("text content");
    assert!(text.contains("standalone"), "{text}");

    let killed = call_tool(
        addr,
        &session,
        "nession_agent_kill_session",
        json!({
            "agent_id": TEST_AGENT_ID,
            "name": name,
            "expected_instance_id": text_of(&created)["instance_id"]
                .as_str()
                .expect("the create reports its durable instance")
        }),
    )
    .await;
    assert_eq!(killed["isError"], false, "{killed}");
    assert_eq!(text_of(&killed)["name"], name);

    let _ = handle.shutdown().await;
}

/// `#3779` SC-04: the three Conversation/Transcript read Tools are contributed
/// through the Agent's own catalog and execute the **existing** Protocol Units
/// against the same tmux Session truth the endpoint serves.
///
/// The empty Session is the real reader's answer at this Session's strict cwd:
/// `ready` with no conversations, then `not_found` for an id that names no
/// conversation and no transcript. None of the three substitutes another
/// conversation, and none carries a filesystem path.
#[tokio::test]
async fn agent_mcp_exposes_the_claude_conversation_and_transcript_readers() {
    let (addr, handle) = start_agent_with_provider_factory(
        nession_agent::execution::mutation_scheduler(),
        60,
        |tmux| nession_agent::runtime::compose_mcp_tool_providers(TEST_AGENT_ID, tmux),
        None,
    )
    .await;
    let session = initialize(addr).await;

    let tools = list_tools(addr, &session).await;
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    for name in [
        "nession_claude_status",
        "nession_claude_enter",
        "nession_claude_submit",
        "nession_claude_list_conversations",
        "nession_claude_get_conversation",
        "nession_claude_get_transcript",
    ] {
        assert!(names.contains(&name), "{name} is missing from {names:?}");
    }

    let list_tool = tools
        .iter()
        .find(|tool| tool["name"] == "nession_claude_list_conversations")
        .expect("list Tool");
    assert_eq!(list_tool["inputSchema"]["additionalProperties"], false);
    for field in ["state", "items", "binding", "next_cursor", "has_more"] {
        assert!(
            list_tool["outputSchema"]["properties"].get(field).is_some(),
            "the list contract is missing {field}"
        );
    }
    let conversation_tool = tools
        .iter()
        .find(|tool| tool["name"] == "nession_claude_get_conversation")
        .expect("conversation Tool");
    for field in ["items", "conversation", "partial_tail", "skipped"] {
        assert!(
            conversation_tool["outputSchema"]["properties"]
                .get(field)
                .is_some(),
            "the conversation contract is missing {field}"
        );
    }
    let transcript_tool = tools
        .iter()
        .find(|tool| tool["name"] == "nession_claude_get_transcript")
        .expect("transcript Tool");
    for field in ["page", "record"] {
        assert!(
            transcript_tool["outputSchema"]["properties"]
                .get(field)
                .is_some(),
            "the transcript contract is missing {field}"
        );
    }
    assert!(
        !transcript_tool["outputSchema"]
            .to_string()
            .contains("\"path\""),
        "the transcript contract must not expose a file path"
    );

    let name = unique_session_name("claude-read");
    let created = call_tool(
        addr,
        &session,
        "nession_agent_create_session",
        json!({ "agent_id": TEST_AGENT_ID, "name": name }),
    )
    .await;
    assert_eq!(created["isError"], false, "{created}");
    let target = format!("{TEST_AGENT_ID}:{name}");

    let listed = call_tool(
        addr,
        &session,
        "nession_claude_list_conversations",
        json!({ "agent_id": TEST_AGENT_ID, "session_id": target }),
    )
    .await;
    assert_eq!(listed["isError"], false, "{listed}");
    let listed = text_of(&listed);
    assert_eq!(listed["state"], "ready", "{listed}");
    assert!(
        listed["items"]
            .as_array()
            .is_none_or(std::vec::Vec::is_empty),
        "a cwd with no Claude conversations is an empty ready list: {listed}"
    );

    let unknown = call_tool(
        addr,
        &session,
        "nession_claude_get_conversation",
        json!({
            "agent_id": TEST_AGENT_ID,
            "session_id": target,
            "conversation_id": "550e8400-e29b-41d4-a716-446655440000"
        }),
    )
    .await;
    assert_eq!(unknown["isError"], false, "{unknown}");
    let unknown = text_of(&unknown);
    assert_eq!(unknown["state"], "not_found", "{unknown}");
    assert!(
        unknown.get("conversation").is_none(),
        "an unknown id must not select another conversation: {unknown}"
    );

    let transcript = call_tool(
        addr,
        &session,
        "nession_claude_get_transcript",
        json!({
            "agent_id": TEST_AGENT_ID,
            "session_id": target,
            "conversation_id": "550e8400-e29b-41d4-a716-446655440000"
        }),
    )
    .await;
    assert_eq!(transcript["isError"], false, "{transcript}");
    let transcript = text_of(&transcript);
    assert_eq!(transcript["page"]["state"], "not_found", "{transcript}");
    assert!(transcript.get("record").is_none(), "{transcript}");

    let record = call_tool(
        addr,
        &session,
        "nession_claude_get_transcript",
        json!({
            "agent_id": TEST_AGENT_ID,
            "session_id": target,
            "record_ref": "not-a-real-reference"
        }),
    )
    .await;
    assert_eq!(record["isError"], false, "{record}");
    assert_eq!(text_of(&record)["record"]["state"], "not_found", "{record}");

    let foreign = call_tool(
        addr,
        &session,
        "nession_claude_list_conversations",
        json!({ "agent_id": "another-agent", "session_id": "another-agent:dev" }),
    )
    .await;
    assert_eq!(foreign["isError"], true, "{foreign}");

    let killed = call_tool(
        addr,
        &session,
        "nession_agent_kill_session",
        json!({
            "agent_id": TEST_AGENT_ID,
            "name": name,
            "expected_instance_id": text_of(&created)["instance_id"]
                .as_str()
                .expect("the create reports its durable instance")
        }),
    )
    .await;
    assert_eq!(killed["isError"], false, "{killed}");
    let _ = handle.shutdown().await;
}

/// `#3778` SC-01: the Agent's explicit provider composition reaches the shared
/// endpoint with its typed contract intact, while the seventeen baseline Tools
/// keep their exact advertised definitions.
#[tokio::test]
async fn agent_mcp_composes_an_extension_tool_into_the_shared_catalog() {
    let provider = Arc::new(FixtureExtensionProvider::default());
    let (addr, handle) = start_agent_with_providers(
        nession_agent::execution::mutation_scheduler(),
        60,
        vec![provider.clone()],
    )
    .await;
    let session = initialize(addr).await;

    let tools = list_tools(addr, &session).await;
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    let baseline = nession_mcp::tools::TOOL_NAMES;
    assert_eq!(
        &names[..baseline.len()],
        baseline,
        "the baseline catalog and its order must not change"
    );
    assert_eq!(names.len(), baseline.len() + 1);

    let fixture = tools
        .iter()
        .find(|tool| tool["name"] == "fixture_extension_echo")
        .expect("the contributed Tool is advertised");
    assert_eq!(
        fixture["description"],
        "Echo one message through the shared MCP catalog"
    );
    let input = &fixture["inputSchema"];
    assert_eq!(input["type"], "object");
    assert_eq!(input["additionalProperties"], false);
    assert_eq!(input["properties"]["message"]["type"], "string");
    assert_eq!(
        input["properties"]["message"]["description"],
        "The message to echo."
    );
    assert!(input["required"]
        .as_array()
        .expect("required")
        .iter()
        .any(|field| field == "message"));
    let output = &fixture["outputSchema"];
    assert_eq!(output["type"], "object");
    assert_eq!(output["properties"]["message"]["type"], "string");
    assert_eq!(output["properties"]["provider"]["type"], "string");
    assert_eq!(
        output["properties"]["provider"]["description"],
        "The provider that answered."
    );

    let called = call_tool(
        addr,
        &session,
        "fixture_extension_echo",
        json!({ "agent_id": TEST_AGENT_ID, "message": "hello" }),
    )
    .await;
    assert_eq!(called["isError"], false, "{called}");
    let expected = json!({ "message": "hello", "provider": "fixture-extension" });
    assert_eq!(text_of(&called), expected);
    assert_eq!(called["structuredContent"], expected);

    let refused = call_tool(
        addr,
        &session,
        "fixture_extension_echo",
        json!({ "agent_id": TEST_AGENT_ID, "wrong": "hello" }),
    )
    .await;
    assert_eq!(refused["isError"], true, "{refused}");
    assert!(
        refused.get("structuredContent").is_none(),
        "a refused call must not carry success structuredContent"
    );

    assert_eq!(
        provider.enumerations.load(Ordering::SeqCst),
        1,
        "tools/list and tools/call must not rebuild the catalog"
    );

    let _ = handle.shutdown().await;
}

/// Reproduce the actual MCP timeout across the Agent listener, shared lane and
/// tmux owner. Both writes have been admitted to the queue but not started.
/// The original implementation ran them after the HTTP request timed out.
async fn abandoned_queued_call(
    addr: SocketAddr,
    mcp_session: &str,
    mutations: &Arc<KeyedLane<ResourceKey>>,
    name: &str,
    tool_name: &str,
    expected_instance_id: Option<&str>,
) {
    let key = ResourceKey::Session(name.to_string());
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    mutations
        .enqueue(
            key.clone(),
            Box::pin(async move {
                let _ = started_tx.send(());
                let _ = release_rx.await;
            }),
        )
        .await;
    started_rx.await.expect("the blocker owns the Session key");

    let mut arguments = json!({ "agent_id": TEST_AGENT_ID, "name": name });
    if let Some(expected) = expected_instance_id {
        arguments["expected_instance_id"] = json!(expected);
    }
    let result = call_tool(addr, mcp_session, tool_name, arguments).await;
    assert_eq!(
        result["isError"], true,
        "a blocked tool must time out: {result}"
    );
    let error = text_of(&result);
    assert_eq!(error["error"]["kind"], "timeout", "{error}");
    let message = error["error"]["message"].as_str().expect("timeout message");
    assert!(
        message.contains("inspect the affected state before retrying"),
        "{message}"
    );

    // The queued work must have reached the owner lane before the response;
    // otherwise this test would prove only a timeout before dispatch.
    let pending = mutations.snapshot().await;
    assert_eq!(pending.queued, 1, "MCP write was not queued: {pending:?}");

    // Queue a sentinel after the cancelled call, release the blocker, then
    // await FIFO completion. No sleep/polling or guessed completion timing.
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    mutations
        .enqueue(
            key,
            Box::pin(async move {
                let _ = done_tx.send(());
            }),
        )
        .await;
    release_tx.send(()).expect("release blocker");
    tokio::time::timeout(Duration::from_secs(10), done_rx)
        .await
        .expect("lane drained the timed-out call")
        .expect("sentinel completed");
}

#[tokio::test]
async fn agent_mcp_abandoned_queued_create_and_kill_preserve_tmux_state() {
    let mutations = nession_agent::execution::mutation_scheduler();
    // The fixture deadline is not the subject of this test: the abandoned call
    // times out deterministically because its blocker is held for the whole
    // call. The deliberate readback-then-retry create runs real tmux work, and
    // a one-second deadline races it when the integration binary runs its
    // other real-runtime tests in parallel.
    let (addr, handle) = start_agent_with_mcp_using(Arc::clone(&mutations), 5).await;
    let mcp_session = initialize(addr).await;
    let name = unique_session_name("mcp-timeout");

    abandoned_queued_call(
        addr,
        &mcp_session,
        &mutations,
        &name,
        "nession_agent_create_session",
        None,
    )
    .await;
    let absent = call_tool(
        addr,
        &mcp_session,
        "nession_agent_list_sessions",
        json!({ "agent_id": TEST_AGENT_ID }),
    )
    .await;
    assert_eq!(absent["isError"], false, "{absent}");
    assert!(
        !text_of(&absent)["sessions"]
            .as_array()
            .expect("Agent sessions")
            .iter()
            .any(|item| item["name"] == name),
        "a timed-out queued create changed tmux state"
    );

    // A deliberate readback-before-retry, not an implicit replay.
    let created = call_tool(
        addr,
        &mcp_session,
        "nession_agent_create_session",
        json!({ "agent_id": TEST_AGENT_ID, "name": name }),
    )
    .await;
    assert_eq!(created["isError"], false, "{created}");

    abandoned_queued_call(
        addr,
        &mcp_session,
        &mutations,
        &name,
        "nession_agent_kill_session",
        Some(
            text_of(&created)["instance_id"]
                .as_str()
                .expect("the create reports its durable instance"),
        ),
    )
    .await;
    let retained = call_tool(
        addr,
        &mcp_session,
        "nession_agent_list_sessions",
        json!({ "agent_id": TEST_AGENT_ID }),
    )
    .await;
    assert_eq!(retained["isError"], false, "{retained}");
    assert!(
        text_of(&retained)["sessions"]
            .as_array()
            .expect("Agent sessions")
            .iter()
            .any(|item| item["name"] == name),
        "a timed-out queued kill removed a live tmux Session"
    );
    let killed = call_tool(
        addr,
        &mcp_session,
        "nession_agent_kill_session",
        json!({
            "agent_id": TEST_AGENT_ID,
            "name": name,
            "expected_instance_id": text_of(&created)["instance_id"]
                .as_str()
                .expect("the create reports its durable instance")
        }),
    )
    .await;
    assert_eq!(killed["isError"], false, "{killed}");
    let _ = handle.shutdown().await;
}

/// #4302 SC-01: a guarded kill already queued on the Session key must conflict
/// when a controlled A→B replacement lands before the lane admits it.
///
/// The blocker holds the keyed lane; the replacement runs on the listener's
/// own tmux manager (the user terminates A and recreates the name); only then
/// is the blocker released. The queued kill therefore checks identity against
/// B, refuses as a `conflict`, and B keeps running with its own incarnation.
/// The ordering is forced by the lane and the blocker, not by timing.
#[tokio::test]
async fn a_queued_guarded_kill_conflicts_after_a_controlled_replacement() {
    let mutations = nession_agent::execution::mutation_scheduler();
    let mut shared: Option<Arc<SessionManager>> = None;
    let (addr, handle) = start_agent_with_provider_factory(
        Arc::clone(&mutations),
        10,
        |tmux| {
            shared = Some(tmux);
            Vec::new()
        },
        None,
    )
    .await;
    let tmux = shared.expect("the factory receives the listener's own manager");
    let mcp_session = initialize(addr).await;
    let name = unique_session_name("mcp-aba");

    let created = call_tool(
        addr,
        &mcp_session,
        "nession_agent_create_session",
        json!({ "agent_id": TEST_AGENT_ID, "name": name }),
    )
    .await;
    assert_eq!(created["isError"], false, "{created}");
    let a = text_of(&created)["instance_id"]
        .as_str()
        .expect("the create reports its durable instance")
        .to_string();

    // The blocker owns the Session key; the guarded kill queues behind it.
    let key = ResourceKey::Session(name.clone());
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    mutations
        .enqueue(
            key.clone(),
            Box::pin(async move {
                let _ = started_tx.send(());
                let _ = release_rx.await;
            }),
        )
        .await;
    started_rx.await.expect("the blocker owns the Session key");

    let kill_task = tokio::spawn({
        let mcp_session = mcp_session.clone();
        let name = name.clone();
        let a = a.clone();
        async move {
            call_tool(
                addr,
                &mcp_session,
                "nession_agent_kill_session",
                json!({
                    "agent_id": TEST_AGENT_ID,
                    "name": name,
                    "expected_instance_id": a
                }),
            )
            .await
        }
    });

    // While the kill is queued, the user terminates A and recreates the name.
    // This is outside the lane on purpose: it is the replacement that cuts in
    // ahead of the queued mutation, the exact ABA ordering of the Issue.
    tmux.kill_session(&name).await.expect("A is terminated");
    let outcome = tmux
        .create_session_with_options(&name, 80, 24, "/tmp", None, None, None)
        .await
        .expect("B is created under the same name");
    let b = outcome.instance_id.expect("B reports its identity");
    assert_ne!(a, b, "the replacement is a fresh incarnation");

    release_tx.send(()).expect("release the blocker");
    let killed = kill_task.await.expect("the queued kill answers");
    assert_eq!(killed["isError"], true, "{killed}");
    assert_eq!(text_of(&killed)["error"]["kind"], "conflict", "{killed}");

    // B is untouched: alive, its own identity, and still killable by a caller
    // that actually observed it.
    assert!(
        tmux.list_sessions()
            .await
            .expect("tmux list")
            .iter()
            .any(|session| session.name == name),
        "the refused kill terminated the replacement"
    );
    assert_eq!(tmux.session_instance_id(&name).await.unwrap(), b);
    let killed = call_tool(
        addr,
        &mcp_session,
        "nession_agent_kill_session",
        json!({
            "agent_id": TEST_AGENT_ID,
            "name": name,
            "expected_instance_id": b
        }),
    )
    .await;
    assert_eq!(killed["isError"], false, "{killed}");
    let _ = handle.shutdown().await;
}

/// #4302 SC-02: the Agent-embedded Tool refuses a missing or empty expected
/// instance explicitly, and a stale one as a conflict that leaves B running.
#[tokio::test]
async fn agent_mcp_kill_requires_and_enforces_the_observed_instance() {
    let (addr, handle) = start_agent_with_mcp().await;
    let mcp_session = initialize(addr).await;
    let name = unique_session_name("mcp-guard");

    let created = call_tool(
        addr,
        &mcp_session,
        "nession_agent_create_session",
        json!({ "agent_id": TEST_AGENT_ID, "name": name }),
    )
    .await;
    assert_eq!(created["isError"], false, "{created}");
    let instance = text_of(&created)["instance_id"]
        .as_str()
        .expect("the create reports its durable instance")
        .to_string();

    let missing = call_tool(
        addr,
        &mcp_session,
        "nession_agent_kill_session",
        json!({ "agent_id": TEST_AGENT_ID, "name": name }),
    )
    .await;
    assert_eq!(missing["isError"], true, "{missing}");
    assert_eq!(text_of(&missing)["error"]["kind"], "invalid_argument");

    let empty = call_tool(
        addr,
        &mcp_session,
        "nession_agent_kill_session",
        json!({
            "agent_id": TEST_AGENT_ID,
            "name": name,
            "expected_instance_id": ""
        }),
    )
    .await;
    assert_eq!(empty["isError"], true, "{empty}");
    assert_eq!(text_of(&empty)["error"]["kind"], "invalid_argument");

    let stale = call_tool(
        addr,
        &mcp_session,
        "nession_agent_kill_session",
        json!({
            "agent_id": TEST_AGENT_ID,
            "name": name,
            "expected_instance_id": "00000000-0000-4000-8000-000000000000"
        }),
    )
    .await;
    assert_eq!(stale["isError"], true, "{stale}");
    assert_eq!(text_of(&stale)["error"]["kind"], "conflict", "{stale}");

    let listed = call_tool(
        addr,
        &mcp_session,
        "nession_agent_list_sessions",
        json!({ "agent_id": TEST_AGENT_ID }),
    )
    .await;
    let entry = text_of(&listed)["sessions"]
        .as_array()
        .expect("sessions")
        .iter()
        .find(|entry| entry["name"] == name)
        .cloned()
        .expect("the refused kills left the Session running");
    assert_eq!(entry["instance_id"], instance);

    let killed = call_tool(
        addr,
        &mcp_session,
        "nession_agent_kill_session",
        json!({
            "agent_id": TEST_AGENT_ID,
            "name": name,
            "expected_instance_id": instance
        }),
    )
    .await;
    assert_eq!(killed["isError"], false, "{killed}");
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
    // The outbound Server credential (AGENT_AUTH_TOKEN) is never valid on
    // the Agent's own MCP surface, which checks the durable Agent Token.
    let wrong = send(addr, "POST", Some("outbound-server-token"), None, &body)
        .await
        .expect("wrong bearer must receive an HTTP refusal");
    assert_eq!(wrong.status, 401);
    let _ = handle.shutdown().await;
}

/// `#3439` SC-02: the Agent's single listener is one explicit route table.
///
/// MCP owns its configured path; everything else is the P2P upgrade route.
/// A plain HTTP request to an unmatched path is a 404, and a request that
/// claims to be an upgrade but is malformed is refused by Axum's extractor
/// rather than quietly becoming a WebSocket or a closed connection.
#[tokio::test]
async fn agent_http_surface_is_explicit() {
    let (addr, handle) = start_agent_with_mcp().await;

    let unmatched = send_path(addr, "GET", "/not-a-route", None, None, "")
        .await
        .expect("HTTP answer");
    assert_eq!(unmatched.status, 404);

    let not_an_upgrade = send_path(addr, "GET", "/ws", None, None, "")
        .await
        .expect("HTTP answer");
    assert_eq!(not_an_upgrade.status, 404);

    let wrong_method = send_path(addr, "POST", "/ws", None, None, "")
        .await
        .expect("HTTP answer");
    assert_eq!(wrong_method.status, 404, "the P2P fallback is upgrade-only");

    let _ = handle.shutdown().await;
}

/// Raw probe request with arbitrary extra headers; header keys are normalised
/// to lowercase so assertions do not depend on the wire casing.
async fn send_probe(
    addr: SocketAddr,
    method: &str,
    extra: &[(&str, &str)],
) -> Option<HttpResponse> {
    let mut stream = TcpStream::connect(addr).await.ok()?;
    let mut head = format!(
        "{method} /probe HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n"
    );
    for (name, value) in extra {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await.ok()?;
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
                .map(|(key, value)| (key.trim().to_ascii_lowercase(), value.trim().to_string()))
        })
        .collect();
    Some(HttpResponse {
        status,
        headers,
        body: body.to_string(),
    })
}

/// `#4618` SC-01: the Agent's reserved `/probe` route is a credential-free
/// reachability endpoint on the same P2P listener — `204` + `Nession-Probe: v1`
/// + `no-store` + CORS exposure, no body, no auth, and no pending-auth upgrade
/// even for an upgrade-shaped GET. The P2P listener has no Origin allowlist, so
/// a browser Origin receives a credential-free wildcard.
#[tokio::test]
async fn agent_probe_route_is_credential_free() {
    let (addr, handle) = start_agent_with_mcp().await;

    let plain = send_probe(addr, "GET", &[]).await.expect("HTTP answer");
    assert_eq!(plain.status, 204);
    assert!(plain.body.is_empty(), "the probe carries no body");
    assert_eq!(plain.header("cache-control"), Some("no-store"));
    assert_eq!(plain.header("nession-probe"), Some("v1"));
    assert_eq!(
        plain.header("access-control-expose-headers"),
        Some("Nession-Probe")
    );
    assert!(plain.header("access-control-allow-credentials").is_none());
    // A bogus credential is ignored: the probe has no auth slot.
    let bogus = send_probe(addr, "GET", &[("Authorization", "Bearer nonsense")])
        .await
        .expect("HTTP answer");
    assert_eq!(bogus.status, 204);

    let cors = send_probe(addr, "GET", &[("Origin", "https://app.example.com")])
        .await
        .expect("HTTP answer");
    assert_eq!(cors.status, 204);
    assert_eq!(cors.header("access-control-allow-origin"), Some("*"));
    assert!(cors.header("access-control-allow-credentials").is_none());

    let post = send_probe(addr, "POST", &[]).await.expect("HTTP answer");
    assert_eq!(post.status, 405, "the probe is GET-only");

    // An upgrade-shaped GET to the reserved path stays a probe, never a WS:
    // the explicit route wins over the any-path upgrade fallback.
    let upgrade = send_probe(
        addr,
        "GET",
        &[
            ("Upgrade", "websocket"),
            ("Connection", "Upgrade"),
            ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
            ("Sec-WebSocket-Version", "13"),
        ],
    )
    .await
    .expect("HTTP answer");
    assert_eq!(upgrade.status, 204);
    assert_eq!(upgrade.header("nession-probe"), Some("v1"));

    let _ = handle.shutdown().await;
}
