//! `claude-code.mcp-mutate` / v1 (#3600).
//!
//! Add, update or remove one Claude MCP definition in the **local** or
//! **project** scope of this Session's Claude user.
//!
//! ## One scope per operation, named explicitly
//!
//! The request names the scope it mutates. An edit never falls back to another
//! scope, never touches a same-named entry elsewhere, and never writes a
//! project file unless the caller has acknowledged that `.mcp.json` may be
//! shared (`confirm_project_write`). User scope is deliberately absent: the
//! canonical non-project AI resource manager (#3251) owns it.
//!
//! ## Native adapter, not a config editor
//!
//! The write goes through the `claude mcp` CLI as an argument vector. This
//! capability does not reach into `~/.claude.json` with its own JSON writer:
//! Claude owns that file's format, its migration state and its concurrency
//! behaviour. A CLI that is missing or too old is reported as unsupported
//! rather than worked around.
//!
//! ## The readback is the answer
//!
//! A successful CLI exit is not the answer. The mutated scope is re-read and
//! returned, so the client shows what is configured rather than what it asked
//! for. `reload_required` states the other half: a successful write does not
//! make a running Claude session load the change.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::mcp_servers::v1::{McpScopeV1, McpServerEntryV1, McpTransportV1};
use crate::protocol::v1_descriptor;

pub const WIRE: &str = "claude-code.mcp-mutate";

/// The scopes this capability may write.
///
/// A closed pair rather than `McpScopeV1` so "user" and "managed" are not
/// representable requests. User-level mutation belongs to #3251; managed
/// configuration belongs to the administrator who deployed it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum McpWriteScopeV1 {
    Local,
    Project,
}

impl McpWriteScopeV1 {
    pub fn scope(self) -> McpScopeV1 {
        match self {
            Self::Local => McpScopeV1::Local,
            Self::Project => McpScopeV1::Project,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum McpMutationV1 {
    Add,
    Update,
    Remove,
}

/// One env or header pair supplied by the caller.
///
/// `value: null` on an **update** means "keep the value already configured".
/// That is how a client edits an entry without ever reading a secret back: it
/// sends the names it knows and new values only where the user typed one. On
/// add, a null value is an empty value.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct McpKeyValueV1 {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

/// The definition a caller wants written.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct McpDefinitionV1 {
    pub name: String,
    pub transport: McpTransportV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<McpKeyValueV1>,
    #[serde(default)]
    pub headers: Vec<McpKeyValueV1>,
    /// Replace the whole env map instead of merging by name. On add this is
    /// implied; on update it is how a caller removes a key.
    #[serde(default)]
    pub replace_env: bool,
    /// Replace the whole header map instead of merging by name.
    #[serde(default)]
    pub replace_headers: bool,
    /// Replace the argument vector. On add this is implied; on update `false`
    /// keeps the existing arguments, which is how a client that never read
    /// secret-bearing arguments can still edit the rest of the entry.
    #[serde(default)]
    pub replace_args: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct McpMutateRequestV1 {
    pub session_id: String,
    pub operation: McpMutationV1,
    pub scope: McpWriteScopeV1,
    /// The entry name. Required for remove; add/update also carry it in
    /// `definition`, and the two must agree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Required for add/update; ignored for remove.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition: Option<McpDefinitionV1>,
    /// The fingerprint the client saw. A mismatch is an external concurrent
    /// edit and is reported as a conflict rather than overwritten.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_fingerprint: Option<String>,
    /// The caller has seen that project `.mcp.json` may be committed/shared.
    #[serde(default)]
    pub confirm_project_write: bool,
    /// The caller explicitly resolved a same-name configuration conflict.
    #[serde(default)]
    pub confirm_replace: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum McpMutationStateV1 {
    Ok,
    Invalid,
    NotFound,
    UnsupportedScope,
    UnsupportedVersion,
    Conflict,
    PolicyBlocked,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct McpMutateResponseV1 {
    pub state: McpMutationStateV1,
    pub scope: McpWriteScopeV1,
    /// What the configuration actually holds after the operation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<McpServerEntryV1>,
    /// Every entry in the mutated scope, re-read after the write.
    #[serde(default)]
    pub servers: Vec<McpServerEntryV1>,
    /// The entry Claude currently loads under this name, when it is in another
    /// scope. A name collision across scopes is not silently resolved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_scope: Option<McpScopeV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_version: Option<String>,
    /// A running Claude session does not reload configuration on its own.
    #[serde(default)]
    pub reload_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl McpMutateResponseV1 {
    pub fn bare(state: McpMutationStateV1, scope: McpWriteScopeV1) -> Self {
        Self {
            state,
            scope,
            entry: None,
            servers: Vec::new(),
            effective_scope: None,
            claude_version: None,
            reload_required: false,
            error: None,
        }
    }

    pub fn with_error(
        state: McpMutationStateV1,
        scope: McpWriteScopeV1,
        error: impl Into<String>,
    ) -> Self {
        Self {
            error: Some(error.into()),
            ..Self::bare(state, scope)
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
    fn a_definition_carries_no_requirement_to_send_a_secret() {
        let request: McpMutateRequestV1 = serde_json::from_value(json!({
            "session_id": "agent:s",
            "operation": "update",
            "scope": "local",
            "definition": {
                "name": "github",
                "transport": "http",
                "url": "https://example.invalid/mcp",
                "headers": [{"name": "Authorization"}]
            }
        }))
        .unwrap();
        let definition = request.definition.unwrap();
        assert_eq!(definition.headers[0].name, "Authorization");
        assert_eq!(definition.headers[0].value, None);
        assert!(!definition.replace_headers);
    }

    #[test]
    fn the_write_scope_cannot_spell_user_or_managed() {
        assert!(serde_json::from_value::<McpWriteScopeV1>(json!("user")).is_err());
        assert!(serde_json::from_value::<McpWriteScopeV1>(json!("managed")).is_err());
        assert_eq!(
            serde_json::from_value::<McpWriteScopeV1>(json!("project")).unwrap(),
            McpWriteScopeV1::Project
        );
    }

    #[test]
    fn a_bare_answer_names_the_scope_it_did_not_write() {
        let value = serde_json::to_value(McpMutateResponseV1::bare(
            McpMutationStateV1::Conflict,
            McpWriteScopeV1::Project,
        ))
        .unwrap();
        assert_eq!(value["state"], "conflict");
        assert_eq!(value["scope"], "project");
        assert_eq!(value["servers"], json!([]));
        assert_eq!(value["reload_required"], false);
    }
}
