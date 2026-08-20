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

pub(crate) fn unique_session_name(prefix: &str) -> String {
    let suffix: u32 = rand::thread_rng().gen();
    format!("{}-{}", prefix, suffix)
}
