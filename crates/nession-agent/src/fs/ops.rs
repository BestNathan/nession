use anyhow::{Context, Result};
use base64::Engine;

use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::UNIX_EPOCH;
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

/// Re-exported, not redefined (`#678`).
///
/// `FileEntry` and `FileData` serialise straight onto the wire — `file.list`
/// answers with a `Vec<FileEntry>` and `file.read` with a `FileData` — so the
/// agent's filesystem model *was* the contract, and nothing outside this crate
/// could name what a listing is. They live in `contracts/file/v1.rs` now and
/// every path naming `fs::ops::FileEntry` keeps resolving. What stays here is
/// the filesystem knowledge: MIME inference, the sandbox, the chunking.
pub use nession_protocol::contracts::file::v1::{FileData, FileEntry};

/// High-level file operations scoped to a sandbox root.
pub struct FileOps {
    sandbox: PathSandbox,
    /// Serialises the metadata check and the atomic replace of a mutation.
    ///
    /// The agent is the writer for its host view, so an intra-process lock is
    /// what makes "check the revision, then replace" a single decision instead
    /// of two that a concurrent request can interleave. Reads and listings do
    /// not take it.
    mutation_lock: tokio::sync::Mutex<()>,
}

/// An opaque revision derived from the file's metadata.
///
/// Deliberately not a content hash: a chunked read must not rehash the whole
/// file for every chunk. `mtime_nanos + size` is enough to notice a competing
/// write, which is what `expected_revision` is for.
fn revision_of(metadata: &fs::Metadata) -> String {
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{mtime}-{}", metadata.len())
}

fn revision_of_path(path: &Path) -> Result<String> {
    let metadata =
        fs::metadata(path).with_context(|| format!("failed to stat: {}", path.display()))?;
    Ok(revision_of(&metadata))
}

impl FileOps {
    pub fn new(sandbox: PathSandbox) -> Self {
        Self {
            sandbox,
            mutation_lock: tokio::sync::Mutex::new(()),
        }
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
            move || -> Result<(Vec<u8>, String, u64, u64, bool, String)> {
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
                    return Ok((data, mime, 0, size, false, revision_of(&metadata)));
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
                Ok((
                    buf,
                    mime,
                    actual_offset,
                    size,
                    has_more,
                    revision_of(&metadata),
                ))
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
            revision: result.5,
        })
    }

    /// Write content to a file. Uses atomic write (temp + rename).
    /// `content` is base64-encoded bytes.
    pub async fn write_file(&self, path: &str, content_b64: &str) -> Result<u64> {
        Ok(self
            .write_file_with_options(path, content_b64, None, false)
            .await?
            .0)
    }

    /// Write content with create-only and stale-revision protection.
    ///
    /// `create_only` refuses an existing target atomically (`hard_link` is the
    /// no-overwrite primitive; the temp file lives in the same directory). A
    /// regular write may pass `expected_revision`, the revision returned by
    /// {@link FileOps::read_file}; if the file changed since that read the
    /// write is refused as a `conflict` instead of overwriting the newer
    /// content.
    ///
    /// The metadata check and the replace happen under one process-wide
    /// mutation lock, so two agent requests cannot interleave the check with
    /// the other's replace.
    pub async fn write_file_with_options(
        &self,
        path: &str,
        content_b64: &str,
        expected_revision: Option<&str>,
        create_only: bool,
    ) -> Result<(u64, String)> {
        let resolved = self.sandbox.resolve(path)?;
        let expected_revision = expected_revision.map(str::to_owned);

        let data = base64::engine::general_purpose::STANDARD
            .decode(content_b64)
            .context("failed to decode base64 content")?;

        let len = data.len() as u64;
        let user_path = path.to_string();

        let _guard = self.mutation_lock.lock().await;
        let (_, revision) = task::spawn_blocking(move || -> Result<(u64, String)> {
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

            let revision = revision_of_path(&tmp)?;

            if create_only {
                match fs::hard_link(&tmp, &resolved) {
                    Ok(()) => {
                        let _ = fs::remove_file(&tmp);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                        let _ = fs::remove_file(&tmp);
                        anyhow::bail!("already_exists: {user_path}");
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Unsupported => {
                        // Filesystems without hard links: reserve the name
                        // atomically with `create_new`, then fill it.
                        let mut file = match fs::OpenOptions::new()
                            .write(true)
                            .create_new(true)
                            .open(&resolved)
                        {
                            Ok(file) => file,
                            Err(open_err)
                                if open_err.kind() == std::io::ErrorKind::AlreadyExists =>
                            {
                                let _ = fs::remove_file(&tmp);
                                anyhow::bail!("already_exists: {user_path}");
                            }
                            Err(open_err) => {
                                let _ = fs::remove_file(&tmp);
                                return Err(open_err).with_context(|| {
                                    format!(
                                        "failed to create file without replacing: {}",
                                        resolved.display()
                                    )
                                });
                            }
                        };
                        file.write_all(&data).with_context(|| {
                            format!("failed to write file: {}", resolved.display())
                        })?;
                        let _ = fs::remove_file(&tmp);
                    }
                    Err(e) => {
                        let _ = fs::remove_file(&tmp);
                        return Err(e).with_context(|| {
                            format!(
                                "failed to create file without replacing: {}",
                                resolved.display()
                            )
                        });
                    }
                }
            } else {
                if let Some(expected) = expected_revision {
                    let current = match fs::metadata(&resolved) {
                        Ok(metadata) => revision_of(&metadata),
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                            let _ = fs::remove_file(&tmp);
                            anyhow::bail!("conflict: {user_path} was removed");
                        }
                        Err(e) => {
                            let _ = fs::remove_file(&tmp);
                            return Err(e).with_context(|| {
                                format!("failed to stat: {}", resolved.display())
                            });
                        }
                    };
                    if current != expected {
                        let _ = fs::remove_file(&tmp);
                        anyhow::bail!(
                            "conflict: {user_path} changed (expected revision {expected}, current {current})"
                        );
                    }
                }

                match fs::rename(&tmp, &resolved) {
                    Ok(()) => {}
                    Err(e) => {
                        // Clean up the orphaned temp file on rename failure.
                        let _ = fs::remove_file(&tmp);
                        return Err(e)
                            .with_context(|| format!("failed to rename temp file: {}", tmp.display()));
                    }
                }
            }

            Ok((len, revision))
        })
        .await??;

        Ok((len, revision))
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
        self.create_dir_with_options(path, false).await
    }

    /// Create a directory. `create_only` refuses an existing directory (and
    /// any missing parent, because the UI target's parent always exists);
    /// the default keeps the historical "create parents, accept existing"
    /// behaviour for older clients.
    pub async fn create_dir_with_options(&self, path: &str, create_only: bool) -> Result<()> {
        let resolved = self.sandbox.resolve(path)?;
        let user_path = path.to_string();

        let _guard = self.mutation_lock.lock().await;
        task::spawn_blocking(move || -> Result<()> {
            if create_only {
                match fs::create_dir(&resolved) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                        anyhow::bail!("already_exists: {user_path}");
                    }
                    Err(e) => {
                        return Err(e).with_context(|| {
                            format!("failed to create directory: {}", resolved.display())
                        })
                    }
                }
            } else {
                fs::create_dir_all(&resolved).with_context(|| {
                    format!("failed to create directory: {}", resolved.display())
                })?;
            }
            Ok(())
        })
        .await??;

        Ok(())
    }

    /// Rename (move) a file or directory within the sandbox.
    pub async fn rename(&self, from: &str, to: &str) -> Result<()> {
        self.rename_with_options(from, to, false).await
    }

    /// Rename (move) with an optional no-replace guard.
    ///
    /// `no_replace` checks the destination under the mutation lock and refuses
    /// with `already_exists` instead of letting `rename(2)` silently replace
    /// it. The agent is the writer for its host view; a writer outside the
    /// agent is outside this contract.
    pub async fn rename_with_options(&self, from: &str, to: &str, no_replace: bool) -> Result<()> {
        let from_resolved = self.sandbox.resolve(from)?;
        let to_resolved = self.sandbox.resolve(to)?;
        let user_to = to.to_string();

        let _guard = self.mutation_lock.lock().await;
        task::spawn_blocking(move || -> Result<()> {
            // Ensure parent of destination exists.
            if let Some(parent) = to_resolved.parent() {
                fs::create_dir_all(parent).with_context(|| {
                    format!("failed to create parent dir: {}", parent.display())
                })?;
            }

            if no_replace {
                match fs::symlink_metadata(&to_resolved) {
                    Ok(_) => anyhow::bail!("already_exists: {user_to}"),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => {
                        return Err(e)
                            .with_context(|| format!("failed to stat: {}", to_resolved.display()))
                    }
                }
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

    fn encode_b64(text: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(text.as_bytes())
    }

    #[tokio::test]
    async fn test_chunked_read_first_chunk() {
        let (dir, ops) = setup();
        // 30-byte file: "0123456789" repeated 3 times.
        let content: Vec<u8> = (0..30u8).map(|i| b'0' + (i % 10)).collect();
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
        let content: Vec<u8> = (0..30u8).map(|i| b'0' + (i % 10)).collect();
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
        let content: Vec<u8> = (0..30u8).map(|i| b'0' + (i % 10)).collect();
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
        let content: Vec<u8> = (0..30u8).map(|i| b'0' + (i % 10)).collect();
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
        let content: Vec<u8> = (0..30u8).map(|i| b'0' + (i % 10)).collect();
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

    #[tokio::test]
    async fn test_read_reports_a_revision_that_changes_after_write() {
        let (_dir, ops) = setup();
        let before = ops.read_file("missing", None, None).await;
        assert!(before.is_err());

        ops.write_file("file.txt", &encode_b64("one"))
            .await
            .unwrap();
        let first = ops.read_file("file.txt", None, None).await.unwrap();
        assert!(!first.revision.is_empty());

        ops.write_file("file.txt", &encode_b64("two"))
            .await
            .unwrap();
        let second = ops.read_file("file.txt", None, None).await.unwrap();
        assert_ne!(first.revision, second.revision);
    }

    #[tokio::test]
    async fn test_create_only_refuses_an_existing_file_and_keeps_its_content() {
        let (dir, ops) = setup();
        fs::write(dir.path().join("existing.txt"), b"keep me").unwrap();

        let err = ops
            .write_file_with_options("existing.txt", &encode_b64("replace"), None, true)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("already_exists"), "got: {err:#}");
        assert_eq!(
            fs::read(dir.path().join("existing.txt")).unwrap(),
            b"keep me"
        );

        ops.write_file_with_options("new.txt", &encode_b64("created"), None, true)
            .await
            .unwrap();
        assert_eq!(fs::read(dir.path().join("new.txt")).unwrap(), b"created");
    }

    #[tokio::test]
    async fn test_expected_revision_refuses_a_stale_write_and_accepts_the_current_one() {
        let (dir, ops) = setup();
        ops.write_file("file.txt", &encode_b64("first"))
            .await
            .unwrap();
        let loaded = ops.read_file("file.txt", None, None).await.unwrap();

        // Another writer changes the file after the read.
        fs::write(dir.path().join("file.txt"), b"from another writer").unwrap();

        let err = ops
            .write_file_with_options(
                "file.txt",
                &encode_b64("stale"),
                Some(&loaded.revision),
                false,
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("conflict"), "got: {err:#}");
        assert_eq!(
            fs::read(dir.path().join("file.txt")).unwrap(),
            b"from another writer"
        );

        let current = ops.read_file("file.txt", None, None).await.unwrap();
        let (written, revision) = ops
            .write_file_with_options(
                "file.txt",
                &encode_b64("updated"),
                Some(&current.revision),
                false,
            )
            .await
            .unwrap();
        assert_eq!(written, 7);
        assert!(!revision.is_empty());
        assert_eq!(fs::read(dir.path().join("file.txt")).unwrap(), b"updated");
    }

    #[tokio::test]
    async fn test_expected_revision_on_a_deleted_file_is_a_conflict() {
        let (dir, ops) = setup();
        ops.write_file("file.txt", &encode_b64("first"))
            .await
            .unwrap();
        let loaded = ops.read_file("file.txt", None, None).await.unwrap();
        fs::remove_file(dir.path().join("file.txt")).unwrap();

        let err = ops
            .write_file_with_options(
                "file.txt",
                &encode_b64("stale"),
                Some(&loaded.revision),
                false,
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("conflict"), "got: {err:#}");
    }

    #[tokio::test]
    async fn test_rename_no_replace_refuses_an_existing_destination() {
        let (dir, ops) = setup();
        fs::write(dir.path().join("a.txt"), b"a").unwrap();
        fs::write(dir.path().join("b.txt"), b"b").unwrap();

        let err = ops
            .rename_with_options("a.txt", "b.txt", true)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("already_exists"), "got: {err:#}");
        assert_eq!(fs::read(dir.path().join("a.txt")).unwrap(), b"a");
        assert_eq!(fs::read(dir.path().join("b.txt")).unwrap(), b"b");

        ops.rename_with_options("a.txt", "c.txt", true)
            .await
            .unwrap();
        assert!(!dir.path().join("a.txt").exists());
        assert_eq!(fs::read(dir.path().join("c.txt")).unwrap(), b"a");
    }

    #[tokio::test]
    async fn test_create_dir_create_only_refuses_an_existing_directory() {
        let (dir, ops) = setup();
        fs::create_dir(dir.path().join("subdir")).unwrap();

        let err = ops
            .create_dir_with_options("subdir", true)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("already_exists"), "got: {err:#}");

        ops.create_dir_with_options("newdir", true).await.unwrap();
        assert!(dir.path().join("newdir").is_dir());
    }
}
