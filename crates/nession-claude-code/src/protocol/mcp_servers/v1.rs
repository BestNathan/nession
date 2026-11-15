//! `claude-code.mcp-servers` / v1 (#3600).
//!
//! The MCP configuration the current Nession Session's Claude Code user sees:
//! every entry from the scopes this Agent can observe, which source won the
//! name, and whether that source is effective or blocked.
//!
//! ## The Session is the whole context
//!
//! One request names a Session and nothing else. The OS user's home, the
//! effective Claude config directory and the project working directory are
//! resolved from that Session's own tmux environment, never from the Agent
//! daemon's process environment. A viewer cannot ask this unit about another
//! Agent's user, another directory, or a machine-wide scan.
//!
//! ## Configured is not loaded
//!
//! The inventory reads configuration files only. It does not run
//! `claude mcp list` or `claude mcp get` — both perform connection checks — and
//! it does not start a stdio server or call `tools/list`. So this unit can say
//! an entry is configured, shadowed or policy-blocked; it cannot say a running
//! Claude session has loaded it, and `load_state` exists to say exactly that
//! rather than invent one.
//!
//! ## Secrets are named, never returned
//!
//! Header and env values are not part of the response at all: only their names
//! travel. URLs are sanitised (userinfo, query values and fragments removed)
//! and command arguments that look like credentials are masked. A client that
//! later edits an entry sends new values; it never reads the old ones back.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::v1_descriptor;

pub const WIRE: &str = "claude-code.mcp-servers";

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct McpServersRequestV1 {
    /// Required: the inventory is a fact about one Session's Claude context.
    pub session_id: String,
}

/// The closed vocabulary for "what did this inventory call produce".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum McpInventoryStateV1 {
    /// The sources were read; `servers` is the complete list they produced.
    Ready,
    /// The host cannot name the Session, its cwd or its Claude environment.
    Unavailable,
    /// No `claude` CLI is available to inspect or edit this context.
    Unsupported,
    /// A source that must be read to answer refused; `error` says which.
    Error,
}

/// Where an entry was configured.
///
/// `Managed` and `Plugin` are read-only here: their owner is not this
/// capability. `User` is read-only in this view because the canonical
/// non-project AI resource manager (#3251) owns it; this unit reports it so
/// precedence is complete, not so it can be edited twice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum McpScopeV1 {
    Local,
    Project,
    User,
    Managed,
    Plugin,
}

impl McpScopeV1 {
    /// Claude Code's precedence: managed above all, then local, project, user,
    /// plugin. Higher ranks win a name collision outright — entries are never
    /// field-merged across scopes.
    pub fn rank(self) -> u8 {
        match self {
            Self::Managed => 0,
            Self::Local => 1,
            Self::Project => 2,
            Self::User => 3,
            Self::Plugin => 4,
        }
    }

    pub fn is_editable(self) -> bool {
        matches!(self, Self::Local | Self::Project)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum McpTransportV1 {
    Stdio,
    Http,
    Sse,
    Ws,
    /// A `type` this build does not model. Carried rather than dropped, so an
    /// entry remains visible without this capability claiming to understand it.
    Unknown,
}

/// Whether Claude will load a project entry.
///
/// Local and user scopes do not need approval; managed entries are decided by
/// policy; a project entry is pending until the user approves it in Claude.
/// The inventory reads the state file's approval lists, so `Unknown` is a
/// source that could not be read, not a guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum McpApprovalV1 {
    Approved,
    Pending,
    Rejected,
    NotRequired,
    Unknown,
}

/// Whether a running Claude session has loaded an entry.
///
/// Always `Unknown` today: nothing in the configuration files states it, and
/// the only live source is Claude's own process. Keeping the vocabulary wide
/// lets a future authoritative probe answer honestly instead of overloading a
/// boolean.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum McpLoadStateV1 {
    Unknown,
}

/// One source file the inventory consulted.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct McpSourceStatusV1 {
    /// `local`, `project`, `user`, `managed`, `plugin` or `settings`.
    pub id: String,
    /// The scope this source contributes, when it contributes one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<McpScopeV1>,
    /// The file (or, for an unsupported source, the reason there is no file).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub state: McpSourceStateV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum McpSourceStateV1 {
    Read,
    Missing,
    Unsupported,
    Error,
}

/// The Session context the answer was derived from.
///
/// Disclosure, not input: every field is what the host observed. No field is
/// ever accepted from a later request.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct McpSessionContextV1 {
    pub cwd: String,
    pub home: String,
    pub config_dir: String,
    /// The `.claude.json` state file local and user scopes live in.
    pub state_file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_version: Option<String>,
}

/// One configured entry, as this view may show it.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct McpServerEntryV1 {
    pub name: String,
    pub transport: McpTransportV1,
    pub scope: McpScopeV1,
    /// Where the definition lives — a file path, or `plugin:<name>`.
    pub source: String,
    /// The highest-precedence definition of this name. Exactly one entry per
    /// name has `true`.
    pub effective: bool,
    /// The scope that shadows this definition, when it is not effective.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadowed_by: Option<McpScopeV1>,
    /// A definition whose owner is not this capability (managed, plugin, or the
    /// user-level manager #3251). The UI must not offer edit/remove.
    pub read_only: bool,
    /// Why Claude will not load this entry even though it is configured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked: Option<String>,
    pub approval: McpApprovalV1,
    pub load_state: McpLoadStateV1,
    /// Sanitised: userinfo, query values and fragments are removed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The executable only, never the full argv.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// Argument count, so the view can state there are arguments without
    /// echoing possibly-secret values.
    #[serde(default)]
    pub argument_count: usize,
    /// Command arguments after credential masking.
    #[serde(default)]
    pub sanitized_args: Vec<String>,
    /// Names only. Values never travel.
    #[serde(default)]
    pub env_names: Vec<String>,
    /// Names only. Values never travel.
    #[serde(default)]
    pub header_names: Vec<String>,
    /// Another definition of this name exists in a different scope with a
    /// different endpoint or command.
    #[serde(default)]
    pub conflict: bool,
    /// A stable fingerprint of the non-secret structure, for optimistic
    /// conflict detection on mutation. Absent when the definition could not be
    /// read as an object.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}

/// The Agent's own MCP hosting facts, when it has any.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct McpHostInfoV1 {
    /// The Agent-embedded endpoint, when `[mcp] enabled = true` here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<McpHostEndpointV1>,
    /// Whether this Agent has a Server to reach at all.
    pub server_configured: bool,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct McpHostEndpointV1 {
    pub enabled: bool,
    /// The endpoint exactly as a process on this Agent's host would reach it.
    pub url: String,
    pub path: String,
    /// The Session environment variable a Connect operation requires. The
    /// value never travels through the protocol.
    pub token_env_var: String,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct McpServersResponseV1 {
    pub state: McpInventoryStateV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<McpSessionContextV1>,
    #[serde(default)]
    pub sources: Vec<McpSourceStatusV1>,
    #[serde(default)]
    pub servers: Vec<McpServerEntryV1>,
    /// Hosting facts belong to the Agent, not to a file. Present whenever the
    /// host could answer, even when the list itself is empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<McpHostInfoV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl McpServersResponseV1 {
    pub fn bare(state: McpInventoryStateV1) -> Self {
        Self {
            state,
            context: None,
            sources: Vec::new(),
            servers: Vec::new(),
            host: None,
            error: None,
        }
    }

    pub fn with_error(state: McpInventoryStateV1, error: impl Into<String>) -> Self {
        Self {
            error: Some(error.into()),
            ..Self::bare(state)
        }
    }

    pub fn at(mut self, context: McpSessionContextV1) -> Self {
        self.context = Some(context);
        self
    }

    pub fn hosting(mut self, host: McpHostInfoV1) -> Self {
        self.host = Some(host);
        self
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
    fn a_request_names_a_session_and_nothing_else() {
        let request: McpServersRequestV1 =
            serde_json::from_value(json!({"session_id": "agent:s"})).unwrap();
        assert_eq!(request.session_id, "agent:s");
        assert!(serde_json::from_value::<McpServersRequestV1>(json!({})).is_err());
    }

    #[test]
    fn scope_precedence_is_the_documented_order() {
        let mut scopes = [
            McpScopeV1::Plugin,
            McpScopeV1::User,
            McpScopeV1::Project,
            McpScopeV1::Local,
            McpScopeV1::Managed,
        ];
        scopes.sort_by_key(|scope| scope.rank());
        assert_eq!(
            scopes,
            [
                McpScopeV1::Managed,
                McpScopeV1::Local,
                McpScopeV1::Project,
                McpScopeV1::User,
                McpScopeV1::Plugin,
            ]
        );
    }

    #[test]
    fn only_local_and_project_are_editable_here() {
        assert!(McpScopeV1::Local.is_editable());
        assert!(McpScopeV1::Project.is_editable());
        for scope in [McpScopeV1::User, McpScopeV1::Managed, McpScopeV1::Plugin] {
            assert!(!scope.is_editable(), "{scope:?} must be read-only");
        }
    }

    #[test]
    fn every_vocabulary_serialises_in_snake_case() {
        assert_eq!(
            serde_json::to_value(McpInventoryStateV1::Unsupported).unwrap(),
            json!("unsupported")
        );
        assert_eq!(
            serde_json::to_value(McpTransportV1::Sse).unwrap(),
            json!("sse")
        );
        assert_eq!(
            serde_json::to_value(McpApprovalV1::NotRequired).unwrap(),
            json!("not_required")
        );
        assert_eq!(
            serde_json::to_value(McpLoadStateV1::Unknown).unwrap(),
            json!("unknown")
        );
        assert_eq!(
            serde_json::to_value(McpSourceStateV1::Error).unwrap(),
            json!("error")
        );
    }

    #[test]
    fn a_bare_answer_omits_disclosure_fields() {
        let value =
            serde_json::to_value(McpServersResponseV1::bare(McpInventoryStateV1::Unavailable))
                .unwrap();
        assert_eq!(
            value,
            json!({"state": "unavailable", "sources": [], "servers": []})
        );
    }
}
