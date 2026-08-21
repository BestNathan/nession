// Single harness for all nession-agent integration tests.

mod connection;
mod control_mode;
mod full_chain; // ← e2e_test.rs renamed (spec: Rust has no E2E layer)
mod server;
mod sync;
mod tmux;

// ── Shared helpers ───────────────────────────────────────────────────────────

// unique_session_name: defined 5× across the 6 files, 4 of them byte-identical.
// Extract to crate root. control_mode's copy differs (extra ctrl- segment) and
// stays module-private.
use rand::Rng;

/// Prefix shared by every tmux session these tests create, so that strays left
/// behind by a crashed run are identifiable and can be swept in bulk.
/// `scripts/sweep-test-sessions.sh` matches on it.
pub(crate) const TEST_SESSION_PREFIX: &str = "nession-test-";

pub(crate) fn unique_session_name(prefix: &str) -> String {
    let suffix: u32 = rand::thread_rng().gen();
    format!("{TEST_SESSION_PREFIX}{prefix}-{suffix}")
}

/// Owns a generated session name and kills the tmux session on drop.
///
/// The tests' own `kill_session` calls only run on the happy path, so a panic
/// between creation and teardown used to leak the session permanently. Drop
/// runs during unwind too, which closes that hole.
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
