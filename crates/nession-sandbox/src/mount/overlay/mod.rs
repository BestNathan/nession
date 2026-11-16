//! Shared writable OverlayFS management (#3582).
//!
//! One managed Workspace has one durable `upper`/`work` pair and therefore one
//! physical `fuse-overlayfs` Merged View per Agent identity and mount
//! namespace. Multiple identified Sandbox execution consumers lease that same
//! Merged View; the last release safely unmounts it without deleting durable
//! bytes.
//!
//! Ownership is split deliberately:
//!
//! | Thing | Owner |
//! |---|---|
//! | Workspace identity, registry, durable `upper`/`work`, lower binding, deletion | Agent Workspace Manager |
//! | Physical Overlay mount, consumers, generation, recovery | [`OverlayMountManager`] |
//! | Read-only EROFS lower mount | [`nession_erofs::mount_manager::MountManager`] |
//! | Execution isolation, launch barrier, execution record | `nession-sandbox` |
//!
//! This is the Sandbox-domain owner of the Workspace Overlay physical mount
//! (#3695). The reusable EROFS read-only mount manager stays in
//! `nession-erofs`; workspace identity crosses this boundary only as an
//! authorized root plus a validated relative key.

pub mod manager;
pub mod mount;
pub mod probe;
pub mod recovery;
pub mod state;
pub mod storage;

pub use manager::{
    LowerAdoption, LowerLease, LowerProvider, LowerStatus, OverlayLease, OverlayMountManager,
    OverlayMountManagerConfig, OverlayRequest, ProtectedWorkspaces, ACQUIRE_WAIT_TIMEOUT,
    MAX_OVERLAY_LOWERS,
};
pub use mount::{OverlayMountSpec, OverlaySettings};
pub use probe::{StorageFacts, StorageSupport};
pub use state::{
    OverlayBinding, OverlayConsumerRef, OverlayLowerBinding, OverlayLowerRef,
    OverlayRecoveryReport, OverlayState, OverlayStatus,
};
pub use storage::{OverlayStoragePaths, OverlayWorkspaceKey, OwnerRecord};
