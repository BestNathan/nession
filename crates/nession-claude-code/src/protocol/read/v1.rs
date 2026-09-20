//! `claude-code.read` / v1.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::v1_descriptor;
use crate::security::{MAX_CHUNK_SIZE, MAX_FILE_SIZE};

pub const WIRE: &str = "extension.claude_code.read";

/// Which `.claude/` directory the caller means.
///
/// A closed enum rather than a string: `scope` used to be free text defaulting
/// to `"global"`, and an unrecognised value silently resolved to *no* directory
/// — a typo became an empty answer rather than a refusal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    #[default]
    Global,
    Project,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
pub struct ReadRequestV1 {
    #[serde(default)]
    pub scope: Scope,
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub session_id: Option<String>,
    #[serde(default)]
    pub path: String,
    /// Byte offset into the file.
    #[serde(default)]
    pub offset: u64,
    /// How many bytes to return.
    ///
    /// A **request**, clamped to [`MAX_CHUNK_SIZE`] — which it was not before
    /// this contract existed. See [`chunk`] for what an unclamped one did.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub limit: Option<u64>,
}

/// The success shape.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
pub struct ReadOkV1 {
    pub content: String,
    #[serde(rename = "content_type")]
    pub content_type: String,
    #[serde(rename = "total_size")]
    pub total_size: usize,
    pub offset: usize,
    #[serde(rename = "has_more")]
    pub has_more: bool,
}

/// What a caller gets instead of content.
///
/// The wire carries a bare code in `error`, sometimes with the metadata that
/// explains it. Typed faithfully: turning `error: "access_denied"` into a rich
/// error object is a contract change, not a migration.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
pub struct ReadFailureV1 {
    pub error: String,
    #[serde(
        default,
        rename = "total_size",
        skip_serializing_if = "Option::is_none"
    )]
    pub total_size: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(
        default,
        rename = "content_type",
        skip_serializing_if = "Option::is_none"
    )]
    pub content_type: Option<String>,
}

impl ReadFailureV1 {
    pub fn new(error: impl Into<String>) -> Self {
        Self {
            error: error.into(),
            total_size: None,
            content: None,
            content_type: None,
        }
    }

    /// The oversized-file answer, which carries the size that explains it.
    pub fn file_too_large(total_size: usize) -> Self {
        Self {
            error: "file_too_large".to_string(),
            total_size: Some(total_size),
            content: Some(String::new()),
            content_type: Some("text".to_string()),
        }
    }
}

/// Either content or a refusal, distinguished on the wire by which fields are
/// present rather than by a discriminator.
///
/// `untagged` because that is what the shipped shape is. Serialisation emits
/// the inner value unchanged, which is all this provider does with a response —
/// nothing deserialises one, so the usual caution about untagged enums does not
/// apply here.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[serde(untagged)]
pub enum ReadResponseV1 {
    Ok(ReadOkV1),
    Failed(ReadFailureV1),
}

/// The byte range to return, and whether anything follows it.
///
/// ## What this replaces
///
/// The previous code was `let end = min(offset + limit, len)` with both operands
/// straight from the client, then `content[offset..end]`. Run in a release build
/// (which is what ships) with `offset: 100`, `limit: u64::MAX` and a 1000-byte
/// file, that is:
///
/// ```text
/// offset + limit wraps to 99
/// end = min(99, 1000) = 99
/// panicked: begin > end (100 > 99) when slicing
/// ```
///
/// A debug build panics one step earlier, on the addition itself, so the slice
/// failure is the one that reaches production. Either way a `limit` from a peer
/// could take down the task serving it.
///
/// Saturating arithmetic and a clamp, so the failure mode is a short answer
/// rather than a crash. `MAX_CHUNK_SIZE` is now the ceiling it always read as
/// being: before, it was only the default when `limit` was absent.
pub fn chunk(content_len: usize, offset: u64, limit: Option<u64>) -> (usize, usize, bool) {
    let offset = usize::try_from(offset).unwrap_or(usize::MAX);
    if offset >= content_len {
        return (content_len, content_len, false);
    }

    let requested = limit
        .and_then(|l| usize::try_from(l).ok())
        .unwrap_or(MAX_CHUNK_SIZE)
        .min(MAX_CHUNK_SIZE);

    // Saturating, not wrapping: an enormous request is answered with the rest of
    // the file rather than with an arithmetic overflow.
    let end = offset.saturating_add(requested).min(content_len);
    (offset, end, end < content_len)
}

/// How many bytes of a file one answer may carry.
pub const CHUNK_CEILING: usize = MAX_CHUNK_SIZE;

/// The largest file this provider will read at all.
pub const FILE_CEILING: usize = MAX_FILE_SIZE;

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_limit_of_u64_max_returns_the_rest_of_the_file_rather_than_panicking() {
        // The regression this exists for. `min(offset + limit, len)` with both
        // operands from the client overflowed: debug panicked on the addition,
        // release wrapped to `len - 1` and then panicked on the slice.
        let (start, end, has_more) = chunk(1000, 100, Some(u64::MAX));
        assert_eq!((start, end), (100, 1000));
        assert!(!has_more);
        assert!(end <= 1000 && start <= end, "the range must stay ordered");
    }

    #[test]
    fn a_limit_over_the_ceiling_is_clamped_to_it() {
        let (start, end, has_more) = chunk(1_000_000, 0, Some(u64::MAX));
        assert_eq!(start, 0);
        assert_eq!(
            end, MAX_CHUNK_SIZE,
            "MAX_CHUNK_SIZE is a ceiling, not only a default"
        );
        assert!(has_more);
    }

    #[test]
    fn an_absent_limit_takes_the_default_chunk() {
        assert_eq!(chunk(1_000_000, 0, None), (0, MAX_CHUNK_SIZE, true));
    }

    #[test]
    fn an_offset_past_the_end_is_an_empty_answer_not_a_panic() {
        assert_eq!(chunk(100, u64::MAX, Some(10)), (100, 100, false));
        assert_eq!(chunk(100, 100, Some(10)), (100, 100, false));
    }

    #[test]
    fn a_chunk_that_reaches_the_end_says_there_is_no_more() {
        assert_eq!(chunk(500, 400, Some(100)), (400, 500, false));
        assert_eq!(chunk(500, 400, Some(99)), (400, 499, true));
    }

    #[test]
    fn the_offset_comes_back_as_it_was_asked_for() {
        // The response echoes `offset`, and the Web client uses it to request
        // the next chunk; echoing a clamped value would skip bytes.
        let (start, _, _) = chunk(1_000_000, 999_999, Some(10));
        assert_eq!(start, 999_999);
    }

    #[test]
    fn a_scope_typo_is_refused_rather_than_silently_resolving_to_nothing() {
        // `scope` used to be free text; an unrecognised value fell to `_ => None`
        // and produced an empty answer, so a typo looked like an empty directory.
        let err = serde_json::from_value::<ReadRequestV1>(json!({"scope": "globel"})).unwrap_err();
        assert!(err.to_string().contains("scope") || err.to_string().contains("variant"));
        assert_eq!(
            serde_json::from_value::<ReadRequestV1>(json!({}))
                .unwrap()
                .scope,
            Scope::Global
        );
    }

    #[test]
    fn the_ok_response_serialises_in_the_shipped_wire_shape() {
        let response = ReadResponseV1::Ok(ReadOkV1 {
            content: "abc".to_string(),
            content_type: "text".to_string(),
            total_size: 3,
            offset: 0,
            has_more: false,
        });
        let value = serde_json::to_value(&response).unwrap();
        assert_eq!(value["content"], "abc");
        assert_eq!(value["content_type"], "text");
        assert_eq!(value["total_size"], 3);
        assert_eq!(value["has_more"], false);
    }

    #[test]
    fn a_bare_refusal_stays_bare() {
        // `{ "error": "access_denied" }` and nothing else. The metadata fields
        // are present only when they explain something.
        let response = ReadResponseV1::Failed(ReadFailureV1::new("access_denied"));
        let value = serde_json::to_value(&response).unwrap();
        assert_eq!(value, json!({"error": "access_denied"}));
    }

    #[test]
    fn the_oversized_file_refusal_carries_its_size() {
        let response = ReadResponseV1::Failed(ReadFailureV1::file_too_large(2_000_000));
        let value = serde_json::to_value(&response).unwrap();
        assert_eq!(value["error"], "file_too_large");
        assert_eq!(value["total_size"], 2_000_000);
        assert_eq!(value["content"], "");
    }

    #[test]
    fn the_descriptor_names_this_unit_its_owner_and_its_wire_type() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "claude-code.read");
        assert_eq!(d.owner, "nession-claude-code");
        assert_eq!(
            d.contracts[0].wire,
            vec!["extension.claude_code.read".to_string()]
        );
        assert!(d.validate().is_ok());
    }
}
