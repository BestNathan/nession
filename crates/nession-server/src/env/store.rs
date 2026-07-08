//! Server-side env-file storage under `~/.nession/server/envs`.
//!
//! Mirrors the agent-local store but tags files with `EnvSource::Server`.
//! Filenames are validated to reject path traversal.

use anyhow::{Context, Result};
use nession_common::env_file::parse_env;
use nession_common::protocol::{EnvFileInfo, EnvSource};
use std::path::{Path, PathBuf};
use tokio::fs;

/// Store for server-managed env files.
#[derive(Clone)]
pub struct EnvStore {
    root: PathBuf,
}

/// Validate that `name` is a safe `.env` filename.
fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() {
        anyhow::bail!("env file name is empty");
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        anyhow::bail!("invalid env file name: {name}");
    }
    if Path::new(name).file_name().map(|f| f.to_string_lossy()) != Some(name.into()) {
        anyhow::bail!("invalid env file name: {name}");
    }
    if !name.ends_with(".env") || name.len() <= 4 {
        anyhow::bail!("env file name must end with .env: {name}");
    }
    Ok(())
}

impl EnvStore {
    /// Create a store rooted at `root`. The directory is created lazily on the
    /// first write, so construction is infallible.
    #[must_use]
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn path_for(&self, name: &str) -> Result<PathBuf> {
        validate_name(name)?;
        Ok(self.root.join(name))
    }

    /// List all `.env` files with metadata. Missing/unreadable dir → empty.
    pub async fn list(&self) -> Result<Vec<EnvFileInfo>> {
        let mut out = Vec::new();
        let mut dir = match fs::read_dir(&self.root).await {
            Ok(d) => d,
            Err(_) => return Ok(out),
        };
        while let Some(entry) = dir.next_entry().await? {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if !file_name.ends_with(".env") {
                continue;
            }
            let meta = match entry.metadata().await {
                Ok(m) if m.is_file() => m,
                _ => continue,
            };
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let var_count = fs::read_to_string(entry.path())
                .await
                .map(|c| parse_env(&c).len())
                .unwrap_or(0);
            out.push(EnvFileInfo {
                name: file_name,
                source: EnvSource::Server,
                agent_id: None,
                size: meta.len(),
                modified,
                var_count,
            });
        }
        out.sort_by_key(|f| f.name.to_lowercase());
        Ok(out)
    }

    /// Read a file's raw content.
    pub async fn read(&self, name: &str) -> Result<String> {
        let path = self.path_for(name)?;
        fs::read_to_string(&path)
            .await
            .with_context(|| format!("failed to read env file: {name}"))
    }

    /// True if the named file exists.
    pub async fn exists(&self, name: &str) -> Result<bool> {
        let path = self.path_for(name)?;
        Ok(fs::try_exists(&path).await.unwrap_or(false))
    }

    /// Write (create/overwrite) a file atomically. When `overwrite` is false
    /// and the file exists, returns `Ok(false)` without writing.
    pub async fn write(&self, name: &str, content: &str, overwrite: bool) -> Result<bool> {
        let path = self.path_for(name)?;
        fs::create_dir_all(&self.root)
            .await
            .with_context(|| format!("failed to create env dir: {}", self.root.display()))?;
        if !overwrite && fs::try_exists(&path).await.unwrap_or(false) {
            return Ok(false);
        }
        let tmp = self
            .root
            .join(format!(".nession-{}.tmp", uuid::Uuid::new_v4()));
        fs::write(&tmp, content.as_bytes())
            .await
            .with_context(|| format!("failed to write temp env file for {name}"))?;
        if let Err(e) = fs::rename(&tmp, &path).await {
            let _ = fs::remove_file(&tmp).await;
            return Err(e).with_context(|| format!("failed to persist env file: {name}"));
        }
        Ok(true)
    }

    /// Delete a file. Missing file is treated as success (idempotent).
    pub async fn delete(&self, name: &str) -> Result<()> {
        let path = self.path_for(name)?;
        match fs::remove_file(&path).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e).with_context(|| format!("failed to delete env file: {name}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_in(dir: &tempfile::TempDir) -> EnvStore {
        EnvStore::new(dir.path().to_path_buf())
    }

    #[test]
    fn rejects_traversal() {
        assert!(validate_name("../evil.env").is_err());
        assert!(validate_name("a/b.env").is_err());
        assert!(validate_name("noext").is_err());
        assert!(validate_name("good.env").is_ok());
    }

    #[tokio::test]
    async fn roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let s = store_in(&dir);
        assert!(s.write("a.env", "FOO=bar\n", false).await.unwrap());
        assert_eq!(s.read("a.env").await.unwrap(), "FOO=bar\n");
        let list = s.list().await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list.first().unwrap().source, EnvSource::Server);
        assert!(list.first().unwrap().agent_id.is_none());
        s.delete("a.env").await.unwrap();
        assert!(s.list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn no_overwrite_refuses() {
        let dir = tempfile::tempdir().unwrap();
        let s = store_in(&dir);
        assert!(s.write("a.env", "X=1", false).await.unwrap());
        assert!(!s.write("a.env", "X=2", false).await.unwrap());
        assert_eq!(s.read("a.env").await.unwrap(), "X=1");
    }
}
