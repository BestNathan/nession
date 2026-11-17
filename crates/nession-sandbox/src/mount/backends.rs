//! The typed Mount backends (#3695).
//!
//! Every backend resolves exactly one source kind:
//!
//! - [`ErofsRoBackend`] delegates physical read-only mounts to the reusable
//!   `nession_erofs::mount_manager::MountManager`;
//! - [`OverlayBackend`] leases the one shared writable Workspace Merged View
//!   from [`crate::mount::overlay::OverlayMountManager`];
//! - [`BindBackend`] binds an Agent-validated canonical directory.
//!
//! Missing managers are explicit `UnsupportedPolicy` failures. None of these
//! backends creates an execution-scoped physical EROFS or Workspace Overlay.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use nession_erofs::digest::file_digest;
use nession_erofs::mount_manager::{MountLease, MountManager, VerifiedImage};

use crate::error::{Result, SandboxError};
use crate::policy::CompiledWorkspace;
use crate::settings::SandboxSettings;

use super::overlay::{
    self, OverlayMountManager, OverlayMountSpec, OverlayRequest, OverlaySettings,
};
use super::plan::{ErofsSource, MountConsumer, MountPlanEntry, MountSource, MountSourceKind};
use super::view::{MountRecoveryBinding, MountRecoverySource, MountedView, ViewLease};

/// One physical backend family.
pub trait MountBackend: Send + Sync {
    fn kind(&self) -> MountSourceKind;

    /// Acquire one identified consumer over the prepared view.
    fn acquire(&self, entry: &MountPlanEntry, consumer: &MountConsumer) -> Result<MountedView>;
}

/// Resolve one planned entry through its backend.
pub(super) fn acquire(
    entry: &MountPlanEntry,
    consumer: &MountConsumer,
    settings: &SandboxSettings,
    execution_dir: &Path,
) -> Result<MountedView> {
    match &entry.source {
        MountSource::Erofs(_) => {
            let manager = settings.mount_manager.clone().ok_or_else(|| {
                SandboxError::UnsupportedPolicy(
                    "the Agent's shared EROFS read-only mount manager is not configured"
                        .to_string(),
                )
            })?;
            let image_root = settings.erofs_image_root.clone().ok_or_else(|| {
                SandboxError::UnsupportedPolicy(
                    "no Agent-authorized EROFS image root is configured".to_string(),
                )
            })?;
            ErofsRoBackend::new(manager, image_root).acquire(entry, consumer)
        }
        MountSource::Overlay(source) if source.workspace.is_some() => {
            let manager = settings.overlay_manager.clone().ok_or_else(|| {
                SandboxError::UnsupportedPolicy(
                    "the Agent's shared Workspace Overlay manager is not configured".to_string(),
                )
            })?;
            let image_root = settings.erofs_image_root.clone().ok_or_else(|| {
                SandboxError::UnsupportedPolicy(
                    "the Workspace Overlay lower requires an Agent-authorized EROFS image root"
                        .to_string(),
                )
            })?;
            OverlayBackend::new(manager, image_root).acquire(entry, consumer)
        }
        MountSource::Overlay(_) => {
            TransientRootfsBackend::new(settings.clone(), execution_dir).acquire(entry, consumer)
        }
        MountSource::Bind {
            directory,
            ownership,
        } => BindBackend::new(settings.clone()).acquire(
            &MountPlanEntry {
                role: entry.role,
                source: MountSource::Bind {
                    directory: directory.clone(),
                    ownership: *ownership,
                },
                target: entry.target.clone(),
            },
            consumer,
        ),
    }
}

/// Read-only EROFS views, delegated to the reusable EROFS mount manager.
pub struct ErofsRoBackend {
    manager: Arc<MountManager>,
    image_root: PathBuf,
}

impl ErofsRoBackend {
    pub fn new(manager: Arc<MountManager>, image_root: PathBuf) -> Self {
        Self {
            manager,
            image_root,
        }
    }
}

impl MountBackend for ErofsRoBackend {
    fn kind(&self) -> MountSourceKind {
        MountSourceKind::Erofs
    }

    fn acquire(&self, entry: &MountPlanEntry, consumer: &MountConsumer) -> Result<MountedView> {
        let MountSource::Erofs(source) = &entry.source else {
            return Err(SandboxError::InvalidPolicy(
                "the EROFS read-only backend received a non-EROFS source".to_string(),
            ));
        };
        let canonical = verify_erofs_source(source, &self.image_root)?;
        let verified = VerifiedImage::new(source.digest.clone(), canonical)
            .map_err(|error| SandboxError::Prepare(format!("{error:#}")))?;
        let lease = self
            .manager
            .acquire(&verified, consumer.execution_id())
            .map_err(|error| {
                SandboxError::Prepare(format!(
                    "could not acquire the shared read-only EROFS mount {}: {error:#}",
                    source.digest
                ))
            })?;
        let mountpoint = lease.mountpoint().to_path_buf();
        let recovery = MountRecoveryBinding {
            role: entry.role,
            target: entry.target.clone(),
            source: MountRecoverySource::Erofs {
                digest: lease.digest().to_string(),
                mountpoint: mountpoint.clone(),
                generation: lease.generation().to_string(),
            },
        };
        Ok(MountedView::new(
            entry.clone(),
            mountpoint,
            recovery,
            ViewLease::Erofs(lease),
        ))
    }
}

/// The shared writable Workspace Overlay backend.
pub struct OverlayBackend {
    manager: Arc<OverlayMountManager>,
    image_root: PathBuf,
}

impl OverlayBackend {
    pub fn new(manager: Arc<OverlayMountManager>, image_root: PathBuf) -> Self {
        Self {
            manager,
            image_root,
        }
    }
}

impl MountBackend for OverlayBackend {
    fn kind(&self) -> MountSourceKind {
        MountSourceKind::Overlay
    }

    fn acquire(&self, entry: &MountPlanEntry, consumer: &MountConsumer) -> Result<MountedView> {
        let MountSource::Overlay(source) = &entry.source else {
            return Err(SandboxError::InvalidPolicy(
                "the Workspace Overlay backend received a non-Overlay source".to_string(),
            ));
        };
        let Some(workspace) = &source.workspace else {
            return Err(SandboxError::InvalidPolicy(
                "the Workspace Overlay backend received a transient RootFS source".to_string(),
            ));
        };
        let verified = verify_erofs_sources(&source.lowers, &self.image_root)?;
        let lease = self
            .manager
            .acquire(
                &OverlayRequest::new(workspace.clone(), verified),
                consumer.execution_id(),
            )
            .map_err(|error| {
                SandboxError::Prepare(format!(
                    "could not acquire the shared Workspace Overlay of {}: {error:#}",
                    workspace.identity()
                ))
            })?;
        let binding = lease.binding();
        let mountpoint = lease.mountpoint().to_path_buf();
        let recovery = MountRecoveryBinding {
            role: entry.role,
            target: entry.target.clone(),
            source: MountRecoverySource::Overlay {
                workspace: binding.workspace.clone(),
                mountpoint: mountpoint.clone(),
                generation: binding.generation.clone(),
                lowers: binding.effective_lowers(),
            },
        };
        Ok(MountedView::new(
            entry.clone(),
            mountpoint,
            recovery,
            ViewLease::Overlay(lease),
        ))
    }
}

/// One execution-owned, disposable writable RootFS.
pub(super) struct TransientRootfsLease {
    settings: OverlaySettings,
    mountpoint: PathBuf,
    upper: PathBuf,
    work: PathBuf,
    lower: Option<MountLease>,
}

impl TransientRootfsLease {
    /// Strictly unmount, then remove the ephemeral upper/work, then release
    /// the read-only base consumer. A failed unmount retains everything.
    pub(super) fn release(mut self) -> Result<()> {
        if overlay::mount::is_overlay_mount(&self.mountpoint) {
            if let Err(error) = overlay::mount::unmount_overlay(&self.settings, &self.mountpoint) {
                let mountpoint = self.mountpoint.display().to_string();
                // The live Merged View still depends on the read-only lower.
                // Keep the consumer registered for record reconciliation
                // instead of dropping the lease (which would release it).
                std::mem::forget(self);
                return Err(SandboxError::Cleanup(format!(
                    "could not unmount the transient RootFS at {mountpoint}: {error:#}"
                )));
            }
        } else if nession_erofs::mount::is_mounted(&self.mountpoint) {
            let mountpoint = self.mountpoint.display().to_string();
            // A foreign mount at the owned path is unresolved state: keep the
            // read-only lower registered for the durable record's retry.
            std::mem::forget(self);
            return Err(SandboxError::Cleanup(format!(
                "the transient RootFS path {mountpoint} is a foreign mount; refusing to unmount it"
            )));
        }
        remove_owned_directory(&self.upper)?;
        remove_owned_directory(&self.work)?;
        if let Some(lower) = self.lower.take() {
            lower.release().map_err(|error| {
                SandboxError::Cleanup(format!(
                    "could not release the transient RootFS base lower: {error:#}"
                ))
            })?;
        }
        Ok(())
    }
}

/// Transient writable RootFS views (#3698).
pub struct TransientRootfsBackend {
    settings: SandboxSettings,
    execution_dir: PathBuf,
}

impl TransientRootfsBackend {
    pub fn new(settings: SandboxSettings, execution_dir: &Path) -> Self {
        Self {
            settings,
            execution_dir: execution_dir.to_path_buf(),
        }
    }
}

impl MountBackend for TransientRootfsBackend {
    fn kind(&self) -> MountSourceKind {
        MountSourceKind::Overlay
    }

    fn acquire(&self, entry: &MountPlanEntry, consumer: &MountConsumer) -> Result<MountedView> {
        let MountSource::Overlay(source) = &entry.source else {
            return Err(SandboxError::InvalidPolicy(
                "the transient RootFS backend received a non-Overlay source".to_string(),
            ));
        };
        if source.workspace.is_some() {
            return Err(SandboxError::InvalidPolicy(
                "the transient RootFS backend received a managed Workspace source".to_string(),
            ));
        }
        if source.lowers.len() != 1 {
            return Err(SandboxError::InvalidPolicy(
                "a writable RootFS has exactly one immutable Base lower".to_string(),
            ));
        }
        let overlay_settings = OverlaySettings::new(
            self.settings.fuse_overlayfs_path.clone(),
            self.settings.fusermount_path.clone(),
        );
        let (available, reason) = overlay::mount::probe(&overlay_settings);
        if !available {
            return Err(SandboxError::UnsupportedPolicy(format!(
                "a writable RootFS requires the unprivileged Overlay helpers: {}",
                reason.unwrap_or_else(|| "unavailable".to_string())
            )));
        }
        let image_root = self.settings.erofs_image_root.as_ref().ok_or_else(|| {
            SandboxError::UnsupportedPolicy(
                "a writable RootFS requires an Agent-authorized EROFS image root".to_string(),
            )
        })?;
        let manager = self.settings.mount_manager.as_ref().ok_or_else(|| {
            SandboxError::UnsupportedPolicy(
                "a writable RootFS requires the shared EROFS read-only mount manager".to_string(),
            )
        })?;
        let source = source.lowers.first().ok_or_else(|| {
            SandboxError::InvalidPolicy(
                "a writable RootFS has exactly one immutable Base lower".to_string(),
            )
        })?;
        let canonical = verify_erofs_source(source, image_root)?;
        let verified = VerifiedImage::new(source.digest.clone(), canonical)
            .map_err(|error| SandboxError::Prepare(format!("{error:#}")))?;
        let lower = manager
            .acquire(&verified, consumer.execution_id())
            .map_err(|error| {
                SandboxError::Prepare(format!(
                    "could not acquire the writable RootFS base lower {}: {error:#}",
                    source.digest
                ))
            })?;
        let transient_root = self.execution_dir.join("rootfs-overlay");
        // Persist the rollback identity before exposing a physical mount. If
        // the record cannot be written, no mount exists yet: release the
        // consumer and fail closed rather than owning unrecorded state.
        let transient_record = crate::exec::TransientRootfsRecord {
            mountpoint: transient_root.join("merged").display().to_string(),
            upper: transient_root.join("upper").display().to_string(),
            work: transient_root.join("work").display().to_string(),
        };
        let lower_shared = crate::exec::SharedMountRecord {
            digest: lower.digest().to_string(),
            mountpoint: lower.mountpoint().display().to_string(),
            generation: lower.generation().to_string(),
        };
        if let Err(error) = crate::exec::write_recovery_pending(
            &self.settings,
            consumer.execution_id(),
            &self.execution_dir,
            transient_record,
            vec![lower_shared],
        ) {
            let _ = lower.release();
            return Err(SandboxError::Prepare(format!(
                "could not persist the transient RootFS recovery record: {error:#}"
            )));
        }
        let setup = (|| -> Result<(PathBuf, PathBuf, PathBuf)> {
            create_owned_directory(&transient_root)?;
            let upper = transient_root.join("upper");
            let work = transient_root.join("work");
            create_owned_directory(&upper)?;
            create_owned_directory(&work)?;
            let facts = overlay::probe::probe_storage(&upper, &work)
                .map_err(|error| SandboxError::Prepare(format!("{error:#}")))?;
            facts
                .validate_paths(&upper, &work)
                .map_err(|error| SandboxError::Prepare(format!("{error:#}")))?;
            let merged = transient_root.join("merged");
            let spec = OverlayMountSpec {
                lowers: vec![lower.mountpoint().to_path_buf()],
                upper: upper.clone(),
                work: work.clone(),
                merged: merged.clone(),
            };
            overlay::mount::mount_overlay(&spec, &overlay_settings)
                .map_err(|error| SandboxError::Prepare(format!("{error:#}")))?;
            if !overlay::mount::is_overlay_mount(&merged) {
                let rollback = overlay::mount::unmount_overlay(&overlay_settings, &merged);
                return Err(SandboxError::Prepare(match rollback {
                    Ok(()) => format!(
                        "the RootFS helper reported success but {} is not a fuse-overlayfs mount",
                        merged.display()
                    ),
                    Err(rollback) => format!(
                        "the RootFS helper reported success but {} is not a fuse-overlayfs mount; \
                         verified rollback also failed: {rollback:#}",
                        merged.display()
                    ),
                }));
            }
            Ok((upper, work, merged))
        })();
        let (upper, work, mountpoint) = match setup {
            Ok(paths) => paths,
            Err(error) => {
                let merged = transient_root.join("merged");
                let unmount_ok = if overlay::mount::is_overlay_mount(&merged) {
                    overlay::mount::unmount_overlay(&overlay_settings, &merged).is_ok()
                } else {
                    true
                };
                // The durable recovery record is the rollback owner. Keep it
                // whenever any owned part — the live Merged View, its lower
                // consumer, or a temporary directory — could not be released.
                let mut retained = !unmount_ok;
                let mut retained_lower = Some(lower);
                if unmount_ok {
                    if remove_owned_directory(&transient_root).is_ok() {
                        let released = match retained_lower.take() {
                            Some(lower) => lower.release().is_ok(),
                            None => false,
                        };
                        if released {
                            crate::exec::remove_recovery_record(
                                &self.settings,
                                consumer.execution_id(),
                            );
                        }
                    } else {
                        retained = true;
                    }
                }
                if retained {
                    if let Some(lower) = retained_lower.take() {
                        // The live Merged View still depends on the read-only
                        // lower. Keep the consumer registered for the record's
                        // retry instead of dropping the lease.
                        std::mem::forget(lower);
                    }
                }
                return Err(error);
            }
        };
        let recovery = MountRecoveryBinding {
            role: entry.role,
            target: entry.target.clone(),
            source: MountRecoverySource::TransientRootfs {
                mountpoint: mountpoint.clone(),
                upper: upper.clone(),
                work: work.clone(),
                lower_digest: lower.digest().to_string(),
                lower_mountpoint: lower.mountpoint().to_path_buf(),
                lower_generation: lower.generation().to_string(),
            },
        };
        Ok(MountedView::new(
            entry.clone(),
            mountpoint.clone(),
            recovery,
            ViewLease::TransientRootfs(TransientRootfsLease {
                settings: overlay_settings,
                mountpoint,
                upper,
                work,
                lower: Some(lower),
            }),
        ))
    }
}

fn create_owned_directory(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(SandboxError::Prepare(format!(
                    "the transient RootFS directory {} must be a real directory",
                    path.display()
                )));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(path).map_err(|error| {
                SandboxError::Prepare(format!(
                    "could not create the transient RootFS directory {}: {error}",
                    path.display()
                ))
            })?;
        }
        Err(error) => {
            return Err(SandboxError::Prepare(format!(
                "could not inspect the transient RootFS directory {}: {error}",
                path.display()
            )))
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn remove_owned_directory(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(SandboxError::Cleanup(format!(
            "refusing to remove symlinked transient RootFS path {}",
            path.display()
        ))),
        Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(path).map_err(|error| {
            SandboxError::Cleanup(format!(
                "could not remove the transient RootFS directory {}: {error}",
                path.display()
            ))
        }),
        Ok(_) => Err(SandboxError::Cleanup(format!(
            "the transient RootFS path {} is not a directory",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(SandboxError::Cleanup(format!(
            "could not inspect the transient RootFS path {}: {error}",
            path.display()
        ))),
    }
}

/// Agent-validated canonical directory binds.
pub struct BindBackend {
    settings: SandboxSettings,
}

impl BindBackend {
    pub fn new(settings: SandboxSettings) -> Self {
        Self { settings }
    }
}

impl MountBackend for BindBackend {
    fn kind(&self) -> MountSourceKind {
        MountSourceKind::Bind
    }

    fn acquire(&self, entry: &MountPlanEntry, _consumer: &MountConsumer) -> Result<MountedView> {
        let MountSource::Bind {
            directory,
            ownership,
        } = &entry.source
        else {
            return Err(SandboxError::InvalidPolicy(
                "the Bind backend received a non-Bind source".to_string(),
            ));
        };
        let workspace = CompiledWorkspace {
            lowers: Vec::new(),
            write: directory.clone(),
            ownership: *ownership,
        };
        let canonical = crate::exec::validate_composition_workspace(&workspace, &self.settings)?;
        let recovery = MountRecoveryBinding {
            role: entry.role,
            target: entry.target.clone(),
            source: MountRecoverySource::Bind {
                directory: canonical.clone(),
                ownership: *ownership,
            },
        };
        Ok(MountedView::new(
            entry.clone(),
            canonical,
            recovery,
            ViewLease::Bind,
        ))
    }
}

fn verify_erofs_sources(sources: &[ErofsSource], image_root: &Path) -> Result<Vec<VerifiedImage>> {
    if sources.is_empty() {
        return Err(SandboxError::InvalidPolicy(
            "an Overlay needs at least one read-only lower".to_string(),
        ));
    }
    let mut verified = Vec::with_capacity(sources.len());
    for source in sources {
        let canonical = verify_erofs_source(source, image_root)?;
        verified.push(
            VerifiedImage::new(source.digest.clone(), canonical)
                .map_err(|error| SandboxError::Prepare(format!("{error:#}")))?,
        );
    }
    Ok(verified)
}

/// Re-verify the exact authorized local bytes of one EROFS source.
///
/// The Sandbox never trusts the prepared path or digest: the path must be a
/// real regular file below the Agent-authorized image root and the current
/// bytes must hash to the prepared digest.
pub(crate) fn verify_erofs_source(source: &ErofsSource, image_root: &Path) -> Result<PathBuf> {
    let metadata = std::fs::symlink_metadata(&source.source).map_err(|error| {
        SandboxError::InvalidPolicy(format!(
            "EROFS image {} does not exist: {error}",
            source.source.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(SandboxError::InvalidPolicy(format!(
            "EROFS image {} must be a regular file, not a symlink",
            source.source.display()
        )));
    }
    if metadata.len() == 0 {
        return Err(SandboxError::InvalidPolicy(format!(
            "EROFS image {} is empty",
            source.source.display()
        )));
    }
    let canonical = std::fs::canonicalize(&source.source).map_err(|error| {
        SandboxError::InvalidPolicy(format!(
            "EROFS image {} cannot be resolved: {error}",
            source.source.display()
        ))
    })?;
    let canonical_root = std::fs::canonicalize(image_root).map_err(|error| {
        SandboxError::InvalidPolicy(format!(
            "the Agent-authorized EROFS image root {} cannot be resolved: {error}",
            image_root.display()
        ))
    })?;
    if !canonical.starts_with(&canonical_root) {
        return Err(SandboxError::InvalidPolicy(format!(
            "EROFS image {} is outside the Agent-authorized image root {}",
            canonical.display(),
            canonical_root.display()
        )));
    }
    let actual = file_digest(&canonical).map_err(|error| {
        SandboxError::InvalidPolicy(format!(
            "EROFS image {} cannot be verified: {error:#}",
            canonical.display()
        ))
    })?;
    if actual != source.digest {
        return Err(SandboxError::InvalidPolicy(format!(
            "EROFS image {} digest {actual} does not match the prepared digest {}",
            canonical.display(),
            source.digest
        )));
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nession_protocol::contracts::sandbox::v1::SandboxWorkspaceOwnership;

    fn erofs_file(directory: &Path, name: &str, bytes: &[u8]) -> ErofsSource {
        let path = directory.join(name);
        std::fs::write(&path, bytes).unwrap();
        ErofsSource::new(nession_erofs::digest::digest_of_bytes(bytes), path)
    }

    #[test]
    fn a_digest_mismatch_is_refused_before_mounting() {
        let root = tempfile::tempdir().unwrap();
        let images = root.path().join("images");
        std::fs::create_dir_all(&images).unwrap();
        let source = ErofsSource::new(
            nession_erofs::digest::digest_of_bytes(b"different bytes"),
            images.join("base.erofs"),
        );
        std::fs::write(&source.source, b"real bytes").unwrap();
        let error = verify_erofs_source(&source, &images).unwrap_err();
        assert!(
            format!("{error}").contains("does not match the prepared digest"),
            "{error}"
        );
    }

    #[test]
    fn a_source_outside_the_authorized_root_is_refused_before_mounting() {
        let root = tempfile::tempdir().unwrap();
        let images = root.path().join("images");
        std::fs::create_dir_all(&images).unwrap();
        let outside = root.path().join("outside.erofs");
        std::fs::write(&outside, b"bytes").unwrap();
        let source = ErofsSource::new(nession_erofs::digest::digest_of_bytes(b"bytes"), outside);
        let error = verify_erofs_source(&source, &images).unwrap_err();
        assert!(
            format!("{error}").contains("outside the Agent-authorized image root"),
            "{error}"
        );
    }

    #[test]
    fn an_authorized_regular_file_verifies_to_its_canonical_path() {
        let root = tempfile::tempdir().unwrap();
        let source = erofs_file(root.path(), "base.erofs", b"image bytes");
        assert_eq!(
            verify_erofs_source(&source, root.path()).unwrap(),
            std::fs::canonicalize(&source.source).unwrap()
        );
    }

    #[test]
    fn a_bind_backend_returns_the_validated_canonical_directory() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("state");
        let workspace = state.join("workspace-a");
        std::fs::create_dir_all(&workspace).unwrap();
        let settings = SandboxSettings::new(
            state,
            PathBuf::from("/bin/true"),
            PathBuf::from("/bin/true"),
            PathBuf::from("/bin/true"),
        );
        let entry = MountPlanEntry {
            role: super::super::plan::MountRole::Workspace,
            source: MountSource::Bind {
                directory: workspace.clone(),
                ownership: SandboxWorkspaceOwnership::Agent,
            },
            target: PathBuf::from("/workspace"),
        };
        let consumer = MountConsumer::new("exec-bind").unwrap();
        let view = BindBackend::new(settings)
            .acquire(&entry, &consumer)
            .unwrap();
        assert_eq!(view.host_view(), std::fs::canonicalize(&workspace).unwrap());
        assert_eq!(view.target(), Path::new("/workspace"));
        assert!(view.is_bound());
        let mut view = view;
        view.release().unwrap();
        assert!(view.release().is_ok(), "release is idempotent");
    }

    use crate::mount::overlay::manager::OverlayMountBackend;
    use crate::mount::overlay::manager::{LowerAdoption, LowerLease, LowerProvider, LowerStatus};
    use crate::mount::overlay::{
        OverlayMountManager, OverlayMountManagerConfig, OverlaySettings, OverlayState,
    };
    use nession_erofs::mount_manager::{ConsumerRef, VerifiedImage};
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    struct FakeOverlayBackend {
        mounted: Mutex<HashSet<PathBuf>>,
        mounts: AtomicUsize,
    }

    impl OverlayMountBackend for FakeOverlayBackend {
        fn mount(
            &self,
            spec: &super::super::overlay::OverlayMountSpec,
            _settings: &OverlaySettings,
        ) -> anyhow::Result<()> {
            std::fs::create_dir_all(&spec.merged).unwrap();
            self.mounted.lock().unwrap().insert(spec.merged.clone());
            self.mounts.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn unmount(&self, _settings: &OverlaySettings, mountpoint: &Path) -> anyhow::Result<()> {
            self.mounted.lock().unwrap().remove(mountpoint);
            Ok(())
        }

        fn is_overlay_mount(&self, mountpoint: &Path) -> bool {
            self.mounted.lock().unwrap().contains(mountpoint)
        }

        fn storage_facts(
            &self,
            _upper: &Path,
            _work: &Path,
        ) -> anyhow::Result<super::super::overlay::probe::StorageFacts> {
            Ok(super::super::overlay::probe::StorageFacts::local_for_test())
        }
    }

    struct FakeLower {
        acquired: Arc<Mutex<HashSet<String>>>,
        released: Arc<Mutex<Vec<String>>>,
        consumer_id: String,
        digest: String,
        mountpoint: PathBuf,
    }

    impl LowerLease for FakeLower {
        fn mountpoint(&self) -> PathBuf {
            self.mountpoint.clone()
        }

        fn digest(&self) -> String {
            self.digest.clone()
        }

        fn generation(&self) -> String {
            "lower-generation".to_string()
        }

        fn release(self: Box<Self>) -> anyhow::Result<()> {
            self.acquired.lock().unwrap().remove(&self.consumer_id);
            self.released.lock().unwrap().push(self.consumer_id);
            Ok(())
        }
    }

    struct FakeLowerProvider {
        mountpoint: PathBuf,
        acquired: Arc<Mutex<HashSet<String>>>,
        released: Arc<Mutex<Vec<String>>>,
    }

    impl LowerProvider for FakeLowerProvider {
        fn acquire_lower(
            &self,
            _image: &VerifiedImage,
            consumer_id: &str,
        ) -> anyhow::Result<Box<dyn LowerLease>> {
            self.acquired
                .lock()
                .unwrap()
                .insert(consumer_id.to_string());
            Ok(Box::new(FakeLower {
                acquired: Arc::clone(&self.acquired),
                released: Arc::clone(&self.released),
                consumer_id: consumer_id.to_string(),
                digest: format!("sha256:{}", "b".repeat(64)),
                mountpoint: self.mountpoint.clone(),
            }))
        }

        fn adopt_lowers(&self, _consumers: &[ConsumerRef]) -> LowerAdoption {
            LowerAdoption::default()
        }

        fn release_lower(
            &self,
            _digest: &str,
            consumer_id: &str,
            _generation: Option<&str>,
        ) -> anyhow::Result<()> {
            self.acquired.lock().unwrap().remove(consumer_id);
            self.released.lock().unwrap().push(consumer_id.to_string());
            Ok(())
        }

        fn lower_status(&self, _digest: &str) -> Option<LowerStatus> {
            Some(LowerStatus {
                mountpoint: self.mountpoint.clone(),
                mounted: true,
                consumers: self.acquired.lock().unwrap().len(),
            })
        }
    }

    struct OverlayFixture {
        manager: Arc<OverlayMountManager>,
        lower: ErofsSource,
        workspace: PathBuf,
        acquired: Arc<Mutex<HashSet<String>>>,
        released: Arc<Mutex<Vec<String>>>,
        physical: Arc<FakeOverlayBackend>,
    }

    fn overlay_fixture(root: &Path) -> OverlayFixture {
        let images = root.join("images");
        std::fs::create_dir_all(&images).unwrap();
        let lower = erofs_file(&images, "project.erofs", b"project image");
        let workspace_root = root.join("workspaces");
        let workspace = workspace_root.join("ws_a");
        std::fs::create_dir_all(&workspace).unwrap();
        crate::mount::overlay::storage::initialize(&workspace).unwrap();
        let backend = Arc::new(FakeOverlayBackend {
            mounted: Mutex::new(HashSet::new()),
            mounts: AtomicUsize::new(0),
        });
        let acquired = Arc::new(Mutex::new(HashSet::new()));
        let released = Arc::new(Mutex::new(Vec::new()));
        let lower_mountpoint = root.join("lower-mount");
        std::fs::create_dir_all(&lower_mountpoint).unwrap();
        let manager = OverlayMountManager::open_with_backend(
            OverlayMountManagerConfig {
                root: root.join("overlay-root"),
                workspace_roots: vec![workspace_root],
                settings: OverlaySettings::new("/bin/true", "/bin/true"),
                lower: Arc::new(FakeLowerProvider {
                    mountpoint: lower_mountpoint,
                    acquired: Arc::clone(&acquired),
                    released: Arc::clone(&released),
                }),
                identity: "agent-test".to_string(),
            },
            backend.clone(),
        )
        .unwrap();
        OverlayFixture {
            manager,
            lower,
            workspace,
            acquired,
            released,
            physical: backend,
        }
    }

    fn overlay_entry(
        manager: &OverlayMountManager,
        lower: ErofsSource,
        workspace: &Path,
    ) -> MountPlanEntry {
        MountPlanEntry {
            role: super::super::plan::MountRole::Workspace,
            source: MountSource::Overlay(super::super::plan::OverlaySource {
                workspace: Some(manager.resolve_workspace(workspace).unwrap()),
                lowers: vec![lower],
            }),
            target: PathBuf::from("/workspace"),
        }
    }

    #[test]
    fn the_overlay_backend_returns_one_view_and_lease_for_two_consumers() {
        let root = tempfile::tempdir().unwrap();
        let OverlayFixture {
            manager,
            lower,
            workspace,
            acquired,
            released,
            physical,
        } = overlay_fixture(root.path());
        let image_root = root.path().join("images");
        let lower_digest = lower.digest.clone();
        let entry = overlay_entry(&manager, lower, &workspace);
        let backend = OverlayBackend::new(Arc::clone(&manager), image_root);
        let first = backend
            .acquire(&entry, &MountConsumer::new("exec-a").unwrap())
            .unwrap();
        let second = backend
            .acquire(&entry, &MountConsumer::new("exec-b").unwrap())
            .unwrap();
        assert_eq!(first.host_view(), second.host_view());
        assert_eq!(first.target(), Path::new("/workspace"));
        assert_eq!(first.source_kind(), MountSourceKind::Overlay);
        assert_eq!(physical.mounts.load(Ordering::SeqCst), 1);
        let MountRecoverySource::Overlay {
            workspace: recorded,
            lowers,
            ..
        } = &first.recovery().source
        else {
            panic!("an Overlay recovery binding");
        };
        assert_eq!(
            recorded.identity(),
            manager.resolve_workspace(&workspace).unwrap().identity()
        );
        assert_eq!(
            lowers.first().map(|lower| lower.digest.as_str()),
            Some(lower_digest.as_str())
        );

        let mut first = first;
        first.release().unwrap();
        assert_eq!(physical.mounted.lock().unwrap().len(), 1);
        assert_eq!(released.lock().unwrap().len(), 0);
        let mut second = second;
        second.release().unwrap();
        assert!(physical.mounted.lock().unwrap().is_empty());
        assert_eq!(released.lock().unwrap().len(), 1);
        assert!(acquired.lock().unwrap().is_empty());
        assert_eq!(
            manager.lookup(&entry_workspace(&entry)).unwrap().state,
            OverlayState::Idle
        );
    }

    fn entry_workspace(entry: &MountPlanEntry) -> crate::mount::overlay::OverlayWorkspaceKey {
        let MountSource::Overlay(source) = &entry.source else {
            panic!("an Overlay source");
        };
        source.workspace.clone().expect("a persistent workspace")
    }

    #[test]
    fn a_missing_bind_directory_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let settings = SandboxSettings::new(
            root.path().join("state"),
            PathBuf::from("/bin/true"),
            PathBuf::from("/bin/true"),
            PathBuf::from("/bin/true"),
        );
        let entry = MountPlanEntry {
            role: super::super::plan::MountRole::Workspace,
            source: MountSource::Bind {
                directory: root.path().join("missing"),
                ownership: SandboxWorkspaceOwnership::Agent,
            },
            target: PathBuf::from("/workspace"),
        };
        let error = BindBackend::new(settings)
            .acquire(&entry, &MountConsumer::new("exec-bind").unwrap())
            .unwrap_err();
        assert!(format!("{error}").contains("does not exist"), "{error}");
    }
}
