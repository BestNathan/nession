//! Background update check executed on every CLI invocation.

use crate::update::cache::{self, is_cache_fresh, UpdateCache};
use crate::update::github::GitHubReleaseClient;
use crate::update::version::{compare_versions, VersionStatus};
use chrono::Utc;
use std::path::Path;

pub async fn background_check() -> Option<String> {
    let cache_path = cache::cache_path().ok();
    let client = GitHubReleaseClient::from_env().ok();
    background_check_at(cache_path.as_deref(), client).await
}

/// The explicit-input seam behind [`background_check`].
///
/// `cache_path` is the caller's owned cache file (or `None` when the durable
/// home is unresolvable); every `client` is an already-resolved release
/// source. Tests and isolated installs use this instead of mutating the
/// process-global `NESSON_UPDATE_API_URL`/`NESSON_HOME` (#4597 F10). The
/// production wrapper resolves both from the process environment once.
pub async fn background_check_at(
    cache_path: Option<&Path>,
    client: Option<GitHubReleaseClient>,
) -> Option<String> {
    let current_version = env!("CARGO_PKG_VERSION");

    if let Some(path) = cache_path {
        if let Some(cached) = cache::read_cache_at(path) {
            // A cache written by another installed release must never be read
            // as this release's answer (#3173).
            if cached.current_version == current_version && is_cache_fresh(&cached.checked_at) {
                return if cached.update_available {
                    Some(format!(
                        "⚠ Update available: {} → {}. Run `nession update` to upgrade.",
                        cached.current_version, cached.latest_version
                    ))
                } else {
                    None
                };
            }
        }
    }

    let client = client?;

    let release = match tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.fetch_latest(),
    )
    .await
    {
        Ok(Ok(r)) => r,
        _ => return None,
    };

    let latest_version = match crate::update::github::parse_release_version(&release) {
        Some(v) => v,
        None => return None,
    };

    let update_available = matches!(
        compare_versions(current_version, &latest_version),
        VersionStatus::UpdateAvailable { .. }
    );

    let cache_data = UpdateCache {
        checked_at: Utc::now(),
        latest_version: latest_version.to_string(),
        current_version: current_version.to_string(),
        update_available,
    };
    if let Some(path) = cache_path {
        let _ = cache::write_cache_at(path, &cache_data);
    }

    if update_available {
        Some(format!(
            "⚠ Update available: {current_version} → {latest_version}. Run `nession update` to upgrade.",
        ))
    } else {
        None
    }
}
