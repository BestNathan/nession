//! Agent host adapter for the shared OCI Registry service (#4090).
//!
//! The Agent may mount the common [`RegistryService`] (#4088) as an **explicitly
//! enabled read-only** capability on its own HTTP ingress, backed by its verified
//! cache ([`CacheBlobStore`]) and local reference/reachability projection
//! ([`CacheRepositoryStore`]). It compiles no external registry client and no
//! credential provider: the `registry-service` feature is deliberately
//! independent of the Server-owned `registry` client feature, so an Agent build
//! never carries upstream registry secrets.
//!
//! Authority is constrained to the local authorized Repository/Manifest closure.
//! [`CacheRepositoryStore`] exposes no reference until one is registered against
//! a verified Manifest, so the private local CAS is never advertised by default;
//! possessing a digest is never authorization. Mutation verbs are denied by the
//! read-only service mode (the one owner of that refusal), regardless of
//! credential.
//!
//! Disabling the capability removes external Registry visibility (the router is
//! simply not mounted) without touching the durable cache, its pins or active
//! Session mounts: those belong to [`ErofsCache`] and the Sandbox runtime, not to
//! this adapter.

use std::sync::Arc;

use anyhow::Result;
use axum::Router;

use nession_erofs::cache::repository::CacheRepositoryStore;
use nession_erofs::cache::store::CacheBlobStore;
use nession_erofs::cache::ErofsCache;
use nession_erofs::registry::service::{
    Authorization, NoPublisher, RegistryAction, RegistryAuthorizer, RegistryService,
};

use crate::p2p_auth::P2pAuth;

/// The concrete Agent Registry service: a pull-only `/v2/` endpoint over the
/// Agent's verified cache and local reachability projection.
pub type AgentRegistry =
    RegistryService<CacheBlobStore, CacheRepositoryStore, AgentRegistryAuthorizer, NoPublisher>;

/// The Agent's identity adapter for the mounted read-only Registry (#4090).
///
/// It honours the Agent's own inbound token ([`P2pAuth`]): an empty token keeps
/// the documented no-auth mode; a configured token must be presented as a
/// `Bearer` credential and verified in constant time. Repository-scope
/// reachability is the [`CacheRepositoryStore`]'s job, not this adapter's.
///
/// The adapter owns identity only; it fails closed — a missing credential is a
/// 401 challenge and a known-but-invalid credential is 403. Mutation denial is
/// deliberately NOT duplicated here: the read-only [`RegistryService`] mode is
/// the one owner that refuses every mutation verb with 405 regardless of
/// credential, so even a valid push credential cannot publish through an Agent.
#[derive(Clone)]
pub struct AgentRegistryAuthorizer {
    auth: Arc<P2pAuth>,
}

impl AgentRegistryAuthorizer {
    pub fn new(auth: Arc<P2pAuth>) -> Self {
        Self { auth }
    }
}

#[async_trait::async_trait]
impl RegistryAuthorizer for AgentRegistryAuthorizer {
    async fn authorize(
        &self,
        credential: Option<&str>,
        _repository: &str,
        _action: RegistryAction,
    ) -> Authorization {
        if !self.auth.is_enabled() {
            return Authorization::Allowed;
        }
        let Some(token) = credential.and_then(bearer_token) else {
            return Authorization::Unauthorized {
                challenge: "Bearer".to_string(),
            };
        };
        if self.auth.verify(token) {
            Authorization::Allowed
        } else {
            Authorization::Denied
        }
    }
}

/// Extract the token from an exact `Authorization` header value (Bearer only).
fn bearer_token(credential: &str) -> Option<&str> {
    let value = credential.trim();
    value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
        .map(str::trim)
        .filter(|token| !token.is_empty())
}

/// The opt-in Agent read-only Registry capability handle.
///
/// Holds the mounted service together with the reachability projection the
/// Agent's preparation path registers authorized tags against. The cache itself
/// is owned elsewhere; this handle only projects verified objects it is told to
/// expose, and dropping it (disabling the capability) destroys no cache state.
pub struct AgentReadOnlyRegistry {
    service: Arc<AgentRegistry>,
    repositories: Arc<CacheRepositoryStore>,
}

impl AgentReadOnlyRegistry {
    /// The `/v2/` router to merge into the Agent ingress when enabled.
    pub fn router(&self) -> Router {
        self.service.router()
    }

    /// Register one authorized repository Tag against a verified Manifest.
    ///
    /// The Manifest bytes must already be verified in the cache; registration
    /// never invents reachability for absent or corrupt objects. This is the
    /// seam the Image preparation path uses to expose an authorized closure.
    pub fn register_tag(&self, repository: &str, tag: &str, manifest_digest: &str) -> Result<()> {
        self.repositories
            .register_tag(repository, tag, manifest_digest)
    }

    /// Drop one repository's projection (for example when its grant revokes).
    /// The underlying verified cache objects and pins are untouched.
    pub fn unregister_repository(&self, repository: &str) -> Result<bool> {
        self.repositories.unregister_repository(repository)
    }
}

/// Build the opt-in read-only Registry over an opened verified cache.
///
/// The projection starts empty: nothing is advertised until the preparation path
/// registers an authorized tag, so enabling the capability never exposes the
/// private local CAS by default.
pub fn build_read_only_registry(
    cache: Arc<ErofsCache>,
    auth: Arc<P2pAuth>,
) -> Result<AgentReadOnlyRegistry> {
    let repositories = Arc::new(CacheRepositoryStore::new(Arc::clone(&cache)));
    let blobs = Arc::new(CacheBlobStore::new(cache));
    let authorizer = Arc::new(AgentRegistryAuthorizer::new(auth));
    let service = Arc::new(RegistryService::read_only(
        blobs,
        Arc::clone(&repositories),
        authorizer,
    )?);
    Ok(AgentReadOnlyRegistry {
        service,
        repositories,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{HeaderMap, Method, Request, StatusCode};
    use http_body_util::BodyExt;
    use nession_erofs::cache::StorageProbe;
    use nession_erofs::contracts::BlobStore;
    use nession_erofs::oci::annotation::{
        MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_MANIFEST,
    };
    use nession_erofs::oci::config::{ImageConfig, RootFs, RuntimeConfig};
    use nession_erofs::oci::descriptor::Descriptor;
    use nession_erofs::oci::manifest::Manifest;
    use nession_erofs::oci::{to_bytes, RawDocument};
    use serde_json::Map;
    use tempfile::TempDir;
    use tower::ServiceExt;

    const TOKEN: &str = "agent-registry-token";

    struct DurableProbe;
    impl StorageProbe for DurableProbe {
        fn mount_type(&self, _path: &std::path::Path) -> anyhow::Result<String> {
            Ok("nfs".to_string())
        }
    }

    fn descriptor(media_type: &str, document: &RawDocument) -> Descriptor {
        Descriptor {
            media_type: media_type.to_string(),
            digest: document.digest().to_string(),
            size: document.size().unwrap(),
            urls: None,
            annotations: None,
            platform: None,
            artifact_type: None,
            data: None,
            extra: Map::new(),
        }
    }

    struct Fixture {
        manifest: RawDocument,
        config: RawDocument,
        layer: RawDocument,
    }

    fn v1_fixture(payload: &[u8]) -> Fixture {
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
            media_type: Some(MEDIA_TYPE_MANIFEST.to_string()),
            config: descriptor(MEDIA_TYPE_CONFIG, &config),
            layers: vec![descriptor(MEDIA_TYPE_EROFS, &layer)],
            subject: None,
            artifact_type: None,
            annotations: None,
            extra: Map::new(),
        };
        let manifest = RawDocument::from_bytes(to_bytes(&manifest).unwrap());
        Fixture {
            manifest,
            config,
            layer,
        }
    }

    async fn agent_cache() -> (TempDir, Arc<ErofsCache>) {
        let dir = TempDir::new().unwrap();
        let cache = Arc::new(
            ErofsCache::open_with_probe(dir.path(), "agent-registry", false, &DurableProbe)
                .await
                .unwrap(),
        );
        (dir, cache)
    }

    async fn send(
        router: &Router,
        method: Method,
        uri: &str,
        auth: Option<&str>,
        body: Vec<u8>,
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = auth {
            builder = builder.header("authorization", token);
        }
        let request = builder.body(Body::from(body)).unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, headers, bytes.to_vec())
    }

    #[tokio::test]
    async fn sc03_agent_readonly_serves_only_registered_verified_closure() {
        let (_dir, cache) = agent_cache().await;
        let registry =
            build_read_only_registry(Arc::clone(&cache), Arc::new(P2pAuth::new(TOKEN))).unwrap();
        let router = registry.router();
        let good = format!("Bearer {TOKEN}");

        // Nothing is advertised by default: the private CAS is not exposed even
        // though verified bytes will land in it.
        let fixture = v1_fixture(b"agent readonly closure layer");
        let blobs = CacheBlobStore::new(Arc::clone(&cache));
        blobs.put_bytes(fixture.layer.bytes()).unwrap();
        blobs.put_bytes(fixture.config.bytes()).unwrap();
        blobs.put_bytes(fixture.manifest.bytes()).unwrap();

        // Before registration the repository exposes no reference.
        let (status, _, _) = send(
            &router,
            Method::GET,
            "/v2/team/app/manifests/v1",
            Some(&good),
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // Register the authorized tag against the verified Manifest.
        registry
            .register_tag("team/app", "v1", fixture.manifest.digest())
            .unwrap();

        // Identity fails closed.
        let (status, _, _) = send(&router, Method::GET, "/v2/", None, Vec::new()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _, _) = send(
            &router,
            Method::GET,
            "/v2/",
            Some("Bearer wrong"),
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        // The registered verified closure is served by tag and by digest.
        let (status, _, body) = send(
            &router,
            Method::GET,
            "/v2/team/app/manifests/v1",
            Some(&good),
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, fixture.manifest.bytes());
        let (status, _, body) = send(
            &router,
            Method::GET,
            &format!("/v2/team/app/blobs/{}", fixture.layer.digest()),
            Some(&good),
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, fixture.layer.bytes());

        // A foreign repository cannot read the same digest (possession is not
        // authorization), and an unregistered repository is invisible.
        let (status, _, _) = send(
            &router,
            Method::GET,
            &format!("/v2/other/app/blobs/{}", fixture.layer.digest()),
            Some(&good),
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        println!(
            "#4090 SC-03 measured: Agent read-only /v2/ unregistered->404; after register_tag \
             manifest v1 -> 200 ({} bytes) and EROFS blob -> 200 exact bytes; no-cred->401 \
             bad-token->403; foreign repository blob -> 404",
            fixture.manifest.bytes().len(),
        );
    }

    #[tokio::test]
    async fn sc03_agent_readonly_denies_every_mutation_verb() {
        let (_dir, cache) = agent_cache().await;
        let registry =
            build_read_only_registry(Arc::clone(&cache), Arc::new(P2pAuth::new(TOKEN))).unwrap();
        let router = registry.router();
        let good = format!("Bearer {TOKEN}");
        let fixture = v1_fixture(b"mutation denial layer");
        let blobs = CacheBlobStore::new(Arc::clone(&cache));
        blobs.put_bytes(fixture.layer.bytes()).unwrap();
        blobs.put_bytes(fixture.config.bytes()).unwrap();
        blobs.put_bytes(fixture.manifest.bytes()).unwrap();
        registry
            .register_tag("team/app", "v1", fixture.manifest.digest())
            .unwrap();

        // Every mutation verb is refused even with a valid credential.
        let (status, _, _) = send(
            &router,
            Method::POST,
            "/v2/team/app/blobs/uploads/",
            Some(&good),
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        let (status, _, _) = send(
            &router,
            Method::PUT,
            "/v2/team/app/manifests/v2",
            Some(&good),
            fixture.manifest.bytes().to_vec(),
        )
        .await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        let (status, _, _) = send(
            &router,
            Method::DELETE,
            "/v2/team/app/manifests/v1",
            Some(&good),
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);

        // The pull surface still works after the denied mutations.
        let (status, _, _) = send(
            &router,
            Method::GET,
            "/v2/team/app/manifests/v1",
            Some(&good),
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        println!(
            "#4090 SC-03 measured: Agent read-only POST uploads/PUT manifest/DELETE manifest all \
             -> 405 with a valid credential; GET manifest v1 still -> 200"
        );
    }

    #[tokio::test]
    async fn sc03_disabling_removes_visibility_without_destroying_cache() {
        let (_dir, cache) = agent_cache().await;
        let fixture = v1_fixture(b"disable preserves cache layer");
        let blobs = CacheBlobStore::new(Arc::clone(&cache));
        blobs.put_bytes(fixture.layer.bytes()).unwrap();
        blobs.put_bytes(fixture.config.bytes()).unwrap();
        blobs.put_bytes(fixture.manifest.bytes()).unwrap();

        let registry =
            build_read_only_registry(Arc::clone(&cache), Arc::new(P2pAuth::new(TOKEN))).unwrap();
        registry
            .register_tag("team/app", "v1", fixture.manifest.digest())
            .unwrap();
        let router = registry.router();
        let good = format!("Bearer {TOKEN}");
        let (status, _, _) = send(
            &router,
            Method::GET,
            "/v2/team/app/manifests/v1",
            Some(&good),
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        // Disabling the capability = dropping the handle and not mounting its
        // router. The durable cache and its verified objects survive intact.
        drop(registry);
        assert!(blobs.contains(fixture.manifest.digest()).unwrap());
        assert!(blobs.contains(fixture.layer.digest()).unwrap());
        assert_eq!(
            blobs.read(fixture.layer.digest()).unwrap(),
            fixture.layer.bytes()
        );

        // A fresh projection over the same cache starts empty again: disabling
        // removed external visibility, and re-enabling exposes nothing until an
        // authorized tag is re-registered. The cache bytes were never destroyed.
        let reenabling =
            build_read_only_registry(Arc::clone(&cache), Arc::new(P2pAuth::new(TOKEN))).unwrap();
        let router2 = reenabling.router();
        let (status, _, _) = send(
            &router2,
            Method::GET,
            "/v2/team/app/manifests/v1",
            Some(&good),
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(blobs.contains(fixture.layer.digest()).unwrap());

        println!(
            "#4090 SC-03 measured: disabling the Agent Registry removes /v2/ visibility; the \
             verified cache layer {} and manifest remain readable; re-enabling starts with an \
             empty projection (404) without destroying cache state",
            fixture.layer.digest(),
        );
    }
}
