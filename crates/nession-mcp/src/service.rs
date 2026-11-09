//! The MCP Streamable HTTP service: lifecycle, auth, tools, sessions.
//!
//! One [`McpService`] answers every hosting mode. A host supplies the two
//! backends and the inbound token; nothing else differs.
//!
//! ## Inbound authentication
//!
//! Every request to the MCP endpoint must carry `Authorization: Bearer …`.
//! The token is the host's configured MCP token (a host reuses its native
//! token source — see the mode table in the requirement); a standalone host
//! configures its own. Missing, malformed and wrong tokens are indistinguishable
//! to the peer, and no token ever enters a tool schema, argument, result or log.
//!
//! ## Lifecycle
//!
//! `initialize` negotiates the protocol version and creates an
//! `Mcp-Session-Id`; subsequent requests must present it, `notifications/
//! initialized` marks the session ready, and `DELETE` terminates it. The store
//! is bounded and idle-expired, so an abandoned session cannot grow the host.
//!
//! Tool executions are bounded by [`ServiceConfig::tool_timeout`] and by a
//! semaphore, so a slow backend cannot consume the host's tasks or block its
//! heartbeat.

use std::collections::HashMap;
use std::io;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::Semaphore;
use tracing::{debug, info, warn};

use crate::backend::{ClusterBackend, NodeBackend};
use crate::error::ToolError;
use crate::http::{self, HttpError, PrefixedStream, RequestHead, Response};
use crate::jsonrpc::{codes, ErrorResponse, Request, SuccessResponse};
use crate::protocol;
use crate::tools;

/// How the service is configured.
#[derive(Debug, Clone)]
pub struct ServiceConfig {
    /// The endpoint path, normally `/mcp`.
    pub path: String,
    /// The required bearer token.
    pub auth_token: String,
    /// Bound on one tool execution (and on waiting for a concurrency slot).
    pub tool_timeout: Duration,
    /// Maximum concurrent tool executions.
    pub max_concurrent_calls: usize,
    /// Idle lifetime of one MCP session.
    pub session_idle: Duration,
    /// Maximum live MCP sessions.
    pub max_sessions: usize,
}

impl ServiceConfig {
    /// A config with the protocol defaults and the required token.
    pub fn new(auth_token: impl Into<String>) -> Self {
        Self {
            path: protocol::DEFAULT_PATH.to_string(),
            auth_token: auth_token.into(),
            tool_timeout: Duration::from_secs(protocol::DEFAULT_TOOL_TIMEOUT_SECS),
            max_concurrent_calls: protocol::DEFAULT_MAX_CONCURRENT_CALLS,
            session_idle: Duration::from_secs(protocol::DEFAULT_SESSION_IDLE_SECS),
            max_sessions: protocol::DEFAULT_MAX_SESSIONS,
        }
    }

    /// Fail closed on a configuration that cannot authenticate or serve.
    pub fn validate(&self) -> Result<(), ServiceConfigError> {
        if self.auth_token.trim().is_empty() {
            return Err(ServiceConfigError::EmptyAuthToken);
        }
        if !self.path.starts_with('/') || self.path.len() < 2 {
            return Err(ServiceConfigError::InvalidPath(self.path.clone()));
        }
        if self.tool_timeout.is_zero() {
            return Err(ServiceConfigError::InvalidTimeout);
        }
        if self.max_concurrent_calls == 0 {
            return Err(ServiceConfigError::InvalidConcurrency);
        }
        if self.max_sessions == 0 {
            return Err(ServiceConfigError::InvalidSessionBound);
        }
        Ok(())
    }
}

/// Why a host refused to enable MCP.
#[derive(Debug, Clone, thiserror::Error)]
pub enum ServiceConfigError {
    /// The token is empty: the endpoint would be anonymous.
    #[error(
        "MCP is enabled but its inbound auth token is empty; refusing to expose an anonymous \
         MCP endpoint (fail closed)"
    )]
    EmptyAuthToken,
    /// The path is not an absolute HTTP path.
    #[error("MCP path must be an absolute HTTP path such as `/mcp`; got {0:?}")]
    InvalidPath(String),
    /// The tool deadline is zero.
    #[error("MCP tool_timeout_secs must be greater than zero")]
    InvalidTimeout,
    /// The concurrency bound is zero.
    #[error("MCP max_concurrent_calls must be greater than zero")]
    InvalidConcurrency,
    /// The session bound is zero.
    #[error("MCP max_sessions must be greater than zero")]
    InvalidSessionBound,
}

struct Session {
    last_seen: Instant,
    initialized: bool,
}

struct SessionStore {
    sessions: HashMap<String, Session>,
    idle: Duration,
    max: usize,
}

impl SessionStore {
    fn new(idle: Duration, max: usize) -> Self {
        Self {
            sessions: HashMap::new(),
            idle,
            max,
        }
    }

    fn prune(&mut self) {
        let now = Instant::now();
        let idle = self.idle;
        self.sessions
            .retain(|_, session| now.duration_since(session.last_seen) <= idle);
    }

    fn create(&mut self) -> String {
        self.prune();
        if self.sessions.len() >= self.max {
            // Evict the least recently used session rather than refusing every
            // later initialisation. A live client that keeps calling stays
            // recent; the oldest abandoned session is the safest to drop.
            if let Some(oldest) = self
                .sessions
                .iter()
                .min_by_key(|(_, session)| session.last_seen)
                .map(|(id, _)| id.clone())
            {
                self.sessions.remove(&oldest);
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.sessions.insert(
            id.clone(),
            Session {
                last_seen: Instant::now(),
                initialized: false,
            },
        );
        id
    }

    fn touch(&mut self, id: &str) -> bool {
        match self.sessions.get_mut(id) {
            Some(session) => {
                session.last_seen = Instant::now();
                true
            }
            None => false,
        }
    }

    fn mark_initialized(&mut self, id: &str) -> bool {
        match self.sessions.get_mut(id) {
            Some(session) => {
                session.last_seen = Instant::now();
                session.initialized = true;
                true
            }
            None => false,
        }
    }

    fn remove(&mut self, id: &str) -> bool {
        self.sessions.remove(id).is_some()
    }
}

/// The shared MCP access layer.
pub struct McpService {
    config: ServiceConfig,
    cluster: std::sync::Arc<dyn ClusterBackend>,
    node: std::sync::Arc<dyn NodeBackend>,
    sessions: Mutex<SessionStore>,
    calls: Semaphore,
}

impl McpService {
    /// Build a service and validate its configuration.
    pub fn new(
        config: ServiceConfig,
        cluster: std::sync::Arc<dyn ClusterBackend>,
        node: std::sync::Arc<dyn NodeBackend>,
    ) -> Result<Self, ServiceConfigError> {
        config.validate()?;
        Ok(Self {
            calls: Semaphore::new(config.max_concurrent_calls),
            sessions: Mutex::new(SessionStore::new(config.session_idle, config.max_sessions)),
            config,
            cluster,
            node,
        })
    }

    /// The endpoint path this service answers on.
    pub fn path(&self) -> &str {
        &self.config.path
    }

    /// Read one HTTP request and write its response on the same stream.
    ///
    /// A malformed request is answered with the closest HTTP status the parser
    /// can name; the connection is always closed afterwards, so one bad
    /// request cannot become a persistent half-open task.
    pub async fn serve<S>(&self, head: RequestHead, mut body: PrefixedStream<S>) -> io::Result<()>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        let response = self.handle(head, &mut body).await;
        http::write_response(&mut body, response).await
    }

    async fn handle<S>(&self, head: RequestHead, body: &mut S) -> Response
    where
        S: AsyncRead + Unpin,
    {
        let request_id = uuid::Uuid::new_v4().to_string();

        if head.path() != self.config.path {
            return Response::empty(404);
        }
        if !self.authorized(&head) {
            warn!(request_id = %request_id, "MCP request refused: no valid bearer token");
            return Response::empty(401).with_header("WWW-Authenticate", "Bearer");
        }
        if let Some(version) = head.header("mcp-protocol-version") {
            if !protocol::SUPPORTED_PROTOCOL_VERSIONS.contains(&version) {
                return json_response(
                    400,
                    &ErrorResponse::new(
                        None,
                        codes::INVALID_REQUEST,
                        format!("unsupported MCP protocol version `{version}`"),
                    )
                    .with_data(json!({
                        "supported": protocol::SUPPORTED_PROTOCOL_VERSIONS,
                    })),
                    None,
                );
            }
        }

        match head.method.as_str() {
            "POST" => {
                let bytes = match http::read_body(body, &head, http::DEFAULT_IO_TIMEOUT).await {
                    Ok(bytes) => bytes,
                    Err(error) => return self.http_error_response(error),
                };
                self.handle_post(&head, &bytes).await
            }
            "DELETE" => self.handle_delete(&head),
            "GET" => Response::empty(405).with_header("Allow", "POST, DELETE"),
            _ => Response::empty(405).with_header("Allow", "POST, DELETE"),
        }
    }

    fn authorized(&self, head: &RequestHead) -> bool {
        let Some(value) = head.header("authorization") else {
            return false;
        };
        let mut parts = value.splitn(2, ' ');
        let scheme = parts.next().unwrap_or_default();
        if !scheme.eq_ignore_ascii_case("bearer") {
            return false;
        }
        let Some(presented) = parts.next() else {
            return false;
        };
        constant_time_eq(presented.trim(), &self.config.auth_token)
    }

    fn http_error_response(&self, error: HttpError) -> Response {
        match error {
            HttpError::Timeout => Response::empty(408),
            HttpError::HeaderTooLarge | HttpError::BodyTooLarge => Response::empty(413),
            HttpError::BadRequest(message) => json_response(
                400,
                &ErrorResponse::new(None, codes::INVALID_REQUEST, message.to_string()),
                None,
            ),
            HttpError::Io(error) => {
                warn!(%error, "MCP request body read failed");
                Response::empty(400)
            }
        }
    }

    fn handle_delete(&self, head: &RequestHead) -> Response {
        let Some(session_id) = head.header("mcp-session-id") else {
            return Response::empty(400);
        };
        let mut store = self.lock_sessions();
        if store.remove(session_id) {
            Response::empty(200)
        } else {
            Response::empty(404)
        }
    }

    async fn handle_post(&self, head: &RequestHead, bytes: &[u8]) -> Response {
        let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
            return json_response(
                400,
                &ErrorResponse::new(None, codes::PARSE_ERROR, "invalid JSON body"),
                None,
            );
        };

        let items = match value {
            Value::Array(items) => items,
            other => vec![other],
        };
        if items.is_empty() {
            return json_response(
                400,
                &ErrorResponse::new(None, codes::INVALID_REQUEST, "empty batch"),
                None,
            );
        }

        let mut parsed: Vec<Result<Request, ErrorResponse>> = Vec::with_capacity(items.len());
        for item in items {
            match serde_json::from_value::<Request>(item) {
                Ok(request) if request.jsonrpc == "2.0" => parsed.push(Ok(request)),
                Ok(_) => parsed.push(Err(ErrorResponse::new(
                    None,
                    codes::INVALID_REQUEST,
                    "jsonrpc must be \"2.0\"",
                ))),
                Err(_) => parsed.push(Err(ErrorResponse::new(
                    None,
                    codes::INVALID_REQUEST,
                    "not a JSON-RPC request",
                ))),
            }
        }

        let has_initialize = parsed.iter().any(|entry| {
            entry
                .as_ref()
                .map(|request| request.method == "initialize")
                .unwrap_or(false)
        });
        let header_session = head.header("mcp-session-id").map(str::to_string);

        let mut session_id = match &header_session {
            Some(id) => {
                let mut store = self.lock_sessions();
                if !store.touch(id) {
                    if !has_initialize {
                        return Response::empty(404);
                    }
                    None
                } else {
                    Some(id.clone())
                }
            }
            None => None,
        };

        if session_id.is_none() && !has_initialize {
            return json_response(
                400,
                &ErrorResponse::new(
                    None,
                    codes::INVALID_REQUEST,
                    "Mcp-Session-Id is required; send initialize first",
                ),
                None,
            );
        }

        let mut responses: Vec<Value> = Vec::new();
        for entry in parsed {
            match entry {
                Err(error) => {
                    responses.push(serde_json::to_value(error).unwrap_or(Value::Null));
                }
                Ok(request) => {
                    let is_initialize = request.method == "initialize";
                    if is_initialize {
                        let new_id = self.lock_sessions().create();
                        session_id = Some(new_id);
                    }
                    if let Some(response) =
                        self.process_request(request, session_id.as_deref()).await
                    {
                        responses.push(response);
                    }
                }
            }
        }

        if responses.is_empty() {
            // Notifications only: the transport acknowledges with 202 and no
            // body, which is the positive receipt for an MCP notification.
            return Response::empty(202);
        }

        let payload = if responses.len() == 1 {
            responses.into_iter().next().unwrap_or(Value::Null)
        } else {
            Value::Array(responses)
        };
        let body = serde_json::to_vec(&payload).unwrap_or_default();
        let mut response = Response::json(200, body).with_header("Cache-Control", "no-store");
        if let Some(id) = session_id {
            response = response.with_header("Mcp-Session-Id", id);
        }
        response
    }

    async fn process_request(&self, request: Request, session_id: Option<&str>) -> Option<Value> {
        let is_notification = request.is_notification();
        let id = request.id.clone();

        if is_notification {
            if request.method == "notifications/initialized" {
                if let Some(session) = session_id {
                    self.lock_sessions().mark_initialized(session);
                }
            } else if request.method == "notifications/cancelled" {
                debug!("MCP client cancelled a request");
            }
            return None;
        }

        let response = match request.method.as_str() {
            "initialize" => SuccessResponse {
                jsonrpc: "2.0",
                id,
                result: initialize_result(),
            },
            "ping" => SuccessResponse {
                jsonrpc: "2.0",
                id,
                result: json!({}),
            },
            "tools/list" => SuccessResponse {
                jsonrpc: "2.0",
                id,
                result: json!({
                    "tools": tools::catalog()
                        .iter()
                        .map(tools::ToolDefinition::to_wire)
                        .collect::<Vec<_>>(),
                }),
            },
            "tools/call" => match self.tool_call(request.params).await {
                Ok(result) => SuccessResponse {
                    jsonrpc: "2.0",
                    id,
                    result: tool_result(&result),
                },
                Err(error) => SuccessResponse {
                    jsonrpc: "2.0",
                    id,
                    result: tool_error_result(&error),
                },
            },
            other => {
                return Some(
                    serde_json::to_value(ErrorResponse::new(
                        id,
                        codes::METHOD_NOT_FOUND,
                        format!("method `{other}` is not supported"),
                    ))
                    .unwrap_or(Value::Null),
                );
            }
        };

        Some(serde_json::to_value(response).unwrap_or(Value::Null))
    }

    async fn tool_call(&self, params: Option<Value>) -> Result<Value, ToolError> {
        let params = params.unwrap_or(Value::Null);
        let Some(name) = params.get("name").and_then(Value::as_str) else {
            return Err(ToolError::invalid_argument("`name` is required"));
        };
        if !tools::catalog().iter().any(|tool| tool.name == name) {
            return Err(ToolError::invalid_argument(format!(
                "unknown tool `{name}`"
            )));
        }
        let arguments = params.get("arguments").cloned();

        let permit =
            match tokio::time::timeout(self.config.tool_timeout, self.calls.acquire()).await {
                Ok(Ok(permit)) => permit,
                Ok(Err(_)) => {
                    return Err(ToolError::unavailable(
                        "the MCP tool executor is shutting down",
                    ))
                }
                Err(_) => {
                    return Err(ToolError::timeout(
                        "the MCP tool executor is saturated; retry later",
                    ))
                }
            };

        let outcome = tokio::time::timeout(
            self.config.tool_timeout,
            tools::call(name, arguments.as_ref(), &*self.cluster, &*self.node),
        )
        .await;
        drop(permit);

        match outcome {
            Ok(result) => {
                let failed = result.as_ref().map(tools::reply_is_error).unwrap_or(true);
                info!(tool = name, is_error = failed, "MCP tool call completed");
                result
            }
            Err(_) => {
                warn!(tool = name, "MCP tool call timed out");
                Err(ToolError::timeout(format!(
                    "tool `{name}` did not answer in time"
                )))
            }
        }
    }

    fn lock_sessions(&self) -> std::sync::MutexGuard<'_, SessionStore> {
        // A poisoned lock is recovered: the store holds session ids and
        // `Instant`s, so a panic elsewhere cannot have left it inconsistent,
        // and refusing every MCP call forever would turn a local panic into a
        // permanent endpoint outage.
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn initialize_result() -> Value {
    json!({
        "protocolVersion": protocol::PROTOCOL_VERSION,
        "capabilities": {
            "tools": {}
        },
        "serverInfo": {
            "name": protocol::SERVER_NAME,
            "version": env!("CARGO_PKG_VERSION"),
        },
        "instructions": "Nession MCP: `nession_server_*` tools answer from the Nession Server's \
            cluster view; `nession_agent_*` tools act on the explicitly named Agent node.",
    })
}

fn tool_result(value: &Value) -> Value {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string());
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": tools::reply_is_error(value),
    })
}

fn tool_error_result(error: &ToolError) -> Value {
    let payload = json!({
        "error": {
            "kind": error.kind.as_str(),
            "message": error.message,
        }
    });
    let text = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| error.message.clone());
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": true,
    })
}

fn json_response(status: u16, error: &ErrorResponse, session_id: Option<&str>) -> Response {
    let body = serde_json::to_vec(error).unwrap_or_default();
    let mut response = Response::json(status, body);
    if let Some(id) = session_id {
        response = response.with_header("Mcp-Session-Id", id);
    }
    response.with_header("Cache-Control", "no-store")
}

fn constant_time_eq(presented: &str, expected: &str) -> bool {
    let presented = presented.as_bytes();
    let expected = expected.as_bytes();
    let mut difference = presented.len() ^ expected.len();
    let longest = presented.len().max(expected.len());
    for index in 0..longest {
        let left = presented.get(index).copied().unwrap_or(0);
        let right = expected.get(index).copied().unwrap_or(0);
        difference |= usize::from(left ^ right);
    }
    difference == 0
}

/// Whether `id` is a supported negotiated protocol version.
pub fn supports_protocol_version(version: &str) -> bool {
    protocol::SUPPORTED_PROTOCOL_VERSIONS.contains(&version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::UnavailableNodeBackend;
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::Arc;

    struct TestCluster {
        delay: std::time::Duration,
    }

    #[async_trait]
    impl ClusterBackend for TestCluster {
        async fn list_agents(&self) -> Result<Value, ToolError> {
            tokio::time::sleep(self.delay).await;
            Ok(json!({ "agents": [] }))
        }
        async fn list_sessions(
            &self,
            _agent_id: Option<&str>,
            _force: bool,
        ) -> Result<Value, ToolError> {
            Ok(json!({ "sessions": [], "stale_agents": [] }))
        }
        async fn get_info(&self) -> Result<Value, ToolError> {
            Ok(json!({ "version": "test" }))
        }
        async fn capture_session_preview(
            &self,
            _session_id: &str,
            _lines: u32,
        ) -> Result<Value, ToolError> {
            Ok(json!({ "error": "not here" }))
        }
        async fn get_session_attach_info(&self, _session_id: &str) -> Result<Value, ToolError> {
            Ok(json!({ "session_id": "a:b" }))
        }
        async fn create_session(&self, _agent_id: &str, _name: &str) -> Result<Value, ToolError> {
            Ok(json!({ "success": false, "error": "offline" }))
        }
        async fn kill_session(&self, _session_id: &str) -> Result<Value, ToolError> {
            Ok(json!({ "success": false, "error": "missing" }))
        }
        async fn rename_agent(
            &self,
            _agent_id: &str,
            _display_name: Option<&str>,
        ) -> Result<Value, ToolError> {
            Ok(json!({ "success": true }))
        }
        async fn delete_agent(&self, _agent_id: &str) -> Result<Value, ToolError> {
            Ok(json!({ "success": true }))
        }
    }

    fn service() -> Arc<McpService> {
        service_with(TestCluster {
            delay: std::time::Duration::ZERO,
        })
    }

    fn service_with(cluster: TestCluster) -> Arc<McpService> {
        Arc::new(
            McpService::new(
                ServiceConfig::new("secret"),
                Arc::new(cluster),
                Arc::new(UnavailableNodeBackend::new("no node")),
            )
            .expect("service"),
        )
    }

    fn post() -> RequestHead {
        RequestHead {
            method: "POST".to_string(),
            target: "/mcp".to_string(),
            version: "HTTP/1.1".to_string(),
            headers: vec![("authorization".to_string(), "Bearer secret".to_string())],
        }
    }

    #[tokio::test]
    async fn an_anonymous_request_is_refused() {
        let service = service();
        let head = RequestHead {
            method: "POST".to_string(),
            target: "/mcp".to_string(),
            version: "HTTP/1.1".to_string(),
            headers: Vec::new(),
        };
        let response = service.handle(head, &mut b"{}".as_slice()).await;
        assert_eq!(response.status, 401);
    }

    #[tokio::test]
    async fn initialize_creates_a_session_and_tools_list_uses_it() {
        let service = service();
        let body = br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}"#.to_vec();
        let response = service.handle_post(&post(), &body).await;
        assert_eq!(response.status, 200);
        let session = response
            .headers
            .iter()
            .find(|(name, _)| name == "Mcp-Session-Id")
            .map(|(_, value)| value.clone())
            .expect("session header");
        assert!(!session.is_empty());

        let list = br#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#.to_vec();
        let mut head = post();
        head.headers.push(("mcp-session-id".to_string(), session));
        let response = service.handle_post(&head, &list).await;
        assert_eq!(response.status, 200);
        let payload: Value = serde_json::from_slice(&response.body).expect("json");
        let tools = payload
            .get("result")
            .and_then(|value| value.get("tools"))
            .and_then(Value::as_array)
            .expect("tools");
        assert_eq!(tools.len(), 12);
    }

    #[tokio::test]
    async fn a_tool_refusal_is_an_error_result_not_a_transport_error() {
        let service = service();
        let init = br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#.to_vec();
        let response = service.handle_post(&post(), &init).await;
        let session = response
            .headers
            .iter()
            .find(|(name, _)| name == "Mcp-Session-Id")
            .map(|(_, value)| value.clone())
            .expect("session");

        let call = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "nession_server_create_session",
                "arguments": { "agent_id": "a", "name": "n" }
            }
        })
        .to_string()
        .into_bytes();
        let mut head = post();
        head.headers.push(("mcp-session-id".to_string(), session));
        let response = service.handle_post(&head, &call).await;
        assert_eq!(response.status, 200);
        let payload: Value = serde_json::from_slice(&response.body).expect("json");
        assert_eq!(
            payload
                .get("result")
                .and_then(|value| value.get("isError"))
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[tokio::test]
    async fn a_notification_only_body_is_accepted_with_202() {
        let service = service();
        let body = br#"{"jsonrpc":"2.0","method":"notifications/cancelled"}"#.to_vec();
        let response = service.handle_post(&post(), &body).await;
        // No session: the transport refuses before the notification is read.
        assert_eq!(response.status, 400);

        let init = br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#.to_vec();
        let init_response = service.handle_post(&post(), &init).await;
        let session = init_response
            .headers
            .iter()
            .find(|(name, _)| name == "Mcp-Session-Id")
            .map(|(_, value)| value.clone())
            .expect("session");
        let mut head = post();
        head.headers.push(("mcp-session-id".to_string(), session));
        let response = service.handle_post(&head, &body).await;
        assert_eq!(response.status, 202);
        assert!(response.body.is_empty());
    }

    #[tokio::test]
    async fn an_unknown_path_is_not_found() {
        let service = service();
        let mut head = post();
        head.target = "/ws".to_string();
        let response = service.handle(head, &mut b"{}".as_slice()).await;
        assert_eq!(response.status, 404);
    }

    #[tokio::test]
    async fn tools_are_identical_across_every_catalog_read() {
        let first = serde_json::to_value(
            tools::catalog()
                .iter()
                .map(tools::ToolDefinition::to_wire)
                .collect::<Vec<_>>(),
        )
        .expect("json");
        let second = serde_json::to_value(
            tools::catalog()
                .iter()
                .map(tools::ToolDefinition::to_wire)
                .collect::<Vec<_>>(),
        )
        .expect("json");
        assert_eq!(first, second);
    }

    #[test]
    fn tokens_compare_by_content_and_length() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("ab", "abc"));
        assert!(!constant_time_eq("", "abc"));
    }

    async fn _assert_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<McpService>();
    }

    async fn session_for(service: &McpService) -> String {
        let init = br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#.to_vec();
        let response = service.handle_post(&post(), &init).await;
        response
            .headers
            .iter()
            .find(|(name, _)| name == "Mcp-Session-Id")
            .map(|(_, value)| value.clone())
            .expect("session")
    }

    async fn raw_call(
        service: &McpService,
        session: &str,
        id: u64,
        name: &str,
        arguments: Value,
    ) -> Value {
        let body = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": { "name": name, "arguments": arguments }
        })
        .to_string()
        .into_bytes();
        let mut head = post();
        head.headers
            .push(("mcp-session-id".to_string(), session.to_string()));
        let response = service.handle_post(&head, &body).await;
        assert_eq!(response.status, 200);
        serde_json::from_slice(&response.body).expect("json")
    }

    async fn call(service: &McpService, session: &str, name: &str, arguments: Value) -> Value {
        raw_call(service, session, 2, name, arguments)
            .await
            .get("result")
            .cloned()
            .expect("result")
    }

    #[tokio::test]
    async fn a_slow_backend_times_out_as_a_tool_error() {
        let config = ServiceConfig {
            tool_timeout: std::time::Duration::from_millis(20),
            ..ServiceConfig::new("secret")
        };
        let service = Arc::new(
            McpService::new(
                config,
                Arc::new(TestCluster {
                    delay: std::time::Duration::from_millis(200),
                }),
                Arc::new(UnavailableNodeBackend::new("no node")),
            )
            .expect("service"),
        );
        let session = session_for(&service).await;
        let result = call(&service, &session, "nession_server_list_agents", json!({})).await;
        assert_eq!(result["isError"], true);
        let text = result["content"][0]["text"].as_str().expect("text");
        assert!(text.contains("timeout"), "{text}");
    }

    #[tokio::test]
    async fn concurrent_calls_keep_their_own_ids() {
        let service = service();
        let session = session_for(&service).await;
        let (first, second) = tokio::join!(
            raw_call(
                &service,
                &session,
                11,
                "nession_server_list_sessions",
                json!({})
            ),
            raw_call(&service, &session, 12, "nession_server_get_info", json!({})),
        );
        assert_eq!(first["id"], 11);
        assert_eq!(second["id"], 12);
        assert_eq!(first["result"]["isError"], false);
        assert_eq!(second["result"]["isError"], false);
    }

    #[tokio::test]
    async fn a_missing_required_argument_is_an_argument_error() {
        let service = service();
        let session = session_for(&service).await;
        let result = call(
            &service,
            &session,
            "nession_server_create_session",
            json!({ "agent_id": "a" }),
        )
        .await;
        assert_eq!(result["isError"], true);
        let text = result["content"][0]["text"].as_str().expect("text");
        assert!(text.contains("name"), "{text}");
    }
}
