//! Nession's reusable EROFS infrastructure layer (#3022, #3303).
//!
//! This crate owns portable EROFS mechanics only:
//!
//! - [`digest`]: byte-level `sha256:` identity and file verification;
//! - [`store`]: a content-addressed, atomically published blob store;
//! - [`build`]/[`git`]: a deterministic, non-executing source snapshot and
//!   fixed `mkfs.erofs` build;
//! - [`cache`] (feature `cache`): a durable authenticated download/resume/
//!   verify/pin cache;
//! - [`mount`] (feature `mount`, Linux): an unprivileged EROFS FUSE
//!   mount/unmount primitive with an owned handle.
//!
//! It deliberately does not depend on `nession-protocol`: wire DTOs, image
//! roles, registry metadata and authorization stay with their runtime owners.
//! Features let a consumer compile only the mechanics it uses.

pub mod digest;

#[cfg(feature = "store")]
pub mod store;

#[cfg(feature = "build")]
pub mod build;
#[cfg(feature = "build")]
pub mod git;

#[cfg(feature = "cache")]
pub mod cache;

#[cfg(all(feature = "mount", target_os = "linux"))]
pub mod mount;
#[cfg(all(feature = "mount", target_os = "linux"))]
pub mod mount_manager;

#[cfg(feature = "build")]
pub use build::{BuiltImage, ErofsBuilder, MkfsRunner, Packaging, ProcessMkfsRunner};
#[cfg(feature = "cache")]
pub use cache::{CachedImage, DownloadGrant, ErofsCache, PinGuard};
pub use digest::{
    digest_of_bytes, file_digest, is_valid_digest, regular_file_digest, verify_file, DIGEST_PREFIX,
};
#[cfg(feature = "build")]
pub use git::{GitCommandRunner, GitSnapshot, GitTarget, ProcessGitRunner};
#[cfg(all(feature = "mount", target_os = "linux"))]
pub use mount::ErofsMount;
#[cfg(all(feature = "mount", target_os = "linux"))]
pub use mount_manager::{
    BlobPinGuard, BlobPinner, ConsumerRef, MountLease, MountManager, MountManagerConfig,
    MountRecoveryReport, MountState, MountStatus, VerifiedImage,
};
#[cfg(feature = "store")]
pub use store::{BlobDigest, BlobStore, StoreUsage};
