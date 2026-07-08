//! Self-update system for nession CLI binaries.
//!
//! Provides version detection via GitHub Releases API,
//! SHA256-verified downloads, and atomic binary replacement.

pub mod cache;
pub mod check;
pub mod download;
pub mod github;
pub mod replace;
pub mod version;

use std::path::PathBuf;
use thiserror::Error;

/// Errors that can occur during the update process.
#[derive(Debug, Error)]
pub enum UpdateError {
    #[error("Network error: {0}")]
    Network(String),

    #[error("GitHub API rate limited. Try again later.")]
    RateLimited,

    #[allow(dead_code)]
    #[error("No prebuilt binary for {0}-{1}")]
    UnsupportedPlatform(String, String),

    #[error("Release {0} not found")]
    ReleaseNotFound(String),

    #[error("No asset found matching {0}")]
    AssetNotFound(String),

    #[error("Checksum mismatch: expected {expected}, got {actual}")]
    ChecksumMismatch { expected: String, actual: String },

    #[error("No write permission for {0}")]
    PermissionDenied(PathBuf),

    #[allow(dead_code)]
    #[error("Insufficient disk space: need {need} bytes, have {have} bytes")]
    InsufficientSpace { need: u64, have: u64 },

    #[allow(dead_code)]
    #[error("Binary {name} is running (PID: {pid}). Stop it first.")]
    ProcessRunning { name: String, pid: u32 },

    #[error("Failed to extract archive: {0}")]
    ExtractionFailed(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

impl From<reqwest::Error> for UpdateError {
    fn from(err: reqwest::Error) -> Self {
        UpdateError::Network(err.to_string())
    }
}

/// Outcome for a single binary replacement.
#[derive(Debug)]
pub enum BinaryStatus {
    /// Successfully replaced.
    Replaced(PathBuf),
    /// Skipped (e.g., binary not found).
    Skipped { name: String, reason: String },
    /// Failed to replace.
    Failed { name: String, error: UpdateError },
}

impl BinaryStatus {
    #[allow(dead_code)]
    pub fn name(&self) -> &str {
        match self {
            BinaryStatus::Replaced(_) => "replaced",
            BinaryStatus::Skipped { name, .. } => name.as_str(),
            BinaryStatus::Failed { name, .. } => name.as_str(),
        }
    }

    pub fn is_ok(&self) -> bool {
        matches!(
            self,
            BinaryStatus::Replaced(_) | BinaryStatus::Skipped { .. }
        )
    }
}
