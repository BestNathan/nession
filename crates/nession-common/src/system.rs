//! System-level utilities (hostname, IP address, OS info).
//!
//! These functions use OS syscalls rather than environment variables,
//! so they work regardless of how the process was launched
//! (launchd, systemd, tmux pane, or interactive shell).

/// Get the system hostname via the OS `gethostname()` syscall.
///
/// Uses the [`hostname`] crate which wraps the POSIX `gethostname(2)` /
/// Win32 `GetComputerNameExW` call. This works reliably on Linux, macOS,
/// and Windows regardless of whether `$HOSTNAME` is set in the environment.
///
/// Returns `"unknown"` only when the OS call itself fails or the result
/// is not valid UTF-8 (extremely rare).
pub fn get_hostname() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "unknown".to_string())
}
