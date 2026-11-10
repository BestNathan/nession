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

use sha2::{Digest, Sha256};

use crate::error::{Result, SandboxError};
use crate::policy::{CompiledComposition, CompiledImage};
use crate::settings::SandboxSettings;

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MOUNT_READY_TIMEOUT: Duration = Duration::from_secs(10);

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

/// Live mounts owned by one execution. Cleanup unmounts exactly these paths.
pub struct MountedComposition {
    mounts: Vec<PathBuf>,
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
            .map(|path| path.display().to_string())
            .collect()
    }

    /// Unmount every owned image, eagerly rather than relying on Drop.
    pub fn unmount(&mut self, report: &mut crate::exec::CleanupReport) -> Result<()> {
        let mounts = std::mem::take(&mut self.mounts);
        let mut failure = None;
        for mountpoint in mounts.iter().rev() {
            match unmount_one(&self.fusermount, mountpoint) {
                Ok(()) => report
                    .evidence
                    .push(("unmounted".to_string(), mountpoint.display().to_string())),
                Err(error) => {
                    report.evidence.push((
                        "unmount-failed".to_string(),
                        format!("{}: {error}", mountpoint.display()),
                    ));
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
        for mountpoint in mounts.iter().rev() {
            let _ = unmount_one(&self.fusermount, mountpoint);
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
    if !executable(&settings.erofsfuse_path) {
        return (
            false,
            Some(format!(
                "{} is not executable",
                settings.erofsfuse_path.display()
            )),
        );
    }
    if !executable(&settings.fusermount_path) {
        return (
            false,
            Some(format!(
                "{} is not executable",
                settings.fusermount_path.display()
            )),
        );
    }
    match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/fuse")
    {
        Ok(_) => (true, None),
        Err(error) => (
            false,
            Some(format!("/dev/fuse is not readable and writable: {error}")),
        ),
    }
}

/// Whether the unprivileged OverlayFS helper is available.
pub fn overlay_available(settings: &SandboxSettings) -> bool {
    executable(&settings.fuse_overlayfs_path)
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
        settings,
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
                settings,
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
            mounted.mounts.push(merged.clone());
            if !is_mounted(&merged) {
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
            settings,
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
    settings: &SandboxSettings,
    mounted: &mut Vec<PathBuf>,
) -> Result<PathBuf> {
    let source = verify_image(image, image_root)?;
    std::fs::create_dir_all(mountpoint).map_err(|error| {
        SandboxError::Prepare(format!(
            "create EROFS mountpoint {}: {error}",
            mountpoint.display()
        ))
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(mountpoint, std::fs::Permissions::from_mode(0o700));
    }
    run_fuse(&settings.erofsfuse_path, &source, mountpoint)?;
    mounted.push(mountpoint.to_path_buf());
    if !is_mounted(mountpoint) {
        return Err(SandboxError::Prepare(format!(
            "erofsfuse reported success but {} is not a mount",
            mountpoint.display()
        )));
    }
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
    let mut file = std::fs::File::open(&canonical).map_err(|error| {
        SandboxError::InvalidPolicy(format!(
            "EROFS image {} cannot be read: {error}",
            canonical.display()
        ))
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            SandboxError::Prepare(format!("read EROFS image {}: {error}", canonical.display()))
        })?;
        if read == 0 {
            break;
        }
        let Some(chunk) = buffer.get(..read) else {
            break;
        };
        hasher.update(chunk);
    }
    let actual = format!("sha256:{}", hex(&hasher.finalize()));
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

fn run_fuse(erofsfuse: &Path, image: &Path, mountpoint: &Path) -> Result<()> {
    let mut command = Command::new(erofsfuse); // not-tmux: unprivileged EROFS FUSE helper
    command.arg(image).arg(mountpoint);
    run_mount_helper(
        command,
        &format!("{} {}", erofsfuse.display(), image.display()),
        mountpoint,
    )
}

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
    let deadline = Instant::now() + PROBE_TIMEOUT;
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
    let deadline = Instant::now() + MOUNT_READY_TIMEOUT;
    while Instant::now() < deadline {
        if is_mounted(mountpoint) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(SandboxError::Prepare(format!(
        "{} did not become a mount within {:?}",
        mountpoint.display(),
        MOUNT_READY_TIMEOUT
    )))
}

fn unmount_one(fusermount: &Path, mountpoint: &Path) -> Result<()> {
    if !is_mounted(mountpoint) {
        return Ok(());
    }
    let status = Command::new(fusermount) // not-tmux: FUSE unmount helper
        .arg("-u")
        .arg(mountpoint)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| {
            SandboxError::Prepare(format!(
                "run {} -u {}: {error}",
                fusermount.display(),
                mountpoint.display()
            ))
        })?;
    if status.success() && !is_mounted(mountpoint) {
        return Ok(());
    }
    let _ = Command::new(fusermount) // not-tmux: FUSE lazy-unmount helper
        .arg("-uz")
        .arg(mountpoint)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    if is_mounted(mountpoint) {
        return Err(SandboxError::Prepare(format!(
            "could not unmount {}",
            mountpoint.display()
        )));
    }
    Ok(())
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
        if is_mounted(path) {
            match unmount_one(fusermount, path) {
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

/// Whether `path` currently appears as a mountpoint in this process's view.
pub fn is_mounted(path: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string("/proc/self/mountinfo") else {
        return false;
    };
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    text.lines().any(|line| {
        let Some(field) = line.split_whitespace().nth(4) else {
            return false;
        };
        Path::new(&unescape_mount_point(field)) == canonical
    })
}

fn unescape_mount_point(value: &str) -> String {
    value
        .replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}

fn executable(path: &Path) -> bool {
    let resolved = if path.is_absolute() || path.components().count() > 1 {
        Some(path.to_path_buf())
    } else {
        std::env::var_os("PATH").and_then(|value| {
            std::env::split_paths(&value)
                .map(|directory| directory.join(path))
                .find(|candidate| is_executable_file(candidate))
        })
    };
    resolved.is_some_and(|candidate| is_executable_file(&candidate))
}

fn is_executable_file(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        false
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}
