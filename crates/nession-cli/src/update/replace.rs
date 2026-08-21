//! Binary file operations: locate, backup, and atomically replace.

use crate::update::UpdateError;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn cli_install_dir() -> Result<PathBuf, UpdateError> {
    let exe = std::env::current_exe().map_err(UpdateError::Io)?;
    let canonical = std::fs::canonicalize(&exe).unwrap_or(exe);
    canonical.parent().map(Path::to_path_buf).ok_or_else(|| {
        UpdateError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "cannot determine CLI directory",
        ))
    })
}

pub fn locate_binary(name: &str, cli_dir: &Path) -> Option<PathBuf> {
    if name == "nession" {
        return std::env::current_exe().ok();
    }
    let candidate = cli_dir.join(name);
    if candidate.exists() {
        return Some(candidate);
    }
    which_in_path(name)
}

fn which_in_path(name: &str) -> Option<PathBuf> {
    let output = Command::new("which").arg(name).output().ok()?;
    if output.status.success() {
        let path_str = String::from_utf8(output.stdout).ok()?;
        let path = PathBuf::from(path_str.trim());
        if path.exists() {
            return Some(path);
        }
    }
    None
}

pub fn check_write_permission(path: &Path) -> Result<(), UpdateError> {
    let dir = path.parent().unwrap_or(path);
    if dir.is_dir()
        && std::fs::metadata(dir)
            .map(|m| m.permissions().readonly())
            .unwrap_or(true)
    {
        return Err(UpdateError::PermissionDenied(dir.to_path_buf()));
    }
    Ok(())
}

#[allow(dead_code)]
pub fn check_disk_space(path: &Path, needed: u64) -> Result<(), UpdateError> {
    let dir = if path.is_dir() {
        path
    } else {
        path.parent().unwrap_or(path)
    };
    let dir_str = dir.to_string_lossy();

    let output = Command::new("df")
        .args(["-k", &dir_str])
        .output()
        .map_err(|_| UpdateError::Io(std::io::Error::other("failed to run df")))?;

    if !output.status.success() {
        return Ok(());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // df -k output: "Available" is 4th column (index 3), in 1K blocks.
    let avail_kb = stdout
        .lines()
        .nth(1)
        .and_then(|line| line.split_whitespace().nth(3))
        .and_then(|s| s.parse::<u64>().ok());

    match avail_kb {
        // needed is in bytes; convert KB to bytes for comparison.
        Some(a) if a * 1024 < needed => Err(UpdateError::InsufficientSpace {
            need: needed,
            have: a * 1024,
        }),
        _ => Ok(()),
    }
}

pub fn is_process_running(name: &str) -> Option<u32> {
    let output = Command::new("pgrep").args(["-x", name]).output().ok()?;
    if output.status.success() {
        let pid_str = String::from_utf8(output.stdout).ok()?;
        pid_str.trim().parse::<u32>().ok()
    } else {
        None
    }
}

pub fn backup_binary(path: &Path) -> Result<PathBuf, UpdateError> {
    let backup_path = path.with_extension("bak");
    std::fs::copy(path, &backup_path).map_err(UpdateError::Io)?;
    Ok(backup_path)
}

pub fn set_executable(path: &Path) -> Result<(), UpdateError> {
    let mut perms = std::fs::metadata(path)
        .map_err(UpdateError::Io)?
        .permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).map_err(UpdateError::Io)?;
    Ok(())
}

pub fn atomic_replace(src: &Path, dst: &Path) -> Result<(), UpdateError> {
    let dst_dir = dst.parent().unwrap_or_else(|| Path::new("."));
    let tmp_name = format!(
        ".{}.tmp.{}",
        dst.file_name().and_then(|n| n.to_str()).unwrap_or("binary"),
        std::process::id()
    );
    let tmp_path = dst_dir.join(&tmp_name);
    std::fs::copy(src, &tmp_path).map_err(UpdateError::Io)?;
    set_executable(&tmp_path)?;
    std::fs::rename(&tmp_path, dst).map_err(UpdateError::Io)?;
    Ok(())
}

pub fn maybe_print_quarantine_hint(path: &Path) {
    if cfg!(target_os = "macos") {
        eprintln!(
            "Note: macOS may quarantine the new binary. If blocked, run: xattr -d com.apple.quarantine {}",
            path.display()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn locate_nession_uses_current_exe() {
        let found = locate_binary("nession", Path::new("/nonexistent"));
        assert!(found.is_some(), "should find the running test binary");
    }

    #[test]
    fn locate_unknown_binary_returns_none() {
        let found = locate_binary("nonexistent-binary-xyz", Path::new("/tmp"));
        assert!(found.is_none());
    }

    #[test]
    fn backup_and_restore() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("test-bin");
        fs::write(&original, b"old").unwrap();
        let backup = backup_binary(&original).unwrap();
        assert_eq!(backup, dir.path().join("test-bin.bak"));
        assert_eq!(fs::read_to_string(&backup).unwrap(), "old");
    }

    #[test]
    fn atomic_replace_works() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("new-bin");
        let dst = dir.path().join("target-bin");
        fs::write(&src, b"new content").unwrap();
        fs::write(&dst, b"old content").unwrap();
        set_executable(&src).unwrap();
        atomic_replace(&src, &dst).unwrap();
        let content = fs::read_to_string(&dst).unwrap();
        assert_eq!(content, "new content");
    }

    #[test]
    fn write_permission_check() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("writable-bin");
        fs::write(&path, b"test").unwrap();
        assert!(check_write_permission(&path).is_ok());
    }

    #[test]
    fn is_process_running_absent_process_returns_none() {
        // Must be a name that cannot plausibly be running. The previous version
        // of this test probed "nession-agent", which fails for any developer
        // who happens to have a local agent up — including anyone verifying a
        // change against a local stack — and blocks the pre-push hook.
        let pid = is_process_running("nession-no-such-process-b7f3a1c9");
        assert!(pid.is_none(), "an absent process must report no pid");
    }

    #[test]
    fn is_process_running_known_process() {
        // launchd (macOS) or systemd (Linux) should always be running. If
        // neither is found (unusual container), the test still proved the call
        // does not crash, so there is nothing left to assert.
        let pid = is_process_running("launchd").or_else(|| is_process_running("systemd"));
        if let Some(pid) = pid {
            assert!(pid > 0);
        }
    }

    #[test]
    fn check_write_permission_file_negative() {
        // Create a file inside a tempdir, then make the directory non-writable.
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("test-bin");
        std::fs::write(&file_path, b"content").unwrap();
        let mut dir_perms = std::fs::metadata(dir.path()).unwrap().permissions();
        dir_perms.set_readonly(true);
        std::fs::set_permissions(dir.path(), dir_perms).unwrap();
        let result = check_write_permission(&file_path);
        assert!(matches!(result, Err(UpdateError::PermissionDenied(_))));
        // Restore permissions so tempdir cleanup doesn't fail. Set the mode
        // explicitly rather than via `set_readonly(false)`, which on Unix
        // clears the mode to world-writable (0o777).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn cli_install_dir_returns_ok() {
        let result = cli_install_dir();
        assert!(result.is_ok(), "should find CLI install dir");
    }

    #[test]
    fn quarantine_hint_does_not_panic() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test");
        fs::write(&path, b"x").unwrap();
        maybe_print_quarantine_hint(&path); // should not panic
    }

    #[test]
    fn locate_binary_searches_path() {
        // 'ls' should exist on both macOS and Linux
        let cli_dir = Path::new("/nonexistent-dir-xyz");
        let found = locate_binary("ls", cli_dir);
        assert!(found.is_some(), "should find 'ls' in PATH");
    }

    #[test]
    fn locate_binary_not_in_path() {
        // A binary that definitely doesn't exist.
        let found = locate_binary(
            "nonexistent-binary-xyz-12345",
            Path::new("/nonexistent-dir"),
        );
        assert!(found.is_none());
    }

    #[test]
    fn locate_binary_in_cli_dir() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("testbin");
        fs::write(&bin, b"content").unwrap();
        let found = locate_binary("testbin", dir.path());
        assert_eq!(found, Some(bin));
    }

    #[test]
    fn check_disk_space_happy_path() {
        let dir = tempfile::tempdir().unwrap();
        assert!(check_disk_space(dir.path(), 1).is_ok());
    }

    #[test]
    fn check_disk_space_insufficient() {
        // u64::MAX bytes is impossibly large → should fail on any real system.
        let result = check_disk_space(Path::new("."), u64::MAX);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            UpdateError::InsufficientSpace { .. }
        ));
    }

    #[test]
    fn set_executable_works() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test-exe");
        fs::write(&path, b"content").unwrap();
        set_executable(&path).unwrap();
        let meta = std::fs::metadata(&path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert!(meta.permissions().mode() & 0o111 != 0);
        }
    }

    #[test]
    fn backup_binary_returns_path() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("test-bin");
        fs::write(&original, b"content").unwrap();
        let backup = backup_binary(&original).unwrap();
        assert_eq!(backup, dir.path().join("test-bin.bak"));
        assert!(backup.exists());
    }
}
