//! Durable, digest-addressed EROFS cache (#3023, #3303).
//!
//! The Server (or any other authority) resolves a logical image to an
//! immutable `sha256:<hex>` digest and hands over a scoped bearer grant. This
//! module checks the persistent cache first, downloads missing content through
//! bounded authenticated streaming (with `Range` resume), verifies the digest
//! before publishing, and atomically renames the verified bytes into place.
//! Interrupted or corrupted content is never offered as a cache hit.
//!
//! The cache is namespace-scoped: `configured_root/<namespace>/<identity>`.
//! Several consumers may share one durable volume; ready bytes are immutable,
//! but partials and eviction are mutable state that must not cross identities.
//! The runtime adapter owns the concrete identity and its durable root.

use anyhow::{Context, Result};
use futures_util::StreamExt;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as AsyncMutex;

use crate::digest::{is_valid_digest, regular_file_digest, DIGEST_PREFIX};

/// The local readiness of one digest, observed without downloading or mutating.
///
/// This is a protocol-free projection: a runtime owner maps it to its own wire
/// vocabulary. It is deliberately not an availability promise — a verified
/// blob may still be evicted, and a missing one may be fetched later.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CacheObservation {
    /// The published blob exists and its bytes match the digest.
    Verified,
    /// A partial download exists; a later fetch resumes it.
    Preparing,
    /// Neither a published blob nor a partial download exists.
    Absent,
    /// A published blob exists but does not match the digest, or the digest is invalid.
    Failed { detail: String },
}

/// One digest's authoritative transfer/verification phase (#3412).
///
/// This is still protocol-free: the Agent adapter maps it to
/// `ImageCachePhase`. `Resumable` is a durable partial with no active worker;
/// `Downloading` and `Verifying` are the only active phases.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CachePhase {
    Absent,
    Resumable,
    Downloading,
    Verifying,
    Verified,
    Failed,
}

/// One digest's measured progress snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheProgress {
    pub phase: CachePhase,
    /// Durable partial bytes plus bytes written by the current transfer.
    pub downloaded_bytes: Option<u64>,
    /// Authoritative total, or `None` when the server did not provide one.
    pub total_bytes: Option<u64>,
    pub active: bool,
    /// Last measured state change: a file mtime for durable states, `now` for
    /// live/failed states.
    pub updated_at: SystemTime,
    /// Bounded diagnostic; never a local image path or grant.
    pub detail: Option<String>,
}

/// One in-flight transfer, kept only in memory. A surviving `.part` without
/// this entry is `Resumable`, never `Downloading`.
#[derive(Debug, Clone)]
struct TransferState {
    phase: CachePhase,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    updated_at: SystemTime,
    detail: Option<String>,
}

impl TransferState {
    fn progress(&self) -> CacheProgress {
        CacheProgress {
            phase: self.phase,
            downloaded_bytes: Some(self.downloaded_bytes),
            total_bytes: self.total_bytes,
            active: matches!(self.phase, CachePhase::Downloading | CachePhase::Verifying),
            updated_at: self.updated_at,
            detail: self.detail.clone(),
        }
    }
}

/// How often a streaming transfer refreshes its observable byte count.
const PROGRESS_UPDATE_BYTES: u64 = 256 * 1024;
/// Bound on a reported transfer error; the cache never emits an unbounded body.
const TRANSFER_DETAIL_MAX_CHARS: usize = 512;

struct TransferOutcome {
    transferred: u64,
    /// Full durable bytes in the `.part` after this transfer.
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

/// Clears an in-flight entry when the transfer future is dropped or cancelled.
/// Durable bytes remain in the `.part`, so the next observation is `Resumable`.
struct TransferGuard<'a> {
    cache: &'a ErofsCache,
    digest: String,
    armed: bool,
}

impl<'a> TransferGuard<'a> {
    fn new(cache: &'a ErofsCache, digest: &str) -> Self {
        Self {
            cache,
            digest: digest.to_string(),
            armed: true,
        }
    }

    /// Keep the state the transfer explicitly recorded (verified/failed).
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TransferGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.cache.clear_transfer(&self.digest);
        }
    }
}

/// One read/write chunk. The cache never buffers a whole image in memory.
pub const TRANSFER_CHUNK_BYTES: usize = 64 * 1024;
/// A partial download older than this is reconciled; a newer one is resumed.
pub const PARTIAL_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);

/// The directory below the configured cache root that holds one namespace per
/// durable consumer identity (#3180, #3303).
///
/// Several Agents may share one durable (RWX) volume. Ready bytes are
/// immutable and content-addressed, but `tmp` partials and eviction are
/// mutable state: two processes racing on `<tmp>/<hex>.part`, or one Agent
/// evicting a blob another process is reading, is exactly what a per-identity
/// namespace prevents. A shared identity deliberately shares one namespace —
/// it is the same logical Agent.
pub const IDENTITY_NAMESPACE_DIR: &str = "agents";

/// One identity's verified bytes and in-flight partials, for operator
/// diagnostics (#3180 SC-05).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheDiagnostics {
    pub identity: String,
    /// This identity's namespace root.
    pub root: PathBuf,
    pub ready_blobs: u64,
    pub ready_bytes: u64,
    /// Every file under this identity's `tmp` directory.
    pub temp_artifacts: u64,
    pub temp_bytes: u64,
    /// `tmp` partials older than [`PARTIAL_RETENTION`].
    pub stale_partials: u64,
    pub evicted_blobs: u64,
    pub reconciled_partials: u64,
}

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

/// A persistent, content-addressed image cache owned by one identity.
pub struct ErofsCache {
    /// The configured durable root (shared by every identity on the volume).
    configured_root: PathBuf,
    /// `<configured_root>/agents/<identity>` — this Agent's mutable namespace.
    root: PathBuf,
    identity: String,
    client: reqwest::Client,
    /// One fetch per digest. The map entry is removed when no waiter remains.
    locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    /// Digests with an active consumer; eviction refuses to remove them.
    pinned: Mutex<HashMap<String, u32>>,
    /// Per-digest live transfer observations. Absent means no active worker.
    transfers: Mutex<HashMap<String, TransferState>>,
    bytes_transferred: AtomicU64,
    fetch_count: AtomicU64,
    evicted_blobs: AtomicU64,
    reconciled_partials: AtomicU64,
}

impl ErofsCache {
    /// Open a durable cache rooted at `configured_root`, using the real mount
    /// table.
    ///
    /// The runtime adapter owns the root's configuration precedence and the
    /// stable identity (the Agent uses its resolved identity, so two Agent
    /// processes with different identities on one volume never share ready or
    /// partial files). `explicit` selects the durable-storage proof: an
    /// explicitly configured root must not be on an ephemeral filesystem.
    pub async fn open(configured_root: &Path, identity: &str, explicit: bool) -> Result<Self> {
        Self::open_with_probe(configured_root, identity, explicit, &ProcMountsProbe).await
    }

    /// Open with an injected mount probe (tests and non-Linux hosts).
    pub async fn open_with_probe(
        configured_root: &Path,
        identity: &str,
        explicit: bool,
        probe: &dyn StorageProbe,
    ) -> Result<Self> {
        validate_identity(identity)?;
        let configured_root = configured_root.to_path_buf();
        std::fs::create_dir_all(&configured_root).with_context(|| {
            format!(
                "cannot create EROFS cache root {}",
                configured_root.display()
            )
        })?;
        validate_storage(&configured_root, explicit, probe)?;
        let root = identity_root(&configured_root, identity)?;
        for subdir in ["sha256", "tmp"] {
            std::fs::create_dir_all(root.join(subdir)).with_context(|| {
                format!(
                    "cannot create EROFS {} directory under {}",
                    subdir,
                    root.display()
                )
            })?;
        }
        refuse_symlinked_identity_root(&root)?;
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30 * 60))
            .build()
            .context("cannot build the EROFS download client")?;
        Ok(Self {
            configured_root,
            root,
            identity: identity.to_string(),
            client,
            locks: Mutex::new(HashMap::new()),
            pinned: Mutex::new(HashMap::new()),
            transfers: Mutex::new(HashMap::new()),
            bytes_transferred: AtomicU64::new(0),
            fetch_count: AtomicU64::new(0),
            evicted_blobs: AtomicU64::new(0),
            reconciled_partials: AtomicU64::new(0),
        })
    }

    /// This identity's namespace root.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The configured durable root shared by every identity on the volume.
    pub fn configured_root(&self) -> &Path {
        &self.configured_root
    }

    pub fn identity(&self) -> &str {
        &self.identity
    }

    /// Total image-body bytes downloaded by this cache instance.
    pub fn bytes_transferred(&self) -> u64 {
        self.bytes_transferred.load(Ordering::Relaxed)
    }

    /// Total cold fetches performed by this cache instance.
    pub fn fetch_count(&self) -> u64 {
        self.fetch_count.load(Ordering::Relaxed)
    }

    /// Verified blobs removed by [`Self::evict`] since this instance opened.
    pub fn evicted_blobs(&self) -> u64 {
        self.evicted_blobs.load(Ordering::Relaxed)
    }

    /// Stale partials removed by [`Self::reconcile_stale_partials`] since this
    /// instance opened.
    pub fn reconciled_partials(&self) -> u64 {
        self.reconciled_partials.load(Ordering::Relaxed)
    }

    /// Measure this identity's durable blob bytes, temporary artifacts, stale
    /// partials and retention outcomes (#3180 SC-05).
    ///
    /// The scan is read-only and bounded by the identity namespace, so it can
    /// never report another Agent's bytes as this Agent's cache.
    pub fn diagnostics(&self, now: SystemTime) -> Result<CacheDiagnostics> {
        let (ready_blobs, ready_bytes) = scan_directory(&self.root.join("sha256"))?;
        let mut diagnostics = CacheDiagnostics {
            identity: self.identity.clone(),
            root: self.root.clone(),
            ready_blobs,
            ready_bytes,
            temp_artifacts: 0,
            temp_bytes: 0,
            stale_partials: 0,
            evicted_blobs: self.evicted_blobs(),
            reconciled_partials: self.reconciled_partials(),
        };
        for entry in std::fs::read_dir(self.root.join("tmp")).with_context(|| {
            format!(
                "cannot read EROFS temp directory under {}",
                self.root.display()
            )
        })? {
            let entry = entry?;
            let metadata = entry.metadata()?;
            if !metadata.is_file() {
                continue;
            }
            diagnostics.temp_artifacts += 1;
            diagnostics.temp_bytes += metadata.len();
            if entry.file_name().to_string_lossy().ends_with(".part") {
                let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                if now.duration_since(modified).unwrap_or_default() > PARTIAL_RETENTION {
                    diagnostics.stale_partials += 1;
                }
            }
        }
        Ok(diagnostics)
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

    /// The partial-download path for a validated digest.
    pub fn partial_path(&self, digest: &str) -> Result<PathBuf> {
        validate_digest(digest)?;
        let hex = digest
            .strip_prefix(DIGEST_PREFIX)
            .ok_or_else(|| anyhow::anyhow!("invalid image digest"))?;
        Ok(self.root.join("tmp").join(format!("{hex}.part")))
    }

    /// Observe one digest's local readiness without downloading or mutating.
    ///
    /// A published blob is verified here, so a corrupt file is reported as
    /// failed rather than as available. A valid blob wins over a stale partial
    /// from a previous interrupted attempt.
    pub async fn observe(&self, digest: &str) -> CacheObservation {
        let Ok(final_path) = self.blob_path(digest) else {
            return CacheObservation::Failed {
                detail: "invalid image digest".to_string(),
            };
        };
        if self.verify_file(&final_path, digest).await.unwrap_or(false) {
            return CacheObservation::Verified;
        }
        if final_path.exists() {
            return CacheObservation::Failed {
                detail: "cached blob failed digest verification".to_string(),
            };
        }
        if self
            .partial_path(digest)
            .map(|partial| partial.exists())
            .unwrap_or(false)
        {
            return CacheObservation::Preparing;
        }
        CacheObservation::Absent
    }

    /// Observe one digest's phase, measured bytes and activity without
    /// downloading or mutating anything.
    ///
    /// The in-memory transfer entry is authoritative while a worker runs. With
    /// no entry, the durable files decide: a verified blob is `Verified`, a
    /// surviving `.part` is `Resumable` (not active), and neither is `Absent`.
    /// A restart therefore rebuilds the same truthful state from disk.
    pub async fn observe_progress(&self, digest: &str) -> CacheProgress {
        let now = SystemTime::now();
        let Ok(final_path) = self.blob_path(digest) else {
            return CacheProgress {
                phase: CachePhase::Failed,
                downloaded_bytes: None,
                total_bytes: None,
                active: false,
                updated_at: now,
                detail: Some("invalid image digest".to_string()),
            };
        };
        if let Some(state) = self.transfer_state(digest) {
            return state.progress();
        }
        if self.verify_file(&final_path, digest).await.unwrap_or(false) {
            let size = std::fs::metadata(&final_path).ok().map(|meta| meta.len());
            let updated_at = std::fs::metadata(&final_path)
                .and_then(|meta| meta.modified())
                .unwrap_or(now);
            return CacheProgress {
                phase: CachePhase::Verified,
                downloaded_bytes: size,
                total_bytes: size,
                active: false,
                updated_at,
                detail: None,
            };
        }
        if final_path.exists() {
            let updated_at = std::fs::metadata(&final_path)
                .and_then(|meta| meta.modified())
                .unwrap_or(now);
            return CacheProgress {
                phase: CachePhase::Failed,
                downloaded_bytes: None,
                total_bytes: None,
                active: false,
                updated_at,
                detail: Some("cached blob failed digest verification".to_string()),
            };
        }
        match self.partial_path(digest).map(|partial| {
            std::fs::metadata(&partial)
                .ok()
                .filter(std::fs::Metadata::is_file)
                .map(|meta| (meta.len(), meta.modified().unwrap_or(now)))
        }) {
            Ok(Some((downloaded_bytes, updated_at))) => CacheProgress {
                phase: CachePhase::Resumable,
                downloaded_bytes: Some(downloaded_bytes),
                total_bytes: None,
                active: false,
                updated_at,
                detail: Some("a partial download exists; it can resume".to_string()),
            },
            _ => CacheProgress {
                phase: CachePhase::Absent,
                downloaded_bytes: None,
                total_bytes: None,
                active: false,
                updated_at: now,
                detail: None,
            },
        }
    }

    fn transfer_state(&self, digest: &str) -> Option<TransferState> {
        self.transfers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(digest)
            .cloned()
    }

    fn set_transfer(&self, digest: &str, state: TransferState) {
        self.transfers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(digest.to_string(), state);
    }

    fn begin_transfer(&self, digest: &str, downloaded_bytes: u64) {
        self.set_transfer(
            digest,
            TransferState {
                phase: CachePhase::Downloading,
                downloaded_bytes,
                total_bytes: None,
                updated_at: SystemTime::now(),
                detail: None,
            },
        );
    }

    fn update_transfer_progress(
        &self,
        digest: &str,
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
    ) {
        let mut transfers = self
            .transfers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(state) = transfers.get_mut(digest) {
            state.phase = CachePhase::Downloading;
            state.downloaded_bytes = downloaded_bytes;
            state.total_bytes = total_bytes;
            state.updated_at = SystemTime::now();
        }
    }

    fn set_transfer_verifying(
        &self,
        digest: &str,
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
    ) {
        let mut transfers = self
            .transfers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(state) = transfers.get_mut(digest) {
            state.phase = CachePhase::Verifying;
            state.downloaded_bytes = downloaded_bytes;
            state.total_bytes = total_bytes;
            state.updated_at = SystemTime::now();
            state.detail = None;
        }
    }

    fn fail_transfer(&self, digest: &str, detail: impl Into<String>) {
        let detail = bounded_transfer_detail(&detail.into());
        self.set_transfer(
            digest,
            TransferState {
                phase: CachePhase::Failed,
                downloaded_bytes: 0,
                total_bytes: None,
                updated_at: SystemTime::now(),
                detail: Some(detail),
            },
        );
    }

    /// A transfer error with durable bytes is resumable; one without is failed.
    fn transfer_error(&self, digest: &str, detail: &str) {
        let durable = self
            .partial_path(digest)
            .ok()
            .and_then(|partial| std::fs::metadata(partial).ok())
            .map(|meta| meta.len())
            .unwrap_or(0);
        if durable > 0 {
            self.clear_transfer(digest);
        } else {
            self.fail_transfer(digest, detail);
        }
    }

    fn clear_transfer(&self, digest: &str) {
        self.transfers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(digest);
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
        let mut transfer = TransferGuard::new(self, digest);
        let outcome = match self.download(digest, grant, &part).await {
            Ok(outcome) => outcome,
            Err(error) => {
                // `download` already recorded the truthful durable state
                // (resumable when bytes survive, failed otherwise).
                transfer.disarm();
                return Err(error);
            }
        };
        self.bytes_transferred
            .fetch_add(outcome.transferred, Ordering::Relaxed);
        self.set_transfer_verifying(digest, outcome.downloaded_bytes, outcome.total_bytes);
        if !self.verify_file(&part, digest).await.unwrap_or(false) {
            let _ = std::fs::remove_file(&part);
            self.fail_transfer(digest, format!("downloaded image does not match {digest}"));
            transfer.disarm();
            anyhow::bail!("downloaded image does not match {digest}");
        }
        let size_bytes = std::fs::metadata(&part)
            .with_context(|| format!("cannot stat {}", part.display()))?
            .len();
        if let Err(error) = std::fs::rename(&part, &final_path) {
            self.fail_transfer(
                digest,
                format!(
                    "cannot publish {} as {}: {error}",
                    part.display(),
                    final_path.display()
                ),
            );
            transfer.disarm();
            return Err(error).with_context(|| {
                format!(
                    "cannot publish {} as {}",
                    part.display(),
                    final_path.display()
                )
            });
        }
        self.clear_transfer(digest);
        transfer.disarm();
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
            self.evicted_blobs.fetch_add(1, Ordering::Relaxed);
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
        self.reconciled_partials
            .fetch_add(removed, Ordering::Relaxed);
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

    async fn verify_file(&self, path: &Path, digest: &str) -> Result<bool> {
        let path = path.to_path_buf();
        let actual = tokio::task::spawn_blocking(move || regular_file_digest(&path))
            .await
            .context("image verification task")??;
        Ok(actual.as_deref() == Some(digest))
    }

    async fn download(
        &self,
        digest: &str,
        grant: &DownloadGrant,
        part: &Path,
    ) -> Result<TransferOutcome> {
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
        self.begin_transfer(digest, existing);
        let result = self.download_stream(digest, grant, part, existing).await;
        if let Err(error) = &result {
            // Keep a truthful final state: durable bytes are resumable,
            // otherwise the attempt is failed with a bounded diagnostic.
            self.transfer_error(digest, &format!("{error:#}"));
        }
        result
    }

    async fn download_stream(
        &self,
        digest: &str,
        grant: &DownloadGrant,
        part: &Path,
        existing: u64,
    ) -> Result<TransferOutcome> {
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
        let headers = response.headers().clone();
        let content_length = header_u64(&headers, reqwest::header::CONTENT_LENGTH);
        let (mut file, resumed_bytes, total_bytes) = if status
            == reqwest::StatusCode::PARTIAL_CONTENT
        {
            let content_range = headers
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| {
                    anyhow::anyhow!("image server returned 206 without Content-Range")
                })?;
            let (start, end, total) = parse_content_range(content_range).ok_or_else(|| {
                anyhow::anyhow!("image server returned an invalid Content-Range `{content_range}`")
            })?;
            if existing == 0 {
                anyhow::bail!(
                    "image server returned an unexpected partial response for a cold download"
                );
            }
            if start != existing {
                anyhow::bail!("image resume range starts at {start}, expected {existing}");
            }
            let expected = end - start + 1;
            if let Some(length) = content_length {
                if length != expected {
                    anyhow::bail!(
                        "image resume length {length} disagrees with Content-Range length {expected}"
                    );
                }
            }
            if let Some(total) = total {
                if total < end + 1 {
                    anyhow::bail!(
                        "image resume range ends at {} but the declared total is {total}",
                        end + 1
                    );
                }
            }
            let file = tokio::fs::OpenOptions::new()
                .append(true)
                .open(part)
                .await
                .context("cannot resume a partial image download")?;
            self.update_transfer_progress(digest, existing, total);
            (file, existing, total)
        } else if status.is_success() {
            // A 200 response restarts from byte zero even if the request asked
            // for a Range; `File::create` truncates the stale partial.
            let file = tokio::fs::File::create(part)
                .await
                .context("cannot create a partial image download")?;
            self.update_transfer_progress(digest, 0, content_length);
            (file, 0, content_length)
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
        let mut last_reported = 0_u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("image body stream failed")?;
            file.write_all(&chunk)
                .await
                .context("image body write failed")?;
            transferred += chunk.len() as u64;
            if transferred.saturating_sub(last_reported) >= PROGRESS_UPDATE_BYTES {
                self.update_transfer_progress(digest, resumed_bytes + transferred, total_bytes);
                last_reported = transferred;
            }
        }
        file.flush().await?;
        file.sync_all().await?;
        let downloaded_bytes = resumed_bytes + transferred;
        if let Some(total) = total_bytes {
            if downloaded_bytes > total {
                let _ = tokio::fs::remove_file(part).await;
                anyhow::bail!(
                    "image body reached {downloaded_bytes} bytes but the declared total is {total}"
                );
            }
        }
        self.update_transfer_progress(digest, downloaded_bytes, total_bytes);
        Ok(TransferOutcome {
            transferred,
            downloaded_bytes,
            total_bytes,
        })
    }
}

fn header_u64(
    headers: &reqwest::header::HeaderMap,
    name: reqwest::header::HeaderName,
) -> Option<u64> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse().ok())
}

/// Parse one `Content-Range: bytes <start>-<end>/<total|*>` value.
fn parse_content_range(value: &str) -> Option<(u64, u64, Option<u64>)> {
    let rest = value.strip_prefix("bytes ")?;
    let (range, total) = rest.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let start = start.parse().ok()?;
    let end = end.parse().ok()?;
    if end < start {
        return None;
    }
    let total = if total == "*" {
        None
    } else {
        Some(total.parse().ok()?)
    };
    Some((start, end, total))
}

fn bounded_transfer_detail(detail: &str) -> String {
    // The observation is client-visible: never disclose an absolute cache or
    // host path, even when an I/O error or context wrapper included one.
    let redacted = detail
        .split_whitespace()
        .map(|token| {
            let trimmed = token.trim_matches(|value: char| {
                matches!(value, '\'' | '"' | '`' | ',' | ';' | '(' | ')')
            });
            if trimmed.starts_with('/') && trimmed.len() > 1 {
                "<path>".to_string()
            } else {
                token.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    if redacted.chars().count() <= TRANSFER_DETAIL_MAX_CHARS {
        return redacted;
    }
    let mut bounded: String = redacted.chars().take(TRANSFER_DETAIL_MAX_CHARS).collect();
    bounded.push('…');
    bounded
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
    if !is_valid_digest(digest) {
        anyhow::bail!("invalid image digest");
    }
    Ok(())
}

/// The one owner of the on-volume layout: an identity's namespace root is
/// `<configured root>/agents/<identity>`.
pub fn identity_root(configured_root: &Path, identity: &str) -> Result<PathBuf> {
    validate_identity(identity)?;
    Ok(configured_root.join(IDENTITY_NAMESPACE_DIR).join(identity))
}

/// An Agent identity must be one safe path segment. The identity is the
/// namespace name, so a slash, `.` or `..` would escape or alias another
/// Agent's cache.
fn validate_identity(identity: &str) -> Result<()> {
    let valid = !identity.is_empty()
        && identity.len() <= 128
        && identity
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_alphanumeric())
        && identity
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'));
    if !valid {
        anyhow::bail!(
            "invalid Agent identity for the EROFS cache namespace: use 1-128 ASCII letters, digits, '.', '_' or '-'"
        );
    }
    Ok(())
}

/// A pre-existing symlink at `<root>/agents/<identity>` would silently redirect
/// this Agent's writes into another directory. Refuse it instead of following.
fn refuse_symlinked_identity_root(root: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(root)
        .with_context(|| format!("cannot inspect EROFS cache namespace {}", root.display()))?;
    if metadata.file_type().is_symlink() {
        anyhow::bail!(
            "EROFS cache namespace {} must not be a symlink",
            root.display()
        );
    }
    Ok(())
}

/// Count regular files and their bytes in one directory. A missing directory
/// is an error: the owner created it when the cache opened.
fn scan_directory(path: &Path) -> Result<(u64, u64)> {
    let mut files = 0;
    let mut bytes = 0;
    for entry in
        std::fs::read_dir(path).with_context(|| format!("cannot read {}", path.display()))?
    {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if metadata.is_file() {
            files += 1;
            bytes += metadata.len();
        }
    }
    Ok((files, bytes))
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
        crate::digest::digest_of_bytes(bytes)
    }

    struct DurableProbe(&'static str);
    impl StorageProbe for DurableProbe {
        fn mount_type(&self, _path: &Path) -> Result<String> {
            Ok(self.0.to_string())
        }
    }

    async fn cache(root: &Path, explicit: bool, fs_type: &'static str) -> ErofsCache {
        ErofsCache::open_with_probe(root, "agent-test", explicit, &DurableProbe(fs_type))
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
                    .header(
                        "content-range",
                        format!("bytes {half}-{}/{}", bytes.len() - 1, bytes.len()),
                    )
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
            &dir.path().join("explicit"),
            "agent-test",
            true,
            &DurableProbe("tmpfs"),
        )
        .await;
        assert!(explicit.is_err());
        let implicit = ErofsCache::open_with_probe(
            &dir.path().join("implicit"),
            "agent-test",
            false,
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
        let result =
            ErofsCache::open_with_probe(&root, "agent-test", false, &DurableProbe("ext4")).await;
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
        assert_eq!(cache.evicted_blobs(), 1);
        assert_eq!(cache.reconciled_partials(), 1);
    }

    /// #3180 SC-01: two independent Agent identities on one durable volume
    /// fetch the same digest concurrently. They must not share a partial or a
    /// ready file, both must publish checksum-valid bytes, and one identity's
    /// eviction must not remove the other's ready blob.
    #[tokio::test]
    async fn two_identities_on_one_volume_never_share_ready_or_partial_files() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = vec![9_u8; 32 * 1024];
        let digest = digest_for(&bytes);
        let server = Server::run();
        // Each identity cold-fetches independently; there is no cross-process
        // fetch coalescing to lean on.
        server.expect(
            Expectation::matching(request::method_path("GET", format!("/blobs/{digest}")))
                .times(2)
                .respond_with(Response::builder().status(200).body(bytes.clone()).unwrap()),
        );
        let storage = dir.path().to_path_buf();
        let agent_a = Arc::new(
            ErofsCache::open_with_probe(&storage, "agent-a", true, &DurableProbe("nfs"))
                .await
                .unwrap(),
        );
        let agent_b = Arc::new(
            ErofsCache::open_with_probe(&storage, "agent-b", true, &DurableProbe("nfs"))
                .await
                .unwrap(),
        );
        assert_eq!(agent_a.identity(), "agent-a");
        assert_ne!(agent_a.root(), agent_b.root());
        assert!(agent_a
            .root()
            .starts_with(dir.path().join(IDENTITY_NAMESPACE_DIR)));

        let grant = DownloadGrant {
            url: server.url(&format!("/blobs/{digest}")).to_string(),
            token: "t".to_string(),
        };
        let (left, right) = tokio::join!(
            {
                let cache = Arc::clone(&agent_a);
                let grant = grant.clone();
                let digest = digest.clone();
                async move { cache.get_or_fetch(&digest, &grant).await.unwrap() }
            },
            {
                let cache = Arc::clone(&agent_b);
                let grant = grant.clone();
                let digest = digest.clone();
                async move { cache.get_or_fetch(&digest, &grant).await.unwrap() }
            }
        );
        assert!(!left.from_cache);
        assert!(!right.from_cache);
        assert_ne!(left.path, right.path);
        assert_eq!(tokio::fs::read(&left.path).await.unwrap(), bytes);
        assert_eq!(tokio::fs::read(&right.path).await.unwrap(), bytes);
        assert_eq!(agent_a.bytes_transferred(), bytes.len() as u64);
        assert_eq!(agent_b.bytes_transferred(), bytes.len() as u64);

        // A's eviction is confined to A's namespace.
        assert!(agent_a.evict(&digest).unwrap());
        assert!(!left.path.exists());
        assert!(right.path.exists());
        let warm = agent_b.get_or_fetch(&digest, &grant).await.unwrap();
        assert!(warm.from_cache);
        assert_eq!(agent_b.bytes_transferred(), bytes.len() as u64);
    }

    /// #3180 SC-01: the identity names the namespace directory, so it must be
    /// one safe path segment.
    #[tokio::test]
    async fn an_identity_must_be_one_safe_path_segment() {
        let dir = tempfile::tempdir().unwrap();
        for identity in ["", ".", "..", "a/b", "../escape", ".hidden", "agent a"] {
            let result = ErofsCache::open_with_probe(
                &dir.path().join("root"),
                identity,
                false,
                &DurableProbe("ext4"),
            )
            .await;
            assert!(result.is_err(), "identity {identity:?} must be refused");
            assert!(
                !dir.path()
                    .join("root")
                    .join(IDENTITY_NAMESPACE_DIR)
                    .exists(),
                "a refused identity must not create a namespace"
            );
        }
        let accepted = ErofsCache::open_with_probe(
            &dir.path().join("root"),
            "agent-9f2c_1.0",
            false,
            &DurableProbe("ext4"),
        )
        .await;
        assert!(accepted.is_ok());
    }

    /// #3180 SC-05: diagnostics separate durable ready bytes from temporary
    /// artifacts and stale partials, and report retention outcomes.
    #[tokio::test]
    async fn diagnostics_separate_ready_bytes_from_temporary_artifacts() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"measured image".to_vec();
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
            token: "t".to_string(),
        };
        let cached = cache.get_or_fetch(&digest, &grant).await.unwrap();
        let empty = cache.diagnostics(SystemTime::now()).unwrap();
        assert_eq!(empty.identity, "agent-test");
        assert_eq!(empty.ready_blobs, 1);
        assert_eq!(empty.ready_bytes, bytes.len() as u64);
        assert_eq!(empty.temp_artifacts, 0);
        assert_eq!(empty.temp_bytes, 0);
        assert_eq!(empty.stale_partials, 0);

        let stale = cache.partial_path(&digest).unwrap();
        tokio::fs::write(&stale, b"stale-partial").await.unwrap();
        std::fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(SystemTime::UNIX_EPOCH)
            .unwrap();
        let with_partial = cache.diagnostics(SystemTime::now()).unwrap();
        assert_eq!(with_partial.ready_bytes, bytes.len() as u64);
        assert_eq!(with_partial.temp_artifacts, 1);
        assert_eq!(with_partial.temp_bytes, b"stale-partial".len() as u64);
        assert_eq!(with_partial.stale_partials, 1);

        // The stale artifact is reclaimable without touching the ready bytes.
        assert_eq!(
            cache.reconcile_stale_partials(SystemTime::now()).unwrap(),
            1
        );
        assert!(cached.path.exists());
        let after = cache.diagnostics(SystemTime::now()).unwrap();
        assert_eq!(after.ready_bytes, bytes.len() as u64);
        assert_eq!(after.temp_artifacts, 0);
        assert_eq!(after.stale_partials, 0);
        assert_eq!(after.reconciled_partials, 1);
    }
}

#[cfg(test)]
mod progress_tests {
    use super::*;
    use std::io::{Read, Write};

    struct DurableProbe;
    impl StorageProbe for DurableProbe {
        fn mount_type(&self, _path: &Path) -> Result<String> {
            Ok("nfs".to_string())
        }
    }

    async fn cache(root: &Path) -> ErofsCache {
        ErofsCache::open_with_probe(root, "agent-progress", true, &DurableProbe)
            .await
            .unwrap()
    }

    fn digest_for(bytes: &[u8]) -> String {
        crate::digest::digest_of_bytes(bytes)
    }

    #[test]
    fn content_range_parsing_accepts_known_and_unknown_totals() {
        assert_eq!(
            parse_content_range("bytes 12-47/48"),
            Some((12, 47, Some(48)))
        );
        assert_eq!(parse_content_range("bytes 0-99/*"), Some((0, 99, None)));
        assert_eq!(parse_content_range("bytes 47-12/48"), None);
        assert_eq!(parse_content_range("items 0-1/2"), None);
    }

    #[tokio::test]
    async fn progress_distinguishes_absent_resumable_and_verified() {
        let dir = tempfile::tempdir().unwrap();
        let cache = cache(dir.path()).await;
        let bytes = b"progress body".to_vec();
        let digest = digest_for(&bytes);

        let absent = cache.observe_progress(&digest).await;
        assert_eq!(absent.phase, CachePhase::Absent);
        assert!(!absent.active);
        assert!(absent.downloaded_bytes.is_none());

        let part = cache.partial_path(&digest).unwrap();
        std::fs::write(&part, &bytes[..4]).unwrap();
        let resumable = cache.observe_progress(&digest).await;
        assert_eq!(resumable.phase, CachePhase::Resumable);
        assert_eq!(resumable.downloaded_bytes, Some(4));
        assert!(!resumable.active);
        assert!(resumable
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("partial")));

        let server = httptest::Server::run();
        server.expect(
            httptest::Expectation::matching(httptest::matchers::request::method_path(
                "GET",
                format!("/blobs/{digest}"),
            ))
            .respond_with(
                httptest::http::Response::builder()
                    .status(200)
                    .body(bytes.clone())
                    .unwrap(),
            ),
        );
        let grant = DownloadGrant {
            url: server.url(&format!("/blobs/{digest}")).to_string(),
            token: "t".to_string(),
        };
        cache.get_or_fetch(&digest, &grant).await.unwrap();
        let verified = cache.observe_progress(&digest).await;
        assert_eq!(verified.phase, CachePhase::Verified);
        assert_eq!(verified.downloaded_bytes, Some(bytes.len() as u64));
        assert_eq!(verified.total_bytes, Some(bytes.len() as u64));
        assert!(!verified.active);
    }

    #[tokio::test]
    async fn restart_rebuilds_resumable_and_verified_progress_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"restart progress".to_vec();
        let digest = digest_for(&bytes);
        {
            let cache = cache(dir.path()).await;
            std::fs::write(cache.partial_path(&digest).unwrap(), &bytes[..5]).unwrap();
            let verified_bytes = b"already verified".to_vec();
            let verified_digest = digest_for(&verified_bytes);
            let server = httptest::Server::run();
            server.expect(
                httptest::Expectation::matching(httptest::matchers::request::method_path(
                    "GET",
                    format!("/blobs/{verified_digest}"),
                ))
                .respond_with(
                    httptest::http::Response::builder()
                        .status(200)
                        .body(verified_bytes.clone())
                        .unwrap(),
                ),
            );
            let grant = DownloadGrant {
                url: server.url(&format!("/blobs/{verified_digest}")).to_string(),
                token: "t".to_string(),
            };
            cache.get_or_fetch(&verified_digest, &grant).await.unwrap();
        }
        let restarted = cache(dir.path()).await;
        let resumable = restarted.observe_progress(&digest).await;
        assert_eq!(resumable.phase, CachePhase::Resumable);
        assert_eq!(resumable.downloaded_bytes, Some(5));
        assert!(!resumable.active);

        let verified = restarted
            .observe_progress(&digest_for(b"already verified"))
            .await;
        assert_eq!(verified.phase, CachePhase::Verified);
        assert!(!verified.active);
    }

    #[tokio::test]
    async fn a_slow_transfer_is_downloading_with_measured_bytes_then_verified() {
        let dir = tempfile::tempdir().unwrap();
        let body = vec![0_u8; 512 * 1024];
        let digest = digest_for(&body);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server_body = body.clone();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                server_body.len()
            )
            .unwrap();
            let (first, second) = server_body.split_at(server_body.len() / 2);
            stream.write_all(first).unwrap();
            stream.flush().unwrap();
            std::thread::sleep(Duration::from_millis(300));
            stream.write_all(second).unwrap();
        });
        let cache = Arc::new(cache(dir.path()).await);
        let grant = DownloadGrant {
            url: format!("http://{address}/blobs/{digest}"),
            token: "t".to_string(),
        };
        let fetch = tokio::spawn({
            let cache = Arc::clone(&cache);
            let digest = digest.clone();
            async move { cache.get_or_fetch(&digest, &grant).await }
        });

        let mut observed = None;
        for _ in 0..200 {
            let progress = cache.observe_progress(&digest).await;
            if progress.phase == CachePhase::Downloading
                && progress.downloaded_bytes.unwrap_or(0) > 0
            {
                observed = Some(progress);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let observed = observed.expect("a slow transfer must be observable while active");
        assert!(observed.active);
        assert_eq!(observed.total_bytes, Some(body.len() as u64));
        assert!(observed.downloaded_bytes.unwrap() < body.len() as u64);

        fetch.await.unwrap().unwrap();
        server.join().unwrap();
        let verified = cache.observe_progress(&digest).await;
        assert_eq!(verified.phase, CachePhase::Verified);
        assert!(!verified.active);
    }

    #[tokio::test]
    async fn a_200_restart_resets_the_reported_count() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"0123456789abcdef".to_vec();
        let digest = digest_for(&bytes);
        let part = cache(dir.path()).await.partial_path(&digest).unwrap();
        std::fs::write(&part, &bytes[..8]).unwrap();
        let server = httptest::Server::run();
        server.expect(
            httptest::Expectation::matching(httptest::matchers::request::method_path(
                "GET",
                format!("/blobs/{digest}"),
            ))
            .respond_with(
                httptest::http::Response::builder()
                    .status(200)
                    .body(bytes.clone())
                    .unwrap(),
            ),
        );
        let cache = cache(dir.path()).await;
        let grant = DownloadGrant {
            url: server.url(&format!("/blobs/{digest}")).to_string(),
            token: "t".to_string(),
        };
        let cached = cache.get_or_fetch(&digest, &grant).await.unwrap();
        assert_eq!(cached.size_bytes, bytes.len() as u64);
        assert_eq!(cache.bytes_transferred(), bytes.len() as u64);
        assert_eq!(
            cache.observe_progress(&digest).await.downloaded_bytes,
            Some(bytes.len() as u64)
        );
    }

    #[tokio::test]
    async fn a_digest_mismatch_is_failed_not_verified() {
        let dir = tempfile::tempdir().unwrap();
        let expected = digest_for(b"expected");
        let server = httptest::Server::run();
        server.expect(
            httptest::Expectation::matching(httptest::matchers::request::method_path(
                "GET",
                format!("/blobs/{expected}"),
            ))
            .respond_with(
                httptest::http::Response::builder()
                    .status(200)
                    .body(b"wrong".to_vec())
                    .unwrap(),
            ),
        );
        let cache = cache(dir.path()).await;
        let grant = DownloadGrant {
            url: server.url(&format!("/blobs/{expected}")).to_string(),
            token: "t".to_string(),
        };
        assert!(cache.get_or_fetch(&expected, &grant).await.is_err());
        let failed = cache.observe_progress(&expected).await;
        assert_eq!(failed.phase, CachePhase::Failed);
        assert!(!failed.active);
        assert!(failed
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("does not match")));
        assert!(!cache.partial_path(&expected).unwrap().exists());
    }
}

#[cfg(test)]
mod progress_negative_tests {
    use super::*;
    use std::io::{Read, Write};

    struct DurableProbe;
    impl StorageProbe for DurableProbe {
        fn mount_type(&self, _path: &Path) -> Result<String> {
            Ok("nfs".to_string())
        }
    }

    async fn cache(root: &Path) -> ErofsCache {
        ErofsCache::open_with_probe(root, "agent-negative", true, &DurableProbe)
            .await
            .unwrap()
    }

    fn digest_for(bytes: &[u8]) -> String {
        crate::digest::digest_of_bytes(bytes)
    }

    #[test]
    fn transfer_details_redact_absolute_paths_and_bound_length() {
        let detail = bounded_transfer_detail(
            "cannot publish /data/erofs/agents/a/tmp/x.part as /data/erofs/agents/a/sha256/x: denied",
        );
        assert!(!detail.contains("/data/erofs"), "{detail}");
        assert!(detail.contains("<path>"), "{detail}");
        let long = "x".repeat(TRANSFER_DETAIL_MAX_CHARS + 10);
        assert_eq!(
            bounded_transfer_detail(&long).chars().count(),
            TRANSFER_DETAIL_MAX_CHARS + 1
        );
    }

    #[tokio::test]
    async fn an_interrupted_transfer_leaves_nonzero_resumable_bytes_not_active() {
        let dir = tempfile::tempdir().unwrap();
        let body = vec![0_u8; 512 * 1024];
        let digest = digest_for(&body);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server_body = body.clone();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                server_body.len()
            )
            .unwrap();
            stream
                .write_all(&server_body[..server_body.len() / 2])
                .unwrap();
            stream.flush().unwrap();
            // Dropping the connection before the declared length is an
            // interrupted transfer, not a successful image.
        });
        let cache = cache(dir.path()).await;
        let grant = DownloadGrant {
            url: format!("http://{address}/blobs/{digest}"),
            token: "t".to_string(),
        };
        assert!(cache.get_or_fetch(&digest, &grant).await.is_err());
        server.join().unwrap();

        let progress = cache.observe_progress(&digest).await;
        assert_eq!(progress.phase, CachePhase::Resumable);
        assert!(!progress.active);
        assert!(progress.downloaded_bytes.unwrap() > 0);
        assert!(progress.downloaded_bytes.unwrap() < body.len() as u64);
        let part = cache.partial_path(&digest).unwrap();
        assert_eq!(
            progress.downloaded_bytes,
            Some(std::fs::metadata(part).unwrap().len())
        );
    }

    #[tokio::test]
    async fn a_contradictory_resume_range_keeps_the_partial_resumable() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"0123456789abcdef".to_vec();
        let digest = digest_for(&bytes);
        let server = httptest::Server::run();
        server.expect(
            httptest::Expectation::matching(httptest::matchers::request::method_path(
                "GET",
                format!("/blobs/{digest}"),
            ))
            .respond_with(
                httptest::http::Response::builder()
                    .status(206)
                    .header("content-range", "bytes 4-15/16")
                    .body(bytes[8..].to_vec())
                    .unwrap(),
            ),
        );
        let cache = cache(dir.path()).await;
        let part = cache.partial_path(&digest).unwrap();
        std::fs::write(&part, &bytes[..8]).unwrap();
        let grant = DownloadGrant {
            url: server.url(&format!("/blobs/{digest}")).to_string(),
            token: "t".to_string(),
        };
        assert!(cache.get_or_fetch(&digest, &grant).await.is_err());
        let progress = cache.observe_progress(&digest).await;
        assert_eq!(progress.phase, CachePhase::Resumable);
        assert_eq!(progress.downloaded_bytes, Some(8));
        assert!(!progress.active);
    }

    #[tokio::test]
    async fn a_refused_grant_is_failed_without_a_partial() {
        let dir = tempfile::tempdir().unwrap();
        let digest = digest_for(b"refused image");
        let server = httptest::Server::run();
        server.expect(
            httptest::Expectation::matching(httptest::matchers::request::method_path(
                "GET",
                format!("/blobs/{digest}"),
            ))
            .respond_with(
                httptest::http::Response::builder()
                    .status(403)
                    .body(Vec::new())
                    .unwrap(),
            ),
        );
        let cache = cache(dir.path()).await;
        let grant = DownloadGrant {
            url: server.url(&format!("/blobs/{digest}")).to_string(),
            token: "expired".to_string(),
        };
        assert!(cache.get_or_fetch(&digest, &grant).await.is_err());
        let progress = cache.observe_progress(&digest).await;
        assert_eq!(progress.phase, CachePhase::Failed);
        assert!(!progress.active);
        assert!(progress
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("403")));
        assert!(!cache.partial_path(&digest).unwrap().exists());
    }

    #[tokio::test]
    async fn verifying_is_active_but_not_verified() {
        let dir = tempfile::tempdir().unwrap();
        let cache = cache(dir.path()).await;
        let digest = digest_for(b"verifying image");
        cache.set_transfer(
            &digest,
            TransferState {
                phase: CachePhase::Verifying,
                downloaded_bytes: 1024,
                total_bytes: Some(1024),
                updated_at: SystemTime::now(),
                detail: None,
            },
        );
        let progress = cache.observe_progress(&digest).await;
        assert_eq!(progress.phase, CachePhase::Verifying);
        assert!(progress.active);
        assert_eq!(progress.downloaded_bytes, Some(1024));
        assert_eq!(progress.total_bytes, Some(1024));
        assert_ne!(progress.phase, CachePhase::Verified);
        cache.clear_transfer(&digest);
    }

    #[tokio::test]
    async fn two_consumers_share_one_active_transfer() {
        let dir = tempfile::tempdir().unwrap();
        let body = vec![1_u8; 512 * 1024];
        let digest = digest_for(&body);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server_body = body.clone();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                server_body.len()
            )
            .unwrap();
            let (first, second) = server_body.split_at(server_body.len() / 2);
            stream.write_all(first).unwrap();
            stream.flush().unwrap();
            std::thread::sleep(Duration::from_millis(300));
            stream.write_all(second).unwrap();
        });
        let cache = Arc::new(cache(dir.path()).await);
        let grant = DownloadGrant {
            url: format!("http://{address}/blobs/{digest}"),
            token: "t".to_string(),
        };
        let first = tokio::spawn({
            let cache = Arc::clone(&cache);
            let grant = grant.clone();
            let digest = digest.clone();
            async move { cache.get_or_fetch(&digest, &grant).await }
        });
        let second = tokio::spawn({
            let cache = Arc::clone(&cache);
            let grant = grant.clone();
            let digest = digest.clone();
            async move { cache.get_or_fetch(&digest, &grant).await }
        });

        let mut observed = None;
        for _ in 0..200 {
            let progress = cache.observe_progress(&digest).await;
            if progress.phase == CachePhase::Downloading
                && progress.downloaded_bytes.unwrap_or(0) > 0
            {
                observed = Some(progress);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let observed = observed.expect("the shared transfer is observable");
        assert!(observed.active);
        assert!(observed.downloaded_bytes.unwrap() < body.len() as u64);

        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
        server.join().unwrap();
        assert_eq!(cache.fetch_count(), 1);
        assert_eq!(
            cache.observe_progress(&digest).await.phase,
            CachePhase::Verified
        );
    }
}
