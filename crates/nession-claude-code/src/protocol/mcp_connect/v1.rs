//! `claude-code.mcp-connect` / v1 (#3600).
//!
//! Register the Nession MCP endpoint with the current Session's Claude Code
//! user, after a preflight that can say "no" without changing anything.
//!
//! ## Two calls, one contract
//!
//! `confirm: false` runs the preflight and reports every prerequisite. Nothing
//! is written. `confirm: true` re-runs the same preflight — the endpoint,
//! credential and policy can all have changed between the two calls — and then
//! performs the one configuration write. A preflight that is not ready is a
//! terminal `blocked` answer, not a prompt to weaken a check.
//!
//! ## The credential is a reference
//!
//! The written entry names `NESSION_MCP_TOKEN` through Claude's `${VAR}`
//! expansion. The token's **value** is read from the Session's own environment
//! to verify it against the endpoint, and it never appears in this protocol, in
//! a project `.mcp.json`, in logs or in a CLI argument. When the variable is
//! absent the answer is `blocked`; this capability does not mint or export a
//! token, and it never enables an MCP endpoint as a side effect.
//!
//! ## Endpoints are resolved, not invented
//!
//! Agent mode uses the endpoint this Agent actually mounted. Server mode
//! requires the Server's own `server.mcp.endpoint` answer (`enabled`, `path`)
//! and derives the origin from the Agent's configured `server_url` — the
//! address the Claude process on this host can actually reach — then validates
//! the origin against it. A URL chosen by the browser is never trusted.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::mcp_mutate::v1::McpWriteScopeV1;
use crate::protocol::mcp_servers::v1::{McpScopeV1, McpServerEntryV1};
use crate::protocol::v1_descriptor;

pub const WIRE: &str = "claude-code.mcp-connect";

/// The default name a Connect operation writes when the caller names none.
pub const DEFAULT_SERVER_NAME: &str = "nession";

/// The Session environment variable the written entry references.
pub const CREDENTIAL_ENV: &str = "NESSION_MCP_TOKEN";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum McpHostingModeV1 {
    /// The Nession Server's embedded `/mcp`, for cluster-scoped capabilities.
    Server,
    /// This Agent's own embedded `/mcp`.
    Agent,
}

/// What the Server answered about its own MCP endpoint.
///
/// Obtained from `server.mcp.endpoint`; carried through so the Agent can
/// combine it with the address it actually reaches the Server on. The Agent
/// re-verifies reachability and the credential with a real handshake, so a
/// stale or untruthful `enabled` cannot produce a successful write.
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct McpServerEndpointInputV1 {
    pub enabled: bool,
    /// The Server's configured endpoint path, e.g. `/mcp`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct McpConnectRequestV1 {
    pub session_id: String,
    pub mode: McpHostingModeV1,
    pub scope: McpWriteScopeV1,
    /// Claude entry name. Absent means [`DEFAULT_SERVER_NAME`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Required for `mode: server`; ignored for `mode: agent`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_endpoint: Option<McpServerEndpointInputV1>,
    /// `false` is a preflight only. `true` performs the write when ready.
    #[serde(default)]
    pub confirm: bool,
    /// The caller has seen that project `.mcp.json` may be committed/shared.
    #[serde(default)]
    pub confirm_project_write: bool,
    /// The caller explicitly resolved a pre-existing same-name entry.
    #[serde(default)]
    pub confirm_replace: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum McpPrerequisiteStateV1 {
    Met,
    Missing,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct McpPrerequisiteV1 {
    /// A stable id a client may switch on: `endpoint_enabled`,
    /// `endpoint_reachable`, `credential_present`, `credential_verified`,
    /// `claude_cli`, `scope_policy`, `name_collision`.
    pub id: String,
    /// One quiet sentence for a person.
    pub label: String,
    pub state: McpPrerequisiteStateV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct McpConnectPreflightV1 {
    pub mode: McpHostingModeV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint_url: Option<String>,
    /// Always [`CREDENTIAL_ENV`]; a constant, disclosed so the UI can name the
    /// variable the user must provision rather than inventing one.
    pub credential_env: String,
    pub credential_present: bool,
    pub credential_verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_version: Option<String>,
    pub ready: bool,
    #[serde(default)]
    pub prerequisites: Vec<McpPrerequisiteV1>,
}

impl McpConnectPreflightV1 {
    pub fn bare(mode: McpHostingModeV1) -> Self {
        Self {
            mode,
            endpoint_url: None,
            credential_env: CREDENTIAL_ENV.to_string(),
            credential_present: false,
            credential_verified: false,
            claude_version: None,
            ready: false,
            prerequisites: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum McpConnectStateV1 {
    Preflight,
    Configured,
    AlreadyConfigured,
    Blocked,
    Conflict,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct McpConnectResponseV1 {
    pub state: McpConnectStateV1,
    pub preflight: McpConnectPreflightV1,
    /// The definition read back after a successful write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<McpServerEntryV1>,
    /// The scope Claude actually loads for this name, when that is not the
    /// scope this operation wrote.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_scope: Option<McpScopeV1>,
    /// A running Claude session does not reload MCP configuration on its own.
    #[serde(default)]
    pub reload_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl McpConnectResponseV1 {
    pub fn bare(state: McpConnectStateV1, preflight: McpConnectPreflightV1) -> Self {
        Self {
            state,
            preflight,
            entry: None,
            effective_scope: None,
            reload_required: false,
            error: None,
        }
    }

    pub fn with_error(
        state: McpConnectStateV1,
        preflight: McpConnectPreflightV1,
        error: impl Into<String>,
    ) -> Self {
        Self {
            error: Some(error.into()),
            ..Self::bare(state, preflight)
        }
    }
}

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_preflight_defaults_to_no_write() {
        let request: McpConnectRequestV1 = serde_json::from_value(json!({
            "session_id": "agent:s",
            "mode": "agent",
            "scope": "local"
        }))
        .unwrap();
        assert!(!request.confirm);
        assert!(!request.confirm_project_write);
        assert!(!request.confirm_replace);
        assert_eq!(request.name, None);
        assert_eq!(request.scope, McpWriteScopeV1::Local);
    }

    #[test]
    fn the_default_name_and_credential_variable_are_stated_once() {
        assert_eq!(DEFAULT_SERVER_NAME, "nession");
        assert_eq!(CREDENTIAL_ENV, "NESSION_MCP_TOKEN");
        assert_eq!(
            McpConnectPreflightV1::bare(McpHostingModeV1::Agent).credential_env,
            CREDENTIAL_ENV
        );
    }

    #[test]
    fn a_bare_preflight_is_not_ready() {
        let value = serde_json::to_value(McpConnectResponseV1::bare(
            McpConnectStateV1::Blocked,
            McpConnectPreflightV1::bare(McpHostingModeV1::Server),
        ))
        .unwrap();
        assert_eq!(value["state"], "blocked");
        assert_eq!(value["preflight"]["ready"], false);
        assert_eq!(value["preflight"]["credential_env"], CREDENTIAL_ENV);
        assert_eq!(value["preflight"]["mode"], "server");
    }
}
