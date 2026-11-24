//! Manifest-aware Agent cache fetch (#3499).
//!
//! A Server grant names one resolved Manifest and its reachable Config/EROFS
//! descriptors. This module fetches exactly that set through the existing
//! verified cache, validates every descriptor against the parsed documents,
//! and returns the EROFS layer identity the mount layer consumes.
//!
//! Only the EROFS payload is a physical image identity. Index/Manifest/Config
//! metadata is cached under its own digest, so two Manifests that share one
//! EROFS layer download that payload once and produce one physical file, while
//! each keeps independent Config/Manifest metadata.

use anyhow::{Context, Result};
use std::collections::HashSet;
use std::path::PathBuf;

use crate::cache::{CachedImage, DownloadGrant, ErofsCache};
use crate::oci::annotation::{
    MEDIA_TYPE_COMPOSITE, MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_MANIFEST,
};
use crate::oci::composite::{
    parse_composite, validate_composite_manifest_config, CompositeDescriptor,
};
use crate::oci::config::ImageConfig;
use crate::oci::descriptor::Descriptor;
use crate::oci::manifest::Manifest;
use crate::oci::validation::validate_manifest_config;
use crate::oci::{parse_config, parse_manifest};

/// One authorized OCI object route handed to the Agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageObjectGrant {
    pub digest: String,
    pub media_type: String,
    pub size_bytes: u64,
    pub path: String,
}

/// The verified objects of one resolved Manifest.
#[derive(Debug, Clone)]
pub struct FetchedImage {
    pub manifest_digest: String,
    pub config_digest: String,
    pub layer: Descriptor,
    /// The verified local EROFS payload path (the physical mount identity).
    pub layer_path: PathBuf,
    pub manifest: Manifest,
    pub config: ImageConfig,
    /// Every object fetched or adopted from the cache, in grant order.
    pub objects: Vec<CachedImage>,
}

/// The verified objects of one referenced Composite Manifest (#3697).
#[derive(Debug, Clone)]
pub struct FetchedComposite {
    pub manifest_digest: String,
    pub config_digest: String,
    pub manifest: Manifest,
    pub config: ImageConfig,
    pub composite_digest: String,
    pub composite: CompositeDescriptor,
    /// The primary metadata EROFS device.
    pub metadata: Descriptor,
    pub metadata_path: PathBuf,
    /// Ordered backing EROFS devices.
    pub devices: Vec<Descriptor>,
    pub device_paths: Vec<PathBuf>,
    /// Every object fetched or adopted from the cache, in closure order.
    pub objects: Vec<CachedImage>,
}

/// Bound for Index/Manifest/Config/Composite metadata. Metadata is parsed into
/// memory, so it is never allowed to grow to payload size.
pub const MAX_METADATA_BYTES: u64 = 16 * 1024 * 1024;

/// Fetch one resolved Manifest and its reachable Config/EROFS objects.
///
/// Failures are closed: a missing, duplicated, mis-typed, over-sized or
/// descriptor-mismatched object yields no `FetchedImage`, so no caller can
/// mount a guessed or partially verified identity. `route_prefix` is the
/// Protocol owner's blob route (the crate does not duplicate that constant).
///
/// This is the proprietary compatibility path (`/images/blobs/<digest>`). The
/// standard OCI Distribution cutover target is [`fetch_manifest_image_v2`];
/// both share one verified fetch implementation during the compatibility window.
pub async fn fetch_manifest_image(
    cache: &ErofsCache,
    objects: &[ImageObjectGrant],
    origin: &str,
    server_auth_token: &str,
    route_prefix: &str,
) -> Result<FetchedImage> {
    fetch_manifest_image_with_route(cache, objects, origin, server_auth_token, &|object| {
        format!("{route_prefix}{}", object.digest)
    })
    .await
}

/// Fetch one resolved Manifest closure through a Server-hosted standard OCI
/// `/v2/` Registry (#4090), with no proprietary download URL.
///
/// The grant names one authorized `repository`; the Manifest is fetched by its
/// immutable digest through `/v2/{repository}/manifests/{digest}` and the
/// Config/EROFS objects through `/v2/{repository}/blobs/{digest}`. Every route
/// is repository-scoped, so the Server's reachability fence — not possession of
/// a digest — decides what the Agent may read. The verified cache mechanics,
/// descriptor validation and pin semantics are identical to the proprietary
/// path: this is the same SDK/cache fetch, only the authorized route shape
/// changes for the cutover.
pub async fn fetch_manifest_image_v2(
    cache: &ErofsCache,
    objects: &[ImageObjectGrant],
    origin: &str,
    server_auth_token: &str,
    repository: &str,
) -> Result<FetchedImage> {
    crate::contracts::validate_repository_name(repository)?;
    fetch_manifest_image_with_route(cache, objects, origin, server_auth_token, &|object| {
        if object.media_type == MEDIA_TYPE_MANIFEST {
            format!("/v2/{repository}/manifests/{}", object.digest)
        } else {
            format!("/v2/{repository}/blobs/{}", object.digest)
        }
    })
    .await
}

/// The one verified fetch implementation shared by the proprietary and `/v2/`
/// route shapes. `expected_route` computes the authorized route for each object;
/// a grant whose path disagrees is refused before any network request.
async fn fetch_manifest_image_with_route(
    cache: &ErofsCache,
    objects: &[ImageObjectGrant],
    origin: &str,
    server_auth_token: &str,
    expected_route: &(dyn Fn(&ImageObjectGrant) -> String + Sync),
) -> Result<FetchedImage> {
    let manifest_grant = exactly_one(objects, MEDIA_TYPE_MANIFEST, "Manifest")?;
    let config_grant = exactly_one(objects, MEDIA_TYPE_CONFIG, "Config")?;
    let layer_grant = exactly_one(objects, MEDIA_TYPE_EROFS, "EROFS layer")?;
    if objects.len() != 3 {
        anyhow::bail!(
            "a resolved v1 image has exactly a Manifest, Config and EROFS layer; got {} objects",
            objects.len()
        );
    }
    let mut seen = HashSet::new();
    for object in objects {
        if !seen.insert(object.digest.as_str()) {
            anyhow::bail!("duplicate authorized object {}", object.digest);
        }
        if !crate::digest::is_valid_digest(&object.digest) {
            anyhow::bail!("invalid authorized object digest {:?}", object.digest);
        }
        let expected = expected_route(object);
        if object.path != expected {
            anyhow::bail!(
                "authorized route {:?} is not the blob route for {}",
                object.path,
                object.digest
            );
        }
        if object.size_bytes == 0 {
            anyhow::bail!("authorized object {} declares an empty size", object.digest);
        }
    }
    if manifest_grant.size_bytes > MAX_METADATA_BYTES {
        anyhow::bail!(
            "Manifest {} declares {} bytes, above the metadata bound {MAX_METADATA_BYTES}",
            manifest_grant.digest,
            manifest_grant.size_bytes
        );
    }
    if config_grant.size_bytes > MAX_METADATA_BYTES {
        anyhow::bail!(
            "Config {} declares {} bytes, above the metadata bound {MAX_METADATA_BYTES}",
            config_grant.digest,
            config_grant.size_bytes
        );
    }

    let manifest_cached = fetch_object(cache, manifest_grant, origin, server_auth_token, true)
        .await
        .with_context(|| format!("cannot fetch Manifest {}", manifest_grant.digest))?;
    let manifest_bytes = tokio::fs::read(&manifest_cached.path)
        .await
        .with_context(|| format!("cannot read Manifest {}", manifest_grant.digest))?;
    let (_, manifest) = parse_manifest(&manifest_bytes)?;
    if manifest.config.digest != config_grant.digest
        || manifest.config.media_type != config_grant.media_type
        || manifest.config.size != config_grant.size_bytes
    {
        anyhow::bail!(
            "Manifest {} does not describe the authorized Config {}",
            manifest_grant.digest,
            config_grant.digest
        );
    }
    let layer = manifest
        .layers
        .first()
        .context("resolved Manifest has no EROFS layer")?
        .clone();
    if layer.digest != layer_grant.digest
        || layer.media_type != layer_grant.media_type
        || layer.size != layer_grant.size_bytes
    {
        anyhow::bail!(
            "Manifest {} does not describe the authorized EROFS layer {}",
            manifest_grant.digest,
            layer_grant.digest
        );
    }

    let config_cached = fetch_object(cache, config_grant, origin, server_auth_token, true)
        .await
        .with_context(|| format!("cannot fetch Config {}", config_grant.digest))?;
    let config_bytes = tokio::fs::read(&config_cached.path)
        .await
        .with_context(|| format!("cannot read Config {}", config_grant.digest))?;
    let (_, config) = parse_config(&config_bytes)?;
    validate_manifest_config(&manifest, &config)?;

    // The payload is fetched by its own EROFS digest: two Manifests that name
    // the same layer share this one verified physical file.
    let layer_cached = fetch_object(cache, layer_grant, origin, server_auth_token, false)
        .await
        .with_context(|| format!("cannot fetch EROFS layer {}", layer_grant.digest))?;
    Ok(FetchedImage {
        manifest_digest: manifest_grant.digest.clone(),
        config_digest: config_grant.digest.clone(),
        layer,
        layer_path: layer_cached.path.clone(),
        manifest,
        config,
        objects: vec![manifest_cached, config_cached, layer_cached],
    })
}

/// Fetch one referenced Composite Manifest, its descriptor and every backing
/// device into the verified cache (#3697).
///
/// The grant must contain exactly the Manifest, Config, Composite descriptor
/// and the descriptor's complete metadata/device closure. A missing, extra,
/// duplicated, mis-typed or descriptor-mismatched object yields no
/// `FetchedComposite`; no caller can mount a partial closure.
pub async fn fetch_composite_image(
    cache: &ErofsCache,
    objects: &[ImageObjectGrant],
    origin: &str,
    server_auth_token: &str,
    route_prefix: &str,
) -> Result<FetchedComposite> {
    fetch_composite_image_with_route(cache, objects, origin, server_auth_token, &|object| {
        format!("{route_prefix}{}", object.digest)
    })
    .await
}

/// Fetch one referenced Composite Manifest closure through a Server-hosted
/// standard OCI `/v2/` Registry (#4250), with no proprietary download URL.
///
/// The grant names one authorized `repository`; the Manifest is fetched by its
/// immutable digest through `/v2/{repository}/manifests/{digest}` and the
/// Config/Composite descriptor/metadata/device objects through
/// `/v2/{repository}/blobs/{digest}`. The Server's repository reachability fence
/// already expands the Composite closure, so every device is repository-scoped.
/// The verified cache mechanics, descriptor validation and pin semantics are
/// identical to the proprietary path: this is the same SDK/cache fetch, only the
/// authorized route shape changes for the cutover.
pub async fn fetch_composite_image_v2(
    cache: &ErofsCache,
    objects: &[ImageObjectGrant],
    origin: &str,
    server_auth_token: &str,
    repository: &str,
) -> Result<FetchedComposite> {
    crate::contracts::validate_repository_name(repository)?;
    fetch_composite_image_with_route(cache, objects, origin, server_auth_token, &|object| {
        if object.media_type == MEDIA_TYPE_MANIFEST {
            format!("/v2/{repository}/manifests/{}", object.digest)
        } else {
            format!("/v2/{repository}/blobs/{}", object.digest)
        }
    })
    .await
}

/// The one verified Composite fetch implementation shared by the proprietary and
/// `/v2/` route shapes. `expected_route` computes the authorized route for each
/// object; a grant whose path disagrees is refused before any network request.
async fn fetch_composite_image_with_route(
    cache: &ErofsCache,
    objects: &[ImageObjectGrant],
    origin: &str,
    server_auth_token: &str,
    expected_route: &(dyn Fn(&ImageObjectGrant) -> String + Sync),
) -> Result<FetchedComposite> {
    let manifest_grant = exactly_one(objects, MEDIA_TYPE_MANIFEST, "Manifest")?;
    let config_grant = exactly_one(objects, MEDIA_TYPE_CONFIG, "Config")?;
    let composite_grant = exactly_one(objects, MEDIA_TYPE_COMPOSITE, "Composite descriptor")?;
    let mut seen = HashSet::new();
    for object in objects {
        if !seen.insert(object.digest.as_str()) {
            anyhow::bail!("duplicate authorized object {}", object.digest);
        }
        if !crate::digest::is_valid_digest(&object.digest) {
            anyhow::bail!("invalid authorized object digest {:?}", object.digest);
        }
        let expected = expected_route(object);
        if object.path != expected {
            anyhow::bail!(
                "authorized route {:?} is not the blob route for {}",
                object.path,
                object.digest
            );
        }
        if object.size_bytes == 0 {
            anyhow::bail!("authorized object {} declares an empty size", object.digest);
        }
    }
    for grant in [manifest_grant, config_grant, composite_grant] {
        if grant.size_bytes > MAX_METADATA_BYTES {
            anyhow::bail!(
                "{} {} declares {} bytes, above the metadata bound {MAX_METADATA_BYTES}",
                grant.media_type,
                grant.digest,
                grant.size_bytes
            );
        }
    }

    let manifest_cached = fetch_object(cache, manifest_grant, origin, server_auth_token, true)
        .await
        .with_context(|| format!("cannot fetch Manifest {}", manifest_grant.digest))?;
    let manifest_bytes = tokio::fs::read(&manifest_cached.path).await?;
    let (_, manifest) = parse_manifest(&manifest_bytes)?;
    if manifest.config.digest != config_grant.digest
        || manifest.config.media_type != config_grant.media_type
        || manifest.config.size != config_grant.size_bytes
    {
        anyhow::bail!(
            "Manifest {} does not describe the authorized Config {}",
            manifest_grant.digest,
            config_grant.digest
        );
    }
    let layer = manifest
        .layers
        .first()
        .context("Composite Manifest has no layer")?;
    if layer.media_type != MEDIA_TYPE_COMPOSITE
        || layer.digest != composite_grant.digest
        || layer.size != composite_grant.size_bytes
    {
        anyhow::bail!(
            "Manifest {} does not describe the authorized Composite descriptor {}",
            manifest_grant.digest,
            composite_grant.digest
        );
    }
    let config_cached = fetch_object(cache, config_grant, origin, server_auth_token, true)
        .await
        .with_context(|| format!("cannot fetch Config {}", config_grant.digest))?;
    let config_bytes = tokio::fs::read(&config_cached.path).await?;
    let (_, config) = parse_config(&config_bytes)?;
    let composite_cached = fetch_object(cache, composite_grant, origin, server_auth_token, true)
        .await
        .with_context(|| {
            format!(
                "cannot fetch Composite descriptor {}",
                composite_grant.digest
            )
        })?;
    let composite_bytes = tokio::fs::read(&composite_cached.path).await?;
    let composite = parse_composite(&composite_bytes)?;
    let closure = composite.closure()?;
    validate_composite_manifest_config(&manifest, &config, &composite, layer)?;

    if objects.len() != closure.len() + 3 {
        anyhow::bail!(
            "the authorized object set has {} objects, the Composite closure requires {}",
            objects.len(),
            closure.len() + 3
        );
    }
    let mut metadata_path = None;
    let mut device_paths = Vec::new();
    let mut fetched_objects = vec![manifest_cached, config_cached, composite_cached];
    for (position, descriptor) in closure.iter().enumerate() {
        let grant = objects
            .iter()
            .find(|object| object.digest == descriptor.digest)
            .with_context(|| {
                format!(
                    "the authorized object set has no Composite device {}",
                    descriptor.digest
                )
            })?;
        if grant.media_type != descriptor.media_type || grant.size_bytes != descriptor.size {
            anyhow::bail!(
                "authorized device {} descriptor does not match the Composite closure",
                descriptor.digest
            );
        }
        let cached = fetch_object(cache, grant, origin, server_auth_token, false)
            .await
            .with_context(|| format!("cannot fetch Composite device {}", descriptor.digest))?;
        if position == 0 {
            metadata_path = Some(cached.path.clone());
        } else {
            device_paths.push(cached.path.clone());
        }
        fetched_objects.push(cached);
    }
    Ok(FetchedComposite {
        manifest_digest: manifest_grant.digest.clone(),
        config_digest: config_grant.digest.clone(),
        manifest,
        config,
        composite_digest: composite_grant.digest.clone(),
        composite,
        metadata: closure
            .first()
            .cloned()
            .context("Composite closure has no metadata device")?,
        metadata_path: metadata_path.context("Composite metadata was not fetched")?,
        devices: closure.into_iter().skip(1).collect(),
        device_paths,
        objects: fetched_objects,
    })
}

async fn fetch_object(
    cache: &ErofsCache,
    object: &ImageObjectGrant,
    origin: &str,
    server_auth_token: &str,
    metadata: bool,
) -> Result<CachedImage> {
    let grant = DownloadGrant {
        url: format!("{origin}{}", object.path),
        token: server_auth_token.to_string(),
    };
    let cached = cache
        .get_or_fetch_bounded(&object.digest, &grant, Some(object.size_bytes))
        .await?;
    if cached.size_bytes != object.size_bytes {
        anyhow::bail!(
            "fetched {} has {} bytes, its descriptor claims {}",
            object.digest,
            cached.size_bytes,
            object.size_bytes
        );
    }
    if metadata && cached.size_bytes > MAX_METADATA_BYTES {
        anyhow::bail!(
            "fetched metadata {} exceeds the metadata bound {MAX_METADATA_BYTES}",
            object.digest
        );
    }
    Ok(cached)
}

fn exactly_one<'a>(
    objects: &'a [ImageObjectGrant],
    media_type: &str,
    label: &str,
) -> Result<&'a ImageObjectGrant> {
    let mut matches = objects
        .iter()
        .filter(|object| object.media_type == media_type);
    let first = matches
        .next()
        .with_context(|| format!("the authorized object set has no {label}"))?;
    if matches.next().is_some() {
        anyhow::bail!("the authorized object set has more than one {label}");
    }
    Ok(first)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oci::config::{RootFs, RuntimeConfig};
    use crate::oci::descriptor::Descriptor;
    use crate::oci::{to_bytes, RawDocument};
    use httptest::{matchers::*, Expectation, Server};
    use serde_json::Map;

    const ROUTE_PREFIX: &str = "/images/blobs/";
    const TOKEN: &str = "server-auth-token";

    async fn cache(root: &std::path::Path) -> ErofsCache {
        ErofsCache::open(root, "agent-fetch", false).await.unwrap()
    }

    struct Fixture {
        manifest: RawDocument,
        config: RawDocument,
        layer: RawDocument,
    }

    fn fixture(payload: &[u8], env: &str) -> Fixture {
        let layer = RawDocument::from_bytes(payload.to_vec());
        let config = ImageConfig {
            created: None,
            author: None,
            architecture: "amd64".to_string(),
            os: "linux".to_string(),
            os_version: None,
            os_features: Some(vec!["erofs".to_string()]),
            variant: None,
            config: RuntimeConfig {
                env: Some(vec![format!("K={env}")]),
                ..RuntimeConfig::default()
            },
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
            config: Descriptor {
                media_type: MEDIA_TYPE_CONFIG.to_string(),
                digest: config.digest().to_string(),
                size: config.size().unwrap(),
                urls: None,
                annotations: None,
                platform: None,
                artifact_type: None,
                data: None,
                extra: Map::new(),
            },
            layers: vec![Descriptor {
                media_type: MEDIA_TYPE_EROFS.to_string(),
                digest: layer.digest().to_string(),
                size: layer.size().unwrap(),
                urls: None,
                annotations: None,
                platform: None,
                artifact_type: None,
                data: None,
                extra: Map::new(),
            }],
            subject: None,
            artifact_type: None,
            annotations: None,
            extra: Map::new(),
        };
        Fixture {
            manifest: RawDocument::from_bytes(to_bytes(&manifest).unwrap()),
            config,
            layer,
        }
    }

    fn grants(fixture: &Fixture) -> Vec<ImageObjectGrant> {
        vec![
            ImageObjectGrant {
                digest: fixture.manifest.digest().to_string(),
                media_type: MEDIA_TYPE_MANIFEST.to_string(),
                size_bytes: fixture.manifest.size().unwrap(),
                path: format!("{ROUTE_PREFIX}{}", fixture.manifest.digest()),
            },
            ImageObjectGrant {
                digest: fixture.config.digest().to_string(),
                media_type: MEDIA_TYPE_CONFIG.to_string(),
                size_bytes: fixture.config.size().unwrap(),
                path: format!("{ROUTE_PREFIX}{}", fixture.config.digest()),
            },
            ImageObjectGrant {
                digest: fixture.layer.digest().to_string(),
                media_type: MEDIA_TYPE_EROFS.to_string(),
                size_bytes: fixture.layer.size().unwrap(),
                path: format!("{ROUTE_PREFIX}{}", fixture.layer.digest()),
            },
        ]
    }

    fn serve(server: &Server, bytes: &[u8], digest: &str, times: usize) {
        server.expect(
            Expectation::matching(request::method_path(
                "GET",
                format!("{ROUTE_PREFIX}{digest}"),
            ))
            .times(times)
            .respond_with(
                httptest::http::Response::builder()
                    .status(200)
                    .body(bytes.to_vec())
                    .unwrap(),
            ),
        );
    }

    #[tokio::test]
    async fn two_manifests_share_one_payload_download_and_one_physical_file() {
        let dir = tempfile::tempdir().unwrap();
        let first = fixture(b"one shared erofs payload", "one");
        let second = fixture(b"one shared erofs payload", "two");
        assert_eq!(first.layer.digest(), second.layer.digest());
        assert_ne!(first.manifest.digest(), second.manifest.digest());
        let server = Server::run();
        serve(&server, first.manifest.bytes(), first.manifest.digest(), 1);
        serve(&server, first.config.bytes(), first.config.digest(), 1);
        serve(
            &server,
            second.manifest.bytes(),
            second.manifest.digest(),
            1,
        );
        serve(&server, second.config.bytes(), second.config.digest(), 1);
        // The shared payload is authorized once per Manifest but transferred
        // exactly once.
        serve(&server, first.layer.bytes(), first.layer.digest(), 1);
        let cache = cache(dir.path()).await;
        let origin = server
            .url("/")
            .to_string()
            .trim_end_matches('/')
            .to_string();

        let first_fetched =
            fetch_manifest_image(&cache, &grants(&first), &origin, TOKEN, ROUTE_PREFIX)
                .await
                .unwrap();
        let second_fetched =
            fetch_manifest_image(&cache, &grants(&second), &origin, TOKEN, ROUTE_PREFIX)
                .await
                .unwrap();
        assert_eq!(first_fetched.layer_path, second_fetched.layer_path);
        assert_eq!(
            first_fetched.manifest_digest,
            first.manifest.digest().to_string()
        );
        assert_eq!(
            second_fetched.manifest_digest,
            second.manifest.digest().to_string()
        );
        assert_ne!(first_fetched.config_digest, second_fetched.config_digest);
        assert_eq!(first_fetched.config.env(), &["K=one".to_string()]);
        assert_eq!(second_fetched.config.env(), &["K=two".to_string()]);
        assert_eq!(
            cache.fetch_count(),
            5,
            "two Manifests/Configs and one payload"
        );
        assert_eq!(
            cache.bytes_transferred(),
            (first.manifest.size().unwrap()
                + first.config.size().unwrap()
                + first.layer.size().unwrap()
                + second.manifest.size().unwrap()
                + second.config.size().unwrap())
        );
        let ready = std::fs::read_dir(cache.root().join("sha256"))
            .unwrap()
            .count();
        assert_eq!(ready, 5, "one physical file per distinct object digest");
        assert_eq!(
            std::fs::read(&first_fetched.layer_path).unwrap(),
            b"one shared erofs payload"
        );
    }

    fn composite_fixture() -> (
        RawDocument,
        RawDocument,
        RawDocument,
        Vec<RawDocument>,
        crate::oci::composite::CompositeDescriptor,
    ) {
        use crate::oci::composite::CompositeDescriptor;
        use crate::oci::descriptor::{Descriptor, Platform};
        use crate::oci::MEDIA_TYPE_COMPOSITE;
        let device = |name: &str| RawDocument::from_bytes(name.as_bytes().to_vec());
        let metadata = device("metadata erofs bytes");
        let first = device("node backing bytes");
        let second = device("dsh backing bytes");
        let descriptor_of = |document: &RawDocument| Descriptor {
            media_type: MEDIA_TYPE_EROFS.to_string(),
            digest: document.digest().to_string(),
            size: document.size().unwrap(),
            urls: None,
            annotations: None,
            platform: None,
            artifact_type: None,
            data: None,
            extra: Map::new(),
        };
        let descriptors = [
            descriptor_of(&metadata),
            descriptor_of(&first),
            descriptor_of(&second),
        ];
        let composite = CompositeDescriptor::new(
            &Platform::for_consumer("linux", "amd64", None),
            &descriptors[0],
            &[descriptors[1].clone(), descriptors[2].clone()],
        )
        .unwrap();
        let composite_document = composite.to_document().unwrap();
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
                fs_type: crate::oci::composite::COMPOSITE_ROOTFS_TYPE.to_string(),
                diff_ids: composite
                    .closure()
                    .unwrap()
                    .into_iter()
                    .map(|descriptor| descriptor.digest)
                    .collect(),
                extra: Map::new(),
            },
            history: Vec::new(),
            extra: Map::new(),
        };
        let config = RawDocument::from_bytes(to_bytes(&config).unwrap());
        let manifest = Manifest {
            schema_version: 2,
            media_type: Some(MEDIA_TYPE_MANIFEST.to_string()),
            config: Descriptor {
                media_type: MEDIA_TYPE_CONFIG.to_string(),
                digest: config.digest().to_string(),
                size: config.size().unwrap(),
                urls: None,
                annotations: None,
                platform: None,
                artifact_type: None,
                data: None,
                extra: Map::new(),
            },
            layers: vec![Descriptor {
                media_type: MEDIA_TYPE_COMPOSITE.to_string(),
                digest: composite_document.digest().to_string(),
                size: composite_document.size().unwrap(),
                urls: None,
                annotations: None,
                platform: None,
                artifact_type: None,
                data: None,
                extra: Map::new(),
            }],
            subject: None,
            artifact_type: None,
            annotations: None,
            extra: Map::new(),
        };
        let manifest = RawDocument::from_bytes(to_bytes(&manifest).unwrap());
        (
            manifest,
            config,
            composite_document,
            vec![metadata, first, second],
            composite,
        )
    }

    fn composite_grants(
        manifest: &RawDocument,
        config: &RawDocument,
        composite: &RawDocument,
        devices: &[RawDocument],
    ) -> Vec<ImageObjectGrant> {
        use crate::oci::MEDIA_TYPE_COMPOSITE;
        let mut objects = vec![
            ImageObjectGrant {
                digest: manifest.digest().to_string(),
                media_type: MEDIA_TYPE_MANIFEST.to_string(),
                size_bytes: manifest.size().unwrap(),
                path: format!("{ROUTE_PREFIX}{}", manifest.digest()),
            },
            ImageObjectGrant {
                digest: config.digest().to_string(),
                media_type: MEDIA_TYPE_CONFIG.to_string(),
                size_bytes: config.size().unwrap(),
                path: format!("{ROUTE_PREFIX}{}", config.digest()),
            },
            ImageObjectGrant {
                digest: composite.digest().to_string(),
                media_type: MEDIA_TYPE_COMPOSITE.to_string(),
                size_bytes: composite.size().unwrap(),
                path: format!("{ROUTE_PREFIX}{}", composite.digest()),
            },
        ];
        for device in devices {
            objects.push(ImageObjectGrant {
                digest: device.digest().to_string(),
                media_type: MEDIA_TYPE_EROFS.to_string(),
                size_bytes: device.size().unwrap(),
                path: format!("{ROUTE_PREFIX}{}", device.digest()),
            });
        }
        objects
    }

    #[tokio::test]
    async fn a_composite_fetches_every_closure_object_and_returns_ordered_devices() {
        let dir = tempfile::tempdir().unwrap();
        let (manifest, config, composite_document, devices, descriptor) = composite_fixture();
        assert_eq!(descriptor.devices.len(), 2);
        let grants = composite_grants(&manifest, &config, &composite_document, &devices);
        let server = Server::run();
        for document in [&manifest, &config, &composite_document] {
            serve(&server, document.bytes(), document.digest(), 1);
        }
        for device in &devices {
            serve(&server, device.bytes(), device.digest(), 1);
        }
        let cache = cache(dir.path()).await;
        let fetched = fetch_composite_image(
            &cache,
            &grants,
            server.url("/").to_string().trim_end_matches('/'),
            TOKEN,
            ROUTE_PREFIX,
        )
        .await
        .unwrap();
        assert_eq!(fetched.manifest_digest, manifest.digest());
        assert_eq!(fetched.composite_digest, composite_document.digest());
        assert_eq!(
            fetched.metadata.digest,
            devices.first().unwrap().digest(),
            "the metadata device is first"
        );
        assert_eq!(
            fetched
                .devices
                .iter()
                .map(|device| device.digest.as_str())
                .collect::<Vec<_>>(),
            vec![devices[1].digest(), devices[2].digest()]
        );
        assert_eq!(fetched.device_paths.len(), 2);
        assert!(fetched.metadata_path.is_file());
        for path in &fetched.device_paths {
            assert!(path.is_file());
        }
        assert_eq!(cache.fetch_count(), 6);
    }

    #[tokio::test]
    async fn a_composite_fetches_its_closure_over_v2_routes() {
        let dir = tempfile::tempdir().unwrap();
        let (manifest, config, composite_document, devices, _) = composite_fixture();
        let repository = "team/app";
        let v2_path = |document: &RawDocument, media_type: &str| {
            if media_type == MEDIA_TYPE_MANIFEST {
                format!("/v2/{repository}/manifests/{}", document.digest())
            } else {
                format!("/v2/{repository}/blobs/{}", document.digest())
            }
        };
        let mut grants = vec![
            ImageObjectGrant {
                digest: manifest.digest().to_string(),
                media_type: MEDIA_TYPE_MANIFEST.to_string(),
                size_bytes: manifest.size().unwrap(),
                path: v2_path(&manifest, MEDIA_TYPE_MANIFEST),
            },
            ImageObjectGrant {
                digest: config.digest().to_string(),
                media_type: MEDIA_TYPE_CONFIG.to_string(),
                size_bytes: config.size().unwrap(),
                path: v2_path(&config, MEDIA_TYPE_CONFIG),
            },
            ImageObjectGrant {
                digest: composite_document.digest().to_string(),
                media_type: MEDIA_TYPE_COMPOSITE.to_string(),
                size_bytes: composite_document.size().unwrap(),
                path: v2_path(&composite_document, MEDIA_TYPE_COMPOSITE),
            },
        ];
        for device in &devices {
            grants.push(ImageObjectGrant {
                digest: device.digest().to_string(),
                media_type: MEDIA_TYPE_EROFS.to_string(),
                size_bytes: device.size().unwrap(),
                path: v2_path(device, MEDIA_TYPE_EROFS),
            });
        }
        let server = Server::run();
        for grant in &grants {
            server.expect(
                Expectation::matching(request::method_path("GET", grant.path.clone()))
                    .times(1)
                    .respond_with(
                        httptest::http::Response::builder()
                            .status(200)
                            .body(
                                [&manifest, &config, &composite_document]
                                    .into_iter()
                                    .chain(devices.iter())
                                    .find(|document| document.digest() == grant.digest)
                                    .unwrap()
                                    .bytes()
                                    .to_vec(),
                            )
                            .unwrap(),
                    ),
            );
        }
        let cache = cache(dir.path()).await;
        let fetched = fetch_composite_image_v2(
            &cache,
            &grants,
            server.url("/").to_string().trim_end_matches('/'),
            TOKEN,
            repository,
        )
        .await
        .unwrap();
        assert_eq!(fetched.manifest_digest, manifest.digest());
        assert_eq!(fetched.composite_digest, composite_document.digest());
        assert_eq!(fetched.metadata.digest, devices.first().unwrap().digest());
        assert_eq!(fetched.device_paths.len(), 2);
        assert_eq!(cache.fetch_count(), 6);
    }

    #[tokio::test]
    async fn a_composite_v2_grant_on_the_proprietary_route_fails_before_network() {
        let dir = tempfile::tempdir().unwrap();
        let (manifest, config, composite_document, devices, _) = composite_fixture();
        // The grant carries the legacy compatibility route, but the caller asks
        // for the `/v2/` fetch: the route mismatch is refused before any request.
        let grants = composite_grants(&manifest, &config, &composite_document, &devices);
        let server = Server::run();
        let cache = cache(dir.path()).await;
        let error = fetch_composite_image_v2(
            &cache,
            &grants,
            server.url("/").to_string().trim_end_matches('/'),
            TOKEN,
            "team/app",
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(error.contains("is not the blob route"), "{error}");
        assert_eq!(cache.fetch_count(), 0);
    }

    #[tokio::test]
    async fn a_composite_grant_missing_a_device_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let (manifest, config, composite_document, devices, _) = composite_fixture();
        let mut grants = composite_grants(&manifest, &config, &composite_document, &devices);
        grants.pop();
        let server = Server::run();
        for document in [&manifest, &config, &composite_document] {
            serve(&server, document.bytes(), document.digest(), 1);
        }
        let cache = cache(dir.path()).await;
        let error = fetch_composite_image(
            &cache,
            &grants,
            server.url("/").to_string().trim_end_matches('/'),
            TOKEN,
            ROUTE_PREFIX,
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(
            error.contains("requires 6") || error.contains("no Composite device"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn a_descriptor_mismatch_fails_before_the_payload_is_fetched() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = fixture(b"payload", "one");
        let mut grants = grants(&fixture);
        // The authorized Config descriptor does not match the Manifest.
        grants[1].size_bytes += 1;
        let server = Server::run();
        serve(
            &server,
            fixture.manifest.bytes(),
            fixture.manifest.digest(),
            1,
        );
        // No Config or payload expectation: the mismatch must fail before
        // either is requested.
        let cache = cache(dir.path()).await;
        let error = fetch_manifest_image(
            &cache,
            &grants,
            server.url("/").to_string().trim_end_matches('/'),
            TOKEN,
            ROUTE_PREFIX,
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(
            error.contains("does not describe the authorized Config"),
            "{error}"
        );
        assert_eq!(cache.fetch_count(), 1);
    }

    #[tokio::test]
    async fn unverified_payload_bytes_never_produce_a_layer_path() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = fixture(b"expected payload", "one");
        let server = Server::run();
        serve(
            &server,
            fixture.manifest.bytes(),
            fixture.manifest.digest(),
            1,
        );
        serve(&server, fixture.config.bytes(), fixture.config.digest(), 1);
        server.expect(
            Expectation::matching(request::method_path(
                "GET",
                format!("{ROUTE_PREFIX}{}", fixture.layer.digest()),
            ))
            .times(1)
            .respond_with(
                httptest::http::Response::builder()
                    .status(200)
                    .body(b"tampered".to_vec())
                    .unwrap(),
            ),
        );
        let cache = cache(dir.path()).await;
        assert!(fetch_manifest_image(
            &cache,
            &grants(&fixture),
            server.url("/").to_string().trim_end_matches('/'),
            TOKEN,
            ROUTE_PREFIX,
        )
        .await
        .is_err());
        assert!(!cache.blob_path(fixture.layer.digest()).unwrap().exists());
    }

    #[tokio::test]
    async fn an_index_or_duplicate_object_is_refused_as_a_grant_set() {
        let dir = tempfile::tempdir().unwrap();
        let cache = cache(dir.path()).await;
        let fixture = fixture(b"payload", "one");
        let mut duplicated = grants(&fixture);
        duplicated.push(duplicated[0].clone());
        let error = fetch_manifest_image(
            &cache,
            &duplicated,
            "http://127.0.0.1:9",
            TOKEN,
            ROUTE_PREFIX,
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(error.contains("more than one Manifest"), "{error}");

        let mut index_grant = grants(&fixture);
        index_grant[0].media_type = crate::oci::MEDIA_TYPE_INDEX.to_string();
        let error = fetch_manifest_image(
            &cache,
            &index_grant,
            "http://127.0.0.1:9",
            TOKEN,
            ROUTE_PREFIX,
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(error.contains("no Manifest"), "{error}");
    }

    #[tokio::test]
    async fn an_agent_restart_adopts_only_reverifiable_metadata_and_payload() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = fixture(b"restart payload", "one");
        let server = Server::run();
        serve(
            &server,
            fixture.manifest.bytes(),
            fixture.manifest.digest(),
            1,
        );
        serve(&server, fixture.config.bytes(), fixture.config.digest(), 1);
        serve(&server, fixture.layer.bytes(), fixture.layer.digest(), 1);
        let origin = server
            .url("/")
            .to_string()
            .trim_end_matches('/')
            .to_string();
        {
            let cache = cache(dir.path()).await;
            fetch_manifest_image(&cache, &grants(&fixture), &origin, TOKEN, ROUTE_PREFIX)
                .await
                .unwrap();
            assert_eq!(cache.fetch_count(), 3);
        }
        let restarted = cache(dir.path()).await;
        let fetched =
            fetch_manifest_image(&restarted, &grants(&fixture), &origin, TOKEN, ROUTE_PREFIX)
                .await
                .unwrap();
        assert_eq!(
            restarted.fetch_count(),
            0,
            "a restart re-verifies, not re-downloads"
        );
        assert_eq!(restarted.bytes_transferred(), 0);
        assert_eq!(fetched.manifest_digest, fixture.manifest.digest());

        // A tampered metadata file is re-fetched rather than adopted.
        std::fs::write(&fetched.layer_path, b"tampered").unwrap();
        let server = Server::run();
        serve(&server, fixture.layer.bytes(), fixture.layer.digest(), 1);
        let origin = server
            .url("/")
            .to_string()
            .trim_end_matches('/')
            .to_string();
        let refetched =
            fetch_manifest_image(&restarted, &grants(&fixture), &origin, TOKEN, ROUTE_PREFIX)
                .await
                .unwrap();
        assert_eq!(restarted.fetch_count(), 1);
        assert_eq!(
            std::fs::read(&refetched.layer_path).unwrap(),
            b"restart payload"
        );
    }

    #[tokio::test]
    async fn a_foreign_route_is_refused_before_any_download() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = fixture(b"payload", "one");
        let mut grant = grants(&fixture);
        grant[2].path = "/images/blobs/sha256:bbbb".to_string();
        let cache = cache(dir.path()).await;
        let error = fetch_manifest_image(&cache, &grant, "http://127.0.0.1:9", TOKEN, ROUTE_PREFIX)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("is not the blob route"), "{error}");
        assert_eq!(cache.fetch_count(), 0);
    }
}
