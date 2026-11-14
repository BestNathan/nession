//! Platform-aware registry pull and catalog import.
//!
//! A tag is resolved to an immutable digest first. When the resolved object is
//! an Index, exactly one child Manifest is selected with the Phase A selection
//! rule and fetched by its digest; the wrong platform is never used as a
//! fallback. The imported Manifest/Config keep their exact source bytes.

use anyhow::Context;
use sea_orm::DatabaseConnection;

use super::auth::{ImportScope, RegistryImportAuthorizer};
use super::client::RegistryClient;
use super::{RegistryError, RegistryResult, RemoteReference};
use crate::blob::store::BlobStore;
use crate::catalog::tag::TagExpectation;
use crate::image::publish::{publish_manifest, ManifestPublication};
use crate::oci::{
    parse_config, parse_index, parse_manifest, select_platform, validate_manifest,
    validate_manifest_config, Descriptor, ImageConfig, Platform, RawDocument, MEDIA_TYPE_MANIFEST,
};

/// One requested import from an external registry into the local catalog.
#[derive(Debug, Clone)]
pub struct ImportRequest {
    /// The remote repository path (no registry host).
    pub repository: String,
    /// The remote tag or immutable digest.
    pub reference: RemoteReference,
    /// The exact linux platform the caller needs.
    pub platform: Platform,
    /// The local catalog repository the Server has approved.
    pub local_repository: String,
    /// The local mutable tag to move after the import commits.
    pub local_tag: String,
    /// The expected previous local tag digest.
    pub expectation: TagExpectation,
}

/// The digest identities of one successful import.
///
/// This is the only value an Agent-facing adapter needs. It contains no
/// registry credential, token, URL or authorization header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportOutcome {
    /// The digest the remote tag (or digest reference) resolved to.
    pub source_digest: String,
    /// The media type of the resolved remote object.
    pub source_media_type: String,
    /// The imported local Manifest digest.
    pub manifest_digest: String,
    /// The imported local Config digest.
    pub config_digest: String,
    /// The imported local raw EROFS layer digest.
    pub layer_digest: String,
    /// The exact platform the imported Config declares.
    pub platform: Platform,
    /// The previous local Tag digest, if this import moved one.
    pub previous_tag_digest: Option<String>,
}

impl ImportOutcome {
    /// Project the import to the digest-only grant an Agent may receive.
    pub fn agent_grant(&self) -> RegistryDigestGrant {
        RegistryDigestGrant {
            manifest_digest: self.manifest_digest.clone(),
            config_digest: self.config_digest.clone(),
            layer_digest: self.layer_digest.clone(),
        }
    }
}

/// A scoped internal grant. It deliberately has no registry fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryDigestGrant {
    pub manifest_digest: String,
    pub config_digest: String,
    pub layer_digest: String,
}

/// Pull one platform-specific image and publish it through the Phase B
/// Manifest publication path.
///
/// Ordering:
/// 1. validate the local target and the requested linux/erofs platform;
/// 2. ask the Server-owned authorizer (before any network access);
/// 3. resolve the tag/digest and select the exact child Manifest;
/// 4. verify Config against the Manifest and the requested platform;
/// 5. download and verify the raw EROFS layer into the CAS;
/// 6. atomically publish Config/Manifest/edges and move the Tag.
///
/// Any failure before step 6 leaves at most verified unreachable CAS bytes or
/// a private temp file; a Tag is never moved to an incomplete object.
pub async fn pull_image(
    client: &RegistryClient,
    conn: &DatabaseConnection,
    store: &BlobStore,
    request: &ImportRequest,
    authorizer: &dyn RegistryImportAuthorizer,
    now: i64,
) -> RegistryResult<ImportOutcome> {
    crate::catalog::validate_repository_name(&request.local_repository)
        .map_err(|error| RegistryError::InvalidReference(format!("{error:#}")))?;
    crate::catalog::tag::validate_tag(&request.local_tag)
        .map_err(|error| RegistryError::InvalidReference(format!("{error:#}")))?;
    super::validate_remote_repository(&request.repository)?;
    validate_target_platform(&request.platform)?;

    authorizer.authorize_import(&ImportScope {
        authority: client.authority(),
        repository: &request.repository,
        local_repository: &request.local_repository,
        local_tag: &request.local_tag,
        platform: &request.platform,
    })?;

    let resolved = client
        .fetch_manifest(&request.repository, &request.reference)
        .await?;
    let source_digest = resolved.digest.clone();
    let source_media_type = resolved.media_type.clone();

    let (manifest_document, selected_platform) = select_manifest(client, request, resolved).await?;

    let (_, manifest) = parse_manifest(manifest_document.bytes()).map_err(|error| {
        RegistryError::MalformedManifest(format!("{}: {error:#}", manifest_document.digest()))
    })?;
    validate_manifest(&manifest).map_err(|error| {
        RegistryError::MalformedManifest(format!("{}: {error:#}", manifest_document.digest()))
    })?;

    let config_document = client
        .fetch_config(&request.repository, &manifest.config)
        .await?;
    let (_, config) = parse_config(config_document.bytes()).map_err(|error| {
        RegistryError::MalformedConfig(format!("{}: {error:#}", config_document.digest()))
    })?;
    validate_manifest_config(&manifest, &config).map_err(|error| {
        RegistryError::MalformedConfig(format!("{}: {error:#}", config_document.digest()))
    })?;
    let config_platform = platform_of_config(&config);
    if !config_platform.matches(&request.platform) {
        return Err(RegistryError::UnsupportedPlatform(format!(
            "Config targets {}/{} variant {:?}, not the requested {}/{} variant {:?}",
            config_platform.os,
            config_platform.architecture,
            config_platform.variant,
            request.platform.os,
            request.platform.architecture,
            request.platform.variant,
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
    client
        .download_blob(store, &request.repository, &layer)
        .await?;

    let config_digest = config_document.digest().to_string();
    let publication = ManifestPublication {
        repository: request.local_repository.clone(),
        tag: request.local_tag.clone(),
        expectation: request.expectation.clone(),
        layer: layer.clone(),
        config: config_document,
        manifest: manifest_document.clone(),
    };
    let published = publish_manifest(conn, store, &publication, now)
        .await
        .map_err(RegistryError::from)?;
    if published.manifest_digest != manifest_document.digest()
        || published.config_digest != config_digest
        || published.layer_digest != layer.digest
    {
        return Err(RegistryError::Local(format!(
            "published identities do not match the imported bytes ({})",
            manifest_document.digest()
        )));
    }
    Ok(ImportOutcome {
        source_digest,
        source_media_type,
        manifest_digest: published.manifest_digest,
        config_digest: published.config_digest,
        layer_digest: published.layer_digest,
        platform: config_platform,
        previous_tag_digest: published.previous_tag_digest,
    })
}

async fn select_manifest(
    client: &RegistryClient,
    request: &ImportRequest,
    resolved: super::client::FetchedManifest,
) -> RegistryResult<(RawDocument, Option<Platform>)> {
    if resolved.media_type == crate::oci::MEDIA_TYPE_INDEX {
        let (_, index) = parse_index(resolved.document.bytes()).map_err(|error| {
            RegistryError::MalformedIndex(format!("{}: {error:#}", resolved.digest))
        })?;
        let selected = select_platform(&index, &request.platform)
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
                &request.repository,
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

/// Validate the descriptor shape a caller may hand to a manual import.
pub fn validate_import_descriptor(descriptor: &Descriptor) -> RegistryResult<()> {
    crate::oci::validate_descriptor(descriptor)
        .map_err(|error| RegistryError::InvalidReference(format!("{error:#}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::sqlite::tests::memory_connection;
    use crate::catalog::tag;
    use crate::digest::digest_of_bytes;
    use crate::image::publish::tests::{layer, manifest_and_config};
    use crate::oci::{to_bytes, Index, MEDIA_TYPE_INDEX, MEDIA_TYPE_MANIFEST};
    use crate::registry::auth::{AllowAllImports, DenyAllImports, RegistryCredentialProvider};
    use crate::registry::push::push_image;
    use crate::registry::test_registry::{MockRegistry, PASSWORD, TOKEN, USERNAME};
    use crate::registry::{RegistryAuthority, RegistryCredential};
    use sea_orm::DatabaseConnection;
    use std::sync::{Arc, Mutex};
    use tempfile::{tempdir, TempDir};

    struct Fixture {
        manifest: RawDocument,
        config: RawDocument,
        layer: Descriptor,
    }

    struct RecordingProvider {
        allowed: String,
        credential: RegistryCredential,
        calls: Mutex<Vec<(RegistryAuthority, String)>>,
    }

    impl RecordingProvider {
        fn new(allowed: &str) -> Self {
            Self {
                allowed: allowed.to_string(),
                credential: RegistryCredential::new(USERNAME, PASSWORD).expect("credential"),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<(RegistryAuthority, String)> {
            self.calls.lock().expect("provider calls").clone()
        }
    }

    impl RegistryCredentialProvider for RecordingProvider {
        fn credential_for(
            &self,
            authority: &RegistryAuthority,
            repository: &str,
        ) -> Option<RegistryCredential> {
            self.calls
                .lock()
                .expect("provider calls")
                .push((authority.clone(), repository.to_string()));
            (repository == self.allowed).then(|| self.credential.clone())
        }
    }

    struct PrefixAuthorizer {
        prefix: String,
    }

    impl RegistryImportAuthorizer for PrefixAuthorizer {
        fn authorize_import(&self, scope: &ImportScope<'_>) -> RegistryResult<()> {
            if scope.local_repository.starts_with(&self.prefix) {
                Ok(())
            } else {
                Err(RegistryError::ImportDenied(
                    scope.local_repository.to_string(),
                ))
            }
        }
    }

    fn target(architecture: &str) -> Platform {
        Platform {
            architecture: architecture.to_string(),
            os: "linux".to_string(),
            os_features: Some(vec!["erofs".to_string()]),
            ..Platform::default()
        }
    }

    fn fixture(store: &BlobStore, architecture: &str, payload: &[u8]) -> Fixture {
        let layer = layer(store, payload);
        let (manifest, config) = manifest_and_config(store, &layer, architecture, None, None);
        Fixture {
            manifest,
            config,
            layer,
        }
    }

    fn descriptor(fixture: &Fixture, architecture: &str) -> Descriptor {
        Descriptor {
            media_type: MEDIA_TYPE_MANIFEST.to_string(),
            digest: fixture.manifest.digest().to_string(),
            size: fixture.manifest.size().expect("manifest size"),
            urls: None,
            annotations: None,
            platform: Some(target(architecture)),
            artifact_type: None,
            data: None,
            extra: serde_json::Map::new(),
        }
    }

    fn build_index(entries: &[(&str, &Fixture)]) -> (RawDocument, Index) {
        let index = Index {
            schema_version: 2,
            media_type: Some(MEDIA_TYPE_INDEX.to_string()),
            manifests: entries
                .iter()
                .map(|(architecture, fixture)| descriptor(fixture, architecture))
                .collect(),
            annotations: None,
            extra: serde_json::Map::new(),
        };
        let document = RawDocument::from_bytes(to_bytes(&index).expect("index JSON"));
        (document, index)
    }

    fn seed_manifest(
        registry: &MockRegistry,
        store: &BlobStore,
        repository: &str,
        tag_name: &str,
        fixture: &Fixture,
    ) {
        registry.seed_blob(&store.read(&fixture.layer.digest).expect("layer bytes"));
        registry.seed_blob(fixture.config.bytes());
        registry.seed_manifest(repository, MEDIA_TYPE_MANIFEST, fixture.manifest.bytes());
        registry.set_tag(repository, tag_name, fixture.manifest.digest());
    }

    fn seed_index(
        registry: &MockRegistry,
        store: &BlobStore,
        repository: &str,
        tag_name: &str,
        index: &RawDocument,
        fixtures: &[&Fixture],
    ) {
        for fixture in fixtures {
            registry.seed_blob(&store.read(&fixture.layer.digest).expect("layer bytes"));
            registry.seed_blob(fixture.config.bytes());
            registry.seed_manifest(repository, MEDIA_TYPE_MANIFEST, fixture.manifest.bytes());
        }
        registry.seed_manifest(repository, MEDIA_TYPE_INDEX, index.bytes());
        registry.set_tag(repository, tag_name, index.digest());
    }

    fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
        !needle.is_empty()
            && haystack
                .windows(needle.len())
                .any(|window| window == needle)
    }

    async fn fresh() -> (TempDir, BlobStore, DatabaseConnection) {
        let directory = tempdir().expect("temp dir");
        let store = BlobStore::new(directory.path().join("store")).expect("store");
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn)
            .await
            .expect("schema");
        (directory, store, conn)
    }

    fn request(
        repository: &str,
        reference: RemoteReference,
        local_repository: &str,
        architecture: &str,
    ) -> ImportRequest {
        ImportRequest {
            repository: repository.to_string(),
            reference,
            platform: target(architecture),
            local_repository: local_repository.to_string(),
            local_tag: "v1".to_string(),
            expectation: TagExpectation::Absent,
        }
    }

    #[tokio::test]
    async fn round_trip_preserves_manifest_config_layer_digests_and_one_blob() {
        let (_source_dir, source, _source_conn) = fresh().await;
        let fixture = fixture(&source, "amd64", b"one raw erofs layer");
        let registry = MockRegistry::start().await;
        let client = registry.client();
        let push = push_image(
            &client,
            &source,
            "team/app",
            &RemoteReference::Tag("v1".to_string()),
            fixture.manifest.digest(),
        )
        .await
        .expect("push");
        assert_eq!(push.digest, fixture.manifest.digest());
        assert_eq!(
            registry.tag_digest("team/app", "v1"),
            Some(fixture.manifest.digest().to_string())
        );
        assert!(registry.has_manifest("team/app", fixture.manifest.digest()));
        assert_eq!(
            registry.blob(&fixture.layer.digest).expect("remote layer"),
            source.read(&fixture.layer.digest).expect("source layer")
        );
        assert_eq!(
            registry
                .blob(fixture.config.digest())
                .expect("remote config"),
            fixture.config.bytes()
        );

        let (_dest_dir, dest, conn) = fresh().await;
        let outcome = pull_image(
            &client,
            &conn,
            &dest,
            &request(
                "team/app",
                RemoteReference::Tag("v1".to_string()),
                "tenant/app",
                "amd64",
            ),
            &AllowAllImports,
            1,
        )
        .await
        .expect("pull");
        assert_eq!(outcome.source_digest, fixture.manifest.digest());
        assert_eq!(outcome.source_media_type, MEDIA_TYPE_MANIFEST);
        assert_eq!(outcome.manifest_digest, fixture.manifest.digest());
        assert_eq!(outcome.config_digest, fixture.config.digest());
        assert_eq!(outcome.layer_digest, fixture.layer.digest);
        assert_eq!(
            dest.read(fixture.manifest.digest()).expect("manifest"),
            fixture.manifest.bytes()
        );
        assert_eq!(
            dest.read(fixture.config.digest()).expect("config"),
            fixture.config.bytes()
        );
        assert_eq!(
            dest.read(&fixture.layer.digest).expect("layer"),
            b"one raw erofs layer"
        );
        let usage = dest.usage().expect("usage");
        assert_eq!(usage.blobs, 3, "one physical blob per unique object");
        assert_eq!(usage.temp_files, 0);
        assert_eq!(
            tag::get_tag(&conn, "tenant/app", "v1").await.expect("tag"),
            Some(fixture.manifest.digest().to_string())
        );

        let mut repeat = request(
            "team/app",
            RemoteReference::Tag("v1".to_string()),
            "tenant/app",
            "amd64",
        );
        repeat.expectation = TagExpectation::Exact(fixture.manifest.digest().to_string());
        let repeated = pull_image(&client, &conn, &dest, &repeat, &AllowAllImports, 2)
            .await
            .expect("idempotent pull");
        assert_eq!(repeated.manifest_digest, fixture.manifest.digest());
        assert_eq!(dest.usage().expect("usage").blobs, 3);

        let mut by_digest_request = request(
            "team/app",
            RemoteReference::Digest(fixture.manifest.digest().to_string()),
            "tenant/app",
            "amd64",
        );
        by_digest_request.expectation =
            TagExpectation::Exact(fixture.manifest.digest().to_string());
        let by_digest = pull_image(
            &client,
            &conn,
            &dest,
            &by_digest_request,
            &AllowAllImports,
            3,
        )
        .await
        .expect("digest import");
        assert_eq!(by_digest.manifest_digest, fixture.manifest.digest());
        assert_eq!(by_digest.layer_digest, fixture.layer.digest);
        assert_eq!(dest.usage().expect("usage").blobs, 3);
    }

    #[tokio::test]
    async fn imported_json_keeps_unknown_fields_annotations_and_exact_digest() {
        let (_source_dir, source, _source_conn) = fresh().await;
        let fixture = fixture(&source, "amd64", b"unknown field payload");
        let (_, mut manifest) = parse_manifest(fixture.manifest.bytes()).expect("manifest");
        manifest.annotations = Some(
            [("org.example.annotation".to_string(), "kept".to_string())]
                .into_iter()
                .collect(),
        );
        manifest
            .extra
            .insert("x-unknown".to_string(), serde_json::json!({"kept": true}));
        let manifest_document =
            RawDocument::from_bytes(to_bytes(&manifest).expect("manifest JSON"));
        source
            .put_bytes(manifest_document.bytes())
            .expect("store manifest");
        let registry = MockRegistry::start().await;
        let client = registry.client();
        push_image(
            &client,
            &source,
            "team/app",
            &RemoteReference::Tag("v1".to_string()),
            manifest_document.digest(),
        )
        .await
        .expect("push annotated manifest");
        let (_dest_dir, dest, conn) = fresh().await;
        let outcome = pull_image(
            &client,
            &conn,
            &dest,
            &request(
                "team/app",
                RemoteReference::Tag("v1".to_string()),
                "tenant/app",
                "amd64",
            ),
            &AllowAllImports,
            1,
        )
        .await
        .expect("pull annotated manifest");
        assert_eq!(outcome.manifest_digest, manifest_document.digest());
        let bytes = dest
            .read(manifest_document.digest())
            .expect("imported manifest");
        assert_eq!(bytes, manifest_document.bytes());
        let value: serde_json::Value = serde_json::from_slice(&bytes).expect("JSON");
        assert_eq!(value["x-unknown"]["kept"], true);
        assert_eq!(value["annotations"]["org.example.annotation"], "kept");
        assert_eq!(
            dest.read(fixture.config.digest()).expect("config"),
            fixture.config.bytes()
        );
    }

    #[tokio::test]
    async fn index_import_selects_exactly_the_requested_platform() {
        let (_source_dir, source, _source_conn) = fresh().await;
        let amd64 = fixture(&source, "amd64", b"amd64 erofs payload");
        let arm64 = fixture(&source, "arm64", b"arm64 erofs payload");
        let (index_document, _) = build_index(&[("amd64", &amd64), ("arm64", &arm64)]);
        let registry = MockRegistry::start().await;
        let client = registry.client();
        seed_index(
            &registry,
            &source,
            "team/multi",
            "multi",
            &index_document,
            &[&amd64, &arm64],
        );

        let (_dest_dir, dest, conn) = fresh().await;
        registry.clear_requests();
        let outcome = pull_image(
            &client,
            &conn,
            &dest,
            &request(
                "team/multi",
                RemoteReference::Tag("multi".to_string()),
                "tenant/multi",
                "amd64",
            ),
            &AllowAllImports,
            1,
        )
        .await
        .expect("amd64 pull");
        assert_eq!(outcome.source_digest, index_document.digest());
        assert_eq!(outcome.source_media_type, MEDIA_TYPE_INDEX);
        assert_eq!(outcome.manifest_digest, amd64.manifest.digest());
        assert_eq!(outcome.layer_digest, amd64.layer.digest);
        assert_eq!(outcome.platform.architecture, "amd64");
        assert!(!dest
            .contains(arm64.layer.digest.as_str())
            .expect("arm64 layer"));
        assert!(!dest.contains(arm64.config.digest()).expect("arm64 config"));
        assert!(!dest
            .contains(arm64.manifest.digest())
            .expect("arm64 manifest"));
        let requests = registry.requests();
        assert!(requests
            .iter()
            .any(|request| request.contains(&amd64.layer.digest)));
        assert!(!requests
            .iter()
            .any(|request| request.contains(&arm64.layer.digest)));
        assert!(!requests
            .iter()
            .any(|request| request.contains(arm64.config.digest())));

        let (_arm_dir, arm_dest, arm_conn) = fresh().await;
        let arm = pull_image(
            &client,
            &arm_conn,
            &arm_dest,
            &request(
                "team/multi",
                RemoteReference::Tag("multi".to_string()),
                "tenant/multi",
                "arm64",
            ),
            &AllowAllImports,
            2,
        )
        .await
        .expect("arm64 pull");
        assert_eq!(arm.manifest_digest, arm64.manifest.digest());
        assert_eq!(arm.layer_digest, arm64.layer.digest);
        assert_eq!(arm.platform.architecture, "arm64");
        assert!(!arm_dest
            .contains(amd64.layer.digest.as_str())
            .expect("amd64 layer"));
    }

    #[tokio::test]
    async fn unsupported_platform_and_broken_descriptor_are_refused() {
        let (_source_dir, source, _source_conn) = fresh().await;
        let amd64 = fixture(&source, "amd64", b"amd64 payload");
        let arm64 = fixture(&source, "arm64", b"arm64 payload");
        let (index_document, index) = build_index(&[("amd64", &amd64), ("arm64", &arm64)]);
        let registry = MockRegistry::start().await;
        let client = registry.client();
        seed_index(
            &registry,
            &source,
            "team/multi",
            "multi",
            &index_document,
            &[&amd64, &arm64],
        );

        registry.clear_requests();
        let (_dir, dest, conn) = fresh().await;
        let error = pull_image(
            &client,
            &conn,
            &dest,
            &request(
                "team/multi",
                RemoteReference::Tag("multi".to_string()),
                "tenant/multi",
                "riscv64",
            ),
            &AllowAllImports,
            1,
        )
        .await
        .expect_err("unsupported platform");
        assert!(matches!(error, RegistryError::UnsupportedPlatform(_)));
        assert!(dest.usage().expect("usage").blobs == 0);
        assert!(tag::get_tag(&conn, "tenant/multi", "v1")
            .await
            .expect("tag")
            .is_none());
        let requests = registry.requests();
        assert_eq!(requests.len(), 1, "selection fails before any child fetch");
        assert!(!requests
            .iter()
            .any(|request| request.contains(&amd64.layer.digest)));

        let mut broken = index.clone();
        broken.manifests.first_mut().expect("amd64 descriptor").size += 1;
        let broken = RawDocument::from_bytes(to_bytes(&broken).expect("broken index"));
        registry.seed_manifest("team/multi", MEDIA_TYPE_INDEX, broken.bytes());
        registry.set_tag("team/multi", "broken", broken.digest());
        let error = pull_image(
            &client,
            &conn,
            &dest,
            &request(
                "team/multi",
                RemoteReference::Tag("broken".to_string()),
                "tenant/multi",
                "amd64",
            ),
            &AllowAllImports,
            2,
        )
        .await
        .expect_err("broken descriptor");
        assert!(matches!(error, RegistryError::SizeMismatch { .. }));
        assert!(dest.usage().expect("usage").blobs == 0);

        let mut unsupported = index;
        unsupported
            .manifests
            .first_mut()
            .expect("amd64 descriptor")
            .platform
            .as_mut()
            .expect("platform")
            .os_features = Some(vec!["wasm".to_string()]);
        let unsupported = RawDocument::from_bytes(to_bytes(&unsupported).expect("index"));
        registry.seed_manifest("team/multi", MEDIA_TYPE_INDEX, unsupported.bytes());
        registry.set_tag("team/multi", "wasm", unsupported.digest());
        let error = pull_image(
            &client,
            &conn,
            &dest,
            &request(
                "team/multi",
                RemoteReference::Tag("wasm".to_string()),
                "tenant/multi",
                "amd64",
            ),
            &AllowAllImports,
            3,
        )
        .await
        .expect_err("non-erofs child");
        assert!(matches!(error, RegistryError::MalformedIndex(_)));
    }

    #[tokio::test]
    async fn private_registry_bearer_challenge_succeeds_without_leaking_credentials() {
        let (_source_dir, source, _source_conn) = fresh().await;
        let fixture = fixture(&source, "amd64", b"private erofs payload");
        let registry = MockRegistry::start().await;
        registry.seed_private_repository("team/private");
        registry.require_basic_for_token(true);
        seed_manifest(&registry, &source, "team/private", "v1", &fixture);
        let provider = Arc::new(RecordingProvider::new("team/private"));
        let client = registry.client_with(provider.clone());
        let (_dest_dir, dest, conn) = fresh().await;
        let outcome = pull_image(
            &client,
            &conn,
            &dest,
            &request(
                "team/private",
                RemoteReference::Tag("v1".to_string()),
                "tenant/private",
                "amd64",
            ),
            &AllowAllImports,
            1,
        )
        .await
        .expect("authenticated pull");
        assert_eq!(outcome.manifest_digest, fixture.manifest.digest());

        let token_requests = registry.token_requests();
        assert_eq!(token_requests.len(), 1);
        let token_request = token_requests.first().expect("token request");
        assert_eq!(
            token_request.scope.as_deref(),
            Some("repository:team/private:pull")
        );
        assert_eq!(token_request.service.as_deref(), Some("mock-registry"));
        assert!(token_request.has_basic);
        assert!(token_request.basic_valid);

        let calls = provider.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls.first().expect("call").1, "team/private");
        assert_eq!(calls.first().expect("call").0, registry.authority());

        let config_bytes = dest.read(fixture.config.digest()).expect("config");
        let layer_bytes = dest.read(&fixture.layer.digest).expect("layer");
        assert!(!contains_bytes(&config_bytes, PASSWORD.as_bytes()));
        assert!(!contains_bytes(&layer_bytes, PASSWORD.as_bytes()));
        assert!(!contains_bytes(&config_bytes, TOKEN.as_bytes()));
        assert!(!contains_bytes(&layer_bytes, TOKEN.as_bytes()));

        for rendered in [
            format!("{client:?}"),
            format!("{outcome:?}"),
            format!("{:?}", outcome.agent_grant()),
            format!(
                "{:?}",
                RegistryCredential::new(USERNAME, PASSWORD).expect("credential")
            ),
        ] {
            assert!(
                !rendered.contains(PASSWORD),
                "credential leaked: {rendered}"
            );
            assert!(!rendered.contains(USERNAME), "username leaked: {rendered}");
            assert!(!rendered.contains(TOKEN), "token leaked: {rendered}");
        }
    }

    #[tokio::test]
    async fn a_missing_credential_is_unauthorized_and_leak_free() {
        let (_source_dir, source, _source_conn) = fresh().await;
        let fixture = fixture(&source, "amd64", b"private erofs payload");
        let registry = MockRegistry::start().await;
        registry.seed_private_repository("team/private");
        registry.use_basic_challenge(true);
        seed_manifest(&registry, &source, "team/private", "v1", &fixture);
        let client = registry.client();
        let (_dest_dir, dest, conn) = fresh().await;
        let error = pull_image(
            &client,
            &conn,
            &dest,
            &request(
                "team/private",
                RemoteReference::Tag("v1".to_string()),
                "tenant/private",
                "amd64",
            ),
            &AllowAllImports,
            1,
        )
        .await
        .expect_err("missing credential");
        assert!(matches!(error, RegistryError::Unauthorized(_)));
        assert!(!error.to_string().contains(PASSWORD));
        assert!(!error.to_string().contains(USERNAME));
        assert!(dest.usage().expect("usage").blobs == 0);
        assert!(tag::get_tag(&conn, "tenant/private", "v1")
            .await
            .expect("tag")
            .is_none());
    }

    #[tokio::test]
    async fn basic_challenge_uses_a_scoped_server_credential() {
        let (_source_dir, source, _source_conn) = fresh().await;
        let fixture = fixture(&source, "amd64", b"basic auth payload");
        let registry = MockRegistry::start().await;
        registry.seed_private_repository("team/private");
        registry.use_basic_challenge(true);
        seed_manifest(&registry, &source, "team/private", "v1", &fixture);
        let provider = Arc::new(RecordingProvider::new("team/private"));
        let client = registry.client_with(provider.clone());
        let (_dest_dir, dest, conn) = fresh().await;
        let outcome = pull_image(
            &client,
            &conn,
            &dest,
            &request(
                "team/private",
                RemoteReference::Tag("v1".to_string()),
                "tenant/private",
                "amd64",
            ),
            &AllowAllImports,
            1,
        )
        .await
        .expect("Basic challenge pull");
        assert_eq!(outcome.manifest_digest, fixture.manifest.digest());
        assert!(
            registry.token_requests().is_empty(),
            "Basic does not use the token service"
        );
        assert_eq!(provider.calls().len(), 1);
    }

    #[tokio::test]
    async fn forbidden_repository_and_forbidden_token_are_distinguished() {
        let (_source_dir, source, _source_conn) = fresh().await;
        let fixture = fixture(&source, "amd64", b"private erofs payload");
        let registry = MockRegistry::start().await;
        registry.seed_private_repository("team/private");
        registry.require_basic_for_token(true);
        registry.forbid_repository("team/private");
        seed_manifest(&registry, &source, "team/private", "v1", &fixture);
        let provider = Arc::new(RecordingProvider::new("team/private"));
        let client = registry.client_with(provider);
        let (_dest_dir, dest, conn) = fresh().await;
        let error = pull_image(
            &client,
            &conn,
            &dest,
            &request(
                "team/private",
                RemoteReference::Tag("v1".to_string()),
                "tenant/private",
                "amd64",
            ),
            &AllowAllImports,
            1,
        )
        .await
        .expect_err("forbidden repository");
        assert!(matches!(error, RegistryError::Forbidden(_)));
        assert!(dest.usage().expect("usage").blobs == 0);
        assert!(tag::get_tag(&conn, "tenant/private", "v1")
            .await
            .expect("tag")
            .is_none());

        let registry2 = MockRegistry::start().await;
        registry2.seed_private_repository("team/private");
        registry2.require_basic_for_token(true);
        registry2.forbid_tokens(true);
        seed_manifest(&registry2, &source, "team/private", "v1", &fixture);
        let provider = Arc::new(RecordingProvider::new("team/private"));
        let client = registry2.client_with(provider);
        let (_dest2, dest2, conn2) = fresh().await;
        let error = pull_image(
            &client,
            &conn2,
            &dest2,
            &request(
                "team/private",
                RemoteReference::Tag("v1".to_string()),
                "tenant/private",
                "amd64",
            ),
            &AllowAllImports,
            2,
        )
        .await
        .expect_err("forbidden token");
        assert!(matches!(error, RegistryError::AuthDenied(_)));
        assert!(dest2.usage().expect("usage").blobs == 0);
    }

    #[tokio::test]
    async fn a_challenge_scope_cannot_name_another_repository() {
        let (_source_dir, source, _source_conn) = fresh().await;
        let fixture = fixture(&source, "amd64", b"private erofs payload");
        let registry = MockRegistry::start().await;
        registry.seed_private_repository("team/private");
        registry.challenge_scope_repository("other/repository");
        seed_manifest(&registry, &source, "team/private", "v1", &fixture);
        let provider = Arc::new(RecordingProvider::new("team/private"));
        let client = registry.client_with(provider.clone());
        let (_dest_dir, dest, conn) = fresh().await;
        let error = pull_image(
            &client,
            &conn,
            &dest,
            &request(
                "team/private",
                RemoteReference::Tag("v1".to_string()),
                "tenant/private",
                "amd64",
            ),
            &AllowAllImports,
            1,
        )
        .await
        .expect_err("foreign challenge scope");
        assert!(matches!(error, RegistryError::AuthChallenge(_)));
        assert!(registry.token_requests().is_empty());
        assert!(provider.calls().is_empty());
        assert!(dest.usage().expect("usage").blobs == 0);
    }

    #[tokio::test]
    async fn tampered_blob_is_refused_without_a_ready_object() {
        let (_source_dir, source, _source_conn) = fresh().await;
        let fixture = fixture(&source, "amd64", b"tamper target payload");
        let registry = MockRegistry::start().await;
        seed_manifest(&registry, &source, "team/app", "v1", &fixture);
        registry.tamper_blob(&fixture.layer.digest);
        let client = registry.client();
        let (_dest_dir, dest, conn) = fresh().await;
        let error = pull_image(
            &client,
            &conn,
            &dest,
            &request(
                "team/app",
                RemoteReference::Tag("v1".to_string()),
                "tenant/app",
                "amd64",
            ),
            &AllowAllImports,
            1,
        )
        .await
        .expect_err("tampered blob");
        assert!(matches!(error, RegistryError::DigestMismatch { .. }));
        let usage = dest.usage().expect("usage");
        assert_eq!(usage.blobs, 0);
        assert_eq!(usage.temp_files, 0);
        assert!(tag::get_tag(&conn, "tenant/app", "v1")
            .await
            .expect("tag")
            .is_none());
    }

    #[tokio::test]
    async fn interrupted_download_is_refused_without_a_ready_object() {
        let (_source_dir, source, _source_conn) = fresh().await;
        let fixture = fixture(&source, "amd64", b"interrupted payload");
        let registry = MockRegistry::start().await;
        seed_manifest(&registry, &source, "team/app", "v1", &fixture);
        registry.interrupt_blob(&fixture.layer.digest);
        let client = registry.client();
        let (_dest_dir, dest, conn) = fresh().await;
        let error = pull_image(
            &client,
            &conn,
            &dest,
            &request(
                "team/app",
                RemoteReference::Tag("v1".to_string()),
                "tenant/app",
                "amd64",
            ),
            &AllowAllImports,
            1,
        )
        .await
        .expect_err("interrupted transfer");
        assert!(
            matches!(error, RegistryError::TransferInterrupted(_)),
            "unexpected error: {error:?}"
        );
        let usage = dest.usage().expect("usage");
        assert_eq!(usage.blobs, 0);
        assert_eq!(usage.temp_files, 0, "the partial temp file is removed");
        assert!(tag::get_tag(&conn, "tenant/app", "v1")
            .await
            .expect("tag")
            .is_none());
    }

    #[tokio::test]
    async fn malformed_manifest_and_wrong_media_type_are_refused() {
        let registry = MockRegistry::start().await;
        let bad = b"this is not OCI JSON";
        registry.seed_manifest("team/app", MEDIA_TYPE_MANIFEST, bad);
        let client = registry.client();
        let (_dest_dir, dest, conn) = fresh().await;
        let error = pull_image(
            &client,
            &conn,
            &dest,
            &request(
                "team/app",
                RemoteReference::Digest(digest_of_bytes(bad)),
                "tenant/app",
                "amd64",
            ),
            &AllowAllImports,
            1,
        )
        .await
        .expect_err("malformed manifest");
        assert!(matches!(error, RegistryError::MalformedManifest(_)));
        assert_eq!(dest.usage().expect("usage").blobs, 0);
        assert!(tag::get_tag(&conn, "tenant/app", "v1")
            .await
            .expect("tag")
            .is_none());

        let (_source_dir, source, _source_conn) = fresh().await;
        let fixture = fixture(&source, "amd64", b"media type payload");
        let registry2 = MockRegistry::start().await;
        seed_manifest(&registry2, &source, "team/app", "v1", &fixture);
        registry2.blob_media_type("application/vnd.oci.image.layer.v1.tar+gzip");
        let client2 = registry2.client();
        let (_dest2, dest2, conn2) = fresh().await;
        let error = pull_image(
            &client2,
            &conn2,
            &dest2,
            &request(
                "team/app",
                RemoteReference::Tag("v1".to_string()),
                "tenant/app",
                "amd64",
            ),
            &AllowAllImports,
            2,
        )
        .await
        .expect_err("media type");
        assert!(matches!(error, RegistryError::MediaTypeMismatch { .. }));
        assert_eq!(dest2.usage().expect("usage").blobs, 0);
    }

    #[tokio::test]
    async fn redirected_hosts_are_refused_for_pull_auth_and_upload() {
        let (_source_dir, source, _source_conn) = fresh().await;
        let fixture = fixture(&source, "amd64", b"redirect payload");
        let registry = MockRegistry::start().await;
        seed_manifest(&registry, &source, "team/app", "v1", &fixture);
        let base = registry.base_url();
        let port = base.rsplit_once(':').expect("port").1;
        registry.redirect_manifest_to(&format!("http://localhost:{port}/v2/team/app/manifests/v1"));
        let client = registry.client();
        let (_dest_dir, dest, conn) = fresh().await;
        let error = pull_image(
            &client,
            &conn,
            &dest,
            &request(
                "team/app",
                RemoteReference::Tag("v1".to_string()),
                "tenant/app",
                "amd64",
            ),
            &AllowAllImports,
            1,
        )
        .await
        .expect_err("manifest redirect");
        assert!(matches!(error, RegistryError::RedirectRefused { .. }));
        assert_eq!(dest.usage().expect("usage").blobs, 0);

        let registry2 = MockRegistry::start().await;
        registry2.seed_private_repository("team/private");
        registry2.auth_realm_override(&format!("http://localhost:{port}/token"));
        seed_manifest(&registry2, &source, "team/private", "v1", &fixture);
        let provider = Arc::new(RecordingProvider::new("team/private"));
        let client2 = registry2.client_with(provider);
        let (_dest2, dest2, conn2) = fresh().await;
        let error = pull_image(
            &client2,
            &conn2,
            &dest2,
            &request(
                "team/private",
                RemoteReference::Tag("v1".to_string()),
                "tenant/private",
                "amd64",
            ),
            &AllowAllImports,
            2,
        )
        .await
        .expect_err("auth realm host");
        assert!(matches!(error, RegistryError::AuthHostRefused(_)));
        assert!(registry2.token_requests().is_empty());
        assert_eq!(dest2.usage().expect("usage").blobs, 0);

        let registry3 = MockRegistry::start().await;
        registry3.cross_host_upload_location(true);
        let client3 = registry3.client();
        let error = push_image(
            &client3,
            &source,
            "team/app",
            &RemoteReference::Tag("v1".to_string()),
            fixture.manifest.digest(),
        )
        .await
        .expect_err("upload location host");
        assert!(matches!(error, RegistryError::RedirectRefused { .. }));
        assert!(registry3.tag_digest("team/app", "v1").is_none());
        assert!(!registry3
            .requests()
            .iter()
            .any(|request| request.starts_with("PUT ") && request.contains("/manifests/")));
    }

    #[tokio::test]
    async fn allowed_cross_host_redirect_does_not_forward_registry_credentials() {
        let (_source_dir, source, _source_conn) = fresh().await;
        let fixture = fixture(&source, "amd64", b"cross-host redirect payload");
        let registry = MockRegistry::start().await;
        let other = MockRegistry::start().await;
        registry.seed_private_repository("team/private");
        registry.require_basic_for_token(true);
        other.seed_private_repository("team/private");
        seed_manifest(&registry, &source, "team/private", "v1", &fixture);
        seed_manifest(&other, &source, "team/private", "v1", &fixture);
        let other_base = other.base_url();
        let other_port = other_base.rsplit_once(':').expect("other port").1;
        registry.redirect_manifest_to(&format!("{other_base}/v2/team/private/manifests/v1"));
        let mut config = registry.config();
        config
            .allowed_redirect_hosts
            .push(format!("127.0.0.1:{other_port}"));
        let provider = Arc::new(RecordingProvider::new("team/private"));
        let client = registry.client_with_config(config, provider);
        let (_dest_dir, dest, conn) = fresh().await;
        let error = pull_image(
            &client,
            &conn,
            &dest,
            &request(
                "team/private",
                RemoteReference::Tag("v1".to_string()),
                "tenant/private",
                "amd64",
            ),
            &AllowAllImports,
            1,
        )
        .await
        .expect_err("cross-host redirect without credentials");
        assert!(matches!(error, RegistryError::Unauthorized(_)));
        assert_eq!(
            registry.authorization_headers(),
            vec![None, Some("<authorization>".to_string())],
            "only the registry-authority retry carries credentials"
        );
        assert_eq!(
            other.authorization_headers(),
            vec![None],
            "an allowed redirect host never receives the registry credential"
        );
        assert!(other.token_requests().is_empty());
        assert_eq!(dest.usage().expect("usage").blobs, 0);
    }

    #[tokio::test]
    async fn oversized_manifest_response_is_bounded() {
        let (_source_dir, source, _source_conn) = fresh().await;
        let fixture = fixture(&source, "amd64", b"oversized payload");
        let registry = MockRegistry::start().await;
        seed_manifest(&registry, &source, "team/app", "v1", &fixture);
        registry.oversized_manifest(true);
        let client = registry.client();
        let (_dest_dir, dest, conn) = fresh().await;
        let error = pull_image(
            &client,
            &conn,
            &dest,
            &request(
                "team/app",
                RemoteReference::Tag("v1".to_string()),
                "tenant/app",
                "amd64",
            ),
            &AllowAllImports,
            1,
        )
        .await
        .expect_err("oversized response");
        assert!(matches!(error, RegistryError::ResponseTooLarge { .. }));
        assert_eq!(dest.usage().expect("usage").blobs, 0);
    }

    #[tokio::test]
    async fn denied_import_never_reaches_the_registry_or_credentials() {
        let (_source_dir, source, _source_conn) = fresh().await;
        let fixture = fixture(&source, "amd64", b"denied payload");
        let registry = MockRegistry::start().await;
        registry.seed_private_repository("team/private");
        seed_manifest(&registry, &source, "team/private", "v1", &fixture);
        let provider = Arc::new(RecordingProvider::new("team/private"));
        let client = registry.client_with(provider.clone());
        registry.clear_requests();

        let (_dest_dir, dest, conn) = fresh().await;
        let error = pull_image(
            &client,
            &conn,
            &dest,
            &request(
                "team/private",
                RemoteReference::Tag("v1".to_string()),
                "tenant/app",
                "amd64",
            ),
            &DenyAllImports,
            1,
        )
        .await
        .expect_err("denied import");
        assert!(matches!(error, RegistryError::ImportDenied(_)));
        assert!(
            registry.requests().is_empty(),
            "denial precedes the network"
        );
        assert!(
            provider.calls().is_empty(),
            "denial precedes credential access"
        );
        assert!(dest.usage().expect("usage").blobs == 0);
        assert!(tag::get_tag(&conn, "tenant/app", "v1")
            .await
            .expect("tag")
            .is_none());

        let tenant = PrefixAuthorizer {
            prefix: "tenant-a/".to_string(),
        };
        let error = pull_image(
            &client,
            &conn,
            &dest,
            &request(
                "team/private",
                RemoteReference::Tag("v1".to_string()),
                "tenant-b/app",
                "amd64",
            ),
            &tenant,
            2,
        )
        .await
        .expect_err("cross-tenant import");
        assert!(matches!(error, RegistryError::ImportDenied(_)));
        assert!(registry.requests().is_empty());
        assert!(provider.calls().is_empty());
    }

    #[tokio::test]
    async fn agent_grant_projects_only_local_digests_and_no_credentials() {
        let (_source_dir, source, _source_conn) = fresh().await;
        let fixture = fixture(&source, "amd64", b"agent grant payload");
        let registry = MockRegistry::start().await;
        registry.seed_private_repository("team/private");
        registry.require_basic_for_token(true);
        seed_manifest(&registry, &source, "team/private", "v1", &fixture);
        let provider = Arc::new(RecordingProvider::new("team/private"));
        let client = registry.client_with(provider);
        let (_dest_dir, dest, conn) = fresh().await;
        let tenant = PrefixAuthorizer {
            prefix: "tenant-a/".to_string(),
        };
        let outcome = pull_image(
            &client,
            &conn,
            &dest,
            &request(
                "team/private",
                RemoteReference::Tag("v1".to_string()),
                "tenant-a/app",
                "amd64",
            ),
            &tenant,
            1,
        )
        .await
        .expect("tenant-scoped pull");
        let grant = outcome.agent_grant();
        assert_eq!(grant.manifest_digest, outcome.manifest_digest);
        assert_eq!(grant.config_digest, outcome.config_digest);
        assert_eq!(grant.layer_digest, outcome.layer_digest);
        assert_eq!(grant.manifest_digest, fixture.manifest.digest());
        let rendered = format!("{grant:?}");
        for secret in [PASSWORD, USERNAME, TOKEN] {
            assert!(!rendered.contains(secret));
        }
    }
}
