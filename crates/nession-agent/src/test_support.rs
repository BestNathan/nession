//! Test-only helpers shared by this crate's unit tests.
//!
//! Integration tests under `tests/` cannot see `#[cfg(test)]` items, so they
//! keep their own copy of this in `tests/integration/main.rs`. Keep the two in
//! step: both must produce names starting with [`TEST_SESSION_PREFIX`], and
//! both must kill the session on drop.

use std::time::{SystemTime, UNIX_EPOCH};

/// Prefix shared by every tmux session the tests create, so that strays left
/// behind by a crashed run are identifiable and can be swept in bulk.
/// `scripts/sweep-test-sessions.sh` matches on it.
pub(crate) const TEST_SESSION_PREFIX: &str = "nession-test-";

pub(crate) fn unique_session_name(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{TEST_SESSION_PREFIX}{prefix}-{nanos}")
}

/// Owns a generated session name and kills the tmux session on drop.
///
/// Tests clean up on their happy path only, so a panic between creating the
/// session and reaching that teardown used to leak it permanently. Drop runs
/// during unwind too, which closes that hole.
pub(crate) struct TestSession {
    name: String,
}

impl TestSession {
    pub(crate) fn new(prefix: &str) -> Self {
        Self {
            name: unique_session_name(prefix),
        }
    }

    pub(crate) fn name(&self) -> &str {
        &self.name
    }
}

impl Drop for TestSession {
    fn drop(&mut self) {
        // Synchronous by necessity: Drop cannot await. A non-zero status just
        // means the test already cleaned up, so the result is ignored.
        let _ = std::process::Command::new("tmux")
            .args(["kill-session", "-t", &self.name])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}
