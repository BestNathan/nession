//! Agent adapter over the reusable EROFS cache (#3023, #3303).
//!
//! The durable download/resume/verify/publish/diagnostics/pin mechanics live
//! in [`nession_erofs::cache`]. This module supplies only what is Agent-owned:
//! the configured-root precedence resolved by
//! [`crate::config::AgentConfig::effective_erofs_storage_dir`] and the stable
//! Agent identity.

pub use nession_erofs::cache::{
    identity_root, CacheDiagnostics, CacheObservation, CachedImage, DownloadGrant, ErofsCache,
    PinGuard, ProcMountsProbe, StorageProbe, IDENTITY_NAMESPACE_DIR, PARTIAL_RETENTION,
    TRANSFER_CHUNK_BYTES,
};
use nession_protocol::contracts::image::v1::{ImageCacheState, ImageCacheStatus};

use crate::config::ResolvedErofsStorage;

/// Open the Agent's durable cache from its resolved storage configuration.
///
/// `ResolvedErofsStorage` comes only from
/// [`crate::config::AgentConfig::effective_erofs_storage_dir`], which owns the
/// TOML > environment > native-default precedence. `identity` is the stable
/// Agent identity (see [`crate::identity::resolve_agent_id`]); two Agent
/// processes with different identities on one volume never share ready or
/// partial files.
pub async fn open_resolved(
    resolved: &ResolvedErofsStorage,
    identity: &str,
) -> anyhow::Result<ErofsCache> {
    ErofsCache::open_with_probe(
        &resolved.path,
        identity,
        resolved.explicit,
        &ProcMountsProbe,
    )
    .await
}

/// Project one cached digest into the Web-safe Agent readiness vocabulary.
///
/// This is an observation, never a reservation: it does not download, repair
/// or evict. Server Ready is a different fact and is not inferred here.
pub async fn status(cache: &ErofsCache, digest: &str) -> ImageCacheStatus {
    let (state, detail) = match cache.observe(digest).await {
        CacheObservation::Verified => (ImageCacheState::Verified, None),
        CacheObservation::Preparing => (
            ImageCacheState::Preparing,
            Some("a partial download exists; Enter will resume it".to_string()),
        ),
        CacheObservation::Absent => (ImageCacheState::Absent, None),
        CacheObservation::Failed { detail } => (ImageCacheState::Failed, Some(detail)),
    };
    ImageCacheStatus {
        digest: digest.to_string(),
        state,
        detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use httptest::http::Response;
    use httptest::{matchers::*, Expectation, Server};
    use nession_erofs::digest_of_bytes;

    #[tokio::test]
    async fn status_distinguishes_absent_verified_and_preparing_without_mutating() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"status image body".to_vec();
        let digest = digest_of_bytes(&bytes);
        let server = Server::run();
        server.expect(
            Expectation::matching(request::method_path("GET", format!("/blobs/{digest}")))
                .times(1)
                .respond_with(Response::builder().status(200).body(bytes.clone()).unwrap()),
        );
        let cache = ErofsCache::open_with_probe(dir.path(), "agent-test", false, &ProcMountsProbe)
            .await
            .unwrap();
        assert_eq!(status(&cache, &digest).await.state, ImageCacheState::Absent);
        let grant = DownloadGrant {
            url: server.url(&format!("/blobs/{digest}")).to_string(),
            token: "scoped-token".to_string(),
        };
        cache.get_or_fetch(&digest, &grant).await.unwrap();
        let verified = status(&cache, &digest).await;
        assert_eq!(verified.state, ImageCacheState::Verified);
        assert!(verified.detail.is_none());

        let other = format!("sha256:{}", "a".repeat(64));
        let partial = cache.partial_path(&other).unwrap();
        std::fs::write(&partial, b"partial").unwrap();
        let preparing = status(&cache, &other).await;
        assert_eq!(preparing.state, ImageCacheState::Preparing);
        assert!(preparing.detail.as_deref().unwrap().contains("partial"));
        assert_eq!(
            status(&cache, "sha256:not-a-digest").await.state,
            ImageCacheState::Failed
        );
    }
}
