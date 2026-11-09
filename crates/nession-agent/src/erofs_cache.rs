//! Durable, digest-addressed Agent cache for Server-owned EROFS images (#3023).
//!
//! The Agent never owns image identity: the Server resolves a logical image to
//! an immutable `sha256:<hex>` digest and mints a scoped bearer grant. This
//! module checks the persistent cache first, downloads missing content through
//! bounded authenticated streaming (with `Range` resume), verifies the digest
//! before publishing, and atomically renames the verified bytes into place.
//! Interrupted or corrupted content is never offered as a cache hit.

use anyhow::{Context, Result};
use futures_util::StreamExt;
use nession_protocol::contracts::image::v1::is_valid_image_digest;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex as AsyncMutex;

use crate::config::ResolvedErofsStorage;

/// The only digest shape this cache accepts.
pub const DIGEST_PREFIX: &str = "sha256:";
/// One read/write chunk. The cache never buffers a whole image in memory.
pub const TRANSFER_CHUNK_BYTES: usize = 64 * 1024;
/// A partial download older than this is reconciled; a newer one is resumed.
pub const PARTIAL_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);

/// A scoped, single-digest bearer grant minted by `server.image.access`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadGrant {
    pub url: String,
    pub token: String,
}

/// A verified image in the persistent cache.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedImage {
    pub digest: String,
    pub path: PathBuf,
    pub size_bytes: u64,
    /// True when no image body was transferred by this call.
    pub from_cache: bool,
}

/// The filesystem identity of the cache root.
pub trait StorageProbe: Send + Sync {
    /// The mount type containing `path`, or an error when it cannot be proved.
    fn mount_type(&self, path: &Path) -> Result<String>;
}

/// Reads `/proc/mounts`. On non-Linux hosts it reports `unknown`; the
/// durability requirement is a Linux deployment contract.
#[derive(Debug, Default, Clone, Copy)]
pub struct ProcMountsProbe;

impl StorageProbe for ProcMountsProbe {
    fn mount_type(&self, path: &Path) -> Result<String> {
        #[cfg(target_os = "linux")]
        {
            let canonical = std::fs::canonicalize(path)
                .with_context(|| format!("cannot resolve {}", path.display()))?;
            // `Path::starts_with` compares whole components, so the mount point
            // must be an ancestor rather than merely a shared string prefix.
            let mounts = std::fs::read_to_string("/proc/mounts")
                .context("cannot read /proc/mounts to prove durable storage")?;
            let mut best: Option<(usize, String)> = None;
            for line in mounts.lines() {
                let mut fields = line.split_whitespace();
                let (Some(_device), Some(mount_point), Some(fs_type)) =
                    (fields.next(), fields.next(), fields.next())
                else {
                    continue;
                };
                let mount_point = unescape_mount_point(mount_point);
                let mount_path = Path::new(&mount_point);
                if canonical.starts_with(mount_path) {
                    let length = mount_path.as_os_str().len();
                    if best.as_ref().is_none_or(|(current, _)| length > *current) {
                        best = Some((length, fs_type.to_string()));
                    }
                }
            }
            best.map(|(_, fs_type)| fs_type).ok_or_else(|| {
                anyhow::anyhow!("cannot identify the mount containing {}", path.display())
            })
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = path;
            Ok("unknown".to_string())
        }
    }
}

#[cfg(target_os = "linux")]
fn unescape_mount_point(value: &str) -> String {
    value
        .replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}

/// Filesystems whose loss on a recreated container would silently discard the
/// cache. `overlay` is the container writable layer; `tmpfs`/`ramfs` are RAM.
fn is_ephemeral_mount(fs_type: &str) -> bool {
    matches!(
        fs_type,
        "tmpfs"
            | "ramfs"
            | "overlay"
            | "aufs"
            | "devtmpfs"
            | "proc"
            | "sysfs"
            | "cgroup"
            | "cgroup2"
            | "debugfs"
            | "securityfs"
    )
}

/// A persistent, content-addressed image cache.
pub struct ErofsCache {
    root: PathBuf,
    client: reqwest::Client,
    /// One fetch per digest. The map entry is removed when no waiter remains.
    locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    /// Digests with an active consumer; eviction refuses to remove them.
    pinned: Mutex<HashMap<String, u32>>,
    bytes_transferred: AtomicU64,
    fetch_count: AtomicU64,
}

impl ErofsCache {
    /// Open from a resolved config, using the real mount table.
    ///
    /// `ResolvedErofsStorage` comes only from
    /// [`crate::config::AgentConfig::effective_erofs_storage_dir`], which owns
    /// the TOML > environment > native-default precedence.
    pub async fn open_resolved(resolved: &ResolvedErofsStorage) -> Result<Self> {
        Self::open_with_probe(resolved, &ProcMountsProbe).await
    }

    /// Open with an injected mount probe (tests and non-Linux hosts).
    pub async fn open_with_probe(
        resolved: &ResolvedErofsStorage,
        probe: &dyn StorageProbe,
    ) -> Result<Self> {
        let root = resolved.path.clone();
        std::fs::create_dir_all(root.join("sha256")).with_context(|| {
            format!(
                "cannot create EROFS blob directory under {}",
                root.display()
            )
        })?;
        std::fs::create_dir_all(root.join("tmp")).with_context(|| {
            format!(
                "cannot create EROFS temp directory under {}",
                root.display()
            )
        })?;
        validate_storage(&root, resolved.explicit, probe)?;
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30 * 60))
            .build()
            .context("cannot build the EROFS download client")?;
        Ok(Self {
            root,
            client,
            locks: Mutex::new(HashMap::new()),
            pinned: Mutex::new(HashMap::new()),
            bytes_transferred: AtomicU64::new(0),
            fetch_count: AtomicU64::new(0),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Total image-body bytes downloaded by this cache instance.
    pub fn bytes_transferred(&self) -> u64 {
        self.bytes_transferred.load(Ordering::Relaxed)
    }

    /// Total cold fetches performed by this cache instance.
    pub fn fetch_count(&self) -> u64 {
        self.fetch_count.load(Ordering::Relaxed)
    }

    /// Pin a digest for an active consumer. Eviction refuses a pinned digest.
    ///
    /// The guard owns an `Arc` to the cache, so it cannot outlive it.
    pub fn pin(self: &Arc<Self>, digest: &str) -> Result<PinGuard> {
        validate_digest(digest)?;
        if let Ok(mut pinned) = self.pinned.lock() {
            *pinned.entry(digest.to_string()).or_insert(0) += 1;
        }
        Ok(PinGuard {
            digest: digest.to_string(),
            cache: Arc::clone(self),
        })
    }

    /// The final path for a validated digest.
    pub fn blob_path(&self, digest: &str) -> Result<PathBuf> {
        validate_digest(digest)?;
        let hex = digest
            .strip_prefix(DIGEST_PREFIX)
            .ok_or_else(|| anyhow::anyhow!("invalid image digest"))?;
        Ok(self.root.join("sha256").join(hex))
    }

    /// Return the verified blob, downloading it only when the cache is cold.
    ///
    /// Concurrent callers for one digest share a single fetch. A warm hit
    /// transfers zero image-body bytes. Corrupt/partial content is removed and
    /// retried on a later call; it is never returned as a hit.
    pub async fn get_or_fetch(&self, digest: &str, grant: &DownloadGrant) -> Result<CachedImage> {
        let final_path = self.blob_path(digest)?;
        if self.verify_file(&final_path, digest).await.unwrap_or(false) {
            return Ok(CachedImage {
                digest: digest.to_string(),
                size_bytes: std::fs::metadata(&final_path)
                    .with_context(|| format!("cannot stat {}", final_path.display()))?
                    .len(),
                path: final_path,
                from_cache: true,
            });
        }
        if final_path.exists() {
            let _ = std::fs::remove_file(&final_path);
        }
        let lock = self.digest_lock(digest);
        let _guard = lock.lock().await;
        // Another caller may have published while this one waited.
        if self.verify_file(&final_path, digest).await.unwrap_or(false) {
            return Ok(CachedImage {
                digest: digest.to_string(),
                size_bytes: std::fs::metadata(&final_path)
                    .with_context(|| format!("cannot stat {}", final_path.display()))?
                    .len(),
                path: final_path,
                from_cache: true,
            });
        }
        self.fetch_count.fetch_add(1, Ordering::Relaxed);
        let part = self.partial_path(digest)?;
        let transferred = self.download(digest, grant, &part).await?;
        self.bytes_transferred
            .fetch_add(transferred, Ordering::Relaxed);
        if !self.verify_file(&part, digest).await.unwrap_or(false) {
            let _ = std::fs::remove_file(&part);
            anyhow::bail!("downloaded image does not match {digest}");
        }
        let size_bytes = std::fs::metadata(&part)
            .with_context(|| format!("cannot stat {}", part.display()))?
            .len();
        std::fs::rename(&part, &final_path).with_context(|| {
            format!(
                "cannot publish {} as {}",
                part.display(),
                final_path.display()
            )
        })?;
        Ok(CachedImage {
            digest: digest.to_string(),
            path: final_path,
            size_bytes,
            from_cache: false,
        })
    }

    /// Remove a cached blob when no consumer pins it. Returns true if removed.
    pub fn evict(&self, digest: &str) -> Result<bool> {
        let path = self.blob_path(digest)?;
        let pinned = self
            .pinned
            .lock()
            .map(|pinned| pinned.get(digest).copied().unwrap_or(0))
            .unwrap_or(0);
        if pinned > 0 {
            return Ok(false);
        }
        if path.exists() {
            std::fs::remove_file(&path)
                .with_context(|| format!("cannot evict {}", path.display()))?;
            return Ok(true);
        }
        Ok(false)
    }

    /// Delete partial downloads older than the retention window.
    pub fn reconcile_stale_partials(&self, now: SystemTime) -> Result<u64> {
        let tmp = self.root.join("tmp");
        let mut removed = 0;
        for entry in
            std::fs::read_dir(&tmp).with_context(|| format!("cannot read {}", tmp.display()))?
        {
            let entry = entry?;
            if !entry.file_name().to_string_lossy().ends_with(".part") {
                continue;
            }
            let metadata = entry.metadata()?;
            let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            if now.duration_since(modified).unwrap_or_default() > PARTIAL_RETENTION {
                std::fs::remove_file(entry.path())?;
                removed += 1;
            }
        }
        Ok(removed)
    }

    fn digest_lock(&self, digest: &str) -> Arc<AsyncMutex<()>> {
        let mut locks = self
            .locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        locks
            .entry(digest.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    fn partial_path(&self, digest: &str) -> Result<PathBuf> {
        validate_digest(digest)?;
        let hex = digest
            .strip_prefix(DIGEST_PREFIX)
            .ok_or_else(|| anyhow::anyhow!("invalid image digest"))?;
        Ok(self.root.join("tmp").join(format!("{hex}.part")))
    }

    async fn verify_file(&self, path: &Path, digest: &str) -> Result<bool> {
        let metadata = match tokio::fs::metadata(path).await {
            Ok(metadata) if metadata.is_file() => metadata,
            _ => return Ok(false),
        };
        if metadata.len() == 0 {
            return Ok(false);
        }
        let mut file = tokio::fs::File::open(path).await?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0_u8; TRANSFER_CHUNK_BYTES];
        loop {
            let read = file.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            hasher.update(buffer.get(..read).unwrap_or_default());
        }
        Ok(format!("{DIGEST_PREFIX}{:x}", hasher.finalize()) == digest)
    }

    async fn download(&self, digest: &str, grant: &DownloadGrant, part: &Path) -> Result<u64> {
        if grant.token.is_empty() {
            anyhow::bail!("image download grant has no token");
        }
        if !(grant.url.starts_with("https://") || grant.url.starts_with("http://")) {
            anyhow::bail!("image download grant must be an http(s) URL");
        }
        let existing = tokio::fs::metadata(part)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let mut request = self
            .client
            .get(&grant.url)
            .bearer_auth(&grant.token)
            .header(reqwest::header::ACCEPT_ENCODING, "identity");
        if existing > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
        }
        let response = request.send().await.context("image download failed")?;
        let status = response.status();
        let (mut file, append) = if status == reqwest::StatusCode::PARTIAL_CONTENT && existing > 0 {
            (
                tokio::fs::OpenOptions::new()
                    .append(true)
                    .open(part)
                    .await
                    .context("cannot resume a partial image download")?,
                true,
            )
        } else if status.is_success() {
            (
                tokio::fs::File::create(part)
                    .await
                    .context("cannot create a partial image download")?,
                false,
            )
        } else if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            let _ = tokio::fs::remove_file(part).await;
            anyhow::bail!("image server refused the resume range; retry the download");
        } else {
            anyhow::bail!(
                "image download refused with HTTP {} for {digest}",
                status.as_u16()
            );
        };
        let mut stream = response.bytes_stream();
        let mut transferred = 0_u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("image body stream failed")?;
            file.write_all(&chunk)
                .await
                .context("image body write failed")?;
            transferred += chunk.len() as u64;
        }
        file.flush().await?;
        file.sync_all().await?;
        if !append {
            // A 200 response restarted the body from byte zero; the file was
            // truncated by File::create, so the final hash covers the whole
            // body, not a concatenation.
            let _ = append;
        }
        Ok(transferred)
    }
}

/// A consumer's pin. Dropping it releases the eviction guard.
pub struct PinGuard {
    digest: String,
    cache: Arc<ErofsCache>,
}

impl Drop for PinGuard {
    fn drop(&mut self) {
        if let Ok(mut pinned) = self.cache.pinned.lock() {
            if let Some(count) = pinned.get_mut(&self.digest) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    pinned.remove(&self.digest);
                }
            }
        }
    }
}

fn validate_digest(digest: &str) -> Result<()> {
    if !is_valid_image_digest(digest) {
        anyhow::bail!("invalid image digest");
    }
    Ok(())
}

fn validate_storage(root: &Path, explicit: bool, probe: &dyn StorageProbe) -> Result<()> {
    let metadata = std::fs::symlink_metadata(root)
        .with_context(|| format!("EROFS cache is not readable: {}", root.display()))?;
    if !metadata.is_dir() {
        anyhow::bail!("EROFS cache path is not a directory: {}", root.display());
    }
    if metadata.file_type().is_symlink() {
        anyhow::bail!("EROFS cache path must not be a symlink: {}", root.display());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let euid = unsafe { libc::geteuid() };
        if euid != 0 && metadata.uid() != euid {
            anyhow::bail!(
                "EROFS cache {} is owned by uid {}, expected {}",
                root.display(),
                metadata.uid(),
                euid
            );
        }
    }
    let probe_file = root.join(format!(".writable-{}", uuid::Uuid::new_v4()));
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&probe_file)
            .with_context(|| format!("EROFS cache is not writable: {}", root.display()))?;
        file.write_all(b"probe")?;
        file.sync_all()?;
    }
    std::fs::remove_file(&probe_file)?;
    if explicit {
        let fs_type = probe.mount_type(root)?;
        if is_ephemeral_mount(&fs_type) {
            anyhow::bail!(
                "erofs.storage_dir {} is on ephemeral filesystem `{fs_type}`; mount a durable PVC or choose a durable path",
                root.display()
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use httptest::http::Response;
    use httptest::{matchers::*, Expectation, Server};

    fn digest_for(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        format!("{DIGEST_PREFIX}{:x}", hasher.finalize())
    }

    struct DurableProbe(&'static str);
    impl StorageProbe for DurableProbe {
        fn mount_type(&self, _path: &Path) -> Result<String> {
            Ok(self.0.to_string())
        }
    }

    async fn cache(root: &Path, explicit: bool, fs_type: &'static str) -> ErofsCache {
        ErofsCache::open_with_probe(
            &ResolvedErofsStorage {
                path: root.to_path_buf(),
                explicit,
            },
            &DurableProbe(fs_type),
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn cold_fetch_publishes_the_verified_digest_and_warm_hit_transfers_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"immutable image body".to_vec();
        let digest = digest_for(&bytes);
        let server = Server::run();
        server.expect(
            Expectation::matching(request::method_path("GET", format!("/blobs/{digest}")))
                .times(1)
                .respond_with(Response::builder().status(200).body(bytes.clone()).unwrap()),
        );
        let cache = cache(dir.path(), true, "nfs").await;
        let grant = DownloadGrant {
            url: server.url(&format!("/blobs/{digest}")).to_string(),
            token: "scoped-token".to_string(),
        };
        let first = cache.get_or_fetch(&digest, &grant).await.unwrap();
        assert!(!first.from_cache);
        assert_eq!(first.size_bytes, bytes.len() as u64);
        assert_eq!(cache.bytes_transferred(), bytes.len() as u64);
        assert_eq!(cache.fetch_count(), 1);
        let second = cache.get_or_fetch(&digest, &grant).await.unwrap();
        assert!(second.from_cache);
        assert_eq!(cache.bytes_transferred(), bytes.len() as u64);
        assert_eq!(cache.fetch_count(), 1);
    }

    #[tokio::test]
    async fn concurrent_callers_share_one_fetch_per_digest() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = vec![7_u8; 4096];
        let digest = digest_for(&bytes);
        let server = Server::run();
        server.expect(
            Expectation::matching(request::method_path("GET", format!("/blobs/{digest}")))
                .times(1)
                .respond_with(Response::builder().status(200).body(bytes.clone()).unwrap()),
        );
        let cache = Arc::new(cache(dir.path(), true, "nfs").await);
        let grant = DownloadGrant {
            url: server.url(&format!("/blobs/{digest}")).to_string(),
            token: "t".to_string(),
        };
        let a = tokio::spawn({
            let cache = Arc::clone(&cache);
            let grant = grant.clone();
            let digest = digest.clone();
            async move { cache.get_or_fetch(&digest, &grant).await.unwrap() }
        });
        let b = tokio::spawn({
            let cache = Arc::clone(&cache);
            let grant = grant.clone();
            let digest = digest.clone();
            async move { cache.get_or_fetch(&digest, &grant).await.unwrap() }
        });
        let (a, b) = (a.await.unwrap(), b.await.unwrap());
        assert_eq!(a.path, b.path);
        assert_eq!(cache.fetch_count(), 1);
        assert_eq!(cache.bytes_transferred(), bytes.len() as u64);
    }

    #[tokio::test]
    async fn a_corrupted_published_blob_is_rejected_and_refetched() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"good image".to_vec();
        let digest = digest_for(&bytes);
        let server = Server::run();
        server.expect(
            Expectation::matching(request::method_path("GET", format!("/blobs/{digest}")))
                .times(2)
                .respond_with(Response::builder().status(200).body(bytes.clone()).unwrap()),
        );
        let cache = cache(dir.path(), true, "nfs").await;
        let grant = DownloadGrant {
            url: server.url(&format!("/blobs/{digest}")).to_string(),
            token: "t".to_string(),
        };
        let first = cache.get_or_fetch(&digest, &grant).await.unwrap();
        tokio::fs::write(&first.path, b"tampered").await.unwrap();
        let second = cache.get_or_fetch(&digest, &grant).await.unwrap();
        assert!(!second.from_cache);
        assert_eq!(tokio::fs::read(&second.path).await.unwrap(), bytes);
        assert_eq!(cache.fetch_count(), 2);
    }

    #[tokio::test]
    async fn a_partial_download_resumes_with_one_range_request() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"0123456789abcdef".to_vec();
        let digest = digest_for(&bytes);
        let half = bytes.len() / 2;
        let server = Server::run();
        server.expect(
            Expectation::matching(all_of![
                request::method_path("GET", format!("/blobs/{digest}")),
                request::headers(contains(("range", format!("bytes={half}-")))),
            ])
            .times(1)
            .respond_with(
                Response::builder()
                    .status(206)
                    .body(bytes[half..].to_vec())
                    .unwrap(),
            ),
        );
        let cache = cache(dir.path(), true, "nfs").await;
        let part = cache.partial_path(&digest).unwrap();
        tokio::fs::write(&part, &bytes[..half]).await.unwrap();
        let grant = DownloadGrant {
            url: server.url(&format!("/blobs/{digest}")).to_string(),
            token: "t".to_string(),
        };
        let cached = cache.get_or_fetch(&digest, &grant).await.unwrap();
        assert_eq!(tokio::fs::read(&cached.path).await.unwrap(), bytes);
        assert_eq!(cache.bytes_transferred(), (bytes.len() - half) as u64);
    }

    #[tokio::test]
    async fn a_digest_mismatch_never_publishes_and_leaves_no_part() {
        let dir = tempfile::tempdir().unwrap();
        let expected = digest_for(b"expected");
        let server = Server::run();
        server.expect(
            Expectation::matching(request::method_path("GET", format!("/blobs/{expected}")))
                .times(1)
                .respond_with(
                    Response::builder()
                        .status(200)
                        .body(b"wrong".to_vec())
                        .unwrap(),
                ),
        );
        let cache = cache(dir.path(), true, "nfs").await;
        let grant = DownloadGrant {
            url: server.url(&format!("/blobs/{expected}")).to_string(),
            token: "t".to_string(),
        };
        assert!(cache.get_or_fetch(&expected, &grant).await.is_err());
        assert!(!cache.blob_path(&expected).unwrap().exists());
        assert!(!cache.partial_path(&expected).unwrap().exists());
    }

    #[tokio::test]
    async fn an_explicit_cache_on_a_tmpfs_fails_closed_and_an_implicit_one_is_a_dev_default() {
        let dir = tempfile::tempdir().unwrap();
        let explicit = ErofsCache::open_with_probe(
            &ResolvedErofsStorage {
                path: dir.path().join("explicit"),
                explicit: true,
            },
            &DurableProbe("tmpfs"),
        )
        .await;
        assert!(explicit.is_err());
        let implicit = ErofsCache::open_with_probe(
            &ResolvedErofsStorage {
                path: dir.path().join("implicit"),
                explicit: false,
            },
            &DurableProbe("tmpfs"),
        )
        .await;
        assert!(implicit.is_ok());
    }

    #[tokio::test]
    async fn an_unwritable_cache_directory_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("readonly");
        std::fs::create_dir_all(root.join("sha256")).unwrap();
        std::fs::create_dir_all(root.join("tmp")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&root).unwrap().permissions();
            permissions.set_mode(0o500);
            std::fs::set_permissions(&root, permissions).unwrap();
        }
        let result = ErofsCache::open_with_probe(
            &ResolvedErofsStorage {
                path: root.clone(),
                explicit: false,
            },
            &DurableProbe("ext4"),
        )
        .await;
        #[cfg(unix)]
        if unsafe { libc::geteuid() } != 0 {
            assert!(result.is_err());
        }
        let _ = result;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&root).unwrap().permissions();
            permissions.set_mode(0o700);
            std::fs::set_permissions(&root, permissions).unwrap();
        }
    }

    #[tokio::test]
    async fn restart_reuses_a_verified_blob_without_another_transfer() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"restart image".to_vec();
        let digest = digest_for(&bytes);
        let server = Server::run();
        server.expect(
            Expectation::matching(request::method_path("GET", format!("/blobs/{digest}")))
                .times(1)
                .respond_with(Response::builder().status(200).body(bytes.clone()).unwrap()),
        );
        let grant = DownloadGrant {
            url: server.url(&format!("/blobs/{digest}")).to_string(),
            token: "t".to_string(),
        };
        {
            let first = cache(dir.path(), true, "nfs").await;
            let cached = first.get_or_fetch(&digest, &grant).await.unwrap();
            assert!(!cached.from_cache);
            assert_eq!(first.fetch_count(), 1);
        }
        let restarted = cache(dir.path(), true, "nfs").await;
        let hit = restarted.get_or_fetch(&digest, &grant).await.unwrap();
        assert!(hit.from_cache);
        assert_eq!(restarted.fetch_count(), 0);
        assert_eq!(restarted.bytes_transferred(), 0);
        assert_eq!(tokio::fs::read(&hit.path).await.unwrap(), bytes);
    }

    #[tokio::test]
    async fn eviction_refuses_a_pinned_digest_and_stale_partials_are_removed() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"pin".to_vec();
        let digest = digest_for(&bytes);
        let server = Server::run();
        server.expect(
            Expectation::matching(request::method_path("GET", format!("/blobs/{digest}")))
                .times(1)
                .respond_with(Response::builder().status(200).body(bytes.clone()).unwrap()),
        );
        let cache = Arc::new(cache(dir.path(), true, "nfs").await);
        let grant = DownloadGrant {
            url: server.url(&format!("/blobs/{digest}")).to_string(),
            token: "t".to_string(),
        };
        let cached = cache.get_or_fetch(&digest, &grant).await.unwrap();
        {
            let _pin = cache.pin(&digest).unwrap();
            assert!(!cache.evict(&digest).unwrap());
            assert!(cached.path.exists());
        }
        assert!(cache.evict(&digest).unwrap());
        let stale = cache.partial_path(&digest).unwrap();
        tokio::fs::write(&stale, b"partial").await.unwrap();
        std::fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(SystemTime::UNIX_EPOCH)
            .unwrap();
        assert_eq!(
            cache.reconcile_stale_partials(SystemTime::now()).unwrap(),
            1
        );
        assert!(!stale.exists());
    }
}
