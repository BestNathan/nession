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

pub use capabilities::Capabilities;
pub use error::{Result, SandboxError};
pub use exec::{
    cleanup_record, prepare, probe, reconcile, CleanupReport, ExecutionRecord, LaunchRequest,
    PreparedSandbox, ReconcileOutcome, SandboxExecutionHandle,
};
pub use policy::{compile, CompiledSandboxPolicy};
pub use settings::SandboxSettings;
