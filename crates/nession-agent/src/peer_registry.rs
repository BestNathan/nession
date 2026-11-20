//! Agent peer OCI source grants and Agent-to-Agent fetch wiring (#4091).
//!
//! The host-independent discovery control plane lives in
//! [`nession_erofs::cache::discovery`]; this adapter is the Agent's thin
//! Nession-specific wiring: a bounded holder of **repository-scoped peer grants**
//! ([`ScopedPeerGrants`]) that the Agent presents through the same verified
//! distribution engine the normal local-cache/Sandbox preparation path uses.
//!
//! Identity is reused from the Agent's inbound P2P token ([`crate::p2p_auth`]) and
//! the #4090 read-only Registry adapter ([`crate::registry`]): a peer grant is a
//! short-lived scoped credential bound to one source authority/repository, never
//! a global Server bearer. Possessing a digest or another Session's private image
//! confers no access — the source's repository reachability fence decides reads.
//!
//! No arbitrary inbound/public peer Registry listener is opened here: the Agent
//! only mounts the explicitly enabled read-only Registry (#4090) and otherwise
//! fetches outbound from approved candidates, failing closed to an alternate
//! authorized OCI source for the same pinned digest.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use nession_erofs::cache::discovery::{ImageSource, SourceCredentialProvider, SourceKind};

/// A bounded holder of repository-scoped peer bearer grants.
///
/// Each grant is bound to one `(origin, repository)` pair; a lookup for any other
/// source returns `None` (fail closed). The holder never stores a global Server
/// credential and never returns a peer's token for a different authority. `Debug`
/// is redacted so no token is ever exposed in a diagnostic.
#[derive(Default, Clone)]
pub struct ScopedPeerGrants {
    grants: Arc<Mutex<HashMap<(String, String), String>>>,
}

impl ScopedPeerGrants {
    /// An empty holder (no grant for any source).
    pub fn new() -> Self {
        Self::default()
    }

    /// Bind one scoped bearer grant to an exact source authority/repository.
    pub fn grant(
        &self,
        origin: impl Into<String>,
        repository: impl Into<String>,
        token: impl Into<String>,
    ) {
        self.grants
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert((origin.into(), repository.into()), token.into());
    }

    /// Revoke every grant for one source authority (for example a revoked peer).
    pub fn revoke_origin(&self, origin: &str) {
        self.grants
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|(source_origin, _), _| source_origin != origin);
    }
}

impl SourceCredentialProvider for ScopedPeerGrants {
    fn grant_token(&self, origin: &str, repository: &str) -> Option<String> {
        self.grants
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&(origin.to_string(), repository.to_string()))
            .cloned()
    }
}

impl fmt::Debug for ScopedPeerGrants {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let count = self.grants.lock().map(|grants| grants.len()).unwrap_or(0);
        formatter
            .debug_struct("ScopedPeerGrants")
            .field("grants", &count)
            .field("tokens", &"<redacted>")
            .finish()
    }
}

/// Build one approved peer candidate over a scoped grant holder.
pub fn peer_source(
    origin: impl Into<String>,
    repository: impl Into<String>,
    grants: Arc<ScopedPeerGrants>,
) -> anyhow::Result<ImageSource> {
    ImageSource::new(origin, repository, SourceKind::Peer, grants)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use axum::Router;
    use nession_erofs::blob::store::FsBlobStore;
    use nession_erofs::cache::discovery::{
        FetchAuthorizer, PinnedClosure, SourceFetcher, SourceKind,
    };
    use nession_erofs::cache::fetch::ImageObjectGrant;
    use nession_erofs::cache::store::CacheBlobStore;
    use nession_erofs::cache::{ErofsCache, StorageProbe};
    use nession_erofs::catalog::reference::{
        record_object, record_reference, ObjectKind, StoredObject,
    };
    use nession_erofs::catalog::tag::{set_tag, TagExpectation};
    use nession_erofs::contracts::BlobStore;
    use nession_erofs::oci::annotation::{
        MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_MANIFEST,
    };
    use nession_erofs::oci::config::{ImageConfig, RootFs, RuntimeConfig};
    use nession_erofs::oci::descriptor::Descriptor;
    use nession_erofs::oci::manifest::Manifest;
    use nession_erofs::oci::{to_bytes, RawDocument};
    use nession_protocol::TokenVerifier;
    use nession_server::image::registry::mount_registry;
    use serde_json::Map;
    use tempfile::TempDir;
    use tower::ServiceExt;

    use crate::p2p_auth::P2pAuth;
    use crate::registry::build_read_only_registry;

    const AGENT_A_TOKEN: &str = "agent-a-peer-grant";
    const SERVER_TOKEN: &str = "server-authoritative-token";

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

    async fn open_cache(identity: &str) -> (TempDir, Arc<ErofsCache>) {
        let dir = TempDir::new().unwrap();
        let cache = Arc::new(
            ErofsCache::open_with_probe(dir.path(), identity, false, &DurableProbe)
                .await
                .unwrap(),
        );
        (dir, cache)
    }

    fn seed_cache(cache: &Arc<ErofsCache>, fixture: &Fixture) {
        let blobs = CacheBlobStore::new(Arc::clone(cache));
        blobs.put_bytes(fixture.layer.bytes()).unwrap();
        blobs.put_bytes(fixture.config.bytes()).unwrap();
        blobs.put_bytes(fixture.manifest.bytes()).unwrap();
    }

    async fn serve_loopback(router: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (format!("http://{addr}"), handle)
    }

    /// Agent A: an opted-in read-only Registry over its verified cache, gated by
    /// its own P2P token. Returns the base URL, handle and the registry handle.
    async fn serve_agent_a(
        fixture: &Fixture,
    ) -> (
        TempDir,
        String,
        tokio::task::JoinHandle<()>,
        Arc<ErofsCache>,
        crate::registry::AgentReadOnlyRegistry,
    ) {
        let (dir, cache) = open_cache("agent-a").await;
        seed_cache(&cache, fixture);
        let registry =
            build_read_only_registry(Arc::clone(&cache), Arc::new(P2pAuth::new(AGENT_A_TOKEN)))
                .unwrap();
        registry
            .register_tag("team/app", "v1", fixture.manifest.digest())
            .unwrap();
        let (base, handle) = serve_loopback(registry.router()).await;
        (dir, base, handle, cache, registry)
    }

    /// The Server: an authoritative writable Registry over its own CAS/Catalog,
    /// gated by the Server Token. A middleware counts blob GETs so a peer-only
    /// fetch can prove the Server served no Blob bytes.
    async fn serve_server(
        fixture: &Fixture,
    ) -> (
        TempDir,
        String,
        tokio::task::JoinHandle<()>,
        Arc<AtomicUsize>,
    ) {
        let dir = TempDir::new().unwrap();
        let store = FsBlobStore::new(dir.path().join("cas")).unwrap();
        let conn = sea_orm::Database::connect("sqlite::memory:").await.unwrap();
        nession_erofs::catalog::migrate(&conn).await.unwrap();
        for (document, kind, media_type) in [
            (&fixture.layer, ObjectKind::Erofs, MEDIA_TYPE_EROFS),
            (&fixture.config, ObjectKind::Config, MEDIA_TYPE_CONFIG),
            (&fixture.manifest, ObjectKind::Manifest, MEDIA_TYPE_MANIFEST),
        ] {
            store.put_bytes(document.bytes()).unwrap();
            record_object(
                &conn,
                &StoredObject {
                    digest: document.digest().to_string(),
                    media_type: media_type.to_string(),
                    size_bytes: document.size().unwrap(),
                    kind,
                },
                1,
            )
            .await
            .unwrap();
        }
        record_reference(
            &conn,
            fixture.manifest.digest(),
            fixture.config.digest(),
            "config",
            1,
        )
        .await
        .unwrap();
        record_reference(
            &conn,
            fixture.manifest.digest(),
            fixture.layer.digest(),
            "layer",
            1,
        )
        .await
        .unwrap();
        set_tag(
            &conn,
            "team/app",
            "v1",
            fixture.manifest.digest(),
            &TagExpectation::Absent,
            1,
        )
        .await
        .unwrap();
        let registry = mount_registry(store, conn, TokenVerifier::new(SERVER_TOKEN)).unwrap();
        let blob_reads = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&blob_reads);
        let router = registry.router().layer(axum::middleware::from_fn(
            move |request: Request<Body>, next: axum::middleware::Next| {
                let counter = Arc::clone(&counter);
                async move {
                    if request.method() == Method::GET && request.uri().path().contains("/blobs/") {
                        counter.fetch_add(1, Ordering::SeqCst);
                    }
                    next.run(request).await
                }
            },
        ));
        let (base, handle) = serve_loopback(router).await;
        (dir, base, handle, blob_reads)
    }

    fn closure_for(fixture: &Fixture) -> PinnedClosure {
        let object = |document: &RawDocument, media_type: &str| ImageObjectGrant {
            digest: document.digest().to_string(),
            media_type: media_type.to_string(),
            size_bytes: document.size().unwrap(),
            path: String::new(),
        };
        PinnedClosure {
            manifest_digest: fixture.manifest.digest().to_string(),
            objects: vec![
                object(&fixture.manifest, MEDIA_TYPE_MANIFEST),
                object(&fixture.config, MEDIA_TYPE_CONFIG),
                object(&fixture.layer, MEDIA_TYPE_EROFS),
            ],
        }
    }

    struct AllowFetch;
    impl FetchAuthorizer for AllowFetch {
        fn authorize_fetch(
            &self,
            _manifest_digest: &str,
            _local_repository: &str,
        ) -> anyhow::Result<()> {
            Ok(())
        }
    }

    fn peer_grants(origin: &str, repository: &str) -> Arc<ScopedPeerGrants> {
        let grants = Arc::new(ScopedPeerGrants::new());
        grants.grant(origin, repository, AGENT_A_TOKEN);
        grants
    }

    fn server_source(origin: &str) -> ImageSource {
        let grants = Arc::new(ScopedPeerGrants::new());
        grants.grant(origin, "team/app", SERVER_TOKEN);
        ImageSource::new(origin, "team/app", SourceKind::Server, grants).unwrap()
    }

    async fn probe(router: &Router, method: Method, uri: &str, auth: Option<&str>) -> StatusCode {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = auth {
            builder = builder.header("authorization", token);
        }
        let response = router
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        response.status()
    }

    #[tokio::test]
    async fn sc01_two_authorized_agents_peer_fetch_server_serves_no_blob_bytes() {
        let fixture = v1_fixture(b"two agent peer fetch layer");
        let (_peer_dir, peer_base, peer_handle, _peer_cache, _peer_registry) =
            serve_agent_a(&fixture).await;
        let (_srv_dir, server_base, server_handle, server_blob_reads) =
            serve_server(&fixture).await;
        let (_dst_dir, dst_cache) = open_cache("agent-b").await;
        let closure = closure_for(&fixture);

        // The Server is the policy/discovery authority (it holds the authoritative
        // pinned closure), but Agent B fetches Blob bytes only from authorized Agent A.
        let grants = peer_grants(&peer_base, "team/app");
        let source = peer_source(&peer_base, "team/app", grants).unwrap();
        let (fetched, provenance) = SourceFetcher::new()
            .fetch_pinned(&dst_cache, &closure, &[source], &AllowFetch, "team/app")
            .await
            .unwrap();

        assert_eq!(fetched.manifest_digest, fixture.manifest.digest());
        assert_eq!(fetched.layer.digest, fixture.layer.digest());
        assert_eq!(provenance.kind, SourceKind::Peer);
        assert_eq!(provenance.origin, peer_base);
        // Normal local-cache/Sandbox preparation path: verified EROFS mount identity.
        assert_eq!(
            tokio::fs::read(&fetched.layer_path).await.unwrap(),
            fixture.layer.bytes()
        );
        // The Server served zero Blob bytes: it was policy/discovery only.
        assert_eq!(server_blob_reads.load(Ordering::SeqCst), 0);
        let _ = server_base;

        // Agent B completes the normal preparation path and mounts its own opted-in
        // read-only Registry: the fetched verified closure becomes B's authorized
        // source, so a second Agent can now pull the same pinned digest from B.
        let registry_b = build_read_only_registry(
            Arc::clone(&dst_cache),
            Arc::new(P2pAuth::new("agent-b-token")),
        )
        .unwrap();
        registry_b
            .register_tag("team/app", "v1", fixture.manifest.digest())
            .unwrap();
        let (base_b, handle_b) = serve_loopback(registry_b.router()).await;
        let grants_b = Arc::new(ScopedPeerGrants::new());
        grants_b.grant(&base_b, "team/app", "agent-b-token");
        let (_dst2_dir, dst2_cache) = open_cache("agent-c").await;
        let (from_b, provenance_b) = SourceFetcher::new()
            .fetch_pinned(
                &dst2_cache,
                &closure,
                &[peer_source(&base_b, "team/app", grants_b).unwrap()],
                &AllowFetch,
                "team/app",
            )
            .await
            .unwrap();
        assert_eq!(from_b.manifest_digest, fixture.manifest.digest());
        assert_eq!(provenance_b.kind, SourceKind::Peer);
        assert_eq!(provenance_b.origin, base_b);

        peer_handle.abort();
        server_handle.abort();
        handle_b.abort();
        println!(
            "#4091 SC-01 measured: Agent B fetched complete immutable EROFS Image (Manifest {} / \
             EROFS {}) from Agent A's read-only Registry {} into its local cache mount identity; \
             provenance=peer; Server blob GET count=0 (policy/discovery only, not Blob bytes); \
             Agent B then mounted its own read-only Registry {} and served the same pinned digest \
             to a further authorized Agent (A2A propagation)",
            fixture.manifest.digest(),
            fixture.layer.digest(),
            peer_base,
            base_b,
        );
    }

    #[tokio::test]
    async fn sc02_denied_principal_foreign_repo_forged_digest_and_no_global_credential() {
        let fixture = v1_fixture(b"identity credential isolation layer");
        let (_peer_dir, peer_base, peer_handle, _peer_cache, peer_registry) =
            serve_agent_a(&fixture).await;
        let router = peer_registry.router();
        let (_dst_dir, dst_cache) = open_cache("agent-b").await;
        let closure = closure_for(&fixture);
        let good = format!("Bearer {AGENT_A_TOKEN}");

        // Identity fails closed at the peer endpoint (SCN-04): no credential -> 401,
        // a wrong principal token -> 403.
        assert_eq!(
            probe(&router, Method::GET, "/v2/", None).await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            probe(
                &router,
                Method::GET,
                "/v2/",
                Some("Bearer denied-principal")
            )
            .await,
            StatusCode::FORBIDDEN
        );

        // No global Server credential is reused: the Server Token is distinct and
        // is denied by Agent A's own P2P identity.
        assert_eq!(
            probe(
                &router,
                Method::GET,
                "/v2/",
                Some(&format!("Bearer {SERVER_TOKEN}"))
            )
            .await,
            StatusCode::FORBIDDEN
        );

        // A denied principal cannot fetch through the discovery path either.
        let denied_grants = Arc::new(ScopedPeerGrants::new());
        denied_grants.grant(&peer_base, "team/app", "denied-principal");
        let denied_source = peer_source(&peer_base, "team/app", denied_grants).unwrap();
        let error = SourceFetcher::new()
            .fetch_pinned(
                &dst_cache,
                &closure,
                &[denied_source],
                &AllowFetch,
                "team/app",
            )
            .await
            .expect_err("denied principal");
        assert!(error.to_string().contains("no authorized source"));

        // Repository B cannot read Agent A's private Manifest/Blob even with a valid
        // peer token: a foreign repository is invisible (possession != authorization).
        assert_eq!(
            probe(
                &router,
                Method::GET,
                &format!("/v2/other/app/blobs/{}", fixture.layer.digest()),
                Some(&good),
            )
            .await,
            StatusCode::NOT_FOUND
        );
        let foreign_grants = peer_grants(&peer_base, "other/app");
        let foreign_source = peer_source(&peer_base, "other/app", foreign_grants).unwrap();
        let error = SourceFetcher::new()
            .fetch_pinned(
                &dst_cache,
                &closure,
                &[foreign_source],
                &AllowFetch,
                "team/app",
            )
            .await
            .expect_err("foreign repository");
        assert!(error.to_string().contains("no authorized source"));

        // A forged Manifest digest (a different revision) is not served by Agent A.
        let mut forged = closure_for(&fixture);
        forged.manifest_digest = "sha256:".to_string() + &"cd".repeat(32);
        // Re-point the Manifest object digest so the closure validates, but the
        // forged digest is not one Agent A exposes.
        forged.objects[0].digest = forged.manifest_digest.clone();
        let error = SourceFetcher::new()
            .fetch_pinned(
                &dst_cache,
                &forged,
                &[
                    peer_source(&peer_base, "team/app", peer_grants(&peer_base, "team/app"))
                        .unwrap(),
                ],
                &AllowFetch,
                "team/app",
            )
            .await
            .expect_err("forged digest");
        assert!(error.to_string().contains("no authorized source"));

        // A forged endpoint (unreachable authority) fails closed.
        let forged_endpoint = peer_source("http://127.0.0.1:1", "team/app", {
            let grants = Arc::new(ScopedPeerGrants::new());
            grants.grant("http://127.0.0.1:1", "team/app", AGENT_A_TOKEN);
            grants
        })
        .unwrap();
        let error = SourceFetcher::new()
            .fetch_pinned(
                &dst_cache,
                &closure,
                &[forged_endpoint],
                &AllowFetch,
                "team/app",
            )
            .await
            .expect_err("forged endpoint");
        assert!(error.to_string().contains("no authorized source"));

        // Valid Repository A access works with the repository-scoped peer grant.
        let (fetched, provenance) = SourceFetcher::new()
            .fetch_pinned(
                &dst_cache,
                &closure,
                &[
                    peer_source(&peer_base, "team/app", peer_grants(&peer_base, "team/app"))
                        .unwrap(),
                ],
                &AllowFetch,
                "team/app",
            )
            .await
            .unwrap();
        assert_eq!(fetched.manifest_digest, fixture.manifest.digest());
        assert_eq!(provenance.repository, "team/app");
        assert_eq!(
            probe(
                &router,
                Method::GET,
                "/v2/team/app/manifests/v1",
                Some(&good)
            )
            .await,
            StatusCode::OK
        );

        peer_handle.abort();
        println!(
            "#4091 SC-02 measured: Agent A no-cred->401 wrong-principal->403; Server Token {} \
             denied by Agent A (no global credential reuse); denied principal/foreign Repository \
             B/forged digest/forged endpoint all fail closed; valid Repository A fetched pinned \
             Manifest {} with a repository-scoped peer grant",
            SERVER_TOKEN,
            fixture.manifest.digest(),
        );
    }

    #[tokio::test]
    async fn sc03_peer_failure_falls_back_to_authorized_server_same_pinned_digest() {
        let fixture = v1_fixture(b"two agent resilient fallback layer");
        let (_peer_dir, peer_base, peer_handle, _peer_cache, peer_registry) =
            serve_agent_a(&fixture).await;
        let (_srv_dir, server_base, server_handle, server_blob_reads) =
            serve_server(&fixture).await;
        let (_dst_dir, dst_cache) = open_cache("agent-b").await;
        let closure = closure_for(&fixture);

        // Revoke Agent A's repository projection: the peer can no longer serve the
        // private closure, so Agent B must fall back to the authorized Server.
        peer_registry.unregister_repository("team/app").unwrap();

        let peer =
            peer_source(&peer_base, "team/app", peer_grants(&peer_base, "team/app")).unwrap();
        let server = server_source(&server_base);
        let (fetched, provenance) = SourceFetcher::new()
            .fetch_pinned(
                &dst_cache,
                &closure,
                &[peer, server],
                &AllowFetch,
                "team/app",
            )
            .await
            .unwrap();

        assert_eq!(fetched.manifest_digest, fixture.manifest.digest());
        assert_eq!(fetched.layer.digest, fixture.layer.digest());
        assert_eq!(provenance.kind, SourceKind::Server);
        assert_eq!(provenance.origin, server_base);
        // Complete verified CAS state: the EROFS payload is Ready with exact bytes.
        assert_eq!(
            tokio::fs::read(&fetched.layer_path).await.unwrap(),
            fixture.layer.bytes()
        );
        let blobs = CacheBlobStore::new(Arc::clone(&dst_cache));
        assert!(blobs
            .verify_named_size(fixture.layer.digest(), fixture.layer.size().unwrap())
            .is_ok());
        assert!(blobs.contains(fixture.manifest.digest()).unwrap());
        // The Server served Blob bytes only on the authorized fallback.
        assert!(server_blob_reads.load(Ordering::SeqCst) > 0);

        peer_handle.abort();
        server_handle.abort();
        println!(
            "#4091 SC-03 measured: revoked peer Agent A {} fell back to authorized Server {} for \
             the SAME pinned Manifest {}; complete verified CAS (EROFS {} Ready, exact bytes); \
             provenance=server; no partial bytes consumed; Server blob GETs={}",
            peer_base,
            server_base,
            fixture.manifest.digest(),
            fixture.layer.digest(),
            server_blob_reads.load(Ordering::SeqCst),
        );
    }
}
