//! The parent half of the daemon readiness handshake (#1016).
//!
//! `nession agent start` and `nession server start` both run in the background
//! by re-executing themselves with `--foreground` and returning. What they
//! return *is* the answer the operator reads, so the parent has to know the
//! child reached the point of serving — not merely that `spawn` succeeded.
//!
//! It used to sleep a fixed interval and report success regardless, so a child
//! that had already died on a bad config, a taken port or an unreadable TLS
//! certificate was reported as a successful start.
//!
//! Two halves make the handshake, and they live in different crates: the child
//! announces through [`nession_common::readiness`], the parent waits here. Both
//! are shared by the agent and server paths on purpose — a second copy of this
//! wait is a second place for it to be subtly wrong about the same child.

use anyhow::{Context, Result};
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

/// How long a background start waits for the child to serve.
///
/// Deliberately generous: the child opens a database, binds a socket and, for
/// an agent, composes its providers. What it must not be is *unbounded*, and
/// what it must not become is the old fixed sleep — a deadline reported as a
/// failure is a better answer than a success nobody checked.
pub const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

/// How a background start ended.
#[derive(Debug)]
pub enum Startup {
    /// The child announced it is serving.
    Serving,
    /// The child exited first — its status is the reason.
    Exited(std::process::ExitStatus),
    /// Neither happened before the deadline.
    TimedOut,
}

/// The marker this parent is watching for, and the path it names to the child.
///
/// The path carries the parent's pid, so a marker left behind by an earlier
/// start — or by a pid the OS has since recycled — cannot be mistaken for this
/// child's announcement. It is removed when the wait ends, on every path.
#[derive(Debug)]
pub struct ReadyMarker {
    path: String,
}

impl ReadyMarker {
    /// A marker beside the state file, unique to this parent.
    pub fn beside_state_file(pid_file: &str) -> Self {
        Self {
            path: format!("{pid_file}.ready.{}", std::process::id()),
        }
    }

    /// Point `cmd` at this marker, and clear anything already at the path.
    ///
    /// Setting the variable and clearing the path belong together: a marker
    /// that already exists would be read as this child's announcement the
    /// instant the wait began, before the child had done anything at all.
    pub fn arm(&self, cmd: &mut Command) {
        let _ = fs::remove_file(&self.path);
        cmd.env(
            nession_common::readiness::NESSION_READY_FILE_ENV,
            &self.path,
        );
    }

    /// Whether the child has announced.
    fn is_announced(&self) -> bool {
        Path::new(&self.path).exists()
    }
}

impl Drop for ReadyMarker {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// Wait for the child to announce readiness, or to exit, or for the deadline.
///
/// Watching the child as well as the marker is the point: a start that only
/// waited for the marker would sit out the whole timeout on a child that died
/// immediately, and then report the timeout instead of the child's own failure.
pub async fn wait_for_ready(
    child: &mut std::process::Child,
    marker: &ReadyMarker,
    timeout: Duration,
) -> Startup {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if marker.is_announced() {
            return Startup::Serving;
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Startup::Exited(status);
        }
        if std::time::Instant::now() >= deadline {
            return Startup::TimedOut;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The pid to report for a background start that announced itself.
///
/// Read from the state file the child wrote rather than from `child.id()`, so
/// the number the operator is given is the one `stop` and `status` will act on.
/// It is an error for the two to disagree: the child writes its identity before
/// it can possibly announce, so a missing record here means the parent and the
/// child are not talking about the same file — which is how a `server stop`
/// against a custom `--pid-file` used to silently do nothing (#1016).
pub fn announced_pid(state_file: &str) -> Result<u32> {
    let identity = crate::utils::pid_file::read_identity(state_file).with_context(|| {
        format!(
            "the daemon announced it was serving but recorded no identity at {state_file}; \
             it was started with a different state file than the one being watched"
        )
    })?;
    Ok(identity.pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A child that stays alive, so only the marker can end the wait.
    fn spawn_sleeper() -> std::process::Child {
        std::process::Command::new("sleep")
            .arg("30")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn sleep")
    }

    fn marker_at(path: &Path) -> ReadyMarker {
        ReadyMarker {
            path: path.to_str().expect("utf-8 path").to_string(),
        }
    }

    #[tokio::test]
    async fn a_child_that_announces_is_serving() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("ready");
        std::fs::write(&path, "ready pid=1\n").expect("write marker");
        let marker = marker_at(&path);
        let mut child = spawn_sleeper();

        let outcome = wait_for_ready(&mut child, &marker, Duration::from_secs(5)).await;

        let _ = child.kill();
        assert!(matches!(outcome, Startup::Serving), "{outcome:?}");
    }

    /// The defect this replaces: a child that died was reported as a start.
    ///
    /// The deadline here is far longer than the child takes to die, so a
    /// `TimedOut` would mean the wait was watching the clock instead of the
    /// child — and the caller would print "check logs for status" and return
    /// success for a process that had already exited.
    #[tokio::test]
    async fn a_child_that_exits_without_announcing_reports_its_own_exit() {
        let dir = tempfile::tempdir().expect("tempdir");
        let marker = marker_at(&dir.path().join("ready"));
        let mut child = std::process::Command::new("false")
            .spawn()
            .expect("spawn false");

        let outcome = wait_for_ready(&mut child, &marker, Duration::from_secs(30)).await;

        match outcome {
            Startup::Exited(status) => assert!(
                !status.success(),
                "the child's own status must travel, not a synthesised success"
            ),
            other => panic!("expected the child's exit, not {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_child_that_never_announces_times_out() {
        let dir = tempfile::tempdir().expect("tempdir");
        let marker = marker_at(&dir.path().join("ready"));
        let mut child = spawn_sleeper();

        let outcome = wait_for_ready(&mut child, &marker, Duration::from_millis(200)).await;

        let _ = child.kill();
        assert!(matches!(outcome, Startup::TimedOut), "{outcome:?}");
    }

    /// The marker does not outlive the wait, on any outcome.
    ///
    /// It is left behind for nothing to read: the parent is the only reader, and
    /// it has stopped waiting. Leaving it would also mean a later start whose
    /// parent happened to reuse this pid would begin with the announcement
    /// already made — and `arm` clears the path for that same reason.
    #[test]
    fn the_marker_is_removed_when_the_wait_ends() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("ready");
        let marker = marker_at(&path);
        std::fs::write(&path, "ready pid=1\n").expect("write marker");

        drop(marker);

        assert!(
            !path.exists(),
            "the marker outlived the wait that watched it"
        );
    }

    /// `arm` must not leave an earlier announcement in place: a marker that
    /// already exists would read as this child's before it had done anything.
    #[test]
    fn arming_clears_a_marker_that_is_already_there() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("ready");
        let marker = marker_at(&path);
        std::fs::write(&path, "ready pid=1\n").expect("write stale marker");

        marker.arm(&mut std::process::Command::new("true"));

        assert!(
            !path.exists(),
            "a stale announcement would be read as the new child's"
        );
    }

    /// What the operator is told is the pid `stop` and `status` will act on.
    #[test]
    fn the_reported_pid_is_the_recorded_identity() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state_file = dir.path().join("server.pid");
        let state_file = state_file.to_str().expect("utf-8 path");

        let written = crate::utils::pid_file::write_identity(
            state_file,
            crate::utils::pid_file::Component::Server,
        )
        .expect("write identity");

        assert_eq!(
            announced_pid(state_file).expect("a recorded pid"),
            written.pid
        );
    }

    /// A child that announced but recorded nothing is a disagreement about which
    /// file to use, not a start to report.
    #[test]
    fn announcing_without_a_recorded_identity_is_an_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state_file = dir.path().join("server.pid");
        let state_file = state_file.to_str().expect("utf-8 path");
        std::fs::write(state_file, "not an identity\n").expect("write junk");

        assert!(
            announced_pid(state_file).is_err(),
            "an announced start with no identity must not report a pid"
        );
    }
}
