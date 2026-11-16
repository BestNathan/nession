//! Typed Sandbox mount planning, backends and Workspace Overlay ownership
//! (#3695).
//!
//! | Thing | Owner |
//! |---|---|
//! | Plan shape, host-view → Sandbox-target binding, consumer identity | [`plan`] |
//! | Legacy-free EROFS read-only mount manager | `nession_erofs::mount_manager` |
//! | Physical Workspace Overlay, upper ownership, recovery | [`overlay`] |
//! | One execution's views, recovery bindings and explicit release | [`view`] |
//!
//! The plan never carries a host mountpoint. A backend derives the physical
//! view from the typed source, and the execution record persists the manager's
//! authorized identity rather than a caller path.

pub mod backends;
pub mod overlay;
pub mod plan;
pub mod view;

pub use backends::{BindBackend, ErofsRoBackend, MountBackend, OverlayBackend};
pub use plan::{
    ErofsSource, MountCapabilities, MountConsumer, MountPlan, MountPlanEntry, MountRole,
    MountSource, MountSourceKind, MAX_MOUNT_VIEWS,
};
pub use view::{
    MountRecoveryBinding, MountRecoverySource, MountedComposition, MountedView,
    ResolvedComposition, WorkspaceMount,
};
