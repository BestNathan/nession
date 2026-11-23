//! Inspect stored Manifest/Index/Config bytes and read advisory usage hints.

use anyhow::{Context, Result};

use crate::blob::store::FsBlobStore;
use crate::catalog::reference::{get_object, ObjectKind};
use crate::oci::annotation::NessionUsage;
use crate::oci::config::ImageConfig;
use crate::oci::descriptor::{Descriptor, Platform};
use crate::oci::index::Index;
use crate::oci::manifest::Manifest;
use crate::oci::validation::{select_platform, validate_index, validate_manifest_config};
use crate::oci::{parse_config, parse_index, parse_manifest};

/// One Manifest and its linked Config, read back from the CAS.
#[derive(Debug, Clone)]
pub struct ManifestInspection {
    pub manifest_digest: String,
    pub config_digest: String,
    pub layer_digest: String,
    pub manifest: Manifest,
    pub config: ImageConfig,
    pub usage: NessionUsage,
    /// Present for a referenced Composite Manifest (#3697).
    pub composite: Option<crate::oci::composite::CompositeDescriptor>,
}

/// One resolved Index selection.
#[derive(Debug, Clone)]
pub struct IndexInspection {
    pub index_digest: String,
    pub selected: Descriptor,
    pub index: Index,
}

/// Read, verify and validate one Manifest plus its Config.
///
/// The stored digest is checked against the exact bytes before parsing; a
/// catalog row without matching bytes is a failure, not an inspection result.
pub fn inspect_manifest(store: &FsBlobStore, manifest_digest: &str) -> Result<ManifestInspection> {
    let manifest_bytes = store
        .read(manifest_digest)
        .with_context(|| format!("Manifest {manifest_digest} is missing from the CAS"))?;
    let actual = crate::digest::digest_of_bytes(&manifest_bytes);
    if actual != manifest_digest {
        anyhow::bail!("Manifest {manifest_digest} bytes hash to {actual}");
    }
    let (_, manifest) = parse_manifest(&manifest_bytes)?;
    let config_bytes = store
        .read(&manifest.config.digest)
        .with_context(|| format!("Config {} is missing from the CAS", manifest.config.digest))?;
    let actual = crate::digest::digest_of_bytes(&config_bytes);
    if actual != manifest.config.digest {
        anyhow::bail!("Config {} bytes hash to {actual}", manifest.config.digest);
    }
    if u64::try_from(config_bytes.len()).unwrap_or_default() != manifest.config.size {
        anyhow::bail!(
            "Config {} size does not match its descriptor",
            manifest.config.digest
        );
    }
    let (_, config) = parse_config(&config_bytes)?;
    let layer = manifest.layers.first().context("Manifest has no layer")?;
    let (layer_digest, composite) = if layer.media_type == crate::oci::MEDIA_TYPE_COMPOSITE {
        let bytes = store.read(&layer.digest).with_context(|| {
            format!(
                "Composite descriptor {} is missing from the CAS",
                layer.digest
            )
        })?;
        if crate::digest::digest_of_bytes(&bytes) != layer.digest
            || u64::try_from(bytes.len()).ok() != Some(layer.size)
        {
            anyhow::bail!("Composite descriptor {} bytes do not match", layer.digest);
        }
        let composite = crate::oci::composite::parse_composite(&bytes)?;
        for descriptor in composite.closure()? {
            store
                .verify_named_size(&descriptor.digest, descriptor.size)
                .with_context(|| {
                    format!(
                        "Composite device {} is not a verified CAS object",
                        descriptor.digest
                    )
                })?;
        }
        crate::oci::composite::validate_composite_manifest_config(
            &manifest, &config, &composite, layer,
        )?;
        let metadata = composite
            .closure()?
            .first()
            .context("Composite closure has no metadata device")?
            .digest
            .clone();
        (metadata, Some(composite))
    } else {
        validate_manifest_config(&manifest, &config)?;
        (layer.digest.clone(), None)
    };
    let usage = NessionUsage::from_annotations(manifest.annotations.as_ref())?;
    Ok(ManifestInspection {
        manifest_digest: manifest_digest.to_string(),
        config_digest: manifest.config.digest.clone(),
        layer_digest,
        manifest,
        config,
        usage,
        composite,
    })
}

/// Read and validate one Index, then select the requested platform.
pub fn inspect_index(
    store: &FsBlobStore,
    index_digest: &str,
    target: &Platform,
) -> Result<IndexInspection> {
    let bytes = store
        .read(index_digest)
        .with_context(|| format!("Index {index_digest} is missing from the CAS"))?;
    let actual = crate::digest::digest_of_bytes(&bytes);
    if actual != index_digest {
        anyhow::bail!("Index {index_digest} bytes hash to {actual}");
    }
    let (_, index) = parse_index(&bytes)?;
    validate_index(&index)?;
    let selected = select_platform(&index, target)?.clone();
    Ok(IndexInspection {
        index_digest: index_digest.to_string(),
        selected,
        index,
    })
}

/// Verify that a resolved catalog object is a Manifest or Index before an
/// adapter reads its bytes.
pub async fn inspect_resolved(
    conn: &impl sea_orm::ConnectionTrait,
    digest: &str,
) -> Result<Option<ObjectKind>> {
    Ok(get_object(conn, digest).await?.map(|object| object.kind))
}
