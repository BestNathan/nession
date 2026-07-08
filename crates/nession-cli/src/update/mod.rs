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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_status_name_replaced() {
        let s = BinaryStatus::Replaced(PathBuf::from("/usr/local/bin/nession"));
        assert_eq!(s.name(), "replaced");
    }

    #[test]
    fn binary_status_name_skipped() {
        let s = BinaryStatus::Skipped {
            name: "nession-agent".into(),
            reason: "not found".into(),
        };
        assert_eq!(s.name(), "nession-agent");
    }

    #[test]
    fn binary_status_name_failed() {
        let s = BinaryStatus::Failed {
            name: "nession-server".into(),
            error: UpdateError::PermissionDenied(PathBuf::from("/usr/bin")),
        };
        assert_eq!(s.name(), "nession-server");
    }

    #[test]
    fn binary_status_is_ok() {
        assert!(BinaryStatus::Replaced(PathBuf::from("/tmp/x")).is_ok());
        assert!(BinaryStatus::Skipped {
            name: "x".into(),
            reason: "r".into()
        }
        .is_ok());
        assert!(!BinaryStatus::Failed {
            name: "x".into(),
            error: UpdateError::RateLimited
        }
        .is_ok());
    }

    #[test]
    fn update_error_display() {
        let err = UpdateError::RateLimited;
        assert_eq!(err.to_string(), "GitHub API rate limited. Try again later.");

        let err = UpdateError::ReleaseNotFound("0.1.0".into());
        assert!(err.to_string().contains("0.1.0"));

        let err = UpdateError::ChecksumMismatch {
            expected: "abc".into(),
            actual: "def".into(),
        };
        assert!(err.to_string().contains("abc"));
        assert!(err.to_string().contains("def"));

        let err = UpdateError::PermissionDenied(PathBuf::from("/usr/local"));
        assert!(err.to_string().contains("/usr/local"));

        let err = UpdateError::Network("connection reset".into());
        assert!(err.to_string().contains("connection reset"));

        let err = UpdateError::AssetNotFound("nession-0.5.0-linux-amd64.tar.gz".into());
        assert!(err.to_string().contains("nession-0.5.0-linux-amd64.tar.gz"));

        let err = UpdateError::ExtractionFailed("unexpected EOF".into());
        assert!(err.to_string().contains("unexpected EOF"));

        let err = UpdateError::Io(std::io::Error::new(std::io::ErrorKind::NotFound, "no file"));
        assert!(err.to_string().contains("no file"));

        let err = UpdateError::UnsupportedPlatform("linux".into(), "riscv64".into());
        assert!(err.to_string().contains("linux"));
        assert!(err.to_string().contains("riscv64"));

        let err = UpdateError::InsufficientSpace {
            need: 1000,
            have: 500,
        };
        assert!(err.to_string().contains("1000"));
        assert!(err.to_string().contains("500"));

        let err = UpdateError::ProcessRunning {
            name: "nession".into(),
            pid: 12345,
        };
        assert!(err.to_string().contains("nession"));
        assert!(err.to_string().contains("12345"));
    }
}
