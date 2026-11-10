//! Native cgroup v2 control-file naming policy (#3141).
//!
//! This is the one owner of two related questions:
//!
//! 1. which files exposed by a delegated child cgroup are **declarative
//!    resource controls** the user may configure, versus hierarchy/lifecycle
//!    interfaces, read-only status files and command-style pseudo-files; and
//! 2. what basename shape a policy key may have.
//!
//! Discovery, the Web suggestion list, the compiler and the runtime writer all
//! consult this module. It is deliberately a *shape* rule, not a resource
//! allowlist: a new kernel controller file that is declarative configuration is
//! accepted without a Nession code change, while `cgroup.procs`,
//! `memory.reclaim` and the like can never become a policy write.

/// Kernel cgroup filenames are bounded by the filesystem name limit.
const MAX_NAME_LEN: usize = 255;

/// Read-only state/interface suffixes. A configurable control never ends in
/// one of these; the kernel exposes them for observation only.
const READ_ONLY_SUFFIXES: &[&str] = &[
    ".stat",
    ".stat.local",
    ".events",
    ".events.local",
    ".current",
    ".peak",
    ".pressure",
    ".numa_stat",
    ".effective",
];

/// Command-style pseudo-files: writing them *acts* (reclaims memory, kills,
/// freezes) rather than declaring a resource limit. Nession keeps ownership of
/// process and lifecycle operations.
const COMMAND_FILES: &[&str] = &["memory.reclaim"];

/// The controller prefix of a namespaced control file (`memory.max` ->
/// `memory`, `hugetlb.2MB.max` -> `hugetlb`).
pub(crate) fn controller_of(name: &str) -> Option<&str> {
    let (controller, rest) = name.split_once('.')?;
    (!controller.is_empty() && !rest.is_empty()).then_some(controller)
}

fn valid_name_chars(name: &str) -> bool {
    name.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// Whether a file exposed by the delegated child is declarative resource
/// configuration this contract may edit.
pub(crate) fn is_configurable_control_file(name: &str) -> bool {
    if name.is_empty() || name.len() > MAX_NAME_LEN || !valid_name_chars(name) {
        return false;
    }
    // Every hierarchy/lifecycle interface (`cgroup.procs`, `cgroup.threads`,
    // `cgroup.kill`, `cgroup.freeze`, `cgroup.subtree_control`, ...) shares
    // this prefix. Nession owns those transitions, never the policy editor.
    if name.starts_with("cgroup.") {
        return false;
    }
    if name == "." || name == ".." || name.contains("..") {
        return false;
    }
    if READ_ONLY_SUFFIXES
        .iter()
        .any(|suffix| name.ends_with(suffix))
        || COMMAND_FILES.contains(&name)
    {
        return false;
    }
    let Some(controller) = controller_of(name) else {
        return false;
    };
    controller
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// Validate a policy key at the generic boundary (no resource-specific
/// parsers). The kernel remains authoritative for whether a *value* installs.
pub(crate) fn validate_key(key: &str) -> std::result::Result<(), String> {
    if key.is_empty() {
        return Err("a native cgroup control-file name is required".to_string());
    }
    if key.len() > MAX_NAME_LEN {
        return Err(format!(
            "`{key}` is longer than the {MAX_NAME_LEN}-byte kernel filename limit"
        ));
    }
    if key.trim() != key {
        return Err(format!("`{key}` must not have surrounding whitespace"));
    }
    if key.contains('/') || key.contains('\\') || key.contains('\0') {
        return Err(format!(
            "`{key}` must be one control-file basename with no path separators"
        ));
    }
    if key == "." || key == ".." || key.contains("..") {
        return Err(format!("`{key}` must be a plain control-file basename"));
    }
    if key.starts_with("cgroup.") {
        return Err(format!(
            "`{key}` is a cgroup hierarchy/lifecycle interface, not a declarative resource control"
        ));
    }
    if READ_ONLY_SUFFIXES
        .iter()
        .any(|suffix| key.ends_with(suffix))
    {
        return Err(format!(
            "`{key}` is a read-only cgroup status/interface file"
        ));
    }
    if COMMAND_FILES.contains(&key) {
        return Err(format!(
            "`{key}` is a command-style cgroup interface, not declarative configuration"
        ));
    }
    if !is_configurable_control_file(key) {
        return Err(format!(
            "`{key}` is not a native resource-controller control-file basename"
        ));
    }
    Ok(())
}

/// Validate a native value at the generic boundary. Format is the kernel's
/// business; only emptiness and NUL bytes are rejected before the write.
pub(crate) fn validate_value(value: &str) -> std::result::Result<(), String> {
    if value.trim().is_empty() {
        return Err("a native control-file value is required".to_string());
    }
    if value.contains('\0') {
        return Err("a native control-file value must not contain NUL".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declarative_controller_files_are_accepted_without_an_allowlist() {
        for name in [
            "memory.max",
            "memory.high",
            "memory.low",
            "memory.oom.group",
            "cpu.max",
            "cpu.weight",
            "pids.max",
            "io.max",
            "cpuset.cpus",
            "hugetlb.2MB.max",
        ] {
            assert!(is_configurable_control_file(name), "{name}");
            assert_eq!(validate_key(name), Ok(()), "{name}");
        }
    }

    #[test]
    fn lifecycle_status_and_command_interfaces_are_never_editable() {
        for name in [
            "cgroup.procs",
            "cgroup.threads",
            "cgroup.kill",
            "cgroup.freeze",
            "cgroup.subtree_control",
            "cgroup.type",
            "memory.stat",
            "memory.events",
            "memory.events.local",
            "memory.current",
            "memory.peak",
            "memory.pressure",
            "memory.numa_stat",
            "cpu.stat",
            "pids.events",
            "pids.current",
            "cpuset.cpus.effective",
            "memory.reclaim",
        ] {
            assert!(!is_configurable_control_file(name), "{name}");
            assert!(validate_key(name).is_err(), "{name}");
        }
    }

    #[test]
    fn traversal_and_escaping_names_are_rejected() {
        for name in ["", "..", "../memory.max", "/memory.max", "a/b", "a\\b"] {
            assert!(validate_key(name).is_err(), "{name}");
        }
        assert!(validate_key("memory..max").is_err());
        assert!(validate_key("memory.max ").is_err());
    }

    #[test]
    fn controller_prefix_is_derived_without_per_resource_parsing() {
        assert_eq!(controller_of("memory.high"), Some("memory"));
        assert_eq!(controller_of("cpu.weight"), Some("cpu"));
        assert_eq!(controller_of("hugetlb.2MB.max"), Some("hugetlb"));
        assert_eq!(controller_of("memory"), None);
    }
}
