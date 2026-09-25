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
#[allow(dead_code)]
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

/// Which Nession component a state file belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Component {
    Agent,
    Server,
}

impl Component {
    fn as_str(self) -> &'static str {
        match self {
            Component::Agent => "agent",
            Component::Server => "server",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "agent" => Some(Component::Agent),
            "server" => Some(Component::Server),
            _ => None,
        }
    }
}

/// What a daemon state file records about the process that wrote it.
///
/// A bare pid is **not** an identity (#1016): operating systems reuse PIDs, so
/// "a process with this number exists" does not mean "the Nession process this
/// file was written for is alive" — and `stop` acting on that reading can signal
/// an unrelated process. The start time is what closes the gap: a reused pid
/// names a *different* instance, and two instances disagree about when they
/// started.
///
/// There is deliberately no instance nonce. The issue sketches one, but nothing
/// can *verify* a nonce — it could only be recorded, which proves no more than
/// the start time already does. A field that looks like evidence and isn't is
/// worse than not having it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    /// When the process started, in seconds since the Unix epoch.
    pub started_at: u64,
    pub kind: Component,
}

impl ProcessIdentity {
    /// The identity of the process calling this.
    pub fn of_current_process(kind: Component) -> Result<Self> {
        let pid = std::process::id();
        let started_at = start_time_of(pid).with_context(|| {
            format!("cannot determine when pid {pid} started; refusing to record an identity")
        })?;
        Ok(Self {
            pid,
            started_at,
            kind,
        })
    }
}

/// How far two readings of the same start time may differ and still be the same
/// instance.
///
/// Both readings are derived from `now` and a second-resolution uptime, so the
/// same process can measure a second apart on two calls. A pid reused by a
/// process that started within this window of its predecessor would compare
/// equal — which is a far narrower hole than "the pid exists", and not one this
/// can close without a platform-specific clock.
const START_TIME_TOLERANCE_SECS: u64 = 2;

/// When `pid` started, approximately, as seconds since the Unix epoch.
///
/// `now` minus the process's own uptime — deliberately one primitive rather than
/// two. The obvious composition, `boot_time + uptime`, is only correct where
/// `get_boot_time` measures: on Linux it does, and everywhere else it returns
/// `now - 3600` as a placeholder, which would make the sum drift by two seconds
/// per second instead of standing still.
///
/// What this needs from the result is *stability*, not accuracy: two readings of
/// an unchanged process must agree, and two different instances must not. Hence
/// the tolerance at the call site.
fn start_time_of(pid: u32) -> Option<u64> {
    let uptime = super::process::get_process_uptime(pid)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some(now.saturating_sub(uptime))
}

/// Record the identity of the current process at `path`.
pub fn write_identity(path: &str, kind: Component) -> Result<ProcessIdentity> {
    let identity = ProcessIdentity::of_current_process(kind)?;
    let body = format!(
        "pid={}\nstarted_at={}\nkind={}\n",
        identity.pid,
        identity.started_at,
        identity.kind.as_str()
    );
    fs::write(path, body).with_context(|| format!("Failed to write state file: {path}"))?;
    Ok(identity)
}

/// Read the identity recorded at `path`.
pub fn read_identity(path: &str) -> Result<ProcessIdentity> {
    let content =
        fs::read_to_string(path).with_context(|| format!("Failed to read state file: {path}"))?;

    let mut pid = None;
    let mut started_at = None;
    let mut kind = None;
    for line in content.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "pid" => pid = value.trim().parse::<u32>().ok(),
            "started_at" => started_at = value.trim().parse::<u64>().ok(),
            "kind" => kind = Component::parse(value.trim()),
            _ => {}
        }
    }

    match (pid, started_at, kind) {
        (Some(pid), Some(started_at), Some(kind)) => Ok(ProcessIdentity {
            pid,
            started_at,
            kind,
        }),
        // A file the old format wrote — a bare pid — reads as a missing record
        // rather than as an identity, because a bare pid is what this replaces.
        _ => anyhow::bail!("state file at {path} does not hold a process identity"),
    }
}

/// What the state file at `path` says about the process it names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ownership {
    /// The recorded instance is running: safe to signal.
    Alive(ProcessIdentity),
    /// The pid is alive but is a different instance — it was reused.
    Reused(ProcessIdentity),
    /// Nothing is running under that pid.
    Stale(ProcessIdentity),
}

/// Decide whether the process a state file names is the one that wrote it.
pub fn ownership(path: &str) -> Result<Ownership> {
    let recorded = read_identity(path)?;
    if !is_process_running(recorded.pid) {
        return Ok(Ownership::Stale(recorded));
    }
    match start_time_of(recorded.pid) {
        Some(started) if started.abs_diff(recorded.started_at) <= START_TIME_TOLERANCE_SECS => {
            Ok(Ownership::Alive(recorded))
        }
        // Either the start time differs — the pid is somebody else's process now
        // — or it could not be read at all. Both fall to the same answer on
        // purpose: `stop` must not signal a process whose ownership it cannot
        // establish (#1016), and "I cannot tell" is not "it is mine".
        _ => Ok(Ownership::Reused(recorded)),
    }
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

    /// A record naming some other pid, written without going through
    /// `write_identity` — which can only ever describe the calling process.
    fn record(path: &str, pid: u32, started_at: u64) {
        std::fs::write(
            path,
            format!("pid={pid}\nstarted_at={started_at}\nkind=agent\n"),
        )
        .unwrap();
    }

    #[test]
    fn an_identity_round_trips() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("agent.pid");
        let path = path.to_str().unwrap();

        let written = write_identity(path, Component::Agent).unwrap();
        let read = read_identity(path).unwrap();

        assert_eq!(read, written);
        assert_eq!(read.pid, std::process::id());
        assert_eq!(read.kind, Component::Agent);
    }

    #[test]
    fn the_current_process_is_recognised_as_ours() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("agent.pid");
        let path = path.to_str().unwrap();

        write_identity(path, Component::Agent).unwrap();

        assert!(matches!(ownership(path).unwrap(), Ownership::Alive(_)));
    }

    #[test]
    fn a_pid_that_is_not_running_is_stale() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("agent.pid");
        let path = path.to_str().unwrap();

        record(path, 999_999_999, 1_700_000_000);

        assert!(matches!(ownership(path).unwrap(), Ownership::Stale(_)));
    }

    /// The case this exists for: the pid is alive, but it is not our process.
    ///
    /// Written deterministically by naming *this* process's pid with a start
    /// time it cannot have — which is exactly what a reused pid looks like from
    /// the outside, without having to wait for the OS to recycle one.
    #[test]
    fn a_reused_pid_is_not_mistaken_for_ours() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("agent.pid");
        let path = path.to_str().unwrap();

        let real = ProcessIdentity::of_current_process(Component::Agent).unwrap();
        // Well outside the tolerance: this pid belongs to a process that started
        // a minute away from the one the file describes.
        record(path, real.pid, real.started_at + 60);

        let verdict = ownership(path).unwrap();
        assert!(
            matches!(verdict, Ownership::Reused(_)),
            "an alive pid with the wrong start time must not read as ours: {verdict:?}"
        );
    }

    /// The old format is not an identity, and must not be read as one.
    #[test]
    fn a_bare_pid_is_not_an_identity() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("agent.pid");
        let path = path.to_str().unwrap();

        std::fs::write(path, std::process::id().to_string()).unwrap();

        assert!(
            read_identity(path).is_err(),
            "a bare pid carries no ownership evidence and must not resolve"
        );
    }
}
