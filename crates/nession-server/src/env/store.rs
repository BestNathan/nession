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
use nession_protocol::contracts::env::v1::{EnvFileInfo, EnvSource};
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
    ///
    /// Create-only (`overwrite == false`) is a single database-atomic
    /// insert-if-absent (#4300): the existence check and the insert cannot be
    /// interleaved by a competing creator, so exactly one concurrent writer
    /// receives `Ok(true)` and the others receive the existing-file refusal
    /// `Ok(false)`. The previous read-then-upsert sequence let two creators both
    /// observe "absent" and silently clobber each other. Explicit
    /// `overwrite == true` keeps the upsert path.
    pub async fn write(&self, name: &str, content: &str, overwrite: bool) -> Result<bool> {
        validate_name(name)?;
        if overwrite {
            self.db.upsert_env_file(name, content).await?;
            Ok(true)
        } else {
            self.db.insert_env_file_if_absent(name, content).await
        }
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
    async fn create_only_refusal_preserves_row_and_overwrite_replaces() {
        let s = store().await;
        assert!(s.write("ctl.env", "OWNER=A\n", false).await.unwrap());
        let before = s.db.get_env_file("ctl.env").await.unwrap().unwrap();

        // Create-only against an existing file refuses without mutating content
        // or timestamps (SC-02).
        assert!(!s.write("ctl.env", "OWNER=B\n", false).await.unwrap());
        let after = s.db.get_env_file("ctl.env").await.unwrap().unwrap();
        assert_eq!(after.content, "OWNER=A\n");
        assert_eq!(after.created_at, before.created_at);
        assert_eq!(after.updated_at, before.updated_at);
        assert_eq!(s.read("ctl.env").await.unwrap(), "OWNER=A\n");
        assert!(s.exists("ctl.env").await.unwrap());
        assert_eq!(s.list().await.unwrap().len(), 1);

        // Explicit overwrite still replaces the content.
        assert!(s.write("ctl.env", "OWNER=C\n", true).await.unwrap());
        assert_eq!(s.read("ctl.env").await.unwrap(), "OWNER=C\n");

        // read/list/delete remain unchanged; delete is idempotent.
        s.delete("ctl.env").await.unwrap();
        assert!(!s.exists("ctl.env").await.unwrap());
        assert!(s.list().await.unwrap().is_empty());
        s.delete("ctl.env").await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_create_only_yields_exactly_one_winner() {
        // #4300 regression (SC-01): several writers race to create the same
        // absent name with overwrite=false. Each EnvStore backs a real SQLite
        // connection onto one shared WAL file, so the writer lock is genuine
        // between them. Exactly one creation may succeed; every other writer
        // must receive the explicit existing-file refusal Ok(false), and the
        // winner's credential-bearing content must remain intact.
        //
        // On the pre-fix read-then-upsert code every writer observes "absent"
        // before any upsert lands, so all return Ok(true) and the last silently
        // clobbers the rest — this test fails there. Connections are opened
        // sequentially first (migrations applied once); only the writes race.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("race.db");
        let path = path.to_str().unwrap();
        const WRITERS: usize = 8;
        let mut stores = Vec::new();
        for _ in 0..WRITERS {
            let db = Arc::new(Database::new(path).await.unwrap());
            stores.push(EnvStore::new(db));
        }

        let barrier = Arc::new(tokio::sync::Barrier::new(WRITERS));
        let mut handles = Vec::new();
        for (i, store) in stores.iter().enumerate() {
            let store = store.clone();
            let barrier = Arc::clone(&barrier);
            handles.push(tokio::spawn(async move {
                barrier.wait().await;
                store
                    .write("race.env", &format!("OWNER={i}\n"), false)
                    .await
                    .unwrap()
            }));
        }
        let mut winners = Vec::new();
        let mut refusals = 0usize;
        for (i, handle) in handles.into_iter().enumerate() {
            if handle.await.unwrap() {
                winners.push(i);
            } else {
                refusals += 1;
            }
        }
        assert_eq!(
            winners.len(),
            1,
            "exactly one create-only writer may succeed"
        );
        assert_eq!(refusals, WRITERS - 1, "every other writer is refused");
        assert_eq!(
            stores[0].read("race.env").await.unwrap(),
            format!("OWNER={}\n", winners[0])
        );
        let list = stores[0].list().await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "race.env");
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
