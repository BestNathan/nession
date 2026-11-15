//! The one owner of physical writable OverlayFS Merged Views (#3582).
//!
//! One managed Workspace has **one** durable `upper`/`work` pair and therefore
//! at most one active physical `fuse-overlayfs` mount per Agent identity and
//! mount namespace. Independent Sandbox executions acquire identified consumer
//! leases over that same Merged View; a lease never carries unmount authority.
//! Only this manager mounts and unmounts, and it does so after the last
//! identified consumer is gone.
//!
//! The manager owns:
//!
//! - the manager-derived mountpoint for one authorized workspace identity;
//! - the state machine (`Idle / Mounting / Mounted / Unmounting / Failed /
//!   Orphaned`) with serialized mount/unmount transitions and single-flight
//!   acquisition for one workspace;
//! - the durable owner lock and owner/identity sidecars that fence another
//!   process (or another manager root) sharing the same durable upper;
//! - a read-only EROFS lower lease held for the full physical Overlay
//!   lifetime. A failed Overlay unmount never releases the lower and never
//!   removes durable bytes;
//! - restart reconciliation through the durable binding, owner lock and
//!   mountinfo. A mount is never adopted merely because a path exists.
//!
//! It deliberately does not own Workspace metadata, identity allocation,
//! registry, deletion policy or Sandbox execution records. The Agent Workspace
//! Manager remains the data owner; the Sandbox remains the execution owner.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

use anyhow::{Context, Result};

use crate::mount_manager::{ConsumerRef, MountLease, MountManager, VerifiedImage};

use super::mount::{self, OverlayMountSpec, OverlaySettings};
use super::probe;
use super::recovery::{self, OverlayIdentityFile};
use super::state::{OverlayBinding, OverlayState, OverlayStatus};
use super::storage::{self, OverlayWorkspaceKey, OwnerLock, OwnerRecord};

/// How long an acquire waits for another same-workspace transition to finish.
pub const ACQUIRE_WAIT_TIMEOUT: Duration = Duration::from_secs(30);

/// A physical Overlay exists at the manager-derived mountpoint but this
/// manager cannot prove it created it. It is never adopted by path.
#[derive(Debug)]
struct OrphanedMount {
    mountpoint: PathBuf,
}

impl std::fmt::Display for OrphanedMount {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "an unverified Overlay mount already exists at {}; it is never adopted by path",
            self.mountpoint.display()
        )
    }
}

impl std::error::Error for OrphanedMount {}

/// A read-only EROFS lower lease held for the physical Overlay lifetime.
pub trait LowerLease: Send + Sync {
    fn mountpoint(&self) -> PathBuf;
    fn digest(&self) -> String;
    fn generation(&self) -> String;
    /// Release the lower consumer. Called only after a verified Overlay
    /// unmount (or when a mount attempt failed before the Overlay existed).
    fn release(self: Box<Self>) -> Result<()>;
}

/// Observed lower state, for read-only Overlay status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LowerStatus {
    pub mountpoint: PathBuf,
    pub mounted: bool,
    pub consumers: usize,
}

/// What a lower adoption attempt proved.
#[derive(Debug, Default, Clone)]
pub struct LowerAdoption {
    pub adopted: Vec<(String, String)>,
    pub unavailable: Vec<(String, String)>,
}

/// The existing, content-addressed EROFS mount manager, by interface.
///
/// Production wires this to [`MountManager`]; unit tests inject a deterministic
/// fake so the Overlay state machine can be exercised without FUSE.
pub trait LowerProvider: Send + Sync {
    fn acquire_lower(
        &self,
        image: &VerifiedImage,
        consumer_id: &str,
    ) -> Result<Box<dyn LowerLease>>;
    fn adopt_lowers(&self, consumers: &[ConsumerRef]) -> LowerAdoption;
    fn release_lower(
        &self,
        digest: &str,
        consumer_id: &str,
        generation: Option<&str>,
    ) -> Result<()>;
    fn lower_status(&self, digest: &str) -> Option<LowerStatus>;
}

impl LowerLease for MountLease {
    fn mountpoint(&self) -> PathBuf {
        MountLease::mountpoint(self).to_path_buf()
    }

    fn digest(&self) -> String {
        MountLease::digest(self).to_string()
    }

    fn generation(&self) -> String {
        MountLease::generation(self).to_string()
    }

    fn release(self: Box<Self>) -> Result<()> {
        MountLease::release(*self)
    }
}

impl LowerProvider for MountManager {
    fn acquire_lower(
        &self,
        image: &VerifiedImage,
        consumer_id: &str,
    ) -> Result<Box<dyn LowerLease>> {
        Ok(Box::new(MountManager::acquire(self, image, consumer_id)?))
    }

    fn adopt_lowers(&self, consumers: &[ConsumerRef]) -> LowerAdoption {
        let report = MountManager::adopt_consumers(self, consumers);
        LowerAdoption {
            adopted: report.adopted,
            unavailable: report.unavailable,
        }
    }

    fn release_lower(
        &self,
        digest: &str,
        consumer_id: &str,
        generation: Option<&str>,
    ) -> Result<()> {
        MountManager::release_consumers(self, digest, consumer_id, generation)
    }

    fn lower_status(&self, digest: &str) -> Option<LowerStatus> {
        MountManager::lookup(self, digest).map(|status| LowerStatus {
            mountpoint: status.mountpoint,
            mounted: status.mounted,
            consumers: status.consumers,
        })
    }
}

/// Manager construction input.
pub struct OverlayMountManagerConfig {
    /// Manager-owned root. Physical mountpoints live under `<root>/mounts` and
    /// durable identity sidecars under `<root>/state`.
    pub root: PathBuf,
    /// Authorized Agent-owned Workspace roots. A request names one of these
    /// roots plus a validated relative identity; upper/work are derived.
    pub workspace_roots: Vec<PathBuf>,
    pub settings: OverlaySettings,
    /// The existing #3449 lower owner.
    pub lower: Arc<dyn LowerProvider>,
    /// This Agent's stable identity.
    pub identity: String,
}

/// The physical mount operations the manager performs.
///
/// Production always uses [`RealMountBackend`]. Unit tests inject a fake so
/// single-flight, sharing and recovery can be exercised without FUSE.
pub(super) trait OverlayMountBackend: Send + Sync {
    fn mount(&self, spec: &OverlayMountSpec, settings: &OverlaySettings) -> Result<()>;
    fn unmount(&self, settings: &OverlaySettings, mountpoint: &Path) -> Result<()>;
    fn is_overlay_mount(&self, mountpoint: &Path) -> bool;
    fn storage_facts(&self, upper: &Path, work: &Path) -> Result<probe::StorageFacts>;
}

pub(super) struct RealMountBackend;

impl OverlayMountBackend for RealMountBackend {
    fn mount(&self, spec: &OverlayMountSpec, settings: &OverlaySettings) -> Result<()> {
        mount::mount_overlay(spec, settings)
    }

    fn unmount(&self, settings: &OverlaySettings, mountpoint: &Path) -> Result<()> {
        mount::unmount_overlay(settings, mountpoint)
    }

    fn is_overlay_mount(&self, mountpoint: &Path) -> bool {
        mount::is_overlay_mount(mountpoint)
    }

    fn storage_facts(&self, upper: &Path, work: &Path) -> Result<probe::StorageFacts> {
        probe::probe_storage(upper, work)
    }
}

/// One request to acquire the shared Merged View of an authorized Workspace.
#[derive(Debug, Clone)]
pub struct OverlayRequest {
    pub workspace: OverlayWorkspaceKey,
    pub lower: VerifiedImage,
}

impl OverlayRequest {
    pub fn new(workspace: OverlayWorkspaceKey, lower: VerifiedImage) -> Self {
        Self { workspace, lower }
    }
}

pub(super) struct Consumer {
    pub(super) execution_id: String,
    pub(super) generation: String,
}

/// The lower lease the physical Overlay depends on.
pub(super) enum LowerHandle {
    Leased {
        lease: Box<dyn LowerLease>,
        digest: String,
        generation: String,
    },
    /// A lower consumer reconstructed from a durable execution record after a
    /// restart. Released through the manager by identity.
    Adopted { digest: String, generation: String },
}

impl LowerHandle {
    pub(super) fn release(self, provider: &dyn LowerProvider, consumer_id: &str) -> Result<()> {
        match self {
            Self::Leased { lease, .. } => lease.release(),
            Self::Adopted { digest, generation } => {
                provider.release_lower(&digest, consumer_id, Some(&generation))
            }
        }
    }

    pub(super) fn retry_handle(&self) -> Self {
        match self {
            Self::Leased {
                digest, generation, ..
            }
            | Self::Adopted { digest, generation } => Self::Adopted {
                digest: digest.clone(),
                generation: generation.clone(),
            },
        }
    }
}

pub(super) struct EntryState {
    pub(super) phase: OverlayState,
    pub(super) binding: Option<OverlayBinding>,
    pub(super) consumers: HashMap<u64, Consumer>,
    pub(super) next_token: u64,
    pub(super) failure: Option<String>,
    pub(super) lower: Option<LowerHandle>,
    pub(super) owner: Option<OwnerLock>,
}

pub(super) struct OverlayEntry {
    pub(super) workspace: OverlayWorkspaceKey,
    pub(super) mountpoint: PathBuf,
    pub(super) identity_path: PathBuf,
    pub(super) state: Mutex<EntryState>,
    pub(super) transitioned: Condvar,
}

impl OverlayEntry {
    fn new(root: &Path, workspace: &OverlayWorkspaceKey) -> Self {
        let short = workspace.short_id();
        Self {
            workspace: workspace.clone(),
            mountpoint: root.join("mounts").join(&short),
            identity_path: root.join("state").join(format!("{short}.json")),
            state: Mutex::new(EntryState {
                phase: OverlayState::Idle,
                binding: None,
                consumers: HashMap::new(),
                next_token: 0,
                failure: None,
                lower: None,
                owner: None,
            }),
            transitioned: Condvar::new(),
        }
    }
}

pub(super) struct ManagerInner {
    pub(super) root: PathBuf,
    pub(super) workspace_roots: Vec<PathBuf>,
    pub(super) settings: OverlaySettings,
    pub(super) backend: Arc<dyn OverlayMountBackend>,
    pub(super) lower: Arc<dyn LowerProvider>,
    pub(super) agent_identity: String,
    pub(super) mount_namespace: String,
    pub(super) entries: Mutex<HashMap<String, Arc<OverlayEntry>>>,
    pub(super) adoptions: AtomicU64,
}

/// The one owner of physical writable Overlay mounts for this Agent identity
/// and mount namespace.
pub struct OverlayMountManager {
    pub(super) inner: Arc<ManagerInner>,
}

impl std::fmt::Debug for OverlayMountManager {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OverlayMountManager")
            .field("root", &self.inner.root)
            .field("agent_identity", &self.inner.agent_identity)
            .finish_non_exhaustive()
    }
}

impl OverlayMountManager {
    /// Open the manager root and prepare its private directories.
    ///
    /// Opening performs no mount and adopts nothing.
    pub fn open(config: OverlayMountManagerConfig) -> Result<Arc<Self>> {
        Self::open_with_backend_inner(config, Arc::new(RealMountBackend))
    }

    #[cfg(test)]
    pub(super) fn open_with_backend(
        config: OverlayMountManagerConfig,
        backend: Arc<dyn OverlayMountBackend>,
    ) -> Result<Arc<Self>> {
        Self::open_with_backend_inner(config, backend)
    }

    fn open_with_backend_inner(
        config: OverlayMountManagerConfig,
        backend: Arc<dyn OverlayMountBackend>,
    ) -> Result<Arc<Self>> {
        let agent_identity = config.identity.trim().to_string();
        if agent_identity.is_empty() {
            anyhow::bail!("the Overlay manager needs a non-empty Agent identity");
        }
        if !config.root.is_absolute() {
            anyhow::bail!(
                "the Overlay manager root {} must be absolute",
                config.root.display()
            );
        }
        std::fs::create_dir_all(&config.root).with_context(|| {
            format!("create the Overlay manager root {}", config.root.display())
        })?;
        let root = std::fs::canonicalize(&config.root).with_context(|| {
            format!("resolve the Overlay manager root {}", config.root.display())
        })?;
        if !root.is_dir() {
            anyhow::bail!(
                "the Overlay manager root {} is not a directory",
                root.display()
            );
        }
        let mount_namespace = std::fs::read_link("/proc/self/ns/mnt")
            .context("read this process's mount namespace for Overlay ownership")?
            .display()
            .to_string();
        let mut workspace_roots = Vec::new();
        for candidate in config.workspace_roots {
            if !candidate.is_absolute() {
                anyhow::bail!(
                    "an authorized Overlay workspace root {} must be absolute",
                    candidate.display()
                );
            }
            std::fs::create_dir_all(&candidate).with_context(|| {
                format!(
                    "create the authorized Overlay workspace root {}",
                    candidate.display()
                )
            })?;
            let canonical = std::fs::canonicalize(&candidate).with_context(|| {
                format!(
                    "resolve the authorized Overlay workspace root {}",
                    candidate.display()
                )
            })?;
            if !canonical.is_dir() {
                anyhow::bail!(
                    "the authorized Overlay workspace root {} is not a directory",
                    canonical.display()
                );
            }
            // A workspace nested below the manager root could be mistaken for
            // a manager-owned mountpoint; refuse that overlap.
            if canonical.starts_with(&root) {
                anyhow::bail!(
                    "the authorized Overlay workspace root {} must not be inside the manager root {}",
                    canonical.display(),
                    root.display()
                );
            }
            if !workspace_roots.contains(&canonical) {
                workspace_roots.push(canonical);
            }
        }
        if workspace_roots.is_empty() {
            anyhow::bail!("the Overlay manager requires at least one authorized workspace root");
        }
        for directory in [root.join("mounts"), root.join("state")] {
            std::fs::create_dir_all(&directory).with_context(|| {
                format!("create Overlay manager directory {}", directory.display())
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ =
                    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700));
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700));
        }
        Ok(Arc::new(Self {
            inner: Arc::new(ManagerInner {
                root,
                workspace_roots,
                settings: config.settings,
                backend,
                lower: config.lower,
                agent_identity,
                mount_namespace,
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

    /// Resolve an Agent-prepared writable directory to its authorized
    /// workspace identity.
    ///
    /// The directory must be a real, canonical child of one of the manager's
    /// authorized workspace roots. The returned key is derived from that root
    /// and the validated relative path; no caller-supplied mountpoint or
    /// upper/work path is accepted anywhere.
    pub fn resolve_workspace(&self, write: &Path) -> Result<OverlayWorkspaceKey> {
        if !write.is_absolute() {
            anyhow::bail!(
                "an Overlay workspace directory {} must be absolute",
                write.display()
            );
        }
        let metadata = std::fs::symlink_metadata(write)
            .with_context(|| format!("inspect Overlay workspace directory {}", write.display()))?;
        if metadata.file_type().is_symlink() {
            anyhow::bail!(
                "an Overlay workspace directory {} must not be a symlink",
                write.display()
            );
        }
        if !metadata.is_dir() {
            anyhow::bail!(
                "an Overlay workspace directory {} is not a directory",
                write.display()
            );
        }
        let canonical = std::fs::canonicalize(write)
            .with_context(|| format!("resolve Overlay workspace directory {}", write.display()))?;
        for root in &self.inner.workspace_roots {
            if let Ok(relative) = canonical.strip_prefix(root) {
                if relative.as_os_str().is_empty() {
                    continue;
                }
                return OverlayWorkspaceKey::new(root.clone(), relative.to_path_buf());
            }
        }
        anyhow::bail!(
            "the Overlay workspace directory {} is outside the manager-authorized Workspace roots",
            canonical.display()
        )
    }

    /// Acquire one identified consumer lease over a workspace's physical
    /// Merged View.
    ///
    /// Acquisitions of the same workspace are single-flight. The returned
    /// lease can release only its own consumer; it cannot unmount the shared
    /// physical Overlay.
    pub fn acquire(&self, request: &OverlayRequest, execution_id: &str) -> Result<OverlayLease> {
        if execution_id.trim().is_empty() {
            anyhow::bail!("a shared Overlay consumer needs a non-empty execution id");
        }
        self.validate_workspace(&request.workspace)?;
        let entry = self.entry_or_create(&request.workspace)?;
        let deadline = std::time::Instant::now() + ACQUIRE_WAIT_TIMEOUT;
        loop {
            let mut state = lock(&entry.state);
            match state.phase {
                OverlayState::Mounted => {
                    let Some(binding) = state.binding.clone() else {
                        state.phase = OverlayState::Idle;
                        drop(state);
                        continue;
                    };
                    if binding.lower_digest != request.lower.digest() {
                        anyhow::bail!(
                            "the shared Overlay of {} is merged with lower {}; refusing lower {}",
                            entry.workspace.identity(),
                            binding.lower_digest,
                            request.lower.digest()
                        );
                    }
                    if !self.inner.backend.is_overlay_mount(&entry.mountpoint) {
                        if state.consumers.is_empty() {
                            // The mount vanished while nothing held it. Drop
                            // the stale ownership through the same strict
                            // reclamation path (release the lower, remove the
                            // durable identity) instead of forgetting it.
                            state.phase = OverlayState::Unmounting;
                            drop(state);
                            let mut state = lock(&entry.state);
                            reclaim_if_unused(&self.inner, &entry, &mut state)?;
                            drop(state);
                            continue;
                        }
                        let failure = format!(
                            "the shared Overlay mount {} for {} disappeared",
                            entry.mountpoint.display(),
                            entry.workspace.identity()
                        );
                        state.phase = OverlayState::Failed;
                        state.failure = Some(failure.clone());
                        entry.transitioned.notify_all();
                        anyhow::bail!(
                            "{failure}; {} consumer(s) still hold it",
                            state.consumers.len()
                        );
                    }
                    let token = adopt_token(&mut state, execution_id, &binding.generation);
                    state.failure = None;
                    drop(state);
                    return Ok(OverlayLease::new(
                        Arc::clone(&self.inner),
                        entry,
                        token,
                        binding,
                        execution_id,
                    ));
                }
                OverlayState::Mounting | OverlayState::Unmounting => {
                    let now = std::time::Instant::now();
                    if now >= deadline {
                        anyhow::bail!(
                            "timed out waiting for the shared Overlay of {}",
                            entry.workspace.identity()
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
                            "timed out waiting for the shared Overlay of {}",
                            entry.workspace.identity()
                        );
                    }
                }
                OverlayState::Failed => {
                    if !state.consumers.is_empty() {
                        let failure = state
                            .failure
                            .clone()
                            .unwrap_or_else(|| "a previous Overlay transition failed".to_string());
                        anyhow::bail!(
                            "the shared Overlay of {} is unusable while {} consumer(s) remain: {failure}",
                            entry.workspace.identity(),
                            state.consumers.len()
                        );
                    }
                    // Retry the strict unmount before remounting so a failed
                    // rollback cannot leave two mounts aliased.
                    state.phase = OverlayState::Unmounting;
                    drop(state);
                    {
                        let mut state = lock(&entry.state);
                        reclaim_if_unused(&self.inner, &entry, &mut state)?;
                    }
                    continue;
                }
                OverlayState::Orphaned => {
                    anyhow::bail!(
                        "the shared Overlay of {} is orphaned; it is never adopted by path",
                        entry.workspace.identity()
                    );
                }
                OverlayState::Idle => {
                    if self.inner.backend.is_overlay_mount(&entry.mountpoint) {
                        // A physical mount without this manager's transition is
                        // an orphan: only restart reconciliation may reclaim it
                        // after identity checks.
                        let failure = OrphanedMount {
                            mountpoint: entry.mountpoint.clone(),
                        }
                        .to_string();
                        state.phase = OverlayState::Orphaned;
                        state.failure = Some(failure.clone());
                        entry.transitioned.notify_all();
                        anyhow::bail!(failure);
                    }
                    state.phase = OverlayState::Mounting;
                    drop(state);
                    let outcome = self.mount_entry(&entry, request);
                    let mut state = lock(&entry.state);
                    match outcome {
                        Ok((binding, lower, owner)) => {
                            state.phase = OverlayState::Mounted;
                            state.binding = Some(binding.clone());
                            state.lower = Some(lower);
                            state.owner = Some(owner);
                            state.failure = None;
                            let token = adopt_token(&mut state, execution_id, &binding.generation);
                            entry.transitioned.notify_all();
                            drop(state);
                            return Ok(OverlayLease::new(
                                Arc::clone(&self.inner),
                                entry,
                                token,
                                binding,
                                execution_id,
                            ));
                        }
                        Err(error) => {
                            state.phase = if error.downcast_ref::<OrphanedMount>().is_some() {
                                OverlayState::Orphaned
                            } else {
                                OverlayState::Failed
                            };
                            state.failure = Some(format!("{error:#}"));
                            entry.transitioned.notify_all();
                            return Err(error);
                        }
                    }
                }
            }
        }
    }

    /// Release every consumer of `execution_id` for one workspace (recovery).
    ///
    /// Idempotent: a consumer that was already released is ignored. A previous
    /// release whose strict unmount failed is retried.
    pub fn release_consumers(
        &self,
        workspace: &OverlayWorkspaceKey,
        execution_id: &str,
        generation: Option<&str>,
    ) -> Result<()> {
        workspace.validate()?;
        let Some(entry) = self.entry(workspace) else {
            return Ok(());
        };
        let mut state = lock(&entry.state);
        let before = state.consumers.len();
        state.consumers.retain(|_, consumer| {
            !(consumer.execution_id == execution_id
                && generation.is_none_or(|expected| consumer.generation == expected))
        });
        if state.consumers.len() == before {
            if state.phase == OverlayState::Failed && state.consumers.is_empty() {
                return reclaim_if_unused(&self.inner, &entry, &mut state);
            }
            return Ok(());
        }
        reclaim_if_unused(&self.inner, &entry, &mut state)
    }

    /// Read-only lookup by authorized workspace identity.
    ///
    /// A status for a workspace this manager never mounted in this process is
    /// reconstructed from the durable identity sidecar and reported
    /// `verified = false`. A mount without that identity is `Orphaned`.
    pub fn lookup(&self, workspace: &OverlayWorkspaceKey) -> Option<OverlayStatus> {
        workspace.validate().ok()?;
        if let Some(entry) = self.entry(workspace) {
            return Some(status_of(&self.inner, &entry));
        }
        let identity = recovery::read_identity(&self.identity_path_for(workspace)).ok()?;
        if identity.workspace.identity() != workspace.identity() {
            return None;
        }
        let mounted = self.inner.backend.is_overlay_mount(&identity.mountpoint);
        let lower_mounted = self
            .inner
            .lower
            .lower_status(&identity.lower_digest)
            .is_some_and(|status| status.mounted);
        Some(OverlayStatus {
            workspace: workspace.clone(),
            mountpoint: identity.mountpoint,
            generation: Some(identity.generation),
            state: if mounted {
                OverlayState::Mounted
            } else {
                OverlayState::Idle
            },
            mounted,
            verified: false,
            consumers: 0,
            lower_digest: Some(identity.lower_digest),
            lower_mounted,
            failure: None,
        })
    }

    /// Read-only lookup for an Agent-prepared writable directory.
    pub fn lookup_workspace_directory(&self, directory: &Path) -> Option<OverlayStatus> {
        let workspace = self.resolve_workspace(directory).ok()?;
        self.lookup(&workspace)
    }

    /// Whether a live process currently holds this workspace's durable owner
    /// lock. Read-only; it never creates the lock file.
    pub fn probe_owner_held(&self, workspace: &OverlayWorkspaceKey) -> bool {
        OwnerLock::probe_held(&workspace.directory())
    }

    /// The manager-derived mountpoint of an authorized workspace. Read-only;
    /// it creates nothing and never adopts an existing mount.
    pub fn mountpoint_for(&self, workspace: &OverlayWorkspaceKey) -> Result<PathBuf> {
        workspace.validate()?;
        if !self
            .inner
            .workspace_roots
            .iter()
            .any(|root| root == workspace.root())
        {
            anyhow::bail!(
                "the Overlay workspace root {} is not manager-authorized",
                workspace.root().display()
            );
        }
        Ok(self.inner.root.join("mounts").join(workspace.short_id()))
    }

    pub(super) fn identity_path_for(&self, workspace: &OverlayWorkspaceKey) -> PathBuf {
        self.inner
            .root
            .join("state")
            .join(format!("{}.json", workspace.short_id()))
    }

    pub(super) fn validate_workspace(&self, workspace: &OverlayWorkspaceKey) -> Result<()> {
        self.validate_workspace_storage(workspace).map(|_| ())
    }

    /// Validate the authorized path and the durable storage pair, then probe
    /// the actual filesystem capability.
    ///
    /// The capability probe writes and removes a probe file and an xattr, so
    /// it is safe only while this process holds the durable owner lock. Every
    /// acquire therefore performs the read-only path validation first and the
    /// capability probe inside [`Self::mount_entry`] after taking the lock.
    fn validate_workspace_storage(
        &self,
        workspace: &OverlayWorkspaceKey,
    ) -> Result<storage::OverlayStoragePaths> {
        workspace.validate()?;
        if !self
            .inner
            .workspace_roots
            .iter()
            .any(|root| root == workspace.root())
        {
            anyhow::bail!(
                "the Overlay workspace root {} is not manager-authorized",
                workspace.root().display()
            );
        }
        let directory = workspace.directory();
        let metadata = std::fs::symlink_metadata(&directory).with_context(|| {
            format!(
                "the Overlay workspace directory {} does not exist",
                directory.display()
            )
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            anyhow::bail!(
                "the Overlay workspace {} must be a real directory",
                directory.display()
            );
        }
        let canonical = std::fs::canonicalize(&directory)
            .with_context(|| format!("resolve Overlay workspace {}", directory.display()))?;
        if canonical != directory {
            anyhow::bail!(
                "the Overlay workspace {} resolves to {}; the durable identity must be canonical",
                directory.display(),
                canonical.display()
            );
        }
        let storage = storage::verify(&canonical)?;
        let facts = self
            .inner
            .backend
            .storage_facts(&storage.upper, &storage.work)?;
        facts.validate_paths(&storage.upper, &storage.work)?;
        Ok(storage)
    }

    pub(super) fn entry(&self, workspace: &OverlayWorkspaceKey) -> Option<Arc<OverlayEntry>> {
        lock(&self.inner.entries)
            .get(&workspace.identity())
            .cloned()
    }

    pub(super) fn entry_or_create(
        &self,
        workspace: &OverlayWorkspaceKey,
    ) -> Result<Arc<OverlayEntry>> {
        let mut entries = lock(&self.inner.entries);
        if let Some(entry) = entries.get(&workspace.identity()) {
            return Ok(Arc::clone(entry));
        }
        let entry = Arc::new(OverlayEntry::new(&self.inner.root, workspace));
        entries.insert(workspace.identity(), Arc::clone(&entry));
        Ok(entry)
    }

    fn mount_entry(
        &self,
        entry: &OverlayEntry,
        request: &OverlayRequest,
    ) -> Result<(OverlayBinding, LowerHandle, OwnerLock)> {
        let directory = entry.workspace.directory();
        // The durable owner lock is the cross-process fence. It is acquired
        // before the capability probe (which writes a probe file/xattr), so
        // another process sharing the same durable bytes can never observe or
        // interleave a write, and before any durable state is read or written.
        let owner = OwnerLock::acquire(&directory)?;
        let storage = self.validate_workspace_storage(&entry.workspace)?;
        if let Some(record) = storage::read_owner_record(&directory)? {
            if record.agent_identity != self.inner.agent_identity {
                anyhow::bail!(
                    "the durable Overlay of {} is owned by Agent identity {}; refusing to take it over",
                    entry.workspace.identity(),
                    record.agent_identity
                );
            }
            if record.mountpoint != entry.mountpoint {
                anyhow::bail!(
                    "the durable Overlay of {} records mountpoint {}, not the manager-derived {}",
                    entry.workspace.identity(),
                    record.mountpoint.display(),
                    entry.mountpoint.display()
                );
            }
        }
        if let Ok(identity) = recovery::read_identity(&entry.identity_path) {
            if identity.workspace.identity() != entry.workspace.identity() {
                anyhow::bail!(
                    "the durable Overlay identity in {} names a different workspace",
                    entry.identity_path.display()
                );
            }
            if identity.agent_identity != self.inner.agent_identity {
                anyhow::bail!(
                    "the durable Overlay of {} is owned by Agent identity {}; refusing to take it over",
                    entry.workspace.identity(),
                    identity.agent_identity
                );
            }
            if identity.mountpoint != entry.mountpoint {
                anyhow::bail!(
                    "the durable Overlay identity records mountpoint {}, not the manager-derived {}",
                    identity.mountpoint.display(),
                    entry.mountpoint.display()
                );
            }
            if identity.mount_namespace != self.inner.mount_namespace
                && self.inner.backend.is_overlay_mount(&entry.mountpoint)
            {
                anyhow::bail!(
                    "the physical Overlay at {} was created in mount namespace {}; this process \
                     cannot adopt it",
                    entry.mountpoint.display(),
                    identity.mount_namespace
                );
            }
        }
        // A mount already present at the manager-derived mountpoint without a
        // matching in-process transition is never adopted merely because a
        // path exists.
        if self.inner.backend.is_overlay_mount(&entry.mountpoint) {
            return Err(anyhow::Error::new(OrphanedMount {
                mountpoint: entry.mountpoint.clone(),
            }));
        }

        let consumer_id = lower_consumer_id(&entry.workspace);
        let mut lower = Some(
            self.inner
                .lower
                .acquire_lower(&request.lower, &consumer_id)?,
        );
        let generation = uuid::Uuid::new_v4().to_string();
        let Some(lower_lease) = lower.as_ref() else {
            anyhow::bail!("the lower lease disappeared before the Overlay mount");
        };
        let binding = OverlayBinding {
            workspace: entry.workspace.clone(),
            mountpoint: entry.mountpoint.clone(),
            generation: generation.clone(),
            lower_digest: request.lower.digest().to_string(),
            lower_mountpoint: lower_lease.mountpoint(),
            lower_generation: lower_lease.generation(),
        };
        let owner_record = OwnerRecord {
            agent_identity: self.inner.agent_identity.clone(),
            mount_namespace: self.inner.mount_namespace.clone(),
            workspace: entry.workspace.identity(),
            mountpoint: entry.mountpoint.clone(),
            generation,
            updated_at: storage::now_seconds(),
        };
        let identity = OverlayIdentityFile::from_binding(
            &binding,
            &self.inner.agent_identity,
            &self.inner.mount_namespace,
        );

        fn release_quiet(lower: &mut Option<Box<dyn LowerLease>>) {
            if let Some(lease) = lower.take() {
                let _ = lease.release();
            }
        }

        // Publish the durable identity before mounting so a crash between the
        // physical mount and its record has no unknown window.
        if let Err(error) = recovery::write_identity(&entry.identity_path, &identity) {
            release_quiet(&mut lower);
            return Err(error);
        }
        if let Err(error) = storage::write_owner_record(&directory, &owner_record) {
            recovery::remove_identity(&entry.identity_path);
            release_quiet(&mut lower);
            return Err(error);
        }
        let spec = OverlayMountSpec {
            lower: binding.lower_mountpoint.clone(),
            upper: storage.upper,
            work: storage.work,
            merged: entry.mountpoint.clone(),
        };
        if let Err(error) = self.inner.backend.mount(&spec, &self.inner.settings) {
            recovery::remove_identity(&entry.identity_path);
            storage::remove_owner_record(&directory);
            release_quiet(&mut lower);
            return Err(error.context(format!(
                "mount the shared Workspace Overlay for {}",
                entry.workspace.identity()
            )));
        }
        if !self.inner.backend.is_overlay_mount(&entry.mountpoint) {
            let rollback = self
                .inner
                .backend
                .unmount(&self.inner.settings, &entry.mountpoint);
            recovery::remove_identity(&entry.identity_path);
            storage::remove_owner_record(&directory);
            release_quiet(&mut lower);
            return Err(match rollback {
                Ok(()) => anyhow::anyhow!(
                    "the Overlay helper reported success but {} is not a fuse-overlayfs mount",
                    entry.mountpoint.display()
                ),
                Err(rollback) => anyhow::anyhow!(
                    "the Overlay helper reported success but {} is not a fuse-overlayfs mount; \
                     verified rollback also failed: {rollback:#}",
                    entry.mountpoint.display()
                ),
            });
        }
        let Some(lease) = lower else {
            anyhow::bail!("the lower lease disappeared during the Overlay mount");
        };
        let handle = LowerHandle::Leased {
            digest: lease.digest(),
            generation: lease.generation(),
            lease,
        };
        Ok((binding, handle, owner))
    }
}

pub(super) fn lower_consumer_id(workspace: &OverlayWorkspaceKey) -> String {
    format!("overlay:{}", workspace.short_id())
}

pub(super) fn adopt_token(state: &mut EntryState, execution_id: &str, generation: &str) -> u64 {
    let token = state.next_token;
    state.next_token += 1;
    state.consumers.insert(
        token,
        Consumer {
            execution_id: execution_id.to_string(),
            generation: generation.to_string(),
        },
    );
    token
}

pub(super) fn status_of(inner: &ManagerInner, entry: &OverlayEntry) -> OverlayStatus {
    let state = lock(&entry.state);
    let mounted = inner.backend.is_overlay_mount(&entry.mountpoint);
    let lower_digest = state
        .binding
        .as_ref()
        .map(|binding| binding.lower_digest.clone());
    let lower_mounted = lower_digest
        .as_deref()
        .and_then(|digest| inner.lower.lower_status(digest))
        .is_some_and(|status| status.mounted);
    OverlayStatus {
        workspace: entry.workspace.clone(),
        mountpoint: entry.mountpoint.clone(),
        generation: state
            .binding
            .as_ref()
            .map(|binding| binding.generation.clone()),
        state: state.phase,
        mounted,
        verified: mounted && state.binding.is_some() && state.phase == OverlayState::Mounted,
        consumers: state.consumers.len(),
        lower_digest,
        lower_mounted,
        failure: state.failure.clone(),
    }
}

/// A non-unmount-capable consumer lease over one shared physical Overlay.
pub struct OverlayLease {
    inner: Arc<ManagerInner>,
    entry: Arc<OverlayEntry>,
    token: u64,
    binding: OverlayBinding,
    execution_id: String,
    released: bool,
}

impl std::fmt::Debug for OverlayLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OverlayLease")
            .field("workspace", &self.entry.workspace.identity())
            .field("mountpoint", &self.entry.mountpoint)
            .field("generation", &self.binding.generation)
            .field("execution_id", &self.execution_id)
            .finish()
    }
}

impl OverlayLease {
    fn new(
        inner: Arc<ManagerInner>,
        entry: Arc<OverlayEntry>,
        token: u64,
        binding: OverlayBinding,
        execution_id: &str,
    ) -> Self {
        Self {
            inner,
            entry,
            token,
            binding,
            execution_id: execution_id.to_string(),
            released: false,
        }
    }

    pub fn mountpoint(&self) -> &Path {
        &self.entry.mountpoint
    }

    pub fn workspace(&self) -> &OverlayWorkspaceKey {
        &self.entry.workspace
    }

    pub fn generation(&self) -> &str {
        &self.binding.generation
    }

    pub fn lower_digest(&self) -> &str {
        &self.binding.lower_digest
    }

    pub fn lower_mountpoint(&self) -> &Path {
        &self.binding.lower_mountpoint
    }

    pub fn lower_generation(&self) -> &str {
        &self.binding.lower_generation
    }

    pub fn execution_id(&self) -> &str {
        &self.execution_id
    }

    /// The durable binding a Sandbox execution persists.
    pub fn binding(&self) -> OverlayBinding {
        self.binding.clone()
    }

    /// Release this consumer. The final consumer triggers a bounded, strict
    /// physical unmount; a failure is retained for a later retry and never
    /// releases the lower or deletes durable bytes.
    pub fn release(mut self) -> Result<()> {
        self.released = true;
        release_token(&self.inner, &self.entry, self.token)
    }
}

impl Drop for OverlayLease {
    fn drop(&mut self) {
        if !self.released {
            let _ = release_token(&self.inner, &self.entry, self.token);
        }
    }
}

fn release_token(inner: &ManagerInner, entry: &OverlayEntry, token: u64) -> Result<()> {
    let mut state = lock(&entry.state);
    if state.consumers.remove(&token).is_none() {
        return Ok(());
    }
    reclaim_if_unused(inner, entry, &mut state)
}

/// Remove the physical mount when this was the last identified consumer.
///
/// The caller holds the entry state lock, so a concurrent acquire observes
/// either the mounted state with a consumer or the idle state; it can never
/// start a second mount over a live one.
pub(super) fn reclaim_if_unused(
    inner: &ManagerInner,
    entry: &OverlayEntry,
    state: &mut EntryState,
) -> Result<()> {
    if !state.consumers.is_empty() {
        state.phase = OverlayState::Mounted;
        return Ok(());
    }
    if state.phase == OverlayState::Idle && state.binding.is_none() && state.lower.is_none() {
        return Ok(());
    }
    state.phase = OverlayState::Unmounting;
    if inner.backend.is_overlay_mount(&entry.mountpoint) {
        if let Err(error) = inner.backend.unmount(&inner.settings, &entry.mountpoint) {
            // Retain the mount, the lower pin, the durable identity and the
            // owner lock: the resource is still live and must stay durable.
            state.phase = OverlayState::Failed;
            state.failure = Some(format!("{error:#}"));
            entry.transitioned.notify_all();
            return Err(error);
        }
    }
    if let Some(lower) = state.lower.take() {
        let consumer_id = lower_consumer_id(&entry.workspace);
        let retry = lower.retry_handle();
        if let Err(error) = lower.release(&*inner.lower, &consumer_id) {
            state.lower = Some(retry);
            state.phase = OverlayState::Failed;
            state.failure = Some(format!("{error:#}"));
            entry.transitioned.notify_all();
            return Err(error);
        }
    }
    state.phase = OverlayState::Idle;
    state.binding = None;
    state.failure = None;
    state.owner = None;
    recovery::remove_identity(&entry.identity_path);
    storage::remove_owner_record(&entry.workspace.directory());
    entry.transitioned.notify_all();
    Ok(())
}

pub(super) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A read-only set of workspace identities a live execution record protects.
pub type ProtectedWorkspaces = HashSet<OverlayWorkspaceKey>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::digest::digest_of_bytes;
    use std::sync::atomic::{AtomicBool, AtomicUsize};

    fn image(root: &Path, bytes: &[u8]) -> VerifiedImage {
        let path = root.join(format!("image-{}.erofs", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes).unwrap();
        VerifiedImage::new(digest_of_bytes(bytes), path).unwrap()
    }

    struct FakeMountBackend {
        mounted: Mutex<HashSet<PathBuf>>,
        mounts: AtomicUsize,
        fail_mount: AtomicBool,
        fail_unmount: AtomicBool,
        facts: Mutex<probe::StorageFacts>,
    }

    impl FakeMountBackend {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                mounted: Mutex::new(HashSet::new()),
                mounts: AtomicUsize::new(0),
                fail_mount: AtomicBool::new(false),
                fail_unmount: AtomicBool::new(false),
                facts: Mutex::new(probe::StorageFacts::local_for_test()),
            })
        }
    }

    impl OverlayMountBackend for FakeMountBackend {
        fn mount(&self, spec: &OverlayMountSpec, _settings: &OverlaySettings) -> Result<()> {
            if self.fail_mount.load(Ordering::SeqCst) {
                anyhow::bail!("injected Overlay mount failure");
            }
            std::fs::create_dir_all(&spec.merged).unwrap();
            self.mounted.lock().unwrap().insert(spec.merged.clone());
            self.mounts.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn unmount(&self, _settings: &OverlaySettings, mountpoint: &Path) -> Result<()> {
            if self.fail_unmount.load(Ordering::SeqCst) {
                anyhow::bail!("injected Overlay unmount failure");
            }
            self.mounted.lock().unwrap().remove(mountpoint);
            Ok(())
        }

        fn is_overlay_mount(&self, mountpoint: &Path) -> bool {
            self.mounted.lock().unwrap().contains(mountpoint)
        }

        fn storage_facts(&self, _upper: &Path, _work: &Path) -> Result<probe::StorageFacts> {
            Ok(self.facts.lock().unwrap().clone())
        }
    }

    #[derive(Default)]
    struct FakeLowerState {
        acquired: Mutex<HashSet<String>>,
        released: Mutex<Vec<String>>,
        mountpoint: Mutex<Option<PathBuf>>,
        fail_release: AtomicBool,
    }

    struct FakeLower {
        state: Arc<FakeLowerState>,
        consumer_id: String,
        digest: String,
        generation: String,
    }

    impl LowerLease for FakeLower {
        fn mountpoint(&self) -> PathBuf {
            self.state
                .mountpoint
                .lock()
                .unwrap()
                .clone()
                .expect("fake lower mountpoint")
        }

        fn digest(&self) -> String {
            self.digest.clone()
        }

        fn generation(&self) -> String {
            self.generation.clone()
        }

        fn release(self: Box<Self>) -> Result<()> {
            if self.state.fail_release.load(Ordering::SeqCst) {
                anyhow::bail!("injected lower release failure");
            }
            self.state
                .acquired
                .lock()
                .unwrap()
                .remove(&self.consumer_id);
            self.state.released.lock().unwrap().push(self.consumer_id);
            Ok(())
        }
    }

    struct FakeLowerProvider {
        root: PathBuf,
        state: Arc<FakeLowerState>,
    }

    impl LowerProvider for FakeLowerProvider {
        fn acquire_lower(
            &self,
            image: &VerifiedImage,
            consumer_id: &str,
        ) -> Result<Box<dyn LowerLease>> {
            let mountpoint = self
                .root
                .join("lower")
                .join(image.digest().replace(':', "-"));
            std::fs::create_dir_all(&mountpoint).unwrap();
            self.state.mountpoint.lock().unwrap().replace(mountpoint);
            self.state
                .acquired
                .lock()
                .unwrap()
                .insert(consumer_id.to_string());
            Ok(Box::new(FakeLower {
                state: Arc::clone(&self.state),
                consumer_id: consumer_id.to_string(),
                digest: image.digest().to_string(),
                generation: "lower-generation".to_string(),
            }))
        }

        fn adopt_lowers(&self, consumers: &[ConsumerRef]) -> LowerAdoption {
            let mut adoption = LowerAdoption::default();
            for consumer in consumers {
                let mountpoint = self
                    .root
                    .join("lower")
                    .join(consumer.digest.replace(':', "-"));
                if !mountpoint.is_dir() {
                    adoption.unavailable.push((
                        consumer.digest.clone(),
                        "the lower mount is not present".to_string(),
                    ));
                    continue;
                }
                self.state
                    .acquired
                    .lock()
                    .unwrap()
                    .insert(consumer.execution_id.clone());
                adoption
                    .adopted
                    .push((consumer.digest.clone(), consumer.execution_id.clone()));
            }
            adoption
        }

        fn release_lower(
            &self,
            _digest: &str,
            consumer_id: &str,
            _generation: Option<&str>,
        ) -> Result<()> {
            if self.state.fail_release.load(Ordering::SeqCst) {
                anyhow::bail!("injected lower release failure");
            }
            self.state.acquired.lock().unwrap().remove(consumer_id);
            self.state
                .released
                .lock()
                .unwrap()
                .push(consumer_id.to_string());
            Ok(())
        }

        fn lower_status(&self, _digest: &str) -> Option<LowerStatus> {
            let mountpoint = self.state.mountpoint.lock().unwrap().clone()?;
            Some(LowerStatus {
                mountpoint,
                mounted: true,
                consumers: self.state.acquired.lock().unwrap().len(),
            })
        }
    }

    struct Fixture {
        _root: tempfile::TempDir,
        manager_root: PathBuf,
        workspace_root: PathBuf,
        backend: Arc<FakeMountBackend>,
        lower_root: PathBuf,
        lower_state: Arc<FakeLowerState>,
        manager: Arc<OverlayMountManager>,
    }

    fn fixture() -> Fixture {
        fixture_with_identity("agent-test")
    }

    fn fixture_with_identity(identity: &str) -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let manager_root = root.path().join("overlay-root");
        let workspace_root = root.path().join("workspaces");
        std::fs::create_dir_all(&workspace_root).unwrap();
        let backend = FakeMountBackend::new();
        let lower_root = root.path().join("lowers");
        let lower_state = Arc::new(FakeLowerState::default());
        let manager = OverlayMountManager::open_with_backend(
            OverlayMountManagerConfig {
                root: manager_root.clone(),
                workspace_roots: vec![workspace_root.clone()],
                settings: OverlaySettings::new(
                    root.path().join("fuse-overlayfs"),
                    root.path().join("fusermount3"),
                ),
                lower: Arc::new(FakeLowerProvider {
                    root: lower_root.clone(),
                    state: Arc::clone(&lower_state),
                }),
                identity: identity.to_string(),
            },
            backend.clone(),
        )
        .unwrap();
        Fixture {
            _root: root,
            manager_root,
            workspace_root,
            backend,
            lower_root,
            lower_state,
            manager,
        }
    }

    fn workspace(fixture: &Fixture, name: &str) -> OverlayWorkspaceKey {
        let directory = fixture.workspace_root.join(name);
        std::fs::create_dir_all(&directory).unwrap();
        storage::initialize(&directory).unwrap();
        fixture.manager.resolve_workspace(&directory).unwrap()
    }

    fn request(fixture: &Fixture, key: &OverlayWorkspaceKey, bytes: &[u8]) -> OverlayRequest {
        OverlayRequest::new(key.clone(), image(&fixture.workspace_root, bytes))
    }

    #[test]
    fn two_consumers_of_one_workspace_share_one_physical_mount() {
        let fixture = fixture();
        let key = workspace(&fixture, "ws_shared");
        let request = request(&fixture, &key, b"lower bytes");
        let first = fixture.manager.acquire(&request, "exec-a").unwrap();
        let second = fixture.manager.acquire(&request, "exec-b").unwrap();
        assert_eq!(first.mountpoint(), second.mountpoint());
        assert_eq!(first.generation(), second.generation());
        assert_eq!(fixture.backend.mounts.load(Ordering::SeqCst), 1);
        let status = fixture.manager.lookup(&key).unwrap();
        assert!(status.mounted);
        assert!(status.verified);
        assert_eq!(status.consumers, 2);
        drop(first);
        let status = fixture.manager.lookup(&key).unwrap();
        assert!(status.mounted, "the remaining consumer keeps the mount");
        assert_eq!(status.consumers, 1);
        drop(second);
        let status = fixture.manager.lookup(&key).unwrap();
        assert!(!status.mounted);
        assert_eq!(status.state, OverlayState::Idle);
        assert_eq!(status.consumers, 0);
        assert_eq!(
            fixture.lower_state.released.lock().unwrap().len(),
            1,
            "the lower is released exactly when the last consumer leaves"
        );
    }

    #[test]
    fn concurrent_acquisitions_make_one_physical_mount() {
        let fixture = fixture();
        let key = workspace(&fixture, "ws_concurrent");
        let request = request(&fixture, &key, b"lower bytes");
        let barrier = Arc::new(std::sync::Barrier::new(5));
        let observed = Arc::new(Mutex::new(Vec::new()));
        let mut threads = Vec::new();
        for index in 0..4 {
            let manager = Arc::clone(&fixture.manager);
            let request = request.clone();
            let barrier = Arc::clone(&barrier);
            let observed = Arc::clone(&observed);
            threads.push(std::thread::spawn(move || {
                let lease = manager.acquire(&request, &format!("exec-{index}")).unwrap();
                observed.lock().unwrap().push((
                    lease.mountpoint().to_path_buf(),
                    lease.generation().to_string(),
                ));
                barrier.wait();
                barrier.wait();
                lease.release().unwrap();
            }));
        }
        barrier.wait();
        let observed = observed.lock().unwrap().clone();
        assert_eq!(observed.len(), 4);
        for (mountpoint, generation) in &observed {
            assert_eq!(mountpoint, &observed[0].0);
            assert_eq!(generation, &observed[0].1);
        }
        assert_eq!(fixture.backend.mounts.load(Ordering::SeqCst), 1);
        barrier.wait();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(fixture.manager.lookup(&key).unwrap().consumers, 0);
        assert!(!fixture.manager.lookup(&key).unwrap().mounted);
    }

    #[test]
    fn different_workspaces_get_isolated_storage_and_mounts() {
        let fixture = fixture();
        let first = workspace(&fixture, "ws_one");
        let second = workspace(&fixture, "ws_two");
        let first_lease = fixture
            .manager
            .acquire(&request(&fixture, &first, b"lower one"), "exec-a")
            .unwrap();
        let second_lease = fixture
            .manager
            .acquire(&request(&fixture, &second, b"lower two"), "exec-b")
            .unwrap();
        assert_ne!(first_lease.mountpoint(), second_lease.mountpoint());
        assert_ne!(first.upper(), second.upper());
        assert_eq!(fixture.backend.mounts.load(Ordering::SeqCst), 2);
        assert_eq!(fixture.manager.lookup(&first).unwrap().consumers, 1);
        assert_eq!(fixture.manager.lookup(&second).unwrap().consumers, 1);
    }

    #[test]
    fn invalid_identities_roots_and_paths_are_refused() {
        let fixture = fixture();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(outside.path().join("ws")).unwrap();
        storage::initialize(&outside.path().join("ws")).unwrap();
        assert!(fixture
            .manager
            .resolve_workspace(&outside.path().join("ws"))
            .is_err());

        // A relative path that escapes the root cannot be constructed.
        assert!(OverlayWorkspaceKey::new(&fixture.workspace_root, Path::new("../escape")).is_err());

        // An unauthorized root is refused even when the key shape is valid.
        let unauthorized = OverlayWorkspaceKey::new(outside.path(), "ws").unwrap();
        let error = fixture
            .manager
            .acquire(&request(&fixture, &unauthorized, b"bytes"), "exec")
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("not manager-authorized"),
            "{error:#}"
        );

        // Missing and symlinked storage is refused before any mount.
        let missing = fixture.workspace_root.join("ws_missing");
        std::fs::create_dir(&missing).unwrap();
        let key = fixture.manager.resolve_workspace(&missing).unwrap();
        let error = fixture
            .manager
            .acquire(&request(&fixture, &key, b"bytes"), "exec")
            .unwrap_err();
        assert!(format!("{error:#}").contains("missing"), "{error:#}");
        assert_eq!(fixture.backend.mounts.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_shared_network_storage_is_refused_before_any_mount() {
        let fixture = fixture();
        let key = workspace(&fixture, "ws_nfs");
        *fixture.backend.facts.lock().unwrap() = probe::StorageFacts {
            upper_fs: "nfs".to_string(),
            work_fs: "nfs".to_string(),
            upper_device: 1,
            work_device: 1,
            xattrs: true,
        };
        let error = fixture
            .manager
            .acquire(&request(&fixture, &key, b"bytes"), "exec")
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("shared filesystem"),
            "{error:#}"
        );
        assert_eq!(fixture.backend.mounts.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_competing_manager_cannot_take_a_live_durable_upper() {
        let fixture = fixture();
        let key = workspace(&fixture, "ws_fenced");
        let lease = fixture
            .manager
            .acquire(&request(&fixture, &key, b"lower bytes"), "exec-a")
            .unwrap();
        let other_backend = FakeMountBackend::new();
        other_backend
            .mounted
            .lock()
            .unwrap()
            .insert(lease.mountpoint().to_path_buf());
        let other = OverlayMountManager::open_with_backend(
            OverlayMountManagerConfig {
                root: fixture.manager_root.join("other"),
                workspace_roots: vec![fixture.workspace_root.clone()],
                settings: OverlaySettings::new("/bin/true", "/bin/true"),
                lower: Arc::new(FakeLowerProvider {
                    root: fixture.workspace_root.join("other-lowers"),
                    state: Arc::clone(&fixture.lower_state),
                }),
                identity: "agent-test".to_string(),
            },
            other_backend,
        )
        .unwrap();
        let error = other
            .acquire(&request(&fixture, &key, b"lower bytes"), "exec-b")
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("another process holds the durable Overlay owner lock"),
            "{error:#}"
        );
        // The first owner is untouched.
        assert!(fixture.manager.lookup(&key).unwrap().mounted);
    }

    #[test]
    fn a_failed_unmount_keeps_the_lower_upper_and_mount_for_retry() {
        let fixture = fixture();
        let key = workspace(&fixture, "ws_failed_unmount");
        std::fs::write(key.upper().join("durable.txt"), b"durable").unwrap();
        let lease = fixture
            .manager
            .acquire(&request(&fixture, &key, b"lower bytes"), "exec-a")
            .unwrap();
        fixture.backend.fail_unmount.store(true, Ordering::SeqCst);
        let error = lease.release().unwrap_err();
        assert!(format!("{error:#}").contains("injected"), "{error:#}");
        let status = fixture.manager.lookup(&key).unwrap();
        assert_eq!(status.state, OverlayState::Failed);
        assert!(status.mounted, "the live mount is retained");
        assert_eq!(status.consumers, 0);
        assert!(status.failure.is_some());
        assert!(
            fixture.lower_state.released.lock().unwrap().is_empty(),
            "the lower is never released on a failed Overlay unmount"
        );
        assert_eq!(
            std::fs::read_to_string(key.upper().join("durable.txt")).unwrap(),
            "durable"
        );

        fixture.backend.fail_unmount.store(false, Ordering::SeqCst);
        fixture
            .manager
            .release_consumers(&key, "exec-a", None)
            .expect("the retry succeeds");
        assert!(!fixture.manager.lookup(&key).unwrap().mounted);
        assert_eq!(fixture.lower_state.released.lock().unwrap().len(), 1);
        assert_eq!(
            std::fs::read_to_string(key.upper().join("durable.txt")).unwrap(),
            "durable"
        );
    }

    #[test]
    fn a_failed_mount_releases_the_lower_and_leaves_no_mount() {
        let fixture = fixture();
        let key = workspace(&fixture, "ws_failed_mount");
        fixture.backend.fail_mount.store(true, Ordering::SeqCst);
        let error = fixture
            .manager
            .acquire(&request(&fixture, &key, b"lower bytes"), "exec-a")
            .unwrap_err();
        assert!(format!("{error:#}").contains("injected"), "{error:#}");
        let status = fixture.manager.lookup(&key).unwrap();
        assert_eq!(status.state, OverlayState::Failed);
        assert!(!status.mounted);
        assert_eq!(status.consumers, 0);
        assert_eq!(
            fixture.lower_state.acquired.lock().unwrap().len(),
            0,
            "a failed mount does not leak the lower consumer"
        );
        assert!(!key.identity_marker_exists());
    }

    #[test]
    fn a_mount_helper_that_does_not_mount_is_never_reported_ready() {
        // The fake backend reports success while is_overlay_mount stays false.
        struct SilentBackend;
        impl OverlayMountBackend for SilentBackend {
            fn mount(&self, _spec: &OverlayMountSpec, _settings: &OverlaySettings) -> Result<()> {
                Ok(())
            }
            fn unmount(&self, _settings: &OverlaySettings, _mountpoint: &Path) -> Result<()> {
                Ok(())
            }
            fn is_overlay_mount(&self, _mountpoint: &Path) -> bool {
                false
            }
            fn storage_facts(&self, _upper: &Path, _work: &Path) -> Result<probe::StorageFacts> {
                Ok(probe::StorageFacts::local_for_test())
            }
        }
        let root = tempfile::tempdir().unwrap();
        let workspace_root = root.path().join("workspaces");
        std::fs::create_dir_all(workspace_root.join("ws_silent")).unwrap();
        storage::initialize(&workspace_root.join("ws_silent")).unwrap();
        let manager = OverlayMountManager::open_with_backend(
            OverlayMountManagerConfig {
                root: root.path().join("root"),
                workspace_roots: vec![workspace_root.clone()],
                settings: OverlaySettings::new("/bin/true", "/bin/true"),
                lower: Arc::new(FakeLowerProvider {
                    root: root.path().join("lowers"),
                    state: Arc::new(FakeLowerState::default()),
                }),
                identity: "agent-test".to_string(),
            },
            Arc::new(SilentBackend),
        )
        .unwrap();
        let key = manager
            .resolve_workspace(&workspace_root.join("ws_silent"))
            .unwrap();
        let error = manager
            .acquire(&request_for_root(&workspace_root, &key), "exec")
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("is not a fuse-overlayfs mount"),
            "{error:#}"
        );
        let status = manager.lookup(&key).unwrap();
        assert!(!status.mounted);
        assert!(!status.verified);
    }

    fn request_for_root(root: &Path, key: &OverlayWorkspaceKey) -> OverlayRequest {
        OverlayRequest::new(key.clone(), image(root, b"lower bytes"))
    }

    #[test]
    fn adopted_state_requires_matching_generation_identity_and_mountinfo() {
        let fixture = fixture();
        let key = workspace(&fixture, "ws_adopt");
        let lease = fixture
            .manager
            .acquire(&request(&fixture, &key, b"lower bytes"), "exec-live")
            .unwrap();
        let binding = lease.binding();
        // Detach the in-process ownership as a crashed process would, keeping
        // the fake physical mount and the durable sidecars.
        std::mem::forget(lease);
        fixture.manager.abandon_for_test(&key);

        let reopened = fixture.reopen();
        let report = reopened.adopt_consumers(&[binding.consumer("exec-live")]);
        assert_eq!(report.adopted.len(), 1, "{report:?}");
        let status = reopened.lookup(&key).unwrap();
        assert!(status.mounted);
        assert!(status.verified);
        assert_eq!(status.consumers, 1);
        reopened
            .release_consumers(&key, "exec-live", Some(&binding.generation))
            .unwrap();
        assert!(!reopened.lookup(&key).unwrap().mounted);

        // A mismatched generation is never served.
        let lease = reopened
            .acquire(&request(&fixture, &key, b"lower bytes"), "exec-new")
            .unwrap();
        let binding = lease.binding();
        std::mem::forget(lease);
        reopened.abandon_for_test(&key);
        let reopened = fixture.reopen();
        let mut wrong = binding.consumer("exec-new");
        wrong.generation = "stale-generation".to_string();
        let report = reopened.adopt_consumers(&[wrong]);
        assert!(report.adopted.is_empty(), "{report:?}");
        assert!(!report.unavailable.is_empty());
        let status = reopened.lookup(&key).unwrap();
        assert!(status.mounted);
        assert!(!status.verified, "an unadopted mount is not verified");
    }

    #[test]
    fn a_mount_that_disappeared_is_never_adopted_or_reported_ready() {
        let fixture = fixture();
        let key = workspace(&fixture, "ws_missing_adopt");
        let lease = fixture
            .manager
            .acquire(&request(&fixture, &key, b"lower bytes"), "exec-live")
            .unwrap();
        let binding = lease.binding();
        std::mem::forget(lease);
        fixture.manager.abandon_for_test(&key);
        // The physical mount disappeared behind the manager's durable record.
        fixture
            .backend
            .mounted
            .lock()
            .unwrap()
            .remove(&binding.mountpoint);
        let reopened = fixture.reopen();
        let report = reopened.adopt_consumers(&[binding.consumer("exec-live")]);
        assert!(report.adopted.is_empty(), "{report:?}");
        assert!(
            report
                .unavailable
                .iter()
                .any(|(_, reason)| reason.contains("no longer present")),
            "{report:?}"
        );
        assert!(!reopened.lookup(&key).unwrap().mounted);
    }

    #[test]
    fn a_foreign_owner_identity_is_never_adopted() {
        let fixture = fixture();
        let key = workspace(&fixture, "ws_foreign");
        let lease = fixture
            .manager
            .acquire(&request(&fixture, &key, b"lower bytes"), "exec-live")
            .unwrap();
        let binding = lease.binding();
        std::mem::forget(lease);
        fixture.manager.abandon_for_test(&key);
        // Rewrite the durable identity as another Agent's.
        let path = fixture.manager.identity_path_for(&key);
        let mut identity = recovery::read_identity(&path).unwrap();
        identity.agent_identity = "agent-other".to_string();
        recovery::write_identity(&path, &identity).unwrap();
        let reopened = fixture.reopen();
        let report = reopened.adopt_consumers(&[binding.consumer("exec-live")]);
        assert!(report.adopted.is_empty(), "{report:?}");
        assert!(!report.unavailable.is_empty());
    }

    #[test]
    fn orphan_reclamation_respects_protection_and_a_live_owner() {
        let fixture = fixture();
        let key = workspace(&fixture, "ws_reclaim");
        std::fs::write(key.upper().join("durable.txt"), b"durable").unwrap();
        let lease = fixture
            .manager
            .acquire(&request(&fixture, &key, b"lower bytes"), "exec-live")
            .unwrap();
        std::mem::forget(lease);
        fixture.manager.abandon_for_test(&key);
        let reopened = fixture.reopen();
        let mut protected = ProtectedWorkspaces::new();
        protected.insert(key.clone());
        let report = reopened.reclaim_orphans(&protected);
        assert!(report.reclaimed.is_empty(), "{report:?}");
        assert!(reopened.lookup(&key).unwrap().mounted);

        let report = reopened.reclaim_orphans(&ProtectedWorkspaces::new());
        assert_eq!(report.reclaimed.len(), 1, "{report:?}");
        assert!(!reopened.lookup(&key).unwrap().mounted);
        assert!(recovery::read_identity(&reopened.identity_path_for(&key)).is_err());
        assert_eq!(
            std::fs::read_to_string(key.upper().join("durable.txt")).unwrap(),
            "durable",
            "reclamation never deletes durable upper bytes"
        );
    }

    #[test]
    fn an_unknown_workspace_has_no_invented_status() {
        // A workspace directory this manager never mounted has no durable
        // Overlay identity, so a read-only lookup reports nothing rather than
        // guessing readiness.
        let fixture = fixture();
        let key = workspace(&fixture, "ws_unknown_status");
        assert!(fixture.manager.lookup(&key).is_none());
        let never_used = fixture.workspace_root.join("ws_never");
        std::fs::create_dir(&never_used).unwrap();
        let key = fixture.manager.resolve_workspace(&never_used).unwrap();
        assert!(fixture.manager.lookup(&key).is_none());
    }

    #[test]
    fn the_overlay_crate_has_no_reverse_dependency() {
        let manifest =
            std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).unwrap();
        let dependencies = manifest
            .split("[dependencies]")
            .nth(1)
            .expect("a dependencies section");
        for forbidden in [
            "nession-protocol",
            "nession-agent",
            "nession-sandbox",
            "nession-server",
            "nession-tmux",
        ] {
            assert!(
                !dependencies.contains(forbidden),
                "nession-erofs must not depend on {forbidden}"
            );
        }
    }

    impl Fixture {
        fn reopen(&self) -> Arc<OverlayMountManager> {
            OverlayMountManager::open_with_backend(
                OverlayMountManagerConfig {
                    root: self.manager_root.clone(),
                    workspace_roots: vec![self.workspace_root.clone()],
                    settings: OverlaySettings::new("/bin/true", "/bin/true"),
                    lower: Arc::new(FakeLowerProvider {
                        root: self.lower_root.clone(),
                        state: Arc::clone(&self.lower_state),
                    }),
                    identity: "agent-test".to_string(),
                },
                self.backend.clone(),
            )
            .unwrap()
        }
    }

    impl OverlayMountManager {
        /// Test seam: detach the in-process ownership without unmounting, as a
        /// process crash would, so a second manager can adopt durable state.
        fn abandon_for_test(&self, workspace: &OverlayWorkspaceKey) {
            let mut entries = lock(&self.inner.entries);
            if let Some(entry) = entries.remove(&workspace.identity()) {
                let mut state = lock(&entry.state);
                state.owner = None;
                state.lower = None;
                state.binding = None;
                state.consumers.clear();
                state.phase = OverlayState::Idle;
            }
        }
    }

    impl OverlayWorkspaceKey {
        fn identity_marker_exists(&self) -> bool {
            storage::owner_holder(&self.directory())
                .join(storage::OWNER_FILE)
                .exists()
        }
    }
}
