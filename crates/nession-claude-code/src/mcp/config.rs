//! Resolving the current Session's Claude context and reading its MCP
//! configuration (#3600).
//!
//! ## The Session, not the daemon
//!
//! `HOME`, `CLAUDE_CONFIG_DIR` and the working directory come from the
//! Session's own tmux environment through [`SessionContext`]. The Agent
//! daemon's process environment is never used to answer "which user's Claude
//! configuration is this". When the host cannot observe those values the
//! answer is `unavailable`, not a default that may belong to another user.
//!
//! ## Files this module reads
//!
//! | Scope | Owner file |
//! | --- | --- |
//! | local | `<config>/.claude.json` → `projects[<cwd>].mcpServers` |
//! | user | `<config>/.claude.json` → `mcpServers` |
//! | project | `<cwd>/.mcp.json` |
//! | managed | the platform's `managed-mcp.json` |
//!
//! `<config>` is the Session's `CLAUDE_CONFIG_DIR` when it has one, and
//! `<home>/.claude.json` otherwise. The state file moves with the config
//! directory — measured against Claude Code 2.1.325 — which is why the home
//! directory alone is not enough to locate it.
//!
//! Plugin-provided and claude.ai connector entries are **not** discoverable
//! from these files. They are reported as unsupported sources rather than
//! omitted silently, so an empty list is never mistaken for "this user has no
//! servers".

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use crate::protocol::mcp_servers::v1::{
    McpApprovalV1, McpLoadStateV1, McpScopeV1, McpServerEntryV1, McpSessionContextV1,
    McpSourceStateV1, McpSourceStatusV1, McpTransportV1,
};
use crate::session_context::SessionContext;

use super::sanitize;

/// A configuration file larger than this is not a Claude config this view can
/// reason about; refusing it is better than truncating one.
pub const MAX_CONFIG_BYTES: u64 = 16 * 1024 * 1024;

/// The absolute context one Session's Claude view is scoped to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Roots {
    /// The Session's working directory, as tmux reports it.
    pub cwd: PathBuf,
    /// `cwd` with symlinks resolved. Claude keys local state by this path.
    pub canonical_cwd: PathBuf,
    pub home: PathBuf,
    pub config_dir: PathBuf,
    /// Whether `config_dir` came from the Session's `CLAUDE_CONFIG_DIR`.
    /// The CLI child must not inherit the Agent's value when it did not.
    pub config_dir_is_explicit: bool,
    /// The `.claude.json` local/user state file.
    pub state_file: PathBuf,
    /// `<cwd>/.mcp.json`.
    pub project_file: PathBuf,
    /// The platform's managed file, when this platform has one.
    pub managed_file: Option<PathBuf>,
}

impl Roots {
    /// What a protocol response may disclose about the resolution.
    pub fn context(&self, claude_version: Option<String>) -> McpSessionContextV1 {
        McpSessionContextV1 {
            cwd: self.cwd.to_string_lossy().into_owned(),
            home: self.home.to_string_lossy().into_owned(),
            config_dir: self.config_dir.to_string_lossy().into_owned(),
            state_file: self.state_file.to_string_lossy().into_owned(),
            claude_version,
        }
    }
}

/// Why the Session context could not be resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContextError {
    /// The host cannot answer a fact the view depends on.
    Unavailable(&'static str),
    /// The host answered, but with a value this view cannot use.
    Invalid(String),
}

impl ContextError {
    pub fn message(&self) -> String {
        match self {
            Self::Unavailable(what) => format!("session context unavailable: {what}"),
            Self::Invalid(what) => format!("session context invalid: {what}"),
        }
    }
}

/// Resolve the Session's Claude context.
///
/// Deliberately all-or-nothing. A view that half-resolved (say, a cwd but no
/// observed home) would have to invent the rest, and inventing `~` is exactly
/// how another user's configuration gets shown under this Session.
pub async fn resolve_roots(
    context: &dyn SessionContext,
    session_id: &str,
) -> Result<Roots, ContextError> {
    let cwd = context
        .session_cwd(session_id)
        .await
        .ok_or(ContextError::Unavailable("working directory"))?;
    let cwd = PathBuf::from(cwd.trim());
    if cwd.as_os_str().is_empty() {
        return Err(ContextError::Unavailable("working directory"));
    }

    let observed = context
        .session_claude_config(session_id)
        .await
        .ok_or(ContextError::Unavailable("Claude environment"))?;

    let home = observed
        .home
        .as_deref()
        .filter(|home| !home.trim().is_empty())
        .ok_or(ContextError::Unavailable("HOME"))?;
    let home = PathBuf::from(home.trim());
    if !home.is_absolute() {
        return Err(ContextError::Invalid("HOME is not absolute".to_string()));
    }

    let explicit_config_dir = observed
        .config_dir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty());
    let config_dir = match explicit_config_dir {
        Some(dir) => {
            let dir = PathBuf::from(dir);
            if !dir.is_absolute() {
                return Err(ContextError::Invalid(
                    "CLAUDE_CONFIG_DIR is not absolute".to_string(),
                ));
            }
            dir
        }
        None => home.join(".claude"),
    };

    // Measured against Claude Code 2.1.325: a custom CLAUDE_CONFIG_DIR carries
    // `.claude.json` with it. The default layout keeps the state file beside
    // the home directory rather than inside `.claude/`.
    let state_file = match explicit_config_dir {
        Some(_) => config_dir.join(".claude.json"),
        None => home.join(".claude.json"),
    };

    let canonical_cwd = std::fs::canonicalize(&cwd).unwrap_or_else(|_| cwd.clone());
    let project_file = cwd.join(".mcp.json");

    Ok(Roots {
        cwd,
        canonical_cwd,
        home,
        config_dir,
        config_dir_is_explicit: explicit_config_dir.is_some(),
        state_file,
        project_file,
        managed_file: managed_mcp_path(),
    })
}

/// The platform path Claude Code documents for its exclusive managed set.
pub fn managed_mcp_path() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        Some(PathBuf::from(
            "/Library/Application Support/ClaudeCode/managed-mcp.json",
        ))
    } else if cfg!(windows) {
        Some(PathBuf::from(
            r"C:\Program Files\ClaudeCode\managed-mcp.json",
        ))
    } else {
        Some(PathBuf::from("/etc/claude-code/managed-mcp.json"))
    }
}

/// A file read that distinguishes "not there" from "there and unreadable".
#[derive(Debug, Clone)]
pub enum SourceRead<T> {
    Missing,
    Read(T),
    Error(String),
}

/// Read one Claude configuration file with the shared size bound.
///
/// The Workspace Trust owner consumes this too: the trust state file is the
/// same `.claude.json`, so "missing", "unreadable" and "not valid JSON" must
/// have one definition rather than two.
pub(crate) fn read_json(path: &Path) -> SourceRead<Value> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return SourceRead::Missing,
        Err(error) => return SourceRead::Error(error.to_string()),
    };
    if metadata.len() > MAX_CONFIG_BYTES {
        return SourceRead::Error(format!("configuration exceeds {MAX_CONFIG_BYTES} bytes"));
    }
    match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(value) => SourceRead::Read(value),
            Err(error) => SourceRead::Error(format!("invalid JSON: {error}")),
        },
        Err(error) => SourceRead::Error(error.to_string()),
    }
}

/// One definition as it exists in a file, including values that must never be
/// serialised.
#[derive(Debug, Clone)]
pub struct RawDefinition {
    pub name: String,
    pub scope: McpScopeV1,
    pub source: String,
    pub entry: Value,
    pub approval: McpApprovalV1,
}

impl RawDefinition {
    pub fn transport(&self) -> McpTransportV1 {
        transport_of(&self.entry)
    }

    pub fn url(&self) -> Option<&str> {
        self.entry.get("url").and_then(Value::as_str)
    }

    pub fn command(&self) -> Option<&str> {
        self.entry.get("command").and_then(Value::as_str)
    }

    pub fn args(&self) -> Vec<String> {
        self.entry
            .get("args")
            .and_then(Value::as_array)
            .map(|args| {
                args.iter()
                    .filter_map(|arg| arg.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn env(&self) -> BTreeMap<String, String> {
        sanitize::string_map(self.entry.get("env"))
    }

    pub fn headers(&self) -> BTreeMap<String, String> {
        sanitize::string_map(self.entry.get("headers"))
    }
}

fn transport_of(entry: &Value) -> McpTransportV1 {
    match entry.get("type").and_then(Value::as_str) {
        Some("http") | Some("streamable-http") => McpTransportV1::Http,
        Some("sse") => McpTransportV1::Sse,
        Some("ws") => McpTransportV1::Ws,
        Some("stdio") => McpTransportV1::Stdio,
        // Claude accepts a missing `type` only for stdio; an entry with a URL
        // and no type is rejected by the CLI. Reporting it as `unknown` keeps
        // the entry visible without this view pretending to understand it.
        None if entry.get("command").is_some() => McpTransportV1::Stdio,
        _ => McpTransportV1::Unknown,
    }
}

/// Every entry and source status this Session's files produced.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Inventory {
    pub sources: Vec<McpSourceStatusV1>,
    pub servers: Vec<McpServerEntryV1>,
    pub managed_exclusive: bool,
}

fn scope_source(scope: McpScopeV1, path: &Path, read: &SourceRead<Value>) -> McpSourceStatusV1 {
    let (state, detail) = match read {
        SourceRead::Missing => (McpSourceStateV1::Missing, None),
        SourceRead::Read(_) => (McpSourceStateV1::Read, None),
        SourceRead::Error(error) => (McpSourceStateV1::Error, Some(error.clone())),
    };
    McpSourceStatusV1 {
        id: match scope {
            McpScopeV1::Local => "local",
            McpScopeV1::Project => "project",
            McpScopeV1::User => "user",
            McpScopeV1::Managed => "managed",
            McpScopeV1::Plugin => "plugin",
        }
        .to_string(),
        scope: Some(scope),
        path: Some(path.to_string_lossy().into_owned()),
        state,
        detail,
    }
}

/// Read the configuration this Session's Claude user would see.
///
/// Never contacts a server, never runs the CLI, never launches a stdio server.
pub fn inventory(roots: &Roots) -> Inventory {
    let state = read_json(&roots.state_file);
    let project = read_json(&roots.project_file);
    let managed = roots
        .managed_file
        .as_deref()
        .map(read_json)
        .unwrap_or(SourceRead::Missing);

    let mut sources = vec![match roots.managed_file.as_deref() {
        Some(path) => scope_source(McpScopeV1::Managed, path, &managed),
        None => McpSourceStatusV1 {
            id: "managed".to_string(),
            scope: Some(McpScopeV1::Managed),
            path: None,
            state: McpSourceStateV1::Unsupported,
            detail: Some("this platform has no managed-mcp.json path".to_string()),
        },
    }];
    sources.push(scope_source(McpScopeV1::Local, &roots.state_file, &state));
    sources.push(McpSourceStatusV1 {
        id: "managed_settings".to_string(),
        scope: Some(McpScopeV1::Managed),
        path: None,
        state: McpSourceStateV1::Unsupported,
        detail: Some("managedMcpServers in managed settings is not read by this view".to_string()),
    });
    sources.push(scope_source(
        McpScopeV1::Project,
        &roots.project_file,
        &project,
    ));
    sources.push(scope_source(McpScopeV1::User, &roots.state_file, &state));
    sources.push(McpSourceStatusV1 {
        id: "plugin".to_string(),
        scope: Some(McpScopeV1::Plugin),
        path: None,
        state: McpSourceStateV1::Unsupported,
        detail: Some(
            "plugin-provided servers are not discoverable from configuration files".to_string(),
        ),
    });
    sources.push(McpSourceStatusV1 {
        id: "connectors".to_string(),
        scope: None,
        path: None,
        state: McpSourceStateV1::Unsupported,
        detail: Some(
            "claude.ai connectors require the running Claude session, not a config file"
                .to_string(),
        ),
    });

    let managed_exclusive = matches!(&managed, SourceRead::Read(_));
    let project_approvals = ProjectApprovals::from_state(&state, roots);

    let mut definitions = Vec::new();
    if let SourceRead::Read(value) = &managed {
        collect_entries(
            value.get("mcpServers"),
            McpScopeV1::Managed,
            &roots
                .managed_file
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default(),
            &mut definitions,
        );
        for definition in definitions
            .iter_mut()
            .filter(|definition| definition.scope == McpScopeV1::Managed)
        {
            definition.approval = McpApprovalV1::Approved;
        }
    }
    if let SourceRead::Read(value) = &state {
        if let Some(project_entry) = project_state_entry(value, roots) {
            collect_entries(
                project_entry.get("mcpServers"),
                McpScopeV1::Local,
                &roots.state_file.to_string_lossy(),
                &mut definitions,
            );
        }
        collect_entries(
            value.get("mcpServers"),
            McpScopeV1::User,
            &roots.state_file.to_string_lossy(),
            &mut definitions,
        );
    }
    if let SourceRead::Read(value) = &project {
        collect_entries(
            value.get("mcpServers"),
            McpScopeV1::Project,
            &roots.project_file.to_string_lossy(),
            &mut definitions,
        );
    }
    for definition in &mut definitions {
        definition.approval = match definition.scope {
            McpScopeV1::Local | McpScopeV1::User => McpApprovalV1::NotRequired,
            McpScopeV1::Managed => McpApprovalV1::Approved,
            McpScopeV1::Project => project_approvals.for_name(&definition.name),
            McpScopeV1::Plugin => McpApprovalV1::Unknown,
        };
    }

    let mut servers = project_entries(definitions, managed_exclusive);
    servers.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.scope.rank().cmp(&right.scope.rank()))
    });

    Inventory {
        sources,
        servers,
        managed_exclusive,
    }
}

/// How the project file's entries stand with Claude.
#[derive(Debug, Clone)]
enum ProjectApprovals {
    Available {
        enabled: Vec<String>,
        disabled: Vec<String>,
    },
    Unknown,
}

impl ProjectApprovals {
    fn from_state(state: &SourceRead<Value>, roots: &Roots) -> Self {
        let SourceRead::Read(value) = state else {
            return Self::Unknown;
        };
        let Some(project) = project_state_entry(value, roots) else {
            return Self::Unknown;
        };
        Self::Available {
            enabled: string_array(project.get("enabledMcpjsonServers")),
            disabled: string_array(project.get("disabledMcpjsonServers")),
        }
    }

    fn for_name(&self, name: &str) -> McpApprovalV1 {
        match self {
            Self::Available { enabled, disabled } => {
                if disabled.iter().any(|candidate| candidate == name) {
                    McpApprovalV1::Rejected
                } else if enabled.iter().any(|candidate| candidate == name) {
                    McpApprovalV1::Approved
                } else {
                    McpApprovalV1::Pending
                }
            }
            Self::Unknown => McpApprovalV1::Unknown,
        }
    }
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// The `.claude.json` project record for this Session's cwd.
///
/// Claude canonicalises symlinks and NFC-normalises the key at write time; tmux
/// reports the shell's logical path, which may be neither. Both spellings are
/// tried, canonical first, so a macOS `/tmp` ↔ `/private/tmp` mismatch does not
/// silently produce an empty local scope.
pub fn project_state_entry<'a>(state: &'a Value, roots: &Roots) -> Option<&'a Value> {
    let projects = state.get("projects")?.as_object()?;
    let mut candidates: Vec<String> = Vec::new();
    for path in [&roots.canonical_cwd, &roots.cwd] {
        let raw = path.to_string_lossy().into_owned();
        candidates.push(raw.clone());
        candidates.push(raw.nfc().collect());
    }
    candidates.dedup();
    candidates.into_iter().find_map(|key| projects.get(&key))
}

fn collect_entries(
    servers: Option<&Value>,
    scope: McpScopeV1,
    source: &str,
    out: &mut Vec<RawDefinition>,
) {
    let Some(map) = servers.and_then(Value::as_object) else {
        return;
    };
    for (name, entry) in map {
        out.push(RawDefinition {
            name: name.clone(),
            scope,
            source: source.to_string(),
            entry: entry.clone(),
            // Resolved per source and per name by the caller.
            approval: McpApprovalV1::Unknown,
        });
    }
}

fn project_entries(
    definitions: Vec<RawDefinition>,
    managed_exclusive: bool,
) -> Vec<McpServerEntryV1> {
    // Project approvals are per name; the collector only knows the source's
    // default. Re-resolve here so `enabledMcpjsonServers`/`disabled...` are
    // honoured without threading the list through every collector call.
    let mut grouped: BTreeMap<String, Vec<RawDefinition>> = BTreeMap::new();
    for definition in definitions {
        grouped
            .entry(definition.name.clone())
            .or_default()
            .push(definition);
    }

    let mut servers = Vec::new();
    for (name, mut group) in grouped {
        group.sort_by_key(|definition| definition.scope.rank());
        // Under exclusive managed control only the managed file can be
        // effective. A name it does not define has no effective definition at
        // all: the user's entries are blocked by policy, not shadowed by a
        // managed server that does not exist.
        let effective_scope = if managed_exclusive {
            group
                .iter()
                .find(|definition| definition.scope == McpScopeV1::Managed)
                .map(|definition| definition.scope)
        } else {
            group.first().map(|definition| definition.scope)
        };
        let effective_key = group
            .iter()
            .find(|definition| Some(definition.scope) == effective_scope)
            .map(|definition| sanitize::endpoint_key(&definition.entry));
        let conflict = effective_scope.is_some()
            && group
                .iter()
                .skip(1)
                .any(|definition| Some(sanitize::endpoint_key(&definition.entry)) != effective_key);

        for definition in group {
            let scope = definition.scope;
            let shadowed_by = if Some(scope) != effective_scope {
                if managed_exclusive && scope != McpScopeV1::Managed {
                    Some(McpScopeV1::Managed)
                } else {
                    effective_scope
                }
            } else {
                None
            };
            let approval = definition.approval;

            let mut blocked = None;
            if managed_exclusive && scope != McpScopeV1::Managed {
                blocked = Some("enterprise_exclusive".to_string());
            } else if approval == McpApprovalV1::Rejected {
                blocked = Some("disabled_by_settings".to_string());
            } else if definition.transport() == McpTransportV1::Unknown {
                blocked = Some("unsupported_transport".to_string());
            } else if !sanitize::valid_server_name(&name) {
                blocked = Some("invalid_name".to_string());
            }

            let args = definition.args();
            let sanitized_args = args
                .iter()
                .enumerate()
                .take(sanitize::MAX_SANITIZED_ARGS)
                .map(|(index, arg)| {
                    let previous = index
                        .checked_sub(1)
                        .and_then(|previous| args.get(previous))
                        .map(String::as_str);
                    sanitize::redact_argument(previous, arg)
                })
                .collect::<Vec<_>>();

            servers.push(McpServerEntryV1 {
                name: name.clone(),
                transport: definition.transport(),
                scope,
                source: definition.source.clone(),
                effective: Some(scope) == effective_scope,
                shadowed_by,
                read_only: !scope.is_editable(),
                blocked,
                approval,
                load_state: McpLoadStateV1::Unknown,
                url: definition.url().map(sanitize::sanitize_url),
                command: definition
                    .command()
                    .map(|command| sanitize::redact_argument(None, command)),
                argument_count: args.len(),
                sanitized_args,
                env_names: definition.env().keys().cloned().collect(),
                header_names: definition.headers().keys().cloned().collect(),
                conflict,
                fingerprint: Some(sanitize::fingerprint(&definition.entry)),
            });
        }
    }
    servers
}

/// One raw definition by scope and name, including its secret values.
pub fn definition(roots: &Roots, scope: McpScopeV1, name: &str) -> Option<RawDefinition> {
    let mut definitions = Vec::new();
    match scope {
        McpScopeV1::Managed => {
            if let Some(path) = roots.managed_file.as_deref() {
                if let SourceRead::Read(value) = read_json(path) {
                    collect_entries(
                        value.get("mcpServers"),
                        scope,
                        &path.to_string_lossy(),
                        &mut definitions,
                    );
                }
            }
        }
        McpScopeV1::Local => {
            if let SourceRead::Read(state) = read_json(&roots.state_file) {
                if let Some(project) = project_state_entry(&state, roots) {
                    collect_entries(
                        project.get("mcpServers"),
                        scope,
                        &roots.state_file.to_string_lossy(),
                        &mut definitions,
                    );
                }
            }
        }
        McpScopeV1::Project => {
            if let SourceRead::Read(project) = read_json(&roots.project_file) {
                collect_entries(
                    project.get("mcpServers"),
                    scope,
                    &roots.project_file.to_string_lossy(),
                    &mut definitions,
                );
            }
        }
        McpScopeV1::User => {
            if let SourceRead::Read(state) = read_json(&roots.state_file) {
                collect_entries(
                    state.get("mcpServers"),
                    scope,
                    &roots.state_file.to_string_lossy(),
                    &mut definitions,
                );
            }
        }
        McpScopeV1::Plugin => {}
    }
    definitions
        .into_iter()
        .find(|definition| definition.name == name)
        .map(|mut definition| {
            definition.approval = McpApprovalV1::Unknown;
            definition
        })
}

/// The list of definitions in one writable scope, for mutation.
pub fn definitions_in_scope(roots: &Roots, scope: McpScopeV1) -> Vec<RawDefinition> {
    let mut definitions = Vec::new();
    match scope {
        McpScopeV1::Local => {
            if let SourceRead::Read(state) = read_json(&roots.state_file) {
                if let Some(project) = project_state_entry(&state, roots) {
                    collect_entries(
                        project.get("mcpServers"),
                        scope,
                        &roots.state_file.to_string_lossy(),
                        &mut definitions,
                    );
                }
            }
        }
        McpScopeV1::Project => {
            if let SourceRead::Read(project) = read_json(&roots.project_file) {
                collect_entries(
                    project.get("mcpServers"),
                    scope,
                    &roots.project_file.to_string_lossy(),
                    &mut definitions,
                );
            }
        }
        _ => {}
    }
    for definition in &mut definitions {
        definition.approval = McpApprovalV1::Pending;
    }
    definitions
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use tempfile::TempDir;

    fn roots(
        home: &Path,
        cwd: &Path,
        config_dir: Option<&Path>,
        managed: Option<PathBuf>,
    ) -> Roots {
        let explicit_config_dir = config_dir.is_some();
        let config_dir = match config_dir {
            Some(dir) => dir.to_path_buf(),
            None => home.join(".claude"),
        };
        let state_file = if explicit_config_dir {
            config_dir.join(".claude.json")
        } else {
            home.join(".claude.json")
        };
        Roots {
            cwd: cwd.to_path_buf(),
            canonical_cwd: fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf()),
            home: home.to_path_buf(),
            config_dir,
            config_dir_is_explicit: explicit_config_dir,
            state_file,
            project_file: cwd.join(".mcp.json"),
            managed_file: managed,
        }
    }

    fn write(path: &Path, value: &Value) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
    }

    #[test]
    fn local_user_and_project_entries_are_read_from_their_owners() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&cwd).unwrap();
        let roots = roots(&home, &cwd, None, None);

        write(
            &roots.state_file,
            &json!({
                "mcpServers": {"global": {"type": "http", "url": "https://global.invalid/mcp"}},
                "projects": {roots.canonical_cwd.to_string_lossy().as_ref(): {
                    "mcpServers": {"private": {"type": "stdio", "command": "tool"}},
                    "enabledMcpjsonServers": ["shared"]
                }}
            }),
        );
        write(
            &roots.project_file,
            &json!({"mcpServers": {
                "shared": {"type": "http", "url": "https://shared.invalid/mcp"}
            }}),
        );

        let inventory = inventory(&roots);
        let names: Vec<&str> = inventory
            .servers
            .iter()
            .map(|server| server.name.as_str())
            .collect();
        assert_eq!(names, ["global", "private", "shared"]);
        let shared = inventory
            .servers
            .iter()
            .find(|server| server.name == "shared")
            .unwrap();
        assert_eq!(shared.scope, McpScopeV1::Project);
        assert_eq!(shared.approval, McpApprovalV1::Approved);
        assert!(shared.effective);
        assert!(!shared.read_only);
        assert!(!inventory.managed_exclusive);
    }

    #[test]
    fn precedence_is_local_then_project_then_user() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&cwd).unwrap();
        let roots = roots(&home, &cwd, None, None);
        write(
            &roots.state_file,
            &json!({
                "mcpServers": {"same": {"type": "http", "url": "https://user.invalid/mcp"}},
                "projects": {roots.canonical_cwd.to_string_lossy().as_ref(): {
                    "mcpServers": {"same": {"type": "http", "url": "https://local.invalid/mcp"}}
                }}
            }),
        );
        write(
            &roots.project_file,
            &json!({"mcpServers": {"same": {"type": "http", "url": "https://project.invalid/mcp"}}}),
        );

        let inventory = inventory(&roots);
        let same: Vec<&McpServerEntryV1> = inventory
            .servers
            .iter()
            .filter(|server| server.name == "same")
            .collect();
        assert_eq!(same.len(), 3);
        assert_eq!(same[0].scope, McpScopeV1::Local);
        assert!(same[0].effective);
        assert_eq!(same[1].scope, McpScopeV1::Project);
        assert_eq!(same[1].shadowed_by, Some(McpScopeV1::Local));
        assert_eq!(same[2].scope, McpScopeV1::User);
        assert_eq!(same[2].shadowed_by, Some(McpScopeV1::Local));
        assert!(same.iter().all(|server| server.conflict));
        assert!(same[2].read_only, "user scope is #3251's to edit");
    }

    #[test]
    fn a_managed_file_is_exclusive_and_blocks_every_other_scope() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&cwd).unwrap();
        let managed = temp.path().join("managed-mcp.json");
        let roots = roots(&home, &cwd, None, Some(managed.clone()));
        write(
            &managed,
            &json!({"mcpServers": {"company": {"type": "http", "url": "https://company.invalid/mcp"}}}),
        );
        write(
            &roots.state_file,
            &json!({"mcpServers": {"personal": {"type": "http", "url": "https://personal.invalid/mcp"}}}),
        );

        let inventory = inventory(&roots);
        assert!(inventory.managed_exclusive);
        let company = inventory
            .servers
            .iter()
            .find(|server| server.name == "company")
            .unwrap();
        assert!(company.effective);
        assert!(company.read_only);
        let personal = inventory
            .servers
            .iter()
            .find(|server| server.name == "personal")
            .unwrap();
        assert!(!personal.effective);
        assert_eq!(personal.shadowed_by, Some(McpScopeV1::Managed));
        assert_eq!(personal.blocked.as_deref(), Some("enterprise_exclusive"));
    }

    #[test]
    fn a_custom_config_dir_moves_the_state_file_with_it() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let config = temp.path().join("claude-config");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&cwd).unwrap();
        let roots = roots(&home, &cwd, Some(&config), None);
        assert_eq!(roots.state_file, config.join(".claude.json"));
        assert!(!roots.state_file.starts_with(&home));
    }

    #[test]
    fn secrets_never_appear_in_the_serialised_inventory() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&cwd).unwrap();
        let roots = roots(&home, &cwd, None, None);
        write(
            &roots.project_file,
            &json!({"mcpServers": {
                "secret": {
                    "type": "http",
                    "url": "https://user:password123@example.invalid/mcp?token=querysecret",
                    "headers": {"Authorization": "Bearer headersecret"},
                    "env": {"API_KEY": "envsecret"}
                }
            }}),
        );

        let value = serde_json::to_string(&inventory(&roots)).unwrap();
        for secret in ["password123", "querysecret", "headersecret", "envsecret"] {
            assert!(!value.contains(secret), "{secret} leaked: {value}");
        }
        assert!(value.contains("Authorization"));
        assert!(value.contains("API_KEY"));
    }

    #[test]
    fn a_project_entry_rejected_by_settings_is_reported_as_blocked() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&cwd).unwrap();
        let roots = roots(&home, &cwd, None, None);
        write(
            &roots.state_file,
            &json!({"projects": {roots.canonical_cwd.to_string_lossy().as_ref(): {
                "disabledMcpjsonServers": ["shared"]
            }}}),
        );
        write(
            &roots.project_file,
            &json!({"mcpServers": {"shared": {"type": "stdio", "command": "tool"}}}),
        );
        let inventory = inventory(&roots);
        let shared = inventory.servers.first().unwrap();
        assert_eq!(shared.approval, McpApprovalV1::Rejected);
        assert_eq!(shared.blocked.as_deref(), Some("disabled_by_settings"));
    }

    #[test]
    fn an_invalid_project_file_is_an_explicit_source_error_not_an_empty_success() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&cwd).unwrap();
        let roots = roots(&home, &cwd, None, None);
        fs::write(&roots.project_file, "{not json").unwrap();
        let inventory = inventory(&roots);
        let project = inventory
            .sources
            .iter()
            .find(|source| source.id == "project")
            .unwrap();
        assert_eq!(project.state, McpSourceStateV1::Error);
        assert!(inventory.servers.is_empty());
    }

    #[test]
    fn an_entry_with_a_url_but_no_type_is_visibly_unsupported() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&cwd).unwrap();
        let roots = roots(&home, &cwd, None, None);
        write(
            &roots.project_file,
            &json!({"mcpServers": {"untyped": {"url": "https://example.invalid/mcp"}}}),
        );
        let inventory = inventory(&roots);
        let untyped = inventory.servers.first().unwrap();
        assert_eq!(untyped.transport, McpTransportV1::Unknown);
        assert_eq!(untyped.blocked.as_deref(), Some("unsupported_transport"));
    }

    #[test]
    fn an_empty_managed_file_still_claims_exclusive_control() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&cwd).unwrap();
        let managed = temp.path().join("managed-mcp.json");
        fs::write(&managed, r#"{"mcpServers": {}}"#).unwrap();
        let roots = roots(&home, &cwd, None, Some(managed));
        write(
            &roots.state_file,
            &json!({"mcpServers": {"personal": {"type": "stdio", "command": "tool"}}}),
        );
        let inventory = inventory(&roots);
        assert!(inventory.managed_exclusive);
        assert_eq!(
            inventory.servers[0].blocked.as_deref(),
            Some("enterprise_exclusive")
        );
    }

    #[test]
    fn a_raw_cwd_key_is_found_when_the_canonical_one_is_not_present() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&cwd).unwrap();
        let roots = roots(&home, &cwd, None, None);
        write(
            &roots.state_file,
            &json!({
                "projects": {roots.cwd.to_string_lossy().as_ref(): {
                    "mcpServers": {"raw": {"type": "stdio", "command": "tool"}}
                }}
            }),
        );
        let inventory = inventory(&roots);
        assert_eq!(inventory.servers.len(), 1);
        assert_eq!(inventory.servers[0].name, "raw");
    }

    #[test]
    fn an_unreadable_state_file_is_reported_for_local_and_user() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        let roots = roots(&home, &cwd, None, None);
        fs::write(&roots.state_file, "{not json").unwrap();
        let inventory = inventory(&roots);
        for id in ["local", "user"] {
            let source = inventory
                .sources
                .iter()
                .find(|source| source.id == id)
                .unwrap();
            assert_eq!(source.state, McpSourceStateV1::Error, "{id}");
        }
    }

    #[test]
    fn definition_looks_up_one_scope_and_never_another() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&cwd).unwrap();
        let managed = temp.path().join("managed-mcp.json");
        let roots = roots(&home, &cwd, None, Some(managed.clone()));
        write(
            &roots.state_file,
            &json!({
                "mcpServers": {"user": {"type": "http", "url": "https://user.invalid/mcp"}},
                "projects": {roots.canonical_cwd.to_string_lossy().as_ref(): {
                    "mcpServers": {"local": {"type": "stdio", "command": "tool"}}
                }}
            }),
        );
        write(
            &roots.project_file,
            &json!({"mcpServers": {"project": {"type": "stdio", "command": "tool"}}}),
        );
        write(
            &managed,
            &json!({"mcpServers": {"managed": {"type": "stdio", "command": "tool"}}}),
        );

        assert_eq!(
            definition(&roots, McpScopeV1::Local, "local")
                .unwrap()
                .command(),
            Some("tool")
        );
        assert!(definition(&roots, McpScopeV1::Local, "user").is_none());
        assert!(definition(&roots, McpScopeV1::User, "user").is_some());
        assert!(definition(&roots, McpScopeV1::Project, "project").is_some());
        assert!(definition(&roots, McpScopeV1::Managed, "managed").is_some());
        assert!(definition(&roots, McpScopeV1::Plugin, "anything").is_none());
    }

    #[test]
    fn writable_scope_listing_is_scoped_and_carries_the_raw_definition() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&cwd).unwrap();
        let roots = roots(&home, &cwd, None, None);
        write(
            &roots.project_file,
            &json!({"mcpServers": {"project": {"type": "http", "url": "https://example.invalid/mcp"}}}),
        );
        let project = definitions_in_scope(&roots, McpScopeV1::Project);
        assert_eq!(project.len(), 1);
        assert_eq!(project[0].scope, McpScopeV1::Project);
        assert!(definitions_in_scope(&roots, McpScopeV1::Local).is_empty());
        assert!(definitions_in_scope(&roots, McpScopeV1::User).is_empty());
    }

    #[test]
    fn transport_spelling_is_normalized_and_unknown_ones_stay_visible() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&cwd).unwrap();
        let roots = roots(&home, &cwd, None, None);
        write(
            &roots.project_file,
            &json!({"mcpServers": {
                "sse": {"type": "sse", "url": "https://example.invalid/sse"},
                "ws": {"type": "ws", "url": "wss://example.invalid/ws"},
                "alias": {"type": "streamable-http", "url": "https://example.invalid/mcp"},
                "sdk": {"type": "sdk"}
            }}),
        );
        let inventory = inventory(&roots);
        let transport = |name: &str| {
            inventory
                .servers
                .iter()
                .find(|entry| entry.name == name)
                .unwrap()
                .transport
        };
        assert_eq!(transport("sse"), McpTransportV1::Sse);
        assert_eq!(transport("ws"), McpTransportV1::Ws);
        assert_eq!(transport("alias"), McpTransportV1::Http);
        assert_eq!(transport("sdk"), McpTransportV1::Unknown);
    }

    #[test]
    fn the_session_context_and_error_vocabulary_are_disclosed() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&cwd).unwrap();
        let roots = roots(&home, &cwd, None, None);
        let context = roots.context(Some("2.1.325".to_string()));
        assert_eq!(context.cwd, cwd.to_string_lossy());
        assert_eq!(context.home, home.to_string_lossy());
        assert_eq!(context.claude_version.as_deref(), Some("2.1.325"));
        assert!(ContextError::Unavailable("HOME").message().contains("HOME"));
        assert!(ContextError::Invalid("relative".to_string())
            .message()
            .contains("relative"));
        assert!(managed_mcp_path().is_some());
    }
}
