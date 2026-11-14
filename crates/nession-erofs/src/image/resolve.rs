//! Resolve mutable Tags and immutable digests to catalog objects.

use anyhow::Result;
use sea_orm::ConnectionTrait;

use crate::catalog::reference::{get_object, ObjectKind, StoredObject};
use crate::catalog::tag;

/// A Tag or digest resolved to one immutable catalog object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedImage {
    pub digest: String,
    pub kind: ObjectKind,
    pub size_bytes: u64,
}

impl From<StoredObject> for ResolvedImage {
    fn from(object: StoredObject) -> Self {
        Self {
            digest: object.digest,
            kind: object.kind,
            size_bytes: object.size_bytes,
        }
    }
}

/// Resolve a Tag only when it names a Manifest or Index.
///
/// A tag that exists but points at a missing or non-image object is a broken
/// reference and fails instead of returning a partial identity.
pub async fn resolve_tag(
    conn: &impl ConnectionTrait,
    repository: &str,
    tag_name: &str,
) -> Result<Option<ResolvedImage>> {
    let Some(digest) = tag::get_tag(conn, repository, tag_name).await? else {
        return Ok(None);
    };
    let object = get_object(conn, &digest).await?;
    let Some(object) = object else {
        anyhow::bail!("tag {repository}:{tag_name} points at missing object {digest}");
    };
    if !matches!(object.kind, ObjectKind::Manifest | ObjectKind::Index) {
        anyhow::bail!(
            "tag {repository}:{tag_name} points at a {:?}, not a Manifest or Index",
            object.kind
        );
    }
    Ok(Some(object.into()))
}

/// Resolve an immutable digest to its catalog object.
pub async fn resolve_digest(
    conn: &impl ConnectionTrait,
    digest: &str,
) -> Result<Option<ResolvedImage>> {
    Ok(get_object(conn, digest).await?.map(ResolvedImage::from))
}

/// Resolve a historical EROFS digest to the migrated Manifest digest.
pub async fn resolve_legacy_digest(
    conn: &impl ConnectionTrait,
    legacy_digest: &str,
) -> Result<Option<String>> {
    crate::catalog::legacy::legacy_manifest_digest(conn, legacy_digest).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::sqlite::tests::memory_connection;

    #[tokio::test]
    async fn a_missing_tag_is_absent_and_a_broken_tag_fails_closed() {
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        assert!(resolve_tag(&conn, "nession/base", "missing")
            .await
            .unwrap()
            .is_none());
        crate::catalog::sqlite::execute(
            &conn,
            "INSERT INTO catalog_tags VALUES ('nession/base', 'broken', ?, 1)",
            vec!["sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into()],
        )
        .await
        .unwrap();
        assert!(resolve_tag(&conn, "nession/base", "broken").await.is_err());
    }
}
