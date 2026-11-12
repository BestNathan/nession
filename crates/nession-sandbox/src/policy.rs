//! Policy compilation: schema validation and normalization without host side
//! effects.
//!
//! `compile` answers "is this a coherent, supported-by-the-schema request?".
//! Capability validation (does *this* kernel/backend support it?) is a
//! separate step in [`crate::prepare`], because that one has to inspect the
//! host and must not be inferred from a schema.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use nession_protocol::contracts::sandbox::v1::{
    SandboxCgroupV2Policy, SandboxEnforcement, SandboxFilesystemComposition, SandboxImageRef,
    SandboxLinuxNamespaces, SandboxNetworkMode, SandboxPolicy, SandboxToolchainImage,
    SandboxWorkspace, SANDBOX_POLICY_VERSION,
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
    pub cgroup: Option<CgroupWrites>,
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
    /// A prepared EROFS root composition; mutually exclusive with `read`/`write`.
    pub composition: Option<CompiledComposition>,
}

/// One verified local EROFS image and its sandbox mount target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledImage {
    pub digest: String,
    pub source: PathBuf,
    pub target: PathBuf,
}

/// The compiled `/workspace` view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledWorkspace {
    pub image: Option<CompiledImage>,
    pub write: PathBuf,
}

/// The compiled minimal composable root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledComposition {
    pub base: CompiledImage,
    pub workspace: Option<CompiledWorkspace>,
    /// Sorted by target, so the mount order is deterministic.
    pub toolchains: Vec<CompiledImage>,
}

impl CompiledFilesystem {
    /// Whether `path` is visible in the sandbox.
    pub fn is_visible(&self, path: &Path) -> bool {
        self.read
            .iter()
            .chain(self.write.iter())
            .any(|allowed| path == allowed || path.starts_with(allowed))
    }

    /// The absolute sandbox paths an EROFS composition must expose.
    pub fn composition_probes(&self) -> Vec<PathBuf> {
        let Some(composition) = &self.composition else {
            return Vec::new();
        };
        let mut probes = vec![PathBuf::from("/bin/sh"), composition.workspace_probe()];
        probes.extend(
            composition
                .toolchains
                .iter()
                .map(|image| image.target.clone()),
        );
        probes.sort();
        probes.dedup();
        probes
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

impl CompiledComposition {
    /// The path the composition must make visible for a working workspace.
    pub fn workspace_probe(&self) -> PathBuf {
        PathBuf::from("/workspace")
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

/// Validated native cgroup v2 control-file writes, not yet applied.
///
/// The map preserves the kernel's own file names and raw values; this type
/// performs no unit conversion or per-file interpretation.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CgroupWrites {
    writes: BTreeMap<String, String>,
}

impl CgroupWrites {
    /// The controllers the requested files belong to.
    pub fn controllers(&self) -> BTreeSet<String> {
        self.writes
            .keys()
            .filter_map(|file| crate::cgroup_file::controller_of(file).map(str::to_string))
            .collect()
    }

    /// `true` when no control file was requested.
    pub fn is_empty(&self) -> bool {
        self.writes.is_empty()
    }

    /// The files and values to write, in stable basename order.
    pub fn files(&self) -> impl Iterator<Item = (&str, &str)> {
        self.writes
            .iter()
            .map(|(file, value)| (file.as_str(), value.as_str()))
    }

    /// One requested native value.
    pub fn get(&self, file: &str) -> Option<&str> {
        self.writes.get(file).map(String::as_str)
    }
}

/// The pinned built-in seccomp profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeccompProfile {
    pub name: &'static str,
}

/// Compile and validate a policy schema.
///
/// The function performs no host I/O. The native cgroup map is checked at the
/// generic basename boundary (no path traversal, lifecycle/status/command
/// interfaces, empty values); the kernel remains authoritative for each
/// value's format and range when the execution is created.
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
        .map(|filesystem| {
            compile_filesystem(
                &filesystem.access.read,
                &filesystem.access.write,
                filesystem.composition.as_ref(),
            )
        })
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
        if let Some(composition) = &filesystem.composition {
            normalized_filesystem.composition = Some(normalize_composition(composition));
        }
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
    if let Some(filesystem) = &policy.filesystem {
        if filesystem.composition.is_some() {
            mechanisms.push("filesystem.erofs".to_string());
        } else {
            mechanisms.push("filesystem.access".to_string());
        }
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

fn compile_filesystem(
    read: &[String],
    write: &[String],
    composition: Option<&SandboxFilesystemComposition>,
) -> Result<CompiledFilesystem> {
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
    if composition.is_some() && (!read_paths.is_empty() || !write_paths.is_empty()) {
        return Err(SandboxError::InvalidPolicy(
            "filesystem.composition replaces filesystem.access; carrying both would \
             create two owners for the sandbox root"
                .to_string(),
        ));
    }
    Ok(CompiledFilesystem {
        read: read_paths,
        write: write_paths,
        composition: composition.map(compile_composition).transpose()?,
    })
}

fn compile_composition(composition: &SandboxFilesystemComposition) -> Result<CompiledComposition> {
    let base = compile_image(&composition.base, Path::new("/"))?;
    let Some(workspace_config) = composition.workspace.as_ref() else {
        return Err(SandboxError::InvalidPolicy(
            "filesystem.composition requires workspace.write so the user has a writable tree"
                .to_string(),
        ));
    };
    let image = workspace_config
        .image
        .as_ref()
        .map(|image| compile_image(image, Path::new("/workspace")))
        .transpose()?;
    let write = validate_path(&workspace_config.write)?;
    if write == Path::new("/") {
        return Err(SandboxError::InvalidPolicy(
            "filesystem.composition.workspace.write must name a bounded \
             Agent-owned directory, not the host root"
                .to_string(),
        ));
    }
    let workspace = Some(CompiledWorkspace { image, write });

    let mut toolchains = composition
        .toolchains
        .iter()
        .map(|toolchain| {
            let target = validate_toolchain_target(&toolchain.target)?;
            compile_image(
                &SandboxImageRef {
                    digest: toolchain.digest.clone(),
                    source: toolchain.source.clone(),
                },
                &target,
            )
        })
        .collect::<Result<Vec<_>>>()?;
    toolchains.sort_by(|left, right| left.target.cmp(&right.target));
    for pair in toolchains.windows(2) {
        if let [left, right] = pair {
            if left.target == right.target {
                return Err(SandboxError::InvalidPolicy(format!(
                    "filesystem.composition toolchain target {} is duplicated",
                    left.target.display()
                )));
            }
        }
    }
    Ok(CompiledComposition {
        base,
        workspace,
        toolchains,
    })
}

fn compile_image(image: &SandboxImageRef, target: &Path) -> Result<CompiledImage> {
    validate_image_digest(&image.digest)?;
    let source = validate_path(&image.source)?;
    Ok(CompiledImage {
        digest: image.digest.clone(),
        source,
        target: target.to_path_buf(),
    })
}

fn validate_image_digest(digest: &str) -> Result<()> {
    let hex = digest.strip_prefix("sha256:").ok_or_else(|| {
        SandboxError::InvalidPolicy(format!(
            "filesystem.composition image digest `{digest}` must be sha256:<64 lowercase hex>"
        ))
    })?;
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(SandboxError::InvalidPolicy(format!(
            "filesystem.composition image digest `{digest}` must be sha256:<64 lowercase hex>"
        )));
    }
    Ok(())
}

/// V1 toolchains are exactly `/opt/<name>`: no arbitrary overlapping root
/// composition or ordering language.
fn validate_toolchain_target(raw: &str) -> Result<PathBuf> {
    let path = validate_path(raw)?;
    let components: Vec<_> = path.components().collect();
    let (Some(opt), Some(name)) = (components.get(1), components.get(2)) else {
        return Err(invalid_toolchain_target(raw));
    };
    let valid = components.len() == 3
        && matches!(components.first(), Some(Component::RootDir))
        && matches!(opt, Component::Normal(opt) if opt.to_str() == Some("opt"))
        && matches!(name, Component::Normal(name) if name.to_str().is_some_and(|name| {
            !name.is_empty()
                && name.len() <= 63
                && name.bytes().enumerate().all(|(index, byte)| {
                    matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-')
                        && !(index == 0 && matches!(byte, b'.' | b'_' | b'-'))
                })
        }));
    if !valid {
        return Err(invalid_toolchain_target(raw));
    }
    Ok(path)
}

fn invalid_toolchain_target(raw: &str) -> SandboxError {
    SandboxError::InvalidPolicy(format!(
        "filesystem.composition toolchain target `{raw}` must be /opt/<lowercase name>"
    ))
}

fn normalize_composition(composition: &CompiledComposition) -> SandboxFilesystemComposition {
    SandboxFilesystemComposition {
        base: normalized_image(&composition.base),
        workspace: composition
            .workspace
            .as_ref()
            .map(|workspace| SandboxWorkspace {
                image: workspace.image.as_ref().map(normalized_image),
                write: workspace.write.to_string_lossy().into_owned(),
            }),
        toolchains: composition
            .toolchains
            .iter()
            .map(|image| SandboxToolchainImage {
                digest: image.digest.clone(),
                source: image.source.to_string_lossy().into_owned(),
                target: image.target.to_string_lossy().into_owned(),
            })
            .collect(),
    }
}

fn normalized_image(image: &CompiledImage) -> SandboxImageRef {
    SandboxImageRef {
        digest: image.digest.clone(),
        source: image.source.to_string_lossy().into_owned(),
    }
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

fn compile_cgroup(cgroup: &SandboxCgroupV2Policy) -> Result<CgroupWrites> {
    if cgroup.0.is_empty() {
        return Err(SandboxError::InvalidPolicy(
            "resource.cgroup_v2 requests no limit".to_string(),
        ));
    }
    let mut writes = BTreeMap::new();
    for (file, value) in &cgroup.0 {
        crate::cgroup_file::validate_key(file).map_err(SandboxError::InvalidPolicy)?;
        crate::cgroup_file::validate_value(value).map_err(SandboxError::InvalidPolicy)?;
        writes.insert(file.clone(), value.clone());
    }
    Ok(CgroupWrites { writes })
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
    fn native_cgroup_values_pass_through_without_application_parsers() {
        let compiled = compile(&policy(serde_json::json!({
            "enabled": true,
            "resource": { "cgroup_v2": {
                "cpu.weight": "100",
                "memory.high": "max",
                "io.max": "8:16 rbps=2097152",
                "cpuset.cpus": "0-3"
            } }
        })))
        .expect("native controller files are not restricted to a four-key allowlist");
        let cgroup = compiled.cgroup.expect("compiled cgroup writes");
        assert_eq!(cgroup.get("cpu.weight"), Some("100"));
        assert_eq!(cgroup.get("io.max"), Some("8:16 rbps=2097152"));
        assert_eq!(
            cgroup.controllers(),
            ["cpu", "cpuset", "io", "memory"]
                .into_iter()
                .map(str::to_string)
                .collect()
        );

        for bad in [
            "cgroup.procs",
            "cgroup.threads",
            "memory.stat",
            "memory.reclaim",
            "../memory.max",
            "/sys/fs/cgroup/memory.max",
            "a/b",
        ] {
            let error = compile(&policy(serde_json::json!({
                "enabled": true,
                "resource": { "cgroup_v2": { bad: "1" } }
            })))
            .expect_err("malformed/lifecycle keys must fail closed");
            assert!(
                matches!(error, SandboxError::InvalidPolicy(_)),
                "{bad}: {error}"
            );
        }

        let error = compile(&policy(serde_json::json!({
            "enabled": true,
            "resource": { "cgroup_v2": { "memory.max": "" } }
        })))
        .expect_err("an empty native value must fail closed");
        assert!(matches!(error, SandboxError::InvalidPolicy(_)));
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

    fn composition_policy() -> serde_json::Value {
        serde_json::json!({
            "enabled": true,
            "filesystem": {
                "access": { "read": [], "write": [] },
                "composition": {
                    "base": {
                        "digest": format!("sha256:{}", "a".repeat(64)),
                        "source": "/data/erofs/sha256/base"
                    },
                    "workspace": {
                        "image": {
                            "digest": format!("sha256:{}", "b".repeat(64)),
                            "source": "/data/erofs/sha256/source"
                        },
                        "write": "/data/sandbox/executions/e1/workspace"
                    },
                    "toolchains": [
                        {
                            "digest": format!("sha256:{}", "d".repeat(64)),
                            "source": "/data/erofs/sha256/rust",
                            "target": "/opt/rust"
                        },
                        {
                            "digest": format!("sha256:{}", "c".repeat(64)),
                            "source": "/data/erofs/sha256/node",
                            "target": "/opt/node"
                        }
                    ]
                }
            }
        })
    }

    #[test]
    fn a_prepared_composition_compiles_and_sorts_its_toolchains() {
        let compiled = compile(&policy(composition_policy())).expect("valid composition");
        let filesystem = compiled.filesystem.expect("filesystem");
        let composition = filesystem.composition.expect("composition");
        assert_eq!(composition.base.target, PathBuf::from("/"));
        assert!(composition.workspace.as_ref().unwrap().image.is_some());
        assert_eq!(
            composition
                .toolchains
                .iter()
                .map(|image| image.target.display().to_string())
                .collect::<Vec<_>>(),
            vec!["/opt/node", "/opt/rust"]
        );
        assert!(
            compiled
                .normalized
                .filesystem
                .as_ref()
                .unwrap()
                .composition
                .as_ref()
                .unwrap()
                .toolchains[0]
                .target
                == "/opt/node"
        );
    }

    #[test]
    fn composition_and_access_cannot_both_own_the_root() {
        let mut value = composition_policy();
        value["filesystem"]["access"]["read"] = serde_json::json!(["/usr"]);
        let error = compile(&policy(value)).expect_err("two filesystem owners");
        assert!(matches!(error, SandboxError::InvalidPolicy(_)));
    }

    #[test]
    fn malformed_composition_images_fail_closed() {
        let mut cases = Vec::new();
        for (pointer, bad) in [
            (
                "/filesystem/composition/base/digest",
                serde_json::json!("sha256:ABC"),
            ),
            (
                "/filesystem/composition/base/source",
                serde_json::json!("erofs/base"),
            ),
            (
                "/filesystem/composition/base/source",
                serde_json::json!("/data/../etc/shadow"),
            ),
            (
                "/filesystem/composition/toolchains/0/target",
                serde_json::json!("/usr"),
            ),
            (
                "/filesystem/composition/toolchains/0/target",
                serde_json::json!("/opt/../etc"),
            ),
            (
                "/filesystem/composition/workspace/write",
                serde_json::json!("relative"),
            ),
            ("/filesystem/composition/workspace", serde_json::Value::Null),
        ] {
            let mut value = composition_policy();
            *value.pointer_mut(pointer).expect("fixture path") = bad;
            cases.push(value);
        }
        for value in cases {
            let error = compile(&policy(value)).expect_err("must fail closed");
            assert!(matches!(error, SandboxError::InvalidPolicy(_)));
        }
    }

    #[test]
    fn duplicate_toolchain_targets_are_refused() {
        let mut value = composition_policy();
        value["filesystem"]["composition"]["toolchains"][1]["target"] =
            serde_json::json!("/opt/rust");
        let error = compile(&policy(value)).expect_err("ambiguous mount target");
        assert!(matches!(error, SandboxError::InvalidPolicy(_)));
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
