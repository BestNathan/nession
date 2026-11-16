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

/// A caller-verified referenced Composite view identity (#3697).
///
/// The identity is the Composite descriptor digest, never the top Manifest or
/// a data Blob digest. The primary metadata EROFS and every backing device are
/// independently verified before the first physical mount.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedComposite {
    identity: String,
    metadata: VerifiedImage,
    devices: Vec<VerifiedImage>,
}

impl VerifiedComposite {
    pub fn new(
        identity: impl Into<String>,
        metadata: VerifiedImage,
        devices: Vec<VerifiedImage>,
    ) -> Result<Self> {
        let identity = identity.into();
        if !is_valid_digest(&identity) {
            anyhow::bail!("invalid composite view identity {identity:?}");
        }
        if devices.is_empty() {
            anyhow::bail!("a composite view requires at least one backing device");
        }
        if devices.len() > crate::oci::composite::MAX_COMPOSITE_DEVICES {
            anyhow::bail!(
                "a composite view accepts at most {} backing devices",
                crate::oci::composite::MAX_COMPOSITE_DEVICES
            );
        }
        if identity == metadata.digest() || devices.iter().any(|device| device.digest() == identity)
        {
            anyhow::bail!("the composite view identity must differ from every data Blob digest");
        }
        let mut seen = HashSet::new();
        seen.insert(metadata.digest());
        for device in &devices {
            if !seen.insert(device.digest()) {
                anyhow::bail!("composite view repeats device {}", device.digest());
            }
        }
        Ok(Self {
            identity,
            metadata,
            devices,
        })
    }

    /// The composite view identity (Composite descriptor digest).
    pub fn identity(&self) -> &str {
        &self.identity
    }

    pub fn metadata(&self) -> &VerifiedImage {
        &self.metadata
    }

    pub fn devices(&self) -> &[VerifiedImage] {
        &self.devices
    }

    /// The component digests in physical order: metadata, then devices.
    pub fn component_digests(&self) -> Vec<String> {
        std::iter::once(self.metadata.digest().to_string())
            .chain(
                self.devices
                    .iter()
                    .map(|device| device.digest().to_string()),
            )
            .collect()
    }
}

/// One pinned composite component set held for the physical mount lifetime.
struct CompositePins(Vec<Box<dyn BlobPinGuard>>);

impl BlobPinGuard for CompositePins {}

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

/// The physical mount operations the manager performs.
///
/// Production always uses [`RealMountBackend`]; unit tests inject a fake so the
/// sharing/recovery state machine can be exercised without FUSE, root or the
/// `erofsfuse` helper. Keeping the seam here (rather than in `mount.rs`) leaves
/// the verified-mount contract itself untouched.
trait MountBackend: Send + Sync {
    fn mount(&self, image: &Path, mountpoint: &Path, settings: &MountSettings) -> Result<()>;
    /// Mount a primary EROFS image with ordered extra devices.
    fn mount_multi(
        &self,
        image: &Path,
        _devices: &[PathBuf],
        mountpoint: &Path,
        settings: &MountSettings,
    ) -> Result<()> {
        self.mount(image, mountpoint, settings)
    }
    fn unmount(&self, settings: &MountSettings, mountpoint: &Path) -> Result<()>;
    fn is_erofs_mount(&self, mountpoint: &Path) -> bool;
}

struct RealMountBackend;

impl MountBackend for RealMountBackend {
    fn mount(&self, image: &Path, mountpoint: &Path, settings: &MountSettings) -> Result<()> {
        mount::mount_shared(image, mountpoint, settings)
    }

    fn mount_multi(
        &self,
        image: &Path,
        devices: &[PathBuf],
        mountpoint: &Path,
        settings: &MountSettings,
    ) -> Result<()> {
        mount::mount_shared_with_devices(image, devices, mountpoint, settings)
    }

    fn unmount(&self, settings: &MountSettings, mountpoint: &Path) -> Result<()> {
        mount::unmount_shared(&settings.fusermount, mountpoint)
    }

    fn is_erofs_mount(&self, mountpoint: &Path) -> bool {
        mount::is_erofs_mount(mountpoint)
    }
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
    /// Present when the identity is a referenced Composite view.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    composite: Option<CompositeIdentity>,
}

/// The component closure recorded for a Composite view identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct CompositeIdentity {
    metadata_digest: String,
    device_digests: Vec<String>,
}

/// One verified source set for a physical mount transition.
struct MountSourceSet {
    identity: String,
    components: Vec<String>,
    composite: Option<CompositeIdentity>,
    primary: VerifiedImage,
    primary_path: PathBuf,
    device_paths: Vec<PathBuf>,
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
    backend: Arc<dyn MountBackend>,
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
        Self::open_with_backend_inner(config, Arc::new(RealMountBackend))
    }

    /// Test seam: exercise the manager against an injected mount backend.
    #[cfg(test)]
    fn open_with_mounts(
        config: MountManagerConfig,
        backend: Arc<dyn MountBackend>,
    ) -> Result<Arc<Self>> {
        Self::open_with_backend_inner(config, backend)
    }

    fn open_with_backend_inner(
        config: MountManagerConfig,
        backend: Arc<dyn MountBackend>,
    ) -> Result<Arc<Self>> {
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
                backend,
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
        Some(status_of(&self.inner, &entry))
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
        Some(status_of(&self.inner, &entry))
    }

    /// Acquire one consumer-scoped lease for a verified image.
    ///
    /// Acquisitions of the same digest are single-flight. The returned lease
    /// can release only its own consumer; it cannot unmount the shared mount.
    pub fn acquire(&self, image: &VerifiedImage, execution_id: &str) -> Result<MountLease> {
        let source = self.verify_source(image)?;
        self.acquire_sources(
            MountSourceSet {
                identity: image.digest().to_string(),
                components: vec![image.digest().to_string()],
                composite: None,
                primary: image.clone(),
                primary_path: source,
                device_paths: Vec::new(),
            },
            execution_id,
        )
    }

    /// Acquire one consumer-scoped lease over a verified referenced Composite
    /// view (#3697).
    ///
    /// The view identity is the Composite descriptor digest, never a data Blob
    /// digest. The primary metadata EROFS and every backing device are
    /// independently re-verified; every component is pinned for the physical
    /// mount lifetime. Consumers of one identity share one physical mount.
    pub fn acquire_composite(
        &self,
        composite: &VerifiedComposite,
        execution_id: &str,
    ) -> Result<MountLease> {
        if execution_id.trim().is_empty() {
            anyhow::bail!("a shared EROFS mount consumer needs a non-empty execution id");
        }
        let primary_path = self.verify_source(composite.metadata())?;
        let mut device_paths = Vec::with_capacity(composite.devices().len());
        for device in composite.devices() {
            device_paths.push(self.verify_source(device)?);
        }
        self.acquire_sources(
            MountSourceSet {
                identity: composite.identity().to_string(),
                components: composite.component_digests(),
                composite: Some(CompositeIdentity {
                    metadata_digest: composite.metadata().digest().to_string(),
                    device_digests: composite
                        .devices()
                        .iter()
                        .map(|device| device.digest().to_string())
                        .collect(),
                }),
                primary: composite.metadata().clone(),
                primary_path,
                device_paths,
            },
            execution_id,
        )
    }

    fn acquire_sources(&self, sources: MountSourceSet, execution_id: &str) -> Result<MountLease> {
        if execution_id.trim().is_empty() {
            anyhow::bail!("a shared EROFS mount consumer needs a non-empty execution id");
        }
        let entry = self.entry_or_create(&sources.identity);
        let deadline = std::time::Instant::now() + ACQUIRE_WAIT_TIMEOUT;
        loop {
            let mut state = lock(&entry.state);
            match state.phase {
                MountState::Mounted | MountState::Idle => {
                    let Some(generation) = state.generation.clone() else {
                        state.phase = MountState::Unmounted;
                        continue;
                    };
                    if sources.composite.is_some() {
                        // A view identity must never be served against a
                        // different component closure.
                        match read_identity(&entry.identity_path) {
                            Ok(identity) if identity.composite == sources.composite => {}
                            Ok(_) => anyhow::bail!(
                                "the shared EROFS mount of {} records a different Composite closure",
                                entry.digest
                            ),
                            Err(error) => anyhow::bail!(
                                "the shared EROFS mount of {} has no readable Composite identity: {error:#}",
                                entry.digest
                            ),
                        }
                    }
                    if !self.inner.backend.is_erofs_mount(&entry.mountpoint) {
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
                        sources.components,
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
                    let reclaim = self
                        .inner
                        .backend
                        .unmount(&self.inner.settings, &entry.mountpoint);
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
                    let outcome = self.mount_entry(&entry, &sources);
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
                                sources.components,
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
            if !self.inner.backend.is_erofs_mount(&entry.mountpoint) {
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
                let mut digests = vec![consumer.digest.clone()];
                if let Some(composite) = &identity.composite {
                    if !digests.contains(&composite.metadata_digest) {
                        digests.push(composite.metadata_digest.clone());
                    }
                    for digest in &composite.device_digests {
                        if !digests.contains(digest) {
                            digests.push(digest.clone());
                        }
                    }
                }
                match pin_all(self.inner.pinner.as_ref(), &digests) {
                    Ok(pin) => state.pin = pin,
                    Err(error) => {
                        report.unavailable.push((
                            consumer.digest.clone(),
                            format!("cannot pin the backing blob: {error:#}"),
                        ));
                        continue;
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
            if !self.inner.backend.is_erofs_mount(&entry.mountpoint) {
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
            match self
                .inner
                .backend
                .unmount(&self.inner.settings, &entry.mountpoint)
            {
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
                if known_identity || !self.inner.backend.is_erofs_mount(&path) {
                    continue;
                }
                let entry = self.entry_or_create(&digest);
                let mut state = lock(&entry.state);
                if !state.consumers.is_empty() {
                    continue;
                }
                state.phase = MountState::Unmounting;
                match self.inner.backend.unmount(&self.inner.settings, &path) {
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
        sources: &MountSourceSet,
    ) -> Result<(String, Option<Box<dyn BlobPinGuard>>)> {
        let actual = file_digest(&sources.primary_path)
            .with_context(|| format!("verify EROFS image {}", sources.primary_path.display()))?;
        if actual != sources.primary.digest() {
            anyhow::bail!(
                "EROFS image {} digest {actual} does not match the requested digest {}",
                sources.primary_path.display(),
                sources.primary.digest()
            );
        }
        for (path, digest) in sources
            .device_paths
            .iter()
            .zip(sources.components.iter().skip(1))
        {
            let actual = file_digest(path)
                .with_context(|| format!("verify EROFS device {}", path.display()))?;
            if &actual != digest {
                anyhow::bail!(
                    "EROFS device {} digest {actual} does not match the requested digest {digest}",
                    path.display()
                );
            }
        }
        let mut pin_digests = vec![entry.digest.clone()];
        for digest in &sources.components {
            if !pin_digests.contains(digest) {
                pin_digests.push(digest.clone());
            }
        }
        let pin = pin_all(self.inner.pinner.as_ref(), &pin_digests)?;
        let generation = uuid::Uuid::new_v4().to_string();
        let identity = MountIdentity {
            digest: entry.digest.clone(),
            mountpoint: entry.mountpoint.clone(),
            generation: generation.clone(),
            source: sources.primary_path.clone(),
            created_at: now_seconds(),
            composite: sources.composite.clone(),
        };
        self.inner.backend.mount_multi(
            &sources.primary_path,
            &sources.device_paths,
            &entry.mountpoint,
            &self.inner.settings,
        )?;
        if let Err(error) = write_identity(&entry.identity_path, &identity) {
            let rollback = self
                .inner
                .backend
                .unmount(&self.inner.settings, &entry.mountpoint);
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
    /// The data component digests of this view (metadata first for a
    /// Composite; the single layer digest for a v1 image).
    components: Vec<String>,
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
        components: Vec<String>,
    ) -> Self {
        Self {
            inner,
            entry,
            token,
            generation,
            execution_id: execution_id.to_string(),
            components,
            released: false,
        }
    }

    pub fn mountpoint(&self) -> &Path {
        &self.entry.mountpoint
    }

    pub fn digest(&self) -> &str {
        &self.entry.digest
    }

    /// The data component digests (metadata/device order for a Composite).
    pub fn component_digests(&self) -> &[String] {
        &self.components
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

fn pin_all(
    pinner: Option<&Arc<dyn BlobPinner>>,
    digests: &[String],
) -> Result<Option<Box<dyn BlobPinGuard>>> {
    let Some(pinner) = pinner else {
        return Ok(None);
    };
    let mut guards = Vec::with_capacity(digests.len());
    for digest in digests {
        guards.push(
            pinner
                .pin(digest)
                .with_context(|| format!("pin EROFS blob {digest}"))?,
        );
    }
    Ok(Some(Box::new(CompositePins(guards))))
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
    match inner.backend.unmount(&inner.settings, &entry.mountpoint) {
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

fn status_of(inner: &ManagerInner, entry: &MountEntry) -> MountStatus {
    let state = lock(&entry.state);
    let mounted = inner.backend.is_erofs_mount(&entry.mountpoint);
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
    file.sync_all()
        .with_context(|| format!("sync mount identity {}", temporary.display()))?;
    std::fs::rename(&temporary, path)
        .with_context(|| format!("publish mount identity {}", path.display()))?;
    // Persist the rename itself; a sidecar that vanishes after a crash would
    // turn a reconstructible consumer into an unexplained orphan.
    if let Some(parent) = path.parent() {
        if let Ok(directory) = std::fs::File::open(parent) {
            let _ = directory.sync_all();
        }
    }
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

    fn executable(path: &Path, body: &str) {
        crate::testing::install_via_a_child(path, body).unwrap();
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

    /// A backend that records successful mounts in memory. Sharing/recovery
    /// tests use this so they do not need FUSE, root or an `erofsfuse` binary.
    #[derive(Default)]
    struct FakeMountBackend {
        mounted: Mutex<HashSet<PathBuf>>,
        multi: Mutex<Vec<(PathBuf, Vec<PathBuf>)>>,
    }

    impl MountBackend for FakeMountBackend {
        fn mount(&self, _image: &Path, mountpoint: &Path, _settings: &MountSettings) -> Result<()> {
            std::fs::create_dir_all(mountpoint).unwrap();
            self.mounted
                .lock()
                .unwrap()
                .insert(mountpoint.to_path_buf());
            Ok(())
        }

        fn mount_multi(
            &self,
            _image: &Path,
            devices: &[PathBuf],
            mountpoint: &Path,
            _settings: &MountSettings,
        ) -> Result<()> {
            self.multi
                .lock()
                .unwrap()
                .push((mountpoint.to_path_buf(), devices.to_vec()));
            self.mount(_image, mountpoint, _settings)
        }

        fn unmount(&self, _settings: &MountSettings, mountpoint: &Path) -> Result<()> {
            self.mounted.lock().unwrap().remove(mountpoint);
            Ok(())
        }

        fn is_erofs_mount(&self, mountpoint: &Path) -> bool {
            self.mounted.lock().unwrap().contains(mountpoint)
        }
    }

    fn manager_with_fake_mounts(root: &Path, authorized: Vec<PathBuf>) -> Arc<MountManager> {
        MountManager::open_with_mounts(
            MountManagerConfig {
                root: root.join("mounts-root"),
                settings: MountSettings::new(root.join("erofsfuse"), root.join("fusermount3")),
                authorized_roots: authorized,
                pinner: None,
            },
            Arc::new(FakeMountBackend::default()),
        )
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

    /// #3499: two configs that share one EROFS layer acquire the same physical
    /// mount; releasing one consumer keeps the mount for the other, and the
    /// last release removes it.
    #[test]
    fn two_consumers_of_one_layer_share_one_physical_mount() {
        let root = tempfile::tempdir().unwrap();
        let (source, digest) = image(root.path(), b"one shared physical layer");
        let manager = manager_with_fake_mounts(root.path(), vec![root.path().join("images")]);
        let verified = VerifiedImage::new(digest.clone(), source).unwrap();
        let first = manager.acquire(&verified, "exec-a").unwrap();
        let second = manager.acquire(&verified, "exec-b").unwrap();
        assert_eq!(first.mountpoint(), second.mountpoint());
        let status = manager.lookup(&digest).unwrap();
        assert!(status.mounted);
        assert_eq!(status.consumers, 2);
        drop(first);
        let status = manager.lookup(&digest).unwrap();
        assert!(status.mounted, "the remaining consumer keeps the mount");
        assert_eq!(status.consumers, 1);
        drop(second);
        let status = manager.lookup(&digest).unwrap();
        assert!(!status.mounted);
        assert_eq!(status.consumers, 0);
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

    #[derive(Default)]
    struct RecordingPinner {
        pins: Mutex<Vec<String>>,
    }

    struct RecordingPinGuard;

    impl BlobPinGuard for RecordingPinGuard {}

    impl BlobPinner for RecordingPinner {
        fn pin(&self, digest: &str) -> Result<Box<dyn BlobPinGuard>> {
            self.pins.lock().unwrap().push(digest.to_string());
            Ok(Box::new(RecordingPinGuard))
        }
    }

    fn manager_with_composite_backend(
        root: &Path,
    ) -> (
        Arc<MountManager>,
        Arc<FakeMountBackend>,
        Arc<RecordingPinner>,
    ) {
        let backend = Arc::new(FakeMountBackend::default());
        let pinner = Arc::new(RecordingPinner::default());
        let manager = MountManager::open_with_mounts(
            MountManagerConfig {
                root: root.join("mounts-root"),
                settings: MountSettings::new(root.join("erofsfuse"), root.join("fusermount3")),
                authorized_roots: vec![root.join("images")],
                pinner: Some(pinner.clone()),
            },
            backend.clone(),
        )
        .unwrap();
        (manager, backend, pinner)
    }

    #[test]
    fn a_composite_view_identity_shares_one_physical_mount_and_pins_every_component() {
        let root = tempfile::tempdir().unwrap();
        let (manager, backend, pinner) = manager_with_composite_backend(root.path());
        let (metadata_path, metadata_digest) = image(root.path(), b"metadata erofs");
        let devices = root.path().join("images");
        let first = devices.join("node.erofs");
        let second = devices.join("dsh.erofs");
        std::fs::write(&first, b"node backing erofs").unwrap();
        std::fs::write(&second, b"dsh backing erofs").unwrap();
        let metadata = VerifiedImage::new(metadata_digest.clone(), metadata_path).unwrap();
        let first = VerifiedImage::new(digest_of_bytes(b"node backing erofs"), first).unwrap();
        let second = VerifiedImage::new(digest_of_bytes(b"dsh backing erofs"), second).unwrap();
        let identity = digest_of_bytes(b"referenced composite descriptor");
        assert!(
            VerifiedComposite::new(&metadata_digest, metadata.clone(), vec![first.clone()])
                .is_err()
        );
        assert!(VerifiedComposite::new(
            &metadata_digest,
            metadata.clone(),
            vec![first.clone(), first.clone()]
        )
        .is_err());
        let composite = VerifiedComposite::new(
            identity.clone(),
            metadata.clone(),
            vec![first.clone(), second.clone()],
        )
        .unwrap();
        let first_lease = manager
            .acquire_composite(&composite, "execution-a")
            .unwrap();
        let second_lease = manager
            .acquire_composite(&composite, "execution-b")
            .unwrap();
        assert_eq!(first_lease.mountpoint(), second_lease.mountpoint());
        assert_eq!(first_lease.digest(), identity);
        assert_ne!(first_lease.digest(), metadata.digest());
        assert_eq!(
            first_lease.component_digests(),
            &[
                metadata.digest().to_string(),
                first.digest().to_string(),
                second.digest().to_string()
            ]
        );
        let mounted = backend.multi.lock().unwrap();
        assert_eq!(mounted.len(), 1, "one physical view");
        assert_eq!(mounted[0].1.len(), 2, "both backing devices were passed");
        drop(mounted);
        let pins = pinner.pins.lock().unwrap().clone();
        for digest in [
            &identity,
            &metadata_digest,
            &first.digest().to_string(),
            &second.digest().to_string(),
        ] {
            assert!(pins.contains(digest), "pinned {digest}: {pins:?}");
        }
        let sidecar = read_identity(
            &manager
                .entry(&identity)
                .expect("composite entry")
                .identity_path,
        )
        .unwrap();
        let recorded = sidecar.composite.expect("composite sidecar");
        assert_eq!(recorded.metadata_digest, metadata_digest);
        assert_eq!(recorded.device_digests.len(), 2);
        first_lease.release().unwrap();
        second_lease.release().unwrap();
        assert!(backend.mounted.lock().unwrap().is_empty());
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
                composite: None,
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
                composite: None,
            },
        )
        .unwrap();
        let report = manager.reclaim_orphans(&HashSet::new());
        assert_eq!(report.reclaimed, vec![digest]);
        assert!(!entry.identity_path.exists());
        assert!(!mount::is_mounted(&entry.mountpoint));
    }
}
