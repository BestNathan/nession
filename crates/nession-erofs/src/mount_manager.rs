//! Shared, recoverable content-addressed EROFS mount management (#3449).
//!
//! One verified `sha256:<digest>` normally corresponds to **one physical
//! read-only FUSE mount per manager instance** (one Agent identity and mount
//! namespace). Independent consumers acquire leases; a lease never carries
//! unmount authority. Only the manager unmounts, and only after the last
//! identified consumer is gone and a strict, bounded unmount succeeds.
//!
//! The manager owns:
//!
//! - the canonical mountpoint derived from the verified digest;
//! - the state machine (`Mounting / Mounted / Idle / Unmounting / Failed /
//!   Orphaned`) with serialized mount/unmount transitions;
//! - bounded helper lifecycle and verified rollback on mount failure;
//! - durable mount identity (digest, mountpoint, generation, source) used to
//!   fence stale records and to reclaim orphans without ever adopting an
//!   unidentified mountpoint by digest guess;
//! - optional backing-blob pins held for the full physical mount lifetime.
//!
//! Queries never acquire ownership. Lookups are read-only and report the
//! observed mountinfo state, generation, consumer count and failure detail.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::digest::{file_digest, is_valid_digest, DIGEST_PREFIX};
use crate::mount::{self, MountSettings};

/// How long an acquire waits for another same-digest transition to finish.
pub const ACQUIRE_WAIT_TIMEOUT: Duration = Duration::from_secs(30);

/// A guard that keeps a verified backing blob from being evicted.
pub trait BlobPinGuard: Send + Sync {}

/// Pins one verified digest. The Agent supplies an adapter over its cache.
pub trait BlobPinner: Send + Sync {
    fn pin(&self, digest: &str) -> Result<Box<dyn BlobPinGuard>>;
}

/// A caller-verified image identity. Construction validates the digest shape;
/// the manager independently re-verifies the bytes before the first mount.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedImage {
    digest: String,
    source: PathBuf,
}

impl VerifiedImage {
    pub fn new(digest: impl Into<String>, source: impl Into<PathBuf>) -> Result<Self> {
        let digest = digest.into();
        if !is_valid_digest(&digest) {
            anyhow::bail!("invalid EROFS image digest {digest}");
        }
        let source = source.into();
        if !source.is_absolute() {
            anyhow::bail!("EROFS image source {} must be absolute", source.display());
        }
        Ok(Self { digest, source })
    }

    pub fn digest(&self) -> &str {
        &self.digest
    }

    pub fn source(&self) -> &Path {
        &self.source
    }
}

/// Manager construction input.
pub struct MountManagerConfig {
    /// Manager-owned root. Physical mountpoints live under `<root>/mounts`, and
    /// durable identity sidecars under `<root>/state`.
    pub root: PathBuf,
    pub settings: MountSettings,
    /// Canonical source roots a mount may come from. Empty means the caller
    /// deliberately accepts any regular file it verified.
    pub authorized_roots: Vec<PathBuf>,
    /// Optional cache pin source held for each physical mount lifetime.
    pub pinner: Option<Arc<dyn BlobPinner>>,
}

/// One consumer identity persisted in a sandbox execution record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsumerRef {
    pub digest: String,
    pub execution_id: String,
    pub generation: String,
}

/// The observable state of one managed digest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MountState {
    Unmounted,
    Mounting,
    Mounted,
    Idle,
    Unmounting,
    Failed,
    Orphaned,
}

/// Read-only status for one digest or physical mountpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MountStatus {
    pub digest: String,
    pub mountpoint: PathBuf,
    pub generation: Option<String>,
    pub state: MountState,
    /// `true` only when mountinfo currently reports an EROFS FUSE mount.
    pub mounted: bool,
    pub consumers: usize,
    pub failure: Option<String>,
}

/// The result of restart reconciliation.
#[derive(Debug, Default, Clone)]
pub struct MountRecoveryReport {
    /// `(digest, execution_id)` pairs whose live consumer was adopted.
    pub adopted: Vec<(String, String)>,
    /// `(digest, reason)` pairs that could not be adopted or served.
    pub unavailable: Vec<(String, String)>,
    /// Digests whose physical mount was reclaimed.
    pub reclaimed: Vec<String>,
    /// `(digest, reason)` pairs whose reclamation failed and remains retryable.
    pub reclaim_failed: Vec<(String, String)>,
}

impl MountRecoveryReport {
    pub fn evidence_lines(&self) -> Vec<String> {
        let mut lines = Vec::new();
        for (digest, execution) in &self.adopted {
            lines.push(format!("adopted={digest}:{execution}"));
        }
        for (digest, reason) in &self.unavailable {
            lines.push(format!("unavailable={digest}:{reason}"));
        }
        for digest in &self.reclaimed {
            lines.push(format!("reclaimed={digest}"));
        }
        for (digest, reason) in &self.reclaim_failed {
            lines.push(format!("reclaim-failed={digest}:{reason}"));
        }
        lines
    }
}

/// Durable mount identity. A sidecar exists only for a mount this manager
/// created; an unidentified mountpoint is never adopted by digest guess.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct MountIdentity {
    digest: String,
    mountpoint: PathBuf,
    generation: String,
    source: PathBuf,
    created_at: u64,
}

#[derive(Debug, Clone)]
struct Consumer {
    execution_id: String,
    generation: String,
}

struct EntryState {
    phase: MountState,
    generation: Option<String>,
    consumers: HashMap<u64, Consumer>,
    next_token: u64,
    failure: Option<String>,
    pin: Option<Box<dyn BlobPinGuard>>,
}

struct MountEntry {
    digest: String,
    mountpoint: PathBuf,
    identity_path: PathBuf,
    state: Mutex<EntryState>,
    transitioned: Condvar,
}

impl MountEntry {
    fn new(root: &Path, digest: &str) -> Self {
        let hex = digest.strip_prefix(DIGEST_PREFIX).unwrap_or(digest);
        Self {
            digest: digest.to_string(),
            mountpoint: root.join("mounts").join(hex),
            identity_path: root.join("state").join(format!("{hex}.json")),
            state: Mutex::new(EntryState {
                phase: MountState::Unmounted,
                generation: None,
                consumers: HashMap::new(),
                next_token: 0,
                failure: None,
                pin: None,
            }),
            transitioned: Condvar::new(),
        }
    }
}

struct ManagerInner {
    root: PathBuf,
    settings: MountSettings,
    authorized_roots: Vec<PathBuf>,
    pinner: Option<Arc<dyn BlobPinner>>,
    entries: Mutex<HashMap<String, Arc<MountEntry>>>,
    adoptions: AtomicU64,
}

/// The one owner of physical shared EROFS mounts for this Agent identity.
pub struct MountManager {
    inner: Arc<ManagerInner>,
}

impl std::fmt::Debug for MountManager {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MountManager")
            .field("root", &self.inner.root)
            .finish()
    }
}

impl MountManager {
    /// Open the manager root and prepare its private mount/state directories.
    ///
    /// Opening performs no mount and adopts nothing.
    pub fn open(config: MountManagerConfig) -> Result<Arc<Self>> {
        let root = config.root;
        if !root.is_absolute() {
            anyhow::bail!("the EROFS mount manager root must be absolute");
        }
        for directory in [root.join("mounts"), root.join("state")] {
            std::fs::create_dir_all(&directory).with_context(|| {
                format!(
                    "create EROFS mount manager directory {}",
                    directory.display()
                )
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ =
                    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700));
            }
        }
        let authorized_roots = config
            .authorized_roots
            .into_iter()
            .map(|path| std::fs::canonicalize(&path).unwrap_or(path))
            .collect();
        Ok(Arc::new(Self {
            inner: Arc::new(ManagerInner {
                root,
                settings: config.settings,
                authorized_roots,
                pinner: config.pinner,
                entries: Mutex::new(HashMap::new()),
                adoptions: AtomicU64::new(0),
            }),
        }))
    }

    /// The manager-owned root.
    pub fn root(&self) -> &Path {
        &self.inner.root
    }

    /// How many durable consumers this manager adopted since it opened.
    pub fn adopted_consumers(&self) -> u64 {
        self.inner.adoptions.load(Ordering::Relaxed)
    }

    /// The canonical physical mountpoint for a digest.
    pub fn mountpoint_for(&self, digest: &str) -> Result<PathBuf> {
        if !is_valid_digest(digest) {
            anyhow::bail!("invalid EROFS image digest {digest}");
        }
        let hex = digest.strip_prefix(DIGEST_PREFIX).unwrap_or(digest);
        Ok(self.inner.root.join("mounts").join(hex))
    }

    /// Read-only lookup by digest. Never creates a mount or a consumer.
    pub fn lookup(&self, digest: &str) -> Option<MountStatus> {
        let entry = self.entry(digest)?;
        Some(status_of(&entry))
    }

    /// Read-only lookup by canonical physical mountpoint. An unknown path is
    /// never resolved by guessing a digest.
    pub fn lookup_by_mountpoint(&self, mountpoint: &Path) -> Option<MountStatus> {
        let canonical =
            std::fs::canonicalize(mountpoint).unwrap_or_else(|_| mountpoint.to_path_buf());
        let entry = {
            let entries = lock(&self.inner.entries);
            entries
                .values()
                .find(|entry| entry.mountpoint == canonical || entry.mountpoint == mountpoint)
                .cloned()
        }?;
        Some(status_of(&entry))
    }

    /// Acquire one consumer-scoped lease for a verified image.
    ///
    /// Acquisitions of the same digest are single-flight. The returned lease
    /// can release only its own consumer; it cannot unmount the shared mount.
    pub fn acquire(&self, image: &VerifiedImage, execution_id: &str) -> Result<MountLease> {
        if execution_id.trim().is_empty() {
            anyhow::bail!("a shared EROFS mount consumer needs a non-empty execution id");
        }
        let source = self.verify_source(image)?;
        let entry = self.entry_or_create(image.digest());
        let deadline = std::time::Instant::now() + ACQUIRE_WAIT_TIMEOUT;
        loop {
            let mut state = lock(&entry.state);
            match state.phase {
                MountState::Mounted | MountState::Idle => {
                    let Some(generation) = state.generation.clone() else {
                        state.phase = MountState::Unmounted;
                        continue;
                    };
                    if !mount::is_erofs_mount(&entry.mountpoint) {
                        let failure = format!(
                            "the shared EROFS mount {} for {} disappeared",
                            entry.mountpoint.display(),
                            entry.digest
                        );
                        if state.consumers.is_empty() {
                            // No identified consumer remains: remount is safe.
                            state.phase = MountState::Unmounted;
                            state.generation = None;
                            state.failure = None;
                            state.pin = None;
                            drop(state);
                            continue;
                        }
                        state.phase = MountState::Failed;
                        state.failure = Some(failure.clone());
                        entry.transitioned.notify_all();
                        anyhow::bail!(
                            "{failure}; {} consumer(s) still hold it",
                            state.consumers.len()
                        );
                    }
                    let token = adopt_token(&mut state, execution_id, &generation);
                    state.failure = None;
                    drop(state);
                    return Ok(MountLease::new(
                        Arc::clone(&self.inner),
                        entry,
                        token,
                        generation,
                        execution_id,
                    ));
                }
                MountState::Mounting | MountState::Unmounting => {
                    let now = std::time::Instant::now();
                    if now >= deadline {
                        anyhow::bail!(
                            "timed out waiting for the shared EROFS mount of {}",
                            entry.digest
                        );
                    }
                    let wait = (deadline - now).min(Duration::from_millis(200));
                    let (guard, timeout) = entry
                        .transitioned
                        .wait_timeout(state, wait)
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    drop(guard);
                    if timeout.timed_out() && std::time::Instant::now() >= deadline {
                        anyhow::bail!(
                            "timed out waiting for the shared EROFS mount of {}",
                            entry.digest
                        );
                    }
                }
                MountState::Failed => {
                    if !state.consumers.is_empty() {
                        let failure = state
                            .failure
                            .clone()
                            .unwrap_or_else(|| "a previous mount attempt failed".to_string());
                        anyhow::bail!(
                            "the shared EROFS mount of {} is unusable while {} consumer(s) remain: {failure}",
                            entry.digest,
                            state.consumers.len()
                        );
                    }
                    // No consumer remains: retry from a clean transition. The
                    // unmount is retried before remounting so a failed rollback
                    // cannot leave two mounts aliased.
                    state.phase = MountState::Unmounting;
                    drop(state);
                    let reclaim =
                        mount::unmount_shared(&self.inner.settings.fusermount, &entry.mountpoint);
                    let mut state = lock(&entry.state);
                    match reclaim {
                        Ok(()) => {
                            state.phase = MountState::Unmounted;
                            state.generation = None;
                            state.failure = None;
                            state.pin = None;
                            remove_identity(&entry.identity_path);
                            entry.transitioned.notify_all();
                        }
                        Err(error) => {
                            state.phase = MountState::Failed;
                            state.failure = Some(format!("{error:#}"));
                            entry.transitioned.notify_all();
                            return Err(error);
                        }
                    }
                }
                MountState::Orphaned => {
                    anyhow::bail!(
                        "the shared EROFS mount of {} is orphaned; it is never adopted by digest guess",
                        entry.digest
                    );
                }
                MountState::Unmounted => {
                    state.phase = MountState::Mounting;
                    drop(state);
                    let outcome = self.mount_entry(&entry, &source);
                    let mut state = lock(&entry.state);
                    match outcome {
                        Ok((generation, pin)) => {
                            state.phase = MountState::Mounted;
                            state.generation = Some(generation.clone());
                            state.pin = pin;
                            state.failure = None;
                            let token = adopt_token(&mut state, execution_id, &generation);
                            entry.transitioned.notify_all();
                            drop(state);
                            return Ok(MountLease::new(
                                Arc::clone(&self.inner),
                                entry,
                                token,
                                generation,
                                execution_id,
                            ));
                        }
                        Err(error) => {
                            state.phase = MountState::Failed;
                            state.failure = Some(format!("{error:#}"));
                            entry.transitioned.notify_all();
                            return Err(error);
                        }
                    }
                }
            }
        }
    }

    /// Release every consumer of `execution_id` for one digest (recovery path).
    ///
    /// Idempotent: a consumer that was already released is ignored.
    pub fn release_consumers(
        &self,
        digest: &str,
        execution_id: &str,
        generation: Option<&str>,
    ) -> Result<()> {
        let Some(entry) = self.entry(digest) else {
            return Ok(());
        };
        let mut state = lock(&entry.state);
        let before = state.consumers.len();
        state.consumers.retain(|_, consumer| {
            !(consumer.execution_id == execution_id
                && generation.is_none_or(|expected| consumer.generation == expected))
        });
        if state.consumers.len() == before {
            // A previous release removed the consumer but its strict unmount
            // failed. Retrying the reclaim is the only way the retained mount
            // and its durable identity eventually go away.
            if state.phase == MountState::Failed && state.consumers.is_empty() {
                return reclaim_if_unused(&self.inner, &entry, &mut state);
            }
            return Ok(());
        }
        reclaim_if_unused(&self.inner, &entry, &mut state)
    }

    /// Adopt durable consumers recovered from authoritative execution records.
    ///
    /// A consumer is adopted only when the sidecar identity matches the
    /// requested digest/generation and mountinfo still reports the EROFS FUSE
    /// mount. A missing or stale mount is reported unavailable, never served.
    pub fn adopt_consumers(&self, consumers: &[ConsumerRef]) -> MountRecoveryReport {
        let mut report = MountRecoveryReport::default();
        for consumer in consumers {
            if !is_valid_digest(&consumer.digest) {
                report
                    .unavailable
                    .push((consumer.digest.clone(), "invalid digest".to_string()));
                continue;
            }
            let entry = self.entry_or_create(&consumer.digest);
            let identity = match read_identity(&entry.identity_path) {
                Ok(identity) => identity,
                Err(error) => {
                    report
                        .unavailable
                        .push((consumer.digest.clone(), format!("{error:#}")));
                    continue;
                }
            };
            if identity.digest != consumer.digest {
                report.unavailable.push((
                    consumer.digest.clone(),
                    format!(
                        "durable mount identity names {}, not {}",
                        identity.digest, consumer.digest
                    ),
                ));
                continue;
            }
            if identity.generation != consumer.generation {
                report.unavailable.push((
                    consumer.digest.clone(),
                    format!(
                        "generation mismatch: durable mount is {}, record expects {}",
                        identity.generation, consumer.generation
                    ),
                ));
                continue;
            }
            if identity.mountpoint != entry.mountpoint {
                report.unavailable.push((
                    consumer.digest.clone(),
                    format!(
                        "durable mountpoint {} does not match the canonical {}",
                        identity.mountpoint.display(),
                        entry.mountpoint.display()
                    ),
                ));
                continue;
            }
            if !mount::is_erofs_mount(&entry.mountpoint) {
                report.unavailable.push((
                    consumer.digest.clone(),
                    "the physical EROFS mount is no longer present".to_string(),
                ));
                continue;
            }
            let mut state = lock(&entry.state);
            if state.consumers.values().any(|known| {
                known.execution_id == consumer.execution_id
                    && known.generation == consumer.generation
            }) {
                continue;
            }
            if matches!(state.phase, MountState::Unmounting) {
                report.unavailable.push((
                    consumer.digest.clone(),
                    "the physical mount is being unmounted".to_string(),
                ));
                continue;
            }
            if state.pin.is_none() {
                if let Some(pinner) = &self.inner.pinner {
                    match pinner.pin(&consumer.digest) {
                        Ok(pin) => state.pin = Some(pin),
                        Err(error) => {
                            report.unavailable.push((
                                consumer.digest.clone(),
                                format!("cannot pin the backing blob: {error:#}"),
                            ));
                            continue;
                        }
                    }
                }
            }
            let token = adopt_token(&mut state, &consumer.execution_id, &consumer.generation);
            let _ = token;
            state.phase = MountState::Mounted;
            state.generation = Some(consumer.generation.clone());
            state.failure = None;
            entry.transitioned.notify_all();
            self.inner.adoptions.fetch_add(1, Ordering::Relaxed);
            report
                .adopted
                .push((consumer.digest.clone(), consumer.execution_id.clone()));
        }
        report
    }

    /// Reclaim manager-owned physical mounts that no surviving execution
    /// record protects and that have no identified consumer.
    ///
    /// This discovers both a mount whose sidecar was persisted and a mount
    /// created just before a crash (no sidecar). Neither is adopted.
    pub fn reclaim_orphans(&self, protected_digests: &HashSet<String>) -> MountRecoveryReport {
        let mut report = MountRecoveryReport::default();
        let mut sidecars: Vec<PathBuf> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(self.inner.root.join("state")) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|extension| extension.to_str()) == Some("json") {
                    sidecars.push(path);
                }
            }
        }
        for identity_path in sidecars {
            let identity = match read_identity(&identity_path) {
                Ok(identity) => identity,
                Err(error) => {
                    // An unreadable sidecar proves no identity; the mount is
                    // left untouched for an operator instead of guessed at.
                    report.reclaim_failed.push((
                        identity_path.display().to_string(),
                        format!("unreadable mount identity: {error:#}"),
                    ));
                    continue;
                }
            };
            if protected_digests.contains(&identity.digest) {
                continue;
            }
            if !is_valid_digest(&identity.digest) {
                // A corrupt or tampered sidecar must never derive a path that
                // could point outside the manager root.
                report.reclaim_failed.push((
                    identity_path.display().to_string(),
                    format!("invalid digest in mount identity: {}", identity.digest),
                ));
                continue;
            }
            let entry = self.entry_or_create(&identity.digest);
            if identity.mountpoint != entry.mountpoint {
                // A sidecar that does not name this digest's canonical
                // mountpoint is not trusted to reclaim anything.
                report.reclaim_failed.push((
                    identity.digest,
                    format!(
                        "identity mountpoint {} is not the canonical {}",
                        identity.mountpoint.display(),
                        entry.mountpoint.display()
                    ),
                ));
                continue;
            }
            let in_use = {
                let state = lock(&entry.state);
                !state.consumers.is_empty()
            };
            if in_use {
                continue;
            }
            if !mount::is_erofs_mount(&entry.mountpoint) {
                let mut state = lock(&entry.state);
                state.phase = MountState::Unmounted;
                state.generation = None;
                state.failure = None;
                state.pin = None;
                drop(state);
                remove_identity(&entry.identity_path);
                report.reclaimed.push(identity.digest);
                continue;
            }
            let mut state = lock(&entry.state);
            state.phase = MountState::Unmounting;
            match mount::unmount_shared(&self.inner.settings.fusermount, &entry.mountpoint) {
                Ok(()) => {
                    state.phase = MountState::Unmounted;
                    state.generation = None;
                    state.failure = None;
                    state.pin = None;
                    drop(state);
                    remove_identity(&entry.identity_path);
                    report.reclaimed.push(identity.digest.clone());
                }
                Err(error) => {
                    state.phase = MountState::Failed;
                    state.failure = Some(format!("{error:#}"));
                    entry.transitioned.notify_all();
                    report
                        .reclaim_failed
                        .push((identity.digest.clone(), format!("{error:#}")));
                }
            }
        }

        // Crash window: the mount exists but its sidecar was never persisted.
        if let Ok(entries) = std::fs::read_dir(self.inner.root.join("mounts")) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(hex) = path.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    continue;
                }
                let digest = format!("{DIGEST_PREFIX}{hex}");
                if protected_digests.contains(&digest) {
                    continue;
                }
                let known_identity = self
                    .entry(&digest)
                    .map(|entry| entry.identity_path.exists())
                    .unwrap_or(false);
                if known_identity || !mount::is_erofs_mount(&path) {
                    continue;
                }
                let entry = self.entry_or_create(&digest);
                let mut state = lock(&entry.state);
                if !state.consumers.is_empty() {
                    continue;
                }
                state.phase = MountState::Unmounting;
                match mount::unmount_shared(&self.inner.settings.fusermount, &path) {
                    Ok(()) => {
                        state.phase = MountState::Unmounted;
                        state.generation = None;
                        state.failure = None;
                        state.pin = None;
                        drop(state);
                        report.reclaimed.push(digest);
                    }
                    Err(error) => {
                        state.phase = MountState::Failed;
                        state.failure = Some(format!("{error:#}"));
                        entry.transitioned.notify_all();
                        report.reclaim_failed.push((digest, format!("{error:#}")));
                    }
                }
            }
        }
        report
    }

    fn entry(&self, digest: &str) -> Option<Arc<MountEntry>> {
        let entries = lock(&self.inner.entries);
        entries.get(digest).cloned()
    }

    fn entry_or_create(&self, digest: &str) -> Arc<MountEntry> {
        let mut entries = lock(&self.inner.entries);
        if let Some(entry) = entries.get(digest) {
            return Arc::clone(entry);
        }
        let entry = Arc::new(MountEntry::new(&self.inner.root, digest));
        entries.insert(digest.to_string(), Arc::clone(&entry));
        entry
    }

    fn verify_source(&self, image: &VerifiedImage) -> Result<PathBuf> {
        let metadata = std::fs::symlink_metadata(&image.source)
            .with_context(|| format!("EROFS image {} does not exist", image.source.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            anyhow::bail!(
                "EROFS image {} must be a regular file, not a symlink",
                image.source.display()
            );
        }
        let canonical = std::fs::canonicalize(&image.source)
            .with_context(|| format!("resolve EROFS image {}", image.source.display()))?;
        if !self.inner.authorized_roots.is_empty()
            && !self
                .inner
                .authorized_roots
                .iter()
                .any(|root| canonical.starts_with(root))
        {
            anyhow::bail!(
                "EROFS image {} is outside the manager-authorized source roots",
                canonical.display()
            );
        }
        Ok(canonical)
    }

    fn mount_entry(
        &self,
        entry: &MountEntry,
        source: &Path,
    ) -> Result<(String, Option<Box<dyn BlobPinGuard>>)> {
        let actual = file_digest(source)
            .with_context(|| format!("verify EROFS image {}", source.display()))?;
        if actual != entry.digest {
            anyhow::bail!(
                "EROFS image {} digest {actual} does not match the requested digest {}",
                source.display(),
                entry.digest
            );
        }
        let pin = match &self.inner.pinner {
            Some(pinner) => Some(
                pinner
                    .pin(&entry.digest)
                    .with_context(|| format!("pin EROFS image {}", entry.digest))?,
            ),
            None => None,
        };
        let generation = uuid::Uuid::new_v4().to_string();
        let identity = MountIdentity {
            digest: entry.digest.clone(),
            mountpoint: entry.mountpoint.clone(),
            generation: generation.clone(),
            source: source.to_path_buf(),
            created_at: now_seconds(),
        };
        mount::mount_shared(source, &entry.mountpoint, &self.inner.settings)?;
        if let Err(error) = write_identity(&entry.identity_path, &identity) {
            let rollback =
                mount::unmount_shared(&self.inner.settings.fusermount, &entry.mountpoint);
            return match rollback {
                Ok(()) => Err(error),
                Err(rollback) => Err(error.context(format!(
                    "the mount succeeded but its durable identity failed; verified rollback \
                     also failed, so the mount remains orphaned: {rollback:#}"
                ))),
            };
        }
        Ok((generation, pin))
    }
}

/// A non-unmount-capable consumer lease. Dropping or explicitly releasing it
/// removes exactly this consumer token; only the manager may unmount.
pub struct MountLease {
    inner: Arc<ManagerInner>,
    entry: Arc<MountEntry>,
    token: u64,
    generation: String,
    execution_id: String,
    released: bool,
}

impl std::fmt::Debug for MountLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MountLease")
            .field("digest", &self.entry.digest)
            .field("mountpoint", &self.entry.mountpoint)
            .field("generation", &self.generation)
            .field("execution_id", &self.execution_id)
            .finish()
    }
}

impl MountLease {
    fn new(
        inner: Arc<ManagerInner>,
        entry: Arc<MountEntry>,
        token: u64,
        generation: String,
        execution_id: &str,
    ) -> Self {
        Self {
            inner,
            entry,
            token,
            generation,
            execution_id: execution_id.to_string(),
            released: false,
        }
    }

    pub fn mountpoint(&self) -> &Path {
        &self.entry.mountpoint
    }

    pub fn digest(&self) -> &str {
        &self.entry.digest
    }

    pub fn generation(&self) -> &str {
        &self.generation
    }

    pub fn execution_id(&self) -> &str {
        &self.execution_id
    }

    /// Release this consumer. The final consumer triggers a bounded, strict
    /// physical unmount; a failure is retained on the entry for retry.
    pub fn release(mut self) -> Result<()> {
        self.released = true;
        release_token(&self.inner, &self.entry, self.token)
    }
}

impl Drop for MountLease {
    fn drop(&mut self) {
        if !self.released {
            let _ = release_token(&self.inner, &self.entry, self.token);
        }
    }
}

fn release_token(inner: &ManagerInner, entry: &MountEntry, token: u64) -> Result<()> {
    let mut state = lock(&entry.state);
    if state.consumers.remove(&token).is_none() {
        return Ok(());
    }
    reclaim_if_unused(inner, entry, &mut state)
}

/// Remove the physical mount when this was the last identified consumer.
///
/// The caller holds the entry state lock so a concurrent acquire observes
/// either the mounted state with a consumer or the unmounted state; it can
/// never start a second mount over a live one.
fn reclaim_if_unused(
    inner: &ManagerInner,
    entry: &MountEntry,
    state: &mut EntryState,
) -> Result<()> {
    if !state.consumers.is_empty() {
        state.phase = MountState::Mounted;
        return Ok(());
    }
    if state.phase == MountState::Unmounted {
        return Ok(());
    }
    state.phase = MountState::Unmounting;
    match mount::unmount_shared(&inner.settings.fusermount, &entry.mountpoint) {
        Ok(()) => {
            state.phase = MountState::Unmounted;
            state.generation = None;
            state.failure = None;
            state.pin = None;
            remove_identity(&entry.identity_path);
            entry.transitioned.notify_all();
            Ok(())
        }
        Err(error) => {
            // Retain the mount, the identity and the pin: the resource is
            // still live and must stay durable for a later retry.
            state.phase = MountState::Failed;
            state.failure = Some(format!("{error:#}"));
            entry.transitioned.notify_all();
            Err(error)
        }
    }
}

fn adopt_token(state: &mut EntryState, execution_id: &str, generation: &str) -> u64 {
    let token = state.next_token;
    state.next_token += 1;
    state.consumers.insert(
        token,
        Consumer {
            execution_id: execution_id.to_string(),
            generation: generation.to_string(),
        },
    );
    state.phase = MountState::Mounted;
    token
}

fn status_of(entry: &MountEntry) -> MountStatus {
    let state = lock(&entry.state);
    let mounted = mount::is_erofs_mount(&entry.mountpoint);
    let phase = if state.phase == MountState::Mounted && state.consumers.is_empty() {
        MountState::Idle
    } else {
        state.phase
    };
    MountStatus {
        digest: entry.digest.clone(),
        mountpoint: entry.mountpoint.clone(),
        generation: state.generation.clone(),
        state: phase,
        mounted,
        consumers: state.consumers.len(),
        failure: state.failure.clone(),
    }
}

fn read_identity(path: &Path) -> Result<MountIdentity> {
    let bytes =
        std::fs::read(path).with_context(|| format!("read mount identity {}", path.display()))?;
    serde_json::from_slice(&bytes)
        .with_context(|| format!("parse mount identity {}", path.display()))
}

fn write_identity(path: &Path, identity: &MountIdentity) -> Result<()> {
    let bytes =
        serde_json::to_vec_pretty(identity).context("serialize the durable mount identity")?;
    // A stale temporary from a crashed process must not block every later
    // mount of this digest, so the name is unique rather than pid-based.
    let temporary = path.with_extension(format!("json.tmp.{}", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .with_context(|| format!("create mount identity {}", temporary.display()))?;
    use std::io::Write as _;
    file.write_all(&bytes)
        .with_context(|| format!("write mount identity {}", temporary.display()))?;
    file.sync_all().ok();
    std::fs::rename(&temporary, path)
        .with_context(|| format!("publish mount identity {}", path.display()))?;
    Ok(())
}

fn remove_identity(path: &Path) {
    let _ = std::fs::remove_file(path);
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::digest::digest_of_bytes;
    use std::os::unix::fs::PermissionsExt;

    fn executable(path: &Path, body: &str) {
        std::fs::write(path, body).unwrap();
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions).unwrap();
    }

    fn manager(root: &Path, erofsfuse: &str, authorized: Vec<PathBuf>) -> Arc<MountManager> {
        let helper = root.join("erofsfuse");
        let fusermount = root.join("fusermount3");
        executable(&helper, erofsfuse);
        executable(&fusermount, "#!/bin/sh\nexit 0\n");
        MountManager::open(MountManagerConfig {
            root: root.join("mounts-root"),
            settings: MountSettings::new(helper, fusermount),
            authorized_roots: authorized,
            pinner: None,
        })
        .unwrap()
    }

    fn image(root: &Path, bytes: &[u8]) -> (PathBuf, String) {
        let images = root.join("images");
        std::fs::create_dir_all(&images).unwrap();
        let path = images.join("image.erofs");
        std::fs::write(&path, bytes).unwrap();
        (path, digest_of_bytes(bytes))
    }

    #[test]
    fn lookup_is_read_only_and_unknown_digests_have_no_status() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(root.path(), "#!/bin/sh\nexit 0\n", Vec::new());
        let digest = format!("sha256:{}", "a".repeat(64));
        assert!(manager.lookup(&digest).is_none());
        assert!(manager
            .lookup_by_mountpoint(&root.path().join("not-a-managed-mount"))
            .is_none());
        assert!(!root
            .path()
            .join("mounts-root/mounts")
            .join(&digest[7..])
            .exists());
    }

    #[test]
    fn invalid_and_unauthorized_images_are_refused_before_any_helper_runs() {
        let root = tempfile::tempdir().unwrap();
        assert!(VerifiedImage::new("not-a-digest", "/tmp/image").is_err());
        assert!(
            VerifiedImage::new(format!("sha256:{}", "a".repeat(64)), "relative/image").is_err()
        );

        let allowed = root.path().join("allowed");
        std::fs::create_dir_all(&allowed).unwrap();
        let (source, digest) = image(root.path(), b"authorized bytes");
        let manager = manager(root.path(), "#!/bin/sh\nexit 0\n", vec![allowed]);
        let verified = VerifiedImage::new(digest, source).unwrap();
        let error = manager.acquire(&verified, "exec-1").unwrap_err();
        assert!(
            format!("{error:#}").contains("outside the manager-authorized source roots"),
            "{error:#}"
        );
        assert!(manager.lookup(verified.digest()).is_none());
    }

    #[test]
    fn a_digest_mismatch_fails_closed_without_spawning_the_helper() {
        let root = tempfile::tempdir().unwrap();
        let (source, _) = image(root.path(), b"real bytes");
        let requested = digest_of_bytes(b"other bytes");
        let manager = manager(root.path(), "#!/bin/sh\nexit 0\n", Vec::new());
        let verified = VerifiedImage::new(requested.clone(), source).unwrap();
        let error = manager.acquire(&verified, "exec-1").unwrap_err();
        assert!(
            format!("{error:#}").contains("does not match the requested digest"),
            "{error:#}"
        );
        let status = manager.lookup(&requested).unwrap();
        assert_eq!(status.state, MountState::Failed);
        assert!(!status.mounted);
        assert_eq!(status.consumers, 0);
    }

    #[test]
    fn a_hanging_mount_helper_is_bounded_and_leaves_a_retryable_failure() {
        let root = tempfile::tempdir().unwrap();
        let (source, digest) = image(root.path(), b"bounded bytes");
        let manager = manager(root.path(), "#!/bin/sh\nsleep 60\n", Vec::new());
        let verified = VerifiedImage::new(digest.clone(), source).unwrap();
        let started = std::time::Instant::now();
        let error = manager.acquire(&verified, "exec-1").unwrap_err();
        let elapsed = started.elapsed();
        assert!(
            elapsed < crate::mount::PROBE_TIMEOUT + Duration::from_secs(8),
            "the helper wait must be bounded: {elapsed:?}"
        );
        assert!(
            format!("{error:#}").contains("did not return within"),
            "{error:#}"
        );
        let status = manager.lookup(&digest).unwrap();
        assert_eq!(status.state, MountState::Failed);
        assert_eq!(status.consumers, 0);
        assert!(status.failure.is_some());
    }

    #[test]
    fn adoption_never_serves_a_mount_without_matching_durable_identity() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(root.path(), "#!/bin/sh\nexit 0\n", Vec::new());
        let digest = format!("sha256:{}", "b".repeat(64));
        let report = manager.adopt_consumers(&[ConsumerRef {
            digest: digest.clone(),
            execution_id: "exec-1".to_string(),
            generation: "generation-1".to_string(),
        }]);
        assert!(report.adopted.is_empty());
        assert_eq!(report.unavailable.len(), 1);
        assert!(report.unavailable[0].1.contains("read mount identity"));
        let status = manager.lookup(&digest).unwrap();
        assert!(!status.mounted);
        assert_eq!(status.consumers, 0);
    }

    #[test]
    fn a_sidecar_with_an_invalid_digest_cannot_derive_an_unmount_target() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(root.path(), "#!/bin/sh\nexit 0\n", Vec::new());
        let hex = "d".repeat(64);
        let digest = format!("{DIGEST_PREFIX}{hex}");
        let entry = manager.entry_or_create(&digest);
        write_identity(
            &entry.identity_path,
            &MountIdentity {
                digest: "../../../escape".to_string(),
                mountpoint: entry.mountpoint.clone(),
                generation: "generation-1".to_string(),
                source: root.path().join("image"),
                created_at: 0,
            },
        )
        .unwrap();
        let report = manager.reclaim_orphans(&HashSet::new());
        assert!(report.reclaimed.is_empty());
        assert_eq!(report.reclaim_failed.len(), 1);
        assert!(report.reclaim_failed[0].1.contains("invalid digest"));
        assert!(
            entry.identity_path.exists(),
            "the identity is left for an operator"
        );
    }

    #[test]
    fn a_stale_identity_for_an_absent_mount_is_reported_and_reclaimed() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(root.path(), "#!/bin/sh\nexit 0\n", Vec::new());
        let digest = format!("sha256:{}", "c".repeat(64));
        let entry = manager.entry_or_create(&digest);
        write_identity(
            &entry.identity_path,
            &MountIdentity {
                digest: digest.clone(),
                mountpoint: entry.mountpoint.clone(),
                generation: "generation-1".to_string(),
                source: root.path().join("image"),
                created_at: 0,
            },
        )
        .unwrap();
        let report = manager.reclaim_orphans(&HashSet::new());
        assert_eq!(report.reclaimed, vec![digest]);
        assert!(!entry.identity_path.exists());
        assert!(!mount::is_mounted(&entry.mountpoint));
    }
}
