//! Mark → grace → recheck → bounded reclaim over the catalog graph.

use anyhow::Result;
use sea_orm::{ConnectionTrait, DatabaseConnection};
use std::collections::HashSet;

use super::pin;
use super::reference;
use super::sqlite;
use super::tag;
use crate::blob::store::BlobStore;

/// One sweep's bounds and grace window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GcPolicy {
    /// How long an unreachable object stays marked before it can be reclaimed.
    /// A zero grace still takes two sweeps: the first marks, the second may
    /// recheck and delete.
    pub grace_seconds: i64,
    /// Maximum objects reclaimed in one sweep.
    pub max_deletions: usize,
    /// Maximum blob bytes reclaimed in one sweep.
    pub max_bytes: u64,
}

impl Default for GcPolicy {
    fn default() -> Self {
        Self {
            grace_seconds: 3600,
            max_deletions: 64,
            max_bytes: 512 * 1024 * 1024,
        }
    }
}

/// The outcome of one sweep.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GcReport {
    /// Distinct roots considered (tags, live pins, external consumers).
    pub roots: u64,
    /// Objects reachable from those roots through descriptor edges.
    pub reachable_objects: u64,
    /// Unreachable objects marked for the first time in this sweep.
    pub newly_marked: u64,
    /// Objects whose grace had not elapsed.
    pub waiting_for_grace: u64,
    /// Objects rechecked and found reachable again.
    pub reprieved: u64,
    pub deleted_objects: u64,
    pub deleted_blobs: u64,
    pub reclaimed_bytes: u64,
    /// Work left for a later sweep by the count/byte bound.
    pub deferred_by_limit: u64,
}

async fn live_roots(conn: &impl ConnectionTrait, now: i64) -> Result<HashSet<String>> {
    let mut roots: HashSet<String> = tag::all_tag_digests(conn).await?.into_iter().collect();
    roots.extend(pin::live_pin_digests(conn, now).await?);
    Ok(roots)
}

/// Every digest currently protected by a Tag or live pin, expanded through
/// descriptor edges. The legacy Server GC uses this so a migrated EROFS blob
/// cannot be reclaimed while a catalog Manifest still references it.
pub async fn protected_digests(conn: &impl ConnectionTrait, now: i64) -> Result<HashSet<String>> {
    if !sqlite::table_exists(conn, "catalog_objects").await? {
        return Ok(HashSet::new());
    }
    let roots: Vec<String> = live_roots(conn, now).await?.into_iter().collect();
    reference::reachable(conn, &roots).await
}

async fn get_mark(conn: &impl ConnectionTrait, digest: &str) -> Result<Option<i64>> {
    let rows = sqlite::query_all(
        conn,
        "SELECT marked_at FROM catalog_gc_marks WHERE digest = ?",
        vec![digest.into()],
    )
    .await?;
    match rows.first() {
        None => Ok(None),
        Some(row) => Ok(Some(row.try_get("", "marked_at").map_err(|error| {
            anyhow::anyhow!("catalog GC mark is invalid: {error}")
        })?)),
    }
}

async fn mark(conn: &impl ConnectionTrait, digest: &str, now: i64) -> Result<()> {
    sqlite::execute(
        conn,
        "INSERT INTO catalog_gc_marks (digest, marked_at) VALUES (?, ?) \
         ON CONFLICT (digest) DO NOTHING",
        vec![digest.into(), now.into()],
    )
    .await?;
    Ok(())
}

async fn unmark(conn: &impl ConnectionTrait, digest: &str) -> Result<()> {
    sqlite::execute(
        conn,
        "DELETE FROM catalog_gc_marks WHERE digest = ?",
        vec![digest.into()],
    )
    .await?;
    Ok(())
}

/// Run one bounded sweep.
///
/// The caller serializes this with publishing (the `ImageCatalog` lock does
/// that for every in-process writer). Marks are durable, so an interrupted
/// sweep resumes on the next call; object rows are deleted before their blobs,
/// leaving at worst an orphan file rather than a referenced digest whose bytes
/// are gone.
pub async fn sweep(
    conn: &DatabaseConnection,
    store: &BlobStore,
    now: i64,
    policy: &GcPolicy,
    external_roots: &[String],
) -> Result<GcReport> {
    pin::prune_expired(conn, now).await?;
    let roots: HashSet<String> = live_roots(conn, now)
        .await?
        .into_iter()
        .chain(external_roots.iter().cloned())
        .collect();
    let root_list: Vec<String> = roots.iter().cloned().collect();
    let reachable = reference::reachable(conn, &root_list).await?;
    let objects = reference::all_objects(conn).await?;
    let mut report = GcReport {
        roots: u64::try_from(roots.len()).unwrap_or(u64::MAX),
        reachable_objects: u64::try_from(reachable.len()).unwrap_or(u64::MAX),
        ..GcReport::default()
    };
    // A new Tag or pin may have made a previously marked object reachable
    // again. Clear the durable mark so a stale mark cannot outlive the reason
    // it was set.
    for object in &objects {
        if reachable.contains(&object.digest) && get_mark(conn, &object.digest).await?.is_some() {
            unmark(conn, &object.digest).await?;
            report.reprieved += 1;
        }
    }
    let candidates: Vec<_> = objects
        .into_iter()
        .filter(|object| !reachable.contains(&object.digest))
        .collect();
    for (position, object) in candidates.iter().enumerate() {
        if usize::try_from(report.deleted_objects).unwrap_or(usize::MAX) >= policy.max_deletions {
            report.deferred_by_limit =
                u64::try_from(candidates.len() - position).unwrap_or_default();
            break;
        }
        if report.reclaimed_bytes.saturating_add(object.size_bytes) > policy.max_bytes {
            report.deferred_by_limit =
                u64::try_from(candidates.len() - position).unwrap_or_default();
            break;
        }
        let Some(marked_at) = get_mark(conn, &object.digest).await? else {
            mark(conn, &object.digest, now).await?;
            report.newly_marked += 1;
            continue;
        };
        if marked_at.saturating_add(policy.grace_seconds) > now {
            report.waiting_for_grace += 1;
            continue;
        }
        // Recheck inside one transaction: a Tag or pin may have appeared since
        // the mark, and deleting the row and its edges must be atomic.
        let transaction = sqlite::begin(conn).await?;
        let roots_now: Vec<String> = live_roots(&transaction, now)
            .await?
            .into_iter()
            .chain(external_roots.iter().cloned())
            .collect();
        let still_reachable = reference::reachable(&transaction, &roots_now).await?;
        if still_reachable.contains(&object.digest) {
            unmark(&transaction, &object.digest).await?;
            transaction
                .commit()
                .await
                .map_err(|error| anyhow::anyhow!("catalog GC recheck commit failed: {error}"))?;
            report.reprieved += 1;
            continue;
        }
        let removed = reference::delete_object(&transaction, &object.digest).await?;
        unmark(&transaction, &object.digest).await?;
        transaction
            .commit()
            .await
            .map_err(|error| anyhow::anyhow!("catalog GC commit failed: {error}"))?;
        if removed.is_some() {
            report.deleted_objects += 1;
            report.reclaimed_bytes = report.reclaimed_bytes.saturating_add(object.size_bytes);
            if store.remove(&object.digest)? {
                report.deleted_blobs += 1;
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob::store::BlobStore;
    use crate::catalog::reference::{record_object, ObjectKind, StoredObject};
    use crate::catalog::sqlite::tests::memory_connection;
    use crate::catalog::tag::{set_tag, TagExpectation};
    use crate::oci::{MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_MANIFEST};
    use tempfile::tempdir;

    async fn published_manifest(
        conn: &DatabaseConnection,
        store: &BlobStore,
        tag_name: Option<&str>,
        hex: char,
        now: i64,
    ) -> (String, String) {
        let layer_bytes = format!("erofs-bytes-{hex}").into_bytes();
        let layer = store.put_bytes(&layer_bytes).unwrap();
        let config = StoredObject {
            digest: format!("sha256:{}", hex.to_string().repeat(63) + "a"),
            media_type: MEDIA_TYPE_CONFIG.to_string(),
            size_bytes: 1,
            kind: ObjectKind::Config,
        };
        let manifest = StoredObject {
            digest: format!("sha256:{}", hex.to_string().repeat(63) + "b"),
            media_type: MEDIA_TYPE_MANIFEST.to_string(),
            size_bytes: 1,
            kind: ObjectKind::Manifest,
        };
        let layer_object = StoredObject {
            digest: layer.digest.clone(),
            media_type: MEDIA_TYPE_EROFS.to_string(),
            size_bytes: layer.size_bytes,
            kind: ObjectKind::Erofs,
        };
        for object in [&config, &manifest, &layer_object] {
            record_object(conn, object, now).await.unwrap();
        }
        reference::record_reference(conn, &manifest.digest, &config.digest, "config", now)
            .await
            .unwrap();
        reference::record_reference(conn, &manifest.digest, &layer.digest, "layer", now)
            .await
            .unwrap();
        if let Some(tag_name) = tag_name {
            set_tag(
                conn,
                "nession/test",
                tag_name,
                &manifest.digest,
                &TagExpectation::Absent,
                now,
            )
            .await
            .unwrap();
        }
        (manifest.digest, layer.digest)
    }

    #[tokio::test]
    async fn gc_marks_then_deletes_only_unreachable_objects_after_grace() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().join("store")).unwrap();
        let conn = memory_connection().await;
        sqlite::migrate(&conn).await.unwrap();
        let (kept, kept_layer) = published_manifest(&conn, &store, Some("v1"), 'a', 100).await;
        let (garbage, garbage_layer) = published_manifest(&conn, &store, None, 'b', 100).await;

        let policy = GcPolicy {
            grace_seconds: 60,
            max_deletions: 10,
            max_bytes: u64::MAX,
        };
        let first = sweep(&conn, &store, 200, &policy, &[]).await.unwrap();
        assert!(first.newly_marked >= 3, "{first:?}");
        assert_eq!(first.deleted_objects, 0);
        assert!(reference::get_object(&conn, &garbage)
            .await
            .unwrap()
            .is_some());

        let second = sweep(&conn, &store, 261, &policy, &[]).await.unwrap();
        assert!(second.deleted_objects >= 3, "{second:?}");
        assert!(reference::get_object(&conn, &garbage)
            .await
            .unwrap()
            .is_none());
        assert!(!store.contains(&garbage_layer).unwrap());
        assert!(reference::get_object(&conn, &kept).await.unwrap().is_some());
        assert!(store.contains(&kept_layer).unwrap());
    }

    #[tokio::test]
    async fn a_pin_or_new_tag_reprieves_a_marked_object() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().join("store")).unwrap();
        let conn = memory_connection().await;
        sqlite::migrate(&conn).await.unwrap();
        let (digest, _) = published_manifest(&conn, &store, None, 'c', 1).await;
        let policy = GcPolicy {
            grace_seconds: 10,
            max_deletions: 10,
            max_bytes: u64::MAX,
        };
        sweep(&conn, &store, 100, &policy, &[]).await.unwrap();
        pin::pin(&conn, pin::ConsumerKind::Session, "s1", &digest, 101, None)
            .await
            .unwrap();
        let second = sweep(&conn, &store, 200, &policy, &[]).await.unwrap();
        assert!(second.reprieved >= 1, "{second:?}");
        assert!(reference::get_object(&conn, &digest)
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn durable_marks_bounded_sweeps_and_restarts_still_reclaim() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().join("store")).unwrap();
        let database_path = dir.path().join("gc.db");
        let conn = sqlite::tests::file_connection(&database_path).await;
        sqlite::migrate(&conn).await.unwrap();
        let (digest, _) = published_manifest(&conn, &store, None, 'd', 1).await;
        let policy = GcPolicy {
            grace_seconds: 10,
            max_deletions: 1,
            max_bytes: u64::MAX,
        };
        sweep(&conn, &store, 100, &policy, &[]).await.unwrap();
        assert!(get_mark(&conn, &digest).await.unwrap().is_some());
        drop(conn);
        let conn = sqlite::tests::file_connection(&database_path).await;
        let bounded = sweep(&conn, &store, 111, &policy, &[]).await.unwrap();
        assert_eq!(bounded.deleted_objects, 1, "{bounded:?}");
        assert!(bounded.deferred_by_limit >= 1, "{bounded:?}");
        // The remaining durable marks let a later sweep (or restarted owner)
        // continue rather than restarting the grace window.
        let third = sweep(&conn, &store, 111, &policy, &[]).await.unwrap();
        assert!(third.deleted_objects >= 1, "{third:?}");
    }
}
