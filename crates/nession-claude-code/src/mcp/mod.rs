//! The Claude MCP view's agent-side operation owner (#3600).
//!
//! Four operations, one module:
//!
//! | Unit | Question |
//! | --- | --- |
//! | `claude-code.mcp-servers` | what is configured in this Session's Claude context, and which definition wins? |
//! | `claude-code.mcp-server` | what is this one entry, and (only when asked) what does it advertise? |
//! | `claude-code.mcp-mutate` | add/update/remove one local or project definition |
//! | `claude-code.mcp-connect` | preflight and register the Nession endpoint |
//!
//! Each operation resolves the same Session context exactly once:
//! the Session's own cwd, HOME and `CLAUDE_CONFIG_DIR`. There is no Agent
//! picker, no client-supplied path and no second configuration store.

pub mod cli;
pub mod config;
pub mod connect;
pub mod mutate;
pub mod probe;
pub mod sanitize;

#[cfg(test)]
pub(crate) mod test_support;

use crate::protocol::mcp_connect::v1::{McpConnectRequestV1, McpConnectResponseV1};
use crate::protocol::mcp_mutate::v1::{McpMutateRequestV1, McpMutateResponseV1};
use crate::protocol::mcp_server::v1::{McpServerRequestV1, McpServerResponseV1, McpServerStateV1};
use crate::protocol::mcp_servers::v1::{
    McpHostEndpointV1, McpHostInfoV1, McpInventoryStateV1, McpServersResponseV1,
};
use crate::session_context::SessionContext;

/// Answer `claude-code.mcp-servers`.
pub async fn servers(context: &dyn SessionContext, session_id: &str) -> McpServersResponseV1 {
    let roots = match config::resolve_roots(context, session_id).await {
        Ok(roots) => roots,
        Err(error) => {
            let state = match error {
                config::ContextError::Unavailable(_) => McpInventoryStateV1::Unavailable,
                config::ContextError::Invalid(_) => McpInventoryStateV1::Error,
            };
            return McpServersResponseV1::with_error(state, error.message());
        }
    };

    let availability = cli::detect(context, session_id, &roots).await;
    let claude_version = match availability {
        cli::Availability::Available(cli) => Some(cli.version_text),
        cli::Availability::Unavailable(_) => None,
    };
    let inventory = config::inventory(&roots);
    let host = context.claude_mcp_host().await.map(|host| McpHostInfoV1 {
        agent: host.agent.map(|endpoint| McpHostEndpointV1 {
            enabled: true,
            url: endpoint.url,
            path: endpoint.path,
            token_env_var: crate::protocol::mcp_connect::v1::CREDENTIAL_ENV.to_string(),
        }),
        server_configured: host.server_url.is_some(),
    });

    let mut response =
        McpServersResponseV1::bare(McpInventoryStateV1::Ready).at(roots.context(claude_version));
    response.sources = inventory.sources;
    response.servers = inventory.servers;
    response.host = host;
    response
}

/// Answer `claude-code.mcp-server`.
pub async fn server(
    context: &dyn SessionContext,
    session_id: &str,
    request: McpServerRequestV1,
) -> McpServerResponseV1 {
    let roots = match config::resolve_roots(context, session_id).await {
        Ok(roots) => roots,
        Err(error) => {
            let state = match error {
                config::ContextError::Unavailable(_) => McpServerStateV1::Unavailable,
                config::ContextError::Invalid(_) => McpServerStateV1::Error,
            };
            return McpServerResponseV1::with_error(state, error.message());
        }
    };
    let inventory = config::inventory(&roots);
    let entry = match request.scope {
        Some(scope) => inventory
            .servers
            .iter()
            .find(|entry| entry.name == request.name && entry.scope == scope)
            .cloned(),
        None => inventory
            .servers
            .iter()
            .find(|entry| entry.name == request.name && entry.effective)
            .cloned()
            .or_else(|| {
                inventory
                    .servers
                    .iter()
                    .find(|entry| entry.name == request.name)
                    .cloned()
            }),
    };
    let Some(entry) = entry else {
        return McpServerResponseV1::bare(McpServerStateV1::NotFound);
    };

    let mut response = McpServerResponseV1::bare(McpServerStateV1::Ready).entry(entry.clone());
    if request.probe {
        let Some(raw) = config::definition(&roots, entry.scope, &request.name) else {
            return response.probe(
                crate::protocol::mcp_server::v1::McpProbeResultV1::status_only(
                    crate::protocol::mcp_server::v1::McpProbeStatusV1::Failed,
                    "entry_not_readable",
                ),
            );
        };
        let result =
            probe::probe_definition(context, session_id, &roots, &raw, request.allow_stdio).await;
        response = response.probe(result);
    }
    response
}

/// Answer `claude-code.mcp-mutate`.
pub async fn mutate(
    context: &dyn SessionContext,
    session_id: &str,
    request: McpMutateRequestV1,
) -> McpMutateResponseV1 {
    mutate::mutate(context, session_id, request).await
}

/// Answer `claude-code.mcp-connect`.
pub async fn connect(
    context: &dyn SessionContext,
    session_id: &str,
    request: McpConnectRequestV1,
) -> McpConnectResponseV1 {
    connect::connect(context, session_id, request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_context::{McpHostContext, McpHostEndpoint, SessionClaudeConfig};
    use async_trait::async_trait;
    use std::fs;
    use tempfile::TempDir;

    struct FixedContext {
        cwd: String,
        home: String,
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
            (name == "PATH").then(|| Some(String::new()))
        }
        async fn claude_mcp_host(&self) -> Option<McpHostContext> {
            Some(McpHostContext {
                agent: Some(McpHostEndpoint {
                    url: "http://127.0.0.1:19091/mcp".to_string(),
                    path: "/mcp".to_string(),
                }),
                server_url: Some("wss://nession.example/ws".to_string()),
            })
        }
    }

    fn fixture() -> (TempDir, FixedContext, std::path::PathBuf) {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        fs::write(
            cwd.join(".mcp.json"),
            r#"{"mcpServers":{"github":{"type":"http","url":"https://example.invalid/mcp"}}}"#,
        )
        .unwrap();
        let context = FixedContext {
            cwd: cwd.to_string_lossy().into_owned(),
            home: home.to_string_lossy().into_owned(),
        };
        (temp, context, cwd)
    }

    #[tokio::test]
    async fn inventory_reports_host_and_a_configured_entry() {
        let (_temp, context, _cwd) = fixture();
        let response = servers(&context, "agent:s").await;
        assert_eq!(response.state, McpInventoryStateV1::Ready);
        assert_eq!(response.servers.len(), 1);
        assert_eq!(response.servers[0].name, "github");
        assert!(response.servers[0].effective);
        let host = response.host.unwrap();
        assert!(host.server_configured);
        assert_eq!(host.agent.unwrap().token_env_var, "NESSON_MCP_TOKEN");
    }

    #[tokio::test]
    async fn a_named_entry_resolves_the_effective_definition() {
        let (_temp, context, _cwd) = fixture();
        let response = server(
            &context,
            "agent:s",
            McpServerRequestV1 {
                session_id: "agent:s".to_string(),
                name: "github".to_string(),
                scope: None,
                probe: false,
                allow_stdio: false,
            },
        )
        .await;
        assert_eq!(response.state, McpServerStateV1::Ready);
        assert_eq!(
            response.server.unwrap().scope,
            crate::protocol::mcp_servers::v1::McpScopeV1::Project
        );
        assert_eq!(
            response.probe.status,
            crate::protocol::mcp_server::v1::McpProbeStatusV1::NotRequested
        );
    }

    #[tokio::test]
    async fn an_unknown_name_is_not_found_rather_than_the_only_entry() {
        let (_temp, context, _cwd) = fixture();
        let response = server(
            &context,
            "agent:s",
            McpServerRequestV1 {
                session_id: "agent:s".to_string(),
                name: "missing".to_string(),
                scope: None,
                probe: false,
                allow_stdio: false,
            },
        )
        .await;
        assert_eq!(response.state, McpServerStateV1::NotFound);
        assert!(response.server.is_none());
    }

    #[tokio::test]
    async fn an_unobservable_session_is_unavailable_not_an_empty_list() {
        struct Unknown;
        #[async_trait]
        impl SessionContext for Unknown {
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
        }
        let response = servers(&Unknown, "agent:s").await;
        assert_eq!(response.state, McpInventoryStateV1::Unavailable);
        assert!(response.error.is_some());
    }

    #[tokio::test]
    async fn a_named_entry_with_probe_runs_the_discovery_through_the_contract() {
        let endpoint = crate::mcp::test_support::FakeMcp::start().await;
        let (_temp, context, cwd) = fixture();
        fs::write(
            cwd.join(".mcp.json"),
            serde_json::to_string(&serde_json::json!({
                "mcpServers": {
                    "github": {
                        "type": "http",
                        "url": endpoint.url("/mcp"),
                        "headers": {"Authorization": "Bearer test-token"}
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let response = server(
            &context,
            "agent:s",
            McpServerRequestV1 {
                session_id: "agent:s".to_string(),
                name: "github".to_string(),
                scope: None,
                probe: true,
                allow_stdio: false,
            },
        )
        .await;
        assert_eq!(response.state, McpServerStateV1::Ready);
        assert_eq!(
            response.probe.status,
            crate::protocol::mcp_server::v1::McpProbeStatusV1::Ok
        );
        assert_eq!(response.probe.tools[0].name, "echo");
        assert!(endpoint
            .authorizations()
            .await
            .iter()
            .any(|header| header == "Bearer test-token"));
    }
}
