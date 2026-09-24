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

/// Prefix shared by every tmux session these tests create, so the contents of
/// a run directory left behind by a crashed run are recognizable at a glance.
/// Since #582, `scripts/sweep-test-sessions.sh` reclaims whole owned run
/// directories by pattern (`nession-test-tmux.*`) rather than by session name.
pub(crate) const TEST_SESSION_PREFIX: &str = "nession-test-";

pub(crate) fn unique_session_name(prefix: &str) -> String {
    let suffix: u32 = rand::thread_rng().gen();
    format!("{TEST_SESSION_PREFIX}{prefix}-{suffix}")
}

/// `tmux show-environment -t <session> <name>`, as tmux holds it — the value
/// half of the one `NAME=VALUE` line it prints, or `None` when tmux does not
/// answer successfully (an unknown variable exits 1).
///
/// This is how a test asks tmux what it actually holds, rather than asking
/// nession whether it thinks it succeeded — the distinction #980 turned on.
///
/// Built from `tmux::cmd::global()` like every other tmux call in this
/// workspace, so it addresses the socket this run was given rather than tmux's
/// default one, which is also what makes it read the same server the code
/// under test wrote to (`scripts/check-tmux-socket.sh` enforces the form).
///
/// The split is `split_once('=')` rather than a split on every `=`: a value is
/// allowed to contain them, and a value is not something to parse.
pub(crate) async fn tmux_show_environment(session: &str, name: &str) -> Option<String> {
    let out = nession_agent::tmux::cmd::global()
        .tokio()
        .args(["show-environment", "-t", session, name])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.trim()
        .split_once('=')
        .map(|(_, value)| value.to_string())
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
        //
        // Goes through tmux::cmd like every other tmux call in the workspace, so
        // this kill lands on nession's socket. A bare `tmux kill-session` here
        // would target the developer's real tmux server, where a name collision
        // would kill *their* session.
        let _ = nession_agent::tmux::cmd::global()
            .std()
            .args(["kill-session", "-t", &self.name])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}
