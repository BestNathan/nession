//! Resolve mutable Tags and immutable digests to catalog objects.
//!
//! # Manifest-aware resolution (#3499)
//!
//! A Repository/Tag (or immutable digest) resolves to one **pinned** Manifest
//! for a requesting platform. An Index is read, validated and platform-selected
//! deterministically; a direct Manifest is checked against the same platform.
//! The parsed Config and EROFS layer descriptor are retained, and every object
//! in the chain is verified against both its catalog descriptor and its CAS
//! bytes before it is returned. A Tag never reaches runtime unresolved.

use anyhow::{Context, Result};
use sea_orm::ConnectionTrait;

use crate::blob::store::BlobStore;
use crate::catalog::legacy::legacy_manifest_digest;
use crate::catalog::reference::{get_object, ObjectKind, StoredObject};
use crate::catalog::tag;
use crate::oci::annotation::NessionUsage;
use crate::oci::config::ImageConfig;
use crate::oci::descriptor::{Descriptor, Platform};
use crate::oci::manifest::Manifest;
use crate::oci::{parse_config, parse_manifest};

/// A Tag or digest resolved to one immutable catalog object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedImage {
    pub digest: String,
    pub kind: ObjectKind,
    pub size_bytes: u64,
}

impl From<StoredObject> for ResolvedImage {
    fn from(object: StoredObject) -> Self {
        Self {
            digest: object.digest,
            kind: object.kind,
            size_bytes: object.size_bytes,
        }
    }
}

/// The catalog root a reference names before any blob is read.
///
/// This is the authorization fence: an adapter can prove a consumer reaches
/// this digest through the catalog graph before it reads any bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedRoot {
    pub digest: String,
    pub kind: ObjectKind,
}

/// The verified referenced Composite closure of one Manifest (#3697).
#[derive(Debug, Clone)]
pub struct ResolvedComposite {
    pub descriptor: crate::oci::composite::CompositeDescriptor,
    /// The Manifest layer descriptor naming the descriptor JSON.
    pub descriptor_object: Descriptor,
    /// The primary metadata EROFS device.
    pub metadata: Descriptor,
    /// Ordered backing EROFS devices.
    pub devices: Vec<Descriptor>,
}

/// One fully verified image identity pinned to a Manifest.
#[derive(Debug, Clone)]
pub struct ResolvedTarget {
    /// Present when a Tag/digest named an Index.
    pub index_digest: Option<String>,
    /// The immutable image revision.
    pub manifest_digest: String,
    /// The Config descriptor identity.
    pub config_digest: String,
    /// The single raw EROFS layer (the physical data identity).
    pub layer: Descriptor,
    pub manifest: Manifest,
    pub config: ImageConfig,
    pub usage: NessionUsage,
    /// Present when the Manifest is a referenced Composite Image.
    pub composite: Option<ResolvedComposite>,
}

/// Resolve a Tag only when it names a Manifest or Index.
///
/// A tag that exists but points at a missing or non-image object is a broken
/// reference and fails instead of returning a partial identity.
pub async fn resolve_tag(
    conn: &impl ConnectionTrait,
    repository: &str,
    tag_name: &str,
) -> Result<Option<ResolvedImage>> {
    let Some(digest) = tag::get_tag(conn, repository, tag_name).await? else {
        return Ok(None);
    };
    let object = get_object(conn, &digest).await?;
    let Some(object) = object else {
        anyhow::bail!("tag {repository}:{tag_name} points at missing object {digest}");
    };
    if !matches!(object.kind, ObjectKind::Manifest | ObjectKind::Index) {
        anyhow::bail!(
            "tag {repository}:{tag_name} points at a {:?}, not a Manifest or Index",
            object.kind
        );
    }
    Ok(Some(object.into()))
}

/// Resolve an immutable digest to its catalog object.
pub async fn resolve_digest(
    conn: &impl ConnectionTrait,
    digest: &str,
) -> Result<Option<ResolvedImage>> {
    Ok(get_object(conn, digest).await?.map(ResolvedImage::from))
}

/// Resolve a historical EROFS digest to the migrated Manifest digest.
pub async fn resolve_legacy_digest(
    conn: &impl ConnectionTrait,
    legacy_digest: &str,
) -> Result<Option<String>> {
    crate::catalog::legacy::legacy_manifest_digest(conn, legacy_digest).await
}

/// Resolve a reference to the catalog root it names, without reading bytes.
///
/// A Tag that does not exist is an error, not an empty result: the runtime
/// must never start from an unresolved Tag. A historical EROFS digest is
/// mapped through #3496's legacy manifest record.
pub async fn resolve_root(
    conn: &impl ConnectionTrait,
    repository: Option<&str>,
    reference: &str,
) -> Result<ResolvedRoot> {
    let object = if crate::digest::is_valid_digest(reference) {
        match get_object(conn, reference).await? {
            // A manifest/index digest is already the image identity.
            Some(object) if matches!(object.kind, ObjectKind::Manifest | ObjectKind::Index) => {
                object
            }
            // An EROFS/Config digest is a physical descriptor, not an image
            // revision. A migrated legacy pin resolves to its Manifest.
            other => {
                let Some(migrated) = legacy_manifest_digest(conn, reference).await? else {
                    if let Some(object) = other {
                        anyhow::bail!(
                            "image reference {reference} resolves to a {:?}, not a Manifest or Index",
                            object.kind
                        );
                    }
                    anyhow::bail!("image digest {reference} is not in the catalog");
                };
                get_object(conn, &migrated)
                    .await?
                    .context("legacy migration names a Manifest that is missing from the catalog")?
            }
        }
    } else {
        let repository = repository.context(
            "a Tag reference requires a Repository; a bare reference is not an image identity",
        )?;
        let Some(resolved) = resolve_tag(conn, repository, reference).await? else {
            anyhow::bail!("tag {repository}:{reference} does not exist");
        };
        StoredObject {
            digest: resolved.digest,
            media_type: media_type_for(resolved.kind),
            size_bytes: resolved.size_bytes,
            kind: resolved.kind,
        }
    };
    if !matches!(object.kind, ObjectKind::Manifest | ObjectKind::Index) {
        anyhow::bail!(
            "image reference {reference} resolves to a {:?}, not a Manifest or Index",
            object.kind
        );
    }
    Ok(ResolvedRoot {
        digest: object.digest,
        kind: object.kind,
    })
}

/// Resolve one catalog root to a pinned Manifest for `target`.
///
/// Reads Index/Manifest/Config bytes only after the root is known. Every
/// descriptor must exist in the catalog with the same kind and size, and its
/// CAS bytes must hash to the descriptor digest. A missing/stale descriptor,
/// an incompatible platform and an ambiguous Index all fail closed.
pub async fn resolve_root_for_platform(
    conn: &impl ConnectionTrait,
    store: &BlobStore,
    root: &ResolvedRoot,
    target: &Platform,
) -> Result<ResolvedTarget> {
    let manifest_digest = match root.kind {
        ObjectKind::Index => {
            let inspection = crate::image::inspect::inspect_index(store, &root.digest, target)?;
            let object = verified_object(conn, store, &root.digest, ObjectKind::Index).await?;
            if inspection.index_digest != object.digest {
                anyhow::bail!("Index {} identity changed during resolution", root.digest);
            }
            let selected = inspection.selected;
            let manifest =
                verified_object(conn, store, &selected.digest, ObjectKind::Manifest).await?;
            if manifest.media_type != selected.media_type || manifest.size_bytes != selected.size {
                anyhow::bail!(
                    "Index child {} descriptor is stale in the catalog",
                    selected.digest
                );
            }
            selected.digest
        }
        ObjectKind::Manifest => {
            verified_object(conn, store, &root.digest, ObjectKind::Manifest).await?;
            root.digest.clone()
        }
        _ => anyhow::bail!("image root {} is not a Manifest or Index", root.digest),
    };

    let manifest_object =
        verified_object(conn, store, &manifest_digest, ObjectKind::Manifest).await?;
    let manifest_bytes = store.read(&manifest_digest)?;
    let (manifest_document, manifest) = parse_manifest(&manifest_bytes)?;
    if manifest_document.digest() != manifest_digest
        || manifest_document.size()? != manifest_object.size_bytes
    {
        anyhow::bail!("Manifest {manifest_digest} bytes do not match the catalog descriptor");
    }
    let config_object =
        verified_object(conn, store, &manifest.config.digest, ObjectKind::Config).await?;
    if config_object.size_bytes != manifest.config.size
        || config_object.media_type != manifest.config.media_type
    {
        anyhow::bail!(
            "Config {} descriptor is stale in the catalog",
            manifest.config.digest
        );
    }
    let config_bytes = store.read(&manifest.config.digest)?;
    let (config_document, config) = parse_config(&config_bytes)?;
    if config_document.digest() != manifest.config.digest
        || config_document.size()? != manifest.config.size
    {
        anyhow::bail!(
            "Config {} bytes do not match the Manifest descriptor",
            manifest.config.digest
        );
    }
    let layer = manifest
        .layers
        .first()
        .context("resolved Manifest has no layer")?
        .clone();
    if layer.media_type == crate::oci::MEDIA_TYPE_COMPOSITE {
        let composite_object =
            verified_object(conn, store, &layer.digest, ObjectKind::Composite).await?;
        if composite_object.media_type != layer.media_type
            || composite_object.size_bytes != layer.size
        {
            anyhow::bail!(
                "Composite descriptor {} is stale in the catalog",
                layer.digest
            );
        }
        let bytes = store.read(&layer.digest)?;
        if crate::digest::digest_of_bytes(&bytes) != layer.digest {
            anyhow::bail!("Composite descriptor bytes do not match their digest");
        }
        let composite = crate::oci::composite::parse_composite(&bytes)?;
        let mut closure = Vec::new();
        for descriptor in composite.closure()? {
            let object =
                verified_object(conn, store, &descriptor.digest, ObjectKind::Erofs).await?;
            if object.media_type != descriptor.media_type || object.size_bytes != descriptor.size {
                anyhow::bail!(
                    "Composite device {} is stale in the catalog",
                    descriptor.digest
                );
            }
            closure.push(descriptor);
        }
        crate::oci::composite::validate_composite_manifest_config(
            &manifest, &config, &composite, &layer,
        )?;
        let platform = Platform {
            architecture: config.architecture.clone(),
            os: config.os.clone(),
            os_version: config.os_version.clone(),
            os_features: config.os_features.clone(),
            variant: config.variant.clone(),
            ..Platform::default()
        };
        if !platform.matches(target) {
            anyhow::bail!(
                "image {manifest_digest} targets {}/{} variant {:?}, not the requesting {}/{} variant {:?}",
                platform.os,
                platform.architecture,
                platform.variant,
                target.os,
                target.architecture,
                target.variant
            );
        }
        let usage = NessionUsage::from_annotations(manifest.annotations.as_ref())?;
        let metadata = closure
            .first()
            .cloned()
            .context("Composite closure has no metadata device")?;
        return Ok(ResolvedTarget {
            index_digest: (root.kind == ObjectKind::Index).then(|| root.digest.clone()),
            manifest_digest,
            config_digest: manifest.config.digest.clone(),
            layer: metadata.clone(),
            manifest,
            config,
            usage,
            composite: Some(ResolvedComposite {
                descriptor: composite,
                descriptor_object: layer,
                metadata,
                devices: closure.into_iter().skip(1).collect(),
            }),
        });
    }
    let layer_object = verified_object(conn, store, &layer.digest, ObjectKind::Erofs).await?;
    if layer_object.size_bytes != layer.size || layer_object.media_type != layer.media_type {
        anyhow::bail!(
            "EROFS layer {} descriptor is stale in the catalog",
            layer.digest
        );
    }
    crate::oci::validation::validate_manifest_config(&manifest, &config)?;
    let platform = Platform {
        architecture: config.architecture.clone(),
        os: config.os.clone(),
        os_version: config.os_version.clone(),
        os_features: config.os_features.clone(),
        variant: config.variant.clone(),
        ..Platform::default()
    };
    if !platform.matches(target) {
        anyhow::bail!(
            "image {manifest_digest} targets {}/{} variant {:?}, not the requesting {}/{} variant {:?}",
            platform.os,
            platform.architecture,
            platform.variant,
            target.os,
            target.architecture,
            target.variant
        );
    }
    let usage = NessionUsage::from_annotations(manifest.annotations.as_ref())?;
    Ok(ResolvedTarget {
        index_digest: (root.kind == ObjectKind::Index).then(|| root.digest.clone()),
        manifest_digest,
        config_digest: manifest.config.digest.clone(),
        layer,
        manifest,
        config,
        usage,
        composite: None,
    })
}

/// Resolve a Repository Tag or immutable digest for one requesting platform.
///
/// This is the public adapter entry point: a Tag is resolved to a root first,
/// then to one verified Manifest. There is no path that returns an unresolved
/// Tag or an unverified descriptor.
pub async fn resolve_for_platform(
    conn: &impl ConnectionTrait,
    store: &BlobStore,
    repository: Option<&str>,
    reference: &str,
    target: &Platform,
) -> Result<ResolvedTarget> {
    let root = resolve_root(conn, repository, reference).await?;
    resolve_root_for_platform(conn, store, &root, target).await
}

async fn verified_object(
    conn: &impl ConnectionTrait,
    store: &BlobStore,
    digest: &str,
    expected: ObjectKind,
) -> Result<StoredObject> {
    let object = get_object(conn, digest)
        .await?
        .with_context(|| format!("{expected:?} {digest} is missing from the catalog"))?;
    if object.kind != expected {
        anyhow::bail!(
            "object {digest} is recorded as {:?}, expected {expected:?}",
            object.kind
        );
    }
    store
        .verify_named_size(digest, object.size_bytes)
        .with_context(|| format!("{expected:?} {digest} bytes are missing or stale"))?;
    Ok(object)
}

fn media_type_for(kind: ObjectKind) -> String {
    match kind {
        ObjectKind::Index => crate::oci::MEDIA_TYPE_INDEX.to_string(),
        ObjectKind::Manifest => crate::oci::MEDIA_TYPE_MANIFEST.to_string(),
        ObjectKind::Config => crate::oci::MEDIA_TYPE_CONFIG.to_string(),
        ObjectKind::Erofs => crate::oci::MEDIA_TYPE_EROFS.to_string(),
        ObjectKind::Composite => crate::oci::MEDIA_TYPE_COMPOSITE.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::sqlite::tests::memory_connection;
    use crate::catalog::tag::TagExpectation;
    use crate::image::publish::tests::{layer, manifest_and_config};
    use crate::image::publish::{
        publish_index, publish_manifest, IndexEntry, IndexPublication, ManifestPublication,
    };
    use crate::oci::descriptor::Platform;
    use crate::oci::{to_bytes, Index, RawDocument};
    use serde_json::Map;
    use tempfile::tempdir;

    fn target(architecture: &str) -> Platform {
        Platform::for_consumer("linux", architecture, None)
    }

    async fn fixture() -> (
        tempfile::TempDir,
        BlobStore,
        sea_orm::DatabaseConnection,
        Descriptor,
        RawDocument,
        RawDocument,
    ) {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().join("store")).unwrap();
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        let layer = layer(&store, b"verified erofs bytes");
        let (manifest, config) = manifest_and_config(&store, &layer, "amd64", None, None);
        (dir, store, conn, layer, manifest, config)
    }

    #[tokio::test]
    async fn a_tag_resolves_to_the_platform_manifest_with_verified_descriptors() {
        let (_dir, store, conn, layer, manifest, config) = fixture().await;
        let published = publish_manifest(
            &conn,
            &store,
            &ManifestPublication {
                repository: "nession/base".to_string(),
                tag: "v1".to_string(),
                expectation: TagExpectation::Absent,
                layer: layer.clone(),
                config,
                manifest: manifest.clone(),
            },
            1,
        )
        .await
        .unwrap();
        let resolved =
            resolve_for_platform(&conn, &store, Some("nession/base"), "v1", &target("amd64"))
                .await
                .unwrap();
        assert_eq!(resolved.manifest_digest, published.manifest_digest);
        assert_eq!(resolved.config_digest, published.config_digest);
        assert_eq!(resolved.layer.digest, layer.digest);
        assert_eq!(resolved.index_digest, None);
        assert!(resolved.config.supports_erofs());
    }

    #[tokio::test]
    async fn an_incompatible_platform_fails_before_any_mount_could_be_attempted() {
        let (_dir, store, conn, layer, manifest, config) = fixture().await;
        publish_manifest(
            &conn,
            &store,
            &ManifestPublication {
                repository: "nession/base".to_string(),
                tag: "v1".to_string(),
                expectation: TagExpectation::Absent,
                layer,
                config,
                manifest,
            },
            1,
        )
        .await
        .unwrap();
        let error =
            resolve_for_platform(&conn, &store, Some("nession/base"), "v1", &target("arm64"))
                .await
                .unwrap_err()
                .to_string();
        assert!(error.contains("targets linux/amd64"), "{error}");
    }

    fn index_entry(store: &BlobStore, architecture: &str, payload: &[u8]) -> IndexEntry {
        let layer = layer(store, payload);
        let (manifest, config) = manifest_and_config(store, &layer, architecture, None, None);
        IndexEntry {
            manifest,
            config,
            layer,
        }
    }

    fn index_document(entries: &[IndexEntry], architectures: &[&str]) -> RawDocument {
        let index = Index {
            schema_version: 2,
            media_type: Some(crate::oci::MEDIA_TYPE_INDEX.to_string()),
            manifests: entries
                .iter()
                .zip(architectures)
                .map(|(entry, architecture)| Descriptor {
                    media_type: crate::oci::MEDIA_TYPE_MANIFEST.to_string(),
                    digest: entry.manifest.digest().to_string(),
                    size: entry.manifest.size().unwrap(),
                    urls: None,
                    annotations: None,
                    platform: Some(target(architecture)),
                    artifact_type: None,
                    data: None,
                    extra: Map::new(),
                })
                .collect(),
            annotations: None,
            extra: Map::new(),
        };
        RawDocument::from_bytes(to_bytes(&index).unwrap())
    }

    #[tokio::test]
    async fn an_index_selects_only_the_compatible_platform_manifest() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().join("store")).unwrap();
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        let amd64 = index_entry(&store, "amd64", b"amd64 payload");
        let arm64 = index_entry(&store, "arm64", b"arm64 payload");
        let entries = vec![amd64, arm64];
        let index = index_document(&entries, &["amd64", "arm64"]);
        let published = publish_index(
            &conn,
            &store,
            &IndexPublication {
                repository: "nession/base".to_string(),
                tag: "multi".to_string(),
                expectation: TagExpectation::Absent,
                index,
                entries,
            },
            1,
        )
        .await
        .unwrap();
        let resolved = resolve_for_platform(
            &conn,
            &store,
            Some("nession/base"),
            "multi",
            &target("amd64"),
        )
        .await
        .unwrap();
        assert_eq!(
            resolved.index_digest.as_deref(),
            Some(published.index_digest.as_str())
        );
        assert_eq!(resolved.manifest_digest, published.manifest_digests[0]);

        let error = resolve_for_platform(
            &conn,
            &store,
            Some("nession/base"),
            "multi",
            &target("riscv64"),
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(error.contains("no manifest for linux/riscv64"), "{error}");
    }

    #[tokio::test]
    async fn an_ambiguous_index_fails_closed() {
        use crate::catalog::reference::{
            record_object, record_reference, ObjectKind, StoredObject,
        };

        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().join("store")).unwrap();
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        let first = index_entry(&store, "amd64", b"first payload");
        let second = index_entry(&store, "amd64", b"second payload");
        for entry in [&first, &second] {
            store.put_bytes(entry.manifest.bytes()).unwrap();
            store.put_bytes(entry.config.bytes()).unwrap();
            record_object(
                &conn,
                &StoredObject {
                    digest: entry.manifest.digest().to_string(),
                    media_type: crate::oci::MEDIA_TYPE_MANIFEST.to_string(),
                    size_bytes: entry.manifest.size().unwrap(),
                    kind: ObjectKind::Manifest,
                },
                1,
            )
            .await
            .unwrap();
            record_object(
                &conn,
                &StoredObject {
                    digest: entry.layer.digest.clone(),
                    media_type: crate::oci::MEDIA_TYPE_EROFS.to_string(),
                    size_bytes: entry.layer.size,
                    kind: ObjectKind::Erofs,
                },
                1,
            )
            .await
            .unwrap();
        }
        let entries = vec![first, second];
        let index = index_document(&entries, &["amd64", "amd64"]);
        let stored = store.put_bytes(index.bytes()).unwrap();
        record_object(
            &conn,
            &StoredObject {
                digest: stored.digest.clone(),
                media_type: crate::oci::MEDIA_TYPE_INDEX.to_string(),
                size_bytes: stored.size_bytes,
                kind: ObjectKind::Index,
            },
            1,
        )
        .await
        .unwrap();
        for entry in &entries {
            record_reference(
                &conn,
                &stored.digest,
                entry.manifest.digest(),
                "index-child",
                1,
            )
            .await
            .unwrap();
        }
        crate::catalog::tag::set_tag(
            &conn,
            "nession/base",
            "ambiguous",
            &stored.digest,
            &TagExpectation::Absent,
            1,
        )
        .await
        .unwrap();
        let error = resolve_for_platform(
            &conn,
            &store,
            Some("nession/base"),
            "ambiguous",
            &target("amd64"),
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(error.contains("ambiguous OCI index"), "{error}");
    }

    #[tokio::test]
    async fn a_missing_tag_is_an_error_and_a_stale_descriptor_fails_closed() {
        let (_dir, store, conn, layer, manifest, config) = fixture().await;
        assert!(resolve_root(&conn, Some("nession/base"), "missing")
            .await
            .is_err());
        let published = publish_manifest(
            &conn,
            &store,
            &ManifestPublication {
                repository: "nession/base".to_string(),
                tag: "v1".to_string(),
                expectation: TagExpectation::Absent,
                layer,
                config,
                manifest,
            },
            1,
        )
        .await
        .unwrap();
        std::fs::remove_file(store.path_for(&published.manifest_digest).unwrap()).unwrap();
        let error =
            resolve_for_platform(&conn, &store, Some("nession/base"), "v1", &target("amd64"))
                .await
                .unwrap_err()
                .to_string();
        assert!(error.contains("missing or stale"), "{error}");
    }

    #[tokio::test]
    async fn a_legacy_digest_resolves_through_the_migrated_manifest() {
        let (_dir, store, conn, layer, manifest, config) = fixture().await;
        let published = publish_manifest(
            &conn,
            &store,
            &ManifestPublication {
                repository: "legacy".to_string(),
                tag: "alias".to_string(),
                expectation: TagExpectation::Absent,
                layer: layer.clone(),
                config,
                manifest,
            },
            1,
        )
        .await
        .unwrap();
        crate::catalog::sqlite::execute(
            &conn,
            "INSERT INTO catalog_legacy_images \
             (legacy_image_id, legacy_digest, manifest_digest, config_digest, platform, migrated_at) \
             VALUES ('legacy-1', ?, ?, ?, 'linux/amd64', 1)",
            vec![
                layer.digest.as_str().into(),
                published.manifest_digest.as_str().into(),
                published.config_digest.as_str().into(),
            ],
        )
        .await
        .unwrap();
        let resolved = resolve_for_platform(&conn, &store, None, &layer.digest, &target("amd64"))
            .await
            .unwrap();
        assert_eq!(resolved.manifest_digest, published.manifest_digest);
        assert_eq!(resolved.layer.digest, layer.digest);
    }

    #[tokio::test]
    async fn a_broken_tag_fails_closed() {
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        assert!(resolve_root(&conn, Some("nession/base"), "missing")
            .await
            .is_err());
        crate::catalog::sqlite::execute(
            &conn,
            "INSERT INTO catalog_tags VALUES ('nession/base', 'broken', ?, 1)",
            vec!["sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into()],
        )
        .await
        .unwrap();
        assert!(resolve_root(&conn, Some("nession/base"), "broken")
            .await
            .is_err());
    }
}
