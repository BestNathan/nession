#![allow(clippy::expect_used, clippy::indexing_slicing)]

//! Protocol and registry conformance (`#3264` SC-01/02/03/05/06/07).
//!
//! The service is mounted on a real TCP listener and spoken to two ways:
//!
//! * raw HTTP, so required headers, version errors, auth, Origin and the
//!   legacy session lifecycle are observed on the wire;
//! * the official `rmcp` client, so `2026-07-28` and `2025-03-26` are proven
//!   by an independent implementation rather than by the server's own tests.

use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use async_trait::async_trait;
use nession_mcp::backend::{ClusterBackend, NodeBackend};
use nession_mcp::error::ToolError;
use nession_mcp::http::{self, Sniffed};
use nession_mcp::service::McpService;
use nession_mcp::ServiceConfig;
use rmcp::model::{CallToolRequestParams, ContentBlock, ProtocolVersion};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::{ClientLifecycleMode, ClientServiceExt};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};

const TOKEN: &str = "mcp-test-token";
const PATH: &str = "/mcp";
const MODERN: &str = "2026-07-28";
const LEGACY: &str = "2025-03-26";

#[derive(Default)]
struct Recorder {
    calls: Mutex<Vec<String>>,
}

impl Recorder {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("recorder lock").clone()
    }

    fn push(&self, call: impl Into<String>) {
        self.calls.lock().expect("recorder lock").push(call.into());
    }
}

#[async_trait]
impl ClusterBackend for Recorder {
    async fn list_agents(&self) -> Result<Value, ToolError> {
        self.push("cluster.list_agents");
        Ok(json!({
            "agents": [{ "agent_id": "agent-1", "status": "online" }]
        }))
    }
}

#[async_trait]
impl NodeBackend for Recorder {
    async fn list_sessions(&self, agent_id: &str) -> Result<Value, ToolError> {
        self.push(format!("node.list_sessions:{agent_id}"));
        Ok(json!({ "sessions": [], "stale_agents": [] }))
    }

    async fn create_session(
        &self,
        agent_id: &str,
        name: &str,
        working_dir: Option<&str>,
    ) -> Result<Value, ToolError> {
        self.push(format!("node.create:{agent_id}:{name}:{working_dir:?}"));
        Ok(json!({ "name": name, "warnings": [] }))
    }

    async fn kill_session(&self, agent_id: &str, name: &str) -> Result<Value, ToolError> {
        self.push(format!("node.kill:{agent_id}:{name}"));
        Ok(json!({ "name": name }))
    }
}

struct SlowNode;

#[async_trait]
impl NodeBackend for SlowNode {
    async fn list_sessions(&self, _agent_id: &str) -> Result<Value, ToolError> {
        tokio::time::sleep(Duration::from_millis(500)).await;
        Ok(json!({ "sessions": [] }))
    }

    async fn create_session(
        &self,
        _agent_id: &str,
        _name: &str,
        _working_dir: Option<&str>,
    ) -> Result<Value, ToolError> {
        Ok(json!({}))
    }

    async fn kill_session(&self, _agent_id: &str, _name: &str) -> Result<Value, ToolError> {
        Ok(json!({}))
    }
}

struct Harness {
    addr: SocketAddr,
    recorder: Arc<Recorder>,
}

async fn start(recorder: Arc<Recorder>) -> Harness {
    start_with(recorder, Config::default()).await
}

struct Config {
    tool_timeout: Duration,
    allowed_origins: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            tool_timeout: Duration::from_secs(2),
            allowed_origins: Vec::new(),
        }
    }
}

async fn start_with(recorder: Arc<Recorder>, config: Config) -> Harness {
    let cluster: Arc<dyn ClusterBackend> = recorder.clone();
    let node: Arc<dyn NodeBackend> = recorder.clone();
    let service = Arc::new(
        McpService::new(
            ServiceConfig {
                tool_timeout: config.tool_timeout,
                allowed_origins: config.allowed_origins,
                ..ServiceConfig::new(TOKEN)
            },
            cluster,
            node,
        )
        .expect("service"),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("address");
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let service = Arc::clone(&service);
            tokio::spawn(async move {
                if let Ok(Sniffed::Http { stream, .. }) =
                    http::sniff(stream, http::DEFAULT_IO_TIMEOUT).await
                {
                    let _ = service.serve(stream).await;
                }
            });
        }
    });
    Harness { addr, recorder }
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

    /// The response body with any chunked transfer coding removed.
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

    /// The JSON value of the response, whether it arrived as one JSON object
    /// or as the final event of a Streamable HTTP SSE stream.
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

async fn request(
    addr: SocketAddr,
    method: &str,
    headers: &[(&str, String)],
    body: &str,
) -> HttpResponse {
    request_to(addr, PATH, method, headers, body).await
}

async fn request_to(
    addr: SocketAddr,
    target: &str,
    method: &str,
    headers: &[(&str, String)],
    body: &str,
) -> HttpResponse {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    let mut head = format!(
        "{method} {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: application/json, \
         text/event-stream\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
         Connection: close\r\n",
        body.len()
    );
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await.expect("write head");
    stream.write_all(body.as_bytes()).await.expect("write body");
    // A response that arrives before the request body is consumed may be
    // followed by a TCP reset; the response bytes are what this client needs.
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw).await;
    assert!(!raw.is_empty(), "the server closed without a response");
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text.split_once("\r\n\r\n").expect("a complete response");
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|status| status.parse().ok())
        .expect("status");
    let headers = lines
        .filter_map(|line| {
            line.split_once(':')
                .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        })
        .collect();
    HttpResponse {
        status,
        headers,
        body: body.to_string(),
    }
}

fn auth() -> Vec<(&'static str, String)> {
    vec![("Authorization", format!("Bearer {TOKEN}"))]
}

fn with_auth(mut headers: Vec<(&'static str, String)>) -> Vec<(&'static str, String)> {
    headers.extend(auth());
    headers
}

fn modern_meta(version: &str) -> Value {
    json!({
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientInfo": { "name": "raw-test", "version": "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
    })
}

fn modern_headers() -> Vec<(&'static str, String)> {
    vec![
        ("MCP-Protocol-Version", MODERN.to_string()),
        ("Mcp-Method", "tools/list".to_string()),
    ]
}

async fn modern(addr: SocketAddr, method: &str, params: Value, name: Option<&str>) -> HttpResponse {
    let mut headers = vec![
        ("MCP-Protocol-Version", MODERN.to_string()),
        ("Mcp-Method", method.to_string()),
    ];
    if let Some(name) = name {
        headers.push(("Mcp-Name", name.to_string()));
    }
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    });
    request(addr, "POST", &with_auth(headers), &body.to_string()).await
}

fn tool_call_params(name: &str, arguments: Value) -> Value {
    json!({
        "name": name,
        "arguments": arguments,
        "_meta": modern_meta(MODERN),
    })
}

fn text_of(result: &Value) -> Value {
    let text = result["content"][0]["text"]
        .as_str()
        .expect("text tool content");
    serde_json::from_str(text).expect("tool text is JSON")
}

#[tokio::test]
async fn modern_discover_reports_both_versions_and_the_server_identity() {
    let harness = start(Arc::default()).await;
    let response = modern(
        harness.addr,
        "server/discover",
        json!({ "_meta": modern_meta(MODERN) }),
        None,
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.body);
    let result = &response.json()["result"];
    let versions = result["supportedVersions"]
        .as_array()
        .expect("supportedVersions");
    assert!(versions.contains(&json!(MODERN)));
    assert!(versions.contains(&json!(LEGACY)));
    assert_eq!(
        result["_meta"]["io.modelcontextprotocol/serverInfo"]["name"],
        "nession"
    );
    assert!(result["capabilities"]["tools"].is_object());
}

#[tokio::test]
async fn modern_stateless_requests_need_no_initialize_and_advertise_four_tools() {
    let harness = start(Arc::default()).await;
    let response = modern(
        harness.addr,
        "tools/list",
        json!({ "_meta": modern_meta(MODERN) }),
        None,
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.body);
    assert!(
        response.header("mcp-session-id").is_none(),
        "2026-07-28 must not mint a session"
    );
    let json = response.json();
    let tools = json["result"]["tools"].as_array().expect("tools");
    let names: Vec<_> = tools
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
    // Modern cache semantics are part of the advertised result, not optional
    // extras on this version.
    assert!(json["result"]["ttlMs"].as_u64().is_some());
    assert_eq!(json["result"]["cacheScope"], "private");
}

#[tokio::test]
async fn modern_tool_calls_reach_the_semantic_backend() {
    let harness = start(Arc::default()).await;
    let agents = modern(
        harness.addr,
        "tools/call",
        tool_call_params("nession_server_list_agents", json!({})),
        Some("nession_server_list_agents"),
    )
    .await;
    assert_eq!(agents.status, 200, "{}", agents.body);
    let result = &agents.json()["result"];
    assert_eq!(result["isError"], false);
    assert_eq!(text_of(result)["agents"][0]["agent_id"], "agent-1");

    let created = modern(
        harness.addr,
        "tools/call",
        tool_call_params(
            "nession_agent_create_session",
            json!({ "agent_id": "agent-1", "name": "work", "working_dir": "/tmp" }),
        ),
        Some("nession_agent_create_session"),
    )
    .await;
    assert_eq!(created.status, 200, "{}", created.body);
    assert_eq!(created.json()["result"]["isError"], false);

    assert_eq!(
        harness.recorder.calls(),
        vec![
            "cluster.list_agents".to_string(),
            "node.create:agent-1:work:Some(\"/tmp\")".to_string(),
        ]
    );
}

#[tokio::test]
async fn invalid_and_unknown_tool_calls_are_tool_errors_not_transport_errors() {
    let harness = start(Arc::default()).await;
    let unknown = modern(
        harness.addr,
        "tools/call",
        tool_call_params("nession_server_get_info", json!({})),
        Some("nession_server_get_info"),
    )
    .await;
    assert_eq!(unknown.status, 200, "{}", unknown.body);
    assert_eq!(unknown.json()["result"]["isError"], true);

    let empty_agent = modern(
        harness.addr,
        "tools/call",
        tool_call_params("nession_agent_list_sessions", json!({ "agent_id": "" })),
        Some("nession_agent_list_sessions"),
    )
    .await;
    assert_eq!(empty_agent.status, 200, "{}", empty_agent.body);
    assert_eq!(empty_agent.json()["result"]["isError"], true);
    assert!(harness.recorder.calls().is_empty());
}

#[tokio::test]
async fn a_retired_camel_case_tool_argument_is_refused_by_its_contract_name() {
    let harness = start(Arc::default()).await;
    let refused = modern(
        harness.addr,
        "tools/call",
        tool_call_params(
            "nession_agent_list_sessions",
            json!({ "agentId": "agent-1" }),
        ),
        Some("nession_agent_list_sessions"),
    )
    .await;
    assert_eq!(refused.status, 200, "{}", refused.body);
    let result = &refused.json()["result"];
    assert_eq!(result["isError"], true);
    let text = result["content"][0]["text"].as_str().expect("text content");
    // #3371: Nession's own argument spelling is `agent_id`; the typed Tool
    // contract refuses the retired camelCase form instead of ignoring it.
    assert!(
        text.contains("agent_id"),
        "the refusal must name the argument: {text}"
    );
    assert!(harness.recorder.calls().is_empty());
}

#[tokio::test]
async fn a_modern_request_without_standard_headers_is_a_header_mismatch() {
    let harness = start(Arc::default()).await;
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/list",
        "params": { "_meta": modern_meta(MODERN) },
    });
    let missing_method = request(
        harness.addr,
        "POST",
        &with_auth(vec![("MCP-Protocol-Version", MODERN.to_string())]),
        &body.to_string(),
    )
    .await;
    assert_eq!(missing_method.status, 400, "{}", missing_method.body);
    assert_eq!(missing_method.json()["error"]["code"], -32020);

    let missing_version = request(
        harness.addr,
        "POST",
        &with_auth(vec![("Mcp-Method", "tools/list".to_string())]),
        &body.to_string(),
    )
    .await;
    assert_eq!(missing_version.status, 400, "{}", missing_version.body);
    assert_eq!(missing_version.json()["error"]["code"], -32020);

    let mismatch = modern(
        harness.addr,
        "tools/call",
        tool_call_params("nession_server_list_agents", json!({})),
        Some("nession_agent_kill_session"),
    )
    .await;
    assert_eq!(mismatch.status, 400, "{}", mismatch.body);
    assert_eq!(mismatch.json()["error"]["code"], -32020);
}

#[tokio::test]
async fn an_unsupported_version_lists_the_supported_versions() {
    let harness = start(Arc::default()).await;
    // Header and body must agree before version support is judged; otherwise
    // the transport correctly reports a header mismatch instead.
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/list",
        "params": { "_meta": modern_meta("1900-01-01") },
    });
    let headers = with_auth(vec![
        ("MCP-Protocol-Version", "1900-01-01".to_string()),
        ("Mcp-Method", "tools/list".to_string()),
    ]);
    let response = request(harness.addr, "POST", &headers, &body.to_string()).await;
    assert_eq!(response.status, 400, "{}", response.body);
    let error = &response.json()["error"];
    assert_eq!(error["code"], -32022, "{error}");
    let supported = error["data"]["supported"]
        .as_array()
        .expect("supported list");
    assert!(supported.contains(&json!(MODERN)));
    assert!(supported.contains(&json!(LEGACY)));
}

#[tokio::test]
async fn the_legacy_initialize_lifecycle_still_works() {
    let harness = start(Arc::default()).await;
    let initialize = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": LEGACY,
            "capabilities": {},
            "clientInfo": { "name": "legacy-test", "version": "1" }
        }
    });
    let response = request(
        harness.addr,
        "POST",
        &with_auth(Vec::new()),
        &initialize.to_string(),
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json()["result"]["protocolVersion"],
        LEGACY,
        "body: {}",
        response.body
    );
    let session = response
        .header("mcp-session-id")
        .expect("legacy session")
        .to_string();

    let initialized = request(
        harness.addr,
        "POST",
        &with_auth(vec![("Mcp-Session-Id", session.clone())]),
        &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string(),
    )
    .await;
    assert_eq!(initialized.status, 202, "{}", initialized.body);

    let list = request(
        harness.addr,
        "POST",
        &with_auth(vec![("Mcp-Session-Id", session.clone())]),
        &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }).to_string(),
    )
    .await;
    assert_eq!(list.status, 200, "{}", list.body);
    assert_eq!(
        list.json()["result"]["tools"]
            .as_array()
            .expect("tools")
            .len(),
        4
    );

    let call = request(
        harness.addr,
        "POST",
        &with_auth(vec![("Mcp-Session-Id", session.clone())]),
        &json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "nession_agent_list_sessions",
                "arguments": { "agent_id": "agent-1" }
            }
        })
        .to_string(),
    )
    .await;
    assert_eq!(call.status, 200, "{}", call.body);
    assert_eq!(call.json()["result"]["isError"], false);

    let delete = request(
        harness.addr,
        "DELETE",
        &with_auth(vec![("Mcp-Session-Id", session.clone())]),
        "",
    )
    .await;
    assert!(delete.status < 300, "DELETE returned {}", delete.status);
    let after = request(
        harness.addr,
        "POST",
        &with_auth(vec![("Mcp-Session-Id", session)]),
        &json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/list" }).to_string(),
    )
    .await;
    assert_eq!(after.status, 404, "{}", after.body);
}

#[tokio::test]
async fn auth_and_path_fail_closed() {
    let harness = start(Arc::default()).await;
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }).to_string();
    let anonymous = request(harness.addr, "POST", &[], &body).await;
    assert_eq!(anonymous.status, 401);
    assert_eq!(anonymous.header("www-authenticate"), Some("Bearer"));

    let wrong = request(
        harness.addr,
        "POST",
        &[("Authorization", "Bearer wrong".to_string())],
        &body,
    )
    .await;
    assert_eq!(wrong.status, 401);
    assert!(wrong.body.is_empty(), "a refusal must not leak detail");

    // A valid token on a different path is not an MCP endpoint.
    let elsewhere = request_to(harness.addr, "/ws", "POST", &with_auth(Vec::new()), &body).await;
    assert_eq!(elsewhere.status, 404);
}

#[tokio::test]
async fn a_present_origin_is_refused_by_default() {
    let harness = start(Arc::default()).await;
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/list",
        "params": { "_meta": modern_meta(MODERN) },
    });
    let mut headers = modern_headers();
    headers.push(("Origin", "https://evil.example".to_string()));
    let response = request(harness.addr, "POST", &with_auth(headers), &body.to_string()).await;
    assert_eq!(response.status, 403, "{}", response.body);
}

#[tokio::test]
async fn a_slow_tool_call_times_out_as_a_tool_error() {
    let recorder = Arc::new(Recorder::default());
    let cluster: Arc<dyn ClusterBackend> = recorder.clone();
    let service = Arc::new(
        McpService::new(
            ServiceConfig {
                tool_timeout: Duration::from_millis(50),
                ..ServiceConfig::new(TOKEN)
            },
            cluster,
            Arc::new(SlowNode),
        )
        .expect("service"),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("address");
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let service = Arc::clone(&service);
            tokio::spawn(async move {
                if let Ok(Sniffed::Http { stream, .. }) =
                    http::sniff(stream, http::DEFAULT_IO_TIMEOUT).await
                {
                    let _ = service.serve(stream).await;
                }
            });
        }
    });

    let response = modern(
        addr,
        "tools/call",
        tool_call_params(
            "nession_agent_list_sessions",
            json!({ "agent_id": "agent-1" }),
        ),
        Some("nession_agent_list_sessions"),
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.body);
    let result = &response.json()["result"];
    assert_eq!(result["isError"], true);
    assert!(text_of(result)["error"]["kind"] == "timeout", "{}", result);
}

/// A valid request whose head and body must survive replay byte for byte.
const REPLAY_REQUEST: &[u8] = b"POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\nhello world";

/// A valid WebSocket upgrade that must survive replay byte for byte.
const REPLAY_UPGRADE: &[u8] = b"GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";

/// Serves `script` in fixed-size chunks and then stays pending forever.
///
/// A parser that waits for a newline or EOF is observably stuck; the shared
/// counter records how many bytes it pulled from the transport, so a test can
/// assert that the oversized line was not drained.
struct ScriptedReader {
    script: Vec<u8>,
    served: usize,
    chunk: usize,
    pulled: Arc<AtomicUsize>,
}

impl ScriptedReader {
    fn new(script: Vec<u8>, chunk: usize) -> (Self, Arc<AtomicUsize>) {
        let pulled = Arc::new(AtomicUsize::new(0));
        (
            Self {
                script,
                served: 0,
                chunk,
                pulled: Arc::clone(&pulled),
            },
            pulled,
        )
    }
}

impl AsyncRead for ScriptedReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if self.served >= self.script.len() {
            return Poll::Pending;
        }
        let end = self
            .served
            .saturating_add(self.chunk)
            .min(self.script.len());
        let available = self.script.get(self.served..end).unwrap_or(&[]);
        let take = available.len().min(buf.remaining());
        let chunk = available.get(..take).unwrap_or(&[]);
        buf.put_slice(chunk);
        self.served = self.served.saturating_add(take);
        self.pulled.store(self.served, Ordering::SeqCst);
        Poll::Ready(Ok(()))
    }
}

#[tokio::test]
async fn an_unterminated_request_line_is_refused_within_the_head_budget() {
    const CHUNK: usize = 512;
    let budget = http::MAX_HEADER_BYTES;
    let (reader, pulled) = ScriptedReader::new(vec![b'G'; budget * 4], CHUNK);

    let outcome = tokio::time::timeout(
        Duration::from_secs(2),
        http::sniff(reader, Duration::from_secs(60)),
    )
    .await
    .expect("an oversized unterminated line must not wait for LF or EOF");

    assert!(
        matches!(outcome, Err(http::HttpError::HeaderTooLarge)),
        "the unterminated request line must be refused as too large"
    );
    let pulled = pulled.load(Ordering::SeqCst);
    assert!(
        pulled <= budget + CHUNK,
        "the parser pulled {pulled} bytes for a {budget}-byte head budget"
    );
}

#[tokio::test]
async fn an_unterminated_header_line_is_refused_within_the_head_budget() {
    const CHUNK: usize = 512;
    let budget = http::MAX_HEADER_BYTES;
    let mut script = b"GET /ws HTTP/1.1\r\nHost: localhost\r\nX-Fill: ".to_vec();
    script.resize(script.len() + budget * 2, b'x');
    let (reader, pulled) = ScriptedReader::new(script, CHUNK);

    let outcome = tokio::time::timeout(
        Duration::from_secs(2),
        http::sniff(reader, Duration::from_secs(60)),
    )
    .await
    .expect("an oversized unterminated line must not wait for LF or EOF");

    assert!(
        matches!(outcome, Err(http::HttpError::HeaderTooLarge)),
        "the unterminated header line must be refused as too large"
    );
    let pulled = pulled.load(Ordering::SeqCst);
    assert!(
        pulled <= budget + CHUNK,
        "the parser pulled {pulled} bytes for a {budget}-byte head budget"
    );
}

#[tokio::test]
async fn a_head_exactly_at_the_budget_is_accepted() {
    let budget = http::MAX_HEADER_BYTES;
    let prefix = b"GET /ws HTTP/1.1\r\nHost: localhost\r\nX-Pad: ";
    let suffix = b"\r\n\r\n";
    let pad = budget - prefix.len() - suffix.len();
    let mut request = prefix.to_vec();
    request.resize(request.len() + pad, b'p');
    request.extend_from_slice(suffix);
    assert_eq!(request.len(), budget);

    let (mut writer, reader) = tokio::io::duplex(budget * 2);
    writer
        .write_all(&request)
        .await
        .expect("write an at-the-limit request");
    let sniffed = http::sniff(reader, http::DEFAULT_IO_TIMEOUT)
        .await
        .expect("a head exactly at the budget is valid");
    drop(writer);

    let Sniffed::Http { mut stream, .. } = sniffed else {
        panic!("expected an HTTP request");
    };
    let mut replay = Vec::new();
    stream.read_to_end(&mut replay).await.expect("read replay");
    assert_eq!(replay, request);
}

#[tokio::test]
async fn a_malformed_header_fails_closed() {
    let (mut writer, reader) = tokio::io::duplex(128);
    writer
        .write_all(b"GET /ws HTTP/1.1\r\nHost: localhost\r\nMissing-Colon\r\n\r\n")
        .await
        .expect("write a malformed request");
    drop(writer);

    let outcome = http::sniff(reader, http::DEFAULT_IO_TIMEOUT).await;
    assert!(
        matches!(outcome, Err(http::HttpError::BadRequest(_))),
        "a header line without a colon must be refused"
    );
}

#[tokio::test]
async fn a_fragmented_request_replays_every_byte() {
    let (mut writer, reader) = tokio::io::duplex(64);
    let writer_task = tokio::spawn(async move {
        for fragment in REPLAY_REQUEST.chunks(5) {
            writer.write_all(fragment).await.expect("write fragment");
            tokio::task::yield_now().await;
        }
    });

    let sniffed = http::sniff(reader, http::DEFAULT_IO_TIMEOUT)
        .await
        .expect("a valid request must classify");
    let Sniffed::Http { head, mut stream } = sniffed else {
        panic!("expected an HTTP request");
    };
    assert_eq!(head.method, "POST");
    assert_eq!(head.path(), "/mcp");
    assert_eq!(head.header("content-length"), Some("11"));

    let mut replay = Vec::new();
    stream.read_to_end(&mut replay).await.expect("read replay");
    assert_eq!(replay, REPLAY_REQUEST);
    writer_task.await.expect("writer task");
}

#[tokio::test]
async fn a_request_buffered_with_its_body_replays_every_byte() {
    let (mut writer, reader) = tokio::io::duplex(256);
    writer
        .write_all(REPLAY_REQUEST)
        .await
        .expect("write the request and body together");
    let sniffed = http::sniff(reader, http::DEFAULT_IO_TIMEOUT)
        .await
        .expect("a valid request must classify");
    drop(writer);

    let Sniffed::Http { mut stream, .. } = sniffed else {
        panic!("expected an HTTP request");
    };
    let mut replay = Vec::new();
    stream.read_to_end(&mut replay).await.expect("read replay");
    assert_eq!(replay, REPLAY_REQUEST);
}

#[tokio::test]
async fn a_fragmented_websocket_upgrade_replays_every_byte() {
    let (mut writer, reader) = tokio::io::duplex(64);
    let writer_task = tokio::spawn(async move {
        for fragment in REPLAY_UPGRADE.chunks(7) {
            writer.write_all(fragment).await.expect("write fragment");
            tokio::task::yield_now().await;
        }
    });

    let sniffed = http::sniff(reader, http::DEFAULT_IO_TIMEOUT)
        .await
        .expect("a valid upgrade must classify");
    let Sniffed::WebSocket { mut stream } = sniffed else {
        panic!("expected a WebSocket upgrade");
    };
    let mut replay = Vec::new();
    stream.read_to_end(&mut replay).await.expect("read replay");
    assert_eq!(replay, REPLAY_UPGRADE);
    writer_task.await.expect("writer task");
}

fn client_config(addr: SocketAddr) -> StreamableHttpClientTransportConfig {
    StreamableHttpClientTransportConfig::with_uri(format!("http://{addr}{PATH}")).auth_header(TOKEN)
}

#[tokio::test]
async fn the_official_client_negotiates_modern_protocol_without_initialize() {
    let harness = start(Arc::default()).await;
    let running = ()
        .serve_with_lifecycle(
            StreamableHttpClientTransport::from_config(client_config(harness.addr)),
            ClientLifecycleMode::Discover {
                preferred_versions: vec![ProtocolVersion::V_2026_07_28],
            },
        )
        .await
        .expect("modern official client");
    let info = running.peer_info().expect("peer info");
    assert_eq!(info.protocol_version, ProtocolVersion::V_2026_07_28);

    let tools = running.list_tools(None).await.expect("tools/list");
    assert_eq!(tools.tools.len(), 4);

    let result = running
        .call_tool(CallToolRequestParams::new("nession_server_list_agents"))
        .await
        .expect("tools/call");
    assert_ne!(result.is_error, Some(true));
    let text = match result.content.first().expect("content") {
        ContentBlock::Text(text) => text.text.clone(),
        other => panic!("unexpected content {other:?}"),
    };
    let reply: Value = serde_json::from_str(&text).expect("reply JSON");
    assert_eq!(reply["agents"][0]["agent_id"], "agent-1");

    running.cancel().await.expect("cancel");
}

#[tokio::test]
async fn the_official_client_keeps_the_legacy_lifecycle() {
    let harness = start(Arc::default()).await;
    let running = ()
        .serve_with_lifecycle(
            StreamableHttpClientTransport::from_config(client_config(harness.addr)),
            ClientLifecycleMode::Initialize,
        )
        .await
        .expect("legacy official client");
    let info = running.peer_info().expect("peer info");
    assert_eq!(info.protocol_version, ProtocolVersion::V_2025_03_26);
    assert!(
        info.capabilities.tools.is_some(),
        "the legacy initialize reply advertises tools"
    );

    let tools = running.list_tools(None).await.expect("tools/list");
    assert_eq!(tools.tools.len(), 4);
    let result = running
        .call_tool(
            CallToolRequestParams::new("nession_agent_create_session").with_arguments(
                json!({ "agent_id": "agent-1", "name": "legacy-work" })
                    .as_object()
                    .expect("arguments")
                    .clone(),
            ),
        )
        .await
        .expect("tools/call");
    assert_ne!(result.is_error, Some(true));
    assert!(harness
        .recorder
        .calls()
        .contains(&"node.create:agent-1:legacy-work:None".to_string()));

    running.cancel().await.expect("cancel");
}

#[test]
fn supported_versions_are_exactly_the_claimed_pair() {
    assert_eq!(
        nession_mcp::protocol::SUPPORTED_PROTOCOL_VERSIONS,
        &[MODERN, LEGACY]
    );
}
