//! Live mounted views and their explicit release (#3695).
//!
//! A [`MountedView`] is the pair of a prepared host view and its independent
//! Sandbox target. It retains the consumer lease that keeps the physical
//! resource alive and a serializable recovery binding for the durable
//! execution record. Releasing a view releases only that identified consumer;
//! physical unmount authority stays with the owning backend manager.

use std::path::{Path, PathBuf};

use nession_protocol::contracts::sandbox::v1::SandboxWorkspaceOwnership;
use serde::{Deserialize, Serialize};

use crate::error::{Result, SandboxError};
use crate::exec::SharedMountRecord;

use super::overlay::{OverlayBinding, OverlayLease, OverlayLowerBinding, OverlayWorkspaceKey};
use super::plan::{MountPlanEntry, MountRole, MountSource, MountSourceKind};

/// The serialized recovery binding of one mounted view.
///
/// It names the authorized identity and manager-derived host mountpoint, never
/// a caller-supplied path. A restarted Agent can release or adopt exactly the
/// consumer this record names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MountRecoveryBinding {
    pub role: MountRole,
    pub target: PathBuf,
    pub source: MountRecoverySource,
}

/// The typed recovery identity of one view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MountRecoverySource {
    /// A consumer lease over a shared read-only EROFS mount.
    Erofs {
        digest: String,
        mountpoint: PathBuf,
        generation: String,
    },
    /// A consumer lease over the shared writable Workspace Overlay.
    Overlay {
        workspace: OverlayWorkspaceKey,
        mountpoint: PathBuf,
        generation: String,
        lowers: Vec<OverlayLowerBinding>,
    },
    /// An execution-owned transient writable RootFS. Its upper/work are
    /// disposable after a verified unmount.
    TransientRootfs {
        mountpoint: PathBuf,
        upper: PathBuf,
        work: PathBuf,
        lower_digest: String,
        lower_mountpoint: PathBuf,
        lower_generation: String,
    },
    /// An Agent-validated directory with no physical lease of its own.
    Bind {
        directory: PathBuf,
        ownership: SandboxWorkspaceOwnership,
    },
}

/// The lease a view retains. Only the owning backend manager may unmount.
pub(super) enum ViewLease {
    Erofs(nession_erofs::mount_manager::MountLease),
    Overlay(OverlayLease),
    TransientRootfs(super::backends::TransientRootfsLease),
    Bind,
}

impl ViewLease {
    fn release(self) -> Result<()> {
        match self {
            Self::Erofs(lease) => lease.release().map_err(|error| {
                SandboxError::Cleanup(format!(
                    "could not release the shared EROFS consumer: {error:#}"
                ))
            }),
            Self::Overlay(lease) => lease.release().map_err(|error| {
                SandboxError::Cleanup(format!(
                    "could not release the shared Workspace Overlay consumer: {error:#}"
                ))
            }),
            Self::TransientRootfs(lease) => lease.release(),
            Self::Bind => Ok(()),
        }
    }
}

/// One live view and its consumer lease.
pub struct MountedView {
    entry: MountPlanEntry,
    host_view: PathBuf,
    recovery: MountRecoveryBinding,
    lease: Option<ViewLease>,
}

impl std::fmt::Debug for MountedView {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MountedView")
            .field("role", &self.entry.role)
            .field("target", &self.entry.target)
            .field("host_view", &self.host_view)
            .field("has_lease", &self.lease.is_some())
            .finish()
    }
}

impl MountedView {
    pub(super) fn new(
        entry: MountPlanEntry,
        host_view: PathBuf,
        recovery: MountRecoveryBinding,
        lease: ViewLease,
    ) -> Self {
        Self {
            entry,
            host_view,
            recovery,
            lease: Some(lease),
        }
    }

    pub fn role(&self) -> MountRole {
        self.entry.role
    }

    pub fn source_kind(&self) -> MountSourceKind {
        self.entry.source_kind()
    }

    /// The host view path. It is derived by the backend, never by the plan.
    pub fn host_view(&self) -> &Path {
        &self.host_view
    }

    /// The independent in-Sandbox target.
    pub fn target(&self) -> &Path {
        &self.entry.target
    }

    pub fn recovery(&self) -> &MountRecoveryBinding {
        &self.recovery
    }

    pub fn is_bound(&self) -> bool {
        matches!(self.entry.source, MountSource::Bind { .. })
    }

    /// Release this identified consumer explicitly. Idempotent.
    pub fn release(&mut self) -> Result<()> {
        match self.lease.take() {
            Some(lease) => lease.release(),
            None => Ok(()),
        }
    }
}

impl Drop for MountedView {
    fn drop(&mut self) {
        let _ = self.release();
    }
}

/// How the `/workspace` view is installed in the launcher plan.
#[derive(Debug, Clone)]
pub enum WorkspaceMount {
    /// A prepared writable directory with no Project image.
    Bind(PathBuf),
    /// A `fuse-overlayfs` merge of the Project image and the Agent-owned
    /// writable upper/work directories.
    Overlay(PathBuf),
}

/// Host views the launcher binds into the Sandbox.
#[derive(Debug, Clone)]
pub struct ResolvedComposition {
    pub base: PathBuf,
    /// Whether the launcher binds the Base host view writable. A transient
    /// RootFS is merged with an execution-owned upper/work.
    pub base_writable: bool,
    pub workspace: WorkspaceMount,
    /// `(sandbox target, host view)`, sorted by target.
    pub toolchains: Vec<(PathBuf, PathBuf)>,
}

/// Every view and lease owned by one execution.
pub struct MountedComposition {
    views: Vec<MountedView>,
    resolved: ResolvedComposition,
}

impl MountedComposition {
    pub(super) fn new(views: Vec<MountedView>) -> Result<Self> {
        let base_view = views
            .iter()
            .find(|view| view.role() == MountRole::Base)
            .ok_or_else(|| {
                SandboxError::InvalidPolicy("the mount plan has no Base view".to_string())
            })?;
        let base = base_view.host_view().to_path_buf();
        let base_writable = base_view.source_kind() == MountSourceKind::Overlay;
        let workspace_view = views
            .iter()
            .find(|view| view.role() == MountRole::Workspace)
            .ok_or_else(|| {
                SandboxError::InvalidPolicy("the mount plan has no Workspace view".to_string())
            })?;
        let workspace = match workspace_view.source_kind() {
            MountSourceKind::Bind => WorkspaceMount::Bind(workspace_view.host_view().to_path_buf()),
            MountSourceKind::Overlay => {
                WorkspaceMount::Overlay(workspace_view.host_view().to_path_buf())
            }
            MountSourceKind::Erofs => {
                return Err(SandboxError::InvalidPolicy(
                    "the Workspace view cannot be a read-only EROFS image".to_string(),
                ))
            }
        };
        let mut toolchains: Vec<(PathBuf, PathBuf)> = views
            .iter()
            .filter(|view| view.role() == MountRole::Toolchain)
            .map(|view| (view.target().to_path_buf(), view.host_view().to_path_buf()))
            .collect();
        toolchains.sort();
        Ok(Self {
            views,
            resolved: ResolvedComposition {
                base,
                base_writable,
                workspace,
                toolchains,
            },
        })
    }

    pub fn resolved(&self) -> &ResolvedComposition {
        &self.resolved
    }

    pub fn views(&self) -> &[MountedView] {
        &self.views
    }

    /// Shared EROFS consumers recorded in the durable execution record.
    ///
    /// A transient writable RootFS also holds its immutable base lower through
    /// the read-only mount manager, so that consumer appears here as well.
    pub fn shared_mounts(&self) -> Vec<SharedMountRecord> {
        self.views
            .iter()
            .filter_map(|view| match &view.recovery().source {
                MountRecoverySource::Erofs {
                    digest,
                    mountpoint,
                    generation,
                } => Some(SharedMountRecord {
                    digest: digest.clone(),
                    mountpoint: mountpoint.display().to_string(),
                    generation: generation.clone(),
                }),
                MountRecoverySource::TransientRootfs {
                    lower_digest,
                    lower_mountpoint,
                    lower_generation,
                    ..
                } => Some(SharedMountRecord {
                    digest: lower_digest.clone(),
                    mountpoint: lower_mountpoint.display().to_string(),
                    generation: lower_generation.clone(),
                }),
                _ => None,
            })
            .collect()
    }

    /// The manager-owned Workspace Overlay binding of this execution.
    pub fn overlay(&self) -> Option<OverlayBinding> {
        self.views
            .iter()
            .find_map(|view| match &view.recovery().source {
                MountRecoverySource::Overlay {
                    workspace,
                    mountpoint,
                    generation,
                    lowers,
                } => {
                    let first = lowers.first()?;
                    Some(OverlayBinding {
                        workspace: workspace.clone(),
                        mountpoint: mountpoint.clone(),
                        generation: generation.clone(),
                        lower_digest: first.digest.clone(),
                        lower_mountpoint: first.mountpoint.clone(),
                        lower_generation: first.generation.clone(),
                        lowers: lowers.clone(),
                    })
                }
                _ => None,
            })
    }

    /// The execution-owned transient RootFS of this composition, when one was
    /// selected.
    pub fn transient_rootfs(&self) -> Option<(PathBuf, PathBuf, PathBuf)> {
        self.views
            .iter()
            .find_map(|view| match &view.recovery().source {
                MountRecoverySource::TransientRootfs {
                    mountpoint,
                    upper,
                    work,
                    ..
                } => Some((mountpoint.clone(), upper.clone(), work.clone())),
                _ => None,
            })
    }

    /// Release every consumer, eagerly rather than relying on Drop.
    ///
    /// Views are released in reverse dependency order: the Workspace Overlay
    /// before the read-only lowers it depends on. A failure keeps every
    /// retained resource recoverable and is reported.
    pub fn unmount(&mut self, report: &mut crate::exec::CleanupReport) -> Result<()> {
        let mut failure = None;
        for view in self.views.iter_mut().rev() {
            let label = format!(
                "{}->{}",
                view.host_view().display(),
                view.target().display()
            );
            match view.release() {
                Ok(()) => report.evidence.push(("unmounted".to_string(), label)),
                Err(error) => {
                    report
                        .evidence
                        .push(("unmount-failed".to_string(), format!("{label}: {error}")));
                    failure = Some(error);
                }
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

impl Drop for MountedComposition {
    fn drop(&mut self) {
        for view in self.views.iter_mut().rev() {
            let _ = view.release();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mount::plan::ErofsSource;

    fn entry(role: MountRole, source: MountSource, target: &str) -> MountPlanEntry {
        MountPlanEntry {
            role,
            source,
            target: PathBuf::from(target),
        }
    }

    #[test]
    fn a_recovery_binding_round_trips_for_every_source_kind() {
        let workspace = OverlayWorkspaceKey::new("/workspaces", "ws_a").unwrap();
        let mut bindings = vec![
            MountRecoveryBinding {
                role: MountRole::Base,
                target: PathBuf::from("/"),
                source: MountRecoverySource::Erofs {
                    digest: format!("sha256:{}", "a".repeat(64)),
                    mountpoint: PathBuf::from("/mounts/erofs/a"),
                    generation: "generation-a".to_string(),
                },
            },
            MountRecoveryBinding {
                role: MountRole::Workspace,
                target: PathBuf::from("/workspace"),
                source: MountRecoverySource::Overlay {
                    workspace,
                    mountpoint: PathBuf::from("/mounts/overlay/a"),
                    generation: "generation-o".to_string(),
                    lowers: vec![OverlayLowerBinding {
                        digest: format!("sha256:{}", "b".repeat(64)),
                        mountpoint: PathBuf::from("/mounts/erofs/b"),
                        generation: "generation-b".to_string(),
                    }],
                },
            },
            MountRecoveryBinding {
                role: MountRole::Toolchain,
                target: PathBuf::from("/opt/tool"),
                source: MountRecoverySource::Bind {
                    directory: PathBuf::from("/opt/tool"),
                    ownership: SandboxWorkspaceOwnership::ProjectLocation,
                },
            },
        ];
        for binding in bindings.drain(..) {
            let encoded = serde_json::to_vec(&binding).unwrap();
            let decoded: MountRecoveryBinding = serde_json::from_slice(&encoded).unwrap();
            assert_eq!(decoded, binding);
        }
    }

    #[test]
    fn host_views_and_sandbox_targets_stay_independent() {
        let base = MountedView::new(
            entry(
                MountRole::Base,
                MountSource::Erofs(ErofsSource::new(
                    format!("sha256:{}", "a".repeat(64)),
                    "/images/base.erofs",
                )),
                "/",
            ),
            PathBuf::from("/manager/mounts/base"),
            MountRecoveryBinding {
                role: MountRole::Base,
                target: PathBuf::from("/"),
                source: MountRecoverySource::Erofs {
                    digest: format!("sha256:{}", "a".repeat(64)),
                    mountpoint: PathBuf::from("/manager/mounts/base"),
                    generation: "generation-a".to_string(),
                },
            },
            ViewLease::Bind,
        );
        let bind = MountedView::new(
            entry(
                MountRole::Workspace,
                MountSource::Bind {
                    directory: PathBuf::from("/workspaces/ws_a"),
                    ownership: SandboxWorkspaceOwnership::Agent,
                },
                "/workspace",
            ),
            PathBuf::from("/workspaces/ws_a"),
            MountRecoveryBinding {
                role: MountRole::Workspace,
                target: PathBuf::from("/workspace"),
                source: MountRecoverySource::Bind {
                    directory: PathBuf::from("/workspaces/ws_a"),
                    ownership: SandboxWorkspaceOwnership::Agent,
                },
            },
            ViewLease::Bind,
        );
        assert_eq!(base.host_view(), Path::new("/manager/mounts/base"));
        assert_eq!(base.target(), Path::new("/"));
        assert_eq!(bind.host_view(), Path::new("/workspaces/ws_a"));
        assert_eq!(bind.target(), Path::new("/workspace"));
        assert_eq!(bind.source_kind(), MountSourceKind::Bind);
    }
}
