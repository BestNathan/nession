//! Agent adapter over the reusable EROFS cache (#3023, #3303).
//!
//! The durable download/resume/verify/publish/diagnostics/pin mechanics live
//! in [`nession_erofs::cache`]. This module supplies only what is Agent-owned:
//! the configured-root precedence resolved by
//! [`crate::config::AgentConfig::effective_erofs_storage_dir`] and the stable
//! Agent identity.

pub use nession_erofs::cache::eviction::{evict_all_unpinned, evict_unpinned, EvictionReport};
pub use nession_erofs::cache::fetch::{
    fetch_manifest_image, FetchedImage, ImageObjectGrant, MAX_METADATA_BYTES,
};
pub use nession_erofs::cache::{
    identity_root, CacheDiagnostics, CacheObservation, CachePhase, CacheProgress, CachedImage,
    DownloadGrant, ErofsCache, PinGuard, ProcMountsProbe, StorageProbe, IDENTITY_NAMESPACE_DIR,
    PARTIAL_RETENTION, TRANSFER_CHUNK_BYTES,
};
use nession_protocol::contracts::image::v1::{
    ImageCacheObservation, ImageCachePhase, ImageCacheStatus, IMAGE_BLOB_PATH_PREFIX,
    IMAGE_CACHE_OBSERVATION_VERSION,
};
use nession_protocol::contracts::session::v1::{ManagedImageGrant, ManagedImageRole};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::ResolvedErofsStorage;

/// Agent adapter that keeps a verified cache blob pinned for the full
/// lifetime of a shared physical EROFS mount (#3449).
#[cfg(target_os = "linux")]
pub struct CachePinner {
    cache: std::sync::Arc<ErofsCache>,
}

#[cfg(target_os = "linux")]
impl CachePinner {
    pub fn new(cache: std::sync::Arc<ErofsCache>) -> Self {
        Self { cache }
    }
}

#[cfg(target_os = "linux")]
struct CachePinGuard {
    _guard: PinGuard,
}

#[cfg(target_os = "linux")]
impl nession_erofs::mount_manager::BlobPinGuard for CachePinGuard {}

#[cfg(target_os = "linux")]
impl nession_erofs::mount_manager::BlobPinner for CachePinner {
    fn pin(
        &self,
        digest: &str,
    ) -> anyhow::Result<Box<dyn nession_erofs::mount_manager::BlobPinGuard>> {
        let guard = self.cache.pin(digest)?;
        Ok(Box::new(CachePinGuard { _guard: guard }))
    }
}

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

/// The immutable Manifest identity one prepared image resolved to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedManifestBinding {
    pub role: ManagedImageRole,
    pub manifest_digest: String,
    pub layer_digest: String,
}

/// One grant resolved to the physical EROFS identity the mount layer uses.
///
/// A Manifest-aware grant carries the immutable Manifest digest; a legacy
/// digest-addressed grant has none. `layer_path` is a verified cache file, not
/// a guessed path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedGrantImage {
    pub manifest_digest: Option<String>,
    pub layer_digest: String,
    pub layer_path: PathBuf,
}

/// Fetch one Server grant into this Agent's verified cache (#3499).
///
/// A grant with `objects` names a resolved Manifest and its reachable Config/
/// EROFS routes; the Agent fetches exactly that set, validates every descriptor
/// and returns the EROFS layer identity. An empty set preserves the accepted
/// legacy digest-addressed fetch.
pub async fn resolve_grant_image(
    cache: &ErofsCache,
    grant: &ManagedImageGrant,
    origin: &str,
    server_auth_token: &str,
) -> anyhow::Result<ResolvedGrantImage> {
    use anyhow::Context;

    if !grant.path.starts_with(IMAGE_BLOB_PATH_PREFIX) {
        anyhow::bail!(
            "authorization route '{}' is not an image blob path",
            grant.path
        );
    }
    if grant.objects.is_empty() {
        let download = DownloadGrant {
            url: format!("{origin}{}", grant.path),
            token: server_auth_token.to_string(),
        };
        let cached = cache
            .get_or_fetch(&grant.digest, &download)
            .await
            .with_context(|| format!("cannot prepare image {}", grant.digest))?;
        return Ok(ResolvedGrantImage {
            manifest_digest: None,
            layer_digest: grant.digest.clone(),
            layer_path: cached.path,
        });
    }

    let manifest = grant
        .objects
        .iter()
        .find(|object| object.digest == grant.digest)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "authorized object set does not contain the manifest identity {}",
                grant.digest
            )
        })?;
    if manifest.media_type != nession_erofs::oci::MEDIA_TYPE_MANIFEST {
        anyhow::bail!(
            "authorized image identity {} is {:?}, not a Manifest",
            grant.digest,
            manifest.media_type
        );
    }
    if manifest.path != grant.path {
        anyhow::bail!(
            "manifest route {:?} is not the image grant route {:?}",
            manifest.path,
            grant.path
        );
    }
    let objects = grant
        .objects
        .iter()
        .map(|object| {
            if !object.path.starts_with(IMAGE_BLOB_PATH_PREFIX) {
                anyhow::bail!(
                    "authorization route '{}' is not an image blob path",
                    object.path
                );
            }
            Ok(ImageObjectGrant {
                digest: object.digest.clone(),
                media_type: object.media_type.clone(),
                size_bytes: object.size_bytes,
                path: object.path.clone(),
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let fetched = fetch_manifest_image(
        cache,
        &objects,
        origin,
        server_auth_token,
        IMAGE_BLOB_PATH_PREFIX,
    )
    .await
    .with_context(|| format!("cannot prepare Manifest image {}", grant.digest))?;
    Ok(ResolvedGrantImage {
        manifest_digest: Some(fetched.manifest_digest.clone()),
        layer_digest: fetched.layer.digest.clone(),
        layer_path: fetched.layer_path,
    })
}

/// Project one digest into the authoritative per-digest observation (#3412).
///
/// This is read-only: it never downloads, repairs or evicts. A surviving
/// `.part` is `resumable`, not `downloading`; only an in-memory worker is
/// active. Server Ready is a different fact and is not inferred here.
pub async fn observation(cache: &ErofsCache, digest: &str) -> ImageCacheObservation {
    let progress = cache.observe_progress(digest).await;
    ImageCacheObservation {
        contract_version: IMAGE_CACHE_OBSERVATION_VERSION,
        digest: digest.to_string(),
        phase: match progress.phase {
            CachePhase::Absent => ImageCachePhase::Absent,
            CachePhase::Resumable => ImageCachePhase::Resumable,
            CachePhase::Downloading => ImageCachePhase::Downloading,
            CachePhase::Verifying => ImageCachePhase::Verifying,
            CachePhase::Verified => ImageCachePhase::Verified,
            CachePhase::Failed => ImageCachePhase::Failed,
        },
        downloaded_bytes: progress.downloaded_bytes,
        total_bytes: progress.total_bytes,
        active: progress.active,
        updated_at: unix_seconds(progress.updated_at),
        detail: progress.detail,
    }
}

/// The observation for an Agent with no configured EROFS cache.
pub fn unavailable_observation(digest: &str) -> ImageCacheObservation {
    ImageCacheObservation {
        contract_version: IMAGE_CACHE_OBSERVATION_VERSION,
        digest: digest.to_string(),
        phase: ImageCachePhase::Unavailable,
        downloaded_bytes: None,
        total_bytes: None,
        active: false,
        updated_at: unix_seconds(SystemTime::now()),
        detail: Some("this Agent has no EROFS cache configured".to_string()),
    }
}

/// Project one cached digest into the older Web-safe readiness vocabulary.
///
/// `preparing` covers resumable, downloading and verifying; only a verified
/// observation maps to `verified`.
pub async fn status(cache: &ErofsCache, digest: &str) -> ImageCacheStatus {
    ImageCacheStatus::from_observation(&observation(cache, digest).await)
}

fn unix_seconds(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use httptest::http::Response;
    use httptest::{matchers::*, Expectation, Server};
    use nession_erofs::digest_of_bytes;
    use nession_protocol::contracts::image::v1::ImageCacheState;

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
        let absent = observation(&cache, &digest).await;
        assert_eq!(absent.contract_version, IMAGE_CACHE_OBSERVATION_VERSION);
        assert_eq!(absent.phase, ImageCachePhase::Absent);
        assert!(!absent.active);
        let grant = DownloadGrant {
            url: server.url(&format!("/blobs/{digest}")).to_string(),
            token: "scoped-token".to_string(),
        };
        cache.get_or_fetch(&digest, &grant).await.unwrap();
        let verified = status(&cache, &digest).await;
        assert_eq!(verified.state, ImageCacheState::Verified);
        assert!(verified.detail.is_none());
        let verified_observation = observation(&cache, &digest).await;
        assert_eq!(verified_observation.phase, ImageCachePhase::Verified);
        assert_eq!(
            verified_observation.downloaded_bytes,
            Some(bytes.len() as u64)
        );
        assert!(!verified_observation.active);

        let other = format!("sha256:{}", "a".repeat(64));
        let partial = cache.partial_path(&other).unwrap();
        std::fs::write(&partial, b"partial").unwrap();
        let preparing = status(&cache, &other).await;
        assert_eq!(preparing.state, ImageCacheState::Preparing);
        assert!(preparing.detail.as_deref().unwrap().contains("partial"));
        let resumable = observation(&cache, &other).await;
        assert_eq!(resumable.phase, ImageCachePhase::Resumable);
        assert_eq!(resumable.downloaded_bytes, Some(b"partial".len() as u64));
        assert!(!resumable.active);
        assert_eq!(
            status(&cache, "sha256:not-a-digest").await.state,
            ImageCacheState::Failed
        );
    }
}
