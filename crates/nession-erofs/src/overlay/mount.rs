//! Bounded `fuse-overlayfs` mount/unmount primitive for one physical Merged
//! View (#3582).
//!
//! This is a *primitive*: it merges one already-authorized read-only lower
//! mount with an Agent-owned upper/work pair. Consumers, single-flight,
//! ownership fencing, durable identity and recovery stay with
//! [`crate::overlay::manager`]. Missing helpers, a missing `/dev/fuse` or a
//! mount that never appears fail closed; there is no lazy-unmount escape hatch
//! for a shared physical Overlay.

use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result};

use crate::mount::{self, MountSettings};

/// The host helpers one physical Overlay mount needs.
#[derive(Debug, Clone)]
pub struct OverlaySettings {
    pub fuse_overlayfs: std::path::PathBuf,
    pub fusermount: std::path::PathBuf,
}

impl OverlaySettings {
    pub fn new(
        fuse_overlayfs: impl Into<std::path::PathBuf>,
        fusermount: impl Into<std::path::PathBuf>,
    ) -> Self {
        Self {
            fuse_overlayfs: fuse_overlayfs.into(),
            fusermount: fusermount.into(),
        }
    }
}

/// Unprivileged Overlay capability: executable helpers plus `/dev/fuse`.
pub fn probe(settings: &OverlaySettings) -> (bool, Option<String>) {
    if !mount::executable(&settings.fuse_overlayfs) {
        return (
            false,
            Some(format!(
                "{} is not executable",
                settings.fuse_overlayfs.display()
            )),
        );
    }
    if !mount::executable(&settings.fusermount) {
        return (
            false,
            Some(format!(
                "{} is not executable",
                settings.fusermount.display()
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

/// The inputs of one physical Overlay mount. Every path is manager-derived.
#[derive(Debug, Clone)]
pub struct OverlayMountSpec {
    pub lower: std::path::PathBuf,
    pub upper: std::path::PathBuf,
    pub work: std::path::PathBuf,
    pub merged: std::path::PathBuf,
}

/// Mount one `fuse-overlayfs` Merged View, with a bounded helper and a
/// verified mountinfo observation.
pub fn mount_overlay(spec: &OverlayMountSpec, settings: &OverlaySettings) -> Result<()> {
    for path in [&spec.lower, &spec.upper, &spec.work, &spec.merged] {
        let text = path.to_string_lossy();
        if text.contains(',') || text.contains(':') {
            anyhow::bail!(
                "overlay path {} must not contain `,` or `:`",
                path.display()
            );
        }
    }
    create_mountpoint(&spec.merged)?;
    let mut command = Command::new(&settings.fuse_overlayfs); // not-tmux: unprivileged OverlayFS FUSE helper
    command.arg("-o").arg(format!(
        "lowerdir={},upperdir={},workdir={}",
        spec.lower.display(),
        spec.upper.display(),
        spec.work.display()
    ));
    command.arg(&spec.merged);
    let label = format!(
        "{} for {}",
        settings.fuse_overlayfs.display(),
        spec.merged.display()
    );
    let outcome = match mount::run_bounded_helper(command, &label, mount::PROBE_TIMEOUT) {
        Ok(outcome) => outcome,
        Err(error) => return finalize_mount_failure(settings, &spec.merged, error),
    };
    if !outcome.status.success() {
        let detail = mount::stderr_detail(&outcome);
        return finalize_mount_failure(
            settings,
            &spec.merged,
            anyhow::anyhow!("{label} failed: {detail}"),
        );
    }
    let deadline = std::time::Instant::now() + mount::MOUNT_READY_TIMEOUT;
    while std::time::Instant::now() < deadline {
        if is_overlay_mount(&spec.merged) {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    finalize_mount_failure(
        settings,
        &spec.merged,
        anyhow::anyhow!(
            "{} did not become an OverlayFS mount within {:?}",
            spec.merged.display(),
            mount::MOUNT_READY_TIMEOUT
        ),
    )
}

fn create_mountpoint(mountpoint: &Path) -> Result<()> {
    std::fs::create_dir_all(mountpoint)
        .with_context(|| format!("create Overlay mountpoint {}", mountpoint.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(mountpoint, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// A failed mount must not leave an unowned mount behind. Attempt a bounded
/// rollback and report both the original failure and the rollback outcome.
fn finalize_mount_failure(
    settings: &OverlaySettings,
    mountpoint: &Path,
    error: anyhow::Error,
) -> Result<()> {
    match unmount_overlay(settings, mountpoint) {
        Ok(()) => Err(error),
        Err(rollback) => Err(error.context(format!(
            "verified rollback also failed; the Overlay mount remains orphaned: {rollback:#}"
        ))),
    }
}

/// Strict shared Overlay unmount: bounded, never lazy, and it succeeds only
/// after mountinfo no longer reports the mount.
pub fn unmount_overlay(settings: &OverlaySettings, mountpoint: &Path) -> Result<()> {
    if !mount::is_mounted(mountpoint) {
        return Ok(());
    }
    let mut command = Command::new(&settings.fusermount); // not-tmux: FUSE unmount helper
    command.arg("-u").arg(mountpoint);
    let label = format!(
        "{} -u {}",
        settings.fusermount.display(),
        mountpoint.display()
    );
    let outcome = mount::run_bounded_helper(command, &label, mount::UNMOUNT_TIMEOUT)?;
    if !outcome.status.success() {
        anyhow::bail!("{label} failed: {}", mount::stderr_detail(&outcome));
    }
    if mount::is_mounted(mountpoint) {
        anyhow::bail!("{label} reported success but the mount remains");
    }
    Ok(())
}

/// Whether `path` is a live `fuse-overlayfs` mount, as observed by mountinfo.
pub fn is_overlay_mount(path: &Path) -> bool {
    mount::mount_entry(path).is_some_and(|entry| {
        entry.fs_type.to_ascii_lowercase().contains("overlayfs")
            || entry.source.to_ascii_lowercase().contains("overlayfs")
    })
}

/// The mount settings the underlying EROFS primitive uses. Re-exported so a
/// caller can build both from one operator configuration.
pub fn mount_settings(settings: &OverlaySettings) -> MountSettings {
    MountSettings::new(settings.fuse_overlayfs.clone(), settings.fusermount.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn a_missing_helper_fails_closed() {
        let root = tempfile::tempdir().unwrap();
        let settings = OverlaySettings::new(
            root.path().join("fuse-overlayfs"),
            root.path().join("fusermount3"),
        );
        let (available, reason) = probe(&settings);
        assert!(!available);
        assert!(reason.unwrap().contains("fuse-overlayfs"));
    }

    #[test]
    fn overlay_option_paths_may_not_contain_delimiters() {
        let root = tempfile::tempdir().unwrap();
        let settings = OverlaySettings::new("/bin/true", "/bin/true");
        let spec = OverlayMountSpec {
            lower: PathBuf::from("/lower,with,comma"),
            upper: root.path().join("upper"),
            work: root.path().join("work"),
            merged: root.path().join("merged"),
        };
        let error = mount_overlay(&spec, &settings).unwrap_err();
        assert!(
            format!("{error:#}").contains("must not contain"),
            "{error:#}"
        );
    }
}
