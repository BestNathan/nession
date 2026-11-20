//! OCI Distribution HTTP client: manifests, blobs, challenge authentication,
//! bounded redirects and blob upload primitives.

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use reqwest::header::{
    HeaderName, ACCEPT, ACCEPT_ENCODING, AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, LOCATION,
    WWW_AUTHENTICATE,
};
use reqwest::{Method, Response, StatusCode, Url};
use serde::Deserialize;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use super::auth::{
    parse_challenge, requested_scope, validate_challenge_scope, ChallengeScheme,
    RegistryCredential, RegistryCredentialProvider,
};
use super::{
    host_entry_matches, is_loopback_host, same_authority, validate_remote_repository,
    RegistryAuthority, RegistryError, RegistryResult, RemoteReference, DEFAULT_CONNECT_TIMEOUT,
    DEFAULT_MAX_JSON_BYTES, DEFAULT_MAX_REDIRECTS, DEFAULT_MAX_TOKEN_BYTES,
    DEFAULT_REQUEST_TIMEOUT, DISTRIBUTION_PREFIX, MANIFEST_ACCEPT, OCTET_STREAM,
};
use crate::blob::store::FsBlobStore;
use crate::digest::{digest_of_bytes, file_digest};
use crate::oci::{
    parse_index, parse_manifest, validate_index, validate_manifest, Descriptor, RawDocument,
    MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_INDEX, MEDIA_TYPE_MANIFEST,
};

/// The maximum accepted bearer token length.
const MAX_AUTH_TOKEN_BYTES: usize = 64 * 1024;
const DOCKER_CONTENT_DIGEST: HeaderName = HeaderName::from_static("docker-content-digest");

/// How one registry client is configured.
///
/// `base_url` must not contain credentials. Plaintext `http` is accepted only
/// for loopback (tests and a local registry); production registries must use
/// `https`. Redirect targets beyond the registry's own authority must be
/// listed explicitly in `allowed_redirect_hosts`.
#[derive(Debug, Clone)]
pub struct RegistryConfig {
    pub base_url: Url,
    /// Extra `host` or `host:port` redirect targets (for example a registry's
    /// blob CDN). The registry's own authority is always allowed.
    pub allowed_redirect_hosts: Vec<String>,
    /// Extra authentication-service hosts. The registry's own authority is
    /// always allowed; a challenge realm elsewhere must be listed here.
    pub allowed_auth_hosts: Vec<String>,
    pub max_json_bytes: u64,
    pub max_redirects: usize,
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
}

impl RegistryConfig {
    pub fn new(base_url: impl AsRef<str>) -> RegistryResult<Self> {
        let base_url = Url::parse(base_url.as_ref()).map_err(|_| {
            RegistryError::InvalidEndpoint("registry URL is not a valid URL".to_string())
        })?;
        if base_url.query().is_some() || base_url.fragment().is_some() {
            return Err(RegistryError::InvalidEndpoint(
                "registry URL must not carry a query or fragment".to_string(),
            ));
        }
        RegistryAuthority::from_url(&base_url)?;
        Ok(Self {
            base_url,
            allowed_redirect_hosts: Vec::new(),
            allowed_auth_hosts: Vec::new(),
            max_json_bytes: DEFAULT_MAX_JSON_BYTES,
            max_redirects: DEFAULT_MAX_REDIRECTS,
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
        })
    }
}

/// One fetched Manifest or Index document with its exact identity.
#[derive(Debug, Clone)]
pub struct FetchedManifest {
    pub document: RawDocument,
    pub media_type: String,
    pub digest: String,
}

/// A client for one OCI Distribution registry authority.
///
/// The client is the only owner of the credential provider and of resolved
/// bearer tokens. Its `Debug` output names the authority and nothing else.
pub struct RegistryClient {
    base_url: Url,
    authority: RegistryAuthority,
    http: reqwest::Client,
    credentials: Arc<dyn RegistryCredentialProvider>,
    tokens: Mutex<HashMap<String, String>>,
    allowed_redirect_hosts: Vec<String>,
    allowed_auth_hosts: Vec<String>,
    max_json_bytes: u64,
    max_redirects: usize,
}

impl fmt::Debug for RegistryClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RegistryClient")
            .field("base_url", &self.base_url.as_str())
            .field("authority", &self.authority)
            .field("credentials", &"<redacted>")
            .finish()
    }
}

impl RegistryClient {
    /// Build a client. The credential provider is the Server-owned secret
    /// source; the crate never takes an accessor to it.
    pub fn new(
        config: RegistryConfig,
        credentials: Arc<dyn RegistryCredentialProvider>,
    ) -> RegistryResult<Self> {
        let authority = RegistryAuthority::from_url(&config.base_url)?;
        validate_host_entries(&config.allowed_redirect_hosts)?;
        validate_host_entries(&config.allowed_auth_hosts)?;
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(config.connect_timeout)
            .timeout(config.request_timeout)
            .user_agent(format!("nession-erofs/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| {
                RegistryError::InvalidEndpoint(format!(
                    "cannot build the registry HTTP client: {error}"
                ))
            })?;
        Ok(Self {
            base_url: config.base_url,
            authority,
            http,
            credentials,
            tokens: Mutex::new(HashMap::new()),
            allowed_redirect_hosts: config.allowed_redirect_hosts,
            allowed_auth_hosts: config.allowed_auth_hosts,
            max_json_bytes: config.max_json_bytes,
            max_redirects: config.max_redirects,
        })
    }

    pub fn authority(&self) -> &RegistryAuthority {
        &self.authority
    }

    pub fn base_url(&self) -> &Url {
        &self.base_url
    }

    /// Resolve one Manifest or Index by tag or exact digest.
    ///
    /// A tag is resolved by hashing the exact response bytes; the returned
    /// digest is the immutable identity the caller imports. If the reference
    /// is already a digest, the bytes must hash to it.
    pub async fn fetch_manifest(
        &self,
        repository: &str,
        reference: &RemoteReference,
    ) -> RegistryResult<FetchedManifest> {
        validate_remote_repository(repository)?;
        let resource = format!("manifest {repository}:{}", reference.as_str());
        let url = self.endpoint(repository, &format!("manifests/{}", reference.as_str()))?;
        let response = self
            .send_without_body(Method::GET, url, repository, "pull", Some(MANIFEST_ACCEPT))
            .await?;
        require_status(&response, &resource)?;
        let media_type = response_media_type(&response, &resource)?;
        if media_type != MEDIA_TYPE_INDEX && media_type != MEDIA_TYPE_MANIFEST {
            return Err(RegistryError::MediaTypeMismatch {
                resource,
                expected: format!("{MEDIA_TYPE_MANIFEST} or {MEDIA_TYPE_INDEX}"),
                actual: media_type,
            });
        }
        let declared = docker_content_digest(&response, &resource)?;
        let bytes = read_bounded(response, self.max_json_bytes, &resource).await?;
        let digest = digest_of_bytes(&bytes);
        if let Some(declared) = declared {
            if declared != digest {
                return Err(RegistryError::DigestMismatch {
                    resource,
                    expected: declared,
                    actual: digest,
                });
            }
        }
        if let Some(expected) = reference.digest() {
            if expected != digest {
                return Err(RegistryError::DigestMismatch {
                    resource,
                    expected: expected.to_string(),
                    actual: digest,
                });
            }
        }
        if media_type == MEDIA_TYPE_INDEX {
            let (_, index) = parse_index(&bytes).map_err(|error| {
                RegistryError::MalformedIndex(format!(
                    "{repository}:{}: {error:#}",
                    reference.as_str()
                ))
            })?;
            validate_index(&index).map_err(|error| {
                RegistryError::MalformedIndex(format!(
                    "{repository}:{}: {error:#}",
                    reference.as_str()
                ))
            })?;
        } else {
            let (_, manifest) = parse_manifest(&bytes).map_err(|error| {
                RegistryError::MalformedManifest(format!(
                    "{repository}:{}: {error:#}",
                    reference.as_str()
                ))
            })?;
            validate_manifest(&manifest).map_err(|error| {
                RegistryError::MalformedManifest(format!(
                    "{repository}:{}: {error:#}",
                    reference.as_str()
                ))
            })?;
        }
        Ok(FetchedManifest {
            document: RawDocument::from_bytes(bytes),
            media_type,
            digest,
        })
    }

    /// Fetch one Config blob into bounded memory and verify its exact identity.
    pub async fn fetch_config(
        &self,
        repository: &str,
        descriptor: &Descriptor,
    ) -> RegistryResult<RawDocument> {
        if descriptor.media_type != MEDIA_TYPE_CONFIG {
            return Err(RegistryError::MediaTypeMismatch {
                resource: format!("config {}", descriptor.digest),
                expected: MEDIA_TYPE_CONFIG.to_string(),
                actual: descriptor.media_type.clone(),
            });
        }
        let resource = format!("config {repository}@{}", descriptor.digest);
        let url = self.endpoint(repository, &format!("blobs/{}", descriptor.digest))?;
        let response = self
            .send_without_body(Method::GET, url, repository, "pull", Some(OCTET_STREAM))
            .await?;
        require_status(&response, &resource)?;
        require_blob_content_type(&response, &descriptor.media_type, &resource)?;
        let bytes = read_bounded(response, self.max_json_bytes, &resource).await?;
        verify_bytes_against(descriptor, &bytes, &resource)?;
        Ok(RawDocument::from_bytes(bytes))
    }

    /// Download one EROFS layer into the CAS.
    ///
    /// Bytes are written to the store's private `.tmp` directory, verified
    /// against the descriptor's digest and size, and only then renamed into the
    /// content-addressed store. An interrupted or mismatched transfer leaves no
    /// Ready object.
    pub async fn download_blob(
        &self,
        store: &FsBlobStore,
        repository: &str,
        descriptor: &Descriptor,
    ) -> RegistryResult<()> {
        if descriptor.media_type != MEDIA_TYPE_EROFS {
            return Err(RegistryError::MediaTypeMismatch {
                resource: format!("layer {}", descriptor.digest),
                expected: MEDIA_TYPE_EROFS.to_string(),
                actual: descriptor.media_type.clone(),
            });
        }
        let resource = format!("layer {repository}@{}", descriptor.digest);
        let url = self.endpoint(repository, &format!("blobs/{}", descriptor.digest))?;
        let response = self
            .send_without_body(Method::GET, url, repository, "pull", Some(OCTET_STREAM))
            .await?;
        require_status(&response, &resource)?;
        require_blob_content_type(&response, &descriptor.media_type, &resource)?;
        if let Some(length) = content_length(&response) {
            if length != descriptor.size {
                return Err(RegistryError::SizeMismatch {
                    resource,
                    expected: descriptor.size,
                    actual: length,
                });
            }
        }
        let temp = store
            .root()
            .join(".tmp")
            .join(format!("registry-{}", uuid::Uuid::new_v4()));
        let result = stream_to_store(response, store, descriptor, &temp, &resource).await;
        // `FsBlobStore::put_file` copies through its own private temp file, so the
        // verified download source is removed on both success and failure.
        let _ = tokio::fs::remove_file(&temp).await;
        result
    }

    /// HEAD one blob; `Ok(false)` means the registry does not have it.
    pub(crate) async fn blob_exists(
        &self,
        repository: &str,
        descriptor: &Descriptor,
    ) -> RegistryResult<bool> {
        validate_remote_repository(repository)?;
        let resource = format!("blob {repository}@{}", descriptor.digest);
        let url = self.endpoint(repository, &format!("blobs/{}", descriptor.digest))?;
        let response = self
            .send_without_body(Method::HEAD, url, repository, "pull,push", None)
            .await?;
        match response.status() {
            StatusCode::OK => {
                if let Some(length) = content_length(&response) {
                    if length != descriptor.size {
                        return Err(RegistryError::SizeMismatch {
                            resource,
                            expected: descriptor.size,
                            actual: length,
                        });
                    }
                }
                if let Some(declared) = docker_content_digest(&response, &resource)? {
                    if declared != descriptor.digest {
                        return Err(RegistryError::DigestMismatch {
                            resource,
                            expected: descriptor.digest.clone(),
                            actual: declared,
                        });
                    }
                }
                Ok(true)
            }
            StatusCode::NOT_FOUND => Ok(false),
            status => Err(status_error(status, &resource)),
        }
    }

    /// Start a standard POST/PATCH/PUT blob upload.
    pub(crate) async fn begin_blob_upload(&self, repository: &str) -> RegistryResult<Url> {
        validate_remote_repository(repository)?;
        let resource = format!("blob upload {repository}");
        let url = self.endpoint(repository, "blobs/uploads/")?;
        let response = self
            .send_without_body(Method::POST, url.clone(), repository, "pull,push", None)
            .await?;
        match response.status() {
            StatusCode::ACCEPTED => self.upload_location(&url, &response, &resource),
            status => Err(upload_status_error(status, &resource)),
        }
    }

    /// Send one upload chunk and return the next upload location.
    pub(crate) async fn upload_blob_chunk(
        &self,
        repository: &str,
        location: &Url,
        path: &Path,
    ) -> RegistryResult<Url> {
        let resource = format!("blob upload {repository}");
        let response = self
            .send_upload(
                Method::PATCH,
                location.clone(),
                repository,
                "pull,push",
                UploadSource::File(path.to_path_buf()),
                OCTET_STREAM,
            )
            .await?;
        match response.status() {
            StatusCode::ACCEPTED => self.upload_location(location, &response, &resource),
            status => Err(upload_status_error(status, &resource)),
        }
    }

    /// Finish an upload and verify the registry accepted the exact digest.
    pub(crate) async fn finish_blob_upload(
        &self,
        repository: &str,
        location: &Url,
        digest: &str,
    ) -> RegistryResult<()> {
        let resource = format!("blob upload {repository}@{digest}");
        let mut url = location.clone();
        url.query_pairs_mut().append_pair("digest", digest);
        let response = self
            .send_upload(
                Method::PUT,
                url,
                repository,
                "pull,push",
                UploadSource::Bytes(Vec::new()),
                OCTET_STREAM,
            )
            .await?;
        match response.status() {
            StatusCode::CREATED => {
                if let Some(declared) = docker_content_digest(&response, &resource)? {
                    if declared != digest {
                        return Err(RegistryError::DigestMismatch {
                            resource,
                            expected: digest.to_string(),
                            actual: declared,
                        });
                    }
                }
                Ok(())
            }
            status => Err(upload_status_error(status, &resource)),
        }
    }

    /// PUT exact Manifest or Index bytes under a tag or digest.
    pub(crate) async fn put_manifest(
        &self,
        repository: &str,
        reference: &RemoteReference,
        media_type: &str,
        bytes: Vec<u8>,
    ) -> RegistryResult<()> {
        validate_remote_repository(repository)?;
        let resource = format!("manifest {repository}:{}", reference.as_str());
        let expected = digest_of_bytes(&bytes);
        if let Some(requested) = reference.digest() {
            if requested != expected {
                return Err(RegistryError::DigestMismatch {
                    resource,
                    expected: requested.to_string(),
                    actual: expected,
                });
            }
        }
        let url = self.endpoint(repository, &format!("manifests/{}", reference.as_str()))?;
        let response = self
            .send_upload(
                Method::PUT,
                url,
                repository,
                "pull,push",
                UploadSource::Bytes(bytes),
                media_type,
            )
            .await?;
        match response.status() {
            StatusCode::CREATED | StatusCode::OK => {
                if let Some(declared) = docker_content_digest(&response, &resource)? {
                    if declared != expected {
                        return Err(RegistryError::DigestMismatch {
                            resource,
                            expected,
                            actual: declared,
                        });
                    }
                }
                Ok(())
            }
            status => Err(upload_status_error(status, &resource)),
        }
    }

    async fn send_without_body(
        &self,
        method: Method,
        mut url: Url,
        repository: &str,
        actions: &str,
        accept: Option<&str>,
    ) -> RegistryResult<Response> {
        let key = token_key(repository, actions);
        let mut auth = self.cached_auth(&key).await;
        let mut solved = false;
        let mut redirects = 0_usize;
        loop {
            // Credentials are scoped to the configured registry authority. A
            // redirect target that is merely listed as allowed (for example a
            // blob CDN) receives no Authorization header and cannot start a
            // second challenge/token exchange.
            let on_registry = self.is_registry_url(&url);
            let mut request = self
                .http
                .request(method.clone(), url.clone())
                .header(ACCEPT_ENCODING, "identity");
            if let Some(accept) = accept {
                request = request.header(ACCEPT, accept);
            }
            if on_registry {
                if let Some(value) = &auth {
                    request = request.header(AUTHORIZATION, value);
                }
            }
            let response = request
                .send()
                .await
                .map_err(|error| self.transport(format!("{method} {repository}"), error))?;
            if is_redirect(response.status()) {
                url = self.redirect_target(&url, &response, &method, redirects)?;
                redirects += 1;
                continue;
            }
            if on_registry && response.status() == StatusCode::UNAUTHORIZED && !solved {
                let value = self.solve_challenge(&response, repository, actions).await?;
                self.cache_auth(&key, &value).await;
                auth = Some(value);
                solved = true;
                continue;
            }
            return Ok(response);
        }
    }

    async fn send_upload(
        &self,
        method: Method,
        mut url: Url,
        repository: &str,
        actions: &str,
        source: UploadSource,
        content_type: &str,
    ) -> RegistryResult<Response> {
        let key = token_key(repository, actions);
        let mut auth = self.cached_auth(&key).await;
        let mut solved = false;
        let mut redirects = 0_usize;
        loop {
            let on_registry = self.is_registry_url(&url);
            let mut request = self
                .http
                .request(method.clone(), url.clone())
                .header(CONTENT_TYPE, content_type)
                .header(ACCEPT_ENCODING, "identity");
            if on_registry {
                if let Some(value) = &auth {
                    request = request.header(AUTHORIZATION, value);
                }
            }
            request = match &source {
                UploadSource::Bytes(bytes) => {
                    if !bytes.is_empty() {
                        request = request.header(CONTENT_LENGTH, bytes.len().to_string());
                    }
                    request.body(bytes.clone())
                }
                UploadSource::File(path) => {
                    let metadata = tokio::fs::metadata(path).await.map_err(|error| {
                        RegistryError::Local(format!("cannot read local blob for upload: {error}"))
                    })?;
                    request = request.header(CONTENT_LENGTH, metadata.len().to_string());
                    let file = tokio::fs::File::open(path).await.map_err(|error| {
                        RegistryError::Local(format!("cannot open local blob for upload: {error}"))
                    })?;
                    request.body(reqwest::Body::from(file))
                }
            };
            let response = request
                .send()
                .await
                .map_err(|error| self.transport(format!("{method} {repository}"), error))?;
            if is_redirect(response.status()) {
                url = self.redirect_target(&url, &response, &method, redirects)?;
                redirects += 1;
                continue;
            }
            if on_registry && response.status() == StatusCode::UNAUTHORIZED && !solved {
                let value = self.solve_challenge(&response, repository, actions).await?;
                self.cache_auth(&key, &value).await;
                auth = Some(value);
                solved = true;
                continue;
            }
            return Ok(response);
        }
    }

    fn is_registry_url(&self, url: &Url) -> bool {
        RegistryAuthority::from_url(url)
            .is_ok_and(|authority| same_authority(&authority, &self.authority))
    }

    async fn cached_auth(&self, key: &str) -> Option<String> {
        self.tokens.lock().await.get(key).cloned()
    }

    async fn cache_auth(&self, key: &str, value: &str) {
        self.tokens
            .lock()
            .await
            .insert(key.to_string(), value.to_string());
    }

    async fn solve_challenge(
        &self,
        response: &Response,
        repository: &str,
        actions: &str,
    ) -> RegistryResult<String> {
        let raw = response
            .headers()
            .get(WWW_AUTHENTICATE)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| {
                RegistryError::AuthChallenge(format!(
                    "registry {repository} returned 401 without a usable challenge"
                ))
            })?;
        let challenge = parse_challenge(raw)?;
        if let Some(scope) = challenge.scope.as_deref() {
            validate_challenge_scope(scope, repository)?;
        }
        if let Some(error) = challenge.error.as_deref() {
            // An expired cached token is retryable once; any other challenge
            // error means the registry did not grant the requested scope.
            if error != "invalid_token" {
                return Err(RegistryError::AuthDenied(repository.to_string()));
            }
        }
        let credential = self.credentials.credential_for(&self.authority, repository);
        match challenge.scheme {
            ChallengeScheme::Basic => {
                let credential = credential
                    .ok_or_else(|| RegistryError::Unauthorized(format!("registry {repository}")))?;
                Ok(credential.basic_authorization())
            }
            ChallengeScheme::Bearer => {
                let realm = challenge.required_realm()?;
                let realm_url = Url::parse(realm).map_err(|_| {
                    RegistryError::AuthChallenge(
                        "Bearer challenge realm is not a valid URL".to_string(),
                    )
                })?;
                self.validate_auth_url(&realm_url)?;
                let scope = requested_scope(repository, actions)?;
                let service = challenge
                    .service
                    .as_deref()
                    .filter(|value| !value.is_empty());
                if let Some(service) = service {
                    if service.len() > 256 || service.chars().any(char::is_control) {
                        return Err(RegistryError::AuthChallenge(
                            "Bearer challenge service is invalid".to_string(),
                        ));
                    }
                }
                let token = self
                    .fetch_token(realm_url, service, &scope, credential)
                    .await?;
                Ok(format!("Bearer {token}"))
            }
        }
    }

    async fn fetch_token(
        &self,
        mut realm: Url,
        service: Option<&str>,
        scope: &str,
        credential: Option<RegistryCredential>,
    ) -> RegistryResult<String> {
        {
            let mut query = realm.query_pairs_mut();
            if let Some(service) = service {
                query.append_pair("service", service);
            }
            query.append_pair("scope", scope);
        }
        let mut request = self.http.get(realm.clone());
        if let Some(credential) = &credential {
            request = request.header(AUTHORIZATION, credential.basic_authorization());
        }
        let response = request.send().await.map_err(|error| {
            self.transport(
                format!("token service {}", realm.host_str().unwrap_or_default()),
                error,
            )
        })?;
        if is_redirect(response.status()) {
            return Err(RegistryError::RedirectRefused {
                from: realm.to_string(),
                to: response
                    .headers()
                    .get(LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("<missing>")
                    .to_string(),
            });
        }
        match response.status() {
            StatusCode::OK => {}
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                return Err(RegistryError::AuthDenied(
                    realm.host_str().unwrap_or_default().to_string(),
                ));
            }
            status => {
                return Err(RegistryError::MalformedResponse(format!(
                    "token service returned status {status}"
                )));
            }
        }
        let bytes = read_bounded(response, DEFAULT_MAX_TOKEN_BYTES, "authentication token").await?;
        let token_response: TokenResponse = serde_json::from_slice(&bytes).map_err(|_| {
            RegistryError::MalformedResponse("token service returned invalid JSON".to_string())
        })?;
        let token = token_response
            .token
            .or(token_response.access_token)
            .filter(|token| !token.is_empty())
            .ok_or_else(|| {
                RegistryError::MalformedResponse(
                    "token service returned no usable token".to_string(),
                )
            })?;
        if token.len() > MAX_AUTH_TOKEN_BYTES || token.chars().any(char::is_control) {
            return Err(RegistryError::MalformedResponse(
                "token service returned an invalid token".to_string(),
            ));
        }
        Ok(token)
    }

    fn validate_auth_url(&self, url: &Url) -> RegistryResult<()> {
        if url.scheme() != "https"
            && !(url.scheme() == "http" && is_loopback_host(url.host_str().unwrap_or_default()))
        {
            return Err(RegistryError::AuthHostRefused(
                url.host_str().unwrap_or_default().to_string(),
            ));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(RegistryError::AuthHostRefused(
                url.host_str().unwrap_or_default().to_string(),
            ));
        }
        let authority = RegistryAuthority::from_url(url)?;
        if same_authority(&authority, &self.authority)
            || host_entry_matches(url, &self.allowed_auth_hosts)
        {
            return Ok(());
        }
        Err(RegistryError::AuthHostRefused(authority.label()))
    }

    fn redirect_target(
        &self,
        current: &Url,
        response: &Response,
        method: &Method,
        redirects: usize,
    ) -> RegistryResult<Url> {
        if redirects >= self.max_redirects {
            return Err(RegistryError::TooManyRedirects(current.to_string()));
        }
        let status = response.status();
        if status != StatusCode::TEMPORARY_REDIRECT
            && status != StatusCode::PERMANENT_REDIRECT
            && method != Method::GET
            && method != Method::HEAD
        {
            return Err(RegistryError::RedirectRefused {
                from: current.to_string(),
                to: "<method-changing redirect>".to_string(),
            });
        }
        let location = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| {
                RegistryError::MalformedResponse("redirect has no Location header".to_string())
            })?;
        let next = current.join(location).map_err(|_| {
            RegistryError::MalformedResponse("redirect Location is not a valid URL".to_string())
        })?;
        if next.scheme() != "https" && next.scheme() != "http" {
            return Err(RegistryError::RedirectRefused {
                from: current.to_string(),
                to: next.to_string(),
            });
        }
        if current.scheme() == "https" && next.scheme() == "http" {
            return Err(RegistryError::RedirectRefused {
                from: current.to_string(),
                to: next.to_string(),
            });
        }
        if next.scheme() == "http" && !is_loopback_host(next.host_str().unwrap_or_default()) {
            return Err(RegistryError::RedirectRefused {
                from: current.to_string(),
                to: next.to_string(),
            });
        }
        if !next.username().is_empty() || next.password().is_some() || next.fragment().is_some() {
            return Err(RegistryError::RedirectRefused {
                from: current.to_string(),
                to: next.to_string(),
            });
        }
        let target = RegistryAuthority::from_url(&next)?;
        if method != Method::GET
            && method != Method::HEAD
            && !same_authority(&target, &self.authority)
        {
            // Upload state is scoped to the registry. A cross-authority upload
            // location would require exposing the repository token elsewhere.
            return Err(RegistryError::RedirectRefused {
                from: current.to_string(),
                to: next.to_string(),
            });
        }
        if same_authority(&target, &self.authority)
            || host_entry_matches(&next, &self.allowed_redirect_hosts)
        {
            return Ok(next);
        }
        Err(RegistryError::RedirectRefused {
            from: current.to_string(),
            to: next.to_string(),
        })
    }

    fn upload_location(
        &self,
        current: &Url,
        response: &Response,
        resource: &str,
    ) -> RegistryResult<Url> {
        let location = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| {
                RegistryError::MalformedResponse(format!(
                    "{resource} response has no upload Location"
                ))
            })?;
        let next = current.join(location).map_err(|_| {
            RegistryError::MalformedResponse(format!(
                "{resource} upload Location is not a valid URL"
            ))
        })?;
        if next.scheme() != "https"
            && !(next.scheme() == "http" && is_loopback_host(next.host_str().unwrap_or_default()))
        {
            return Err(RegistryError::RedirectRefused {
                from: current.to_string(),
                to: next.to_string(),
            });
        }
        if !next.username().is_empty() || next.password().is_some() {
            return Err(RegistryError::RedirectRefused {
                from: current.to_string(),
                to: next.to_string(),
            });
        }
        let target = RegistryAuthority::from_url(&next)?;
        if same_authority(&target, &self.authority) {
            return Ok(next);
        }
        Err(RegistryError::RedirectRefused {
            from: current.to_string(),
            to: next.to_string(),
        })
    }

    fn endpoint(&self, repository: &str, suffix: &str) -> RegistryResult<Url> {
        validate_remote_repository(repository)?;
        let mut url = self.base_url.clone();
        let base_path = self.base_url.path().trim_end_matches('/');
        url.set_path(&format!(
            "{base_path}/{DISTRIBUTION_PREFIX}/{repository}/{suffix}"
        ));
        url.set_query(None);
        url.set_fragment(None);
        Ok(url)
    }

    fn transport(&self, resource: String, error: reqwest::Error) -> RegistryError {
        // A connection failure or timeout is a transport failure. A request
        // that starts and then dies mid-response (for example an incomplete
        // HTTP message) is the interrupted-transfer class the caller must see.
        if error.is_timeout() || error.is_connect() {
            RegistryError::Transport {
                resource,
                source: error,
            }
        } else if error.is_body() || error.is_decode() || error.is_request() {
            RegistryError::TransferInterrupted(format!("{resource}: {error}"))
        } else {
            RegistryError::Transport {
                resource,
                source: error,
            }
        }
    }
}

#[derive(Clone)]
enum UploadSource {
    Bytes(Vec<u8>),
    File(PathBuf),
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    token: Option<String>,
    access_token: Option<String>,
}

fn token_key(repository: &str, actions: &str) -> String {
    format!("{repository}\u{0}{actions}")
}

fn is_redirect(status: StatusCode) -> bool {
    status.is_redirection() && status != StatusCode::NOT_MODIFIED && status != StatusCode::USE_PROXY
}

fn status_error(status: StatusCode, resource: &str) -> RegistryError {
    match status {
        StatusCode::UNAUTHORIZED => RegistryError::Unauthorized(resource.to_string()),
        StatusCode::FORBIDDEN => RegistryError::Forbidden(resource.to_string()),
        StatusCode::NOT_FOUND => RegistryError::NotFound(resource.to_string()),
        other => RegistryError::MalformedResponse(format!(
            "{resource} returned unexpected status {other}"
        )),
    }
}

fn upload_status_error(status: StatusCode, resource: &str) -> RegistryError {
    match status {
        StatusCode::UNAUTHORIZED => RegistryError::Unauthorized(resource.to_string()),
        StatusCode::FORBIDDEN => RegistryError::Forbidden(resource.to_string()),
        StatusCode::NOT_FOUND => RegistryError::NotFound(resource.to_string()),
        other => RegistryError::UploadFailed {
            resource: resource.to_string(),
            status: other.as_u16(),
        },
    }
}

fn require_status(response: &Response, resource: &str) -> RegistryResult<()> {
    if response.status().is_success() || response.status() == StatusCode::PARTIAL_CONTENT {
        return Ok(());
    }
    Err(status_error(response.status(), resource))
}

fn response_media_type(response: &Response, resource: &str) -> RegistryResult<String> {
    let value = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            RegistryError::MalformedResponse(format!("{resource} has no Content-Type"))
        })?;
    Ok(value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase())
}

fn require_blob_content_type(
    response: &Response,
    expected: &str,
    resource: &str,
) -> RegistryResult<()> {
    let Some(value) = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
    else {
        return Ok(());
    };
    let actual = value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if actual == expected || actual == OCTET_STREAM {
        return Ok(());
    }
    Err(RegistryError::MediaTypeMismatch {
        resource: resource.to_string(),
        expected: expected.to_string(),
        actual,
    })
}

fn content_length(response: &Response) -> Option<u64> {
    response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
}

fn docker_content_digest(response: &Response, resource: &str) -> RegistryResult<Option<String>> {
    let Some(value) = response
        .headers()
        .get(&DOCKER_CONTENT_DIGEST)
        .and_then(|value| value.to_str().ok())
    else {
        return Ok(None);
    };
    let value = value.trim();
    if !crate::digest::is_valid_digest(value) {
        return Err(RegistryError::MalformedResponse(format!(
            "{resource} has an invalid Docker-Content-Digest header"
        )));
    }
    Ok(Some(value.to_string()))
}

async fn read_bounded(
    mut response: Response,
    limit: u64,
    resource: &str,
) -> RegistryResult<Vec<u8>> {
    let declared = content_length(&response);
    if let Some(length) = declared {
        if length > limit {
            return Err(RegistryError::ResponseTooLarge {
                resource: resource.to_string(),
                limit,
            });
        }
    }
    let mut bytes = Vec::new();
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|error| RegistryError::TransferInterrupted(format!("{resource}: {error}")))?;
        let Some(chunk) = chunk else {
            break;
        };
        let total = u64::try_from(bytes.len())
            .unwrap_or(u64::MAX)
            .saturating_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX));
        if total > limit {
            return Err(RegistryError::ResponseTooLarge {
                resource: resource.to_string(),
                limit,
            });
        }
        bytes.extend_from_slice(&chunk);
    }
    if let Some(declared) = declared {
        let actual = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        if actual != declared {
            return Err(RegistryError::TransferInterrupted(format!(
                "{resource}: declared {declared} bytes but received {actual}"
            )));
        }
    }
    Ok(bytes)
}

fn verify_bytes_against(
    descriptor: &Descriptor,
    bytes: &[u8],
    resource: &str,
) -> RegistryResult<()> {
    let actual_size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    if actual_size != descriptor.size {
        return Err(RegistryError::SizeMismatch {
            resource: resource.to_string(),
            expected: descriptor.size,
            actual: actual_size,
        });
    }
    let actual_digest = digest_of_bytes(bytes);
    if actual_digest != descriptor.digest {
        return Err(RegistryError::DigestMismatch {
            resource: resource.to_string(),
            expected: descriptor.digest.clone(),
            actual: actual_digest,
        });
    }
    Ok(())
}

async fn stream_to_store(
    mut response: Response,
    store: &FsBlobStore,
    descriptor: &Descriptor,
    temp: &Path,
    resource: &str,
) -> RegistryResult<()> {
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(temp)
        .await
        .map_err(|error| {
            RegistryError::Local(format!("cannot create registry temp file: {error}"))
        })?;
    let mut total = 0_u64;
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|error| RegistryError::TransferInterrupted(format!("{resource}: {error}")))?;
        let Some(chunk) = chunk else {
            break;
        };
        total = total.saturating_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX));
        if total > descriptor.size {
            return Err(RegistryError::SizeMismatch {
                resource: resource.to_string(),
                expected: descriptor.size,
                actual: total,
            });
        }
        file.write_all(&chunk).await.map_err(|error| {
            RegistryError::Local(format!("cannot write registry temp file: {error}"))
        })?;
    }
    file.sync_all().await.map_err(|error| {
        RegistryError::Local(format!("cannot fsync registry temp file: {error}"))
    })?;
    drop(file);
    if total != descriptor.size {
        return Err(RegistryError::TransferInterrupted(format!(
            "{resource}: expected {} bytes, received {total}",
            descriptor.size
        )));
    }
    let actual = file_digest(temp)?;
    if actual != descriptor.digest {
        return Err(RegistryError::DigestMismatch {
            resource: resource.to_string(),
            expected: descriptor.digest.clone(),
            actual,
        });
    }
    let stored = store.put_file(temp).with_context(|| {
        format!(
            "cannot publish verified registry blob {}",
            descriptor.digest
        )
    })?;
    if stored.digest != descriptor.digest || stored.size_bytes != descriptor.size {
        return Err(RegistryError::DigestMismatch {
            resource: resource.to_string(),
            expected: descriptor.digest.clone(),
            actual: stored.digest,
        });
    }
    Ok(())
}

fn validate_host_entries(entries: &[String]) -> RegistryResult<()> {
    for entry in entries {
        if entry.trim().is_empty()
            || entry.contains('/')
            || entry.contains("://")
            || entry.chars().any(char::is_control)
        {
            return Err(RegistryError::InvalidEndpoint(format!(
                "allowed registry host entry {entry:?} is invalid"
            )));
        }
    }
    Ok(())
}
