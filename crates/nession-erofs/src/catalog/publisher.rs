//! The Server catalog adapter of the #4088 [`RepositoryPublisher`] contract.
//!
//! [`CatalogRepositoryPublisher`] makes Registry pushes visible through the
//! same SQLite catalog the [`super::CatalogRepositoryStore`] reads. Bytes are
//! CAS-published by the service first; this adapter records the object rows,
//! descriptor edges and the mutable Tag in one transaction, so a failed push
//! never leaves a Tag pointing at an incomplete object.
//!
//! Blob uploads (`publish_blob`) only confirm the verified CAS object: a raw
//! upload carries no media type, so its catalog row is created when a Manifest
//! references it. Unrecorded CAS bytes are not swept by catalog GC (which walks
//! `catalog_objects`), so an uploaded-but-not-yet-manifested blob is safe.
//!
//! The catalog is Nession-image-specific: referenced layers must be EROFS or
//! Composite v1 media types. This adapter deliberately does not claim Docker
//! runtime compatibility for arbitrary OCI artifacts.
//!
//! Exposure follows the accepted #4087 tag-rooted reachability fence: a
//! Manifest pushed by Tag is readable by both its Tag and its digest (the Tag
//! root reaches it); a Manifest pushed by digest alone is recorded durably but
//! is exposed only once a Tag or pin reaches it. Moving a Tag therefore moves
//! the repository's exposed root atomically — the previous revision leaves the
//! fence (and becomes GC-eligible) while its bytes remain in the CAS.

use std::path::Path;

use anyhow::{Context, Result};
use sea_orm::DatabaseConnection;

use super::reference::{record_object, record_reference, ObjectKind, StoredObject};
use super::tag::{get_tag, set_tag, TagExpectation};
use crate::blob::store::FsBlobStore;
use crate::digest::is_valid_digest;
use crate::oci::composite::parse_composite;
use crate::registry::service::{describe_manifest_document, RepositoryPublisher};

/// Publishes Registry pushes into the Server's catalog over its own connection.
pub struct CatalogRepositoryPublisher {
    conn: DatabaseConnection,
    blobs: FsBlobStore,
}

impl CatalogRepositoryPublisher {
    /// Publish over the Server's existing connection and authoritative CAS.
    /// Opens no second database.
    pub fn new(conn: DatabaseConnection, blobs: FsBlobStore) -> Self {
        Self { conn, blobs }
    }

    fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs() as i64)
            .unwrap_or(0)
    }

    /// Record one referenced object and its edge, verifying CAS bytes first.
    async fn record_reference_object(
        &self,
        transaction: &sea_orm::DatabaseTransaction,
        parent: &str,
        digest: &str,
        media_type: &str,
        size: u64,
        role: &str,
    ) -> Result<()> {
        let now = Self::now();
        let kind = ObjectKind::for_media_type(media_type)
            .with_context(|| format!("unsupported catalog media type {media_type:?}"))?;
        self.blobs
            .verify_named_size(digest, size)
            .with_context(|| format!("referenced object {digest} is not a verified CAS object"))?;
        record_object(
            transaction,
            &StoredObject {
                digest: digest.to_string(),
                media_type: media_type.to_string(),
                size_bytes: size,
                kind,
            },
            now,
        )
        .await?;
        record_reference(transaction, parent, digest, role, now).await?;
        Ok(())
    }
}

#[async_trait::async_trait]
impl RepositoryPublisher for CatalogRepositoryPublisher {
    async fn publish_blob(
        &self,
        _repository: &str,
        digest: &str,
        size_bytes: u64,
        _path: &Path,
    ) -> Result<()> {
        if !is_valid_digest(digest) {
            anyhow::bail!("invalid uploaded blob digest {digest:?}");
        }
        // The service already CAS-published and hashed these bytes; confirm the
        // verified object is present. The typed catalog row is recorded when a
        // Manifest references the blob (a raw upload carries no media type).
        self.blobs
            .verify_named_size(digest, size_bytes)
            .context("uploaded blob is not a verified CAS object")?;
        Ok(())
    }

    async fn publish_manifest(
        &self,
        repository: &str,
        reference: &str,
        media_type: &str,
        digest: &str,
        size_bytes: u64,
        _path: &Path,
    ) -> Result<()> {
        let root_kind = ObjectKind::for_media_type(media_type)
            .with_context(|| format!("unsupported manifest media type {media_type:?}"))?;
        if !matches!(root_kind, ObjectKind::Manifest | ObjectKind::Index) {
            anyhow::bail!("registry push root must be a Manifest/Index, not {root_kind:?}");
        }
        let bytes = self
            .blobs
            .read(digest)
            .context("published manifest bytes are not in the CAS")?;
        let shape = describe_manifest_document(&bytes)
            .map_err(|error| anyhow::anyhow!("published manifest is malformed: {error}"))?;
        if shape.media_type != media_type {
            anyhow::bail!("manifest media type drift between push and stored document");
        }

        let now = Self::now();
        let transaction = super::sqlite::begin(&self.conn).await?;
        record_object(
            &transaction,
            &StoredObject {
                digest: digest.to_string(),
                media_type: media_type.to_string(),
                size_bytes,
                kind: root_kind,
            },
            now,
        )
        .await?;
        for descriptor in &shape.references {
            self.record_reference_object(
                &transaction,
                digest,
                &descriptor.digest,
                &descriptor.media_type,
                descriptor.size,
                descriptor.role,
            )
            .await?;
            // A Composite layer carries its own backing closure; record it so
            // the repository's verified closure is complete.
            if descriptor.media_type == crate::oci::MEDIA_TYPE_COMPOSITE {
                let composite_bytes = self.blobs.read(&descriptor.digest)?;
                let composite = parse_composite(&composite_bytes)?;
                for (index, device) in composite.closure()?.iter().enumerate() {
                    let role = if index == 0 { "metadata" } else { "device" };
                    self.record_reference_object(
                        &transaction,
                        &descriptor.digest,
                        &device.digest,
                        &device.media_type,
                        device.size,
                        role,
                    )
                    .await?;
                }
            }
        }
        if let Some(subject) = &shape.subject {
            if self.blobs.contains(&subject.digest)? {
                record_reference(&transaction, digest, &subject.digest, "subject", now).await?;
            }
        }
        // A tag reference moves the mutable Tag with compare-and-swap; a digest
        // reference publishes the object without a Tag.
        if !is_valid_digest(reference) {
            let expectation = match get_tag(&transaction, repository, reference).await? {
                Some(current) => TagExpectation::Exact(current),
                None => TagExpectation::Absent,
            };
            set_tag(
                &transaction,
                repository,
                reference,
                digest,
                &expectation,
                now,
            )
            .await?;
        }
        transaction
            .commit()
            .await
            .map_err(|error| anyhow::anyhow!("registry publication commit failed: {error}"))?;
        Ok(())
    }
}
