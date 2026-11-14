//! Atomic Manifest/Index publication over the CAS and catalog.

use anyhow::{Context, Result};
use sea_orm::DatabaseConnection;
use std::collections::HashMap;

use crate::blob::store::BlobStore;
use crate::catalog::reference::{record_object, record_reference, ObjectKind, StoredObject};
use crate::catalog::tag::{set_tag, TagExpectation};
use crate::oci::annotation::{MEDIA_TYPE_EROFS, MEDIA_TYPE_MANIFEST};
use crate::oci::descriptor::Descriptor;
use crate::oci::index::Index;
use crate::oci::manifest::Manifest;
use crate::oci::validation::{validate_index, validate_manifest_config};
use crate::oci::{parse_config, parse_index, parse_manifest, RawDocument};

/// One Manifest publication.
#[derive(Debug, Clone)]
pub struct ManifestPublication {
    pub repository: String,
    pub tag: String,
    pub expectation: TagExpectation,
    /// The existing or newly published raw EROFS layer descriptor.
    pub layer: Descriptor,
    /// Exact Config bytes.
    pub config: RawDocument,
    /// Exact Manifest bytes.
    pub manifest: RawDocument,
}

/// The result of one Manifest publication.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishOutcome {
    pub manifest_digest: String,
    pub config_digest: String,
    pub layer_digest: String,
    pub previous_tag_digest: Option<String>,
}

/// One platform entry of an Index publication.
#[derive(Debug, Clone)]
pub struct IndexEntry {
    pub manifest: RawDocument,
    pub config: RawDocument,
    pub layer: Descriptor,
}

/// One Index publication.
#[derive(Debug, Clone)]
pub struct IndexPublication {
    pub repository: String,
    pub tag: String,
    pub expectation: TagExpectation,
    pub index: RawDocument,
    pub entries: Vec<IndexEntry>,
}

/// The result of one Index publication.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexPublishOutcome {
    pub index_digest: String,
    pub manifest_digests: Vec<String>,
    pub previous_tag_digest: Option<String>,
}

/// Publish one Config+Manifest and move the Tag.
///
/// Steps are ordered: verify the layer Blob, publish exact Config bytes,
/// publish exact Manifest bytes, then record objects/edges and compare-and-swap
/// the Tag in one transaction. A failure leaves at most unreachable CAS bytes,
/// never a Tag pointing at an incomplete object.
pub async fn publish_manifest(
    conn: &DatabaseConnection,
    store: &BlobStore,
    publication: &ManifestPublication,
    now: i64,
) -> Result<PublishOutcome> {
    let (_, manifest) = parse_manifest(publication.manifest.bytes())
        .context("published Manifest bytes are invalid")?;
    let (_, config) =
        parse_config(publication.config.bytes()).context("published Config bytes are invalid")?;
    validate_manifest_config(&manifest, &config)?;
    publication
        .config
        .verify_against(&manifest.config)
        .context("Config bytes do not match the Manifest config descriptor")?;
    let manifest_layer = manifest
        .layers
        .first()
        .context("Manifest has no EROFS layer")?;
    if manifest_layer != &publication.layer {
        anyhow::bail!("layer descriptor does not match the published Manifest");
    }
    if manifest_layer.media_type != MEDIA_TYPE_EROFS {
        anyhow::bail!("layer media type must be {MEDIA_TYPE_EROFS}");
    }
    store
        .verify_named_size(&publication.layer.digest, publication.layer.size)
        .context("EROFS layer is not a verified CAS object")?;
    let config_blob = store.put_bytes(publication.config.bytes())?;
    if config_blob.digest != manifest.config.digest {
        anyhow::bail!("Config bytes do not publish under the Manifest config digest");
    }
    let manifest_blob = store.put_bytes(publication.manifest.bytes())?;
    if manifest_blob.digest != publication.manifest.digest() {
        anyhow::bail!("Manifest bytes do not publish under their own digest");
    }

    let transaction = crate::catalog::sqlite::begin(conn).await?;
    let layer_object = StoredObject {
        digest: publication.layer.digest.clone(),
        media_type: publication.layer.media_type.clone(),
        size_bytes: publication.layer.size,
        kind: ObjectKind::Erofs,
    };
    record_object(&transaction, &layer_object, now).await?;
    record_object(
        &transaction,
        &StoredObject {
            digest: manifest.config.digest.clone(),
            media_type: manifest.config.media_type.clone(),
            size_bytes: manifest.config.size,
            kind: ObjectKind::Config,
        },
        now,
    )
    .await?;
    record_object(
        &transaction,
        &StoredObject {
            digest: manifest_blob.digest.clone(),
            media_type: manifest
                .media_type
                .clone()
                .unwrap_or_else(|| MEDIA_TYPE_MANIFEST.to_string()),
            size_bytes: manifest_blob.size_bytes,
            kind: ObjectKind::Manifest,
        },
        now,
    )
    .await?;
    record_reference(
        &transaction,
        &manifest_blob.digest,
        &manifest.config.digest,
        "config",
        now,
    )
    .await?;
    record_reference(
        &transaction,
        &manifest_blob.digest,
        &publication.layer.digest,
        "layer",
        now,
    )
    .await?;
    if let Some(subject) = &manifest.subject {
        if store.contains(&subject.digest)? {
            record_reference(
                &transaction,
                &manifest_blob.digest,
                &subject.digest,
                "subject",
                now,
            )
            .await?;
        }
    }
    let tag_update = set_tag(
        &transaction,
        &publication.repository,
        &publication.tag,
        &manifest_blob.digest,
        &publication.expectation,
        now,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| anyhow::anyhow!("image publication commit failed: {error}"))?;
    Ok(PublishOutcome {
        manifest_digest: manifest_blob.digest,
        config_digest: config_blob.digest,
        layer_digest: publication.layer.digest.clone(),
        previous_tag_digest: tag_update.previous,
    })
}

/// Publish a multi-platform Index over already-described child Manifests.
pub async fn publish_index(
    conn: &DatabaseConnection,
    store: &BlobStore,
    publication: &IndexPublication,
    now: i64,
) -> Result<IndexPublishOutcome> {
    let (_, index): (RawDocument, Index) =
        parse_index(publication.index.bytes()).context("published Index bytes are invalid")?;
    validate_index(&index)?;
    if index.manifests.len() != publication.entries.len() {
        anyhow::bail!(
            "Index has {} child descriptors but {} entries were supplied",
            index.manifests.len(),
            publication.entries.len()
        );
    }
    let mut entries: HashMap<String, (&IndexEntry, Manifest)> = HashMap::new();
    for entry in &publication.entries {
        let (_, manifest) = parse_manifest(entry.manifest.bytes())
            .context("Index child Manifest bytes are invalid")?;
        let (_, config) =
            parse_config(entry.config.bytes()).context("Index child Config bytes are invalid")?;
        validate_manifest_config(&manifest, &config)?;
        entry
            .config
            .verify_against(&manifest.config)
            .context("Index child Config does not match its Manifest")?;
        let manifest_digest = entry.manifest.digest().to_string();
        if entries
            .insert(manifest_digest.clone(), (entry, manifest))
            .is_some()
        {
            anyhow::bail!("duplicate Index child Manifest {manifest_digest}");
        }
    }
    for descriptor in &index.manifests {
        let Some((entry, manifest)) = entries.get(&descriptor.digest) else {
            anyhow::bail!(
                "Index child {} has no supplied Manifest publication",
                descriptor.digest
            );
        };
        if descriptor.size != entry.manifest.size()? || descriptor.media_type != MEDIA_TYPE_MANIFEST
        {
            anyhow::bail!(
                "Index child {} descriptor does not match the supplied Manifest bytes",
                descriptor.digest
            );
        }
        let manifest_layer = manifest
            .layers
            .first()
            .context("Index child Manifest has no EROFS layer")?;
        if manifest_layer != &entry.layer {
            anyhow::bail!("Index child layer descriptor does not match its Manifest");
        }
        store
            .verify_named_size(&entry.layer.digest, entry.layer.size)
            .context("Index child EROFS layer is not a verified CAS object")?;
        store.put_bytes(entry.config.bytes())?;
        store.put_bytes(entry.manifest.bytes())?;
    }
    let index_blob = store.put_bytes(publication.index.bytes())?;
    if index_blob.digest != publication.index.digest() {
        anyhow::bail!("Index bytes do not publish under their own digest");
    }

    let transaction = crate::catalog::sqlite::begin(conn).await?;
    for descriptor in &index.manifests {
        let Some((entry, manifest)) = entries.get(&descriptor.digest) else {
            continue;
        };
        let layer_object = StoredObject {
            digest: entry.layer.digest.clone(),
            media_type: entry.layer.media_type.clone(),
            size_bytes: entry.layer.size,
            kind: ObjectKind::Erofs,
        };
        record_object(&transaction, &layer_object, now).await?;
        record_object(
            &transaction,
            &StoredObject {
                digest: manifest.config.digest.clone(),
                media_type: manifest.config.media_type.clone(),
                size_bytes: manifest.config.size,
                kind: ObjectKind::Config,
            },
            now,
        )
        .await?;
        record_object(
            &transaction,
            &StoredObject {
                digest: descriptor.digest.clone(),
                media_type: descriptor.media_type.clone(),
                size_bytes: descriptor.size,
                kind: ObjectKind::Manifest,
            },
            now,
        )
        .await?;
        record_reference(
            &transaction,
            &descriptor.digest,
            &manifest.config.digest,
            "config",
            now,
        )
        .await?;
        record_reference(
            &transaction,
            &descriptor.digest,
            &entry.layer.digest,
            "layer",
            now,
        )
        .await?;
        record_reference(
            &transaction,
            &index_blob.digest,
            &descriptor.digest,
            "index-child",
            now,
        )
        .await?;
    }
    record_object(
        &transaction,
        &StoredObject {
            digest: index_blob.digest.clone(),
            media_type: index
                .media_type
                .clone()
                .unwrap_or_else(|| crate::oci::MEDIA_TYPE_INDEX.to_string()),
            size_bytes: index_blob.size_bytes,
            kind: ObjectKind::Index,
        },
        now,
    )
    .await?;
    let tag_update = set_tag(
        &transaction,
        &publication.repository,
        &publication.tag,
        &index_blob.digest,
        &publication.expectation,
        now,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| anyhow::anyhow!("Index publication commit failed: {error}"))?;
    Ok(IndexPublishOutcome {
        index_digest: index_blob.digest,
        manifest_digests: index
            .manifests
            .iter()
            .map(|descriptor| descriptor.digest.clone())
            .collect(),
        previous_tag_digest: tag_update.previous,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::blob::store::BlobStore;
    use crate::catalog::sqlite::tests::memory_connection;
    use crate::catalog::tag;
    use crate::oci::annotation::{MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS};
    use crate::oci::config::{ImageConfig, RootFs, RuntimeConfig};
    use crate::oci::descriptor::Platform;
    use crate::oci::to_bytes;
    use serde_json::Map;
    use tempfile::tempdir;

    pub(crate) fn manifest_and_config(
        store: &BlobStore,
        layer: &Descriptor,
        architecture: &str,
        annotation: Option<(&str, &str)>,
        env: Option<&str>,
    ) -> (RawDocument, RawDocument) {
        let config = ImageConfig {
            created: None,
            author: None,
            architecture: architecture.to_string(),
            os: "linux".to_string(),
            os_version: None,
            os_features: Some(vec!["erofs".to_string()]),
            variant: None,
            config: RuntimeConfig {
                env: env.map(|value| vec![value.to_string()]),
                ..RuntimeConfig::default()
            },
            rootfs: RootFs {
                fs_type: "layers".to_string(),
                diff_ids: vec![layer.digest.clone()],
                extra: Map::new(),
            },
            history: Vec::new(),
            extra: Map::new(),
        };
        let config_document = RawDocument::from_bytes(to_bytes(&config).unwrap());
        store.put_bytes(config_document.bytes()).unwrap();
        let mut annotations = std::collections::BTreeMap::new();
        if let Some((key, value)) = annotation {
            annotations.insert(key.to_string(), value.to_string());
        }
        let manifest = Manifest {
            schema_version: 2,
            media_type: Some(MEDIA_TYPE_MANIFEST.to_string()),
            config: Descriptor {
                media_type: MEDIA_TYPE_CONFIG.to_string(),
                digest: config_document.digest().to_string(),
                size: config_document.size().unwrap(),
                urls: None,
                annotations: None,
                platform: None,
                artifact_type: None,
                data: None,
                extra: Map::new(),
            },
            layers: vec![layer.clone()],
            subject: None,
            artifact_type: None,
            annotations: (!annotations.is_empty()).then_some(annotations),
            extra: Map::new(),
        };
        let manifest_document = RawDocument::from_bytes(to_bytes(&manifest).unwrap());
        store.put_bytes(manifest_document.bytes()).unwrap();
        (manifest_document, config_document)
    }

    pub(crate) fn layer(store: &BlobStore, bytes: &[u8]) -> Descriptor {
        let stored = store.put_bytes(bytes).unwrap();
        Descriptor {
            media_type: MEDIA_TYPE_EROFS.to_string(),
            digest: stored.digest,
            size: stored.size_bytes,
            urls: None,
            annotations: None,
            platform: None,
            artifact_type: None,
            data: None,
            extra: Map::new(),
        }
    }

    #[tokio::test]
    async fn two_manifests_can_share_one_physical_erofs_blob() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().join("store")).unwrap();
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        let layer = layer(&store, b"one shared erofs payload");
        let (manifest_a, config_a) = manifest_and_config(
            &store,
            &layer,
            "amd64",
            Some(("io.nession.kind", "tool")),
            Some("A=1"),
        );
        let (manifest_b, config_b) =
            manifest_and_config(&store, &layer, "amd64", None, Some("A=2"));
        let first = publish_manifest(
            &conn,
            &store,
            &ManifestPublication {
                repository: "nession/tools".to_string(),
                tag: "a".to_string(),
                expectation: TagExpectation::Absent,
                layer: layer.clone(),
                config: config_a,
                manifest: manifest_a,
            },
            1,
        )
        .await
        .unwrap();
        let second = publish_manifest(
            &conn,
            &store,
            &ManifestPublication {
                repository: "nession/tools".to_string(),
                tag: "b".to_string(),
                expectation: TagExpectation::Absent,
                layer: layer.clone(),
                config: config_b,
                manifest: manifest_b,
            },
            2,
        )
        .await
        .unwrap();
        assert_ne!(first.manifest_digest, second.manifest_digest);
        assert_eq!(first.layer_digest, second.layer_digest);
        assert_eq!(
            store.usage().unwrap().blobs,
            5,
            "one shared EROFS blob plus two Configs and two Manifests"
        );
        assert_eq!(
            tag::get_tag(&conn, "nession/tools", "a").await.unwrap(),
            Some(first.manifest_digest)
        );
        assert_eq!(
            tag::get_tag(&conn, "nession/tools", "b").await.unwrap(),
            Some(second.manifest_digest)
        );
    }

    #[tokio::test]
    async fn manifest_identities_and_one_physical_blob_survive_reopen() {
        let dir = tempdir().unwrap();
        let store_path = dir.path().join("store");
        let database_path = dir.path().join("catalog.db");
        let store = BlobStore::new(&store_path).unwrap();
        let conn = crate::catalog::sqlite::tests::file_connection(&database_path).await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        let layer = layer(&store, b"one physical EROFS");
        let (manifest_a, config_a) = manifest_and_config(
            &store,
            &layer,
            "amd64",
            Some(("io.nession.kind", "tool")),
            Some("A=1"),
        );
        let (manifest_b, config_b) =
            manifest_and_config(&store, &layer, "amd64", None, Some("A=2"));
        let first = publish_manifest(
            &conn,
            &store,
            &ManifestPublication {
                repository: "nession/reopen".to_string(),
                tag: "a".to_string(),
                expectation: TagExpectation::Absent,
                layer: layer.clone(),
                config: config_a,
                manifest: manifest_a.clone(),
            },
            1,
        )
        .await
        .unwrap();
        let second = publish_manifest(
            &conn,
            &store,
            &ManifestPublication {
                repository: "nession/reopen".to_string(),
                tag: "b".to_string(),
                expectation: TagExpectation::Absent,
                layer: layer.clone(),
                config: config_b,
                manifest: manifest_b,
            },
            2,
        )
        .await
        .unwrap();
        assert_ne!(first.config_digest, second.config_digest);
        drop(conn);

        let conn = crate::catalog::sqlite::tests::file_connection(&database_path).await;
        let store = BlobStore::new(&store_path).unwrap();
        assert_eq!(
            tag::get_tag(&conn, "nession/reopen", "a").await.unwrap(),
            Some(first.manifest_digest.clone())
        );
        assert_eq!(
            tag::get_tag(&conn, "nession/reopen", "b").await.unwrap(),
            Some(second.manifest_digest.clone())
        );
        let inspection =
            crate::image::inspect::inspect_manifest(&store, &first.manifest_digest).unwrap();
        assert_eq!(inspection.layer_digest, layer.digest);
        assert_eq!(inspection.config.env(), &["A=1".to_string()]);
        assert_eq!(
            store.read(&layer.digest).unwrap(),
            b"one physical EROFS",
            "the shared EROFS bytes were never rewritten"
        );
    }

    #[tokio::test]
    async fn a_conflicting_tag_move_fails_and_keeps_the_old_resolution() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().join("store")).unwrap();
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        let layer = layer(&store, b"layer");
        let (manifest_a, config_a) = manifest_and_config(&store, &layer, "amd64", None, None);
        let first = publish_manifest(
            &conn,
            &store,
            &ManifestPublication {
                repository: "nession/tools".to_string(),
                tag: "latest".to_string(),
                expectation: TagExpectation::Absent,
                layer: layer.clone(),
                config: config_a,
                manifest: manifest_a,
            },
            1,
        )
        .await
        .unwrap();
        let (manifest_b, config_b) =
            manifest_and_config(&store, &layer, "amd64", Some(("x", "y")), None);
        let wrong_expected =
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        assert!(publish_manifest(
            &conn,
            &store,
            &ManifestPublication {
                repository: "nession/tools".to_string(),
                tag: "latest".to_string(),
                expectation: TagExpectation::Exact(wrong_expected.to_string()),
                layer,
                config: config_b,
                manifest: manifest_b,
            },
            2,
        )
        .await
        .is_err());
        assert_eq!(
            tag::get_tag(&conn, "nession/tools", "latest")
                .await
                .unwrap(),
            Some(first.manifest_digest)
        );
    }

    fn platform_index_entry(store: &BlobStore, architecture: &str, payload: &[u8]) -> IndexEntry {
        let layer = layer(store, payload);
        let (manifest, config) = manifest_and_config(store, &layer, architecture, None, None);
        IndexEntry {
            manifest,
            config,
            layer,
        }
    }

    #[tokio::test]
    async fn an_index_publishes_platform_children_and_selects_exactly() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().join("store")).unwrap();
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        let amd64 = platform_index_entry(&store, "amd64", b"amd64 payload");
        let arm64 = platform_index_entry(&store, "arm64", b"arm64 payload");
        let index = Index {
            schema_version: 2,
            media_type: Some(crate::oci::MEDIA_TYPE_INDEX.to_string()),
            manifests: vec![
                Descriptor {
                    media_type: MEDIA_TYPE_MANIFEST.to_string(),
                    digest: amd64.manifest.digest().to_string(),
                    size: amd64.manifest.size().unwrap(),
                    urls: None,
                    annotations: None,
                    platform: Some(Platform {
                        architecture: "amd64".to_string(),
                        os: "linux".to_string(),
                        os_features: Some(vec!["erofs".to_string()]),
                        ..Platform::default()
                    }),
                    artifact_type: None,
                    data: None,
                    extra: Map::new(),
                },
                Descriptor {
                    media_type: MEDIA_TYPE_MANIFEST.to_string(),
                    digest: arm64.manifest.digest().to_string(),
                    size: arm64.manifest.size().unwrap(),
                    urls: None,
                    annotations: None,
                    platform: Some(Platform {
                        architecture: "arm64".to_string(),
                        os: "linux".to_string(),
                        os_features: Some(vec!["erofs".to_string()]),
                        ..Platform::default()
                    }),
                    artifact_type: None,
                    data: None,
                    extra: Map::new(),
                },
            ],
            annotations: None,
            extra: Map::new(),
        };
        let index_document = RawDocument::from_bytes(to_bytes(&index).unwrap());
        let outcome = publish_index(
            &conn,
            &store,
            &IndexPublication {
                repository: "nession/base".to_string(),
                tag: "v1".to_string(),
                expectation: TagExpectation::Absent,
                index: index_document,
                entries: vec![amd64, arm64],
            },
            1,
        )
        .await
        .unwrap();
        assert_eq!(outcome.manifest_digests.len(), 2);
        assert_eq!(
            tag::get_tag(&conn, "nession/base", "v1").await.unwrap(),
            Some(outcome.index_digest)
        );
    }
}
