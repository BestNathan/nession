//! Integrated GHCR EROFS Toolchain consumer-chain proof (#4249).
//!
//! One immutable published artifact identity is bound through every consumer
//! stage: external OCI Index -> authorized Server import/Catalog revision ->
//! Session pin -> `/v2/` Registry grant -> Agent verified cache -> Host-root
//! Sandbox composition -> shared MountManager EROFS mount -> `gh version`
//! inside an isolated execution.
//!
//! Two lanes live here:
//!
//! * Deterministic loopback fixtures (SC-01, SCN-01): portable, no external
//!   network, run by the normal Rust test gates at the exact PR head. They
//!   prove the identity-binding contract and the fail-closed negatives
//!   (wrong digest/platform, unauthorized repository/principal, referenced
//!   Composite) without claiming native runtime behavior.
//! * Real published GHCR artifact (SC-02/SC-03, SCN-03 native + SCN-04):
//!   Linux-only, `#[ignore]`d, executed by the staging `Acceptance / Cases`
//!   lane on a mount-capable runner. They consume the exact pinned
//!   `ghcr.io/bestnathan/nession-toolchain:gh-2.105.0` Index digest published
//!   by #4160 (read back independently by #4241) and never substitute a
//!   synthetic fixture for the real bytes.
//!
//! The pinned digests below mirror the trusted publication receipts in
//! `scripts/acceptance-toolchain-4160-evidence.mjs` and
//! `scripts/acceptance-toolchain-4241-evidence.mjs`; the tests re-resolve the
//! remote Index at start and refuse to continue if the tag no longer points
//! at the pinned identity.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use axum::response::IntoResponse;
use axum::Router;
use nession_erofs::blob::store::FsBlobStore;
use nession_erofs::cache::discovery::{
    FetchAuthorizer, PinnedClosure, SourceCredentialProvider, SourceFetcher, SourceKind,
};
use nession_erofs::cache::fetch::ImageObjectGrant;
use nession_erofs::cache::{identity_root, ErofsCache, StorageProbe};
use nession_erofs::catalog::pin::ConsumerKind;
use nession_erofs::catalog::reference::{record_object, ObjectKind, StoredObject};
use nession_erofs::catalog::tag::{get_tag, set_tag, TagExpectation};
use nession_erofs::image_documents;
use nession_erofs::oci::{
    to_bytes, Descriptor, Index, Platform, RawDocument, MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS,
    MEDIA_TYPE_INDEX, MEDIA_TYPE_MANIFEST,
};
use nession_erofs::registry::auth::{AllowAllImports, NoCredentials};
use nession_erofs::registry::pull::{pull_image, ImportRequest};
use nession_erofs::registry::{RegistryClient, RegistryConfig, RemoteReference};
use nession_protocol::contracts::image::v1::ImageCachePhase;
use nession_protocol::contracts::session::v1::{
    ManagedImageGrant, ManagedImageObjectGrant, ManagedImageRole, SandboxImagePrepareIntent,
};
use nession_protocol::TokenVerifier;
use nession_server::image::registry::mount_registry;
use tempfile::TempDir;
use tower::ServiceExt;

use nession_agent::erofs_cache::{observation, prepare_grant_image};
use nession_agent::peer_registry::{peer_source, ScopedPeerGrants};
use nession_agent::sandbox_images;

const SERVER_TOKEN: &str = "server-authoritative-4249";
const PEER_TOKEN: &str = "agent-a-peer-grant-4249";
const LOCAL_REPOSITORY: &str = "team/toolchain";
const REMOTE_REPOSITORY: &str = "upstream/tools";
const SESSION_ID: &str = "session-4249";

// ── Shared fixture helpers ──────────────────────────────────────────────────
//
// The workspace denies `unwrap_used`/`expect_used` and `allow-*-in-tests` only
// covers test functions and `#[cfg(test)]` modules, so the fixture helpers
// live in a `#[cfg(test)]` module (the `nession-sandbox/tests/linux_runtime.rs`
// convention) instead of weakening the lint.

#[cfg(test)]
mod helpers {
    use super::*;

    pub(super) struct DurableProbe;
    impl StorageProbe for DurableProbe {
        fn mount_type(&self, _path: &Path) -> anyhow::Result<String> {
            Ok("nfs".to_string())
        }
    }

    pub(super) fn linux_platform(architecture: &str) -> Platform {
        Platform::for_consumer("linux", architecture, None)
    }

    /// The exact Manifest/Config/EROFS documents of one synthetic tool image.
    pub(super) struct ImageDocs {
        pub(super) manifest: RawDocument,
        pub(super) config: RawDocument,
        pub(super) layer: RawDocument,
    }

    pub(super) fn tool_documents(payload: &[u8], architecture: &str) -> ImageDocs {
        let layer = RawDocument::from_bytes(payload.to_vec());
        let descriptor = Descriptor {
            media_type: MEDIA_TYPE_EROFS.to_string(),
            digest: layer.digest().to_string(),
            size: layer.size().unwrap(),
            urls: None,
            annotations: None,
            platform: None,
            artifact_type: None,
            data: None,
            extra: serde_json::Map::new(),
        };
        let annotations = BTreeMap::from([
            ("io.nession.kind".to_string(), "tool".to_string()),
            ("io.nession.path.prepend".to_string(), "bin".to_string()),
        ]);
        let (config, manifest) = image_documents(
            &descriptor,
            &linux_platform(architecture),
            &[],
            &annotations,
        )
        .unwrap();
        ImageDocs {
            manifest,
            config,
            layer,
        }
    }

    /// One OCI Index with linux/amd64 + linux/arm64 EROFS children, the exact
    /// shape of the published `gh-2.105.0` artifact.
    pub(super) struct IndexFixture {
        pub(super) index: RawDocument,
        pub(super) amd64: ImageDocs,
        pub(super) arm64: ImageDocs,
    }

    pub(super) fn index_fixture(payload: &[u8]) -> IndexFixture {
        let amd64 = tool_documents(payload, "amd64");
        let arm64 = tool_documents(&[payload, b"-arm64"].concat(), "arm64");
        let child = |docs: &ImageDocs, architecture: &str| Descriptor {
            media_type: MEDIA_TYPE_MANIFEST.to_string(),
            digest: docs.manifest.digest().to_string(),
            size: docs.manifest.size().unwrap(),
            urls: None,
            annotations: None,
            platform: Some(linux_platform(architecture)),
            artifact_type: None,
            data: None,
            extra: serde_json::Map::new(),
        };
        let index = Index {
            schema_version: 2,
            media_type: Some(MEDIA_TYPE_INDEX.to_string()),
            manifests: vec![child(&amd64, "amd64"), child(&arm64, "arm64")],
            annotations: Some(BTreeMap::from([(
                "io.nession.kind".to_string(),
                "tool".to_string(),
            )])),
            extra: serde_json::Map::new(),
        };
        IndexFixture {
            index: RawDocument::from_bytes(to_bytes(&index).unwrap()),
            amd64,
            arm64,
        }
    }

    /// A trusted isolated loopback OCI Distribution endpoint serving exact
    /// documents by digest and tag. No credential: it stands in for the external
    /// provider in deterministic fixtures only, never for the real GHCR lane.
    pub(super) async fn serve_documents(
        documents: Vec<RawDocument>,
        media_types: Vec<String>,
        tags: Vec<(String, String, String)>,
        tampered: Vec<(String, Vec<u8>)>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let mut by_digest: BTreeMap<String, (String, Vec<u8>)> = BTreeMap::new();
        for (document, media_type) in documents.into_iter().zip(media_types) {
            by_digest.insert(
                document.digest().to_string(),
                (media_type, document.bytes().to_vec()),
            );
        }
        for (digest, bytes) in tampered {
            if let Some(entry) = by_digest.get_mut(&digest) {
                entry.1 = bytes;
            }
        }
        let tag_map: BTreeMap<(String, String), String> = tags
            .into_iter()
            .map(|(repository, tag, digest)| ((repository, tag), digest))
            .collect();
        let state = Arc::new((by_digest, tag_map));
        let router = Router::new().fallback(move |request: Request<Body>| {
            let state = Arc::clone(&state);
            async move {
                let path = request.uri().path().to_string();
                if request.method() != Method::GET {
                    return StatusCode::METHOD_NOT_ALLOWED.into_response();
                }
                if path == "/v2/" {
                    return "{}".into_response();
                }
                let Some(rest) = path.strip_prefix("/v2/") else {
                    return StatusCode::NOT_FOUND.into_response();
                };
                let (repository, tail) = match rest.split_once("/manifests/") {
                    Some((repository, reference)) => (repository, ("manifests", reference)),
                    None => match rest.split_once("/blobs/") {
                        Some((repository, digest)) => (repository, ("blobs", digest)),
                        None => return StatusCode::NOT_FOUND.into_response(),
                    },
                };
                let (by_digest, tag_map) = state.as_ref();
                let digest = if tail.0 == "manifests" && !tail.1.starts_with("sha256:") {
                    match tag_map.get(&(repository.to_string(), tail.1.to_string())) {
                        Some(digest) => digest.clone(),
                        None => return StatusCode::NOT_FOUND.into_response(),
                    }
                } else {
                    tail.1.to_string()
                };
                match by_digest.get(&digest) {
                    Some((media_type, bytes)) => {
                        let mut headers = HeaderMap::new();
                        headers.insert(header::CONTENT_TYPE, media_type.parse().unwrap());
                        headers.insert("docker-content-digest", digest.parse().unwrap());
                        (headers, bytes.clone()).into_response()
                    }
                    None => StatusCode::NOT_FOUND.into_response(),
                }
            }
        });
        serve_loopback(router).await
    }

    pub(super) async fn serve_loopback(router: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (format!("http://{addr}"), handle)
    }

    /// The Agent's `server_url` is the WebSocket origin; `blob_origin` derives the
    /// HTTP blob origin from it exactly as the runtime does.
    pub(super) fn ws_origin(base: &str) -> String {
        base.replacen("http://", "ws://", 1)
    }

    pub(super) async fn open_cache(root: &Path, identity: &str) -> Arc<ErofsCache> {
        Arc::new(
            ErofsCache::open_with_probe(root, identity, false, &DurableProbe)
                .await
                .unwrap(),
        )
    }

    /// The standard `/v2/` grant shape (#4090): one authorized Manifest identity
    /// plus its reachable Config/EROFS closure, repository-scoped routes.
    pub(super) fn v2_grant(
        docs: &ImageDocs,
        repository: &str,
        target: Option<&str>,
    ) -> ManagedImageGrant {
        let object =
            |document: &RawDocument, media_type: &str, route: &str| ManagedImageObjectGrant {
                digest: document.digest().to_string(),
                media_type: media_type.to_string(),
                size_bytes: document.size().unwrap(),
                path: format!("/v2/{repository}/{route}/{}", document.digest()),
            };
        ManagedImageGrant {
            role: ManagedImageRole::Toolchain,
            digest: docs.manifest.digest().to_string(),
            path: format!("/v2/{repository}/manifests/{}", docs.manifest.digest()),
            target: target.map(str::to_string),
            objects: vec![
                object(&docs.manifest, MEDIA_TYPE_MANIFEST, "manifests"),
                object(&docs.config, MEDIA_TYPE_CONFIG, "blobs"),
                object(&docs.layer, MEDIA_TYPE_EROFS, "blobs"),
            ],
        }
    }

    /// The Server's own CAS + migrated Catalog over an isolated in-memory SQLite
    /// connection (the #4091 fixture shape; no production database).
    pub(super) async fn server_cas(dir: &Path) -> (FsBlobStore, sea_orm::DatabaseConnection) {
        let store = FsBlobStore::new(dir.join("cas")).unwrap();
        let conn = sea_orm::Database::connect("sqlite::memory:").await.unwrap();
        nession_erofs::catalog::migrate(&conn).await.unwrap();
        (store, conn)
    }

    /// Record one imported closure as a Catalog revision and move the local tag.
    pub(super) async fn publish_revision(
        conn: &sea_orm::DatabaseConnection,
        store: &FsBlobStore,
        docs: &ImageDocs,
        tag: &str,
    ) {
        for (document, kind, media_type) in [
            (&docs.layer, ObjectKind::Erofs, MEDIA_TYPE_EROFS),
            (&docs.config, ObjectKind::Config, MEDIA_TYPE_CONFIG),
            (&docs.manifest, ObjectKind::Manifest, MEDIA_TYPE_MANIFEST),
        ] {
            store.put_bytes(document.bytes()).unwrap();
            record_object(
                conn,
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
        nession_erofs::catalog::reference::record_reference(
            conn,
            docs.manifest.digest(),
            docs.config.digest(),
            "config",
            1,
        )
        .await
        .unwrap();
        nession_erofs::catalog::reference::record_reference(
            conn,
            docs.manifest.digest(),
            docs.layer.digest(),
            "layer",
            1,
        )
        .await
        .unwrap();
        set_tag(
            conn,
            LOCAL_REPOSITORY,
            tag,
            docs.manifest.digest(),
            &TagExpectation::Absent,
            1,
        )
        .await
        .unwrap();
    }

    /// The authoritative Server `/v2/` Registry over its CAS/Catalog, gated by the
    /// Server Token, with a blob-GET counter so fallback/warm proofs can observe
    /// exactly which source served bytes.
    pub(super) async fn serve_server_registry(
        store: FsBlobStore,
        conn: sea_orm::DatabaseConnection,
    ) -> (String, tokio::task::JoinHandle<()>, Arc<AtomicUsize>) {
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
        (base, handle, blob_reads)
    }

    pub(super) async fn probe_status(
        router: &Router,
        method: Method,
        uri: &str,
        auth: Option<&str>,
    ) -> StatusCode {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = auth {
            builder = builder.header("authorization", token);
        }
        router
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status()
    }

    pub(super) struct AllowFetch;
    impl FetchAuthorizer for AllowFetch {
        fn authorize_fetch(
            &self,
            _manifest_digest: &str,
            _local_repository: &str,
        ) -> anyhow::Result<()> {
            Ok(())
        }
    }

    pub(super) fn closure_for(docs: &ImageDocs) -> PinnedClosure {
        let object = |document: &RawDocument, media_type: &str| ImageObjectGrant {
            digest: document.digest().to_string(),
            media_type: media_type.to_string(),
            size_bytes: document.size().unwrap(),
            path: String::new(),
        };
        PinnedClosure {
            manifest_digest: docs.manifest.digest().to_string(),
            objects: vec![
                object(&docs.manifest, MEDIA_TYPE_MANIFEST),
                object(&docs.config, MEDIA_TYPE_CONFIG),
                object(&docs.layer, MEDIA_TYPE_EROFS),
            ],
        }
    }

    /// The Host-root (#3792) Toolchain-only policy the Session owner materializes
    /// from the prepared composition: no Base, read-only host root, one verified
    /// EROFS toolchain under a private `/opt`.
    pub(super) fn host_root_policy(
        composition: &nession_protocol::contracts::sandbox::v1::SandboxFilesystemComposition,
    ) -> nession_protocol::contracts::sandbox::v1::SandboxPolicy {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "enabled": true,
            "filesystem": {
                "access": { "read": [], "write": [] },
                "rootfs": { "kind": "local" },
                "composition": serde_json::to_value(composition).unwrap(),
            },
            "process": { "linux_namespaces": { "pid": true, "ipc": true, "user": true } },
            "syscall": { "seccomp": { "profile": "nession-interactive-v1" } },
            "enforcement": "required",
        }))
        .expect("host-root toolchain policy")
    }
}

use helpers::*;

// ── SC-01: deterministic identity binding and fail-closed negatives ─────────

/// SC-01 positive: one immutable Index identity is selected once and held
/// through Catalog revision, Session pin, `/v2/` grant, verified Agent cache
/// and the compiled Host-root composition — every stage names the same
/// Manifest/Config/EROFS digests, and the advisory `bin` prepend resolves
/// against the actual `/opt/gh` mount target.
#[tokio::test]
async fn sc01_one_pinned_index_identity_binds_catalog_grant_cache_and_composition() {
    let fixture = index_fixture(b"#4249 deterministic consumer chain layer");
    let dir = TempDir::new().unwrap();

    // The external provider: an Index reachable by tag and by digest.
    let (remote_base, remote_handle) = serve_documents(
        vec![
            fixture.index.clone(),
            fixture.amd64.manifest.clone(),
            fixture.amd64.config.clone(),
            fixture.amd64.layer.clone(),
            fixture.arm64.manifest.clone(),
            fixture.arm64.config.clone(),
            fixture.arm64.layer.clone(),
        ],
        vec![
            MEDIA_TYPE_INDEX.to_string(),
            MEDIA_TYPE_MANIFEST.to_string(),
            MEDIA_TYPE_CONFIG.to_string(),
            MEDIA_TYPE_EROFS.to_string(),
            MEDIA_TYPE_MANIFEST.to_string(),
            MEDIA_TYPE_CONFIG.to_string(),
            MEDIA_TYPE_EROFS.to_string(),
        ],
        vec![(
            REMOTE_REPOSITORY.to_string(),
            "v1".to_string(),
            fixture.index.digest().to_string(),
        )],
        Vec::new(),
    )
    .await;

    // Authorized Server import: the tag resolves to the Index, exactly one
    // platform child is selected, and the verified closure lands in the
    // Server CAS with a Catalog revision (local tag) atomically.
    let (store, conn) = server_cas(dir.path()).await;
    let client = RegistryClient::new(
        RegistryConfig::new(&remote_base).unwrap(),
        Arc::new(NoCredentials),
    )
    .unwrap();
    let outcome = pull_image(
        &client,
        &conn,
        &store,
        &ImportRequest {
            repository: REMOTE_REPOSITORY.to_string(),
            reference: RemoteReference::Tag("v1".to_string()),
            platform: linux_platform("amd64"),
            local_repository: LOCAL_REPOSITORY.to_string(),
            local_tag: "gh".to_string(),
            expectation: TagExpectation::Absent,
        },
        &AllowAllImports,
        1,
    )
    .await
    .expect("authorized import of the pinned Index identity");
    assert_eq!(outcome.source_digest, fixture.index.digest());
    assert_eq!(outcome.source_media_type, MEDIA_TYPE_INDEX);
    assert_eq!(outcome.manifest_digest, fixture.amd64.manifest.digest());
    assert_eq!(outcome.config_digest, fixture.amd64.config.digest());
    assert_eq!(outcome.layer_digest, fixture.amd64.layer.digest());
    assert_eq!(
        get_tag(&conn, LOCAL_REPOSITORY, "gh")
            .await
            .unwrap()
            .as_deref(),
        Some(fixture.amd64.manifest.digest()),
        "the Catalog revision must name the selected platform Manifest"
    );

    // The Session binds the resolved Manifest identity (GC root / pin).
    nession_erofs::catalog::pin::pin(
        &conn,
        ConsumerKind::Session,
        SESSION_ID,
        &outcome.manifest_digest,
        1,
        None,
    )
    .await
    .unwrap();

    // The authoritative `/v2/` Registry serves exactly that revision.
    let (server_base, server_handle, _reads) =
        serve_server_registry(store.clone(), conn.clone()).await;
    let grant = v2_grant(&fixture.amd64, LOCAL_REPOSITORY, Some("/opt/gh"));

    // Session-bound Agent prepare: the intent-gated unit fetches the authorized
    // closure into the identity-namespaced verified cache.
    let cache_root = dir.path().join("agent-cache");
    let cache = open_cache(&cache_root, "agent-4249").await;
    let prepared_image = prepare_grant_image(
        &cache,
        &grant,
        SandboxImagePrepareIntent::Prepare,
        &server_base,
        SERVER_TOKEN,
    )
    .await
    .expect("the authorized grant must prepare");
    assert_eq!(prepared_image.observation.phase, ImageCachePhase::Verified);
    assert_eq!(prepared_image.observation.digest, grant.digest);

    // The composition bridge resolves the same identity and builds the
    // Host-root Toolchain input with the verified local cache path.
    let state_dir = dir.path().join("agent-state");
    let prepared = sandbox_images::prepare(
        Some(cache.as_ref()),
        std::slice::from_ref(&grant),
        &ws_origin(&server_base),
        SERVER_TOKEN,
        &state_dir,
        None,
    )
    .await
    .expect("toolchain composition preparation");
    assert_eq!(prepared.manifests.len(), 1);
    assert_eq!(
        prepared.manifests[0].manifest_digest,
        outcome.manifest_digest
    );
    assert_eq!(prepared.manifests[0].layer_digest, outcome.layer_digest);
    let toolchain = &prepared.composition.toolchains[0];
    assert_eq!(toolchain.digest, outcome.layer_digest);
    assert_eq!(toolchain.target, "/opt/gh");
    assert_eq!(toolchain.path_prepend.as_deref(), Some("bin"));
    assert!(
        prepared.composition.base.is_none(),
        "Host-root keeps no Base"
    );
    assert_eq!(
        tokio::fs::read(&toolchain.source).await.unwrap(),
        fixture.amd64.layer.bytes(),
        "the cached EROFS bytes must be the exact imported layer"
    );
    let image_root = identity_root(&cache_root, "agent-4249").unwrap();
    assert!(
        Path::new(&toolchain.source).starts_with(&image_root),
        "the composition source must stay inside the Agent image root"
    );

    // Compile is side-effect-free: the same digest reaches the mount input and
    // the advisory prepend resolves against the actual mount target.
    let policy = host_root_policy(&prepared.composition);
    let compiled = nession_sandbox::compile(&policy).expect("host-root policy compiles");
    let composition = compiled
        .filesystem
        .as_ref()
        .unwrap()
        .composition
        .as_ref()
        .unwrap();
    assert_eq!(composition.toolchains[0].digest, outcome.layer_digest);
    assert_eq!(
        composition.path_prepend_dirs(),
        vec![PathBuf::from("/opt/gh/bin")],
        "PATH precedence binds the advisory prepend to the mount target"
    );

    remote_handle.abort();
    server_handle.abort();
    println!(
        "#4249 SC-01 measured: one pinned Index {} bound through Catalog revision {}/gh={}, \
         Session pin, /v2/ grant, verified Agent cache and compiled Host-root composition; \
         Manifest {} / Config {} / EROFS {} identical at every stage; prepend /opt/gh/bin",
        fixture.index.digest(),
        LOCAL_REPOSITORY,
        outcome.manifest_digest,
        outcome.manifest_digest,
        outcome.config_digest,
        outcome.layer_digest,
    );
}

/// SC-01 negatives: a wrong digest or wrong platform never resolves, never
/// falls back, and never publishes a Ready object.
#[tokio::test]
async fn sc01_wrong_digest_and_wrong_platform_fail_closed() {
    let fixture = index_fixture(b"#4249 wrong identity negative layer");
    let dir = TempDir::new().unwrap();
    let (remote_base, remote_handle) = serve_documents(
        vec![
            fixture.index.clone(),
            fixture.amd64.manifest.clone(),
            fixture.amd64.config.clone(),
            fixture.amd64.layer.clone(),
        ],
        vec![
            MEDIA_TYPE_INDEX.to_string(),
            MEDIA_TYPE_MANIFEST.to_string(),
            MEDIA_TYPE_CONFIG.to_string(),
            MEDIA_TYPE_EROFS.to_string(),
        ],
        vec![(
            REMOTE_REPOSITORY.to_string(),
            "v1".to_string(),
            fixture.index.digest().to_string(),
        )],
        Vec::new(),
    )
    .await;
    let (store, conn) = server_cas(dir.path()).await;
    let client = RegistryClient::new(
        RegistryConfig::new(&remote_base).unwrap(),
        Arc::new(NoCredentials),
    )
    .unwrap();
    let request = |reference: RemoteReference, platform: Platform| ImportRequest {
        repository: REMOTE_REPOSITORY.to_string(),
        reference,
        platform,
        local_repository: LOCAL_REPOSITORY.to_string(),
        local_tag: "gh".to_string(),
        expectation: TagExpectation::Absent,
    };

    // A forged Index digest is not served: the import fails closed and the
    // Catalog tag never moves.
    let forged = "sha256:".to_string() + &"cd".repeat(32);
    let error = pull_image(
        &client,
        &conn,
        &store,
        &request(
            RemoteReference::Digest(forged.clone()),
            linux_platform("amd64"),
        ),
        &AllowAllImports,
        1,
    )
    .await
    .expect_err("forged pinned digest");
    assert!(
        format!("{error:#}").contains(&forged) || format!("{error:#}").contains("404"),
        "the refusal must name the missing identity: {error:#}"
    );
    assert!(get_tag(&conn, LOCAL_REPOSITORY, "gh")
        .await
        .unwrap()
        .is_none());

    // A non-linux platform and a platform without the erofs feature are
    // refused before any payload fetch.
    let mut darwin = linux_platform("amd64");
    darwin.os = "darwin".to_string();
    let error = pull_image(
        &client,
        &conn,
        &store,
        &request(RemoteReference::Tag("v1".to_string()), darwin),
        &AllowAllImports,
        1,
    )
    .await
    .expect_err("non-linux platform");
    assert!(format!("{error:#}").contains("linux"));
    let mut no_erofs = linux_platform("amd64");
    no_erofs.os_features = Some(Vec::new());
    let error = pull_image(
        &client,
        &conn,
        &store,
        &request(RemoteReference::Tag("v1".to_string()), no_erofs),
        &AllowAllImports,
        1,
    )
    .await
    .expect_err("platform without erofs");
    assert!(format!("{error:#}").contains("erofs"));

    // An Index child whose Config disagrees with the selected platform is a
    // fail-closed mismatch, never a silent fallback to another child.
    let mismatched = tool_documents(b"#4249 mismatched config layer", "arm64");
    let lying_index = Index {
        schema_version: 2,
        media_type: Some(MEDIA_TYPE_INDEX.to_string()),
        manifests: vec![Descriptor {
            media_type: MEDIA_TYPE_MANIFEST.to_string(),
            digest: mismatched.manifest.digest().to_string(),
            size: mismatched.manifest.size().unwrap(),
            urls: None,
            annotations: None,
            platform: Some(linux_platform("amd64")),
            artifact_type: None,
            data: None,
            extra: serde_json::Map::new(),
        }],
        annotations: None,
        extra: serde_json::Map::new(),
    };
    let lying_index = RawDocument::from_bytes(to_bytes(&lying_index).unwrap());
    let (lying_base, lying_handle) = serve_documents(
        vec![
            lying_index.clone(),
            mismatched.manifest.clone(),
            mismatched.config.clone(),
            mismatched.layer.clone(),
        ],
        vec![
            MEDIA_TYPE_INDEX.to_string(),
            MEDIA_TYPE_MANIFEST.to_string(),
            MEDIA_TYPE_CONFIG.to_string(),
            MEDIA_TYPE_EROFS.to_string(),
        ],
        vec![(
            REMOTE_REPOSITORY.to_string(),
            "v1".to_string(),
            lying_index.digest().to_string(),
        )],
        Vec::new(),
    )
    .await;
    let lying_client = RegistryClient::new(
        RegistryConfig::new(&lying_base).unwrap(),
        Arc::new(NoCredentials),
    )
    .unwrap();
    let error = pull_image(
        &lying_client,
        &conn,
        &store,
        &ImportRequest {
            repository: REMOTE_REPOSITORY.to_string(),
            reference: RemoteReference::Tag("v1".to_string()),
            platform: linux_platform("amd64"),
            local_repository: LOCAL_REPOSITORY.to_string(),
            local_tag: "gh".to_string(),
            expectation: TagExpectation::Absent,
        },
        &AllowAllImports,
        1,
    )
    .await
    .expect_err("Index child / Config platform disagreement");
    assert!(
        format!("{error:#}").contains("platform") || format!("{error:#}").contains("targets"),
        "the refusal must name the platform mismatch: {error:#}"
    );
    assert!(get_tag(&conn, LOCAL_REPOSITORY, "gh")
        .await
        .unwrap()
        .is_none());

    // A tampered EROFS payload served at the correct digest route never
    // becomes Ready: hashing while streaming refuses it before publication.
    let mut corrupted = fixture.amd64.layer.bytes().to_vec();
    corrupted[0] ^= 0xff;
    let (tampered_base, tampered_handle) = serve_documents(
        vec![
            fixture.index.clone(),
            fixture.amd64.manifest.clone(),
            fixture.amd64.config.clone(),
            fixture.amd64.layer.clone(),
        ],
        vec![
            MEDIA_TYPE_INDEX.to_string(),
            MEDIA_TYPE_MANIFEST.to_string(),
            MEDIA_TYPE_CONFIG.to_string(),
            MEDIA_TYPE_EROFS.to_string(),
        ],
        vec![(
            REMOTE_REPOSITORY.to_string(),
            "v1".to_string(),
            fixture.index.digest().to_string(),
        )],
        vec![(fixture.amd64.layer.digest().to_string(), corrupted)],
    )
    .await;
    let tampered_client = RegistryClient::new(
        RegistryConfig::new(&tampered_base).unwrap(),
        Arc::new(NoCredentials),
    )
    .unwrap();
    let error = pull_image(
        &tampered_client,
        &conn,
        &store,
        &request(
            RemoteReference::Tag("v1".to_string()),
            linux_platform("amd64"),
        ),
        &AllowAllImports,
        1,
    )
    .await
    .expect_err("tampered EROFS bytes");
    assert!(
        format!("{error:#}").contains("digest") || format!("{error:#}").contains("mismatch"),
        "the refusal must name the digest verification failure: {error:#}"
    );
    assert!(
        !store.contains(fixture.amd64.layer.digest()).unwrap(),
        "a tampered layer must never be published Ready in the CAS"
    );
    assert!(get_tag(&conn, LOCAL_REPOSITORY, "gh")
        .await
        .unwrap()
        .is_none());

    // The Agent grant boundary independently refuses a forged Manifest digest
    // even when the Server route exists: possession is not authorization.
    let (server_base, server_handle, _reads) =
        serve_server_registry(store.clone(), conn.clone()).await;
    let cache = open_cache(&dir.path().join("agent-cache"), "agent-4249").await;
    let mut forged_grant = v2_grant(&fixture.amd64, LOCAL_REPOSITORY, Some("/opt/gh"));
    forged_grant.digest = forged.clone();
    forged_grant.path = format!("/v2/{LOCAL_REPOSITORY}/manifests/{forged}");
    forged_grant.objects[0].digest = forged.clone();
    forged_grant.objects[0].path = forged_grant.path.clone();
    let error = prepare_grant_image(
        &cache,
        &forged_grant,
        SandboxImagePrepareIntent::Prepare,
        &server_base,
        SERVER_TOKEN,
    )
    .await
    .expect_err("forged grant identity");
    assert!(format!("{error:#}").contains(&forged) || format!("{error:#}").contains("404"));
    let aggregate = observation(&cache, &forged).await;
    assert_ne!(aggregate.phase, ImageCachePhase::Verified);

    remote_handle.abort();
    lying_handle.abort();
    tampered_handle.abort();
    server_handle.abort();
    println!(
        "#4249 SC-01 measured: forged Index digest, non-linux platform, missing erofs feature, \
         Index-child/Config platform disagreement, tampered EROFS bytes and a forged /v2/ grant \
         all fail closed; no Catalog tag moved and no corrupted object became Ready"
    );
}

/// SC-01 negatives: repository reachability and principal authorization are
/// enforced at the `/v2/` boundary and in the scoped peer grant holder; no
/// global credential exists and diagnostics never reveal a token.
#[tokio::test]
async fn sc01_unauthorized_repository_and_principal_fail_closed() {
    let fixture = index_fixture(b"#4249 authorization negative layer");
    let dir = TempDir::new().unwrap();
    let (store, conn) = server_cas(dir.path()).await;
    publish_revision(&conn, &store, &fixture.amd64, "gh").await;
    let registry = mount_registry(
        store.clone(),
        conn.clone(),
        TokenVerifier::new(SERVER_TOKEN),
    )
    .unwrap();
    let router = registry.router();
    let (server_base, server_handle) = serve_loopback(router.clone()).await;
    let good = format!("Bearer {SERVER_TOKEN}");

    // Identity: no credential -> 401 challenge; a wrong principal -> 403.
    assert_eq!(
        probe_status(&router, Method::GET, "/v2/", None).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        probe_status(
            &router,
            Method::GET,
            "/v2/",
            Some("Bearer denied-principal")
        )
        .await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        probe_status(&router, Method::GET, "/v2/", Some(&good)).await,
        StatusCode::OK
    );

    // Repository reachability: a foreign repository cannot read the private
    // closure even with the valid Server principal.
    assert_eq!(
        probe_status(
            &router,
            Method::GET,
            &format!("/v2/other/app/blobs/{}", fixture.amd64.layer.digest()),
            Some(&good),
        )
        .await,
        StatusCode::NOT_FOUND
    );
    let cache = open_cache(&dir.path().join("agent-cache"), "agent-4249").await;
    let foreign_grant = v2_grant(&fixture.amd64, "other/app", Some("/opt/gh"));
    let error = prepare_grant_image(
        &cache,
        &foreign_grant,
        SandboxImagePrepareIntent::Prepare,
        &server_base,
        SERVER_TOKEN,
    )
    .await
    .expect_err("foreign repository grant");
    assert!(format!("{error:#}").contains("404") || format!("{error:#}").contains("other/app"));
    assert_ne!(
        observation(&cache, fixture.amd64.manifest.digest())
            .await
            .phase,
        ImageCachePhase::Verified
    );

    // A denied principal cannot fetch through the discovery path either.
    let denied_grants = Arc::new(ScopedPeerGrants::new());
    denied_grants.grant(&server_base, LOCAL_REPOSITORY, "denied-principal");
    let denied_source = peer_source(&server_base, LOCAL_REPOSITORY, denied_grants).unwrap();
    let error = SourceFetcher::new()
        .fetch_pinned(
            &cache,
            &closure_for(&fixture.amd64),
            &[denied_source],
            &AllowFetch,
            LOCAL_REPOSITORY,
        )
        .await
        .expect_err("denied principal fetch");
    assert!(error.to_string().contains("no authorized source"));

    // Scoped peer grants bind exactly one (origin, repository); any other
    // lookup fails closed and Debug never reveals the token.
    let grants = ScopedPeerGrants::new();
    grants.grant("http://peer-a", LOCAL_REPOSITORY, PEER_TOKEN);
    assert_eq!(
        grants
            .grant_token("http://peer-a", LOCAL_REPOSITORY)
            .as_deref(),
        Some(PEER_TOKEN)
    );
    assert!(grants
        .grant_token("http://peer-b", LOCAL_REPOSITORY)
        .is_none());
    assert!(grants.grant_token("http://peer-a", "other/app").is_none());
    let debug = format!("{grants:?}");
    assert!(
        !debug.contains(PEER_TOKEN),
        "peer grant Debug must redact tokens"
    );
    grants.revoke_origin("http://peer-a");
    assert!(grants
        .grant_token("http://peer-a", LOCAL_REPOSITORY)
        .is_none());

    // The valid repository-scoped path still fetches the exact pinned closure.
    let (fetched, provenance) = SourceFetcher::new()
        .fetch_pinned(
            &cache,
            &closure_for(&fixture.amd64),
            &[{
                let scoped = Arc::new(ScopedPeerGrants::new());
                scoped.grant(&server_base, LOCAL_REPOSITORY, SERVER_TOKEN);
                nession_erofs::cache::discovery::ImageSource::new(
                    &server_base,
                    LOCAL_REPOSITORY,
                    SourceKind::Server,
                    scoped,
                )
                .unwrap()
            }],
            &AllowFetch,
            LOCAL_REPOSITORY,
        )
        .await
        .expect("authorized repository fetch");
    assert_eq!(fetched.manifest_digest, fixture.amd64.manifest.digest());
    assert_eq!(provenance.repository, LOCAL_REPOSITORY);

    server_handle.abort();
    println!(
        "#4249 SC-01 measured: /v2/ no-credential->401 wrong-principal->403; foreign repository \
         invisible (404) and its grant refused; denied principal fails closed in discovery; \
         peer grants are (origin, repository)-scoped, redacted and revocable; the authorized \
         repository fetched pinned Manifest {}",
        fixture.amd64.manifest.digest(),
    );
}

/// SC-01 negative: a referenced Composite reached through the compatibility
/// route is rejected at the Sandbox composition boundary before any
/// execution-owned workspace exists (#3784 preserved).
#[tokio::test]
async fn sc01_referenced_composite_fails_closed_before_any_workspace() {
    use nession_erofs::oci::{
        CompositeDescriptor, ImageConfig, Manifest, RootFs, RuntimeConfig, COMPOSITE_ROOTFS_TYPE,
        MEDIA_TYPE_COMPOSITE,
    };

    let dir = TempDir::new().unwrap();
    let describe = |bytes: &[u8], media_type: &str| Descriptor {
        media_type: media_type.to_string(),
        digest: nession_erofs::blob::digest::digest_of_bytes(bytes),
        size: bytes.len() as u64,
        urls: None,
        annotations: None,
        platform: None,
        artifact_type: None,
        data: None,
        extra: serde_json::Map::new(),
    };
    let device_bytes: Vec<Vec<u8>> = vec![
        b"#4249 composite metadata".to_vec(),
        b"#4249 composite device one".to_vec(),
        b"#4249 composite device two".to_vec(),
    ];
    let devices: Vec<Descriptor> = device_bytes
        .iter()
        .map(|bytes| describe(bytes, MEDIA_TYPE_EROFS))
        .collect();
    let composite = CompositeDescriptor::new(
        &linux_platform("amd64"),
        &devices[0],
        &[devices[1].clone(), devices[2].clone()],
    )
    .unwrap();
    let composite_bytes = to_bytes(&composite).unwrap();
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
            fs_type: COMPOSITE_ROOTFS_TYPE.to_string(),
            diff_ids: composite
                .closure()
                .unwrap()
                .into_iter()
                .map(|descriptor| descriptor.digest)
                .collect(),
            extra: serde_json::Map::new(),
        },
        history: Vec::new(),
        extra: serde_json::Map::new(),
    };
    let config_bytes = to_bytes(&config).unwrap();
    let manifest = Manifest {
        schema_version: 2,
        media_type: Some(MEDIA_TYPE_MANIFEST.to_string()),
        config: describe(&config_bytes, MEDIA_TYPE_CONFIG),
        layers: vec![describe(&composite_bytes, MEDIA_TYPE_COMPOSITE)],
        subject: None,
        artifact_type: None,
        annotations: None,
        extra: serde_json::Map::new(),
    };
    let manifest_bytes = to_bytes(&manifest).unwrap();
    let manifest_digest = nession_erofs::blob::digest::digest_of_bytes(&manifest_bytes);

    let mut objects: Vec<(String, Vec<u8>)> = vec![
        (MEDIA_TYPE_MANIFEST.to_string(), manifest_bytes),
        (MEDIA_TYPE_CONFIG.to_string(), config_bytes),
        (MEDIA_TYPE_COMPOSITE.to_string(), composite_bytes),
    ];
    objects.extend(
        device_bytes
            .into_iter()
            .map(|bytes| (MEDIA_TYPE_EROFS.to_string(), bytes)),
    );
    // The compatibility image-blob route serves every closure object.
    let blob_map: Arc<BTreeMap<String, Vec<u8>>> = Arc::new(
        objects
            .iter()
            .map(|(_, bytes)| {
                (
                    nession_erofs::blob::digest::digest_of_bytes(bytes),
                    bytes.clone(),
                )
            })
            .collect(),
    );
    let router = Router::new().fallback(move |request: Request<Body>| {
        let blob_map = Arc::clone(&blob_map);
        async move {
            let path = request.uri().path().to_string();
            match path.strip_prefix("/images/blobs/") {
                Some(digest) => match blob_map.get(digest) {
                    Some(bytes) => bytes.clone().into_response(),
                    None => StatusCode::NOT_FOUND.into_response(),
                },
                None => StatusCode::NOT_FOUND.into_response(),
            }
        }
    });
    let (server_base, server_handle) = serve_loopback(router).await;

    let grant = ManagedImageGrant {
        role: ManagedImageRole::Toolchain,
        digest: manifest_digest.clone(),
        path: format!("/images/blobs/{manifest_digest}"),
        target: Some("/opt/gh".to_string()),
        objects: objects
            .iter()
            .map(|(media_type, bytes)| ManagedImageObjectGrant {
                digest: nession_erofs::blob::digest::digest_of_bytes(bytes),
                media_type: media_type.clone(),
                size_bytes: bytes.len() as u64,
                path: format!(
                    "/images/blobs/{}",
                    nession_erofs::blob::digest::digest_of_bytes(bytes)
                ),
            })
            .collect(),
    };
    let cache = open_cache(&dir.path().join("agent-cache"), "agent-4249").await;
    let state_dir = dir.path().join("agent-state");
    let error = match sandbox_images::prepare(
        Some(cache.as_ref()),
        &[grant],
        &ws_origin(&server_base),
        SERVER_TOKEN,
        &state_dir,
        None,
    )
    .await
    {
        Ok(_) => panic!("a referenced Composite must not prepare a Sandbox composition"),
        Err(error) => error,
    };
    let message = format!("{error:#}");
    assert!(
        message.contains("not yet selectable by the Sandbox composition"),
        "the Composite boundary must own the rejection: {message}"
    );
    assert!(
        message.contains("#3697"),
        "the rejection names its contract: {message}"
    );
    assert!(
        !state_dir.join("sandbox-workspaces").exists(),
        "a rejected preparation must not create the execution-owned workspace root"
    );

    server_handle.abort();
    println!(
        "#4249 SC-01 measured: referenced Composite Manifest {manifest_digest} resolved through \
         the compatibility route and was rejected at the Sandbox composition boundary (#3784) \
         before any execution-owned workspace existed"
    );
}

// ── SC-02 / SC-03: the real published GHCR artifact (native Linux lane) ─────

#[cfg(target_os = "linux")]
mod native {
    use self::helpers::*;
    use super::*;
    use std::io::Read;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    use nession_erofs::cache::store::CacheBlobStore;
    use nession_erofs::contracts::BlobStore;
    use nession_erofs::host_platform;
    use nession_erofs::mount_manager::{BlobPinner, ConsumerRef, MountManager, MountManagerConfig};
    use nession_erofs::registry::pull::ImportOutcome;
    use nession_protocol::contracts::sandbox::v1::SandboxPolicy;
    use nession_sandbox::{
        prepare as sandbox_prepare, LaunchRequest, PreparedSandbox, SandboxSettings,
    };

    use nession_agent::erofs_cache::CachePinner;
    use nession_agent::p2p_auth::P2pAuth;
    use nession_agent::registry::build_read_only_registry;

    const EVIDENCE_PREFIX: &str = "NESSON_SANDBOX_EVIDENCE ";

    /// The exact immutable OCI Index identity published by #4160 and read back
    /// by #4241. Consumers pin this digest, never the mutable tag.
    const PINNED_INDEX_DIGEST: &str =
        "sha256:2bd0fe388655d48fd514431095bc52bfb1d319fedc4fd183feb5949e4fb73587";
    const GHCR_REGISTRY: &str = "https://ghcr.io";
    const GHCR_REPOSITORY: &str = "bestnathan/nession-toolchain";
    const GHCR_TAG: &str = "gh-2.105.0";
    const GH_VERSION_PREFIX: &str = "gh version 2.105.0";

    /// Per-platform child identities of the pinned Index (remote readback).
    const AMD64_MANIFEST: &str =
        "sha256:0a922f17a02b48d58b2c4595da9cef0aa0909891d9a232dc394e2738c88d580d";
    const AMD64_CONFIG: &str =
        "sha256:32f71d5b1b7cb58cc03144d0d2970d054cf4746607202562020c14256d3d805c";
    const AMD64_LAYER: &str =
        "sha256:7ad4db01530282b6c49e692a221cd6b87ba428448894385f7d2713c3a899c609";
    const ARM64_MANIFEST: &str =
        "sha256:ff76276ffff35570a40da8b436e7e031646932d4edf049ee58dcfaf6ca982718";
    const ARM64_CONFIG: &str =
        "sha256:328004ec220c20790167264686e7e94a44695a5e771cbbafc91be9a8c1988816";
    const ARM64_LAYER: &str =
        "sha256:3b33564cb6788cc5d02e71484b0dd3d1f3ac012615b1a141e429bb799ef84c8b";

    // Native fixture helpers live in a `#[cfg(test)]` module so the workspace
    // `unwrap_used`/`expect_used` denies stay intact (the `linux_runtime.rs`
    // convention); the `#[tokio::test]` bodies below are test code already.
    #[cfg(test)]
    mod helpers {
        use super::*;

        /// The approved anonymous reader client for the public GHCR package. No
        /// credential is mapped into the Case; the challenge flow obtains a
        /// repository-scoped pull token and blob redirects stay on the allowlist.
        pub(super) fn ghcr_client() -> RegistryClient {
            let mut config = RegistryConfig::new(GHCR_REGISTRY).unwrap();
            config.allowed_redirect_hosts =
                vec!["pkg-containers.githubusercontent.com".to_string()];
            RegistryClient::new(config, Arc::new(NoCredentials)).unwrap()
        }

        pub(super) fn expected_child() -> (&'static str, &'static str, &'static str) {
            match std::env::consts::ARCH {
                "aarch64" => (ARM64_MANIFEST, ARM64_CONFIG, ARM64_LAYER),
                _ => (AMD64_MANIFEST, AMD64_CONFIG, AMD64_LAYER),
            }
        }

        /// Resolve the published tag at test start and refuse any identity other
        /// than the pinned #4160 Index digest; then import the exact pinned
        /// closure into an isolated Server CAS/Catalog with a Session pin.
        pub(super) async fn pinned_server_import(
            dir: &Path,
        ) -> (FsBlobStore, sea_orm::DatabaseConnection, ImportOutcome) {
            let client = ghcr_client();
            let resolved = client
                .fetch_manifest(GHCR_REPOSITORY, &RemoteReference::Tag(GHCR_TAG.to_string()))
                .await
                .expect("resolve the published GHCR tag");
            assert_eq!(
                resolved.digest, PINNED_INDEX_DIGEST,
                "the published tag must still point at the pinned #4160 Index identity"
            );
            assert_eq!(resolved.media_type, MEDIA_TYPE_INDEX);

            let (store, conn) = server_cas(dir).await;
            let outcome = pull_image(
                &client,
                &conn,
                &store,
                &ImportRequest {
                    repository: GHCR_REPOSITORY.to_string(),
                    reference: RemoteReference::Digest(PINNED_INDEX_DIGEST.to_string()),
                    platform: host_platform(),
                    local_repository: LOCAL_REPOSITORY.to_string(),
                    local_tag: "gh".to_string(),
                    expectation: TagExpectation::Absent,
                },
                &AllowAllImports,
                1,
            )
            .await
            .expect("import the pinned GHCR closure");
            assert_eq!(outcome.source_digest, PINNED_INDEX_DIGEST);
            let (manifest, config, layer) = expected_child();
            assert_eq!(outcome.manifest_digest, manifest);
            assert_eq!(outcome.config_digest, config);
            assert_eq!(outcome.layer_digest, layer);
            nession_erofs::catalog::pin::pin(
                &conn,
                ConsumerKind::Session,
                SESSION_ID,
                &outcome.manifest_digest,
                1,
                None,
            )
            .await
            .unwrap();
            (store, conn, outcome)
        }

        /// The real Manifest/Config/EROFS documents read back from the Server CAS.
        pub(super) fn cas_docs(store: &FsBlobStore, outcome: &ImportOutcome) -> ImageDocs {
            ImageDocs {
                manifest: RawDocument::from_bytes(store.read(&outcome.manifest_digest).unwrap()),
                config: RawDocument::from_bytes(store.read(&outcome.config_digest).unwrap()),
                layer: RawDocument::from_bytes(store.read(&outcome.layer_digest).unwrap()),
            }
        }

        pub(super) fn bridge_path() -> PathBuf {
            if let Some(path) = std::env::var_os("NESSON_SANDBOX_BRIDGE_BIN") {
                return PathBuf::from(path);
            }
            std::env::current_exe()
                .unwrap()
                .parent()
                .unwrap()
                .join("nession-sandbox-bridge")
        }

        /// Agent-shaped settings: the verified identity-namespaced cache is the
        /// only authorized image root, and the shared MountManager pins cache
        /// blobs for the physical mount lifetime through the Agent's CachePinner.
        pub(super) fn agent_settings(
            dir: &Path,
            cache_root: &Path,
            identity: &str,
            cache: Arc<ErofsCache>,
            manager_root: &Path,
        ) -> SandboxSettings {
            let mut settings = SandboxSettings::new(
                dir.join("agent-state"),
                bridge_path(),
                PathBuf::from("bwrap"),
                PathBuf::from("/usr/bin/sandbox-exec"),
            );
            settings.launch_timeout = Duration::from_secs(20);
            if let Some(root) = std::env::var_os("SANDBOX_CGROUP_ROOT")
                .or_else(|| std::env::var_os("NESSON_SANDBOX_CGROUP_ROOT"))
            {
                settings.cgroup_root = Some(PathBuf::from(root));
            }
            let image_root = identity_root(cache_root, identity).unwrap();
            settings.erofs_image_root = Some(image_root.clone());
            let manager = MountManager::open(MountManagerConfig {
                root: manager_root.to_path_buf(),
                settings: nession_erofs::mount::MountSettings::new(
                    settings.erofsfuse_path.clone(),
                    settings.fusermount_path.clone(),
                ),
                authorized_roots: vec![image_root],
                pinner: Some(Arc::new(CachePinner::new(cache)) as Arc<dyn BlobPinner>),
            })
            .expect("open the shared EROFS mount manager");
            settings.mount_manager = Some(manager);
            settings
        }

        pub(super) struct Running {
            pub(super) prepared: PreparedSandbox,
            pub(super) child: Child,
            pub(super) pane_pid: u32,
        }

        /// Spawn the exact trusted launcher the Agent hands to `tmux new-session`
        /// (direct isolated execution; no tmux server is involved in this proof).
        pub(super) fn launch(
            settings: &SandboxSettings,
            policy: SandboxPolicy,
            inner: &str,
        ) -> Running {
            let request = LaunchRequest {
                policy,
                session_name: format!("toolchain-4249-{}", std::process::id()),
                instance_id: "instance-4249".to_string(),
                working_dir: settings
                    .state_dir
                    .parent()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                inner_command: vec!["/bin/sh".to_string(), "-c".to_string(), inner.to_string()],
                tmux_socket: None,
            };
            let prepared = sandbox_prepare(&request, settings).expect("prepare the execution");
            let image = prepared.image_environment();
            let mut envs = image.defaults.clone();
            if let Some(path) = nession_sandbox::compose_path_prepend(
                &image.path_prepend,
                std::env::var("PATH").ok().as_deref(),
            ) {
                envs.push(("PATH".to_string(), path));
            }
            envs.extend(prepared.env().iter().cloned());
            let program = prepared.command().first().unwrap().clone();
            let mut command = Command::new(program); // not-tmux: the sandbox trusted launcher
            command.args(prepared.command().get(1..).unwrap_or_default());
            for (key, value) in &envs {
                command.env(key, value);
            }
            let child = command
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("spawn the trusted launcher");
            let pane_pid = child.id();
            Running {
                prepared,
                child,
                pane_pid,
            }
        }

        pub(super) fn verify_or_report(running: &mut Running, context: &str) {
            if let Err(error) = running.prepared.verify(running.pane_pid) {
                let _ = running.child.kill();
                let mut stderr = String::new();
                if let Some(mut pipe) = running.child.stderr.take() {
                    let _ = pipe.read_to_string(&mut stderr);
                }
                let mut stdout = String::new();
                if let Some(mut pipe) = running.child.stdout.take() {
                    let _ = pipe.read_to_string(&mut stdout);
                }
                panic!("{context}: {error}; stdout: {stdout}; stderr: {stderr}");
            }
        }

        pub(super) fn wait_for_exit(
            running: &mut Running,
        ) -> (std::process::ExitStatus, String, String) {
            let mut stderr = running.child.stderr.take().expect("stderr");
            let stderr_reader = std::thread::spawn(move || {
                let mut text = String::new();
                let _ = stderr.read_to_string(&mut text);
                text
            });
            let deadline = Instant::now() + Duration::from_secs(60);
            let status = loop {
                if let Some(status) = running.child.try_wait().expect("wait for the sandbox") {
                    break status;
                }
                if Instant::now() >= deadline {
                    let _ = running.child.kill();
                    let _ = running.child.wait();
                    panic!("the sandboxed execution did not exit");
                }
                std::thread::sleep(Duration::from_millis(20));
            };
            let mut stdout = String::new();
            running
                .child
                .stdout
                .take()
                .expect("stdout")
                .read_to_string(&mut stdout)
                .expect("read sandbox stdout");
            let stderr = stderr_reader.join().unwrap_or_default();
            (status, stdout, stderr)
        }

        pub(super) fn sha256_file(path: &Path) -> String {
            use sha2::{Digest, Sha256};
            let bytes = std::fs::read(path).unwrap();
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            format!("sha256:{:x}", hasher.finalize())
        }

        pub(super) fn kernel() -> String {
            String::from_utf8(
                Command::new("uname")
                    .arg("-r")
                    .output()
                    .expect("uname")
                    .stdout,
            )
            .unwrap()
            .trim()
            .to_string()
        }

        pub(super) fn print_evidence(value: &serde_json::Value) {
            println!("{EVIDENCE_PREFIX}{value}");
        }
    }

    /// SC-02: the same real published GHCR `gh` artifact travels the whole
    /// authorized consumer chain and executes inside an isolated Host-root
    /// Session execution, with no Host/Agent rootfs mutation and no
    /// unauthorized artifact access.
    #[tokio::test]
    #[ignore = "requires the real GHCR artifact, erofs-utils and /dev/fuse; executed by the #4249 SC-02 staging acceptance Case"]
    async fn sc02_real_ghcr_gh_toolchain_imports_mounts_and_executes_in_sandbox() {
        let dir = TempDir::new().unwrap();
        let (store, conn, outcome) = pinned_server_import(dir.path()).await;
        let docs = cas_docs(&store, &outcome);
        let (server_base, server_handle, _reads) =
            serve_server_registry(store.clone(), conn.clone()).await;
        let registry = mount_registry(
            store.clone(),
            conn.clone(),
            TokenVerifier::new(SERVER_TOKEN),
        )
        .unwrap();
        let router = registry.router();

        // Session-bound Agent prepare over the standard /v2/ grant.
        let cache_root = dir.path().join("agent-cache");
        let cache = open_cache(&cache_root, "agent-4249").await;
        let grant = v2_grant(&docs, LOCAL_REPOSITORY, Some("/opt/gh"));
        let prepared_image = prepare_grant_image(
            &cache,
            &grant,
            SandboxImagePrepareIntent::Prepare,
            &server_base,
            SERVER_TOKEN,
        )
        .await
        .expect("prepare the real GHCR grant");
        assert_eq!(prepared_image.observation.phase, ImageCachePhase::Verified);
        let state_dir = dir.path().join("agent-state");
        let prepared = sandbox_images::prepare(
            Some(cache.as_ref()),
            std::slice::from_ref(&grant),
            &ws_origin(&server_base),
            SERVER_TOKEN,
            &state_dir,
            None,
        )
        .await
        .expect("compose the real toolchain");
        let toolchain = &prepared.composition.toolchains[0];
        assert_eq!(toolchain.digest, outcome.layer_digest);
        assert_eq!(toolchain.target, "/opt/gh");
        assert_eq!(toolchain.path_prepend.as_deref(), Some("bin"));
        assert_eq!(
            sha256_file(Path::new(&toolchain.source)),
            outcome.layer_digest,
            "the cached EROFS bytes must hash to the pinned layer identity"
        );

        // Host-root execution: `gh version` resolves through the composed
        // PATH prepend on the verified shared EROFS mount. A sentinel file on
        // the host root proves the read-only bind never mutates Host bytes,
        // and the toolchain mount itself refuses writes.
        let sentinel = dir.path().join("host-sentinel.txt");
        std::fs::write(&sentinel, "host-original-4249\n").unwrap();
        let settings = agent_settings(
            dir.path(),
            &cache_root,
            "agent-4249",
            Arc::clone(&cache),
            &dir.path().join("erofs-mounts"),
        );
        std::fs::create_dir_all(&settings.state_dir).unwrap();
        let policy = host_root_policy(&prepared.composition);
        let inner = format!(
            "gh version; \
             if touch /opt/gh/bin/.nession-mutate 2>/dev/null; then echo TOOLCHAIN-WRITABLE; \
             else echo TOOLCHAIN-READONLY; fi; \
             if echo mutated >> {sentinel} 2>/dev/null; then echo HOST-WRITABLE; \
             else echo HOST-READONLY; fi; \
             cat {sentinel}",
            sentinel = sentinel.display(),
        );
        let mut running = launch(&settings, policy, &inner);
        verify_or_report(
            &mut running,
            "the Host-root launch barrier must verify before gh runs",
        );
        let (status, stdout, stderr) = wait_for_exit(&mut running);
        assert!(
            status.success(),
            "gh version must exit successfully: stdout={stdout} stderr={stderr}"
        );
        assert!(
            stdout.contains(GH_VERSION_PREFIX),
            "the executed tool must be the published gh 2.105.0: {stdout}"
        );
        assert!(
            stdout.contains("TOOLCHAIN-READONLY"),
            "the EROFS toolchain mount is read-only: {stdout}"
        );
        assert!(
            stdout.contains("HOST-READONLY"),
            "the Host root bind is read-only: {stdout}"
        );
        assert!(
            stdout.contains("host-original-4249"),
            "the host sentinel must be readable: {stdout}"
        );
        assert_eq!(
            std::fs::read_to_string(&sentinel).unwrap(),
            "host-original-4249\n",
            "Host rootfs bytes must not be mutated by the sandbox execution"
        );
        let record = running.prepared.record().clone();
        assert_eq!(record.backend, "linux-bwrap");
        assert_eq!(record.shared_mounts.len(), 1);
        assert_eq!(record.shared_mounts[0].digest, outcome.layer_digest);
        assert_eq!(
            sha256_file(Path::new(&toolchain.source)),
            outcome.layer_digest,
            "the cached layer must remain byte-identical after execution"
        );
        let mountpoint = record.shared_mounts[0].mountpoint.clone();
        running
            .prepared
            .into_handle()
            .cleanup()
            .expect("owned cleanup");
        assert!(
            !nession_erofs::mount::mount_entries()
                .iter()
                .any(|entry| entry.mountpoint == Path::new(&mountpoint)),
            "the physical mount must be reclaimed after the last consumer"
        );

        // Unauthorized access to the real artifact's Server projection fails
        // closed: a denied principal and a foreign repository read nothing.
        assert_eq!(
            probe_status(
                &router,
                Method::GET,
                "/v2/",
                Some("Bearer denied-principal")
            )
            .await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            probe_status(
                &router,
                Method::GET,
                &format!("/v2/other/app/blobs/{}", outcome.layer_digest),
                Some(&format!("Bearer {SERVER_TOKEN}")),
            )
            .await,
            StatusCode::NOT_FOUND
        );

        server_handle.abort();
        let gh_line = stdout
            .lines()
            .find(|line| line.starts_with(GH_VERSION_PREFIX))
            .unwrap()
            .to_string();
        print_evidence(&serde_json::json!({
            "issue": 4249,
            "criterion": "SC-02",
            "source": format!("ghcr.io/{GHCR_REPOSITORY}:{GHCR_TAG}"),
            "index_digest": PINNED_INDEX_DIGEST,
            "manifest_digest": outcome.manifest_digest,
            "config_digest": outcome.config_digest,
            "layer_digest": outcome.layer_digest,
            "gh_version": gh_line,
            "backend": record.backend,
            "execution_id": record.execution_id,
            "toolchain_target": "/opt/gh",
            "path_prepend": "/opt/gh/bin",
            "toolchain_readonly": true,
            "host_rootfs_unchanged": true,
            "unauthorized_principal_denied": true,
            "foreign_repository_denied": true,
            "mount_reclaimed_after_cleanup": true,
            "kernel": kernel(),
        }));
        println!(
            "#4249 SC-02 measured: pinned GHCR Index {PINNED_INDEX_DIGEST} imported through the \
             authorized Server Catalog revision, prepared over /v2/ into the verified Agent cache \
             (Manifest {} / EROFS {}), mounted by the shared MountManager under Host-root /opt/gh \
             and executed `{gh_line}` in an isolated linux-bwrap Session execution; Host/Agent \
             rootfs unmutated, toolchain read-only, denied principal 403 and foreign repository 404",
            outcome.manifest_digest, outcome.layer_digest,
        );
    }

    /// SC-03: the same pinned artifact survives an Agent restart on the warm
    /// verified cache (no re-download), an unavailable peer falls back only to
    /// the authorized Server for the identical digest, corrupted bytes never
    /// become Ready, and mount/cache leases clean up correctly.
    #[tokio::test]
    #[ignore = "requires the real GHCR artifact, erofs-utils and /dev/fuse; executed by the #4249 SC-03 staging acceptance Case"]
    async fn sc03_real_ghcr_pinned_artifact_restart_warm_cache_and_authorized_fallback() {
        let dir = TempDir::new().unwrap();
        let (store, conn, outcome) = pinned_server_import(dir.path()).await;
        let docs = cas_docs(&store, &outcome);
        let (server_base, server_handle, server_blob_reads) =
            serve_server_registry(store.clone(), conn.clone()).await;
        let grant = v2_grant(&docs, LOCAL_REPOSITORY, Some("/opt/gh"));

        // Cold prepare, then an Agent restart over the same durable cache: the
        // verified closure is adopted without a single new transfer.
        let cache_root = dir.path().join("agent-cache");
        let cache = open_cache(&cache_root, "agent-4249").await;
        let cold = prepare_grant_image(
            &cache,
            &grant,
            SandboxImagePrepareIntent::Prepare,
            &server_base,
            SERVER_TOKEN,
        )
        .await
        .expect("cold prepare");
        assert_eq!(cold.observation.phase, ImageCachePhase::Verified);
        let cold_fetches = cache.fetch_count();
        assert!(
            cold_fetches > 0,
            "the cold prepare must transfer the closure"
        );
        drop(cache);
        let restarted = open_cache(&cache_root, "agent-4249").await;
        let warm = prepare_grant_image(
            &restarted,
            &grant,
            SandboxImagePrepareIntent::Prepare,
            &server_base,
            SERVER_TOKEN,
        )
        .await
        .expect("warm restart prepare");
        assert_eq!(warm.observation.phase, ImageCachePhase::Verified);
        assert_eq!(
            restarted.fetch_count(),
            0,
            "a verified warm cache must not re-download any object"
        );
        let state_dir = dir.path().join("agent-state");
        let prepared = sandbox_images::prepare(
            Some(restarted.as_ref()),
            std::slice::from_ref(&grant),
            &ws_origin(&server_base),
            SERVER_TOKEN,
            &state_dir,
            None,
        )
        .await
        .expect("warm composition");
        assert_eq!(
            prepared.composition.toolchains[0].digest,
            outcome.layer_digest
        );

        // Mount, simulate an Agent crash with a live consumer, reopen the
        // manager and adopt the recorded consumer identity; a second Session
        // execution reuses the one physical mount and still runs gh.
        let settings_one = agent_settings(
            dir.path(),
            &cache_root,
            "agent-4249",
            Arc::clone(&restarted),
            &dir.path().join("erofs-mounts"),
        );
        std::fs::create_dir_all(&settings_one.state_dir).unwrap();
        let policy = host_root_policy(&prepared.composition);
        let mut first = launch(&settings_one, policy.clone(), "gh version");
        verify_or_report(&mut first, "first execution barrier");
        let (status, stdout, stderr) = wait_for_exit(&mut first);
        assert!(
            status.success(),
            "first gh version: stdout={stdout} stderr={stderr}"
        );
        assert!(stdout.contains(GH_VERSION_PREFIX));
        let record_one = first.prepared.record().clone();
        let shared = record_one.shared_mounts[0].clone();
        let manager_one = settings_one.mount_manager.clone().unwrap();
        let status_before = manager_one.lookup(&outcome.layer_digest).unwrap();
        assert!(status_before.mounted);
        assert_eq!(status_before.consumers, 1);
        // Crash: the execution's consumer lease and the manager disappear
        // without cleanup; the physical mount and its sidecar survive.
        std::mem::forget(first);
        drop(settings_one);
        drop(manager_one);

        let settings_two = agent_settings(
            dir.path(),
            &cache_root,
            "agent-4249",
            Arc::clone(&restarted),
            &dir.path().join("erofs-mounts"),
        );
        std::fs::create_dir_all(&settings_two.state_dir).unwrap();
        let manager_two = settings_two.mount_manager.clone().unwrap();
        let report = manager_two.adopt_consumers(&[ConsumerRef {
            digest: shared.digest.clone(),
            execution_id: record_one.execution_id.clone(),
            generation: shared.generation.clone(),
        }]);
        assert_eq!(
            report.adopted,
            vec![(
                outcome.layer_digest.clone(),
                record_one.execution_id.clone()
            )],
            "the restarted manager must adopt the recorded live consumer: {report:?}"
        );
        assert!(report.unavailable.is_empty(), "{report:?}");
        let adopted = manager_two.lookup(&outcome.layer_digest).unwrap();
        assert!(adopted.mounted);
        assert_eq!(adopted.mountpoint.to_string_lossy(), shared.mountpoint);
        assert_eq!(
            adopted.generation.as_deref(),
            Some(shared.generation.as_str())
        );

        let mut second = launch(&settings_two, policy, "gh version");
        verify_or_report(&mut second, "second execution barrier on the adopted mount");
        let (status, stdout, stderr) = wait_for_exit(&mut second);
        assert!(
            status.success(),
            "second gh version: stdout={stdout} stderr={stderr}"
        );
        assert!(stdout.contains(GH_VERSION_PREFIX));
        let record_two = second.prepared.record().clone();
        assert_eq!(
            record_two.shared_mounts[0].mountpoint, shared.mountpoint,
            "both executions share one physical mount for the pinned digest"
        );
        second
            .prepared
            .into_handle()
            .cleanup()
            .expect("second execution cleanup");
        manager_two
            .release_consumers(
                &outcome.layer_digest,
                &record_one.execution_id,
                Some(shared.generation.as_str()),
            )
            .expect("release the adopted crashed consumer");
        let after = manager_two.lookup(&outcome.layer_digest);
        assert!(
            after.as_ref().is_none_or(|status| !status.mounted),
            "the mount must be reclaimed after the last adopted consumer releases: {after:?}"
        );
        // The crashed execution's empty cgroup is the only leaked kernel
        // resource; remove exactly that owned child (the process has exited).
        if let Some(cgroup_path) = &record_one.cgroup_path {
            let _ = std::fs::remove_dir(cgroup_path);
        }

        // Peer propagation of the same real bytes: Agent A serves its verified
        // closure; Agent B fetches from the peer while the Server serves zero
        // blob bytes, then a revoked peer falls back only to the authorized
        // Server for the identical pinned Manifest.
        let peer_cache = open_cache(&dir.path().join("peer-cache"), "agent-a").await;
        let peer_blobs = CacheBlobStore::new(Arc::clone(&peer_cache));
        peer_blobs.put_bytes(docs.layer.bytes()).unwrap();
        peer_blobs.put_bytes(docs.config.bytes()).unwrap();
        peer_blobs.put_bytes(docs.manifest.bytes()).unwrap();
        let peer_registry =
            build_read_only_registry(Arc::clone(&peer_cache), Arc::new(P2pAuth::new(PEER_TOKEN)))
                .unwrap();
        peer_registry
            .register_tag(LOCAL_REPOSITORY, "gh", &outcome.manifest_digest)
            .unwrap();
        let (peer_base, peer_handle) = serve_loopback(peer_registry.router()).await;
        let peer_grants = Arc::new(ScopedPeerGrants::new());
        peer_grants.grant(&peer_base, LOCAL_REPOSITORY, PEER_TOKEN);
        let server_grants = Arc::new(ScopedPeerGrants::new());
        server_grants.grant(&server_base, LOCAL_REPOSITORY, SERVER_TOKEN);
        let server_credentials: Arc<dyn SourceCredentialProvider> = server_grants.clone();
        let server_source = nession_erofs::cache::discovery::ImageSource::new(
            &server_base,
            LOCAL_REPOSITORY,
            SourceKind::Server,
            server_credentials,
        )
        .unwrap();
        let closure = closure_for(&docs);

        let cache_b = open_cache(&dir.path().join("agent-b-cache"), "agent-b").await;
        let reads_before_peer = server_blob_reads.load(Ordering::SeqCst);
        let (from_peer, peer_provenance) = SourceFetcher::new()
            .fetch_pinned(
                &cache_b,
                &closure,
                &[
                    peer_source(&peer_base, LOCAL_REPOSITORY, Arc::clone(&peer_grants)).unwrap(),
                    server_source.clone(),
                ],
                &AllowFetch,
                LOCAL_REPOSITORY,
            )
            .await
            .expect("authorized peer fetch of the real closure");
        assert_eq!(from_peer.manifest_digest, outcome.manifest_digest);
        assert_eq!(from_peer.layer.digest, outcome.layer_digest);
        assert_eq!(peer_provenance.kind, SourceKind::Peer);
        assert_eq!(
            server_blob_reads.load(Ordering::SeqCst),
            reads_before_peer,
            "the Server must serve zero blob bytes while the peer is authorized"
        );
        assert_eq!(
            tokio::fs::read(&from_peer.layer_path).await.unwrap(),
            docs.layer.bytes(),
            "the peer-fetched EROFS bytes are the exact published layer"
        );

        // Revoke the peer's repository projection: fallback goes only to the
        // authorized Server and delivers the identical pinned digest.
        peer_registry
            .unregister_repository(LOCAL_REPOSITORY)
            .unwrap();
        let cache_c = open_cache(&dir.path().join("agent-c-cache"), "agent-c").await;
        let reads_before_fallback = server_blob_reads.load(Ordering::SeqCst);
        let (from_server, server_provenance) = SourceFetcher::new()
            .fetch_pinned(
                &cache_c,
                &closure,
                &[
                    peer_source(&peer_base, LOCAL_REPOSITORY, Arc::clone(&peer_grants)).unwrap(),
                    server_source,
                ],
                &AllowFetch,
                LOCAL_REPOSITORY,
            )
            .await
            .expect("authorized fallback for the same pinned digest");
        assert_eq!(from_server.manifest_digest, outcome.manifest_digest);
        assert_eq!(from_server.layer.digest, outcome.layer_digest);
        assert_eq!(server_provenance.kind, SourceKind::Server);
        assert_eq!(server_provenance.origin, server_base);
        assert!(
            server_blob_reads.load(Ordering::SeqCst) > reads_before_fallback,
            "the fallback must actually read blob bytes from the authorized Server"
        );
        for object in [
            &from_server.manifest_digest,
            &from_server.config_digest,
            &from_server.layer.digest,
        ] {
            assert_eq!(
                observation(&cache_c, object).await.phase,
                ImageCachePhase::Verified,
                "every fallback object must be Verified, never partial"
            );
        }

        // Corrupted bytes at the correct route never become Ready: the
        // transfer verifies before publication and the aggregate identity is
        // not mount-ready.
        let mut corrupted = docs.layer.bytes().to_vec();
        let mid = corrupted.len() / 2;
        corrupted[mid] ^= 0xff;
        let (tampered_base, tampered_handle) = serve_documents(
            vec![
                docs.manifest.clone(),
                docs.config.clone(),
                docs.layer.clone(),
            ],
            vec![
                MEDIA_TYPE_MANIFEST.to_string(),
                MEDIA_TYPE_CONFIG.to_string(),
                MEDIA_TYPE_EROFS.to_string(),
            ],
            Vec::new(),
            vec![(outcome.layer_digest.clone(), corrupted)],
        )
        .await;
        let cache_d = open_cache(&dir.path().join("agent-d-cache"), "agent-d").await;
        let tampered_grant = v2_grant(&docs, LOCAL_REPOSITORY, Some("/opt/gh"));
        let error = prepare_grant_image(
            &cache_d,
            &tampered_grant,
            SandboxImagePrepareIntent::Prepare,
            &tampered_base,
            SERVER_TOKEN,
        )
        .await
        .expect_err("corrupted EROFS bytes must fail verification");
        assert!(
            format!("{error:#}").contains("digest")
                || format!("{error:#}").contains("mismatch")
                || format!("{error:#}").contains("verify"),
            "the refusal must name verification: {error:#}"
        );
        assert_ne!(
            observation(&cache_d, &outcome.layer_digest).await.phase,
            ImageCachePhase::Verified
        );
        assert_ne!(
            observation(&cache_d, &outcome.manifest_digest).await.phase,
            ImageCachePhase::Verified,
            "a Manifest whose EROFS layer failed is never mount-ready"
        );

        // Cache lease correctness: a pinned blob refuses eviction; after the
        // pin releases, eviction reclaims it. No partial file is Ready.
        let pin = cache_c.pin(&outcome.layer_digest).unwrap();
        assert!(
            cache_c.evict(&outcome.layer_digest).is_err(),
            "a pinned blob must refuse eviction"
        );
        drop(pin);
        cache_c
            .evict(&outcome.layer_digest)
            .expect("unpinned eviction");
        assert!(!cache_c.blob_path(&outcome.layer_digest).unwrap().exists());

        peer_handle.abort();
        tampered_handle.abort();
        server_handle.abort();
        print_evidence(&serde_json::json!({
            "issue": 4249,
            "criterion": "SC-03",
            "index_digest": PINNED_INDEX_DIGEST,
            "manifest_digest": outcome.manifest_digest,
            "layer_digest": outcome.layer_digest,
            "cold_transfers": cold_fetches,
            "restart_fetch_count": 0,
            "restart_observation": "verified",
            "adopted_consumer": record_one.execution_id,
            "one_physical_mount": true,
            "second_execution_gh_version": true,
            "mount_reclaimed_after_release": true,
            "peer_provenance": "peer",
            "server_blob_gets_during_peer": 0,
            "fallback_provenance": "server",
            "fallback_same_digest": true,
            "corrupted_layer_never_ready": true,
            "pin_protects_eviction": true,
            "kernel": kernel(),
        }));
        println!(
            "#4249 SC-03 measured: pinned GHCR Manifest {} reused after Agent restart with \
             fetch_count=0 on the verified warm cache; crashed consumer adopted by the reopened \
             MountManager and one physical mount served a second `gh version` execution before \
             reclaim; authorized peer fetch served the exact layer with zero Server blob bytes, \
             revoked peer fell back only to the authorized Server for the identical digest; \
             corrupted bytes never Ready; pin/eviction lease semantics held",
            outcome.manifest_digest,
        );
    }
}
