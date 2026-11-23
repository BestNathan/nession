//! Mountable OCI Distribution `/v2/` Registry service (#4088).
//!
//! A reusable Axum router over the shared #4087 contracts: a supplied
//! [`BlobStore`] holds verified bytes, a [`RepositoryStore`] decides what each
//! repository exposes, and an injected [`RegistryAuthorizer`] decides who may
//! act. The service owns no host identity, no database and no second
//! authorization state machine; a Server or Agent mounts it on its existing
//! HTTP ingress.
//!
//! Pull surface: `GET /v2/`, `GET/HEAD /v2/{name}/manifests/{ref}`,
//! `GET/HEAD /v2/{name}/blobs/{digest}` (Range/ETag) and
//! `GET /v2/{name}/tags/list`. Push surface (read-write mode only): the
//! standard `POST/PATCH/PUT /v2/{name}/blobs/uploads/` sequence, cross-
//! repository blob mount and `PUT /v2/{name}/manifests/{ref}`. Uploads stage
//! privately and publish atomically through an injected
//! [`RepositoryPublisher`]; a Manifest is published only after every hard
//! referenced object is present and size-verified in the CAS.
//!
//! Possessing a digest is never authorization: every blob read is gated by
//! [`RepositoryStore::permits_blob`], so a foreign repository's bytes are not
//! exposed even when they share the same CAS. Read-only mode denies every
//! mutation verb regardless of credential.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::Result;
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, OriginalUri, Path as UrlPath, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::io::ReaderStream;

use crate::contracts::{validate_repository_name, BlobStore, RepositoryStore};
use crate::digest::{digest_of_bytes, file_digest, is_valid_digest};

use super::{RemoteReference, OCTET_STREAM};

/// The Distribution API version header value every response carries.
const API_VERSION: &str = "registry/2.0";
/// Upper bound for one Manifest/Index push body (mirrors the client bound).
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;

/// The action one request asks to perform on a repository.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryAction {
    /// Read manifests, blobs or the tag list.
    Pull,
    /// Upload blobs, mount blobs or publish manifests/tags.
    Push,
    /// Enumerate repository tags.
    List,
}

/// The authorizer's decision for one request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Authorization {
    /// The credential may perform the action on the repository.
    Allowed,
    /// No usable credential: respond 401 with this `WWW-Authenticate` value.
    Unauthorized { challenge: String },
    /// The credential is known but may not perform this action: respond 403.
    Denied,
}

/// The injected per-request authorization provider (#4088).
///
/// `credential` is the exact `Authorization` header value (scheme included),
/// or `None` when absent. `repository` is the validated repository name, or
/// `""` for the bare `/v2/` endpoint. Implementations must fail closed: an
/// internal lookup failure must produce `Denied`, never `Allowed`.
#[async_trait::async_trait]
pub trait RegistryAuthorizer: Send + Sync {
    /// Decide one request before any object existence is revealed.
    async fn authorize(
        &self,
        credential: Option<&str>,
        repository: &str,
        action: RegistryAction,
    ) -> Authorization;
}

/// An explicit allow-everything authorizer for trusted loopback fixtures.
///
/// Never mount this on a shared ingress: it performs no authentication.
pub struct AllowAllAuthorizer;

#[async_trait::async_trait]
impl RegistryAuthorizer for AllowAllAuthorizer {
    async fn authorize(
        &self,
        _credential: Option<&str>,
        _repository: &str,
        _action: RegistryAction,
    ) -> Authorization {
        Authorization::Allowed
    }
}

/// An explicit deny-everything authorizer.
pub struct DenyAllAuthorizer;

#[async_trait::async_trait]
impl RegistryAuthorizer for DenyAllAuthorizer {
    async fn authorize(
        &self,
        _credential: Option<&str>,
        _repository: &str,
        _action: RegistryAction,
    ) -> Authorization {
        Authorization::Denied
    }
}

/// The injected atomic publication boundary for write-mode registries.
///
/// The service stages and CAS-publishes bytes first, then calls the publisher
/// to make them repository-visible. A publisher failure must leave no visible
/// tag pointing at an incomplete object. The Server implements this over its
/// catalog transaction; an Agent read-only registry uses [`NoPublisher`].
#[async_trait::async_trait]
pub trait RepositoryPublisher: Send + Sync {
    /// Associate an already CAS-published blob with the repository (upload
    /// completion or cross-repository mount). `path` is the validated CAS path.
    async fn publish_blob(
        &self,
        repository: &str,
        digest: &str,
        size_bytes: u64,
        path: &Path,
    ) -> Result<()>;

    /// Atomically publish an already CAS-published Manifest/Index and, when
    /// `reference` is a tag, move that tag with compare-and-swap semantics.
    async fn publish_manifest(
        &self,
        repository: &str,
        reference: &str,
        media_type: &str,
        digest: &str,
        size_bytes: u64,
        path: &Path,
    ) -> Result<()>;
}

/// The publisher of a read-only registry: every call fails closed.
pub struct NoPublisher;

#[async_trait::async_trait]
impl RepositoryPublisher for NoPublisher {
    async fn publish_blob(
        &self,
        _repository: &str,
        _digest: &str,
        _size_bytes: u64,
        _path: &Path,
    ) -> Result<()> {
        anyhow::bail!("read-only registry has no publisher")
    }

    async fn publish_manifest(
        &self,
        _repository: &str,
        _reference: &str,
        _media_type: &str,
        _digest: &str,
        _size_bytes: u64,
        _path: &Path,
    ) -> Result<()> {
        anyhow::bail!("read-only registry has no publisher")
    }
}

/// Whether a mounted registry accepts mutation verbs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryMode {
    /// Pull only; every mutation verb is refused with 405.
    ReadOnly,
    /// Pull and push through the injected publisher.
    ReadWrite,
}

/// One in-progress chunked upload, staged privately until digest verification.
struct UploadSession {
    repository: String,
    path: PathBuf,
    /// Serialized appended offset; OCI clients must sequence chunks anyway,
    /// but the lock keeps concurrent PATCHes from interleaving bytes.
    offset: tokio::sync::Mutex<u64>,
}

/// The mountable OCI Distribution Registry service (#4088).
///
/// Construct with [`RegistryService::read_only`] (Agent) or
/// [`RegistryService::read_write`] (Server), then mount [`Self::router`] on the
/// host's existing Axum ingress. The service never opens its own accept loop.
pub struct RegistryService<B, R, A, P> {
    blobs: Arc<B>,
    repositories: Arc<R>,
    authorizer: Arc<A>,
    publisher: Arc<P>,
    mode: RegistryMode,
    uploads: Mutex<HashMap<String, Arc<UploadSession>>>,
    staging: tempfile::TempDir,
}

impl<B, R, A> RegistryService<B, R, A, NoPublisher>
where
    B: BlobStore + 'static,
    R: RepositoryStore + 'static,
    A: RegistryAuthorizer + 'static,
{
    /// Mount a pull-only registry (the Agent mode). Mutation verbs are denied
    /// even with a valid push credential.
    pub fn read_only(blobs: Arc<B>, repositories: Arc<R>, authorizer: Arc<A>) -> Result<Self> {
        Ok(Self {
            blobs,
            repositories,
            authorizer,
            publisher: Arc::new(NoPublisher),
            mode: RegistryMode::ReadOnly,
            uploads: Mutex::new(HashMap::new()),
            staging: tempfile::TempDir::new()?,
        })
    }
}

impl<B, R, A, P> RegistryService<B, R, A, P>
where
    B: BlobStore + 'static,
    R: RepositoryStore + 'static,
    A: RegistryAuthorizer + 'static,
    P: RepositoryPublisher + 'static,
{
    /// Mount a writable registry whose pushes publish through `publisher`.
    pub fn read_write(
        blobs: Arc<B>,
        repositories: Arc<R>,
        authorizer: Arc<A>,
        publisher: Arc<P>,
    ) -> Result<Self> {
        Ok(Self {
            blobs,
            repositories,
            authorizer,
            publisher,
            mode: RegistryMode::ReadWrite,
            uploads: Mutex::new(HashMap::new()),
            staging: tempfile::TempDir::new()?,
        })
    }

    /// The configured mutation mode.
    pub fn mode(&self) -> RegistryMode {
        self.mode
    }

    /// The `/v2/` router to mount on the host ingress. Body limits are
    /// disabled at the router layer; JSON pushes are bounded explicitly and
    /// blob uploads stream to private staging files.
    pub fn router(self: &Arc<Self>) -> Router {
        Router::new()
            .route("/v2", any(base_endpoint::<B, R, A, P>))
            .route("/v2/", any(base_endpoint::<B, R, A, P>))
            .route("/v2/{*rest}", any(dispatch::<B, R, A, P>))
            .layer(DefaultBodyLimit::disable())
            .with_state(Arc::clone(self))
    }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/// The parsed `/v2/` endpoint shapes. Repository names contain `/`, so the
/// suffix is matched right-to-left and the remainder is the repository.
enum Endpoint {
    TagsList(String),
    Manifest(String, String),
    Blob(String, String),
    UploadStart(String),
    Upload(String, String),
}

fn parse_endpoint(rest: &str) -> Option<Endpoint> {
    let rest = rest.trim_end_matches('/');
    if let Some(repository) = rest.strip_suffix("/tags/list") {
        return Some(Endpoint::TagsList(repository.to_string()));
    }
    if let Some(repository) = rest.strip_suffix("/blobs/uploads") {
        return Some(Endpoint::UploadStart(repository.to_string()));
    }
    if let Some((repository, session)) = rest.rsplit_once("/blobs/uploads/") {
        if !session.is_empty() && !session.contains('/') {
            return Some(Endpoint::Upload(
                repository.to_string(),
                session.to_string(),
            ));
        }
    }
    if let Some((repository, digest)) = rest.rsplit_once("/blobs/") {
        if !digest.is_empty() && !digest.contains('/') {
            return Some(Endpoint::Blob(repository.to_string(), digest.to_string()));
        }
    }
    if let Some((repository, reference)) = rest.rsplit_once("/manifests/") {
        if !reference.is_empty() && !reference.contains('/') {
            return Some(Endpoint::Manifest(
                repository.to_string(),
                reference.to_string(),
            ));
        }
    }
    None
}

fn query_params(uri: &Uri) -> HashMap<String, String> {
    uri.query()
        .map(|query| {
            query
                .split('&')
                .filter_map(|pair| pair.split_once('='))
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

async fn base_endpoint<B, R, A, P>(
    State(service): State<Arc<RegistryService<B, R, A, P>>>,
    method: Method,
    headers: HeaderMap,
) -> Response
where
    B: BlobStore + 'static,
    R: RepositoryStore + 'static,
    A: RegistryAuthorizer + 'static,
    P: RepositoryPublisher + 'static,
{
    if method != Method::GET && method != Method::HEAD {
        return method_not_allowed();
    }
    let credential = credential_header(&headers);
    match service
        .authorizer
        .authorize(credential, "", RegistryAction::Pull)
        .await
    {
        Authorization::Allowed => {
            let mut response = json_response(StatusCode::OK, "{}");
            if method == Method::HEAD {
                *response.body_mut() = Body::empty();
            }
            response
        }
        Authorization::Unauthorized { challenge } => unauthorized(&challenge),
        Authorization::Denied => denied(""),
    }
}

async fn dispatch<B, R, A, P>(
    State(service): State<Arc<RegistryService<B, R, A, P>>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    UrlPath(rest): UrlPath<String>,
    headers: HeaderMap,
    body: Body,
) -> Response
where
    B: BlobStore + 'static,
    R: RepositoryStore + 'static,
    A: RegistryAuthorizer + 'static,
    P: RepositoryPublisher + 'static,
{
    let Some(endpoint) = parse_endpoint(&rest) else {
        return fail(
            StatusCode::NOT_FOUND,
            "NAME_UNKNOWN",
            "unknown registry endpoint",
        );
    };
    let repository = match &endpoint {
        Endpoint::TagsList(repository)
        | Endpoint::Manifest(repository, _)
        | Endpoint::Blob(repository, _)
        | Endpoint::UploadStart(repository)
        | Endpoint::Upload(repository, _) => repository.clone(),
    };
    if let Err(error) = validate_repository_name(&repository) {
        return fail(
            StatusCode::BAD_REQUEST,
            "NAME_INVALID",
            format!("invalid repository name: {error:#}"),
        );
    }

    let mutating = method != Method::GET && method != Method::HEAD;
    let action = match (&endpoint, mutating) {
        (Endpoint::TagsList(_), false) => RegistryAction::List,
        (_, false) => RegistryAction::Pull,
        (_, true) => RegistryAction::Push,
    };
    let credential = credential_header(&headers);
    match service
        .authorizer
        .authorize(credential, &repository, action)
        .await
    {
        Authorization::Allowed => {}
        Authorization::Unauthorized { challenge } => return unauthorized(&challenge),
        Authorization::Denied => return denied(&repository),
    }
    if mutating && service.mode == RegistryMode::ReadOnly {
        let mut response = fail(
            StatusCode::METHOD_NOT_ALLOWED,
            "UNSUPPORTED",
            "registry is mounted read-only; mutation verbs are denied",
        );
        response
            .headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
        return response;
    }

    let query = query_params(&uri);
    match endpoint {
        Endpoint::TagsList(repository) => {
            if method != Method::GET {
                return method_not_allowed();
            }
            tags_list(&service, &repository, &query).await
        }
        Endpoint::Manifest(repository, reference) => match method {
            Method::GET | Method::HEAD => {
                manifest_pull(
                    &service,
                    &repository,
                    &reference,
                    &headers,
                    method == Method::HEAD,
                )
                .await
            }
            Method::PUT => manifest_push(&service, &repository, &reference, body).await,
            _ => method_not_allowed(),
        },
        Endpoint::Blob(repository, digest) => match method {
            Method::GET | Method::HEAD => {
                blob_pull(
                    &service,
                    &repository,
                    &digest,
                    &headers,
                    method == Method::HEAD,
                )
                .await
            }
            _ => method_not_allowed(),
        },
        Endpoint::UploadStart(repository) => {
            if method != Method::POST {
                return method_not_allowed();
            }
            upload_start(&service, &repository, &query, body).await
        }
        Endpoint::Upload(repository, session) => match method {
            Method::GET => upload_status(&service, &repository, &session).await,
            Method::PATCH => upload_patch(&service, &repository, &session, &headers, body).await,
            Method::PUT => {
                upload_put(&service, &repository, &session, &headers, &query, body).await
            }
            Method::DELETE => upload_delete(&service, &repository, &session),
            _ => method_not_allowed(),
        },
    }
}

// ---------------------------------------------------------------------------
// Pull surface
// ---------------------------------------------------------------------------

async fn tags_list<B, R, A, P>(
    service: &RegistryService<B, R, A, P>,
    repository: &str,
    query: &HashMap<String, String>,
) -> Response
where
    B: BlobStore + 'static,
    R: RepositoryStore + 'static,
    A: RegistryAuthorizer + 'static,
    P: RepositoryPublisher + 'static,
{
    let tags = match service.repositories.list_tags(repository).await {
        Ok(tags) => tags,
        Err(error) => return internal_error(format!("tag listing failed: {error:#}")),
    };
    let page_size = query.get("n").and_then(|value| value.parse::<usize>().ok());
    let last = query.get("last").cloned();
    let mut selected: Vec<String> = tags
        .iter()
        .filter(|tag| {
            last.as_ref()
                .is_none_or(|boundary| tag.as_str() > boundary.as_str())
        })
        .cloned()
        .collect();
    let mut next_last = None;
    if let Some(limit) = page_size {
        if selected.len() > limit {
            selected.truncate(limit);
            next_last = selected.last().cloned();
        }
    }
    let body = serde_json::json!({ "name": repository, "tags": selected });
    let mut response = json_response(StatusCode::OK, body.to_string());
    if let Some(boundary) = next_last {
        let limit = page_size.unwrap_or_default();
        let link = format!("</v2/{repository}/tags/list?n={limit}&last={boundary}>; rel=\"next\"");
        if let Ok(value) = HeaderValue::from_str(&link) {
            response.headers_mut().insert(header::LINK, value);
        }
    }
    response
}

async fn manifest_pull<B, R, A, P>(
    service: &RegistryService<B, R, A, P>,
    repository: &str,
    reference: &str,
    headers: &HeaderMap,
    head: bool,
) -> Response
where
    B: BlobStore + 'static,
    R: RepositoryStore + 'static,
    A: RegistryAuthorizer + 'static,
    P: RepositoryPublisher + 'static,
{
    let parsed = match RemoteReference::parse(reference) {
        Ok(parsed) => parsed,
        Err(error) => {
            return fail(
                StatusCode::BAD_REQUEST,
                "MANIFEST_INVALID",
                format!("invalid manifest reference: {error}"),
            )
        }
    };
    let manifest = match service
        .repositories
        .resolve_reference(repository, parsed.as_str())
        .await
    {
        Ok(Some(manifest)) => manifest,
        Ok(None) => return manifest_unknown(repository, reference),
        Err(error) => return internal_error(format!("manifest resolution failed: {error:#}")),
    };
    if !accepts_media_type(headers, &manifest.media_type) {
        return manifest_unknown(repository, reference);
    }
    let blobs = Arc::clone(&service.blobs);
    let digest = manifest.digest.clone();
    let bytes = match tokio::task::spawn_blocking(move || blobs.read(&digest)).await {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(error)) => return internal_error(format!("manifest read failed: {error:#}")),
        Err(error) => return internal_error(format!("manifest read task failed: {error}")),
    };
    // Fail closed: the stored bytes must still match the exposed identity.
    if digest_of_bytes(&bytes) != manifest.digest || bytes.len() as u64 != manifest.size_bytes {
        return internal_error(format!(
            "manifest {} failed stored-byte verification",
            manifest.digest
        ));
    }
    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, manifest.media_type.as_str())
        .header(header::CONTENT_LENGTH, bytes.len())
        .header("docker-content-digest", manifest.digest.as_str())
        .header(header::ETAG, format!("\"{}\"", manifest.digest))
        .body(if head {
            Body::empty()
        } else {
            Body::from(bytes)
        });
    match response {
        Ok(response) => with_api_version(response),
        Err(error) => internal_error(format!("manifest response build failed: {error}")),
    }
}

async fn blob_pull<B, R, A, P>(
    service: &RegistryService<B, R, A, P>,
    repository: &str,
    digest: &str,
    headers: &HeaderMap,
    head: bool,
) -> Response
where
    B: BlobStore + 'static,
    R: RepositoryStore + 'static,
    A: RegistryAuthorizer + 'static,
    P: RepositoryPublisher + 'static,
{
    if !is_valid_digest(digest) {
        return fail(
            StatusCode::BAD_REQUEST,
            "DIGEST_INVALID",
            "blob reference must be sha256:<64 lowercase hex>",
        );
    }
    // Digest possession is never authorization: the repository must expose a
    // complete verified closure containing this blob.
    match service.repositories.permits_blob(repository, digest).await {
        Ok(true) => {}
        Ok(false) => return blob_unknown(repository, digest),
        Err(error) => return internal_error(format!("blob authorization failed: {error:#}")),
    }
    let blobs = Arc::clone(&service.blobs);
    let owned_digest = digest.to_string();
    let size = match tokio::task::spawn_blocking(move || {
        let size = blobs.size(&owned_digest)?;
        blobs.verify_named_size(&owned_digest, size)?;
        Ok::<u64, anyhow::Error>(size)
    })
    .await
    {
        Ok(Ok(size)) => size,
        Ok(Err(error)) => return internal_error(format!("blob verification failed: {error:#}")),
        Err(error) => return internal_error(format!("blob verification task failed: {error}")),
    };

    let range = match headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
    {
        Some(value) => match parse_range(value, size) {
            Ok(range) => range,
            Err(()) => {
                let mut response = fail(
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    "SIZE_INVALID",
                    "requested byte range is not satisfiable",
                );
                response.headers_mut().insert(
                    header::CONTENT_RANGE,
                    HeaderValue::from_str(&format!("bytes */{size}"))
                        .unwrap_or(HeaderValue::from_static("bytes */0")),
                );
                return response;
            }
        },
        None => ByteRange::Full,
    };
    let (start, length, partial) = match range {
        ByteRange::Full => (0, size, false),
        ByteRange::Partial { start, end } => (start, end - start + 1, true),
    };

    let mut file = match service.blobs.open(digest) {
        Ok(file) => tokio::fs::File::from_std(file),
        Err(error) => return internal_error(format!("blob open failed: {error:#}")),
    };
    if let Err(error) = file.seek(std::io::SeekFrom::Start(start)).await {
        return internal_error(format!("blob seek failed: {error}"));
    }
    let body = if head {
        Body::empty()
    } else {
        Body::from_stream(ReaderStream::new(file.take(length)))
    };
    let mut builder = Response::builder()
        .status(if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, OCTET_STREAM)
        .header(header::CONTENT_LENGTH, length)
        .header(header::ACCEPT_RANGES, "bytes")
        .header("docker-content-digest", digest)
        .header(header::ETAG, format!("\"{digest}\""));
    if partial {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{}/{size}", start + length - 1),
        );
    }
    match builder.body(body) {
        Ok(response) => with_api_version(response),
        Err(error) => internal_error(format!("blob response build failed: {error}")),
    }
}

/// Whether the request's Accept header permits the stored media type. A
/// missing Accept permits everything; a present one must name the exact type
/// or `*/*` (Distribution content negotiation).
fn accepts_media_type(headers: &HeaderMap, media_type: &str) -> bool {
    let Some(accept) = headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
    else {
        return true;
    };
    accept.split(',').any(|entry| {
        let entry = entry.split(';').next().unwrap_or("").trim();
        entry == "*/*" || entry == media_type
    })
}

enum ByteRange {
    Full,
    Partial { start: u64, end: u64 },
}

/// Parse a single `bytes=` range against a known size. Multi-ranges are
/// ignored (full response); an unsatisfiable range is `Err` → 416.
fn parse_range(value: &str, size: u64) -> Result<ByteRange, ()> {
    let Some(spec) = value.strip_prefix("bytes=") else {
        return Err(());
    };
    let spec = spec.trim();
    if spec.contains(',') {
        return Ok(ByteRange::Full);
    }
    if size == 0 {
        return Err(());
    }
    let (start, end) = match spec.split_once('-') {
        Some(("", suffix)) => {
            let suffix: u64 = suffix.parse().map_err(|_| ())?;
            if suffix == 0 {
                return Err(());
            }
            (size.saturating_sub(suffix), size - 1)
        }
        Some((start, "")) => {
            let start: u64 = start.parse().map_err(|_| ())?;
            if start >= size {
                return Err(());
            }
            (start, size - 1)
        }
        Some((start, end)) => {
            let start: u64 = start.parse().map_err(|_| ())?;
            let end: u64 = end.parse().map_err(|_| ())?;
            if start >= size || start > end {
                return Err(());
            }
            (start, end.min(size - 1))
        }
        None => return Err(()),
    };
    Ok(ByteRange::Partial { start, end })
}

// ---------------------------------------------------------------------------
// Push surface
// ---------------------------------------------------------------------------

async fn upload_start<B, R, A, P>(
    service: &RegistryService<B, R, A, P>,
    repository: &str,
    query: &HashMap<String, String>,
    body: Body,
) -> Response
where
    B: BlobStore + 'static,
    R: RepositoryStore + 'static,
    A: RegistryAuthorizer + 'static,
    P: RepositoryPublisher + 'static,
{
    // Cross-repository mount: only when the source repository actually
    // exposes the digest and the CAS holds it.
    if let Some(mount) = query.get("mount") {
        if let Some(from) = query.get("from") {
            if is_valid_digest(mount)
                && validate_repository_name(from).is_ok()
                && service
                    .repositories
                    .permits_blob(from, mount)
                    .await
                    .unwrap_or(false)
            {
                if let Some(response) = mount_blob(service, repository, mount).await {
                    return response;
                }
            }
        }
    }
    let session = match new_session(service, repository) {
        Ok(session) => session,
        Err(error) => return internal_error(format!("upload staging failed: {error:#}")),
    };
    if let Some(claimed) = query.get("digest") {
        // Monolithic POST: the whole body arrives with the creation request.
        let appended = match append_body(&session.path, body).await {
            Ok(appended) => appended,
            Err(response) => return response,
        };
        {
            let mut offset = session.offset.lock().await;
            *offset = appended;
        }
        return finalize_upload(service, repository, &session, claimed).await;
    }
    let location = format!("/v2/{repository}/blobs/uploads/{}", session_id(&session));
    upload_accepted(&location, &session_id(&session), 0)
}

async fn mount_blob<B, R, A, P>(
    service: &RegistryService<B, R, A, P>,
    repository: &str,
    digest: &str,
) -> Option<Response>
where
    B: BlobStore + 'static,
    R: RepositoryStore + 'static,
    A: RegistryAuthorizer + 'static,
    P: RepositoryPublisher + 'static,
{
    let blobs = Arc::clone(&service.blobs);
    let owned = digest.to_string();
    let published = tokio::task::spawn_blocking(move || {
        if !blobs.contains(&owned)? {
            return Ok(None);
        }
        let size = blobs.size(&owned)?;
        blobs.verify_named_size(&owned, size)?;
        Ok::<Option<(u64, PathBuf)>, anyhow::Error>(Some((size, blobs.path_for(&owned)?)))
    })
    .await;
    let (size, path) = match published {
        Ok(Ok(Some(pair))) => pair,
        _ => return None,
    };
    if let Err(error) = service
        .publisher
        .publish_blob(repository, digest, size, &path)
        .await
    {
        return Some(internal_error(format!("blob mount failed: {error:#}")));
    }
    let response = Response::builder()
        .status(StatusCode::CREATED)
        .header(header::LOCATION, format!("/v2/{repository}/blobs/{digest}"))
        .header("docker-content-digest", digest)
        .body(Body::empty());
    match response {
        Ok(response) => Some(with_api_version(response)),
        Err(error) => Some(internal_error(format!(
            "mount response build failed: {error}"
        ))),
    }
}

fn session_id(session: &UploadSession) -> String {
    session
        .path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn new_session<B, R, A, P>(
    service: &RegistryService<B, R, A, P>,
    repository: &str,
) -> Result<Arc<UploadSession>> {
    let id = uuid::Uuid::new_v4().to_string();
    let path = service.staging.path().join(&id);
    std::fs::File::create(&path)?;
    let session = Arc::new(UploadSession {
        repository: repository.to_string(),
        path,
        offset: tokio::sync::Mutex::new(0),
    });
    service
        .uploads
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(id, Arc::clone(&session));
    Ok(session)
}

fn lookup_session<B, R, A, P>(
    service: &RegistryService<B, R, A, P>,
    repository: &str,
    id: &str,
) -> Option<Arc<UploadSession>> {
    let uploads = service
        .uploads
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    uploads
        .get(id)
        .filter(|session| session.repository == repository)
        .cloned()
}

fn remove_session<B, R, A, P>(service: &RegistryService<B, R, A, P>, id: &str) {
    let removed = service
        .uploads
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(id);
    if let Some(session) = removed {
        let _ = std::fs::remove_file(&session.path);
    }
}

async fn upload_status<B, R, A, P>(
    service: &RegistryService<B, R, A, P>,
    repository: &str,
    id: &str,
) -> Response
where
    B: BlobStore + 'static,
    R: RepositoryStore + 'static,
    A: RegistryAuthorizer + 'static,
    P: RepositoryPublisher + 'static,
{
    let Some(session) = lookup_session(service, repository, id) else {
        return upload_unknown(id);
    };
    let offset = *session.offset.lock().await;
    let response = Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header("docker-upload-uuid", id)
        .header(header::RANGE, range_header(offset))
        .body(Body::empty());
    match response {
        Ok(response) => with_api_version(response),
        Err(error) => internal_error(format!("upload status build failed: {error}")),
    }
}

fn upload_delete<B, R, A, P>(
    service: &RegistryService<B, R, A, P>,
    repository: &str,
    id: &str,
) -> Response
where
    B: BlobStore + 'static,
    R: RepositoryStore + 'static,
    A: RegistryAuthorizer + 'static,
    P: RepositoryPublisher + 'static,
{
    if lookup_session(service, repository, id).is_none() {
        return upload_unknown(id);
    }
    remove_session(service, id);
    with_api_version(StatusCode::NO_CONTENT.into_response())
}

async fn upload_patch<B, R, A, P>(
    service: &RegistryService<B, R, A, P>,
    repository: &str,
    id: &str,
    headers: &HeaderMap,
    body: Body,
) -> Response
where
    B: BlobStore + 'static,
    R: RepositoryStore + 'static,
    A: RegistryAuthorizer + 'static,
    P: RepositoryPublisher + 'static,
{
    let Some(session) = lookup_session(service, repository, id) else {
        return upload_unknown(id);
    };
    let mut offset = session.offset.lock().await;
    if let Some(value) = headers
        .get(header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
    {
        if !content_range_matches(value, *offset) {
            return fail(
                StatusCode::RANGE_NOT_SATISFIABLE,
                "SIZE_INVALID",
                format!("upload chunk does not start at the current offset {offset}"),
            );
        }
    }
    let appended = match append_body(&session.path, body).await {
        Ok(appended) => appended,
        Err(response) => return response,
    };
    *offset += appended;
    let location = format!("/v2/{repository}/blobs/uploads/{id}");
    upload_accepted(&location, id, *offset)
}

async fn upload_put<B, R, A, P>(
    service: &RegistryService<B, R, A, P>,
    repository: &str,
    id: &str,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
    body: Body,
) -> Response
where
    B: BlobStore + 'static,
    R: RepositoryStore + 'static,
    A: RegistryAuthorizer + 'static,
    P: RepositoryPublisher + 'static,
{
    let Some(session) = lookup_session(service, repository, id) else {
        return upload_unknown(id);
    };
    let Some(claimed) = query.get("digest") else {
        return fail(
            StatusCode::BAD_REQUEST,
            "DIGEST_INVALID",
            "upload completion requires a ?digest= claim",
        );
    };
    {
        let mut offset = session.offset.lock().await;
        if let Some(value) = headers
            .get(header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
        {
            if !content_range_matches(value, *offset) {
                return fail(
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    "SIZE_INVALID",
                    format!("upload chunk does not start at the current offset {offset}"),
                );
            }
        }
        let appended = match append_body(&session.path, body).await {
            Ok(appended) => appended,
            Err(response) => return response,
        };
        *offset += appended;
    }
    finalize_upload(service, repository, &session, claimed).await
}

/// Hash the staged bytes, compare the claim, then atomically CAS-publish and
/// hand the verified object to the publisher. A mismatch never publishes.
async fn finalize_upload<B, R, A, P>(
    service: &RegistryService<B, R, A, P>,
    repository: &str,
    session: &UploadSession,
    claimed: &str,
) -> Response
where
    B: BlobStore + 'static,
    R: RepositoryStore + 'static,
    A: RegistryAuthorizer + 'static,
    P: RepositoryPublisher + 'static,
{
    let id = session_id(session);
    if !is_valid_digest(claimed) {
        remove_session(service, &id);
        return fail(
            StatusCode::BAD_REQUEST,
            "DIGEST_INVALID",
            "digest claim must be sha256:<64 lowercase hex>",
        );
    }
    let staged = session.path.clone();
    let actual = match tokio::task::spawn_blocking(move || file_digest(&staged)).await {
        Ok(Ok(actual)) => actual,
        Ok(Err(error)) => {
            remove_session(service, &id);
            return internal_error(format!("upload hashing failed: {error:#}"));
        }
        Err(error) => {
            remove_session(service, &id);
            return internal_error(format!("upload hashing task failed: {error}"));
        }
    };
    if actual != claimed {
        remove_session(service, &id);
        return fail(
            StatusCode::BAD_REQUEST,
            "DIGEST_INVALID",
            format!("uploaded bytes hash to {actual}, not the claimed {claimed}"),
        );
    }
    let blobs = Arc::clone(&service.blobs);
    let staged = session.path.clone();
    let published = match tokio::task::spawn_blocking(move || blobs.put_file(&staged)).await {
        Ok(Ok(published)) => published,
        Ok(Err(error)) => {
            remove_session(service, &id);
            return internal_error(format!("upload publication failed: {error:#}"));
        }
        Err(error) => {
            remove_session(service, &id);
            return internal_error(format!("upload publication task failed: {error}"));
        }
    };
    if let Err(error) = service
        .publisher
        .publish_blob(
            repository,
            &published.digest,
            published.size_bytes,
            &published.path,
        )
        .await
    {
        remove_session(service, &id);
        return internal_error(format!("blob publication failed: {error:#}"));
    }
    remove_session(service, &id);
    let response = Response::builder()
        .status(StatusCode::CREATED)
        .header(
            header::LOCATION,
            format!("/v2/{repository}/blobs/{}", published.digest),
        )
        .header("docker-content-digest", published.digest.as_str())
        .body(Body::empty());
    match response {
        Ok(response) => with_api_version(response),
        Err(error) => internal_error(format!("upload response build failed: {error}")),
    }
}

async fn manifest_push<B, R, A, P>(
    service: &RegistryService<B, R, A, P>,
    repository: &str,
    reference: &str,
    body: Body,
) -> Response
where
    B: BlobStore + 'static,
    R: RepositoryStore + 'static,
    A: RegistryAuthorizer + 'static,
    P: RepositoryPublisher + 'static,
{
    let parsed = match RemoteReference::parse(reference) {
        Ok(parsed) => parsed,
        Err(error) => {
            return fail(
                StatusCode::BAD_REQUEST,
                "MANIFEST_INVALID",
                format!("invalid manifest reference: {error}"),
            )
        }
    };
    let bytes = match read_limited(body, MAX_MANIFEST_BYTES).await {
        Ok(bytes) => bytes,
        Err(response) => return response,
    };
    let digest = digest_of_bytes(&bytes);
    if let Some(expected) = parsed.digest() {
        if expected != digest {
            return fail(
                StatusCode::BAD_REQUEST,
                "DIGEST_INVALID",
                format!("manifest bytes hash to {digest}, not the referenced {expected}"),
            );
        }
    }
    let shape = match describe_manifest_document(&bytes) {
        Ok(shape) => shape,
        Err(error) => {
            return fail(
                StatusCode::BAD_REQUEST,
                "MANIFEST_INVALID",
                format!("malformed manifest document: {error}"),
            )
        }
    };
    // Publish only after every hard referenced object is present and
    // size-verified; an incomplete push never becomes a visible tag.
    for descriptor in &shape.references {
        let blobs = Arc::clone(&service.blobs);
        let owned = descriptor.digest.clone();
        let expected_size = descriptor.size;
        let present = tokio::task::spawn_blocking(move || {
            if !blobs.contains(&owned)? {
                return Ok(false);
            }
            Ok::<bool, anyhow::Error>(blobs.size(&owned)? == expected_size)
        })
        .await;
        match present {
            Ok(Ok(true)) => {}
            Ok(Ok(false)) => {
                return fail(
                    StatusCode::BAD_REQUEST,
                    "MANIFEST_BLOB_UNKNOWN",
                    format!(
                        "referenced object {} ({}) is missing or size-mismatched in the CAS",
                        descriptor.digest, descriptor.media_type
                    ),
                )
            }
            Ok(Err(error)) => {
                return internal_error(format!("referenced object check failed: {error:#}"))
            }
            Err(error) => return internal_error(format!("referenced object task failed: {error}")),
        }
    }
    let blobs = Arc::clone(&service.blobs);
    let owned_bytes = bytes.clone();
    let published = match tokio::task::spawn_blocking(move || blobs.put_bytes(&owned_bytes)).await {
        Ok(Ok(published)) => published,
        Ok(Err(error)) => {
            return internal_error(format!("manifest CAS publication failed: {error:#}"))
        }
        Err(error) => return internal_error(format!("manifest CAS task failed: {error}")),
    };
    if let Err(error) = service
        .publisher
        .publish_manifest(
            repository,
            parsed.as_str(),
            &shape.media_type,
            &published.digest,
            published.size_bytes,
            &published.path,
        )
        .await
    {
        return fail(
            StatusCode::BAD_REQUEST,
            "MANIFEST_INVALID",
            format!("manifest publication was refused: {error:#}"),
        );
    }
    let response = Response::builder()
        .status(StatusCode::CREATED)
        .header(
            header::LOCATION,
            format!("/v2/{repository}/manifests/{}", published.digest),
        )
        .header("docker-content-digest", published.digest.as_str())
        .body(Body::empty());
    match response {
        Ok(response) => with_api_version(response),
        Err(error) => internal_error(format!("manifest push response failed: {error}")),
    }
}

// ---------------------------------------------------------------------------
// Shared structural manifest description (service pre-check + catalog publisher)
// ---------------------------------------------------------------------------

/// One hard descriptor reference inside a Manifest/Index document.
pub(crate) struct ManifestReference {
    pub digest: String,
    pub media_type: String,
    pub size: u64,
    /// The descriptor edge role (`config`, `layer`, `index-child`). Consumed by
    /// the catalog publisher to record reference edges; a host without a
    /// catalog (the read-only Agent) does not read it.
    #[cfg_attr(not(feature = "catalog"), allow(dead_code))]
    pub role: &'static str,
}

/// The structural shape of one pushed Manifest/Index document. This is a
/// transport-level description, not the domain validation owned by the
/// publisher/host (EROFS v1 rules stay with their catalog owner).
pub(crate) struct ManifestShape {
    pub media_type: String,
    pub references: Vec<ManifestReference>,
    /// The optional soft `subject` reference, recorded by the catalog
    /// publisher when present; not read by a catalog-less host.
    #[cfg_attr(not(feature = "catalog"), allow(dead_code))]
    pub subject: Option<ManifestReference>,
}

pub(crate) fn describe_manifest_document(bytes: &[u8]) -> Result<ManifestShape, String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| format!("invalid JSON: {error}"))?;
    let object = value.as_object().ok_or("document must be a JSON object")?;
    if let Some(version) = object.get("schemaVersion") {
        if version.as_u64() != Some(2) {
            return Err("schemaVersion must be 2".to_string());
        }
    }
    let mut references = Vec::new();
    let is_index = object.contains_key("manifests");
    if is_index {
        let manifests = object
            .get("manifests")
            .and_then(serde_json::Value::as_array)
            .ok_or("manifests must be an array")?;
        for entry in manifests {
            references.push(parse_descriptor(entry, "index-child")?);
        }
    } else {
        let config = object.get("config").ok_or("manifest requires config")?;
        references.push(parse_descriptor(config, "config")?);
        let layers = object
            .get("layers")
            .and_then(serde_json::Value::as_array)
            .ok_or("manifest requires a layers array")?;
        for entry in layers {
            references.push(parse_descriptor(entry, "layer")?);
        }
    }
    let media_type = match object.get("mediaType").and_then(serde_json::Value::as_str) {
        Some(media_type) => media_type.to_string(),
        None => {
            if is_index {
                crate::oci::MEDIA_TYPE_INDEX.to_string()
            } else {
                crate::oci::MEDIA_TYPE_MANIFEST.to_string()
            }
        }
    };
    let subject = match object.get("subject") {
        Some(subject) => Some(parse_descriptor(subject, "subject")?),
        None => None,
    };
    Ok(ManifestShape {
        media_type,
        references,
        subject,
    })
}

fn parse_descriptor(
    value: &serde_json::Value,
    role: &'static str,
) -> Result<ManifestReference, String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{role} descriptor must be an object"))?;
    let digest = object
        .get("digest")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("{role} descriptor requires digest"))?;
    if !is_valid_digest(digest) {
        return Err(format!("{role} descriptor digest must be sha256:<64 hex>"));
    }
    let media_type = object
        .get("mediaType")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("{role} descriptor requires mediaType"))?;
    let size = object
        .get("size")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| format!("{role} descriptor requires a numeric size"))?;
    Ok(ManifestReference {
        digest: digest.to_string(),
        media_type: media_type.to_string(),
        size,
        role,
    })
}

// ---------------------------------------------------------------------------
// Body/upload helpers
// ---------------------------------------------------------------------------

fn credential_header(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
}

async fn read_limited(body: Body, limit: u64) -> Result<Vec<u8>, Response> {
    let mut stream = body.into_data_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            fail(
                StatusCode::BAD_REQUEST,
                "MANIFEST_INVALID",
                format!("request body failed: {error}"),
            )
        })?;
        if bytes.len() as u64 + chunk.len() as u64 > limit {
            return Err(fail(
                StatusCode::BAD_REQUEST,
                "MANIFEST_INVALID",
                format!("manifest body exceeds the {limit}-byte bound"),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn append_body(path: &Path, body: Body) -> Result<u64, Response> {
    let mut file = match tokio::fs::OpenOptions::new().append(true).open(path).await {
        Ok(file) => file,
        Err(error) => {
            return Err(internal_error(format!(
                "upload staging open failed: {error}"
            )))
        }
    };
    let mut stream = body.into_data_stream();
    let mut appended = 0_u64;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => return Err(internal_error(format!("upload chunk failed: {error}"))),
        };
        if let Err(error) = file.write_all(&chunk).await {
            return Err(internal_error(format!(
                "upload staging write failed: {error}"
            )));
        }
        appended += chunk.len() as u64;
    }
    if let Err(error) = file.flush().await {
        return Err(internal_error(format!(
            "upload staging flush failed: {error}"
        )));
    }
    Ok(appended)
}

/// Distribution PATCH `Content-Range` is `<start>-<end>` (optionally `bytes `
/// prefixed); the chunk must begin exactly at the session's current offset.
fn content_range_matches(value: &str, offset: u64) -> bool {
    let spec = value.strip_prefix("bytes ").unwrap_or(value).trim();
    let Some((start, end)) = spec.split_once('-') else {
        return false;
    };
    let Ok(start) = start.parse::<u64>() else {
        return false;
    };
    let Ok(end) = end.parse::<u64>() else {
        return false;
    };
    start == offset && end >= start
}

fn range_header(offset: u64) -> String {
    if offset == 0 {
        "0-0".to_string()
    } else {
        format!("0-{}", offset - 1)
    }
}

fn upload_accepted(location: &str, id: &str, offset: u64) -> Response {
    let response = Response::builder()
        .status(StatusCode::ACCEPTED)
        .header(header::LOCATION, location)
        .header("docker-upload-uuid", id)
        .header(header::RANGE, range_header(offset))
        .body(Body::empty());
    match response {
        Ok(response) => with_api_version(response),
        Err(error) => internal_error(format!("upload response build failed: {error}")),
    }
}

// ---------------------------------------------------------------------------
// OCI error semantics
// ---------------------------------------------------------------------------

fn with_api_version(mut response: Response) -> Response {
    response.headers_mut().insert(
        "docker-distribution-api-version",
        HeaderValue::from_static(API_VERSION),
    );
    response
}

fn json_response(status: StatusCode, body: impl Into<String>) -> Response {
    let mut response = status.into_response();
    *response.body_mut() = Body::from(body.into());
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    with_api_version(response)
}

fn fail(status: StatusCode, code: &str, message: impl Into<String>) -> Response {
    let message = message.into();
    let body = serde_json::json!({
        "errors": [{ "code": code, "message": message, "detail": message }]
    });
    json_response(status, body.to_string())
}

fn unauthorized(challenge: &str) -> Response {
    let mut response = fail(
        StatusCode::UNAUTHORIZED,
        "UNAUTHORIZED",
        "authentication required".to_string(),
    );
    if let Ok(value) = HeaderValue::from_str(challenge) {
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, value);
    }
    response
}

fn denied(repository: &str) -> Response {
    fail(
        StatusCode::FORBIDDEN,
        "DENIED",
        format!("requested access to {repository:?} is denied"),
    )
}

fn manifest_unknown(repository: &str, reference: &str) -> Response {
    fail(
        StatusCode::NOT_FOUND,
        "MANIFEST_UNKNOWN",
        format!("manifest {reference:?} is not exposed by {repository:?}"),
    )
}

fn blob_unknown(repository: &str, digest: &str) -> Response {
    fail(
        StatusCode::NOT_FOUND,
        "BLOB_UNKNOWN",
        format!("blob {digest} is not exposed by {repository:?}"),
    )
}

fn upload_unknown(id: &str) -> Response {
    fail(
        StatusCode::NOT_FOUND,
        "BLOB_UPLOAD_UNKNOWN",
        format!("upload session {id:?} does not exist"),
    )
}

fn method_not_allowed() -> Response {
    fail(
        StatusCode::METHOD_NOT_ALLOWED,
        "UNSUPPORTED",
        "the operation is not supported on this endpoint".to_string(),
    )
}

fn internal_error(message: String) -> Response {
    fail(StatusCode::INTERNAL_SERVER_ERROR, "UNKNOWN", message)
}

#[cfg(test)]
mod tests;
