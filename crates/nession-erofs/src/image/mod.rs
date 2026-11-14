//! Manifest-addressed image operations over the catalog and CAS (#3496).

pub mod inspect;
pub mod publish;
pub mod resolve;

pub use inspect::{inspect_index, inspect_manifest, IndexInspection, ManifestInspection};
pub use publish::{
    publish_index, publish_manifest, publish_manifest_untagged, IndexEntry, IndexPublication,
    IndexPublishOutcome, ManifestPublication, PublishOutcome,
};
pub use resolve::{resolve_digest, resolve_legacy_digest, resolve_tag, ResolvedImage};

use anyhow::Result;
use sea_orm::DatabaseConnection;
use tokio::sync::Mutex;

use crate::blob::store::BlobStore;
use crate::catalog::gc::{sweep, GcPolicy, GcReport};
use crate::catalog::legacy::{migrate_legacy_images, LegacyMigrationReport, LegacyPlatform};
use crate::catalog::tag::TagExpectation;

/// The in-process writer for one CAS and catalog.
///
/// Publication, legacy migration and GC take one lock. Combined with the
/// Server's single SQLite connection, this means a sweep can never delete a
/// Blob between a publisher's CAS verification and its Tag commit. Cross-
/// process concurrency is a V1 single-owner condition (the same condition the
/// accepted #3334 build root uses), not a multi-Pod claim.
#[derive(Debug)]
pub struct ImageCatalog {
    store: BlobStore,
    writer: Mutex<()>,
}

impl ImageCatalog {
    pub fn new(store: BlobStore) -> Self {
        Self {
            store,
            writer: Mutex::new(()),
        }
    }

    pub fn store(&self) -> &BlobStore {
        &self.store
    }

    /// Publish one Manifest and move its Tag.
    pub async fn publish_manifest(
        &self,
        conn: &DatabaseConnection,
        publication: &ManifestPublication,
        now: i64,
    ) -> Result<PublishOutcome> {
        let _guard = self.writer.lock().await;
        publish_manifest(conn, &self.store, publication, now).await
    }

    /// Publish one multi-platform Index and move its Tag.
    pub async fn publish_index(
        &self,
        conn: &DatabaseConnection,
        publication: &IndexPublication,
        now: i64,
    ) -> Result<IndexPublishOutcome> {
        let _guard = self.writer.lock().await;
        publish_index(conn, &self.store, publication, now).await
    }

    /// Create or move a Tag to an object that already exists in the catalog.
    pub async fn set_tag(
        &self,
        conn: &DatabaseConnection,
        repository: &str,
        tag: &str,
        digest: &str,
        expectation: &TagExpectation,
        now: i64,
    ) -> Result<crate::catalog::tag::TagUpdate> {
        let _guard = self.writer.lock().await;
        crate::catalog::tag::set_tag(conn, repository, tag, digest, expectation, now).await
    }

    /// Run one bounded GC sweep.
    pub async fn gc(
        &self,
        conn: &DatabaseConnection,
        now: i64,
        policy: &GcPolicy,
        external_roots: &[String],
    ) -> Result<GcReport> {
        let _guard = self.writer.lock().await;
        sweep(conn, &self.store, now, policy, external_roots).await
    }

    /// Migrate historical digest-addressed rows without rewriting bytes.
    pub async fn migrate_legacy(
        &self,
        conn: &DatabaseConnection,
        platform: &LegacyPlatform,
        now: i64,
    ) -> Result<LegacyMigrationReport> {
        let _guard = self.writer.lock().await;
        migrate_legacy_images(conn, &self.store, platform, now).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::pin;
    use crate::catalog::sqlite::tests::memory_connection;
    use crate::catalog::tag;
    use crate::image::publish::tests::{layer, manifest_and_config};
    use crate::image::resolve::resolve_digest;
    use tempfile::tempdir;

    #[tokio::test]
    async fn the_catalog_lock_serializes_publication_and_gc() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().join("store")).unwrap();
        let catalog = ImageCatalog::new(store);
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        let layer = layer(catalog.store(), b"shared");
        let (manifest, config) = manifest_and_config(catalog.store(), &layer, "amd64", None, None);
        let publication = ManifestPublication {
            repository: "nession/test".to_string(),
            tag: "v1".to_string(),
            expectation: TagExpectation::Absent,
            layer,
            config,
            manifest: manifest.clone(),
        };
        let policy = GcPolicy::default();
        let (published, swept) = tokio::join!(
            catalog.publish_manifest(&conn, &publication, 1),
            catalog.gc(&conn, 1, &policy, &[])
        );
        published.unwrap();
        swept.unwrap();
        assert_eq!(
            tag::get_tag(&conn, "nession/test", "v1").await.unwrap(),
            Some(manifest.digest().to_string())
        );
    }

    #[tokio::test]
    async fn concurrent_tag_moves_with_one_expected_old_digest_have_one_winner() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().join("store")).unwrap();
        let catalog = ImageCatalog::new(store);
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        let layer = layer(catalog.store(), b"shared");
        let (initial, initial_config) =
            manifest_and_config(catalog.store(), &layer, "amd64", None, Some("A=1"));
        let initial = catalog
            .publish_manifest(
                &conn,
                &ManifestPublication {
                    repository: "nession/test".to_string(),
                    tag: "latest".to_string(),
                    expectation: TagExpectation::Absent,
                    layer: layer.clone(),
                    config: initial_config,
                    manifest: initial,
                },
                1,
            )
            .await
            .unwrap();
        let (left, left_config) =
            manifest_and_config(catalog.store(), &layer, "amd64", None, Some("A=2"));
        let (right, right_config) =
            manifest_and_config(catalog.store(), &layer, "amd64", None, Some("A=3"));
        let publication = |manifest, config| ManifestPublication {
            repository: "nession/test".to_string(),
            tag: "latest".to_string(),
            expectation: TagExpectation::Exact(initial.manifest_digest.clone()),
            layer: layer.clone(),
            config,
            manifest,
        };
        let left_publication = publication(left, left_config);
        let right_publication = publication(right, right_config);
        let (left_result, right_result) = tokio::join!(
            catalog.publish_manifest(&conn, &left_publication, 2),
            catalog.publish_manifest(&conn, &right_publication, 3)
        );
        assert!(
            left_result.is_ok() != right_result.is_ok(),
            "exactly one move succeeds"
        );
        let winner = left_result
            .as_ref()
            .or(right_result.as_ref())
            .map(|outcome| outcome.manifest_digest.clone())
            .unwrap();
        assert_eq!(
            tag::get_tag(&conn, "nession/test", "latest").await.unwrap(),
            Some(winner)
        );
    }

    #[tokio::test]
    async fn a_pinned_manifest_survives_a_tag_move() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().join("store")).unwrap();
        let catalog = ImageCatalog::new(store);
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        let layer = layer(catalog.store(), b"shared");
        let (first, first_config) =
            manifest_and_config(catalog.store(), &layer, "amd64", None, Some("A=1"));
        let first_digest = first.digest().to_string();
        catalog
            .publish_manifest(
                &conn,
                &ManifestPublication {
                    repository: "nession/test".to_string(),
                    tag: "latest".to_string(),
                    expectation: TagExpectation::Absent,
                    layer: layer.clone(),
                    config: first_config,
                    manifest: first,
                },
                1,
            )
            .await
            .unwrap();
        pin::pin(
            &conn,
            pin::ConsumerKind::Session,
            "session-1",
            &first_digest,
            2,
            None,
        )
        .await
        .unwrap();
        let (second, second_config) =
            manifest_and_config(catalog.store(), &layer, "amd64", None, Some("A=2"));
        let second_digest = second.digest().to_string();
        catalog
            .publish_manifest(
                &conn,
                &ManifestPublication {
                    repository: "nession/test".to_string(),
                    tag: "latest".to_string(),
                    expectation: TagExpectation::Exact(first_digest.clone()),
                    layer: layer.clone(),
                    config: second_config,
                    manifest: second,
                },
                3,
            )
            .await
            .unwrap();
        assert_eq!(
            tag::get_tag(&conn, "nession/test", "latest").await.unwrap(),
            Some(second_digest)
        );
        assert_eq!(
            resolve_digest(&conn, &first_digest)
                .await
                .unwrap()
                .unwrap()
                .digest,
            first_digest
        );
        let inspection = inspect_manifest(catalog.store(), &first_digest).unwrap();
        assert_eq!(inspection.config.env(), &["A=1".to_string()]);
    }
}
