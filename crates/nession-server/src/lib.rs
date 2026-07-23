pub mod broker;
pub mod db;
pub mod env;
pub mod probe;
pub mod registry;
pub mod server;

use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

static START_TIME: OnceLock<u64> = OnceLock::new();

/// Return the server's uptime in seconds. The first call captures the start
/// time; subsequent calls return the elapsed duration.
pub fn uptime_seconds() -> u64 {
    let start = *START_TIME.get_or_init(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    });
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    now.saturating_sub(start)
}
