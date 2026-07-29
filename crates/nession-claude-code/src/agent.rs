use async_trait::async_trait;
use nession_common::extension::AgentExtension;
use serde_json::Value;
use tracing::debug;

use crate::scanner;
use crate::security::{self, MAX_CHUNK_SIZE};

/// The Claude Code extension on the agent side.
/// Handles `claude_code.list` and `claude_code.read` commands
/// relayed from the server via CommandBroker.
pub struct ClaudeCodeAgentExtension;

impl Default for ClaudeCodeAgentExtension {
    fn default() -> Self {
        Self
    }
}

impl ClaudeCodeAgentExtension {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl AgentExtension for ClaudeCodeAgentExtension {
    fn name(&self) -> &'static str {
        "claude_code"
    }

    fn message_types(&self) -> &'static [&'static str] {
        &["extension.claude_code.list", "extension.claude_code.read"]
    }

    async fn handle_command(&self, command: &str, payload: Value) -> anyhow::Result<Value> {
        match command {
            "claude_code.list" => self.handle_list(payload).await,
            "claude_code.read" => self.handle_read(payload).await,
            _ => anyhow::bail!("unknown claude_code command: {command}"),
        }
    }
}

impl ClaudeCodeAgentExtension {
    async fn handle_list(&self, payload: Value) -> anyhow::Result<Value> {
        let scope = payload
            .get("scope")
            .and_then(|v| v.as_str())
            .unwrap_or("global");
        let session_id = payload.get("session_id").and_then(|v| v.as_str());

        let claude_root = match scope {
            "global" => security::claude_home_dir(),
            "project" => self.resolve_project_claude_dir(session_id),
            _ => None,
        };

        let claude_root = match claude_root {
            Some(dir) if dir.exists() => dir,
            _ => {
                return Ok(serde_json::json!({
                    "available": false,
                    "categories": []
                }));
            }
        };

        let mut categories = scanner::scan_claude_dir(&claude_root);

        // History is only available at global scope
        if scope == "project" {
            categories.retain(|c| c.name != "History");
        }

        Ok(serde_json::to_value(serde_json::json!({
            "available": true,
            "categories": categories,
        }))?)
    }

    async fn handle_read(&self, payload: Value) -> anyhow::Result<Value> {
        let scope = payload
            .get("scope")
            .and_then(|v| v.as_str())
            .unwrap_or("global");
        let path = payload.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let offset: usize = payload
            .get("offset")
            .and_then(serde_json::Value::as_u64)
            .and_then(|v| usize::try_from(v).ok())
            .unwrap_or(0);
        let limit: usize = payload
            .get("limit")
            .and_then(serde_json::Value::as_u64)
            .and_then(|v| usize::try_from(v).ok())
            .unwrap_or(MAX_CHUNK_SIZE);
        let session_id = payload.get("session_id").and_then(|v| v.as_str());

        // Security check
        if !security::is_path_allowed(path) {
            return Ok(serde_json::json!({ "error": "access_denied" }));
        }

        let claude_root = match scope {
            "global" => security::claude_home_dir(),
            "project" => self.resolve_project_claude_dir(session_id),
            _ => None,
        };

        let claude_root = match claude_root {
            Some(d) => d,
            None => return Ok(serde_json::json!({ "error": "not_found" })),
        };

        // Resolve full path
        let full_path = claude_root.join(path);
        let full_path = match full_path.canonicalize() {
            Ok(p) => p,
            Err(_) => return Ok(serde_json::json!({ "error": "not_found" })),
        };

        // Double-check canonicalized path is within claude_root
        let canonical_root = claude_root.canonicalize().unwrap_or(claude_root.clone());
        if !full_path.starts_with(&canonical_root) {
            return Ok(serde_json::json!({ "error": "access_denied" }));
        }

        // Read file metadata
        let metadata = match std::fs::metadata(&full_path) {
            Ok(m) => m,
            Err(e) => return Ok(serde_json::json!({ "error": e.to_string() })),
        };

        let total_size = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
        if total_size > security::MAX_FILE_SIZE {
            return Ok(serde_json::json!({
                "error": "file_too_large",
                "total_size": total_size,
                "content": "",
                "content_type": "text",
            }));
        }

        // Read file content
        let content = match std::fs::read_to_string(&full_path) {
            Ok(c) => c,
            Err(_) => "[binary or unreadable]".to_string(),
        };

        // Apply pagination (offset + limit)
        let chunked = if offset >= content.len() {
            String::new()
        } else {
            let end = std::cmp::min(offset + limit, content.len());
            content[offset..end].to_string()
        };

        let content_type = if path.ends_with(".json") {
            "json"
        } else if path.ends_with(".jsonl") {
            "jsonl"
        } else if path.ends_with(".md") {
            "markdown"
        } else {
            "text"
        };

        Ok(serde_json::json!({
            "content": chunked,
            "content_type": content_type,
            "total_size": total_size,
            "offset": offset,
            "has_more": offset + limit < content.len(),
        }))
    }

    /// Resolve the project-level .claude/ directory from a session_id.
    ///
    /// The current SessionManager tracks tmux sessions by listing them via
    /// `tmux list-sessions`, which does not expose per-session working
    /// directories. This is a v1 limitation -- project scope will be fully
    /// implemented once SessionManager stores working_dir for individual
    /// sessions. For now, project-level config resolution is not available.
    fn resolve_project_claude_dir(&self, session_id: Option<&str>) -> Option<std::path::PathBuf> {
        if session_id.is_some() {
            debug!("project-level claude_code requires session working_dir, not yet available");
        }
        None
    }
}
