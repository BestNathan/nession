//! The versioned referenced multi-blob EROFS Composite descriptor (#3697).
//!
//! A referenced Composite Image is one immutable OCI Manifest whose single
//! layer is this JSON descriptor. The descriptor names:
//!
//! - the **metadata EROFS** (the primary `mkfs.erofs` rebuild output whose
//!   directory tree and chunk indexes reference the backing devices);
//! - an ordered list of **backing EROFS blobs** (the original source images,
//!   reused byte-for-byte as external devices);
//! - the exact packer/format identity that produced the metadata image.
//!
//! The Manifest's Config uses `rootfs.type = "erofs-composite"` and lists the
//! metadata device followed by the backing devices as `diff_ids`. That is a
//! documented Nession rootfs form, not a multi-layer OCI claim: the Manifest
//! itself still has exactly one layer descriptor, and the descriptor closure
//! is verified before any mount. OCI descriptor meanings are preserved.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::annotation::{
    NessionUsage, MEDIA_TYPE_COMPOSITE, MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_MANIFEST,
};
use super::config::ImageConfig;
use super::descriptor::Descriptor;
use super::{to_bytes, Manifest, RawDocument};

/// The only Composite descriptor schema this build reads.
pub const COMPOSITE_SCHEMA_VERSION: u32 = 1;
/// The only metadata packer format this build reads.
pub const COMPOSITE_PACKER_FORMAT: &str = "erofs-rebuild-v1";
/// The only metadata packer tool identity this build reads.
pub const COMPOSITE_PACKER_TOOL: &str = "mkfs.erofs";
/// The only chunk size this build accepts.
pub const COMPOSITE_CHUNK_SIZE: u32 = 4096;
/// The only block size this build accepts.
pub const COMPOSITE_BLOCK_SIZE: u32 = 4096;
/// Maximum backing devices in one Composite Image.
pub const MAX_COMPOSITE_DEVICES: usize = 16;
/// The Config rootfs type of a referenced Composite Image.
pub const COMPOSITE_ROOTFS_TYPE: &str = "erofs-composite";

/// One exact blob descriptor in the Composite closure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompositeBlob {
    pub media_type: String,
    /// `sha256:<64 lowercase hex>` of the exact bytes.
    pub digest: String,
    pub size: u64,
}

impl CompositeBlob {
    pub fn erofs(descriptor: &Descriptor) -> Result<Self> {
        if descriptor.media_type != MEDIA_TYPE_EROFS {
            anyhow::bail!(
                "Composite device media type {:?} is not {MEDIA_TYPE_EROFS}",
                descriptor.media_type
            );
        }
        Ok(Self {
            media_type: descriptor.media_type.clone(),
            digest: descriptor.digest.clone(),
            size: descriptor.size,
        })
    }

    pub fn as_descriptor(&self) -> Result<Descriptor> {
        if self.media_type != MEDIA_TYPE_EROFS {
            anyhow::bail!(
                "Composite device media type {:?} is not {MEDIA_TYPE_EROFS}",
                self.media_type
            );
        }
        if !crate::digest::is_valid_digest(&self.digest) {
            anyhow::bail!("invalid Composite blob digest {:?}", self.digest);
        }
        Ok(Descriptor {
            media_type: self.media_type.clone(),
            digest: self.digest.clone(),
            size: self.size,
            urls: None,
            annotations: None,
            platform: None,
            artifact_type: None,
            data: None,
            extra: serde_json::Map::new(),
        })
    }
}

/// The platform a Composite Image targets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompositePlatform {
    pub os: String,
    pub architecture: String,
    #[serde(
        rename = "os.version",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub os_version: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub os_features: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
}

impl CompositePlatform {
    pub fn supports_erofs(&self) -> bool {
        self.os_features.iter().any(|feature| feature == "erofs")
    }

    pub fn from_platform(platform: &super::descriptor::Platform) -> Self {
        let mut os_features = platform.os_features.clone().unwrap_or_default();
        if !os_features.iter().any(|feature| feature == "erofs") {
            os_features.push("erofs".to_string());
        }
        Self {
            os: platform.os.clone(),
            architecture: platform.architecture.clone(),
            os_version: platform.os_version.clone(),
            os_features,
            variant: platform.variant.clone(),
        }
    }

    pub fn to_platform(&self) -> super::descriptor::Platform {
        super::descriptor::Platform {
            architecture: self.architecture.clone(),
            os: self.os.clone(),
            os_version: self.os_version.clone(),
            os_features: Some(self.os_features.clone()),
            variant: self.variant.clone(),
            ..super::descriptor::Platform::default()
        }
    }
}

/// The pinned metadata packer identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompositePacker {
    pub format: String,
    pub block_size: u32,
    pub chunk_size: u32,
    pub tool: String,
}

impl Default for CompositePacker {
    fn default() -> Self {
        Self {
            format: COMPOSITE_PACKER_FORMAT.to_string(),
            block_size: COMPOSITE_BLOCK_SIZE,
            chunk_size: COMPOSITE_CHUNK_SIZE,
            tool: COMPOSITE_PACKER_TOOL.to_string(),
        }
    }
}

/// The complete immutable Composite descriptor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompositeDescriptor {
    pub schema_version: u32,
    pub media_type: String,
    pub platform: CompositePlatform,
    pub metadata: CompositeBlob,
    /// Ordered backing devices. Device 1 is `devices[0]`.
    pub devices: Vec<CompositeBlob>,
    pub packer: CompositePacker,
}

impl CompositeDescriptor {
    /// Build a descriptor from verified descriptors.
    pub fn new(
        platform: &super::descriptor::Platform,
        metadata: &Descriptor,
        devices: &[Descriptor],
    ) -> Result<Self> {
        if devices.is_empty() {
            anyhow::bail!("a referenced Composite Image requires at least one backing device");
        }
        if devices.len() > MAX_COMPOSITE_DEVICES {
            anyhow::bail!(
                "a referenced Composite Image accepts at most {MAX_COMPOSITE_DEVICES} backing devices"
            );
        }
        let descriptor = Self {
            schema_version: COMPOSITE_SCHEMA_VERSION,
            media_type: MEDIA_TYPE_COMPOSITE.to_string(),
            platform: CompositePlatform::from_platform(platform),
            metadata: CompositeBlob::erofs(metadata)?,
            devices: devices
                .iter()
                .map(CompositeBlob::erofs)
                .collect::<Result<Vec<_>>>()?,
            packer: CompositePacker::default(),
        };
        descriptor.validate()?;
        Ok(descriptor)
    }

    /// Validate the versioned shape and every descriptor identity.
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != COMPOSITE_SCHEMA_VERSION {
            anyhow::bail!(
                "unsupported Composite schemaVersion {}: expected {COMPOSITE_SCHEMA_VERSION}",
                self.schema_version
            );
        }
        if self.media_type != MEDIA_TYPE_COMPOSITE {
            anyhow::bail!(
                "unsupported Composite mediaType {:?}: expected {MEDIA_TYPE_COMPOSITE}",
                self.media_type
            );
        }
        if self.platform.os.trim().is_empty() || self.platform.architecture.trim().is_empty() {
            anyhow::bail!("Composite platform must name both os and architecture");
        }
        if !self.platform.supports_erofs() {
            anyhow::bail!("Composite platform os.features must include \"erofs\"");
        }
        let _ = self.metadata.as_descriptor()?;
        if self.devices.is_empty() {
            anyhow::bail!("a referenced Composite Image requires at least one backing device");
        }
        if self.devices.len() > MAX_COMPOSITE_DEVICES {
            anyhow::bail!(
                "a referenced Composite Image accepts at most {MAX_COMPOSITE_DEVICES} backing devices"
            );
        }
        let mut seen = std::collections::HashSet::new();
        seen.insert(self.metadata.digest.as_str());
        for device in &self.devices {
            let _ = device.as_descriptor()?;
            if !seen.insert(device.digest.as_str()) {
                anyhow::bail!(
                    "Composite closure contains duplicate blob digest {}",
                    device.digest
                );
            }
        }
        if self.packer.format != COMPOSITE_PACKER_FORMAT
            || self.packer.tool != COMPOSITE_PACKER_TOOL
            || self.packer.block_size != COMPOSITE_BLOCK_SIZE
            || self.packer.chunk_size != COMPOSITE_CHUNK_SIZE
        {
            anyhow::bail!(
                "unsupported Composite packer {:?}/{:?} block {} chunk {}",
                self.packer.format,
                self.packer.tool,
                self.packer.block_size,
                self.packer.chunk_size
            );
        }
        Ok(())
    }

    /// The deterministic JSON bytes of this descriptor.
    pub fn to_document(&self) -> Result<RawDocument> {
        self.validate()?;
        Ok(RawDocument::from_bytes(to_bytes(self)?))
    }

    /// The ordered physical closure: metadata device first, then backing
    /// devices in device-table order.
    pub fn closure(&self) -> Result<Vec<Descriptor>> {
        let mut closure = Vec::with_capacity(self.devices.len() + 1);
        closure.push(self.metadata.as_descriptor()?);
        for device in &self.devices {
            closure.push(device.as_descriptor()?);
        }
        Ok(closure)
    }
}

/// Parse and validate one Composite descriptor document.
pub fn parse_composite(bytes: &[u8]) -> Result<CompositeDescriptor> {
    let descriptor: CompositeDescriptor =
        serde_json::from_slice(bytes).context("Composite descriptor is not valid JSON")?;
    descriptor.validate()?;
    Ok(descriptor)
}

/// Validate a Manifest, Config and Composite descriptor as one referenced
/// image. The Manifest has exactly one layer: the Composite descriptor.
pub fn validate_composite_manifest_config(
    manifest: &Manifest,
    config: &ImageConfig,
    composite: &CompositeDescriptor,
    composite_descriptor: &Descriptor,
) -> Result<()> {
    if manifest.schema_version != 2 {
        anyhow::bail!(
            "unsupported OCI manifest schemaVersion {}: expected 2",
            manifest.schema_version
        );
    }
    if let Some(media_type) = &manifest.media_type {
        if media_type != MEDIA_TYPE_MANIFEST {
            anyhow::bail!("unsupported OCI manifest mediaType {media_type:?}");
        }
    }
    if manifest.layers.len() != 1 {
        anyhow::bail!(
            "a referenced Composite Manifest has exactly one descriptor layer, got {}",
            manifest.layers.len()
        );
    }
    let layer = manifest
        .layers
        .first()
        .context("Composite Manifest has no layer")?;
    if layer.media_type != MEDIA_TYPE_COMPOSITE {
        anyhow::bail!(
            "Composite Manifest layer mediaType {:?} is not {MEDIA_TYPE_COMPOSITE}",
            layer.media_type
        );
    }
    if layer.digest != composite_descriptor.digest || layer.size != composite_descriptor.size {
        anyhow::bail!("Composite Manifest layer does not match the descriptor bytes");
    }
    if manifest.config.media_type != MEDIA_TYPE_CONFIG {
        anyhow::bail!(
            "Composite Config mediaType {:?} is not {MEDIA_TYPE_CONFIG}",
            manifest.config.media_type
        );
    }
    if !crate::digest::is_valid_digest(&manifest.config.digest) {
        anyhow::bail!("invalid Composite Config digest");
    }
    if config.architecture.trim().is_empty() || config.os.trim().is_empty() {
        anyhow::bail!("Composite Config must name both architecture and os");
    }
    if !config.supports_erofs() {
        anyhow::bail!("Composite Config os.features must include \"erofs\"");
    }
    if config.rootfs.fs_type != COMPOSITE_ROOTFS_TYPE {
        anyhow::bail!(
            "unsupported Composite Config rootfs.type {:?}: expected {COMPOSITE_ROOTFS_TYPE}",
            config.rootfs.fs_type
        );
    }
    let expected = composite.closure().map(|descriptors| {
        descriptors
            .into_iter()
            .map(|descriptor| descriptor.digest)
            .collect::<Vec<_>>()
    })?;
    if config.rootfs.diff_ids != expected {
        anyhow::bail!("Composite Config rootfs.diff_ids do not match the metadata/device closure");
    }
    for variable in config.env() {
        let Some((name, _)) = variable.split_once('=') else {
            anyhow::bail!("OCI config Env entry {variable:?} is not KEY=VALUE");
        };
        if name.is_empty() {
            anyhow::bail!("OCI config Env entry {variable:?} has an empty name");
        }
    }
    if let Some(working_dir) = &config.config.working_dir {
        if !working_dir.starts_with('/') {
            anyhow::bail!("OCI config WorkingDir must be absolute, got {working_dir:?}");
        }
    }
    NessionUsage::from_annotations(manifest.annotations.as_ref())?;
    composite.validate()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor(hex: char, size: u64) -> Descriptor {
        Descriptor {
            media_type: MEDIA_TYPE_EROFS.to_string(),
            digest: format!("sha256:{}", hex.to_string().repeat(64)),
            size,
            urls: None,
            annotations: None,
            platform: None,
            artifact_type: None,
            data: None,
            extra: serde_json::Map::new(),
        }
    }

    #[test]
    fn a_descriptor_round_trips_deterministically_and_lists_the_ordered_closure() {
        let metadata = descriptor('a', 10);
        let first = descriptor('b', 20);
        let second = descriptor('c', 30);
        let platform = super::super::descriptor::Platform::for_consumer("linux", "amd64", None);
        let composite =
            CompositeDescriptor::new(&platform, &metadata, &[first.clone(), second.clone()])
                .unwrap();
        let document = composite.to_document().unwrap();
        let parsed = parse_composite(document.bytes()).unwrap();
        assert_eq!(parsed, composite);
        assert_eq!(
            parsed
                .closure()
                .unwrap()
                .into_iter()
                .map(|descriptor| descriptor.digest)
                .collect::<Vec<_>>(),
            vec![metadata.digest, first.digest, second.digest]
        );
        assert_eq!(
            composite.to_document().unwrap().bytes(),
            document.bytes(),
            "repeated serialization is identical"
        );
    }

    #[test]
    fn duplicate_wrong_media_and_unsupported_versions_fail_closed() {
        let platform = super::super::descriptor::Platform::for_consumer("linux", "amd64", None);
        let metadata = descriptor('a', 10);
        let device = descriptor('b', 20);
        let mut composite =
            CompositeDescriptor::new(&platform, &metadata, std::slice::from_ref(&device)).unwrap();
        assert!(
            CompositeDescriptor::new(&platform, &metadata, std::slice::from_ref(&metadata))
                .is_err()
        );
        let mut wrong_media = device.clone();
        wrong_media.media_type = MEDIA_TYPE_COMPOSITE.to_string();
        assert!(CompositeDescriptor::new(&platform, &metadata, &[wrong_media]).is_err());

        composite.schema_version = 2;
        assert!(composite
            .validate()
            .unwrap_err()
            .to_string()
            .contains("schemaVersion"));
        composite.schema_version = COMPOSITE_SCHEMA_VERSION;
        composite.packer.chunk_size = 512;
        assert!(composite.validate().is_err());
        composite.packer = CompositePacker::default();
        composite
            .devices
            .push(CompositeBlob::erofs(&device).unwrap());
        assert!(composite
            .validate()
            .unwrap_err()
            .to_string()
            .contains("duplicate"));
    }
}
