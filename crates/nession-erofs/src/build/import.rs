//! Import an already-built raw EROFS image without rebuilding it.

use anyhow::{Context, Result};
use sea_orm::DatabaseConnection;
use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

use super::publication::{publish_layer, LayerPublication};
use crate::blob::store::BlobStore;
use crate::catalog::tag::TagExpectation;
use crate::image::publish::PublishOutcome;
use crate::oci::annotation::MEDIA_TYPE_EROFS;
use crate::oci::descriptor::{Descriptor, Platform};

/// The EROFS superblock magic (`"EROFS"` little endian), read at offset 1024.
pub const EROFS_MAGIC: u32 = 0xE2E1_F5E0;
/// The superblock magic offset in a raw EROFS image.
pub const EROFS_MAGIC_OFFSET: usize = 1024;
/// The largest raw image this v1 import path accepts.
pub const MAX_IMPORT_BYTES: u64 = 32 * 1024 * 1024 * 1024;

/// One raw EROFS import.
#[derive(Debug, Clone)]
pub struct RawErofsImport {
    pub repository: String,
    pub tag: String,
    pub expectation: TagExpectation,
    pub platform: Platform,
    pub env: Vec<String>,
    pub annotations: BTreeMap<String, String>,
}

/// The result of one import.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportOutcome {
    pub layer_digest: String,
    pub size_bytes: u64,
    pub publication: PublishOutcome,
}

/// Verify that a file is a bounded raw EROFS image.
///
/// This is a format check, not a mount or a filesystem parser: Phase A's
/// supported form is one raw EROFS layer, so a wrong magic is refused before
/// any bytes are published.
pub fn validate_erofs_file(path: &Path) -> Result<u64> {
    let metadata = std::fs::metadata(path)
        .with_context(|| format!("cannot stat raw EROFS import {}", path.display()))?;
    if !metadata.is_file() {
        anyhow::bail!("raw EROFS import {} is not a regular file", path.display());
    }
    if metadata.len() == 0 {
        anyhow::bail!("raw EROFS import {} is empty", path.display());
    }
    if metadata.len() > MAX_IMPORT_BYTES {
        anyhow::bail!(
            "raw EROFS import {} is {} bytes, above the {MAX_IMPORT_BYTES} byte bound",
            path.display(),
            metadata.len()
        );
    }
    let mut file = std::fs::File::open(path)
        .with_context(|| format!("cannot open raw EROFS import {}", path.display()))?;
    let mut header = [0_u8; EROFS_MAGIC_OFFSET + 4];
    file.read_exact(&mut header).with_context(|| {
        format!(
            "raw EROFS import {} is shorter than a superblock",
            path.display()
        )
    })?;
    let magic = u32::from_le_bytes(
        header[EROFS_MAGIC_OFFSET..]
            .try_into()
            .context("EROFS magic slice is invalid")?,
    );
    if magic != EROFS_MAGIC {
        anyhow::bail!(
            "raw EROFS import {} has magic 0x{magic:08X}, expected 0x{EROFS_MAGIC:08X}",
            path.display()
        );
    }
    Ok(metadata.len())
}

/// Publish an already-built raw EROFS image byte-for-byte.
///
/// No rebuild happens. The exact file is hashed and published into the CAS,
/// then the standard Config+Manifest are generated around that layer digest.
/// Importing identical bytes under another Tag reuses the same physical blob.
pub async fn import_raw_erofs(
    conn: &DatabaseConnection,
    store: &BlobStore,
    path: &Path,
    import: &RawErofsImport,
) -> Result<ImportOutcome> {
    let size_bytes = validate_erofs_file(path)?;
    let stored = store.put_file(path)?;
    if stored.size_bytes != size_bytes {
        anyhow::bail!(
            "raw EROFS import {} changed size while publishing",
            path.display()
        );
    }
    let layer = Descriptor {
        media_type: MEDIA_TYPE_EROFS.to_string(),
        digest: stored.digest.clone(),
        size: stored.size_bytes,
        urls: None,
        annotations: None,
        platform: None,
        artifact_type: None,
        data: None,
        extra: serde_json::Map::new(),
    };
    let publication = publish_layer(
        conn,
        store,
        &LayerPublication {
            repository: import.repository.clone(),
            tag: Some(import.tag.clone()),
            expectation: import.expectation.clone(),
            layer,
            platform: import.platform.clone(),
            env: import.env.clone(),
            annotations: import.annotations.clone(),
        },
    )
    .await?;
    Ok(ImportOutcome {
        layer_digest: stored.digest,
        size_bytes: stored.size_bytes,
        publication,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::sqlite::tests::memory_connection;
    use crate::catalog::tag;
    use crate::oci::annotation::ANNOTATION_KIND;
    use tempfile::tempdir;

    fn erofs_file(path: &Path) {
        let mut bytes = vec![0_u8; EROFS_MAGIC_OFFSET + 4 + 64];
        let magic = EROFS_MAGIC.to_le_bytes();
        bytes[EROFS_MAGIC_OFFSET..EROFS_MAGIC_OFFSET + 4].copy_from_slice(&magic);
        std::fs::write(path, bytes).unwrap();
    }

    #[tokio::test]
    async fn import_publishes_exact_bytes_without_a_rebuild() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().join("store")).unwrap();
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        let image = dir.path().join("image.erofs");
        erofs_file(&image);
        let mut annotations = std::collections::BTreeMap::new();
        annotations.insert(ANNOTATION_KIND.to_string(), "tool".to_string());
        let import = RawErofsImport {
            repository: "imports".to_string(),
            tag: "tool-a".to_string(),
            expectation: TagExpectation::Absent,
            platform: super::super::publication::host_platform(),
            env: vec!["PATH=/usr/bin".to_string()],
            annotations,
        };
        let first = import_raw_erofs(&conn, &store, &image, &import)
            .await
            .unwrap();
        assert_eq!(
            store.read(&first.layer_digest).unwrap(),
            std::fs::read(&image).unwrap()
        );
        assert_eq!(
            tag::get_tag(&conn, "imports", "tool-a").await.unwrap(),
            Some(first.publication.manifest_digest.clone())
        );

        let second = import_raw_erofs(
            &conn,
            &store,
            &image,
            &RawErofsImport {
                tag: "tool-b".to_string(),
                ..import
            },
        )
        .await
        .unwrap();
        assert_eq!(second.layer_digest, first.layer_digest);
        assert_eq!(
            store.usage().unwrap().blobs,
            3,
            "one EROFS + Config + Manifest"
        );
    }

    #[test]
    fn a_non_erofs_file_is_refused() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("not.erofs");
        std::fs::write(&path, vec![0_u8; 2048]).unwrap();
        let error = validate_erofs_file(&path).unwrap_err().to_string();
        assert!(error.contains("magic"));
    }

    #[test]
    fn an_oversized_or_empty_file_is_refused() {
        let dir = tempdir().unwrap();
        let empty = dir.path().join("empty");
        std::fs::write(&empty, []).unwrap();
        assert!(validate_erofs_file(&empty).is_err());
    }
}
