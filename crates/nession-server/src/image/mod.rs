//! Server-owned global EROFS Image Manager (#3022).
//!
//! The manager composes canonical source validation, a bounded build worker,
//! the content-addressed blob store, Project-scoped access grants and GC. It is
//! the only writer of image metadata and blob bytes; Projects reference a
//! digest and never own either.

pub mod http;
pub use http::ImageHttpService;

use anyhow::Result;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Semaphore;

use nession_erofs::{BlobStore, BuiltImage, ErofsBuilder};
use nession_protocol::contracts::image::v1::{
    is_valid_image_digest, normalize_alias, normalize_image_digest, normalize_image_source,
    ImageDescriptor, ImagePackaging, ImageSource, ImageStatus, NormalizedImageSource,
    IMAGE_BLOB_PATH_PREFIX, IMAGE_LIST_MAX_LIMIT,
};
use nession_protocol::contracts::project::v1::is_valid_project_id;

use crate::db::{Database, ImageGrantRow, ImageLeaseRow, ImageRow};

/// The bounded build seam. Production is [`ErofsBuilder`]; Server tests inject
/// a deterministic backend so build policy is exercised without `mkfs.erofs`.
pub trait ImageBuildBackend: Send + Sync {
    fn build(
        &self,
        source: &NormalizedImageSource,
        packaging: &ImagePackaging,
    ) -> Result<BuiltImage>;
}

impl ImageBuildBackend for ErofsBuilder {
    fn build(
        &self,
        source: &NormalizedImageSource,
        packaging: &ImagePackaging,
    ) -> Result<BuiltImage> {
        self.build_source(source, packaging)
    }
}

/// Deterministic manager failures the protocol handler maps to `error_kind`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageError {
    Invalid(String),
    NotFound(String),
    Forbidden(String),
    Unavailable(String),
    BuildFailed(String),
}

impl ImageError {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Invalid(_) => "invalid",
            Self::NotFound(_) => "not_found",
            Self::Forbidden(_) => "forbidden",
            Self::Unavailable(_) => "unavailable",
            Self::BuildFailed(_) => "build_failed",
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Invalid(message)
            | Self::NotFound(message)
            | Self::Forbidden(message)
            | Self::Unavailable(message)
            | Self::BuildFailed(message) => message,
        }
    }
}

impl std::fmt::Display for ImageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for ImageError {}

/// One page of the complete registry inventory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageListPage {
    pub images: Vec<ImageDescriptor>,
    pub total: u64,
    pub next_offset: Option<u32>,
}

/// The single consumer context a grant is scoped to.
enum GrantConsumer<'a> {
    Project(&'a str),
    Session(&'a str),
}

impl From<nession_protocol::contracts::image::v1::ImageValidationError> for ImageError {
    fn from(error: nession_protocol::contracts::image::v1::ImageValidationError) -> Self {
        Self::Invalid(error.message())
    }
}

/// One minted scoped bearer grant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageAccessGrant {
    pub token: String,
    pub expires_at: u64,
    pub path: String,
}

/// The outcome of one GC sweep (#3180 SC-02).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GcReport {
    /// Candidates the query returned (before any bound).
    pub candidates: u64,
    /// Candidates actually examined in this sweep.
    pub examined_images: u64,
    pub removed_images: u64,
    pub removed_blobs: u64,
    pub reclaimed_bytes: u64,
    pub skipped_active_transfers: u64,
    /// Candidates left for a later sweep by `max_candidates` or
    /// `max_deleted_bytes`. A bounded sweep is resumable: the next call
    /// re-evaluates these from the database, not from in-memory state.
    pub deferred_by_limit: u64,
}

/// Bounds for one GC sweep. Deletion is bounded so a scheduled sweep can never
/// become an unbounded delete loop over a large registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GcLimits {
    pub max_candidates: usize,
    pub max_deleted_bytes: u64,
}

impl Default for GcLimits {
    fn default() -> Self {
        Self {
            max_candidates: 64,
            max_deleted_bytes: 512 * 1024 * 1024,
        }
    }
}

/// Server image storage as operators need to see it: metadata rows by status,
/// ready blob bytes, and unpublished temporary files (#3180 SC-05).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageStorageDiagnostics {
    pub blob_dir: std::path::PathBuf,
    pub ready_images: u64,
    pub failed_images: u64,
    pub building_images: u64,
    pub blobs: u64,
    pub blob_bytes: u64,
    pub temp_files: u64,
    pub temp_bytes: u64,
}

/// Server-owned image manager.
pub struct ImageManager {
    db: Arc<Database>,
    builder: Arc<dyn ImageBuildBackend>,
    blobs: BlobStore,
    semaphore: Arc<Semaphore>,
    access_token_ttl_secs: u64,
    /// In-process active transfers, keyed by digest. GC consults this so a
    /// reader is never racing a delete.
    transfers: Arc<Mutex<HashMap<String, usize>>>,
}

/// A backend that refuses every build. Used by handler/integration fixtures
/// that never exercise the image units; production always passes `ErofsBuilder`.
#[derive(Debug, Clone, Copy)]
pub struct UnavailableBackend;

impl ImageBuildBackend for UnavailableBackend {
    fn build(
        &self,
        _source: &NormalizedImageSource,
        _packaging: &ImagePackaging,
    ) -> Result<BuiltImage> {
        anyhow::bail!("image build backend is unavailable in this test host")
    }
}

impl ImageManager {
    /// Build a manager whose backend refuses builds. Test/support only.
    pub fn unavailable(db: Arc<Database>, blob_dir: impl Into<std::path::PathBuf>) -> Result<Self> {
        let blob_dir = blob_dir.into();
        let blobs = BlobStore::new(&blob_dir)?;
        Ok(Self::new(db, Arc::new(UnavailableBackend), blobs, 1, 60))
    }

    pub fn new(
        db: Arc<Database>,
        builder: Arc<dyn ImageBuildBackend>,
        blobs: BlobStore,
        max_concurrent_builds: usize,
        access_token_ttl_secs: u64,
    ) -> Self {
        Self {
            db,
            builder,
            blobs,
            semaphore: Arc::new(Semaphore::new(max_concurrent_builds.max(1))),
            access_token_ttl_secs: access_token_ttl_secs.max(1),
            transfers: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Build one source and publish it atomically. A failed build leaves an
    /// explicit `failed` row and no ready bytes.
    pub async fn build(
        &self,
        source: &ImageSource,
        alias: Option<&str>,
    ) -> std::result::Result<ImageDescriptor, ImageError> {
        let normalized = normalize_image_source(source)?;
        let alias = alias.map(normalize_alias).transpose()?;
        let packaging = ImagePackaging::default();
        let now = now_i64();
        let image_id = format!("image-{}", uuid::Uuid::new_v4().simple());
        let source_json = serde_json::to_string(&normalized.source())
            .map_err(|e| ImageError::Unavailable(format!("image source encoding failed: {e}")))?;
        let packaging_json = serde_json::to_string(&packaging).map_err(|e| {
            ImageError::Unavailable(format!("image packaging encoding failed: {e}"))
        })?;
        let row = ImageRow {
            image_id: image_id.clone(),
            digest: None,
            size_bytes: 0,
            source_json,
            source_sha: None,
            packaging_json,
            status: ImageStatus::Building.as_str().to_string(),
            error: None,
            created_at: now,
            updated_at: now,
        };
        self.db.insert_image(&row).await.map_err(|e| {
            ImageError::Unavailable(format!("image build could not be recorded: {e:#}"))
        })?;

        let permit = self.semaphore.clone().acquire_owned().await.map_err(|_| {
            ImageError::Unavailable("image build worker is unavailable".to_string())
        })?;
        let builder = Arc::clone(&self.builder);
        let source_for_build = normalized.clone();
        let built = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            builder.build(&source_for_build, &packaging)
        })
        .await;
        let built = match built {
            Ok(Ok(built)) => built,
            Ok(Err(error)) => {
                let text = bounded_error(&format!("{error:#}"));
                let _ = self.db.fail_image(&image_id, &text, now_i64()).await;
                return Err(ImageError::BuildFailed(text));
            }
            Err(error) => {
                let text = bounded_error(&format!("image build worker failed: {error}"));
                let _ = self.db.fail_image(&image_id, &text, now_i64()).await;
                return Err(ImageError::Unavailable(text));
            }
        };

        // The same content may already have a ready row. One physical blob and
        // one immutable metadata row are the identity; the second attempt is
        // retired rather than duplicated.
        if let Ok(Some(existing)) = self.db.get_image_by_digest(&built.blob.digest).await {
            if existing.status == ImageStatus::Ready.as_str() {
                let _ = self.db.delete_image_row(&image_id).await;
                if let Some(alias) = &alias {
                    self.db
                        .upsert_image_alias(alias, &built.blob.digest, now_i64())
                        .await
                        .map_err(|e| {
                            ImageError::Unavailable(format!("image alias failed: {e:#}"))
                        })?;
                }
                return self.descriptor_with_aliases(&existing, alias.clone()).await;
            }
        }

        let finished = self
            .db
            .finish_image(
                &image_id,
                &built.blob.digest,
                built.blob.size_bytes,
                now_i64(),
            )
            .await
            .map_err(|e| ImageError::Unavailable(format!("image publication failed: {e:#}")))?
            .ok_or_else(|| {
                ImageError::Unavailable(
                    "image build row disappeared before publication".to_string(),
                )
            })?;
        if let Some(alias) = &alias {
            self.db
                .upsert_image_alias(alias, &built.blob.digest, now_i64())
                .await
                .map_err(|e| ImageError::Unavailable(format!("image alias failed: {e:#}")))?;
        }
        self.descriptor_with_aliases(&finished, alias).await
    }

    pub async fn list(
        &self,
        offset: u32,
        limit: u32,
        query: &str,
    ) -> Result<ImageListPage, ImageError> {
        let limit = limit.clamp(1, IMAGE_LIST_MAX_LIMIT);
        let total = self
            .db
            .count_images(query)
            .await
            .map_err(|e| ImageError::Unavailable(format!("image list failed: {e:#}")))?;
        let rows = self
            .db
            .list_images_page(u64::from(offset), u64::from(limit), query)
            .await
            .map_err(|e| ImageError::Unavailable(format!("image list failed: {e:#}")))?;
        let aliases = self
            .db
            .list_image_aliases()
            .await
            .map_err(|e| ImageError::Unavailable(format!("image list failed: {e:#}")))?;
        let mut aliases_by_digest: HashMap<String, Vec<String>> = HashMap::new();
        for (alias, digest) in aliases {
            aliases_by_digest.entry(digest).or_default().push(alias);
        }
        let images = rows
            .iter()
            .map(|row| {
                let digest_aliases = row
                    .digest
                    .as_ref()
                    .and_then(|digest| aliases_by_digest.get(digest))
                    .cloned()
                    .unwrap_or_default();
                self.descriptor(row, None, digest_aliases)
            })
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let consumed = u32::try_from(images.len()).map_err(|_| {
            ImageError::Unavailable("image page is larger than the protocol offset".to_string())
        })?;
        let next_offset = if u64::from(offset) + u64::from(consumed) < total {
            Some(offset.saturating_add(consumed))
        } else {
            None
        };
        Ok(ImageListPage {
            images,
            total,
            next_offset,
        })
    }

    pub async fn get(
        &self,
        digest: Option<&str>,
        alias: Option<&str>,
    ) -> std::result::Result<ImageDescriptor, ImageError> {
        let (row, used_alias) = match (digest, alias) {
            (Some(digest), None) => {
                let digest = normalize_image_digest(digest)?;
                let row = self
                    .db
                    .get_image_by_digest(&digest)
                    .await
                    .map_err(|e| ImageError::Unavailable(format!("image read failed: {e:#}")))?
                    .ok_or_else(|| ImageError::NotFound("image not found".to_string()))?;
                (row, None)
            }
            (None, Some(alias)) => {
                let alias = normalize_alias(alias)?;
                let row = self
                    .db
                    .get_image_by_alias(&alias)
                    .await
                    .map_err(|e| ImageError::Unavailable(format!("image read failed: {e:#}")))?
                    .ok_or_else(|| ImageError::NotFound("image alias not found".to_string()))?;
                (row, Some(alias))
            }
            _ => {
                return Err(ImageError::Invalid(
                    "server.image.get requires exactly one of digest or alias".to_string(),
                ))
            }
        };
        self.descriptor_with_aliases(&row, used_alias).await
    }

    /// Mint a scoped read grant for one Project's referenced digest.
    pub async fn grant_access(
        &self,
        project_id: &str,
        digest: &str,
    ) -> std::result::Result<ImageAccessGrant, ImageError> {
        self.mint_access_grant(GrantConsumer::Project(project_id), digest, true, false)
            .await
    }

    /// Mint a scoped read grant for a Server-resolved Managed Session artifact
    /// (#3062).
    ///
    /// Managed creation is orchestrated by the Server: the Project pins the
    /// source image and the request pins the Base Runtime/toolchain artifacts,
    /// so the Server authorizes every one of them for the Session. This is
    /// deliberately separate from the client-facing `server.image.access`
    /// unit, which keeps the "Project references this digest" rule.
    pub async fn grant_managed_access(
        &self,
        project_id: &str,
        digest: &str,
    ) -> std::result::Result<ImageAccessGrant, ImageError> {
        self.mint_access_grant(GrantConsumer::Project(project_id), digest, false, false)
            .await
    }

    /// Mint a Session-scoped grant for a digest the Session's Managed context
    /// already resolved. Knowing a digest or another Session's identity is not
    /// authorization.
    pub async fn grant_session_access(
        &self,
        session_id: &str,
        digest: &str,
    ) -> std::result::Result<ImageAccessGrant, ImageError> {
        self.mint_access_grant(GrantConsumer::Session(session_id), digest, false, true)
            .await
    }

    /// Mint a Session-scoped grant for an explicit Sandbox composition image.
    ///
    /// The caller has already resolved the authenticated Session and Agent; the
    /// grant is still bound to one `(session_id, digest)` so a token cannot be
    /// replayed for another digest or claimed by another consumer.
    pub async fn grant_sandbox_access(
        &self,
        session_id: &str,
        digest: &str,
    ) -> std::result::Result<ImageAccessGrant, ImageError> {
        self.mint_access_grant(GrantConsumer::Session(session_id), digest, false, false)
            .await
    }

    async fn mint_access_grant(
        &self,
        consumer: GrantConsumer<'_>,
        digest: &str,
        require_project_reference: bool,
        require_session_membership: bool,
    ) -> std::result::Result<ImageAccessGrant, ImageError> {
        let (project_id, session_id) = match consumer {
            GrantConsumer::Project(project_id) => {
                if !is_valid_project_id(project_id) {
                    return Err(ImageError::Invalid(
                        "project_id is not a valid Project identity".to_string(),
                    ));
                }
                (Some(project_id.to_string()), None)
            }
            GrantConsumer::Session(session_id) => {
                if session_id.is_empty() {
                    return Err(ImageError::Invalid(
                        "session_id must not be empty".to_string(),
                    ));
                }
                (None, Some(session_id.to_string()))
            }
        };
        let digest = normalize_image_digest(digest)?;
        let row = self
            .db
            .get_image_by_digest(&digest)
            .await
            .map_err(|e| ImageError::Unavailable(format!("image read failed: {e:#}")))?
            .ok_or_else(|| ImageError::NotFound("image not found".to_string()))?;
        if row.status != ImageStatus::Ready.as_str() {
            return Err(ImageError::Forbidden(
                "image bytes are not ready".to_string(),
            ));
        }
        if require_project_reference {
            let Some(project_id) = project_id.as_deref() else {
                return Err(ImageError::Invalid(
                    "a Project reference requires project_id".to_string(),
                ));
            };
            let referenced = self
                .db
                .project_references_image(project_id, &digest)
                .await
                .map_err(|e| {
                    ImageError::Unavailable(format!("image authorization failed: {e:#}"))
                })?;
            if !referenced {
                return Err(ImageError::Forbidden(
                    "Project does not reference this image".to_string(),
                ));
            }
        }
        if require_session_membership {
            let Some(session_id) = session_id.as_deref() else {
                return Err(ImageError::Invalid(
                    "a Session reference requires session_id".to_string(),
                ));
            };
            let context = self
                .db
                .get_session_managed_context(session_id)
                .await
                .map_err(|e| ImageError::Unavailable(format!("image authorization failed: {e:#}")))?
                .filter(|context| context.status == "ready")
                .ok_or_else(|| {
                    ImageError::Forbidden("Session has no ready managed image context".to_string())
                })?;
            let allowed = std::iter::once(context.base_digest.as_str())
                .chain(std::iter::once(context.workspace_digest.as_str()))
                .chain(
                    context
                        .toolchains
                        .iter()
                        .map(|toolchain| toolchain.digest.as_str()),
                )
                .any(|allowed| allowed == digest);
            if !allowed {
                return Err(ImageError::Forbidden(
                    "Session does not reference this image".to_string(),
                ));
            }
        }
        let mut token = String::with_capacity(64);
        let mut bytes = [0_u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        for byte in bytes {
            token.push_str(&format!("{byte:02x}"));
        }
        let expires_at = now_secs().saturating_add(self.access_token_ttl_secs);
        let token_hash = sha256_hex(&token);
        self.db
            .insert_image_access_grant(&ImageGrantRow {
                token_hash,
                image_digest: digest.clone(),
                project_id,
                session_id,
                expires_at: expires_at as i64,
            })
            .await
            .map_err(|e| ImageError::Unavailable(format!("image grant failed: {e:#}")))?;
        let _ = self.db.delete_expired_image_access_grants(now_i64()).await;
        Ok(ImageAccessGrant {
            token,
            expires_at,
            path: format!("{IMAGE_BLOB_PATH_PREFIX}{digest}"),
        })
    }

    /// Authorize one bearer token for one digest.
    pub async fn authorize(
        &self,
        token: &str,
        digest: &str,
    ) -> std::result::Result<ImageGrantRow, ImageError> {
        if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(ImageError::Forbidden(
                "image access token is invalid or expired".to_string(),
            ));
        }
        let grant = self
            .db
            .get_image_access_grant(&sha256_hex(token))
            .await
            .map_err(|e| ImageError::Unavailable(format!("image authorization failed: {e:#}")))?
            .ok_or_else(|| {
                ImageError::Forbidden("image access token is invalid or expired".to_string())
            })?;
        if grant.expires_at <= now_secs() as i64 || grant.image_digest != digest {
            return Err(ImageError::Forbidden(
                "image access token is invalid or expired".to_string(),
            ));
        }
        Ok(grant)
    }

    /// Whether a digest is ready and its bytes verify.
    pub async fn ready_blob(&self, digest: &str) -> std::result::Result<u64, ImageError> {
        let digest = normalize_image_digest(digest)?;
        let row = self
            .db
            .get_image_by_digest(&digest)
            .await
            .map_err(|e| ImageError::Unavailable(format!("image read failed: {e:#}")))?
            .ok_or_else(|| ImageError::NotFound("image not found".to_string()))?;
        if row.status != ImageStatus::Ready.as_str() {
            return Err(ImageError::NotFound(
                "image bytes are not ready".to_string(),
            ));
        }
        self.blobs
            .verify(&digest)
            .map_err(|e| ImageError::Unavailable(format!("image bytes are not readable: {e:#}")))?;
        self.blobs
            .size(&digest)
            .map_err(|e| ImageError::Unavailable(format!("image bytes are not readable: {e:#}")))
    }

    pub fn open_blob(&self, digest: &str) -> Result<std::fs::File> {
        self.blobs.open(digest)
    }

    /// Hold an in-process transfer guard. GC skips a digest with a live guard.
    pub fn begin_transfer(&self, digest: &str) -> TransferGuard {
        if let Ok(mut transfers) = self.transfers.lock() {
            *transfers.entry(digest.to_string()).or_insert(0) += 1;
        }
        TransferGuard {
            digest: digest.to_string(),
            transfers: Arc::clone(&self.transfers),
        }
    }

    /// Remove unreferenced artifacts with the default per-sweep bounds.
    ///
    /// A failed or stale build row is removed; a ready row is removed only with
    /// its blob and only when no Project, alias, active lease or in-process
    /// transfer protects it.
    pub async fn gc(&self) -> Result<GcReport> {
        self.gc_bounded(GcLimits::default()).await
    }

    /// Remove at most `limits.max_candidates` candidates and at most
    /// `limits.max_deleted_bytes` of blob bytes in one sweep.
    ///
    /// The sweep owns no in-memory cursor: `deferred_by_limit` rows remain in
    /// the database and a follow-up call (or the next scheduled tick) selects
    /// them again. An interrupted sweep therefore resumes by re-querying, and a
    /// failed unlink leaves the row for the next attempt.
    pub async fn gc_bounded(&self, limits: GcLimits) -> Result<GcReport> {
        let now = now_i64();
        let _ = self.db.delete_expired_image_access_grants(now).await;
        let _ = self.db.delete_expired_image_leases(now).await;
        let candidates = self
            .db
            .gc_image_candidates(now, now.saturating_sub(3600))
            .await?;
        let mut report = GcReport {
            candidates: candidates.len() as u64,
            ..GcReport::default()
        };
        for (index, row) in candidates.into_iter().enumerate() {
            if index >= limits.max_candidates.max(1) {
                report.deferred_by_limit += 1;
                continue;
            }
            report.examined_images += 1;
            if let Some(digest) = &row.digest {
                let active = self
                    .transfers
                    .lock()
                    .map(|transfers| transfers.get(digest).copied().unwrap_or(0))
                    .unwrap_or(0);
                if active > 0 {
                    report.skipped_active_transfers += 1;
                    continue;
                }
                if self.blobs.contains(digest).unwrap_or(false) {
                    let size = self.blobs.size(digest).unwrap_or(0);
                    if report.reclaimed_bytes.saturating_add(size) > limits.max_deleted_bytes {
                        report.deferred_by_limit += 1;
                        continue;
                    }
                    if let Ok(path) = self.blobs.path_for(digest) {
                        if std::fs::remove_file(&path).is_ok() {
                            report.removed_blobs += 1;
                            report.reclaimed_bytes += size;
                        }
                    }
                }
            }
            if self.db.delete_image_row(&row.image_id).await? {
                report.removed_images += 1;
            }
        }
        Ok(report)
    }

    /// Measure persisted image metadata and blob usage (#3180 SC-05).
    pub async fn diagnostics(&self) -> Result<ImageStorageDiagnostics> {
        let counts = self.db.image_status_counts().await?;
        let usage = self.blobs.usage()?;
        Ok(ImageStorageDiagnostics {
            blob_dir: self.blobs.root().to_path_buf(),
            ready_images: counts.ready,
            failed_images: counts.failed,
            building_images: counts.building,
            blobs: usage.blobs,
            blob_bytes: usage.blob_bytes,
            temp_files: usage.temp_files,
            temp_bytes: usage.temp_bytes,
        })
    }

    pub fn blob_store(&self) -> &BlobStore {
        &self.blobs
    }

    fn descriptor(
        &self,
        row: &ImageRow,
        alias: Option<String>,
        aliases: Vec<String>,
    ) -> std::result::Result<ImageDescriptor, ImageError> {
        let source: ImageSource = serde_json::from_str(&row.source_json).map_err(|e| {
            ImageError::Unavailable(format!("stored image source is unreadable: {e}"))
        })?;
        let packaging: ImagePackaging = serde_json::from_str(&row.packaging_json).map_err(|e| {
            ImageError::Unavailable(format!("stored image packaging is unreadable: {e}"))
        })?;
        let status = ImageStatus::parse(&row.status).ok_or_else(|| {
            ImageError::Unavailable(format!("stored image status is unknown: {}", row.status))
        })?;
        Ok(ImageDescriptor {
            image_id: row.image_id.clone(),
            digest: row.digest.clone(),
            size_bytes: row.size_bytes,
            source,
            source_sha: row.source_sha.clone(),
            packaging,
            status,
            error: row.error.clone(),
            alias,
            aliases,
            created_at: u64::try_from(row.created_at).unwrap_or(0),
            updated_at: u64::try_from(row.updated_at).unwrap_or(0),
        })
    }

    /// Resolve a descriptor and the aliases that currently name its digest.
    async fn descriptor_with_aliases(
        &self,
        row: &ImageRow,
        alias: Option<String>,
    ) -> std::result::Result<ImageDescriptor, ImageError> {
        let aliases = match row.digest.as_ref() {
            Some(digest) => self
                .db
                .aliases_for_digest(digest)
                .await
                .map_err(|e| ImageError::Unavailable(format!("image read failed: {e:#}")))?,
            None => Vec::new(),
        };
        self.descriptor(row, alias, aliases)
    }
}

/// Decrements the active transfer count when dropped.
pub struct TransferGuard {
    digest: String,
    transfers: Arc<Mutex<HashMap<String, usize>>>,
}

impl Drop for TransferGuard {
    fn drop(&mut self) {
        if let Ok(mut transfers) = self.transfers.lock() {
            if let Some(count) = transfers.get_mut(&self.digest) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    transfers.remove(&self.digest);
                }
            }
        }
    }
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn now_i64() -> i64 {
    i64::try_from(now_secs()).unwrap_or(i64::MAX)
}

fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn bounded_error(value: &str) -> String {
    value.chars().take(1024).collect()
}

/// The default blob root below a Server component directory.
pub fn default_blob_root(base: &std::path::Path) -> std::path::PathBuf {
    base.join("images").join("blobs")
}

/// The default build workspace below a Server component directory.
pub fn default_build_root(base: &std::path::Path) -> std::path::PathBuf {
    base.join("images").join("build")
}

/// Record a lease for an active Session/transfer. The caller owns release.
pub fn lease_row(digest: &str, project_id: &str, lease_id: &str, expires_at: i64) -> ImageLeaseRow {
    ImageLeaseRow {
        lease_id: lease_id.to_string(),
        image_digest: digest.to_string(),
        project_id: project_id.to_string(),
        expires_at,
    }
}

/// Whether a string is a valid image digest. Re-exported for HTTP route parsing.
pub fn valid_digest(value: &str) -> bool {
    is_valid_image_digest(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::Mutex;

    use nession_protocol::contracts::image::v1::{
        ImageSource, NormalizedImageSource, IMAGE_BLOB_PATH_PREFIX,
    };

    struct FakeBackend {
        blobs: BlobStore,
        content: Mutex<HashMap<String, Vec<u8>>>,
        fail_next: Mutex<Option<String>>,
    }

    impl FakeBackend {
        fn new(blobs: BlobStore) -> Self {
            Self {
                blobs,
                content: Mutex::new(HashMap::new()),
                fail_next: Mutex::new(None),
            }
        }

        fn set(&self, key: &str, bytes: &[u8]) {
            self.content
                .lock()
                .unwrap()
                .insert(key.to_string(), bytes.to_vec());
        }

        fn fail_next(&self, message: &str) {
            *self.fail_next.lock().unwrap() = Some(message.to_string());
        }
    }

    fn key_for(source: &NormalizedImageSource) -> String {
        match source {
            NormalizedImageSource::GitHub {
                repository_url,
                reference,
                ..
            } => format!("{repository_url}#{reference}"),
            NormalizedImageSource::LocalDirectory { path } => path.clone(),
        }
    }

    impl ImageBuildBackend for FakeBackend {
        fn build(
            &self,
            source: &NormalizedImageSource,
            _packaging: &ImagePackaging,
        ) -> Result<BuiltImage> {
            if let Some(message) = self.fail_next.lock().unwrap().take() {
                anyhow::bail!("{message}");
            }
            let key = key_for(source);
            let bytes = self
                .content
                .lock()
                .unwrap()
                .get(&key)
                .cloned()
                .unwrap_or_else(|| key.into_bytes());
            let mut file = tempfile::NamedTempFile::new()?;
            file.write_all(&bytes)?;
            let blob = self.blobs.put_file(file.path())?;
            Ok(BuiltImage {
                blob,
                source_sha: match source {
                    NormalizedImageSource::GitHub { requested_sha, .. } => requested_sha.clone(),
                    NormalizedImageSource::LocalDirectory { .. } => None,
                },
                packaging: ImagePackaging::default(),
            })
        }
    }

    async fn manager(
        dir: &std::path::Path,
    ) -> (Arc<ImageManager>, Arc<FakeBackend>, Arc<Database>) {
        let db = Arc::new(Database::new(":memory:").await.unwrap());
        let blobs = BlobStore::new(dir.join("blobs")).unwrap();
        let backend = Arc::new(FakeBackend::new(blobs.clone()));
        let manager = Arc::new(ImageManager::new(
            Arc::clone(&db),
            backend.clone(),
            blobs,
            2,
            60,
        ));
        (manager, backend, db)
    }

    fn local(path: &str) -> ImageSource {
        ImageSource::LocalDirectory {
            path: path.to_string(),
        }
    }

    fn project(_db: &Database, id: &str, digest: Option<&str>) -> crate::db::ProjectRow {
        crate::db::ProjectRow {
            project_id: id.to_string(),
            name: "Fixture".to_string(),
            description: None,
            source: None,
            locations: Vec::new(),
            session_defaults: None,
            image_digest: digest.map(str::to_string),
            created_at: 1,
            updated_at: 1,
        }
    }

    #[tokio::test]
    async fn identical_content_reuses_one_ready_image_and_one_blob() {
        let dir = tempfile::tempdir().unwrap();
        let (manager, backend, _db) = manager(dir.path()).await;
        backend.set("/source/a", b"same bytes");
        let first = manager
            .build(&local("/source/a"), Some("latest"))
            .await
            .unwrap();
        let second = manager
            .build(&local("/source/a"), Some("latest"))
            .await
            .unwrap();
        assert_eq!(first.digest, second.digest);
        assert_eq!(first.status, ImageStatus::Ready);
        let images = manager.list(0, 10, "").await.unwrap().images;
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].digest, first.digest);
        assert_eq!(images[0].alias, None);
        assert_eq!(
            std::fs::read_dir(dir.path().join("blobs/sha256"))
                .unwrap()
                .count(),
            1
        );
        let by_alias = manager.get(None, Some("latest")).await.unwrap();
        assert_eq!(by_alias.digest, first.digest);
    }

    #[tokio::test]
    async fn a_complete_inventory_pages_past_two_hundred_and_reports_aliases() {
        let dir = tempfile::tempdir().unwrap();
        let (manager, _backend, db) = manager(dir.path()).await;
        let packaging = serde_json::to_string(&ImagePackaging::default()).unwrap();
        let source = serde_json::to_string(&local("/source/page")).unwrap();
        for index in 0..235_u64 {
            let digest = format!("sha256:{index:064x}");
            let image_id = format!("image-page-{index}");
            db.insert_image(&crate::db::ImageRow {
                image_id: image_id.clone(),
                digest: Some(digest.clone()),
                size_bytes: 1,
                source_json: source.clone(),
                source_sha: None,
                packaging_json: packaging.clone(),
                status: ImageStatus::Ready.as_str().to_string(),
                error: None,
                created_at: index as i64,
                updated_at: index as i64,
            })
            .await
            .unwrap();
            if index == 0 {
                db.upsert_image_alias("paged-latest", &digest, 1)
                    .await
                    .unwrap();
            }
        }

        let first = manager.list(0, 200, "").await.unwrap();
        assert_eq!(first.total, 235);
        assert_eq!(first.images.len(), 200);
        assert_eq!(first.next_offset, Some(200));
        assert_eq!(first.images[0].image_id, "image-page-234");
        assert_eq!(first.images[0].aliases, Vec::<String>::new());

        let second = manager.list(200, 200, "").await.unwrap();
        assert_eq!(second.total, 235);
        assert_eq!(second.images.len(), 35);
        assert_eq!(second.next_offset, None);
        let aliased = second
            .images
            .iter()
            .find(|image| image.image_id == "image-page-0")
            .expect("aliased image is on the second page");
        assert_eq!(aliased.aliases, vec!["paged-latest".to_string()]);

        let past_end = manager.list(400, 50, "").await.unwrap();
        assert_eq!(past_end.total, 235);
        assert!(past_end.images.is_empty());
        assert_eq!(past_end.next_offset, None);

        let by_alias = manager.list(0, 50, "paged-latest").await.unwrap();
        assert_eq!(by_alias.total, 1);
        assert_eq!(by_alias.images[0].image_id, "image-page-0");
        let by_source = manager.list(0, 50, "source/page").await.unwrap();
        assert_eq!(by_source.total, 235);
        let no_match = manager.list(0, 50, "does-not-exist").await.unwrap();
        assert_eq!(no_match.total, 0);
        assert!(no_match.images.is_empty());
    }

    #[tokio::test]
    async fn a_new_revision_changes_the_alias_without_overwriting_the_old_digest() {
        let dir = tempfile::tempdir().unwrap();
        let (manager, backend, _db) = manager(dir.path()).await;
        backend.set("/source/a", b"revision one");
        backend.set("/source/b", b"revision two");
        let first = manager
            .build(&local("/source/a"), Some("latest"))
            .await
            .unwrap();
        let second = manager
            .build(&local("/source/b"), Some("latest"))
            .await
            .unwrap();
        assert_ne!(first.digest, second.digest);
        let alias = manager.get(None, Some("latest")).await.unwrap();
        assert_eq!(alias.digest, second.digest);
        let old = manager.get(first.digest.as_deref(), None).await.unwrap();
        assert_eq!(old.digest, first.digest);
        assert_eq!(old.alias, None);
    }

    #[tokio::test]
    async fn a_failed_build_is_recoverable_and_never_offers_partial_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let (manager, backend, _db) = manager(dir.path()).await;
        backend.fail_next("network unavailable");
        let error = manager
            .build(&local("/source/fail"), None)
            .await
            .unwrap_err();
        assert_eq!(error.kind(), "build_failed");
        let images = manager.list(0, 10, "").await.unwrap().images;
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].status, ImageStatus::Failed);
        assert_eq!(images[0].digest, None);
        assert!(images[0]
            .error
            .as_deref()
            .unwrap()
            .contains("network unavailable"));
        assert!(!dir
            .path()
            .join("blobs/sha256")
            .read_dir()
            .map(|mut d| d.next().is_some())
            .unwrap_or(false));
    }

    #[tokio::test]
    async fn a_session_grant_is_bounded_by_its_managed_context_and_digest() {
        let dir = tempfile::tempdir().unwrap();
        let (manager, backend, db) = manager(dir.path()).await;
        backend.set("/source/base", b"base image");
        backend.set("/source/tool", b"tool image");
        backend.set("/source/other", b"other image");
        let base = manager.build(&local("/source/base"), None).await.unwrap();
        let tool = manager.build(&local("/source/tool"), None).await.unwrap();
        let other = manager.build(&local("/source/other"), None).await.unwrap();
        let base_digest = base.digest.clone().unwrap();
        let tool_digest = tool.digest.clone().unwrap();
        let other_digest = other.digest.clone().unwrap();
        db.begin_session_managed_context(&crate::db::SessionManagedContextRow {
            session_id: "a1:s1".to_string(),
            agent_id: "a1".to_string(),
            project_id: "project-00000000-0000-0000-0000-000000000001".to_string(),
            attempt_id: "attempt-1".to_string(),
            base_digest: base_digest.clone(),
            workspace_digest: base_digest.clone(),
            toolchains: vec![
                nession_protocol::contracts::session::v1::ManagedToolchainRequest {
                    digest: tool_digest.clone(),
                    target: "/opt/tool".to_string(),
                },
            ],
            source_sha: None,
            workspace: None,
            status: "ready".to_string(),
            error: None,
            updated_at: now_i64(),
        })
        .await
        .unwrap();

        let base_grant = manager
            .grant_session_access("a1:s1", &base_digest)
            .await
            .unwrap();
        manager
            .authorize(&base_grant.token, &base_digest)
            .await
            .unwrap();
        assert!(manager
            .grant_session_access("a1:s1", &other_digest)
            .await
            .is_err());
        assert!(manager
            .grant_session_access("a1:other", &base_digest)
            .await
            .is_err());
        manager
            .grant_session_access("a1:s1", &tool_digest)
            .await
            .unwrap();

        // The internal Sandbox path authorizes an explicit selection for an
        // existing Session even before a Managed context references it.
        let sandbox_grant = manager
            .grant_sandbox_access("a1:s1", &other_digest)
            .await
            .unwrap();
        manager
            .authorize(&sandbox_grant.token, &other_digest)
            .await
            .unwrap();
        let stored = db
            .get_image_access_grant(&sha256_hex(&sandbox_grant.token))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.project_id, None);
        assert_eq!(stored.session_id.as_deref(), Some("a1:s1"));
    }

    #[tokio::test]
    async fn a_grant_is_bound_to_its_project_and_digest() {
        let dir = tempfile::tempdir().unwrap();
        let (manager, backend, db) = manager(dir.path()).await;
        backend.set("/source/a", b"project a image");
        backend.set("/source/b", b"project b image");
        let a = manager.build(&local("/source/a"), None).await.unwrap();
        let b = manager.build(&local("/source/b"), None).await.unwrap();
        db.insert_project(&project(
            &db,
            "project-00000000-0000-0000-0000-000000000001",
            a.digest.as_deref(),
        ))
        .await
        .unwrap();
        db.insert_project(&project(
            &db,
            "project-00000000-0000-0000-0000-000000000002",
            b.digest.as_deref(),
        ))
        .await
        .unwrap();
        let grant_a = manager
            .grant_access(
                "project-00000000-0000-0000-0000-000000000001",
                a.digest.as_deref().unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            grant_a.path,
            format!("{IMAGE_BLOB_PATH_PREFIX}{}", a.digest.as_deref().unwrap())
        );
        manager
            .authorize(&grant_a.token, a.digest.as_deref().unwrap())
            .await
            .unwrap();
        assert!(manager
            .authorize(&grant_a.token, b.digest.as_deref().unwrap())
            .await
            .is_err());
        assert!(manager
            .grant_access(
                "project-00000000-0000-0000-0000-000000000002",
                a.digest.as_deref().unwrap()
            )
            .await
            .is_err());
        assert!(manager
            .authorize("not-a-token", a.digest.as_deref().unwrap())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn gc_keeps_referenced_leased_and_transferring_images() {
        let dir = tempfile::tempdir().unwrap();
        let (manager, backend, db) = manager(dir.path()).await;
        backend.set("/source/ref", b"referenced");
        backend.set("/source/lease", b"leased");
        backend.set("/source/free", b"free");
        backend.set("/source/transfer", b"transferring");
        let referenced = manager.build(&local("/source/ref"), None).await.unwrap();
        let leased = manager.build(&local("/source/lease"), None).await.unwrap();
        let free = manager.build(&local("/source/free"), None).await.unwrap();
        let transferring = manager
            .build(&local("/source/transfer"), None)
            .await
            .unwrap();
        db.insert_project(&project(
            &db,
            "project-00000000-0000-0000-0000-000000000011",
            referenced.digest.as_deref(),
        ))
        .await
        .unwrap();
        db.insert_image_lease(&lease_row(
            leased.digest.as_deref().unwrap(),
            "project-00000000-0000-0000-0000-000000000012",
            "lease-1",
            now_i64() + 600,
        ))
        .await
        .unwrap();
        let guard = manager.begin_transfer(transferring.digest.as_deref().unwrap());
        let report = manager.gc().await.unwrap();
        assert_eq!(report.removed_images, 1);
        assert_eq!(report.removed_blobs, 1);
        assert_eq!(report.skipped_active_transfers, 1);
        assert!(manager
            .get(referenced.digest.as_deref(), None)
            .await
            .is_ok());
        assert!(manager.get(leased.digest.as_deref(), None).await.is_ok());
        assert!(manager
            .get(transferring.digest.as_deref(), None)
            .await
            .is_ok());
        assert!(manager.get(free.digest.as_deref(), None).await.is_err());
        drop(guard);
        let report = manager.gc().await.unwrap();
        assert_eq!(report.removed_images, 1);
    }

    /// #3180 SC-02: one sweep deletes at most the configured candidate count;
    /// the deferred candidates stay in the database and a follow-up sweep
    /// resumes them. The report is the observable result of the operation.
    #[tokio::test]
    async fn a_bounded_gc_defers_work_and_a_follow_up_sweep_resumes() {
        let dir = tempfile::tempdir().unwrap();
        let (manager, backend, _db) = manager(dir.path()).await;
        for name in ["a", "b", "c"] {
            backend.set(&format!("/source/{name}"), name.as_bytes());
            manager
                .build(&local(&format!("/source/{name}")), None)
                .await
                .unwrap();
        }
        let first = manager
            .gc_bounded(GcLimits {
                max_candidates: 1,
                max_deleted_bytes: u64::MAX,
            })
            .await
            .unwrap();
        assert_eq!(first.candidates, 3);
        assert_eq!(first.examined_images, 1);
        assert_eq!(first.removed_images, 1);
        assert_eq!(first.removed_blobs, 1);
        assert_eq!(first.reclaimed_bytes, 1);
        assert_eq!(first.deferred_by_limit, 2);
        assert_eq!(manager.list(0, 10, "").await.unwrap().images.len(), 2);

        // The next sweep re-selects the deferred rows from the database.
        let second = manager
            .gc_bounded(GcLimits {
                max_candidates: 10,
                max_deleted_bytes: u64::MAX,
            })
            .await
            .unwrap();
        assert_eq!(second.candidates, 2);
        assert_eq!(second.removed_images, 2);
        assert_eq!(second.deferred_by_limit, 0);
        assert!(manager.list(0, 10, "").await.unwrap().images.is_empty());
    }

    /// #3180 SC-02: a byte budget leaves a ready row and its bytes untouched
    /// for a later sweep instead of deleting the row while keeping the blob.
    #[tokio::test]
    async fn a_byte_budget_defers_a_ready_image_instead_of_leaking_its_blob() {
        let dir = tempfile::tempdir().unwrap();
        let (manager, backend, _db) = manager(dir.path()).await;
        backend.set("/source/bound", b"eightbyte");
        let image = manager.build(&local("/source/bound"), None).await.unwrap();
        let digest = image.digest.as_deref().unwrap();
        let report = manager
            .gc_bounded(GcLimits {
                max_candidates: 10,
                max_deleted_bytes: 0,
            })
            .await
            .unwrap();
        assert_eq!(report.removed_images, 0);
        assert_eq!(report.removed_blobs, 0);
        assert_eq!(report.deferred_by_limit, 1);
        assert!(manager.get(Some(digest), None).await.is_ok());
        assert!(manager.blob_store().contains(digest).unwrap());

        let resumed = manager
            .gc_bounded(GcLimits {
                max_candidates: 10,
                max_deleted_bytes: u64::MAX,
            })
            .await
            .unwrap();
        assert_eq!(resumed.removed_images, 1);
        assert_eq!(resumed.reclaimed_bytes, b"eightbyte".len() as u64);
        assert!(manager.get(Some(digest), None).await.is_err());
    }

    /// #3180 SC-05: diagnostics distinguish ready image bytes, failed rows and
    /// unpublished temporary files, and count them within the same manager
    /// that owns the registry.
    #[tokio::test]
    async fn diagnostics_separate_ready_bytes_failed_rows_and_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let (manager, backend, _db) = manager(dir.path()).await;
        backend.set("/source/ready", b"ready-bytes");
        manager.build(&local("/source/ready"), None).await.unwrap();
        backend.fail_next("fixture failure");
        manager
            .build(&local("/source/failed"), None)
            .await
            .unwrap_err();
        std::fs::write(
            dir.path().join("blobs/.tmp/interrupted.part"),
            b"unpublished",
        )
        .unwrap();

        let diagnostics = manager.diagnostics().await.unwrap();
        assert_eq!(diagnostics.ready_images, 1);
        assert_eq!(diagnostics.failed_images, 1);
        assert_eq!(diagnostics.building_images, 0);
        assert_eq!(diagnostics.blobs, 1);
        assert_eq!(diagnostics.blob_bytes, b"ready-bytes".len() as u64);
        assert_eq!(diagnostics.temp_files, 1);
        assert_eq!(diagnostics.temp_bytes, b"unpublished".len() as u64);
    }

    async fn http_request(
        manager: &Arc<ImageManager>,
        method: &str,
        target: &str,
        headers: Vec<(&str, &str)>,
    ) -> String {
        use tokio::io::AsyncReadExt;
        let (mut client, server) = tokio::io::duplex(64 * 1024);
        let head = nession_mcp::http::RequestHead {
            method: method.to_string(),
            target: target.to_string(),
            version: "HTTP/1.1".to_string(),
            headers: headers
                .into_iter()
                .map(|(name, value)| (name.to_ascii_lowercase(), value.to_string()))
                .collect(),
        };
        let service = crate::image::http::ImageHttpService::new(Arc::clone(manager));
        let task = tokio::spawn(async move {
            service
                .serve(
                    head,
                    nession_mcp::http::PrefixedStream::new(Vec::new(), server),
                )
                .await
        });
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        task.await.unwrap().unwrap();
        String::from_utf8_lossy(&response).into_owned()
    }

    fn split_response(response: &str) -> (String, Vec<u8>) {
        let Some((head, body)) = response.split_once("\r\n\r\n") else {
            return (response.to_string(), Vec::new());
        };
        (head.to_string(), body.as_bytes().to_vec())
    }

    #[tokio::test]
    async fn http_range_etag_and_authorization_are_exact() {
        let dir = tempfile::tempdir().unwrap();
        let (manager, backend, db) = manager(dir.path()).await;
        let bytes = b"0123456789ab";
        backend.set("/source/http", bytes);
        let image = manager.build(&local("/source/http"), None).await.unwrap();
        let digest = image.digest.clone().unwrap();
        db.insert_project(&project(
            &db,
            "project-00000000-0000-0000-0000-000000000021",
            Some(&digest),
        ))
        .await
        .unwrap();
        let grant = manager
            .grant_access("project-00000000-0000-0000-0000-000000000021", &digest)
            .await
            .unwrap();
        let target = format!("{IMAGE_BLOB_PATH_PREFIX}{digest}");
        let auth = format!("Bearer {}", grant.token);
        let response = http_request(
            &manager,
            "GET",
            &target,
            vec![("Authorization", auth.as_str()), ("Range", "bytes=2-5")],
        )
        .await;
        let (head, body) = split_response(&response);
        assert!(head.starts_with("HTTP/1.1 206 Partial Content"), "{head}");
        assert!(head.contains("Content-Range: bytes 2-5/12"), "{head}");
        assert!(head.contains(&format!("ETag: \"{digest}\"")), "{head}");
        assert_eq!(body, b"2345");

        let response = http_request(
            &manager,
            "GET",
            &target,
            vec![("Authorization", auth.as_str())],
        )
        .await;
        let (head, body) = split_response(&response);
        assert!(head.starts_with("HTTP/1.1 200 OK"), "{head}");
        assert!(
            head.contains(&format!("X-Nession-Image-Digest: {digest}")),
            "{head}"
        );
        assert_eq!(body, bytes);

        let response = http_request(
            &manager,
            "HEAD",
            &target,
            vec![("Authorization", auth.as_str())],
        )
        .await;
        let (head, body) = split_response(&response);
        assert!(head.starts_with("HTTP/1.1 200 OK"), "{head}");
        assert!(body.is_empty());
    }

    #[tokio::test]
    async fn http_denies_foreign_projects_and_unknown_digests() {
        let dir = tempfile::tempdir().unwrap();
        let (manager, backend, db) = manager(dir.path()).await;
        backend.set("/source/a", b"project a");
        backend.set("/source/b", b"project b");
        let a = manager.build(&local("/source/a"), None).await.unwrap();
        let b = manager.build(&local("/source/b"), None).await.unwrap();
        let digest_a = a.digest.clone().unwrap();
        let digest_b = b.digest.clone().unwrap();
        db.insert_project(&project(
            &db,
            "project-00000000-0000-0000-0000-000000000031",
            Some(&digest_a),
        ))
        .await
        .unwrap();
        db.insert_project(&project(
            &db,
            "project-00000000-0000-0000-0000-000000000032",
            Some(&digest_b),
        ))
        .await
        .unwrap();
        let grant_a = manager
            .grant_access("project-00000000-0000-0000-0000-000000000031", &digest_a)
            .await
            .unwrap();
        let target_b = format!("{IMAGE_BLOB_PATH_PREFIX}{digest_b}");
        let auth = format!("Bearer {}", grant_a.token);
        let response = http_request(
            &manager,
            "GET",
            &target_b,
            vec![("Authorization", auth.as_str())],
        )
        .await;
        assert!(split_response(&response)
            .0
            .starts_with("HTTP/1.1 403 Forbidden"));
        let target_a = format!("{IMAGE_BLOB_PATH_PREFIX}{digest_a}");
        let response = http_request(&manager, "GET", &target_a, vec![]).await;
        assert!(split_response(&response)
            .0
            .starts_with("HTTP/1.1 403 Forbidden"));
        let unknown = format!("{IMAGE_BLOB_PATH_PREFIX}sha256:{}", "e".repeat(64));
        let response = http_request(
            &manager,
            "GET",
            &unknown,
            vec![("Authorization", auth.as_str())],
        )
        .await;
        assert!(split_response(&response)
            .0
            .starts_with("HTTP/1.1 404 Not Found"));
    }

    #[tokio::test]
    async fn http_invalid_range_is_416_with_the_entity_size() {
        let dir = tempfile::tempdir().unwrap();
        let (manager, backend, db) = manager(dir.path()).await;
        backend.set("/source/a", b"0123456789ab");
        let image = manager.build(&local("/source/a"), None).await.unwrap();
        let digest = image.digest.clone().unwrap();
        db.insert_project(&project(
            &db,
            "project-00000000-0000-0000-0000-000000000041",
            Some(&digest),
        ))
        .await
        .unwrap();
        let grant = manager
            .grant_access("project-00000000-0000-0000-0000-000000000041", &digest)
            .await
            .unwrap();
        let target = format!("{IMAGE_BLOB_PATH_PREFIX}{digest}");
        let auth = format!("Bearer {}", grant.token);
        let response = http_request(
            &manager,
            "GET",
            &target,
            vec![("Authorization", auth.as_str()), ("Range", "bytes=99-100")],
        )
        .await;
        let (head, _) = split_response(&response);
        assert!(
            head.starts_with("HTTP/1.1 416 Range Not Satisfiable"),
            "{head}"
        );
        assert!(head.contains("Content-Range: bytes */12"), "{head}");
    }

    #[tokio::test]
    async fn restart_preserves_image_metadata_and_project_references() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("server.db");
        let blobs = BlobStore::new(dir.path().join("blobs")).unwrap();
        let backend = Arc::new(FakeBackend::new(blobs.clone()));
        backend.set("/source/persist", b"persistent image");
        let digest = {
            let db = Arc::new(Database::new(db_path.to_str().unwrap()).await.unwrap());
            let manager = ImageManager::new(Arc::clone(&db), backend.clone(), blobs.clone(), 1, 60);
            let image = manager
                .build(&local("/source/persist"), None)
                .await
                .unwrap();
            db.insert_project(&project(
                &db,
                "project-00000000-0000-0000-0000-000000000013",
                image.digest.as_deref(),
            ))
            .await
            .unwrap();
            image.digest.unwrap()
        };
        let db = Arc::new(Database::new(db_path.to_str().unwrap()).await.unwrap());
        let manager = ImageManager::new(Arc::clone(&db), backend, blobs, 1, 60);
        let image = manager.get(Some(&digest), None).await.unwrap();
        assert_eq!(image.digest.as_deref(), Some(digest.as_str()));
        assert!(db
            .project_references_image("project-00000000-0000-0000-0000-000000000013", &digest)
            .await
            .unwrap());
    }
}
