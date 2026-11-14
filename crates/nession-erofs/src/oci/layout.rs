//! OCI Image Layout header and blob path rules.
//!
//! The layout is the offline interoperability form: an `oci-layout` header, an
//! `index.json` entry point and content addressed under `blobs/sha256/<hex>`.
//! This module only parses and validates those names; it does not own a store.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::{parse_index, Index, RawDocument, UnknownFields};

/// The OCI Image Layout version Nession understands.
pub const OCI_LAYOUT_VERSION: &str = "1.0.0";
/// The layout header file name.
pub const OCI_LAYOUT_FILE: &str = "oci-layout";
/// The layout entry point file name.
pub const OCI_INDEX_FILE: &str = "index.json";
/// The content-addressed blob directory below a layout root.
pub const OCI_BLOB_DIR: &str = "blobs/sha256";

/// The `oci-layout` header document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutHeader {
    pub image_layout_version: String,
    #[serde(flatten)]
    pub extra: UnknownFields,
}

/// Parse the `oci-layout` header while retaining its exact bytes.
pub fn parse_layout(bytes: &[u8]) -> Result<(RawDocument, LayoutHeader)> {
    let header: LayoutHeader = serde_json::from_slice(bytes).context("invalid oci-layout JSON")?;
    Ok((RawDocument::from_bytes(bytes.to_vec()), header))
}

/// Validate the layout version.
pub fn validate_layout(header: &LayoutHeader) -> Result<()> {
    if header.image_layout_version != OCI_LAYOUT_VERSION {
        anyhow::bail!(
            "unsupported OCI imageLayoutVersion {:?}: expected {OCI_LAYOUT_VERSION}",
            header.image_layout_version
        );
    }
    Ok(())
}

/// Parse a layout's `index.json`.
pub fn parse_layout_index(bytes: &[u8]) -> Result<(RawDocument, Index)> {
    parse_index(bytes).context("invalid OCI image layout index.json")
}

/// The content-addressed path of one blob inside a layout root.
///
/// The digest must already be a valid `sha256:<hex>` value; the path cannot
/// escape the layout because it is derived only from the validated hex.
pub fn blob_path(root: &Path, digest: &str) -> Result<PathBuf> {
    if !crate::digest::is_valid_digest(digest) {
        anyhow::bail!("invalid OCI layout blob digest {digest:?}");
    }
    let hex = digest
        .strip_prefix(crate::digest::DIGEST_PREFIX)
        .context("invalid OCI layout blob digest")?;
    Ok(root.join(OCI_BLOB_DIR).join(hex))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_header_version_is_validated() {
        let (document, header) =
            parse_layout(br#"{"imageLayoutVersion":"1.0.0","x":"kept"}"#).unwrap();
        validate_layout(&header).unwrap();
        assert_eq!(
            document.digest(),
            crate::digest::digest_of_bytes(document.bytes())
        );
        assert!(header.extra.contains_key("x"));

        let (_, unsupported) = parse_layout(br#"{"imageLayoutVersion":"9.9.9"}"#).unwrap();
        assert!(validate_layout(&unsupported).is_err());
    }

    #[test]
    fn blob_paths_are_derived_from_the_validated_digest() {
        let digest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let path = blob_path(Path::new("/layout"), digest).unwrap();
        assert_eq!(
            path,
            Path::new("/layout/blobs/sha256/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        );
        assert!(blob_path(Path::new("/layout"), "sha256:../../escape").is_err());
    }
}
