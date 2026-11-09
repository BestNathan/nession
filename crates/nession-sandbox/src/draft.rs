//! Materialize the Web-safe policy draft into the canonical policy (#3124).
//!
//! The UI edits Resource/Syscall as typed Key/Value rows because the canonical
//! cgroup field names (`memory.max`, `cpu.max`) cannot cross the generated
//! Web binding rules. This module is the **one** place that interprets those
//! rows: it validates key/value shape, maps them onto
//! `resource.cgroup_v2` / `syscall.seccomp`, and omits an empty group instead
//! of sending `{}`. `compile` still owns the canonical validation afterwards,
//! and the host capability check remains in [`crate::capabilities::validate`].
//!
//! It is not a second policy schema: every non-row field is the canonical
//! `SandboxPolicy` dimension unchanged.

use std::collections::BTreeSet;

use nession_protocol::contracts::sandbox::v1::{
    SandboxCgroupV2Policy, SandboxFieldError, SandboxKvEntry, SandboxPolicy, SandboxPolicyDraft,
    SandboxResourcePolicy, SandboxSeccompPolicy, SandboxSyscallPolicy,
};

use crate::policy::{
    validate_cpu_max, validate_memory_max, validate_oom_group, validate_pids_max,
    SECCOMP_PROFILE_INTERACTIVE_V1,
};

/// One Resource key's UI metadata, in the fixed canonical order.
pub const RESOURCE_FIELD_METADATA: [(&str, &str, &str); 4] = [
    ("memory.max", "uint64 bytes or `max`", "2147483648"),
    (
        "cpu.max",
        "`quota period` (quota microseconds or `max`; period 1000..=1000000)",
        "200000 100000",
    ),
    ("pids.max", "uint64 tasks or `max`", "256"),
    ("memory.oom.group", "`0` or `1`", "0"),
];

/// The one Syscall key this contract accepts.
pub const SYSCALL_PROFILE_KEY: &str = "seccomp.profile";

/// Materialize a draft, collecting **all** row errors rather than the first.
///
/// An invalid draft never reaches `compile`; a valid one is compiled by the
/// caller (preflight/Enter), so canonical value/back-end validation keeps its
/// single owner.
pub fn materialize(
    draft: &SandboxPolicyDraft,
) -> std::result::Result<SandboxPolicy, Vec<SandboxFieldError>> {
    let mut errors = Vec::new();

    if !draft.enabled {
        errors.push(field_error(
            "enabled",
            "invalid-value",
            "Entering a Sandbox requires enabled: true; there is no Native fallback",
        ));
    }

    let cgroup = materialize_resource(&draft.resource, &mut errors);
    let seccomp = materialize_syscall(&draft.syscall, &mut errors);

    if !errors.is_empty() {
        return Err(errors);
    }

    Ok(SandboxPolicy {
        version: draft.version,
        enabled: draft.enabled,
        filesystem: draft.filesystem.clone(),
        network: draft.network.clone(),
        process: draft.process.clone(),
        resource: cgroup.map(|cgroup_v2| SandboxResourcePolicy { cgroup_v2 }),
        syscall: seccomp.map(|profile| SandboxSyscallPolicy {
            seccomp: SandboxSeccompPolicy { profile },
        }),
        enforcement: draft.enforcement,
    })
}

/// Project a canonical policy back into the Web-safe editor shape.
///
/// Used for the observed **effective** policy of a live execution; it never
/// re-validates, because `CompiledSandboxPolicy::normalized` already is the
/// compiled, normalized request.
pub fn draft_from_policy(policy: &SandboxPolicy) -> SandboxPolicyDraft {
    let mut resource = Vec::new();
    if let Some(cgroup) = policy.resource.as_ref().map(|resource| &resource.cgroup_v2) {
        for (key, value) in [
            ("memory.max", &cgroup.memory_max),
            ("cpu.max", &cgroup.cpu_max),
            ("pids.max", &cgroup.pids_max),
            ("memory.oom.group", &cgroup.memory_oom_group),
        ] {
            if let Some(value) = value {
                resource.push(SandboxKvEntry {
                    key: key.to_string(),
                    value: value.clone(),
                });
            }
        }
    }
    let mut syscall = Vec::new();
    if let Some(syscall_policy) = &policy.syscall {
        syscall.push(SandboxKvEntry {
            key: SYSCALL_PROFILE_KEY.to_string(),
            value: syscall_policy.seccomp.profile.clone(),
        });
    }
    SandboxPolicyDraft {
        version: policy.version,
        enabled: policy.enabled,
        filesystem: policy.filesystem.clone(),
        network: policy.network.clone(),
        process: policy.process.clone(),
        resource,
        syscall,
        enforcement: policy.enforcement,
    }
}

fn materialize_resource(
    rows: &[SandboxKvEntry],
    errors: &mut Vec<SandboxFieldError>,
) -> Option<SandboxCgroupV2Policy> {
    if rows.is_empty() {
        return None;
    }
    let allowed: BTreeSet<&str> = RESOURCE_FIELD_METADATA.iter().map(|row| row.0).collect();
    let mut seen = BTreeSet::new();
    let mut cgroup = SandboxCgroupV2Policy::default();
    for (index, row) in rows.iter().enumerate() {
        let key = row.key.trim();
        if key.is_empty() {
            errors.push(field_error(
                format!("resource[{index}].key"),
                "blank-key",
                "a Resource key is required",
            ));
            continue;
        }
        if !allowed.contains(key) {
            errors.push(field_error(
                format!("resource[{index}].key"),
                "unknown-key",
                format!(
                    "`{key}` is not a V1 cgroup v2 control file; use one of {}",
                    RESOURCE_FIELD_METADATA
                        .iter()
                        .map(|row| row.0)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            ));
            continue;
        }
        if !seen.insert(key.to_string()) {
            errors.push(field_error(
                format!("resource[{index}].key"),
                "duplicate-key",
                format!("`{key}` is already configured"),
            ));
            continue;
        }
        let value = row.value.trim();
        if value.is_empty() {
            errors.push(field_error(
                format!("resource[{index}].value"),
                "blank-value",
                "a native control-file value is required",
            ));
            continue;
        }
        let validated = match key {
            "memory.max" => validate_memory_max(value),
            "cpu.max" => validate_cpu_max(value),
            "pids.max" => validate_pids_max(value),
            "memory.oom.group" => validate_oom_group(value),
            _ => unreachable!("the key allowlist was checked above"),
        };
        match validated {
            Ok(value) => match key {
                "memory.max" => cgroup.memory_max = Some(value),
                "cpu.max" => cgroup.cpu_max = Some(value),
                "pids.max" => cgroup.pids_max = Some(value),
                "memory.oom.group" => cgroup.memory_oom_group = Some(value),
                _ => unreachable!("the key allowlist was checked above"),
            },
            Err(error) => errors.push(field_error(
                format!("resource[{index}].value"),
                "invalid-value",
                error.to_string(),
            )),
        }
    }
    Some(cgroup)
}

fn materialize_syscall(
    rows: &[SandboxKvEntry],
    errors: &mut Vec<SandboxFieldError>,
) -> Option<String> {
    if rows.is_empty() {
        return None;
    }
    let mut seen = false;
    let mut profile = None;
    for (index, row) in rows.iter().enumerate() {
        let key = row.key.trim();
        if key.is_empty() {
            errors.push(field_error(
                format!("syscall[{index}].key"),
                "blank-key",
                "a Syscall key is required",
            ));
            continue;
        }
        if key != SYSCALL_PROFILE_KEY {
            errors.push(field_error(
                format!("syscall[{index}].key"),
                "unknown-key",
                format!("`{key}` is not supported; the only V1 key is `{SYSCALL_PROFILE_KEY}`"),
            ));
            continue;
        }
        if seen {
            errors.push(field_error(
                format!("syscall[{index}].key"),
                "duplicate-key",
                format!("`{key}` is already configured"),
            ));
            continue;
        }
        seen = true;
        let value = row.value.trim();
        if value.is_empty() {
            errors.push(field_error(
                format!("syscall[{index}].value"),
                "blank-value",
                "a seccomp profile name is required",
            ));
            continue;
        }
        if value != SECCOMP_PROFILE_INTERACTIVE_V1 {
            errors.push(field_error(
                format!("syscall[{index}].value"),
                "invalid-value",
                format!(
                    "`{value}` is not a registered profile; this build pins `{SECCOMP_PROFILE_INTERACTIVE_V1}`"
                ),
            ));
            continue;
        }
        profile = Some(value.to_string());
    }
    profile
}

fn field_error(
    field: impl Into<String>,
    code: &str,
    message: impl Into<String>,
) -> SandboxFieldError {
    SandboxFieldError {
        field: field.into(),
        code: code.to_string(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(value: serde_json::Value) -> SandboxPolicyDraft {
        serde_json::from_value(value).expect("draft fixture")
    }

    #[test]
    fn empty_groups_are_omitted_not_serialized_as_empty_objects() {
        let policy = materialize(&draft(serde_json::json!({
            "enabled": true,
            "network": { "mode": "deny" },
            "resource": [],
            "syscall": []
        })))
        .expect("empty-first draft");
        assert!(policy.resource.is_none());
        assert!(policy.syscall.is_none());
        let value = serde_json::to_value(&policy).unwrap();
        assert!(value.get("resource").is_none());
        assert!(value.get("syscall").is_none());
    }

    #[test]
    fn rows_map_onto_the_canonical_nested_contract() {
        let policy = materialize(&draft(serde_json::json!({
            "enabled": true,
            "resource": [
                { "key": "cpu.max", "value": "200000 100000" },
                { "key": "memory.oom.group", "value": "1" }
            ],
            "syscall": [
                { "key": "seccomp.profile", "value": "nession-interactive-v1" }
            ]
        })))
        .expect("valid rows");
        let value = serde_json::to_value(&policy).unwrap();
        assert_eq!(value["resource"]["cgroup_v2"]["cpu.max"], "200000 100000");
        assert_eq!(value["resource"]["cgroup_v2"]["memory.oom.group"], "1");
        assert_eq!(
            value["syscall"]["seccomp"]["profile"],
            "nession-interactive-v1"
        );
        assert!(value["resource"]["cgroup_v2"].get("memory.max").is_none());
    }

    #[test]
    fn unknown_duplicate_blank_and_malformed_rows_fail_with_field_errors() {
        let errors = materialize(&draft(serde_json::json!({
            "enabled": true,
            "resource": [
                { "key": "memory.swap.max", "value": "1" },
                { "key": "pids.max", "value": "64" },
                { "key": "pids.max", "value": "32" },
                { "key": "", "value": "1" },
                { "key": "cpu.max", "value": "200000 999" },
                { "key": "memory.max", "value": "" }
            ],
            "syscall": [
                { "key": "seccomp.profile", "value": "custom" },
                { "key": "syscall.list", "value": "read" }
            ]
        })))
        .expect_err("invalid rows must not reach compile");
        let codes: Vec<&str> = errors.iter().map(|error| error.code.as_str()).collect();
        assert!(codes.contains(&"unknown-key"));
        assert!(codes.contains(&"duplicate-key"));
        assert!(codes.contains(&"blank-key"));
        assert!(codes.contains(&"invalid-value"));
        assert!(codes.contains(&"blank-value"));
        assert!(errors
            .iter()
            .any(|error| error.field == "resource[4].value"));
        assert!(errors.iter().any(|error| error.field == "syscall[0].value"));
    }

    #[test]
    fn the_observed_policy_projects_back_to_rows() {
        let compiled = crate::compile(
            &materialize(&draft(serde_json::json!({
                "enabled": true,
                "resource": [{ "key": "cpu.max", "value": "200000 100000" }],
                "syscall": [{ "key": "seccomp.profile", "value": "nession-interactive-v1" }]
            })))
            .expect("materialized"),
        )
        .expect("compiled");
        let projected = draft_from_policy(&compiled.normalized);
        assert_eq!(projected.resource.len(), 1);
        assert_eq!(projected.resource[0].key, "cpu.max");
        assert_eq!(projected.syscall[0].key, "seccomp.profile");
    }

    #[test]
    fn a_disabled_draft_is_refused_rather_than_falling_back_to_native() {
        let errors = materialize(&draft(serde_json::json!({ "enabled": false })))
            .expect_err("Enter cannot be a silent Native fallback");
        assert_eq!(errors[0].field, "enabled");
    }
}
