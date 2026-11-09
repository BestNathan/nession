//! What this host can actually install, and the fail-closed check that binds a
//! compiled policy to it.
//!
//! A capability is measured, not assumed: the Linux probe exercises Bubblewrap
//! namespace flags and cgroup delegation; the macOS probe runs a real Seatbelt
//! allow/deny fixture. An installed executable or a mounted cgroup filesystem
//! is not by itself evidence that a requested guarantee can be installed.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use nession_protocol::contracts::sandbox::v1::{
    SandboxCapabilityCatalog, SandboxCatalogStatus, SandboxFieldEntry, SandboxNetworkMode,
};

use crate::error::{Result, SandboxError};
use crate::policy::CompiledSandboxPolicy;
use crate::settings::SandboxSettings;

/// The host family this build runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Linux,
    Macos,
    Unsupported,
}

impl Platform {
    /// The platform name used in reports.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Linux => "linux",
            Self::Macos => "macos",
            Self::Unsupported => "unsupported",
        }
    }
}

/// Which Linux namespace flags the backend could create.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NamespaceSupport {
    pub user: bool,
    pub pid: bool,
    pub ipc: bool,
    pub uts: bool,
    pub cgroup: bool,
    pub net: bool,
}

impl NamespaceSupport {
    /// Whether a namespace exists for every requested flag.
    pub fn supports(&self, request: &crate::policy::NamespaceRequest) -> bool {
        (!request.user || self.user)
            && (!request.pid || self.pid)
            && (!request.ipc || self.ipc)
            && (!request.uts || self.uts)
            && (!request.cgroup || self.cgroup)
    }
}

/// Whether one allowlisted cgroup control file can actually be installed.
///
/// File presence alone is not installability: the probe writes a harmless
/// native value into an Agent-owned child cgroup and records the kernel's
/// answer, which is what the UI catalog and the policy validator consume.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CgroupFieldSupport {
    pub available: bool,
    pub reason: Option<String>,
}

/// Delegated cgroup v2 support under one writable execution root.
#[derive(Debug, Clone)]
pub struct CgroupSupport {
    /// The execution root under the cgroup mount (control-file access).
    pub root: PathBuf,
    /// The same root as `/proc/<pid>/cgroup` reports it (kernel-relative).
    pub relative_root: PathBuf,
    pub controllers: BTreeSet<String>,
    /// Per allowlisted control file, keyed by its native name.
    pub fields: BTreeMap<String, CgroupFieldSupport>,
    pub detail: String,
}

/// Verified Seatbelt capabilities on macOS.
#[derive(Debug, Clone)]
pub struct SeatbeltSupport {
    pub filesystem: bool,
    pub network_deny: bool,
    pub detail: String,
}

/// The measured capability set.
#[derive(Debug, Clone)]
pub struct Capabilities {
    pub platform: Platform,
    /// `linux-bwrap` or `macos-seatbelt` when the backend is usable.
    pub backend: Option<&'static str>,
    /// Why the backend is unusable, when it is.
    pub unavailable: Option<String>,
    pub namespaces: NamespaceSupport,
    pub cgroup_v2: Option<CgroupSupport>,
    pub seccomp: bool,
    pub filesystem: bool,
    pub network_allow: bool,
    pub network_deny: bool,
    pub network_restricted: bool,
    pub seatbelt: Option<SeatbeltSupport>,
    /// The in-sandbox bridge executable is available.
    pub bridge: bool,
    /// Probe notes, kept as evidence rather than hidden.
    pub detail: Vec<String>,
}

/// Probe this host. Never creates an execution; probe resources are removed.
pub fn probe(settings: &SandboxSettings) -> Capabilities {
    if !settings.enabled {
        return Capabilities {
            platform: platform(),
            backend: None,
            unavailable: Some(
                "the Sandbox backend is disabled by the Agent configuration".to_string(),
            ),
            namespaces: NamespaceSupport::default(),
            cgroup_v2: None,
            seccomp: false,
            filesystem: false,
            network_allow: false,
            network_deny: false,
            network_restricted: false,
            seatbelt: None,
            bridge: false,
            detail: Vec::new(),
        };
    }

    #[cfg(target_os = "linux")]
    {
        crate::linux::probe(settings)
    }
    #[cfg(target_os = "macos")]
    {
        crate::macos::probe(settings)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = settings;
        Capabilities {
            platform: Platform::Unsupported,
            backend: None,
            unavailable: Some("no Sandbox backend exists for this platform".to_string()),
            namespaces: NamespaceSupport::default(),
            cgroup_v2: None,
            seccomp: false,
            filesystem: false,
            network_allow: false,
            network_deny: false,
            network_restricted: false,
            seatbelt: None,
            bridge: false,
            detail: Vec::new(),
        }
    }
}

/// The build's platform, independent of what the host supports.
pub const fn platform() -> Platform {
    #[cfg(target_os = "linux")]
    {
        Platform::Linux
    }
    #[cfg(target_os = "macos")]
    {
        Platform::Macos
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        Platform::Unsupported
    }
}

/// Build the read-only capability catalog the Workspace UI consumes (#3124).
///
/// Hints only: keys are listed when this Agent could actually install them in
/// a child cgroup / load the profile. The compiler, preflight and launch
/// barrier remain the final authorities and re-probe on every Enter.
pub fn catalog(capabilities: &Capabilities) -> SandboxCapabilityCatalog {
    let platform = capabilities.platform.as_str().to_string();
    let mut resource_fields = Vec::new();
    let mut syscall_fields = Vec::new();

    if capabilities.platform == Platform::Linux {
        match &capabilities.cgroup_v2 {
            Some(cgroup) => {
                for (key, value_format, example) in crate::draft::RESOURCE_FIELD_METADATA {
                    let field = cgroup.fields.get(key);
                    resource_fields.push(SandboxFieldEntry {
                        key: key.to_string(),
                        value_format: value_format.to_string(),
                        example: example.to_string(),
                        available: field.map(|field| field.available).unwrap_or(false),
                        reason: match field {
                            Some(field) if field.available => None,
                            Some(field) => field.reason.clone().or_else(|| {
                                Some(
                                    "the kernel refused a probe write to this control file"
                                        .to_string(),
                                )
                            }),
                            None => Some(
                                "the Agent's delegated subtree probe did not measure this control file"
                                    .to_string(),
                            ),
                        },
                    });
                }
            }
            None => {
                for (key, value_format, example) in crate::draft::RESOURCE_FIELD_METADATA {
                    resource_fields.push(SandboxFieldEntry {
                        key: key.to_string(),
                        value_format: value_format.to_string(),
                        example: example.to_string(),
                        available: false,
                        reason: Some(
                            "no writable delegated cgroup v2 subtree on this Agent".to_string(),
                        ),
                    });
                }
            }
        }
        syscall_fields.push(SandboxFieldEntry {
            key: crate::draft::SYSCALL_PROFILE_KEY.to_string(),
            value_format: "registered Agent seccomp profile".to_string(),
            example: crate::policy::SECCOMP_PROFILE_INTERACTIVE_V1.to_string(),
            available: capabilities.seccomp,
            reason: (!capabilities.seccomp)
                .then(|| "the pinned profile could not be loaded on this Agent".to_string()),
        });
    }

    let probe_generation = probe_generation(capabilities, &resource_fields, &syscall_fields);
    let status = if capabilities.backend.is_some() {
        SandboxCatalogStatus::Available
    } else {
        SandboxCatalogStatus::Unavailable
    };
    SandboxCapabilityCatalog {
        status,
        platform,
        backend: capabilities.backend.map(str::to_string),
        probe_generation,
        source: "agent-host-probe".to_string(),
        detail: capabilities.detail.clone(),
        reason: capabilities.unavailable.clone(),
        resource_fields,
        syscall_fields,
    }
}

/// A stable digest over the measured facts; it changes when the host's
/// measured capability changes.
fn probe_generation(
    capabilities: &Capabilities,
    resource_fields: &[SandboxFieldEntry],
    syscall_fields: &[SandboxFieldEntry],
) -> String {
    let mut facts = String::new();
    facts.push_str(capabilities.platform.as_str());
    facts.push('|');
    facts.push_str(capabilities.backend.unwrap_or("-"));
    facts.push('|');
    facts.push_str(capabilities.unavailable.as_deref().unwrap_or("-"));
    facts.push('|');
    facts.push_str(&format!(
        "ns={:?};seccomp={};fs={};net={}{}{};bridge={}",
        capabilities.namespaces,
        capabilities.seccomp,
        capabilities.filesystem,
        capabilities.network_allow,
        capabilities.network_deny,
        capabilities.network_restricted,
        capabilities.bridge
    ));
    for support in capabilities.cgroup_v2.iter() {
        for controller in &support.controllers {
            facts.push_str(";controller=");
            facts.push_str(controller);
        }
        for (key, field) in &support.fields {
            facts.push_str(";field=");
            facts.push_str(key);
            facts.push('=');
            facts.push_str(if field.available { "1" } else { "0" });
        }
    }
    for field in resource_fields.iter().chain(syscall_fields.iter()) {
        facts.push_str(";option=");
        facts.push_str(&field.key);
        facts.push('=');
        facts.push_str(if field.available { "1" } else { "0" });
    }
    crate::policy::hex_sha256(facts.as_bytes())
}

/// Reject a compiled policy this host cannot install.
///
/// This is the fail-closed gate: there is no "drop the unsupported part and
/// continue" branch. Linux-native keys on macOS and unavailable controllers on
/// Linux both refuse the launch.
pub fn validate(compiled: &CompiledSandboxPolicy, capabilities: &Capabilities) -> Result<()> {
    let backend = capabilities.backend.ok_or_else(|| {
        SandboxError::BackendUnavailable(
            capabilities
                .unavailable
                .clone()
                .unwrap_or_else(|| "the Sandbox backend is unavailable".to_string()),
        )
    })?;

    match capabilities.platform {
        Platform::Linux => {
            if backend != "linux-bwrap" {
                return Err(SandboxError::BackendUnavailable(
                    "unexpected Linux backend".to_string(),
                ));
            }
            validate_linux(compiled, capabilities)
        }
        Platform::Macos => validate_macos(compiled, capabilities),
        Platform::Unsupported => Err(SandboxError::UnsupportedPolicy(
            "no Sandbox backend exists for this platform".to_string(),
        )),
    }
}

fn validate_linux(compiled: &CompiledSandboxPolicy, capabilities: &Capabilities) -> Result<()> {
    if compiled.filesystem.is_some() && !capabilities.filesystem {
        return Err(SandboxError::UnsupportedPolicy(
            "filesystem.access requires a working Bubblewrap mount view".to_string(),
        ));
    }

    if let Some(network) = &compiled.network {
        match network.mode {
            SandboxNetworkMode::Allow => {}
            SandboxNetworkMode::Deny if !capabilities.network_deny => {
                return Err(SandboxError::UnsupportedPolicy(
                    "network.mode deny requires a working network namespace".to_string(),
                ));
            }
            SandboxNetworkMode::Deny => {}
            SandboxNetworkMode::Restricted => {
                if !capabilities.network_deny {
                    return Err(SandboxError::UnsupportedPolicy(
                        "network.mode restricted requires a working network namespace".to_string(),
                    ));
                }
                if !capabilities.bridge {
                    return Err(SandboxError::UnsupportedPolicy(
                        "network.mode restricted requires the in-sandbox bridge executable"
                            .to_string(),
                    ));
                }
            }
        }
    }

    let requested = compiled.namespaces;
    if requested.any() && !capabilities.namespaces.supports(&requested) {
        let missing = requested
            .mechanism_names()
            .into_iter()
            .filter(|name| !namespace_supported(capabilities, name))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(SandboxError::UnsupportedPolicy(format!(
            "process.linux_namespaces cannot create: {missing}"
        )));
    }

    if let Some(cgroup) = &compiled.cgroup {
        let support = capabilities.cgroup_v2.as_ref().ok_or_else(|| {
            SandboxError::UnsupportedPolicy(
                "resource.cgroup_v2 requires a writable delegated cgroup v2 subtree".to_string(),
            )
        })?;
        let missing = cgroup
            .controllers()
            .into_iter()
            .filter(|controller| !support.controllers.contains(*controller))
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(SandboxError::UnsupportedPolicy(format!(
                "resource.cgroup_v2 controllers are not delegated: {}",
                missing.join(", ")
            )));
        }
        // A delegated controller is not proof that its control file can be
        // written. The child-cgroup probe measured each allowlisted file, and
        // a key that was probed unavailable fails here even when the
        // controller is delegated.
        for (file, _) in cgroup.files() {
            if let Some(field) = support.fields.get(file) {
                if !field.available {
                    return Err(SandboxError::UnsupportedPolicy(format!(
                        "resource.cgroup_v2 {file} is not installable on this host: {}",
                        field
                            .reason
                            .as_deref()
                            .unwrap_or("the child cgroup refused a probe write")
                    )));
                }
            }
        }
    }

    if compiled.seccomp.is_some() && !capabilities.seccomp {
        return Err(SandboxError::UnsupportedPolicy(
            "syscall.seccomp requires a kernel and Bubblewrap that can load the pinned filter"
                .to_string(),
        ));
    }

    Ok(())
}

fn namespace_supported(capabilities: &Capabilities, name: &str) -> bool {
    match name {
        "pid" => capabilities.namespaces.pid,
        "ipc" => capabilities.namespaces.ipc,
        "user" => capabilities.namespaces.user,
        "uts" => capabilities.namespaces.uts,
        "cgroup" => capabilities.namespaces.cgroup,
        _ => false,
    }
}

fn validate_macos(compiled: &CompiledSandboxPolicy, capabilities: &Capabilities) -> Result<()> {
    if compiled.namespaces.any() {
        return Err(SandboxError::UnsupportedPolicy(
            "process.linux_namespaces is Linux-native and is not supported on macOS".to_string(),
        ));
    }
    if compiled.cgroup.is_some() {
        return Err(SandboxError::UnsupportedPolicy(
            "resource.cgroup_v2 is Linux-native and is not supported on macOS; setrlimit is not an equivalent"
                .to_string(),
        ));
    }
    if compiled.seccomp.is_some() {
        return Err(SandboxError::UnsupportedPolicy(
            "syscall.seccomp is Linux-native and is not supported on macOS".to_string(),
        ));
    }
    let seatbelt = capabilities.seatbelt.as_ref().ok_or_else(|| {
        SandboxError::UnsupportedPolicy(
            "macOS Seatbelt is unavailable; no sandbox guarantee can be installed".to_string(),
        )
    })?;
    if compiled.filesystem.is_some() && !seatbelt.filesystem {
        return Err(SandboxError::UnsupportedPolicy(
            "filesystem.access could not be verified under macOS Seatbelt".to_string(),
        ));
    }
    if let Some(network) = &compiled.network {
        match network.mode {
            SandboxNetworkMode::Allow => {}
            SandboxNetworkMode::Deny if !seatbelt.network_deny => {
                return Err(SandboxError::UnsupportedPolicy(
                    "network.mode deny could not be verified under macOS Seatbelt".to_string(),
                ));
            }
            SandboxNetworkMode::Deny => {}
            SandboxNetworkMode::Restricted => {
                return Err(SandboxError::UnsupportedPolicy(
                    "network.mode restricted is not supported by the macOS backend in V1"
                        .to_string(),
                ));
            }
        }
    }
    let _ = capabilities.backend;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::compile;
    use nession_protocol::contracts::sandbox::v1::SandboxPolicy;

    fn compiled(value: serde_json::Value) -> CompiledSandboxPolicy {
        let policy: SandboxPolicy = serde_json::from_value(value).expect("policy fixture");
        compile(&policy).expect("compiled")
    }

    fn linux_capabilities() -> Capabilities {
        Capabilities {
            platform: Platform::Linux,
            backend: Some("linux-bwrap"),
            unavailable: None,
            namespaces: NamespaceSupport {
                user: true,
                pid: true,
                ipc: true,
                uts: true,
                cgroup: true,
                net: true,
            },
            cgroup_v2: Some(CgroupSupport {
                root: PathBuf::from("/sys/fs/cgroup/nession"),
                relative_root: PathBuf::from("/nession"),
                controllers: ["memory", "cpu", "pids"]
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
                fields: ["memory.max", "cpu.max", "pids.max", "memory.oom.group"]
                    .into_iter()
                    .map(|key| {
                        (
                            key.to_string(),
                            CgroupFieldSupport {
                                available: true,
                                reason: None,
                            },
                        )
                    })
                    .collect(),
                detail: "delegated".to_string(),
            }),
            seccomp: true,
            filesystem: true,
            network_allow: true,
            network_deny: true,
            network_restricted: true,
            seatbelt: None,
            bridge: true,
            detail: Vec::new(),
        }
    }

    fn macos_capabilities() -> Capabilities {
        Capabilities {
            platform: Platform::Macos,
            backend: Some("macos-seatbelt"),
            unavailable: None,
            namespaces: NamespaceSupport::default(),
            cgroup_v2: None,
            seccomp: false,
            filesystem: false,
            network_allow: true,
            network_deny: true,
            network_restricted: false,
            seatbelt: Some(SeatbeltSupport {
                filesystem: false,
                network_deny: true,
                detail: "network denial verified; path allow-lists not verified".to_string(),
            }),
            bridge: false,
            detail: Vec::new(),
        }
    }

    #[test]
    fn a_missing_backend_is_refused_with_its_measured_reason() {
        let mut capabilities = linux_capabilities();
        capabilities.backend = None;
        capabilities.unavailable = Some("sandbox disabled by Agent configuration".to_string());
        let error = validate(
            &compiled(serde_json::json!({ "enabled": true })),
            &capabilities,
        )
        .expect_err("no backend must refuse");
        assert!(matches!(error, SandboxError::BackendUnavailable(_)));
        assert!(error
            .to_string()
            .contains("disabled by Agent configuration"));
    }

    #[test]
    fn linux_native_keys_are_refused_on_macos() {
        let capabilities = macos_capabilities();
        for policy in [
            serde_json::json!({
                "enabled": true,
                "process": { "linux_namespaces": { "pid": true } }
            }),
            serde_json::json!({
                "enabled": true,
                "resource": { "cgroup_v2": { "memory.max": "1024" } }
            }),
            serde_json::json!({
                "enabled": true,
                "syscall": { "seccomp": { "profile": "nession-interactive-v1" } }
            }),
            serde_json::json!({
                "enabled": true,
                "filesystem": { "access": { "read": ["/usr"], "write": [] } }
            }),
        ] {
            let error = validate(&compiled(policy), &capabilities)
                .expect_err("macOS must refuse a guarantee it did not verify");
            assert!(
                matches!(error, SandboxError::UnsupportedPolicy(_)),
                "{error}"
            );
        }
    }

    #[test]
    fn undelegated_cgroup_controllers_are_refused() {
        let mut capabilities = linux_capabilities();
        capabilities.cgroup_v2 = Some(CgroupSupport {
            root: PathBuf::from("/sys/fs/cgroup/nession"),
            relative_root: PathBuf::from("/nession"),
            controllers: ["cpu"].into_iter().map(str::to_string).collect(),
            fields: BTreeMap::new(),
            detail: "cpu only".to_string(),
        });
        let error = validate(
            &compiled(serde_json::json!({
                "enabled": true,
                "resource": { "cgroup_v2": { "pids.max": "64" } }
            })),
            &capabilities,
        )
        .expect_err("an undelegated pids controller must fail closed");
        assert!(matches!(error, SandboxError::UnsupportedPolicy(_)));
        assert!(error.to_string().contains("not delegated"));
    }

    #[test]
    fn restricted_network_requires_the_bridge() {
        let mut capabilities = linux_capabilities();
        capabilities.bridge = false;
        capabilities.network_restricted = false;
        let error = validate(
            &compiled(serde_json::json!({
                "enabled": true,
                "network": { "mode": "restricted", "egress": { "allow": ["example.com:443"] } }
            })),
            &capabilities,
        )
        .expect_err("restricted mode without the bridge must fail closed");
        assert!(matches!(error, SandboxError::UnsupportedPolicy(_)));
        assert!(error.to_string().contains("bridge"));
    }

    #[test]
    fn a_probed_unavailable_control_file_is_refused_even_when_delegated() {
        let mut capabilities = linux_capabilities();
        if let Some(support) = capabilities.cgroup_v2.as_mut() {
            support.controllers.insert("cpu".to_string());
            support.fields.insert(
                "cpu.max".to_string(),
                CgroupFieldSupport {
                    available: false,
                    reason: Some("the kernel refused a probe write".to_string()),
                },
            );
        }
        let error = validate(
            &compiled(serde_json::json!({
                "enabled": true,
                "resource": { "cgroup_v2": { "cpu.max": "200000 100000" } }
            })),
            &capabilities,
        )
        .expect_err("an uninstallable field must fail closed");
        assert!(error.to_string().contains("cpu.max"));
        assert!(error.to_string().contains("probe write"));
    }

    #[test]
    fn the_catalog_lists_only_probed_fields_and_pins_their_generation() {
        let capabilities = linux_capabilities();
        let measured = catalog(&capabilities);
        assert_eq!(measured.status, SandboxCatalogStatus::Available);
        assert_eq!(measured.backend.as_deref(), Some("linux-bwrap"));
        assert_eq!(measured.resource_fields.len(), 4);
        assert!(measured.resource_fields.iter().all(|field| field.available));
        assert_eq!(measured.syscall_fields.len(), 1);
        assert_eq!(measured.syscall_fields[0].key, "seccomp.profile");
        assert_eq!(measured.probe_generation.len(), 64);

        let mut changed = linux_capabilities();
        if let Some(support) = changed.cgroup_v2.as_mut() {
            support.fields.insert(
                "cpu.max".to_string(),
                CgroupFieldSupport {
                    available: false,
                    reason: Some("not installable".to_string()),
                },
            );
        }
        let changed_catalog = catalog(&changed);
        assert_ne!(
            measured.probe_generation, changed_catalog.probe_generation,
            "a changed measured field must change the probe generation"
        );
        let cpu = changed_catalog
            .resource_fields
            .iter()
            .find(|field| field.key == "cpu.max")
            .expect("cpu.max is still listed");
        assert!(!cpu.available);
        assert_eq!(cpu.reason.as_deref(), Some("not installable"));
    }

    #[test]
    fn macos_offers_no_linux_native_catalog_keys() {
        let catalog = catalog(&macos_capabilities());
        assert!(catalog.resource_fields.is_empty());
        assert!(catalog.syscall_fields.is_empty());
    }

    #[test]
    fn an_unavailable_backend_reports_the_measured_reason() {
        let mut capabilities = linux_capabilities();
        capabilities.backend = None;
        capabilities.unavailable = Some("bubblewrap is not executable on this host".to_string());
        let catalog = catalog(&capabilities);
        assert_eq!(catalog.status, SandboxCatalogStatus::Unavailable);
        assert_eq!(
            catalog.reason.as_deref(),
            Some("bubblewrap is not executable on this host")
        );
    }

    #[test]
    fn namespace_support_requires_every_requested_flag() {
        let support = NamespaceSupport {
            user: true,
            pid: true,
            ipc: false,
            uts: true,
            cgroup: false,
            net: true,
        };
        assert!(support.supports(&crate::policy::NamespaceRequest {
            pid: true,
            user: true,
            ..Default::default()
        }));
        assert!(!support.supports(&crate::policy::NamespaceRequest {
            ipc: true,
            ..Default::default()
        }));
    }
}
