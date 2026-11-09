//! The versioned Sandbox policy contract (#2681).
//!
//! `nession-sandbox` owns validation, capability probing and execution. This
//! module owns only the **shape** of the policy a Session may bind, so the
//! wire, the Agent, the Server and generated bindings cannot each grow their
//! own field names.
//!
//! The schema names native mechanisms where a native mechanism is the promise:
//! `process.linux_namespaces`, `resource.cgroup_v2` and `syscall.seccomp` mean
//! exactly what Linux means by them and carry no cross-platform conversion
//! claim. Only genuinely shared contracts — `filesystem.access` and the
//! target-oriented `network` policy — are expressed portably.
//!
//! Every struct denies unknown fields. A policy the schema does not know is
//! refused when it is parsed, before any host resource is created; the
//! validator additionally rejects known-but-unsupported combinations (for
//! example `cgroup_v2` on macOS) rather than silently dropping them.

use serde::{Deserialize, Serialize};

/// The only policy schema version this build understands.
pub const SANDBOX_POLICY_VERSION: u32 = 1;

const fn default_policy_version() -> u32 {
    SANDBOX_POLICY_VERSION
}

/// One optional Sandbox policy bound to one Session.
///
/// `enabled` is explicit because the policy travels as a payload: absence of
/// the whole policy means "Native, unchanged", while a payload that says
/// `enabled: false` and also carries constraints is contradictory and is
/// rejected by the validator.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxPolicy {
    /// The versioned schema this payload answers. Anything but
    /// [`SANDBOX_POLICY_VERSION`] is rejected without interpretation.
    #[serde(default = "default_policy_version")]
    pub version: u32,
    /// Whether the caller asks for sandboxed execution at all.
    #[serde(default)]
    pub enabled: bool,
    /// Visible/read-only/writable host paths. Absence adds no filesystem
    /// constraint beyond the backend's own executability prerequisites.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filesystem: Option<SandboxFilesystemPolicy>,
    /// Shared, target-oriented network policy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<SandboxNetworkPolicy>,
    /// Linux-native process namespace requests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<SandboxProcessPolicy>,
    /// Linux cgroup v2 resource limits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource: Option<SandboxResourcePolicy>,
    /// Linux seccomp profile reference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub syscall: Option<SandboxSyscallPolicy>,
    /// How a backend must behave when it cannot install a requested
    /// guarantee. V1 supports only `required`: no silent fallback.
    #[serde(default)]
    pub enforcement: SandboxEnforcement,
}

/// How strictly a backend must honour the policy.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SandboxEnforcement {
    /// Every explicitly requested guarantee must be in effect before user
    /// code runs; an unavailable guarantee refuses the launch.
    #[default]
    Required,
}

/// Filesystem access contract.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxFilesystemPolicy {
    pub access: SandboxFilesystemAccess,
}

/// Authorized host path sets. Other host paths are not visible in the
/// sandbox; listed Unix sockets remain subject to their own permission checks.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxFilesystemAccess {
    /// Paths visible read-only.
    #[serde(default)]
    pub read: Vec<String>,
    /// Paths visible read-write. A writable path is also readable.
    #[serde(default)]
    pub write: Vec<String>,
}

/// Network policy, expressed as the shared target contract rather than as an
/// OS mechanism.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxNetworkPolicy {
    pub mode: SandboxNetworkMode,
    /// Destination rules. Only meaningful for `restricted`; carrying them in
    /// another mode is rejected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub egress: Option<SandboxEgressPolicy>,
    /// Ingress is denied by default in V1 and only `deny` is accepted.
    #[serde(default)]
    pub ingress: SandboxIngress,
}

/// The three V1 network modes.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SandboxNetworkMode {
    /// Inherit the accessible host network without additional policy.
    Allow,
    /// Block external IP networking and host-local addressing; sandbox-local
    /// loopback may still function.
    Deny,
    /// Default-deny with an explicit Domain/IP/Port allow and deny contract,
    /// enforced by a trusted host-side proxy.
    Restricted,
}

/// Target-oriented egress rules for `restricted` mode.
///
/// Entries are exact hosts or IP literals with an optional port:
/// `api.example.com:443`, `10.0.0.7`, `[2001:db8::1]:8443`. A wildcard is
/// only the leading `*.` form and matches subdomains but not the base domain.
/// `deny` wins over `allow`.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxEgressPolicy {
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
    /// Host-local, private and link-local destinations are denied; V1 has no
    /// value that re-permits them.
    #[serde(default)]
    pub private_network: SandboxPrivateNetwork,
}

/// The only V1 private-network value.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SandboxPrivateNetwork {
    #[default]
    Deny,
}

/// The only V1 ingress value: no port publication.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SandboxIngress {
    #[default]
    Deny,
}

/// Linux-native process namespace requests.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxProcessPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linux_namespaces: Option<SandboxLinuxNamespaces>,
}

/// Direct mapping to Linux `pid/ipc/user/uts/cgroup` namespace semantics.
///
/// Mount and network namespaces are owned by `filesystem` and `network`
/// respectively, so they do not appear here as duplicate knobs.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxLinuxNamespaces {
    #[serde(default)]
    pub pid: bool,
    #[serde(default)]
    pub ipc: bool,
    #[serde(default)]
    pub user: bool,
    #[serde(default)]
    pub uts: bool,
    /// Visibility mapping only; not resource quota enforcement.
    #[serde(default)]
    pub cgroup: bool,
}

/// Linux cgroup v2 resource policy.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxResourcePolicy {
    pub cgroup_v2: SandboxCgroupV2Policy,
}

/// Allowlisted cgroup v2 control files, using their native names and value
/// formats. No unit or CPU-core reinterpretation is applied.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxCgroupV2Policy {
    /// Byte count or `max`.
    #[serde(
        default,
        rename = "memory.max",
        skip_serializing_if = "Option::is_none"
    )]
    pub memory_max: Option<String>,
    /// Native `quota period` format, for example `200000 100000`.
    #[serde(default, rename = "cpu.max", skip_serializing_if = "Option::is_none")]
    pub cpu_max: Option<String>,
    /// Maximum kernel tasks (threads included) or `max`.
    #[serde(default, rename = "pids.max", skip_serializing_if = "Option::is_none")]
    pub pids_max: Option<String>,
    /// `0` or `1`, when the kernel supports group OOM handling.
    #[serde(
        default,
        rename = "memory.oom.group",
        skip_serializing_if = "Option::is_none"
    )]
    pub memory_oom_group: Option<String>,
}

/// Linux seccomp policy.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxSyscallPolicy {
    pub seccomp: SandboxSeccompPolicy,
}

/// A pinned built-in profile reference, never an arbitrary syscall list or
/// external BPF blob.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxSeccompPolicy {
    pub profile: String,
}

/// What the Agent actually installed, reported back on create.
///
/// This is an observation record, not a policy request: it names the backend
/// and mechanisms that were verified in effect, and a digest that binds the
/// report to the exact compiled policy.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxExecutionReport {
    /// Stable identity of this execution, also delivered to the Pane
    /// environment and used for owned-resource reconciliation.
    pub execution_id: String,
    /// `linux-bwrap` or `macos-seatbelt`.
    pub backend: String,
    /// SHA-256 over the canonical compiled policy.
    pub policy_digest: String,
    /// Requested guarantees that were probed and verified in effect.
    pub mechanisms: Vec<String>,
    /// The execution-scoped cgroup v2 directory, when one was requested.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cgroup_path: Option<String>,
    /// The sandbox-local proxy endpoint, when restricted networking was
    /// requested.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_endpoint: Option<String>,
    /// Non-fatal backend notes (for example a backend-internal baseline mount
    /// that was added for executability). Empty means no note.
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example_policy() -> SandboxPolicy {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "enabled": true,
            "filesystem": { "access": { "read": ["/usr"], "write": ["/workspace", "/tmp"] } },
            "network": {
                "mode": "restricted",
                "egress": {
                    "allow": ["api.anthropic.com:443", "*.npmjs.org:443"],
                    "deny": ["*.internal.example"],
                    "private_network": "deny"
                },
                "ingress": "deny"
            },
            "process": { "linux_namespaces": { "pid": true, "ipc": true, "user": true } },
            "resource": { "cgroup_v2": { "memory.max": "2147483648", "cpu.max": "200000 100000", "pids.max": "256" } },
            "syscall": { "seccomp": { "profile": "nession-interactive-v1" } },
            "enforcement": "required"
        }))
        .expect("the requirement's illustrative policy must parse")
    }

    #[test]
    fn the_illustrative_policy_round_trips_with_native_cgroup_keys() {
        let policy = example_policy();
        let value = serde_json::to_value(&policy).unwrap();
        assert_eq!(value["resource"]["cgroup_v2"]["memory.max"], "2147483648");
        assert_eq!(value["resource"]["cgroup_v2"]["cpu.max"], "200000 100000");
        assert_eq!(value["network"]["mode"], "restricted");
        assert_eq!(policy.version, SANDBOX_POLICY_VERSION);
    }

    #[test]
    fn unknown_fields_are_refused_at_the_schema_boundary() {
        let error = serde_json::from_value::<SandboxPolicy>(serde_json::json!({
            "enabled": true,
            "make_me_root": true
        }))
        .expect_err("an unknown key is not a policy");
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn unknown_cgroup_keys_are_refused_rather_than_written() {
        let error = serde_json::from_value::<SandboxPolicy>(serde_json::json!({
            "enabled": true,
            "resource": { "cgroup_v2": { "memory.swap.max": "1" } }
        }))
        .expect_err("only allowlisted control files exist");
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn unknown_enum_values_are_refused() {
        let error = serde_json::from_value::<SandboxPolicy>(serde_json::json!({
            "enabled": true,
            "network": { "mode": "allow-ish" }
        }))
        .expect_err("network modes are a closed set");
        assert!(error.to_string().contains("unknown variant"));
    }
}
