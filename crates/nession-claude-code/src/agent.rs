//! The Claude Code extension on the agent side: the erased dispatcher boundary
//! for this provider (`#678`).
//!
//! Handles `claude_code.list` and `claude_code.read`, relayed from the server
//! via CommandBroker. Each operation decodes its typed request once and answers
//! with the contract's typed response, so `Value` lives only at the dispatcher
//! edge — the same shape `nession-git` uses, for the same reason.
//!
//! ## This provider's failure vocabulary is its own
//!
//! `nession-git` answers failures as `state: unavailable | not_a_repository |
//! error`; this one answers `{ error: "access_denied" }` and
//! `{ available: false }`. Two vocabularies for one concept is a real cost —
//! the Web client branches on both — but unifying them is a wire change that
//! needs a new contract version and a client update together, so this migration
//! types what ships rather than changing it in passing.

use std::path::PathBuf;

use async_trait::async_trait;
use nession_common::extension::AgentExtension;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tracing::debug;

use crate::protocol::list::{ListRequestV1, ListResponseV1};
use crate::protocol::read::{ReadFailureV1, ReadOkV1, ReadRequestV1, ReadResponseV1, Scope};
use crate::protocol::{list, read};
use crate::scanner;
use crate::security;

/// The one place a `Value` becomes a contract.
///
/// A malformed payload is answered rather than propagated, so the caller's
/// correlation id stays alive — a request that never gets a reply reads to the
/// UI as a hang, not an error.
fn decode<T: DeserializeOwned>(payload: Value) -> Result<T, ReadFailureV1> {
    serde_json::from_value(payload).map_err(|e| ReadFailureV1::new(format!("bad_request: {e}")))
}

/// The Claude Code extension on the agent side.
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

    /// Resolve the `.claude/` directory a scope names.
    ///
    /// `None` is "there is no such directory", which both operations answer as
    /// a state rather than an error.
    fn claude_root(&self, scope: Scope, session_id: Option<&str>) -> Option<PathBuf> {
        match scope {
            Scope::Global => security::claude_home_dir(),
            Scope::Project => self.resolve_project_claude_dir(session_id),
        }
    }

    async fn handle_list(&self, payload: Value) -> anyhow::Result<Value> {
        let request: ListRequestV1 = match decode(payload) {
            Ok(request) => request,
            Err(failure) => return Ok(serde_json::to_value(failure)?),
        };

        let Some(root) = self
            .claude_root(request.scope, request.session_id.as_deref())
            .filter(|dir| dir.exists())
        else {
            return Ok(serde_json::to_value(ListResponseV1::unavailable())?);
        };

        let mut categories = scanner::scan_claude_dir(&root);

        // History is only available at global scope: it lives under
        // `projects/*/`, which is a machine-wide record rather than a project's.
        if request.scope == Scope::Project {
            categories.retain(|c| c.name != "History");
        }

        Ok(serde_json::to_value(ListResponseV1::listing(categories))?)
    }

    async fn handle_read(&self, payload: Value) -> anyhow::Result<Value> {
        let request: ReadRequestV1 = match decode(payload) {
            Ok(request) => request,
            Err(failure) => return Ok(serde_json::to_value(failure)?),
        };

        Ok(serde_json::to_value(self.read(request))?)
    }

    /// The read itself, as a typed response.
    ///
    /// Split out from the handler so the security decisions and the pagination
    /// are readable in one place, and so the `?`-free path is obvious: every
    /// refusal here is a value the contract has a shape for.
    fn read(&self, request: ReadRequestV1) -> ReadResponseV1 {
        if !security::is_path_allowed(&request.path) {
            return ReadResponseV1::Failed(ReadFailureV1::new("access_denied"));
        }

        let Some(root) = self.claude_root(request.scope, request.session_id.as_deref()) else {
            return ReadResponseV1::Failed(ReadFailureV1::new("not_found"));
        };

        let Ok(full_path) = root.join(&request.path).canonicalize() else {
            return ReadResponseV1::Failed(ReadFailureV1::new("not_found"));
        };

        // The canonicalised path is checked against the canonicalised root, so a
        // symlink out of the tree is refused after resolution rather than before
        // it — checking the un-resolved join would miss exactly that case.
        let Ok(canonical_root) = root.canonicalize() else {
            return ReadResponseV1::Failed(ReadFailureV1::new("not_found"));
        };
        if !full_path.starts_with(&canonical_root) {
            return ReadResponseV1::Failed(ReadFailureV1::new("access_denied"));
        }

        let Ok(metadata) = std::fs::metadata(&full_path) else {
            return ReadResponseV1::Failed(ReadFailureV1::new("not_found"));
        };

        let total_size = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
        if total_size > security::MAX_FILE_SIZE {
            return ReadResponseV1::Failed(ReadFailureV1::file_too_large(total_size));
        }

        let Ok(content) = std::fs::read_to_string(&full_path) else {
            return ReadResponseV1::Failed(ReadFailureV1::new("binary_or_unreadable"));
        };

        // The bounds come from `chunk`, which clamps and saturates. The version
        // this replaced did `min(offset + limit, len)` on two client-supplied
        // numbers, which overflowed — see that function for what a
        // `limit: u64::MAX` used to do.
        let (start, end, has_more) = read::chunk(content.len(), request.offset, request.limit);

        ReadResponseV1::Ok(ReadOkV1 {
            // `get` rather than `[start..end]`: the range is proven ordered by
            // `chunk`, and stating it as a lookup keeps this free of the one
            // panic path a later edit could reintroduce.
            content: content.get(start..end).unwrap_or_default().to_string(),
            content_type: content_type_for(&request.path).to_string(),
            total_size,
            offset: start,
            has_more,
        })
    }

    /// Resolve the project-level `.claude/` directory from a session_id.
    ///
    /// The current SessionManager tracks tmux sessions by listing them via
    /// `tmux list-sessions`, which does not expose per-session working
    /// directories. This is a v1 limitation -- project scope will be fully
    /// implemented once SessionManager stores working_dir for individual
    /// sessions. Until then this answers `not_found`, which is truthful: there
    /// is no directory it can name.
    fn resolve_project_claude_dir(&self, session_id: Option<&str>) -> Option<PathBuf> {
        if session_id.is_some() {
            debug!("project-level claude_code requires session working_dir, not yet available");
        }
        None
    }
}

fn content_type_for(path: &str) -> &'static str {
    if path.ends_with(".json") {
        "json"
    } else if path.ends_with(".jsonl") {
        "jsonl"
    } else if path.ends_with(".md") {
        "markdown"
    } else {
        "text"
    }
}

#[async_trait]
impl AgentExtension for ClaudeCodeAgentExtension {
    fn name(&self) -> &'static str {
        "claude_code"
    }

    /// Each wire type is named once, in the contract that owns it.
    fn message_types(&self) -> &'static [&'static str] {
        &[list::v1::WIRE, read::v1::WIRE]
    }

    /// Dispatch on the **command suffix**, which for this provider is not the
    /// protocol id.
    ///
    /// The registry strips `extension.` and passes the remainder — here
    /// `claude_code.read`, while the id is `claude-code.read`. `ProtocolId`
    /// refuses underscores, so the two cannot be made equal, and the wire
    /// spelling cannot change without breaking peers. Translating explicitly is
    /// what the design means by calling the message type a projection.
    async fn handle_command(&self, command: &str, payload: Value) -> anyhow::Result<Value> {
        match command {
            list::COMMAND => self.handle_list(payload).await,
            read::COMMAND => self.handle_read(payload).await,
            other => anyhow::bail!("unknown claude_code command: {other}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::MAX_CHUNK_SIZE;

    #[test]
    fn the_command_suffix_is_the_wire_type_without_its_namespace() {
        // The registry's silent transform, asserted. `nession-git` gets to
        // compare against its ids here; this provider has to translate, and the
        // translation is checked rather than assumed.
        for (wire, command) in [
            (list::v1::WIRE, list::COMMAND),
            (read::v1::WIRE, read::COMMAND),
        ] {
            assert_eq!(wire.strip_prefix("extension."), Some(command));
        }
    }

    #[test]
    fn the_advertised_message_types_are_the_contracts_own_wire_types() {
        let extension = ClaudeCodeAgentExtension::new();
        assert_eq!(extension.message_types(), &[list::v1::WIRE, read::v1::WIRE]);
    }

    #[test]
    fn the_protocol_ids_are_the_canonical_spelling_not_the_wire_one() {
        // `claude_code.read` is what travels; `claude-code.read` is what the
        // protocol is. Both are asserted so neither can drift into the other.
        assert_eq!(list::ID, "claude-code.list");
        assert_eq!(read::ID, "claude-code.read");
        assert_eq!(list::COMMAND, "claude_code.list");
        assert_eq!(read::COMMAND, "claude_code.read");
    }

    #[test]
    fn a_malformed_payload_is_answered_rather_than_propagated() {
        let failure = decode::<ReadRequestV1>(serde_json::json!({"scope": "globel"})).unwrap_err();
        let value = serde_json::to_value(ReadResponseV1::Failed(failure)).unwrap();
        assert!(
            value["error"]
                .as_str()
                .unwrap_or("")
                .starts_with("bad_request"),
            "got {value}"
        );
    }

    #[test]
    fn the_chunk_ceiling_is_what_the_bound_actually_uses() {
        // Pinned so the constant and the clamp cannot drift apart: the read path
        // calls `chunk`, which clamps to this.
        assert_eq!(read::CHUNK_CEILING, MAX_CHUNK_SIZE);
        assert_eq!(
            read::chunk(MAX_CHUNK_SIZE * 4, 0, Some(u64::MAX)).1,
            MAX_CHUNK_SIZE
        );
    }

    #[test]
    fn content_type_follows_the_extension() {
        assert_eq!(content_type_for("settings.json"), "json");
        assert_eq!(content_type_for("history.jsonl"), "jsonl");
        assert_eq!(content_type_for("CLAUDE.md"), "markdown");
        assert_eq!(content_type_for("notes.txt"), "text");
    }

    #[test]
    fn project_scope_has_no_directory_and_says_so() {
        // The v1 limitation, pinned rather than left to be rediscovered: with a
        // session id it still resolves to nothing, so a read answers `not_found`
        // instead of reading the wrong tree.
        let extension = ClaudeCodeAgentExtension::new();
        assert_eq!(extension.resolve_project_claude_dir(Some("agent:s")), None);
        assert_eq!(extension.resolve_project_claude_dir(None), None);
    }

    #[test]
    fn a_path_outside_the_allowed_set_is_refused_before_anything_is_opened() {
        let extension = ClaudeCodeAgentExtension::new();
        let response = extension.read(ReadRequestV1 {
            scope: Scope::Global,
            session_id: None,
            path: "../../../etc/passwd".to_string(),
            offset: 0,
            limit: None,
        });
        let value = serde_json::to_value(response).unwrap();
        // Either the allowlist refuses it or the root cannot be resolved; both
        // are refusals, and neither opens the file.
        assert!(
            matches!(
                value["error"].as_str(),
                Some("access_denied") | Some("not_found")
            ),
            "got {value}"
        );
    }
}
