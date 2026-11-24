//! Immutable catalog objects and their descriptor-reference edges.

use anyhow::Result;
use sea_orm::ConnectionTrait;
use std::collections::{HashMap, HashSet, VecDeque};

use super::pin::ConsumerKind;
use super::sqlite;
use crate::digest::is_valid_digest;
use crate::oci::{
    MEDIA_TYPE_COMPOSITE, MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_INDEX,
    MEDIA_TYPE_MANIFEST,
};

/// The stored object kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectKind {
    Index,
    Manifest,
    Config,
    Erofs,
    /// The referenced multi-blob Composite descriptor (#3697).
    Composite,
}

impl ObjectKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Index => "index",
            Self::Manifest => "manifest",
            Self::Config => "config",
            Self::Erofs => "erofs",
            Self::Composite => "composite",
        }
    }

    /// The kind implied by a v1 media type, or `None` for an unsupported one.
    pub fn for_media_type(media_type: &str) -> Option<Self> {
        match media_type {
            MEDIA_TYPE_INDEX => Some(Self::Index),
            MEDIA_TYPE_MANIFEST => Some(Self::Manifest),
            MEDIA_TYPE_CONFIG => Some(Self::Config),
            MEDIA_TYPE_EROFS => Some(Self::Erofs),
            MEDIA_TYPE_COMPOSITE => Some(Self::Composite),
            _ => None,
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "index" => Ok(Self::Index),
            "manifest" => Ok(Self::Manifest),
            "config" => Ok(Self::Config),
            "erofs" => Ok(Self::Erofs),
            "composite" => Ok(Self::Composite),
            other => anyhow::bail!("unsupported catalog object kind {other:?}"),
        }
    }
}

/// One immutable object row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredObject {
    pub digest: String,
    pub media_type: String,
    /// The exact byte count claimed by the descriptor and verified by CAS.
    pub size_bytes: u64,
    pub kind: ObjectKind,
}

/// Insert one object row, or verify that the existing row describes the same
/// object. A digest can never be re-associated with a different type or size.
pub async fn record_object(
    conn: &impl ConnectionTrait,
    object: &StoredObject,
    now: i64,
) -> Result<()> {
    if !is_valid_digest(&object.digest) {
        anyhow::bail!("invalid catalog object digest {:?}", object.digest);
    }
    if let Some(existing) = get_object(conn, &object.digest).await? {
        if existing.media_type != object.media_type
            || existing.size_bytes != object.size_bytes
            || existing.kind != object.kind
        {
            anyhow::bail!(
                "catalog object {} is already recorded as {:?} {} bytes, not {:?} {} bytes",
                object.digest,
                existing.kind,
                existing.size_bytes,
                object.kind,
                object.size_bytes
            );
        }
        return Ok(());
    }
    sqlite::execute(
        conn,
        "INSERT INTO catalog_objects (digest, media_type, size_bytes, kind, created_at) \
         VALUES (?, ?, ?, ?, ?)",
        vec![
            object.digest.as_str().into(),
            object.media_type.as_str().into(),
            i64::try_from(object.size_bytes)
                .map_err(|_| anyhow::anyhow!("catalog object size exceeds i64"))?
                .into(),
            object.kind.as_str().into(),
            now.into(),
        ],
    )
    .await?;
    Ok(())
}

/// Record one parent→child descriptor edge.
pub async fn record_reference(
    conn: &impl ConnectionTrait,
    parent_digest: &str,
    child_digest: &str,
    role: &str,
    now: i64,
) -> Result<()> {
    if !is_valid_digest(parent_digest) || !is_valid_digest(child_digest) {
        anyhow::bail!("invalid catalog reference digest");
    }
    if role.is_empty() {
        anyhow::bail!("catalog reference role must not be empty");
    }
    sqlite::execute(
        conn,
        "INSERT INTO catalog_references (parent_digest, child_digest, role, created_at) \
         VALUES (?, ?, ?, ?) ON CONFLICT (parent_digest, child_digest, role) DO NOTHING",
        vec![
            parent_digest.into(),
            child_digest.into(),
            role.into(),
            now.into(),
        ],
    )
    .await?;
    Ok(())
}

/// Read one object row.
pub async fn get_object(conn: &impl ConnectionTrait, digest: &str) -> Result<Option<StoredObject>> {
    if !is_valid_digest(digest) {
        anyhow::bail!("invalid catalog object digest {digest:?}");
    }
    let rows = sqlite::query_all(
        conn,
        "SELECT digest, media_type, size_bytes, kind FROM catalog_objects WHERE digest = ?",
        vec![digest.into()],
    )
    .await?;
    rows.first().map(object_from_row).transpose()
}

/// Read every object row in stable digest order.
pub async fn all_objects(conn: &impl ConnectionTrait) -> Result<Vec<StoredObject>> {
    let rows = sqlite::query_all(
        conn,
        "SELECT digest, media_type, size_bytes, kind FROM catalog_objects ORDER BY digest",
        Vec::new(),
    )
    .await?;
    rows.iter().map(object_from_row).collect()
}

fn object_from_row(row: &sea_orm::QueryResult) -> Result<StoredObject> {
    let size: i64 = row
        .try_get("", "size_bytes")
        .map_err(|error| anyhow::anyhow!("catalog object size is invalid: {error}"))?;
    let kind: String = row
        .try_get("", "kind")
        .map_err(|error| anyhow::anyhow!("catalog object kind is invalid: {error}"))?;
    Ok(StoredObject {
        digest: row
            .try_get("", "digest")
            .map_err(|error| anyhow::anyhow!("catalog object digest is invalid: {error}"))?,
        media_type: row
            .try_get("", "media_type")
            .map_err(|error| anyhow::anyhow!("catalog object media type is invalid: {error}"))?,
        size_bytes: u64::try_from(size)
            .map_err(|_| anyhow::anyhow!("catalog object size is negative"))?,
        kind: ObjectKind::parse(&kind)?,
    })
}

async fn all_edges(conn: &impl ConnectionTrait) -> Result<Vec<(String, String)>> {
    let rows = sqlite::query_all(
        conn,
        "SELECT parent_digest, child_digest FROM catalog_references",
        Vec::new(),
    )
    .await?;
    rows.iter()
        .map(|row| {
            Ok((
                row.try_get::<String>("", "parent_digest")
                    .map_err(|error| anyhow::anyhow!("catalog reference is invalid: {error}"))?,
                row.try_get::<String>("", "child_digest")
                    .map_err(|error| anyhow::anyhow!("catalog reference is invalid: {error}"))?,
            ))
        })
        .collect()
}

/// Expand a root set through descriptor edges.
///
/// Roots themselves count as reachable even when they are a historical digest
/// with no catalog row (legacy Project/Session references). The function loads
/// the edge set once, so a sweep sees a stable graph.
pub async fn reachable(conn: &impl ConnectionTrait, roots: &[String]) -> Result<HashSet<String>> {
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for (parent, child) in all_edges(conn).await? {
        children.entry(parent).or_default().push(child);
    }
    let mut reachable: HashSet<String> = roots.iter().cloned().collect();
    let mut queue: VecDeque<String> = roots.iter().cloned().collect();
    while let Some(parent) = queue.pop_front() {
        if let Some(next) = children.get(&parent) {
            for child in next {
                if reachable.insert(child.clone()) {
                    queue.push_back(child.clone());
                }
            }
        }
    }
    Ok(reachable)
}

/// Parent digests that name `child_digest` under one role.
pub async fn parents_for_reference(
    conn: &impl ConnectionTrait,
    child_digest: &str,
    role: &str,
) -> Result<Vec<String>> {
    let rows = sqlite::query_all(
        conn,
        "SELECT parent_digest FROM catalog_references \
         WHERE child_digest = ? AND role = ? ORDER BY parent_digest",
        vec![child_digest.into(), role.into()],
    )
    .await?;
    rows.iter()
        .map(|row| {
            row.try_get("", "parent_digest")
                .map_err(|error| anyhow::anyhow!("catalog reference is invalid: {error}"))
        })
        .collect()
}

/// Every parent digest of one object, for every reference role.
pub async fn parents_of(conn: &impl ConnectionTrait, child_digest: &str) -> Result<Vec<String>> {
    let rows = sqlite::query_all(
        conn,
        "SELECT parent_digest FROM catalog_references \
         WHERE child_digest = ? ORDER BY parent_digest",
        vec![child_digest.into()],
    )
    .await?;
    rows.iter()
        .map(|row| {
            row.try_get("", "parent_digest")
                .map_err(|error| anyhow::anyhow!("catalog reference is invalid: {error}"))
        })
        .collect()
}

/// Every Manifest/Index ancestor of one catalog object, nearest first.
///
/// A build publishes a Manifest that names the raw EROFS layer, and a
/// referenced Composite adds one metadata hop. Walk parent edges until a
/// Manifest/Index root is found; unreachable or cyclic history is bounded and
/// reported as an empty answer rather than interpreted.
pub async fn manifest_ancestors(
    conn: &impl ConnectionTrait,
    child_digest: &str,
) -> Result<Vec<StoredObject>> {
    if !is_valid_digest(child_digest) {
        anyhow::bail!("invalid catalog object digest {child_digest:?}");
    }
    let mut frontier = vec![child_digest.to_string()];
    let mut seen: HashSet<String> = HashSet::new();
    let mut manifests: HashMap<String, StoredObject> = HashMap::new();
    for _ in 0..8 {
        if frontier.is_empty() {
            break;
        }
        let mut next = Vec::new();
        for digest in frontier {
            if !seen.insert(digest.clone()) {
                continue;
            }
            for parent in parents_of(conn, &digest).await? {
                let Some(object) = get_object(conn, &parent).await? else {
                    continue;
                };
                if matches!(object.kind, ObjectKind::Manifest | ObjectKind::Index) {
                    manifests.insert(object.digest.clone(), object);
                } else if seen.insert(parent.clone()) {
                    next.push(parent);
                }
            }
        }
        frontier = next;
    }
    let mut manifests: Vec<StoredObject> = manifests.into_values().collect();
    manifests.sort_by(|left, right| left.digest.cmp(&right.digest));
    Ok(manifests)
}

/// The direct descriptor edges of one object, with each child's stored kind.
pub async fn references_of(
    conn: &impl ConnectionTrait,
    parent_digest: &str,
) -> Result<Vec<(StoredObject, String)>> {
    let rows = sqlite::query_all(
        conn,
        "SELECT r.role, o.digest, o.media_type, o.size_bytes, o.kind \
         FROM catalog_references r JOIN catalog_objects o ON o.digest = r.child_digest \
         WHERE r.parent_digest = ? ORDER BY r.role, o.digest",
        vec![parent_digest.into()],
    )
    .await?;
    rows.iter()
        .map(|row| {
            let role: String = row
                .try_get("", "role")
                .map_err(|error| anyhow::anyhow!("catalog reference is invalid: {error}"))?;
            let object = object_from_row(row)?;
            Ok((object, role))
        })
        .collect()
}

/// Every repository Tag resolving to one Manifest, sorted.
pub async fn tags_for_manifest(
    conn: &impl ConnectionTrait,
    manifest_digest: &str,
) -> Result<Vec<(String, String)>> {
    let rows = sqlite::query_all(
        conn,
        "SELECT repository, tag FROM catalog_tags WHERE manifest_digest = ? \
         ORDER BY repository, tag",
        vec![manifest_digest.into()],
    )
    .await?;
    rows.iter()
        .map(|row| {
            let repository: String = row
                .try_get("", "repository")
                .map_err(|error| anyhow::anyhow!("catalog tag is invalid: {error}"))?;
            let tag: String = row
                .try_get("", "tag")
                .map_err(|error| anyhow::anyhow!("catalog tag is invalid: {error}"))?;
            Ok((repository, tag))
        })
        .collect()
}

/// The standard OCI `/v2/` repository whose Tag-reachable closure contains one
/// resolved Manifest (#4250).
///
/// The `/v2/` Registry exposes an immutable digest only when a repository's Tags
/// reach it through descriptor edges (including Index children). This finds the
/// first such repository in deterministic order so the Server can issue a
/// repository-scoped `/v2/{repo}/manifests/{digest}` grant. `None` means the
/// Manifest is not Tag-reachable in any repository — an untagged build or a
/// digest-only legacy row — and the caller keeps the bounded compatibility route.
/// This reads the same Tag roots and descriptor edges as the Registry's
/// reachability fence; it grants no access beyond what `/v2/` already serves.
pub async fn v2_repository_for_manifest(
    conn: &impl ConnectionTrait,
    manifest_digest: &str,
) -> Result<Option<String>> {
    if !is_valid_digest(manifest_digest) {
        anyhow::bail!("invalid catalog object digest {manifest_digest:?}");
    }
    // Candidate reachability roots: the Manifest itself and every Index/Manifest
    // ancestor a Tag might target instead of the Manifest digest.
    let mut roots = vec![manifest_digest.to_string()];
    for ancestor in manifest_ancestors(conn, manifest_digest).await? {
        roots.push(ancestor.digest);
    }
    let mut repositories: Vec<String> = Vec::new();
    for root in &roots {
        for (repository, _tag) in tags_for_manifest(conn, root).await? {
            if !repositories.contains(&repository) {
                repositories.push(repository);
            }
        }
    }
    repositories.sort();
    for repository in repositories {
        let mut tag_roots = Vec::new();
        for name in super::tag::list_tags(conn, &repository).await? {
            if let Some(digest) = super::tag::get_tag(conn, &repository, &name).await? {
                if !tag_roots.contains(&digest) {
                    tag_roots.push(digest);
                }
            }
        }
        if reachable(conn, &tag_roots).await?.contains(manifest_digest) {
            return Ok(Some(repository));
        }
    }
    Ok(None)
}

/// Live catalog pins for one digest, counted by consumer kind.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PinCounts {
    pub project: u64,
    pub session: u64,
    pub build: u64,
    pub transfer: u64,
    pub mount: u64,
}

impl PinCounts {
    pub fn leases(&self) -> u64 {
        self.build + self.transfer + self.mount
    }
}

/// Count durable pins and unexpired leases for one Manifest.
pub async fn pin_counts(
    conn: &impl ConnectionTrait,
    manifest_digest: &str,
    now: i64,
) -> Result<PinCounts> {
    let rows = sqlite::query_all(
        conn,
        "SELECT consumer_kind, COUNT(*) AS count FROM catalog_pins \
         WHERE manifest_digest = ? AND (expires_at IS NULL OR expires_at > ?) \
         GROUP BY consumer_kind",
        vec![manifest_digest.into(), now.into()],
    )
    .await?;
    let mut counts = PinCounts::default();
    for row in rows {
        let kind: String = row
            .try_get("", "consumer_kind")
            .map_err(|error| anyhow::anyhow!("catalog pin is invalid: {error}"))?;
        let count: i64 = row
            .try_get("", "count")
            .map_err(|error| anyhow::anyhow!("catalog pin count is invalid: {error}"))?;
        let count = u64::try_from(count).unwrap_or(0);
        match ConsumerKind::parse(&kind)? {
            ConsumerKind::Project => counts.project = count,
            ConsumerKind::Session => counts.session = count,
            ConsumerKind::Build => counts.build = count,
            ConsumerKind::Transfer => counts.transfer = count,
            ConsumerKind::Mount => counts.mount = count,
        }
    }
    Ok(counts)
}

/// Every Manifest digest named by a Tag in one repository, sorted.
pub async fn repository_manifest_digests(
    conn: &impl ConnectionTrait,
    repository: &str,
) -> Result<Vec<String>> {
    let rows = sqlite::query_all(
        conn,
        "SELECT DISTINCT manifest_digest FROM catalog_tags WHERE repository = ? \
         ORDER BY manifest_digest",
        vec![repository.into()],
    )
    .await?;
    rows.iter()
        .map(|row| {
            row.try_get("", "manifest_digest")
                .map_err(|error| anyhow::anyhow!("catalog tag is invalid: {error}"))
        })
        .collect()
}

/// Every reachable raw EROFS digest below one root, sorted.
pub async fn reachable_erofs_digests(
    conn: &impl ConnectionTrait,
    root_digest: &str,
) -> Result<Vec<String>> {
    let reachable = reachable(conn, &[root_digest.to_string()]).await?;
    let mut erofs = Vec::new();
    for digest in reachable {
        if digest == root_digest {
            continue;
        }
        if let Some(object) = get_object(conn, &digest).await? {
            if object.kind == ObjectKind::Erofs {
                erofs.push(digest);
            }
        }
    }
    erofs.sort();
    Ok(erofs)
}

/// Delete one object row and every edge that names it.
pub async fn delete_object(
    conn: &impl ConnectionTrait,
    digest: &str,
) -> Result<Option<StoredObject>> {
    let Some(object) = get_object(conn, digest).await? else {
        return Ok(None);
    };
    sqlite::execute(
        conn,
        "DELETE FROM catalog_references WHERE parent_digest = ? OR child_digest = ?",
        vec![digest.into(), digest.into()],
    )
    .await?;
    sqlite::execute(
        conn,
        "DELETE FROM catalog_objects WHERE digest = ?",
        vec![digest.into()],
    )
    .await?;
    Ok(Some(object))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::sqlite::tests::memory_connection;

    fn object(kind: ObjectKind, hex: char, size: u64) -> StoredObject {
        StoredObject {
            digest: format!("sha256:{}", hex.to_string().repeat(64)),
            media_type: match kind {
                ObjectKind::Index => MEDIA_TYPE_INDEX.to_string(),
                ObjectKind::Manifest => MEDIA_TYPE_MANIFEST.to_string(),
                ObjectKind::Config => MEDIA_TYPE_CONFIG.to_string(),
                ObjectKind::Erofs => MEDIA_TYPE_EROFS.to_string(),
                ObjectKind::Composite => MEDIA_TYPE_COMPOSITE.to_string(),
            },
            size_bytes: size,
            kind,
        }
    }

    #[tokio::test]
    async fn recording_is_idempotent_and_rejects_changed_metadata() {
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        let manifest = object(ObjectKind::Manifest, 'a', 10);
        record_object(&conn, &manifest, 1).await.unwrap();
        record_object(&conn, &manifest, 2).await.unwrap();
        let mut changed = manifest.clone();
        changed.size_bytes = 11;
        assert!(record_object(&conn, &changed, 3).await.is_err());
        assert_eq!(all_objects(&conn).await.unwrap(), vec![manifest]);
    }

    #[tokio::test]
    async fn reachability_follows_transitive_edges() {
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        let index = object(ObjectKind::Index, 'a', 1);
        let manifest = object(ObjectKind::Manifest, 'b', 1);
        let config = object(ObjectKind::Config, 'c', 1);
        let layer = object(ObjectKind::Erofs, 'd', 1);
        for item in [&index, &manifest, &config, &layer] {
            record_object(&conn, item, 1).await.unwrap();
        }
        record_reference(&conn, &index.digest, &manifest.digest, "index-child", 1)
            .await
            .unwrap();
        record_reference(&conn, &manifest.digest, &config.digest, "config", 1)
            .await
            .unwrap();
        record_reference(&conn, &manifest.digest, &layer.digest, "layer", 1)
            .await
            .unwrap();
        let roots = vec![index.digest.clone()];
        let found = reachable(&conn, &roots).await.unwrap();
        assert!(found.contains(&manifest.digest));
        assert!(found.contains(&config.digest));
        assert!(found.contains(&layer.digest));

        delete_object(&conn, &manifest.digest).await.unwrap();
        let found = reachable(&conn, &roots).await.unwrap();
        assert!(!found.contains(&config.digest));
        assert!(!found.contains(&layer.digest));
    }

    #[tokio::test]
    async fn v2_repository_resolves_a_directly_tagged_manifest() {
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        let manifest = object(ObjectKind::Manifest, 'a', 10);
        record_object(&conn, &manifest, 1).await.unwrap();
        crate::catalog::tag::set_tag(
            &conn,
            "team/app",
            "v1",
            &manifest.digest,
            &crate::catalog::tag::TagExpectation::Absent,
            1,
        )
        .await
        .unwrap();
        assert_eq!(
            v2_repository_for_manifest(&conn, &manifest.digest)
                .await
                .unwrap()
                .as_deref(),
            Some("team/app")
        );
    }

    #[tokio::test]
    async fn v2_repository_is_none_for_an_untagged_manifest() {
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        let manifest = object(ObjectKind::Manifest, 'a', 10);
        record_object(&conn, &manifest, 1).await.unwrap();
        assert_eq!(
            v2_repository_for_manifest(&conn, &manifest.digest)
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn v2_repository_resolves_a_manifest_through_a_tagged_index() {
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        let index = object(ObjectKind::Index, 'a', 1);
        let manifest = object(ObjectKind::Manifest, 'b', 1);
        record_object(&conn, &index, 1).await.unwrap();
        record_object(&conn, &manifest, 1).await.unwrap();
        record_reference(&conn, &index.digest, &manifest.digest, "index-child", 1)
            .await
            .unwrap();
        crate::catalog::tag::set_tag(
            &conn,
            "team/app",
            "v1",
            &index.digest,
            &crate::catalog::tag::TagExpectation::Absent,
            1,
        )
        .await
        .unwrap();
        assert_eq!(
            v2_repository_for_manifest(&conn, &manifest.digest)
                .await
                .unwrap()
                .as_deref(),
            Some("team/app")
        );
    }

    #[tokio::test]
    async fn v2_repository_pick_is_deterministic_across_repositories() {
        let conn = memory_connection().await;
        crate::catalog::sqlite::migrate(&conn).await.unwrap();
        let manifest = object(ObjectKind::Manifest, 'a', 10);
        record_object(&conn, &manifest, 1).await.unwrap();
        for repository in ["z/repo", "a/repo"] {
            crate::catalog::tag::set_tag(
                &conn,
                repository,
                "v1",
                &manifest.digest,
                &crate::catalog::tag::TagExpectation::Absent,
                1,
            )
            .await
            .unwrap();
        }
        assert_eq!(
            v2_repository_for_manifest(&conn, &manifest.digest)
                .await
                .unwrap()
                .as_deref(),
            Some("a/repo")
        );
    }
}
