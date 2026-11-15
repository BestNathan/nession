//! Verified push/export of existing local OCI/EROFS objects.
//!
//! Push never rewrites object bytes: every blob is re-verified against its
//! digest and size before upload, child objects are uploaded before their
//! parent, and a remote tag is moved last. A failed upload can leave only
//! unreferenced remote blobs; it cannot publish a partial image.
//!
//! [`export_layout`] writes the same verified objects into a standard OCI Image
//! Layout directory for offline interoperability.

use std::collections::HashSet;
use std::fs;
use std::io::{self, Write};
use std::path::Path;

use anyhow::{Context, Result};
use sea_orm::DatabaseConnection;
use serde_json::Value;

use super::client::RegistryClient;
use super::{validate_remote_repository, RegistryError, RegistryResult, RemoteReference};
use crate::blob::store::BlobStore;
use crate::catalog::tag;
use crate::digest::{digest_of_bytes, is_valid_digest, verify_file};
use crate::oci::layout::{OCI_BLOB_DIR, OCI_INDEX_FILE, OCI_LAYOUT_FILE, OCI_LAYOUT_VERSION};
use crate::oci::{
    parse_index, parse_manifest, to_bytes, validate_index, validate_manifest, Descriptor, Index,
    MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_INDEX, MEDIA_TYPE_MANIFEST,
};

/// The result of one push.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushOutcome {
    /// The immutable digest of the root object that was pushed.
    pub digest: String,
    /// The root object's media type.
    pub media_type: String,
    /// Blobs uploaded by this push.
    pub blobs_uploaded: u64,
    /// Blobs the registry already had.
    pub blobs_reused: u64,
    /// Manifest/Index objects uploaded by this push.
    pub manifests_uploaded: u64,
}

/// The result of one OCI Image Layout export.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutExport {
    pub root_digest: String,
    pub media_type: String,
    /// Number of content blobs written below `blobs/sha256`.
    pub objects: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ObjectForm {
    Manifest,
    Index,
}

impl ObjectForm {
    fn media_type(self) -> &'static str {
        match self {
            Self::Manifest => MEDIA_TYPE_MANIFEST,
            Self::Index => MEDIA_TYPE_INDEX,
        }
    }
}

#[derive(Default)]
struct PushCounts {
    blobs_uploaded: u64,
    blobs_reused: u64,
    manifests_uploaded: u64,
}

/// Push one existing local Manifest or Index graph to a registry.
///
/// `reference` names the remote tag or exact digest. A digest reference must
/// equal `source_digest`. The remote tag, when supplied, is moved only after
/// every Config/layer/child Manifest upload succeeded.
pub async fn push_image(
    client: &RegistryClient,
    store: &BlobStore,
    repository: &str,
    reference: &RemoteReference,
    source_digest: &str,
) -> RegistryResult<PushOutcome> {
    validate_remote_repository(repository)?;
    if !is_valid_digest(source_digest) {
        return Err(RegistryError::InvalidReference(
            "source digest must be sha256:<64 lowercase hex>".to_string(),
        ));
    }
    if let Some(expected) = reference.digest() {
        if expected != source_digest {
            return Err(RegistryError::InvalidReference(
                "remote digest reference does not match the source digest".to_string(),
            ));
        }
    }
    let mut counts = PushCounts::default();
    let form = push_object(
        client,
        store,
        repository,
        source_digest,
        Some(reference),
        &mut counts,
    )
    .await?;
    Ok(PushOutcome {
        digest: source_digest.to_string(),
        media_type: form.media_type().to_string(),
        blobs_uploaded: counts.blobs_uploaded,
        blobs_reused: counts.blobs_reused,
        manifests_uploaded: counts.manifests_uploaded,
    })
}

/// Resolve one local catalog tag and push its Manifest/Index graph.
pub async fn push_tag(
    client: &RegistryClient,
    store: &BlobStore,
    conn: &DatabaseConnection,
    local_repository: &str,
    local_tag: &str,
    remote_repository: &str,
    remote_tag: &str,
) -> RegistryResult<PushOutcome> {
    let Some(digest) = tag::get_tag(conn, local_repository, local_tag)
        .await
        .map_err(RegistryError::from)?
    else {
        return Err(RegistryError::NotFound(format!(
            "local tag {local_repository}:{local_tag}"
        )));
    };
    let reference = RemoteReference::parse(remote_tag)?;
    if !matches!(reference, RemoteReference::Tag(_)) {
        return Err(RegistryError::InvalidReference(
            "push_tag requires a tag reference".to_string(),
        ));
    }
    push_image(client, store, remote_repository, &reference, &digest).await
}

async fn push_object(
    client: &RegistryClient,
    store: &BlobStore,
    repository: &str,
    digest: &str,
    reference: Option<&RemoteReference>,
    counts: &mut PushCounts,
) -> RegistryResult<ObjectForm> {
    let (bytes, form) = read_verified_object(store, digest)?;
    match form {
        ObjectForm::Manifest => {
            push_manifest_object(client, store, repository, digest, bytes, reference, counts)
                .await?;
            Ok(form)
        }
        ObjectForm::Index => {
            let (_, index) = parse_index(&bytes)
                .map_err(|error| RegistryError::MalformedIndex(format!("{digest}: {error:#}")))?;
            validate_index(&index)
                .map_err(|error| RegistryError::MalformedIndex(format!("{digest}: {error:#}")))?;
            for child in &index.manifests {
                if child.media_type != MEDIA_TYPE_MANIFEST {
                    return Err(RegistryError::MalformedIndex(format!(
                        "index child {} is not a manifest",
                        child.digest
                    )));
                }
                let (child_bytes, child_form) = read_verified_object(store, &child.digest)?;
                if child_form != ObjectForm::Manifest {
                    return Err(RegistryError::MalformedIndex(format!(
                        "index child {} is not a manifest",
                        child.digest
                    )));
                }
                let child_size = u64::try_from(child_bytes.len()).unwrap_or(u64::MAX);
                if child_size != child.size {
                    return Err(RegistryError::SizeMismatch {
                        resource: format!("index child {}", child.digest),
                        expected: child.size,
                        actual: child_size,
                    });
                }
                let target = RemoteReference::Digest(child.digest.clone());
                push_manifest_object(
                    client,
                    store,
                    repository,
                    &child.digest,
                    child_bytes,
                    Some(&target),
                    counts,
                )
                .await?;
            }
            let target = match reference {
                Some(reference) => reference.clone(),
                None => RemoteReference::Digest(digest.to_string()),
            };
            client
                .put_manifest(repository, &target, form.media_type(), bytes)
                .await?;
            counts.manifests_uploaded = counts.manifests_uploaded.saturating_add(1);
            Ok(form)
        }
    }
}

async fn push_manifest_object(
    client: &RegistryClient,
    store: &BlobStore,
    repository: &str,
    digest: &str,
    bytes: Vec<u8>,
    reference: Option<&RemoteReference>,
    counts: &mut PushCounts,
) -> RegistryResult<()> {
    let (_, manifest) = parse_manifest(&bytes)
        .map_err(|error| RegistryError::MalformedManifest(format!("{digest}: {error:#}")))?;
    validate_manifest(&manifest)
        .map_err(|error| RegistryError::MalformedManifest(format!("{digest}: {error:#}")))?;
    ensure_blob(client, store, repository, &manifest.config, counts).await?;
    for layer in &manifest.layers {
        ensure_blob(client, store, repository, layer, counts).await?;
    }
    let target = match reference {
        Some(reference) => reference.clone(),
        None => RemoteReference::Digest(digest.to_string()),
    };
    client
        .put_manifest(
            repository,
            &target,
            ObjectForm::Manifest.media_type(),
            bytes,
        )
        .await?;
    counts.manifests_uploaded = counts.manifests_uploaded.saturating_add(1);
    Ok(())
}

async fn ensure_blob(
    client: &RegistryClient,
    store: &BlobStore,
    repository: &str,
    descriptor: &Descriptor,
    counts: &mut PushCounts,
) -> RegistryResult<()> {
    store
        .verify_named_size(&descriptor.digest, descriptor.size)
        .map_err(|error| {
            RegistryError::Local(format!(
                "local blob {} is not a verified CAS object: {error:#}",
                descriptor.digest
            ))
        })?;
    if client.blob_exists(repository, descriptor).await? {
        counts.blobs_reused = counts.blobs_reused.saturating_add(1);
        return Ok(());
    }
    let path = store.path_for(&descriptor.digest).map_err(|error| {
        RegistryError::Local(format!(
            "cannot address local blob {}: {error:#}",
            descriptor.digest
        ))
    })?;
    let location = client.begin_blob_upload(repository).await?;
    let location = client
        .upload_blob_chunk(repository, &location, &path)
        .await?;
    client
        .finish_blob_upload(repository, &location, &descriptor.digest)
        .await?;
    counts.blobs_uploaded = counts.blobs_uploaded.saturating_add(1);
    Ok(())
}

fn read_verified_object(store: &BlobStore, digest: &str) -> RegistryResult<(Vec<u8>, ObjectForm)> {
    let bytes = store.read(digest).map_err(|error| {
        RegistryError::Local(format!("local object {digest} is missing: {error:#}"))
    })?;
    let actual = digest_of_bytes(&bytes);
    if actual != digest {
        return Err(RegistryError::DigestMismatch {
            resource: format!("local object {digest}"),
            expected: digest.to_string(),
            actual,
        });
    }
    let size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    store.verify_named_size(digest, size).map_err(|error| {
        RegistryError::Local(format!(
            "local object {digest} failed verification: {error:#}"
        ))
    })?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
        RegistryError::MalformedManifest(format!("{digest}: not OCI JSON: {error}"))
    })?;
    let form = if value.get("manifests").is_some() {
        ObjectForm::Index
    } else if value.get("layers").is_some() {
        ObjectForm::Manifest
    } else {
        return Err(RegistryError::MalformedManifest(format!(
            "{digest}: not an OCI Manifest or Index"
        )));
    };
    if let Some(declared) = value.get("mediaType").and_then(Value::as_str) {
        if declared != form.media_type() {
            return Err(RegistryError::MediaTypeMismatch {
                resource: format!("local object {digest}"),
                expected: form.media_type().to_string(),
                actual: declared.to_string(),
            });
        }
    }
    Ok((bytes, form))
}

/// Export one local Manifest/Index graph as a standard OCI Image Layout.
///
/// Exact object bytes are copied into `blobs/sha256/<hex>`; only `oci-layout`
/// and `index.json` are newly produced layout metadata. No registry credential
/// is involved.
pub fn export_layout(
    store: &BlobStore,
    source_digest: &str,
    root: &Path,
) -> RegistryResult<LayoutExport> {
    if !is_valid_digest(source_digest) {
        return Err(RegistryError::InvalidReference(
            "layout source digest must be sha256:<64 lowercase hex>".to_string(),
        ));
    }
    if root.starts_with(store.root()) || store.root().starts_with(root) {
        return Err(RegistryError::Local(
            "layout export directory must not overlap the blob store".to_string(),
        ));
    }
    let (root_bytes, form) = read_verified_object(store, source_digest)?;
    let root_size = u64::try_from(root_bytes.len()).unwrap_or(u64::MAX);
    let mut objects: Vec<(String, String, u64)> = Vec::new();
    let mut seen = HashSet::new();
    collect_closure(store, source_digest, &mut objects, &mut seen)?;
    fs::create_dir_all(root.join(OCI_BLOB_DIR)).map_err(|error| {
        RegistryError::Local(format!(
            "cannot create OCI layout {}: {error}",
            root.display()
        ))
    })?;
    let layout_header = format!("{{\"imageLayoutVersion\":\"{OCI_LAYOUT_VERSION}\"}}");
    write_atomic(root, OCI_LAYOUT_FILE, layout_header.as_bytes())?;
    let index = Index {
        schema_version: 2,
        media_type: Some(MEDIA_TYPE_INDEX.to_string()),
        manifests: vec![Descriptor {
            media_type: form.media_type().to_string(),
            digest: source_digest.to_string(),
            size: root_size,
            urls: None,
            annotations: None,
            platform: None,
            artifact_type: None,
            data: None,
            extra: serde_json::Map::new(),
        }],
        annotations: None,
        extra: serde_json::Map::new(),
    };
    let index_bytes = to_bytes(&index).map_err(|error| {
        RegistryError::Local(format!("cannot serialize OCI layout index: {error:#}"))
    })?;
    write_atomic(root, OCI_INDEX_FILE, &index_bytes)?;
    for (digest, _media_type, size) in &objects {
        copy_verified(store, digest, *size, root)?;
    }
    Ok(LayoutExport {
        root_digest: source_digest.to_string(),
        media_type: form.media_type().to_string(),
        objects: u64::try_from(objects.len()).unwrap_or(u64::MAX),
    })
}

fn collect_closure(
    store: &BlobStore,
    digest: &str,
    objects: &mut Vec<(String, String, u64)>,
    seen: &mut HashSet<String>,
) -> RegistryResult<()> {
    if !seen.insert(digest.to_string()) {
        return Ok(());
    }
    let bytes = store.read(digest).map_err(|error| {
        RegistryError::Local(format!("local object {digest} is missing: {error:#}"))
    })?;
    let actual = digest_of_bytes(&bytes);
    if actual != digest {
        return Err(RegistryError::DigestMismatch {
            resource: format!("local object {digest}"),
            expected: digest.to_string(),
            actual,
        });
    }
    let size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
        RegistryError::MalformedManifest(format!("{digest}: not OCI JSON: {error}"))
    })?;
    if value.get("manifests").is_some() {
        let (_, index) = parse_index(&bytes)
            .map_err(|error| RegistryError::MalformedIndex(format!("{digest}: {error:#}")))?;
        validate_index(&index)
            .map_err(|error| RegistryError::MalformedIndex(format!("{digest}: {error:#}")))?;
        objects.push((digest.to_string(), MEDIA_TYPE_INDEX.to_string(), size));
        for child in &index.manifests {
            if child.media_type != MEDIA_TYPE_MANIFEST {
                return Err(RegistryError::MalformedIndex(format!(
                    "index child {} is not a manifest",
                    child.digest
                )));
            }
            collect_closure(store, &child.digest, objects, seen)?;
        }
        return Ok(());
    }
    if value.get("layers").is_some() {
        let (_, manifest) = parse_manifest(&bytes)
            .map_err(|error| RegistryError::MalformedManifest(format!("{digest}: {error:#}")))?;
        validate_manifest(&manifest)
            .map_err(|error| RegistryError::MalformedManifest(format!("{digest}: {error:#}")))?;
        objects.push((digest.to_string(), MEDIA_TYPE_MANIFEST.to_string(), size));
        verify_leaf(store, &manifest.config, MEDIA_TYPE_CONFIG)?;
        if seen.insert(manifest.config.digest.clone()) {
            objects.push((
                manifest.config.digest.clone(),
                manifest.config.media_type.clone(),
                manifest.config.size,
            ));
        }
        for layer in &manifest.layers {
            verify_leaf(store, layer, MEDIA_TYPE_EROFS)?;
            if seen.insert(layer.digest.clone()) {
                objects.push((layer.digest.clone(), layer.media_type.clone(), layer.size));
            }
        }
        return Ok(());
    }
    Err(RegistryError::MalformedManifest(format!(
        "{digest}: not an OCI Manifest or Index"
    )))
}

fn verify_leaf(
    store: &BlobStore,
    descriptor: &Descriptor,
    expected_media_type: &str,
) -> RegistryResult<()> {
    if descriptor.media_type != expected_media_type {
        return Err(RegistryError::MediaTypeMismatch {
            resource: descriptor.digest.clone(),
            expected: expected_media_type.to_string(),
            actual: descriptor.media_type.clone(),
        });
    }
    store
        .verify_named_size(&descriptor.digest, descriptor.size)
        .map_err(|error| {
            RegistryError::Local(format!(
                "local object {} failed verification: {error:#}",
                descriptor.digest
            ))
        })?;
    Ok(())
}

fn copy_verified(
    store: &BlobStore,
    digest: &str,
    expected_size: u64,
    root: &Path,
) -> RegistryResult<()> {
    let Some(hex) = digest.strip_prefix(crate::digest::DIGEST_PREFIX) else {
        return Err(RegistryError::InvalidReference(
            "layout blob digest has no sha256 prefix".to_string(),
        ));
    };
    let directory = root.join(OCI_BLOB_DIR);
    fs::create_dir_all(&directory).map_err(|error| {
        RegistryError::Local(format!("cannot create {}: {error}", directory.display()))
    })?;
    let destination = directory.join(hex);
    if destination.exists() {
        verify_file(&destination, digest).map_err(|error| {
            RegistryError::Local(format!(
                "existing layout object {} failed verification: {error:#}",
                destination.display()
            ))
        })?;
        return Ok(());
    }
    let temp = directory.join(format!(".{hex}.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut source = store.open(digest)?;
        let metadata = source.metadata()?;
        if metadata.len() != expected_size {
            anyhow::bail!(
                "local object {digest} has size {}, expected {expected_size}",
                metadata.len()
            );
        }
        let mut target =
            fs::File::create(&temp).with_context(|| format!("cannot create {}", temp.display()))?;
        io::copy(&mut source, &mut target)
            .with_context(|| format!("cannot copy {digest} into the OCI layout"))?;
        target.sync_all().context("cannot fsync OCI layout blob")?;
        drop(target);
        fs::rename(&temp, &destination).with_context(|| {
            format!(
                "cannot publish OCI layout blob {} as {}",
                temp.display(),
                destination.display()
            )
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(RegistryError::from)?;
    verify_file(&destination, digest).map_err(|error| {
        RegistryError::Local(format!(
            "exported layout object {} failed verification: {error:#}",
            destination.display()
        ))
    })
}

fn write_atomic(root: &Path, name: &str, bytes: &[u8]) -> RegistryResult<()> {
    fs::create_dir_all(root).map_err(|error| {
        RegistryError::Local(format!(
            "cannot create OCI layout {}: {error}",
            root.display()
        ))
    })?;
    let destination = root.join(name);
    let temp = root.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file =
            fs::File::create(&temp).with_context(|| format!("cannot create {}", temp.display()))?;
        file.write_all(bytes)
            .with_context(|| format!("cannot write {}", temp.display()))?;
        file.sync_all()
            .context("cannot fsync OCI layout metadata")?;
        fs::rename(&temp, &destination).with_context(|| {
            format!(
                "cannot publish OCI layout metadata {} as {}",
                temp.display(),
                destination.display()
            )
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(RegistryError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::sqlite::tests::memory_connection;
    use crate::catalog::tag::{self, TagExpectation};
    use crate::image::publish::tests::{layer, manifest_and_config};
    use crate::image::publish::{publish_manifest, ManifestPublication};
    use crate::oci::layout::{parse_layout, validate_layout};
    use crate::oci::{Platform, MEDIA_TYPE_INDEX};
    use crate::registry::test_registry::{MockRegistry, PASSWORD, USERNAME};
    use crate::registry::{RegistryAuthority, RegistryCredential, RegistryCredentialProvider};
    use std::sync::{Arc, Mutex};
    use tempfile::tempdir;

    struct Fixture {
        manifest: crate::oci::RawDocument,
        config: crate::oci::RawDocument,
        layer: Descriptor,
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

    fn target(architecture: &str) -> Platform {
        Platform {
            architecture: architecture.to_string(),
            os: "linux".to_string(),
            os_features: Some(vec!["erofs".to_string()]),
            ..Platform::default()
        }
    }

    fn index_document(store: &BlobStore, fixtures: &[(&str, &Fixture)]) -> crate::oci::RawDocument {
        let index = Index {
            schema_version: 2,
            media_type: Some(MEDIA_TYPE_INDEX.to_string()),
            manifests: fixtures
                .iter()
                .map(|(architecture, fixture)| Descriptor {
                    media_type: MEDIA_TYPE_MANIFEST.to_string(),
                    digest: fixture.manifest.digest().to_string(),
                    size: fixture.manifest.size().expect("manifest size"),
                    urls: None,
                    annotations: None,
                    platform: Some(target(architecture)),
                    artifact_type: None,
                    data: None,
                    extra: serde_json::Map::new(),
                })
                .collect(),
            annotations: None,
            extra: serde_json::Map::new(),
        };
        let document = crate::oci::RawDocument::from_bytes(to_bytes(&index).expect("index JSON"));
        store
            .put_bytes(document.bytes())
            .expect("store index bytes");
        document
    }

    #[tokio::test]
    async fn push_preserves_digest_identities_and_reuses_remote_blobs() {
        let directory = tempdir().expect("temp dir");
        let store = BlobStore::new(directory.path().join("store")).expect("store");
        let fixture = fixture(&store, "amd64", b"push payload");
        let registry = MockRegistry::start().await;
        let client = registry.client();
        let outcome = push_image(
            &client,
            &store,
            "team/app",
            &RemoteReference::Tag("v1".to_string()),
            fixture.manifest.digest(),
        )
        .await
        .expect("push");
        assert_eq!(outcome.digest, fixture.manifest.digest());
        assert_eq!(outcome.media_type, MEDIA_TYPE_MANIFEST);
        assert_eq!(outcome.blobs_uploaded, 2);
        assert_eq!(outcome.blobs_reused, 0);
        assert_eq!(outcome.manifests_uploaded, 1);
        assert_eq!(registry.uploaded_blobs(), 2);
        assert_eq!(
            registry.tag_digest("team/app", "v1"),
            Some(fixture.manifest.digest().to_string())
        );
        assert_eq!(
            registry.blob(&fixture.layer.digest).expect("remote layer"),
            store.read(&fixture.layer.digest).expect("local layer")
        );
        assert_eq!(
            registry
                .blob(fixture.config.digest())
                .expect("remote config"),
            fixture.config.bytes()
        );
        let fetched = client
            .fetch_manifest("team/app", &RemoteReference::Tag("v1".to_string()))
            .await
            .expect("remote manifest");
        assert_eq!(fetched.digest, fixture.manifest.digest());
        assert_eq!(fetched.document.bytes(), fixture.manifest.bytes());

        let again = push_image(
            &client,
            &store,
            "team/app",
            &RemoteReference::Tag("v1".to_string()),
            fixture.manifest.digest(),
        )
        .await
        .expect("replay push");
        assert_eq!(again.blobs_uploaded, 0);
        assert_eq!(again.blobs_reused, 2);
        assert_eq!(again.manifests_uploaded, 1);
    }

    #[tokio::test]
    async fn push_refuses_a_tampered_local_object_before_uploading() {
        let directory = tempdir().expect("temp dir");
        let store = BlobStore::new(directory.path().join("store")).expect("store");
        let fixture = fixture(&store, "amd64", b"tamper target");
        let manifest_path = store
            .path_for(fixture.manifest.digest())
            .expect("manifest path");
        fs::write(&manifest_path, b"tampered local manifest bytes").expect("tamper");
        let registry = MockRegistry::start().await;
        let client = registry.client();
        let error = push_image(
            &client,
            &store,
            "team/app",
            &RemoteReference::Tag("v1".to_string()),
            fixture.manifest.digest(),
        )
        .await
        .expect_err("tampered object");
        assert!(matches!(error, RegistryError::DigestMismatch { .. }));
        assert!(registry.requests().is_empty());
        assert!(registry.tag_digest("team/app", "v1").is_none());
    }

    #[tokio::test]
    async fn interrupted_upload_does_not_publish_a_remote_tag() {
        let directory = tempdir().expect("temp dir");
        let store = BlobStore::new(directory.path().join("store")).expect("store");
        let fixture = fixture(&store, "amd64", b"upload interruption");
        let registry = MockRegistry::start().await;
        registry.fail_finish_upload(true);
        let client = registry.client();
        let error = push_image(
            &client,
            &store,
            "team/app",
            &RemoteReference::Tag("v1".to_string()),
            fixture.manifest.digest(),
        )
        .await
        .expect_err("interrupted upload");
        assert!(matches!(error, RegistryError::UploadFailed { .. }));
        assert!(registry.tag_digest("team/app", "v1").is_none());
        assert!(!registry
            .requests()
            .iter()
            .any(|request| request.starts_with("PUT ") && request.contains("/manifests/")));
    }

    #[tokio::test]
    async fn index_push_uploads_children_before_the_index_tag() {
        let directory = tempdir().expect("temp dir");
        let store = BlobStore::new(directory.path().join("store")).expect("store");
        let amd64 = fixture(&store, "amd64", b"index amd64");
        let arm64 = fixture(&store, "arm64", b"index arm64");
        let index = index_document(&store, &[("amd64", &amd64), ("arm64", &arm64)]);
        let registry = MockRegistry::start().await;
        let client = registry.client();
        let outcome = push_image(
            &client,
            &store,
            "team/multi",
            &RemoteReference::Tag("multi".to_string()),
            index.digest(),
        )
        .await
        .expect("push index");
        assert_eq!(outcome.media_type, MEDIA_TYPE_INDEX);
        assert_eq!(outcome.manifests_uploaded, 3);
        assert_eq!(
            registry.tag_digest("team/multi", "multi"),
            Some(index.digest().to_string())
        );
        assert!(registry.has_manifest("team/multi", amd64.manifest.digest()));
        assert!(registry.has_manifest("team/multi", arm64.manifest.digest()));
        assert!(registry.has_manifest("team/multi", index.digest()));
        let fetched = client
            .fetch_manifest("team/multi", &RemoteReference::Tag("multi".to_string()))
            .await
            .expect("fetch index");
        assert_eq!(fetched.media_type, MEDIA_TYPE_INDEX);
        assert_eq!(fetched.document.bytes(), index.bytes());
    }

    #[derive(Default)]
    struct PushProvider {
        calls: Mutex<usize>,
    }

    impl PushProvider {
        fn calls(&self) -> usize {
            *self.calls.lock().expect("provider calls")
        }
    }

    impl RegistryCredentialProvider for PushProvider {
        fn credential_for(
            &self,
            _authority: &RegistryAuthority,
            _repository: &str,
        ) -> Option<RegistryCredential> {
            *self.calls.lock().expect("provider calls") += 1;
            Some(RegistryCredential::new(USERNAME, PASSWORD).expect("credential"))
        }
    }

    #[tokio::test]
    async fn private_registry_push_requests_a_scoped_push_token() {
        let directory = tempdir().expect("temp dir");
        let store = BlobStore::new(directory.path().join("store")).expect("store");
        let fixture = fixture(&store, "amd64", b"private push payload");
        let registry = MockRegistry::start().await;
        registry.seed_private_repository("team/private");
        registry.require_basic_for_token(true);
        let provider = Arc::new(PushProvider::default());
        let client = registry.client_with(provider.clone());
        let outcome = push_image(
            &client,
            &store,
            "team/private",
            &RemoteReference::Tag("v1".to_string()),
            fixture.manifest.digest(),
        )
        .await
        .expect("private push");
        assert_eq!(outcome.digest, fixture.manifest.digest());
        assert_eq!(
            registry.tag_digest("team/private", "v1"),
            Some(fixture.manifest.digest().to_string())
        );
        let token_requests = registry.token_requests();
        assert_eq!(token_requests.len(), 1);
        let token_request = token_requests.first().expect("token request");
        assert_eq!(
            token_request.scope.as_deref(),
            Some("repository:team/private:pull,push")
        );
        assert!(token_request.has_basic);
        assert!(token_request.basic_valid);
        assert_eq!(provider.calls(), 1);
    }

    #[tokio::test]
    async fn push_tag_resolves_the_local_catalog_tag() {
        let directory = tempdir().expect("temp dir");
        let store = BlobStore::new(directory.path().join("store")).expect("store");
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn)
            .await
            .expect("schema");
        let fixture = fixture(&store, "amd64", b"local catalog payload");
        let published = publish_manifest(
            &conn,
            &store,
            &ManifestPublication {
                repository: "local/app".to_string(),
                tag: "v1".to_string(),
                expectation: TagExpectation::Absent,
                layer: fixture.layer.clone(),
                config: fixture.config.clone(),
                manifest: fixture.manifest.clone(),
            },
            1,
        )
        .await
        .expect("local publication");
        assert_eq!(
            tag::get_tag(&conn, "local/app", "v1").await.expect("tag"),
            Some(published.manifest_digest.clone())
        );
        let registry = MockRegistry::start().await;
        let client = registry.client();
        let outcome = push_tag(
            &client,
            &store,
            &conn,
            "local/app",
            "v1",
            "team/app",
            "remote",
        )
        .await
        .expect("push local tag");
        assert_eq!(outcome.digest, published.manifest_digest);
        assert_eq!(
            registry.tag_digest("team/app", "remote"),
            Some(published.manifest_digest)
        );
    }

    #[tokio::test]
    async fn export_layout_writes_exact_verified_bytes() {
        let directory = tempdir().expect("temp dir");
        let store = BlobStore::new(directory.path().join("store")).expect("store");
        let fixture = fixture(&store, "amd64", b"layout payload");
        let layout_root = directory.path().join("layout");
        let exported =
            export_layout(&store, fixture.manifest.digest(), &layout_root).expect("export layout");
        assert_eq!(exported.root_digest, fixture.manifest.digest());
        assert_eq!(exported.objects, 3);
        let header = fs::read(layout_root.join(OCI_LAYOUT_FILE)).expect("layout header");
        let (_, parsed) = parse_layout(&header).expect("parse layout header");
        validate_layout(&parsed).expect("layout version");
        let index_bytes = fs::read(layout_root.join(OCI_INDEX_FILE)).expect("layout index");
        let (_, index) =
            crate::oci::layout::parse_layout_index(&index_bytes).expect("layout index");
        let root = index.manifests.first().expect("root descriptor");
        assert_eq!(root.digest, fixture.manifest.digest());
        assert_eq!(root.media_type, MEDIA_TYPE_MANIFEST);
        let layer_bytes = store.read(&fixture.layer.digest).expect("layer bytes");
        for (digest, expected) in [
            (fixture.manifest.digest(), fixture.manifest.bytes()),
            (fixture.config.digest(), fixture.config.bytes()),
            (fixture.layer.digest.as_str(), layer_bytes.as_slice()),
        ] {
            let hex = digest
                .strip_prefix(crate::digest::DIGEST_PREFIX)
                .expect("hex");
            let path = layout_root.join(OCI_BLOB_DIR).join(hex);
            assert_eq!(
                fs::read(&path).expect("layout blob"),
                expected,
                "layout blob {digest} must be exact"
            );
        }
        let again = export_layout(&store, fixture.manifest.digest(), &layout_root)
            .expect("idempotent export");
        assert_eq!(again.objects, 3);
    }
}
