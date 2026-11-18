//! Prepared EROFS composition execution (#3024, #3695).
//!
//! Sandbox policy compiles a [`MountPlan`] from the Agent-prepared composition.
//! Each planned view is acquired through its typed backend: read-only EROFS
//! through the reusable `nession_erofs::mount_manager`, the writable
//! `/workspace` view through the Sandbox-owned shared Overlay manager, and a
//! Project Location through an Agent-validated Bind. A missing helper,
//! `/dev/fuse`, kernel FUSE support or a digest mismatch fails closed; there is
//! no extraction fallback, kernel-loop mount or Native degradation.

use std::path::Path;

use nession_erofs::mount::{self, MountSettings};

use crate::error::{Result, SandboxError};
use crate::mount::{MountConsumer, MountPlan};
use crate::policy::CompiledComposition;
use crate::settings::SandboxSettings;

pub use crate::mount::{MountedComposition, ResolvedComposition, WorkspaceMount};

/// The composed mount view uses the same mountpoint oracle as the reusable
/// primitive; re-exported for the Linux runtime proof.
pub use nession_erofs::mount::is_mounted;

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

/// Compile and execute the typed Mount plan for one composition.
///
/// The writable `/workspace` Merged View is a manager-owned shared resource
/// (#3582); it is never created below the execution directory.
pub fn mount_composition(
    composition: &CompiledComposition,
    execution_dir: &Path,
    execution_id: &str,
    settings: &SandboxSettings,
) -> Result<MountedComposition> {
    let plan = MountPlan::compile(composition, settings)?;
    if composition.base.is_none() {
        // A Host-root composition binds the ordinary read-only host root, so
        // Bubblewrap cannot create a missing top-level mountpoint. Fail closed
        // before any host resource exists with an actionable prerequisite
        // (#3792).
        if composition.workspace.is_some() && !Path::new("/workspace").is_dir() {
            return Err(SandboxError::UnsupportedPolicy(
                "the Host-root composition requires a /workspace mountpoint on this Agent;                  create it (or choose an image RootFS)"
                    .to_string(),
            ));
        }
        if !composition.toolchains.is_empty() && !Path::new("/opt").is_dir() {
            return Err(SandboxError::UnsupportedPolicy(
                "the Host-root composition requires an /opt mountpoint on this Agent for                  toolchains"
                    .to_string(),
            ));
        }
    }
    let consumer = MountConsumer::new(execution_id)?;
    let mounted = plan.execute(&consumer, settings, execution_dir)?;
    let resolved = mounted.resolved();

    // An image-root composition mounts only over directories the Base image
    // already contains. A Host-root composition needs no Base checks: its
    // toolchain targets live under a private /opt mountpoint (#3792).
    if let Some(base) = &resolved.base {
        if !base.join("bin/sh").exists() && !base.join("usr/bin/sh").exists() {
            return Err(SandboxError::Prepare(format!(
                "the Base Runtime image has no /bin/sh at {}",
                base.display()
            )));
        }
        for required in ["dev", "proc", "home", "tmp", "run/nession", "workspace"] {
            require_dir(base, Path::new(required))?;
        }
        for toolchain in &composition.toolchains {
            require_dir(
                base,
                toolchain
                    .target
                    .strip_prefix("/")
                    .unwrap_or(toolchain.target.as_path()),
            )?;
        }
    }
    for (toolchain, (target, path)) in composition.toolchains.iter().zip(&resolved.toolchains) {
        if target != &toolchain.target {
            return Err(SandboxError::Prepare(format!(
                "the resolved toolchain target {} does not match the compiled target {}",
                target.display(),
                toolchain.target.display()
            )));
        }
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

/// Unmount paths recorded by a previous Agent process, before removing their
/// execution directory. Only paths that are mounts are touched.
///
/// This handles records written before #3582, when the writable Overlay was
/// execution-scoped. A manager-owned Overlay mountpoint is never passed here:
/// reconciliation releases it through the Overlay manager instead.
/// A mount that cannot be strictly unmounted is an error: the caller must
/// retain the durable record and the execution directory rather than forget
/// resources the Agent still owns.
pub fn unmount_recorded(
    paths: &[String],
    execution_dir: &Path,
    fusermount: &Path,
    report: &mut crate::exec::CleanupReport,
) -> Result<()> {
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
                Err(error) => {
                    report.evidence.push((
                        "reconcile-unmount-failed".to_string(),
                        format!("{raw}: {error}"),
                    ));
                    return Err(SandboxError::Cleanup(format!(
                        "could not unmount the recorded execution mount {raw}: {error:#}"
                    )));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mount::ErofsSource;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

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
        let source = ErofsSource::new(
            nession_erofs::digest::digest_of_bytes(b"different bytes"),
            image,
        );
        let error = crate::mount::backends::verify_erofs_source(&source, &images).unwrap_err();
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
        let error = crate::mount::backends::verify_erofs_source(&source, &images).unwrap_err();
        assert!(
            format!("{error}").contains("outside the Agent-authorized image root"),
            "{error}"
        );
    }
}
