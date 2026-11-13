//! The MCP service: protocol/transport adapter, auth, deadlines, tools (`#3264`).
//!
//! One [`McpService`] answers every hosting mode. A host supplies the two
//! semantic backends and the inbound token; nothing else differs.
//!
//! The wire grammar — `2026-07-28`'s stateless per-request metadata and
//! `Mcp-Method`/`Mcp-Name` header validation, plus the legacy `2025-03-26`
//! `initialize`/`Mcp-Session-Id` lifecycle — belongs to the official `rmcp`
//! SDK. This module owns Nession's policy around it:
//!
//! * fail-closed bearer authentication on every request;
//! * the endpoint path;
//! * the flat Tool registry and its per-call concurrency/deadline bounds;
//! * the stable tool-result shape shared by all three hosts.
//!
//! The registry is built **once** at startup; no request rebuilds the catalog.

use std::borrow::Cow;
use std::convert::Infallible;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http::{Request, Response, StatusCode};
use http_body::Body as HttpBody;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Empty};
use rmcp::model::{
    CacheScope, CallToolResponse, CallToolResult, ContentBlock, Implementation, ListToolsResult,
    PaginatedRequestParams, ProtocolVersion, ServerCapabilities, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::Semaphore;
use tokio::time::timeout;
use tower_service::Service;
use tracing::{info, warn};

use crate::backend::{ClusterBackend, NodeBackend};
use crate::error::ToolError;
use crate::http::PrefixedStream;
use crate::protocol;
use crate::registry::ToolRegistry;
use crate::tool::{reply_is_error, ToolContext};
use crate::tools;

/// The exact response body type the rmcp Streamable HTTP service produces.
type RmcpBody = BoxBody<Bytes, Infallible>;

/// How the service is configured.
#[derive(Debug, Clone)]
pub struct ServiceConfig {
    /// The endpoint path, normally `/mcp`.
    pub path: String,
    /// The required inbound bearer token.
    pub auth_token: String,
    /// Bound on one tool execution (and on waiting for a concurrency slot).
    pub tool_timeout: Duration,
    /// Maximum concurrent tool executions.
    pub max_concurrent_calls: usize,
    /// Browser origins allowed to call the endpoint.
    ///
    /// Empty means **no** browser origin is allowed: a request carrying an
    /// `Origin` header is refused. Requests without `Origin` (MCP clients) pass.
    pub allowed_origins: Vec<String>,
    /// Host header authorities accepted by the transport.
    ///
    /// Empty disables Host validation; the host adapter derives a specific
    /// allowlist whenever the listener binds a concrete host.
    pub allowed_hosts: Vec<String>,
}

impl ServiceConfig {
    /// A config with the protocol defaults and the required token.
    pub fn new(auth_token: impl Into<String>) -> Self {
        Self {
            path: protocol::DEFAULT_PATH.to_string(),
            auth_token: auth_token.into(),
            tool_timeout: Duration::from_secs(protocol::DEFAULT_TOOL_TIMEOUT_SECS),
            max_concurrent_calls: protocol::DEFAULT_MAX_CONCURRENT_CALLS,
            allowed_origins: Vec::new(),
            allowed_hosts: Vec::new(),
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
    /// The explicit Tool registration did not satisfy the registry contract.
    #[error("MCP Tool registry is invalid: {0}")]
    InvalidRegistry(String),
}

/// Derive the Host allowlist for a listener bind address.
///
/// A concrete host is accepted together with loopback. An unspecified bind
/// (`0.0.0.0`/`::`) leaves the transport's Host check disabled: the client
/// chooses whichever interface address it dialled, so an allowlist cannot be
/// derived. Bearer authentication and the Origin policy remain mandatory in
/// that configuration.
pub fn allowed_hosts_for_bind(bind_address: &str) -> Vec<String> {
    let host = match bind_address.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(rest),
        None => bind_address
            .rsplit_once(':')
            .map(|(host, _)| host)
            .unwrap_or(bind_address),
    };
    match host {
        "" | "0.0.0.0" | "::" => Vec::new(),
        "localhost" | "127.0.0.1" | "::1" => {
            vec![
                "localhost".to_string(),
                "127.0.0.1".to_string(),
                "::1".to_string(),
            ]
        }
        concrete => vec![
            concrete.to_string(),
            "localhost".to_string(),
            "127.0.0.1".to_string(),
            "::1".to_string(),
        ],
    }
}

/// The shared MCP access layer.
pub struct McpService {
    path: Arc<str>,
    /// The authenticated, path-scoped tower service in front of rmcp.
    endpoint: AuthorizedMcp,
}

impl McpService {
    /// Build a service and validate its configuration.
    ///
    /// The Tool registry is constructed here, once, from the explicit
    /// registration list in [`crate::tools`].
    pub fn new(
        config: ServiceConfig,
        cluster: Arc<dyn ClusterBackend>,
        node: Arc<dyn NodeBackend>,
    ) -> Result<Self, ServiceConfigError> {
        config.validate()?;
        let registry = tools::registry()
            .map_err(|error| ServiceConfigError::InvalidRegistry(error.to_string()))?;
        let handler = RegistryServer {
            registry: Arc::new(registry),
            context: Arc::new(ToolContext::new(cluster, node)),
            calls: Arc::new(Semaphore::new(config.max_concurrent_calls)),
            tool_timeout: config.tool_timeout,
        };

        let mut transport = StreamableHttpServerConfig::default()
            // Dual-era: `initialize` sessions for legacy versions, stateless
            // per-request metadata for `2026-07-28`.
            .with_legacy_session_mode(true)
            .with_json_response(true)
            .with_stateless_protocol_metadata_required(true);
        // An empty allowlist is not "allow everything": a request presenting a
        // browser Origin is refused, which is the DNS-rebinding boundary.
        transport = if config.allowed_origins.is_empty() {
            transport
                .with_allowed_origins(Vec::<String>::new())
                .enforce_origin_validation()
        } else {
            transport.with_allowed_origins(config.allowed_origins.clone())
        };
        transport = if config.allowed_hosts.is_empty() {
            transport.disable_allowed_hosts()
        } else {
            transport.with_allowed_hosts(config.allowed_hosts.clone())
        };

        let inner: StreamableHttpService<RegistryServer, LocalSessionManager> =
            StreamableHttpService::new(move || Ok(handler.clone()), Default::default(), transport);
        Ok(Self {
            path: Arc::from(config.path.as_str()),
            endpoint: AuthorizedMcp {
                inner,
                path: Arc::from(config.path.as_str()),
                auth_token: Arc::from(config.auth_token.as_str()),
            },
        })
    }

    /// The endpoint path this service answers on.
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Answer one HTTP request on an embedding host's Axum router (`#3439`).
    ///
    /// The host owns the route and the upgrade/routing decision; the service
    /// still owns its path check, bearer authentication and the rmcp transport
    /// semantics. A request reaching this method has already been parsed by the
    /// host's HTTP stack, so no request head is replayed here.
    pub async fn handle<B>(&self, request: Request<B>) -> Response<RmcpBody>
    where
        B: HttpBody + Send + 'static,
        B::Data: Send + 'static,
        B::Error: std::fmt::Display,
    {
        let mut endpoint = self.endpoint.clone();
        match endpoint.call(request).await {
            Ok(response) => response,
            Err(never) => match never {},
        }
    }

    /// Serve one replayed HTTP connection.
    ///
    /// The standalone MCP host owns its listener and uses this; embedded
    /// Server/Agent hosts mount [`Self::handle`] on their Axum router instead.
    pub async fn serve<S>(&self, stream: PrefixedStream<S>) -> io::Result<()>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let endpoint = self.endpoint.clone();
        let connection = hyper::server::conn::http1::Builder::new()
            // A configured header timeout needs an explicit timer in hyper 1.x.
            .timer(hyper_util::rt::TokioTimer::new())
            .header_read_timeout(Duration::from_secs(10))
            .serve_connection(
                hyper_util::rt::TokioIo::new(stream),
                hyper::service::service_fn(move |request| {
                    let mut endpoint = endpoint.clone();
                    async move { Service::call(&mut endpoint, request).await }
                }),
            );
        connection.await.map_err(io::Error::other)
    }
}

/// The MCP handler rmcp drives: flat registry, bounded execution, stable result
/// shape.
#[derive(Clone)]
struct RegistryServer {
    registry: Arc<ToolRegistry>,
    context: Arc<ToolContext>,
    calls: Arc<Semaphore>,
    tool_timeout: Duration,
}

impl ServerHandler for RegistryServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                protocol::SERVER_NAME,
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(
                "Nession MCP: `nession_server_list_agents` answers from the Nession Server's \
                 cluster registry; `nession_agent_*` tools act on the explicitly named Agent \
                 node and never fall back to the host running MCP.",
            )
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Owned(vec![
            ProtocolVersion::V_2026_07_28,
            ProtocolVersion::V_2025_03_26,
        ])
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult::with_all_items(self.registry.list())
            .with_ttl_ms(protocol::TOOLS_LIST_TTL_MS)
            .with_cache_scope(CacheScope::Private))
    }

    async fn call_tool(
        &self,
        request: rmcp::model::CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let name = request.name.to_string();
        let arguments = request.arguments;

        let permit = match timeout(self.tool_timeout, Arc::clone(&self.calls).acquire_owned()).await
        {
            Ok(Ok(permit)) => permit,
            Ok(Err(_)) => {
                return Ok(CallToolResponse::Complete(tool_error_result(
                    &ToolError::unavailable("the MCP tool executor is shutting down"),
                )))
            }
            Err(_) => {
                return Ok(CallToolResponse::Complete(tool_error_result(
                    &ToolError::timeout("the MCP tool executor is saturated; retry later"),
                )))
            }
        };

        let outcome = timeout(
            self.tool_timeout,
            self.registry.call(&self.context, &name, arguments),
        )
        .await;
        drop(permit);

        Ok(CallToolResponse::Complete(match outcome {
            Ok(Ok(reply)) => {
                let is_error = reply_is_error(&reply);
                info!(tool = %name, is_error, "MCP tool call completed");
                tool_result(&reply)
            }
            Ok(Err(error)) => {
                warn!(tool = %name, kind = error.kind.as_str(), "MCP tool call failed");
                tool_error_result(&error)
            }
            Err(_) => {
                warn!(tool = %name, "MCP tool call timed out");
                tool_error_result(&ToolError::timeout(format!(
                    "tool `{name}` did not answer in time"
                )))
            }
        }))
    }
}

/// The stable `tools/call` result shape.
///
/// The owner's reply is rendered as pretty JSON in a text block; a delivered
/// refusal sets `isError`. This is the same shape in every hosting mode.
fn tool_result(value: &Value) -> CallToolResult {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string());
    let content = vec![ContentBlock::text(text)];
    if reply_is_error(value) {
        CallToolResult::error(content)
    } else {
        CallToolResult::success(content)
    }
}

/// The stable structured error shape for a tool-level failure.
fn tool_error_result(error: &ToolError) -> CallToolResult {
    let payload = json!({
        "error": {
            "kind": error.kind.as_str(),
            "message": error.message,
        }
    });
    let text = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| error.message.clone());
    CallToolResult::error(vec![ContentBlock::text(text)])
}

/// The bearer/path gate in front of the rmcp service.
#[derive(Clone)]
struct AuthorizedMcp {
    inner: StreamableHttpService<RegistryServer, LocalSessionManager>,
    path: Arc<str>,
    auth_token: Arc<str>,
}

impl AuthorizedMcp {
    fn unauthorized() -> Response<RmcpBody> {
        Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .header("WWW-Authenticate", "Bearer")
            .body(empty_body())
            .unwrap_or_else(|_| Response::new(empty_body()))
    }

    fn not_found() -> Response<RmcpBody> {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(empty_body())
            .unwrap_or_else(|_| Response::new(empty_body()))
    }
}

fn empty_body() -> RmcpBody {
    Empty::<Bytes>::new().boxed()
}

impl<B> Service<Request<B>> for AuthorizedMcp
where
    B: HttpBody + Send + 'static,
    B::Data: Send + 'static,
    B::Error: std::fmt::Display,
{
    type Response = Response<RmcpBody>;
    type Error = Infallible;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn call(&mut self, request: Request<B>) -> Self::Future {
        if request.uri().path() != &*self.path {
            return Box::pin(async { Ok(Self::not_found()) });
        }
        if !authorized_by(&request, &self.auth_token) {
            warn!("MCP request refused: no valid bearer token");
            return Box::pin(async { Ok(Self::unauthorized()) });
        }
        let mut inner = self.inner.clone();
        Box::pin(async move {
            match inner.call(request).await {
                Ok(response) => Ok(response),
                Err(never) => match never {},
            }
        })
    }

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
}

fn authorized_by<B>(request: &Request<B>, expected: &str) -> bool {
    let Some(value) = request
        .headers()
        .get(http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
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
    constant_time_eq(presented.trim(), expected)
}

/// Compare a presented token with the configured one without an early exit.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_compare_by_content_and_length() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("ab", "abc"));
        assert!(!constant_time_eq("", "abc"));
    }
}
