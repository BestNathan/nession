//! Observable state, durable binding and recovery reports for shared
//! writable Overlays (#3582).
//!
//! The distinction the recovery contract needs is explicit:
//!
//! - **Idle**: the durable upper/work exist and no physical Overlay is mounted;
//! - **Mounted**: one physical Merged View has at least one identified
//!   consumer;
//! - **Failed**: a mount or unmount failed but the recoverable resources (the
//!   live mount, the lower pin, the durable identity and the durable bytes)
//!   were retained for a bounded retry;
//! - **Orphaned**: a mount exists that this manager cannot prove it created
//!   (identity/generation/namespace mismatch). It is never adopted and never
//!   served as ready.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::storage::OverlayWorkspaceKey;

/// The observable phase of one workspace's physical Overlay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayState {
    /// Durable storage exists; nothing is mounted.
    Idle,
    /// A mount transition is in progress.
    Mounting,
    /// A physical Merged View is mounted and leased.
    Mounted,
    /// An unmount transition is in progress.
    Unmounting,
    /// A transition failed and retained recoverable state for a retry.
    Failed,
    /// A mount exists without a verified manager identity.
    Orphaned,
}

/// Read-only status for one managed workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverlayStatus {
    pub workspace: OverlayWorkspaceKey,
    pub mountpoint: PathBuf,
    pub generation: Option<String>,
    pub state: OverlayState,
    /// `true` only while mountinfo currently reports a `fuse-overlayfs` mount.
    pub mounted: bool,
    /// `true` only when this manager instance proved the durable identity,
    /// owner lock and mountinfo agree. A read-only durable lookup is never
    /// verified.
    pub verified: bool,
    pub consumers: usize,
    pub lower_digest: Option<String>,
    /// `true` while the read-only EROFS lower is still a live mount.
    pub lower_mounted: bool,
    pub failure: Option<String>,
}

/// One identified consumer persisted in a Sandbox execution record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverlayConsumerRef {
    pub workspace: OverlayWorkspaceKey,
    pub execution_id: String,
    pub generation: String,
    pub lower_digest: String,
    pub lower_generation: String,
}

/// The durable binding of one physical Merged View.
///
/// This is what a Sandbox execution persists. It names the authorized
/// workspace identity, never a caller-supplied mountpoint or upper path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OverlayBinding {
    pub workspace: OverlayWorkspaceKey,
    pub mountpoint: PathBuf,
    pub generation: String,
    pub lower_digest: String,
    pub lower_mountpoint: PathBuf,
    pub lower_generation: String,
}

impl OverlayBinding {
    pub fn consumer(&self, execution_id: &str) -> OverlayConsumerRef {
        OverlayConsumerRef {
            workspace: self.workspace.clone(),
            execution_id: execution_id.to_string(),
            generation: self.generation.clone(),
            lower_digest: self.lower_digest.clone(),
            lower_generation: self.lower_generation.clone(),
        }
    }
}

/// The result of restart reconciliation.
#[derive(Debug, Default, Clone)]
pub struct OverlayRecoveryReport {
    /// `(workspace identity, execution id)` pairs whose consumer was adopted.
    pub adopted: Vec<(String, String)>,
    /// `(workspace identity, reason)` pairs that could not be adopted/served.
    pub unavailable: Vec<(String, String)>,
    /// Workspace identities whose physical mount was reclaimed.
    pub reclaimed: Vec<String>,
    /// `(workspace identity, reason)` pairs whose reclamation remains retryable.
    pub reclaim_failed: Vec<(String, String)>,
}

impl OverlayRecoveryReport {
    pub fn evidence_lines(&self) -> Vec<String> {
        let mut lines = Vec::new();
        for (workspace, execution) in &self.adopted {
            lines.push(format!("overlay-adopted={workspace}:{execution}"));
        }
        for (workspace, reason) in &self.unavailable {
            lines.push(format!("overlay-unavailable={workspace}:{reason}"));
        }
        for workspace in &self.reclaimed {
            lines.push(format!("overlay-reclaimed={workspace}"));
        }
        for (workspace, reason) in &self.reclaim_failed {
            lines.push(format!("overlay-reclaim-failed={workspace}:{reason}"));
        }
        lines
    }
}
