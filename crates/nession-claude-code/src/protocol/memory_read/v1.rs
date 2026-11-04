//! `claude-code.memory-read` / v1 (#2689).
//!
//! One Markdown file out of the Session's resolved Auto Memory directory,
//! paginated by byte offset. The request names a Session, the `memory_directory`
//! its caller last saw, and a **relative** path; the root is re-resolved from
//! that Session on every call. A directory mismatch is `stale_memory` and opens
//! nothing, so a Session that changes repository between listing and reading
//! cannot return the new repository's file under the old list. The expected
//! directory is compared, never joined — a read can never be pointed at another
//! repository by carrying a path from somewhere else. Path validation,
//! canonical-root containment, the 1 MiB file ceiling and the 100 KiB chunk
//! ceiling are the same implementation `claude-code.read` uses — this unit adds
//! the memory-specific restriction to Markdown files, not a second reader.
//!
//! The success and failure shapes are `claude-code.read`'s, reused deliberately:
//! the Web folds both answers with one function, and two near-identical unions
//! would be two places for the failure/success discrimination to drift.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::Deserialize;

use crate::protocol::read::v1::ReadResponseV1;
use crate::protocol::v1_descriptor;

pub const WIRE: &str = "claude-code.memory-read";

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct MemoryReadRequestV1 {
    /// Required: the memory root is a fact about one Session.
    pub session_id: String,
    /// The `memory_directory` the caller last saw from `claude-code.memory`.
    ///
    /// Compared with the directory re-resolved for this request; a mismatch is
    /// `stale_memory` and opens nothing. It is **not** used as a read path — the
    /// root is still resolved from the Session — so a caller cannot point this
    /// at another repository, and a Session that moved between the list and the
    /// read cannot return the new repository's file under the old list.
    pub memory_directory: String,
    /// Relative to the resolved memory directory. Absolute paths, `..`
    /// components and non-Markdown extensions are refused.
    pub path: String,
    /// Byte offset into the file.
    #[serde(default)]
    pub offset: u64,
    /// How many bytes to return, clamped to the read unit's chunk ceiling.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub limit: Option<u64>,
}

pub type MemoryReadResponseV1 = ReadResponseV1;

pub use crate::protocol::read::v1::{
    ReadFailureV1 as MemoryReadFailureV1, ReadOkV1 as MemoryReadOkV1,
};

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_request_names_a_session_a_snapshot_a_relative_path_and_a_page_start() {
        let request: MemoryReadRequestV1 = serde_json::from_value(json!({
            "session_id": "agent:s",
            "memory_directory": "/home/u/.claude/projects/-work-repo/memory",
            "path": "MEMORY.md",
            "offset": 100,
            "limit": 200,
        }))
        .unwrap();
        assert_eq!(request.session_id, "agent:s");
        assert_eq!(
            request.memory_directory,
            "/home/u/.claude/projects/-work-repo/memory"
        );
        assert_eq!(request.path, "MEMORY.md");
        assert_eq!(request.offset, 100);
        assert_eq!(request.limit, Some(200));

        let minimal: MemoryReadRequestV1 = serde_json::from_value(json!({
            "session_id": "agent:s",
            "memory_directory": "/m",
            "path": "topic.md",
        }))
        .unwrap();
        assert_eq!(minimal.offset, 0);
        assert_eq!(minimal.limit, None);
    }

    #[test]
    fn a_request_without_a_required_field_is_malformed() {
        assert!(serde_json::from_value::<MemoryReadRequestV1>(json!({
            "memory_directory": "/m",
            "path": "MEMORY.md",
        }))
        .is_err());
        assert!(serde_json::from_value::<MemoryReadRequestV1>(json!({
            "session_id": "s",
            "path": "MEMORY.md",
        }))
        .is_err());
        assert!(serde_json::from_value::<MemoryReadRequestV1>(json!({
            "session_id": "s",
            "memory_directory": "/m",
        }))
        .is_err());
    }

    #[test]
    fn the_response_is_the_read_units_union() {
        use super::super::v1::{MemoryReadFailureV1, MemoryReadOkV1};

        // The alias is load-bearing: the Web imports one response folder for
        // both units, so a future divergence is a type error, not a silent
        // second shape.
        let ok: MemoryReadResponseV1 = ReadResponseV1::Ok(MemoryReadOkV1 {
            content: "hello".to_string(),
            content_type: "markdown".to_string(),
            total_size: 5,
            offset: 0,
            has_more: false,
        });
        assert_eq!(serde_json::to_value(ok).unwrap()["content"], "hello");

        let failed: MemoryReadResponseV1 =
            ReadResponseV1::Failed(MemoryReadFailureV1::new("access_denied"));
        assert_eq!(
            serde_json::to_value(failed).unwrap(),
            json!({"error": "access_denied"})
        );
    }

    #[test]
    fn the_descriptor_names_this_unit_its_owner_and_its_wire_type() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "claude-code.memory-read");
        assert_eq!(d.owner, "nession-claude-code");
        assert_eq!(
            d.contracts[0].wire,
            vec!["claude-code.memory-read".to_string()]
        );
        assert!(d.validate().is_ok());
    }
}
