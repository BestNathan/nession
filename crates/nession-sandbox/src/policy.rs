//! Policy compilation: schema validation and normalization without host side
//! effects.
//!
//! `compile` answers "is this a coherent, supported-by-the-schema request?".
//! Capability validation (does *this* kernel/backend support it?) is a
//! separate step in [`crate::prepare`], because that one has to inspect the
//! host and must not be inferred from a schema.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

use nession_protocol::contracts::sandbox::v1::{
    SandboxCgroupV2Policy, SandboxEnforcement, SandboxLinuxNamespaces, SandboxNetworkMode,
    SandboxPolicy, SANDBOX_POLICY_VERSION,
};
use sha2::{Digest, Sha256};

use crate::error::{Result, SandboxError};
use crate::network::EgressRules;

/// The one built-in seccomp profile this build understands.
pub const SECCOMP_PROFILE_INTERACTIVE_V1: &str = "nession-interactive-v1";

/// A validated policy plus its normalized form and digest.
#[derive(Debug, Clone)]
pub struct CompiledSandboxPolicy {
    /// The policy with paths and rules normalized (sorted, de-duplicated).
    /// This is what the reported digest describes.
    pub normalized: SandboxPolicy,
    /// SHA-256 over the canonical JSON of `normalized`.
    pub digest: String,
    pub filesystem: Option<CompiledFilesystem>,
    pub network: Option<CompiledNetwork>,
    pub namespaces: NamespaceRequest,
    pub cgroup: Option<CgroupLimits>,
    pub seccomp: Option<SeccompProfile>,
    pub enforcement: SandboxEnforcement,
}

/// Validated filesystem path sets.
#[derive(Debug, Clone, Default)]
pub struct CompiledFilesystem {
    /// Visible read-only paths, excluding writable paths.
    pub read: Vec<PathBuf>,
    /// Visible read-write paths.
    pub write: Vec<PathBuf>,
}

impl CompiledFilesystem {
    /// Whether `path` is visible in the sandbox.
    pub fn is_visible(&self, path: &Path) -> bool {
        self.read
            .iter()
            .chain(self.write.iter())
            .any(|allowed| path == allowed || path.starts_with(allowed))
    }

    /// Whether `path` is writable in the sandbox.
    pub fn is_writable(&self, path: &Path) -> bool {
        self.write
            .iter()
            .any(|allowed| path == allowed || path.starts_with(allowed))
    }

    /// Every visible path, writable set included.
    pub fn visible(&self) -> impl Iterator<Item = &Path> {
        self.read
            .iter()
            .chain(self.write.iter())
            .map(PathBuf::as_path)
    }
}

/// A network mode with its parsed restricted-mode rules.
#[derive(Debug, Clone)]
pub struct CompiledNetwork {
    pub mode: SandboxNetworkMode,
    pub rules: EgressRules,
}

impl CompiledNetwork {
    /// `restricted` needs the trusted host-side proxy channel.
    pub fn requires_proxy(&self) -> bool {
        self.mode == SandboxNetworkMode::Restricted
    }

    /// `allow` inherits the host network; the other modes do not.
    pub fn blocks_host_network(&self) -> bool {
        self.mode != SandboxNetworkMode::Allow
    }
}

/// Explicit Linux namespace requests.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NamespaceRequest {
    pub pid: bool,
    pub ipc: bool,
    pub user: bool,
    pub uts: bool,
    pub cgroup: bool,
}

impl NamespaceRequest {
    /// Whether the request names at least one Linux namespace.
    pub fn any(&self) -> bool {
        self.pid || self.ipc || self.user || self.uts || self.cgroup
    }

    /// The policy key names, for the execution report.
    pub fn mechanism_names(&self) -> Vec<&'static str> {
        let mut names = Vec::new();
        for (enabled, name) in [
            (self.pid, "pid"),
            (self.ipc, "ipc"),
            (self.user, "user"),
            (self.uts, "uts"),
            (self.cgroup, "cgroup"),
        ] {
            if enabled {
                names.push(name);
            }
        }
        names
    }
}

/// Native cgroup v2 values, validated but not yet written.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CgroupLimits {
    pub memory_max: Option<String>,
    pub cpu_max: Option<String>,
    pub pids_max: Option<String>,
    pub memory_oom_group: Option<String>,
}

impl CgroupLimits {
    /// The controllers the requested files require.
    pub fn controllers(&self) -> BTreeSet<&'static str> {
        let mut controllers = BTreeSet::new();
        if self.memory_max.is_some() || self.memory_oom_group.is_some() {
            controllers.insert("memory");
        }
        if self.cpu_max.is_some() {
            controllers.insert("cpu");
        }
        if self.pids_max.is_some() {
            controllers.insert("pids");
        }
        controllers
    }

    /// `true` when no control file was requested.
    pub fn is_empty(&self) -> bool {
        self.memory_max.is_none()
            && self.cpu_max.is_none()
            && self.pids_max.is_none()
            && self.memory_oom_group.is_none()
    }

    /// The files and values to write, in a stable order.
    pub fn files(&self) -> Vec<(&'static str, &str)> {
        let mut files = Vec::new();
        if let Some(value) = &self.memory_max {
            files.push(("memory.max", value.as_str()));
        }
        if let Some(value) = &self.cpu_max {
            files.push(("cpu.max", value.as_str()));
        }
        if let Some(value) = &self.pids_max {
            files.push(("pids.max", value.as_str()));
        }
        if let Some(value) = &self.memory_oom_group {
            files.push(("memory.oom.group", value.as_str()));
        }
        files
    }
}

/// The pinned built-in seccomp profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeccompProfile {
    pub name: &'static str,
}

/// Compile and validate a policy schema.
///
/// The function performs no host I/O. A policy that names an unknown key never
/// reaches it (serde refuses it); a known key with an invalid value or a
/// contradictory combination is refused here.
pub fn compile(policy: &SandboxPolicy) -> Result<CompiledSandboxPolicy> {
    if policy.version != SANDBOX_POLICY_VERSION {
        return Err(SandboxError::UnsupportedPolicy(format!(
            "policy schema version {} is not supported (expected {SANDBOX_POLICY_VERSION})",
            policy.version
        )));
    }

    if !policy.enabled {
        let requests_constraints = policy.filesystem.is_some()
            || policy.network.is_some()
            || policy.process.is_some()
            || policy.resource.is_some()
            || policy.syscall.is_some();
        if requests_constraints {
            return Err(SandboxError::InvalidPolicy(
                "a disabled sandbox policy must not carry constraints".to_string(),
            ));
        }
    }

    let mut normalized = policy.clone();
    normalized.version = SANDBOX_POLICY_VERSION;
    normalized.enforcement = SandboxEnforcement::Required;

    let filesystem = policy
        .filesystem
        .as_ref()
        .map(|filesystem| compile_filesystem(&filesystem.access.read, &filesystem.access.write))
        .transpose()?;
    if let (Some(filesystem), Some(normalized_filesystem)) =
        (&filesystem, normalized.filesystem.as_mut())
    {
        normalized_filesystem.access.read = filesystem
            .read
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        normalized_filesystem.access.write = filesystem
            .write
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
    }

    let network = match &policy.network {
        Some(network) => {
            let egress = network.egress.as_ref();
            let (allow, deny) = match egress {
                Some(egress) => (egress.allow.clone(), egress.deny.clone()),
                None => (Vec::new(), Vec::new()),
            };
            if network.mode != SandboxNetworkMode::Restricted && egress.is_some() {
                return Err(SandboxError::InvalidPolicy(
                    "network.egress rules are only meaningful for mode `restricted`".to_string(),
                ));
            }
            let rules = EgressRules::parse(&allow, &deny)?;
            let mut normalized_allow = allow;
            let mut normalized_deny = deny;
            normalized_allow.sort();
            normalized_allow.dedup();
            normalized_deny.sort();
            normalized_deny.dedup();
            if let Some(normalized_egress) = normalized
                .network
                .as_mut()
                .and_then(|network| network.egress.as_mut())
            {
                normalized_egress.allow = normalized_allow;
                normalized_egress.deny = normalized_deny;
            }
            Some(CompiledNetwork {
                mode: network.mode,
                rules,
            })
        }
        None => None,
    };

    let namespaces = match policy
        .process
        .as_ref()
        .and_then(|p| p.linux_namespaces.as_ref())
    {
        Some(namespaces) => compile_namespaces(namespaces)?,
        None => NamespaceRequest::default(),
    };

    let cgroup = match policy.resource.as_ref() {
        Some(resource) => Some(compile_cgroup(&resource.cgroup_v2)?),
        None => None,
    };

    let seccomp = match policy.syscall.as_ref() {
        Some(syscall) => {
            if syscall.seccomp.profile != SECCOMP_PROFILE_INTERACTIVE_V1 {
                return Err(SandboxError::UnsupportedPolicy(format!(
                    "unknown seccomp profile `{}`; this build only pins `{SECCOMP_PROFILE_INTERACTIVE_V1}`",
                    syscall.seccomp.profile
                )));
            }
            Some(SeccompProfile {
                name: SECCOMP_PROFILE_INTERACTIVE_V1,
            })
        }
        None => None,
    };

    let digest = policy_digest(&normalized)?;
    Ok(CompiledSandboxPolicy {
        normalized,
        digest,
        filesystem,
        network,
        namespaces,
        cgroup,
        seccomp,
        enforcement: SandboxEnforcement::Required,
    })
}

/// The mechanisms this compiled policy requests, for evidence.
pub fn requested_mechanisms(policy: &CompiledSandboxPolicy) -> Vec<String> {
    let mut mechanisms = Vec::new();
    if policy.filesystem.is_some() {
        mechanisms.push("filesystem.access".to_string());
    }
    if let Some(network) = &policy.network {
        let mode = match network.mode {
            SandboxNetworkMode::Allow => "allow",
            SandboxNetworkMode::Deny => "deny",
            SandboxNetworkMode::Restricted => "restricted",
        };
        mechanisms.push(format!("network.{mode}"));
    }
    let namespaces = policy.namespaces.mechanism_names();
    if !namespaces.is_empty() {
        mechanisms.push(format!("process.linux_namespaces.{}", namespaces.join(",")));
    }
    if policy.cgroup.is_some() {
        mechanisms.push("resource.cgroup_v2".to_string());
    }
    if policy.seccomp.is_some() {
        mechanisms.push("syscall.seccomp".to_string());
    }
    mechanisms
}

fn compile_filesystem(read: &[String], write: &[String]) -> Result<CompiledFilesystem> {
    let mut read_paths: Vec<PathBuf> = read
        .iter()
        .map(|path| validate_path(path))
        .collect::<Result<Vec<_>>>()?;
    let mut write_paths: Vec<PathBuf> = write
        .iter()
        .map(|path| validate_path(path))
        .collect::<Result<Vec<_>>>()?;
    read_paths.sort();
    read_paths.dedup();
    write_paths.sort();
    write_paths.dedup();
    // A writable path is visible; keeping it only in `write` avoids a
    // contradictory read-only and read-write mount of the same path.
    read_paths.retain(|path| !write_paths.contains(path));
    // A nested read-only path under a writable parent (or vice versa) cannot
    // be honoured by both dimensions: one mount hides the other. Refusing is
    // the only truthful answer.
    for read in &read_paths {
        for write in &write_paths {
            if read.starts_with(write) || write.starts_with(read) {
                return Err(SandboxError::InvalidPolicy(format!(
                    "filesystem paths overlap: {} and {} request different access to the same tree",
                    read.display(),
                    write.display()
                )));
            }
        }
    }
    Ok(CompiledFilesystem {
        read: read_paths,
        write: write_paths,
    })
}

fn validate_path(raw: &str) -> Result<PathBuf> {
    if raw.is_empty() {
        return Err(SandboxError::InvalidPolicy(
            "filesystem paths must not be empty".to_string(),
        ));
    }
    if raw.contains('\0') {
        return Err(SandboxError::InvalidPolicy(
            "filesystem paths must not contain NUL".to_string(),
        ));
    }
    if raw
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return Err(SandboxError::InvalidPolicy(format!(
            "filesystem path `{raw}` must be normalized (no `.` or `..`)"
        )));
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(SandboxError::InvalidPolicy(format!(
            "filesystem path `{raw}` must be absolute"
        )));
    }
    for component in path.components() {
        match component {
            Component::RootDir | Component::Normal(_) => {}
            Component::CurDir | Component::ParentDir | Component::Prefix(_) => {
                return Err(SandboxError::InvalidPolicy(format!(
                    "filesystem path `{raw}` must be normalized (no `.` or `..`)"
                )));
            }
        }
    }
    Ok(path.to_path_buf())
}

fn compile_namespaces(namespaces: &SandboxLinuxNamespaces) -> Result<NamespaceRequest> {
    if namespaces.cgroup && !namespaces.user {
        // bwrap can create a cgroup namespace only in a user namespace it
        // controls. The backend may add a user namespace internally, but the
        // policy must not claim a guarantee combination it did not request.
        return Err(SandboxError::InvalidPolicy(
            "process.linux_namespaces.cgroup requires process.linux_namespaces.user".to_string(),
        ));
    }
    Ok(NamespaceRequest {
        pid: namespaces.pid,
        ipc: namespaces.ipc,
        user: namespaces.user,
        uts: namespaces.uts,
        cgroup: namespaces.cgroup,
    })
}

fn compile_cgroup(cgroup: &SandboxCgroupV2Policy) -> Result<CgroupLimits> {
    let limits = CgroupLimits {
        memory_max: cgroup
            .memory_max
            .as_deref()
            .map(validate_memory_max)
            .transpose()?,
        cpu_max: cgroup
            .cpu_max
            .as_deref()
            .map(validate_cpu_max)
            .transpose()?,
        pids_max: cgroup
            .pids_max
            .as_deref()
            .map(validate_pids_max)
            .transpose()?,
        memory_oom_group: cgroup
            .memory_oom_group
            .as_deref()
            .map(validate_oom_group)
            .transpose()?,
    };
    if limits.is_empty() {
        return Err(SandboxError::InvalidPolicy(
            "resource.cgroup_v2 requests no limit".to_string(),
        ));
    }
    Ok(limits)
}

pub(crate) fn validate_memory_max(value: &str) -> Result<String> {
    if value == "max" {
        return Ok(value.to_string());
    }
    parse_native_u64("memory.max", value)?;
    Ok(value.to_string())
}

pub(crate) fn validate_pids_max(value: &str) -> Result<String> {
    if value == "max" {
        return Ok(value.to_string());
    }
    parse_native_u64("pids.max", value)?;
    Ok(value.to_string())
}

pub(crate) fn validate_cpu_max(value: &str) -> Result<String> {
    let mut parts = value.split_whitespace();
    let quota = parts.next().ok_or_else(|| {
        SandboxError::InvalidPolicy("cpu.max needs `quota period` in native format".to_string())
    })?;
    let period = parts.next().ok_or_else(|| {
        SandboxError::InvalidPolicy("cpu.max needs `quota period` in native format".to_string())
    })?;
    if parts.next().is_some() {
        return Err(SandboxError::InvalidPolicy(
            "cpu.max takes exactly two tokens".to_string(),
        ));
    }
    if quota != "max" {
        parse_native_u64("cpu.max quota", quota)?;
    }
    let period = parse_native_u64("cpu.max period", period)?;
    // The kernel requires period in [1000, 1000000] microseconds.
    if !(1_000..=1_000_000).contains(&period) {
        return Err(SandboxError::InvalidPolicy(
            "cpu.max period must be 1000..=1000000 microseconds".to_string(),
        ));
    }
    Ok(value.to_string())
}

pub(crate) fn validate_oom_group(value: &str) -> Result<String> {
    if value == "0" || value == "1" {
        Ok(value.to_string())
    } else {
        Err(SandboxError::InvalidPolicy(
            "memory.oom.group must be `0` or `1`".to_string(),
        ))
    }
}

fn parse_native_u64(field: &str, value: &str) -> Result<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(SandboxError::InvalidPolicy(format!(
            "{field} must be a decimal integer or `max`"
        )));
    }
    value.parse::<u64>().map_err(|_| {
        SandboxError::InvalidPolicy(format!("{field} value `{value}` is out of range"))
    })
}

fn policy_digest(policy: &SandboxPolicy) -> Result<String> {
    let canonical = serde_json::to_vec(policy).map_err(|error| {
        SandboxError::InvalidPolicy(format!(
            "policy cannot be serialized for its digest: {error}"
        ))
    })?;
    Ok(hex_sha256(&canonical))
}

/// Lower-case hex SHA-256.
pub fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(value: serde_json::Value) -> SandboxPolicy {
        serde_json::from_value(value).expect("fixture parses")
    }

    #[test]
    fn native_cgroup_values_are_validated_in_their_own_units() {
        assert!(compile(&policy(serde_json::json!({
            "enabled": true,
            "resource": { "cgroup_v2": { "cpu.max": "200000 100000" } }
        })))
        .is_ok());
        for bad in [
            "200000",
            "200000 100 3",
            "200000 999",
            "abc 100000",
            "200000 1000000 x",
        ] {
            let error = compile(&policy(serde_json::json!({
                "enabled": true,
                "resource": { "cgroup_v2": { "cpu.max": bad } }
            })))
            .expect_err("invalid native format must fail closed");
            assert!(
                matches!(error, SandboxError::InvalidPolicy(_)),
                "{bad}: {error}"
            );
        }
    }

    #[test]
    fn cgroup_namespace_requires_a_user_namespace_request() {
        let error = compile(&policy(serde_json::json!({
            "enabled": true,
            "process": { "linux_namespaces": { "cgroup": true } }
        })))
        .expect_err("cgroup namespace without a user namespace is not a valid request");
        assert!(matches!(error, SandboxError::InvalidPolicy(_)));
    }

    #[test]
    fn a_disabled_policy_may_not_carry_constraints() {
        let error = compile(&policy(serde_json::json!({
            "enabled": false,
            "network": { "mode": "deny" }
        })))
        .expect_err("disabled with constraints is contradictory");
        assert!(matches!(error, SandboxError::InvalidPolicy(_)));
    }

    #[test]
    fn unknown_versions_are_unsupported_not_interpreted() {
        let error = compile(&policy(serde_json::json!({
            "version": 2,
            "enabled": true
        })))
        .expect_err("unknown schema version");
        assert!(matches!(error, SandboxError::UnsupportedPolicy(_)));
    }

    #[test]
    fn egress_rules_are_rejected_outside_restricted_mode() {
        let error = compile(&policy(serde_json::json!({
            "enabled": true,
            "network": { "mode": "deny", "egress": { "allow": ["example.com"] } }
        })))
        .expect_err("egress rules in deny mode are a contradiction");
        assert!(matches!(error, SandboxError::InvalidPolicy(_)));
    }

    #[test]
    fn unknown_seccomp_profiles_are_unsupported() {
        let error = compile(&policy(serde_json::json!({
            "enabled": true,
            "syscall": { "seccomp": { "profile": "mine" } }
        })))
        .expect_err("only the pinned profile exists");
        assert!(matches!(error, SandboxError::UnsupportedPolicy(_)));
    }

    #[test]
    fn relative_or_unnormalized_paths_are_rejected() {
        for bad in ["workspace", "/workspace/../etc", "/tmp/./x"] {
            let error = compile(&policy(serde_json::json!({
                "enabled": true,
                "filesystem": { "access": { "read": [bad] } }
            })))
            .expect_err("path must be absolute and normalized");
            assert!(matches!(error, SandboxError::InvalidPolicy(_)));
        }
    }

    #[test]
    fn overlapping_read_and_write_paths_are_refused() {
        for (read, write) in [
            ("/workspace/vendor", "/workspace"),
            ("/workspace", "/workspace/tmp"),
        ] {
            let error = compile(&policy(serde_json::json!({
                "enabled": true,
                "filesystem": { "access": { "read": [read], "write": [write] } }
            })))
            .expect_err("two access modes for one tree is contradictory");
            assert!(matches!(error, SandboxError::InvalidPolicy(_)));
        }
    }

    #[test]
    fn write_paths_are_visible_and_not_duplicated_as_read_only() {
        let compiled = compile(&policy(serde_json::json!({
            "enabled": true,
            "filesystem": { "access": { "read": ["/usr", "/workspace"], "write": ["/workspace"] } }
        })))
        .expect("valid policy");
        let filesystem = compiled.filesystem.expect("filesystem compiled");
        assert!(filesystem.is_writable(Path::new("/workspace/src")));
        assert!(filesystem.is_visible(Path::new("/usr/bin")));
        assert!(!filesystem.is_visible(Path::new("/etc")));
        assert_eq!(filesystem.read, vec![PathBuf::from("/usr")]);
    }

    #[test]
    fn the_digest_is_stable_under_equivalent_spelling() {
        let a = compile(&policy(serde_json::json!({
            "enabled": true,
            "network": { "mode": "restricted", "egress": { "allow": ["b.example", "a.example"] } },
            "filesystem": { "access": { "read": ["/usr", "/usr"] } }
        })))
        .expect("valid");
        let b = compile(&policy(serde_json::json!({
            "enabled": true,
            "network": { "mode": "restricted", "egress": { "allow": ["a.example", "b.example"] } },
            "filesystem": { "access": { "read": ["/usr"] } }
        })))
        .expect("valid");
        assert_eq!(a.digest, b.digest, "normalization is part of the digest");
        assert_eq!(a.digest.len(), 64);
    }
}
