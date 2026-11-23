//! Reusable Store and Repository contracts for peer-capable hosts (#4087).
//!
//! Every Nession Server/Agent may own a local verified CAS and mount the same
//! standard OCI Distribution Registry service (#4086). These contracts are the
//! host-independent surface that service and the Registry Client SDK consume:
//!
//! - [`BlobStore`]: content/sha256-addressed bytes — read, write, exists and
//!   verify-stream. Writes are atomic and deduplicate identical digests
//!   without rewriting bytes. Eviction/GC is deliberately **not** part of this
//!   contract: retention is an independent policy of the owning host (Server
//!   catalog GC vs Agent cache eviction), so a shared reader can never reclaim
//!   another owner's pinned or transferring objects.
//! - [`RepositoryStore`]: which Manifests/Tags a repository exposes and the
//!   complete verified blob closure reachable from them. Possessing a digest
//!   is never authorization: a blob read is gated by repository reachability,
//!   and a raw CAS directory is never a repository.
//!
//! The contracts carry no host identity, no database and no authorization
//! state machine. The Server implements them over its SQLite catalog and CAS;
//! the Agent over its verified per-identity cache. `nession-erofs` keeps its
//! one-way dependency rule: no `nession-server`/`nession-agent`/
//! `nession-sandbox`/`nession-protocol` edge.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::blob::store::BlobDigest;
use crate::oci::descriptor::Descriptor;

/// The reusable content-addressed byte contract (#4087 SC-01).
///
/// Implementations accept immutable OCI Index/Manifest/Config/EROFS bytes
/// under their sha256 digest, verify before offering bytes as ready, and
/// deduplicate identical digests without rewriting stored bytes. A failed or
/// interrupted write is never visible under a digest.
pub trait BlobStore: Send + Sync {
    /// Whether a ready blob with this digest exists (no re-hash).
    fn contains(&self, digest: &str) -> Result<bool>;
    /// The size of a stored blob.
    fn size(&self, digest: &str) -> Result<u64>;
    /// The validated filesystem path for a digest.
    fn path_for(&self, digest: &str) -> Result<PathBuf>;
    /// Open a stored blob for streaming reads. Raw access: the consumer must
    /// [`verify`](Self::verify) before consuming the bytes (adapters may be
    /// stricter and verify on read themselves).
    fn open(&self, digest: &str) -> Result<File>;
    /// Read a stored blob completely. Raw access with the same verify-before-
    /// consume rule as [`open`](Self::open).
    fn read(&self, digest: &str) -> Result<Vec<u8>>;
    /// Publish exact bytes atomically under their computed digest.
    fn put_bytes(&self, bytes: &[u8]) -> Result<BlobDigest>;
    /// Publish a local file atomically under its computed digest.
    fn put_file(&self, source: &Path) -> Result<BlobDigest>;
    /// Stream bytes into the store, hashing while writing; the digest is
    /// computed from the bytes actually stored, never from a caller claim.
    fn put_reader(&self, reader: &mut dyn Read) -> Result<BlobDigest>;
    /// Recompute and compare the digest of a stored blob.
    fn verify(&self, digest: &str) -> Result<()>;
    /// Verify existence, claimed size and recomputed digest together.
    fn verify_named_size(&self, digest: &str, expected_size: u64) -> Result<()>;
}

/// Maximum repository name length.
pub const MAX_REPOSITORY_NAME: usize = 255;
/// Maximum one repository path segment length.
pub const MAX_SEGMENT: usize = 63;
/// Maximum tag length.
pub const MAX_TAG_LENGTH: usize = 128;

/// Validate a repository name such as `nession/base-runtime`.
///
/// A name is lowercase alphanumeric segments joined by `/`. `_`, `.` and `-`
/// may separate inner alphanumerics; leading/trailing separators, empty
/// segments and `..` are refused. The name is also the repository's stable
/// identity, so it cannot be renamed into a second row.
///
/// This is the one shared grammar (#4087): the Server catalog and the Agent
/// local reference projection validate the same names, so a remote repository
/// can never become a second catalog identity or a surprising URL.
pub fn validate_repository_name(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > MAX_REPOSITORY_NAME {
        anyhow::bail!("repository name must be 1..={MAX_REPOSITORY_NAME} bytes");
    }
    for segment in name.split('/') {
        if segment.is_empty() {
            anyhow::bail!("repository name {name:?} contains an empty segment");
        }
        if segment.len() > MAX_SEGMENT {
            anyhow::bail!("repository segment {segment:?} exceeds {MAX_SEGMENT} bytes");
        }
        if segment == ".." || segment == "." {
            anyhow::bail!("repository name {name:?} must not contain a dot segment");
        }
        let mut characters = segment.chars();
        let Some(first) = characters.next() else {
            anyhow::bail!("repository name {name:?} contains an empty segment");
        };
        if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
            anyhow::bail!(
                "repository segment {segment:?} must start with a lowercase letter or digit"
            );
        }
        let last = segment.chars().last().unwrap_or(first);
        if !last.is_ascii_lowercase() && !last.is_ascii_digit() {
            anyhow::bail!(
                "repository segment {segment:?} must end with a lowercase letter or digit"
            );
        }
        for character in segment.chars() {
            if !(character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || character == '_'
                || character == '.'
                || character == '-')
            {
                anyhow::bail!("repository segment {segment:?} contains an unsupported character");
            }
        }
    }
    Ok(())
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

/// One repository-scoped Manifest/Index identity resolved from a reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryManifest {
    pub digest: String,
    pub media_type: String,
    pub size_bytes: u64,
}

/// The reusable repository reachability contract (#4087 SC-02).
///
/// A repository exposes only its own complete verified Manifest closures.
/// `Ok(None)` means the reference/object is not exposed by this repository —
/// distinct from an I/O or verification failure (`Err`), so a caller can tell
/// a cache miss / authorized nonexistent object apart from a broken one.
#[async_trait::async_trait]
pub trait RepositoryStore: Send + Sync {
    /// Resolve a Tag or immutable digest reference within one repository to a
    /// Manifest/Index identity, or `None` when the repository does not expose
    /// it. A foreign repository's digest is `None` even when its bytes share
    /// the same CAS.
    async fn resolve_reference(
        &self,
        repository: &str,
        reference: &str,
    ) -> Result<Option<RepositoryManifest>>;

    /// The repository's mutable Tag names in stable order.
    async fn list_tags(&self, repository: &str) -> Result<Vec<String>>;

    /// The complete verified descriptor closure of one Manifest within the
    /// repository, root Manifest first. `None` when the Manifest is not
    /// exposed by the repository or its closure is incomplete/unverified —
    /// an incomplete Composite is never silently truncated.
    async fn verified_closure(
        &self,
        repository: &str,
        manifest_digest: &str,
    ) -> Result<Option<Vec<Descriptor>>>;

    /// Whether a blob read is permitted: the digest must belong to a complete
    /// verified Manifest closure exposed by this repository. Physical
    /// presence in the CAS alone never permits a read.
    async fn permits_blob(&self, repository: &str, digest: &str) -> Result<bool>;
}

/// The one #4087 SC-01 contract exercise, run against every host adapter.
///
/// Accepts immutable OCI-shaped Manifest/Config/EROFS bytes, deduplicates
/// identical digests without rewriting bytes, verifies before ready, and
/// fails closed on tampering. Host adapters prove themselves through this
/// exact sequence rather than through parallel per-host assertions.
#[cfg(test)]
pub(crate) fn exercise_blob_contract(store: &dyn BlobStore) {
    let manifest_bytes =
        br#"{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json"}"#;
    let config_bytes = br#"{"architecture":"amd64","os":"linux"}"#;
    let erofs_bytes = b"raw erofs payload bytes".to_vec();

    let manifest = store.put_bytes(manifest_bytes).unwrap();
    let config = store.put_bytes(config_bytes).unwrap();
    let erofs = store.put_bytes(&erofs_bytes).unwrap();
    assert_ne!(manifest.digest, config.digest);
    assert_ne!(config.digest, erofs.digest);
    assert_eq!(store.read(&manifest.digest).unwrap(), manifest_bytes);
    assert_eq!(store.read(&config.digest).unwrap(), config_bytes);
    assert_eq!(store.read(&erofs.digest).unwrap(), erofs_bytes);
    store.verify(&manifest.digest).unwrap();
    store
        .verify_named_size(&erofs.digest, erofs_bytes.len() as u64)
        .unwrap();
    assert!(store.contains(&manifest.digest).unwrap());
    assert_eq!(
        store.size(&config.digest).unwrap(),
        config_bytes.len() as u64
    );

    // Identical digests deduplicate without rewriting stored bytes.
    let before = std::fs::metadata(&erofs.path).unwrap().modified().unwrap();
    let replay = store.put_bytes(&erofs_bytes).unwrap();
    assert_eq!(replay.digest, erofs.digest);
    assert_eq!(replay.path, erofs.path);
    let after = std::fs::metadata(&erofs.path).unwrap().modified().unwrap();
    assert_eq!(before, after, "a warm replay must not rewrite stored bytes");

    // Streaming writes compute the digest from the bytes actually stored.
    let streamed = store.put_reader(&mut &erofs_bytes[..]).unwrap();
    assert_eq!(streamed.digest, erofs.digest);
    assert_eq!(streamed.path, erofs.path);

    // Tampered bytes fail verification and are never offered as ready.
    // Raw read/open stream stored bytes; verification is the consumer's gate.
    std::fs::write(&erofs.path, b"tampered").unwrap();
    assert!(store.verify(&erofs.digest).is_err());
    assert!(store
        .verify_named_size(&erofs.digest, erofs_bytes.len() as u64)
        .is_err());
    // Re-publishing the original bytes over a corrupt object fails closed
    // rather than silently trusting the filename.
    assert!(store.put_bytes(&erofs_bytes).is_err());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_server_cas_adapter_satisfies_the_shared_contract() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::blob::store::FsBlobStore::new(dir.path().join("server-cas")).unwrap();
        exercise_blob_contract(&store);
    }

    #[test]
    fn repository_and_tag_grammars_are_shared() {
        validate_repository_name("nession/base-runtime").unwrap();
        assert!(validate_repository_name("../escape").is_err());
        validate_tag("v1.2").unwrap();
        assert!(validate_tag("UPPER").is_err());
    }
}
