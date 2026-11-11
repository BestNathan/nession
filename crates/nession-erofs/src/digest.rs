//! Byte-level digest and file verification shared by every EROFS consumer
//! (#3303).
//!
//! The Server, the Agent cache and the Sandbox all need to answer the same
//! question about the same bytes: does this file hash to this immutable
//! `sha256:<hex>` identity? Answering it in one place keeps a consumer from
//! inventing a weaker or different rule; wire-level digest *validation*
//! (prefix, length, lowercase hex) stays with the Protocol Kernel because it
//! rejects a caller's input, while this module owns the byte computation.

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::Path;

/// The only digest shape Nession stores.
pub const DIGEST_PREFIX: &str = "sha256:";
/// One read chunk. A digest is streamed, never buffered whole.
pub const HASH_CHUNK_BYTES: usize = 64 * 1024;

/// Whether `value` is `sha256:` followed by 64 lowercase hex characters.
///
/// This is the mechanical store/verification rule. `nession-protocol` keeps
/// the same shape at the wire boundary; the two agree because the digest is
/// immutable identity, not a policy knob.
pub fn is_valid_digest(value: &str) -> bool {
    let Some(hex) = value.strip_prefix(DIGEST_PREFIX) else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The digest of an in-memory byte slice.
pub fn digest_of_bytes(bytes: &[u8]) -> String {
    format!("{DIGEST_PREFIX}{:x}", Sha256::digest(bytes))
}

/// The digest of a stored file, streamed in bounded chunks.
pub fn file_digest(path: &Path) -> Result<String> {
    let mut file = File::open(path)
        .with_context(|| format!("cannot read {} for verification", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; HASH_CHUNK_BYTES];
    loop {
        let read = file
            .read(&mut buffer)
            .with_context(|| format!("cannot read {} for verification", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(buffer.get(..read).unwrap_or_default());
    }
    Ok(format!("{DIGEST_PREFIX}{:x}", hasher.finalize()))
}

/// The digest of a regular, non-empty file, or `None` when the path is absent,
/// a symlink or anything other than a regular file.
///
/// A cache hit must never be a symlink or an empty placeholder: callers that
/// treat absence as a miss use this shape, while callers that must reject an
/// invalid source call [`file_digest`] and inspect the error.
pub fn regular_file_digest(path: &Path) -> Result<Option<String>> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("cannot inspect {}", path.display()));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() == 0 {
        return Ok(None);
    }
    file_digest(path).map(Some)
}

/// Verify that `path` hashes to `expected`.
pub fn verify_file(path: &Path, expected: &str) -> Result<()> {
    let actual = file_digest(path)?;
    if actual != expected {
        anyhow::bail!(
            "{} digest mismatch: expected {expected}, bytes hash to {actual}",
            path.display()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn a_digest_is_the_sha256_of_its_bytes() {
        assert_eq!(
            digest_of_bytes(b""),
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn digest_validation_accepts_only_the_immutable_shape() {
        let valid = digest_of_bytes(b"image");
        assert!(is_valid_digest(&valid));
        assert!(!is_valid_digest(&valid.to_uppercase()));
        assert!(!is_valid_digest("sha256:abc"));
        assert!(!is_valid_digest(&valid.replacen("sha256:", "md5:", 1)));
        assert!(!is_valid_digest("../etc/passwd"));
    }

    #[test]
    fn file_verification_accepts_identical_bytes_and_rejects_changed_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("image.erofs");
        let mut file = File::create(&path).unwrap();
        file.write_all(b"immutable bytes").unwrap();
        let digest = file_digest(&path).unwrap();
        verify_file(&path, &digest).unwrap();

        std::fs::write(&path, b"changed bytes").unwrap();
        assert!(verify_file(&path, &digest).is_err());
    }

    #[test]
    fn a_symlink_or_empty_file_is_not_a_verified_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        std::fs::write(&target, b"bytes").unwrap();
        let link = dir.path().join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        #[cfg(not(unix))]
        std::fs::write(&link, b"bytes").unwrap();

        let empty = dir.path().join("empty");
        std::fs::write(&empty, b"").unwrap();

        assert!(regular_file_digest(&link).unwrap().is_none());
        assert!(regular_file_digest(&empty).unwrap().is_none());
        assert!(regular_file_digest(&dir.path().join("absent"))
            .unwrap()
            .is_none());
        assert!(regular_file_digest(&target).unwrap().is_some());
    }
}
