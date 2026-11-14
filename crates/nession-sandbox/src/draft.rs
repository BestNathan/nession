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
    SandboxCgroupV2Policy, SandboxFieldError, SandboxFilesystemAccess,
    SandboxFilesystemComposition, SandboxFilesystemPolicy, SandboxKvEntry, SandboxPolicy,
    SandboxPolicyDraft, SandboxResourcePolicy, SandboxSeccompPolicy, SandboxSyscallPolicy,
};

use crate::cgroup_file::{validate_key, validate_value};
use crate::policy::SECCOMP_PROFILE_INTERACTIVE_V1;

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

/// Materialize a draft and attach one Server-resolved image composition.
///
/// The Web draft may carry `filesystem.access`; a composition and that access
/// list are two owners for the sandbox root, so carrying both is refused
/// instead of silently dropping one. The composition is already a canonical
/// value built from Agent-verified cache paths.
pub fn materialize_with_composition(
    draft: &SandboxPolicyDraft,
    composition: SandboxFilesystemComposition,
) -> std::result::Result<SandboxPolicy, Vec<SandboxFieldError>> {
    let mut policy = materialize(draft)?;
    let access_nonempty = policy.filesystem.as_ref().is_some_and(|filesystem| {
        !filesystem.access.read.is_empty() || !filesystem.access.write.is_empty()
    });
    if access_nonempty {
        return Err(vec![field_error(
            "filesystem.access",
            "conflict",
            "filesystem.composition replaces filesystem.access; clear the access lists before selecting images",
        )]);
    }
    policy.filesystem = Some(SandboxFilesystemPolicy {
        access: SandboxFilesystemAccess::default(),
        rootfs: None,
        mounts: Vec::new(),
        workspace: None,
        composition: Some(composition),
    });
    Ok(policy)
}

/// Project a canonical policy back into the Web-safe editor shape.
///
/// Used for the observed **effective** policy of a live execution; it never
/// re-validates, because `CompiledSandboxPolicy::normalized` already is the
/// compiled, normalized request.
pub fn draft_from_policy(policy: &SandboxPolicy) -> SandboxPolicyDraft {
    let mut resource = Vec::new();
    if let Some(cgroup) = policy.resource.as_ref().map(|resource| &resource.cgroup_v2) {
        for (key, value) in &cgroup.0 {
            resource.push(SandboxKvEntry {
                key: key.clone(),
                value: value.clone(),
            });
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
    let mut seen = BTreeSet::new();
    let mut cgroup = SandboxCgroupV2Policy::default();
    for (index, row) in rows.iter().enumerate() {
        let key = row.key.trim();
        if let Err(message) = validate_key(key) {
            errors.push(field_error(
                format!("resource[{index}].key"),
                "invalid-key",
                message,
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
        if let Err(message) = validate_value(&row.value) {
            errors.push(field_error(
                format!("resource[{index}].value"),
                "invalid-value",
                message,
            ));
            continue;
        }
        cgroup.0.insert(key.to_string(), row.value.clone());
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
    fn duplicate_blank_lifecycle_and_empty_value_rows_fail_with_field_errors() {
        let errors = materialize(&draft(serde_json::json!({
            "enabled": true,
            "resource": [
                { "key": "memory.swap.max", "value": "1" },
                { "key": "cpu.weight", "value": "100" },
                { "key": "pids.max", "value": "64" },
                { "key": "pids.max", "value": "32" },
                { "key": "", "value": "1" },
                { "key": "cgroup.procs", "value": "4242" },
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
        assert!(codes.contains(&"invalid-key"));
        assert!(codes.contains(&"duplicate-key"));
        assert!(codes.contains(&"invalid-value"));
        assert!(!errors
            .iter()
            .any(|error| error.field.starts_with("resource[") && error.code == "unknown-key"));
        // Arbitrary discovered controller files are accepted; only the Syscall
        // registry remains a pinned single-key contract.
        assert!(!errors.iter().any(|error| error.field == "resource[0].key"));
        assert!(!errors.iter().any(|error| error.field == "resource[1].key"));
        // No per-resource value parser: the kernel, not the draft layer,
        // decides that `200000 999` is an invalid cpu.max value.
        assert!(!errors
            .iter()
            .any(|error| error.field == "resource[6].value"));
        assert!(errors.iter().any(|error| error.field == "resource[5].key"));
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

    #[test]
    fn a_composition_replaces_access_and_refuses_both_owners() {
        let digest = format!("sha256:{}", "a".repeat(64));
        let composition = SandboxFilesystemComposition {
            base: nession_protocol::contracts::sandbox::v1::SandboxImageRef {
                digest: digest.clone(),
                source: "/cache/base.erofs".to_string(),
            },
            workspace: Some(nession_protocol::contracts::sandbox::v1::SandboxWorkspace {
                image: None,
                write: "/state/workspace".to_string(),
                ownership:
                    nession_protocol::contracts::sandbox::v1::SandboxWorkspaceOwnership::Agent,
            }),
            toolchains: Vec::new(),
        };
        let policy = materialize_with_composition(
            &draft(serde_json::json!({ "enabled": true })),
            composition.clone(),
        )
        .expect("an empty access list becomes a composition");
        assert_eq!(
            policy
                .filesystem
                .as_ref()
                .and_then(|filesystem| filesystem.composition.as_ref())
                .map(|value| value.base.digest.as_str()),
            Some(digest.as_str())
        );
        assert!(policy
            .filesystem
            .as_ref()
            .is_some_and(|filesystem| filesystem.access.read.is_empty()));

        let errors = materialize_with_composition(
            &draft(serde_json::json!({
                "enabled": true,
                "filesystem": { "access": { "read": ["/usr"], "write": [] } }
            })),
            composition,
        )
        .expect_err("composition and access cannot both own the root");
        assert_eq!(errors[0].field, "filesystem.access");
    }
}
