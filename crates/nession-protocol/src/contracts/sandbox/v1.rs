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
//! Every named-field struct denies unknown fields. A policy the schema does not
//! know is refused when it is parsed, before any host resource is created. The
//! native cgroup map is the deliberate exception: its keys are kernel control
//! file basenames, so `nession-sandbox` applies the generic basename rule and
//! lets the kernel validate values. The validator additionally rejects
//! known-but-unsupported combinations (for example `cgroup_v2` on macOS)
//! rather than silently dropping them.

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

/// The client-safe RootFS declaration (#3405).
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SandboxFilesystemRoot {
    /// The backend's host-root baseline ("Local" in the editor).
    Local,
    /// One immutable Base Runtime EROFS image mounted read-only at `/`.
    Image { digest: String },
}

/// One authorized additional image source (#3405).
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SandboxMountSource {
    /// An immutable Server image digest. The Agent resolves it through its
    /// verified cache; a raw local path is never a client source.
    Image { digest: String },
}

/// One read-only additional image mount with an explicit target (#3405).
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxMount {
    pub source: SandboxMountSource,
    /// Absolute, normalized target. The first executable implementation keeps
    /// the V1 `/opt/<lowercase-name>` restriction.
    pub target: String,
    #[serde(default = "default_mount_read_only")]
    pub read_only: bool,
}

fn default_mount_read_only() -> bool {
    true
}

/// The client-safe Workspace selection (#3405, resource model #3407).
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SandboxFilesystemWorkspace {
    /// Resolve the current Project Location first, otherwise the managed
    /// Workspace named after the Session.
    Auto,
    /// The current Project's declared Existing Location on this Agent.
    ProjectLocation,
    /// One Agent-managed Workspace by stable id or lookup name.
    Managed {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
}

/// Filesystem access contract.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxFilesystemPolicy {
    pub access: SandboxFilesystemAccess,
    /// Optional RootFS source. Absent means the current host-root baseline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rootfs: Option<SandboxFilesystemRoot>,
    /// Additional read-only image mounts, initially empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mounts: Vec<SandboxMount>,
    /// Optional Workspace selection at the implicit `/workspace` target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<SandboxFilesystemWorkspace>,
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

/// Who owns the writable directory of a prepared composition (#3407).
///
/// The Sandbox only mounts the directory; the distinction lets every host-path
/// check stay truthful. An `agent` directory must stay under an Agent-owned
/// root and may carry an Overlay upper/work. A `project_location` is a Project
/// declaration the Agent only validated and bound: it is never created,
/// written to as metadata storage or deleted, and it cannot carry a Project
/// EROFS lower because the Overlay would have to store upper/work inside a
/// user-owned tree.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SandboxWorkspaceOwnership {
    /// An Agent-owned, bounded writable directory.
    #[default]
    Agent,
    /// A Project Existing Location: external, user-owned storage.
    ProjectLocation,
}

/// The `/workspace` view: an optional read-only Project source EROFS plus the
/// selected writable directory bound over it.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxWorkspace {
    /// Read-only Project source EROFS, when the Project has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<SandboxImageRef>,
    /// Absolute writable directory bound at `/workspace`.
    pub write: String,
    /// Who owns `write`. Absent (older records) is Agent-owned.
    #[serde(default)]
    pub ownership: SandboxWorkspaceOwnership,
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

/// Native cgroup v2 resource policy: control-file basename -> native text
/// value (#3141).
///
/// This is intentionally not a resource allowlist: the Agent discovers which
/// controller files its delegated child cgroup actually exposes, excludes
/// hierarchy/lifecycle/status/command interfaces, and the kernel remains the
/// authority on each value's format and range. The JSON shape
/// `resource.cgroup_v2: { "cpu.weight": "100" }` is the V1 native boundary.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SandboxCgroupV2Policy(pub std::collections::BTreeMap<String, String>);

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

/// Which prepared image role a Sandbox image selection asks for.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SandboxImageRole {
    /// The Base Runtime image at `/`.
    Base,
    /// The workspace image at `/workspace`, merged with a writable overlay.
    Workspace,
    /// A read-only toolchain image at `/opt/<name>`.
    Toolchain,
}

/// How a selected image participates in the composed root.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SandboxImageMode {
    ReadOnly,
    /// The writable upper/work workspace is Agent-owned; only a workspace
    /// image may use this mode.
    Overlay,
}

/// One image the client asks the Server to resolve and the Agent to prepare
/// for a Sandbox Enter.
///
/// This is not a native composition: it carries no local source path. The
/// Server authorizes the digest and mints a scoped grant; the Agent resolves
/// the verified cache path and builds the canonical composition.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxImageSelection {
    pub role: SandboxImageRole,
    /// `sha256:<64 lowercase hex>` of a Server Ready image.
    pub digest: String,
    /// `/opt/<name>` for a toolchain; absent for the other roles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default = "default_sandbox_image_mode")]
    pub mode: SandboxImageMode,
}

fn default_sandbox_image_mode() -> SandboxImageMode {
    SandboxImageMode::ReadOnly
}

fn field_error(field: &str, code: &str, message: &str) -> SandboxFieldError {
    SandboxFieldError {
        field: field.to_string(),
        code: code.to_string(),
        message: message.to_string(),
    }
}

/// Validate the Web-safe image-selection shape before the Server mints grants.
///
/// The canonical composition and target rules remain owned by
/// `nession-sandbox::compile`; this function only refuses roles, duplicate
/// roots and modes that can never become a valid composition.
pub fn validate_image_selections(
    selections: &[SandboxImageSelection],
) -> Result<(), Vec<SandboxFieldError>> {
    let mut errors = Vec::new();
    let mut base = 0;
    let mut workspace = 0;
    for (index, selection) in selections.iter().enumerate() {
        if !crate::contracts::image::v1::is_valid_image_digest(&selection.digest) {
            errors.push(field_error(
                &format!("images[{index}].digest"),
                "invalid-digest",
                "image digest must be a sha256:<64 lowercase hex> digest",
            ));
        }
        match selection.role {
            SandboxImageRole::Base => {
                base += 1;
                if selection.mode != SandboxImageMode::ReadOnly {
                    errors.push(field_error(
                        &format!("images[{index}].mode"),
                        "invalid-mode",
                        "the Base Runtime image is read-only",
                    ));
                }
                if selection
                    .target
                    .as_deref()
                    .is_some_and(|target| target != "/")
                {
                    errors.push(field_error(
                        &format!("images[{index}].target"),
                        "invalid-target",
                        "the Base Runtime image target is /",
                    ));
                }
            }
            SandboxImageRole::Workspace => {
                workspace += 1;
                if selection.mode != SandboxImageMode::Overlay {
                    errors.push(field_error(
                        &format!("images[{index}].mode"),
                        "invalid-mode",
                        "the workspace image requires the overlay mode",
                    ));
                }
                if selection
                    .target
                    .as_deref()
                    .is_some_and(|target| target != "/workspace")
                {
                    errors.push(field_error(
                        &format!("images[{index}].target"),
                        "invalid-target",
                        "the workspace image target is /workspace",
                    ));
                }
            }
            SandboxImageRole::Toolchain => {
                if selection.mode != SandboxImageMode::ReadOnly {
                    errors.push(field_error(
                        &format!("images[{index}].mode"),
                        "invalid-mode",
                        "a toolchain image is read-only",
                    ));
                }
                let Some(target) = selection.target.as_deref() else {
                    errors.push(field_error(
                        &format!("images[{index}].target"),
                        "missing-target",
                        "a toolchain image requires an /opt/<name> target",
                    ));
                    continue;
                };
                if !target.starts_with("/opt/") || target.len() <= 5 || target.contains("..") {
                    errors.push(field_error(
                        &format!("images[{index}].target"),
                        "invalid-target",
                        "a toolchain target must be /opt/<name>",
                    ));
                }
            }
        }
    }
    if base > 1 {
        errors.push(field_error(
            "images.base",
            "duplicate-role",
            "a Sandbox composition has at most one Base Runtime image",
        ));
    }
    if workspace > 1 {
        errors.push(field_error(
            "images.workspace",
            "duplicate-role",
            "a Sandbox composition has at most one workspace image",
        ));
    }
    if !selections.is_empty() && base == 0 {
        errors.push(field_error(
            "images.base",
            "missing-role",
            "a Sandbox image composition requires a Base Runtime image",
        ));
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
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

/// The catalog shape version this build produces (#3161).
///
/// Version 2 adds per-implementation and per-option support. A client that
/// does not understand a newer version must not read an empty implementation
/// list as "nothing is supported": `unknown` is the truthful fallback.
pub const SANDBOX_CATALOG_VERSION: u32 = 2;

/// Availability of one registered policy implementation or option.
///
/// `available` is eligibility to *compose* a draft, not a claim that the
/// guarantee is installed in the selected Pane, nor that arbitrary values
/// will be accepted at runtime.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SandboxImplementationStatus {
    Available,
    Unavailable,
    /// The implementation is registered in the schema, but this Agent could
    /// not measure it (offline/stale/unprobed/timeout). Never editable.
    Unknown,
}

/// A stable machine-readable reason why an implementation or option is not
/// available. Free-form diagnostics stay in the sibling `reason` string.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SandboxUnsupportedReason {
    /// The schema path is native to another platform (for example Linux
    /// namespaces on macOS).
    PlatformUnsupported,
    /// The Agent has no usable backend at all.
    BackendMissing,
    /// The platform has a backend, but the kernel feature it needs is absent.
    KernelFeatureMissing,
    /// A cgroup v2 subtree or controller was not delegated to the Agent.
    ControllerNotDelegated,
    /// The Agent could not write the native control file or load the profile.
    PermissionDenied,
    /// The implementation is registered, but no measured profile is loadable.
    ProfileUnavailable,
    /// This build does not compile the implementation for this platform.
    ImplementationNotBuilt,
    /// The host was not probed, so support cannot be claimed.
    NotProbed,
    /// The probe did not answer within its bound.
    Timeout,
}

/// One typed, implementation-owned option (network mode, namespace, seccomp
/// profile, ...). The meaning of `id` belongs to the implementation path.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxOptionSupport {
    pub id: String,
    pub status: SandboxImplementationStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<SandboxUnsupportedReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl SandboxOptionSupport {
    /// An option this Agent measured as offered.
    pub fn available(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            status: SandboxImplementationStatus::Available,
            reason_code: None,
            reason: None,
        }
    }

    /// An option this Agent measured as unavailable, with its stable code.
    pub fn unavailable(
        id: impl Into<String>,
        reason_code: SandboxUnsupportedReason,
        reason: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            status: SandboxImplementationStatus::Unavailable,
            reason_code: Some(reason_code),
            reason: Some(reason.into()),
        }
    }

    /// An option that was not measured at all.
    pub fn unknown(id: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            status: SandboxImplementationStatus::Unknown,
            reason_code: Some(SandboxUnsupportedReason::NotProbed),
            reason: Some(reason.into()),
        }
    }
}

/// Per-implementation support keyed by the canonical policy path.
///
/// Only schema-known implementations are listed. A backend must register its
/// own versioned path before it can appear here; a frontend label can never
/// authorize policy bytes.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxImplementationSupport {
    /// Canonical policy path, for example `network` or `resource.cgroup_v2`.
    pub path: String,
    pub status: SandboxImplementationStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<SandboxUnsupportedReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Typed options owned by this implementation. Empty when the
    /// implementation has no enumerated options (for example
    /// `filesystem.access`, whose value is a path list).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<SandboxOptionSupport>,
    /// Typed native fields owned by this implementation (cgroup v2 control
    /// files). Empty for implementations without a field catalog.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<SandboxFieldEntry>,
}

impl SandboxImplementationSupport {
    /// A registered implementation that was not measured. It never claims
    /// support and is never editable.
    pub fn unknown(path: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            status: SandboxImplementationStatus::Unknown,
            reason_code: Some(SandboxUnsupportedReason::NotProbed),
            reason: Some(reason.into()),
            options: Vec::new(),
            fields: Vec::new(),
        }
    }

    /// Whether this implementation can be used to compose a draft at all.
    pub fn is_editable(&self) -> bool {
        self.status == SandboxImplementationStatus::Available
    }
}

/// One selectable Key/Value key, as the Agent's own probe measured it.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxFieldEntry {
    pub key: String,
    /// The native controller/file family this key belongs to, when typed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub controller: Option<String>,
    /// Native value-format help, e.g. `quota period` or `uint64 or max`.
    pub value_format: String,
    pub example: String,
    /// Whether this Agent could actually install the key in a child cgroup /
    /// load the profile. Presence of a file is not installability.
    pub available: bool,
    /// Stable reason code when `available` is false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<SandboxUnsupportedReason>,
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
    /// The shape version this catalog answers. Newer versions add fields;
    /// an older client must treat unknown entries (and an empty
    /// implementation list) as "not measured", never as "unsupported".
    #[serde(default)]
    pub catalog_version: u32,
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
    /// Per canonical policy path support (#3161). Only schema-known
    /// implementations are listed; an omitted path is not a support claim.
    #[serde(default)]
    pub implementations: Vec<SandboxImplementationSupport>,
    /// Linux cgroup v2 choices actually installable by this Agent.
    ///
    /// Kept as a flat compatibility projection of
    /// `resource.cgroup_v2.fields` for clients built before catalog v2.
    #[serde(default)]
    pub resource_fields: Vec<SandboxFieldEntry>,
    /// Registered seccomp profile choices whose loading was probed.
    ///
    /// Kept as a flat compatibility projection of
    /// `syscall.seccomp.options` for clients built before catalog v2.
    #[serde(default)]
    pub syscall_fields: Vec<SandboxFieldEntry>,
}

impl SandboxCapabilityCatalog {
    /// The truthful "not measured" catalog for an unreachable Agent. It is
    /// never an empty kernel feature set: discovery status is unknown and
    /// every schema-registered implementation is listed as unknown.
    pub fn unknown(reason: impl Into<String>) -> Self {
        let reason = reason.into();
        Self {
            catalog_version: SANDBOX_CATALOG_VERSION,
            status: SandboxCatalogStatus::Unknown,
            platform: "unknown".to_string(),
            backend: None,
            probe_generation: String::new(),
            source: "unavailable".to_string(),
            detail: Vec::new(),
            reason: Some(reason.clone()),
            implementations: REGISTERED_IMPLEMENTATION_PATHS
                .iter()
                .map(|path| SandboxImplementationSupport::unknown(*path, reason.clone()))
                .collect(),
            resource_fields: Vec::new(),
            syscall_fields: Vec::new(),
        }
    }

    /// One implementation's support entry, if this catalog lists it.
    pub fn implementation(&self, path: &str) -> Option<&SandboxImplementationSupport> {
        self.implementations
            .iter()
            .find(|implementation| implementation.path == path)
    }
}

/// The canonical policy paths the schema registers for discovery (#3161).
///
/// This is contract knowledge, not a UI allowlist: a backend may only report
/// support for paths it actually implements. `filesystem.composition` is an
/// Agent/Server-prepared input and is never Web-editable.
pub const REGISTERED_IMPLEMENTATION_PATHS: [&str; 6] = [
    "filesystem.access",
    "filesystem.composition",
    "network",
    "process.linux_namespaces",
    "resource.cgroup_v2",
    "syscall.seccomp",
];

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
    fn native_cgroup_keys_round_trip_without_an_allowlist() {
        let policy: SandboxPolicy = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "resource": { "cgroup_v2": {
                "memory.swap.max": "1",
                "cpu.weight": "100",
                "io.max": "8:16 rbps=2097152"
            } }
        }))
        .expect("native controller basenames are schema-valid");
        let value = serde_json::to_value(&policy).expect("serializes");
        assert_eq!(value["resource"]["cgroup_v2"]["cpu.weight"], "100");
        assert_eq!(
            value["resource"]["cgroup_v2"]["io.max"],
            "8:16 rbps=2097152"
        );

        // The map does not relax the resource group itself: only the native
        // cgroup_v2 map is open-keyed.
        let error = serde_json::from_value::<SandboxPolicy>(serde_json::json!({
            "enabled": true,
            "resource": { "cgroup_v2": { "cpu.weight": "100" }, "other": {} }
        }))
        .expect_err("the resource group still denies unknown fields");
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
                catalog_version: SANDBOX_CATALOG_VERSION,
                status: SandboxCatalogStatus::Available,
                platform: "linux".to_string(),
                backend: Some("linux-bwrap".to_string()),
                probe_generation: "p".to_string(),
                source: "agent-host-probe".to_string(),
                detail: Vec::new(),
                reason: None,
                implementations: vec![SandboxImplementationSupport {
                    path: "resource.cgroup_v2".to_string(),
                    status: SandboxImplementationStatus::Available,
                    reason_code: None,
                    reason: None,
                    options: Vec::new(),
                    fields: vec![SandboxFieldEntry {
                        key: "memory.max".to_string(),
                        controller: Some("memory".to_string()),
                        value_format: "uint64 or max".to_string(),
                        example: "2147483648".to_string(),
                        available: true,
                        reason_code: None,
                        reason: None,
                    }],
                }],
                resource_fields: vec![SandboxFieldEntry {
                    key: "memory.max".to_string(),
                    controller: Some("memory".to_string()),
                    value_format: "uint64 or max".to_string(),
                    example: "2147483648".to_string(),
                    available: true,
                    reason_code: None,
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

    #[test]
    fn the_implementation_catalog_separates_paths_and_options() {
        let implementation: SandboxImplementationSupport =
            serde_json::from_value(serde_json::json!({
                "path": "network",
                "status": "available",
                "options": [
                    { "id": "allow", "status": "available" },
                    { "id": "restricted", "status": "unavailable",
                      "reason_code": "platform_unsupported", "reason": "no proxy" }
                ]
            }))
            .expect("per-option support parses");
        assert!(implementation.is_editable());
        assert_eq!(
            implementation.options[0].status,
            SandboxImplementationStatus::Available
        );
        assert_eq!(
            implementation.options[1].reason_code,
            Some(SandboxUnsupportedReason::PlatformUnsupported)
        );
        let value = serde_json::to_value(&implementation).unwrap();
        assert_eq!(value["options"][1]["status"], "unavailable");
        assert_eq!(value["options"][1]["reason_code"], "platform_unsupported");
        assert!(
            value.get("fields").is_none(),
            "empty typed groups stay absent"
        );
    }

    #[test]
    fn an_unmeasured_catalog_lists_every_registered_path_as_unknown() {
        let catalog = SandboxCapabilityCatalog::unknown("Agent unavailable");
        assert_eq!(catalog.catalog_version, SANDBOX_CATALOG_VERSION);
        assert_eq!(catalog.status, SandboxCatalogStatus::Unknown);
        assert_eq!(
            catalog.implementations.len(),
            REGISTERED_IMPLEMENTATION_PATHS.len()
        );
        for implementation in &catalog.implementations {
            assert_eq!(implementation.status, SandboxImplementationStatus::Unknown);
            assert_eq!(
                implementation.reason_code,
                Some(SandboxUnsupportedReason::NotProbed)
            );
            assert!(!implementation.is_editable());
        }
        assert!(catalog.implementation("resource.cgroup_v2").is_some());
        assert!(catalog.implementation("resource.macos_limits").is_none());
    }

    #[test]
    fn an_old_catalog_projection_parses_as_unmeasured_not_unsupported() {
        let catalog: SandboxCapabilityCatalog = serde_json::from_value(serde_json::json!({
            "status": "available",
            "platform": "linux",
            "backend": "linux-bwrap",
            "probe_generation": "p",
            "source": "agent-host-probe",
            "resource_fields": [],
            "syscall_fields": []
        }))
        .expect("the v1 projection remains readable");
        assert_eq!(catalog.catalog_version, 0);
        assert!(catalog.implementations.is_empty());
    }

    #[test]
    fn implementation_entries_refuse_unknown_fields_and_statuses() {
        let unknown_field =
            serde_json::from_value::<SandboxImplementationSupport>(serde_json::json!({
                "path": "network", "status": "available", "editable": true
            }))
            .expect_err("the typed shape is closed");
        assert!(unknown_field.to_string().contains("unknown field"));
        let unknown_status =
            serde_json::from_value::<SandboxImplementationSupport>(serde_json::json!({
                "path": "network", "status": "maybe"
            }))
            .expect_err("status is a closed set");
        assert!(unknown_status.to_string().contains("unknown variant"));
    }

    #[test]
    fn sandbox_image_selections_validate_roles_targets_and_modes() {
        let digest = |hex: char| format!("sha256:{}", hex.to_string().repeat(64));
        let valid = vec![
            SandboxImageSelection {
                role: SandboxImageRole::Base,
                digest: digest('a'),
                target: None,
                mode: SandboxImageMode::ReadOnly,
            },
            SandboxImageSelection {
                role: SandboxImageRole::Workspace,
                digest: digest('b'),
                target: None,
                mode: SandboxImageMode::Overlay,
            },
            SandboxImageSelection {
                role: SandboxImageRole::Toolchain,
                digest: digest('c'),
                target: Some("/opt/rust".to_string()),
                mode: SandboxImageMode::ReadOnly,
            },
        ];
        validate_image_selections(&valid).expect("a coherent composition passes");

        let mut missing_base = valid[1..].to_vec();
        let errors = validate_image_selections(&missing_base).unwrap_err();
        assert!(errors.iter().any(|error| error.field == "images.base"));

        let mut duplicate_base = valid.clone();
        duplicate_base.push(SandboxImageSelection {
            role: SandboxImageRole::Base,
            digest: digest('d'),
            target: None,
            mode: SandboxImageMode::ReadOnly,
        });
        let errors = validate_image_selections(&duplicate_base).unwrap_err();
        assert!(errors.iter().any(|error| error.field == "images.base"));

        let mut workspace_read_only = valid.clone();
        workspace_read_only[1].mode = SandboxImageMode::ReadOnly;
        let errors = validate_image_selections(&workspace_read_only).unwrap_err();
        assert!(errors.iter().any(|error| error.field == "images[1].mode"));

        let mut toolchain_without_target = valid.clone();
        toolchain_without_target[2].target = None;
        let errors = validate_image_selections(&toolchain_without_target).unwrap_err();
        assert!(errors.iter().any(|error| error.field == "images[2].target"));

        let mut base_overlay = valid;
        base_overlay[0].mode = SandboxImageMode::Overlay;
        let errors = validate_image_selections(&base_overlay).unwrap_err();
        assert!(errors.iter().any(|error| error.field == "images[0].mode"));

        missing_base.clear();
        validate_image_selections(&missing_base)
            .expect("no selection is the existing Native policy");
    }
}
