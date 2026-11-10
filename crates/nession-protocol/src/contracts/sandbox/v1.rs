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
    /// A prepared EROFS root composition. When present it replaces
    /// `access`: the sandbox root is an empty tmpfs carrying the base image,
    /// with only the declared image mounts and writable workspace visible.
    ///
    /// This is an Agent/Server-prepared input, not a Web-editable field: the
    /// generated draft projection omits it so a client cannot name native
    /// image paths or digests.
    #[cfg_attr(feature = "codegen", ts(skip))]
    #[cfg_attr(feature = "codegen", schemars(skip))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composition: Option<SandboxFilesystemComposition>,
}

/// A prepared local EROFS image and the immutable digest it must hash to.
///
/// `source` is an Agent-authorized local file, never a URL or a raw mount
/// request. The Sandbox verifies the digest before it mounts anything.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxImageRef {
    /// `sha256:<64 lowercase hex>` of the exact image bytes.
    pub digest: String,
    /// Absolute local path of the already-prepared image file.
    pub source: String,
}

/// The minimal composable root (#3024).
///
/// `base` is mounted read-only at `/`. The optional Project source image and
/// writable directory are both mounted at `/workspace` (the writable bind is
/// applied after the image and therefore shadows it). Toolchain images are
/// read-only and restricted to `/opt/<name>` so V1 has no arbitrary
/// overlapping root ordering language.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxFilesystemComposition {
    /// The minimal glibc Base Runtime image mounted read-only at `/`.
    pub base: SandboxImageRef,
    /// The Project source image and/or the bounded writable workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<SandboxWorkspace>,
    /// Optional read-only toolchain images mounted at `/opt/<name>`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub toolchains: Vec<SandboxToolchainImage>,
}

/// The `/workspace` view: an optional read-only Project source image plus an
/// Agent-owned writable directory bound over it.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxWorkspace {
    /// Read-only Project source EROFS, when the Project has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<SandboxImageRef>,
    /// Absolute Agent-owned writable directory bound at `/workspace`.
    pub write: String,
}

/// One read-only toolchain EROFS and its `/opt/<name>` mount target.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxToolchainImage {
    pub digest: String,
    pub source: String,
    pub target: String,
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

// ---------------------------------------------------------------------------
// Context capability (#3124)
//
// Sandbox is a Session-context capability: the selected *active Pane* is
// either inside a verified Nession-managed execution, outside it, or unknown.
// The types below are the authenticated read/preflight/Enter surface. The
// canonical `SandboxPolicy` above remains the only policy schema; the draft
// below is its **Web-safe projection** (the native cgroup keys are carried as
// typed Key/Value rows instead of dotted field names, which the Web naming
// rules cannot generate). `nession-sandbox` owns the draft→policy
// materialization, so the projection is not a second validator.
// ---------------------------------------------------------------------------

/// The capability's context answers exactly one of three states.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SandboxContextStatus {
    /// The current Pane runs under a verified, Nession-managed execution.
    Inside,
    /// The current Pane is a Native execution with no managed Sandbox.
    Outside,
    /// The Agent could not prove either state (unreadable identity, stale
    /// instance, probe failure). Never rendered as protected.
    Unknown,
}

/// One typed Resource/Syscall editor row.
///
/// Rows are empty-first: the schema preselects nothing, and an empty list
/// omits the whole optional group from the materialized policy.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxKvEntry {
    pub key: String,
    pub value: String,
}

/// The Web-safe policy editor model (#3124).
///
/// Faithful to the canonical `SandboxPolicy`: every field either reuses a
/// generated policy dimension unchanged or carries a native Key/Value row that
/// `nession-sandbox` maps into the canonical nested contract. It is a
/// projection, not an alternative schema — the Agent materializes it and
/// compiles the canonical policy before any host resource is created.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxPolicyDraft {
    #[serde(default = "default_policy_version")]
    pub version: u32,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filesystem: Option<SandboxFilesystemPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<SandboxNetworkPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<SandboxProcessPolicy>,
    /// `resource.cgroup_v2` rows; empty means the group is omitted.
    #[serde(default)]
    pub resource: Vec<SandboxKvEntry>,
    /// `syscall.seccomp` rows; empty means the group is omitted.
    #[serde(default)]
    pub syscall: Vec<SandboxKvEntry>,
    #[serde(default)]
    pub enforcement: SandboxEnforcement,
}

/// Field-level preflight/Enter error.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxFieldError {
    /// Dot/row path such as `resource[0].key` or `filesystem.access.read`.
    pub field: String,
    /// A stable machine code such as `unknown-key`, `duplicate-key`,
    /// `blank-key`, `invalid-value`, `unsupported`.
    pub code: String,
    pub message: String,
}

/// The identity of the Pane execution the capability is reporting on.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxPaneScope {
    pub session_name: String,
    /// The Session's durable tmux identity (`@nession_instance_id`). A
    /// same-named recreation gets a different value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_pid: Option<u32>,
    /// The Pane's current working directory, when the Agent could read it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_dir: Option<String>,
}

/// One verified Nession-managed execution, as the Agent observed it.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxExecutionView {
    pub execution_id: String,
    pub backend: String,
    pub policy_digest: String,
    /// Requested guarantees the launch barrier verified in effect.
    pub mechanisms: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cgroup_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_endpoint: Option<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_pid: Option<u32>,
    /// Wall-clock creation time, epoch seconds.
    pub created_at: u64,
}

/// The Native Pane a Sandbox Pane was entered from, preserved untouched.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxNativePane {
    pub window_id: String,
    pub pane_id: String,
}

/// Another verified Sandbox Pane that still runs in the Session.
///
/// Return to Native is a focus switch; the Sandbox Pane keeps running, so the
/// capability must be able to name it again without fabricating `inside`.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxPaneRef {
    pub execution_id: String,
    pub window_id: String,
    pub pane_id: String,
    pub backend: String,
}

/// Whether the Agent's host probe can offer Enter at all.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SandboxCatalogStatus {
    Available,
    Unavailable,
    /// The host was not probed (offline/unknown); never read as "empty
    /// kernel feature set".
    Unknown,
}

/// One selectable Key/Value key, as the Agent's own probe measured it.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxFieldEntry {
    pub key: String,
    /// Native value-format help, e.g. `quota period` or `uint64 or max`.
    pub value_format: String,
    pub example: String,
    /// Whether this Agent could actually install the key in a child cgroup /
    /// load the profile. Presence of a file is not installability.
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// The Agent-authenticated capability catalog the UI consumes as hints.
///
/// `nession-sandbox` still owns final preflight/launch rejection; a stale
/// probe generation is revalidated on preflight and Enter.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxCapabilityCatalog {
    pub status: SandboxCatalogStatus,
    /// `linux`, `macos` or `unsupported`.
    pub platform: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    /// Changes when the measured host capability changes.
    pub probe_generation: String,
    /// `agent-host-probe`.
    pub source: String,
    #[serde(default)]
    pub detail: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Linux cgroup v2 choices actually installable by this Agent.
    #[serde(default)]
    pub resource_fields: Vec<SandboxFieldEntry>,
    /// Registered seccomp profile choices whose loading was probed.
    #[serde(default)]
    pub syscall_fields: Vec<SandboxFieldEntry>,
}

impl SandboxCapabilityCatalog {
    /// The truthful "not measured" catalog for an unreachable Agent. It is
    /// never an empty kernel feature set: discovery status is unknown.
    pub fn unknown(reason: impl Into<String>) -> Self {
        Self {
            status: SandboxCatalogStatus::Unknown,
            platform: "unknown".to_string(),
            backend: None,
            probe_generation: String::new(),
            source: "unavailable".to_string(),
            detail: Vec::new(),
            reason: Some(reason.into()),
            resource_fields: Vec::new(),
            syscall_fields: Vec::new(),
        }
    }
}

/// The active Pane's Sandbox context.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxCurrentContext {
    pub status: SandboxContextStatus,
    /// A truthful reason code/message when the status is not provable or the
    /// host cannot offer Enter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub scope: SandboxPaneScope,
    /// Opaque context revision. Preflight and Enter are bound to it; it
    /// changes when the active Pane, Session instance or execution changes.
    pub generation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<SandboxExecutionView>,
    /// The Agent-observed normalized policy; never the last UI draft.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_policy: Option<SandboxPolicyDraft>,
    /// Present only while a Sandbox Pane entered from a Native Pane is
    /// focused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_pane: Option<SandboxNativePane>,
    /// Whether Enter is eligible from this exact context.
    pub enterable: bool,
    /// Other verified Sandbox Panes still running in this Session.
    #[serde(default)]
    pub sandbox_panes: Vec<SandboxPaneRef>,
    pub catalog: SandboxCapabilityCatalog,
}

/// Typed outcome kind shared by the capability commands.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SandboxActionErrorKind {
    /// Stale generation, duplicate Enter, or the context changed between
    /// preflight and Enter.
    Conflict,
    /// The draft is not a valid policy (field errors accompany it).
    Invalid,
    /// The host/Agent cannot perform the action now (offline, unsupported,
    /// unreadable identity).
    Unavailable,
    /// The launch was attempted and failed; owned resources were released.
    Failed,
}

/// Preflight result. `ok` is true only when the Agent's own compile + host
/// capability validation passed.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxPreflightResult {
    pub ok: bool,
    /// A request-level refusal (unauthenticated, offline, stale generation).
    /// Field-level policy problems are in `errors` instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The context revision the preflight was evaluated against.
    pub generation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    #[serde(default)]
    pub mechanisms: Vec<String>,
    #[serde(default)]
    pub errors: Vec<SandboxFieldError>,
    #[serde(default)]
    pub warnings: Vec<String>,
    pub catalog: SandboxCapabilityCatalog,
}

/// Enter / Return / Focus outcome.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxActionResult {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<SandboxActionErrorKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field_errors: Option<Vec<SandboxFieldError>>,
    /// The freshly observed context after the action (or after a refusal that
    /// did not change it), so the UI never needs a second round trip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<SandboxCurrentContext>,
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
    fn an_erofs_composition_parses_and_round_trips() {
        let policy: SandboxPolicy = serde_json::from_value(serde_json::json!({
            "version": 1,
            "enabled": true,
            "filesystem": {
                "access": { "read": [], "write": [] },
                "composition": {
                    "base": {
                        "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                        "source": "/data/erofs/sha256/aaaa"
                    },
                    "workspace": {
                        "image": {
                            "digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                            "source": "/data/erofs/sha256/bbbb"
                        },
                        "write": "/data/sandbox/executions/e1/workspace"
                    },
                    "toolchains": [
                        {
                            "digest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                            "source": "/data/erofs/sha256/cccc",
                            "target": "/opt/node"
                        }
                    ]
                }
            }
        }))
        .expect("a prepared EROFS composition is a policy");
        let value = serde_json::to_value(&policy).unwrap();
        assert_eq!(
            value["filesystem"]["composition"]["toolchains"][0]["target"],
            "/opt/node"
        );
    }

    #[test]
    fn unknown_composition_fields_are_refused() {
        for bad in [
            serde_json::json!({
                "base": { "digest": "sha256:aa", "source": "/x", "mount": "kernel" }
            }),
            serde_json::json!({
                "base": { "digest": "sha256:aa", "source": "/x" },
                "workspace": { "write": "/w", "upper": "/u" }
            }),
        ] {
            let error = serde_json::from_value::<SandboxFilesystemComposition>(bad)
                .expect_err("an unknown composition key is refused");
            assert!(error.to_string().contains("unknown field"));
        }
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

    #[test]
    fn the_editor_draft_carries_native_kv_rows_and_omits_empty_groups() {
        // The contract shape accepts an empty-first draft; whether the empty
        // list omits the group is the materializer's rule (owned by
        // `nession-sandbox`), so the wire must represent "no rows" without a
        // dotted key anywhere.
        let draft: SandboxPolicyDraft = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "filesystem": { "access": { "read": ["/usr"], "write": [] } },
            "network": { "mode": "deny" },
            "resource": [],
            "syscall": []
        }))
        .expect("an empty-first draft is valid");
        assert!(draft.resource.is_empty());
        assert!(draft.syscall.is_empty());
        let value = serde_json::to_value(&draft).unwrap();
        assert_eq!(value["resource"], serde_json::json!([]));

        let with_rows: SandboxPolicyDraft = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "resource": [{ "key": "cpu.max", "value": "200000 100000" }],
            "syscall": [{ "key": "seccomp.profile", "value": "nession-interactive-v1" }]
        }))
        .expect("native rows are the Web-safe spelling");
        assert_eq!(with_rows.resource[0].key, "cpu.max");
        assert_eq!(with_rows.syscall[0].key, "seccomp.profile");
    }

    #[test]
    fn a_draft_refuses_unknown_fields_like_the_policy_does() {
        let error = serde_json::from_value::<SandboxPolicyDraft>(serde_json::json!({
            "enabled": true,
            "resource": [{ "key": "cpu.max", "value": "1 1000", "extra": true }]
        }))
        .expect_err("a row is exactly key+value");
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn the_context_snapshot_round_trips_and_never_invents_inside() {
        let context = SandboxCurrentContext {
            status: SandboxContextStatus::Outside,
            reason: Some("native".to_string()),
            scope: SandboxPaneScope {
                session_name: "s".to_string(),
                session_instance_id: Some("i".to_string()),
                pane_id: Some("%1".to_string()),
                window_id: Some("@1".to_string()),
                pane_pid: Some(42),
                working_dir: Some("/workspace".to_string()),
            },
            generation: "g".to_string(),
            execution: None,
            effective_policy: None,
            native_pane: None,
            enterable: true,
            sandbox_panes: Vec::new(),
            catalog: SandboxCapabilityCatalog {
                status: SandboxCatalogStatus::Available,
                platform: "linux".to_string(),
                backend: Some("linux-bwrap".to_string()),
                probe_generation: "p".to_string(),
                source: "agent-host-probe".to_string(),
                detail: Vec::new(),
                reason: None,
                resource_fields: vec![SandboxFieldEntry {
                    key: "memory.max".to_string(),
                    value_format: "uint64 or max".to_string(),
                    example: "2147483648".to_string(),
                    available: true,
                    reason: None,
                }],
                syscall_fields: Vec::new(),
            },
        };
        let value = serde_json::to_value(&context).unwrap();
        assert_eq!(value["status"], "outside");
        assert!(value.get("execution").is_none(), "absent stays absent");
        let parsed: SandboxCurrentContext = serde_json::from_value(value).unwrap();
        assert_eq!(parsed, context);
    }
}
