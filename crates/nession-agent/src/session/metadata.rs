//! Durable, Session-owned work context (#2789).
//!
//! The Agent is the only writer. Metadata is keyed by the tmux Session's
//! `@nession_instance_id` user option, not by its name: an Agent restart keeps
//! the tmux Session (and therefore the option), while killing and recreating a
//! Session of the same name starts without it. That fence is what keeps a new
//! Session from inheriting the previous one's title, description or tags.
//!
//! Writes are atomic (temp + rename) and revision-checked under one
//! per-instance lock, so two clients that read the same revision cannot both
//! succeed. The prior metadata is left intact on every refusal.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use nession_protocol::contracts::session::v1::{validate_session_metadata, SessionMetadata};
use tokio::sync::Mutex as AsyncMutex;

use crate::tmux::manager::SessionManager;

/// The Agent's metadata store, rooted under its private data directory.
pub struct SessionMetadataStore {
    tmux: Arc<SessionManager>,
    root: PathBuf,
    /// One writer per Session instance. The map itself is only an index; the
    /// inner async lock is what serializes the read-compare-replace.
    locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    /// One initializer per Session name. The instance id must be resolved
    /// before the per-instance lock exists, and two callers racing that first
    /// resolution could otherwise create two ids (and two locks) for one tmux
    /// Session.
    name_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
}

impl SessionMetadataStore {
    /// The production store: `~/.nession/agent/sessions`.
    ///
    /// Construction never touches the filesystem; a store that is never asked
    /// for metadata creates nothing. The root falls back beside the process
    /// only when the home directory itself is unresolvable, the same fallback
    /// `EnvStore` uses.
    pub fn new(tmux: Arc<SessionManager>) -> Self {
        Self {
            tmux,
            root: nession_common::paths::agent_sessions_dir()
                .unwrap_or_else(|_| PathBuf::from(".nession/agent/sessions")),
            locks: Mutex::new(HashMap::new()),
            name_locks: Mutex::new(HashMap::new()),
        }
    }

    /// A store with an explicit root, for tests and owned fixtures.
    pub fn with_root(tmux: Arc<SessionManager>, root: PathBuf) -> Self {
        Self {
            tmux,
            root,
            locks: Mutex::new(HashMap::new()),
            name_locks: Mutex::new(HashMap::new()),
        }
    }

    /// The last-known metadata of a Session. Absent metadata is revision 0,
    /// not an error: legacy Sessions must render without a migration step.
    pub async fn get(&self, session_name: &str) -> Result<SessionMetadata> {
        let instance = self.instance_id(session_name).await?;
        self.read_at(&instance).await
    }

    /// Replace the user fields, guarded by the revision the caller read.
    ///
    /// `expected_revision` 0 is the first save on a legacy Session. A stale
    /// revision is `conflict:`; a rejected value is `invalid:`; both leave the
    /// stored metadata unchanged.
    pub async fn update(
        &self,
        session_name: &str,
        title: Option<&str>,
        description: Option<&str>,
        tags: &[String],
        expected_revision: u64,
    ) -> Result<SessionMetadata> {
        let instance = self.instance_id(session_name).await?;
        let lock = self.lock_for(&instance);
        let _guard = lock.lock().await;

        let current = self.read_at(&instance).await?;
        if current.revision != expected_revision {
            anyhow::bail!(
                "conflict: expected revision {expected_revision}, current revision {}",
                current.revision
            );
        }

        let normalized = validate_session_metadata(title, description, tags)
            .map_err(|error| anyhow::anyhow!("invalid: {error}"))?;
        let now = unix_now();
        let next = SessionMetadata {
            revision: current.revision.saturating_add(1),
            title: normalized.title,
            description: normalized.description,
            tags: normalized.tags,
            created_at: current.created_at.or(Some(now)),
            updated_at: Some(now),
        };
        self.write_at(&instance, &next).await?;
        Ok(next)
    }

    async fn instance_id(&self, session_name: &str) -> Result<String> {
        if session_name.trim().is_empty() {
            anyhow::bail!("not_found: a Session name is required");
        }
        // Serialize first-time initialization: the per-instance lock is keyed
        // by the id we do not have yet. Two concurrent readers of a legacy
        // Session would otherwise race `set-option` and end up using different
        // ids (and different locks).
        let name_lock = self.lock_in(&self.name_locks, session_name);
        let _guard = name_lock.lock().await;
        self.tmux
            .session_instance_id(session_name)
            .await
            .map_err(|error| classify_tmux_error(&format!("{error:#}")))
    }

    fn lock_for(&self, instance: &str) -> Arc<AsyncMutex<()>> {
        self.lock_in(&self.locks, instance)
    }

    fn lock_in(
        &self,
        locks: &Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
        key: &str,
    ) -> Arc<AsyncMutex<()>> {
        // The index is only a lookup table; a poisoned lock still holds a
        // usable entry, and discarding it would let two writers diverge.
        let mut locks = match locks.lock() {
            Ok(locks) => locks,
            Err(poisoned) => poisoned.into_inner(),
        };
        Arc::clone(
            locks
                .entry(key.to_string())
                .or_insert_with(|| Arc::new(AsyncMutex::new(()))),
        )
    }

    fn directory(&self, instance: &str) -> PathBuf {
        self.root.join(instance)
    }

    fn metadata_path(&self, instance: &str) -> PathBuf {
        self.directory(instance).join("metadata.json")
    }

    async fn read_at(&self, instance: &str) -> Result<SessionMetadata> {
        let path = self.metadata_path(instance);
        match tokio::fs::read(&path).await {
            Ok(bytes) => serde_json::from_slice::<SessionMetadata>(&bytes).with_context(|| {
                format!("unavailable: metadata for instance {instance} is unreadable")
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(empty_metadata()),
            Err(error) => Err(error)
                .with_context(|| format!("unavailable: could not read metadata for {instance}")),
        }
    }

    async fn write_at(&self, instance: &str, metadata: &SessionMetadata) -> Result<()> {
        let directory = self.directory(instance);
        tokio::fs::create_dir_all(&directory)
            .await
            .with_context(|| format!("unavailable: could not create {}", directory.display()))?;
        let path = self.metadata_path(instance);
        let tmp = directory.join(format!(".nession-{}.tmp", uuid::Uuid::new_v4()));
        let bytes =
            serde_json::to_vec_pretty(metadata).context("metadata could not be serialized")?;
        tokio::fs::write(&tmp, &bytes)
            .await
            .with_context(|| format!("unavailable: could not write {}", tmp.display()))?;
        if let Err(error) = tokio::fs::rename(&tmp, &path).await {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(error)
                .with_context(|| format!("unavailable: could not replace {}", path.display()));
        }
        Ok(())
    }
}

fn empty_metadata() -> SessionMetadata {
    SessionMetadata {
        revision: 0,
        title: None,
        description: None,
        tags: Vec::new(),
        created_at: None,
        updated_at: None,
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// The stable classification and user-facing detail of a store failure.
///
/// The store prefixes its errors so every transport adapter reports the same
/// `error_kind`; the prefix is not repeated in the detail.
pub fn error_kind_and_detail(error: &anyhow::Error) -> (&'static str, String) {
    let message = format!("{error:#}");
    if let Some(rest) = message.strip_prefix("conflict:") {
        ("conflict", rest.trim().to_string())
    } else if let Some(rest) = message.strip_prefix("invalid:") {
        ("invalid", rest.trim().to_string())
    } else if let Some(rest) = message.strip_prefix("not_found:") {
        ("not_found", rest.trim().to_string())
    } else {
        ("unavailable", message.trim().to_string())
    }
}

/// Map tmux's failure into the user-facing classification.
///
/// A missing Session is `not_found`; every other tmux failure is
/// `unavailable`, so a disconnected server is not reported as a deleted
/// Session.
fn classify_tmux_error(message: &str) -> anyhow::Error {
    let lower = message.to_lowercase();
    if lower.contains("can't find session")
        || lower.contains("no such session")
        || lower.contains("session not found")
    {
        anyhow::anyhow!("not_found: {message}")
    } else {
        anyhow::anyhow!("unavailable: {message}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestSession;

    fn tmux_available() -> bool {
        // Through the canonical chokepoint, like every tmux call; `-V` needs
        // no server, so it is harmless on the private socket.
        crate::tmux::cmd::global()
            .std()
            .arg("-V")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    async fn store_with_session(
        prefix: &str,
    ) -> (tempfile::TempDir, Arc<SessionManager>, TestSession) {
        let dir = tempfile::tempdir().unwrap();
        let manager = Arc::new(SessionManager::new());
        let session = TestSession::new(prefix);
        manager
            .create_session(session.name(), 80, 24, "/tmp", &[])
            .await
            .expect("tmux creates the fixture Session");
        (dir, manager, session)
    }

    #[tokio::test]
    async fn metadata_persists_across_a_store_restart() {
        if !tmux_available() {
            eprintln!("tmux not available, skipping");
            return;
        }
        let (dir, manager, session) = store_with_session("metadata-restart").await;
        let name = session.name().to_string();
        let instance_before = manager
            .session_instance_id(&name)
            .await
            .expect("the tmux Session has an instance fence");
        let store = SessionMetadataStore::with_root(Arc::clone(&manager), dir.path().to_path_buf());

        let saved = store
            .update(
                &name,
                Some(" Release triage "),
                Some("Fix the staging run"),
                &["release".to_string(), "Staging".to_string()],
                0,
            )
            .await
            .expect("first save creates revision 1");
        assert_eq!(saved.revision, 1);
        assert_eq!(saved.title.as_deref(), Some("Release triage"));
        assert!(saved.created_at.is_some());

        // A fresh store is the Agent-restart shape: the tmux Session still
        // owns its instance option, so the same metadata is found.
        let restarted =
            SessionMetadataStore::with_root(Arc::clone(&manager), dir.path().to_path_buf());
        let loaded = restarted.get(&name).await.unwrap();
        assert_eq!(loaded, saved);

        // Saving work context does not rename or recreate the tmux Session:
        // the name and the instance fence are the ones that existed before.
        let listed = manager.list_sessions().await.unwrap();
        assert!(
            listed.iter().any(|session| session.name == name),
            "the tmux Session still exists under its own name"
        );
        assert_eq!(
            manager.session_instance_id(&name).await.unwrap(),
            instance_before
        );
    }

    #[tokio::test]
    async fn legacy_metadata_is_absent_until_the_first_save() {
        if !tmux_available() {
            eprintln!("tmux not available, skipping");
            return;
        }
        let (dir, manager, session) = store_with_session("metadata-legacy").await;
        let name = session.name().to_string();
        let store = SessionMetadataStore::with_root(Arc::clone(&manager), dir.path().to_path_buf());

        let empty = store.get(&name).await.unwrap();
        assert_eq!(empty.revision, 0);
        assert!(empty.title.is_none());
        assert!(empty.tags.is_empty());
        assert!(empty.created_at.is_none());

        let saved = store
            .update(&name, Some("New title"), None, &[], 0)
            .await
            .unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(saved.title.as_deref(), Some("New title"));
        assert!(saved.description.is_none());
        assert!(saved.tags.is_empty());
    }

    #[tokio::test]
    async fn stale_revision_is_refused_and_prior_metadata_is_intact() {
        if !tmux_available() {
            eprintln!("tmux not available, skipping");
            return;
        }
        let (dir, manager, session) = store_with_session("metadata-conflict").await;
        let name = session.name().to_string();
        let store = SessionMetadataStore::with_root(Arc::clone(&manager), dir.path().to_path_buf());

        let first = store
            .update(&name, Some("First"), Some("kept"), &["one".to_string()], 0)
            .await
            .unwrap();
        let error = store
            .update(&name, Some("Stale"), None, &[], 0)
            .await
            .unwrap_err();
        assert!(format!("{error}").starts_with("conflict:"), "{error}");
        assert_eq!(store.get(&name).await.unwrap(), first);
    }

    #[tokio::test]
    async fn invalid_values_are_refused_without_writing() {
        if !tmux_available() {
            eprintln!("tmux not available, skipping");
            return;
        }
        let (dir, manager, session) = store_with_session("metadata-invalid").await;
        let name = session.name().to_string();
        let store = SessionMetadataStore::with_root(Arc::clone(&manager), dir.path().to_path_buf());

        let error = store
            .update(&name, Some(&"x".repeat(121)), None, &[], 0)
            .await
            .unwrap_err();
        assert!(format!("{error}").starts_with("invalid:"), "{error}");
        assert_eq!(store.get(&name).await.unwrap().revision, 0);

        let error = store
            .update(
                &name,
                None,
                None,
                &["Same".to_string(), "same".to_string()],
                0,
            )
            .await
            .unwrap_err();
        assert!(format!("{error}").starts_with("invalid:"), "{error}");
        assert_eq!(store.get(&name).await.unwrap().revision, 0);
    }

    #[tokio::test]
    async fn a_recreated_session_of_the_same_name_does_not_inherit_metadata() {
        if !tmux_available() {
            eprintln!("tmux not available, skipping");
            return;
        }
        let (dir, manager, session) = store_with_session("metadata-recreate").await;
        let name = session.name().to_string();
        let old_instance = manager.session_instance_id(&name).await.unwrap();
        let store = SessionMetadataStore::with_root(Arc::clone(&manager), dir.path().to_path_buf());
        store
            .update(&name, Some("Old instance"), None, &[], 0)
            .await
            .unwrap();

        manager.kill_session(&name).await.expect("kill");
        manager
            .create_session(&name, 80, 24, "/tmp", &[])
            .await
            .expect("recreate");

        // The old instance directory is retained (an explicit retention policy:
        // metadata is never deleted behind the user's back), but the new
        // tmux Session has a different instance fence and starts at revision 0.
        assert!(
            dir.path()
                .join(&old_instance)
                .join("metadata.json")
                .exists(),
            "the previous instance's metadata is retained, not deleted"
        );
        let new_instance = manager.session_instance_id(&name).await.unwrap();
        assert_ne!(new_instance, old_instance);
        let recreated = store.get(&name).await.unwrap();
        assert_eq!(recreated.revision, 0);
        assert!(recreated.title.is_none());
    }

    #[test]
    fn a_missing_session_is_not_found_and_a_broken_tmux_is_unavailable() {
        let missing = classify_tmux_error("can't find session: gone");
        assert_eq!(error_kind_and_detail(&missing).0, "not_found");
        let broken = classify_tmux_error("error connecting to /tmp/nession/tmux.sock");
        assert_eq!(error_kind_and_detail(&broken).0, "unavailable");
        let conflict = anyhow::anyhow!("conflict: expected revision 1, current revision 2");
        assert_eq!(error_kind_and_detail(&conflict).0, "conflict");
        let invalid = anyhow::anyhow!("invalid: title is too long");
        assert_eq!(error_kind_and_detail(&invalid).0, "invalid");
    }

    #[tokio::test]
    async fn concurrent_first_saves_have_one_winner() {
        if !tmux_available() {
            eprintln!("tmux not available, skipping");
            return;
        }
        let (dir, manager, session) = store_with_session("metadata-race").await;
        let name = session.name().to_string();
        let store = Arc::new(SessionMetadataStore::with_root(
            Arc::clone(&manager),
            dir.path().to_path_buf(),
        ));

        // More than two racers: the first save also initializes the tmux
        // instance id, so this exercises both the name lock (initialization)
        // and the per-instance lock (read-compare-replace).
        let titles: Vec<String> = (0..8).map(|index| format!("T{index}")).collect();
        let results = futures_util::future::join_all(
            titles
                .iter()
                .map(|title| store.update(&name, Some(title.as_str()), None, &[], 0)),
        )
        .await;
        let successes = results.iter().filter(|result| result.is_ok()).count();
        assert_eq!(successes, 1, "exactly one first save wins");
        let current = store.get(&name).await.unwrap();
        assert_eq!(current.revision, 1);
        assert!(
            titles
                .iter()
                .any(|title| current.title.as_deref() == Some(title.as_str())),
            "the winner's title is the persisted one: {current:?}"
        );
    }
}
