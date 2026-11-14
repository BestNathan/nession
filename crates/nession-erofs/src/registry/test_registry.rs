//! A disposable in-process OCI Distribution registry for deterministic tests.
//!
//! It is test-only: no network, no external credentials, a loopback ephemeral
//! port and explicit state injection for each failure mode.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use axum::body::{to_bytes, Body};
use axum::extract::State;
use axum::http::{header, HeaderMap, Method, Request, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;
use base64::Engine;
use futures_util::stream;
use serde_json::json;
use tokio::net::TcpListener;

use super::client::{RegistryClient, RegistryConfig};
use super::RegistryAuthority;
use crate::digest::digest_of_bytes;

pub(crate) const USERNAME: &str = "robot";
pub(crate) const PASSWORD: &str = "super-secret-value";
pub(crate) const TOKEN: &str = "mock-registry-token";

#[derive(Debug, Clone, Default)]
pub(crate) struct TokenRequest {
    pub service: Option<String>,
    pub scope: Option<String>,
    pub has_basic: bool,
    pub basic_valid: bool,
}

#[derive(Debug, Clone)]
struct StoredManifest {
    media_type: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
struct Upload {
    repository: String,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct Inner {
    blobs: HashMap<String, Vec<u8>>,
    manifests: HashMap<(String, String), StoredManifest>,
    tags: HashMap<(String, String), String>,
    uploads: HashMap<String, Upload>,
    next_upload: u64,
    private_repositories: HashSet<String>,
    forbidden_repositories: HashSet<String>,
    token_requires_basic: bool,
    token_forbidden: bool,
    basic_challenge: bool,
    auth_realm_override: Option<String>,
    challenge_scope_repository: Option<String>,
    token_requests: Vec<TokenRequest>,
    requests: Vec<String>,
    authorization_headers: Vec<Option<String>>,
    tamper_blob: Option<String>,
    interrupt_blob: Option<String>,
    fail_finish_upload: bool,
    redirect_manifest_to: Option<String>,
    oversized_manifest: bool,
    blob_media_type: Option<String>,
    cross_host_upload_location: bool,
}

#[derive(Clone)]
struct Shared {
    inner: Arc<Mutex<Inner>>,
    base: String,
}

/// One disposable registry instance bound to a loopback ephemeral port.
#[derive(Clone)]
pub(crate) struct MockRegistry {
    shared: Shared,
}

impl MockRegistry {
    pub async fn start() -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind the mock registry");
        let address = listener.local_addr().expect("mock registry address");
        let shared = Shared {
            inner: Arc::new(Mutex::new(Inner::default())),
            base: format!("http://127.0.0.1:{}", address.port()),
        };
        let app = Router::new()
            .route("/token", get(token_handler))
            .fallback(any(handle))
            .with_state(shared.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self { shared }
    }

    pub fn base_url(&self) -> String {
        self.shared.base.clone()
    }

    pub fn config(&self) -> RegistryConfig {
        RegistryConfig::new(self.base_url()).expect("valid mock registry URL")
    }

    pub fn authority(&self) -> RegistryAuthority {
        RegistryAuthority {
            scheme: "http".to_string(),
            host: "127.0.0.1".to_string(),
            port: self
                .shared
                .base
                .rsplit_once(':')
                .and_then(|(_, port)| port.parse().ok())
                .expect("mock port"),
        }
    }

    pub fn client(&self) -> RegistryClient {
        RegistryClient::new(self.config(), Arc::new(super::auth::NoCredentials))
            .expect("mock registry client")
    }

    pub fn client_with(
        &self,
        credentials: Arc<dyn super::auth::RegistryCredentialProvider>,
    ) -> RegistryClient {
        RegistryClient::new(self.config(), credentials).expect("mock registry client")
    }

    pub fn client_with_config(
        &self,
        config: RegistryConfig,
        credentials: Arc<dyn super::auth::RegistryCredentialProvider>,
    ) -> RegistryClient {
        RegistryClient::new(config, credentials).expect("mock registry client")
    }

    pub fn seed_blob(&self, bytes: &[u8]) -> String {
        let digest = digest_of_bytes(bytes);
        self.lock().blobs.insert(digest.clone(), bytes.to_vec());
        digest
    }

    pub fn seed_manifest(&self, repository: &str, media_type: &str, bytes: &[u8]) -> String {
        let digest = digest_of_bytes(bytes);
        self.lock().manifests.insert(
            (repository.to_string(), digest.clone()),
            StoredManifest {
                media_type: media_type.to_string(),
                bytes: bytes.to_vec(),
            },
        );
        digest
    }

    pub fn set_tag(&self, repository: &str, tag: &str, digest: &str) {
        self.lock().tags.insert(
            (repository.to_string(), tag.to_string()),
            digest.to_string(),
        );
    }

    pub fn tag_digest(&self, repository: &str, tag: &str) -> Option<String> {
        self.lock()
            .tags
            .get(&(repository.to_string(), tag.to_string()))
            .cloned()
    }

    pub fn blob(&self, digest: &str) -> Option<Vec<u8>> {
        self.lock().blobs.get(digest).cloned()
    }

    pub fn seed_private_repository(&self, repository: &str) {
        self.lock()
            .private_repositories
            .insert(repository.to_string());
    }

    pub fn forbid_repository(&self, repository: &str) {
        self.lock()
            .forbidden_repositories
            .insert(repository.to_string());
    }

    pub fn require_basic_for_token(&self, required: bool) {
        self.lock().token_requires_basic = required;
    }

    pub fn use_basic_challenge(&self, basic: bool) {
        self.lock().basic_challenge = basic;
    }

    pub fn auth_realm_override(&self, realm: &str) {
        self.lock().auth_realm_override = Some(realm.to_string());
    }

    pub fn challenge_scope_repository(&self, repository: &str) {
        self.lock().challenge_scope_repository = Some(repository.to_string());
    }

    pub fn cross_host_upload_location(&self, cross_host: bool) {
        self.lock().cross_host_upload_location = cross_host;
    }

    pub fn has_manifest(&self, repository: &str, digest: &str) -> bool {
        self.lock()
            .manifests
            .contains_key(&(repository.to_string(), digest.to_string()))
    }

    pub fn forbid_tokens(&self, forbidden: bool) {
        self.lock().token_forbidden = forbidden;
    }

    pub fn tamper_blob(&self, digest: &str) {
        self.lock().tamper_blob = Some(digest.to_string());
    }

    pub fn interrupt_blob(&self, digest: &str) {
        self.lock().interrupt_blob = Some(digest.to_string());
    }

    pub fn fail_finish_upload(&self, fail: bool) {
        self.lock().fail_finish_upload = fail;
    }

    pub fn redirect_manifest_to(&self, target: &str) {
        self.lock().redirect_manifest_to = Some(target.to_string());
    }

    pub fn oversized_manifest(&self, oversized: bool) {
        self.lock().oversized_manifest = oversized;
    }

    pub fn blob_media_type(&self, media_type: &str) {
        self.lock().blob_media_type = Some(media_type.to_string());
    }

    pub fn requests(&self) -> Vec<String> {
        self.lock().requests.clone()
    }

    pub fn authorization_headers(&self) -> Vec<Option<String>> {
        self.lock().authorization_headers.clone()
    }

    pub fn clear_requests(&self) {
        self.lock().requests.clear();
    }

    pub fn token_requests(&self) -> Vec<TokenRequest> {
        self.lock().token_requests.clone()
    }

    pub fn uploaded_blobs(&self) -> usize {
        self.lock().blobs.len()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.shared.inner.lock().expect("mock registry state")
    }
}

async fn handle(State(shared): State<Shared>, request: Request<Body>) -> Response {
    let method = request.method().clone();
    let uri = request.uri().clone();
    let headers = request.headers().clone();
    {
        let authorization = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .map(|value| {
                if value.starts_with("Bearer ") || value.starts_with("Basic ") {
                    "<authorization>".to_string()
                } else {
                    "<unexpected>".to_string()
                }
            });
        let mut inner = shared.inner.lock().expect("mock registry state");
        inner.requests.push(format!("{method} {}", uri.path()));
        inner.authorization_headers.push(authorization);
    }
    let path = uri.path().to_string();
    let query = uri.query().unwrap_or_default().to_string();
    if path == "/v2/" {
        return json_response(json!({}));
    }
    let Some(rest) = path.strip_prefix("/v2/") else {
        return not_found();
    };
    let body = to_bytes(request.into_body(), 32 * 1024 * 1024)
        .await
        .unwrap_or_default();
    if let Some((repository, reference)) = split_marker(rest, "/manifests/") {
        return manifest_route(&shared, &method, &headers, repository, reference, &body);
    }
    if let Some((repository, upload_id)) = split_marker(rest, "/blobs/uploads/") {
        return upload_route(
            &shared, &method, &headers, repository, upload_id, &query, &body,
        );
    }
    if let Some((repository, digest)) = split_marker(rest, "/blobs/") {
        return blob_route(&shared, &method, &headers, repository, digest);
    }
    not_found()
}

fn manifest_route(
    shared: &Shared,
    method: &Method,
    headers: &HeaderMap,
    repository: &str,
    reference: &str,
    body: &[u8],
) -> Response {
    if repository.is_empty() || reference.is_empty() {
        return not_found();
    }
    let actions = if method == Method::GET || method == Method::HEAD {
        "pull"
    } else {
        "pull,push"
    };
    if let Some(challenge) = authorize(shared, headers, repository, actions) {
        return challenge;
    }
    if is_forbidden(shared, repository) {
        return (StatusCode::FORBIDDEN, "forbidden repository").into_response();
    }
    if method == Method::PUT {
        return put_manifest(shared, headers, repository, reference, body);
    }
    if method != Method::GET && method != Method::HEAD {
        return method_not_allowed();
    }
    let inner = shared.inner.lock().expect("mock registry state");
    let digest = if reference.starts_with(crate::digest::DIGEST_PREFIX) {
        reference.to_string()
    } else {
        match inner
            .tags
            .get(&(repository.to_string(), reference.to_string()))
        {
            Some(digest) => digest.clone(),
            None => return not_found(),
        }
    };
    let Some(stored) = inner
        .manifests
        .get(&(repository.to_string(), digest.clone()))
    else {
        return not_found();
    };
    let media_type = stored.media_type.clone();
    let bytes = stored.bytes.clone();
    let oversized = inner.oversized_manifest;
    let redirect = inner.redirect_manifest_to.clone();
    drop(inner);
    if method == Method::GET {
        if let Some(target) = redirect {
            return Response::builder()
                .status(StatusCode::TEMPORARY_REDIRECT)
                .header(header::LOCATION, target)
                .body(Body::empty())
                .unwrap_or_else(|_| not_found());
        }
    }
    if oversized && method == Method::GET {
        let chunk = vec![b'x'; 1024 * 1024];
        let chunks = (0..5)
            .map(|_| Ok::<_, std::io::Error>(axum::body::Bytes::from(chunk.clone())))
            .collect::<Vec<_>>();
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, media_type)
            .header("docker-content-digest", digest)
            .body(Body::from_stream(stream::iter(chunks)))
            .unwrap_or_else(|_| not_found());
    }
    manifest_response(method, &digest, &media_type, bytes)
}

fn put_manifest(
    shared: &Shared,
    headers: &HeaderMap,
    repository: &str,
    reference: &str,
    body: &[u8],
) -> Response {
    let media_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    if media_type != crate::oci::MEDIA_TYPE_MANIFEST && media_type != crate::oci::MEDIA_TYPE_INDEX {
        return (StatusCode::BAD_REQUEST, "unsupported manifest media type").into_response();
    }
    let digest = digest_of_bytes(body);
    if reference.starts_with(crate::digest::DIGEST_PREFIX) && reference != digest {
        return (StatusCode::BAD_REQUEST, "digest mismatch").into_response();
    }
    {
        let mut inner = shared.inner.lock().expect("mock registry state");
        inner.manifests.insert(
            (repository.to_string(), digest.clone()),
            StoredManifest {
                media_type,
                bytes: body.to_vec(),
            },
        );
        if !reference.starts_with(crate::digest::DIGEST_PREFIX) {
            inner.tags.insert(
                (repository.to_string(), reference.to_string()),
                digest.clone(),
            );
        }
    }
    Response::builder()
        .status(StatusCode::CREATED)
        .header(header::CONTENT_LENGTH, "0")
        .header("docker-content-digest", digest)
        .body(Body::empty())
        .unwrap_or_else(|_| not_found())
}

fn upload_route(
    shared: &Shared,
    method: &Method,
    headers: &HeaderMap,
    repository: &str,
    upload_id: &str,
    query: &str,
    body: &[u8],
) -> Response {
    if let Some(challenge) = authorize(shared, headers, repository, "pull,push") {
        return challenge;
    }
    if is_forbidden(shared, repository) {
        return (StatusCode::FORBIDDEN, "forbidden repository").into_response();
    }
    if method == Method::POST && upload_id.is_empty() {
        let (cross_host, next) = {
            let mut inner = shared.inner.lock().expect("mock registry state");
            inner.next_upload = inner.next_upload.saturating_add(1);
            (
                inner.cross_host_upload_location,
                format!("upload-{}", inner.next_upload),
            )
        };
        {
            let mut inner = shared.inner.lock().expect("mock registry state");
            inner.uploads.insert(
                next.clone(),
                Upload {
                    repository: repository.to_string(),
                    bytes: Vec::new(),
                },
            );
        }
        let host = if cross_host {
            shared.base.replacen("127.0.0.1", "localhost", 1)
        } else {
            shared.base.clone()
        };
        return Response::builder()
            .status(StatusCode::ACCEPTED)
            .header(
                header::LOCATION,
                format!("{host}/v2/{repository}/blobs/uploads/{next}"),
            )
            .body(Body::empty())
            .unwrap_or_else(|_| not_found());
    }
    if upload_id.is_empty() {
        return method_not_allowed();
    }
    if method == Method::PATCH {
        let mut inner = shared.inner.lock().expect("mock registry state");
        let Some(upload) = inner.uploads.get_mut(upload_id) else {
            return not_found();
        };
        if upload.repository != repository {
            return not_found();
        }
        upload.bytes.extend_from_slice(body);
        drop(inner);
        return Response::builder()
            .status(StatusCode::ACCEPTED)
            .header(
                header::LOCATION,
                format!("/v2/{repository}/blobs/uploads/{upload_id}"),
            )
            .body(Body::empty())
            .unwrap_or_else(|_| not_found());
    }
    if method == Method::PUT {
        let fail = shared
            .inner
            .lock()
            .expect("mock registry state")
            .fail_finish_upload;
        if fail {
            return (StatusCode::INTERNAL_SERVER_ERROR, "upload failed").into_response();
        }
        let Some(digest) = query_value(query, "digest") else {
            return (StatusCode::BAD_REQUEST, "missing digest").into_response();
        };
        let mut inner = shared.inner.lock().expect("mock registry state");
        let Some(upload) = inner.uploads.remove(upload_id) else {
            return not_found();
        };
        if upload.repository != repository {
            return not_found();
        }
        let actual = digest_of_bytes(&upload.bytes);
        if actual != digest {
            return (StatusCode::BAD_REQUEST, "digest mismatch").into_response();
        }
        inner.blobs.insert(digest.clone(), upload.bytes);
        drop(inner);
        return Response::builder()
            .status(StatusCode::CREATED)
            .header(header::CONTENT_LENGTH, "0")
            .header("docker-content-digest", digest)
            .body(Body::empty())
            .unwrap_or_else(|_| not_found());
    }
    method_not_allowed()
}

fn blob_route(
    shared: &Shared,
    method: &Method,
    headers: &HeaderMap,
    repository: &str,
    digest: &str,
) -> Response {
    if let Some(challenge) = authorize(shared, headers, repository, "pull") {
        return challenge;
    }
    if is_forbidden(shared, repository) {
        return (StatusCode::FORBIDDEN, "forbidden repository").into_response();
    }
    if method != Method::GET && method != Method::HEAD {
        return method_not_allowed();
    }
    let inner = shared.inner.lock().expect("mock registry state");
    let Some(mut bytes) = inner.blobs.get(digest).cloned() else {
        return not_found();
    };
    let tamper = inner.tamper_blob.as_deref() == Some(digest);
    let interrupt = inner.interrupt_blob.as_deref() == Some(digest);
    let media_type = inner
        .blob_media_type
        .clone()
        .unwrap_or_else(|| "application/octet-stream".to_string());
    drop(inner);
    if tamper {
        if let Some(first) = bytes.first_mut() {
            *first = first.wrapping_add(1);
        }
    }
    if method == Method::HEAD {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, media_type)
            .header(header::CONTENT_LENGTH, bytes.len().to_string())
            .header("docker-content-digest", digest)
            .body(Body::empty())
            .unwrap_or_else(|_| not_found());
    }
    if interrupt {
        let midpoint = bytes.len() / 2;
        let partial = bytes.get(..midpoint).unwrap_or_default().to_vec();
        let declared = bytes.len();
        let stream = stream::iter(vec![
            Ok::<_, std::io::Error>(axum::body::Bytes::from(partial)),
            Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionReset,
                "interrupted transfer",
            )),
        ]);
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, media_type)
            .header(header::CONTENT_LENGTH, declared.to_string())
            .header("docker-content-digest", digest)
            .body(Body::from_stream(stream))
            .unwrap_or_else(|_| not_found());
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, media_type)
        .header(header::CONTENT_LENGTH, bytes.len().to_string())
        .header("docker-content-digest", digest)
        .body(Body::from(bytes))
        .unwrap_or_else(|_| not_found())
}

fn manifest_response(method: &Method, digest: &str, media_type: &str, bytes: Vec<u8>) -> Response {
    let length = bytes.len().to_string();
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(bytes)
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, media_type)
        .header(header::CONTENT_LENGTH, length)
        .header("docker-content-digest", digest)
        .body(body)
        .unwrap_or_else(|_| not_found())
}

async fn token_handler(
    State(shared): State<Shared>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if method != Method::GET {
        return method_not_allowed();
    }
    let query = uri.query().unwrap_or_default();
    let scope = query_value(query, "scope");
    let service = query_value(query, "service");
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    let has_basic = authorization.is_some_and(|value| value.starts_with("Basic "));
    let basic_valid = authorization == Some(expected_basic_authorization().as_str());
    let (requires_basic, forbidden) = {
        let mut inner = shared.inner.lock().expect("mock registry state");
        inner.token_requests.push(TokenRequest {
            service,
            scope,
            has_basic,
            basic_valid,
        });
        (inner.token_requires_basic, inner.token_forbidden)
    };
    if forbidden {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    if requires_basic && !basic_valid {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .header(header::WWW_AUTHENTICATE, "Basic realm=\"mock\"")
            .body(Body::empty())
            .unwrap_or_else(|_| not_found());
    }
    json_response(json!({ "token": TOKEN }))
}

fn expected_basic_authorization() -> String {
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{USERNAME}:{PASSWORD}"))
    )
}

fn json_response(value: serde_json::Value) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, value.to_string().len().to_string())
        .body(Body::from(value.to_string()))
        .unwrap_or_else(|_| not_found())
}

fn authorize(
    shared: &Shared,
    headers: &HeaderMap,
    repository: &str,
    actions: &str,
) -> Option<Response> {
    let (private, basic_challenge, realm_override, scope_repository) = {
        let inner = shared.inner.lock().expect("mock registry state");
        (
            inner.private_repositories.contains(repository),
            inner.basic_challenge,
            inner.auth_realm_override.clone(),
            inner
                .challenge_scope_repository
                .clone()
                .unwrap_or_else(|| repository.to_string()),
        )
    };
    if !private {
        return None;
    }
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    let authorized = if basic_challenge {
        authorization == Some(expected_basic_authorization().as_str())
    } else {
        authorization == Some(format!("Bearer {TOKEN}").as_str())
    };
    if authorized {
        return None;
    }
    let challenge = if basic_challenge {
        "Basic realm=\"mock\"".to_string()
    } else {
        let realm = realm_override.unwrap_or_else(|| format!("{}/token", shared.base));
        format!(
            "Bearer realm=\"{realm}\",service=\"mock-registry\",scope=\"repository:{scope_repository}:{actions}\""
        )
    };
    Some(
        Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .header(header::WWW_AUTHENTICATE, challenge)
            .header(header::CONTENT_LENGTH, "0")
            .body(Body::empty())
            .unwrap_or_else(|_| not_found()),
    )
}

fn is_forbidden(shared: &Shared, repository: &str) -> bool {
    shared
        .inner
        .lock()
        .expect("mock registry state")
        .forbidden_repositories
        .contains(repository)
}

fn split_marker<'a>(rest: &'a str, marker: &str) -> Option<(&'a str, &'a str)> {
    let index = rest.rfind(marker)?;
    Some((rest.get(..index)?, rest.get(index + marker.len()..)?))
}

fn query_value(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then(|| percent_decode(value))
    })
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if let (Some(high), Some(low)) = (
                bytes.get(index + 1).and_then(|byte| hex_value(*byte)),
                bytes.get(index + 2).and_then(|byte| hex_value(*byte)),
            ) {
                output.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

fn method_not_allowed() -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, "method not allowed").into_response()
}
