//! Prepared EROFS image mounts for the minimal composable root (#3024).
//!
//! The Agent has already resolved a logical image to a local file and an
//! immutable digest. This module re-verifies the exact bytes, mounts the image
//! read-only through the unprivileged `erofsfuse` helper, and returns the host
//! mountpoints Bubblewrap binds into the execution. A missing helper,
//! `/dev/fuse`, kernel FUSE support or a digest mismatch fails closed; there is
//! no extraction fallback, kernel-loop mount or Native degradation.

use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use nession_erofs::digest::file_digest;
use nession_erofs::mount::{self, ErofsMount, MountSettings};

use crate::error::{Result, SandboxError};
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

/// One mount this execution owns, in creation order.
enum OwnedMount {
    /// A read-only EROFS image mount with its primitive-owned handle.
    Erofs(ErofsMount),
    /// A `fuse-overlayfs` merge; the Sandbox owns its cleanup policy.
    Overlay(PathBuf),
}

impl OwnedMount {
    fn path(&self) -> &Path {
        match self {
            Self::Erofs(mount) => mount.mountpoint(),
            Self::Overlay(path) => path,
        }
    }
}

/// Live mounts owned by one execution. Cleanup unmounts exactly these paths.
pub struct MountedComposition {
    mounts: Vec<OwnedMount>,
    fusermount: PathBuf,
    resolved: ResolvedComposition,
}

impl MountedComposition {
    pub fn resolved(&self) -> &ResolvedComposition {
        &self.resolved
    }

    /// Mountpoints recorded in the durable execution record.
    pub fn mountpoints(&self) -> Vec<String> {
        self.mounts
            .iter()
            .map(|mount| mount.path().display().to_string())
            .collect()
    }

    /// Unmount every owned image, eagerly rather than relying on Drop.
    pub fn unmount(&mut self, report: &mut crate::exec::CleanupReport) -> Result<()> {
        let mounts = std::mem::take(&mut self.mounts);
        let mut failure = None;
        for mount in mounts.into_iter().rev() {
            let path = mount.path().display().to_string();
            let outcome = match mount {
                OwnedMount::Erofs(mut mount) => mount
                    .unmount()
                    .map_err(|error| SandboxError::Prepare(format!("{error:#}"))),
                OwnedMount::Overlay(path) => mount::unmount_one(&self.fusermount, &path)
                    .map_err(|error| SandboxError::Prepare(format!("{error:#}"))),
            };
            match outcome {
                Ok(()) => report.evidence.push(("unmounted".to_string(), path)),
                Err(error) => {
                    report
                        .evidence
                        .push(("unmount-failed".to_string(), format!("{path}: {error}")));
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
                OwnedMount::Erofs(handle) => drop(handle),
                OwnedMount::Overlay(path) => {
                    let _ = mount::unmount_one(&self.fusermount, &path);
                }
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

/// Verify and mount every image in one composition.
pub fn mount_composition(
    composition: &CompiledComposition,
    execution_dir: &Path,
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
    let mounts_dir = execution_dir.join("mounts");
    std::fs::create_dir_all(&mounts_dir).map_err(|error| {
        SandboxError::Prepare(format!(
            "create EROFS mount directory {}: {error}",
            mounts_dir.display()
        ))
    })?;

    let helpers = mount_settings(settings);
    let mut mounted = MountedComposition {
        mounts: Vec::new(),
        fusermount: settings.fusermount_path.clone(),
        resolved: ResolvedComposition {
            base: PathBuf::new(),
            workspace: WorkspaceMount::Bind(PathBuf::new()),
            toolchains: Vec::new(),
        },
    };

    let base = mount_image(
        &composition.base,
        &mounts_dir.join("base"),
        &image_root,
        &helpers,
        &mut mounted.mounts,
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
    let write = validate_workspace_write(&workspace.write, &settings.state_dir)?;
    mounted.resolved.workspace = match &workspace.image {
        Some(image) => {
            let lower = mount_image(
                image,
                &mounts_dir.join("workspace-image"),
                &image_root,
                &helpers,
                &mut mounted.mounts,
            )?;
            let upper = write.join("upper");
            let work = write.join("work");
            for directory in [&upper, &work] {
                std::fs::create_dir_all(directory).map_err(|error| {
                    SandboxError::Prepare(format!(
                        "create overlay directory {}: {error}",
                        directory.display()
                    ))
                })?;
            }
            let merged = mounts_dir.join("workspace-merged");
            std::fs::create_dir_all(&merged).map_err(|error| {
                SandboxError::Prepare(format!(
                    "create overlay mountpoint {}: {error}",
                    merged.display()
                ))
            })?;
            run_fuse_overlay(
                &settings.fuse_overlayfs_path,
                &lower,
                &upper,
                &work,
                &merged,
            )?;
            mounted.mounts.push(OwnedMount::Overlay(merged.clone()));
            if !mount::is_mounted(&merged) {
                return Err(SandboxError::Prepare(format!(
                    "fuse-overlayfs reported success but {} is not a mount",
                    merged.display()
                )));
            }
            WorkspaceMount::Overlay(merged)
        }
        None => WorkspaceMount::Bind(write),
    };

    for (index, toolchain) in composition.toolchains.iter().enumerate() {
        let path = mount_image(
            toolchain,
            &mounts_dir.join(format!("toolchain-{index}")),
            &image_root,
            &helpers,
            &mut mounted.mounts,
        )?;
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
    mountpoint: &Path,
    image_root: &Path,
    settings: &MountSettings,
    mounted: &mut Vec<OwnedMount>,
) -> Result<PathBuf> {
    let source = verify_image(image, image_root)?;
    let handle = ErofsMount::mount(&source, mountpoint, settings)
        .map_err(|error| SandboxError::Prepare(format!("{error:#}")))?;
    mounted.push(OwnedMount::Erofs(handle));
    Ok(mountpoint.to_path_buf())
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

fn validate_workspace_write(write: &Path, state_dir: &Path) -> Result<PathBuf> {
    let metadata = std::fs::symlink_metadata(write).map_err(|error| {
        SandboxError::InvalidPolicy(format!(
            "workspace write directory {} does not exist: {error}",
            write.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(SandboxError::InvalidPolicy(format!(
            "workspace write directory {} must be a real directory",
            write.display()
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let euid = unsafe { libc::geteuid() };
        use std::os::unix::fs::MetadataExt;
        if euid != 0 && metadata.uid() != euid {
            return Err(SandboxError::InvalidPolicy(format!(
                "workspace write directory {} is not owned by the Agent user",
                write.display()
            )));
        }
        if metadata.permissions().mode() & 0o200 == 0 {
            return Err(SandboxError::InvalidPolicy(format!(
                "workspace write directory {} is not writable",
                write.display()
            )));
        }
    }
    let canonical_write = std::fs::canonicalize(write).map_err(|error| {
        SandboxError::InvalidPolicy(format!(
            "workspace write directory {} cannot be resolved: {error}",
            write.display()
        ))
    })?;
    let canonical_state =
        std::fs::canonicalize(state_dir).unwrap_or_else(|_| state_dir.to_path_buf());
    if !canonical_write.starts_with(&canonical_state) {
        return Err(SandboxError::InvalidPolicy(format!(
            "workspace write directory {} is outside the Agent sandbox state directory",
            canonical_write.display()
        )));
    }
    Ok(canonical_write)
}

/// Merge the Project image and the bounded writable upper/work through the
/// unprivileged `fuse-overlayfs` helper.
///
/// Overlay composition is Sandbox-owned; only the EROFS image mount itself is
/// the reusable primitive.
fn run_fuse_overlay(
    helper: &Path,
    lower: &Path,
    upper: &Path,
    work: &Path,
    merged: &Path,
) -> Result<()> {
    for path in [lower, upper, work, merged] {
        let text = path.to_string_lossy();
        if text.contains(',') || text.contains(':') {
            return Err(SandboxError::InvalidPolicy(format!(
                "overlay path {} must not contain `,` or `:`",
                path.display()
            )));
        }
    }
    let mut command = Command::new(helper); // not-tmux: unprivileged OverlayFS FUSE helper
    command.arg("-o").arg(format!(
        "lowerdir={},upperdir={},workdir={}",
        lower.display(),
        upper.display(),
        work.display()
    ));
    command.arg(merged);
    run_mount_helper(
        command,
        &format!("{} for {}", helper.display(), merged.display()),
        merged,
    )
}

fn run_mount_helper(mut command: Command, label: &str, mountpoint: &Path) -> Result<()> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        SandboxError::Prepare(format!(
            "start {} for {}: {error}",
            label,
            mountpoint.display()
        ))
    })?;
    let stderr = child.stderr.take();
    let reader = stderr.map(|mut stderr| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stderr.read_to_end(&mut bytes);
            bytes
        })
    });
    let deadline = Instant::now() + mount::PROBE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(SandboxError::Prepare(format!(
                    "{} did not return for {}",
                    label,
                    mountpoint.display()
                )));
            }
            Err(error) => {
                return Err(SandboxError::Prepare(format!("wait for {label}: {error}")));
            }
        }
    };
    let stderr = reader
        .and_then(|reader| reader.join().ok())
        .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
        .unwrap_or_default();
    if !status.success() {
        return Err(SandboxError::Prepare(format!(
            "{} failed for {}: {}",
            label,
            mountpoint.display(),
            stderr
        )));
    }
    let deadline = Instant::now() + mount::MOUNT_READY_TIMEOUT;
    while Instant::now() < deadline {
        if mount::is_mounted(mountpoint) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(SandboxError::Prepare(format!(
        "{} did not become a mount within {:?}",
        mountpoint.display(),
        mount::MOUNT_READY_TIMEOUT
    )))
}

/// Unmount paths recorded by a previous Agent process, before removing their
/// execution directory. Only paths that are mounts are touched.
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
        };
        let error = verify_image(&compiled, &images).unwrap_err();
        assert!(
            format!("{error}").contains("outside the Agent-authorized image root"),
            "{error}"
        );
    }
}
