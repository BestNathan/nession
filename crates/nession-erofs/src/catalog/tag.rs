//! Mutable Tags over immutable Manifest/Index digests.

use anyhow::Result;
use sea_orm::ConnectionTrait;

use super::repository;
use super::sqlite;
use crate::digest::is_valid_digest;

/// Maximum tag length.
pub const MAX_TAG_LENGTH: usize = 128;

/// What the caller expects the Tag to point at before this update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TagExpectation {
    /// The Tag must not exist; create it.
    Absent,
    /// The Tag must currently resolve to this exact digest; move it.
    Exact(String),
}

/// The result of one successful Tag update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagUpdate {
    pub repository: String,
    pub tag: String,
    pub previous: Option<String>,
    pub digest: String,
}

/// Validate a Tag: `[a-z0-9][a-z0-9._-]{0,127}` (the existing alias rule).
pub fn validate_tag(tag: &str) -> Result<()> {
    if tag.is_empty() || tag.len() > MAX_TAG_LENGTH {
        anyhow::bail!("tag must be 1..={MAX_TAG_LENGTH} bytes");
    }
    let mut characters = tag.chars();
    let Some(first) = characters.next() else {
        anyhow::bail!("tag must not be empty");
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        anyhow::bail!("tag {tag:?} must start with a lowercase letter or digit");
    }
    for character in characters {
        if !(character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || character == '.'
            || character == '_'
            || character == '-')
        {
            anyhow::bail!("tag {tag:?} contains an unsupported character");
        }
    }
    Ok(())
}

/// Atomically create or move a Tag with an expected-previous check.
///
/// Callers must run this inside the same transaction that records the new
/// object and its descriptor edges. A Tag update never rewrites an existing
/// Session pin: pins store the resolved digest independently.
pub async fn set_tag(
    conn: &impl ConnectionTrait,
    repository_name: &str,
    tag: &str,
    digest: &str,
    expectation: &TagExpectation,
    now: i64,
) -> Result<TagUpdate> {
    repository::validate_repository_name(repository_name)?;
    validate_tag(tag)?;
    if !is_valid_digest(digest) {
        anyhow::bail!("invalid tag target digest {digest:?}");
    }
    repository::ensure_repository(conn, repository_name, now).await?;
    match expectation {
        TagExpectation::Absent => {
            let inserted = sqlite::execute(
                conn,
                "INSERT INTO catalog_tags (repository, tag, manifest_digest, updated_at) \
                 VALUES (?, ?, ?, ?) ON CONFLICT (repository, tag) DO NOTHING",
                vec![
                    repository_name.into(),
                    tag.into(),
                    digest.into(),
                    now.into(),
                ],
            )
            .await?;
            if inserted == 0 {
                anyhow::bail!(
                    "tag {repository_name}:{tag} already exists; expected it to be absent"
                );
            }
            Ok(TagUpdate {
                repository: repository_name.to_string(),
                tag: tag.to_string(),
                previous: None,
                digest: digest.to_string(),
            })
        }
        TagExpectation::Exact(expected) => {
            if !is_valid_digest(expected) {
                anyhow::bail!("invalid expected tag digest {expected:?}");
            }
            let updated = sqlite::execute(
                conn,
                "UPDATE catalog_tags SET manifest_digest = ?, updated_at = ? \
                 WHERE repository = ? AND tag = ? AND manifest_digest = ?",
                vec![
                    digest.into(),
                    now.into(),
                    repository_name.into(),
                    tag.into(),
                    expected.as_str().into(),
                ],
            )
            .await?;
            if updated == 0 {
                anyhow::bail!(
                    "tag conflict for {repository_name}:{tag}: expected previous digest {expected}"
                );
            }
            Ok(TagUpdate {
                repository: repository_name.to_string(),
                tag: tag.to_string(),
                previous: Some(expected.clone()),
                digest: digest.to_string(),
            })
        }
    }
}

/// Resolve a Tag to its current digest.
pub async fn get_tag(
    conn: &impl ConnectionTrait,
    repository_name: &str,
    tag: &str,
) -> Result<Option<String>> {
    repository::validate_repository_name(repository_name)?;
    validate_tag(tag)?;
    let rows = sqlite::query_all(
        conn,
        "SELECT manifest_digest FROM catalog_tags WHERE repository = ? AND tag = ?",
        vec![repository_name.into(), tag.into()],
    )
    .await?;
    match rows.first() {
        None => Ok(None),
        Some(row) => Ok(Some(row.try_get("", "manifest_digest").map_err(
            |error| anyhow::anyhow!("catalog tag row is invalid: {error}"),
        )?)),
    }
}

/// Delete one Tag and report whether it existed.
pub async fn delete_tag(
    conn: &impl ConnectionTrait,
    repository_name: &str,
    tag: &str,
) -> Result<bool> {
    let deleted = sqlite::execute(
        conn,
        "DELETE FROM catalog_tags WHERE repository = ? AND tag = ?",
        vec![repository_name.into(), tag.into()],
    )
    .await?;
    Ok(deleted > 0)
}

/// Delete one Tag only if it still resolves to the expected digest.
pub async fn delete_tag_if_matches(
    conn: &impl ConnectionTrait,
    repository_name: &str,
    tag: &str,
    digest: &str,
) -> Result<bool> {
    let deleted = sqlite::execute(
        conn,
        "DELETE FROM catalog_tags WHERE repository = ? AND tag = ? AND manifest_digest = ?",
        vec![repository_name.into(), tag.into(), digest.into()],
    )
    .await?;
    Ok(deleted > 0)
}

/// All Tag targets, used as GC roots.
pub async fn all_tag_digests(conn: &impl ConnectionTrait) -> Result<Vec<String>> {
    let rows = sqlite::query_all(
        conn,
        "SELECT DISTINCT manifest_digest FROM catalog_tags",
        Vec::new(),
    )
    .await?;
    rows.iter()
        .map(|row| {
            row.try_get("", "manifest_digest")
                .map_err(|error| anyhow::anyhow!("catalog tag row is invalid: {error}"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::sqlite::tests::memory_connection;

    const A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[tokio::test]
    async fn absent_create_and_exact_move_are_compare_and_swap() {
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        set_tag(&conn, "nession/base", "v1", A, &TagExpectation::Absent, 1)
            .await
            .unwrap();
        assert_eq!(
            get_tag(&conn, "nession/base", "v1").await.unwrap(),
            Some(A.to_string())
        );
        assert!(
            set_tag(&conn, "nession/base", "v1", B, &TagExpectation::Absent, 2)
                .await
                .is_err()
        );
        let moved = set_tag(
            &conn,
            "nession/base",
            "v1",
            B,
            &TagExpectation::Exact(A.to_string()),
            3,
        )
        .await
        .unwrap();
        assert_eq!(moved.previous.as_deref(), Some(A));
        assert!(set_tag(
            &conn,
            "nession/base",
            "v1",
            A,
            &TagExpectation::Exact(A.to_string()),
            4,
        )
        .await
        .is_err());
        assert_eq!(
            get_tag(&conn, "nession/base", "v1").await.unwrap(),
            Some(B.to_string())
        );
    }

    #[test]
    fn tags_follow_the_legacy_alias_shape() {
        for valid in ["v1", "base-runtime_1.2", "a"] {
            validate_tag(valid).unwrap();
        }
        for invalid in ["", "UPPER", "-leading", "a/b", "a b"] {
            assert!(validate_tag(invalid).is_err(), "{invalid:?}");
        }
    }
}
