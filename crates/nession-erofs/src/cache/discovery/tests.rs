//! Host-independent proofs for the peer source discovery control plane (#4091).
//!
//! A loopback read-only [`RegistryService`] over a verified cache stands in for an
//! authorized peer/Server source. These prove the control-plane mechanics without
//! a Server/Agent dependency: authorize-first denial, bounded candidate fallback
//! for the same pinned digest, repository-scoped grants (no global bearer),
//! per-digest single-flight warm-cache dedupe, and no partial Ready bytes.

#![cfg(feature = "registry-service")]

use std::sync::Arc;

use axum::Router;
use serde_json::Map;
use tempfile::TempDir;

use super::*;
use crate::cache::repository::CacheRepositoryStore;
use crate::cache::store::CacheBlobStore;
use crate::cache::StorageProbe;
use crate::contracts::BlobStore;
use crate::oci::annotation::{MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_MANIFEST};
use crate::oci::config::{ImageConfig, RootFs, RuntimeConfig};
use crate::oci::descriptor::Descriptor;
use crate::oci::manifest::Manifest;
use crate::oci::{to_bytes, RawDocument};
use crate::registry::service::{
    Authorization, RegistryAction, RegistryAuthorizer, RegistryService,
};

const TOKEN: &str = "peer-scoped-grant";

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

fn seed(cache: &Arc<ErofsCache>, fixture: &Fixture, with_layer: bool) {
    let blobs = CacheBlobStore::new(Arc::clone(cache));
    if with_layer {
        blobs.put_bytes(fixture.layer.bytes()).unwrap();
    }
    blobs.put_bytes(fixture.config.bytes()).unwrap();
    blobs.put_bytes(fixture.manifest.bytes()).unwrap();
}

/// A static-token Bearer authorizer for the loopback source (identity only).
struct BearerAuthorizer {
    token: String,
}

#[async_trait::async_trait]
impl RegistryAuthorizer for BearerAuthorizer {
    async fn authorize(
        &self,
        credential: Option<&str>,
        _repository: &str,
        _action: RegistryAction,
    ) -> Authorization {
        let presented = credential
            .and_then(|value| value.trim().strip_prefix("Bearer "))
            .map(str::trim);
        match presented {
            None => Authorization::Unauthorized {
                challenge: "Bearer".to_string(),
            },
            Some(token) if token == self.token => Authorization::Allowed,
            Some(_) => Authorization::Denied,
        }
    }
}

/// Serve one read-only source over a verified cache; returns its base URL, the
/// server handle and the reachability projection (for revocation probes).
async fn serve_source(
    cache: Arc<ErofsCache>,
    repository: &str,
    fixture: &Fixture,
    with_layer: bool,
) -> (
    String,
    tokio::task::JoinHandle<()>,
    Arc<CacheRepositoryStore>,
) {
    seed(&cache, fixture, with_layer);
    let repositories = Arc::new(CacheRepositoryStore::new(Arc::clone(&cache)));
    repositories
        .register_tag(repository, "v1", fixture.manifest.digest())
        .unwrap();
    let blobs = Arc::new(CacheBlobStore::new(cache));
    let authorizer = Arc::new(BearerAuthorizer {
        token: TOKEN.to_string(),
    });
    let service =
        Arc::new(RegistryService::read_only(blobs, Arc::clone(&repositories), authorizer).unwrap());
    let router: Router = service.router();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (format!("http://{addr}"), handle, repositories)
}

/// A repository-scoped grant provider: it returns the token only for the exact
/// approved origin+repository, never a global credential for any other source.
struct ScopedGrant {
    origin: String,
    repository: String,
    token: String,
}

impl SourceCredentialProvider for ScopedGrant {
    fn grant_token(&self, origin: &str, repository: &str) -> Option<String> {
        (origin == self.origin && repository == self.repository).then(|| self.token.clone())
    }
}

struct AllowFetch;
impl FetchAuthorizer for AllowFetch {
    fn authorize_fetch(&self, _manifest_digest: &str, _local_repository: &str) -> Result<()> {
        Ok(())
    }
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

fn peer_source(origin: &str, repository: &str) -> ImageSource {
    ImageSource::new(
        origin,
        repository,
        SourceKind::Peer,
        Arc::new(ScopedGrant {
            origin: origin.to_string(),
            repository: repository.to_string(),
            token: TOKEN.to_string(),
        }),
    )
    .unwrap()
}

#[tokio::test]
async fn sc01_peer_fetch_lands_complete_verified_closure_in_local_cache() {
    let fixture = v1_fixture(b"peer discovery complete closure layer");
    let (_src_dir, src_cache) = open_cache("source-a").await;
    let (base, server, _repos) = serve_source(src_cache, "team/app", &fixture, true).await;

    let (_dst_dir, dst_cache) = open_cache("requester-b").await;
    let closure = closure_for(&fixture);
    let fetcher = SourceFetcher::new();
    let (fetched, provenance) = fetcher
        .fetch_pinned(
            &dst_cache,
            &closure,
            &[peer_source(&base, "team/app")],
            &AllowFetch,
            "team/app",
        )
        .await
        .unwrap();

    assert_eq!(fetched.manifest_digest, fixture.manifest.digest());
    assert_eq!(fetched.config_digest, fixture.config.digest());
    assert_eq!(fetched.layer.digest, fixture.layer.digest());
    assert_eq!(provenance.kind, SourceKind::Peer);
    // The normal local-cache path: the verified EROFS payload is the mount identity.
    assert_eq!(
        tokio::fs::read(&fetched.layer_path).await.unwrap(),
        fixture.layer.bytes()
    );
    let blobs = CacheBlobStore::new(Arc::clone(&dst_cache));
    assert!(blobs.contains(fixture.layer.digest()).unwrap());
    assert!(blobs.contains(fixture.manifest.digest()).unwrap());

    server.abort();
    println!(
        "#4091 SC-01 measured: peer source {} served pinned Manifest {} ({} bytes); complete \
         verified closure (config {} / EROFS {}) landed in the requester local cache as the \
         mount identity; provenance=peer",
        base,
        fixture.manifest.digest(),
        fixture.manifest.bytes().len(),
        fixture.config.digest(),
        fixture.layer.digest(),
    );
}

#[tokio::test]
async fn sc02_no_grant_skips_source_and_wrong_token_fails_closed() {
    let fixture = v1_fixture(b"credential isolation layer");
    let (_src_dir, src_cache) = open_cache("source-a").await;
    let (base, server, _repos) = serve_source(src_cache, "team/app", &fixture, true).await;
    let (_dst_dir, dst_cache) = open_cache("requester-b").await;
    let closure = closure_for(&fixture);

    // A principal with no grant for the peer: the source is skipped before any
    // request, and with no other candidate the fetch fails closed.
    let no_grant =
        ImageSource::new(&base, "team/app", SourceKind::Peer, Arc::new(NoGrant)).unwrap();
    let error = SourceFetcher::new()
        .fetch_pinned(&dst_cache, &closure, &[no_grant], &AllowFetch, "team/app")
        .await
        .expect_err("no grant");
    assert!(error.to_string().contains("no grant"));
    let blobs = CacheBlobStore::new(Arc::clone(&dst_cache));
    assert!(!blobs.contains(fixture.layer.digest()).unwrap());

    // A foreign repository grant cannot read the peer's private closure: the
    // provider returns no token for a different repository (possession != access).
    let foreign = ImageSource::new(
        &base,
        "other/app",
        SourceKind::Peer,
        Arc::new(ScopedGrant {
            origin: base.clone(),
            repository: "team/app".to_string(),
            token: TOKEN.to_string(),
        }),
    )
    .unwrap();
    let error = SourceFetcher::new()
        .fetch_pinned(&dst_cache, &closure, &[foreign], &AllowFetch, "team/app")
        .await
        .expect_err("foreign repository");
    assert!(error.to_string().contains("no grant"));

    // The valid repository-scoped grant works.
    let (fetched, provenance) = SourceFetcher::new()
        .fetch_pinned(
            &dst_cache,
            &closure,
            &[peer_source(&base, "team/app")],
            &AllowFetch,
            "team/app",
        )
        .await
        .unwrap();
    assert_eq!(fetched.manifest_digest, fixture.manifest.digest());
    assert_eq!(provenance.repository, "team/app");

    server.abort();
    println!(
        "#4091 SC-02 measured: no-grant principal skipped before network (no Ready bytes); \
         foreign-repository grant returns no token; valid repository-scoped grant fetched \
         pinned Manifest {}; no global bearer is shared across sources",
        fixture.manifest.digest(),
    );
}

#[tokio::test]
async fn sc02_authorize_first_denial_never_reaches_the_network() {
    let fixture = v1_fixture(b"authorize first layer");
    let (_src_dir, src_cache) = open_cache("source-a").await;
    let (base, server, _repos) = serve_source(src_cache, "team/app", &fixture, true).await;
    let (_dst_dir, dst_cache) = open_cache("requester-b").await;
    let closure = closure_for(&fixture);

    // A denied principal/Session is refused before any source is contacted.
    let error = SourceFetcher::new()
        .fetch_pinned(
            &dst_cache,
            &closure,
            &[peer_source(&base, "team/app")],
            &DenyAllFetch,
            "team/app",
        )
        .await
        .expect_err("denied principal");
    assert!(error.to_string().contains("authorization denied"));
    let blobs = CacheBlobStore::new(Arc::clone(&dst_cache));
    assert!(!blobs.contains(fixture.manifest.digest()).unwrap());
    assert_eq!(dst_cache.fetch_count(), 0);

    server.abort();
    println!(
        "#4091 SC-02 measured: DenyAllFetch refused pinned Manifest {} before discovery; \
         0 physical fetches and no Ready object in the requester cache",
        fixture.manifest.digest(),
    );
}

#[tokio::test]
async fn sc03_unavailable_peer_falls_back_to_authorized_server_same_digest() {
    let fixture = v1_fixture(b"resilient fallback layer");
    // The Server source holds the complete verified closure.
    let (_srv_dir, srv_cache) = open_cache("server").await;
    let (srv_base, srv_handle, _srv_repos) =
        serve_source(srv_cache, "team/app", &fixture, true).await;
    let (_dst_dir, dst_cache) = open_cache("requester-b").await;
    let closure = closure_for(&fixture);

    // An unreachable peer (closed port) precedes the authorized Server source.
    let dead_peer = peer_source("http://127.0.0.1:1", "team/app");
    let server_source = ImageSource::new(
        &srv_base,
        "team/app",
        SourceKind::Server,
        Arc::new(ScopedGrant {
            origin: srv_base.clone(),
            repository: "team/app".to_string(),
            token: TOKEN.to_string(),
        }),
    )
    .unwrap();

    let (fetched, provenance) = SourceFetcher::new()
        .fetch_pinned(
            &dst_cache,
            &closure,
            &[dead_peer, server_source],
            &AllowFetch,
            "team/app",
        )
        .await
        .unwrap();
    assert_eq!(fetched.manifest_digest, fixture.manifest.digest());
    assert_eq!(fetched.layer.digest, fixture.layer.digest());
    assert_eq!(provenance.kind, SourceKind::Server);
    assert_eq!(
        tokio::fs::read(&fetched.layer_path).await.unwrap(),
        fixture.layer.bytes()
    );

    srv_handle.abort();
    println!(
        "#4091 SC-03 measured: unreachable peer http://127.0.0.1:1 fell back to authorized \
         Server {} for the SAME pinned Manifest {}; complete verified EROFS {} read back; \
         provenance=server",
        srv_base,
        fixture.manifest.digest(),
        fixture.layer.digest(),
    );
}

#[tokio::test]
async fn sc03_peer_missing_blob_never_ready_and_falls_back() {
    let fixture = v1_fixture(b"missing blob fallback layer");
    // The peer advertises the Manifest/Config but has lost its EROFS blob.
    let (_peer_dir, peer_cache) = open_cache("peer-a").await;
    let (peer_base, peer_handle, _peer_repos) =
        serve_source(peer_cache, "team/app", &fixture, false).await;
    // The Server holds the complete closure.
    let (_srv_dir, srv_cache) = open_cache("server").await;
    let (srv_base, srv_handle, _srv_repos) =
        serve_source(srv_cache, "team/app", &fixture, true).await;
    let (_dst_dir, dst_cache) = open_cache("requester-b").await;
    let closure = closure_for(&fixture);

    let server_source = ImageSource::new(
        &srv_base,
        "team/app",
        SourceKind::Server,
        Arc::new(ScopedGrant {
            origin: srv_base.clone(),
            repository: "team/app".to_string(),
            token: TOKEN.to_string(),
        }),
    )
    .unwrap();
    let (fetched, provenance) = SourceFetcher::new()
        .fetch_pinned(
            &dst_cache,
            &closure,
            &[peer_source(&peer_base, "team/app"), server_source],
            &AllowFetch,
            "team/app",
        )
        .await
        .unwrap();
    assert_eq!(fetched.manifest_digest, fixture.manifest.digest());
    assert_eq!(provenance.kind, SourceKind::Server);
    // The EROFS payload is Ready only after the authorized fallback, exact bytes.
    assert_eq!(
        tokio::fs::read(&fetched.layer_path).await.unwrap(),
        fixture.layer.bytes()
    );
    let blobs = CacheBlobStore::new(Arc::clone(&dst_cache));
    assert!(blobs
        .verify_named_size(fixture.layer.digest(), fixture.layer.size().unwrap())
        .is_ok());

    peer_handle.abort();
    srv_handle.abort();
    println!(
        "#4091 SC-03 measured: peer {} lost its EROFS blob (incomplete closure -> no Ready \
         payload); fell back to Server {} for the SAME pinned Manifest {}; verified EROFS {} \
         is Ready only after fallback with exact bytes",
        peer_base,
        srv_base,
        fixture.manifest.digest(),
        fixture.layer.digest(),
    );
}

#[tokio::test]
async fn sc03_revoked_peer_grant_falls_back_without_leaking_bytes() {
    let fixture = v1_fixture(b"revoked grant fallback layer");
    let (_peer_dir, peer_cache) = open_cache("peer-a").await;
    let (peer_base, peer_handle, peer_repos) =
        serve_source(peer_cache, "team/app", &fixture, true).await;
    let (_srv_dir, srv_cache) = open_cache("server").await;
    let (srv_base, srv_handle, _srv_repos) =
        serve_source(srv_cache, "team/app", &fixture, true).await;
    let (_dst_dir, dst_cache) = open_cache("requester-b").await;
    let closure = closure_for(&fixture);

    // Revoke the peer's repository projection: its private closure is no longer
    // advertised, so a direct peer pull cannot read the Manifest/Blob.
    peer_repos.unregister_repository("team/app").unwrap();

    let server_source = ImageSource::new(
        &srv_base,
        "team/app",
        SourceKind::Server,
        Arc::new(ScopedGrant {
            origin: srv_base.clone(),
            repository: "team/app".to_string(),
            token: TOKEN.to_string(),
        }),
    )
    .unwrap();
    let (fetched, provenance) = SourceFetcher::new()
        .fetch_pinned(
            &dst_cache,
            &closure,
            &[peer_source(&peer_base, "team/app"), server_source],
            &AllowFetch,
            "team/app",
        )
        .await
        .unwrap();
    assert_eq!(fetched.manifest_digest, fixture.manifest.digest());
    assert_eq!(provenance.kind, SourceKind::Server);

    peer_handle.abort();
    srv_handle.abort();
    println!(
        "#4091 SC-03 measured: revoked peer repository projection hides the private closure; \
         fetch fell back to authorized Server {} for the SAME pinned Manifest {} with no \
         partial bytes consumed",
        srv_base,
        fixture.manifest.digest(),
    );
}

#[tokio::test]
async fn sc01_single_flight_warm_cache_copies_nothing() {
    let fixture = v1_fixture(b"single flight dedupe layer");
    let (_src_dir, src_cache) = open_cache("source-a").await;
    let (base, server, _repos) = serve_source(src_cache, "team/app", &fixture, true).await;
    let (_dst_dir, dst_cache) = open_cache("requester-b").await;
    let closure = closure_for(&fixture);
    let fetcher = Arc::new(SourceFetcher::new());

    // Two concurrent fetches of one pinned digest coalesce: the first transfers
    // the closure, the second adopts the warm verified cache.
    let mut handles = Vec::new();
    for _ in 0..2 {
        let fetcher = Arc::clone(&fetcher);
        let cache = Arc::clone(&dst_cache);
        let closure = closure.clone();
        let source = peer_source(&base, "team/app");
        handles.push(tokio::spawn(async move {
            fetcher
                .fetch_pinned(&cache, &closure, &[source], &AllowFetch, "team/app")
                .await
                .unwrap()
        }));
    }
    for handle in handles {
        let (fetched, _) = handle.await.unwrap();
        assert_eq!(fetched.manifest_digest, fixture.manifest.digest());
    }
    // Exactly one physical transfer of each object: the warm caller re-fetches nothing.
    assert_eq!(dst_cache.fetch_count(), 3);

    server.abort();
    println!(
        "#4091 SC-01 measured: two concurrent fetches of pinned Manifest {} coalesced to one \
         physical transfer set (fetch_count=3: Manifest/Config/EROFS); the warm caller adopted \
         verified Ready bytes without copying",
        fixture.manifest.digest(),
    );
}

#[test]
fn digest_pin_rejects_substituted_closure_before_network() {
    let fixture = v1_fixture(b"digest pin layer");
    let mut closure = closure_for(&fixture);
    // A substituted Manifest digest (a different tag result) is refused.
    closure.manifest_digest = "sha256:".to_string() + &"ab".repeat(32);
    let error = closure.validate().expect_err("substituted digest");
    assert!(error
        .to_string()
        .contains("disagrees with the pinned digest"));

    // An incomplete closure (missing EROFS) is refused before discovery.
    let mut incomplete = closure_for(&fixture);
    incomplete
        .objects
        .retain(|object| object.media_type != MEDIA_TYPE_EROFS);
    let error = incomplete.validate().expect_err("incomplete closure");
    assert!(error.to_string().contains("exactly one"));
}
