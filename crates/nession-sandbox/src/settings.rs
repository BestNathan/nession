//! Host-local backend configuration.
//!
//! The policy is the caller's request; these are the Agent operator's facts
//! about this host. They are separate on purpose: a policy never chooses an
//! executable, a cgroup root or a state directory.

use std::path::PathBuf;
use std::time::Duration;

/// Where the Agent's sandbox machinery lives on this host.
#[derive(Debug, Clone)]
pub struct SandboxSettings {
    /// Operator master switch. When false, every policy request fails closed.
    pub enabled: bool,
    /// The Bubblewrap executable.
    pub bubblewrap_path: PathBuf,
    /// The macOS `sandbox-exec` executable.
    pub sandbox_exec_path: PathBuf,
    /// Agent-private directory for execution records and profiles.
    pub state_dir: PathBuf,
    /// Agent-owned short root for one execution's Unix channel directory.
    ///
    /// A Unix socket path must fit the kernel's `SUN_LEN` (~108 bytes), and
    /// `state_dir` is operator-configurable and may be arbitrarily deep. The
    /// channel therefore lives in a fixed short root keyed by the execution
    /// id; the durable record names the exact directory for cleanup.
    pub runtime_root: PathBuf,
    /// Optional cgroup root override. Defaults to a `nession` subtree under
    /// the Agent's own cgroup.
    pub cgroup_root: Option<PathBuf>,
    /// Bound for one launch-verification wait.
    pub launch_timeout: Duration,
    /// Executable that provides the in-sandbox bridge subcommand. Defaults to
    /// the Agent binary, which ships the bridge as a hidden subcommand so no
    /// second artifact is needed inside the sandbox.
    pub bridge_executable: PathBuf,
    /// The hidden subcommand name the bridge dispatches on.
    pub bridge_subcommand: String,
    /// The trusted launcher shell that enrolls the cgroup and seccomp FD.
    pub launcher_shell: PathBuf,
    /// Agent-authorized root containing prepared EROFS images. A composition
    /// may mount only files beneath this directory.
    pub erofs_image_root: Option<PathBuf>,
    /// The unprivileged EROFS FUSE helper.
    pub erofsfuse_path: PathBuf,
    /// The FUSE unmount helper.
    pub fusermount_path: PathBuf,
    /// Unprivileged OverlayFS helper used when a Project image must be merged
    /// with an Agent-owned writable upper/work.
    pub fuse_overlayfs_path: PathBuf,
    /// Agent-private directories (identity, credentials, configuration) that
    /// must never be visible inside a sandbox.
    pub private_directories: Vec<PathBuf>,
}

impl SandboxSettings {
    /// Build settings for one host. The caller owns defaults for its config.
    pub fn new(
        state_dir: PathBuf,
        bridge_executable: PathBuf,
        bubblewrap_path: PathBuf,
        sandbox_exec_path: PathBuf,
    ) -> Self {
        Self {
            enabled: true,
            bubblewrap_path,
            sandbox_exec_path,
            state_dir,
            runtime_root: std::path::PathBuf::from("/tmp/nession-sandbox"),
            cgroup_root: None,
            launch_timeout: Duration::from_secs(10),
            bridge_executable,
            bridge_subcommand: "__nession-sandbox-bridge".to_string(),
            launcher_shell: PathBuf::from("/bin/sh"),
            erofs_image_root: None,
            erofsfuse_path: PathBuf::from("erofsfuse"),
            fusermount_path: PathBuf::from("fusermount3"),
            fuse_overlayfs_path: PathBuf::from("fuse-overlayfs"),
            private_directories: Vec::new(),
        }
    }

    /// The default cgroup root under the Agent's own cgroup path.
    pub fn resolved_cgroup_root(&self) -> Option<PathBuf> {
        if let Some(root) = &self.cgroup_root {
            return Some(root.clone());
        }
        let own = cgroup::own_cgroup_path()?;
        Some(own.join("nession"))
    }
}

/// The Agent's own cgroup v2 path from `/proc/self/cgroup`.
#[cfg(target_os = "linux")]
pub mod cgroup {
    use std::path::PathBuf;

    /// `0::/path` is the cgroup v2 entry. A host without one returns `None`.
    pub fn own_cgroup_path() -> Option<PathBuf> {
        let text = std::fs::read_to_string("/proc/self/cgroup").ok()?;
        for line in text.lines() {
            let path = line.strip_prefix("0::")?;
            if path.starts_with('/') {
                return Some(PathBuf::from(path));
            }
        }
        None
    }
}

#[cfg(not(target_os = "linux"))]
mod cgroup {
    use std::path::PathBuf;

    pub fn own_cgroup_path() -> Option<PathBuf> {
        None
    }
}
