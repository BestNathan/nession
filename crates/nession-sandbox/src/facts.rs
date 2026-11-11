//! Facts the in-sandbox bridge reports over the trusted channel.
//!
//! They are collected after the namespaces, cgroup and seccomp filter are
//! installed and before any user code runs. The host compares them with its own
//! observations rather than trusting them on their own.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Facts reported by the bridge before user code starts.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BridgeFacts {
    /// The bridge's PID inside its PID namespace (must be 1).
    pub ns_pid: u32,
    /// `/proc/self/ns/*` link targets.
    pub namespaces: BTreeMap<String, String>,
    /// `0::<path>` from `/proc/self/cgroup`.
    pub cgroup: String,
    /// `Seccomp:` from `/proc/self/status`.
    pub seccomp: String,
    /// `NoNewPrivs:` from `/proc/self/status`.
    pub no_new_privs: String,
    /// Paths the bridge confirmed exist in its root view.
    #[serde(default)]
    pub visible: Vec<String>,
    /// Paths the bridge confirmed are absent from its root view.
    #[serde(default)]
    pub hidden: Vec<String>,
    /// Masked file paths confirmed to be absent or no longer sockets.
    #[serde(default)]
    pub hidden_not_socket: Vec<String>,
    /// Probe paths that could not be answered at all.
    #[serde(default)]
    pub probe_errors: Vec<String>,
}
