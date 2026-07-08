//! Background update check executed on every CLI invocation.

use crate::update::cache::{self, is_cache_fresh, UpdateCache};
use crate::update::github::GitHubReleaseClient;
use crate::update::version::{compare_versions, VersionStatus};
use chrono::Utc;

pub async fn background_check() -> Option<String> {
    let current_version = env!("CARGO_PKG_VERSION");

    if let Some(cached) = cache::read_cache() {
        if is_cache_fresh(&cached.checked_at) {
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

    let client = match GitHubReleaseClient::new() {
        Ok(c) => c,
        Err(_) => return None,
    };

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
    let _ = cache::write_cache(&cache_data);

    if update_available {
        Some(format!(
            "⚠ Update available: {current_version} → {latest_version}. Run `nession update` to upgrade.",
        ))
    } else {
        None
    }
}
