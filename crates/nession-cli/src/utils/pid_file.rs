//! PID file management utilities for daemon processes.
//!
//! Provides functions to create, read, and manage PID files for
//! background processes like agents and servers.

use anyhow::{Context, Result};
use std::fs;
use std::path::Path;

/// Write the current process ID to a file.
///
/// Creates or overwrites the file at `path` with the given PID.
/// Returns the PID that was written.
pub fn write_pid_file(path: &str, pid: u32) -> Result<()> {
    fs::write(path, pid.to_string())
        .with_context(|| format!("Failed to write PID file: {path}"))?;
    Ok(())
}

/// Read a PID from a file.
///
/// Returns the PID stored in the file at `path`.
/// Returns an error if the file doesn't exist or contains invalid data.
pub fn read_pid_file(path: &str) -> Result<u32> {
    let content =
        fs::read_to_string(path).with_context(|| format!("Failed to read PID file: {path}"))?;
    let pid: u32 = content
        .trim()
        .parse()
        .with_context(|| format!("Failed to parse PID from file: {path}"))?;
    Ok(pid)
}

/// Check if a process with the given PID is currently running.
///
/// Returns `true` if the process exists, `false` otherwise.
/// On Unix systems, this sends a signal 0 to check process existence.
#[cfg(unix)]
pub fn is_process_running(pid: u32) -> bool {
    use nix::sys::signal::kill;
    use nix::unistd::Pid;

    kill(Pid::from_raw(pid as i32), None).is_ok()
}

#[cfg(not(unix))]
pub fn is_process_running(pid: u32) -> bool {
    // On non-Unix systems, we can't easily check process existence
    // This is a placeholder implementation
    false
}

/// Check if a process is running based on its PID file.
///
/// Returns `true` if the PID file exists and the process is running.
/// Returns `false` if the file doesn't exist, is invalid, or the process is not running.
pub fn is_process_running_from_pid_file(path: &str) -> bool {
    if !Path::new(path).exists() {
        return false;
    }

    match read_pid_file(path) {
        Ok(pid) => is_process_running(pid),
        Err(_) => false,
    }
}

/// Format a duration in seconds into a human-readable string.
///
/// Examples:
/// - 30 seconds -> "30 seconds"
/// - 90 seconds -> "1 minute 30 seconds"
/// - 3661 seconds -> "1 hour 1 minute 1 second"
pub fn format_duration(seconds: u64) -> String {
    let hours = seconds / 3600;
    let minutes = (seconds % 3600) / 60;
    let secs = seconds % 60;

    let mut parts = Vec::new();

    if hours > 0 {
        parts.push(format!(
            "{} hour{}",
            hours,
            if hours == 1 { "" } else { "s" }
        ));
    }

    if minutes > 0 {
        parts.push(format!(
            "{} minute{}",
            minutes,
            if minutes == 1 { "" } else { "s" }
        ));
    }

    if secs > 0 || parts.is_empty() {
        parts.push(format!(
            "{} second{}",
            secs,
            if secs == 1 { "" } else { "s" }
        ));
    }

    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_write_and_read_pid_file() {
        let temp_dir = TempDir::new().unwrap();
        let pid_file = temp_dir.path().join("test.pid");
        let pid_file_str = pid_file.to_str().unwrap();

        let test_pid = 12345u32;
        write_pid_file(pid_file_str, test_pid).unwrap();

        let read_pid = read_pid_file(pid_file_str).unwrap();
        assert_eq!(read_pid, test_pid);
    }

    #[test]
    fn test_read_nonexistent_pid_file() {
        let result = read_pid_file("/nonexistent/path/to/pid.file");
        assert!(result.is_err());
    }

    #[test]
    fn test_format_duration_seconds() {
        assert_eq!(format_duration(30), "30 seconds");
        assert_eq!(format_duration(1), "1 second");
        assert_eq!(format_duration(0), "0 seconds");
    }

    #[test]
    fn test_format_duration_minutes() {
        assert_eq!(format_duration(90), "1 minute 30 seconds");
        assert_eq!(format_duration(60), "1 minute");
        assert_eq!(format_duration(120), "2 minutes");
    }

    #[test]
    fn test_format_duration_hours() {
        assert_eq!(format_duration(3661), "1 hour 1 minute 1 second");
        assert_eq!(format_duration(3600), "1 hour");
        assert_eq!(format_duration(7200), "2 hours");
    }

    #[test]
    fn test_is_process_running_current_process() {
        // Current process should be running
        let current_pid = std::process::id();
        assert!(is_process_running(current_pid));
    }

    #[test]
    fn test_is_process_running_nonexistent() {
        // Very high PID that likely doesn't exist
        assert!(!is_process_running(999999999));
    }

    #[test]
    fn test_is_process_running_from_pid_file() {
        let temp_dir = TempDir::new().unwrap();
        let pid_file = temp_dir.path().join("test.pid");
        let pid_file_str = pid_file.to_str().unwrap();

        // Non-existent file
        assert!(!is_process_running_from_pid_file(pid_file_str));

        // Current process
        let current_pid = std::process::id();
        write_pid_file(pid_file_str, current_pid).unwrap();
        assert!(is_process_running_from_pid_file(pid_file_str));

        // Non-existent process
        write_pid_file(pid_file_str, 999999999).unwrap();
        assert!(!is_process_running_from_pid_file(pid_file_str));
    }
}
