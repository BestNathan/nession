//! Durable pins and bounded leases protecting a resolved Manifest.

use anyhow::Result;
use sea_orm::ConnectionTrait;

use super::sqlite;
use crate::digest::is_valid_digest;

/// Why a digest is pinned. Transfer/build/mount consumers are leases; Project
/// and Session consumers are durable references that advance explicitly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsumerKind {
    Project,
    Session,
    Build,
    Transfer,
    Mount,
}

impl ConsumerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Session => "session",
            Self::Build => "build",
            Self::Transfer => "transfer",
            Self::Mount => "mount",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "project" => Ok(Self::Project),
            "session" => Ok(Self::Session),
            "build" => Ok(Self::Build),
            "transfer" => Ok(Self::Transfer),
            "mount" => Ok(Self::Mount),
            other => anyhow::bail!("unsupported catalog pin consumer {other:?}"),
        }
    }
}

/// One durable pin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogPin {
    pub pin_id: String,
    pub manifest_digest: String,
    pub consumer_kind: ConsumerKind,
    pub consumer_id: String,
    /// `None` is a durable pin; `Some` is an expiring lease.
    pub expires_at: Option<i64>,
}

/// The deterministic pin identity for one consumer and digest.
pub fn pin_id(
    consumer_kind: ConsumerKind,
    consumer_id: &str,
    manifest_digest: &str,
) -> Result<String> {
    if consumer_id.is_empty() || consumer_id.contains('\u{0}') {
        anyhow::bail!("catalog pin consumer id must be a non-empty safe string");
    }
    if !is_valid_digest(manifest_digest) {
        anyhow::bail!("invalid catalog pin digest {manifest_digest:?}");
    }
    Ok(format!(
        "{}:{consumer_id}:{manifest_digest}",
        consumer_kind.as_str()
    ))
}

/// Insert or refresh one pin.
///
/// A pinned digest is a GC root until it is unpinned, expires, or is removed
/// by its owner. Moving a Tag does not touch this row.
pub async fn pin(
    conn: &impl ConnectionTrait,
    consumer_kind: ConsumerKind,
    consumer_id: &str,
    manifest_digest: &str,
    now: i64,
    expires_at: Option<i64>,
) -> Result<String> {
    let id = pin_id(consumer_kind, consumer_id, manifest_digest)?;
    sqlite::execute(
        conn,
        "INSERT INTO catalog_pins \
         (pin_id, manifest_digest, consumer_kind, consumer_id, created_at, expires_at) \
         VALUES (?, ?, ?, ?, ?, ?) \
         ON CONFLICT (pin_id) DO UPDATE SET expires_at = excluded.expires_at",
        vec![
            id.as_str().into(),
            manifest_digest.into(),
            consumer_kind.as_str().into(),
            consumer_id.into(),
            now.into(),
            expires_at.map_or(sea_orm::Value::BigInt(None), Into::into),
        ],
    )
    .await?;
    Ok(id)
}

/// Remove one pin by identity.
pub async fn unpin(conn: &impl ConnectionTrait, pin_id: &str) -> Result<bool> {
    let removed = sqlite::execute(
        conn,
        "DELETE FROM catalog_pins WHERE pin_id = ?",
        vec![pin_id.into()],
    )
    .await?;
    Ok(removed > 0)
}

/// Every digest protected by a durable pin or an unexpired lease.
pub async fn live_pin_digests(conn: &impl ConnectionTrait, now: i64) -> Result<Vec<String>> {
    let rows = sqlite::query_all(
        conn,
        "SELECT DISTINCT manifest_digest FROM catalog_pins \
         WHERE expires_at IS NULL OR expires_at > ?",
        vec![now.into()],
    )
    .await?;
    rows.iter()
        .map(|row| {
            row.try_get("", "manifest_digest")
                .map_err(|error| anyhow::anyhow!("catalog pin row is invalid: {error}"))
        })
        .collect()
}

/// Drop expired leases. Durable pins (`expires_at IS NULL`) are kept.
pub async fn prune_expired(conn: &impl ConnectionTrait, now: i64) -> Result<u64> {
    sqlite::execute(
        conn,
        "DELETE FROM catalog_pins WHERE expires_at IS NOT NULL AND expires_at <= ?",
        vec![now.into()],
    )
    .await
}

/// Read one pin, used by diagnostics and tests.
pub async fn get_pin(conn: &impl ConnectionTrait, pin_id: &str) -> Result<Option<CatalogPin>> {
    let rows = sqlite::query_all(
        conn,
        "SELECT pin_id, manifest_digest, consumer_kind, consumer_id, expires_at \
         FROM catalog_pins WHERE pin_id = ?",
        vec![pin_id.into()],
    )
    .await?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let kind: String = row
        .try_get("", "consumer_kind")
        .map_err(|error| anyhow::anyhow!("catalog pin kind is invalid: {error}"))?;
    Ok(Some(CatalogPin {
        pin_id: row
            .try_get("", "pin_id")
            .map_err(|error| anyhow::anyhow!("catalog pin id is invalid: {error}"))?,
        manifest_digest: row
            .try_get("", "manifest_digest")
            .map_err(|error| anyhow::anyhow!("catalog pin digest is invalid: {error}"))?,
        consumer_kind: ConsumerKind::parse(&kind)?,
        consumer_id: row
            .try_get("", "consumer_id")
            .map_err(|error| anyhow::anyhow!("catalog pin consumer is invalid: {error}"))?,
        expires_at: row
            .try_get("", "expires_at")
            .map_err(|error| anyhow::anyhow!("catalog pin expiry is invalid: {error}"))?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::sqlite::tests::memory_connection;

    const A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[tokio::test]
    async fn durable_and_expiring_pins_have_distinct_root_lifetimes() {
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        pin(&conn, ConsumerKind::Session, "s1", A, 10, None)
            .await
            .unwrap();
        pin(&conn, ConsumerKind::Transfer, "t1", A, 10, Some(20))
            .await
            .unwrap();
        assert_eq!(
            live_pin_digests(&conn, 15).await.unwrap(),
            vec![A.to_string()]
        );
        assert!(prune_expired(&conn, 21).await.unwrap() >= 1);
        assert_eq!(
            live_pin_digests(&conn, 21).await.unwrap(),
            vec![A.to_string()]
        );
        let session = get_pin(&conn, &pin_id(ConsumerKind::Session, "s1", A).unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(session.expires_at, None);
    }
}
