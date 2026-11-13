//! Agent-owned named Workspace resources (#3407).
//!
//! A managed Workspace is an Agent-local, durable, reusable directory resource.
//! It is not the logical Nession Workspace, a Project Existing Location, an
//! EROFS image or a Sandbox execution. The Server authenticates and routes
//! these units to the current Session's Agent; the Agent owns the registry and
//! the bytes.
//!
//! The identities and validation rules here are canonical for both the Agent
//! manager and the Server's payload checks.

use serde::{Deserialize, Serialize};

/// The only Agent Workspace contract version this build understands.
pub const AGENT_WORKSPACE_CONTRACT_VERSION: u32 = 1;
/// The namespace used when the caller has no Project.
pub const DEFAULT_WORKSPACE_NAMESPACE: &str = "default";
/// The stable prefix of every managed Workspace identity.
pub const WORKSPACE_ID_PREFIX: &str = "ws_";
/// Bound on a human Workspace name, in Unicode scalar values.
pub const WORKSPACE_NAME_MAX_CHARS: usize = 64;
/// Bound on a namespace identifier.
pub const WORKSPACE_NAMESPACE_MAX_CHARS: usize = 128;

/// Whether a Workspace descriptor is Agent-managed or a Project reference.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentWorkspaceKind {
    /// A Project Existing Location: a reference owned by the Project, never
    /// deleted or copied by the Agent Workspace Manager.
    ProjectLocation,
    /// An Agent-owned, durable, reusable Workspace.
    Managed,
}

/// The observed status of one Workspace resource.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentWorkspaceStatus {
    /// The durable directory exists and no execution holds an RW lease.
    Available,
    /// An execution holds an RW lease.
    InUse,
    /// Metadata exists but the durable directory is missing.
    Missing,
    /// The path or metadata cannot be used safely.
    Error,
}

/// One Workspace resource as the current Agent observed it.
///
/// `path` is present only for a user-owned Project Location reference; a
/// managed Workspace never exposes its physical cache path. `workspace_id` is
/// the stable managed identity (or the Project reference identity for a
/// location).
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentWorkspaceDescriptor {
    pub workspace_id: String,
    pub name: String,
    pub namespace: String,
    pub kind: AgentWorkspaceKind,
    pub status: AgentWorkspaceStatus,
    pub auto_created: bool,
    pub created_at: u64,
    pub last_used_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AgentWorkspaceDescriptor {
    /// Validate the descriptor's identity, names and kind-specific path rule.
    ///
    /// A managed Workspace must never expose its physical path; a Project
    /// Location is a reference and therefore must name the path the Project
    /// declared.
    pub fn validate(&self) -> Result<(), String> {
        validate_workspace_name(&self.name)?;
        validate_workspace_namespace(&self.namespace)?;
        match self.kind {
            AgentWorkspaceKind::Managed => {
                if !is_valid_workspace_id(&self.workspace_id) {
                    return Err(
                        "managed workspace_id is not a valid ws_<uuid> identity".to_string()
                    );
                }
                if self.path.is_some() {
                    return Err("a managed workspace must not expose a physical path".to_string());
                }
            }
            AgentWorkspaceKind::ProjectLocation => {
                if self.workspace_id.is_empty() {
                    return Err("Project Location workspace_id must not be empty".to_string());
                }
                if self.path.as_deref().is_none_or(str::is_empty) {
                    return Err("Project Location must name its declared path".to_string());
                }
            }
        }
        Ok(())
    }
}

/// `server.workspace.list` request.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientWorkspaceListPayload {
    /// `agent_id:session_name`; the Server routes to that Session's Agent.
    pub session_id: String,
    /// Optional namespace filter. Absent lists every namespace on the Agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
}

/// `server.workspace.list` reply.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceListResponse {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub workspaces: Vec<AgentWorkspaceDescriptor>,
}

/// `server.workspace.create` request: idempotent get-or-create by name.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientWorkspaceCreatePayload {
    pub session_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    /// Provenance: true when the Session-name auto-allocation created it.
    #[serde(default)]
    pub auto_created: bool,
}

/// `server.workspace.create` reply.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceCreateResponse {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<AgentWorkspaceDescriptor>,
}

/// `server.workspace.delete` request.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientWorkspaceDeletePayload {
    pub session_id: String,
    pub workspace_id: String,
}

/// `server.workspace.delete` reply.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceDeleteResponse {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `agent.workspace.list` request.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerWorkspaceListPayload {
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
}

/// `agent.workspace.create` request.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerWorkspaceCreatePayload {
    pub request_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    #[serde(default)]
    pub auto_created: bool,
}

/// `agent.workspace.delete` request.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerWorkspaceDeletePayload {
    pub request_id: String,
    pub workspace_id: String,
}

/// `ws_` followed by a UUID shape (36 chars, 8-4-4-4-12 hex).
pub fn is_valid_workspace_id(value: &str) -> bool {
    let Some(rest) = value.strip_prefix(WORKSPACE_ID_PREFIX) else {
        return false;
    };
    let bytes = rest.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) {
            *byte == b'-'
        } else {
            byte.is_ascii_hexdigit()
        }
    })
}

/// Validate a human Workspace name. The physical path is keyed by the opaque id.
pub fn validate_workspace_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    let count = trimmed.chars().count();
    if count == 0 {
        return Err("workspace name must not be empty".to_string());
    }
    if count > WORKSPACE_NAME_MAX_CHARS {
        return Err(format!(
            "workspace name must be at most {WORKSPACE_NAME_MAX_CHARS} characters"
        ));
    }
    if trimmed == "." || trimmed == ".." {
        return Err("workspace name must not be `.` or `..`".to_string());
    }
    if trimmed
        .chars()
        .any(|value| value.is_control() || value == '/' || value == '\\')
    {
        return Err("workspace name contains a forbidden character".to_string());
    }
    Ok(())
}

/// The uniqueness key for a name: whitespace becomes one `-`, then lowercase.
pub fn normalize_workspace_name(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase()
}

/// Validate a namespace token (`default` or `project:<id>`).
pub fn validate_workspace_namespace(namespace: &str) -> Result<(), String> {
    if namespace.is_empty() {
        return Err("workspace namespace must not be empty".to_string());
    }
    if namespace.len() > WORKSPACE_NAMESPACE_MAX_CHARS {
        return Err(format!(
            "workspace namespace must be at most {WORKSPACE_NAMESPACE_MAX_CHARS} characters"
        ));
    }
    if !namespace
        .bytes()
        .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'.' | b'_' | b'-' | b':'))
    {
        return Err("workspace namespace contains a forbidden character".to_string());
    }
    Ok(())
}

/// The namespace a Project's Workspaces live in; `default` without a Project.
pub fn workspace_namespace_for_project(project_id: Option<&str>) -> String {
    match project_id {
        Some(project_id) => format!("project:{project_id}"),
        None => DEFAULT_WORKSPACE_NAMESPACE.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_names_and_namespaces_have_one_shape() {
        assert!(is_valid_workspace_id(
            "ws_12345678-1234-4234-8234-123456789abc"
        ));
        assert!(!is_valid_workspace_id("ws_not-a-uuid"));
        assert!(!is_valid_workspace_id(
            "12345678-1234-4234-8234-123456789abc"
        ));
        assert!(validate_workspace_name("  Fix terminal ").is_ok());
        for name in ["", " ", ".", "..", "a/b", "a\\b"] {
            assert!(validate_workspace_name(name).is_err(), "{name}");
        }
        assert_eq!(
            normalize_workspace_name("  Fix   Terminal "),
            "fix-terminal"
        );
        assert!(validate_workspace_namespace("project:project-1").is_ok());
        assert!(validate_workspace_namespace("bad space").is_err());
        assert_eq!(
            workspace_namespace_for_project(Some("project-1")),
            "project:project-1"
        );
        assert_eq!(
            workspace_namespace_for_project(None),
            DEFAULT_WORKSPACE_NAMESPACE
        );
    }

    #[test]
    fn workspace_payloads_refuse_unknown_fields() {
        let value = serde_json::json!({
            "session_id": "a1:s1",
            "workspace_id": "ws_12345678-1234-4234-8234-123456789abc",
            "unexpected": true,
        });
        assert!(serde_json::from_value::<ClientWorkspaceDeletePayload>(value).is_err());
    }
}
