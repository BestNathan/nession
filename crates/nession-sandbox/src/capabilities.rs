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
    SandboxCapabilityCatalog, SandboxCatalogStatus, SandboxFieldEntry, SandboxFieldError,
    SandboxImplementationStatus, SandboxImplementationSupport, SandboxNetworkMode,
    SandboxOptionSupport, SandboxPolicy, SandboxUnsupportedReason, SANDBOX_CATALOG_VERSION,
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
    /// Prepared EROFS images can be mounted read-only without privileges
    /// (`erofsfuse` plus a usable `/dev/fuse` and an Agent-authorized root).
    pub erofs: bool,
    /// A Project image can be merged with a bounded writable upper/work via
    /// the unprivileged `fuse-overlayfs` helper.
    pub erofs_overlay: bool,
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
            erofs: false,
            erofs_overlay: false,
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
            erofs: false,
            erofs_overlay: false,
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

/// Build the read-only capability catalog the Workspace UI consumes (#3161).
///
/// The catalog separates every schema-known implementation by its canonical
/// policy path and every enumerated option (network mode, namespace, seccomp
/// profile, cgroup control file) by the same measured facts `validate` uses.
/// A path this build does not implement is never invented: only
/// [`crate::REGISTERED_IMPLEMENTATION_PATHS`] can appear.
///
/// Hints only: the compiler, preflight and launch barrier remain the final
/// authorities and re-probe on every Enter.
pub fn catalog(capabilities: &Capabilities) -> SandboxCapabilityCatalog {
    let implementations = implementations(capabilities);
    // The flat arrays are the pre-v2 projection: Linux-native keys only,
    // exactly as the catalog reported before per-implementation discovery.
    let (resource_fields, syscall_fields) = if capabilities.platform == Platform::Linux {
        let resource_fields = implementations
            .iter()
            .find(|implementation| implementation.path == "resource.cgroup_v2")
            .map(|implementation| implementation.fields.clone())
            .unwrap_or_default();
        let syscall_fields = implementations
            .iter()
            .find(|implementation| implementation.path == "syscall.seccomp")
            .and_then(|implementation| implementation.options.first())
            .map(|profile| SandboxFieldEntry {
                key: crate::draft::SYSCALL_PROFILE_KEY.to_string(),
                controller: None,
                value_format: "registered Agent seccomp profile".to_string(),
                example: profile.id.clone(),
                available: profile.status == SandboxImplementationStatus::Available,
                reason_code: profile.reason_code,
                reason: profile.reason.clone(),
            })
            .into_iter()
            .collect();
        (resource_fields, syscall_fields)
    } else {
        (Vec::new(), Vec::new())
    };

    let probe_generation = probe_generation(capabilities, &implementations);
    let status = if capabilities.backend.is_some() {
        SandboxCatalogStatus::Available
    } else {
        SandboxCatalogStatus::Unavailable
    };
    SandboxCapabilityCatalog {
        catalog_version: SANDBOX_CATALOG_VERSION,
        status,
        platform: capabilities.platform.as_str().to_string(),
        backend: capabilities.backend.map(str::to_string),
        probe_generation,
        source: "agent-host-probe".to_string(),
        detail: capabilities.detail.clone(),
        reason: capabilities.unavailable.clone(),
        implementations,
        resource_fields,
        syscall_fields,
    }
}

/// Build the typed per-implementation support entries from measured facts.
pub fn implementations(capabilities: &Capabilities) -> Vec<SandboxImplementationSupport> {
    let backend_missing = capabilities.backend.is_none();
    let backend_reason = capabilities
        .unavailable
        .clone()
        .unwrap_or_else(|| "no usable Sandbox backend on this Agent".to_string());
    let linux = capabilities.platform == Platform::Linux;
    let macos = capabilities.platform == Platform::Macos;

    // Without a backend nothing is usable, even if an individual fact was
    // measured in an earlier probe. Platform-native paths keep their stronger
    // platform_unsupported diagnosis; everything else says backend_missing.
    if backend_missing {
        return nession_protocol::contracts::sandbox::v1::REGISTERED_IMPLEMENTATION_PATHS
            .iter()
            .map(|path| {
                let native_elsewhere = macos
                    && matches!(
                        *path,
                        "filesystem.composition"
                            | "process.linux_namespaces"
                            | "resource.cgroup_v2"
                            | "syscall.seccomp"
                    );
                let code = if native_elsewhere || capabilities.platform == Platform::Unsupported {
                    SandboxUnsupportedReason::PlatformUnsupported
                } else {
                    SandboxUnsupportedReason::BackendMissing
                };
                let reason = backend_reason.clone();
                let mut entry = implementation(path, Unavailable(Some(code), reason.clone()));
                // Registered options stay discoverable even when no backend
                // exists; they are all measured unavailable with the same
                // stable reason. No unregistered future path is invented.
                match *path {
                    "network" => {
                        entry.options = ["allow", "deny", "restricted"]
                            .into_iter()
                            .map(|id| SandboxOptionSupport::unavailable(id, code, reason.clone()))
                            .collect();
                    }
                    "process.linux_namespaces" => {
                        entry.options = ["pid", "ipc", "user", "uts", "cgroup"]
                            .into_iter()
                            .map(|id| SandboxOptionSupport::unavailable(id, code, reason.clone()))
                            .collect();
                    }
                    "resource.cgroup_v2" => {
                        entry.fields = crate::draft::RESOURCE_FIELD_METADATA
                            .into_iter()
                            .map(|(key, value_format, example)| SandboxFieldEntry {
                                key: key.to_string(),
                                controller: Some(key.split('.').next().unwrap_or(key).to_string()),
                                value_format: value_format.to_string(),
                                example: example.to_string(),
                                available: false,
                                reason_code: Some(code),
                                reason: Some(reason.clone()),
                            })
                            .collect();
                    }
                    "syscall.seccomp" => {
                        entry.options = vec![SandboxOptionSupport::unavailable(
                            crate::policy::SECCOMP_PROFILE_INTERACTIVE_V1,
                            code,
                            reason.clone(),
                        )];
                    }
                    _ => {}
                }
                entry
            })
            .collect();
    }

    let mut entries = Vec::new();
    entries.push(implementation(
        "filesystem.access",
        if backend_missing {
            Unavailable(
                Some(SandboxUnsupportedReason::BackendMissing),
                backend_reason.clone(),
            )
        } else if linux {
            match capabilities.filesystem {
                true => Available,
                false => Unavailable(
                    Some(SandboxUnsupportedReason::KernelFeatureMissing),
                    "the Bubblewrap mount view is unavailable".to_string(),
                ),
            }
        } else if macos {
            match capabilities.seatbelt.as_ref() {
                Some(seatbelt) if seatbelt.filesystem => Available,
                Some(_) => Unavailable(
                    Some(SandboxUnsupportedReason::KernelFeatureMissing),
                    "filesystem access could not be verified under macOS Seatbelt".to_string(),
                ),
                None => Unavailable(
                    Some(SandboxUnsupportedReason::BackendMissing),
                    "macOS Seatbelt is unavailable".to_string(),
                ),
            }
        } else {
            Unavailable(
                Some(SandboxUnsupportedReason::PlatformUnsupported),
                "no Sandbox backend exists for this platform".to_string(),
            )
        },
    ));

    let composition = if linux {
        if capabilities.erofs {
            Available
        } else {
            Unavailable(
                Some(SandboxUnsupportedReason::KernelFeatureMissing),
                "prepared EROFS composition requires erofsfuse, fusermount and a usable /dev/fuse"
                    .to_string(),
            )
        }
    } else if macos || backend_missing {
        Unavailable(
            Some(if macos {
                SandboxUnsupportedReason::PlatformUnsupported
            } else {
                SandboxUnsupportedReason::BackendMissing
            }),
            "prepared EROFS composition is Linux-native".to_string(),
        )
    } else {
        Unavailable(
            Some(SandboxUnsupportedReason::PlatformUnsupported),
            "no Sandbox backend exists for this platform".to_string(),
        )
    };
    let mut composition_entry = implementation("filesystem.composition", composition);
    if linux && capabilities.erofs {
        composition_entry
            .options
            .push(if capabilities.erofs_overlay {
                SandboxOptionSupport::available("workspace_image")
            } else {
                SandboxOptionSupport::unavailable(
                    "workspace_image",
                    SandboxUnsupportedReason::KernelFeatureMissing,
                    "a Project source image requires the unprivileged fuse-overlayfs helper",
                )
            });
    }
    entries.push(composition_entry);

    let network = |mode: &str, measured: bool, reason: &str| {
        if backend_missing {
            SandboxOptionSupport::unavailable(
                mode,
                SandboxUnsupportedReason::BackendMissing,
                backend_reason.clone(),
            )
        } else if measured {
            SandboxOptionSupport::available(mode)
        } else {
            SandboxOptionSupport::unavailable(
                mode,
                if macos {
                    SandboxUnsupportedReason::PlatformUnsupported
                } else {
                    SandboxUnsupportedReason::KernelFeatureMissing
                },
                reason,
            )
        }
    };
    let allow = network(
        "allow",
        capabilities.network_allow || linux || macos,
        "the host network is unavailable",
    );
    let deny = network(
        "deny",
        capabilities.network_deny,
        "a working network namespace is required",
    );
    let restricted = network(
        "restricted",
        capabilities.network_restricted && capabilities.bridge,
        "restricted network requires a working network namespace and the in-sandbox bridge",
    );
    entries.push(with_options(
        "network",
        vec![allow, deny, restricted],
        Some(SandboxUnsupportedReason::BackendMissing),
        backend_reason.clone(),
    ));

    let namespaces = [
        (
            "pid",
            capabilities.namespaces.pid,
            "the PID namespace is unavailable",
        ),
        (
            "ipc",
            capabilities.namespaces.ipc,
            "the IPC namespace is unavailable",
        ),
        (
            "user",
            capabilities.namespaces.user,
            "the user namespace is unavailable",
        ),
        (
            "uts",
            capabilities.namespaces.uts,
            "the UTS namespace is unavailable",
        ),
        (
            "cgroup",
            capabilities.namespaces.cgroup,
            "the cgroup namespace is unavailable",
        ),
    ];
    let namespace_options = namespaces
        .into_iter()
        .map(|(id, measured, reason)| {
            if !linux {
                SandboxOptionSupport::unavailable(
                    id,
                    if backend_missing && !macos {
                        SandboxUnsupportedReason::BackendMissing
                    } else {
                        SandboxUnsupportedReason::PlatformUnsupported
                    },
                    "process.linux_namespaces is Linux-native",
                )
            } else if measured {
                SandboxOptionSupport::available(id)
            } else {
                SandboxOptionSupport::unavailable(
                    id,
                    SandboxUnsupportedReason::KernelFeatureMissing,
                    reason,
                )
            }
        })
        .collect();
    entries.push(if linux {
        with_options(
            "process.linux_namespaces",
            namespace_options,
            None,
            String::new(),
        )
    } else {
        let reason = if backend_missing && !macos {
            SandboxUnsupportedReason::BackendMissing
        } else {
            SandboxUnsupportedReason::PlatformUnsupported
        };
        implementation(
            "process.linux_namespaces",
            Unavailable(
                Some(reason),
                "process.linux_namespaces is Linux-native".to_string(),
            ),
        )
    });

    let mut fields = Vec::new();
    if linux {
        for (key, value_format, example) in crate::draft::RESOURCE_FIELD_METADATA {
            let field = capabilities
                .cgroup_v2
                .as_ref()
                .and_then(|cgroup| cgroup.fields.get(key));
            let available = field.map(|field| field.available).unwrap_or(false);
            let reason_code = if available {
                None
            } else if capabilities.cgroup_v2.is_none() {
                Some(SandboxUnsupportedReason::ControllerNotDelegated)
            } else {
                Some(SandboxUnsupportedReason::PermissionDenied)
            };
            let reason = if available {
                None
            } else if capabilities.cgroup_v2.is_none() {
                Some("no writable delegated cgroup v2 subtree on this Agent".to_string())
            } else {
                Some(
                    field
                        .and_then(|field| field.reason.clone())
                        .unwrap_or_else(|| "the kernel refused a probe write".to_string()),
                )
            };
            fields.push(SandboxFieldEntry {
                key: key.to_string(),
                controller: Some(key.split('.').next().unwrap_or(key).to_string()),
                value_format: value_format.to_string(),
                example: example.to_string(),
                available,
                reason_code,
                reason,
            });
        }
    }
    let cgroup_status = if !linux {
        Unavailable(
            Some(if backend_missing && !macos {
                SandboxUnsupportedReason::BackendMissing
            } else {
                SandboxUnsupportedReason::PlatformUnsupported
            }),
            "resource.cgroup_v2 is Linux-native".to_string(),
        )
    } else if capabilities.cgroup_v2.is_none() {
        Unavailable(
            Some(SandboxUnsupportedReason::ControllerNotDelegated),
            "no writable delegated cgroup v2 subtree on this Agent".to_string(),
        )
    } else if fields.iter().any(|field| field.available) {
        Available
    } else {
        Unavailable(
            Some(SandboxUnsupportedReason::PermissionDenied),
            "the delegated cgroup subtree measured no installable control file".to_string(),
        )
    };
    let mut cgroup_entry = implementation("resource.cgroup_v2", cgroup_status);
    cgroup_entry.fields = fields;
    entries.push(cgroup_entry);

    let profile = crate::policy::SECCOMP_PROFILE_INTERACTIVE_V1;
    let mut seccomp = if !linux {
        implementation(
            "syscall.seccomp",
            Unavailable(
                Some(if backend_missing && !macos {
                    SandboxUnsupportedReason::BackendMissing
                } else {
                    SandboxUnsupportedReason::PlatformUnsupported
                }),
                "syscall.seccomp is Linux-native".to_string(),
            ),
        )
    } else if capabilities.seccomp {
        with_options(
            "syscall.seccomp",
            vec![SandboxOptionSupport::available(profile)],
            None,
            String::new(),
        )
    } else {
        implementation(
            "syscall.seccomp",
            Unavailable(
                Some(SandboxUnsupportedReason::ProfileUnavailable),
                "the pinned seccomp profile could not be loaded on this Agent".to_string(),
            ),
        )
    };
    seccomp.options = if linux {
        vec![if capabilities.seccomp {
            SandboxOptionSupport::available(profile)
        } else {
            SandboxOptionSupport::unavailable(
                profile,
                SandboxUnsupportedReason::ProfileUnavailable,
                "the pinned seccomp profile could not be loaded on this Agent",
            )
        }]
    } else {
        vec![SandboxOptionSupport::unavailable(
            profile,
            if backend_missing && !macos {
                SandboxUnsupportedReason::BackendMissing
            } else {
                SandboxUnsupportedReason::PlatformUnsupported
            },
            "seccomp profiles are Linux-native",
        )]
    };
    entries.push(seccomp);

    entries
}

enum SupportState {
    Available,
    Unavailable(Option<SandboxUnsupportedReason>, String),
}

use SupportState::{Available, Unavailable};

fn implementation(path: &str, state: SupportState) -> SandboxImplementationSupport {
    match state {
        Available => SandboxImplementationSupport {
            path: path.to_string(),
            status: SandboxImplementationStatus::Available,
            reason_code: None,
            reason: None,
            options: Vec::new(),
            fields: Vec::new(),
        },
        Unavailable(code, reason) => SandboxImplementationSupport {
            path: path.to_string(),
            status: SandboxImplementationStatus::Unavailable,
            reason_code: code,
            reason: Some(reason),
            options: Vec::new(),
            fields: Vec::new(),
        },
    }
}

/// An implementation whose own availability derives from its measured options.
fn with_options(
    path: &str,
    options: Vec<SandboxOptionSupport>,
    missing_code: Option<SandboxUnsupportedReason>,
    missing_reason: String,
) -> SandboxImplementationSupport {
    let usable = options
        .iter()
        .any(|option| option.status == SandboxImplementationStatus::Available);
    if usable {
        SandboxImplementationSupport {
            path: path.to_string(),
            status: SandboxImplementationStatus::Available,
            reason_code: None,
            reason: None,
            options,
            fields: Vec::new(),
        }
    } else {
        let (code, reason) = options
            .iter()
            .find_map(|option| option.reason_code.map(|code| (code, option.reason.clone())))
            .map(|(code, reason)| (Some(code), reason.unwrap_or_else(|| missing_reason.clone())))
            .unwrap_or((missing_code, missing_reason));
        SandboxImplementationSupport {
            path: path.to_string(),
            status: SandboxImplementationStatus::Unavailable,
            reason_code: code,
            reason: Some(reason),
            options,
            fields: Vec::new(),
        }
    }
}

/// A stable digest over the measured facts; it changes when the host's
/// measured capability changes.
fn probe_generation(
    capabilities: &Capabilities,
    implementations: &[SandboxImplementationSupport],
) -> String {
    let mut facts = String::new();
    facts.push_str(capabilities.platform.as_str());
    facts.push('|');
    facts.push_str(capabilities.backend.unwrap_or("-"));
    facts.push('|');
    facts.push_str(capabilities.unavailable.as_deref().unwrap_or("-"));
    for implementation in implementations {
        facts.push_str(";impl=");
        facts.push_str(&implementation.path);
        facts.push('=');
        facts.push_str(status_key(implementation.status));
        if let Some(code) = implementation.reason_code {
            facts.push_str(" reason=");
            facts.push_str(reason_key(code));
        }
        for option in &implementation.options {
            facts.push_str(";option=");
            facts.push_str(&option.id);
            facts.push('=');
            facts.push_str(status_key(option.status));
            if let Some(code) = option.reason_code {
                facts.push_str(" reason=");
                facts.push_str(reason_key(code));
            }
        }
        for field in &implementation.fields {
            facts.push_str(";field=");
            facts.push_str(&field.key);
            facts.push('=');
            facts.push_str(if field.available { "1" } else { "0" });
            if let Some(code) = field.reason_code {
                facts.push_str(" reason=");
                facts.push_str(reason_key(code));
            }
        }
    }
    crate::policy::hex_sha256(facts.as_bytes())
}

fn status_key(status: SandboxImplementationStatus) -> &'static str {
    match status {
        SandboxImplementationStatus::Available => "available",
        SandboxImplementationStatus::Unavailable => "unavailable",
        SandboxImplementationStatus::Unknown => "unknown",
    }
}

fn reason_key(reason: SandboxUnsupportedReason) -> &'static str {
    match reason {
        SandboxUnsupportedReason::PlatformUnsupported => "platform_unsupported",
        SandboxUnsupportedReason::BackendMissing => "backend_missing",
        SandboxUnsupportedReason::KernelFeatureMissing => "kernel_feature_missing",
        SandboxUnsupportedReason::ControllerNotDelegated => "controller_not_delegated",
        SandboxUnsupportedReason::PermissionDenied => "permission_denied",
        SandboxUnsupportedReason::ProfileUnavailable => "profile_unavailable",
        SandboxUnsupportedReason::ImplementationNotBuilt => "implementation_not_built",
        SandboxUnsupportedReason::NotProbed => "not_probed",
        SandboxUnsupportedReason::Timeout => "timeout",
    }
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
    let composition = compiled
        .filesystem
        .as_ref()
        .is_some_and(|filesystem| filesystem.composition.is_some());
    if composition && !capabilities.erofs {
        return Err(SandboxError::UnsupportedPolicy(
            "filesystem.composition requires an unprivileged EROFS mount \
             (erofsfuse, fusermount and a usable /dev/fuse) plus an Agent-authorized image root"
                .to_string(),
        ));
    }
    let needs_overlay = compiled
        .filesystem
        .as_ref()
        .and_then(|filesystem| filesystem.composition.as_ref())
        .and_then(|composition| composition.workspace.as_ref())
        .is_some_and(|workspace| workspace.image.is_some());
    if needs_overlay && !capabilities.erofs_overlay {
        return Err(SandboxError::UnsupportedPolicy(
            "filesystem.composition with a Project source image requires the unprivileged \
             fuse-overlayfs helper for its bounded writable upper/work"
                .to_string(),
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

/// Every explicitly requested implementation or option this host cannot
/// install, as field-path errors (#3161).
///
/// This is the preflight/Enter-friendly projection of [`validate`]: the same
/// measured facts, every failure instead of the first, and the canonical
/// policy field path a client can point at. `validate` remains the
/// fail-closed gate; this function must never report fewer failures.
pub fn unsupported_requests(
    policy: &SandboxPolicy,
    capabilities: &Capabilities,
) -> Vec<SandboxFieldError> {
    let mut errors = Vec::new();
    let push = |errors: &mut Vec<SandboxFieldError>, field: &str, message: String| {
        errors.push(SandboxFieldError {
            field: field.to_string(),
            code: "unsupported".to_string(),
            message,
        });
    };
    if capabilities.backend.is_none() {
        push(
            &mut errors,
            "policy",
            capabilities
                .unavailable
                .clone()
                .unwrap_or_else(|| "the Sandbox backend is unavailable".to_string()),
        );
        return errors;
    }

    match capabilities.platform {
        Platform::Linux => {
            if let Some(filesystem) = &policy.filesystem {
                if !capabilities.filesystem {
                    push(
                        &mut errors,
                        "filesystem.access",
                        "filesystem.access requires a working Bubblewrap mount view".to_string(),
                    );
                }
                if let Some(composition) = &filesystem.composition {
                    if !capabilities.erofs {
                        push(
                            &mut errors,
                            "filesystem.composition",
                            "filesystem.composition requires an unprivileged EROFS mount"
                                .to_string(),
                        );
                    }
                    if composition
                        .workspace
                        .as_ref()
                        .and_then(|workspace| workspace.image.as_ref())
                        .is_some()
                        && !capabilities.erofs_overlay
                    {
                        push(
                            &mut errors,
                            "filesystem.composition.workspace.image",
                            "a Project source image requires the unprivileged fuse-overlayfs helper"
                                .to_string(),
                        );
                    }
                }
            }
            if let Some(network) = &policy.network {
                match network.mode {
                    SandboxNetworkMode::Allow => {}
                    SandboxNetworkMode::Deny if !capabilities.network_deny => push(
                        &mut errors,
                        "network.mode",
                        "network.mode deny requires a working network namespace".to_string(),
                    ),
                    SandboxNetworkMode::Deny => {}
                    SandboxNetworkMode::Restricted => {
                        if !capabilities.network_deny {
                            push(
                                &mut errors,
                                "network.mode",
                                "network.mode restricted requires a working network namespace"
                                    .to_string(),
                            );
                        } else if !capabilities.bridge {
                            push(
                                &mut errors,
                                "network.mode",
                                "network.mode restricted requires the in-sandbox bridge executable"
                                    .to_string(),
                            );
                        }
                    }
                }
            }
            if let Some(namespaces) = policy
                .process
                .as_ref()
                .and_then(|process| process.linux_namespaces.as_ref())
            {
                for (name, requested, supported) in [
                    ("pid", namespaces.pid, capabilities.namespaces.pid),
                    ("ipc", namespaces.ipc, capabilities.namespaces.ipc),
                    ("user", namespaces.user, capabilities.namespaces.user),
                    ("uts", namespaces.uts, capabilities.namespaces.uts),
                    ("cgroup", namespaces.cgroup, capabilities.namespaces.cgroup),
                ] {
                    if requested && !supported {
                        push(
                            &mut errors,
                            &format!("process.linux_namespaces.{name}"),
                            format!("the {name} namespace cannot be created on this host"),
                        );
                    }
                }
            }
            if let Some(cgroup) = policy.resource.as_ref().map(|resource| &resource.cgroup_v2) {
                match capabilities.cgroup_v2.as_ref() {
                    None => push(
                        &mut errors,
                        "resource.cgroup_v2",
                        "resource.cgroup_v2 requires a writable delegated cgroup v2 subtree"
                            .to_string(),
                    ),
                    Some(support) => {
                        for (file, requested) in [
                            ("memory.max", cgroup.memory_max.is_some()),
                            ("cpu.max", cgroup.cpu_max.is_some()),
                            ("pids.max", cgroup.pids_max.is_some()),
                            ("memory.oom.group", cgroup.memory_oom_group.is_some()),
                        ] {
                            if requested
                                && !support
                                    .fields
                                    .get(file)
                                    .map(|field| field.available)
                                    .unwrap_or(false)
                            {
                                push(
                                    &mut errors,
                                    &format!("resource.cgroup_v2.{file}"),
                                    support
                                        .fields
                                        .get(file)
                                        .and_then(|field| field.reason.clone())
                                        .unwrap_or_else(|| {
                                            format!("{file} is not installable on this host")
                                        }),
                                );
                            }
                        }
                    }
                }
            }
            if policy.syscall.is_some() && !capabilities.seccomp {
                push(
                    &mut errors,
                    "syscall.seccomp.profile",
                    "the pinned seccomp profile could not be loaded on this host".to_string(),
                );
            }
        }
        Platform::Macos => {
            let seatbelt = capabilities.seatbelt.as_ref();
            if let Some(filesystem) = &policy.filesystem {
                if filesystem.composition.is_some() {
                    push(
                        &mut errors,
                        "filesystem.composition",
                        "filesystem.composition (EROFS mounts) is unsupported on macOS".to_string(),
                    );
                }
                if !seatbelt.is_some_and(|seatbelt| seatbelt.filesystem) {
                    push(
                        &mut errors,
                        "filesystem.access",
                        "filesystem.access could not be verified under macOS Seatbelt".to_string(),
                    );
                }
            }
            if let Some(namespaces) = policy
                .process
                .as_ref()
                .and_then(|process| process.linux_namespaces.as_ref())
            {
                for (name, requested) in [
                    ("pid", namespaces.pid),
                    ("ipc", namespaces.ipc),
                    ("user", namespaces.user),
                    ("uts", namespaces.uts),
                    ("cgroup", namespaces.cgroup),
                ] {
                    if requested {
                        push(
                            &mut errors,
                            &format!("process.linux_namespaces.{name}"),
                            "process.linux_namespaces is Linux-native and unsupported on macOS"
                                .to_string(),
                        );
                    }
                }
            }
            if policy.resource.is_some() {
                push(
                    &mut errors,
                    "resource.cgroup_v2",
                    "resource.cgroup_v2 is Linux-native and unsupported on macOS".to_string(),
                );
            }
            if policy.syscall.is_some() {
                push(
                    &mut errors,
                    "syscall.seccomp",
                    "syscall.seccomp is Linux-native and unsupported on macOS".to_string(),
                );
            }
            if let Some(network) = &policy.network {
                match network.mode {
                    SandboxNetworkMode::Allow => {}
                    SandboxNetworkMode::Deny
                        if !seatbelt.is_some_and(|seatbelt| seatbelt.network_deny) =>
                    {
                        push(
                            &mut errors,
                            "network.mode",
                            "network.mode deny could not be verified under macOS Seatbelt"
                                .to_string(),
                        )
                    }
                    SandboxNetworkMode::Deny => {}
                    SandboxNetworkMode::Restricted => push(
                        &mut errors,
                        "network.mode",
                        "network.mode restricted is not supported by the macOS backend in V1"
                            .to_string(),
                    ),
                }
            }
        }
        Platform::Unsupported => push(
            &mut errors,
            "policy",
            "no Sandbox backend exists for this platform".to_string(),
        ),
    }
    errors
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
    if compiled
        .filesystem
        .as_ref()
        .is_some_and(|filesystem| filesystem.composition.is_some())
    {
        return Err(SandboxError::UnsupportedPolicy(
            "filesystem.composition (EROFS mounts) is unsupported on macOS".to_string(),
        ));
    }
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
            erofs: true,
            erofs_overlay: true,
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
            erofs: false,
            erofs_overlay: false,
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

    fn composition_policy(with_workspace_image: bool) -> CompiledSandboxPolicy {
        let workspace = if with_workspace_image {
            serde_json::json!({
                "image": {
                    "digest": format!("sha256:{}", "b".repeat(64)),
                    "source": "/data/erofs/sha256/source"
                },
                "write": "/tmp/nession-sandbox/workspace"
            })
        } else {
            serde_json::json!({ "write": "/tmp/nession-sandbox/workspace" })
        };
        compile(
            &serde_json::from_value(serde_json::json!({
                "version": 1,
                "enabled": true,
                "filesystem": {
                    "access": { "read": [], "write": [] },
                    "composition": {
                        "base": {
                            "digest": format!("sha256:{}", "a".repeat(64)),
                            "source": "/data/erofs/sha256/base"
                        },
                        "workspace": workspace
                    }
                }
            }))
            .expect("composition fixture"),
        )
        .expect("compiled")
    }

    #[test]
    fn a_linux_composition_without_erofs_support_is_refused() {
        let policy = composition_policy(false);
        let mut capabilities = linux_capabilities();
        capabilities.erofs = false;
        let error = validate(&policy, &capabilities).expect_err("no EROFS capability");
        assert!(matches!(error, SandboxError::UnsupportedPolicy(_)));
        assert!(error.to_string().contains("erofsfuse"));
    }

    #[test]
    fn a_linux_workspace_image_without_overlay_support_is_refused() {
        let policy = composition_policy(true);
        let mut capabilities = linux_capabilities();
        capabilities.erofs_overlay = false;
        let error = validate(&policy, &capabilities).expect_err("no overlay capability");
        assert!(matches!(error, SandboxError::UnsupportedPolicy(_)));
        assert!(error.to_string().contains("fuse-overlayfs"));
    }

    #[test]
    fn macos_rejects_composition_without_fallback() {
        let policy = composition_policy(false);
        let error = validate(&policy, &macos_capabilities()).expect_err("macOS cannot mount EROFS");
        assert!(matches!(error, SandboxError::UnsupportedPolicy(_)));
        assert!(error.to_string().contains("unsupported on macOS"));
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

    fn policy(value: serde_json::Value) -> SandboxPolicy {
        serde_json::from_value(value).expect("policy fixture")
    }

    fn implementation<'a>(
        catalog: &'a SandboxCapabilityCatalog,
        path: &str,
    ) -> &'a SandboxImplementationSupport {
        catalog
            .implementation(path)
            .unwrap_or_else(|| panic!("missing implementation {path}"))
    }

    #[test]
    fn the_catalog_lists_each_registered_path_with_measured_options() {
        let catalog = catalog(&linux_capabilities());
        assert_eq!(catalog.catalog_version, SANDBOX_CATALOG_VERSION);
        assert_eq!(catalog.implementations.len(), 6);
        assert!(implementation(&catalog, "filesystem.access").is_editable());
        assert!(implementation(&catalog, "filesystem.composition").is_editable());
        let network = implementation(&catalog, "network");
        assert!(network.is_editable());
        assert_eq!(
            network
                .options
                .iter()
                .map(|option| option.id.as_str())
                .collect::<Vec<_>>(),
            vec!["allow", "deny", "restricted"]
        );
        assert!(network
            .options
            .iter()
            .all(|option| option.status == SandboxImplementationStatus::Available));
        let namespaces = implementation(&catalog, "process.linux_namespaces");
        assert!(namespaces.is_editable());
        assert_eq!(namespaces.options.len(), 5);
        assert!(namespaces
            .options
            .iter()
            .all(|option| option.status == SandboxImplementationStatus::Available));
        let cgroup = implementation(&catalog, "resource.cgroup_v2");
        assert!(cgroup.is_editable());
        assert_eq!(cgroup.fields.len(), 4);
        assert!(cgroup.fields.iter().all(|field| field.available));
        assert!(cgroup
            .fields
            .iter()
            .any(|field| field.key == "cpu.max" && field.controller.as_deref() == Some("cpu")));
        let seccomp = implementation(&catalog, "syscall.seccomp");
        assert!(seccomp.is_editable());
        assert_eq!(seccomp.options.len(), 1);
        assert_eq!(
            seccomp.options[0].id,
            crate::policy::SECCOMP_PROFILE_INTERACTIVE_V1
        );
    }

    #[test]
    fn a_partial_linux_host_only_offers_its_measured_options() {
        let mut capabilities = linux_capabilities();
        capabilities.namespaces.pid = false;
        capabilities.network_restricted = false;
        capabilities.seccomp = false;
        capabilities.cgroup_v2.as_mut().unwrap().fields.insert(
            "cpu.max".to_string(),
            CgroupFieldSupport {
                available: false,
                reason: Some("controller not enabled".to_string()),
            },
        );
        let catalog = catalog(&capabilities);
        let namespaces = implementation(&catalog, "process.linux_namespaces");
        let pid = namespaces
            .options
            .iter()
            .find(|option| option.id == "pid")
            .unwrap();
        assert_eq!(pid.status, SandboxImplementationStatus::Unavailable);
        assert_eq!(
            pid.reason_code,
            Some(SandboxUnsupportedReason::KernelFeatureMissing)
        );
        assert!(namespaces.is_editable(), "other namespaces remain usable");
        let network = implementation(&catalog, "network");
        let restricted = network
            .options
            .iter()
            .find(|option| option.id == "restricted")
            .unwrap();
        assert_eq!(restricted.status, SandboxImplementationStatus::Unavailable);
        assert!(network.is_editable(), "allow/deny remain usable");
        let cpu = implementation(&catalog, "resource.cgroup_v2")
            .fields
            .iter()
            .find(|field| field.key == "cpu.max")
            .unwrap();
        assert!(!cpu.available);
        assert_eq!(
            cpu.reason_code,
            Some(SandboxUnsupportedReason::PermissionDenied)
        );
        let seccomp = implementation(&catalog, "syscall.seccomp");
        assert_eq!(seccomp.status, SandboxImplementationStatus::Unavailable);
        assert_eq!(
            seccomp.options[0].reason_code,
            Some(SandboxUnsupportedReason::ProfileUnavailable)
        );
    }

    #[test]
    fn macos_reports_native_paths_unsupported_and_its_measured_network() {
        let catalog = catalog(&macos_capabilities());
        for path in [
            "process.linux_namespaces",
            "resource.cgroup_v2",
            "syscall.seccomp",
        ] {
            let entry = implementation(&catalog, path);
            assert_eq!(entry.status, SandboxImplementationStatus::Unavailable);
            assert_eq!(
                entry.reason_code,
                Some(SandboxUnsupportedReason::PlatformUnsupported)
            );
        }
        let network = implementation(&catalog, "network");
        let restricted = network
            .options
            .iter()
            .find(|option| option.id == "restricted")
            .unwrap();
        assert_eq!(restricted.status, SandboxImplementationStatus::Unavailable);
        assert_eq!(
            restricted.reason_code,
            Some(SandboxUnsupportedReason::PlatformUnsupported)
        );
        assert!(network
            .options
            .iter()
            .find(|option| option.id == "deny")
            .is_some_and(|option| option.status == SandboxImplementationStatus::Available));
    }

    #[test]
    fn an_unavailable_backend_never_reports_a_usable_implementation() {
        let mut capabilities = linux_capabilities();
        capabilities.backend = None;
        capabilities.unavailable = Some("sandbox disabled by Agent configuration".to_string());
        let catalog = catalog(&capabilities);
        assert_eq!(catalog.status, SandboxCatalogStatus::Unavailable);
        assert!(catalog.implementations.iter().all(|entry| {
            entry.status == SandboxImplementationStatus::Unavailable
                && entry.reason_code == Some(SandboxUnsupportedReason::BackendMissing)
        }));
        assert!(catalog
            .implementations
            .iter()
            .all(|entry| !entry.is_editable()));
        // Registered options/fields stay discoverable, not silently empty.
        let network = implementation(&catalog, "network");
        assert_eq!(network.options.len(), 3);
        assert!(network
            .options
            .iter()
            .all(|option| option.status == SandboxImplementationStatus::Unavailable));
        let namespaces = implementation(&catalog, "process.linux_namespaces");
        assert_eq!(namespaces.options.len(), 5);
        let cgroup = implementation(&catalog, "resource.cgroup_v2");
        assert_eq!(cgroup.fields.len(), 4);
        assert!(cgroup.fields.iter().all(|field| !field.available));
        let seccomp = implementation(&catalog, "syscall.seccomp");
        assert_eq!(seccomp.options.len(), 1);
        assert_eq!(
            seccomp.options[0].reason_code,
            Some(SandboxUnsupportedReason::BackendMissing)
        );
    }

    #[test]
    fn the_probe_generation_changes_when_implementation_support_changes() {
        let full = catalog(&linux_capabilities());
        let mut partial = linux_capabilities();
        partial.seccomp = false;
        let partial = catalog(&partial);
        assert_ne!(full.probe_generation, partial.probe_generation);
        let again = catalog(&linux_capabilities());
        assert_eq!(full.probe_generation, again.probe_generation);
    }

    #[test]
    fn unsupported_requests_names_every_unavailable_field_path() {
        let mut capabilities = linux_capabilities();
        capabilities.namespaces.pid = false;
        capabilities.seccomp = false;
        capabilities.cgroup_v2.as_mut().unwrap().fields.insert(
            "cpu.max".to_string(),
            CgroupFieldSupport {
                available: false,
                reason: Some("controller not enabled".to_string()),
            },
        );
        let requested = policy(serde_json::json!({
            "enabled": true,
            "process": { "linux_namespaces": { "pid": true, "ipc": true } },
            "resource": { "cgroup_v2": { "cpu.max": "200000 100000", "memory.max": "1024" } },
            "syscall": { "seccomp": { "profile": "nession-interactive-v1" } }
        }));
        let errors = unsupported_requests(&requested, &capabilities);
        let fields: Vec<&str> = errors.iter().map(|error| error.field.as_str()).collect();
        assert!(fields.contains(&"process.linux_namespaces.pid"));
        assert!(!fields.contains(&"process.linux_namespaces.ipc"));
        assert!(fields.contains(&"resource.cgroup_v2.cpu.max"));
        assert!(!fields.contains(&"resource.cgroup_v2.memory.max"));
        assert!(fields.contains(&"syscall.seccomp.profile"));
        assert!(errors.iter().all(|error| error.code == "unsupported"));

        let macos = policy(serde_json::json!({
            "enabled": true,
            "network": { "mode": "restricted" },
            "process": { "linux_namespaces": { "user": true } },
            "resource": { "cgroup_v2": { "memory.max": "1024" } },
            "syscall": { "seccomp": { "profile": "nession-interactive-v1" } }
        }));
        let fields: Vec<String> = unsupported_requests(&macos, &macos_capabilities())
            .into_iter()
            .map(|error| error.field)
            .collect();
        assert!(fields.contains(&"network.mode".to_string()));
        assert!(fields.contains(&"process.linux_namespaces.user".to_string()));
        assert!(fields.contains(&"resource.cgroup_v2".to_string()));
        assert!(fields.contains(&"syscall.seccomp".to_string()));
    }

    #[test]
    fn a_missing_backend_is_one_policy_error_not_a_partial_guess() {
        let mut capabilities = linux_capabilities();
        capabilities.backend = None;
        capabilities.unavailable = Some("disabled".to_string());
        let errors = unsupported_requests(
            &policy(serde_json::json!({ "enabled": true, "network": { "mode": "deny" } })),
            &capabilities,
        );
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].field, "policy");
        assert_eq!(errors[0].code, "unsupported");
    }
}
