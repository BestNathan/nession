//! #4088 protocol tests: the mountable Registry service over Server-like
//! (catalog) and Agent-like (cache) fixture hosts. These exercise the OCI
//! Distribution pull/push surface, read-only denial and repository-scope
//! authorization that the merged-staging SCN-03 Cases prove end to end.

// The module is declared with bare `cfg(test)` (so clippy's allow-in-tests
// recognizes its helpers); the Server-like fixtures need the catalog, and the
// Agent-like fixture additionally gates itself on `cache` below.
#![cfg(feature = "catalog")]

use std::sync::Arc;

use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use sea_orm::DatabaseConnection;
use serde_json::Map;
use tempfile::TempDir;
use tower::ServiceExt;

use super::{Authorization, RegistryAction, RegistryAuthorizer, RegistryMode, RegistryService};
use crate::blob::store::FsBlobStore;
#[cfg(feature = "cache")]
use crate::cache::repository::CacheRepositoryStore;
#[cfg(feature = "cache")]
use crate::cache::store::CacheBlobStore;
#[cfg(feature = "cache")]
use crate::cache::{ErofsCache, StorageProbe};
use crate::catalog::reference::{record_object, record_reference, ObjectKind, StoredObject};
use crate::catalog::sqlite::tests::memory_connection;
use crate::catalog::tag::{set_tag, TagExpectation};
use crate::catalog::{CatalogRepositoryPublisher, CatalogRepositoryStore};
use crate::contracts::BlobStore;
use crate::oci::annotation::{
    MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_INDEX, MEDIA_TYPE_MANIFEST,
};
use crate::oci::config::{ImageConfig, RootFs, RuntimeConfig};
use crate::oci::descriptor::Descriptor;
use crate::oci::index::Index;
use crate::oci::manifest::Manifest;
use crate::oci::{to_bytes, RawDocument};

const GOOD: &str = "Bearer good-token";
const PUSH_DENIED: &str = "Bearer push-denied";

/// A fixture authorizer: a valid token is allowed; a special token may pull
/// but not push; anything else is denied; no credential is a 401 challenge.
/// Repository-scope denial is deliberately NOT here — it is the repository
/// store's job, so these tests prove possession is not authorization.
struct TokenAuthorizer;

#[async_trait::async_trait]
impl RegistryAuthorizer for TokenAuthorizer {
    async fn authorize(
        &self,
        credential: Option<&str>,
        _repository: &str,
        action: RegistryAction,
    ) -> Authorization {
        match credential {
            Some(GOOD) => Authorization::Allowed,
            Some(PUSH_DENIED) => {
                if matches!(action, RegistryAction::Pull | RegistryAction::List) {
                    Authorization::Allowed
                } else {
                    Authorization::Denied
                }
            }
            Some(_) => Authorization::Denied,
            None => Authorization::Unauthorized {
                challenge: "Bearer realm=\"http://127.0.0.1/token\",service=\"fixture\""
                    .to_string(),
            },
        }
    }
}

// ---------------------------------------------------------------------------
// OCI document fixtures
// ---------------------------------------------------------------------------

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

fn config_document(diff_ids: Vec<String>) -> RawDocument {
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
            diff_ids,
            extra: Map::new(),
        },
        history: Vec::new(),
        extra: Map::new(),
    };
    RawDocument::from_bytes(to_bytes(&config).unwrap())
}

fn manifest_document(config: &RawDocument, layers: Vec<Descriptor>) -> RawDocument {
    let manifest = Manifest {
        schema_version: 2,
        media_type: Some(MEDIA_TYPE_MANIFEST.to_string()),
        config: descriptor(MEDIA_TYPE_CONFIG, config),
        layers,
        subject: None,
        artifact_type: None,
        annotations: None,
        extra: Map::new(),
    };
    RawDocument::from_bytes(to_bytes(&manifest).unwrap())
}

struct V1Fixture {
    manifest: RawDocument,
    config: RawDocument,
    layer: RawDocument,
}

fn v1_fixture(payload: &[u8]) -> V1Fixture {
    let layer = RawDocument::from_bytes(payload.to_vec());
    let config = config_document(vec![layer.digest().to_string()]);
    let manifest = manifest_document(&config, vec![descriptor(MEDIA_TYPE_EROFS, &layer)]);
    V1Fixture {
        manifest,
        config,
        layer,
    }
}

// ---------------------------------------------------------------------------
// Fixture hosts
// ---------------------------------------------------------------------------

struct ServerHost {
    router: Router,
    blobs: Arc<FsBlobStore>,
    conn: DatabaseConnection,
    _dir: TempDir,
}

async fn server_host(mode: RegistryMode) -> ServerHost {
    let dir = TempDir::new().unwrap();
    let conn = memory_connection().await;
    crate::catalog::migrate(&conn).await.unwrap();
    let blobs_fs = FsBlobStore::new(dir.path().join("cas")).unwrap();
    let blobs = Arc::new(blobs_fs.clone());
    let repos = Arc::new(CatalogRepositoryStore::new(conn.clone(), blobs_fs.clone()));
    let authorizer = Arc::new(TokenAuthorizer);
    let router = match mode {
        RegistryMode::ReadOnly => {
            let service =
                RegistryService::read_only(Arc::clone(&blobs), Arc::clone(&repos), authorizer)
                    .unwrap();
            Arc::new(service).router()
        }
        RegistryMode::ReadWrite => {
            let publisher = Arc::new(CatalogRepositoryPublisher::new(conn.clone(), blobs_fs));
            let service = RegistryService::read_write(
                Arc::clone(&blobs),
                Arc::clone(&repos),
                authorizer,
                publisher,
            )
            .unwrap();
            Arc::new(service).router()
        }
    };
    ServerHost {
        router,
        blobs,
        conn,
        _dir: dir,
    }
}

/// Seed one verified v1 image directly into the CAS + catalog + tag, the way a
/// build publication would, so pull tests start from a published repository.
async fn seed_image(host: &ServerHost, repository: &str, tag: &str, payload: &[u8]) -> V1Fixture {
    let fixture = v1_fixture(payload);
    for (document, kind, media_type) in [
        (&fixture.layer, ObjectKind::Erofs, MEDIA_TYPE_EROFS),
        (&fixture.config, ObjectKind::Config, MEDIA_TYPE_CONFIG),
        (&fixture.manifest, ObjectKind::Manifest, MEDIA_TYPE_MANIFEST),
    ] {
        host.blobs.put_bytes(document.bytes()).unwrap();
        record_object(
            &host.conn,
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
        &host.conn,
        fixture.manifest.digest(),
        fixture.config.digest(),
        "config",
        1,
    )
    .await
    .unwrap();
    record_reference(
        &host.conn,
        fixture.manifest.digest(),
        fixture.layer.digest(),
        "layer",
        1,
    )
    .await
    .unwrap();
    set_tag(
        &host.conn,
        repository,
        tag,
        fixture.manifest.digest(),
        &TagExpectation::Absent,
        1,
    )
    .await
    .unwrap();
    fixture
}

#[cfg(feature = "cache")]
struct AgentHost {
    router: Router,
    blobs: CacheBlobStore,
    repos: Arc<CacheRepositoryStore>,
    _dir: TempDir,
}

#[cfg(feature = "cache")]
struct DurableProbe;
#[cfg(feature = "cache")]
impl StorageProbe for DurableProbe {
    fn mount_type(&self, _path: &std::path::Path) -> anyhow::Result<String> {
        Ok("nfs".to_string())
    }
}

#[cfg(feature = "cache")]
async fn agent_host() -> AgentHost {
    let dir = TempDir::new().unwrap();
    let cache = Arc::new(
        ErofsCache::open_with_probe(dir.path(), "agent-registry", false, &DurableProbe)
            .await
            .unwrap(),
    );
    let blobs = CacheBlobStore::new(Arc::clone(&cache));
    let repos = Arc::new(CacheRepositoryStore::new(cache));
    let service = RegistryService::read_only(
        Arc::new(blobs.clone()),
        Arc::clone(&repos),
        Arc::new(TokenAuthorizer),
    )
    .unwrap();
    let router = Arc::new(service).router();
    AgentHost {
        router,
        blobs,
        repos,
        _dir: dir,
    }
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

async fn send(
    router: &Router,
    method: Method,
    uri: &str,
    auth: Option<&str>,
    extra: &[(&str, &str)],
    body: Vec<u8>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = auth {
        builder = builder.header("authorization", token);
    }
    for (name, value) in extra {
        builder = builder.header(*name, *value);
    }
    let request = builder.body(Body::from(body)).unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, headers, bytes.to_vec())
}

fn error_code(body: &[u8]) -> String {
    let value: serde_json::Value = serde_json::from_slice(body).unwrap();
    value["errors"][0]["code"].as_str().unwrap().to_string()
}

fn header(headers: &HeaderMap, name: &str) -> String {
    headers.get(name).unwrap().to_str().unwrap().to_string()
}

/// Drive the standard chunked blob upload sequence to completion.
async fn upload_blob(router: &Router, repository: &str, bytes: &[u8]) -> String {
    let digest = crate::digest::digest_of_bytes(bytes);
    let (status, headers, _) = send(
        router,
        Method::POST,
        &format!("/v2/{repository}/blobs/uploads/"),
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let location = header(&headers, "location");
    // Two chunks to prove PATCH sequencing.
    let mid = bytes.len() / 2;
    let (status, headers, _) = send(
        router,
        Method::PATCH,
        &location,
        Some(GOOD),
        &[("content-range", &format!("0-{}", mid - 1))],
        bytes[..mid].to_vec(),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let location = header(&headers, "location");
    let (status, _, _) = send(
        router,
        Method::PATCH,
        &location,
        Some(GOOD),
        &[("content-range", &format!("{mid}-{}", bytes.len() - 1))],
        bytes[mid..].to_vec(),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let (status, _, _) = send(
        router,
        Method::PUT,
        &format!("{location}?digest={digest}"),
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    digest
}

// ---------------------------------------------------------------------------
// SC-01: pull surface
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ping_requires_auth_and_advertises_the_api_version() {
    let host = server_host(RegistryMode::ReadWrite).await;
    let (status, headers, body) =
        send(&host.router, Method::GET, "/v2/", None, &[], Vec::new()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(error_code(&body), "UNAUTHORIZED");
    assert!(header(&headers, "www-authenticate").starts_with("Bearer"));

    let (status, headers, _) = send(
        &host.router,
        Method::GET,
        "/v2/",
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        header(&headers, "docker-distribution-api-version"),
        "registry/2.0"
    );
}

#[tokio::test]
async fn manifest_pull_by_tag_and_digest_preserves_bytes_and_identity() {
    let host = server_host(RegistryMode::ReadWrite).await;
    let fixture = seed_image(&host, "team/a", "v1", b"pull payload").await;
    let uri = "/v2/team/a/manifests/v1";
    let (status, headers, body) =
        send(&host.router, Method::GET, uri, Some(GOOD), &[], Vec::new()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, fixture.manifest.bytes());
    assert_eq!(header(&headers, "content-type"), MEDIA_TYPE_MANIFEST);
    assert_eq!(
        header(&headers, "docker-content-digest"),
        fixture.manifest.digest()
    );
    assert_eq!(
        header(&headers, "etag"),
        format!("\"{}\"", fixture.manifest.digest())
    );

    // Immutable digest reference resolves to the same bytes.
    let by_digest = format!("/v2/team/a/manifests/{}", fixture.manifest.digest());
    let (status, _, body) = send(
        &host.router,
        Method::GET,
        &by_digest,
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, fixture.manifest.bytes());

    // HEAD returns the headers with an empty body.
    let (status, headers, body) =
        send(&host.router, Method::HEAD, uri, Some(GOOD), &[], Vec::new()).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.is_empty());
    assert_eq!(
        header(&headers, "docker-content-digest"),
        fixture.manifest.digest()
    );
}

#[tokio::test]
async fn blob_pull_serves_full_and_range_requests() {
    let host = server_host(RegistryMode::ReadWrite).await;
    let payload = b"0123456789abcdef";
    let fixture = seed_image(&host, "team/a", "v1", payload).await;
    let uri = format!("/v2/team/a/blobs/{}", fixture.layer.digest());

    let (status, headers, body) =
        send(&host.router, Method::GET, &uri, Some(GOOD), &[], Vec::new()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, payload);
    assert_eq!(header(&headers, "accept-ranges"), "bytes");
    assert_eq!(
        header(&headers, "docker-content-digest"),
        fixture.layer.digest()
    );

    let (status, headers, body) = send(
        &host.router,
        Method::GET,
        &uri,
        Some(GOOD),
        &[("range", "bytes=0-3")],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(body, b"0123");
    assert_eq!(
        header(&headers, "content-range"),
        format!("bytes 0-3/{}", payload.len())
    );

    // Suffix range.
    let (status, _, body) = send(
        &host.router,
        Method::GET,
        &uri,
        Some(GOOD),
        &[("range", "bytes=-4")],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(body, b"cdef");

    // Unsatisfiable range.
    let (status, headers, _) = send(
        &host.router,
        Method::GET,
        &uri,
        Some(GOOD),
        &[("range", "bytes=999-1000")],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(
        header(&headers, "content-range"),
        format!("bytes */{}", payload.len())
    );
}

#[tokio::test]
async fn index_pull_exposes_child_manifests() {
    let host = server_host(RegistryMode::ReadWrite).await;
    let child = seed_image(&host, "team/index", "child", b"child payload").await;
    let index = Index {
        schema_version: 2,
        media_type: Some(MEDIA_TYPE_INDEX.to_string()),
        manifests: vec![descriptor(MEDIA_TYPE_MANIFEST, &child.manifest)],
        annotations: None,
        extra: Map::new(),
    };
    let index = RawDocument::from_bytes(to_bytes(&index).unwrap());
    host.blobs.put_bytes(index.bytes()).unwrap();
    record_object(
        &host.conn,
        &StoredObject {
            digest: index.digest().to_string(),
            media_type: MEDIA_TYPE_INDEX.to_string(),
            size_bytes: index.size().unwrap(),
            kind: ObjectKind::Index,
        },
        1,
    )
    .await
    .unwrap();
    record_reference(
        &host.conn,
        index.digest(),
        child.manifest.digest(),
        "index-child",
        1,
    )
    .await
    .unwrap();
    set_tag(
        &host.conn,
        "team/index",
        "latest",
        index.digest(),
        &TagExpectation::Absent,
        1,
    )
    .await
    .unwrap();

    let (status, headers, body) = send(
        &host.router,
        Method::GET,
        "/v2/team/index/manifests/latest",
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, index.bytes());
    assert_eq!(header(&headers, "content-type"), MEDIA_TYPE_INDEX);
    // The child Manifest resolves by digest through the Index tag.
    let (status, _, _) = send(
        &host.router,
        Method::GET,
        &format!("/v2/team/index/manifests/{}", child.manifest.digest()),
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn content_negotiation_refuses_an_unacceptable_media_type() {
    let host = server_host(RegistryMode::ReadWrite).await;
    seed_image(&host, "team/a", "v1", b"negotiated payload").await;
    let (status, _, body) = send(
        &host.router,
        Method::GET,
        "/v2/team/a/manifests/v1",
        Some(GOOD),
        &[(
            "accept",
            "application/vnd.docker.distribution.manifest.v2+json",
        )],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error_code(&body), "MANIFEST_UNKNOWN");
    // A wildcard Accept is satisfied.
    let (status, _, _) = send(
        &host.router,
        Method::GET,
        "/v2/team/a/manifests/v1",
        Some(GOOD),
        &[("accept", "*/*")],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn oci_errors_use_the_distribution_error_shape() {
    let host = server_host(RegistryMode::ReadWrite).await;
    seed_image(&host, "team/a", "v1", b"error payload").await;
    let (status, _, body) = send(
        &host.router,
        Method::GET,
        "/v2/team/a/manifests/absent",
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error_code(&body), "MANIFEST_UNKNOWN");

    let absent = crate::digest::digest_of_bytes(b"not a blob here");
    let (status, _, body) = send(
        &host.router,
        Method::GET,
        &format!("/v2/team/a/blobs/{absent}"),
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error_code(&body), "BLOB_UNKNOWN");

    let (status, _, body) = send(
        &host.router,
        Method::GET,
        "/v2/INVALID/manifests/v1",
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), "NAME_INVALID");
}

#[tokio::test]
async fn tags_list_paginates_with_a_link_header() {
    let host = server_host(RegistryMode::ReadWrite).await;
    for tag in ["v1", "v2", "v3"] {
        seed_image(&host, "team/a", tag, format!("payload {tag}").as_bytes()).await;
    }
    let (status, _, body) = send(
        &host.router,
        Method::GET,
        "/v2/team/a/tags/list",
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["name"], "team/a");
    assert_eq!(value["tags"], serde_json::json!(["v1", "v2", "v3"]));

    let (status, headers, body) = send(
        &host.router,
        Method::GET,
        "/v2/team/a/tags/list?n=2",
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["tags"], serde_json::json!(["v1", "v2"]));
    assert!(header(&headers, "link").contains("rel=\"next\""));
    let (status, _, body) = send(
        &host.router,
        Method::GET,
        "/v2/team/a/tags/list?n=2&last=v2",
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["tags"], serde_json::json!(["v3"]));
}

// ---------------------------------------------------------------------------
// SC-02: push surface
// ---------------------------------------------------------------------------

#[tokio::test]
async fn chunked_upload_and_manifest_push_roundtrip_preserves_identity() {
    let host = server_host(RegistryMode::ReadWrite).await;
    let fixture = v1_fixture(b"pushed payload bytes");
    // Upload config and layer through the standard Distribution sequence.
    let layer_digest = upload_blob(&host.router, "team/push", fixture.layer.bytes()).await;
    let config_digest = upload_blob(&host.router, "team/push", fixture.config.bytes()).await;
    assert_eq!(layer_digest, fixture.layer.digest());
    assert_eq!(config_digest, fixture.config.digest());

    // Push the Manifest by tag.
    let (status, headers, _) = send(
        &host.router,
        Method::PUT,
        "/v2/team/push/manifests/v1",
        Some(GOOD),
        &[("content-type", MEDIA_TYPE_MANIFEST)],
        fixture.manifest.bytes().to_vec(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        header(&headers, "docker-content-digest"),
        fixture.manifest.digest()
    );

    // Readback matches the original object digests and exact bytes.
    let (status, _, body) = send(
        &host.router,
        Method::GET,
        "/v2/team/push/manifests/v1",
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, fixture.manifest.bytes());
    let (status, _, body) = send(
        &host.router,
        Method::GET,
        &format!("/v2/team/push/blobs/{layer_digest}"),
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, fixture.layer.bytes());
}

#[tokio::test]
async fn monolithic_post_upload_publishes_in_one_request() {
    let host = server_host(RegistryMode::ReadWrite).await;
    let payload = b"monolithic blob";
    let digest = crate::digest::digest_of_bytes(payload);
    let (status, headers, _) = send(
        &host.router,
        Method::POST,
        &format!("/v2/team/push/blobs/uploads/?digest={digest}"),
        Some(GOOD),
        &[],
        payload.to_vec(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(header(&headers, "docker-content-digest"), digest);
    assert!(host.blobs.contains(&digest).unwrap());
}

#[tokio::test]
async fn manifest_push_rejects_a_missing_referenced_blob_without_a_visible_tag() {
    let host = server_host(RegistryMode::ReadWrite).await;
    let fixture = v1_fixture(b"never uploaded layer");
    // Only the config is uploaded; the layer is absent.
    upload_blob(&host.router, "team/push", fixture.config.bytes()).await;
    let (status, _, body) = send(
        &host.router,
        Method::PUT,
        "/v2/team/push/manifests/v1",
        Some(GOOD),
        &[("content-type", MEDIA_TYPE_MANIFEST)],
        fixture.manifest.bytes().to_vec(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), "MANIFEST_BLOB_UNKNOWN");
    // No tag became visible.
    let (status, _, _) = send(
        &host.router,
        Method::GET,
        "/v2/team/push/manifests/v1",
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn upload_completion_rejects_a_tampered_digest_claim() {
    let host = server_host(RegistryMode::ReadWrite).await;
    let payload = b"honest bytes";
    let wrong = crate::digest::digest_of_bytes(b"different bytes");
    let (status, headers, _) = send(
        &host.router,
        Method::POST,
        "/v2/team/push/blobs/uploads/",
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let location = header(&headers, "location");
    let (status, _, _) = send(
        &host.router,
        Method::PUT,
        &format!("{location}?digest={wrong}"),
        Some(GOOD),
        &[],
        payload.to_vec(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // The dishonest object was never published under either digest.
    assert!(!host.blobs.contains(&wrong).unwrap());
    assert!(!host
        .blobs
        .contains(&crate::digest::digest_of_bytes(payload))
        .unwrap());
}

#[tokio::test]
async fn manifest_push_by_digest_rejects_mismatched_bytes() {
    let host = server_host(RegistryMode::ReadWrite).await;
    let fixture = v1_fixture(b"digest referenced payload");
    upload_blob(&host.router, "team/push", fixture.layer.bytes()).await;
    upload_blob(&host.router, "team/push", fixture.config.bytes()).await;
    let wrong_digest = crate::digest::digest_of_bytes(b"not the manifest");
    let (status, _, body) = send(
        &host.router,
        Method::PUT,
        &format!("/v2/team/push/manifests/{wrong_digest}"),
        Some(GOOD),
        &[("content-type", MEDIA_TYPE_MANIFEST)],
        fixture.manifest.bytes().to_vec(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&body), "DIGEST_INVALID");
}

#[tokio::test]
async fn cross_repository_mount_reuses_an_exposed_blob() {
    let host = server_host(RegistryMode::ReadWrite).await;
    let fixture = seed_image(&host, "team/source", "v1", b"mountable payload").await;
    let (status, headers, _) = send(
        &host.router,
        Method::POST,
        &format!(
            "/v2/team/target/blobs/uploads/?mount={}&from=team/source",
            fixture.layer.digest()
        ),
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        header(&headers, "docker-content-digest"),
        fixture.layer.digest()
    );
}

#[tokio::test]
async fn tag_push_moves_atomically_within_the_tag_rooted_fence() {
    let host = server_host(RegistryMode::ReadWrite).await;
    let first = v1_fixture(b"first revision");
    let second = v1_fixture(b"second revision");
    for fixture in [&first, &second] {
        upload_blob(&host.router, "team/push", fixture.layer.bytes()).await;
        upload_blob(&host.router, "team/push", fixture.config.bytes()).await;
        let (status, _, _) = send(
            &host.router,
            Method::PUT,
            "/v2/team/push/manifests/latest",
            Some(GOOD),
            &[("content-type", MEDIA_TYPE_MANIFEST)],
            fixture.manifest.bytes().to_vec(),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
    }
    // The tag now resolves to the second revision, by tag and by digest.
    let (status, _, body) = send(
        &host.router,
        Method::GET,
        "/v2/team/push/manifests/latest",
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, second.manifest.bytes());
    let (status, _, body) = send(
        &host.router,
        Method::GET,
        &format!("/v2/team/push/manifests/{}", second.manifest.digest()),
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, second.manifest.bytes());
    // The first revision left the repository's Tag root: the #4087
    // reachability fence hides it even though its bytes remain in the CAS.
    let (status, _, _) = send(
        &host.router,
        Method::GET,
        &format!("/v2/team/push/manifests/{}", first.manifest.digest()),
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(host.blobs.contains(first.manifest.digest()).unwrap());
}

#[tokio::test]
async fn push_without_a_credential_is_challenged_and_a_denied_token_is_forbidden() {
    let host = server_host(RegistryMode::ReadWrite).await;
    let (status, _, _) = send(
        &host.router,
        Method::POST,
        "/v2/team/push/blobs/uploads/",
        None,
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _, body) = send(
        &host.router,
        Method::POST,
        "/v2/team/push/blobs/uploads/",
        Some(PUSH_DENIED),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&body), "DENIED");
    // The same denied token may still pull.
    seed_image(&host, "team/push", "v1", b"readable").await;
    let (status, _, _) = send(
        &host.router,
        Method::GET,
        "/v2/team/push/manifests/v1",
        Some(PUSH_DENIED),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

// ---------------------------------------------------------------------------
// SC-03: read-only mode and repository-scope authorization
// ---------------------------------------------------------------------------

#[tokio::test]
async fn read_only_mode_denies_every_mutation_verb_even_with_a_push_credential() {
    let host = server_host(RegistryMode::ReadOnly).await;
    seed_image(&host, "team/a", "v1", b"read only payload").await;
    let mutations = [
        (Method::POST, "/v2/team/a/blobs/uploads/"),
        (Method::PUT, "/v2/team/a/manifests/v2"),
        (Method::PATCH, "/v2/team/a/blobs/uploads/some-session"),
        (
            Method::PUT,
            "/v2/team/a/blobs/uploads/some-session?digest=x",
        ),
        (Method::DELETE, "/v2/team/a/blobs/uploads/some-session"),
    ];
    for (method, uri) in mutations {
        let (status, headers, body) = send(
            &host.router,
            method.clone(),
            uri,
            Some(GOOD),
            &[],
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "{method} {uri}");
        assert_eq!(error_code(&body), "UNSUPPORTED");
        assert_eq!(header(&headers, "allow"), "GET, HEAD");
    }
    // Pull still works in read-only mode.
    let (status, _, _) = send(
        &host.router,
        Method::GET,
        "/v2/team/a/manifests/v1",
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn cross_repository_blob_and_manifest_access_is_denied_despite_local_bytes() {
    let host = server_host(RegistryMode::ReadWrite).await;
    let a = seed_image(&host, "team/a", "v1", b"repository A secret").await;
    let b = seed_image(&host, "team/b", "v1", b"repository B secret").await;
    // B's objects are physically in the shared CAS.
    assert!(host.blobs.contains(b.layer.digest()).unwrap());
    assert!(host.blobs.contains(b.manifest.digest()).unwrap());
    // Through repository A they are invisible.
    let (status, _, body) = send(
        &host.router,
        Method::GET,
        &format!("/v2/team/a/blobs/{}", b.layer.digest()),
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error_code(&body), "BLOB_UNKNOWN");
    let (status, _, body) = send(
        &host.router,
        Method::GET,
        &format!("/v2/team/a/manifests/{}", b.manifest.digest()),
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error_code(&body), "MANIFEST_UNKNOWN");
    // A's own objects remain readable.
    let (status, _, _) = send(
        &host.router,
        Method::GET,
        &format!("/v2/team/a/blobs/{}", a.layer.digest()),
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[cfg(feature = "cache")]
#[tokio::test]
async fn agent_like_cache_host_serves_pull_and_denies_push() {
    let host = agent_host().await;
    let fixture = v1_fixture(b"agent cached payload");
    for document in [&fixture.manifest, &fixture.config, &fixture.layer] {
        host.blobs.put_bytes(document.bytes()).unwrap();
    }
    host.repos
        .register_tag("team/agent", "v1", fixture.manifest.digest())
        .unwrap();

    // Pull works over the Agent's verified cache contracts.
    let (status, _, body) = send(
        &host.router,
        Method::GET,
        "/v2/team/agent/manifests/v1",
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, fixture.manifest.bytes());
    let (status, _, body) = send(
        &host.router,
        Method::GET,
        &format!("/v2/team/agent/blobs/{}", fixture.layer.digest()),
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, fixture.layer.bytes());

    // The Agent registry is read-only: push is denied even with a credential.
    let (status, _, _) = send(
        &host.router,
        Method::POST,
        "/v2/team/agent/blobs/uploads/",
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);

    // An unregistered digest in the same cache is not exposed.
    let other = v1_fixture(b"unregistered agent bytes");
    host.blobs.put_bytes(other.layer.bytes()).unwrap();
    let (status, _, _) = send(
        &host.router,
        Method::GET,
        &format!("/v2/team/agent/blobs/{}", other.layer.digest()),
        Some(GOOD),
        &[],
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
