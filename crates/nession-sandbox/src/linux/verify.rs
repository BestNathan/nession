//! Launch verification.
//!
//! The in-sandbox bridge reports facts from *inside* the sandbox after the
//! namespaces, cgroup and seccomp filter are installed but before any user code
//! runs. The Agent compares those facts with the host's own namespace identities
//! and with `/proc` for the bridge's host PID — so a report cannot be fabricated
//! by substituting a different process, and a missing control refuses the
//! launch instead of being assumed present.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::error::{Result, SandboxError};
use crate::linux::channel::ControlPeer;
use crate::util::is_descendant_of;

/// What the caller requires the launch to prove.
#[derive(Debug, Clone)]
pub struct VerifyRequest<'a> {
    pub peer: &'a ControlPeer,
    pub pane_pid: u32,
    pub expected_execution_id: &'a str,
    pub expected_cgroup: Option<&'a Path>,
    pub require_network_isolation: bool,
    pub require_cgroup_namespace: bool,
    pub visible_probes: &'a [PathBuf],
    pub hidden_probes: &'a [PathBuf],
}

/// Observed facts, retained as evidence.
#[derive(Debug, Clone)]
pub struct VerifiedFacts {
    pub sandbox_pid: u32,
    pub namespaces: BTreeMap<String, String>,
    pub cgroup: Option<String>,
    pub seccomp: String,
    pub no_new_privs: String,
    pub filesystem_probes: usize,
}

/// Compare the bridge's report with the host's observed state.
pub fn verify(request: &VerifyRequest<'_>) -> Result<VerifiedFacts> {
    let peer = request.peer;
    if !peer.execution_id_ok() {
        return Err(SandboxError::Verify(
            "the sandbox init named a different execution".to_string(),
        ));
    }
    let facts = peer
        .facts()
        .ok_or_else(|| SandboxError::Verify("the sandbox init reported no facts".to_string()))?;
    let _ = request.expected_execution_id;

    if !is_descendant_of(peer.pid(), request.pane_pid) {
        return Err(SandboxError::Verify(format!(
            "the channel peer {} is not a descendant of the Pane process {}",
            peer.pid(),
            request.pane_pid
        )));
    }
    if facts.ns_pid != 1 {
        return Err(SandboxError::Verify(format!(
            "the sandbox init has in-namespace PID {}, not 1",
            facts.ns_pid
        )));
    }

    let mut required = vec!["mnt", "pid", "user", "ipc", "uts"];
    if request.require_network_isolation {
        required.push("net");
    }
    if request.require_cgroup_namespace {
        required.push("cgroup");
    }
    for namespace in required {
        let host = host_namespace(namespace)?;
        let sandbox = facts.namespaces.get(namespace).ok_or_else(|| {
            SandboxError::Verify(format!(
                "the sandbox init did not report the {namespace} namespace"
            ))
        })?;
        if sandbox == &host {
            return Err(SandboxError::Verify(format!(
                "the sandbox shares the host {namespace} namespace"
            )));
        }
    }

    if facts.seccomp != "2" {
        return Err(SandboxError::Verify(format!(
            "seccomp filter mode is `{}`, expected `2`",
            facts.seccomp
        )));
    }
    if facts.no_new_privs != "1" {
        return Err(SandboxError::Verify(format!(
            "NoNewPrivs is `{}`, expected `1`",
            facts.no_new_privs
        )));
    }

    if let Some(expected) = request.expected_cgroup {
        let expected_entry = format!("0::{}", expected.display());
        if facts.cgroup != expected_entry {
            return Err(SandboxError::Verify(format!(
                "the sandbox init reports cgroup `{}`, expected `{expected_entry}`",
                facts.cgroup
            )));
        }
        let host_entry = read_cgroup_entry(peer.pid())?;
        if host_entry != expected_entry {
            return Err(SandboxError::Verify(format!(
                "host /proc reports cgroup `{host_entry}` for the init, expected `{expected_entry}`"
            )));
        }
    }

    for probe in request.visible_probes {
        let probe = probe.to_string_lossy().into_owned();
        if !facts.visible.contains(&probe) {
            return Err(SandboxError::Verify(format!(
                "visible path `{probe}` was not confirmed inside the sandbox"
            )));
        }
    }
    for probe in request.hidden_probes {
        let probe = probe.to_string_lossy().into_owned();
        if !facts.hidden.contains(&probe) {
            return Err(SandboxError::Verify(format!(
                "hidden path `{probe}` was not confirmed absent inside the sandbox"
            )));
        }
    }
    if !facts.probe_errors.is_empty() {
        return Err(SandboxError::Verify(format!(
            "sandbox filesystem probes could not be answered: {}",
            facts.probe_errors.join(", ")
        )));
    }

    Ok(VerifiedFacts {
        sandbox_pid: peer.pid(),
        namespaces: facts.namespaces.clone(),
        cgroup: request
            .expected_cgroup
            .map(|path| path.display().to_string()),
        seccomp: facts.seccomp.clone(),
        no_new_privs: facts.no_new_privs.clone(),
        filesystem_probes: request.visible_probes.len() + request.hidden_probes.len(),
    })
}

fn host_namespace(name: &str) -> Result<String> {
    let path = format!("/proc/self/ns/{name}");
    std::fs::read_link(&path)
        .map(|target| target.to_string_lossy().into_owned())
        .map_err(|error| SandboxError::Verify(format!("read {path}: {error}")))
}

fn read_cgroup_entry(pid: u32) -> Result<String> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/cgroup"))
        .map_err(|error| SandboxError::Verify(format!("read /proc/{pid}/cgroup: {error}")))?;
    text.lines()
        .find(|line| line.starts_with("0::"))
        .map(str::to_string)
        .ok_or_else(|| SandboxError::Verify(format!("/proc/{pid}/cgroup has no v2 entry")))
}
