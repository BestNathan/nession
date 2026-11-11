//! Unprivileged Linux EROFS FUSE mount/unmount primitive (#3024, #3303).
//!
//! This is a *primitive*, not a composition owner: it mounts one already
//! verified local EROFS file read-only and owns the resulting mountpoint
//! until the handle is dropped or unmounted. Authorization (which source
//! roots are allowed), digest policy, mount ordering, overlay composition,
//! execution records and reconciliation stay with the consumer.
//!
//! Missing helpers, a missing `/dev/fuse`, or a mount that never appears fail
//! closed. There is no kernel-loop mount, extraction or Native fallback.

use anyhow::{Context, Result};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// How long a mount helper may take to return.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the mountpoint may take to appear after the helper returns.
pub const MOUNT_READY_TIMEOUT: Duration = Duration::from_secs(10);

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
        std::fs::create_dir_all(mountpoint)
            .with_context(|| format!("create EROFS mountpoint {}", mountpoint.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(mountpoint, std::fs::Permissions::from_mode(0o700));
        }
        run_fuse(&settings.erofsfuse, image, mountpoint)?;
        if !is_mounted(mountpoint) {
            anyhow::bail!(
                "erofsfuse reported success but {} is not a mount",
                mountpoint.display()
            );
        }
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

fn run_fuse(erofsfuse: &Path, image: &Path, mountpoint: &Path) -> Result<()> {
    let mut command = Command::new(erofsfuse); // not-tmux: unprivileged EROFS FUSE helper
    command.arg(image).arg(mountpoint);
    run_mount_helper(
        command,
        &format!("{} {}", erofsfuse.display(), image.display()),
        mountpoint,
    )
}

fn run_mount_helper(mut command: Command, label: &str, mountpoint: &Path) -> Result<()> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .with_context(|| format!("start {label} for {}", mountpoint.display()))?;
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
                anyhow::bail!("{label} did not return for {}", mountpoint.display());
            }
            Err(error) => {
                anyhow::bail!("wait for {label}: {error}");
            }
        }
    };
    let stderr = reader
        .and_then(|reader| reader.join().ok())
        .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
        .unwrap_or_default();
    if !status.success() {
        anyhow::bail!("{} failed for {}: {}", label, mountpoint.display(), stderr);
    }
    let deadline = Instant::now() + MOUNT_READY_TIMEOUT;
    while Instant::now() < deadline {
        if is_mounted(mountpoint) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    anyhow::bail!(
        "{} did not become a mount within {:?}",
        mountpoint.display(),
        MOUNT_READY_TIMEOUT
    )
}

/// Unmount `mountpoint` through `fusermount`, falling back to a lazy unmount.
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
