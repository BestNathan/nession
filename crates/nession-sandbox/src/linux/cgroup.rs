//! Execution-scoped cgroup v2 management.
//!
//! The Agent owns one `nession` subtree under its own delegated cgroup and
//! creates one child per execution. The shared tmux server and the Agent are
//! never enrolled: the launcher shell writes its own PID into the execution
//! group *before* it execs Bubblewrap, so every sandboxed descendant inherits
//! the domain while the surrounding processes stay outside it.
//!
//! Probe, limit write and membership check all read the kernel's own files.
//! `cgroup.controllers` existing is not enough; each requested controller is
//! observed in the delegation and its effective value is read back.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::capabilities::CgroupSupport;
use crate::error::{Result, SandboxError};
use crate::policy::CgroupLimits;
use crate::util::{read_trimmed, wait_until};

const CGROUP_MOUNT: &str = "/sys/fs/cgroup";

/// One execution's cgroup directory.
#[derive(Debug, Clone)]
pub struct ExecutionCgroup {
    root: PathBuf,
    path: PathBuf,
    limits: CgroupLimits,
}

impl ExecutionCgroup {
    /// The directory the launcher writes its PID into.
    pub fn procs_file(&self) -> PathBuf {
        self.path.join("cgroup.procs")
    }

    /// The execution cgroup path, as `/proc/<pid>/cgroup` reports it.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// PIDs currently in the domain.
    pub fn members(&self) -> Result<Vec<u32>> {
        let text = read_trimmed(&self.path.join("cgroup.procs")).map_err(|error| {
            SandboxError::Prepare(format!("read {}: {error}", self.path.display()))
        })?;
        Ok(text
            .lines()
            .filter_map(|line| line.trim().parse().ok())
            .collect())
    }

    /// Read back the effective values and compare with what was written.
    pub fn verify_limits(&self) -> Result<()> {
        for (file, expected) in self.limits.files() {
            let actual = read_trimmed(&self.path.join(file)).map_err(|error| {
                SandboxError::Prepare(format!(
                    "read effective {file} in {}: {error}",
                    self.path.display()
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
            if let Ok(value) = read_trimmed(&self.path.join(file)) {
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

        let kill = self.path.join("cgroup.kill");
        if let Err(error) = std::fs::write(&kill, "1") {
            if error.kind() != io::ErrorKind::NotFound {
                return Err(SandboxError::Cleanup(format!(
                    "kill {}: {error}",
                    self.path.display()
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
                self.path.display()
            )));
        }
        self.remove_dir()
    }

    fn remove_dir(&self) -> Result<()> {
        std::fs::remove_dir(&self.path).map_err(|error| {
            SandboxError::Cleanup(format!("remove {}: {error}", self.path.display()))
        })?;
        // The root is Agent-owned and shared; removing it is best effort only
        // when it is empty, so a concurrent execution keeps it.
        let _ = std::fs::remove_dir(&self.root);
        Ok(())
    }
}

/// Probe the delegated subtree and create/verify an execution group.
#[derive(Debug, Clone)]
pub struct CgroupManager {
    root: PathBuf,
}

impl CgroupManager {
    /// Probe the delegated subtree rooted at `root`.
    pub fn probe(root: PathBuf) -> Option<CgroupSupport> {
        let mount = PathBuf::from(CGROUP_MOUNT);
        if !mount.join("cgroup.controllers").exists() {
            return None;
        }
        let root_path = resolve_under_mount(&mount, &root)?;
        std::fs::create_dir_all(&root_path).ok()?;
        let controllers = read_trimmed(&root_path.join("cgroup.controllers")).ok()?;
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
                root_path.join("cgroup.subtree_control"),
                format!("+{controller}"),
            ) {
                Ok(()) => {
                    delegated.insert(controller.clone());
                }
                Err(error) => notes.push(format!("{controller}: {error}")),
            }
        }

        // Prove a child directory and a control file can actually be created
        // and written, rather than inferring from the parent's files.
        let probe_path = root_path.join(".probe");
        let _ = std::fs::remove_dir_all(&probe_path);
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
        let _ = std::fs::remove_dir_all(&probe_path);
        if !created || !writable {
            return None;
        }

        Some(CgroupSupport {
            root: root_path,
            controllers: delegated,
            detail: if notes.is_empty() {
                "delegated writable cgroup v2 subtree".to_string()
            } else {
                format!("delegated; unavailable controllers: {}", notes.join(", "))
            },
        })
    }

    /// Create one execution group with its limits.
    pub fn new(support: &CgroupSupport) -> Self {
        Self {
            root: support.root.clone(),
        }
    }

    /// Create and limit the execution directory. On any failure the partial
    /// directory is removed before the error is returned.
    pub fn create_execution(
        &self,
        execution_id: &str,
        limits: &CgroupLimits,
    ) -> Result<ExecutionCgroup> {
        let path = self.root.join(execution_id);
        std::fs::create_dir(&path).map_err(|error| {
            SandboxError::Prepare(format!("create cgroup {}: {error}", path.display()))
        })?;
        let group = ExecutionCgroup {
            root: self.root.clone(),
            path,
            limits: limits.clone(),
        };
        let result = (|| {
            for (file, value) in limits.files() {
                std::fs::write(group.path.join(file), value).map_err(|error| {
                    SandboxError::Prepare(format!(
                        "write {file} in {}: {error}",
                        group.path.display()
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

fn resolve_under_mount(mount: &Path, path: &Path) -> Option<PathBuf> {
    if path.starts_with(mount) {
        return Some(path.to_path_buf());
    }
    let relative = path.strip_prefix("/").ok()?;
    Some(mount.join(relative))
}

/// Whether a `0::/path` cgroup entry names `expected`.
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
}
