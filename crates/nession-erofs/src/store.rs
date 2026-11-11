//! Content-addressed blob bytes for immutable EROFS images (#3022).
//!
//! The digest is the name. A blob is written to a private temporary file,
//! fsynced, and renamed into place, so a partial write is never visible under a
//! digest. A second publication of the same digest reuses the existing bytes;
//! different bytes never overwrite it.

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};

use crate::digest::{is_valid_digest, verify_file, DIGEST_PREFIX};

/// The verified identity of one stored blob.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobDigest {
    /// `sha256:<64 lowercase hex>`.
    pub digest: String,
    pub size_bytes: u64,
    pub path: PathBuf,
}

/// One blob store's on-disk usage, owned by the layout owner (#3180 SC-05).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StoreUsage {
    /// Verified ready blobs under `sha256/`.
    pub blobs: u64,
    pub blob_bytes: u64,
    /// Unpublished temporary files under `.tmp/`.
    pub temp_files: u64,
    pub temp_bytes: u64,
}

/// A filesystem-backed content-addressed store.
#[derive(Debug, Clone)]
pub struct BlobStore {
    root: PathBuf,
}

impl BlobStore {
    /// Open (and create) a store rooted at `root`.
    ///
    /// The layout is `root/sha256/<hex>` and `root/.tmp`; a digest can never
    /// escape the store because every path is derived from validated hex.
    pub fn new(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(root.join("sha256"))
            .with_context(|| format!("failed to create blob directory {}", root.display()))?;
        fs::create_dir_all(root.join(".tmp"))
            .with_context(|| format!("failed to create blob temp directory {}", root.display()))?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The path for a validated digest.
    pub fn path_for(&self, digest: &str) -> Result<PathBuf> {
        if !is_valid_digest(digest) {
            anyhow::bail!("invalid image digest");
        }
        let Some(hex) = digest.strip_prefix(DIGEST_PREFIX) else {
            anyhow::bail!("invalid image digest");
        };
        Ok(self.root.join("sha256").join(hex))
    }

    /// Whether a blob with this digest exists.
    pub fn contains(&self, digest: &str) -> Result<bool> {
        Ok(self.path_for(digest)?.is_file())
    }

    /// The size of a stored blob.
    pub fn size(&self, digest: &str) -> Result<u64> {
        let path = self.path_for(digest)?;
        let metadata = fs::metadata(&path)
            .with_context(|| format!("blob for {digest} is not readable: {}", path.display()))?;
        Ok(metadata.len())
    }

    /// Open a stored blob for streaming.
    pub fn open(&self, digest: &str) -> Result<File> {
        let path = self.path_for(digest)?;
        File::open(&path).with_context(|| format!("blob for {digest} is not readable"))
    }

    /// Publish `source` atomically.
    ///
    /// The returned digest is computed from the bytes actually stored, not from
    /// a caller claim. If the destination already exists, those bytes are
    /// reused: identical content is an idempotent replay; different content can
    /// never land under a digest because the digest is its hash.
    pub fn put_file(&self, source: &Path) -> Result<BlobDigest> {
        let mut reader = BufReader::new(
            File::open(source)
                .with_context(|| format!("failed to open build output {}", source.display()))?,
        );
        let mut hasher = Sha256::new();
        let temp = self
            .root
            .join(".tmp")
            .join(format!("blob-{}", uuid::Uuid::new_v4()));
        let mut writer = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .with_context(|| format!("failed to create blob temp file {}", temp.display()))?;
        let mut size = 0_u64;
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            let read = reader
                .read(&mut buffer)
                .context("failed to read build output")?;
            if read == 0 {
                break;
            }
            hasher.update(buffer.get(..read).unwrap_or_default());
            writer
                .write_all(buffer.get(..read).unwrap_or_default())
                .context("failed to write blob")?;
            size += read as u64;
        }
        writer.sync_all().context("failed to fsync blob")?;
        drop(writer);

        let hex = format!("{:x}", hasher.finalize());
        let digest = format!("{DIGEST_PREFIX}{hex}");
        let destination = self.path_for(&digest)?;
        if destination.exists() {
            let existing = fs::metadata(&destination)
                .with_context(|| format!("failed to stat {}", destination.display()))?;
            if existing.len() != size {
                let _ = fs::remove_file(&temp);
                anyhow::bail!("existing blob for {digest} has a different size");
            }
            let _ = fs::remove_file(&temp);
        } else {
            fs::rename(&temp, &destination).with_context(|| {
                format!(
                    "failed to publish blob {} as {}",
                    temp.display(),
                    destination.display()
                )
            })?;
        }
        Ok(BlobDigest {
            digest,
            size_bytes: size,
            path: destination,
        })
    }

    /// Recompute and compare the digest of a stored blob.
    ///
    /// Used by readers and tests before bytes are offered as ready; a store that
    /// lost or mutated bytes is a failure, not a warning.
    pub fn verify(&self, digest: &str) -> Result<()> {
        verify_file(&self.path_for(digest)?, digest)
    }

    /// Measure ready blob bytes separately from unpublished temporary files.
    ///
    /// Temporary files are failed or interrupted publications; they are not
    /// image content and must be reported separately from retained blobs.
    pub fn usage(&self) -> Result<StoreUsage> {
        let (blobs, blob_bytes) = directory_usage(&self.root.join("sha256"))?;
        let (temp_files, temp_bytes) = directory_usage(&self.root.join(".tmp"))?;
        Ok(StoreUsage {
            blobs,
            blob_bytes,
            temp_files,
            temp_bytes,
        })
    }
}

/// Count regular files and bytes in a directory this store owns.
fn directory_usage(path: &Path) -> Result<(u64, u64)> {
    let mut files = 0;
    let mut bytes = 0;
    for entry in fs::read_dir(path).with_context(|| format!("failed to read {}", path.display()))? {
        let entry = entry?;
        let metadata = entry
            .metadata()
            .with_context(|| format!("failed to stat {}", entry.path().display()))?;
        if metadata.is_file() {
            files += 1;
            bytes += metadata.len();
        }
    }
    Ok((files, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn file_with(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        let mut file = File::create(&path).unwrap();
        file.write_all(bytes).unwrap();
        path
    }

    #[test]
    fn storing_identical_bytes_reuses_one_physical_blob() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::new(dir.path().join("store")).unwrap();
        let input = file_with(dir.path(), "image.bin", b"immutable image bytes");
        let first = store.put_file(&input).unwrap();
        let second = store.put_file(&input).unwrap();
        assert_eq!(first.digest, second.digest);
        assert_eq!(first.path, second.path);
        assert_eq!(first.size_bytes, 21);
        assert_eq!(
            fs::read_dir(dir.path().join("store/sha256"))
                .unwrap()
                .count(),
            1
        );
        store.verify(&first.digest).unwrap();
    }

    #[test]
    fn a_different_input_gets_a_different_digest() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::new(dir.path().join("store")).unwrap();
        let a = file_with(dir.path(), "a.bin", b"a");
        let b = file_with(dir.path(), "b.bin", b"b");
        assert_ne!(
            store.put_file(&a).unwrap().digest,
            store.put_file(&b).unwrap().digest
        );
    }

    #[test]
    fn a_corrupted_blob_fails_verification() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::new(dir.path().join("store")).unwrap();
        let input = file_with(dir.path(), "image.bin", b"original");
        let stored = store.put_file(&input).unwrap();
        fs::write(&stored.path, b"tampered").unwrap();
        assert!(store.verify(&stored.digest).is_err());
    }

    /// #3303 SC-02: a failed/interrupted publication leaves only a `.tmp`
    /// artifact. The digest never becomes a ready blob, and verification of
    /// the claimed digest fails rather than exposing the partial bytes.
    #[test]
    fn an_interrupted_publication_never_exposes_a_ready_blob() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::new(dir.path().join("store")).unwrap();
        let digest = format!("sha256:{}", "ab".repeat(32));
        fs::write(dir.path().join("store/.tmp/blob-aborted"), b"partial bytes").unwrap();

        assert!(!store.contains(&digest).unwrap());
        assert!(store.verify(&digest).is_err());
        let usage = store.usage().unwrap();
        assert_eq!(usage.blobs, 0, "a temp file is not a ready blob");
        assert_eq!(usage.temp_files, 1);
    }

    /// #3180 SC-05: ready blob bytes and unpublished temporary files are
    /// reported as separate quantities.
    #[test]
    fn usage_separates_ready_blob_bytes_from_unpublished_temporary_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::new(dir.path().join("store")).unwrap();
        let input = file_with(dir.path(), "image.bin", b"ready bytes");
        let stored = store.put_file(&input).unwrap();
        fs::write(dir.path().join("store/.tmp/interrupted.part"), b"temporary").unwrap();

        let usage = store.usage().unwrap();
        assert_eq!(usage.blobs, 1);
        assert_eq!(usage.blob_bytes, stored.size_bytes);
        assert_eq!(usage.temp_files, 1);
        assert_eq!(usage.temp_bytes, b"temporary".len() as u64);
    }
}
