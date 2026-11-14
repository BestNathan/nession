//! Nession's reusable EROFS and OCI image infrastructure (#3022, #3303,
//! #3494/#3496).
//!
//! This crate owns portable image mechanics:
//!
//! - [`blob::digest`]: byte-level `sha256:` identity and file verification;
//! - [`oci`]: standard OCI Index/Manifest/Config/Descriptor model, exact-byte
//!   import and fail-closed v1 EROFS validation (#3495);
//! - [`blob::store`]: a content-addressed, atomically published blob store;
//! - [`catalog`] (feature `catalog`): repository/tag/reference graph, pins,
//!   durable GC marks and legacy digest migration over the Server's SQLite
//!   transaction authority (#3496);
//! - [`image`] (feature `catalog`): Manifest-addressed publish, resolve and
//!   inspect over the catalog and CAS;
//! - [`build`]/[`git`]: a deterministic, non-executing source snapshot and
//!   fixed `mkfs.erofs` build;
//! - [`cache`] (feature `cache`): a durable authenticated download/resume/
//!   verify/pin cache;
//! - [`mount`] (feature `mount`, Linux): an unprivileged EROFS FUSE
//!   mount/unmount primitive with an owned handle.
//!
//! It deliberately does not depend on `nession-protocol`: wire DTOs, image
//! roles, authorization and runtime orchestration stay with their owners.
//! Features let a consumer compile only the mechanics it uses.

pub mod blob;
pub mod oci;

#[cfg(feature = "catalog")]
pub mod catalog;
#[cfg(feature = "catalog")]
pub mod image;

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

pub use blob::digest;
pub use blob::digest::{
    digest_of_bytes, file_digest, is_valid_digest, regular_file_digest, verify_file, DIGEST_PREFIX,
};
#[cfg(feature = "store")]
pub use blob::store;
#[cfg(feature = "store")]
pub use blob::store::{BlobDigest, BlobStore, StoreUsage};
#[cfg(feature = "sources")]
pub use build::archive::{
    fetch_and_extract, ArchiveFetcher, ArchiveFormat, ArchiveLimits, ArchiveReceipt, ArchiveSource,
    ReqwestFetcher,
};
#[cfg(feature = "sources")]
pub use build::import::{
    import_raw_erofs, validate_erofs_file, ImportOutcome, RawErofsImport, EROFS_MAGIC,
    EROFS_MAGIC_OFFSET, MAX_IMPORT_BYTES,
};
#[cfg(feature = "sources")]
pub use build::oci::{
    pinned_digest, OciConversion, OciConversionRequest, OciErofsConverter, ProcessOciConverter,
};
#[cfg(feature = "sources")]
pub use build::publication::{host_platform, image_documents, publish_layer, LayerPublication};
#[cfg(feature = "build")]
pub use build::{
    discard_packaged_image, discard_snapshot_artifacts, manifest_tree, packaged_image_path,
    snapshot_dir, verify_snapshot, BuildObserver, BuildRequest, BuildSource, BuiltImage,
    ErofsBuilder, MkfsRunner, NoopObserver, Packaging, ProcessControl, ProcessMkfsRunner,
    ResumePoint, SnapshotCheckpoint, SnapshotSource, Stage, TreeManifest, TreeStats,
};
#[cfg(feature = "cache")]
pub use cache::{CachedImage, DownloadGrant, ErofsCache, PinGuard};
#[cfg(feature = "build")]
pub use git::{GitCommandRunner, GitSnapshot, GitTarget, ProcessGitRunner};
#[cfg(all(feature = "mount", target_os = "linux"))]
pub use mount::ErofsMount;
#[cfg(all(feature = "mount", target_os = "linux"))]
pub use mount_manager::{
    BlobPinGuard, BlobPinner, ConsumerRef, MountLease, MountManager, MountManagerConfig,
    MountRecoveryReport, MountState, MountStatus, VerifiedImage,
};
