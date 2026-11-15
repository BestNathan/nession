//! Prepared EROFS image mounts for the minimal composable root (#3024).
//!
//! The Agent has already resolved a logical image to a local file and an
//! immutable digest. This module re-verifies the exact bytes, mounts the image
//! read-only through the unprivileged `erofsfuse` helper, and returns the host
//! mountpoints Bubblewrap binds into the execution. A missing helper,
//! `/dev/fuse`, kernel FUSE support or a digest mismatch fails closed; there is
//! no extraction fallback, kernel-loop mount or Native degradation.

use std::path::{Path, PathBuf};

use nession_erofs::digest::file_digest;
use nession_erofs::mount::{self, MountSettings};
use nession_erofs::mount_manager::{MountLease, MountManager, VerifiedImage};
use nession_erofs::overlay::{
    OverlayBinding, OverlayLease, OverlayMountManager, OverlayRequest, OverlayWorkspaceKey,
};
use nession_protocol::contracts::sandbox::v1::SandboxWorkspaceOwnership;

use crate::error::{Result, SandboxError};
use crate::exec::SharedMountRecord;
use crate::policy::{CompiledComposition, CompiledImage};
use crate::settings::SandboxSettings;

/// The composed mount view uses the same mountpoint oracle as the reusable
/// primitive; re-exported for the Linux runtime proof.
pub use nession_erofs::mount::is_mounted;

/// How the `/workspace` view is installed.
#[derive(Debug, Clone)]
pub enum WorkspaceMount {
    /// A prepared writable directory with no Project image.
    Bind(PathBuf),
    /// A read-only Project image with no writable layer.
    Image(PathBuf),
    /// A fuse-overlayfs merge of the Project image and the Agent-owned
    /// writable upper/work directories.
    Overlay(PathBuf),
}

/// Host mountpoints the Bubblewrap plan binds into the sandbox.
#[derive(Debug, Clone)]
pub struct ResolvedComposition {
    pub base: PathBuf,
    pub workspace: WorkspaceMount,
    /// `(sandbox target, host mountpoint)`, sorted by target.
    pub toolchains: Vec<(PathBuf, PathBuf)>,
}

/// One mount consumer this execution holds, in creation order.
enum OwnedMount {
    /// A consumer lease over a shared physical EROFS mount (#3449). The lease
    /// cannot unmount; only the manager reclaims the physical mount.
    Shared(MountLease),
    /// A consumer lease over the one shared writable Merged View of a managed
    /// Workspace (#3582). The manager owns the physical `fuse-overlayfs` mount;
    /// the last release unmounts it without deleting durable bytes.
    Overlay(OverlayLease),
}

impl OwnedMount {
    fn label(&self) -> String {
        match self {
            Self::Shared(lease) => lease.mountpoint().display().to_string(),
            Self::Overlay(lease) => lease.mountpoint().display().to_string(),
        }
    }
}

/// Live mounts owned by one execution. Cleanup releases exactly these
/// consumer identities in reverse dependency order.
pub struct MountedComposition {
    mounts: Vec<OwnedMount>,
    shared: Vec<SharedMountRecord>,
    overlay: Option<OverlayBinding>,
    resolved: ResolvedComposition,
}

impl MountedComposition {
    pub fn resolved(&self) -> &ResolvedComposition {
        &self.resolved
    }

    /// Shared EROFS consumers recorded in the durable execution record.
    pub fn shared_mounts(&self) -> Vec<SharedMountRecord> {
        self.shared.clone()
    }

    /// The durable manager-owned Overlay binding of this execution (#3582).
    pub fn overlay(&self) -> Option<OverlayBinding> {
        self.overlay.clone()
    }

    /// Release every consumer, eagerly rather than relying on Drop.
    ///
    /// The Overlay lease is released before the shared image consumers: the
    /// Overlay depends on its read-only lower, and only the Overlay manager may
    /// release that lower after a verified Overlay unmount. A failure keeps
    /// every retained resource recoverable for a later reconciliation.
    pub fn unmount(&mut self, report: &mut crate::exec::CleanupReport) -> Result<()> {
        let mounts = std::mem::take(&mut self.mounts);
        self.shared.clear();
        self.overlay = None;
        let mut failure = None;
        for mount in mounts.into_iter().rev() {
            let label = mount.label();
            let outcome = match mount {
                OwnedMount::Shared(lease) => lease
                    .release()
                    .map_err(|error| SandboxError::Prepare(format!("{error:#}"))),
                OwnedMount::Overlay(lease) => lease
                    .release()
                    .map_err(|error| SandboxError::Prepare(format!("{error:#}"))),
            };
            match outcome {
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
        let mounts = std::mem::take(&mut self.mounts);
        for mount in mounts.into_iter().rev() {
            match mount {
                OwnedMount::Shared(lease) => drop(lease),
                OwnedMount::Overlay(lease) => drop(lease),
            }
        }
    }
}

/// Probe whether this host can mount prepared EROFS images without privileges.
pub fn probe(settings: &SandboxSettings) -> (bool, Option<String>) {
    let Some(root) = &settings.erofs_image_root else {
        return (
            false,
            Some("no Agent-authorized EROFS image root is configured".to_string()),
        );
    };
    if !root.is_absolute() || !root.is_dir() {
        return (
            false,
            Some(format!(
                "EROFS image root {} is not an absolute directory",
                root.display()
            )),
        );
    }
    mount::probe(&mount_settings(settings))
}

fn mount_settings(settings: &SandboxSettings) -> MountSettings {
    MountSettings::new(
        settings.erofsfuse_path.clone(),
        settings.fusermount_path.clone(),
    )
}

/// Whether the unprivileged OverlayFS helper is available.
pub fn overlay_available(settings: &SandboxSettings) -> bool {
    mount::executable(&settings.fuse_overlayfs_path)
}

/// Verify and acquire every image in one composition.
///
/// The writable `/workspace` Merged View is a manager-owned shared resource
/// (#3582); it is no longer created below the execution directory.
pub fn mount_composition(
    composition: &CompiledComposition,
    _execution_dir: &Path,
    execution_id: &str,
    settings: &SandboxSettings,
) -> Result<MountedComposition> {
    let image_root = settings.erofs_image_root.as_ref().ok_or_else(|| {
        SandboxError::UnsupportedPolicy(
            "filesystem.composition requires an Agent-authorized EROFS image root".to_string(),
        )
    })?;
    let image_root = std::fs::canonicalize(image_root).map_err(|error| {
        SandboxError::Prepare(format!(
            "resolve the EROFS image root {}: {error}",
            image_root.display()
        ))
    })?;
    let manager = settings.mount_manager.as_ref().ok_or_else(|| {
        SandboxError::UnsupportedPolicy(
            "filesystem.composition requires the Agent's shared EROFS mount manager".to_string(),
        )
    })?;
    let mut mounted = MountedComposition {
        mounts: Vec::new(),
        shared: Vec::new(),
        overlay: None,
        resolved: ResolvedComposition {
            base: PathBuf::new(),
            workspace: WorkspaceMount::Bind(PathBuf::new()),
            toolchains: Vec::new(),
        },
    };

    let base = mount_image(
        &composition.base,
        &image_root,
        manager,
        execution_id,
        &mut mounted,
    )?;
    if !base.join("bin/sh").exists() && !base.join("usr/bin/sh").exists() {
        return Err(SandboxError::Prepare(format!(
            "the Base Runtime image has no /bin/sh at {}",
            base.display()
        )));
    }
    // The composed root is read-only, so Bubblewrap can mount only over
    // directories the image already contains. These are the runtime paths the
    // sandbox always installs.
    for required in ["dev", "proc", "home", "tmp", "run/nession", "workspace"] {
        require_dir(&base, Path::new(required))?;
    }
    for toolchain in &composition.toolchains {
        require_dir(
            &base,
            toolchain
                .target
                .strip_prefix("/")
                .unwrap_or(toolchain.target.as_path()),
        )?;
    }
    mounted.resolved.base = base;

    let Some(workspace) = &composition.workspace else {
        return Err(SandboxError::InvalidPolicy(
            "filesystem.composition requires a workspace (image and/or write directory)"
                .to_string(),
        ));
    };
    let write = crate::exec::validate_composition_workspace(workspace, settings)?;
    mounted.resolved.workspace = match &workspace.image {
        Some(image) => {
            if workspace.ownership == SandboxWorkspaceOwnership::ProjectLocation {
                return Err(SandboxError::InvalidPolicy(
                    "a Project Location workspace cannot carry a Project EROFS lower".to_string(),
                ));
            }
            // The writable Merged View is owned by the Agent's Overlay manager
            // (#3582). There is no per-execution `fuse-overlayfs` fallback: a
            // host without the manager refuses the composition.
            let overlay_manager = settings.overlay_manager.as_ref().ok_or_else(|| {
                SandboxError::UnsupportedPolicy(
                    "filesystem.composition requires the Agent's shared Workspace Overlay manager"
                        .to_string(),
                )
            })?;
            // The Sandbox still owns image source authorization and byte
            // verification; the Overlay manager derives the workspace identity
            // from its own authorized root and never accepts a caller path.
            let source = verify_image(image, &image_root)?;
            let verified = VerifiedImage::new(image.digest.clone(), source)
                .map_err(|error| SandboxError::Prepare(format!("{error:#}")))?;
            let key = resolve_overlay_workspace(overlay_manager, &write)?;
            let lease = overlay_manager
                .acquire(&OverlayRequest::new(key, verified), execution_id)
                .map_err(|error| SandboxError::Prepare(format!("{error:#}")))?;
            let merged = lease.mountpoint().to_path_buf();
            mounted.overlay = Some(lease.binding());
            mounted.mounts.push(OwnedMount::Overlay(lease));
            WorkspaceMount::Overlay(merged)
        }
        None => WorkspaceMount::Bind(write),
    };

    for toolchain in &composition.toolchains {
        let path = mount_image(toolchain, &image_root, manager, execution_id, &mut mounted)?;
        if let Some(prepend) = &toolchain.path_prepend {
            let executable_dir = path.join(prepend);
            let metadata = std::fs::symlink_metadata(&executable_dir).map_err(|error| {
                SandboxError::Prepare(format!(
                    "toolchain image {} at {} declares io.nession.path.prepend `{}`, but \
                     {}/{} is not an executable directory: {error}",
                    toolchain.digest,
                    toolchain.target.display(),
                    prepend.display(),
                    path.display(),
                    prepend.display()
                ))
            })?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(SandboxError::Prepare(format!(
                    "toolchain image {} at {} declares io.nession.path.prepend `{}`, but \
                     {}/{} must be a real directory",
                    toolchain.digest,
                    toolchain.target.display(),
                    prepend.display(),
                    path.display(),
                    prepend.display()
                )));
            }
        }
        mounted
            .resolved
            .toolchains
            .push((toolchain.target.clone(), path));
    }
    Ok(mounted)
}

fn require_dir(base: &Path, relative: &Path) -> Result<()> {
    let path = base.join(relative);
    let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
        SandboxError::Prepare(format!(
            "the Base Runtime image lacks the required mountpoint /{}: {error}",
            relative.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(SandboxError::Prepare(format!(
            "the Base Runtime mountpoint /{} must be a real directory",
            relative.display()
        )));
    }
    Ok(())
}

fn mount_image(
    image: &CompiledImage,
    image_root: &Path,
    manager: &MountManager,
    execution_id: &str,
    mounted: &mut MountedComposition,
) -> Result<PathBuf> {
    let source = verify_image(image, image_root)?;
    let verified = VerifiedImage::new(image.digest.clone(), source)
        .map_err(|error| SandboxError::Prepare(format!("{error:#}")))?;
    let lease = manager
        .acquire(&verified, execution_id)
        .map_err(|error| SandboxError::Prepare(format!("{error:#}")))?;
    let mountpoint = lease.mountpoint().to_path_buf();
    mounted.shared.push(SharedMountRecord {
        digest: lease.digest().to_string(),
        mountpoint: mountpoint.display().to_string(),
        generation: lease.generation().to_string(),
    });
    mounted.mounts.push(OwnedMount::Shared(lease));
    Ok(mountpoint)
}

/// Re-verify the exact local bytes before mounting anything.
fn verify_image(image: &CompiledImage, image_root: &Path) -> Result<PathBuf> {
    let metadata = std::fs::symlink_metadata(&image.source).map_err(|error| {
        SandboxError::InvalidPolicy(format!(
            "EROFS image {} does not exist: {error}",
            image.source.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(SandboxError::InvalidPolicy(format!(
            "EROFS image {} must be a regular file, not a symlink",
            image.source.display()
        )));
    }
    if metadata.len() == 0 {
        return Err(SandboxError::InvalidPolicy(format!(
            "EROFS image {} is empty",
            image.source.display()
        )));
    }
    let canonical = std::fs::canonicalize(&image.source).map_err(|error| {
        SandboxError::InvalidPolicy(format!(
            "EROFS image {} cannot be resolved: {error}",
            image.source.display()
        ))
    })?;
    if !canonical.starts_with(image_root) {
        return Err(SandboxError::InvalidPolicy(format!(
            "EROFS image {} is outside the Agent-authorized image root {}",
            canonical.display(),
            image_root.display()
        )));
    }
    let actual = file_digest(&canonical).map_err(|error| {
        SandboxError::InvalidPolicy(format!(
            "EROFS image {} cannot be verified: {error:#}",
            canonical.display()
        ))
    })?;
    if actual != image.digest {
        return Err(SandboxError::InvalidPolicy(format!(
            "EROFS image {} digest {actual} does not match the prepared digest {}",
            canonical.display(),
            image.digest
        )));
    }
    Ok(canonical)
}

/// Resolve the composition's writable directory to the manager-authorized
/// workspace identity.
///
/// The path is validated by the Agent-owned composition rules first; the
/// Overlay manager then re-derives the identity from its own authorized roots.
/// A directory outside those roots fails closed.
fn resolve_overlay_workspace(
    manager: &OverlayMountManager,
    write: &Path,
) -> Result<OverlayWorkspaceKey> {
    manager.resolve_workspace(write).map_err(|error| {
        SandboxError::InvalidPolicy(format!(
            "the workspace write directory {} is not an authorized Overlay workspace: {error:#}",
            write.display()
        ))
    })
}

/// Unmount paths recorded by a previous Agent process, before removing their
/// execution directory. Only paths that are mounts are touched.
///
/// This handles records written before #3582, when the writable Overlay was
/// execution-scoped. A manager-owned Overlay mountpoint is never passed here:
/// reconciliation releases it through the Overlay manager instead.
pub fn unmount_recorded(
    paths: &[String],
    execution_dir: &Path,
    fusermount: &Path,
    report: &mut crate::exec::CleanupReport,
) {
    let owned_root =
        std::fs::canonicalize(execution_dir).unwrap_or_else(|_| execution_dir.to_path_buf());
    for raw in paths {
        let path = Path::new(raw);
        if !path.is_absolute() {
            continue;
        }
        let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        if !canonical.starts_with(&owned_root) {
            continue;
        }
        if mount::is_mounted(path) {
            match mount::unmount_one(fusermount, path) {
                Ok(()) => report
                    .evidence
                    .push(("reconciled-unmount".to_string(), raw.clone())),
                Err(error) => report.evidence.push((
                    "reconcile-unmount-failed".to_string(),
                    format!("{raw}: {error}"),
                )),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn settings(root: &Path) -> SandboxSettings {
        let images = root.join("images");
        std::fs::create_dir_all(&images).unwrap();
        let mut settings = SandboxSettings::new(
            root.join("state"),
            PathBuf::from("/bin/true"),
            PathBuf::from("/bin/true"),
            PathBuf::from("/bin/true"),
        );
        settings.erofs_image_root = Some(images);
        settings.erofsfuse_path = root.join("erofsfuse");
        settings.fusermount_path = root.join("fusermount3");
        settings.fuse_overlayfs_path = root.join("fuse-overlayfs");
        settings
    }

    fn executable(path: &Path) {
        std::fs::write(path, b"#!/bin/sh\nexit 0\n").unwrap();
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions).unwrap();
    }

    #[test]
    fn a_missing_erofsfuse_fails_closed() {
        let root = tempfile::tempdir().unwrap();
        let (available, reason) = probe(&settings(root.path()));
        assert!(!available);
        assert!(reason.unwrap().contains("erofsfuse"));
    }

    #[test]
    fn a_missing_fusermount_fails_closed() {
        let root = tempfile::tempdir().unwrap();
        let settings = settings(root.path());
        executable(&settings.erofsfuse_path);
        let (available, reason) = probe(&settings);
        assert!(!available);
        assert!(reason.unwrap().contains("fusermount3"));
    }

    #[test]
    fn a_missing_overlay_helper_reports_overlay_unavailable() {
        let root = tempfile::tempdir().unwrap();
        assert!(!overlay_available(&settings(root.path())));
    }

    #[test]
    fn a_digest_mismatch_is_refused_before_mounting() {
        let root = tempfile::tempdir().unwrap();
        let images = root.path().join("images");
        std::fs::create_dir_all(&images).unwrap();
        let image = images.join("base.erofs");
        std::fs::write(&image, b"real bytes").unwrap();
        let compiled = CompiledImage {
            digest: nession_erofs::digest::digest_of_bytes(b"different bytes"),
            source: image,
            target: PathBuf::from("/"),
            env: Vec::new(),
            path_prepend: None,
        };
        let error = verify_image(&compiled, &images).unwrap_err();
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
        let compiled = CompiledImage {
            digest: nession_erofs::digest::digest_of_bytes(b"bytes"),
            source: outside,
            target: PathBuf::from("/"),
            env: Vec::new(),
            path_prepend: None,
        };
        let error = verify_image(&compiled, &images).unwrap_err();
        assert!(
            format!("{error}").contains("outside the Agent-authorized image root"),
            "{error}"
        );
    }
}
