//! Content fingerprints for raw transcript identities (`#4027`).
//!
//! A raw record reference and a page cursor are content-addressed: they name
//! the bytes they were issued for, not only a file offset. The fingerprint
//! covers exactly the region the identity is responsible for — a record's own
//! line, or the byte range of the page a cursor continues from — so appending
//! records elsewhere never invalidates an identity that is still true, while
//! rewriting a covered record does.

/// FNV-1a, 64-bit. Stable across runs and platforms, unlike `DefaultHasher`.
pub(crate) const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;

const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// Fold `bytes` into a running FNV-1a hash.
pub(crate) fn update(hash: u64, bytes: &[u8]) -> u64 {
    bytes.iter().fold(hash, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(FNV_PRIME)
    })
}

/// The FNV-1a hash of `bytes`.
pub(crate) fn fnv1a64(bytes: &[u8]) -> u64 {
    update(FNV_OFFSET, bytes)
}
