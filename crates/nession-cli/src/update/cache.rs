//! Update-check cache stored in ~/.nession/update-check.json.
//!
//! Caches the latest version check result for 30 minutes to avoid
//! excessive GitHub API calls on every CLI invocation.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::io;
use std::path::PathBuf;

/// Cache TTL: 30 minutes.
const CACHE_TTL_MINUTES: i64 = 30;

/// Serialized cache stored in ~/.nession/update-check.json.
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateCache {
    pub checked_at: DateTime<Utc>,
    pub latest_version: String,
    pub current_version: String,
    pub update_available: bool,
}

/// Returns the path to the update-check cache file.
fn cache_path() -> io::Result<PathBuf> {
    nession_common::paths::nession_home().map(|h| h.join("update-check.json"))
}

/// Read the cached update check result, if it exists and can be parsed.
pub fn read_cache() -> Option<UpdateCache> {
    let path = cache_path().ok()?;
    let data = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str::<UpdateCache>(&data).ok()
}

/// Write the update check result to the cache file.
/// Creates the ~/.nession directory if it doesn't exist.
pub fn write_cache(cache: &UpdateCache) -> io::Result<()> {
    let path = cache_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_string_pretty(cache)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    std::fs::write(&path, data)
}

/// Return true if the cached result is still fresh (within TTL).
pub fn is_cache_fresh(checked_at: &DateTime<Utc>) -> bool {
    let now = Utc::now();
    let elapsed = now.signed_duration_since(*checked_at);
    elapsed.num_minutes() < CACHE_TTL_MINUTES
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    #[test]
    fn fresh_within_ttl() {
        let five_min_ago = Utc::now() - Duration::minutes(5);
        assert!(is_cache_fresh(&five_min_ago));
    }

    #[test]
    fn stale_beyond_ttl() {
        let thirty_one_min_ago = Utc::now() - Duration::minutes(31);
        assert!(!is_cache_fresh(&thirty_one_min_ago));
    }

    #[test]
    fn fresh_at_exactly_ttl_minus_one() {
        let twenty_nine_min_ago = Utc::now() - Duration::minutes(29);
        assert!(is_cache_fresh(&twenty_nine_min_ago));
    }

    #[test]
    fn stale_at_exactly_ttl() {
        let thirty_min_ago = Utc::now() - Duration::minutes(30);
        assert!(!is_cache_fresh(&thirty_min_ago));
    }

    #[test]
    fn roundtrip_write_read() {
        let cache = UpdateCache {
            checked_at: Utc::now(),
            latest_version: "0.5.0".into(),
            current_version: "0.4.2".into(),
            update_available: true,
        };
        write_cache(&cache).unwrap();
        let read = read_cache().unwrap();
        assert_eq!(read.latest_version, "0.5.0");
        assert_eq!(read.current_version, "0.4.2");
        assert!(read.update_available);
    }

    #[test]
    fn read_cache_file_not_exists() {
        let path = cache_path().unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(read_cache().is_none());
    }
}
