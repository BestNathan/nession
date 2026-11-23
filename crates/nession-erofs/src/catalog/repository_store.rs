//! The Server-owned adapter of the reusable #4087 `RepositoryStore` contract.
//!
//! [`CatalogRepositoryStore`] projects the SQLite catalog into the same
//! repository reachability surface the Agent implements over its verified
//! cache. A repository exposes only the Manifest/Index closures reachable
//! from its own Tags; a digest recorded for another repository — or merely
//! present in the shared CAS — is invisible here. Closure completeness is
//! derived from the exact OCI documents and verified against catalog rows and
//! CAS bytes, so an incomplete Composite is refused, never truncated.
//!
//! Authorization beyond repository reachability (Project/Session/tenant
//! policy) stays with the Server adapter that injects this store into the
//! Registry service (#4088); knowing a digest is never authorization.

use anyhow::Result;
use sea_orm::ConnectionTrait;

use super::reference::{get_object, ObjectKind, StoredObject};
use super::tag;
use crate::blob::store::FsBlobStore;
use crate::contracts::{validate_repository_name, RepositoryManifest, RepositoryStore};
use crate::digest::is_valid_digest;
use crate::oci::annotation::{MEDIA_TYPE_COMPOSITE, MEDIA_TYPE_EROFS};
use crate::oci::composite::{parse_composite, validate_composite_manifest_config};
use crate::oci::descriptor::Descriptor;
use crate::oci::validation::validate_manifest_config;
use crate::oci::{parse_config, parse_index, parse_manifest};

/// The Server catalog viewed as a reusable repository reachability contract.
pub struct CatalogRepositoryStore<C: ConnectionTrait> {
    conn: C,
    blobs: FsBlobStore,
}

impl<C: ConnectionTrait> CatalogRepositoryStore<C> {
    /// Project over the Server's existing connection and authoritative CAS.
    /// The store opens no second database and keeps no mirrored state.
    pub fn new(conn: C, blobs: FsBlobStore) -> Self {
        Self { conn, blobs }
    }

    /// The repository's Tag target digests: its only reachability roots.
    async fn repository_roots(&self, repository: &str) -> Result<Vec<String>> {
        let tags = tag::list_tags(&self.conn, repository).await?;
        let mut roots = Vec::new();
        for name in tags {
            if let Some(digest) = tag::get_tag(&self.conn, repository, &name).await? {
                if !roots.contains(&digest) {
                    roots.push(digest);
                }
            }
        }
        Ok(roots)
    }

    /// Everything the repository's Tags reach through descriptor edges,
    /// including Index children. This is the repository's authorization fence.
    async fn repository_reachable(
        &self,
        repository: &str,
    ) -> Result<std::collections::HashSet<String>> {
        let roots = self.repository_roots(repository).await?;
        super::reference::reachable(&self.conn, &roots).await
    }

    /// One object row matched against a descriptor claim, or `None` when the
    /// catalog does not record the object (incomplete closure).
    async fn matched_object(&self, descriptor: &Descriptor) -> Result<Option<StoredObject>> {
        let Some(object) = get_object(&self.conn, &descriptor.digest).await? else {
            return Ok(None);
        };
        if object.media_type != descriptor.media_type || object.size_bytes != descriptor.size {
            anyhow::bail!(
                "catalog object {} is stale against its descriptor ({} {} bytes vs {} {} bytes)",
                object.digest,
                object.media_type,
                object.size_bytes,
                descriptor.media_type,
                descriptor.size
            );
        }
        Ok(Some(object))
    }

    /// Verify one closure object exists with matching CAS bytes.
    /// `Ok(false)` is a missing object; `Err` is corrupt bytes or a stale row.
    async fn closure_object(&self, descriptor: &Descriptor) -> Result<bool> {
        let Some(_object) = self.matched_object(descriptor).await? else {
            return Ok(false);
        };
        if !self.blobs.contains(&descriptor.digest)? {
            return Ok(false);
        }
        self.blobs
            .verify_named_size(&descriptor.digest, descriptor.size)?;
        Ok(true)
    }

    fn descriptor_of(object: &StoredObject) -> Descriptor {
        Descriptor {
            media_type: object.media_type.clone(),
            digest: object.digest.clone(),
            size: object.size_bytes,
            urls: None,
            annotations: None,
            platform: None,
            artifact_type: None,
            data: None,
            extra: Default::default(),
        }
    }

    /// Derive one root's complete verified closure from the exact documents.
    /// `seen` bounds the walk so a shared child is expanded once and a
    /// malformed cyclic edge can never recurse without termination.
    async fn closure_from_root(
        &self,
        root: &StoredObject,
        seen: &mut std::collections::HashSet<String>,
    ) -> Result<Option<Vec<Descriptor>>> {
        if !seen.insert(root.digest.clone()) {
            return Ok(Some(Vec::new()));
        }
        if !self.blobs.contains(&root.digest)? {
            return Ok(None);
        }
        self.blobs
            .verify_named_size(&root.digest, root.size_bytes)?;
        let bytes = self.blobs.read(&root.digest)?;
        let mut closure = vec![Self::descriptor_of(root)];
        match root.kind {
            ObjectKind::Index => {
                let (_document, index) = parse_index(&bytes)?;
                for child in &index.manifests {
                    let Some(object) = self.matched_object(child).await? else {
                        return Ok(None);
                    };
                    if !matches!(object.kind, ObjectKind::Manifest | ObjectKind::Index) {
                        anyhow::bail!("Index child {} is not a Manifest/Index", child.digest);
                    }
                    let Some(mut child_closure) =
                        Box::pin(self.closure_from_root(&object, seen)).await?
                    else {
                        return Ok(None);
                    };
                    closure.append(&mut child_closure);
                }
            }
            ObjectKind::Manifest => {
                let (_document, manifest) = parse_manifest(&bytes)?;
                if !self.closure_object(&manifest.config).await? {
                    return Ok(None);
                }
                let config_bytes = self.blobs.read(&manifest.config.digest)?;
                let (_config_document, config) = parse_config(&config_bytes)?;
                closure.push(manifest.config.clone());
                let Some(layer) = manifest.layers.first() else {
                    anyhow::bail!("Manifest {} has no layer", root.digest);
                };
                if layer.media_type == MEDIA_TYPE_COMPOSITE {
                    if !self.closure_object(layer).await? {
                        return Ok(None);
                    }
                    let composite_bytes = self.blobs.read(&layer.digest)?;
                    let composite = parse_composite(&composite_bytes)?;
                    validate_composite_manifest_config(&manifest, &config, &composite, layer)?;
                    closure.push(layer.clone());
                    for device in composite.closure()? {
                        if !self.closure_object(&device).await? {
                            return Ok(None);
                        }
                        closure.push(device);
                    }
                } else {
                    if layer.media_type != MEDIA_TYPE_EROFS {
                        anyhow::bail!("unsupported layer media type {:?}", layer.media_type);
                    }
                    validate_manifest_config(&manifest, &config)?;
                    if !self.closure_object(layer).await? {
                        return Ok(None);
                    }
                    closure.push(layer.clone());
                }
            }
            other => anyhow::bail!(
                "repository root {} is a {other:?}, not a Manifest/Index",
                root.digest
            ),
        }
        Ok(Some(closure))
    }
}

#[async_trait::async_trait]
impl<C: ConnectionTrait + Send + Sync + 'static> RepositoryStore for CatalogRepositoryStore<C> {
    async fn resolve_reference(
        &self,
        repository: &str,
        reference: &str,
    ) -> Result<Option<RepositoryManifest>> {
        validate_repository_name(repository)?;
        let digest = if is_valid_digest(reference) {
            // An immutable reference is exposed only when this repository's
            // Tags reach it; a foreign repository's digest stays invisible.
            if !self
                .repository_reachable(repository)
                .await?
                .contains(reference)
            {
                return Ok(None);
            }
            reference.to_string()
        } else {
            let Some(resolved) = tag::get_tag(&self.conn, repository, reference).await? else {
                return Ok(None);
            };
            resolved
        };
        let Some(object) = get_object(&self.conn, &digest).await? else {
            return Ok(None);
        };
        if !matches!(object.kind, ObjectKind::Manifest | ObjectKind::Index) {
            return Ok(None);
        }
        Ok(Some(RepositoryManifest {
            digest: object.digest,
            media_type: object.media_type,
            size_bytes: object.size_bytes,
        }))
    }

    async fn list_tags(&self, repository: &str) -> Result<Vec<String>> {
        tag::list_tags(&self.conn, repository).await
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
        if !self
            .repository_reachable(repository)
            .await?
            .contains(manifest_digest)
        {
            return Ok(None);
        }
        let Some(root) = get_object(&self.conn, manifest_digest).await? else {
            return Ok(None);
        };
        self.closure_from_root(&root, &mut std::collections::HashSet::new())
            .await
    }

    async fn permits_blob(&self, repository: &str, digest: &str) -> Result<bool> {
        validate_repository_name(repository)?;
        if !is_valid_digest(digest) {
            return Ok(false);
        }
        for root_digest in self.repository_roots(repository).await? {
            let Some(root) = get_object(&self.conn, &root_digest).await? else {
                continue;
            };
            if let Some(closure) = self
                .closure_from_root(&root, &mut std::collections::HashSet::new())
                .await?
            {
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
    use crate::catalog::pin::{self, ConsumerKind};
    use crate::catalog::reference::{record_object, record_reference};
    use crate::catalog::sqlite::tests::memory_connection;
    use crate::catalog::tag::{set_tag, TagExpectation};
    use crate::contracts::BlobStore;
    use crate::oci::annotation::{MEDIA_TYPE_CONFIG, MEDIA_TYPE_INDEX, MEDIA_TYPE_MANIFEST};
    use crate::oci::composite::CompositeDescriptor;
    use crate::oci::config::{ImageConfig, RootFs, RuntimeConfig};
    use crate::oci::descriptor::Platform;
    use crate::oci::index::Index;
    use crate::oci::manifest::Manifest;
    use crate::oci::{to_bytes, RawDocument};
    use sea_orm::DatabaseConnection;
    use serde_json::Map;

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

    fn stored(document: &RawDocument, kind: ObjectKind, media_type: &str) -> StoredObject {
        StoredObject {
            digest: document.digest().to_string(),
            media_type: media_type.to_string(),
            size_bytes: document.size().unwrap(),
            kind,
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

    /// Publish one v1 fixture into the shared CAS and catalog, tagged in its
    /// own repository. Returns the fixture for digest assertions.
    async fn publish_v1(
        conn: &DatabaseConnection,
        blobs: &FsBlobStore,
        repository: &str,
        tag: &str,
        payload: &[u8],
    ) -> V1Fixture {
        let fixture = v1_fixture(payload);
        for (document, kind, media_type) in [
            (&fixture.layer, ObjectKind::Erofs, MEDIA_TYPE_EROFS),
            (&fixture.config, ObjectKind::Config, MEDIA_TYPE_CONFIG),
            (&fixture.manifest, ObjectKind::Manifest, MEDIA_TYPE_MANIFEST),
        ] {
            blobs.put_bytes(document.bytes()).unwrap();
            record_object(conn, &stored(document, kind, media_type), 1)
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
        fixture
    }

    async fn fixture_store(
        dir: &std::path::Path,
    ) -> (
        DatabaseConnection,
        FsBlobStore,
        CatalogRepositoryStore<DatabaseConnection>,
    ) {
        let conn = memory_connection().await;
        crate::catalog::migrate(&conn).await.unwrap();
        let blobs = FsBlobStore::new(dir.join("server-cas")).unwrap();
        let repos = CatalogRepositoryStore::new(conn.clone(), blobs.clone());
        (conn, blobs, repos)
    }

    /// #4087 SC-02: two repositories share one CAS; each exposes only its own
    /// complete verified closure, by tag and by immutable digest.
    #[tokio::test]
    async fn shared_cas_repositories_expose_only_their_own_closures() {
        let dir = tempfile::tempdir().unwrap();
        let (conn, blobs, repos) = fixture_store(dir.path()).await;
        let a = publish_v1(&conn, &blobs, "team/a", "v1", b"repository A payload").await;
        let b = publish_v1(&conn, &blobs, "team/b", "v1", b"repository B payload").await;

        assert_eq!(
            repos
                .resolve_reference("team/a", "v1")
                .await
                .unwrap()
                .unwrap()
                .digest,
            a.manifest.digest()
        );
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

        // B's digest is catalog-recorded and physically present, yet refused
        // through repository A.
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
        // An unknown repository exposes nothing.
        assert!(repos
            .resolve_reference("team/unknown", "v1")
            .await
            .unwrap()
            .is_none());
    }

    /// #4087 SC-02: an Index root exposes its platform children's closures,
    /// and a digest outside the repository's Tag roots stays invisible.
    #[tokio::test]
    async fn index_roots_expose_child_closures_within_the_repository() {
        let dir = tempfile::tempdir().unwrap();
        let (conn, blobs, repos) = fixture_store(dir.path()).await;
        let child = publish_v1(&conn, &blobs, "team/index", "child", b"child payload").await;
        let index = Index {
            schema_version: 2,
            media_type: Some(MEDIA_TYPE_INDEX.to_string()),
            manifests: vec![descriptor(MEDIA_TYPE_MANIFEST, &child.manifest)],
            annotations: None,
            extra: Map::new(),
        };
        let index = RawDocument::from_bytes(to_bytes(&index).unwrap());
        blobs.put_bytes(index.bytes()).unwrap();
        record_object(
            &conn,
            &stored(&index, ObjectKind::Index, MEDIA_TYPE_INDEX),
            1,
        )
        .await
        .unwrap();
        record_reference(
            &conn,
            index.digest(),
            child.manifest.digest(),
            "index-child",
            1,
        )
        .await
        .unwrap();
        set_tag(
            &conn,
            "team/index",
            "latest",
            index.digest(),
            &TagExpectation::Absent,
            1,
        )
        .await
        .unwrap();

        let closure = repos
            .verified_closure("team/index", index.digest())
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
                index.digest(),
                child.manifest.digest(),
                child.config.digest(),
                child.layer.digest()
            ]
        );
        assert!(repos
            .permits_blob("team/index", child.layer.digest())
            .await
            .unwrap());
        // The child Manifest is reachable through the Index tag, so its
        // digest resolves inside this repository.
        assert!(repos
            .resolve_reference("team/index", child.manifest.digest())
            .await
            .unwrap()
            .is_some());
    }

    /// #4087 SC-02: an incomplete Composite (missing backing device bytes) is
    /// refused even though its catalog rows and other objects are present.
    #[tokio::test]
    async fn an_incomplete_composite_is_refused_in_the_server_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let (conn, blobs, repos) = fixture_store(dir.path()).await;
        let metadata = RawDocument::from_bytes(b"metadata erofs device".to_vec());
        let device = RawDocument::from_bytes(b"backing erofs device".to_vec());
        let platform = Platform::for_consumer("linux", "amd64", None);
        let composite = CompositeDescriptor::new(
            &platform,
            &descriptor(MEDIA_TYPE_EROFS, &metadata),
            &[descriptor(MEDIA_TYPE_EROFS, &device)],
        )
        .unwrap()
        .to_document()
        .unwrap();
        let config = config_document(
            vec![metadata.digest().to_string(), device.digest().to_string()],
            "erofs-composite",
        );
        let manifest =
            manifest_document(&config, vec![descriptor(MEDIA_TYPE_COMPOSITE, &composite)]);
        // Every object is catalog-recorded; the backing device bytes are not
        // published to the CAS.
        for (document, kind, media_type) in [
            (&metadata, ObjectKind::Erofs, MEDIA_TYPE_EROFS),
            (&device, ObjectKind::Erofs, MEDIA_TYPE_EROFS),
            (&composite, ObjectKind::Composite, MEDIA_TYPE_COMPOSITE),
            (&config, ObjectKind::Config, MEDIA_TYPE_CONFIG),
            (&manifest, ObjectKind::Manifest, MEDIA_TYPE_MANIFEST),
        ] {
            if document.digest() != device.digest() {
                blobs.put_bytes(document.bytes()).unwrap();
            }
            record_object(&conn, &stored(document, kind, media_type), 1)
                .await
                .unwrap();
        }
        for (parent, child, role) in [
            (manifest.digest(), config.digest(), "config"),
            (manifest.digest(), composite.digest(), "layer"),
            (composite.digest(), metadata.digest(), "metadata"),
            (composite.digest(), device.digest(), "device"),
        ] {
            record_reference(&conn, parent, child, role, 1)
                .await
                .unwrap();
        }
        set_tag(
            &conn,
            "team/composite",
            "v1",
            manifest.digest(),
            &TagExpectation::Absent,
            1,
        )
        .await
        .unwrap();

        assert!(repos
            .verified_closure("team/composite", manifest.digest())
            .await
            .unwrap()
            .is_none());
        assert!(!repos
            .permits_blob("team/composite", metadata.digest())
            .await
            .unwrap());
        // Completing the closure restores reads.
        blobs.put_bytes(device.bytes()).unwrap();
        let closure = repos
            .verified_closure("team/composite", manifest.digest())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(closure.len(), 5);
        assert!(repos
            .permits_blob("team/composite", device.digest())
            .await
            .unwrap());
    }

    /// #4087 SC-03: Server GC reclaims only unreferenced catalog objects;
    /// tagged and pinned references survive, and Agent cache bytes on the
    /// same volume are never touched by the Server sweep.
    #[cfg(feature = "cache")]
    #[tokio::test]
    async fn server_gc_preserves_references_and_never_crosses_into_the_agent_cache() {
        let dir = tempfile::tempdir().unwrap();
        let (conn, blobs, _repos) = fixture_store(dir.path()).await;
        let kept = publish_v1(&conn, &blobs, "team/a", "v1", b"tagged payload").await;
        let pinned = publish_v1(&conn, &blobs, "team/pinned", "v1", b"pinned payload").await;
        // Move the pinned repository's tag away; only the live Session pin
        // keeps the old revision reachable for GC.
        let moved = publish_v1(&conn, &blobs, "team/pinned", "v2", b"moved payload").await;
        tag::delete_tag(&conn, "team/pinned", "v1").await.unwrap();
        pin::pin(
            &conn,
            ConsumerKind::Session,
            "session-1",
            pinned.manifest.digest(),
            1,
            None,
        )
        .await
        .unwrap();
        let orphan = v1_fixture(b"orphan payload");
        for (document, kind, media_type) in [
            (&orphan.layer, ObjectKind::Erofs, MEDIA_TYPE_EROFS),
            (&orphan.config, ObjectKind::Config, MEDIA_TYPE_CONFIG),
            (&orphan.manifest, ObjectKind::Manifest, MEDIA_TYPE_MANIFEST),
        ] {
            blobs.put_bytes(document.bytes()).unwrap();
            record_object(&conn, &stored(document, kind, media_type), 1)
                .await
                .unwrap();
        }
        // An Agent cache shares the volume parent but owns its namespace.
        let agent =
            crate::cache::ErofsCache::open_with_probe(dir.path(), "agent-gc", false, &AgentProbe)
                .await
                .unwrap();
        let agent_blobs = crate::cache::store::CacheBlobStore::new(std::sync::Arc::new(agent));
        let agent_bytes = b"agent cached payload";
        let agent_blob = agent_blobs.put_bytes(agent_bytes).unwrap();

        let policy = crate::catalog::gc::GcPolicy {
            grace_seconds: 0,
            ..crate::catalog::gc::GcPolicy::default()
        };
        // First sweep marks; second rechecks and reclaims.
        crate::catalog::gc::sweep(&conn, &blobs, 10, &policy, &[])
            .await
            .unwrap();
        let report = crate::catalog::gc::sweep(&conn, &blobs, 20, &policy, &[])
            .await
            .unwrap();
        assert!(report.deleted_objects > 0);
        // Tagged and pinned closures survive.
        for digest in [
            kept.manifest.digest(),
            kept.config.digest(),
            kept.layer.digest(),
            pinned.manifest.digest(),
            pinned.config.digest(),
            pinned.layer.digest(),
            moved.manifest.digest(),
        ] {
            assert!(blobs.contains(digest).unwrap(), "{digest} must survive GC");
        }
        // The orphan is reclaimed.
        assert!(!blobs.contains(orphan.manifest.digest()).unwrap());
        // Agent bytes are untouched: GC never crosses ownership namespaces.
        assert!(agent_blobs.contains(&agent_blob.digest).unwrap());
        assert_eq!(agent_blobs.read(&agent_blob.digest).unwrap(), agent_bytes);
    }

    /// #4087: negative reference probes fail closed with distinct semantics —
    /// a non-image object, a stale catalog row and an invalid name never
    /// resolve into a readable identity.
    #[tokio::test]
    async fn negative_references_are_refused_with_distinct_semantics() {
        let dir = tempfile::tempdir().unwrap();
        let (conn, blobs, repos) = fixture_store(dir.path()).await;
        let a = publish_v1(&conn, &blobs, "team/a", "v1", b"payload").await;
        // A Config digest is recorded and present, but is not an image root.
        assert!(repos
            .resolve_reference("team/a", a.config.digest())
            .await
            .unwrap()
            .is_none());
        // An invalid repository name is an error, not an empty result.
        assert!(repos.resolve_reference("../escape", "v1").await.is_err());
        assert!(repos.list_tags("../escape").await.is_err());
        assert!(repos
            .verified_closure("../escape", a.manifest.digest())
            .await
            .is_err());
        // An invalid digest never permits a read.
        assert!(!repos.permits_blob("team/a", "sha256:short").await.unwrap());
        assert!(repos
            .verified_closure("team/a", "sha256:short")
            .await
            .is_err());
        // A stale catalog row (size drift) fails closed rather than resolving.
        let stale = StoredObject {
            digest: a.manifest.digest().to_string(),
            media_type: MEDIA_TYPE_MANIFEST.to_string(),
            size_bytes: a.manifest.size().unwrap() + 1,
            kind: ObjectKind::Manifest,
        };
        assert!(record_object(&conn, &stale, 2).await.is_err());
        // A tag pointing at a missing object row is invisible.
        let absent = crate::digest::digest_of_bytes(b"never recorded");
        set_tag(
            &conn,
            "team/a",
            "broken",
            &absent,
            &TagExpectation::Absent,
            1,
        )
        .await
        .unwrap();
        assert!(repos
            .resolve_reference("team/a", "broken")
            .await
            .unwrap()
            .is_none());
        assert!(repos
            .verified_closure("team/a", &absent)
            .await
            .unwrap()
            .is_none());
    }

    #[cfg(feature = "cache")]
    struct AgentProbe;
    #[cfg(feature = "cache")]
    impl crate::cache::StorageProbe for AgentProbe {
        fn mount_type(&self, _path: &std::path::Path) -> Result<String> {
            Ok("nfs".to_string())
        }
    }
}
