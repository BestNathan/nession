//! `git.preview` / v1.
//!
//! A status row can describe a path Git has no diff for: an untracked file, or
//! an unmerged file that exists only in the worktree. `git.diff` must not be
//! stretched to mean "raw file content" — that would make one operation answer
//! two different questions and turn a bounded diff into a file browser. This
//! operation is the small, typed read the Git capability actually needs.

use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::{Deserialize, Serialize};

use crate::protocol::{v1_descriptor, GitResponseV1, SessionTargetV1};

pub const WIRE: &str = "git.preview";

/// The status row the caller selected.
///
/// This is a hint, not an authority: the Agent re-reads the repository and
/// refuses a path whose current status no longer matches. It exists because the
/// selected row is the source of the preview mode, and a client that guessed a
/// mode from an empty diff would be the failure this operation replaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum PreviewExpectedV1 {
    Untracked,
    Unmerged,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum PreviewWantV1 {
    /// UTF-8 text for a person to read (the #2838 contract).
    #[default]
    Text,
    /// Complete, bounded media bytes for a recognized media path (#2876).
    Media,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct PreviewRequestV1 {
    #[serde(flatten)]
    pub target: SessionTargetV1,
    /// Repository-relative. Validated agent-side before any file is opened.
    pub path: String,
    /// The row kind the caller selected.
    pub expected: PreviewExpectedV1,
    /// Omitted by the text-preview client; `media` asks for raw bytes.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub want: Option<PreviewWantV1>,
}

/// What the file read produced, before the generic git failure variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum FilePreviewStateV1 {
    /// Content is available (possibly truncated); `binary` distinguishes text.
    Ready,
    /// The path is no longer present in the worktree.
    Missing,
    /// The Agent could not read the path because access was denied.
    Denied,
    /// The path's repository identity or Git status changed since selection.
    Changed,
    /// The path is a symlink, directory or other entry a preview cannot read.
    Unsupported,
    /// A media request whose complete file exceeds the bounded media read.
    TooLarge,
}

/// Complete media bytes for one authorized path.
///
/// Never a prefix: a truncated prefix is not a playable/decodable file, so an
/// oversized answer is `TooLarge` instead of a partial payload.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct MediaPayloadV1 {
    pub content_base64: String,
    /// The MIME type validated from the bytes, not merely the extension.
    pub mime_type: String,
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct FilePreview {
    pub path: String,
    pub state: FilePreviewStateV1,
    /// UTF-8 text for a text file. Empty for binary/missing/denied/changed/
    /// unsupported answers.
    pub text: String,
    /// True when the bytes are not a safely decodable UTF-8 text file.
    pub binary: bool,
    /// Total size reported by the opened file, when known.
    pub size: u64,
    /// True when only a prefix is present; `truncated_bytes` is then the real
    /// number of omitted bytes from the complete file.
    pub truncated: bool,
    pub truncated_bytes: usize,
    /// Human-readable detail for a non-ready state, or a binary/unsupported
    /// explanation. Never a substitute for the typed `state`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Present only on a `want: media` answer that returned complete bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<MediaPayloadV1>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct PreviewOkV1 {
    pub preview: FilePreview,
}

pub fn descriptor() -> Result<ProtocolDescriptor, IdentityError> {
    v1_descriptor(super::ID, WIRE)
}

pub type PreviewResponseV1 = GitResponseV1<PreviewOkV1>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_names_a_session_a_relative_path_and_an_expected_kind() {
        let ok: PreviewRequestV1 = serde_json::from_value(serde_json::json!({
            "session": "s",
            "path": "notes/new.rs",
            "expected": "untracked"
        }))
        .unwrap();
        assert_eq!(ok.path, "notes/new.rs");
        assert_eq!(ok.expected, PreviewExpectedV1::Untracked);

        assert!(
            serde_json::from_value::<PreviewRequestV1>(serde_json::json!({
                "session": "s", "path": "x"
            }))
            .is_err()
        );
    }

    #[test]
    fn the_descriptor_names_this_unit_its_owner_and_its_wire_type() {
        let d = descriptor().unwrap();
        assert_eq!(d.id.as_str(), "git.preview");
        assert_eq!(d.owner, "nession-git");
        assert_eq!(d.contracts[0].wire, vec!["git.preview".to_string()]);
        assert!(d.validate().is_ok());
    }
}
