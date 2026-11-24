//! Server host adapter for the shared OCI Registry service (#4090).
//!
//! The Server mounts the common [`RegistryService`] (#4088) on its existing
//! Axum ingress, backed by its own CAS ([`FsBlobStore`]), Catalog
//! ([`CatalogRepositoryStore`]/[`CatalogRepositoryPublisher`]) and identity
//! authority ([`ServerRegistryAuthorizer`] over the configured Server Token).
//! It owns no second authorization state machine and opens no second database:
//! the service reads reachability and publishes pushes through the same
//! connection the Image Manager already owns.
//!
//! External import reuses the common SDK adapter [`pull_image`] (#4089): the
//! Server-owned [`RegistryImportAuthorizer`] decides origin/credential scope
//! before any network request or catalog write, and a denied import never
//! reaches the remote registry or exposes a credential.
//!
//! # Compatibility window and cutover criterion
//!
//! The proprietary `/images/blobs/{digest}` route ([`super::http`]) stays
//! mounted alongside `/v2/` for the bounded compatibility window. Both serve the
//! same verified CAS bytes; `/v2/` adds repository-scoped reachability so
//! possessing a digest is never authorization. Since the #4250 cutover a
//! Tag-reachable catalog image acquires through `/v2/` only; untagged builds and
//! digest-only legacy rows keep the proprietary route as a documented bounded
//! compatibility obligation.
//!
//! The mount is gated by the protected operator toggle
//! `ServerConfig::legacy_blob_route` (default `true`), applied by the Server
//! ingress `http_router`. Setting it to `false` is the staged removal: the
//! proprietary route is unmounted, a migrated client holding only `/v2/` grants
//! is unaffected, and a caller still asking for `/images/blobs/{digest}` gets a
//! 404. Flipping it back to `true` is the fail-closed rollback — the supported
//! legacy reader returns without relaxing the Server Token or digest checks. The
//! toggle deletes no durable blob and rewrites no Manifest identity. The #4250
//! SC-03 staging Case proves the removal negatives, persistent Agent cache and
//! active-mount preservation, and the fail-closed rollback against the real
//! `http_router`.

use std::sync::Arc;

use anyhow::Result;
use sea_orm::DatabaseConnection;

use nession_erofs::blob::store::FsBlobStore;
use nession_erofs::catalog::{CatalogRepositoryPublisher, CatalogRepositoryStore};
use nession_erofs::registry::auth::RegistryImportAuthorizer;
use nession_erofs::registry::service::{
    Authorization, RegistryAction, RegistryAuthorizer, RegistryService,
};
use nession_erofs::registry::{pull_image, ImportOutcome, ImportRequest, RegistryClient};
use nession_protocol::TokenVerifier;

use super::ImageManager;

/// The concrete Server Registry service: a writable `/v2/` endpoint over the
/// Server's CAS, Catalog reachability, Token identity and Catalog publisher.
pub type ServerRegistry = RegistryService<
    FsBlobStore,
    CatalogRepositoryStore<DatabaseConnection>,
    ServerRegistryAuthorizer,
    CatalogRepositoryPublisher,
>;

/// The Server's identity adapter for the mounted Registry service (#4090).
///
/// It honours the same configured Server Token as the proprietary blob route
/// and the WebSocket ingress: an empty token keeps the documented no-auth mode;
/// a configured token must be presented as a `Bearer` credential and verified
/// in constant time. Repository-scope reachability is deliberately NOT here —
/// it is the [`CatalogRepositoryStore`]'s job, so possessing a digest is never
/// authorization. The adapter fails closed: a missing credential is a 401
/// challenge, a known-but-invalid credential is 403, and only a verified
/// credential is allowed.
#[derive(Clone)]
pub struct ServerRegistryAuthorizer {
    auth: TokenVerifier,
}

impl ServerRegistryAuthorizer {
    pub fn new(auth: TokenVerifier) -> Self {
        Self { auth }
    }
}

#[async_trait::async_trait]
impl RegistryAuthorizer for ServerRegistryAuthorizer {
    async fn authorize(
        &self,
        credential: Option<&str>,
        _repository: &str,
        _action: RegistryAction,
    ) -> Authorization {
        // No-auth mode parity with the proprietary route and WebSocket ingress.
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

/// Extract the token from an exact `Authorization` header value.
///
/// The service hands the adapter the whole header (scheme included). Only a
/// `Bearer` scheme is accepted; any other shape fails closed to `None` so the
/// caller answers a challenge rather than guessing a credential.
fn bearer_token(credential: &str) -> Option<&str> {
    let value = credential.trim();
    value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
        .map(str::trim)
        .filter(|token| !token.is_empty())
}

/// Mount the Server's writable `/v2/` Registry over its own CAS and Catalog.
///
/// This is the composition the Server ingress merges into its router. It is
/// separated from [`build_registry`] so the adapter can be exercised over a
/// fixture CAS/connection without constructing a full Image Manager.
pub fn mount_registry(
    blobs: FsBlobStore,
    conn: DatabaseConnection,
    auth: TokenVerifier,
) -> Result<Arc<ServerRegistry>> {
    let repositories = CatalogRepositoryStore::new(conn.clone(), blobs.clone());
    let publisher = CatalogRepositoryPublisher::new(conn, blobs.clone());
    let authorizer = ServerRegistryAuthorizer::new(auth);
    let service = RegistryService::read_write(
        Arc::new(blobs),
        Arc::new(repositories),
        Arc::new(authorizer),
        Arc::new(publisher),
    )?;
    Ok(Arc::new(service))
}

/// Build the Server Registry service from the Image Manager's owned resources.
pub fn build_registry(manager: &ImageManager, auth: TokenVerifier) -> Result<Arc<ServerRegistry>> {
    mount_registry(manager.blob_store().clone(), manager.connection(), auth)
}

/// Import one external OCI image into the Server's authoritative CAS/Catalog.
///
/// The Server-owned `authorizer` decides origin/credential scope before any
/// network access; the common SDK adapter [`pull_image`] resolves the immutable
/// identity, verifies the closure and atomically publishes the local tag. The
/// returned [`ImportOutcome`] carries only local digests — never a registry
/// credential, token or URL — so it projects safely to an Agent grant.
pub async fn import_registry_image(
    manager: &ImageManager,
    client: &RegistryClient,
    request: &ImportRequest,
    authorizer: &dyn RegistryImportAuthorizer,
    now: i64,
) -> nession_erofs::registry::RegistryResult<ImportOutcome> {
    pull_image(
        client,
        &manager.connection(),
        manager.blob_store(),
        request,
        authorizer,
        now,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{HeaderMap, Method, Request, StatusCode};
    use axum::Router;
    use http_body_util::BodyExt;
    use nession_erofs::catalog::reference::{
        record_object, record_reference, ObjectKind, StoredObject,
    };
    use nession_erofs::catalog::tag::{set_tag, TagExpectation};
    use nession_erofs::oci::annotation::{
        MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_MANIFEST,
    };
    use nession_erofs::oci::config::{ImageConfig, RootFs, RuntimeConfig};
    use nession_erofs::oci::descriptor::{Descriptor, Platform};
    use nession_erofs::oci::manifest::Manifest;
    use nession_erofs::oci::{to_bytes, RawDocument};
    use nession_erofs::registry::auth::NoCredentials;
    use nession_erofs::registry::auth::{
        AllowAllImports, DenyAllImports, ImportScope, RegistryImportAuthorizer,
    };
    use nession_erofs::registry::client::{RegistryClient, RegistryConfig};
    use nession_erofs::registry::service::RegistryService;
    use nession_erofs::registry::{RegistryError, RemoteReference};
    use serde_json::Map;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::TempDir;
    use tower::ServiceExt;

    const TOKEN: &str = "server-registry-token";

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

    async fn memory_catalog() -> (TempDir, FsBlobStore, DatabaseConnection) {
        let dir = TempDir::new().unwrap();
        let store = FsBlobStore::new(dir.path().join("cas")).unwrap();
        let conn = sea_orm::Database::connect("sqlite::memory:").await.unwrap();
        nession_erofs::catalog::migrate(&conn).await.unwrap();
        (dir, store, conn)
    }

    async fn seed(
        conn: &DatabaseConnection,
        store: &FsBlobStore,
        repository: &str,
        tag: &str,
        fixture: &Fixture,
    ) {
        for (document, kind, media_type) in [
            (&fixture.layer, ObjectKind::Erofs, MEDIA_TYPE_EROFS),
            (&fixture.config, ObjectKind::Config, MEDIA_TYPE_CONFIG),
            (&fixture.manifest, ObjectKind::Manifest, MEDIA_TYPE_MANIFEST),
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
        record_reference(
            conn,
            fixture.manifest.digest(),
            fixture.config.digest(),
            "config",
            1,
        )
        .await
        .unwrap();
        record_reference(
            conn,
            fixture.manifest.digest(),
            fixture.layer.digest(),
            "layer",
            1,
        )
        .await
        .unwrap();
        set_tag(
            conn,
            repository,
            tag,
            fixture.manifest.digest(),
            &TagExpectation::Absent,
            1,
        )
        .await
        .unwrap();
    }

    async fn send(
        router: &Router,
        method: Method,
        uri: &str,
        auth: Option<&str>,
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = auth {
            builder = builder.header("authorization", token);
        }
        let request = builder.body(Body::empty()).unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, headers, bytes.to_vec())
    }

    fn header(headers: &HeaderMap, name: &str) -> String {
        headers.get(name).unwrap().to_str().unwrap().to_string()
    }

    fn target_platform() -> Platform {
        Platform {
            architecture: "amd64".to_string(),
            os: "linux".to_string(),
            os_features: Some(vec!["erofs".to_string()]),
            ..Platform::default()
        }
    }

    /// A Server-owned import policy scoped to approved local prefixes and origin
    /// authorities. Fails closed: an unapproved local repository or origin is
    /// denied before the SDK touches the network or a credential.
    struct ScopedImport {
        local_prefix: String,
        authority: nession_erofs::registry::RegistryAuthority,
    }

    impl RegistryImportAuthorizer for ScopedImport {
        fn authorize_import(
            &self,
            scope: &ImportScope<'_>,
        ) -> nession_erofs::registry::RegistryResult<()> {
            if scope.local_repository.starts_with(&self.local_prefix)
                && scope.authority == &self.authority
            {
                Ok(())
            } else {
                Err(RegistryError::ImportDenied(
                    scope.local_repository.to_string(),
                ))
            }
        }
    }

    /// An external authorizer that counts every decision so a denied import can
    /// be proven to never reach the remote registry.
    struct CountingAuthorizer {
        calls: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl RegistryAuthorizer for CountingAuthorizer {
        async fn authorize(
            &self,
            _credential: Option<&str>,
            _repository: &str,
            _action: RegistryAction,
        ) -> Authorization {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Authorization::Allowed
        }
    }

    async fn serve_loopback(router: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (format!("http://{addr}"), handle)
    }

    #[tokio::test]
    async fn sc01_server_mount_serves_verified_objects_and_fails_closed() {
        let (_dir, store, conn) = memory_catalog().await;
        let fixture = v1_fixture(b"server registry mount layer");
        seed(&conn, &store, "tenant/app", "v1", &fixture).await;
        let registry =
            mount_registry(store.clone(), conn.clone(), TokenVerifier::new(TOKEN)).unwrap();
        let router = registry.router();

        // Identity is fail-closed: no credential challenges, a bad token denies.
        let (status, _, _) = send(&router, Method::GET, "/v2/", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _, _) = send(&router, Method::GET, "/v2/", Some("Bearer wrong")).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _, _) = send(
            &router,
            Method::GET,
            "/v2/",
            Some(&format!("Bearer {TOKEN}")),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let good = format!("Bearer {TOKEN}");
        // Manifest by tag: exact bytes and the immutable digest header.
        let (status, headers, body) = send(
            &router,
            Method::GET,
            "/v2/tenant/app/manifests/v1",
            Some(&good),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, fixture.manifest.bytes());
        assert_eq!(
            header(&headers, "docker-content-digest"),
            fixture.manifest.digest()
        );

        // The verified EROFS blob is served by its digest within the repository.
        let (status, _, body) = send(
            &router,
            Method::GET,
            &format!("/v2/tenant/app/blobs/{}", fixture.layer.digest()),
            Some(&good),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, fixture.layer.bytes());

        // Possession is not authorization: a foreign repository denies the same
        // digest even though the bytes share one CAS.
        let (status, _, _) = send(
            &router,
            Method::GET,
            &format!("/v2/other/app/blobs/{}", fixture.layer.digest()),
            Some(&good),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // The tag list exposes the published repository tag.
        let (status, _, body) = send(
            &router,
            Method::GET,
            "/v2/tenant/app/tags/list",
            Some(&good),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["name"], "tenant/app");
        assert!(value["tags"].as_array().unwrap().iter().any(|t| t == "v1"));

        println!(
            "#4090 SC-01 measured: Server /v2/ mount no-cred->401 bad-token->403 good->200; \
             manifest v1 -> 200 digest {} ({} bytes); EROFS blob -> 200 exact bytes; \
             foreign repository blob -> 404; tags/list exposes v1",
            fixture.manifest.digest(),
            fixture.manifest.bytes().len(),
        );
    }

    #[tokio::test]
    async fn sc01_server_import_persists_immutable_identity_and_denies_before_network() {
        // An approved external OCI provider, served on loopback and seeded with
        // one verified image. Its authorizer counts decisions so a denied import
        // can be proven to never reach it.
        let (_ext_dir, ext_store, ext_conn) = memory_catalog().await;
        let fixture = v1_fixture(b"external provider layer");
        seed(&ext_conn, &ext_store, "team/app", "v1", &fixture).await;
        let counting = Arc::new(CountingAuthorizer {
            calls: AtomicUsize::new(0),
        });
        let ext_repos = Arc::new(CatalogRepositoryStore::new(
            ext_conn.clone(),
            ext_store.clone(),
        ));
        let ext_publisher = Arc::new(CatalogRepositoryPublisher::new(
            ext_conn.clone(),
            ext_store.clone(),
        ));
        let ext_service = Arc::new(
            RegistryService::read_write(
                Arc::new(ext_store.clone()),
                ext_repos,
                Arc::clone(&counting),
                ext_publisher,
            )
            .unwrap(),
        );
        let (base, server) = serve_loopback(ext_service.router()).await;
        let client =
            RegistryClient::new(RegistryConfig::new(&base).unwrap(), Arc::new(NoCredentials))
                .unwrap();

        // The Server's authoritative CAS/Catalog and mounted /v2/ endpoint.
        let (_dir, store, conn) = memory_catalog().await;
        let registry =
            mount_registry(store.clone(), conn.clone(), TokenVerifier::new(TOKEN)).unwrap();
        let router = registry.router();

        let request = ImportRequest {
            repository: "team/app".to_string(),
            reference: RemoteReference::Tag("v1".to_string()),
            platform: target_platform(),
            local_repository: "tenant/app".to_string(),
            local_tag: "v1".to_string(),
            expectation: TagExpectation::Absent,
        };
        let scoped = ScopedImport {
            local_prefix: "tenant/".to_string(),
            authority: client.authority().clone(),
        };
        let outcome = pull_image(&client, &conn, &store, &request, &scoped, 1)
            .await
            .unwrap();
        assert_eq!(outcome.manifest_digest, fixture.manifest.digest());
        assert_eq!(outcome.config_digest, fixture.config.digest());
        assert_eq!(outcome.layer_digest, fixture.layer.digest());
        assert_eq!(
            store.read(fixture.layer.digest()).unwrap(),
            fixture.layer.bytes()
        );
        assert_eq!(store.usage().unwrap().blobs, 3);

        // The imported image is served by the Server's standard /v2/ endpoint.
        let good = format!("Bearer {TOKEN}");
        let (status, _, body) = send(
            &router,
            Method::GET,
            "/v2/tenant/app/manifests/v1",
            Some(&good),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, fixture.manifest.bytes());

        // A denied import (unapproved local scope) fails before the network: the
        // external provider sees no request and the Server catalog gains no tag.
        counting.calls.store(0, Ordering::SeqCst);
        let denied_request = ImportRequest {
            local_repository: "foreign/app".to_string(),
            expectation: TagExpectation::Absent,
            ..request.clone()
        };
        let error = pull_image(&client, &conn, &store, &denied_request, &scoped, 2)
            .await
            .expect_err("unapproved local scope");
        assert!(matches!(error, RegistryError::ImportDenied(_)));
        assert_eq!(
            counting.calls.load(Ordering::SeqCst),
            0,
            "denial precedes the network"
        );
        assert!(
            nession_erofs::catalog::tag::get_tag(&conn, "foreign/app", "v1")
                .await
                .unwrap()
                .is_none()
        );

        // The fail-closed default authorizer also denies before any write.
        let error = pull_image(&client, &conn, &store, &request, &DenyAllImports, 3)
            .await
            .expect_err("deny-all");
        assert!(matches!(error, RegistryError::ImportDenied(_)));

        // An approved import is idempotent: a warm re-import adds no physical blob.
        let mut repeat = request.clone();
        repeat.expectation = TagExpectation::Exact(fixture.manifest.digest().to_string());
        let repeated = pull_image(&client, &conn, &store, &repeat, &AllowAllImports, 4)
            .await
            .unwrap();
        assert_eq!(repeated.manifest_digest, fixture.manifest.digest());
        assert_eq!(store.usage().unwrap().blobs, 3);

        server.abort();
        println!(
            "#4090 SC-01 measured: external loopback import manifest/config/layer digests equal \
             originals ({}) with 3 physical blobs; Server /v2/ serves the imported manifest; \
             unapproved scope and deny-all both ImportDenied with 0 external requests and no tag; \
             warm re-import keeps 3 blobs",
            fixture.manifest.digest(),
        );
    }

    #[tokio::test]
    async fn sc01_no_auth_mode_parity_with_proprietary_route() {
        // An empty Server Token keeps the documented no-auth mode, exactly as the
        // proprietary blob route and WebSocket ingress do.
        let (_dir, store, conn) = memory_catalog().await;
        let fixture = v1_fixture(b"no-auth mode layer");
        seed(&conn, &store, "tenant/app", "v1", &fixture).await;
        let registry = mount_registry(store.clone(), conn.clone(), TokenVerifier::new("")).unwrap();
        let router = registry.router();
        let (status, _, body) =
            send(&router, Method::GET, "/v2/tenant/app/manifests/v1", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, fixture.manifest.bytes());

        // The compatibility window: the proprietary route pattern still names the
        // same CAS digest the /v2/ endpoint serves, so both paths coexist.
        let proprietary = format!(
            "{}{}",
            nession_protocol::contracts::image::v1::IMAGE_BLOB_PATH_PREFIX,
            fixture.layer.digest()
        );
        assert_eq!(
            proprietary,
            format!("/images/blobs/{}", fixture.layer.digest())
        );
        let (status, _, body) = send(
            &router,
            Method::GET,
            &format!("/v2/tenant/app/blobs/{}", fixture.layer.digest()),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, store.read(fixture.layer.digest()).unwrap());

        println!(
            "#4090 SC-01 measured: no-auth mode serves manifest v1 without a credential; \
             proprietary route {} and /v2/ blob serve the same CAS digest {} during the \
             compatibility window",
            proprietary,
            fixture.layer.digest(),
        );
    }
}
