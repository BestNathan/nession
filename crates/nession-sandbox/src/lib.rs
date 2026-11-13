//! Nession Sandbox: policy validation, capability probing and native
//! execution isolation (#2681).
//!
//! The crate owns one optional [`SandboxPolicy`](nession_protocol::contracts::sandbox::v1::SandboxPolicy)
//! binding for a Session:
//!
//! ```text
//! compile/validate (no host resources)
//!   -> probe the actual host capability
//!   -> prepare owned resources (cgroup, channel, profile, record)
//!   -> tmux starts the trusted launcher
//!   -> the in-sandbox bridge reports facts and waits
//!   -> the host verifies the facts and releases the launch barrier
//!   -> the user's shell runs
//! ```
//!
//! A requested guarantee that cannot be installed refuses the launch. There is
//! no fallback to a Native execution.

pub mod bridge;
pub mod capabilities;
mod cgroup_file;
pub mod draft;
pub mod error;
pub mod exec;
pub mod facts;
pub mod network;
pub mod policy;
pub mod settings;
mod util;

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;

pub use capabilities::{catalog, Capabilities};
pub use draft::{draft_from_policy, materialize, materialize_with_composition};
pub use error::{Result, SandboxError};
pub use exec::{
    cleanup_record, preflight, preflight_unprepared_composition, prepare, probe, reconcile,
    CleanupReport, ExecutionRecord, LaunchRequest, LivePane, PreflightReport, PreparedSandbox,
    ReconcileOutcome, SandboxExecutionHandle, SharedMountRecord,
};
pub use policy::{compile, hex_sha256, requested_mechanisms, CompiledSandboxPolicy};
pub use settings::SandboxSettings;
