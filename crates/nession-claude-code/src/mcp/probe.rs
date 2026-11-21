//! Bounded MCP capability discovery for an explicitly inspected entry
//! (#3600).
//!
//! ## What this module will and will not do
//!
//! It performs the MCP `initialize` handshake and, only for capabilities the
//! server advertises, `tools/list`, `resources/list` and `prompts/list`. It
//! never calls `tools/call`, never follows an HTTP redirect, never reads a
//! body past its bound, and never starts a stdio process without an explicit
//! `allow_stdio` consent.
//!
//! ## The observation is not the loaded session
//!
//! A successful answer means "this endpoint answered from this process now".
//! It says nothing about whether an already-running Claude session loaded the
//! server. The contract keeps `load_state: unknown`; the caller must present
//! the probe as its own fact.
//!
//! ## Secrets stay inside
//!
//! Header values and env values are expanded and used, never returned. Error
//! text from the remote or from a stdio server's stderr is redacted against the
//! values this call supplied before it is truncated into a protocol response.

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

use crate::protocol::mcp_server::v1::{
    McpProbeResultV1, McpProbeSourceV1, McpProbeStatusV1, McpPromptV1, McpResourceV1, McpToolV1,
};
use crate::protocol::mcp_servers::v1::McpTransportV1;
use crate::session_context::SessionContext;

use super::config::{RawDefinition, Roots};
use super::sanitize;

/// One discovery connection.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// The whole body one HTTP answer may contribute.
pub const MAX_BODY_BYTES: usize = 1024 * 1024;
pub const MAX_TOOLS: usize = 200;
pub const MAX_RESOURCES: usize = 100;
pub const MAX_PROMPTS: usize = 100;
pub const MAX_SCHEMA_BYTES: usize = 16 * 1024;
pub const MAX_TEXT_BYTES: usize = 4096;
/// The number of distinct `${VAR}` references the probe will resolve.
pub const MAX_REFERENCED_VARS: usize = 32;

/// The protocol era this probe speaks.
///
/// The legacy handshake is the one every MCP server documents; our own access
/// layer serves it beside the stateless era, and third-party servers
/// overwhelmingly implement it. A server that only speaks the stateless era
/// answers `initialize` with an error, which is reported as unsupported rather
/// than guessed around.
const PROTOCOL_VERSION: &str = "2025-03-26";

#[derive(Debug)]
enum ProbeFailure {
    Unauthorized,
    Refused(String),
    Unsupported(String),
    Failed(String),
}

impl ProbeFailure {
    fn into_result(self, source: McpProbeSourceV1, transport: McpTransportV1) -> McpProbeResultV1 {
        let (status, error) = match self {
            Self::Unauthorized => (
                McpProbeStatusV1::Refused,
                "authentication_required".to_string(),
            ),
            Self::Refused(error) => (McpProbeStatusV1::Refused, error),
            Self::Unsupported(error) => (McpProbeStatusV1::Unsupported, error),
            Self::Failed(error) => (McpProbeStatusV1::Failed, error),
        };
        let mut result = McpProbeResultV1::status_only(status, error);
        result.source = Some(source);
        result.transport = Some(transport);
        result
    }
}

/// Discover the capabilities of one configured entry.
pub async fn probe_definition(
    context: &dyn SessionContext,
    session_id: &str,
    roots: &Roots,
    definition: &RawDefinition,
    allow_stdio: bool,
) -> McpProbeResultV1 {
    let transport = definition.transport();
    if definition.entry.get("headersHelper").is_some() {
        return McpProbeResultV1::status_only(
            McpProbeStatusV1::Unsupported,
            "headersHelper is not executed by this view",
        );
    }
    if definition.entry.get("oauth").is_some() {
        return McpProbeResultV1::status_only(
            McpProbeStatusV1::Refused,
            "oauth_requires_the_running_claude_session",
        );
    }
    match transport {
        McpTransportV1::Http | McpTransportV1::Sse => {
            let environment =
                resolve_environment(context, session_id, &definition_variables(definition)).await;
            let mut headers = BTreeMap::new();
            for (name, value) in definition.headers() {
                if !sanitize::valid_header_name(&name) {
                    return McpProbeResultV1::status_only(
                        McpProbeStatusV1::Failed,
                        format!("invalid_header_name: {name}"),
                    );
                }
                match sanitize::expand(&value, &environment) {
                    Ok(value) => {
                        headers.insert(name, value);
                    }
                    Err(missing) => {
                        return McpProbeResultV1::status_only(
                            McpProbeStatusV1::Failed,
                            format!("missing_env: {}", missing.join(",")),
                        )
                    }
                }
            }
            let Some(raw_url) = definition.url() else {
                return McpProbeResultV1::status_only(McpProbeStatusV1::Failed, "missing_url");
            };
            let url = match sanitize::expand(raw_url, &environment) {
                Ok(url) => url,
                Err(missing) => {
                    return McpProbeResultV1::status_only(
                        McpProbeStatusV1::Failed,
                        format!("missing_env: {}", missing.join(",")),
                    )
                }
            };
            let secrets = headers.values().cloned().collect::<Vec<_>>();
            match http_discovery(&url, &headers).await {
                Ok(outcome) => finish(outcome, McpProbeSourceV1::Http, &secrets),
                Err(failure) => redacted_failure(failure, McpProbeSourceV1::Http, &secrets),
            }
        }
        McpTransportV1::Stdio => {
            if !allow_stdio {
                return McpProbeResultV1::status_only(
                    McpProbeStatusV1::Refused,
                    "consent_required",
                );
            }
            let environment =
                resolve_environment(context, session_id, &definition_variables(definition)).await;
            match stdio_discovery(context, session_id, roots, definition, &environment).await {
                Ok(outcome) => {
                    let secrets = definition
                        .env()
                        .values()
                        .cloned()
                        .chain(definition.args())
                        .collect::<Vec<_>>();
                    finish(outcome, McpProbeSourceV1::Stdio, &secrets)
                }
                Err(failure) => {
                    let secrets = definition
                        .env()
                        .values()
                        .cloned()
                        .chain(definition.args())
                        .collect::<Vec<_>>();
                    redacted_failure(failure, McpProbeSourceV1::Stdio, &secrets)
                }
            }
        }
        McpTransportV1::Ws => McpProbeResultV1::status_only(
            McpProbeStatusV1::Unsupported,
            "websocket discovery is not implemented",
        ),
        McpTransportV1::Unknown => {
            McpProbeResultV1::status_only(McpProbeStatusV1::Unsupported, "unknown transport")
        }
    }
}

fn redacted_failure(
    failure: ProbeFailure,
    source: McpProbeSourceV1,
    secrets: &[String],
) -> McpProbeResultV1 {
    let failure = match failure {
        ProbeFailure::Failed(error) => ProbeFailure::Failed(sanitize::redact_text(&error, secrets)),
        ProbeFailure::Refused(error) => {
            ProbeFailure::Refused(sanitize::redact_text(&error, secrets))
        }
        ProbeFailure::Unsupported(error) => {
            ProbeFailure::Unsupported(sanitize::redact_text(&error, secrets))
        }
        ProbeFailure::Unauthorized => ProbeFailure::Unauthorized,
    };
    failure.into_result(
        source,
        if source == McpProbeSourceV1::Http {
            McpTransportV1::Http
        } else {
            McpTransportV1::Stdio
        },
    )
}

fn finish(outcome: Discovery, source: McpProbeSourceV1, secrets: &[String]) -> McpProbeResultV1 {
    let mut result = McpProbeResultV1::from_source(
        source,
        if source == McpProbeSourceV1::Http {
            McpTransportV1::Http
        } else {
            McpTransportV1::Stdio
        },
    );
    result.capabilities = outcome.capabilities;
    result.tools = outcome.tools;
    result.resources = outcome.resources;
    result.prompts = outcome.prompts;
    result.truncated = outcome.truncated;
    if outcome.truncated {
        result.status = McpProbeStatusV1::Truncated;
    }
    if let Some(detail) = outcome.detail {
        result.detail = Some(sanitize::redact_text(&detail, secrets));
    }
    result
}

/// The capability list one completed discovery produced.
#[derive(Debug)]
struct Discovery {
    capabilities: Vec<String>,
    tools: Vec<McpToolV1>,
    resources: Vec<McpResourceV1>,
    prompts: Vec<McpPromptV1>,
    truncated: bool,
    detail: Option<String>,
}

/// Every `${VAR}` an entry's URL, command, args, env and headers reference.
fn definition_variables(definition: &RawDefinition) -> Vec<String> {
    let mut names = Vec::new();
    let mut push = |value: &str| {
        for name in sanitize::referenced_vars(value) {
            if names.len() < MAX_REFERENCED_VARS && !names.contains(&name) {
                names.push(name);
            }
        }
    };
    if let Some(url) = definition.url() {
        push(url);
    }
    if let Some(command) = definition.command() {
        push(command);
    }
    for argument in definition.args() {
        push(&argument);
    }
    for value in definition.env().values() {
        push(value);
    }
    for value in definition.headers().values() {
        push(value);
    }
    names
}

async fn resolve_environment(
    context: &dyn SessionContext,
    session_id: &str,
    names: &[String],
) -> HashMap<String, String> {
    let mut environment = HashMap::new();
    for name in names {
        if let Some(Some(value)) = context.session_environment_variable(session_id, name).await {
            environment.insert(name.clone(), value);
        }
    }
    environment
}

/// Verify a concrete endpoint with a concrete Bearer token.
///
/// Used by Connect's preflight: the token is the Session's value, and only the
/// fact that the handshake succeeded travels back. An endpoint that is
/// disabled, unreachable or protected by a different token is a failure here,
/// which is what keeps Connect from writing a configuration it has not seen
/// work.
pub async fn verify_endpoint(url: &str, token: &str) -> Result<(), String> {
    let headers = BTreeMap::from([("Authorization".to_string(), format!("Bearer {token}"))]);
    match http_discovery(url, &headers).await {
        Ok(_) => Ok(()),
        Err(ProbeFailure::Unauthorized) => Err("credential_rejected".to_string()),
        Err(ProbeFailure::Refused(error)) => {
            Err(sanitize::redact_text(&error, &[token.to_string()]))
        }
        Err(ProbeFailure::Unsupported(error)) => {
            Err(sanitize::redact_text(&error, &[token.to_string()]))
        }
        Err(ProbeFailure::Failed(error)) => {
            Err(sanitize::redact_text(&error, &[token.to_string()]))
        }
    }
}

fn http_client() -> Result<reqwest::Client, ProbeFailure> {
    reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("nession-claude-mcp/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| ProbeFailure::Failed(format!("http client: {error}")))
}

fn validated_url(raw: &str) -> Result<url::Url, ProbeFailure> {
    let url = url::Url::parse(raw).map_err(|_| ProbeFailure::Failed("invalid_url".to_string()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ProbeFailure::Unsupported(format!(
            "transport scheme {} is not supported",
            url.scheme()
        )));
    }
    if url.host_str().is_none() {
        return Err(ProbeFailure::Failed("invalid_url: no host".to_string()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ProbeFailure::Refused(
            "url_userinfo_is_not_supported".to_string(),
        ));
    }
    Ok(url)
}

/// The HTTP discovery handshake and the advertised capability list queries.
async fn http_discovery(
    raw_url: &str,
    headers: &BTreeMap<String, String>,
) -> Result<Discovery, ProbeFailure> {
    let url = validated_url(raw_url)?;
    let client = http_client()?;
    let mut session_id: Option<String> = None;
    let initialize = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {
                "name": "nession",
                "version": env!("CARGO_PKG_VERSION")
            }
        }
    });
    let response = http_post(&client, &url, headers, session_id.as_deref(), &initialize).await?;
    session_id = response.session_id.clone();
    let initialize_result = jsonrpc_result(
        &response
            .payload
            .ok_or_else(|| ProbeFailure::Failed("empty_initialize_response".to_string()))?,
    )?;
    let capabilities = capability_names(&initialize_result);

    // The notification acknowledges the handshake. It has no response.
    let initialized = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
    let _ = http_post(&client, &url, headers, session_id.as_deref(), &initialized).await;

    let mut discovery = Discovery {
        capabilities: capabilities.clone(),
        tools: Vec::new(),
        resources: Vec::new(),
        prompts: Vec::new(),
        truncated: false,
        detail: None,
    };
    let mut next_id = 2;
    if capabilities.iter().any(|capability| capability == "tools") {
        let result = http_request(
            &client,
            &url,
            headers,
            session_id.as_deref(),
            next_id,
            "tools/list",
            json!({}),
        )
        .await?;
        next_id += 1;
        let (tools, truncated) = parse_tools(&result);
        discovery.tools = tools;
        discovery.truncated |= truncated;
    }
    if capabilities
        .iter()
        .any(|capability| capability == "resources")
    {
        let result = http_request(
            &client,
            &url,
            headers,
            session_id.as_deref(),
            next_id,
            "resources/list",
            json!({}),
        )
        .await?;
        next_id += 1;
        let (resources, truncated) = parse_resources(&result);
        discovery.resources = resources;
        discovery.truncated |= truncated;
    }
    if capabilities
        .iter()
        .any(|capability| capability == "prompts")
    {
        let result = http_request(
            &client,
            &url,
            headers,
            session_id.as_deref(),
            next_id,
            "prompts/list",
            json!({}),
        )
        .await?;
        let (prompts, truncated) = parse_prompts(&result);
        discovery.prompts = prompts;
        discovery.truncated |= truncated;
    }
    let _ = next_id;

    // Best-effort session teardown for the legacy lifecycle. A failure here
    // says nothing about the discovery that already completed.
    if let Some(session_id) = &session_id {
        let _ = client
            .delete(url.clone())
            .header("Mcp-Session-Id", session_id)
            .timeout(PROBE_TIMEOUT)
            .send()
            .await;
    }
    Ok(discovery)
}

struct HttpAnswer {
    payload: Option<Value>,
    session_id: Option<String>,
}

async fn http_request(
    client: &reqwest::Client,
    url: &url::Url,
    headers: &BTreeMap<String, String>,
    session_id: Option<&str>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, ProbeFailure> {
    let body = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
    let answer = http_post(client, url, headers, session_id, &body).await?;
    let payload = answer
        .payload
        .ok_or_else(|| ProbeFailure::Failed("empty_response".to_string()))?;
    jsonrpc_result(&payload)
}

async fn http_post(
    client: &reqwest::Client,
    url: &url::Url,
    headers: &BTreeMap<String, String>,
    session_id: Option<&str>,
    body: &Value,
) -> Result<HttpAnswer, ProbeFailure> {
    let mut request = client
        .post(url.clone())
        .header("Accept", "application/json, text/event-stream")
        .header("Content-Type", "application/json")
        .json(body);
    for (name, value) in headers {
        request = request.header(name.as_str(), value.as_str());
    }
    if let Some(session_id) = session_id {
        request = request.header("Mcp-Session-Id", session_id);
    }
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            ProbeFailure::Failed("timeout".to_string())
        } else {
            ProbeFailure::Failed(format!("request_failed: {error}"))
        }
    })?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(ProbeFailure::Unauthorized);
    }
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(ProbeFailure::Failed("not_found".to_string()));
    }
    if status.is_redirection() {
        return Err(ProbeFailure::Refused("endpoint_redirected".to_string()));
    }
    let session_id = response
        .headers()
        .get("Mcp-Session-Id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let (text, truncated) = read_http_body(response).await?;
    if truncated {
        return Err(ProbeFailure::Failed("response_too_large".to_string()));
    }
    if text.trim().is_empty() {
        // A notification (`notifications/initialized`) has no response body.
        return Ok(HttpAnswer {
            payload: None,
            session_id,
        });
    }
    if !status.is_success() {
        return Err(ProbeFailure::Failed(format!("http_status: {status}")));
    }
    let payload = if content_type.contains("text/event-stream") {
        parse_sse(&text)
    } else {
        serde_json::from_str::<Value>(&text).ok()
    };
    let Some(payload) = payload else {
        return Err(ProbeFailure::Failed("invalid_response".to_string()));
    };
    if let Some(error) = payload.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("server rejected the request");
        return Err(ProbeFailure::Failed(format!("server_error: {message}")));
    }
    Ok(HttpAnswer {
        payload: Some(payload),
        session_id,
    })
}

async fn read_http_body(mut response: reqwest::Response) -> Result<(String, bool), ProbeFailure> {
    let mut bytes = Vec::new();
    let mut truncated = false;
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                let room = MAX_BODY_BYTES.saturating_sub(bytes.len());
                if room == 0 {
                    truncated = true;
                    break;
                }
                if chunk.len() > room {
                    let prefix = chunk.get(..room).unwrap_or_else(|| chunk.as_ref());
                    bytes.extend_from_slice(prefix);
                    truncated = true;
                    break;
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(error) => {
                return Err(ProbeFailure::Failed(format!("body_read_failed: {error}")));
            }
        }
    }
    Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
}

fn parse_sse(text: &str) -> Option<Value> {
    let mut data = String::new();
    let mut chosen = None;
    let mut consider = |data: &str| {
        if let Ok(value) = serde_json::from_str::<Value>(data.trim_end()) {
            // A server may emit notifications before the response. An event
            // with an `id` is the JSON-RPC answer; keep the last one so a
            // newer response wins without assuming notifications never occur.
            if value.get("id").is_some() || chosen.is_none() {
                chosen = Some(value);
            }
        }
    };
    for line in text.lines() {
        if let Some(payload) = line.strip_prefix("data:") {
            data.push_str(payload.trim_start());
            data.push('\n');
        } else if line.trim().is_empty() && !data.is_empty() {
            consider(&data);
            data.clear();
        }
    }
    if !data.is_empty() {
        consider(&data);
    }
    chosen
}

fn jsonrpc_result(payload: &Value) -> Result<Value, ProbeFailure> {
    if let Some(error) = payload.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("server rejected the request");
        return Err(ProbeFailure::Failed(format!("server_error: {message}")));
    }
    payload
        .get("result")
        .cloned()
        .ok_or_else(|| ProbeFailure::Failed("response_has_no_result".to_string()))
}

fn capability_names(initialize_result: &Value) -> Vec<String> {
    let mut names: Vec<String> = initialize_result
        .get("capabilities")
        .and_then(Value::as_object)
        .map(|capabilities| {
            capabilities
                .iter()
                .filter(|(_, value)| value.is_object())
                .map(|(name, _)| name.clone())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

fn bounded_text(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    let mut text: String = text.chars().take(MAX_TEXT_BYTES).collect();
    if text.chars().count() == MAX_TEXT_BYTES {
        text.push('…');
    }
    Some(text)
}

fn parse_tools(result: &Value) -> (Vec<McpToolV1>, bool) {
    let Some(tools) = result.get("tools").and_then(Value::as_array) else {
        return (Vec::new(), false);
    };
    let truncated = tools.len() > MAX_TOOLS;
    let mut schema_truncated = false;
    let tools = tools
        .iter()
        .take(MAX_TOOLS)
        .filter_map(|tool| {
            let name = tool.get("name")?.as_str()?;
            let schema = tool
                .get("inputSchema")
                .map(|schema| serde_json::to_string(schema).unwrap_or_default());
            let schema_too_large = schema
                .as_ref()
                .is_some_and(|schema| schema.len() > MAX_SCHEMA_BYTES);
            if schema_too_large {
                schema_truncated = true;
            }
            Some(McpToolV1 {
                name: name.chars().take(256).collect(),
                description: bounded_text(tool.get("description")),
                input_schema: if schema_too_large { None } else { schema },
            })
        })
        .collect::<Vec<_>>();
    (tools, truncated || schema_truncated)
}

fn parse_resources(result: &Value) -> (Vec<McpResourceV1>, bool) {
    let Some(resources) = result.get("resources").and_then(Value::as_array) else {
        return (Vec::new(), false);
    };
    let truncated = resources.len() > MAX_RESOURCES;
    (
        resources
            .iter()
            .take(MAX_RESOURCES)
            .filter_map(|resource| {
                Some(McpResourceV1 {
                    uri: bounded_text(resource.get("uri"))?,
                    name: bounded_text(resource.get("name")),
                    description: bounded_text(resource.get("description")),
                    mime_type: bounded_text(resource.get("mimeType")),
                })
            })
            .collect(),
        truncated,
    )
}

fn parse_prompts(result: &Value) -> (Vec<McpPromptV1>, bool) {
    let Some(prompts) = result.get("prompts").and_then(Value::as_array) else {
        return (Vec::new(), false);
    };
    let truncated = prompts.len() > MAX_PROMPTS;
    (
        prompts
            .iter()
            .take(MAX_PROMPTS)
            .filter_map(|prompt| {
                Some(McpPromptV1 {
                    name: bounded_text(prompt.get("name"))?,
                    description: bounded_text(prompt.get("description")),
                })
            })
            .collect(),
        truncated,
    )
}

/// A stdio discovery: start the declared process, speak newline-delimited
/// JSON-RPC, and clean it up on every path.
async fn stdio_discovery(
    context: &dyn SessionContext,
    session_id: &str,
    roots: &Roots,
    definition: &RawDefinition,
    environment: &HashMap<String, String>,
) -> Result<Discovery, ProbeFailure> {
    let Some(raw_command) = definition.command() else {
        return Err(ProbeFailure::Failed("missing_command".to_string()));
    };
    let command = sanitize::expand(raw_command, environment)
        .map_err(|missing| ProbeFailure::Failed(format!("missing_env: {}", missing.join(","))))?;
    let arguments = definition
        .args()
        .into_iter()
        .map(|argument| sanitize::expand(&argument, environment))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|missing| ProbeFailure::Failed(format!("missing_env: {}", missing.join(","))))?;
    let mut env = BTreeMap::new();
    for (name, value) in definition.env() {
        if !sanitize::valid_env_name(&name) {
            return Err(ProbeFailure::Failed(format!("invalid_env_name: {name}")));
        }
        let value = sanitize::expand(&value, environment).map_err(|missing| {
            ProbeFailure::Failed(format!("missing_env: {}", missing.join(",")))
        })?;
        env.insert(name, value);
    }

    let mut process = Command::new(&command);
    process
        .args(&arguments)
        .current_dir(&roots.cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .env("HOME", &roots.home);
    match &roots.config_dir_is_explicit {
        true => {
            process.env("CLAUDE_CONFIG_DIR", &roots.config_dir);
        }
        false => {
            process.env_remove("CLAUDE_CONFIG_DIR");
        }
    }
    if let Some(Some(path)) = context
        .session_environment_variable(session_id, "PATH")
        .await
    {
        process.env("PATH", path);
    }
    for (name, value) in env {
        process.env(name, value);
    }

    let mut child = process
        .spawn()
        .map_err(|error| ProbeFailure::Failed(format!("spawn_failed: {error}")))?;

    let result = speak_stdio(&mut child).await;
    match result {
        Ok(discovery) => {
            // Kill before draining stderr: the pipe keeps what the process
            // already wrote, and waiting for EOF on a server that intends to
            // stay alive would add the whole timeout to every probe.
            cleanup_child(&mut child).await;
            let stderr = collect_stderr(&mut child).await;
            let mut discovery = discovery;
            if discovery.tools.is_empty()
                && discovery.resources.is_empty()
                && discovery.prompts.is_empty()
                && !stderr.trim().is_empty()
            {
                discovery.detail = Some(format!("stderr: {stderr}"));
            }
            Ok(discovery)
        }
        Err(failure) => {
            cleanup_child(&mut child).await;
            let stderr = collect_stderr(&mut child).await;
            Err(match failure {
                ProbeFailure::Failed(message) if !stderr.trim().is_empty() => {
                    ProbeFailure::Failed(format!("{message} (stderr: {stderr})"))
                }
                other => other,
            })
        }
    }
}

async fn cleanup_child(child: &mut Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn collect_stderr(child: &mut Child) -> String {
    let Some(stderr) = child.stderr.take() else {
        return String::new();
    };
    let bounded = stderr.take(MAX_BODY_BYTES as u64);
    let mut reader = BufReader::new(bounded);
    let mut buffer = Vec::new();
    let _ = tokio::time::timeout(PROBE_TIMEOUT, reader.read_to_end(&mut buffer)).await;
    String::from_utf8_lossy(&buffer)
        .chars()
        .take(MAX_TEXT_BYTES)
        .collect()
}

async fn speak_stdio(child: &mut Child) -> Result<Discovery, ProbeFailure> {
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| ProbeFailure::Failed("missing_stdin".to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ProbeFailure::Failed("missing_stdout".to_string()))?;
    let mut reader = BufReader::new(stdout.take(MAX_BODY_BYTES as u64));

    let initialize = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "nession", "version": env!("CARGO_PKG_VERSION")}
        }
    });
    write_line(&mut stdin, &initialize).await?;
    let answer = read_line(&mut reader).await?;
    let capabilities = capability_names(&jsonrpc_result(&answer)?);
    let initialized = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
    write_line(&mut stdin, &initialized).await?;

    let mut discovery = Discovery {
        capabilities: capabilities.clone(),
        tools: Vec::new(),
        resources: Vec::new(),
        prompts: Vec::new(),
        truncated: false,
        detail: None,
    };
    let mut id = 2;
    for method in ["tools/list", "resources/list", "prompts/list"] {
        let capability = method.split('/').next().unwrap_or_default();
        if !capabilities.iter().any(|name| name == capability) {
            continue;
        }
        let request = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": {}});
        write_line(&mut stdin, &request).await?;
        let answer = read_line(&mut reader).await?;
        let result = jsonrpc_result(&answer)?;
        match method {
            "tools/list" => {
                let (tools, truncated) = parse_tools(&result);
                discovery.tools = tools;
                discovery.truncated |= truncated;
            }
            "resources/list" => {
                let (resources, truncated) = parse_resources(&result);
                discovery.resources = resources;
                discovery.truncated |= truncated;
            }
            "prompts/list" => {
                let (prompts, truncated) = parse_prompts(&result);
                discovery.prompts = prompts;
                discovery.truncated |= truncated;
            }
            _ => {}
        }
        id += 1;
    }
    Ok(discovery)
}

async fn write_line<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    value: &Value,
) -> Result<(), ProbeFailure> {
    let mut line = serde_json::to_vec(value)
        .map_err(|error| ProbeFailure::Failed(format!("encode_failed: {error}")))?;
    line.push(b'\n');
    tokio::time::timeout(PROBE_TIMEOUT, async {
        writer.write_all(&line).await?;
        writer.flush().await
    })
    .await
    .map_err(|_| ProbeFailure::Failed("timeout_writing".to_string()))?
    .map_err(|error| ProbeFailure::Failed(format!("write_failed: {error}")))
}

async fn read_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<Value, ProbeFailure> {
    let mut line = String::new();
    let read = tokio::time::timeout(PROBE_TIMEOUT, reader.read_line(&mut line))
        .await
        .map_err(|_| ProbeFailure::Failed("timeout_reading".to_string()))?
        .map_err(|error| ProbeFailure::Failed(format!("read_failed: {error}")))?;
    if read == 0 {
        return Err(ProbeFailure::Failed("server_exited".to_string()));
    }
    let value = serde_json::from_str::<Value>(line.trim())
        .map_err(|_| ProbeFailure::Failed("invalid_response".to_string()))?;
    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("server rejected the request");
        return Err(ProbeFailure::Failed(format!("server_error: {message}")));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::mcp_servers::v1::{McpApprovalV1, McpScopeV1};
    use crate::session_context::SessionClaudeConfig;
    use async_trait::async_trait;
    use serde_json::json;

    /// SC-03 (#4080): probe variables resolve through the Session's observed
    /// environment. "Observed unset" and "cannot ask" are both absent from the
    /// expansion map — they differ from each other, but neither is an Agent
    /// value invented for the Session.
    #[tokio::test]
    async fn probe_variables_resolve_from_the_session_and_never_invent_agent_values() {
        struct SessionOnly;

        #[async_trait]
        impl SessionContext for SessionOnly {
            async fn session_cwd(&self, _session_id: &str) -> Option<String> {
                None
            }

            async fn session_claude_config(
                &self,
                _session_id: &str,
            ) -> Option<SessionClaudeConfig> {
                None
            }

            async fn session_claude_active(&self, _session_id: &str) -> Option<bool> {
                None
            }

            async fn session_claude_binding(
                &self,
                _session_id: &str,
            ) -> Option<crate::binding::Binding> {
                None
            }

            async fn session_environment_variable(
                &self,
                _session_id: &str,
                name: &str,
            ) -> Option<Option<String>> {
                match name {
                    "MCP_TOKEN" => Some(Some("session-value".to_string())),
                    "UNSET" => Some(None),
                    _ => None,
                }
            }
        }

        let resolved = resolve_environment(
            &SessionOnly,
            "agent:s",
            &[
                "MCP_TOKEN".to_string(),
                "UNSET".to_string(),
                "UNOBSERVED".to_string(),
            ],
        )
        .await;
        assert_eq!(
            resolved.get("MCP_TOKEN").map(String::as_str),
            Some("session-value")
        );
        assert!(!resolved.contains_key("UNSET"));
        assert!(!resolved.contains_key("UNOBSERVED"));
    }

    #[test]
    fn sse_frames_are_parsed_and_empty_events_are_ignored() {
        let text = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n";
        let value = parse_sse(text).unwrap();
        assert_eq!(value["id"], 1);
    }

    #[test]
    fn tool_parsing_is_bounded_and_reports_truncation() {
        let tools: Vec<Value> = (0..(MAX_TOOLS + 2))
            .map(|index| json!({"name": format!("tool{index}")}))
            .collect();
        let (parsed, truncated) = parse_tools(&json!({"tools": tools}));
        assert_eq!(parsed.len(), MAX_TOOLS);
        assert!(truncated);
    }

    #[test]
    fn an_oversized_schema_is_omitted_rather_than_cut_into_invalid_json() {
        let schema = "x".repeat(MAX_SCHEMA_BYTES + 1);
        let (tools, truncated) =
            parse_tools(&json!({"tools": [{"name": "huge", "inputSchema": {"x": schema}}]}));
        assert_eq!(tools[0].input_schema, None);
        assert!(truncated);
    }

    #[test]
    fn capability_names_are_sorted_and_only_object_capabilities_count() {
        let names = capability_names(&json!({
            "capabilities": {
                "tools": {},
                "resources": {"subscribe": true},
                "prompts": "not an object"
            }
        }));
        assert_eq!(names, ["resources", "tools"]);
    }

    #[test]
    fn a_url_with_userinfo_is_refused_instead_of_used_as_implicit_credentials() {
        assert!(matches!(
            validated_url("https://user:pass@example.invalid/mcp"),
            Err(ProbeFailure::Refused(_))
        ));
        assert!(validated_url("https://example.invalid/mcp").is_ok());
    }

    fn definition(command: &str) -> RawDefinition {
        RawDefinition {
            name: "fixture".to_string(),
            scope: McpScopeV1::Local,
            source: "fixture".to_string(),
            entry: json!({"type": "stdio", "command": command}),
            approval: McpApprovalV1::NotRequired,
        }
    }

    struct EmptyContext;

    #[async_trait::async_trait]
    impl SessionContext for EmptyContext {
        async fn session_cwd(&self, _session_id: &str) -> Option<String> {
            None
        }
        async fn session_claude_config(
            &self,
            _session_id: &str,
        ) -> Option<crate::session_context::SessionClaudeConfig> {
            None
        }
        async fn session_claude_active(&self, _session_id: &str) -> Option<bool> {
            None
        }
        async fn session_claude_binding(
            &self,
            _session_id: &str,
        ) -> Option<crate::binding::Binding> {
            None
        }
    }

    #[tokio::test]
    async fn stdio_requires_explicit_consent() {
        let temp = tempfile::TempDir::new().unwrap();
        let roots = Roots {
            cwd: temp.path().to_path_buf(),
            canonical_cwd: temp.path().to_path_buf(),
            home: temp.path().to_path_buf(),
            config_dir: temp.path().join(".claude"),
            config_dir_is_explicit: false,
            state_file: temp.path().join(".claude.json"),
            project_file: temp.path().join(".mcp.json"),
            managed_file: None,
        };
        let result = probe_definition(
            &EmptyContext,
            "agent:s",
            &roots,
            &definition("/bin/echo"),
            false,
        )
        .await;
        assert_eq!(result.status, McpProbeStatusV1::Refused);
        assert_eq!(result.error.as_deref(), Some("consent_required"));
    }

    #[tokio::test]
    async fn a_missing_environment_variable_is_named_and_not_sent_literally() {
        let temp = tempfile::TempDir::new().unwrap();
        let roots = Roots {
            cwd: temp.path().to_path_buf(),
            canonical_cwd: temp.path().to_path_buf(),
            home: temp.path().to_path_buf(),
            config_dir: temp.path().join(".claude"),
            config_dir_is_explicit: false,
            state_file: temp.path().join(".claude.json"),
            project_file: temp.path().join(".mcp.json"),
            managed_file: None,
        };
        let entry = RawDefinition {
            name: "fixture".to_string(),
            scope: McpScopeV1::Project,
            source: "fixture".to_string(),
            entry: json!({
                "type": "http",
                "url": "https://example.invalid/mcp",
                "headers": {"Authorization": "Bearer ${MISSING_TOKEN}"}
            }),
            approval: McpApprovalV1::Pending,
        };
        let result = probe_definition(&EmptyContext, "agent:s", &roots, &entry, false).await;
        assert_eq!(result.status, McpProbeStatusV1::Failed);
        assert_eq!(result.error.as_deref(), Some("missing_env: MISSING_TOKEN"));
    }

    #[tokio::test]
    async fn http_discovery_completes_the_handshake_and_returns_advertised_tools() {
        let server = crate::mcp::test_support::FakeMcp::start().await;
        let discovery = http_discovery(
            &server.url("/mcp"),
            &crate::mcp::test_support::bearer("secret-token"),
        )
        .await
        .unwrap();
        assert_eq!(discovery.tools.len(), 1);
        assert_eq!(discovery.tools[0].name, "echo");
        assert_eq!(
            discovery.tools[0].description.as_deref(),
            Some("Echo a value")
        );
        assert!(discovery.tools[0].input_schema.is_some());
        let methods = server.methods().await;
        assert!(methods.iter().any(|method| method == "initialize"));
        assert!(methods.iter().any(|method| method == "tools/list"));
        assert!(server
            .authorizations()
            .await
            .iter()
            .all(|header| header == "Bearer secret-token"));
    }

    #[tokio::test]
    async fn stdio_discovery_starts_the_declared_command_and_stops_it() {
        let temp = tempfile::TempDir::new().unwrap();
        let script = crate::mcp::test_support::stdio_fixture(temp.path());
        let roots = Roots {
            cwd: temp.path().to_path_buf(),
            canonical_cwd: temp.path().to_path_buf(),
            home: temp.path().to_path_buf(),
            config_dir: temp.path().join(".claude"),
            config_dir_is_explicit: false,
            state_file: temp.path().join(".claude.json"),
            project_file: temp.path().join(".mcp.json"),
            managed_file: None,
        };
        let entry = RawDefinition {
            name: "fixture".to_string(),
            scope: McpScopeV1::Local,
            source: "fixture".to_string(),
            entry: json!({
                "type": "stdio",
                "command": script.to_string_lossy(),
            }),
            approval: McpApprovalV1::NotRequired,
        };
        let result = probe_definition(&EmptyContext, "agent:s", &roots, &entry, true).await;
        assert_eq!(result.status, McpProbeStatusV1::Ok, "{result:?}");
        assert_eq!(result.source, Some(McpProbeSourceV1::Stdio));
        assert_eq!(result.tools.len(), 1);
        assert_eq!(result.tools[0].name, "echo");
    }

    fn entry(scope: McpScopeV1, value: Value) -> RawDefinition {
        RawDefinition {
            name: "fixture".to_string(),
            scope,
            source: "fixture".to_string(),
            entry: value,
            approval: McpApprovalV1::NotRequired,
        }
    }

    fn roots_at(temp: &tempfile::TempDir) -> Roots {
        Roots {
            cwd: temp.path().to_path_buf(),
            canonical_cwd: temp.path().to_path_buf(),
            home: temp.path().to_path_buf(),
            config_dir: temp.path().join(".claude"),
            config_dir_is_explicit: false,
            state_file: temp.path().join(".claude.json"),
            project_file: temp.path().join(".mcp.json"),
            managed_file: None,
        }
    }

    #[tokio::test]
    async fn unsupported_or_refused_entry_shapes_are_named() {
        let temp = tempfile::TempDir::new().unwrap();
        let roots = roots_at(&temp);
        for (value, expected) in [
            (
                json!({"type": "http", "url": "https://example.invalid/mcp", "oauth": {}}),
                "oauth_requires_the_running_claude_session",
            ),
            (
                json!({"type": "http", "url": "https://example.invalid/mcp", "headersHelper": "echo"}),
                "headersHelper is not executed by this view",
            ),
            (
                json!({"type": "ws", "url": "wss://example.invalid/mcp"}),
                "websocket discovery is not implemented",
            ),
            (json!({"type": "sdk"}), "unknown transport"),
            (json!({"type": "http"}), "missing_url"),
            (
                json!({"type": "http", "url": "https://example.invalid/mcp", "headers": {"Bad Header": "x"}}),
                "invalid_header_name: Bad Header",
            ),
            (
                json!({"type": "http", "url": "https://user:pass@example.invalid/mcp"}),
                "url_userinfo_is_not_supported",
            ),
        ] {
            let result = probe_definition(
                &EmptyContext,
                "agent:s",
                &roots,
                &entry(McpScopeV1::Local, value.clone()),
                false,
            )
            .await;
            assert!(
                result
                    .error
                    .as_deref()
                    .unwrap_or_default()
                    .contains(expected),
                "{value} produced {result:?}"
            );
            assert_ne!(result.status, McpProbeStatusV1::Ok, "{value}");
        }
    }

    #[tokio::test]
    async fn a_stdio_entry_with_an_invalid_environment_name_is_refused() {
        let temp = tempfile::TempDir::new().unwrap();
        let roots = roots_at(&temp);
        let result = probe_definition(
            &EmptyContext,
            "agent:s",
            &roots,
            &entry(
                McpScopeV1::Local,
                json!({"type": "stdio", "command": "/bin/echo", "env": {"BAD-NAME": "x"}}),
            ),
            true,
        )
        .await;
        assert_eq!(result.status, McpProbeStatusV1::Failed);
        assert_eq!(result.error.as_deref(), Some("invalid_env_name: BAD-NAME"));
    }

    #[tokio::test]
    async fn a_stdio_process_that_exits_is_a_failure_not_an_empty_success() {
        let temp = tempfile::TempDir::new().unwrap();
        let roots = roots_at(&temp);
        let result = probe_definition(
            &EmptyContext,
            "agent:s",
            &roots,
            &entry(
                McpScopeV1::Local,
                json!({"type": "stdio", "command": "/bin/false"}),
            ),
            true,
        )
        .await;
        assert_eq!(result.status, McpProbeStatusV1::Failed);
        assert!(result.error.is_some());
    }

    #[tokio::test]
    async fn verify_endpoint_distinguishes_a_rejected_credential_from_an_unreachable_one() {
        let required = crate::mcp::test_support::FakeMcp::start_requiring("right-token").await;
        assert!(verify_endpoint(&required.url("/mcp"), "right-token")
            .await
            .is_ok());
        assert_eq!(
            verify_endpoint(&required.url("/mcp"), "wrong-token").await,
            Err("credential_rejected".to_string())
        );
        let unreachable = "http://127.0.0.1:1/mcp".to_string();
        assert!(verify_endpoint(&unreachable, "token").await.is_err());
    }

    #[test]
    fn resources_and_prompts_are_bounded_and_parsed() {
        let resources: Vec<Value> = (0..(MAX_RESOURCES + 2))
            .map(|index| json!({"uri": format!("file:///{index}"), "name": format!("r{index}")}))
            .collect();
        let (parsed, truncated) = parse_resources(&json!({"resources": resources}));
        assert_eq!(parsed.len(), MAX_RESOURCES);
        assert!(truncated);
        let prompts: Vec<Value> = (0..(MAX_PROMPTS + 2))
            .map(|index| json!({"name": format!("p{index}")}))
            .collect();
        let (parsed, truncated) = parse_prompts(&json!({"prompts": prompts}));
        assert_eq!(parsed.len(), MAX_PROMPTS);
        assert!(truncated);
    }

    #[test]
    fn a_jsonrpc_error_is_reported_rather_than_read_as_a_result() {
        let failure = jsonrpc_result(&json!({"jsonrpc": "2.0", "error": {"message": "nope"}}));
        assert!(matches!(failure, Err(ProbeFailure::Failed(message)) if message.contains("nope")));
        assert!(jsonrpc_result(&json!({"jsonrpc": "2.0"})).is_err());
    }
}
