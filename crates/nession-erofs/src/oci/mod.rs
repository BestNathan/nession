//! Standard OCI image objects for the Nession EROFS image infrastructure
//! (#3495).
//!
//! This module is the one canonical typed model for OCI Image Index,
//! Manifest, Config and Descriptor plus the raw EROFS layer media type. It
//! deliberately contains no registry, store, catalog, Server or Sandbox
//! dependency: consumers translate their own inputs into these types.
//!
//! Imported bytes are preserved. [`RawDocument`] carries the exact source JSON
//! and its digest, so a consumer can keep the original identity instead of
//! reserializing a typed view and claiming the old digest.

pub mod annotation;
pub mod config;
pub mod descriptor;
pub mod index;
pub mod layout;
pub mod manifest;
pub mod validation;

use anyhow::{Context, Result};
use serde_json::Value;

pub use annotation::{
    ImageKind, NessionUsage, ANNOTATION_KIND, ANNOTATION_MOUNT_DEFAULT, ANNOTATION_PATH_PREPEND,
    MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_INDEX, MEDIA_TYPE_MANIFEST,
};
pub use config::{History, ImageConfig, RootFs, RuntimeConfig};
pub use descriptor::{Descriptor, Platform};
pub use index::Index;
pub use manifest::Manifest;
pub use validation::{
    select_platform, validate_config, validate_descriptor, validate_index, validate_manifest,
    validate_manifest_config,
};

use crate::digest::digest_of_bytes;

/// One imported JSON document with its exact source bytes and identity.
///
/// The digest is computed once from the bytes as supplied. [`Self::bytes`] is
/// the authority for storage and for the document's identity; the parsed typed
/// value is only a view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawDocument {
    bytes: Vec<u8>,
    digest: String,
}

impl RawDocument {
    /// Wrap exact JSON bytes and compute their digest.
    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        let digest = digest_of_bytes(&bytes);
        Self { bytes, digest }
    }

    /// The exact source bytes.
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// `sha256:<64 lowercase hex>` of the exact source bytes.
    pub fn digest(&self) -> &str {
        &self.digest
    }

    /// The source byte length.
    pub fn size(&self) -> Result<u64> {
        u64::try_from(self.bytes.len()).context("document size does not fit in u64")
    }

    /// Verify that this document matches a descriptor's digest and size.
    ///
    /// A descriptor is a claim about exact bytes. Import, storage and transfer
    /// must call this before treating the document as the described object.
    pub fn verify_against(&self, descriptor: &Descriptor) -> Result<()> {
        if self.digest != descriptor.digest {
            anyhow::bail!(
                "document digest {} does not match descriptor digest {}",
                self.digest,
                descriptor.digest
            );
        }
        let actual_size = self.size()?;
        if actual_size != descriptor.size {
            anyhow::bail!(
                "document size {actual_size} does not match descriptor size {}",
                descriptor.size
            );
        }
        Ok(())
    }
}

/// Parse a Manifest from exact bytes while retaining those bytes as identity.
pub fn parse_manifest(bytes: &[u8]) -> Result<(RawDocument, Manifest)> {
    let manifest: Manifest =
        serde_json::from_slice(bytes).context("invalid OCI image manifest JSON")?;
    Ok((RawDocument::from_bytes(bytes.to_vec()), manifest))
}

/// Parse an Index from exact bytes while retaining those bytes as identity.
pub fn parse_index(bytes: &[u8]) -> Result<(RawDocument, Index)> {
    let index: Index = serde_json::from_slice(bytes).context("invalid OCI image index JSON")?;
    Ok((RawDocument::from_bytes(bytes.to_vec()), index))
}

/// Parse an Image Config from exact bytes while retaining those bytes as
/// identity.
pub fn parse_config(bytes: &[u8]) -> Result<(RawDocument, ImageConfig)> {
    let config: ImageConfig =
        serde_json::from_slice(bytes).context("invalid OCI image config JSON")?;
    Ok((RawDocument::from_bytes(bytes.to_vec()), config))
}

/// Parse a descriptor's JSON object.
pub fn parse_descriptor(bytes: &[u8]) -> Result<Descriptor> {
    serde_json::from_slice(bytes).context("invalid OCI descriptor JSON")
}

/// Serialize a typed object for a newly produced (not imported) object.
///
/// The result's digest is the identity of these new bytes. A caller that
/// imports an existing object must keep the original bytes instead.
pub fn to_bytes<T: serde::Serialize>(value: &T) -> Result<Vec<u8>> {
    serde_json::to_vec(value).context("failed to serialize OCI JSON")
}

/// A value that is retained but not interpreted by Nession.
pub type UnknownFields = serde_json::Map<String, Value>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oci::annotation::MEDIA_TYPE_CONFIG;

    const MANIFEST: &str = r#"{
      "schemaVersion": 2,
      "mediaType": "application/vnd.oci.image.manifest.v1+json",
      "config": {
        "mediaType": "application/vnd.oci.image.config.v1+json",
        "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "size": 123
      },
      "layers": [
        {
          "mediaType": "application/vnd.erofs",
          "digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "size": 456
        }
      ],
      "x-unknown": {"kept": true}
    }"#;

    #[test]
    fn exact_source_bytes_are_the_document_identity() {
        let (document, manifest) = parse_manifest(MANIFEST.as_bytes()).unwrap();
        assert_eq!(document.digest(), digest_of_bytes(MANIFEST.as_bytes()));
        assert_eq!(document.bytes(), MANIFEST.as_bytes());
        assert_eq!(manifest.schema_version, 2);
        assert_eq!(manifest.layers.len(), 1);
    }

    #[test]
    fn reordered_keys_change_the_digest_but_not_the_parsed_object() {
        let reordered = r#"{"layers":[{"size":456,"digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","mediaType":"application/vnd.erofs"}],"config":{"size":123,"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mediaType":"application/vnd.oci.image.config.v1+json"},"mediaType":"application/vnd.oci.image.manifest.v1+json","schemaVersion":2,"x-unknown":{"kept":true}}"#;
        let (first_doc, first) = parse_manifest(MANIFEST.as_bytes()).unwrap();
        let (second_doc, second) = parse_manifest(reordered.as_bytes()).unwrap();
        assert_ne!(first_doc.digest(), second_doc.digest());
        assert_eq!(first, second);
        assert_eq!(first.layers, second.layers);
    }

    #[test]
    fn a_descriptor_mismatch_is_rejected() {
        let (document, manifest) = parse_manifest(MANIFEST.as_bytes()).unwrap();
        let config = Descriptor {
            media_type: MEDIA_TYPE_CONFIG.to_string(),
            digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                .to_string(),
            size: 123,
            urls: None,
            annotations: None,
            platform: None,
            artifact_type: None,
            data: None,
            extra: UnknownFields::new(),
        };
        document
            .verify_against(&manifest.config)
            .expect_err("the fixture digest describes the manifest, not its config");
        let (config_document, _) = parse_config(br#"{"architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":["sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]},"os.features":["erofs"]}"#).unwrap();
        config_document
            .verify_against(&config)
            .expect_err("the fixture digest does not match the config bytes");
    }
}
