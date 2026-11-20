//! The Agent-owned adapter of the reusable #4087 `BlobStore` contract.
//!
//! [`CacheBlobStore`] exposes one identity's verified cache namespace through
//! the same content-addressed contract the Server's authoritative CAS uses.
//! Reads verify before bytes are offered as ready; writes publish atomically
//! through a private temporary file and deduplicate identical digests without
//! rewriting stored bytes.
//!
//! Retention is deliberately not part of this adapter: eviction stays with
//! [`ErofsCache::evict`](super::ErofsCache::evict), which refuses pinned
//! digests, and a local publication never races an active single-flight
//! transfer of the same digest. The shared contract exposes no removal, so a
//! Registry reader can never reclaim cached bytes by itself.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

use super::ErofsCache;
use crate::blob::store::BlobDigest;
use crate::contracts::BlobStore;
use crate::digest::{is_valid_digest, regular_file_digest, DIGEST_PREFIX};

/// One Agent identity's verified cache viewed as a reusable CAS.
#[derive(Clone)]
pub struct CacheBlobStore {
    cache: Arc<ErofsCache>,
}

impl CacheBlobStore {
    /// Wrap an opened cache. The adapter never crosses the cache's identity
    /// namespace: every path is derived from the cache's own validated root.
    pub fn new(cache: Arc<ErofsCache>) -> Self {
        Self { cache }
    }

    /// The owning cache, for pin/eviction policy owned by the runtime adapter.
    pub fn cache(&self) -> &Arc<ErofsCache> {
        &self.cache
    }

    fn verified_path(&self, digest: &str) -> Result<PathBuf> {
        let path = self.cache.blob_path(digest)?;
        let actual = regular_file_digest(&path)
            .with_context(|| format!("cached blob for {digest} is not readable"))?;
        if actual.as_deref() != Some(digest) {
            anyhow::bail!("cached blob for {digest} failed digest verification");
        }
        Ok(path)
    }

    /// Whether a single-flight transfer currently owns this digest.
    fn transfer_active(&self, digest: &str) -> bool {
        self.cache
            .transfers
            .lock()
            .map(|transfers| {
                transfers.get(digest).is_some_and(|state| {
                    matches!(
                        state.phase,
                        super::CachePhase::Downloading | super::CachePhase::Verifying
                    )
                })
            })
            .unwrap_or(false)
    }

    fn publish_reader(&self, reader: &mut dyn Read) -> Result<BlobDigest> {
        let mut hasher = Sha256::new();
        let temp = self
            .cache
            .root
            .join("tmp")
            .join(format!("local-{}.part", uuid::Uuid::new_v4()));
        let mut writer = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .with_context(|| format!("failed to create cache temp file {}", temp.display()))?;
        let mut size = 0_u64;
        let mut buffer = vec![0_u8; super::TRANSFER_CHUNK_BYTES];
        let copy = (|| -> Result<()> {
            loop {
                let read = reader
                    .read(&mut buffer)
                    .context("failed to read blob input")?;
                if read == 0 {
                    break;
                }
                hasher.update(buffer.get(..read).unwrap_or_default());
                writer
                    .write_all(buffer.get(..read).unwrap_or_default())
                    .context("failed to write cached blob")?;
                size += read as u64;
            }
            writer.sync_all().context("failed to fsync cached blob")?;
            Ok(())
        })();
        drop(writer);
        if let Err(error) = copy {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }

        let hex = format!("{:x}", hasher.finalize());
        let digest = format!("{DIGEST_PREFIX}{hex}");
        let destination = self.cache.blob_path(&digest)?;
        // Single-flight ownership: an active transfer of this digest owns the
        // partial/ready transition; a local publication must not race it.
        if self.transfer_active(&digest) {
            let _ = fs::remove_file(&temp);
            anyhow::bail!("a transfer is already active for {digest}");
        }
        if destination.exists() {
            let verification = self.verify_named_size(&digest, size);
            let _ = fs::remove_file(&temp);
            verification?;
        } else {
            fs::rename(&temp, &destination).with_context(|| {
                format!(
                    "failed to publish cached blob {} as {}",
                    temp.display(),
                    destination.display()
                )
            })?;
            sync_directory(&self.cache.root.join("sha256"))?;
        }
        Ok(BlobDigest {
            digest,
            size_bytes: size,
            path: destination,
        })
    }
}

impl BlobStore for CacheBlobStore {
    fn contains(&self, digest: &str) -> Result<bool> {
        Ok(self.cache.blob_path(digest)?.is_file())
    }

    fn size(&self, digest: &str) -> Result<u64> {
        let path = self.cache.blob_path(digest)?;
        let metadata = fs::metadata(&path)
            .with_context(|| format!("cached blob for {digest} is not readable"))?;
        Ok(metadata.len())
    }

    fn path_for(&self, digest: &str) -> Result<PathBuf> {
        self.cache.blob_path(digest)
    }

    fn open(&self, digest: &str) -> Result<File> {
        let path = self.verified_path(digest)?;
        File::open(&path).with_context(|| format!("cached blob for {digest} is not readable"))
    }

    fn read(&self, digest: &str) -> Result<Vec<u8>> {
        let path = self.verified_path(digest)?;
        fs::read(&path).with_context(|| format!("cached blob for {digest} is not readable"))
    }

    fn put_bytes(&self, bytes: &[u8]) -> Result<BlobDigest> {
        let digest = crate::digest::digest_of_bytes(bytes);
        let size_bytes = u64::try_from(bytes.len()).context("blob size does not fit in u64")?;
        let destination = self.cache.blob_path(&digest)?;
        if destination.exists() {
            self.verify_named_size(&digest, size_bytes)?;
            return Ok(BlobDigest {
                digest,
                size_bytes,
                path: destination,
            });
        }
        self.publish_reader(&mut &bytes[..])
    }

    fn put_file(&self, source: &Path) -> Result<BlobDigest> {
        let mut reader = std::io::BufReader::new(
            File::open(source)
                .with_context(|| format!("failed to open local source {}", source.display()))?,
        );
        self.publish_reader(&mut reader)
    }

    fn put_reader(&self, reader: &mut dyn Read) -> Result<BlobDigest> {
        self.publish_reader(reader)
    }

    fn verify(&self, digest: &str) -> Result<()> {
        if !is_valid_digest(digest) {
            anyhow::bail!("invalid image digest");
        }
        self.verified_path(digest).map(|_| ())
    }

    fn verify_named_size(&self, digest: &str, expected_size: u64) -> Result<()> {
        let path = self.cache.blob_path(digest)?;
        let metadata = fs::metadata(&path)
            .with_context(|| format!("cached blob for {digest} is not readable"))?;
        if metadata.len() != expected_size {
            anyhow::bail!(
                "cached blob for {digest} has size {}, expected {expected_size}",
                metadata.len()
            );
        }
        self.verified_path(digest).map(|_| ())
    }
}

/// Make a rename durable by syncing the containing directory.
#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<()> {
    let directory = File::open(path)
        .with_context(|| format!("failed to open directory for fsync: {}", path.display()))?;
    directory
        .sync_all()
        .with_context(|| format!("failed to fsync directory {}", path.display()))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::{CachePhase, StorageProbe, TransferState};
    use crate::contracts::{exercise_blob_contract, BlobStore};

    struct DurableProbe;
    impl StorageProbe for DurableProbe {
        fn mount_type(&self, _path: &Path) -> Result<String> {
            Ok("nfs".to_string())
        }
    }

    async fn adapter(root: &Path, identity: &str) -> CacheBlobStore {
        let cache = ErofsCache::open_with_probe(root, identity, false, &DurableProbe)
            .await
            .unwrap();
        CacheBlobStore::new(Arc::new(cache))
    }

    /// #4087 SC-01: the Agent-owned adapter satisfies the exact same contract
    /// exercise as the Server CAS, including dedupe without rewriting bytes.
    #[tokio::test]
    async fn the_agent_cache_adapter_satisfies_the_shared_contract() {
        let dir = tempfile::tempdir().unwrap();
        let store = adapter(dir.path(), "agent-contract").await;
        exercise_blob_contract(&store);
    }

    /// #4087 SC-01: identical digests published through both host adapters
    /// keep one content identity; the Agent namespace stays its own.
    #[tokio::test]
    async fn both_host_adapters_agree_on_content_identity() {
        let dir = tempfile::tempdir().unwrap();
        let server = crate::blob::store::FsBlobStore::new(dir.path().join("server")).unwrap();
        let agent = adapter(dir.path(), "agent-identity").await;
        let bytes = b"one immutable OCI object".to_vec();
        let server_blob = server.put_bytes(&bytes).unwrap();
        let agent_blob = agent.put_bytes(&bytes).unwrap();
        assert_eq!(server_blob.digest, agent_blob.digest);
        assert_eq!(server_blob.size_bytes, agent_blob.size_bytes);
        assert_ne!(server_blob.path, agent_blob.path);
        assert!(agent
            .path_for(&agent_blob.digest)
            .unwrap()
            .starts_with(agent.cache().root()));
    }

    /// #4087 SC-03: eviction is the cache owner's policy, not the shared
    /// contract's. Pinned objects survive; unpinned re-fetchable objects are
    /// reclaimable; the contract exposes no removal of its own.
    #[tokio::test]
    async fn eviction_preserves_pinned_objects_and_reclaims_unpinned_ones() {
        let dir = tempfile::tempdir().unwrap();
        let store = adapter(dir.path(), "agent-evict").await;
        let pinned_blob = store.put_bytes(b"pinned payload").unwrap();
        let loose_blob = store.put_bytes(b"re-fetchable payload").unwrap();
        let _guard = store.cache().pin(&pinned_blob.digest).unwrap();
        assert!(!store.cache().evict(&pinned_blob.digest).unwrap());
        assert!(store.contains(&pinned_blob.digest).unwrap());
        assert!(store.cache().evict(&loose_blob.digest).unwrap());
        assert!(!store.contains(&loose_blob.digest).unwrap());
        drop(_guard);
        assert!(store.cache().evict(&pinned_blob.digest).unwrap());
    }

    /// #4087 SC-03: eviction never crosses identity namespaces on a shared
    /// volume, and a Server-side sweep cannot reach Agent bytes.
    #[tokio::test]
    async fn eviction_and_server_storage_stay_inside_their_own_namespaces() {
        let dir = tempfile::tempdir().unwrap();
        let first = adapter(dir.path(), "agent-first").await;
        let second = adapter(dir.path(), "agent-second").await;
        let bytes = b"shared content, distinct namespaces".to_vec();
        let a = first.put_bytes(&bytes).unwrap();
        let b = second.put_bytes(&bytes).unwrap();
        assert_eq!(a.digest, b.digest);
        assert!(first.cache().evict(&a.digest).unwrap());
        assert!(
            second.contains(&b.digest).unwrap(),
            "another identity's bytes survive"
        );
        // A Server CAS rooted elsewhere on the same volume is untouched by
        // Agent eviction: distinct roots, distinct ownership.
        let server = crate::blob::store::FsBlobStore::new(dir.path().join("server-cas")).unwrap();
        let server_blob = server.put_bytes(&bytes).unwrap();
        assert!(second.cache().evict(&b.digest).unwrap());
        assert!(server.contains(&server_blob.digest).unwrap());
    }

    /// #4087: a local publication must not race the single-flight transfer
    /// that owns the digest's partial/ready transition.
    #[tokio::test]
    async fn local_publication_refuses_while_a_transfer_owns_the_digest() {
        let dir = tempfile::tempdir().unwrap();
        let store = adapter(dir.path(), "agent-single-flight").await;
        let bytes = b"in-flight payload".to_vec();
        let digest = crate::digest::digest_of_bytes(&bytes);
        store.cache().transfers.lock().unwrap().insert(
            digest.clone(),
            TransferState {
                phase: CachePhase::Downloading,
                downloaded_bytes: 1,
                total_bytes: Some(bytes.len() as u64),
                updated_at: std::time::SystemTime::now(),
                detail: None,
            },
        );
        assert!(store.put_bytes(&bytes).is_err());
        assert!(!store.contains(&digest).unwrap());
        // No stray local temp artifact survives the refusal.
        let tmp = store.cache().root().join("tmp");
        let locals = std::fs::read_dir(&tmp)
            .unwrap()
            .filter_map(std::result::Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("local-"))
            .count();
        assert_eq!(locals, 0);
        store.cache().transfers.lock().unwrap().remove(&digest);
        assert!(store.put_bytes(&bytes).is_ok());
    }

    /// #4087 SC-01: the Agent adapter is stricter than raw CAS access — it
    /// verifies on read, so tampered bytes are never offered as ready.
    #[tokio::test]
    async fn the_agent_adapter_refuses_tampered_bytes_on_read() {
        let dir = tempfile::tempdir().unwrap();
        let store = adapter(dir.path(), "agent-tamper").await;
        let blob = store.put_bytes(b"verified payload").unwrap();
        std::fs::write(&blob.path, b"tampered").unwrap();
        assert!(store.contains(&blob.digest).unwrap());
        assert!(store.read(&blob.digest).is_err());
        assert!(store.open(&blob.digest).is_err());
        assert!(store.verify(&blob.digest).is_err());
    }

    /// #4087 SC-01: a warm-cache retry transfers and rewrites nothing.
    #[tokio::test]
    async fn warm_cache_retry_never_rewrites_verified_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let store = adapter(dir.path(), "agent-warm").await;
        let bytes = vec![9_u8; 8192];
        let first = store.put_bytes(&bytes).unwrap();
        let inode_before = std::fs::metadata(&first.path).unwrap().modified().unwrap();
        let second = store.put_file(&first.path).unwrap();
        assert_eq!(first.digest, second.digest);
        let inode_after = std::fs::metadata(&first.path).unwrap().modified().unwrap();
        assert_eq!(inode_before, inode_after);
        assert_eq!(store.cache().bytes_transferred(), 0);
    }
}
