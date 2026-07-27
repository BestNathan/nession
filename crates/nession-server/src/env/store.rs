//! Server-side env-file storage, backed by the SQLite `env_files` table
//! (issue #95, part 2).
//!
//! Previously these files lived only on the filesystem under
//! `~/.nession/server/envs`.  They are now persisted in the database so they
//! survive pod restarts.  On startup, [`EnvStore::import_from_dir`] migrates
//! any pre-existing filesystem files into the DB (without deleting them, for
//! zero-downtime rollback safety).
//!
//! Filenames are validated to reject path traversal, preserving the same
//! `.env`-suffix rules as the filesystem implementation.

use crate::db::Database;
use anyhow::{Context, Result};
use nession_common::env_file::parse_env;
use nession_common::protocol::{EnvFileInfo, EnvSource};
use std::path::Path;
use std::sync::Arc;
use tokio::fs;

/// Store for server-managed env files, backed by the database.
#[derive(Clone)]
pub struct EnvStore {
    db: Arc<Database>,
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
    /// Create a store backed by the given database.
    #[must_use]
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    /// List all env files with metadata, sorted by name (case-insensitive).
    pub async fn list(&self) -> Result<Vec<EnvFileInfo>> {
        let rows = self.db.list_env_files().await?;
        let out = rows
            .into_iter()
            .map(|row| EnvFileInfo {
                size: row.content.len() as u64,
                var_count: parse_env(&row.content).len(),
                modified: u64::try_from(row.updated_at).unwrap_or(0),
                name: row.name,
                source: EnvSource::Server,
                agent_id: None,
            })
            .collect();
        Ok(out)
    }

    /// Read a file's raw content.
    pub async fn read(&self, name: &str) -> Result<String> {
        validate_name(name)?;
        self.db
            .get_env_file(name)
            .await?
            .map(|row| row.content)
            .with_context(|| format!("env file not found: {name}"))
    }

    /// True if the named file exists.
    pub async fn exists(&self, name: &str) -> Result<bool> {
        validate_name(name)?;
        Ok(self.db.get_env_file(name).await?.is_some())
    }

    /// Write (create/overwrite) a file. When `overwrite` is false and the file
    /// exists, returns `Ok(false)` without writing.
    pub async fn write(&self, name: &str, content: &str, overwrite: bool) -> Result<bool> {
        validate_name(name)?;
        if !overwrite && self.db.get_env_file(name).await?.is_some() {
            return Ok(false);
        }
        self.db.upsert_env_file(name, content).await?;
        Ok(true)
    }

    /// Delete a file. Missing file is treated as success (idempotent).
    pub async fn delete(&self, name: &str) -> Result<()> {
        validate_name(name)?;
        self.db.delete_env_file(name).await
    }

    /// Import any `.env` files from a legacy filesystem directory into the DB.
    ///
    /// Only files not already present in the DB are imported (the DB is the
    /// authoritative source, so existing DB entries are never clobbered). The
    /// filesystem copies are left in place for rollback safety. A missing or
    /// unreadable directory is a no-op. Returns the number of files imported.
    pub async fn import_from_dir(&self, dir: &Path) -> Result<usize> {
        let mut imported = 0usize;
        let mut rd = match fs::read_dir(dir).await {
            Ok(d) => d,
            Err(_) => return Ok(0),
        };
        while let Some(entry) = rd.next_entry().await? {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if !file_name.ends_with(".env") || validate_name(&file_name).is_err() {
                continue;
            }
            match entry.metadata().await {
                Ok(m) if m.is_file() => {}
                _ => continue,
            }
            // Skip files already in the DB.
            if self.db.get_env_file(&file_name).await?.is_some() {
                continue;
            }
            if let Ok(content) = fs::read_to_string(entry.path()).await {
                self.db.upsert_env_file(&file_name, &content).await?;
                imported += 1;
                tracing::info!("Imported env file into DB: {file_name}");
            }
        }
        Ok(imported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn store() -> EnvStore {
        let db = Arc::new(Database::new(":memory:").await.unwrap());
        EnvStore::new(db)
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
        let s = store().await;
        assert!(s.write("a.env", "FOO=bar\n", false).await.unwrap());
        assert_eq!(s.read("a.env").await.unwrap(), "FOO=bar\n");
        assert!(s.exists("a.env").await.unwrap());
        let list = s.list().await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list.first().unwrap().source, EnvSource::Server);
        assert!(list.first().unwrap().agent_id.is_none());
        assert_eq!(list.first().unwrap().var_count, 1);
        s.delete("a.env").await.unwrap();
        assert!(s.list().await.unwrap().is_empty());
        assert!(!s.exists("a.env").await.unwrap());
    }

    #[tokio::test]
    async fn no_overwrite_refuses() {
        let s = store().await;
        assert!(s.write("a.env", "X=1", false).await.unwrap());
        assert!(!s.write("a.env", "X=2", false).await.unwrap());
        assert_eq!(s.read("a.env").await.unwrap(), "X=1");
        // overwrite=true replaces.
        assert!(s.write("a.env", "X=3", true).await.unwrap());
        assert_eq!(s.read("a.env").await.unwrap(), "X=3");
    }

    #[tokio::test]
    async fn read_missing_errors() {
        let s = store().await;
        assert!(s.read("missing.env").await.is_err());
        assert!(s.read("bad name").await.is_err());
    }

    #[tokio::test]
    async fn import_from_dir_migrates_files() {
        let s = store().await;
        let dir = tempfile::tempdir().unwrap();
        // Two valid env files + one non-env file (ignored).
        fs::write(dir.path().join("a.env"), "A=1").await.unwrap();
        fs::write(dir.path().join("b.env"), "B=2").await.unwrap();
        fs::write(dir.path().join("notes.txt"), "ignore me")
            .await
            .unwrap();

        let n = s.import_from_dir(dir.path()).await.unwrap();
        assert_eq!(n, 2);
        assert_eq!(s.read("a.env").await.unwrap(), "A=1");
        assert_eq!(s.read("b.env").await.unwrap(), "B=2");

        // Second import is a no-op (already in DB); doesn't clobber DB edits.
        s.write("a.env", "A=changed", true).await.unwrap();
        let n2 = s.import_from_dir(dir.path()).await.unwrap();
        assert_eq!(n2, 0);
        assert_eq!(s.read("a.env").await.unwrap(), "A=changed");
    }

    #[tokio::test]
    async fn import_from_missing_dir_is_noop() {
        let s = store().await;
        let n = s
            .import_from_dir(Path::new("/nonexistent/nession/path"))
            .await
            .unwrap();
        assert_eq!(n, 0);
    }
}
