use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileListPayload {
    pub path: String,
}

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileWritePayload {
    pub path: String,
    /// Base64-encoded content.
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileWriteResponse {
    pub path: String,
    pub written: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDeletePayload {
    pub path: String,
    /// Delete a directory's contents too. Defaults to `false` so an older
    /// client keeps the previous empty-directory-only behaviour.
    #[serde(default)]
    pub recursive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileCreateDirPayload {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRenamePayload {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileCwdPayload {
    /// Web UI session_id in "agent_id:session_name" format.
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileCwdResponse {
    pub path: String,
}
