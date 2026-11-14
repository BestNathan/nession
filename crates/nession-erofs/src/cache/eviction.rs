//! Agent cache eviction with pins and metadata separation (#3499).
//!
//! Eviction is a distinct owner from the Server's catalog GC. It removes only
//! verified Ready files, never a partial and never a digest an active consumer
//! pins. Manifest/Config metadata is an independent cache entry, so evicting
//! one Manifest's metadata does not remove a shared EROFS payload another
//! Manifest still needs, and vice versa.

use anyhow::{Context, Result};
use std::collections::HashSet;

use crate::cache::ErofsCache;
use crate::digest::DIGEST_PREFIX;

/// What one eviction pass did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EvictionReport {
    pub examined: u64,
    pub evicted: Vec<String>,
    /// Verified bytes an active pin or lease protected.
    pub protected: Vec<String>,
    /// Digests that had no Ready file.
    pub absent: Vec<String>,
}

impl EvictionReport {
    pub fn evicted_blobs(&self) -> u64 {
        u64::try_from(self.evicted.len()).unwrap_or(u64::MAX)
    }
}

/// Evict the named digests unless an active consumer pins them.
///
/// A pinned digest stays Ready; a digest with no Ready file is reported
/// absent. Invalid digests fail the whole call before any file is removed, so
/// a caller bug can never turn into an arbitrary-path delete.
pub fn evict_unpinned(cache: &ErofsCache, digests: &[String]) -> Result<EvictionReport> {
    let mut report = EvictionReport::default();
    let mut seen = HashSet::new();
    for digest in digests {
        if !seen.insert(digest.clone()) {
            continue;
        }
        cache.blob_path(digest)?;
        report.examined += 1;
        if cache.is_pinned(digest) {
            report.protected.push(digest.clone());
            continue;
        }
        if cache.evict(digest)? {
            report.evicted.push(digest.clone());
        } else {
            report.absent.push(digest.clone());
        }
    }
    Ok(report)
}

/// Evict every verified object this identity's namespace holds unless pinned.
///
/// The scan sees only the identity's own `sha256/` directory; another Agent's
/// namespace on the same durable volume is never considered. Partials under
/// `tmp/` are not Ready objects and are never touched here.
pub fn evict_all_unpinned(cache: &ErofsCache) -> Result<EvictionReport> {
    let dir = cache.root().join("sha256");
    let mut digests = Vec::new();
    for entry in std::fs::read_dir(&dir)
        .with_context(|| format!("cannot read EROFS cache directory {}", dir.display()))?
    {
        let entry = entry?;
        let metadata = std::fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let digest = format!("{DIGEST_PREFIX}{name}");
        if crate::digest::is_valid_digest(&digest) {
            digests.push(digest);
        }
    }
    digests.sort();
    evict_unpinned(cache, &digests)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::PinGuard;
    use httptest::{matchers::*, Expectation, Server};

    fn digest_for(bytes: &[u8]) -> String {
        crate::digest::digest_of_bytes(bytes)
    }

    async fn cache(root: &std::path::Path) -> std::sync::Arc<ErofsCache> {
        std::sync::Arc::new(
            ErofsCache::open(root, "agent-eviction", false)
                .await
                .unwrap(),
        )
    }

    async fn fetch(cache: &ErofsCache, server: &Server, bytes: &[u8], digest: &str) {
        server.expect(
            Expectation::matching(request::method_path("GET", format!("/blobs/{digest}")))
                .times(1)
                .respond_with(
                    httptest::http::Response::builder()
                        .status(200)
                        .body(bytes.to_vec())
                        .unwrap(),
                ),
        );
        let grant = crate::cache::DownloadGrant {
            url: server.url(&format!("/blobs/{digest}")).to_string(),
            token: "t".to_string(),
        };
        cache.get_or_fetch(digest, &grant).await.unwrap();
    }

    #[tokio::test]
    async fn a_pinned_payload_is_protected_while_unpinned_metadata_is_reclaimable() {
        let dir = tempfile::tempdir().unwrap();
        let cache = cache(dir.path()).await;
        let server = Server::run();
        let payload = b"shared payload".to_vec();
        let manifest = b"{\"metadata\":true}".to_vec();
        let payload_digest = digest_for(&payload);
        let manifest_digest = digest_for(&manifest);
        fetch(&cache, &server, &payload, &payload_digest).await;
        fetch(&cache, &server, &manifest, &manifest_digest).await;

        let pins: Vec<PinGuard> = vec![cache.pin(&payload_digest).unwrap()];
        let report =
            evict_unpinned(&cache, &[payload_digest.clone(), manifest_digest.clone()]).unwrap();
        assert_eq!(report.protected, vec![payload_digest.clone()]);
        assert_eq!(report.evicted, vec![manifest_digest.clone()]);
        assert!(cache.blob_path(&payload_digest).unwrap().exists());
        assert!(!cache.blob_path(&manifest_digest).unwrap().exists());
        drop(pins);

        // Once the lease is gone the payload is reclaimable, and its partial
        // state (if any) is never part of eviction.
        let part = cache.partial_path(&payload_digest).unwrap();
        std::fs::write(&part, b"partial").unwrap();
        let report = evict_unpinned(&cache, std::slice::from_ref(&payload_digest)).unwrap();
        assert_eq!(report.evicted, vec![payload_digest.clone()]);
        assert!(part.exists(), "eviction never removes a partial");
    }

    #[tokio::test]
    async fn eviction_scans_only_this_identity_and_serializes_an_invalid_digest() {
        let dir = tempfile::tempdir().unwrap();
        let first = cache(dir.path()).await;
        let second = std::sync::Arc::new(
            ErofsCache::open(dir.path(), "agent-other", false)
                .await
                .unwrap(),
        );
        let server = Server::run();
        let payload = b"first identity".to_vec();
        let digest = digest_for(&payload);
        fetch(&first, &server, &payload, &digest).await;
        fetch(&second, &server, &payload, &digest).await;

        let report = evict_all_unpinned(&first).unwrap();
        assert_eq!(report.evicted, vec![digest.clone()]);
        assert!(!first.blob_path(&digest).unwrap().exists());
        assert!(second.blob_path(&digest).unwrap().exists());
        assert!(evict_unpinned(&first, &["sha256:nothex".to_string()]).is_err());
    }
}
