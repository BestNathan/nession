//! Agent adapter over the reusable EROFS cache (#3023, #3303).
//!
//! The durable download/resume/verify/publish/diagnostics/pin mechanics live
//! in [`nession_erofs::cache`]. This module supplies only what is Agent-owned:
//! the configured-root precedence resolved by
//! [`crate::config::AgentConfig::effective_erofs_storage_dir`] and the stable
//! Agent identity.

pub use nession_erofs::cache::eviction::{evict_all_unpinned, evict_unpinned, EvictionReport};
pub use nession_erofs::cache::fetch::{
    fetch_composite_image, fetch_composite_image_v2, fetch_manifest_image, fetch_manifest_image_v2,
    FetchedComposite, FetchedImage, ImageObjectGrant, MAX_METADATA_BYTES,
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
use nession_protocol::contracts::session::v1::{
    ManagedImageGrant, ManagedImageRole, SandboxImagePrepareIntent,
};
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

/// One resolved referenced Composite closure (#3697).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedCompositeGrant {
    pub descriptor_digest: String,
    pub metadata_digest: String,
    pub device_digests: Vec<String>,
    pub metadata_path: PathBuf,
    pub device_paths: Vec<PathBuf>,
}

/// One grant resolved to the physical EROFS identity the mount layer uses.
///
/// A Manifest-aware grant carries the immutable Manifest digest and the
/// standard Config/advisory annotation suggestions (#3500); a legacy
/// digest-addressed grant has neither. `layer_path` is a verified cache file,
/// not a guessed path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedGrantImage {
    pub manifest_digest: Option<String>,
    pub layer_digest: String,
    pub layer_path: PathBuf,
    /// Typed read-only Config/annotation suggestions. Present only for a
    /// Manifest-aware grant whose Config bytes were verified.
    pub usage: Option<nession_erofs::oci::usage::ImageRuntimeUsage>,
    /// Present when the Manifest is a referenced multi-blob Composite.
    pub composite: Option<ResolvedCompositeGrant>,
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

    // #4090 cutover target: a standard OCI `/v2/{repo}/manifests/{digest}` grant
    // is fetched through the unified SDK/cache with no proprietary download URL.
    // The proprietary compatibility path below is left untouched during the
    // window, so existing Session prepare/resume semantics cannot regress.
    if let Some(repository) = v2_manifest_repository(&grant.path, &grant.digest) {
        return resolve_grant_image_v2(cache, grant, origin, server_auth_token, &repository).await;
    }

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
            usage: None,
            composite: None,
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
    if objects
        .iter()
        .any(|object| object.media_type == nession_erofs::oci::MEDIA_TYPE_COMPOSITE)
    {
        let fetched = fetch_composite_image(
            cache,
            &objects,
            origin,
            server_auth_token,
            IMAGE_BLOB_PATH_PREFIX,
        )
        .await
        .with_context(|| format!("cannot prepare Composite image {}", grant.digest))?;
        let usage = nession_erofs::oci::usage::ImageRuntimeUsage::from_manifest_and_config(
            &fetched.manifest,
            &fetched.config,
        )
        .with_context(|| format!("cannot read the runtime usage of Manifest {}", grant.digest))?;
        return Ok(ResolvedGrantImage {
            manifest_digest: Some(fetched.manifest_digest.clone()),
            layer_digest: fetched.metadata.digest.clone(),
            layer_path: fetched.metadata_path.clone(),
            usage: Some(usage),
            composite: Some(ResolvedCompositeGrant {
                descriptor_digest: fetched.composite_digest,
                metadata_digest: fetched.metadata.digest.clone(),
                device_digests: fetched
                    .devices
                    .iter()
                    .map(|device| device.digest.clone())
                    .collect(),
                metadata_path: fetched.metadata_path,
                device_paths: fetched.device_paths,
            }),
        });
    }
    let fetched = fetch_manifest_image(
        cache,
        &objects,
        origin,
        server_auth_token,
        IMAGE_BLOB_PATH_PREFIX,
    )
    .await
    .with_context(|| format!("cannot prepare Manifest image {}", grant.digest))?;
    let usage = nession_erofs::oci::usage::ImageRuntimeUsage::from_manifest_and_config(
        &fetched.manifest,
        &fetched.config,
    )
    .with_context(|| format!("cannot read the runtime usage of Manifest {}", grant.digest))?;
    Ok(ResolvedGrantImage {
        manifest_digest: Some(fetched.manifest_digest.clone()),
        layer_digest: fetched.layer.digest.clone(),
        layer_path: fetched.layer_path,
        usage: Some(usage),
        composite: None,
    })
}

/// Parse the authorized repository from a standard `/v2/{repo}/manifests/{digest}`
/// grant route (#4090). Returns `None` for the proprietary blob route or any
/// shape that is not a validated repository-scoped Manifest route.
fn v2_manifest_repository(path: &str, digest: &str) -> Option<String> {
    let rest = path.strip_prefix("/v2/")?;
    let suffix = format!("/manifests/{digest}");
    let repository = rest.strip_suffix(&suffix)?;
    if repository.is_empty() || repository.contains("/manifests/") || repository.contains("/blobs/")
    {
        return None;
    }
    nession_erofs::contracts::validate_repository_name(repository).ok()?;
    Some(repository.to_string())
}

/// Resolve a standard `/v2/` Registry grant through the unified SDK/cache (#4090).
///
/// The reachability fence is the Server's: the Agent fetches only the authorized
/// repository closure by immutable digest. Both a single-EROFS Manifest and a
/// referenced Composite closure (#4250) are fetched through the unified SDK/cache
/// over `/v2/`; a partial or descriptor-mismatched closure still fails closed.
async fn resolve_grant_image_v2(
    cache: &ErofsCache,
    grant: &ManagedImageGrant,
    origin: &str,
    server_auth_token: &str,
    repository: &str,
) -> anyhow::Result<ResolvedGrantImage> {
    use anyhow::Context;

    if grant.objects.is_empty() {
        anyhow::bail!("a /v2/ Registry grant must name its authorized object closure");
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
        .map(|object| ImageObjectGrant {
            digest: object.digest.clone(),
            media_type: object.media_type.clone(),
            size_bytes: object.size_bytes,
            path: object.path.clone(),
        })
        .collect::<Vec<_>>();
    if objects
        .iter()
        .any(|object| object.media_type == nession_erofs::oci::MEDIA_TYPE_COMPOSITE)
    {
        let fetched =
            fetch_composite_image_v2(cache, &objects, origin, server_auth_token, repository)
                .await
                .with_context(|| {
                    format!("cannot prepare Composite image {} via /v2/", grant.digest)
                })?;
        let usage = nession_erofs::oci::usage::ImageRuntimeUsage::from_manifest_and_config(
            &fetched.manifest,
            &fetched.config,
        )
        .with_context(|| format!("cannot read the runtime usage of Manifest {}", grant.digest))?;
        return Ok(ResolvedGrantImage {
            manifest_digest: Some(fetched.manifest_digest.clone()),
            layer_digest: fetched.metadata.digest.clone(),
            layer_path: fetched.metadata_path.clone(),
            usage: Some(usage),
            composite: Some(ResolvedCompositeGrant {
                descriptor_digest: fetched.composite_digest,
                metadata_digest: fetched.metadata.digest.clone(),
                device_digests: fetched
                    .devices
                    .iter()
                    .map(|device| device.digest.clone())
                    .collect(),
                metadata_path: fetched.metadata_path,
                device_paths: fetched.device_paths,
            }),
        });
    }
    let fetched = fetch_manifest_image_v2(cache, &objects, origin, server_auth_token, repository)
        .await
        .with_context(|| format!("cannot prepare Manifest image {} via /v2/", grant.digest))?;
    let usage = nession_erofs::oci::usage::ImageRuntimeUsage::from_manifest_and_config(
        &fetched.manifest,
        &fetched.config,
    )
    .with_context(|| format!("cannot read the runtime usage of Manifest {}", grant.digest))?;
    Ok(ResolvedGrantImage {
        manifest_digest: Some(fetched.manifest_digest.clone()),
        layer_digest: fetched.layer.digest.clone(),
        layer_path: fetched.layer_path,
        usage: Some(usage),
        composite: None,
    })
}

/// Project one digest into the authoritative per-digest observation (#3412).
///
/// This is read-only: it never downloads, repairs or evicts. A surviving
/// `.part` is `resumable`, not `downloading`; only an in-memory worker is
/// active. Server Ready is a different fact and is not inferred here.
///
/// For a locally verified OCI Manifest identity, the observation aggregates
/// the blobs the image actually mounts: its EROFS layer, or a Composite
/// descriptor plus its metadata and ordered devices (#3796). A Manifest whose
/// closure is still downloading is never reported as mount-ready just because
/// its small metadata document arrived first.
pub async fn observation(cache: &ErofsCache, digest: &str) -> ImageCacheObservation {
    identity_observations(cache, digest).await.0
}

/// The aggregate observation plus every observed object it was derived from.
///
/// A legacy digest-addressed blob has no closure, so the list is exactly the
/// requested identity. This is what the explicit prepare unit returns.
pub async fn identity_observations(
    cache: &ErofsCache,
    digest: &str,
) -> (ImageCacheObservation, Vec<ImageCacheObservation>) {
    let own = direct_observation(cache, digest).await;
    if own.phase != ImageCachePhase::Verified {
        return (own.clone(), vec![own]);
    }
    let Some(closure) = required_closure(cache, digest).await else {
        return (own.clone(), vec![own]);
    };
    if closure.is_empty() {
        return (own.clone(), vec![own]);
    }
    let mut observations = Vec::with_capacity(closure.len());
    for child in &closure {
        observations.push(direct_observation(cache, child).await);
    }
    let aggregate = aggregate_observation(digest, &observations);
    (aggregate, observations)
}

/// One digest's own state, without inspecting a Manifest closure.
async fn direct_observation(cache: &ErofsCache, digest: &str) -> ImageCacheObservation {
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

/// The blobs a verified local Manifest requires before it is mount-ready.
///
/// `None` means the bytes are not a Manifest (a legacy digest-addressed blob),
/// so the identity's own verified state is the whole answer.
async fn required_closure(cache: &ErofsCache, digest: &str) -> Option<Vec<String>> {
    let manifest_path = cache.blob_path(digest).ok()?;
    let manifest_bytes = tokio::fs::read(&manifest_path).await.ok()?;
    let (_, manifest) = nession_erofs::oci::parse_manifest(&manifest_bytes).ok()?;
    let layer = manifest.layers.first()?;
    if layer.media_type == nession_erofs::oci::annotation::MEDIA_TYPE_EROFS {
        return Some(vec![layer.digest.clone()]);
    }
    if layer.media_type != nession_erofs::oci::annotation::MEDIA_TYPE_COMPOSITE {
        return None;
    }
    // The Composite descriptor itself is required; while it is still missing
    // or being fetched, its own state is the truthful aggregate.
    let descriptor_state = direct_observation(cache, &layer.digest).await;
    if descriptor_state.phase != ImageCachePhase::Verified {
        return Some(vec![layer.digest.clone()]);
    }
    let mut closure = vec![layer.digest.clone()];
    let Ok(descriptor_path) = cache.blob_path(&layer.digest) else {
        return Some(closure);
    };
    let Ok(descriptor_bytes) = tokio::fs::read(&descriptor_path).await else {
        return Some(closure);
    };
    let Ok(composite) = nession_erofs::oci::composite::parse_composite(&descriptor_bytes) else {
        return Some(closure);
    };
    let Ok(devices) = composite.closure() else {
        return Some(closure);
    };
    closure.extend(devices.into_iter().map(|descriptor| descriptor.digest));
    Some(closure)
}

fn aggregate_observation(
    digest: &str,
    observations: &[ImageCacheObservation],
) -> ImageCacheObservation {
    let any = |phase: ImageCachePhase| observations.iter().any(|item| item.phase == phase);
    let phase = if any(ImageCachePhase::Failed) || any(ImageCachePhase::Unavailable) {
        ImageCachePhase::Failed
    } else if any(ImageCachePhase::Verifying) {
        ImageCachePhase::Verifying
    } else if any(ImageCachePhase::Downloading) {
        ImageCachePhase::Downloading
    } else if any(ImageCachePhase::Resumable) {
        ImageCachePhase::Resumable
    } else if any(ImageCachePhase::Absent) {
        ImageCachePhase::Absent
    } else {
        ImageCachePhase::Verified
    };
    let verified = observations
        .iter()
        .filter(|item| item.phase == ImageCachePhase::Verified)
        .count();
    let total_known = observations
        .iter()
        .all(|item| item.total_bytes.is_some() && item.downloaded_bytes.is_some());
    let (downloaded_bytes, total_bytes) = if total_known {
        (
            Some(
                observations
                    .iter()
                    .filter_map(|item| item.downloaded_bytes)
                    .sum(),
            ),
            Some(
                observations
                    .iter()
                    .filter_map(|item| item.total_bytes)
                    .sum(),
            ),
        )
    } else {
        (None, None)
    };
    let active = matches!(
        phase,
        ImageCachePhase::Downloading | ImageCachePhase::Verifying
    );
    let updated_at = match phase {
        ImageCachePhase::Downloading | ImageCachePhase::Verifying => {
            match SystemTime::now().duration_since(UNIX_EPOCH) {
                Ok(duration) => duration.as_secs(),
                Err(_) => 0,
            }
        }
        _ => observations
            .iter()
            .map(|item| item.updated_at)
            .max()
            .unwrap_or(0),
    };
    let detail = match phase {
        ImageCachePhase::Verified => None,
        ImageCachePhase::Failed => {
            Some("a required image blob failed verification or preparation".to_string())
        }
        ImageCachePhase::Resumable => Some(format!(
            "{verified} of {} required image blobs verified; a partial download can resume",
            observations.len()
        )),
        ImageCachePhase::Downloading | ImageCachePhase::Verifying => Some(format!(
            "{verified} of {} required image blobs verified",
            observations.len()
        )),
        ImageCachePhase::Absent | ImageCachePhase::Unavailable => Some(format!(
            "{verified} of {} required image blobs verified",
            observations.len()
        )),
    };
    ImageCacheObservation {
        contract_version: IMAGE_CACHE_OBSERVATION_VERSION,
        digest: digest.to_string(),
        phase,
        downloaded_bytes,
        total_bytes,
        active,
        updated_at,
        detail,
    }
}

/// One explicit prepare/resume/retry result (#3796).
#[derive(Debug, Clone)]
pub struct PreparedImage {
    /// The aggregate state of the identity's required closure.
    pub observation: ImageCacheObservation,
    /// Every observed object the aggregate was derived from.
    pub observations: Vec<ImageCacheObservation>,
}

/// Fetch, resume or retry one authorized Image identity in this cache.
///
/// The intent is checked against the cache's own observation, so an
/// ineligible action is refused instead of silently downloading. Concurrent
/// callers share the transfer engine's per-digest single-flight work; a
/// repeated prepare observes the same verified bytes rather than fetching
/// them twice. A read never reaches this function.
pub async fn prepare_grant_image(
    cache: &ErofsCache,
    grant: &ManagedImageGrant,
    intent: SandboxImagePrepareIntent,
    origin: &str,
    server_auth_token: &str,
) -> anyhow::Result<PreparedImage> {
    if grant.digest.is_empty()
        || !nession_protocol::contracts::image::v1::is_valid_image_digest(&grant.digest)
    {
        anyhow::bail!("the authorized image identity is not a valid digest");
    }
    let (before, _) = identity_observations(cache, &grant.digest).await;
    match intent {
        SandboxImagePrepareIntent::Prepare => match before.phase {
            ImageCachePhase::Verified => return Ok(prepared_image(cache, &grant.digest).await),
            ImageCachePhase::Unavailable => {
                anyhow::bail!("this Agent has no EROFS cache for the image")
            }
            // An active transfer is already doing exactly this work. Return
            // the truthful in-flight observation instead of starting a second
            // download; the caller polls the same identity.
            ImageCachePhase::Downloading | ImageCachePhase::Verifying => {
                return Ok(PreparedImage {
                    observation: before.clone(),
                    observations: vec![before],
                })
            }
            _ => {}
        },
        SandboxImagePrepareIntent::Resume => {
            if before.phase != ImageCachePhase::Resumable {
                anyhow::bail!(
                    "resume requires a durable partial; the image is currently {}",
                    phase_word(before.phase)
                );
            }
        }
        SandboxImagePrepareIntent::Retry => {
            if before.phase != ImageCachePhase::Failed {
                anyhow::bail!(
                    "retry requires a failed cache state; the image is currently {}",
                    phase_word(before.phase)
                );
            }
        }
    }
    resolve_grant_image(cache, grant, origin, server_auth_token).await?;
    Ok(prepared_image(cache, &grant.digest).await)
}

async fn prepared_image(cache: &ErofsCache, digest: &str) -> PreparedImage {
    let (observation, observations) = identity_observations(cache, digest).await;
    PreparedImage {
        observation,
        observations,
    }
}

fn phase_word(phase: ImageCachePhase) -> &'static str {
    match phase {
        ImageCachePhase::Absent => "absent",
        ImageCachePhase::Resumable => "resumable",
        ImageCachePhase::Downloading => "downloading",
        ImageCachePhase::Verifying => "verifying",
        ImageCachePhase::Verified => "verified",
        ImageCachePhase::Failed => "failed",
        ImageCachePhase::Unavailable => "unavailable",
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

    #[test]
    fn v2_manifest_repository_detects_only_validated_registry_routes() {
        let digest = format!("sha256:{}", "b".repeat(64));
        // A standard repository-scoped Manifest route yields the repository.
        assert_eq!(
            v2_manifest_repository(&format!("/v2/team/app/manifests/{digest}"), &digest),
            Some("team/app".to_string())
        );
        assert_eq!(
            v2_manifest_repository(&format!("/v2/app/manifests/{digest}"), &digest),
            Some("app".to_string())
        );
        // The proprietary compatibility route is not a /v2/ grant.
        assert_eq!(
            v2_manifest_repository(&format!("/images/blobs/{digest}"), &digest),
            None
        );
        // A blobs route is not the Manifest grant route.
        assert_eq!(
            v2_manifest_repository(&format!("/v2/team/app/blobs/{digest}"), &digest),
            None
        );
        // A digest mismatch, an empty repository and an invalid name fail closed.
        assert_eq!(
            v2_manifest_repository(&format!("/v2/team/app/manifests/{digest}"), "sha256:other"),
            None
        );
        assert_eq!(
            v2_manifest_repository(&format!("/v2//manifests/{digest}"), &digest),
            None
        );
        assert_eq!(
            v2_manifest_repository(&format!("/v2/Team/App/manifests/{digest}"), &digest),
            None
        );
    }
}

#[cfg(test)]
mod prepare_tests {
    use super::*;
    use httptest::http::Response;
    use httptest::{matchers::*, Expectation, Server};
    use nession_erofs::oci::config::{ImageConfig, RootFs, RuntimeConfig};
    use nession_erofs::oci::descriptor::Descriptor;
    use nession_erofs::oci::{to_bytes, Manifest, RawDocument};
    use nession_protocol::contracts::session::v1::{
        ManagedImageGrant, ManagedImageObjectGrant, ManagedImageRole,
    };
    use serde_json::Map;

    const ROUTE_PREFIX: &str = "/images/blobs/";

    struct Fixture {
        manifest: RawDocument,
        config: RawDocument,
        layer: RawDocument,
    }

    fn fixture(payload: &[u8]) -> Fixture {
        let layer = RawDocument::from_bytes(payload.to_vec());
        let config = ImageConfig {
            created: None,
            author: None,
            architecture: "amd64".to_string(),
            os: "linux".to_string(),
            os_version: None,
            os_features: Some(vec!["erofs".to_string()]),
            variant: None,
            config: RuntimeConfig::default(),
            rootfs: RootFs {
                fs_type: "layers".to_string(),
                diff_ids: vec![layer.digest().to_string()],
                extra: Map::new(),
            },
            history: Vec::new(),
            extra: Map::new(),
        };
        let config = RawDocument::from_bytes(to_bytes(&config).unwrap());
        let manifest = Manifest {
            schema_version: 2,
            media_type: Some(nession_erofs::oci::MEDIA_TYPE_MANIFEST.to_string()),
            config: Descriptor {
                media_type: nession_erofs::oci::MEDIA_TYPE_CONFIG.to_string(),
                digest: config.digest().to_string(),
                size: config.size().unwrap(),
                urls: None,
                annotations: None,
                platform: None,
                artifact_type: None,
                data: None,
                extra: Map::new(),
            },
            layers: vec![Descriptor {
                media_type: nession_erofs::oci::MEDIA_TYPE_EROFS.to_string(),
                digest: layer.digest().to_string(),
                size: layer.size().unwrap(),
                urls: None,
                annotations: None,
                platform: None,
                artifact_type: None,
                data: None,
                extra: Map::new(),
            }],
            subject: None,
            artifact_type: None,
            annotations: None,
            extra: Map::new(),
        };
        Fixture {
            manifest: RawDocument::from_bytes(to_bytes(&manifest).unwrap()),
            config,
            layer,
        }
    }

    fn grant(fixture: &Fixture) -> ManagedImageGrant {
        let object = |digest: &str, media_type: &str, size: u64| ManagedImageObjectGrant {
            digest: digest.to_string(),
            media_type: media_type.to_string(),
            size_bytes: size,
            path: format!("{ROUTE_PREFIX}{digest}"),
        };
        ManagedImageGrant {
            role: ManagedImageRole::Base,
            digest: fixture.manifest.digest().to_string(),
            path: format!("{ROUTE_PREFIX}{}", fixture.manifest.digest()),
            target: None,
            objects: vec![
                object(
                    fixture.manifest.digest(),
                    nession_erofs::oci::MEDIA_TYPE_MANIFEST,
                    fixture.manifest.size().unwrap(),
                ),
                object(
                    fixture.config.digest(),
                    nession_erofs::oci::MEDIA_TYPE_CONFIG,
                    fixture.config.size().unwrap(),
                ),
                object(
                    fixture.layer.digest(),
                    nession_erofs::oci::MEDIA_TYPE_EROFS,
                    fixture.layer.size().unwrap(),
                ),
            ],
        }
    }

    async fn cache(root: &std::path::Path) -> ErofsCache {
        ErofsCache::open_with_probe(root, "agent-prepare", false, &ProcMountsProbe)
            .await
            .unwrap()
    }

    async fn write_blob(cache: &ErofsCache, digest: &str, bytes: &[u8]) {
        let path = cache.blob_path(digest).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    fn serve(server: &Server, bytes: &[u8], digest: &str, times: usize) {
        server.expect(
            Expectation::matching(request::method_path(
                "GET",
                format!("{ROUTE_PREFIX}{digest}"),
            ))
            .times(times)
            .respond_with(
                Response::builder()
                    .status(200)
                    .body(bytes.to_vec())
                    .unwrap(),
            ),
        );
    }

    fn origin(server: &Server) -> String {
        let root = server.url("/").to_string();
        root.trim_end_matches('/').to_string()
    }

    #[tokio::test]
    async fn a_manifest_observation_aggregates_its_required_layer() {
        let dir = tempfile::tempdir().unwrap();
        let cache = cache(dir.path()).await;
        let fixture = fixture(b"the only required layer");
        write_blob(&cache, fixture.manifest.digest(), fixture.manifest.bytes()).await;

        // The Manifest metadata is verified, but the image is not mount-ready
        // until its EROFS layer is.
        let (absent, observations) = identity_observations(&cache, fixture.manifest.digest()).await;
        assert_eq!(absent.phase, ImageCachePhase::Absent);
        assert_eq!(observations.len(), 1);
        assert_eq!(observations[0].digest, fixture.layer.digest());

        write_blob(&cache, fixture.layer.digest(), fixture.layer.bytes()).await;
        let (verified, observations) =
            identity_observations(&cache, fixture.manifest.digest()).await;
        assert_eq!(verified.phase, ImageCachePhase::Verified);
        assert_eq!(verified.total_bytes, Some(fixture.layer.size().unwrap()));
        assert_eq!(observations.len(), 1);

        // Corrupted bytes are a failure, never a verified cache hit.
        write_blob(&cache, fixture.layer.digest(), b"not the layer").await;
        let (failed, _) = identity_observations(&cache, fixture.manifest.digest()).await;
        assert_eq!(failed.phase, ImageCachePhase::Failed);
        assert!(failed.detail.unwrap().contains("failed verification"));

        // A surviving partial is resumable, not active.
        std::fs::remove_file(cache.blob_path(fixture.layer.digest()).unwrap()).unwrap();
        let partial = cache.partial_path(fixture.layer.digest()).unwrap();
        std::fs::create_dir_all(partial.parent().unwrap()).unwrap();
        std::fs::write(&partial, b"half").unwrap();
        let (resumable, _) = identity_observations(&cache, fixture.manifest.digest()).await;
        assert_eq!(resumable.phase, ImageCachePhase::Resumable);
        assert!(!resumable.active);
    }

    #[tokio::test]
    async fn prepare_requires_the_matching_explicit_intent() {
        let dir = tempfile::tempdir().unwrap();
        let cache = cache(dir.path()).await;
        let fixture = fixture(b"verified layer bytes");
        write_blob(&cache, fixture.manifest.digest(), fixture.manifest.bytes()).await;
        write_blob(&cache, fixture.layer.digest(), fixture.layer.bytes()).await;
        let grant = grant(&fixture);

        for (intent, word) in [
            (SandboxImagePrepareIntent::Resume, "resume"),
            (SandboxImagePrepareIntent::Retry, "retry"),
        ] {
            let error = prepare_grant_image(&cache, &grant, intent, "http://unused", "token")
                .await
                .expect_err("an ineligible intent is refused");
            assert!(format!("{error:#}").contains(word), "{error:#}");
        }

        let prepared = prepare_grant_image(
            &cache,
            &grant,
            SandboxImagePrepareIntent::Prepare,
            "http://unused",
            "token",
        )
        .await
        .expect("a verified identity is a no-op prepare");
        assert_eq!(prepared.observation.phase, ImageCachePhase::Verified);
        assert_eq!(prepared.observations.len(), 1);
    }

    #[tokio::test]
    async fn prepare_fetches_an_absent_manifest_closure_exactly_once() {
        let dir = tempfile::tempdir().unwrap();
        let cache = cache(dir.path()).await;
        let fixture = fixture(b"payload fetched exactly once");
        let server = Server::run();
        serve(
            &server,
            fixture.manifest.bytes(),
            fixture.manifest.digest(),
            1,
        );
        serve(&server, fixture.config.bytes(), fixture.config.digest(), 1);
        serve(&server, fixture.layer.bytes(), fixture.layer.digest(), 1);
        let grant = grant(&fixture);

        let first = prepare_grant_image(
            &cache,
            &grant,
            SandboxImagePrepareIntent::Prepare,
            &origin(&server),
            "token",
        )
        .await
        .unwrap();
        assert_eq!(first.observation.phase, ImageCachePhase::Verified);

        let second = prepare_grant_image(
            &cache,
            &grant,
            SandboxImagePrepareIntent::Prepare,
            &origin(&server),
            "token",
        )
        .await
        .unwrap();
        assert_eq!(second.observation.phase, ImageCachePhase::Verified);
    }

    #[tokio::test]
    async fn concurrent_prepares_share_one_closure_transfer() {
        let dir = tempfile::tempdir().unwrap();
        let cache = cache(dir.path()).await;
        let fixture = fixture(b"one shared transfer");
        let server = Server::run();
        serve(
            &server,
            fixture.manifest.bytes(),
            fixture.manifest.digest(),
            1,
        );
        serve(&server, fixture.config.bytes(), fixture.config.digest(), 1);
        serve(&server, fixture.layer.bytes(), fixture.layer.digest(), 1);
        let grant = grant(&fixture);

        let origin = origin(&server);
        let (left, right) = tokio::join!(
            prepare_grant_image(
                &cache,
                &grant,
                SandboxImagePrepareIntent::Prepare,
                &origin,
                "token",
            ),
            prepare_grant_image(
                &cache,
                &grant,
                SandboxImagePrepareIntent::Prepare,
                &origin,
                "token",
            )
        );
        assert_eq!(left.unwrap().observation.phase, ImageCachePhase::Verified);
        assert_eq!(right.unwrap().observation.phase, ImageCachePhase::Verified);
    }

    #[tokio::test]
    async fn retry_refetches_a_corrupt_versioned_layer() {
        let dir = tempfile::tempdir().unwrap();
        let cache = cache(dir.path()).await;
        let fixture = fixture(b"retryable layer bytes");
        let server = Server::run();
        serve(
            &server,
            fixture.manifest.bytes(),
            fixture.manifest.digest(),
            1,
        );
        serve(&server, fixture.config.bytes(), fixture.config.digest(), 1);
        serve(&server, fixture.layer.bytes(), fixture.layer.digest(), 2);
        let grant = grant(&fixture);

        prepare_grant_image(
            &cache,
            &grant,
            SandboxImagePrepareIntent::Prepare,
            &origin(&server),
            "token",
        )
        .await
        .unwrap();
        write_blob(&cache, fixture.layer.digest(), b"corrupted").await;
        let (failed, _) = identity_observations(&cache, fixture.manifest.digest()).await;
        assert_eq!(failed.phase, ImageCachePhase::Failed);

        let retried = prepare_grant_image(
            &cache,
            &grant,
            SandboxImagePrepareIntent::Retry,
            &origin(&server),
            "token",
        )
        .await
        .unwrap();
        assert_eq!(retried.observation.phase, ImageCachePhase::Verified);
        assert_eq!(
            std::fs::read(cache.blob_path(fixture.layer.digest()).unwrap()).unwrap(),
            fixture.layer.bytes()
        );
    }
}
