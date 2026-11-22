//! Build a standard OCI Config+Manifest for produced or imported EROFS bytes.

use anyhow::{Context, Result};
use sea_orm::DatabaseConnection;
use serde_json::Map;
use std::collections::BTreeMap;

use crate::blob::store::FsBlobStore;
use crate::catalog::reference::{record_object, record_reference, ObjectKind, StoredObject};
use crate::catalog::tag::{set_tag, TagExpectation};
use crate::image::publish::{
    publish_manifest, publish_manifest_untagged, ManifestPublication, PublishOutcome,
};
use crate::oci::annotation::{
    NessionUsage, MEDIA_TYPE_COMPOSITE, MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_MANIFEST,
};
use crate::oci::composite::{
    parse_composite, validate_composite_manifest_config, CompositeDescriptor,
};
use crate::oci::config::{ImageConfig, RootFs, RuntimeConfig};
use crate::oci::descriptor::{Descriptor, Platform};
use crate::oci::manifest::Manifest;
use crate::oci::validation::validate_manifest_config;
use crate::oci::{to_bytes, RawDocument};

/// One EROFS layer to publish with its standard identity.
#[derive(Debug, Clone)]
pub struct LayerPublication {
    pub repository: String,
    /// `None` publishes the objects and edges without a mutable Tag.
    pub tag: Option<String>,
    /// Ignored when [`Self::tag`] is `None`.
    pub expectation: TagExpectation,
    pub layer: Descriptor,
    /// Standard OCI platform; `os_features` is forced to include `erofs`.
    pub platform: Platform,
    /// Standard Config `Env` defaults (`KEY=VALUE`).
    pub env: Vec<String>,
    /// Standard runtime projection. A Compose build supplies the merged Env,
    /// Entrypoint, Cmd and WorkingDir here; other callers use the default and
    /// the `env` field above.
    pub runtime: RuntimeConfig,
    /// Advisory Manifest annotations; only `io.nession.*` values are read.
    pub annotations: BTreeMap<String, String>,
}

/// Build the exact Config and Manifest documents for one verified EROFS layer.
///
/// The documents are deterministic: the same layer/platform/env/annotations
/// always produce the same bytes and digests. A changed Env or annotation
/// produces a new Manifest digest while the layer digest stays identical.
pub fn image_documents(
    layer: &Descriptor,
    platform: &Platform,
    env: &[String],
    annotations: &BTreeMap<String, String>,
) -> Result<(RawDocument, RawDocument)> {
    image_documents_with_runtime(layer, platform, env, &RuntimeConfig::default(), annotations)
}

/// Build the exact Config and Manifest documents with an explicit runtime
/// projection. `env` is the legacy envelope and is superseded by
/// `runtime.env` when that is present.
pub fn image_documents_with_runtime(
    layer: &Descriptor,
    platform: &Platform,
    env: &[String],
    runtime: &RuntimeConfig,
    annotations: &BTreeMap<String, String>,
) -> Result<(RawDocument, RawDocument)> {
    if layer.media_type != MEDIA_TYPE_EROFS {
        anyhow::bail!("layer media type must be {MEDIA_TYPE_EROFS}");
    }
    let mut os_features = platform.os_features.clone().unwrap_or_default();
    if !os_features.iter().any(|feature| feature == "erofs") {
        os_features.push("erofs".to_string());
    }
    let mut runtime = runtime.clone();
    if runtime.env.is_none() && !env.is_empty() {
        runtime.env = Some(env.to_vec());
    }
    let config = ImageConfig {
        created: None,
        author: None,
        architecture: platform.architecture.clone(),
        os: platform.os.clone(),
        os_version: platform.os_version.clone(),
        os_features: Some(os_features),
        variant: platform.variant.clone(),
        config: runtime,
        rootfs: RootFs {
            fs_type: "layers".to_string(),
            diff_ids: vec![layer.digest.clone()],
            extra: Map::new(),
        },
        history: Vec::new(),
        extra: Map::new(),
    };
    let config_document = RawDocument::from_bytes(to_bytes(&config)?);
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
        layers: vec![layer.clone()],
        subject: None,
        artifact_type: None,
        annotations: (!annotations.is_empty()).then(|| annotations.clone()),
        extra: Map::new(),
    };
    validate_manifest_config(&manifest, &config)?;
    NessionUsage::from_annotations(manifest.annotations.as_ref())?;
    Ok((
        config_document,
        RawDocument::from_bytes(to_bytes(&manifest)?),
    ))
}

/// Publish one verified EROFS layer as a standards-valid image.
pub async fn publish_layer(
    conn: &DatabaseConnection,
    store: &FsBlobStore,
    publication: &LayerPublication,
) -> Result<PublishOutcome> {
    store
        .verify_named_size(&publication.layer.digest, publication.layer.size)
        .context("EROFS layer is not a verified CAS object")?;
    let (config, manifest) = image_documents_with_runtime(
        &publication.layer,
        &publication.platform,
        &publication.env,
        &publication.runtime,
        &publication.annotations,
    )?;
    match &publication.tag {
        Some(tag) => {
            publish_manifest(
                conn,
                store,
                &ManifestPublication {
                    repository: publication.repository.clone(),
                    tag: tag.clone(),
                    expectation: publication.expectation.clone(),
                    layer: publication.layer.clone(),
                    config,
                    manifest,
                },
                now_seconds(),
            )
            .await
        }
        None => {
            publish_manifest_untagged(
                conn,
                store,
                publication.layer.clone(),
                config,
                manifest,
                now_seconds(),
            )
            .await
        }
    }
}

/// The host OCI platform used by a Server build or a local import.
pub fn host_platform() -> Platform {
    let architecture = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    };
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    Platform {
        architecture: architecture.to_string(),
        os: os.to_string(),
        os_features: Some(vec!["erofs".to_string()]),
        ..Platform::default()
    }
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| i64::try_from(value.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// One referenced Composite publication.
#[derive(Debug, Clone)]
pub struct CompositePublication {
    pub repository: String,
    /// `None` publishes the objects and edges without a mutable Tag.
    pub tag: Option<String>,
    /// Ignored when [`Self::tag`] is `None`.
    pub expectation: TagExpectation,
    /// The Composite descriptor JSON layer.
    pub composite: Descriptor,
    /// The primary metadata EROFS device.
    pub metadata: Descriptor,
    /// Ordered backing EROFS devices.
    pub devices: Vec<Descriptor>,
    pub config: RawDocument,
    pub manifest: RawDocument,
}

/// The result of one Composite publication.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompositePublishOutcome {
    pub manifest_digest: String,
    pub config_digest: String,
    pub composite_digest: String,
    pub metadata_digest: String,
    pub device_digests: Vec<String>,
    pub previous_tag_digest: Option<String>,
}

/// Publish one verified referenced Composite Manifest and its closure.
///
/// Publication order: verify the metadata/device CAS objects, verify the exact
/// Composite descriptor bytes and closure, publish the Config and Manifest,
/// record every object and descriptor edge, then move the Tag (when present)
/// in one transaction. A failure leaves at most private/unreachable bytes.
pub async fn publish_composite(
    conn: &DatabaseConnection,
    store: &FsBlobStore,
    publication: &CompositePublication,
    now: i64,
) -> Result<CompositePublishOutcome> {
    if publication.composite.media_type != MEDIA_TYPE_COMPOSITE {
        anyhow::bail!("Composite layer media type must be {MEDIA_TYPE_COMPOSITE}");
    }
    store
        .verify_named_size(&publication.metadata.digest, publication.metadata.size)
        .context("Composite metadata EROFS is not a verified CAS object")?;
    if publication.metadata.media_type != MEDIA_TYPE_EROFS {
        anyhow::bail!("Composite metadata media type must be {MEDIA_TYPE_EROFS}");
    }
    let mut seen = std::collections::HashSet::new();
    for device in &publication.devices {
        if device.media_type != MEDIA_TYPE_EROFS {
            anyhow::bail!("Composite device media type must be {MEDIA_TYPE_EROFS}");
        }
        if !seen.insert(device.digest.as_str()) {
            anyhow::bail!("Composite closure repeats device {}", device.digest);
        }
        store
            .verify_named_size(&device.digest, device.size)
            .context("Composite device EROFS is not a verified CAS object")?;
    }
    let composite_bytes = store
        .read(&publication.composite.digest)
        .context("Composite descriptor is missing from the CAS")?;
    let actual = crate::digest::digest_of_bytes(&composite_bytes);
    if actual != publication.composite.digest
        || u64::try_from(composite_bytes.len()).ok() != Some(publication.composite.size)
    {
        anyhow::bail!("Composite descriptor bytes do not match their descriptor");
    }
    let composite: CompositeDescriptor = parse_composite(&composite_bytes)?;
    let closure = composite.closure()?;
    let expected = std::iter::once(&publication.metadata)
        .chain(publication.devices.iter())
        .collect::<Vec<_>>();
    if closure.len() != expected.len()
        || closure.iter().zip(expected.iter()).any(|(left, right)| {
            left.digest != right.digest
                || left.size != right.size
                || left.media_type != right.media_type
        })
    {
        anyhow::bail!("Composite descriptor closure does not match the published devices");
    }
    let (_, manifest) = crate::oci::parse_manifest(publication.manifest.bytes())
        .context("Composite Manifest bytes are invalid")?;
    let (_, config) = crate::oci::parse_config(publication.config.bytes())
        .context("Composite Config bytes are invalid")?;
    validate_composite_manifest_config(&manifest, &config, &composite, &publication.composite)?;
    publication
        .config
        .verify_against(&manifest.config)
        .context("Composite Config bytes do not match the Manifest config descriptor")?;
    if manifest.layers.first() != Some(&publication.composite) {
        anyhow::bail!("Composite Manifest layer does not match the published descriptor");
    }
    let config_blob = store.put_bytes(publication.config.bytes())?;
    if config_blob.digest != manifest.config.digest {
        anyhow::bail!("Composite Config bytes do not publish under the Manifest config digest");
    }
    let manifest_blob = store.put_bytes(publication.manifest.bytes())?;
    if manifest_blob.digest != publication.manifest.digest() {
        anyhow::bail!("Composite Manifest bytes do not publish under their own digest");
    }

    let transaction = crate::catalog::sqlite::begin(conn).await?;
    for descriptor in std::iter::once(&publication.metadata).chain(publication.devices.iter()) {
        record_object(
            &transaction,
            &StoredObject {
                digest: descriptor.digest.clone(),
                media_type: descriptor.media_type.clone(),
                size_bytes: descriptor.size,
                kind: ObjectKind::Erofs,
            },
            now,
        )
        .await?;
        record_reference(
            &transaction,
            &publication.composite.digest,
            &descriptor.digest,
            if descriptor.digest == publication.metadata.digest {
                "composite-metadata"
            } else {
                "composite-device"
            },
            now,
        )
        .await?;
    }
    record_object(
        &transaction,
        &StoredObject {
            digest: publication.composite.digest.clone(),
            media_type: publication.composite.media_type.clone(),
            size_bytes: publication.composite.size,
            kind: ObjectKind::Composite,
        },
        now,
    )
    .await?;
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
        &publication.composite.digest,
        "composite",
        now,
    )
    .await?;
    let previous = match &publication.tag {
        Some(tag) => Some(
            set_tag(
                &transaction,
                &publication.repository,
                tag,
                &manifest_blob.digest,
                &publication.expectation,
                now,
            )
            .await?
            .previous,
        )
        .flatten(),
        None => None,
    };
    transaction
        .commit()
        .await
        .map_err(|error| anyhow::anyhow!("Composite publication commit failed: {error}"))?;
    Ok(CompositePublishOutcome {
        manifest_digest: manifest_blob.digest,
        config_digest: config_blob.digest,
        composite_digest: publication.composite.digest.clone(),
        metadata_digest: publication.metadata.digest.clone(),
        device_digests: publication
            .devices
            .iter()
            .map(|device| device.digest.clone())
            .collect(),
        previous_tag_digest: previous,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::sqlite::tests::memory_connection;
    use crate::catalog::tag;
    use crate::oci::annotation::ANNOTATION_KIND;
    use crate::oci::validation::select_platform;
    use tempfile::tempdir;

    fn layer(store: &FsBlobStore, hex: char) -> Descriptor {
        let stored = store
            .put_bytes(format!("verified erofs bytes {hex}").as_bytes())
            .unwrap();
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
    async fn a_built_layer_publishes_a_standard_manifest_and_tag() {
        let dir = tempdir().unwrap();
        let store = FsBlobStore::new(dir.path().join("store")).unwrap();
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        let layer = layer(&store, 'a');
        let mut annotations = BTreeMap::new();
        annotations.insert(ANNOTATION_KIND.to_string(), "directory".to_string());
        let published = publish_layer(
            &conn,
            &store,
            &LayerPublication {
                repository: "builds".to_string(),
                tag: Some("image-1".to_string()),
                expectation: TagExpectation::Absent,
                layer,
                platform: host_platform(),
                env: vec!["PATH=/usr/bin".to_string()],
                runtime: RuntimeConfig::default(),
                annotations,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            tag::get_tag(&conn, "builds", "image-1").await.unwrap(),
            Some(published.manifest_digest.clone())
        );
        let inspection =
            crate::image::inspect::inspect_manifest(&store, &published.manifest_digest).unwrap();
        assert_eq!(inspection.config.env(), &["PATH=/usr/bin".to_string()]);
        assert_eq!(
            inspection.usage.kind,
            Some(crate::oci::ImageKind::Directory)
        );
        assert!(inspection.config.supports_erofs());
    }

    #[test]
    fn changed_metadata_changes_the_manifest_but_not_the_layer() {
        let dir = tempdir().unwrap();
        let store = FsBlobStore::new(dir.path().join("store")).unwrap();
        let layer = layer(&store, 'b');
        let platform = host_platform();
        let (config_a, manifest_a) =
            image_documents(&layer, &platform, &["A=1".to_string()], &BTreeMap::new()).unwrap();
        let (config_b, manifest_b) =
            image_documents(&layer, &platform, &["A=2".to_string()], &BTreeMap::new()).unwrap();
        assert_ne!(config_a.digest(), config_b.digest());
        assert_ne!(manifest_a.digest(), manifest_b.digest());
        let (_, parsed_a) = crate::oci::parse_manifest(manifest_a.bytes()).unwrap();
        let (_, parsed_b) = crate::oci::parse_manifest(manifest_b.bytes()).unwrap();
        assert_eq!(
            parsed_a.layers.first().unwrap().digest,
            parsed_b.layers.first().unwrap().digest
        );
    }

    #[test]
    fn an_index_can_select_the_published_platform() {
        let dir = tempdir().unwrap();
        let store = FsBlobStore::new(dir.path().join("store")).unwrap();
        let layer = layer(&store, 'c');
        let (_, manifest) =
            image_documents(&layer, &host_platform(), &[], &BTreeMap::new()).unwrap();
        let index = crate::oci::Index {
            schema_version: 2,
            media_type: None,
            manifests: vec![Descriptor {
                media_type: MEDIA_TYPE_MANIFEST.to_string(),
                digest: manifest.digest().to_string(),
                size: manifest.size().unwrap(),
                urls: None,
                annotations: None,
                platform: Some(host_platform()),
                artifact_type: None,
                data: None,
                extra: Map::new(),
            }],
            annotations: None,
            extra: Map::new(),
        };
        assert_eq!(
            select_platform(&index, &host_platform()).unwrap().digest,
            manifest.digest()
        );
    }

    fn composite_documents(
        store: &FsBlobStore,
        metadata: &Descriptor,
        devices: &[Descriptor],
        composite_descriptor: &Descriptor,
    ) -> (RawDocument, RawDocument) {
        use crate::oci::composite::{CompositeDescriptor, COMPOSITE_ROOTFS_TYPE};
        let composite = CompositeDescriptor::new(&host_platform(), metadata, devices).unwrap();
        let closure = composite.closure().unwrap();
        let config = ImageConfig {
            created: None,
            author: None,
            architecture: "amd64".to_string(),
            os: "linux".to_string(),
            os_version: None,
            os_features: Some(vec!["erofs".to_string()]),
            variant: None,
            config: RuntimeConfig::default(),
            rootfs: RootFs {
                fs_type: COMPOSITE_ROOTFS_TYPE.to_string(),
                diff_ids: closure
                    .iter()
                    .map(|descriptor| descriptor.digest.clone())
                    .collect(),
                extra: Map::new(),
            },
            history: Vec::new(),
            extra: Map::new(),
        };
        let config_document = RawDocument::from_bytes(to_bytes(&config).unwrap());
        store.put_bytes(config_document.bytes()).unwrap();
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
            layers: vec![composite_descriptor.clone()],
            subject: None,
            artifact_type: None,
            annotations: None,
            extra: Map::new(),
        };
        let manifest_document = RawDocument::from_bytes(to_bytes(&manifest).unwrap());
        store.put_bytes(manifest_document.bytes()).unwrap();
        (manifest_document, config_document)
    }

    #[tokio::test]
    async fn a_referenced_composite_publishes_its_whole_closure_and_gc_retains_every_device() {
        use crate::oci::composite::CompositeDescriptor;
        let dir = tempdir().unwrap();
        let store = FsBlobStore::new(dir.path().join("store")).unwrap();
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        let metadata = layer(&store, 'm');
        let first = layer(&store, 'n');
        let second = layer(&store, 'o');
        let composite = CompositeDescriptor::new(
            &host_platform(),
            &metadata,
            &[first.clone(), second.clone()],
        )
        .unwrap();
        let composite_document = composite.to_document().unwrap();
        let stored = store.put_bytes(composite_document.bytes()).unwrap();
        let composite_descriptor = Descriptor {
            media_type: MEDIA_TYPE_COMPOSITE.to_string(),
            digest: stored.digest,
            size: stored.size_bytes,
            urls: None,
            annotations: None,
            platform: None,
            artifact_type: None,
            data: None,
            extra: Map::new(),
        };
        let (manifest, config) = composite_documents(
            &store,
            &metadata,
            &[first.clone(), second.clone()],
            &composite_descriptor,
        );
        let outcome = publish_composite(
            &conn,
            &store,
            &CompositePublication {
                repository: "nession/composite".to_string(),
                tag: Some("latest".to_string()),
                expectation: TagExpectation::Absent,
                composite: composite_descriptor.clone(),
                metadata: metadata.clone(),
                devices: vec![first.clone(), second.clone()],
                config,
                manifest,
            },
            1,
        )
        .await
        .unwrap();
        assert_eq!(
            tag::get_tag(&conn, "nession/composite", "latest")
                .await
                .unwrap(),
            Some(outcome.manifest_digest.clone())
        );
        let reachable = crate::catalog::reference::reachable(
            &conn,
            std::slice::from_ref(&outcome.manifest_digest),
        )
        .await
        .unwrap();
        for digest in [
            &outcome.config_digest,
            &composite_descriptor.digest,
            &metadata.digest,
            &first.digest,
            &second.digest,
        ] {
            assert!(reachable.contains(digest), "{digest} must be reachable");
        }
        let protected = crate::catalog::protected_digests(&conn, 2).await.unwrap();
        assert!(protected.contains(&first.digest));
        assert!(protected.contains(&second.digest));

        // Moving the only Tag away leaves the closure reclaimable after the
        // bounded mark/grace path.
        crate::catalog::tag::set_tag(
            &conn,
            "nession/composite",
            "latest",
            &format!("sha256:{}", "f".repeat(64)),
            &TagExpectation::Exact(outcome.manifest_digest.clone()),
            10,
        )
        .await
        .unwrap();
        let policy = crate::catalog::gc::GcPolicy {
            grace_seconds: 0,
            max_deletions: 64,
            max_bytes: u64::MAX,
        };
        crate::catalog::gc::sweep(&conn, &store, 20, &policy, &[])
            .await
            .unwrap();
        crate::catalog::gc::sweep(&conn, &store, 21, &policy, &[])
            .await
            .unwrap();
        assert!(!store.contains(&first.digest).unwrap());
        assert!(!store.contains(&second.digest).unwrap());
    }
}
