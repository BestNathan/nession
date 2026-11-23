//! Deterministic SDK acceptance proofs (#4089 SC-01/02/03).
//!
//! These reuse the accepted #3498 [`MockRegistry`] fixture (no Range support,
//! persistent tamper/interrupt/redirect/challenge overrides) and the #4087
//! [`FsBlobStore`] CAS. A source store builds the image fixtures; a separate
//! destination store is the caller-provided CAS the SDK ingests into. No Server
//! SQLite transaction or Catalog publication is involved: the SDK is exercised
//! exactly as an Agent would call it.

#![cfg(feature = "registry")]

use std::sync::{Arc, Mutex};

use tempfile::{tempdir, TempDir};

use super::{ingest_image, ingest_pinned, ImageReference, VerifiedImage};
use crate::blob::store::FsBlobStore;
use crate::digest::digest_of_bytes;
use crate::image::publish::tests::{layer, manifest_and_config};
use crate::oci::{
    to_bytes, Descriptor, Index, Platform, RawDocument, MEDIA_TYPE_INDEX, MEDIA_TYPE_MANIFEST,
};
use crate::registry::auth::{
    AllowAllImports, NoCredentials, RegistryCredential, RegistryCredentialProvider,
};
use crate::registry::client::RegistryClient;
use crate::registry::test_registry::{MockRegistry, PASSWORD, TOKEN, USERNAME};
use crate::registry::{RegistryAuthority, RegistryError, RegistryResult, RemoteReference};

struct Fixture {
    manifest: RawDocument,
    config: RawDocument,
    layer: Descriptor,
}

/// A credential provider that records every scoped lookup and only serves the
/// one allowed repository, so a test can prove the SDK never asks for a second
/// authority's secret and never renders the secret it was given.
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

fn fresh_store() -> (TempDir, FsBlobStore) {
    let directory = tempdir().expect("temp dir");
    let store = FsBlobStore::new(directory.path().join("store")).expect("store");
    (directory, store)
}

fn target(architecture: &str) -> Platform {
    Platform {
        architecture: architecture.to_string(),
        os: "linux".to_string(),
        os_features: Some(vec!["erofs".to_string()]),
        ..Platform::default()
    }
}

fn fixture(store: &FsBlobStore, architecture: &str, payload: &[u8]) -> Fixture {
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

fn build_index(entries: &[(&str, &Fixture)]) -> RawDocument {
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
    RawDocument::from_bytes(to_bytes(&index).expect("index JSON"))
}

fn seed_manifest(
    registry: &MockRegistry,
    store: &FsBlobStore,
    repository: &str,
    tag: &str,
    fixture: &Fixture,
) {
    registry.seed_blob(&store.read(&fixture.layer.digest).expect("layer bytes"));
    registry.seed_blob(fixture.config.bytes());
    registry.seed_manifest(repository, MEDIA_TYPE_MANIFEST, fixture.manifest.bytes());
    registry.set_tag(repository, tag, fixture.manifest.digest());
}

fn seed_index(
    registry: &MockRegistry,
    store: &FsBlobStore,
    repository: &str,
    tag: &str,
    index: &RawDocument,
    fixtures: &[&Fixture],
) {
    for fixture in fixtures {
        registry.seed_blob(&store.read(&fixture.layer.digest).expect("layer bytes"));
        registry.seed_blob(fixture.config.bytes());
        registry.seed_manifest(repository, MEDIA_TYPE_MANIFEST, fixture.manifest.bytes());
    }
    registry.seed_manifest(repository, MEDIA_TYPE_INDEX, index.bytes());
    registry.set_tag(repository, tag, index.digest());
}

/// Ingest into `team/app` -> `tenant/app:v1` with the allow-all source policy.
async fn ingest(
    client: &RegistryClient,
    store: &FsBlobStore,
    reference: RemoteReference,
    architecture: &str,
) -> RegistryResult<VerifiedImage> {
    ingest_image(
        client,
        store,
        "team/app",
        &reference,
        &target(architecture),
        &AllowAllImports,
        "tenant/app",
        "v1",
    )
    .await
}

fn blob_gets(registry: &MockRegistry) -> usize {
    registry
        .requests()
        .iter()
        .filter(|request| request.starts_with("GET ") && request.contains("/blobs/"))
        .count()
}

// --- SC-01: single SDK pull, exact identity/closure, warm-cache no extra copy ---

#[tokio::test]
async fn sc01_single_pull_yields_exact_identity_and_closure() {
    let (_source_dir, source) = fresh_store();
    let payload = b"sc01 exact erofs closure";
    let fixture = fixture(&source, "amd64", payload);
    let registry = MockRegistry::start().await;
    seed_manifest(&registry, &source, "team/app", "v1", &fixture);
    let (_dest_dir, dest) = fresh_store();

    let image = ingest(
        &registry.client(),
        &dest,
        RemoteReference::Tag("v1".to_string()),
        "amd64",
    )
    .await
    .expect("ingest");

    assert_eq!(image.source_digest, fixture.manifest.digest());
    assert_eq!(image.source_media_type, MEDIA_TYPE_MANIFEST);
    assert_eq!(image.manifest_digest(), fixture.manifest.digest());
    assert_eq!(image.config_digest(), fixture.config.digest());
    assert_eq!(image.layer_digest(), fixture.layer.digest);
    // Exact byte equality for the complete verified closure.
    assert_eq!(
        dest.read(fixture.manifest.digest()).expect("manifest"),
        fixture.manifest.bytes()
    );
    assert_eq!(
        dest.read(fixture.config.digest()).expect("config"),
        fixture.config.bytes()
    );
    assert_eq!(dest.read(&fixture.layer.digest).expect("layer"), payload);
    // Exact size equality, verified by the CAS itself.
    dest.verify_named_size(&fixture.layer.digest, fixture.layer.size)
        .expect("layer size");
    assert_eq!(
        dest.read(&fixture.layer.digest).expect("layer").len() as u64,
        fixture.layer.size
    );
    let usage = dest.usage().expect("usage");
    assert_eq!(usage.blobs, 3, "one physical blob per unique object");
    assert_eq!(usage.temp_files, 0);
    assert_eq!(image.platform.architecture, "amd64");
    assert_eq!(image.platform.os, "linux");
}

#[tokio::test]
async fn sc01_warm_cache_retry_copies_nothing() {
    let (_source_dir, source) = fresh_store();
    let fixture = fixture(&source, "amd64", b"sc01 warm cache payload");
    let registry = MockRegistry::start().await;
    seed_manifest(&registry, &source, "team/app", "v1", &fixture);
    let (_dest_dir, dest) = fresh_store();
    let first = ingest(
        &registry.client(),
        &dest,
        RemoteReference::Tag("v1".to_string()),
        "amd64",
    )
    .await
    .expect("first ingest");
    assert_eq!(dest.usage().expect("usage").blobs, 3);

    registry.clear_requests();
    let second = ingest(
        &registry.client(),
        &dest,
        RemoteReference::Tag("v1".to_string()),
        "amd64",
    )
    .await
    .expect("warm retry");
    assert_eq!(second.manifest_digest(), first.manifest_digest());
    assert_eq!(second.config_digest(), first.config_digest());
    assert_eq!(second.layer_digest(), first.layer_digest());
    // A warm cache re-downloads and re-copies no blob bytes.
    assert_eq!(
        blob_gets(&registry),
        0,
        "warm retry must not GET any blob: {:?}",
        registry.requests()
    );
    let usage = dest.usage().expect("usage");
    assert_eq!(usage.blobs, 3, "no extra physical copy");
    assert_eq!(usage.temp_files, 0);
}

#[tokio::test]
async fn sc01_index_selects_exact_platform_child() {
    let (_source_dir, source) = fresh_store();
    let amd64 = fixture(&source, "amd64", b"sc01 amd64 child");
    let arm64 = fixture(&source, "arm64", b"sc01 arm64 child");
    let index = build_index(&[("amd64", &amd64), ("arm64", &arm64)]);
    let registry = MockRegistry::start().await;
    seed_index(
        &registry,
        &source,
        "team/app",
        "v1",
        &index,
        &[&amd64, &arm64],
    );
    let (_dest_dir, dest) = fresh_store();

    let image = ingest(
        &registry.client(),
        &dest,
        RemoteReference::Tag("v1".to_string()),
        "amd64",
    )
    .await
    .expect("index ingest");
    assert_eq!(image.source_digest, index.digest());
    assert_eq!(image.source_media_type, MEDIA_TYPE_INDEX);
    assert_eq!(image.manifest_digest(), amd64.manifest.digest());
    assert_eq!(image.layer_digest(), amd64.layer.digest);
    assert!(dest.contains(&amd64.layer.digest).expect("amd64 layer"));
    // The wrong platform is never fetched or stored as a fallback.
    assert!(!dest.contains(&arm64.layer.digest).expect("arm64 layer"));
    assert!(!dest.contains(arm64.config.digest()).expect("arm64 config"));
    assert!(!dest
        .contains(arm64.manifest.digest())
        .expect("arm64 manifest"));
    assert!(!registry
        .requests()
        .iter()
        .any(|request| request.contains(&arm64.layer.digest)));
}

// --- SC-02: pinned multi-source fetch, single CAS identity, tag-movement proof ---

#[tokio::test]
async fn sc02_pinned_multi_source_single_cas_identity() {
    let (_source_dir, source) = fresh_store();
    let fixture = fixture(&source, "amd64", b"sc02 pinned shared image");
    let pinned = fixture.manifest.digest().to_string();
    let alpha = MockRegistry::start().await;
    let beta = MockRegistry::start().await;
    assert_ne!(
        alpha.authority(),
        beta.authority(),
        "two distinct authorities"
    );
    seed_manifest(&alpha, &source, "team/app", "v1", &fixture);
    seed_manifest(&beta, &source, "team/app", "v1", &fixture);
    let (_dest_dir, dest) = fresh_store();
    let sources = vec![
        ImageReference::new(
            alpha.base_url(),
            "team/app",
            RemoteReference::Digest(pinned.clone()),
        )
        .expect("alpha ref"),
        ImageReference::new(
            beta.base_url(),
            "team/app",
            RemoteReference::Digest(pinned.clone()),
        )
        .expect("beta ref"),
    ];
    let credentials: Arc<dyn RegistryCredentialProvider> = Arc::new(NoCredentials);

    let image = ingest_pinned(
        &sources,
        &pinned,
        &dest,
        &target("amd64"),
        Arc::clone(&credentials),
        &AllowAllImports,
        "tenant/app",
        "v1",
    )
    .await
    .expect("pinned ingest");
    assert_eq!(image.source_digest, pinned);
    assert_eq!(
        dest.usage().expect("usage").blobs,
        3,
        "single content-addressed identity"
    );

    // The same pin from the second authority alone reuses the one shared CAS.
    beta.clear_requests();
    let from_beta = ingest_pinned(
        &sources[1..],
        &pinned,
        &dest,
        &target("amd64"),
        credentials,
        &AllowAllImports,
        "tenant/app",
        "v1",
    )
    .await
    .expect("beta pinned ingest");
    assert_eq!(from_beta.manifest_digest(), pinned);
    assert_eq!(
        dest.usage().expect("usage").blobs,
        3,
        "atomic dedupe across authorities"
    );
    assert_eq!(
        blob_gets(&beta),
        0,
        "the warm shared CAS downloads nothing from the second authority"
    );
}

#[tokio::test]
async fn sc02_tag_movement_cannot_change_pinned_revision() {
    let (_source_dir, source) = fresh_store();
    let original = fixture(&source, "amd64", b"sc02 original revision");
    let moved = fixture(&source, "amd64", b"sc02 moved revision");
    let pinned = original.manifest.digest().to_string();
    assert_ne!(pinned, moved.manifest.digest());
    let registry = MockRegistry::start().await;
    seed_manifest(&registry, &source, "team/app", "v1", &original);
    let (_dest_dir, dest) = fresh_store();
    let source_ref = ImageReference::new(
        registry.base_url(),
        "team/app",
        RemoteReference::Digest(pinned.clone()),
    )
    .expect("ref");
    let credentials: Arc<dyn RegistryCredentialProvider> = Arc::new(NoCredentials);

    // Move the tag to a different revision on the registry.
    seed_manifest(&registry, &source, "team/app", "v1", &moved);
    assert_eq!(
        registry.tag_digest("team/app", "v1"),
        Some(moved.manifest.digest().to_string())
    );

    // The pinned digest still delivers the original revision, not the moved tag.
    let image = ingest_pinned(
        &[source_ref],
        &pinned,
        &dest,
        &target("amd64"),
        credentials,
        &AllowAllImports,
        "tenant/app",
        "v1",
    )
    .await
    .expect("pinned after tag move");
    assert_eq!(image.source_digest, pinned);
    assert_eq!(image.manifest_digest(), original.manifest.digest());
    assert_eq!(
        dest.read(&original.layer.digest).expect("original layer"),
        b"sc02 original revision"
    );
    assert!(!dest.contains(&moved.layer.digest).expect("moved layer"));

    // Contrast: a mutable tag fetch follows the movement, proving the pin held.
    let by_tag = ingest(
        &registry.client(),
        &dest,
        RemoteReference::Tag("v1".to_string()),
        "amd64",
    )
    .await
    .expect("tag fetch");
    assert_eq!(by_tag.source_digest, moved.manifest.digest());
    assert_ne!(by_tag.source_digest, pinned);
}

// --- SC-03: adversarial rejection / safe recovery, no Ready, no credential leak ---

#[tokio::test]
async fn sc03_malformed_manifest_refused_no_ready() {
    let registry = MockRegistry::start().await;
    let bad = b"this is not OCI JSON";
    registry.seed_manifest("team/app", MEDIA_TYPE_MANIFEST, bad);
    let (_dest_dir, dest) = fresh_store();
    let error = ingest(
        &registry.client(),
        &dest,
        RemoteReference::Digest(digest_of_bytes(bad)),
        "amd64",
    )
    .await
    .expect_err("malformed manifest");
    assert!(
        matches!(error, RegistryError::MalformedManifest(_)),
        "{error:?}"
    );
    assert_eq!(dest.usage().expect("usage").blobs, 0);
}

#[tokio::test]
async fn sc03_wrong_platform_refused_no_ready() {
    let (_source_dir, source) = fresh_store();
    let fixture = fixture(&source, "arm64", b"sc03 wrong platform");
    let registry = MockRegistry::start().await;
    seed_manifest(&registry, &source, "team/app", "v1", &fixture);
    let (_dest_dir, dest) = fresh_store();
    let error = ingest(
        &registry.client(),
        &dest,
        RemoteReference::Tag("v1".to_string()),
        "amd64",
    )
    .await
    .expect_err("wrong platform");
    assert!(
        matches!(error, RegistryError::UnsupportedPlatform(_)),
        "{error:?}"
    );
    assert_eq!(dest.usage().expect("usage").blobs, 0);
    assert!(!dest.contains(&fixture.layer.digest).expect("layer"));
}

#[tokio::test]
async fn sc03_wrong_media_type_refused() {
    let (_source_dir, source) = fresh_store();
    let fixture = fixture(&source, "amd64", b"sc03 media type");
    let registry = MockRegistry::start().await;
    seed_manifest(&registry, &source, "team/app", "v1", &fixture);
    registry.blob_media_type("application/vnd.oci.image.layer.v1.tar+gzip");
    let (_dest_dir, dest) = fresh_store();
    let error = ingest(
        &registry.client(),
        &dest,
        RemoteReference::Tag("v1".to_string()),
        "amd64",
    )
    .await
    .expect_err("media type");
    assert!(
        matches!(error, RegistryError::MediaTypeMismatch { .. }),
        "{error:?}"
    );
    assert_eq!(dest.usage().expect("usage").blobs, 0);
}

#[tokio::test]
async fn sc03_foreign_challenge_refused_leak_free() {
    let (_source_dir, source) = fresh_store();
    let fixture = fixture(&source, "amd64", b"sc03 foreign challenge");
    let registry = MockRegistry::start().await;
    let other = MockRegistry::start().await;
    let other_port = other
        .base_url()
        .rsplit_once(':')
        .expect("port")
        .1
        .to_string();
    registry.seed_private_repository("team/private");
    registry.auth_realm_override(&format!("http://localhost:{other_port}/token"));
    seed_manifest(&registry, &source, "team/private", "v1", &fixture);
    let provider = Arc::new(RecordingProvider::new("team/private"));
    let client = registry.client_with(provider.clone());
    let (_dest_dir, dest) = fresh_store();
    let error = ingest_image(
        &client,
        &dest,
        "team/private",
        &RemoteReference::Tag("v1".to_string()),
        &target("amd64"),
        &AllowAllImports,
        "tenant/private",
        "v1",
    )
    .await
    .expect_err("foreign challenge");
    assert!(
        matches!(error, RegistryError::AuthHostRefused(_)),
        "{error:?}"
    );
    // No token request is ever sent to the foreign realm, and nothing is stored.
    assert!(registry.token_requests().is_empty());
    assert_eq!(dest.usage().expect("usage").blobs, 0);
    assert!(!error.to_string().contains(PASSWORD));
}

#[tokio::test]
async fn sc03_foreign_redirect_refused() {
    let (_source_dir, source) = fresh_store();
    let fixture = fixture(&source, "amd64", b"sc03 redirect");
    let registry = MockRegistry::start().await;
    seed_manifest(&registry, &source, "team/app", "v1", &fixture);
    let port = registry
        .base_url()
        .rsplit_once(':')
        .expect("port")
        .1
        .to_string();
    registry.redirect_manifest_to(&format!("http://localhost:{port}/v2/team/app/manifests/v1"));
    let (_dest_dir, dest) = fresh_store();
    let error = ingest(
        &registry.client(),
        &dest,
        RemoteReference::Tag("v1".to_string()),
        "amd64",
    )
    .await
    .expect_err("redirect");
    assert!(
        matches!(error, RegistryError::RedirectRefused { .. }),
        "{error:?}"
    );
    assert_eq!(dest.usage().expect("usage").blobs, 0);
}

#[tokio::test]
async fn sc03_wrong_digest_refused_no_ready() {
    let (_source_dir, source) = fresh_store();
    let fixture = fixture(&source, "amd64", b"sc03 tamper target");
    let registry = MockRegistry::start().await;
    seed_manifest(&registry, &source, "team/app", "v1", &fixture);
    registry.tamper_blob(&fixture.layer.digest);
    let (_dest_dir, dest) = fresh_store();
    let error = ingest(
        &registry.client(),
        &dest,
        RemoteReference::Tag("v1".to_string()),
        "amd64",
    )
    .await
    .expect_err("tampered blob");
    assert!(
        matches!(error, RegistryError::DigestMismatch { .. }),
        "{error:?}"
    );
    let usage = dest.usage().expect("usage");
    assert_eq!(usage.blobs, 0, "no incomplete object is Ready");
    assert_eq!(usage.temp_files, 0);
    assert!(!dest.contains(&fixture.layer.digest).expect("layer"));
}

#[tokio::test]
async fn sc03_aborted_transfer_refused_no_ready() {
    let (_source_dir, source) = fresh_store();
    let fixture = fixture(&source, "amd64", b"sc03 interrupted payload");
    let registry = MockRegistry::start().await;
    seed_manifest(&registry, &source, "team/app", "v1", &fixture);
    registry.interrupt_blob(&fixture.layer.digest);
    let (_dest_dir, dest) = fresh_store();
    let error = ingest(
        &registry.client(),
        &dest,
        RemoteReference::Tag("v1".to_string()),
        "amd64",
    )
    .await
    .expect_err("interrupted transfer");
    assert!(
        matches!(error, RegistryError::TransferInterrupted(_)),
        "{error:?}"
    );
    let usage = dest.usage().expect("usage");
    assert_eq!(usage.blobs, 0);
    assert_eq!(usage.temp_files, 0, "the partial temp file is removed");
    assert!(!dest.contains(&fixture.layer.digest).expect("layer"));
}

#[tokio::test]
async fn sc03_unsupported_resume_is_a_safe_full_read() {
    let (_source_dir, source) = fresh_store();
    let payload = b"sc03 unsupported resume payload";
    let fixture = fixture(&source, "amd64", payload);
    let registry = MockRegistry::start().await;
    seed_manifest(&registry, &source, "team/app", "v1", &fixture);
    // The fixture registry advertises no Range support: a ranged GET is ignored
    // and answered with the full object (200, not 206).
    let http = reqwest::Client::new();
    let url = format!(
        "{}/v2/team/app/blobs/{}",
        registry.base_url(),
        fixture.layer.digest
    );
    let response = http
        .get(&url)
        .header("Range", "bytes=0-1")
        .send()
        .await
        .expect("ranged GET");
    assert_eq!(response.status().as_u16(), 200, "resume is unsupported");
    assert!(response.headers().get("accept-ranges").is_none());
    assert_eq!(response.bytes().await.expect("body").as_ref(), payload);
    // The SDK therefore does a safe full read and verifies the complete object.
    let (_dest_dir, dest) = fresh_store();
    let image = ingest(
        &registry.client(),
        &dest,
        RemoteReference::Tag("v1".to_string()),
        "amd64",
    )
    .await
    .expect("full-read ingest");
    assert_eq!(image.layer_digest(), fixture.layer.digest);
    assert_eq!(dest.read(&fixture.layer.digest).expect("layer"), payload);
}

#[tokio::test]
async fn sc03_oversized_response_is_bounded() {
    let (_source_dir, source) = fresh_store();
    let fixture = fixture(&source, "amd64", b"sc03 oversized");
    let registry = MockRegistry::start().await;
    seed_manifest(&registry, &source, "team/app", "v1", &fixture);
    registry.oversized_manifest(true);
    let (_dest_dir, dest) = fresh_store();
    let error = ingest(
        &registry.client(),
        &dest,
        RemoteReference::Tag("v1".to_string()),
        "amd64",
    )
    .await
    .expect_err("oversized");
    assert!(
        matches!(error, RegistryError::ResponseTooLarge { .. }),
        "{error:?}"
    );
    assert_eq!(dest.usage().expect("usage").blobs, 0);
}

#[tokio::test]
async fn sc03_credentials_never_leak_into_errors_or_objects() {
    let (_source_dir, source) = fresh_store();
    let fixture = fixture(&source, "amd64", b"sc03 credential leak payload");
    let registry = MockRegistry::start().await;
    registry.seed_private_repository("team/private");
    registry.require_basic_for_token(true);
    seed_manifest(&registry, &source, "team/private", "v1", &fixture);
    registry.tamper_blob(&fixture.layer.digest);
    let provider = Arc::new(RecordingProvider::new("team/private"));
    let client = registry.client_with(provider.clone());
    let (_dest_dir, dest) = fresh_store();
    let error = ingest_image(
        &client,
        &dest,
        "team/private",
        &RemoteReference::Tag("v1".to_string()),
        &target("amd64"),
        &AllowAllImports,
        "tenant/private",
        "v1",
    )
    .await
    .expect_err("tampered authenticated blob");
    assert!(
        matches!(error, RegistryError::DigestMismatch { .. }),
        "{error:?}"
    );
    // Neither the error nor the client rendering carries a secret.
    for rendered in [error.to_string(), format!("{client:?}")] {
        assert!(!rendered.contains(PASSWORD), "password leaked: {rendered}");
        assert!(!rendered.contains(USERNAME), "username leaked: {rendered}");
        assert!(!rendered.contains(TOKEN), "token leaked: {rendered}");
    }
    // The provider was scoped to exactly the requested authority/repository.
    let calls = provider.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls.first().expect("call").0, registry.authority());
    assert_eq!(calls.first().expect("call").1, "team/private");
    // No object reached Ready, and no logged authorization header is raw.
    assert_eq!(dest.usage().expect("usage").blobs, 0);
    for header in registry.authorization_headers().into_iter().flatten() {
        assert!(
            !header.contains(PASSWORD),
            "raw credential logged: {header}"
        );
    }
}
