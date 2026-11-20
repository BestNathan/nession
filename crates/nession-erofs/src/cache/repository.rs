//! The Agent-owned adapter of the reusable #4087 `RepositoryStore` contract.
//!
//! An Agent has no SQLite catalog: its repository reachability is a projection
//! of the verified local references granted to it. [`CacheRepositoryStore`]
//! records repository Tag → pinned Manifest aliases (registered by the runtime
//! adapter when a Session grant is consumed) and derives each Manifest's
//! complete closure from the verified cached OCI bytes themselves.
//!
//! The projection is in-memory by design: durable identity lives in the CAS
//! and in the Server's grants. A restarted Agent re-registers references from
//! its Session preparation; it never exposes a stale or partial closure. A
//! digest physically present in the cache but outside every registered
//! closure is not readable through this contract — possession is not
//! authorization.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};

use super::store::CacheBlobStore;
use super::ErofsCache;
use crate::contracts::BlobStore;
use crate::contracts::{
    validate_repository_name, validate_tag, RepositoryManifest, RepositoryStore,
};
use crate::digest::is_valid_digest;
use crate::oci::annotation::{MEDIA_TYPE_COMPOSITE, MEDIA_TYPE_EROFS, MEDIA_TYPE_MANIFEST};
use crate::oci::composite::{parse_composite, validate_composite_manifest_config};
use crate::oci::descriptor::Descriptor;
use crate::oci::validation::validate_manifest_config;
use crate::oci::{parse_config, parse_manifest};

/// One Agent identity's verified repository reachability projection.
pub struct CacheRepositoryStore {
    blobs: CacheBlobStore,
    /// repository → (tag → pinned Manifest digest).
    references: Mutex<HashMap<String, BTreeMap<String, String>>>,
}

impl CacheRepositoryStore {
    /// Project over an opened cache. No reference is exposed until registered.
    pub fn new(cache: Arc<ErofsCache>) -> Self {
        Self {
            blobs: CacheBlobStore::new(cache),
            references: Mutex::new(HashMap::new()),
        }
    }

    /// Register one repository Tag alias to a pinned Manifest digest.
    ///
    /// The Manifest bytes must already be verified in the cache; registration
    /// never invents reachability for absent or corrupt objects.
    pub fn register_tag(&self, repository: &str, tag: &str, manifest_digest: &str) -> Result<()> {
        validate_repository_name(repository)?;
        validate_tag(tag)?;
        if !is_valid_digest(manifest_digest) {
            anyhow::bail!("invalid manifest digest {manifest_digest:?}");
        }
        self.blobs
            .verify(manifest_digest)
            .with_context(|| format!("cannot register unverified Manifest {manifest_digest}"))?;
        self.references
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(repository.to_string())
            .or_default()
            .insert(tag.to_string(), manifest_digest.to_string());
        Ok(())
    }

    /// Drop one repository's projection (for example when its grant revokes).
    pub fn unregister_repository(&self, repository: &str) -> Result<bool> {
        validate_repository_name(repository)?;
        Ok(self
            .references
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(repository)
            .is_some())
    }

    fn manifest_for(&self, repository: &str, reference: &str) -> Option<String> {
        let references = self
            .references
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let tags = references.get(repository)?;
        if is_valid_digest(reference) {
            // An immutable reference resolves only to a Manifest this
            // repository actually exposes; a foreign digest stays invisible.
            return tags
                .values()
                .find(|digest| digest.as_str() == reference)
                .cloned();
        }
        tags.get(reference).cloned()
    }

    fn manifest_descriptor(&self, manifest_digest: &str) -> Result<Descriptor> {
        let bytes = self.blobs.read(manifest_digest)?;
        let (document, _manifest) = parse_manifest(&bytes)?;
        if document.digest() != manifest_digest {
            anyhow::bail!("cached Manifest {manifest_digest} identity changed");
        }
        Ok(Descriptor {
            media_type: MEDIA_TYPE_MANIFEST.to_string(),
            digest: manifest_digest.to_string(),
            size: document.size()?,
            urls: None,
            annotations: None,
            platform: None,
            artifact_type: None,
            data: None,
            extra: Default::default(),
        })
    }

    /// Whether one descriptor's bytes are verified in the cache with the
    /// claimed size. `Ok(false)` is a missing object (incomplete closure);
    /// `Err` is corrupt/unreadable bytes — both fail closed for consumption.
    fn object_verified(&self, descriptor: &Descriptor) -> Result<bool> {
        if !self.blobs.contains(&descriptor.digest)? {
            return Ok(false);
        }
        self.blobs
            .verify_named_size(&descriptor.digest, descriptor.size)?;
        Ok(true)
    }

    fn closure_inner(&self, manifest_digest: &str) -> Result<Option<Vec<Descriptor>>> {
        let root = self.manifest_descriptor(manifest_digest)?;
        let manifest_bytes = self.blobs.read(manifest_digest)?;
        let (_document, manifest) = parse_manifest(&manifest_bytes)?;
        if !self.object_verified(&manifest.config)? {
            return Ok(None);
        }
        let config_bytes = self.blobs.read(&manifest.config.digest)?;
        let (_config_document, config) = parse_config(&config_bytes)?;
        let mut closure = vec![root, manifest.config.clone()];
        if manifest.layers.len() == 1
            && manifest
                .layers
                .first()
                .is_some_and(|layer| layer.media_type == MEDIA_TYPE_COMPOSITE)
        {
            let layer = manifest.layers.first().context("Composite layer")?;
            if !self.object_verified(layer)? {
                return Ok(None);
            }
            let composite_bytes = self.blobs.read(&layer.digest)?;
            let composite = parse_composite(&composite_bytes)?;
            validate_composite_manifest_config(&manifest, &config, &composite, layer)?;
            closure.push(layer.clone());
            for device in composite.closure()? {
                if !self.object_verified(&device)? {
                    return Ok(None);
                }
                closure.push(device);
            }
        } else {
            validate_manifest_config(&manifest, &config)?;
            let layer = manifest
                .layers
                .first()
                .context("a v1 Manifest has one EROFS layer")?;
            if layer.media_type != MEDIA_TYPE_EROFS {
                anyhow::bail!("unsupported layer media type {:?}", layer.media_type);
            }
            if !self.object_verified(layer)? {
                return Ok(None);
            }
            closure.push(layer.clone());
        }
        Ok(Some(closure))
    }
}

#[async_trait::async_trait]
impl RepositoryStore for CacheRepositoryStore {
    async fn resolve_reference(
        &self,
        repository: &str,
        reference: &str,
    ) -> Result<Option<RepositoryManifest>> {
        validate_repository_name(repository)?;
        let Some(manifest_digest) = self.manifest_for(repository, reference) else {
            return Ok(None);
        };
        let descriptor = self.manifest_descriptor(&manifest_digest)?;
        Ok(Some(RepositoryManifest {
            digest: descriptor.digest,
            media_type: descriptor.media_type,
            size_bytes: descriptor.size,
        }))
    }

    async fn list_tags(&self, repository: &str) -> Result<Vec<String>> {
        validate_repository_name(repository)?;
        let references = self
            .references
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Ok(references
            .get(repository)
            .map(|tags| tags.keys().cloned().collect())
            .unwrap_or_default())
    }

    async fn verified_closure(
        &self,
        repository: &str,
        manifest_digest: &str,
    ) -> Result<Option<Vec<Descriptor>>> {
        validate_repository_name(repository)?;
        if !is_valid_digest(manifest_digest) {
            anyhow::bail!("invalid manifest digest {manifest_digest:?}");
        }
        // The Manifest must be exposed by this repository before any closure
        // is derived; a foreign or unregistered digest is invisible.
        if self.manifest_for(repository, manifest_digest).is_none() {
            return Ok(None);
        }
        self.closure_inner(manifest_digest)
    }

    async fn permits_blob(&self, repository: &str, digest: &str) -> Result<bool> {
        validate_repository_name(repository)?;
        if !is_valid_digest(digest) {
            return Ok(false);
        }
        let manifests: Vec<String> = {
            let references = self
                .references
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            references
                .get(repository)
                .map(|tags| tags.values().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        };
        let mut manifests = manifests;
        manifests.sort();
        manifests.dedup();
        for manifest_digest in manifests {
            if let Some(closure) = self.closure_inner(&manifest_digest)? {
                if closure.iter().any(|object| object.digest == digest) {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    use crate::cache::StorageProbe;
    use crate::oci::annotation::MEDIA_TYPE_CONFIG;
    use crate::oci::composite::CompositeDescriptor;
    use crate::oci::config::{ImageConfig, RootFs, RuntimeConfig};
    use crate::oci::descriptor::Platform;
    use crate::oci::manifest::Manifest;
    use crate::oci::{to_bytes, RawDocument};
    use serde_json::Map;

    struct DurableProbe;
    impl StorageProbe for DurableProbe {
        fn mount_type(&self, _path: &Path) -> Result<String> {
            Ok("nfs".to_string())
        }
    }

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

    fn config_document(diff_ids: Vec<String>, rootfs_type: &str) -> RawDocument {
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
                fs_type: rootfs_type.to_string(),
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
        let config = config_document(vec![layer.digest().to_string()], "layers");
        let manifest = manifest_document(&config, vec![descriptor(MEDIA_TYPE_EROFS, &layer)]);
        V1Fixture {
            manifest,
            config,
            layer,
        }
    }

    struct CompositeFixture {
        manifest: RawDocument,
        config: RawDocument,
        composite: RawDocument,
        metadata: RawDocument,
        device: RawDocument,
    }

    fn composite_fixture() -> CompositeFixture {
        let metadata = RawDocument::from_bytes(b"metadata erofs device".to_vec());
        let device = RawDocument::from_bytes(b"backing erofs device".to_vec());
        let platform = Platform::for_consumer("linux", "amd64", None);
        let composite = CompositeDescriptor::new(
            &platform,
            &descriptor(MEDIA_TYPE_EROFS, &metadata),
            &[descriptor(MEDIA_TYPE_EROFS, &device)],
        )
        .unwrap();
        let composite = composite.to_document().unwrap();
        let diff_ids = vec![metadata.digest().to_string(), device.digest().to_string()];
        let config = config_document(diff_ids, "erofs-composite");
        let manifest =
            manifest_document(&config, vec![descriptor(MEDIA_TYPE_COMPOSITE, &composite)]);
        CompositeFixture {
            manifest,
            config,
            composite,
            metadata,
            device,
        }
    }

    async fn projection(root: &std::path::Path) -> (CacheBlobStore, CacheRepositoryStore) {
        let cache = ErofsCache::open_with_probe(root, "agent-repo", false, &DurableProbe)
            .await
            .unwrap();
        let cache = Arc::new(cache);
        (
            CacheBlobStore::new(Arc::clone(&cache)),
            CacheRepositoryStore::new(cache),
        )
    }

    /// #4087 SC-02: a registered repository exposes only its own complete
    /// verified closure; unrelated cached digests stay invisible.
    #[tokio::test]
    async fn repository_reachability_gates_reads_of_physically_present_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let (blobs, repos) = projection(dir.path()).await;
        let a = v1_fixture(b"repository A payload");
        let b = v1_fixture(b"repository B payload");
        for document in [
            &a.manifest,
            &a.config,
            &a.layer,
            &b.manifest,
            &b.config,
            &b.layer,
        ] {
            blobs.put_bytes(document.bytes()).unwrap();
        }
        repos
            .register_tag("team/a", "v1", a.manifest.digest())
            .unwrap();
        repos
            .register_tag("team/b", "v1", b.manifest.digest())
            .unwrap();

        // Repository A resolves its own tag and pinned digest.
        let resolved = repos
            .resolve_reference("team/a", "v1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(resolved.digest, a.manifest.digest());
        assert_eq!(
            repos
                .resolve_reference("team/a", a.manifest.digest())
                .await
                .unwrap()
                .unwrap()
                .digest,
            a.manifest.digest()
        );
        assert_eq!(repos.list_tags("team/a").await.unwrap(), vec!["v1"]);

        // A's closure is exactly its verified Manifest/Config/EROFS objects.
        let closure = repos
            .verified_closure("team/a", a.manifest.digest())
            .await
            .unwrap()
            .unwrap();
        let digests: Vec<&str> = closure
            .iter()
            .map(|object| object.digest.as_str())
            .collect();
        assert_eq!(
            digests,
            vec![a.manifest.digest(), a.config.digest(), a.layer.digest()]
        );
        for object in &closure {
            assert!(repos.permits_blob("team/a", &object.digest).await.unwrap());
        }

        // B's objects are physically present in the same CAS but refused
        // through repository A — possession is not authorization.
        assert!(repos
            .resolve_reference("team/a", b.manifest.digest())
            .await
            .unwrap()
            .is_none());
        assert!(repos
            .verified_closure("team/a", b.manifest.digest())
            .await
            .unwrap()
            .is_none());
        assert!(!repos
            .permits_blob("team/a", b.layer.digest())
            .await
            .unwrap());
        assert!(blobs.contains(b.layer.digest()).unwrap());
        // An unregistered repository exposes nothing.
        assert!(repos
            .resolve_reference("team/unknown", "v1")
            .await
            .unwrap()
            .is_none());
        assert!(!repos
            .permits_blob("team/unknown", a.layer.digest())
            .await
            .unwrap());
    }

    /// #4087 SC-02: an incomplete Composite closure is refused even when its
    /// missing device is the only absent object; completing it restores reads.
    #[tokio::test]
    async fn an_incomplete_composite_closure_is_refused_not_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let (blobs, repos) = projection(dir.path()).await;
        let fixture = composite_fixture();
        for document in [
            &fixture.manifest,
            &fixture.config,
            &fixture.composite,
            &fixture.metadata,
        ] {
            blobs.put_bytes(document.bytes()).unwrap();
        }
        repos
            .register_tag("team/composite", "v1", fixture.manifest.digest())
            .unwrap();
        // The backing device is missing: the closure is incomplete.
        assert!(repos
            .verified_closure("team/composite", fixture.manifest.digest())
            .await
            .unwrap()
            .is_none());
        assert!(!repos
            .permits_blob("team/composite", fixture.metadata.digest())
            .await
            .unwrap());
        // Publishing the verified device completes the closure.
        blobs.put_bytes(fixture.device.bytes()).unwrap();
        let closure = repos
            .verified_closure("team/composite", fixture.manifest.digest())
            .await
            .unwrap()
            .unwrap();
        let digests: Vec<&str> = closure
            .iter()
            .map(|object| object.digest.as_str())
            .collect();
        assert_eq!(
            digests,
            vec![
                fixture.manifest.digest(),
                fixture.config.digest(),
                fixture.composite.digest(),
                fixture.metadata.digest(),
                fixture.device.digest()
            ]
        );
        assert!(repos
            .permits_blob("team/composite", fixture.device.digest())
            .await
            .unwrap());
    }

    /// #4087 SC-02: a missing layer makes even the Manifest's other objects
    /// unreadable through the repository — completeness gates every read.
    #[tokio::test]
    async fn a_missing_layer_blocks_the_whole_closure() {
        let dir = tempfile::tempdir().unwrap();
        let (blobs, repos) = projection(dir.path()).await;
        let fixture = v1_fixture(b"payload that never arrives");
        blobs.put_bytes(fixture.manifest.bytes()).unwrap();
        blobs.put_bytes(fixture.config.bytes()).unwrap();
        repos
            .register_tag("team/a", "v1", fixture.manifest.digest())
            .unwrap();
        assert!(repos
            .verified_closure("team/a", fixture.manifest.digest())
            .await
            .unwrap()
            .is_none());
        assert!(!repos
            .permits_blob("team/a", fixture.config.digest())
            .await
            .unwrap());
    }

    /// #4087: revoking a projection removes visibility without deleting the
    /// verified bytes, and corrupt bytes fail closed rather than as a miss.
    #[tokio::test]
    async fn revocation_hides_references_and_corruption_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let (blobs, repos) = projection(dir.path()).await;
        let fixture = v1_fixture(b"revocable payload");
        for document in [&fixture.manifest, &fixture.config, &fixture.layer] {
            blobs.put_bytes(document.bytes()).unwrap();
        }
        repos
            .register_tag("team/a", "v1", fixture.manifest.digest())
            .unwrap();
        assert!(repos.unregister_repository("team/a").unwrap());
        assert!(repos
            .resolve_reference("team/a", "v1")
            .await
            .unwrap()
            .is_none());
        assert!(!repos
            .permits_blob("team/a", fixture.layer.digest())
            .await
            .unwrap());
        assert!(blobs.contains(fixture.layer.digest()).unwrap());

        repos
            .register_tag("team/a", "v1", fixture.manifest.digest())
            .unwrap();
        std::fs::write(
            blobs.path_for(fixture.manifest.digest()).unwrap(),
            b"tampered",
        )
        .unwrap();
        assert!(repos
            .verified_closure("team/a", fixture.manifest.digest())
            .await
            .is_err());
    }

    /// #4087: registration never invents reachability for absent objects.
    #[tokio::test]
    async fn registration_requires_verified_manifest_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let (_blobs, repos) = projection(dir.path()).await;
        let absent = crate::digest::digest_of_bytes(b"not stored");
        assert!(repos.register_tag("team/a", "v1", &absent).is_err());
        assert!(repos.list_tags("team/a").await.unwrap().is_empty());
    }
}
