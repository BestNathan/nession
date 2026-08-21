use anyhow::{Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use tokio::task;

use super::sandbox::PathSandbox;

/// Maximum file size for the legacy (no offset/limit) read path (10 MB).
const MAX_READ_SIZE: u64 = 10 * 1024 * 1024;
/// Absolute ceiling for chunked reads (50 MB).
const MAX_CHUNKED_READ_SIZE: u64 = 50 * 1024 * 1024;
/// Default chunk size when the caller supplies a limit of `None` (256 KB).
const DEFAULT_CHUNK_SIZE: u64 = 256 * 1024;

/// Application MIME subtypes that are actually text-based.
const TEXT_LIKE_APPLICATION_TYPES: &[&str] = &[
    "application/json",
    "application/javascript",
    "application/xml",
    "application/x-yaml",
    "application/toml",
    "application/x-sh",
    "application/x-shellscript",
    "application/sql",
    "application/graphql",
    "application/xhtml+xml",
    "application/x-www-form-urlencoded",
];

/// Returns `true` when a MIME type represents binary (non-text) content.
fn is_binary_mime(mime: &str) -> bool {
    if mime.starts_with("text/") {
        return false;
    }
    !TEXT_LIKE_APPLICATION_TYPES.contains(&mime)
}

/// A filesystem entry returned by directory listing.
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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileData {
    pub path: String,
    /// Base64-encoded file content.
    pub content: String,
    /// MIME type (e.g. "text/plain", "application/json").
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
}

/// High-level file operations scoped to a sandbox root.
pub struct FileOps {
    sandbox: PathSandbox,
}

impl FileOps {
    pub fn new(sandbox: PathSandbox) -> Self {
        Self { sandbox }
    }

    /// Convert an absolute path to a sandbox-relative path for use with list_dir etc.
    pub fn relative_path(&self, abs_path: &str) -> Result<String> {
        self.sandbox.relative_path(abs_path)
    }

    /// List entries in a directory. Sorted: directories first, then files,
    /// both alphabetically by name.
    pub async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>> {
        let resolved = self.sandbox.resolve(path)?;

        // Deliberately not Path::is_dir(): it returns false for *any* metadata
        // failure, so a missing path or an unreadable parent were all reported
        // as "not_a_directory" — which sent debugging in the wrong direction.
        // Stat explicitly so each condition gets its own message.
        match fs::metadata(&resolved) {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => anyhow::bail!("not_a_directory: {path}"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                anyhow::bail!("not_found: {path} (resolved to {})", resolved.display())
            }
            Err(e) => {
                return Err(anyhow::Error::from(e)).with_context(|| {
                    format!("failed to stat {path} (resolved to {})", resolved.display())
                })
            }
        }

        let root = self.sandbox.root().to_path_buf();

        let entries = task::spawn_blocking(move || -> Result<Vec<FileEntry>> {
            let mut result: Vec<FileEntry> = Vec::new();
            let dir = fs::read_dir(&resolved)
                .with_context(|| format!("failed to read directory: {}", resolved.display()))?;

            for entry in dir {
                let entry = entry?;
                let metadata = entry.metadata()?;
                let entry_path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                let is_dir = metadata.is_dir();

                // Compute path usable by sandbox.resolve() on the next call.
                // Prefer a path relative to the sandbox root; when the entry
                // lives outside the root (absolute path, e.g. after navigating
                // via a CWD outside the sandbox), return the absolute path so
                // resolve() can canonicalize it directly.
                let relative_path = entry_path
                    .strip_prefix(&root)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|_| entry_path.to_string_lossy().to_string());

                // Infer MIME type and binary flag from the entry name.
                let (mime_type, is_binary) = if is_dir {
                    ("inode/directory".to_string(), false)
                } else {
                    let mime = mime_guess::from_path(&entry_path)
                        .first_or_text_plain()
                        .to_string();
                    let binary = is_binary_mime(&mime);
                    (mime, binary)
                };

                result.push(FileEntry {
                    name,
                    path: relative_path,
                    full_path: entry_path.to_string_lossy().to_string(),
                    is_dir,
                    size: metadata.len(),
                    modified: metadata
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                    mime_type,
                    is_binary,
                });
            }

            // Sort: directories first (alphabetical), then files (alphabetical).
            result.sort_by(|a, b| {
                b.is_dir
                    .cmp(&a.is_dir)
                    .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            });

            Ok(result)
        })
        .await??;

        Ok(entries)
    }

    /// Read the contents of a file. Returns base64-encoded content.
    ///
    /// When `offset` and `limit` are both `None`, the entire file is returned
    /// (up to `MAX_READ_SIZE`, 10 MB) — the backward-compatible fast path.
    ///
    /// When either is `Some`, a chunked read is performed: the file may be up
    /// to `MAX_CHUNKED_READ_SIZE` (50 MB), only `limit` bytes starting at
    /// `offset` are returned, and `has_more` reports whether additional bytes
    /// remain past the returned window.
    pub async fn read_file(
        &self,
        path: &str,
        offset: Option<u64>,
        limit: Option<u64>,
    ) -> Result<FileData> {
        let resolved = self.sandbox.resolve(path)?;
        let user_path = path.to_string();
        let path_for_mime = user_path.clone();
        let chunked = offset.is_some() || limit.is_some();

        let result = task::spawn_blocking(
            move || -> Result<(Vec<u8>, String, u64, u64, bool)> {
                let metadata = fs::metadata(&resolved).with_context(|| {
                    format!("failed to read metadata: {}", resolved.display())
                })?;

                if metadata.is_dir() {
                    anyhow::bail!("is_directory: cannot read a directory");
                }

                let size = metadata.len();
                let mime = mime_guess::from_path(&path_for_mime)
                    .first_or_text_plain()
                    .to_string();

                if !chunked {
                    // Backward-compatible path: reject anything over 10 MB.
                    if size > MAX_READ_SIZE {
                        anyhow::bail!(
                            "file_too_large: file is {size} bytes, max allowed is {MAX_READ_SIZE} bytes"
                        );
                    }
                    let data = fs::read(&resolved).with_context(|| {
                        format!("failed to read file: {}", resolved.display())
                    })?;
                    return Ok((data, mime, 0, size, false));
                }

                // Chunked path.
                if size > MAX_CHUNKED_READ_SIZE {
                    anyhow::bail!(
                        "file_too_large: file is {size} bytes, max allowed is {MAX_CHUNKED_READ_SIZE} bytes"
                    );
                }

                let actual_offset = offset.unwrap_or(0);
                let actual_limit = limit.unwrap_or(DEFAULT_CHUNK_SIZE).min(MAX_CHUNKED_READ_SIZE);

                let mut file = fs::File::open(&resolved).with_context(|| {
                    format!("failed to open file: {}", resolved.display())
                })?;

                if actual_offset > 0 {
                    file.seek(SeekFrom::Start(actual_offset)).with_context(|| {
                        format!("failed to seek to offset {actual_offset}")
                    })?;
                }

                let mut buf = vec![0u8; actual_limit as usize];
                let bytes_read = file.read(&mut buf).with_context(|| {
                    format!("failed to read file: {}", resolved.display())
                })?;
                buf.truncate(bytes_read);

                let has_more = actual_offset + (bytes_read as u64) < size;
                Ok((buf, mime, actual_offset, size, has_more))
            },
        )
        .await??;

        let encoded = base64::engine::general_purpose::STANDARD.encode(&result.0);

        Ok(FileData {
            path: user_path,
            content: encoded,
            mime_type: result.1,
            offset: result.2,
            total_size: result.3,
            has_more: result.4,
        })
    }

    /// Write content to a file. Uses atomic write (temp + rename).
    /// `content` is base64-encoded bytes.
    pub async fn write_file(&self, path: &str, content_b64: &str) -> Result<u64> {
        let resolved = self.sandbox.resolve(path)?;

        let data = base64::engine::general_purpose::STANDARD
            .decode(content_b64)
            .context("failed to decode base64 content")?;

        let len = data.len() as u64;

        task::spawn_blocking(move || -> Result<u64> {
            // Ensure parent directory exists.
            if let Some(parent) = resolved.parent() {
                fs::create_dir_all(parent).with_context(|| {
                    format!("failed to create parent dir: {}", parent.display())
                })?;
            }

            // Use a unique temp file name to avoid collisions, even for
            // extensionless files where with_extension("tmp") would give
            // the same name for every concurrent write to the same path.
            let tmp_id = uuid::Uuid::new_v4();
            let tmp_name = format!(".nession-{tmp_id}.tmp");
            let tmp = resolved.with_file_name(&tmp_name);

            fs::write(&tmp, &data)
                .with_context(|| format!("failed to write temp file: {}", tmp.display()))?;

            match fs::rename(&tmp, &resolved) {
                Ok(()) => Ok(len),
                Err(e) => {
                    // Clean up the orphaned temp file on rename failure.
                    let _ = fs::remove_file(&tmp);
                    Err(e).with_context(|| format!("failed to rename temp file: {}", tmp.display()))
                }
            }
        })
        .await??;

        Ok(len)
    }

    /// Delete a file, or a directory.
    ///
    /// `recursive` controls directory handling: with `false` only an empty
    /// directory is removed (`ENOTEMPTY` otherwise), with `true` the whole
    /// subtree is removed. Callers that mean "delete this folder" — the file
    /// browser's delete action — must pass `true`, since a non-empty folder is
    /// the normal case.
    pub async fn delete(&self, path: &str, recursive: bool) -> Result<()> {
        // resolve_no_follow, not resolve: a symlink must be unlinked, never
        // followed — otherwise a recursive delete would wipe its target tree.
        let resolved = self.sandbox.resolve_no_follow(path)?;

        task::spawn_blocking(move || -> Result<()> {
            // symlink_metadata for the same reason: a symlink pointing at a
            // directory must be treated as a link, not as a directory.
            let meta = fs::symlink_metadata(&resolved)
                .with_context(|| format!("failed to stat: {}", resolved.display()))?;

            if meta.is_dir() {
                let result = if recursive {
                    fs::remove_dir_all(&resolved)
                } else {
                    fs::remove_dir(&resolved)
                };
                result.with_context(|| {
                    format!("failed to remove directory: {}", resolved.display())
                })?;
            } else {
                fs::remove_file(&resolved)
                    .with_context(|| format!("failed to remove file: {}", resolved.display()))?;
            }
            Ok(())
        })
        .await??;

        Ok(())
    }

    /// Create a directory (and any missing parents).
    pub async fn create_dir(&self, path: &str) -> Result<()> {
        let resolved = self.sandbox.resolve(path)?;

        task::spawn_blocking(move || -> Result<()> {
            fs::create_dir_all(&resolved)
                .with_context(|| format!("failed to create directory: {}", resolved.display()))?;
            Ok(())
        })
        .await??;

        Ok(())
    }

    /// Rename (move) a file or directory within the sandbox.
    pub async fn rename(&self, from: &str, to: &str) -> Result<()> {
        let from_resolved = self.sandbox.resolve(from)?;
        let to_resolved = self.sandbox.resolve(to)?;

        task::spawn_blocking(move || -> Result<()> {
            // Ensure parent of destination exists.
            if let Some(parent) = to_resolved.parent() {
                fs::create_dir_all(parent).with_context(|| {
                    format!("failed to create parent dir: {}", parent.display())
                })?;
            }
            fs::rename(&from_resolved, &to_resolved).with_context(|| {
                format!(
                    "failed to rename {} to {}",
                    from_resolved.display(),
                    to_resolved.display()
                )
            })?;
            Ok(())
        })
        .await??;

        Ok(())
    }

    /// Return the sandbox root path as a string.
    pub fn root_path(&self) -> String {
        self.sandbox.root().to_string_lossy().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, FileOps) {
        let dir = tempfile::tempdir().unwrap();
        let sandbox = PathSandbox::new(dir.path()).unwrap();
        let ops = FileOps::new(sandbox);
        (dir, ops)
    }

    #[tokio::test]
    async fn test_list_empty_dir() {
        let (_dir, ops) = setup();
        let entries = ops.list_dir("").await.unwrap();
        assert!(entries.is_empty());
    }

    #[tokio::test]
    async fn test_list_dir_with_files() {
        let (dir, ops) = setup();
        fs::write(dir.path().join("a.txt"), b"a").unwrap();
        fs::write(dir.path().join("b.txt"), b"bb").unwrap();
        fs::create_dir(dir.path().join("subdir")).unwrap();

        let entries = ops.list_dir("").await.unwrap();
        assert_eq!(entries.len(), 3);
        // Directories first.
        assert!(entries[0].is_dir);
        assert_eq!(entries[0].name, "subdir");
        assert_eq!(entries[1].name, "a.txt");
        assert_eq!(entries[2].name, "b.txt");
        assert_eq!(entries[2].size, 2);
    }

    #[tokio::test]
    async fn test_list_dir_returns_paths_relative_to_sandbox_root() {
        let (dir, ops) = setup();
        fs::write(dir.path().join("a.txt"), b"a").unwrap();
        fs::create_dir(dir.path().join("subdir")).unwrap();

        let entries = ops.list_dir("").await.unwrap();
        assert_eq!(entries.len(), 2);

        let subdir = entries.iter().find(|e| e.name == "subdir").unwrap();
        let file = entries.iter().find(|e| e.name == "a.txt").unwrap();

        // Paths must be relative to sandbox root, not absolute OS paths.
        assert_eq!(subdir.path, "subdir");
        assert_eq!(file.path, "a.txt");

        // full_path carries the canonical absolute path for "copy full path".
        assert_eq!(
            file.full_path,
            dir.path()
                .join("a.txt")
                .canonicalize()
                .unwrap()
                .to_string_lossy()
        );
        assert_eq!(
            subdir.full_path,
            dir.path()
                .join("subdir")
                .canonicalize()
                .unwrap()
                .to_string_lossy()
        );

        // Verify round-trip: pass a path from list_dir back to read_file.
        let content = ops.read_file(&file.path, None, None).await.unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&content.content)
            .unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), "a");
    }

    #[tokio::test]
    async fn test_list_dir_nested_path_is_relative() {
        let (dir, ops) = setup();
        fs::create_dir_all(dir.path().join("deep/nested")).unwrap();
        fs::write(dir.path().join("deep/nested/file.txt"), b"nested").unwrap();

        let entries = ops.list_dir("deep/nested").await.unwrap();
        assert_eq!(entries.len(), 1);

        let file = &entries[0];
        assert_eq!(file.name, "file.txt");
        // Path must be relative, not absolute.
        assert_eq!(file.path, "deep/nested/file.txt");

        // Round-trip through read_file.
        let data = ops.read_file(&file.path, None, None).await.unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&data.content)
            .unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), "nested");
    }

    #[tokio::test]
    async fn test_read_write_roundtrip() {
        let (_dir, ops) = setup();
        let content = "Hello, Nession! 你好 🚀";
        let b64 = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());

        let written = ops.write_file("test.txt", &b64).await.unwrap();
        assert_eq!(written, content.len() as u64);

        let file_data = ops.read_file("test.txt", None, None).await.unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&file_data.content)
            .unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), content);
        assert_eq!(file_data.mime_type, "text/plain");
    }

    #[tokio::test]
    async fn test_read_nonexistent_file_fails() {
        let (_dir, ops) = setup();
        let result = ops.read_file("nonexistent.txt", None, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_read_directory_fails() {
        let (dir, ops) = setup();
        fs::create_dir(dir.path().join("mydir")).unwrap();
        let result = ops.read_file("mydir", None, None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("is_directory"));
    }

    #[tokio::test]
    async fn test_list_dir_on_file_reports_not_a_directory() {
        let (dir, ops) = setup();
        fs::write(dir.path().join("plain.txt"), b"x").unwrap();

        let err = ops.list_dir("plain.txt").await.unwrap_err();

        assert!(err.to_string().contains("not_a_directory"), "got: {err:#}");
    }

    #[tokio::test]
    async fn test_list_dir_missing_path_reports_not_found() {
        // Regression: a missing path used to report "not_a_directory" because
        // Path::is_dir() swallows the NotFound error.
        let (_dir, ops) = setup();

        let err = ops.list_dir("no/such/dir").await.unwrap_err();
        let msg = format!("{err:#}");

        assert!(msg.contains("not_found"), "got: {msg}");
        assert!(!msg.contains("not_a_directory"), "got: {msg}");
    }

    #[tokio::test]
    async fn test_list_dir_reports_stat_failure_distinctly() {
        // A component that is a file makes stat fail with ENOTDIR rather than
        // NotFound; that must not be reported as a plain "not a directory".
        let (dir, ops) = setup();
        fs::write(dir.path().join("afile"), b"x").unwrap();

        let err = ops.list_dir("afile/below").await.unwrap_err();
        let msg = format!("{err:#}");

        // Either resolution or the stat rejects it, but the path is named and
        // it is never silently mislabelled as an existing non-directory.
        assert!(msg.contains("afile"), "got: {msg}");
    }

    #[tokio::test]
    async fn test_list_dir_enters_subdir_named_like_root() {
        // The sandbox root's basename is the temp dir's name; a subdirectory
        // that happens to share a name with the root must still be listable.
        let dir = tempfile::tempdir().unwrap();
        let root_name = dir
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let nested = dir.path().join(&root_name);
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join("inner.txt"), b"x").unwrap();
        let ops = FileOps::new(PathSandbox::new(dir.path()).unwrap());

        let entries = ops.list_dir(&root_name).await.unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries.first().map(|e| e.name.as_str()),
            Some("inner.txt"),
            "expected to enter the subdir, got {entries:?}"
        );
    }

    #[tokio::test]
    async fn test_list_dir_in_git_submodule() {
        // A submodule is an ordinary directory whose `.git` is a FILE, not a
        // directory. Listing it must work and mark `.git` as a non-directory.
        let (dir, ops) = setup();
        let sub = dir.path().join("mysub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join(".git"), b"gitdir: ../.git/modules/mysub\n").unwrap();
        fs::write(sub.join("file.txt"), b"hello").unwrap();

        let entries = ops.list_dir("mysub").await.unwrap();

        let git = entries
            .iter()
            .find(|e| e.name == ".git")
            .expect(".git listed");
        assert!(!git.is_dir, "submodule .git is a file");
        assert!(entries.iter().any(|e| e.name == "file.txt"));
    }

    #[tokio::test]
    async fn test_delete_file() {
        let (dir, ops) = setup();
        fs::write(dir.path().join("del.txt"), b"delete me").unwrap();
        ops.delete("del.txt", false).await.unwrap();
        assert!(!dir.path().join("del.txt").exists());
    }

    #[tokio::test]
    async fn test_delete_nonexistent_fails() {
        let (_dir, ops) = setup();
        let result = ops.delete("nope.txt", false).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_delete_empty_dir_non_recursive() {
        let (dir, ops) = setup();
        fs::create_dir(dir.path().join("empty")).unwrap();
        ops.delete("empty", false).await.unwrap();
        assert!(!dir.path().join("empty").exists());
    }

    #[tokio::test]
    async fn test_delete_non_empty_dir_non_recursive_fails() {
        let (dir, ops) = setup();
        fs::create_dir(dir.path().join("full")).unwrap();
        fs::write(dir.path().join("full/a.txt"), b"a").unwrap();

        let result = ops.delete("full", false).await;

        assert!(result.is_err());
        assert!(dir.path().join("full").exists());
    }

    #[tokio::test]
    async fn test_delete_non_empty_dir_recursive() {
        let (dir, ops) = setup();
        fs::create_dir_all(dir.path().join("full/nested")).unwrap();
        fs::write(dir.path().join("full/a.txt"), b"a").unwrap();
        fs::write(dir.path().join("full/nested/b.txt"), b"b").unwrap();

        ops.delete("full", true).await.unwrap();

        assert!(!dir.path().join("full").exists());
    }

    #[tokio::test]
    async fn test_delete_recursive_on_plain_file() {
        // The flag is about directories; a file must still just be unlinked.
        let (dir, ops) = setup();
        fs::write(dir.path().join("solo.txt"), b"x").unwrap();
        ops.delete("solo.txt", true).await.unwrap();
        assert!(!dir.path().join("solo.txt").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_delete_symlink_to_dir_does_not_touch_target() {
        // symlink_metadata keeps a recursive delete from walking through a
        // symlink and wiping the directory it points at.
        let (dir, ops) = setup();
        fs::create_dir(dir.path().join("target")).unwrap();
        fs::write(dir.path().join("target/keep.txt"), b"keep").unwrap();
        std::os::unix::fs::symlink(dir.path().join("target"), dir.path().join("link")).unwrap();

        ops.delete("link", true).await.unwrap();

        assert!(!dir.path().join("link").exists());
        assert!(dir.path().join("target/keep.txt").exists());
    }

    #[tokio::test]
    async fn test_delete_error_reports_os_reason() {
        let (dir, ops) = setup();
        fs::create_dir(dir.path().join("full")).unwrap();
        fs::write(dir.path().join("full/a.txt"), b"a").unwrap();

        let err = ops.delete("full", false).await.unwrap_err();
        let chain: Vec<String> = std::iter::once(err.to_string())
            .chain(err.chain().skip(1).map(ToString::to_string))
            .collect();

        // The path context is kept and the OS cause is reachable in the chain.
        let top = chain.first().expect("error chain is never empty");
        assert!(top.contains("failed to remove directory"));
        assert!(chain.len() > 1, "expected an OS cause, got {chain:?}");
    }

    #[tokio::test]
    async fn test_create_dir() {
        let (dir, ops) = setup();
        ops.create_dir("a/b/c").await.unwrap();
        assert!(dir.path().join("a/b/c").is_dir());
    }

    #[tokio::test]
    async fn test_rename_file() {
        let (dir, ops) = setup();
        fs::write(dir.path().join("old.txt"), b"old").unwrap();
        ops.rename("old.txt", "new.txt").await.unwrap();
        assert!(!dir.path().join("old.txt").exists());
        assert_eq!(
            fs::read_to_string(dir.path().join("new.txt")).unwrap(),
            "old"
        );
    }

    #[tokio::test]
    async fn test_write_creates_parent_dirs() {
        let (dir, ops) = setup();
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"deep");
        ops.write_file("deep/nested/file.txt", &b64).await.unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("deep/nested/file.txt")).unwrap(),
            "deep"
        );
    }

    fn decode_b64(b64: &str) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap()
    }

    #[tokio::test]
    async fn test_chunked_read_first_chunk() {
        let (dir, ops) = setup();
        // 30-byte file: "0123456789" repeated 3 times.
        let content: Vec<u8> = (0..30).map(|i| b'0' + (i % 10) as u8).collect();
        fs::write(dir.path().join("data.bin"), &content).unwrap();

        let file_data = ops.read_file("data.bin", Some(0), Some(10)).await.unwrap();
        let decoded = decode_b64(&file_data.content);
        assert_eq!(decoded, &content[..10]);
        assert_eq!(file_data.offset, 0);
        assert_eq!(file_data.total_size, 30);
        assert!(file_data.has_more);
    }

    #[tokio::test]
    async fn test_chunked_read_middle_chunk() {
        let (dir, ops) = setup();
        let content: Vec<u8> = (0..30).map(|i| b'0' + (i % 10) as u8).collect();
        fs::write(dir.path().join("data.bin"), &content).unwrap();

        let file_data = ops.read_file("data.bin", Some(10), Some(10)).await.unwrap();
        let decoded = decode_b64(&file_data.content);
        assert_eq!(decoded, &content[10..20]);
        assert_eq!(file_data.offset, 10);
        assert_eq!(file_data.total_size, 30);
        assert!(file_data.has_more);
    }

    #[tokio::test]
    async fn test_chunked_read_last_chunk() {
        let (dir, ops) = setup();
        let content: Vec<u8> = (0..30).map(|i| b'0' + (i % 10) as u8).collect();
        fs::write(dir.path().join("data.bin"), &content).unwrap();

        let file_data = ops.read_file("data.bin", Some(20), Some(10)).await.unwrap();
        let decoded = decode_b64(&file_data.content);
        assert_eq!(decoded, &content[20..30]);
        assert_eq!(file_data.offset, 20);
        assert_eq!(file_data.total_size, 30);
        assert!(!file_data.has_more);
    }

    #[tokio::test]
    async fn test_chunked_read_beyond_eof() {
        let (dir, ops) = setup();
        let content: Vec<u8> = (0..30).map(|i| b'0' + (i % 10) as u8).collect();
        fs::write(dir.path().join("data.bin"), &content).unwrap();

        // offset=25, limit=10, but only 5 bytes remain.
        let file_data = ops.read_file("data.bin", Some(25), Some(10)).await.unwrap();
        let decoded = decode_b64(&file_data.content);
        assert_eq!(decoded.len(), 5);
        assert_eq!(decoded, &content[25..30]);
        assert_eq!(file_data.offset, 25);
        assert_eq!(file_data.total_size, 30);
        assert!(!file_data.has_more);
    }

    #[tokio::test]
    async fn test_chunked_read_offset_at_eof() {
        let (dir, ops) = setup();
        let content: Vec<u8> = (0..30).map(|i| b'0' + (i % 10) as u8).collect();
        fs::write(dir.path().join("data.bin"), &content).unwrap();

        // offset == file size → empty result.
        let file_data = ops.read_file("data.bin", Some(30), Some(10)).await.unwrap();
        let decoded = decode_b64(&file_data.content);
        assert!(decoded.is_empty());
        assert_eq!(file_data.offset, 30);
        assert_eq!(file_data.total_size, 30);
        assert!(!file_data.has_more);
    }

    #[tokio::test]
    async fn test_file_entry_mime_and_binary() {
        let (dir, ops) = setup();
        fs::write(dir.path().join("a.txt"), b"text").unwrap();
        fs::write(dir.path().join("b.json"), b"{}").unwrap();
        // Minimal valid PNG header (just the 8-byte signature) to make it a
        // real binary file; the extension alone drives MIME detection.
        fs::write(dir.path().join("c.png"), b"\x89PNG\r\n\x1a\n").unwrap();

        let entries = ops.list_dir("").await.unwrap();
        let find = |name: &str| entries.iter().find(|e| e.name == name).unwrap();

        let txt = find("a.txt");
        assert_eq!(txt.mime_type, "text/plain");
        assert!(!txt.is_binary);

        let json = find("b.json");
        assert_eq!(json.mime_type, "application/json");
        assert!(!json.is_binary);

        let png = find("c.png");
        assert_eq!(png.mime_type, "image/png");
        assert!(png.is_binary);
    }

    #[tokio::test]
    async fn test_backward_compat_read_file_no_offset() {
        let (dir, ops) = setup();
        let content = b"hello world, this is a test file";
        fs::write(dir.path().join("file.txt"), content).unwrap();

        let file_data = ops.read_file("file.txt", None, None).await.unwrap();
        assert_eq!(file_data.offset, 0);
        assert_eq!(file_data.total_size, content.len() as u64);
        assert!(!file_data.has_more);

        let decoded = decode_b64(&file_data.content);
        assert_eq!(decoded, content);
    }
}
