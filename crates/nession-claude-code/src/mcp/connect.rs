//! One-click Nession MCP registration with a fail-closed preflight (#3600).
//!
//! ## The preflight is the product
//!
//! The write itself is one `claude mcp add-json`. What makes this safe is the
//! preflight in front of it: the endpoint must be resolved from a real hosting
//! mode, the credential must be present in the Session's environment **and**
//! verified by a handshake, the CLI must support the adapter, and a same-name
//! configuration in another scope must be acknowledged. Any missing
//! prerequisite produces `blocked` — no endpoint is enabled, no token is
//! minted, no configuration is written.
//!
//! ## The entry is a reference, never a token
//!
//! The written header is `Authorization: Bearer ${NESSION_MCP_TOKEN}`. The
//! variable's value is read from the Session to verify the endpoint and never
//! leaves the process. A project `.mcp.json` therefore contains a reference a
//! teammate's environment must also provide, not a shared secret.

use url::Url;

use crate::protocol::mcp_connect::v1::{
    McpConnectPreflightV1, McpConnectRequestV1, McpConnectResponseV1, McpConnectStateV1,
    McpHostingModeV1, McpPrerequisiteStateV1, McpPrerequisiteV1, McpServerEndpointInputV1,
    CREDENTIAL_ENV, DEFAULT_SERVER_NAME,
};
use crate::protocol::mcp_mutate::v1::McpWriteScopeV1;
use crate::session_context::SessionContext;

use super::cli::{self, Availability};
use super::config::{self, Roots};
use super::probe;
use super::sanitize;

/// Run the preflight, and perform the write only when the caller confirmed and
/// the preflight is ready.
pub async fn connect(
    context: &dyn SessionContext,
    session_id: &str,
    request: McpConnectRequestV1,
) -> McpConnectResponseV1 {
    connect_with_cli(context, session_id, request, &cli::NativeCli).await
}

pub(crate) async fn connect_with_cli(
    context: &dyn SessionContext,
    session_id: &str,
    request: McpConnectRequestV1,
    cli_runner: &dyn cli::McpCli,
) -> McpConnectResponseV1 {
    let name = request
        .name
        .clone()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_SERVER_NAME.to_string());
    let mut preflight = McpConnectPreflightV1::bare(request.mode);
    let roots = match config::resolve_roots(context, session_id).await {
        Ok(roots) => roots,
        Err(error) => {
            return McpConnectResponseV1::with_error(
                McpConnectStateV1::Error,
                preflight,
                error.message(),
            )
        }
    };

    let cli = cli::detect(context, session_id, &roots).await;
    let (claude_version, cli_ready) = match &cli {
        Availability::Available(cli) => (Some(cli.version_text.clone()), true),
        Availability::Unavailable(_) => (None, false),
    };
    preflight.claude_version = claude_version;
    push(
        &mut preflight,
        "claude_cli",
        "Claude Code CLI supports MCP configuration",
        if cli_ready {
            McpPrerequisiteStateV1::Met
        } else {
            McpPrerequisiteStateV1::Unsupported
        },
        match &cli {
            Availability::Available(_) => None,
            Availability::Unavailable(reason) => Some(reason.clone()),
        },
    );

    let host = context.claude_mcp_host().await;
    let endpoint = match resolve_endpoint(
        request.mode,
        request.server_endpoint.as_ref(),
        host.as_ref(),
    ) {
        Ok(endpoint) => {
            push(
                &mut preflight,
                "hosting_mode",
                "A Nession MCP endpoint is resolved for this hosting mode",
                McpPrerequisiteStateV1::Met,
                None,
            );
            push(
                &mut preflight,
                "endpoint_enabled",
                "The selected host has MCP enabled",
                McpPrerequisiteStateV1::Met,
                None,
            );
            preflight.endpoint_url = Some(endpoint.clone());
            Some(endpoint)
        }
        Err((state, detail)) => {
            push(
                &mut preflight,
                "hosting_mode",
                "A Nession MCP endpoint is resolved for this hosting mode",
                state,
                Some(detail),
            );
            None
        }
    };

    let credential = context
        .session_environment_variable(session_id, CREDENTIAL_ENV)
        .await;
    let (credential_present, token) = match credential {
        None => {
            push(
                &mut preflight,
                "credential_present",
                format!("{CREDENTIAL_ENV} is available in this Session's environment"),
                McpPrerequisiteStateV1::Unknown,
                Some("the host could not observe the Session environment".to_string()),
            );
            (false, None)
        }
        Some(None) => {
            push(
                &mut preflight,
                "credential_present",
                format!("{CREDENTIAL_ENV} is available in this Session's environment"),
                McpPrerequisiteStateV1::Missing,
                Some(format!(
                    "set {CREDENTIAL_ENV} through the Session environment binding; this view does not export endpoint tokens"
                )),
            );
            (false, None)
        }
        Some(Some(token)) if token.is_empty() => {
            push(
                &mut preflight,
                "credential_present",
                format!("{CREDENTIAL_ENV} is available in this Session's environment"),
                McpPrerequisiteStateV1::Missing,
                Some(format!(
                    "set {CREDENTIAL_ENV} through the Session environment binding; this view does not export endpoint tokens"
                )),
            );
            (false, None)
        }
        Some(Some(token)) => {
            push(
                &mut preflight,
                "credential_present",
                format!("{CREDENTIAL_ENV} is available in this Session's environment"),
                McpPrerequisiteStateV1::Met,
                None,
            );
            (true, Some(token))
        }
    };
    preflight.credential_present = credential_present;

    if let (Some(url), Some(token)) = (&endpoint, token.as_deref()) {
        match probe::verify_endpoint(url, token).await {
            Ok(()) => {
                preflight.credential_verified = true;
                push(
                    &mut preflight,
                    "endpoint_reachable",
                    "The endpoint answered an MCP handshake",
                    McpPrerequisiteStateV1::Met,
                    None,
                );
                push(
                    &mut preflight,
                    "credential_verified",
                    "The Session credential is accepted by the endpoint",
                    McpPrerequisiteStateV1::Met,
                    None,
                );
            }
            Err(error) if error == "credential_rejected" => {
                push(
                    &mut preflight,
                    "endpoint_reachable",
                    "The endpoint answered an MCP handshake",
                    McpPrerequisiteStateV1::Met,
                    None,
                );
                push(
                    &mut preflight,
                    "credential_verified",
                    "The Session credential is accepted by the endpoint",
                    McpPrerequisiteStateV1::Missing,
                    Some(error),
                );
            }
            Err(error) => {
                push(
                    &mut preflight,
                    "endpoint_reachable",
                    "The endpoint answered an MCP handshake",
                    McpPrerequisiteStateV1::Missing,
                    Some(error),
                );
                push(
                    &mut preflight,
                    "credential_verified",
                    "The Session credential is accepted by the endpoint",
                    McpPrerequisiteStateV1::Unknown,
                    None,
                );
            }
        }
    } else {
        push(
            &mut preflight,
            "endpoint_reachable",
            "The endpoint answered an MCP handshake",
            McpPrerequisiteStateV1::Unknown,
            Some("not attempted without an endpoint and credential".to_string()),
        );
        push(
            &mut preflight,
            "credential_verified",
            "The Session credential is accepted by the endpoint",
            McpPrerequisiteStateV1::Unknown,
            None,
        );
    }

    if request.scope == McpWriteScopeV1::Project && !request.confirm_project_write {
        push(
            &mut preflight,
            "scope_confirmation",
            "Writing project .mcp.json is confirmed",
            McpPrerequisiteStateV1::Missing,
            Some("project .mcp.json may be committed and shared".to_string()),
        );
    } else {
        push(
            &mut preflight,
            "scope_confirmation",
            "Writing project .mcp.json is confirmed",
            McpPrerequisiteStateV1::Met,
            None,
        );
    }

    let before = config::inventory(&roots);
    if before.managed_exclusive {
        push(
            &mut preflight,
            "policy",
            "No enterprise-managed MCP configuration takes exclusive control",
            McpPrerequisiteStateV1::Missing,
            Some("managed-mcp.json is in effect".to_string()),
        );
    } else {
        push(
            &mut preflight,
            "policy",
            "No enterprise-managed MCP configuration takes exclusive control",
            McpPrerequisiteStateV1::Met,
            None,
        );
    }

    let target_scope = request.scope.scope();
    let readable = !before.sources.iter().any(|source| {
        source.state == crate::protocol::mcp_servers::v1::McpSourceStateV1::Error
            && source.scope == Some(target_scope)
    });
    push(
        &mut preflight,
        "configuration_readable",
        "The target scope's configuration is readable",
        if readable {
            McpPrerequisiteStateV1::Met
        } else {
            McpPrerequisiteStateV1::Missing
        },
        if readable {
            None
        } else {
            Some("the target config file could not be parsed".to_string())
        },
    );

    let existing = before
        .servers
        .iter()
        .find(|entry| entry.scope == target_scope && entry.name == name)
        .cloned();
    let existing_raw = config::definitions_in_scope(&roots, target_scope)
        .into_iter()
        .find(|definition| definition.name == name)
        .map(|definition| definition.entry);
    let other_scope = before
        .servers
        .iter()
        .find(|entry| entry.scope != target_scope && entry.name == name)
        .map(|entry| entry.scope);
    let already_configured = existing_raw
        .as_ref()
        .zip(endpoint.as_deref())
        .is_some_and(|(raw, endpoint)| connect_entry(endpoint) == *raw);

    if already_configured {
        push(
            &mut preflight,
            "name_collision",
            "No conflicting entry uses this name",
            McpPrerequisiteStateV1::Met,
            Some("already_configured".to_string()),
        );
    } else if existing.is_some() {
        push(
            &mut preflight,
            "name_collision",
            "No conflicting entry uses this name",
            if request.confirm_replace {
                McpPrerequisiteStateV1::Met
            } else {
                McpPrerequisiteStateV1::Missing
            },
            Some("an entry with this name already exists in this scope".to_string()),
        );
    } else if other_scope.is_some() {
        push(
            &mut preflight,
            "name_collision",
            "No conflicting entry uses this name",
            if request.confirm_replace {
                McpPrerequisiteStateV1::Met
            } else {
                McpPrerequisiteStateV1::Missing
            },
            Some("an entry with this name exists in another scope".to_string()),
        );
    } else if !sanitize::valid_server_name(&name) {
        push(
            &mut preflight,
            "name_collision",
            "No conflicting entry uses this name",
            McpPrerequisiteStateV1::Missing,
            Some("invalid_name".to_string()),
        );
    } else {
        push(
            &mut preflight,
            "name_collision",
            "No conflicting entry uses this name",
            McpPrerequisiteStateV1::Met,
            None,
        );
    }

    preflight.ready = preflight
        .prerequisites
        .iter()
        .all(|prerequisite| prerequisite.state == McpPrerequisiteStateV1::Met);

    if !request.confirm {
        let state = if preflight.ready {
            McpConnectStateV1::Preflight
        } else {
            McpConnectStateV1::Blocked
        };
        return McpConnectResponseV1::bare(state, preflight);
    }
    if !preflight.ready {
        return McpConnectResponseV1::bare(McpConnectStateV1::Blocked, preflight);
    }
    let Some(endpoint) = endpoint else {
        return McpConnectResponseV1::with_error(
            McpConnectStateV1::Blocked,
            preflight,
            "endpoint_unresolved",
        );
    };
    if already_configured {
        let mut response =
            McpConnectResponseV1::bare(McpConnectStateV1::AlreadyConfigured, preflight);
        response.entry = existing;
        response.effective_scope = before
            .servers
            .iter()
            .find(|entry| entry.name == name && entry.effective)
            .map(|entry| entry.scope);
        return response;
    }

    let raw = connect_entry(&endpoint);
    let secrets = token.into_iter().collect::<Vec<_>>();
    let write = ConnectWrite {
        context,
        session_id,
        roots: &roots,
        scope: request.scope,
        name: &name,
        secrets: &secrets,
        cli: cli_runner,
    };
    let outcome = if existing_raw.is_some() {
        match remove_entry(&write).await {
            Ok(()) => match add_entry(&write, &raw).await {
                Ok(()) => Ok(()),
                Err(error) => {
                    if let Some(original) = existing_raw.as_ref() {
                        match add_entry(&write, original).await {
                            Ok(()) => Err(format!("{error}; original_restored")),
                            Err(rollback) => Err(format!("{error}; rollback_failed: {rollback}")),
                        }
                    } else {
                        Err(error)
                    }
                }
            },
            Err(error) => Err(error),
        }
    } else {
        add_entry(&write, &raw).await
    };
    if let Err(error) = outcome {
        return McpConnectResponseV1::with_error(McpConnectStateV1::Error, preflight, error);
    }

    let after = config::inventory(&roots);
    let entry = after
        .servers
        .iter()
        .find(|entry| entry.scope == target_scope && entry.name == name)
        .cloned();
    let effective_scope = after
        .servers
        .iter()
        .find(|entry| entry.name == name && entry.effective)
        .map(|entry| entry.scope);
    if entry.is_none() {
        return McpConnectResponseV1::with_error(
            McpConnectStateV1::Error,
            preflight,
            "configuration_readback_failed",
        );
    }
    let mut response = McpConnectResponseV1::bare(McpConnectStateV1::Configured, preflight);
    response.entry = entry;
    response.effective_scope = effective_scope;
    response.reload_required = true;
    response
}

fn push(
    preflight: &mut McpConnectPreflightV1,
    id: &str,
    label: impl Into<String>,
    state: McpPrerequisiteStateV1,
    detail: Option<String>,
) {
    preflight.prerequisites.push(McpPrerequisiteV1 {
        id: id.to_string(),
        label: label.into(),
        state,
        detail,
    });
}

/// Resolve the endpoint this hosting mode actually offers.
fn resolve_endpoint(
    mode: McpHostingModeV1,
    server: Option<&McpServerEndpointInputV1>,
    host: Option<&crate::session_context::McpHostContext>,
) -> Result<String, (McpPrerequisiteStateV1, String)> {
    match mode {
        McpHostingModeV1::Agent => {
            let Some(host) = host else {
                return Err((
                    McpPrerequisiteStateV1::Unknown,
                    "the Agent host cannot report its MCP endpoint".to_string(),
                ));
            };
            match &host.agent {
                Some(endpoint) => Ok(endpoint.url.clone()),
                None => Err((
                    McpPrerequisiteStateV1::Missing,
                    "this Agent does not mount an embedded MCP endpoint".to_string(),
                )),
            }
        }
        McpHostingModeV1::Server => {
            let Some(host) = host else {
                return Err((
                    McpPrerequisiteStateV1::Unknown,
                    "the Agent host cannot report its Server".to_string(),
                ));
            };
            let Some(server) = server else {
                return Err((
                    McpPrerequisiteStateV1::Missing,
                    "the Server's MCP endpoint was not queried".to_string(),
                ));
            };
            if !server.enabled {
                return Err((
                    McpPrerequisiteStateV1::Missing,
                    "the Server reports MCP disabled".to_string(),
                ));
            }
            let Some(server_url) = host.server_url.as_deref() else {
                return Err((
                    McpPrerequisiteStateV1::Missing,
                    "this Agent has no configured Server".to_string(),
                ));
            };
            let origin = server_origin(server_url)?;
            let path = server.path.as_deref().unwrap_or("/mcp").trim();
            if !valid_path(path) {
                return Err((
                    McpPrerequisiteStateV1::Missing,
                    "the Server reported an invalid MCP path".to_string(),
                ));
            }
            Ok(format!("{origin}{path}"))
        }
    }
}

fn valid_path(path: &str) -> bool {
    path.starts_with('/')
        && path.len() <= 512
        && !path.contains(['?', '#', '\\'])
        && !path.split('/').any(|segment| segment == "..")
        && !path.chars().any(char::is_whitespace)
}

/// The origin the Agent's Claude process can reach the Server at.
fn server_origin(server_url: &str) -> Result<String, (McpPrerequisiteStateV1, String)> {
    let url = Url::parse(server_url).map_err(|_| {
        (
            McpPrerequisiteStateV1::Missing,
            "the Agent's server_url is not a URL".to_string(),
        )
    })?;
    let scheme = match url.scheme() {
        "wss" | "https" => "https",
        "ws" | "http" => "http",
        other => {
            return Err((
                McpPrerequisiteStateV1::Missing,
                format!("server_url scheme {other} is not reachable over HTTP"),
            ))
        }
    };
    let host = url.host_str().ok_or_else(|| {
        (
            McpPrerequisiteStateV1::Missing,
            "server_url has no host".to_string(),
        )
    })?;
    Ok(match url.port() {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    })
}

fn connect_entry(endpoint: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "http",
        "url": endpoint,
        "headers": {"Authorization": format!("Bearer ${{{CREDENTIAL_ENV}}}")}
    })
}

/// One confirmed Connect write: the target, its environment and the adapter.
struct ConnectWrite<'a> {
    context: &'a dyn SessionContext,
    session_id: &'a str,
    roots: &'a Roots,
    scope: McpWriteScopeV1,
    name: &'a str,
    secrets: &'a [String],
    cli: &'a dyn cli::McpCli,
}

async fn add_entry(write: &ConnectWrite<'_>, raw: &serde_json::Value) -> Result<(), String> {
    let arguments = vec![
        "add-json".to_string(),
        "--scope".to_string(),
        scope_flag(write.scope).to_string(),
        write.name.to_string(),
        serde_json::to_string(raw).map_err(|error| error.to_string())?,
    ];
    run(write, &arguments).await
}

async fn remove_entry(write: &ConnectWrite<'_>) -> Result<(), String> {
    let arguments = vec![
        "remove".to_string(),
        write.name.to_string(),
        "--scope".to_string(),
        scope_flag(write.scope).to_string(),
    ];
    run(write, &arguments).await
}

fn scope_flag(scope: McpWriteScopeV1) -> &'static str {
    match scope {
        McpWriteScopeV1::Local => "local",
        McpWriteScopeV1::Project => "project",
    }
}

async fn run(write: &ConnectWrite<'_>, arguments: &[String]) -> Result<(), String> {
    match write
        .cli
        .run(write.context, write.session_id, write.roots, arguments)
        .await
    {
        Ok(output) if output.success => Ok(()),
        Ok(output) => Err({
            let message = sanitize::redact_text(
                format!("{}{}", output.stdout, output.stderr).trim(),
                write.secrets,
            );
            if message.is_empty() {
                "claude_cli_failed".to_string()
            } else {
                message
            }
        }),
        Err(error) => Err(sanitize::redact_text(&error, write.secrets)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::test_support::install_executable_fixture;
    use crate::session_context::{McpHostContext, McpHostEndpoint, SessionClaudeConfig};
    use async_trait::async_trait;
    use std::fs;
    use tempfile::TempDir;

    fn request(mode: McpHostingModeV1) -> McpConnectRequestV1 {
        McpConnectRequestV1 {
            session_id: "agent:s".to_string(),
            mode,
            scope: McpWriteScopeV1::Local,
            name: None,
            server_endpoint: None,
            confirm: false,
            confirm_project_write: false,
            confirm_replace: false,
        }
    }

    #[test]
    fn a_server_origin_is_derived_from_the_agents_own_url() {
        assert_eq!(
            server_origin("wss://nession.example/ws").unwrap(),
            "https://nession.example"
        );
        assert_eq!(
            server_origin("ws://127.0.0.1:19090/ws").unwrap(),
            "http://127.0.0.1:19090"
        );
        assert!(server_origin("ftp://example/ws").is_err());
    }

    #[test]
    fn a_path_may_not_escape_or_carry_a_query() {
        assert!(valid_path("/mcp"));
        assert!(valid_path("/a/mcp"));
        assert!(!valid_path("mcp"));
        assert!(!valid_path("/mcp?x=1"));
        assert!(!valid_path("/../mcp"));
        assert!(!valid_path("/mcp #x"));
    }

    #[test]
    fn the_written_entry_references_the_variable_and_never_its_value() {
        let value = connect_entry("https://nession.example/mcp");
        assert_eq!(value["type"], "http");
        assert_eq!(
            value["headers"]["Authorization"],
            "Bearer ${NESSION_MCP_TOKEN}"
        );
    }

    struct FixedContext {
        cwd: String,
        home: String,
        path: String,
        host: Option<McpHostContext>,
        credential: Option<Option<String>>,
    }

    #[async_trait]
    impl SessionContext for FixedContext {
        async fn session_cwd(&self, _session_id: &str) -> Option<String> {
            Some(self.cwd.clone())
        }
        async fn session_claude_config(&self, _session_id: &str) -> Option<SessionClaudeConfig> {
            Some(SessionClaudeConfig {
                home: Some(self.home.clone()),
                ..SessionClaudeConfig::default()
            })
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
            if name == "PATH" {
                return Some(Some(self.path.clone()));
            }
            if name == CREDENTIAL_ENV {
                return self.credential.clone();
            }
            None
        }
        async fn claude_mcp_host(&self) -> Option<McpHostContext> {
            self.host.clone()
        }
    }

    fn fixture(
        host: Option<McpHostContext>,
        credential: Option<Option<String>>,
    ) -> (TempDir, FixedContext) {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let bin = temp.path().join("bin");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        let claude = bin.join("claude");
        install_executable_fixture(
            &claude,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 2.1.325; exit 0; fi\nexit 0\n",
        );
        let context = FixedContext {
            cwd: cwd.to_string_lossy().into_owned(),
            home: home.to_string_lossy().into_owned(),
            path: bin.to_string_lossy().into_owned(),
            host,
            credential,
        };
        (temp, context)
    }

    #[tokio::test]
    async fn connect_blocks_without_a_verified_credential() {
        let (_temp, context) = fixture(
            Some(McpHostContext {
                agent: Some(McpHostEndpoint {
                    url: "http://127.0.0.1:19999/mcp".to_string(),
                    path: "/mcp".to_string(),
                }),
                server_url: None,
            }),
            Some(None),
        );
        let response = connect(&context, "agent:s", request(McpHostingModeV1::Agent)).await;
        assert_eq!(response.state, McpConnectStateV1::Blocked);
        assert!(!response.preflight.ready);
        assert!(response
            .preflight
            .prerequisites
            .iter()
            .any(|prerequisite| prerequisite.id == "credential_present"
                && prerequisite.state == McpPrerequisiteStateV1::Missing));
        assert_eq!(response.preflight.credential_env, CREDENTIAL_ENV);
    }

    #[tokio::test]
    async fn a_rejected_mcp_token_blocks_without_writing_claude_config() {
        let server = crate::mcp::test_support::FakeMcp::start_requiring("accepted-token").await;
        let (temp, context) = fixture(
            Some(McpHostContext {
                agent: Some(McpHostEndpoint {
                    url: server.url("/mcp"),
                    path: "/mcp".to_string(),
                }),
                server_url: None,
            }),
            Some(Some("rejected-token".to_string())),
        );
        let cli = crate::mcp::test_support::FileCli::new();
        let mut request = request(McpHostingModeV1::Agent);
        request.confirm = true;
        let response = connect_with_cli(&context, "agent:s", request, &cli).await;
        assert_eq!(response.state, McpConnectStateV1::Blocked);
        assert!(response.preflight.prerequisites.iter().any(|entry| {
            entry.id == "credential_verified" && entry.state == McpPrerequisiteStateV1::Missing
        }));
        assert!(
            !temp.path().join("home/.claude.json").exists(),
            "failed authentication must not create a Claude entry"
        );
    }

    #[tokio::test]
    async fn server_mode_blocks_when_the_server_reports_mcp_disabled() {
        let (_temp, context) = fixture(
            Some(McpHostContext {
                agent: None,
                server_url: Some("wss://nession.example/ws".to_string()),
            }),
            Some(None),
        );
        let mut request = request(McpHostingModeV1::Server);
        request.server_endpoint = Some(McpServerEndpointInputV1 {
            enabled: false,
            path: Some("/mcp".to_string()),
        });
        let response = connect(&context, "agent:s", request).await;
        assert_eq!(response.state, McpConnectStateV1::Blocked);
        assert!(response
            .preflight
            .prerequisites
            .iter()
            .any(|prerequisite| prerequisite.id == "hosting_mode"
                && prerequisite.state == McpPrerequisiteStateV1::Missing));
    }

    #[tokio::test]
    async fn an_agent_without_an_embedded_endpoint_blocks_agent_mode() {
        let (_temp, context) = fixture(
            Some(McpHostContext {
                agent: None,
                server_url: None,
            }),
            Some(None),
        );
        let response = connect(&context, "agent:s", request(McpHostingModeV1::Agent)).await;
        assert_eq!(response.state, McpConnectStateV1::Blocked);
    }

    #[tokio::test]
    async fn a_reachable_endpoint_and_accepted_credential_make_the_preflight_ready() {
        let server = crate::mcp::test_support::FakeMcp::start().await;
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let bin = temp.path().join("bin");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        crate::mcp::test_support::claude_fixture(&bin);
        let context = FixedContext {
            cwd: cwd.to_string_lossy().into_owned(),
            home: home.to_string_lossy().into_owned(),
            path: bin.to_string_lossy().into_owned(),
            host: Some(McpHostContext {
                agent: Some(McpHostEndpoint {
                    url: server.url("/mcp"),
                    path: "/mcp".to_string(),
                }),
                server_url: None,
            }),
            credential: Some(Some("secret-token".to_string())),
        };
        let response = connect(&context, "agent:s", request(McpHostingModeV1::Agent)).await;
        assert_eq!(response.state, McpConnectStateV1::Preflight, "{response:?}");
        assert!(response.preflight.ready);
        assert!(response.preflight.credential_verified);
        assert_eq!(
            response.preflight.endpoint_url.as_deref(),
            Some(server.url("/mcp").as_str())
        );
        assert!(server
            .authorizations()
            .await
            .iter()
            .any(|header| header == "Bearer secret-token"));
        assert!(response
            .preflight
            .prerequisites
            .iter()
            .all(|prerequisite| { prerequisite.state == McpPrerequisiteStateV1::Met }));
    }

    #[tokio::test]
    async fn a_confirmed_connect_writes_a_reference_and_reads_it_back() {
        let server = crate::mcp::test_support::FakeMcp::start().await;
        let (temp, context) = fixture(
            Some(McpHostContext {
                agent: Some(McpHostEndpoint {
                    url: server.url("/mcp"),
                    path: "/mcp".to_string(),
                }),
                server_url: None,
            }),
            Some(Some("secret-token".to_string())),
        );
        let cli = crate::mcp::test_support::FileCli::new();
        let mut request = request(McpHostingModeV1::Agent);
        request.confirm = true;
        let response = connect_with_cli(&context, "agent:s", request, &cli).await;
        assert_eq!(
            response.state,
            McpConnectStateV1::Configured,
            "{response:?}"
        );
        assert!(response.reload_required);
        let entry = response.entry.expect("readback");
        assert_eq!(entry.name, "nession");
        assert_eq!(
            entry.scope,
            crate::protocol::mcp_servers::v1::McpScopeV1::Local
        );
        assert!(entry
            .header_names
            .iter()
            .any(|header| header == "Authorization"));

        let state_file = std::path::Path::new(&context.home).join(".claude.json");
        let document: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&state_file).unwrap()).unwrap();
        let written = serde_json::to_string(&document).unwrap();
        assert!(written.contains("Bearer ${NESSION_MCP_TOKEN}"), "{written}");
        assert!(
            !written.contains("secret-token"),
            "the token leaked: {written}"
        );
        let _ = temp;
    }

    #[tokio::test]
    async fn a_second_confirm_is_idempotent() {
        let server = crate::mcp::test_support::FakeMcp::start().await;
        let (temp, context) = fixture(
            Some(McpHostContext {
                agent: Some(McpHostEndpoint {
                    url: server.url("/mcp"),
                    path: "/mcp".to_string(),
                }),
                server_url: None,
            }),
            Some(Some("secret-token".to_string())),
        );
        let cli = crate::mcp::test_support::FileCli::new();
        let mut request = request(McpHostingModeV1::Agent);
        request.confirm = true;
        let first = connect_with_cli(&context, "agent:s", request.clone(), &cli).await;
        assert_eq!(first.state, McpConnectStateV1::Configured, "{first:?}");
        let second = connect_with_cli(&context, "agent:s", request, &cli).await;
        assert_eq!(
            second.state,
            McpConnectStateV1::AlreadyConfigured,
            "{second:?}"
        );
        assert!(second.entry.is_some());
        let _ = temp;
    }

    #[tokio::test]
    async fn project_scope_needs_the_shared_file_confirmation_before_it_can_be_ready() {
        let (_temp, context) = fixture(
            Some(McpHostContext {
                agent: Some(McpHostEndpoint {
                    url: "http://127.0.0.1:19999/mcp".to_string(),
                    path: "/mcp".to_string(),
                }),
                server_url: None,
            }),
            Some(None),
        );
        let mut request = request(McpHostingModeV1::Agent);
        request.scope = McpWriteScopeV1::Project;
        let response = connect(&context, "agent:s", request).await;
        assert!(response
            .preflight
            .prerequisites
            .iter()
            .any(|prerequisite| prerequisite.id == "scope_confirmation"
                && prerequisite.state == McpPrerequisiteStateV1::Missing));
    }

    #[tokio::test]
    async fn server_mode_resolves_the_origin_the_agent_actually_reaches() {
        let server = crate::mcp::test_support::FakeMcp::start_requiring("secret-token").await;
        let (_temp, context) = fixture(
            Some(McpHostContext {
                agent: None,
                server_url: Some(format!("ws://{}/ws", server.addr)),
            }),
            Some(Some("secret-token".to_string())),
        );
        let mut request = request(McpHostingModeV1::Server);
        request.server_endpoint = Some(McpServerEndpointInputV1 {
            enabled: true,
            path: Some("/mcp".to_string()),
        });
        let response = connect(&context, "agent:s", request).await;
        assert_eq!(response.state, McpConnectStateV1::Preflight, "{response:?}");
        assert!(response.preflight.ready);
        assert_eq!(
            response.preflight.endpoint_url.as_deref(),
            Some(server.url("/mcp").as_str())
        );
    }

    #[tokio::test]
    async fn server_mode_blocks_a_missing_endpoint_an_invalid_path_or_a_missing_server() {
        let (_temp, context) = fixture(
            Some(McpHostContext {
                agent: None,
                server_url: Some("wss://nession.example/ws".to_string()),
            }),
            Some(Some("token".to_string())),
        );
        let mut missing = request(McpHostingModeV1::Server);
        assert_eq!(
            connect(&context, "agent:s", missing.clone()).await.state,
            McpConnectStateV1::Blocked
        );
        missing.server_endpoint = Some(McpServerEndpointInputV1 {
            enabled: true,
            path: Some("../escape".to_string()),
        });
        assert_eq!(
            connect(&context, "agent:s", missing).await.state,
            McpConnectStateV1::Blocked
        );
        let no_server = fixture(
            Some(McpHostContext {
                agent: None,
                server_url: None,
            }),
            Some(Some("token".to_string())),
        );
        let mut request = request(McpHostingModeV1::Server);
        request.server_endpoint = Some(McpServerEndpointInputV1 {
            enabled: true,
            path: Some("/mcp".to_string()),
        });
        assert_eq!(
            connect(&no_server.1, "agent:s", request).await.state,
            McpConnectStateV1::Blocked
        );
    }

    #[tokio::test]
    async fn an_unobservable_credential_or_host_is_unknown_not_ready() {
        let (_temp, context) = fixture(
            Some(McpHostContext {
                agent: Some(McpHostEndpoint {
                    url: "http://127.0.0.1:19999/mcp".to_string(),
                    path: "/mcp".to_string(),
                }),
                server_url: None,
            }),
            None,
        );
        let response = connect(&context, "agent:s", request(McpHostingModeV1::Agent)).await;
        assert_eq!(response.state, McpConnectStateV1::Blocked);
        assert!(response.preflight.prerequisites.iter().any(|prerequisite| {
            prerequisite.id == "credential_present"
                && prerequisite.state == McpPrerequisiteStateV1::Unknown
        }));

        let (_temp, without_host) = fixture(None, Some(Some("token".to_string())));
        let response = connect(&without_host, "agent:s", request(McpHostingModeV1::Agent)).await;
        assert!(response.preflight.prerequisites.iter().any(|prerequisite| {
            prerequisite.id == "hosting_mode"
                && prerequisite.state == McpPrerequisiteStateV1::Unknown
        }));
    }

    #[tokio::test]
    async fn a_project_connect_writes_a_reference_into_the_shared_file() {
        let server = crate::mcp::test_support::FakeMcp::start_requiring("secret-token").await;
        let (temp, context) = fixture(
            Some(McpHostContext {
                agent: Some(McpHostEndpoint {
                    url: server.url("/mcp"),
                    path: "/mcp".to_string(),
                }),
                server_url: None,
            }),
            Some(Some("secret-token".to_string())),
        );
        let cli = crate::mcp::test_support::FileCli::new();
        let mut request = request(McpHostingModeV1::Agent);
        request.scope = McpWriteScopeV1::Project;
        request.confirm = true;
        request.confirm_project_write = true;
        let response = connect_with_cli(&context, "agent:s", request, &cli).await;
        assert_eq!(
            response.state,
            McpConnectStateV1::Configured,
            "{response:?}"
        );
        let project = temp.path().join("project").join(".mcp.json");
        let written = std::fs::read_to_string(project).unwrap();
        assert!(written.contains("Bearer ${NESSION_MCP_TOKEN}"), "{written}");
        assert!(!written.contains("secret-token"));
    }

    #[tokio::test]
    async fn a_different_existing_entry_requires_conflict_confirmation() {
        let server = crate::mcp::test_support::FakeMcp::start_requiring("secret-token").await;
        let (temp, context) = fixture(
            Some(McpHostContext {
                agent: Some(McpHostEndpoint {
                    url: server.url("/mcp"),
                    path: "/mcp".to_string(),
                }),
                server_url: None,
            }),
            Some(Some("secret-token".to_string())),
        );
        let home = temp.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let cwd = temp.path().join("project");
        let canonical = std::fs::canonicalize(&cwd).unwrap();
        std::fs::write(
            home.join(".claude.json"),
            serde_json::to_string(&serde_json::json!({
                "projects": {canonical.to_string_lossy().as_ref(): {
                    "mcpServers": {"nession": {"type": "http", "url": "https://old.invalid/mcp"}}
                }}
            }))
            .unwrap(),
        )
        .unwrap();
        let cli = crate::mcp::test_support::FileCli::new();
        let mut request = request(McpHostingModeV1::Agent);
        request.confirm = true;
        let conflict = connect_with_cli(&context, "agent:s", request.clone(), &cli).await;
        assert_eq!(conflict.state, McpConnectStateV1::Blocked, "{conflict:?}");
        assert!(conflict.preflight.prerequisites.iter().any(|prerequisite| {
            prerequisite.id == "name_collision"
                && prerequisite.state == McpPrerequisiteStateV1::Missing
        }));

        request.confirm_replace = true;
        let replaced = connect_with_cli(&context, "agent:s", request, &cli).await;
        assert_eq!(
            replaced.state,
            McpConnectStateV1::Configured,
            "{replaced:?}"
        );
    }

    #[tokio::test]
    async fn a_failed_replace_reports_the_rollback_result() {
        let server = crate::mcp::test_support::FakeMcp::start_requiring("secret-token").await;
        let (temp, context) = fixture(
            Some(McpHostContext {
                agent: Some(McpHostEndpoint {
                    url: server.url("/mcp"),
                    path: "/mcp".to_string(),
                }),
                server_url: None,
            }),
            Some(Some("secret-token".to_string())),
        );
        let home = temp.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let canonical = std::fs::canonicalize(temp.path().join("project")).unwrap();
        std::fs::write(
            home.join(".claude.json"),
            serde_json::to_string(&serde_json::json!({
                "projects": {canonical.to_string_lossy().as_ref(): {
                    "mcpServers": {"nession": {"type": "http", "url": "https://old.invalid/mcp"}}
                }}
            }))
            .unwrap(),
        )
        .unwrap();
        // Fail both the add and the rollback.
        let cli = crate::mcp::test_support::FileCli::new();
        cli.fail_next_adds(2);
        let mut request = request(McpHostingModeV1::Agent);
        request.confirm = true;
        request.confirm_replace = true;
        let response = connect_with_cli(&context, "agent:s", request, &cli).await;
        assert_eq!(response.state, McpConnectStateV1::Error, "{response:?}");
        assert!(response
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("rollback_failed"));
    }

    #[tokio::test]
    async fn an_invalid_name_blocks_the_preflight() {
        let server = crate::mcp::test_support::FakeMcp::start_requiring("secret-token").await;
        let (_temp, context) = fixture(
            Some(McpHostContext {
                agent: Some(McpHostEndpoint {
                    url: server.url("/mcp"),
                    path: "/mcp".to_string(),
                }),
                server_url: None,
            }),
            Some(Some("secret-token".to_string())),
        );
        let mut request = request(McpHostingModeV1::Agent);
        request.name = Some("bad name".to_string());
        let response = connect(&context, "agent:s", request).await;
        assert_eq!(response.state, McpConnectStateV1::Blocked);
        assert!(response.preflight.prerequisites.iter().any(|prerequisite| {
            prerequisite.id == "name_collision"
                && prerequisite.state == McpPrerequisiteStateV1::Missing
        }));
    }
}
