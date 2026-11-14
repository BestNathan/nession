//! Build a standard OCI Config+Manifest for produced or imported EROFS bytes.

use anyhow::{Context, Result};
use sea_orm::DatabaseConnection;
use serde_json::Map;
use std::collections::BTreeMap;

use crate::blob::store::BlobStore;
use crate::catalog::tag::TagExpectation;
use crate::image::publish::{
    publish_manifest, publish_manifest_untagged, ManifestPublication, PublishOutcome,
};
use crate::oci::annotation::{
    NessionUsage, MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_MANIFEST,
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
    if layer.media_type != MEDIA_TYPE_EROFS {
        anyhow::bail!("layer media type must be {MEDIA_TYPE_EROFS}");
    }
    let mut os_features = platform.os_features.clone().unwrap_or_default();
    if !os_features.iter().any(|feature| feature == "erofs") {
        os_features.push("erofs".to_string());
    }
    let config = ImageConfig {
        created: None,
        author: None,
        architecture: platform.architecture.clone(),
        os: platform.os.clone(),
        os_version: platform.os_version.clone(),
        os_features: Some(os_features),
        variant: platform.variant.clone(),
        config: RuntimeConfig {
            env: (!env.is_empty()).then(|| env.to_vec()),
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
    store: &BlobStore,
    publication: &LayerPublication,
) -> Result<PublishOutcome> {
    store
        .verify_named_size(&publication.layer.digest, publication.layer.size)
        .context("EROFS layer is not a verified CAS object")?;
    let (config, manifest) = image_documents(
        &publication.layer,
        &publication.platform,
        &publication.env,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::sqlite::tests::memory_connection;
    use crate::catalog::tag;
    use crate::oci::annotation::ANNOTATION_KIND;
    use crate::oci::validation::select_platform;
    use tempfile::tempdir;

    fn layer(store: &BlobStore, _hex: char) -> Descriptor {
        let stored = store.put_bytes(b"verified erofs bytes").unwrap();
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
        let store = BlobStore::new(dir.path().join("store")).unwrap();
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
        let store = BlobStore::new(dir.path().join("store")).unwrap();
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
        let store = BlobStore::new(dir.path().join("store")).unwrap();
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
}
