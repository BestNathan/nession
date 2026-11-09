//! Image Manager persistence (#3022).
//!
//! One row per build attempt; a ready row owns an immutable digest. Project
//! references are read from `projects` — the Project remains the owner of its
//! declaration — rather than copied into a second table.

use super::Database;
use crate::db::entities::{image_access_grants, image_aliases, image_leases, images, projects};
use anyhow::{Context, Result};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, Set,
};

/// One image build attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageRow {
    pub image_id: String,
    pub digest: Option<String>,
    pub size_bytes: u64,
    pub source_json: String,
    pub source_sha: Option<String>,
    pub packaging_json: String,
    pub status: String,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A scoped bearer grant for one digest and Project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageGrantRow {
    pub token_hash: String,
    pub image_digest: String,
    pub project_id: String,
    pub expires_at: i64,
}

/// One active image lease held by a Session/transfer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageLeaseRow {
    pub lease_id: String,
    pub image_digest: String,
    pub project_id: String,
    pub expires_at: i64,
}

fn row_from_model(model: images::Model) -> ImageRow {
    ImageRow {
        image_id: model.image_id,
        digest: model.digest,
        size_bytes: u64::try_from(model.size_bytes).unwrap_or(0),
        source_json: model.source_json,
        source_sha: model.source_sha,
        packaging_json: model.packaging_json,
        status: model.status,
        error: model.error,
        created_at: model.created_at,
        updated_at: model.updated_at,
    }
}

impl Database {
    /// Insert a new build attempt. A duplicate `image_id` is an error.
    pub async fn insert_image(&self, row: &ImageRow) -> Result<()> {
        images::Entity::insert(images::ActiveModel {
            image_id: Set(row.image_id.clone()),
            digest: Set(row.digest.clone()),
            size_bytes: Set(i64::try_from(row.size_bytes).unwrap_or(i64::MAX)),
            source_json: Set(row.source_json.clone()),
            source_sha: Set(row.source_sha.clone()),
            packaging_json: Set(row.packaging_json.clone()),
            status: Set(row.status.clone()),
            error: Set(row.error.clone()),
            created_at: Set(row.created_at),
            updated_at: Set(row.updated_at),
        })
        .exec(&self.conn)
        .await
        .context("failed to insert image")?;
        Ok(())
    }

    /// Mark a building attempt ready with its verified digest and size.
    pub async fn finish_image(
        &self,
        image_id: &str,
        digest: &str,
        size_bytes: u64,
        updated_at: i64,
    ) -> Result<Option<ImageRow>> {
        let Some(existing) = images::Entity::find_by_id(image_id.to_owned())
            .one(&self.conn)
            .await
            .context("failed to load image for finish")?
        else {
            return Ok(None);
        };
        let mut model: images::ActiveModel = existing.into();
        model.digest = Set(Some(digest.to_string()));
        model.size_bytes = Set(i64::try_from(size_bytes).unwrap_or(i64::MAX));
        model.status = Set("ready".to_string());
        model.error = Set(None);
        model.updated_at = Set(updated_at);
        let updated = model
            .update(&self.conn)
            .await
            .context("failed to finish image")?;
        Ok(Some(row_from_model(updated)))
    }

    /// Mark a building attempt failed; the error is part of the recoverable
    /// state and never offered as ready bytes.
    pub async fn fail_image(&self, image_id: &str, error: &str, updated_at: i64) -> Result<()> {
        let Some(existing) = images::Entity::find_by_id(image_id.to_owned())
            .one(&self.conn)
            .await
            .context("failed to load image for failure")?
        else {
            return Ok(());
        };
        let mut model: images::ActiveModel = existing.into();
        model.digest = Set(None);
        model.status = Set("failed".to_string());
        model.error = Set(Some(error.to_string()));
        model.updated_at = Set(updated_at);
        model
            .update(&self.conn)
            .await
            .context("failed to record image failure")?;
        Ok(())
    }

    pub async fn get_image_by_id(&self, image_id: &str) -> Result<Option<ImageRow>> {
        let row = images::Entity::find_by_id(image_id.to_owned())
            .one(&self.conn)
            .await
            .context("failed to read image")?;
        Ok(row.map(row_from_model))
    }

    pub async fn get_image_by_digest(&self, digest: &str) -> Result<Option<ImageRow>> {
        let row = images::Entity::find()
            .filter(images::Column::Digest.eq(digest))
            .one(&self.conn)
            .await
            .context("failed to read image by digest")?;
        Ok(row.map(row_from_model))
    }

    pub async fn get_image_by_alias(&self, alias: &str) -> Result<Option<ImageRow>> {
        let Some(link) = image_aliases::Entity::find_by_id(alias.to_owned())
            .one(&self.conn)
            .await
            .context("failed to read image alias")?
        else {
            return Ok(None);
        };
        self.get_image_by_digest(&link.image_digest).await
    }

    pub async fn list_images(&self, limit: u64) -> Result<Vec<ImageRow>> {
        let rows = images::Entity::find()
            .order_by_desc(images::Column::CreatedAt)
            .order_by_asc(images::Column::ImageId)
            .limit(limit)
            .all(&self.conn)
            .await
            .context("failed to list images")?;
        Ok(rows.into_iter().map(row_from_model).collect())
    }

    /// Point an alias at an immutable digest. A different revision changes the
    /// tag only; existing Project references and leases keep their digest.
    pub async fn upsert_image_alias(&self, alias: &str, digest: &str, now: i64) -> Result<()> {
        let existing = image_aliases::Entity::find_by_id(alias.to_owned())
            .one(&self.conn)
            .await
            .context("failed to load image alias")?;
        if let Some(existing) = existing {
            if existing.image_digest == digest {
                return Ok(());
            }
            let mut model: image_aliases::ActiveModel = existing.into();
            model.image_digest = Set(digest.to_string());
            model.updated_at = Set(now);
            model
                .update(&self.conn)
                .await
                .context("failed to update image alias")?;
        } else {
            image_aliases::Entity::insert(image_aliases::ActiveModel {
                alias: Set(alias.to_string()),
                image_digest: Set(digest.to_string()),
                created_at: Set(now),
                updated_at: Set(now),
            })
            .exec(&self.conn)
            .await
            .context("failed to insert image alias")?;
        }
        Ok(())
    }

    /// Whether a Project durably references this digest.
    pub async fn project_references_image(&self, project_id: &str, digest: &str) -> Result<bool> {
        let count = projects::Entity::find()
            .filter(projects::Column::ProjectId.eq(project_id))
            .filter(projects::Column::ImageDigest.eq(digest))
            .count(&self.conn)
            .await
            .context("failed to check Project image reference")?;
        Ok(count > 0)
    }

    /// Whether any Project durably references this digest.
    pub async fn any_project_references_image(&self, digest: &str) -> Result<bool> {
        let count = projects::Entity::find()
            .filter(projects::Column::ImageDigest.eq(digest))
            .count(&self.conn)
            .await
            .context("failed to count Project image references")?;
        Ok(count > 0)
    }

    pub async fn insert_image_access_grant(&self, grant: &ImageGrantRow) -> Result<()> {
        image_access_grants::Entity::insert(image_access_grants::ActiveModel {
            token_hash: Set(grant.token_hash.clone()),
            image_digest: Set(grant.image_digest.clone()),
            project_id: Set(grant.project_id.clone()),
            expires_at: Set(grant.expires_at),
        })
        .exec(&self.conn)
        .await
        .context("failed to insert image access grant")?;
        Ok(())
    }

    pub async fn get_image_access_grant(&self, token_hash: &str) -> Result<Option<ImageGrantRow>> {
        let row = image_access_grants::Entity::find_by_id(token_hash.to_owned())
            .one(&self.conn)
            .await
            .context("failed to read image access grant")?;
        Ok(row.map(|model| ImageGrantRow {
            token_hash: model.token_hash,
            image_digest: model.image_digest,
            project_id: model.project_id,
            expires_at: model.expires_at,
        }))
    }

    pub async fn delete_expired_image_access_grants(&self, now: i64) -> Result<u64> {
        let result = image_access_grants::Entity::delete_many()
            .filter(image_access_grants::Column::ExpiresAt.lte(now))
            .exec(&self.conn)
            .await
            .context("failed to prune image access grants")?;
        Ok(result.rows_affected)
    }

    pub async fn insert_image_lease(&self, lease: &ImageLeaseRow) -> Result<()> {
        image_leases::Entity::insert(image_leases::ActiveModel {
            lease_id: Set(lease.lease_id.clone()),
            image_digest: Set(lease.image_digest.clone()),
            project_id: Set(lease.project_id.clone()),
            expires_at: Set(lease.expires_at),
        })
        .exec(&self.conn)
        .await
        .context("failed to insert image lease")?;
        Ok(())
    }

    pub async fn delete_expired_image_leases(&self, now: i64) -> Result<u64> {
        let result = image_leases::Entity::delete_many()
            .filter(image_leases::Column::ExpiresAt.lte(now))
            .exec(&self.conn)
            .await
            .context("failed to prune image leases")?;
        Ok(result.rows_affected)
    }

    pub async fn active_image_lease_count(&self, digest: &str, now: i64) -> Result<u64> {
        let count = image_leases::Entity::find()
            .filter(image_leases::Column::ImageDigest.eq(digest))
            .filter(image_leases::Column::ExpiresAt.gt(now))
            .count(&self.conn)
            .await
            .context("failed to count image leases")?;
        Ok(count)
    }

    pub async fn image_has_alias(&self, digest: &str) -> Result<bool> {
        let count = image_aliases::Entity::find()
            .filter(image_aliases::Column::ImageDigest.eq(digest))
            .count(&self.conn)
            .await
            .context("failed to count image aliases")?;
        Ok(count > 0)
    }

    /// Ready images that no durable reference protects, plus stale in-flight
    /// rows. The caller removes the blob before deleting the row.
    pub async fn gc_image_candidates(
        &self,
        now: i64,
        stale_building_before: i64,
    ) -> Result<Vec<ImageRow>> {
        let rows = images::Entity::find()
            .order_by_asc(images::Column::CreatedAt)
            .all(&self.conn)
            .await
            .context("failed to list images for GC")?;
        let mut candidates = Vec::new();
        for model in rows {
            let row = row_from_model(model);
            match row.status.as_str() {
                "failed" => candidates.push(row),
                "building" if row.updated_at < stale_building_before => candidates.push(row),
                "ready" => {
                    let Some(digest) = row.digest.as_deref() else {
                        candidates.push(row);
                        continue;
                    };
                    if self.any_project_references_image(digest).await?
                        || self.image_has_alias(digest).await?
                        || self.active_image_lease_count(digest, now).await? > 0
                    {
                        continue;
                    }
                    candidates.push(row);
                }
                _ => {}
            }
        }
        Ok(candidates)
    }

    pub async fn delete_image_row(&self, image_id: &str) -> Result<bool> {
        let result = images::Entity::delete_by_id(image_id.to_owned())
            .exec(&self.conn)
            .await
            .context("failed to delete image row")?;
        Ok(result.rows_affected > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, digest: Option<&str>, status: &str, now: i64) -> ImageRow {
        ImageRow {
            image_id: id.to_string(),
            digest: digest.map(str::to_string),
            size_bytes: 0,
            source_json: "{}".to_string(),
            source_sha: None,
            packaging_json: "{}".to_string(),
            status: status.to_string(),
            error: None,
            created_at: now,
            updated_at: now,
        }
    }

    #[tokio::test]
    async fn a_ready_image_is_reused_by_digest_and_a_failed_attempt_is_not_ready() {
        let db = Database::new(":memory:").await.unwrap();
        db.insert_image(&row("image-a", None, "building", 1))
            .await
            .unwrap();
        db.fail_image("image-a", "network failed", 2).await.unwrap();
        let failed = db.get_image_by_id("image-a").await.unwrap().unwrap();
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.digest, None);
        assert_eq!(failed.error.as_deref(), Some("network failed"));

        db.insert_image(&row("image-b", None, "building", 3))
            .await
            .unwrap();
        let ready = db
            .finish_image(
                "image-b",
                "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                7,
                4,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ready.status, "ready");
        assert_eq!(ready.size_bytes, 7);
        let by_digest = db
            .get_image_by_digest(
                "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(by_digest.image_id, "image-b");
    }

    #[tokio::test]
    async fn gc_keeps_project_referenced_aliased_and_leased_images() {
        let db = Database::new(":memory:").await.unwrap();
        let digest_ref = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let digest_alias =
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let digest_lease =
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        let digest_free = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
        for (id, digest) in [
            ("image-ref", digest_ref),
            ("image-alias", digest_alias),
            ("image-lease", digest_lease),
            ("image-free", digest_free),
        ] {
            db.insert_image(&row(id, None, "building", 1))
                .await
                .unwrap();
            db.finish_image(id, digest, 3, 2).await.unwrap();
        }
        db.insert_project(&crate::db::ProjectRow {
            project_id: "project-ref".to_string(),
            name: "Referenced".to_string(),
            description: None,
            source: None,
            locations: Vec::new(),
            session_defaults: None,
            image_digest: Some(digest_ref.to_string()),
            created_at: 1,
            updated_at: 1,
        })
        .await
        .unwrap();
        db.upsert_image_alias("latest", digest_alias, 2)
            .await
            .unwrap();
        db.insert_image_lease(&ImageLeaseRow {
            lease_id: "lease-1".to_string(),
            image_digest: digest_lease.to_string(),
            project_id: "project-lease".to_string(),
            expires_at: 100,
        })
        .await
        .unwrap();
        let candidates = db.gc_image_candidates(50, 0).await.unwrap();
        assert_eq!(
            candidates
                .iter()
                .map(|row| row.image_id.as_str())
                .collect::<Vec<_>>(),
            vec!["image-free"]
        );
        assert_eq!(
            db.active_image_lease_count(digest_lease, 50).await.unwrap(),
            1
        );
        assert!(db.image_has_alias(digest_alias).await.unwrap());
        assert!(db.any_project_references_image(digest_ref).await.unwrap());
    }
}
