//! Execution-scoped cgroup v2 management.
//!
//! The Agent owns one `nession` subtree under its own delegated cgroup and
//! creates one child per execution. The shared tmux server and the Agent are
//! never enrolled: the launcher shell writes its own PID into the execution
//! group *before* it execs Bubblewrap, so every sandboxed descendant inherits
//! the domain while the surrounding processes stay outside it.
//!
//! Two path forms are kept explicitly apart:
//!
//! - the **relative** path (`/system.slice/…/nession/<id>`) is what
//!   `/proc/<pid>/cgroup` reports and what a durable record stores;
//! - the **mount** path (`/sys/fs/cgroup/system.slice/…`) is the directory
//!   control files are read and written through.
//!
//! Confusing the two makes membership verification compare unequal strings and
//! makes restart cleanup re-derive a root the recorded path can never match.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::capabilities::CgroupSupport;
use crate::error::{Result, SandboxError};
use crate::policy::CgroupLimits;
use crate::util::{read_trimmed, wait_until};

/// The cgroup v2 mount point.
pub const CGROUP_MOUNT: &str = "/sys/fs/cgroup";

/// One execution's cgroup directory.
#[derive(Debug, Clone)]
pub struct ExecutionCgroup {
    root_mount: PathBuf,
    relative_path: PathBuf,
    mount_path: PathBuf,
    limits: CgroupLimits,
}

impl ExecutionCgroup {
    /// The directory the launcher writes its PID into.
    pub fn procs_file(&self) -> PathBuf {
        self.mount_path.join("cgroup.procs")
    }

    /// The execution's kernel cgroup path, as `/proc/<pid>/cgroup` reports it.
    pub fn relative_path(&self) -> &Path {
        &self.relative_path
    }

    /// The execution's directory under the cgroup mount.
    pub fn mount_path(&self) -> &Path {
        &self.mount_path
    }

    /// PIDs currently in the domain.
    pub fn members(&self) -> Result<Vec<u32>> {
        let text = read_trimmed(&self.mount_path.join("cgroup.procs")).map_err(|error| {
            SandboxError::Prepare(format!("read {}: {error}", self.mount_path.display()))
        })?;
        Ok(text
            .lines()
            .filter_map(|line| line.trim().parse().ok())
            .collect())
    }

    /// Read back the effective values and compare with what was written.
    pub fn verify_limits(&self) -> Result<()> {
        for (file, expected) in self.limits.files() {
            let actual = read_trimmed(&self.mount_path.join(file)).map_err(|error| {
                SandboxError::Prepare(format!(
                    "read effective {file} in {}: {error}",
                    self.mount_path.display()
                ))
            })?;
            if actual != expected {
                return Err(SandboxError::Prepare(format!(
                    "kernel reports {file}={actual}, requested {expected}"
                )));
            }
        }
        Ok(())
    }

    /// Observed counters, captured as evidence rather than inferred.
    pub fn evidence(&self) -> Vec<(String, String)> {
        let mut rows = Vec::new();
        for file in [
            "memory.max",
            "cpu.max",
            "pids.max",
            "memory.oom.group",
            "memory.events",
            "pids.events",
            "cpu.stat",
        ] {
            if let Ok(value) = read_trimmed(&self.mount_path.join(file)) {
                rows.push((file.to_string(), value));
            }
        }
        rows
    }

    /// Remove this execution's directory.
    ///
    /// An empty directory is removed directly. A populated one is killed first
    /// with `cgroup.kill`, which can only affect processes inside this
    /// execution's own domain — never the shared tmux server, the Agent or
    /// another execution. The directory and its record are kept when it still
    /// cannot be emptied, so reconciliation can try again.
    pub fn remove(&self) -> Result<()> {
        if self.members()?.is_empty() {
            return self.remove_dir();
        }

        let kill = self.mount_path.join("cgroup.kill");
        if let Err(error) = std::fs::write(&kill, "1") {
            if error.kind() != io::ErrorKind::NotFound {
                return Err(SandboxError::Cleanup(format!(
                    "kill {}: {error}",
                    self.mount_path.display()
                )));
            }
            // Kernel without cgroup.kill: signal the members individually.
            for pid in self.members()? {
                // SAFETY: sending SIGKILL to a PID read from our own cgroup.
                unsafe {
                    libc::kill(pid as libc::pid_t, libc::SIGKILL);
                }
            }
        }

        if !wait_until(Duration::from_secs(5), Duration::from_millis(50), || {
            self.members()
                .map(|members| members.is_empty())
                .unwrap_or(false)
        }) {
            return Err(SandboxError::Cleanup(format!(
                "{} still contains processes after SIGKILL",
                self.mount_path.display()
            )));
        }
        self.remove_dir()
    }

    fn remove_dir(&self) -> Result<()> {
        std::fs::remove_dir(&self.mount_path).map_err(|error| {
            SandboxError::Cleanup(format!("remove {}: {error}", self.mount_path.display()))
        })?;
        // The root is Agent-owned and shared; removing it is best effort only
        // when it is empty, so a concurrent execution keeps it.
        let _ = std::fs::remove_dir(&self.root_mount);
        Ok(())
    }
}

/// Probe the delegated subtree and create/verify an execution group.
#[derive(Debug, Clone)]
pub struct CgroupManager {
    root_mount: PathBuf,
    relative_root: PathBuf,
}

impl CgroupManager {
    /// Probe the delegated subtree named by its **relative** kernel path.
    pub fn probe(relative_root: PathBuf) -> Option<CgroupSupport> {
        let mount = PathBuf::from(CGROUP_MOUNT);
        if !mount.join("cgroup.controllers").exists() {
            return None;
        }
        let root_mount = mount_join(&relative_root)?;
        std::fs::create_dir_all(&root_mount).ok()?;
        let controllers = read_trimmed(&root_mount.join("cgroup.controllers")).ok()?;
        let available: std::collections::BTreeSet<String> =
            controllers.split_whitespace().map(str::to_string).collect();
        if available.is_empty() {
            return None;
        }

        // Enable every readable controller for children of the execution root.
        // The root contains no processes, so the kernel's no-internal-process
        // rule permits this. A controller the kernel refuses stays absent from
        // the reported set, and a policy that requests it fails closed.
        let mut delegated = std::collections::BTreeSet::new();
        let mut notes = Vec::new();
        for controller in &available {
            match std::fs::write(
                root_mount.join("cgroup.subtree_control"),
                format!("+{controller}"),
            ) {
                Ok(()) => {
                    delegated.insert(controller.clone());
                }
                Err(error) => notes.push(format!("{controller}: {error}")),
            }
        }

        // Prove a child directory and a control file can actually be created
        // and written, rather than inferring from the parent's files. The probe
        // name is unique per call so concurrent creates cannot delete each
        // other's fixture.
        let probe_path = root_mount.join(format!(".probe-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::remove_dir(&probe_path);
        if std::fs::create_dir(&probe_path).is_err() {
            let _ = std::fs::remove_dir(&probe_path);
            return None;
        }
        let child_controllers =
            read_trimmed(&probe_path.join("cgroup.controllers")).unwrap_or_default();
        let mut writable = false;
        if child_controllers.split_whitespace().any(|c| c == "pids") {
            writable = std::fs::write(probe_path.join("pids.max"), "max").is_ok();
        } else if !child_controllers.is_empty() {
            // A delegated controller exists, but pids is not among them; the
            // execution can still be limited by whatever the policy requests.
            writable = true;
        }
        let created = probe_path.exists();
        // A cgroup directory is removed with rmdir. `remove_dir_all` walks the
        // virtual control files and can leave the fixture behind.
        let _ = std::fs::remove_dir(&probe_path);
        if !created || !writable {
            return None;
        }

        Some(CgroupSupport {
            root: root_mount,
            relative_root,
            controllers: delegated,
            detail: if notes.is_empty() {
                "delegated writable cgroup v2 subtree".to_string()
            } else {
                format!("delegated; unavailable controllers: {}", notes.join(", "))
            },
        })
    }

    /// Bind a manager to the probed subtree.
    pub fn new(support: &CgroupSupport) -> Self {
        Self {
            root_mount: support.root.clone(),
            relative_root: support.relative_root.clone(),
        }
    }

    /// Create and limit the execution directory. On any failure the partial
    /// directory is removed before the error is returned.
    pub fn create_execution(
        &self,
        execution_id: &str,
        limits: &CgroupLimits,
    ) -> Result<ExecutionCgroup> {
        let mount_path = self.root_mount.join(execution_id);
        std::fs::create_dir(&mount_path).map_err(|error| {
            SandboxError::Prepare(format!("create cgroup {}: {error}", mount_path.display()))
        })?;
        let group = ExecutionCgroup {
            root_mount: self.root_mount.clone(),
            relative_path: self.relative_root.join(execution_id),
            mount_path,
            limits: limits.clone(),
        };
        let result = (|| {
            for (file, value) in limits.files() {
                std::fs::write(group.mount_path.join(file), value).map_err(|error| {
                    SandboxError::Prepare(format!(
                        "write {file} in {}: {error}",
                        group.mount_path.display()
                    ))
                })?;
            }
            group.verify_limits()
        })();
        if let Err(error) = result {
            let _ = group.remove();
            return Err(error);
        }
        Ok(group)
    }
}

fn mount_join(relative: &Path) -> Option<PathBuf> {
    let relative = relative.strip_prefix("/").ok()?;
    Some(Path::new(CGROUP_MOUNT).join(relative))
}

/// Remove an execution cgroup named by a durable record.
///
/// The record stores the **relative** kernel path. Only a direct child of the
/// current Nession-owned root is accepted, so a damaged or edited record cannot
/// point cleanup at an unrelated cgroup.
pub fn remove_execution(root_relative: &Path, recorded_relative: &Path) -> Result<()> {
    if !root_relative.is_absolute() || recorded_relative.parent() != Some(root_relative) {
        return Err(SandboxError::Cleanup(format!(
            "refusing to remove {}: not a direct child of the Nession cgroup root {}",
            recorded_relative.display(),
            root_relative.display()
        )));
    }
    let Some(mount_path) = mount_join(recorded_relative) else {
        return Err(SandboxError::Cleanup(format!(
            "invalid cgroup record {}",
            recorded_relative.display()
        )));
    };
    if !mount_path.exists() {
        return Ok(());
    }
    let Some(root_mount) = mount_join(root_relative) else {
        return Err(SandboxError::Cleanup("invalid cgroup root".to_string()));
    };
    let group = ExecutionCgroup {
        root_mount,
        relative_path: recorded_relative.to_path_buf(),
        mount_path,
        limits: CgroupLimits::default(),
    };
    group.remove()
}

/// Whether a `0::/path` cgroup entry names `expected` (relative form).
pub fn cgroup_entry_matches(entry: &str, expected: &Path) -> bool {
    let Some(path) = entry.strip_prefix("0::") else {
        return false;
    };
    Path::new(path.trim()) == expected
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cgroup_entries_match_the_exact_domain() {
        assert!(cgroup_entry_matches(
            "0::/nession/abc",
            Path::new("/nession/abc")
        ));
        assert!(!cgroup_entry_matches(
            "0::/nession/abcd",
            Path::new("/nession/abc")
        ));
        assert!(!cgroup_entry_matches("2::/x", Path::new("/x")));
    }

    #[test]
    fn mount_join_keeps_the_kernel_path_separate_from_the_mount_path() {
        assert_eq!(
            mount_join(Path::new("/a/b")).as_deref(),
            Some(Path::new("/sys/fs/cgroup/a/b"))
        );
        assert_eq!(mount_join(Path::new("a/b")), None);
    }

    #[test]
    fn cleanup_refuses_a_path_that_is_not_a_direct_child_of_the_root() {
        assert!(remove_execution(Path::new("/nession"), Path::new("/other/abc")).is_err());
        assert!(remove_execution(Path::new("/nession"), Path::new("/nession/a/b")).is_err());
        assert!(remove_execution(Path::new("nession"), Path::new("/nession/abc")).is_err());
    }
}
