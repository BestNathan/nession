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
use nession_erofs::mount_manager::{MountManager, VerifiedImage};

use crate::error::{Result, SandboxError};
use crate::policy::CompiledWorkspace;
use crate::settings::SandboxSettings;

use super::overlay::{OverlayMountManager, OverlayRequest};
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
        MountSource::Overlay { .. } => {
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
        let MountSource::Overlay { workspace, lower } = &entry.source else {
            return Err(SandboxError::InvalidPolicy(
                "the Workspace Overlay backend received a non-Overlay source".to_string(),
            ));
        };
        let canonical = verify_erofs_source(lower, &self.image_root)?;
        let verified = VerifiedImage::new(lower.digest.clone(), canonical)
            .map_err(|error| SandboxError::Prepare(format!("{error:#}")))?;
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
                lower_digest: binding.lower_digest.clone(),
                lower_mountpoint: binding.lower_mountpoint.clone(),
                lower_generation: binding.lower_generation,
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
            image: None,
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
            source: MountSource::Overlay {
                workspace: manager.resolve_workspace(workspace).unwrap(),
                lower,
            },
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
            lower_digest: recorded_lower,
            ..
        } = &first.recovery().source
        else {
            panic!("an Overlay recovery binding");
        };
        assert_eq!(
            recorded.identity(),
            manager.resolve_workspace(&workspace).unwrap().identity()
        );
        assert_eq!(recorded_lower, &lower_digest);

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
        let MountSource::Overlay { workspace, .. } = &entry.source else {
            panic!("an Overlay source");
        };
        workspace.clone()
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
