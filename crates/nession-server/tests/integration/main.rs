// Single harness for all nession-server integration tests.
// cargo discovers this automatically and names the target `integration`.

mod agent_registry;
mod command_broker;
mod db;
mod full_stack;
mod handler;
mod relay;
mod session_command;
mod session_registry;
mod websocket;

// ── Shared helpers ───────────────────────────────────────────────────────────

// current_timestamp: defined in both websocket.rs and full_stack.rs (byte-identical).
// Extract to crate root, delete the duplicates, and trim unused std::time imports.
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
