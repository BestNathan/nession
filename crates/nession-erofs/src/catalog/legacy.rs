//! Byte-preserving migration of the historical #3022 digest-addressed rows.
//!
//! Legacy state is an `images` row and an `image_aliases` row keyed to the
//! EROFS Blob digest. Migration synthesizes one deterministic standard
//! Config+Manifest per ready Blob and records the mapping. It never rebuilds,
//! moves or rewrites EROFS bytes, and legacy rows stay readable for rollback.

use anyhow::{Context, Result};
use sea_orm::DatabaseConnection;
use serde_json::Map;
use std::collections::BTreeMap;

use super::pin::ConsumerKind;
use super::reference::{record_object, record_reference, ObjectKind, StoredObject};
use super::repository::ensure_repository;
use super::sqlite;
use super::tag::{self, TagExpectation};
use crate::blob::store::BlobStore;
use crate::oci::annotation::{MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_MANIFEST};
use crate::oci::config::{ImageConfig, RootFs, RuntimeConfig};
use crate::oci::descriptor::Descriptor;
use crate::oci::manifest::Manifest;
use crate::oci::validation::validate_manifest_config;
use crate::oci::{to_bytes, RawDocument};

/// The repository holding migrated historical alias tags.
pub const LEGACY_REPOSITORY: &str = "legacy";

/// The OCI platform assigned to a legacy EROFS blob during migration.
///
/// A legacy row did not record a platform. The migration takes the explicit
/// platform of the importing Server (or test) and stores it in the mapping, so
/// repeated migration with the same declaration is byte-identical.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyPlatform {
    pub os: String,
    pub architecture: String,
    pub variant: Option<String>,
}

impl LegacyPlatform {
    pub fn new(os: &str, architecture: &str) -> Self {
        Self {
            os: os.to_string(),
            architecture: architecture.to_string(),
            variant: None,
        }
    }

    /// Map the host OS/architecture to OCI names.
    pub fn host() -> Self {
        let architecture = match std::env::consts::ARCH {
            "x86_64" => "amd64",
            "aarch64" => "arm64",
            other => other,
        };
        let os = match std::env::consts::OS {
            "macos" => "darwin",
            other => other,
        };
        Self::new(os, architecture)
    }

    fn record(&self) -> String {
        match &self.variant {
            Some(variant) => format!("{}/{}/{variant}", self.os, self.architecture),
            None => format!("{}/{}", self.os, self.architecture),
        }
    }
}

/// What one migration run did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LegacyMigrationReport {
    pub ready_images: u64,
    pub migrated_images: u64,
    pub already_migrated: u64,
    pub created_alias_tags: u64,
    pub alias_conflicts: u64,
}

/// What one rollback removed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LegacyRollbackReport {
    pub removed_mappings: u64,
    pub removed_alias_tags: u64,
}

struct PreparedImage {
    legacy_image_id: String,
    legacy_digest: String,
    config: RawDocument,
    manifest: RawDocument,
    config_digest: String,
    manifest_digest: String,
    platform: String,
}

/// Migrate every ready legacy image that does not have a mapping yet.
///
/// CAS publication happens before the database transaction. If any Blob is
/// missing or invalid, nothing is recorded, so a failed migration leaves the
/// legacy rows and the catalog untouched except for unreachable, idempotent
/// CAS objects.
pub async fn migrate_legacy_images(
    conn: &DatabaseConnection,
    store: &BlobStore,
    platform: &LegacyPlatform,
    now: i64,
) -> Result<LegacyMigrationReport> {
    if !sqlite::table_exists(conn, "images").await? {
        return Ok(LegacyMigrationReport::default());
    }
    let images = sqlite::query_all(
        conn,
        "SELECT image_id, digest, size_bytes FROM images \
         WHERE status = 'ready' AND digest IS NOT NULL ORDER BY image_id",
        Vec::new(),
    )
    .await?;
    let aliases = if sqlite::table_exists(conn, "image_aliases").await? {
        sqlite::query_all(
            conn,
            "SELECT alias, image_digest FROM image_aliases ORDER BY alias",
            Vec::new(),
        )
        .await?
    } else {
        Vec::new()
    };
    let mut report = LegacyMigrationReport {
        ready_images: u64::try_from(images.len()).unwrap_or(u64::MAX),
        ..LegacyMigrationReport::default()
    };
    let mut prepared = Vec::new();
    for row in &images {
        let image_id: String = row
            .try_get("", "image_id")
            .map_err(|error| anyhow::anyhow!("legacy image id is invalid: {error}"))?;
        let digest: String = row
            .try_get("", "digest")
            .map_err(|error| anyhow::anyhow!("legacy image digest is invalid: {error}"))?;
        if legacy_manifest_digest(conn, &digest).await?.is_some() {
            report.already_migrated += 1;
            continue;
        }
        prepared.push(prepare_image(store, &image_id, &digest, platform)?);
    }
    if prepared.is_empty() {
        return Ok(report);
    }

    let transaction = sqlite::begin(conn).await?;
    ensure_repository(&transaction, LEGACY_REPOSITORY, now).await?;
    for image in &prepared {
        let layer_size = store.size(&image.legacy_digest)?;
        let layer = StoredObject {
            digest: image.legacy_digest.clone(),
            media_type: MEDIA_TYPE_EROFS.to_string(),
            size_bytes: layer_size,
            kind: ObjectKind::Erofs,
        };
        let config = StoredObject {
            digest: image.config_digest.clone(),
            media_type: MEDIA_TYPE_CONFIG.to_string(),
            size_bytes: image.config.size()?,
            kind: ObjectKind::Config,
        };
        let manifest = StoredObject {
            digest: image.manifest_digest.clone(),
            media_type: MEDIA_TYPE_MANIFEST.to_string(),
            size_bytes: image.manifest.size()?,
            kind: ObjectKind::Manifest,
        };
        for object in [&layer, &config, &manifest] {
            record_object(&transaction, object, now).await?;
        }
        record_reference(
            &transaction,
            &image.manifest_digest,
            &image.config_digest,
            "config",
            now,
        )
        .await?;
        record_reference(
            &transaction,
            &image.manifest_digest,
            &image.legacy_digest,
            "layer",
            now,
        )
        .await?;
        sqlite::execute(
            &transaction,
            "INSERT INTO catalog_legacy_images \
             (legacy_image_id, legacy_digest, manifest_digest, config_digest, platform, migrated_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
            vec![
                image.legacy_image_id.as_str().into(),
                image.legacy_digest.as_str().into(),
                image.manifest_digest.as_str().into(),
                image.config_digest.as_str().into(),
                image.platform.as_str().into(),
                now.into(),
            ],
        )
        .await?;
    }
    for row in &aliases {
        let alias: String = row
            .try_get("", "alias")
            .map_err(|error| anyhow::anyhow!("legacy alias is invalid: {error}"))?;
        let legacy_digest: String = row
            .try_get("", "image_digest")
            .map_err(|error| anyhow::anyhow!("legacy alias digest is invalid: {error}"))?;
        let Some(manifest_digest) = legacy_manifest_digest(&transaction, &legacy_digest).await?
        else {
            continue;
        };
        match tag::set_tag(
            &transaction,
            LEGACY_REPOSITORY,
            &alias,
            &manifest_digest,
            &TagExpectation::Absent,
            now,
        )
        .await
        {
            Ok(_) => {
                sqlite::execute(
                    &transaction,
                    "INSERT INTO catalog_legacy_tags (alias, manifest_digest) VALUES (?, ?) \
                     ON CONFLICT (alias) DO NOTHING",
                    vec![alias.as_str().into(), manifest_digest.as_str().into()],
                )
                .await?;
                report.created_alias_tags += 1;
            }
            Err(_) => {
                if tag::get_tag(&transaction, LEGACY_REPOSITORY, &alias).await?
                    == Some(manifest_digest)
                {
                    continue;
                }
                report.alias_conflicts += 1;
            }
        }
    }
    transaction
        .commit()
        .await
        .map_err(|error| anyhow::anyhow!("legacy migration commit failed: {error}"))?;
    report.migrated_images = u64::try_from(prepared.len()).unwrap_or(u64::MAX);
    Ok(report)
}

fn prepare_image(
    store: &BlobStore,
    legacy_image_id: &str,
    legacy_digest: &str,
    platform: &LegacyPlatform,
) -> Result<PreparedImage> {
    let layer_size = store
        .size(legacy_digest)
        .with_context(|| format!("legacy image {legacy_image_id} blob is missing"))?;
    store.verify_named_size(legacy_digest, layer_size)?;

    let config = ImageConfig {
        created: None,
        author: None,
        architecture: platform.architecture.clone(),
        os: platform.os.clone(),
        os_version: None,
        os_features: Some(vec!["erofs".to_string()]),
        variant: platform.variant.clone(),
        config: RuntimeConfig::default(),
        rootfs: RootFs {
            fs_type: "layers".to_string(),
            diff_ids: vec![legacy_digest.to_string()],
            extra: Map::new(),
        },
        history: Vec::new(),
        extra: Map::new(),
    };
    let config_bytes = to_bytes(&config)?;
    let config_document = RawDocument::from_bytes(config_bytes);

    let manifest = Manifest {
        schema_version: 2,
        media_type: Some(MEDIA_TYPE_MANIFEST.to_string()),
        config: Descriptor {
            media_type: MEDIA_TYPE_CONFIG.to_string(),
            digest: config_document.digest().to_string(),
            size: config_document.size()?,
            urls: None,
            annotations: None,
            platform: None,
            artifact_type: None,
            data: None,
            extra: Map::new(),
        },
        layers: vec![Descriptor {
            media_type: MEDIA_TYPE_EROFS.to_string(),
            digest: legacy_digest.to_string(),
            size: layer_size,
            urls: None,
            annotations: None,
            platform: None,
            artifact_type: None,
            data: None,
            extra: Map::new(),
        }],
        subject: None,
        artifact_type: None,
        annotations: Some(BTreeMap::new()),
        extra: Map::new(),
    };
    validate_manifest_config(&manifest, &config)?;
    let manifest_document = RawDocument::from_bytes(to_bytes(&manifest)?);
    store
        .put_bytes(config_document.bytes())
        .context("failed to publish the legacy Config")?;
    store
        .put_bytes(manifest_document.bytes())
        .context("failed to publish the legacy Manifest")?;
    Ok(PreparedImage {
        legacy_image_id: legacy_image_id.to_string(),
        legacy_digest: legacy_digest.to_string(),
        config_digest: config_document.digest().to_string(),
        manifest_digest: manifest_document.digest().to_string(),
        config: config_document,
        manifest: manifest_document,
        platform: platform.record(),
    })
}

/// The Manifest digest a historical EROFS digest maps to, if migrated.
pub async fn legacy_manifest_digest(
    conn: &impl sea_orm::ConnectionTrait,
    legacy_digest: &str,
) -> Result<Option<String>> {
    if !sqlite::table_exists(conn, "catalog_legacy_images").await? {
        return Ok(None);
    }
    let rows = sqlite::query_all(
        conn,
        "SELECT manifest_digest FROM catalog_legacy_images WHERE legacy_digest = ? LIMIT 1",
        vec![legacy_digest.into()],
    )
    .await?;
    match rows.first() {
        None => Ok(None),
        Some(row) => Ok(Some(row.try_get("", "manifest_digest").map_err(
            |error| anyhow::anyhow!("legacy mapping is invalid: {error}"),
        )?)),
    }
}

/// Undo the catalog-side migration while leaving legacy rows and EROFS bytes
/// untouched. Migrated objects become unreachable and are later reclaimed by
/// the normal GC grace.
pub async fn rollback_legacy_migration(conn: &DatabaseConnection) -> Result<LegacyRollbackReport> {
    if !sqlite::table_exists(conn, "catalog_legacy_images").await? {
        return Ok(LegacyRollbackReport::default());
    }
    let transaction = sqlite::begin(conn).await?;
    let mut report = LegacyRollbackReport::default();
    if sqlite::table_exists(&transaction, "catalog_legacy_tags").await? {
        let rows = sqlite::query_all(
            &transaction,
            "SELECT alias, manifest_digest FROM catalog_legacy_tags",
            Vec::new(),
        )
        .await?;
        for row in &rows {
            let alias: String = row
                .try_get("", "alias")
                .map_err(|error| anyhow::anyhow!("legacy tag is invalid: {error}"))?;
            let digest: String = row
                .try_get("", "manifest_digest")
                .map_err(|error| anyhow::anyhow!("legacy tag digest is invalid: {error}"))?;
            if tag::delete_tag_if_matches(&transaction, LEGACY_REPOSITORY, &alias, &digest).await? {
                report.removed_alias_tags += 1;
            }
        }
        sqlite::execute(&transaction, "DELETE FROM catalog_legacy_tags", Vec::new()).await?;
    }
    report.removed_mappings = sqlite::execute(
        &transaction,
        "DELETE FROM catalog_legacy_images",
        Vec::new(),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| anyhow::anyhow!("legacy rollback commit failed: {error}"))?;
    Ok(report)
}

/// Pin one migrated Manifest as a durable consumer root while an adapter still
/// holds a legacy reference.
pub async fn pin_migrated_image(
    conn: &impl sea_orm::ConnectionTrait,
    consumer_id: &str,
    manifest_digest: &str,
    now: i64,
) -> Result<String> {
    super::pin::pin(
        conn,
        ConsumerKind::Project,
        consumer_id,
        manifest_digest,
        now,
        None,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob::store::BlobStore;
    use crate::catalog::sqlite::tests::memory_connection;
    use crate::catalog::tag;
    use sea_orm::ConnectionTrait;
    use tempfile::tempdir;

    const LEGACY_TABLES: &[&str] = &[
        "CREATE TABLE images (
            image_id TEXT PRIMARY KEY, digest TEXT, size_bytes INTEGER NOT NULL,
            source_json TEXT NOT NULL, source_sha TEXT, packaging_json TEXT NOT NULL,
            status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )",
        "CREATE TABLE image_aliases (
            alias TEXT PRIMARY KEY, image_digest TEXT NOT NULL,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        )",
    ];

    async fn fixture() -> (tempfile::TempDir, BlobStore, DatabaseConnection, String) {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().join("store")).unwrap();
        let conn = memory_connection().await;
        sqlite::migrate(&conn).await.unwrap();
        for statement in LEGACY_TABLES {
            conn.execute_unprepared(statement).await.unwrap();
        }
        let layer = store.put_bytes(b"legacy erofs bytes").unwrap();
        sqlite::execute(
            &conn,
            "INSERT INTO images VALUES (?, ?, ?, '{}', NULL, '{}', 'ready', NULL, 1, 1)",
            vec!["img-1".into(), layer.digest.as_str().into(), 17_i64.into()],
        )
        .await
        .unwrap();
        sqlite::execute(
            &conn,
            "INSERT INTO image_aliases VALUES ('ubuntu', ?, 1, 1)",
            vec![layer.digest.as_str().into()],
        )
        .await
        .unwrap();
        (dir, store, conn, layer.digest)
    }

    #[tokio::test]
    async fn migration_preserves_bytes_aliases_and_is_idempotent() {
        let (_dir, store, conn, legacy_digest) = fixture().await;
        let report =
            migrate_legacy_images(&conn, &store, &LegacyPlatform::new("linux", "amd64"), 100)
                .await
                .unwrap();
        assert_eq!(report.migrated_images, 1);
        assert_eq!(report.created_alias_tags, 1);
        let manifest = legacy_manifest_digest(&conn, &legacy_digest)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            tag::get_tag(&conn, LEGACY_REPOSITORY, "ubuntu")
                .await
                .unwrap(),
            Some(manifest.clone())
        );
        assert!(store.contains(&legacy_digest).unwrap());
        assert_eq!(store.read(&legacy_digest).unwrap(), b"legacy erofs bytes");

        let second =
            migrate_legacy_images(&conn, &store, &LegacyPlatform::new("linux", "amd64"), 200)
                .await
                .unwrap();
        assert_eq!(second.migrated_images, 0);
        assert_eq!(second.already_migrated, 1);
        assert_eq!(
            legacy_manifest_digest(&conn, &legacy_digest).await.unwrap(),
            Some(manifest)
        );
    }

    #[tokio::test]
    async fn a_missing_legacy_blob_rolls_the_whole_migration_back() {
        let (_dir, store, conn, _legacy_digest) = fixture().await;
        sqlite::execute(
            &conn,
            "INSERT INTO images VALUES (?, ?, ?, '{}', NULL, '{}', 'ready', NULL, 1, 1)",
            vec![
                "img-2".into(),
                format!("sha256:{}", "f".repeat(64)).as_str().into(),
                17_i64.into(),
            ],
        )
        .await
        .unwrap();
        assert!(
            migrate_legacy_images(&conn, &store, &LegacyPlatform::new("linux", "amd64"), 100,)
                .await
                .is_err()
        );
        let rows = sqlite::query_all(
            &conn,
            "SELECT legacy_image_id FROM catalog_legacy_images",
            Vec::new(),
        )
        .await
        .unwrap();
        assert!(rows.is_empty(), "a failed migration records nothing");
    }

    #[tokio::test]
    async fn rollback_removes_mappings_and_alias_tags_but_keeps_legacy_rows() {
        let (_dir, store, conn, legacy_digest) = fixture().await;
        migrate_legacy_images(&conn, &store, &LegacyPlatform::new("linux", "amd64"), 100)
            .await
            .unwrap();
        let rollback = rollback_legacy_migration(&conn).await.unwrap();
        assert_eq!(rollback.removed_mappings, 1);
        assert_eq!(rollback.removed_alias_tags, 1);
        assert!(legacy_manifest_digest(&conn, &legacy_digest)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            tag::get_tag(&conn, LEGACY_REPOSITORY, "ubuntu")
                .await
                .unwrap(),
            None
        );
        let legacy = sqlite::query_all(&conn, "SELECT image_id FROM images", Vec::new())
            .await
            .unwrap();
        assert_eq!(legacy.len(), 1);
        assert!(store.contains(&legacy_digest).unwrap());
    }
}
