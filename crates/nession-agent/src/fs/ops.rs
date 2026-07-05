use anyhow::{Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use tokio::task;

use super::sandbox::PathSandbox;

/// Maximum file size for read operations (10 MB).
const MAX_READ_SIZE: u64 = 10 * 1024 * 1024;

/// A filesystem entry returned by directory listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
}

/// Data returned by a file read operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileData {
    pub path: String,
    /// Base64-encoded file content.
    pub content: String,
    /// MIME type (e.g. "text/plain", "application/json").
    pub mime_type: String,
}

/// High-level file operations scoped to a sandbox root.
pub struct FileOps {
    sandbox: PathSandbox,
}

impl FileOps {
    pub fn new(sandbox: PathSandbox) -> Self {
        Self { sandbox }
    }

    /// List entries in a directory. Sorted: directories first, then files,
    /// both alphabetically by name.
    pub async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>> {
        let resolved = self.sandbox.resolve(path)?;

        if !resolved.is_dir() {
            anyhow::bail!("not_a_directory: {path}");
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

                // Strip sandbox root so paths are relative — downstream
                // operations resolve against the same root via the sandbox.
                let relative_path = entry_path
                    .strip_prefix(&root)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|_| name.clone());

                result.push(FileEntry {
                    name,
                    path: relative_path,
                    is_dir: metadata.is_dir(),
                    size: metadata.len(),
                    modified: metadata
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
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
    /// Rejects files larger than `MAX_READ_SIZE`.
    pub async fn read_file(&self, path: &str) -> Result<FileData> {
        let resolved = self.sandbox.resolve(path)?;
        let user_path = path.to_string();
        let path_for_mime = user_path.clone();

        let content = task::spawn_blocking(move || -> Result<(Vec<u8>, String)> {
            let metadata = fs::metadata(&resolved)
                .with_context(|| format!("failed to read metadata: {}", resolved.display()))?;

            if metadata.is_dir() {
                anyhow::bail!("is_directory: cannot read a directory");
            }

            let size = metadata.len();
            if size > MAX_READ_SIZE {
                anyhow::bail!(
                    "file_too_large: file is {size} bytes, max allowed is {MAX_READ_SIZE} bytes"
                );
            }

            let data = fs::read(&resolved)
                .with_context(|| format!("failed to read file: {}", resolved.display()))?;

            // Detect MIME type from the user-supplied path extension
            // (avoids leaking the on-disk path to the caller via MIME
            // detection resolution).
            let mime = mime_guess::from_path(&path_for_mime)
                .first_or_text_plain()
                .to_string();

            Ok((data, mime))
        })
        .await??;

        let encoded = base64::engine::general_purpose::STANDARD.encode(&content.0);

        Ok(FileData {
            path: user_path,
            content: encoded,
            mime_type: content.1,
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

    /// Delete a file or an empty directory.
    pub async fn delete(&self, path: &str) -> Result<()> {
        let resolved = self.sandbox.resolve(path)?;

        task::spawn_blocking(move || -> Result<()> {
            if resolved.is_dir() {
                fs::remove_dir(&resolved).with_context(|| {
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

        // Verify round-trip: pass a path from list_dir back to read_file.
        let content = ops.read_file(&file.path).await.unwrap();
        let decoded =
            base64::engine::general_purpose::STANDARD.decode(&content.content).unwrap();
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
        let data = ops.read_file(&file.path).await.unwrap();
        let decoded =
            base64::engine::general_purpose::STANDARD.decode(&data.content).unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), "nested");
    }

    #[tokio::test]
    async fn test_read_write_roundtrip() {
        let (_dir, ops) = setup();
        let content = "Hello, Nession! 你好 🚀";
        let b64 = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());

        let written = ops.write_file("test.txt", &b64).await.unwrap();
        assert_eq!(written, content.len() as u64);

        let file_data = ops.read_file("test.txt").await.unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&file_data.content)
            .unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), content);
        assert_eq!(file_data.mime_type, "text/plain");
    }

    #[tokio::test]
    async fn test_read_nonexistent_file_fails() {
        let (_dir, ops) = setup();
        let result = ops.read_file("nonexistent.txt").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_read_directory_fails() {
        let (dir, ops) = setup();
        fs::create_dir(dir.path().join("mydir")).unwrap();
        let result = ops.read_file("mydir").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("is_directory"));
    }

    #[tokio::test]
    async fn test_delete_file() {
        let (dir, ops) = setup();
        fs::write(dir.path().join("del.txt"), b"delete me").unwrap();
        ops.delete("del.txt").await.unwrap();
        assert!(!dir.path().join("del.txt").exists());
    }

    #[tokio::test]
    async fn test_delete_nonexistent_fails() {
        let (_dir, ops) = setup();
        let result = ops.delete("nope.txt").await;
        assert!(result.is_err());
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
}
