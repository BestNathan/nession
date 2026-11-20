//! Host-independent OCI Registry Client SDK (#4089).
//!
//! Acquires an immutable image from any authorized OCI Distribution registry and
//! places its complete verified bytes in a caller-provided [`BlobStore`], without
//! coupling to a Server SQLite transaction. Network fetch, descriptor
//! verification and CAS ingest live here; optional local Catalog tag publication
//! stays with the Server adapter ([`super::pull::pull_image`]). An Agent may call
//! [`ingest_image`] / [`ingest_pinned`] and simply retain the pinned OCI objects.
//!
//! The SDK reuses the accepted #3498 [`RegistryClient`] (challenge auth, bounded
//! redirects, SSRF/host defenses, bounded bodies) and the #4087 [`BlobStore`]
//! contract (atomic dedupe by computed digest, verify-before-Ready). A tag is
//! resolved to an immutable digest before any payload fetch; a pinned digest is
//! fetched by digest from any authorized source, so tag movement on one registry
//! can never silently change the revision another source delivers.

use std::sync::Arc;

use anyhow::Context;

use super::auth::{ImportScope, RegistryCredentialProvider, RegistryImportAuthorizer};
use super::client::{FetchedManifest, RegistryClient, RegistryConfig};
use super::{is_loopback_host, RegistryError, RegistryResult, RemoteReference};
use crate::contracts::BlobStore;
use crate::oci::{
    parse_config, parse_index, parse_manifest, select_platform, validate_manifest,
    validate_manifest_config, Descriptor, ImageConfig, Platform, RawDocument, MEDIA_TYPE_INDEX,
    MEDIA_TYPE_MANIFEST,
};

/// One immutable image reference: a registry authority, a repository path and a
/// tag or digest. The registry is a base URL (`http://127.0.0.1:5000` or
/// `https://registry.example`); it never carries a credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageReference {
    /// The registry base URL (scheme + authority, no path, no credential).
    pub registry: String,
    /// The remote repository path (no registry host).
    pub repository: String,
    /// The remote tag or immutable digest.
    pub reference: RemoteReference,
}

impl ImageReference {
    /// Build a reference from explicit parts, validating the registry URL and
    /// the repository grammar.
    pub fn new(
        registry: impl Into<String>,
        repository: impl Into<String>,
        reference: RemoteReference,
    ) -> RegistryResult<Self> {
        let registry = registry.into();
        let repository = repository.into();
        RegistryConfig::new(&registry)?;
        super::validate_remote_repository(&repository)?;
        Ok(Self {
            registry,
            repository,
            reference,
        })
    }

    /// Parse `registry/repository:tag` or `registry/repository@sha256:<hex>`.
    ///
    /// The registry is the first path segment (an authority `host[:port]`); a
    /// loopback authority defaults to `http`, any other to `https`. The tag colon
    /// is the last colon after the last slash, so a registry port is never
    /// mistaken for a tag separator.
    pub fn parse(value: &str) -> RegistryResult<Self> {
        let (name, reference) = split_reference(value)?;
        let (registry, repository) = name.split_once('/').ok_or_else(|| {
            RegistryError::InvalidReference(
                "image reference must name a registry and a repository".to_string(),
            )
        })?;
        if registry.is_empty() || repository.is_empty() {
            return Err(RegistryError::InvalidReference(
                "image reference must name a registry and a repository".to_string(),
            ));
        }
        let base_url = canonical_registry_url(registry);
        Self::new(base_url, repository, reference)
    }

    /// A client for this reference's authority using a scoped credential
    /// provider. The provider is the only credential source; nothing here
    /// serializes a credential into a grant, config or log line.
    pub fn client(
        &self,
        credentials: Arc<dyn RegistryCredentialProvider>,
    ) -> RegistryResult<RegistryClient> {
        RegistryClient::new(RegistryConfig::new(&self.registry)?, credentials)
    }
}

/// Split the trailing `:tag` or `@digest` reference from an image name.
fn split_reference(value: &str) -> RegistryResult<(&str, RemoteReference)> {
    if let Some((name, digest)) = value.rsplit_once('@') {
        let reference = RemoteReference::parse(digest).map_err(RegistryError::InvalidReference)?;
        if reference.digest().is_none() {
            return Err(RegistryError::InvalidReference(
                "only sha256 digest references are supported".to_string(),
            ));
        }
        return Ok((name, reference));
    }
    let last_slash = value.rfind('/');
    match value.rfind(':') {
        Some(colon) if last_slash.is_none_or(|slash| colon > slash) => {
            let name = value.get(..colon).unwrap_or_default();
            let tag = value.get(colon + 1..).unwrap_or_default();
            let reference = RemoteReference::parse(tag).map_err(RegistryError::InvalidReference)?;
            Ok((name, reference))
        }
        _ => Err(RegistryError::InvalidReference(
            "image reference must include a tag or digest".to_string(),
        )),
    }
}

/// Give a bare `host[:port]` authority its canonical scheme.
fn canonical_registry_url(registry: &str) -> String {
    if registry.starts_with("http://") || registry.starts_with("https://") {
        return registry.to_string();
    }
    let host = if let Some(end) = registry.find(']') {
        registry.get(..=end).unwrap_or(registry)
    } else {
        registry.split(':').next().unwrap_or(registry)
    };
    if is_loopback_host(host) {
        format!("http://{registry}")
    } else {
        format!("https://{registry}")
    }
}

/// The complete verified closure of one pulled image, with its exact source
/// bytes. It carries no registry credential, token, URL or authorization header.
#[derive(Debug, Clone)]
pub struct VerifiedImage {
    /// The digest the remote tag (or digest reference) resolved to.
    pub source_digest: String,
    /// The media type of the resolved remote object.
    pub source_media_type: String,
    /// Exact source Manifest bytes.
    pub manifest: RawDocument,
    /// Exact source Config bytes.
    pub config: RawDocument,
    /// The raw EROFS layer descriptor.
    pub layer: Descriptor,
    /// The exact platform the Config declares.
    pub platform: Platform,
}

impl VerifiedImage {
    /// The imported Manifest digest.
    pub fn manifest_digest(&self) -> &str {
        self.manifest.digest()
    }
    /// The imported Config digest.
    pub fn config_digest(&self) -> &str {
        self.config.digest()
    }
    /// The imported raw EROFS layer digest.
    pub fn layer_digest(&self) -> &str {
        &self.layer.digest
    }
}

/// Pull one platform-specific image into a caller-provided CAS, with no catalog
/// publication. This is the host-independent SDK entry point.
///
/// Ordering: validate the remote repository and requested linux/erofs platform;
/// ask the source-policy authorizer before any network access; resolve the
/// tag/digest and select the exact Index child; verify Config against the
/// Manifest and platform; ingest the verified Manifest/Config/EROFS closure into
/// the store. A warm cache that already holds a verified object is not copied
/// again. Any failure leaves at most verified unreachable CAS bytes; no partial
/// or mismatched object is ever published Ready.
#[allow(clippy::too_many_arguments)]
pub async fn ingest_image<B: BlobStore + ?Sized>(
    client: &RegistryClient,
    store: &B,
    repository: &str,
    reference: &RemoteReference,
    platform: &Platform,
    authorizer: &dyn RegistryImportAuthorizer,
    local_repository: &str,
    local_tag: &str,
) -> RegistryResult<VerifiedImage> {
    super::validate_remote_repository(repository)?;
    validate_target_platform(platform)?;
    authorizer.authorize_import(&ImportScope {
        authority: client.authority(),
        repository,
        local_repository,
        local_tag,
        platform,
    })?;

    let resolved = client.fetch_manifest(repository, reference).await?;
    let source_digest = resolved.digest.clone();
    let source_media_type = resolved.media_type.clone();

    let (manifest_document, selected_platform) =
        select_manifest(client, repository, platform, resolved).await?;

    let (_, manifest) = parse_manifest(manifest_document.bytes()).map_err(|error| {
        RegistryError::MalformedManifest(format!("{}: {error:#}", manifest_document.digest()))
    })?;
    validate_manifest(&manifest).map_err(|error| {
        RegistryError::MalformedManifest(format!("{}: {error:#}", manifest_document.digest()))
    })?;

    // Config: adopt a verified warm-cache object without a second network read,
    // otherwise fetch and verify it. The bytes are held in memory and only
    // ingested into the CAS after the EROFS layer verifies below, so a failed or
    // interrupted layer transfer never leaves a Config (or Manifest) Ready.
    let config_descriptor = &manifest.config;
    let config_document = if store.contains(&config_descriptor.digest)?
        && store
            .verify_named_size(&config_descriptor.digest, config_descriptor.size)
            .is_ok()
    {
        RawDocument::from_bytes(store.read(&config_descriptor.digest)?)
    } else {
        client.fetch_config(repository, config_descriptor).await?
    };
    let (_, config) = parse_config(config_document.bytes()).map_err(|error| {
        RegistryError::MalformedConfig(format!("{}: {error:#}", config_document.digest()))
    })?;
    validate_manifest_config(&manifest, &config).map_err(|error| {
        RegistryError::MalformedConfig(format!("{}: {error:#}", config_document.digest()))
    })?;
    let config_platform = platform_of_config(&config);
    if !config_platform.matches(platform) {
        return Err(RegistryError::UnsupportedPlatform(format!(
            "Config targets {}/{} variant {:?}, not the requested {}/{} variant {:?}",
            config_platform.os,
            config_platform.architecture,
            config_platform.variant,
            platform.os,
            platform.architecture,
            platform.variant,
        )));
    }
    if let Some(selected) = selected_platform.as_ref() {
        if selected.os != config_platform.os
            || selected.architecture != config_platform.architecture
        {
            return Err(RegistryError::UnsupportedPlatform(format!(
                "selected Index child targets {}/{} but its Config targets {}/{}",
                selected.os,
                selected.architecture,
                config_platform.os,
                config_platform.architecture
            )));
        }
        if let (Some(selected_variant), Some(config_variant)) =
            (&selected.variant, &config_platform.variant)
        {
            if selected_variant != config_variant {
                return Err(RegistryError::UnsupportedPlatform(format!(
                    "selected Index child variant {selected_variant:?} disagrees with its Config variant {config_variant:?}"
                )));
            }
        }
    }

    let layer = manifest
        .layers
        .first()
        .context("validated Manifest has no EROFS layer")
        .map_err(|error| RegistryError::MalformedManifest(format!("{error:#}")))?
        .clone();
    // The layer is the last and largest object; only once it is verified Ready
    // do the Config and Manifest join it in the CAS. Atomic dedupe means a warm
    // retry re-publishes nothing, and an Agent retains the full pinned closure
    // without any Catalog publication.
    client.download_blob(store, repository, &layer).await?;
    store.put_bytes(config_document.bytes())?;
    store.put_bytes(manifest_document.bytes())?;

    Ok(VerifiedImage {
        source_digest,
        source_media_type,
        manifest: manifest_document,
        config: config_document,
        layer,
        platform: config_platform,
    })
}

/// Fetch one pinned image digest from any authorized source into a shared CAS.
///
/// The revision is pinned by digest before any source is contacted, so a tag
/// moving on one registry cannot change what another source delivers. Each
/// source is tried in order; the first that serves the verified closure wins and
/// every object lands under its computed digest, so two authorities serving the
/// same image produce a single local content-addressed identity (atomic dedupe).
#[allow(clippy::too_many_arguments)]
pub async fn ingest_pinned<B: BlobStore + ?Sized>(
    sources: &[ImageReference],
    pinned_digest: &str,
    store: &B,
    platform: &Platform,
    credentials: Arc<dyn RegistryCredentialProvider>,
    authorizer: &dyn RegistryImportAuthorizer,
    local_repository: &str,
    local_tag: &str,
) -> RegistryResult<VerifiedImage> {
    let pin = RemoteReference::parse(pinned_digest).map_err(RegistryError::InvalidReference)?;
    if pin.digest().is_none() {
        return Err(RegistryError::InvalidReference(
            "a pinned image reference must be a sha256 digest".to_string(),
        ));
    }
    if sources.is_empty() {
        return Err(RegistryError::InvalidReference(
            "at least one source authority is required".to_string(),
        ));
    }
    let mut last_error = None;
    for source in sources {
        let client = match source.client(Arc::clone(&credentials)) {
            Ok(client) => client,
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };
        match ingest_image(
            &client,
            store,
            &source.repository,
            &pin,
            platform,
            authorizer,
            local_repository,
            local_tag,
        )
        .await
        {
            Ok(image) => {
                if image.source_digest != pinned_digest {
                    return Err(RegistryError::DigestMismatch {
                        resource: format!("pinned image {pinned_digest}"),
                        expected: pinned_digest.to_string(),
                        actual: image.source_digest,
                    });
                }
                return Ok(image);
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        RegistryError::InvalidReference("no source authority produced the pinned image".to_string())
    }))
}

/// Resolve an Index to exactly one platform-specific child Manifest, or pass a
/// Manifest through unchanged. The wrong platform is never a fallback.
async fn select_manifest(
    client: &RegistryClient,
    repository: &str,
    platform: &Platform,
    resolved: FetchedManifest,
) -> RegistryResult<(RawDocument, Option<Platform>)> {
    if resolved.media_type == MEDIA_TYPE_INDEX {
        let (_, index) = parse_index(resolved.document.bytes()).map_err(|error| {
            RegistryError::MalformedIndex(format!("{}: {error:#}", resolved.digest))
        })?;
        let selected = select_platform(&index, platform)
            .map_err(|error| RegistryError::UnsupportedPlatform(format!("{error:#}")))?;
        if selected.media_type != MEDIA_TYPE_MANIFEST {
            return Err(RegistryError::UnsupportedPlatform(format!(
                "Index child {} is {:?}, not an image manifest",
                selected.digest, selected.media_type
            )));
        }
        let selected_platform = selected.platform.clone();
        let child = client
            .fetch_manifest(
                repository,
                &RemoteReference::Digest(selected.digest.clone()),
            )
            .await?;
        if child.media_type != MEDIA_TYPE_MANIFEST {
            return Err(RegistryError::MediaTypeMismatch {
                resource: format!("Index child {}", selected.digest),
                expected: MEDIA_TYPE_MANIFEST.to_string(),
                actual: child.media_type,
            });
        }
        let child_size = child
            .document
            .size()
            .map_err(|error| RegistryError::MalformedManifest(format!("{error:#}")))?;
        if child_size != selected.size {
            return Err(RegistryError::SizeMismatch {
                resource: format!("Index child {}", selected.digest),
                expected: selected.size,
                actual: child_size,
            });
        }
        if child.digest != selected.digest {
            return Err(RegistryError::DigestMismatch {
                resource: format!("Index child {}", selected.digest),
                expected: selected.digest.clone(),
                actual: child.digest,
            });
        }
        Ok((child.document, selected_platform))
    } else {
        Ok((resolved.document, None))
    }
}

fn validate_target_platform(platform: &Platform) -> RegistryResult<()> {
    if platform.os != "linux" {
        return Err(RegistryError::UnsupportedPlatform(format!(
            "requested os {:?}: only linux EROFS images are supported",
            platform.os
        )));
    }
    if platform.architecture.trim().is_empty() {
        return Err(RegistryError::UnsupportedPlatform(
            "requested architecture must not be empty".to_string(),
        ));
    }
    if !platform.supports_erofs() {
        return Err(RegistryError::UnsupportedPlatform(
            "requested platform must include the erofs os feature".to_string(),
        ));
    }
    Ok(())
}

fn platform_of_config(config: &ImageConfig) -> Platform {
    Platform {
        architecture: config.architecture.clone(),
        os: config.os.clone(),
        os_version: config.os_version.clone(),
        os_features: config.os_features.clone(),
        variant: config.variant.clone(),
        features: None,
        extra: serde_json::Map::new(),
    }
}

#[cfg(test)]
mod tests;
