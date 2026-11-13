//! Unprivileged Linux EROFS FUSE mount/unmount primitive (#3024, #3303).
//!
//! This is a *primitive*, not a composition owner: it mounts one already
//! verified local EROFS file read-only and owns the resulting mountpoint
//! until the handle is dropped or unmounted. Authorization (which source
//! roots are allowed), digest policy, mount ordering, overlay composition,
//! execution records and reconciliation stay with the consumer. Shared,
//! content-addressed reuse is owned by [`crate::mount_manager`].
//!
//! Missing helpers, a missing `/dev/fuse`, or a mount that never appears fail
//! closed. There is no kernel-loop mount, extraction or Native fallback.

use anyhow::{Context, Result};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// How long a mount helper may take to return.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the mountpoint may take to appear after the helper returns.
pub const MOUNT_READY_TIMEOUT: Duration = Duration::from_secs(10);
/// How long an unmount helper may take to return.
pub const UNMOUNT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long to wait for a completed helper's stderr reader before treating a
/// surviving pipe holder as a stall and detaching the reader.
const STDERR_COLLECT_TIMEOUT: Duration = Duration::from_millis(500);

/// The host helpers this primitive drives.
#[derive(Debug, Clone)]
pub struct MountSettings {
    pub erofsfuse: PathBuf,
    pub fusermount: PathBuf,
}

impl MountSettings {
    pub fn new(erofsfuse: impl Into<PathBuf>, fusermount: impl Into<PathBuf>) -> Self {
        Self {
            erofsfuse: erofsfuse.into(),
            fusermount: fusermount.into(),
        }
    }
}

/// Read-only EROFS FUSE capability: executable helpers plus `/dev/fuse`.
pub fn probe(settings: &MountSettings) -> (bool, Option<String>) {
    if !executable(&settings.erofsfuse) {
        return (
            false,
            Some(format!(
                "{} is not executable",
                settings.erofsfuse.display()
            )),
        );
    }
    if !executable(&settings.fusermount) {
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

/// Whether `path` is an executable file, resolving a bare name through `PATH`.
pub fn executable(path: &Path) -> bool {
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

/// One live read-only EROFS mount. Dropping the handle unmounts it.
pub struct ErofsMount {
    mountpoint: PathBuf,
    fusermount: PathBuf,
}

impl ErofsMount {
    /// Mount `image` read-only at `mountpoint`.
    ///
    /// The caller has already verified the bytes and authorized the source
    /// root; this function only creates the mountpoint and drives the helper.
    pub fn mount(image: &Path, mountpoint: &Path, settings: &MountSettings) -> Result<Self> {
        mount_shared(image, mountpoint, settings)?;
        Ok(Self {
            mountpoint: mountpoint.to_path_buf(),
            fusermount: settings.fusermount.clone(),
        })
    }

    pub fn mountpoint(&self) -> &Path {
        &self.mountpoint
    }

    /// Unmount eagerly (rather than leaving it to `Drop`).
    pub fn unmount(&mut self) -> Result<()> {
        let result = unmount_one(&self.fusermount, &self.mountpoint);
        self.mountpoint = PathBuf::new();
        result
    }
}

impl Drop for ErofsMount {
    fn drop(&mut self) {
        if !self.mountpoint.as_os_str().is_empty() {
            let _ = unmount_one(&self.fusermount, &self.mountpoint);
        }
    }
}

/// Mount `image` read-only at `mountpoint`, with bounded helper, bounded
/// stderr collection and verified rollback on failure.
pub fn mount_shared(image: &Path, mountpoint: &Path, settings: &MountSettings) -> Result<()> {
    create_mountpoint(mountpoint)?;
    let mut command = Command::new(&settings.erofsfuse); // not-tmux: unprivileged EROFS FUSE helper
    command.arg(image).arg(mountpoint);
    let label = format!("{} {}", settings.erofsfuse.display(), image.display());
    let outcome = match run_bounded_helper(command, &label, PROBE_TIMEOUT) {
        Ok(outcome) => outcome,
        Err(error) => return finalize_mount_failure(&settings.fusermount, mountpoint, error),
    };
    if !outcome.status.success() {
        let detail = stderr_detail(&outcome);
        return finalize_mount_failure(
            &settings.fusermount,
            mountpoint,
            anyhow::anyhow!("{label} failed for {}: {detail}", mountpoint.display()),
        );
    }
    let deadline = Instant::now() + MOUNT_READY_TIMEOUT;
    while Instant::now() < deadline {
        if is_erofs_mount(mountpoint) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    finalize_mount_failure(
        &settings.fusermount,
        mountpoint,
        anyhow::anyhow!(
            "{} did not become an EROFS FUSE mount within {:?}",
            mountpoint.display(),
            MOUNT_READY_TIMEOUT
        ),
    )
}

fn create_mountpoint(mountpoint: &Path) -> Result<()> {
    std::fs::create_dir_all(mountpoint)
        .with_context(|| format!("create EROFS mountpoint {}", mountpoint.display()))?;
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
    fusermount: &Path,
    mountpoint: &Path,
    error: anyhow::Error,
) -> Result<()> {
    match unmount_shared(fusermount, mountpoint) {
        Ok(()) => Err(error),
        Err(rollback) => Err(error.context(format!(
            "verified rollback also failed; the mount remains orphaned: {rollback:#}"
        ))),
    }
}

/// Unmount `mountpoint` through `fusermount`, falling back to a lazy unmount.
///
/// This is the execution-scoped cleanup helper. Shared, reuse-managed mounts
/// must use [`unmount_shared`], which never bypasses active users.
pub fn unmount_one(fusermount: &Path, mountpoint: &Path) -> Result<()> {
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
        .with_context(|| format!("run {} -u {}", fusermount.display(), mountpoint.display()))?;
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
        anyhow::bail!("could not unmount {}", mountpoint.display());
    }
    Ok(())
}

/// Strict shared unmount: bounded, no lazy escape hatch, and it succeeds only
/// after the mountpoint is observed gone.
pub fn unmount_shared(fusermount: &Path, mountpoint: &Path) -> Result<()> {
    if !is_mounted(mountpoint) {
        return Ok(());
    }
    let mut command = Command::new(fusermount); // not-tmux: FUSE unmount helper
    command.arg("-u").arg(mountpoint);
    let label = format!("{} -u {}", fusermount.display(), mountpoint.display());
    let outcome = run_bounded_helper(command, &label, UNMOUNT_TIMEOUT)?;
    if !outcome.status.success() {
        anyhow::bail!("{label} failed: {}", stderr_detail(&outcome));
    }
    if is_mounted(mountpoint) {
        anyhow::bail!("{label} reported success but the mount remains");
    }
    Ok(())
}

/// One parsed `/proc/self/mountinfo` record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MountEntry {
    pub mountpoint: PathBuf,
    /// The filesystem type after the `-` separator, e.g. `fuse.erofsfuse`.
    pub fs_type: String,
    /// The mount source, e.g. `erofsfuse`.
    pub source: String,
}

/// The mountinfo record for exactly `path`, if it is a mountpoint.
pub fn mount_entry(path: &Path) -> Option<MountEntry> {
    let text = std::fs::read_to_string("/proc/self/mountinfo").ok()?;
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    text.lines()
        .find_map(|line| parse_mountinfo(line, &canonical))
}

fn parse_mountinfo(line: &str, canonical: &Path) -> Option<MountEntry> {
    let fields: Vec<&str> = line.split_whitespace().collect();
    let point = unescape_mount_point(fields.get(4)?);
    let mountpoint = Path::new(&point);
    if mountpoint != canonical {
        return None;
    }
    let separator = fields.iter().position(|field| *field == "-")?;
    Some(MountEntry {
        mountpoint: mountpoint.to_path_buf(),
        fs_type: fields.get(separator + 1)?.to_string(),
        source: unescape_mount_point(fields.get(separator + 2)?),
    })
}

/// Whether `path` is a live EROFS FUSE mount, as observed by mountinfo.
pub fn is_erofs_mount(path: &Path) -> bool {
    mount_entry(path).is_some_and(|entry| {
        entry.fs_type.to_ascii_lowercase().contains("erofs")
            || entry.source.to_ascii_lowercase().contains("erofs")
    })
}

/// Whether `path` currently appears as a mountpoint in this process's view.
pub fn is_mounted(path: &Path) -> bool {
    mount_entry(path).is_some()
}

struct BoundedOutcome {
    status: ExitStatus,
    stderr: String,
    stderr_stalled: bool,
}

/// Run a helper process with a hard deadline and a bounded stderr collection.
///
/// A helper whose descendant keeps the stderr pipe open after the helper has
/// exited cannot stall this call: the reader is detached and the stall is
/// reported. The child is killed and reaped on timeout.
fn run_bounded_helper(
    mut command: Command,
    label: &str,
    timeout: Duration,
) -> Result<BoundedOutcome> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = command.spawn().with_context(|| format!("start {label}"))?;
    let (sender, receiver) = mpsc::channel();
    if let Some(mut stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stderr.read_to_end(&mut bytes);
            let _ = sender.send(bytes);
        });
    }
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                anyhow::bail!("{label} did not return within {timeout:?}");
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                anyhow::bail!("wait for {label}: {error}");
            }
        }
    };
    let (stderr, stderr_stalled) = match receiver.recv_timeout(STDERR_COLLECT_TIMEOUT) {
        Ok(bytes) => (String::from_utf8_lossy(&bytes).trim().to_string(), false),
        Err(_) => (String::new(), true),
    };
    Ok(BoundedOutcome {
        status,
        stderr,
        stderr_stalled,
    })
}

fn stderr_detail(outcome: &BoundedOutcome) -> String {
    if outcome.stderr.is_empty() {
        if outcome.stderr_stalled {
            "stderr collection stalled".to_string()
        } else {
            "no stderr".to_string()
        }
    } else if outcome.stderr_stalled {
        format!("{} (stderr collection stalled)", outcome.stderr)
    } else {
        outcome.stderr.clone()
    }
}

fn unescape_mount_point(value: &str) -> String {
    value
        .replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn settings(root: &Path) -> MountSettings {
        MountSettings::new(root.join("erofsfuse"), root.join("fusermount3"))
    }

    fn make_executable(path: &Path) {
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
        make_executable(&settings.erofsfuse);
        let (available, reason) = probe(&settings);
        assert!(!available);
        assert!(reason.unwrap().contains("fusermount3"));
    }

    #[test]
    fn a_path_without_execute_permission_is_not_a_helper() {
        let root = tempfile::tempdir().unwrap();
        let helper = root.path().join("helper");
        std::fs::write(&helper, b"#!/bin/sh\nexit 0\n").unwrap();
        let mut permissions = std::fs::metadata(&helper).unwrap().permissions();
        permissions.set_mode(0o644);
        std::fs::set_permissions(&helper, permissions).unwrap();
        assert!(!executable(&helper));
    }

    #[test]
    fn an_unmounted_directory_is_not_a_mount() {
        let root = tempfile::tempdir().unwrap();
        assert!(!is_mounted(root.path()));
    }
}
