use serde::{Deserialize, Serialize};

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileListPayload {
    pub path: String,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileReadPayload {
    pub path: String,
    /// Byte offset for chunked reads. `None` means start from beginning.
    ///
    /// `skip_serializing_if` as well as `default`, which is the rule this
    /// directory follows for every skippable `Option`: serde reads a missing
    /// key as `None` with `default` alone, but without the skip the field is
    /// written as `null` — a *stated* absence where the contract says the key
    /// may simply not be there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    /// Maximum bytes to return for chunked reads. `None` means use default chunk size.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileWritePayload {
    pub path: String,
    /// Base64-encoded content.
    pub content: String,
    /// Refuse the write unless the target's current revision equals this value.
    ///
    /// A reader passes back the `revision` from {@link FileData}; if the file
    /// changed in between, the agent answers `conflict` instead of silently
    /// overwriting the newer content. `None` keeps the historical
    /// unconditional-write behaviour for older clients.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<String>,
    /// Refuse the write unless the target does not already exist.
    ///
    /// "Create file" and upload use this so two clients racing on the same
    /// name cannot replace each other's content. Defaults to `false` for the
    /// historical write semantics.
    #[serde(default)]
    pub create_only: bool,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileWriteResponse {
    pub path: String,
    pub written: u64,
    /// Opaque revision of the file after the write, suitable for the next
    /// `expected_revision`.
    #[serde(default)]
    pub revision: String,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDeletePayload {
    pub path: String,
    /// Delete a directory's contents too. Defaults to `false` so an older
    /// client keeps the previous empty-directory-only behaviour.
    #[serde(default)]
    pub recursive: bool,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileCreateDirPayload {
    pub path: String,
    /// Refuse creation when the directory already exists. The App/Web folder
    /// actions use this so "New folder" reports the existing name instead of
    /// silently accepting it.
    #[serde(default)]
    pub create_only: bool,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRenamePayload {
    pub from: String,
    pub to: String,
    /// Refuse to replace an existing destination. Rename/move from the UI
    /// passes `true`; the historical unconditional rename default keeps older
    /// clients working.
    #[serde(default)]
    pub no_replace: bool,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileCwdPayload {
    /// Web UI session_id in "agent_id:session_name" format.
    pub session_id: String,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileCwdResponse {
    pub path: String,
}

// --- The listing and the mutation acknowledgements ---
//
// Four responses that were `serde_json::json!({ … })` at the handler until this
// family moved into the kernel. A fixed structure built inline is a contract
// nothing can name: no consumer can be typed against it, and no codegen can see
// it. `FileEntry` comes with them for the same reason `SessionInfo` came with
// the session family — the agent's filesystem model *was* the wire shape.

/// A filesystem entry returned by directory listing.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    /// Absolute path on the filesystem, for actions like "copy full path".
    pub full_path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
    /// Inferred MIME type (from file extension). Directories use "inode/directory".
    pub mime_type: String,
    /// Whether the file is binary (non-text) content.
    pub is_binary: bool,
}

/// Data returned by a file read operation.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileData {
    pub path: String,
    /// Base64-encoded file content.
    pub content: String,
    /// MIME type: "text/plain", "application/json".
    pub mime_type: String,
    /// Byte offset into the file where this chunk starts.
    #[serde(default)]
    pub offset: u64,
    /// Total file size in bytes.
    #[serde(default)]
    pub total_size: u64,
    /// Whether more bytes remain after this chunk.
    #[serde(default)]
    pub has_more: bool,
    /// Opaque revision of the file at read time.
    ///
    /// Derived from the file's metadata rather than a content hash so a
    /// chunked read never rehashes the file. Pass it back as
    /// `expected_revision` on write to refuse overwriting a newer file.
    #[serde(default)]
    pub revision: String,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileListResponse {
    pub entries: Vec<FileEntry>,
}

/// The acknowledgement `file.delete` and `file.create_dir` answer with.
///
/// `success` is always `true` when this is sent — a failure travels as the
/// error envelope — but it is carried, not dropped: it is on the wire today,
/// and a consumer reading it is not wrong to. Removing a field is a contract
/// version, not a transcription.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMutationResponse {
    pub path: String,
    pub success: bool,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRenameResponse {
    pub from: String,
    pub to: String,
    pub success: bool,
}
