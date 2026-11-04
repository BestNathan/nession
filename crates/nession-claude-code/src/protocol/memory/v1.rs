//! `claude-code.memory` / v1 (#2689).
//!
//! The Auto Memory of the repository the current Session is in. One request
//! names a Session and nothing else: the repository is derived from that
//! Session's authoritative working directory, never from a client-supplied
//! path, a project picker, or a machine-wide scan.
//!
//! ## One closed state vocabulary, because "no" has several meanings
//!
//! `ready` is the only state that carries files. The others answer different
//! questions and must not be collapsed into one another:
//!
//! - `unavailable` — the host cannot name the Session or its working directory.
//! - `no_memory` — the Session's repository resolved, but no memory directory
//!   exists yet. This is the ordinary first-use answer.
//! - `disabled` — Claude Code's own `autoMemoryEnabled` setting is off.
//! - `unsupported_override` — the effective memory location depends on a
//!   setting or environment override this host cannot verify. Never rendered
//!   as the default directory.
//! - `error` — the filesystem refused a read the resolution depends on.
//!
//! ## The path fields are disclosure, not input
//!
//! `repository_root` and `memory_directory` state what was resolved, so a
//! client can tell the user *where* the answer came from instead of presenting
//! an opaque list. Nothing in a later request names either path; the read unit
//! re-resolves the same root from the Session and only accepts a relative file
//! path inside it.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::v1_descriptor;

pub const WIRE: &str = "claude-code.memory";

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct MemoryRequestV1 {
    /// Required: Memory is a fact about one Session.
    pub session_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MemoryStateV1 {
    Ready,
    Unavailable,
    NoMemory,
    Disabled,
    UnsupportedOverride,
    Error,
}

/// Which identity produced the project key.
///
/// `project_root` is Claude Code's documented fallback outside a Git
/// repository; it is not an error and not a global scan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MemoryRepositoryKindV1 {
    Git,
    ProjectRoot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct MemoryFileV1 {
    /// Relative to the memory directory, `/`-separated on every platform.
    pub path: String,
    pub size: usize,
    pub content_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct MemoryResponseV1 {
    pub state: MemoryStateV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository_kind: Option<MemoryRepositoryKindV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_directory: Option<String>,
    /// Empty for every state but `ready`.
    #[serde(default)]
    pub files: Vec<MemoryFileV1>,
    /// The listing met its file-count or depth bound. `files` is still a valid
    /// prefix, ordered with `MEMORY.md` first.
    #[serde(default)]
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl MemoryResponseV1 {
    pub fn bare(state: MemoryStateV1) -> Self {
        Self {
            state,
            repository_root: None,
            repository_kind: None,
            memory_directory: None,
            files: Vec::new(),
            truncated: false,
            error: None,
        }
    }

    pub fn with_error(state: MemoryStateV1, error: impl Into<String>) -> Self {
        Self {
            error: Some(error.into()),
            ..Self::bare(state)
        }
    }

    /// The disclosure fields, attached to a state that knows them.
    pub fn describing(mut self, root: impl Into<String>, kind: MemoryRepositoryKindV1) -> Self {
        self.repository_root = Some(root.into());
        self.repository_kind = Some(kind);
        self
    }

    pub fn at(mut self, directory: impl Into<String>) -> Self {
        self.memory_directory = Some(directory.into());
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
        let request: MemoryRequestV1 =
            serde_json::from_value(json!({"session_id": "agent:s"})).unwrap();
        assert_eq!(request.session_id, "agent:s");
        assert!(serde_json::from_value::<MemoryRequestV1>(json!({})).is_err());
    }

    #[test]
    fn every_state_serialises_in_snake_case() {
        assert_eq!(
            serde_json::to_value(MemoryStateV1::UnsupportedOverride).unwrap(),
            json!("unsupported_override")
        );
        assert_eq!(
            serde_json::to_value(MemoryStateV1::NoMemory).unwrap(),
            json!("no_memory")
        );
    }

    #[test]
    fn a_bare_answer_omits_every_disclosure_field() {
        let value =
            serde_json::to_value(MemoryResponseV1::bare(MemoryStateV1::Unavailable)).unwrap();
        assert_eq!(
            value,
            json!({"state": "unavailable", "files": [], "truncated": false})
        );
    }

    #[test]
    fn a_ready_answer_carries_its_files_and_source() {
        let response = MemoryResponseV1 {
            files: vec![MemoryFileV1 {
                path: "MEMORY.md".to_string(),
                size: 12,
                content_type: "markdown".to_string(),
            }],
            ..MemoryResponseV1::bare(MemoryStateV1::Ready)
        }
        .describing("/work/repo", MemoryRepositoryKindV1::Git)
        .at("/home/u/.claude/projects/-work-repo/memory");

        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["state"], "ready");
        assert_eq!(value["repository_root"], "/work/repo");
        assert_eq!(value["repository_kind"], "git");
        assert_eq!(
            value["memory_directory"],
            "/home/u/.claude/projects/-work-repo/memory"
        );
        assert_eq!(value["files"][0]["path"], "MEMORY.md");
        assert!(value.get("error").is_none());
    }

    #[test]
    fn the_descriptor_names_this_unit_its_owner_and_its_wire_type() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "claude-code.memory");
        assert_eq!(d.owner, "nession-claude-code");
        assert_eq!(d.contracts[0].wire, vec!["claude-code.memory".to_string()]);
        assert!(d.validate().is_ok());
    }
}
