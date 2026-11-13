//! Derive Server image selections from the client-safe Filesystem declaration
//! (#3405).
//!
//! The declaration is the single client authoring surface. `SandboxImageSelection`
//! remains the Server/Agent grant transport; when a client sends a
//! `filesystem.rootfs` or `filesystem.mounts` declaration, the Server derives
//! that transport shape here instead of requiring a second client object.
//! Nothing is downloaded or authorized in this module.

use nession_protocol::contracts::sandbox::v1::{
    SandboxFilesystemRoot, SandboxImageMode, SandboxImageRole, SandboxImageSelection,
    SandboxMountSource, SandboxPolicyDraft,
};

fn selection_key(selection: &SandboxImageSelection) -> (String, String, String, String) {
    let role = match selection.role {
        SandboxImageRole::Base => "base",
        SandboxImageRole::Workspace => "workspace",
        SandboxImageRole::Toolchain => "toolchain",
    };
    let mode = match selection.mode {
        SandboxImageMode::ReadOnly => "read_only",
        SandboxImageMode::Overlay => "overlay",
    };
    (
        role.to_string(),
        selection.digest.clone(),
        selection.target.clone().unwrap_or_default(),
        mode.to_string(),
    )
}

fn same_selections(left: &[SandboxImageSelection], right: &[SandboxImageSelection]) -> bool {
    let mut left: Vec<_> = left.iter().map(selection_key).collect();
    let mut right: Vec<_> = right.iter().map(selection_key).collect();
    left.sort();
    right.sort();
    left == right
}

/// Resolve the effective image transport for one preflight/Enter payload.
///
/// - no declaration: the explicit `images` list is unchanged (older clients);
/// - a declaration: Base Runtime and mount digests are derived into image
///   selections, and an explicitly supplied list must agree with it;
/// - an unmaterializable declaration (local root plus mounts, or mounts
///   without an image root) is refused before routing.
pub(super) fn derive_sandbox_image_selections(
    policy: &SandboxPolicyDraft,
    explicit: Vec<SandboxImageSelection>,
) -> Result<Vec<SandboxImageSelection>, String> {
    let Some(filesystem) = &policy.filesystem else {
        return Ok(explicit);
    };
    let has_declaration = filesystem.rootfs.is_some()
        || !filesystem.mounts.is_empty()
        || filesystem.workspace.is_some();
    if !has_declaration {
        return Ok(explicit);
    }

    let mut derived = Vec::new();
    match &filesystem.rootfs {
        Some(SandboxFilesystemRoot::Local) => {
            if !filesystem.mounts.is_empty() || filesystem.workspace.is_some() {
                return Err(
                    "filesystem.rootfs Local cannot carry mounts or a Workspace".to_string()
                );
            }
            if !explicit.is_empty() {
                return Err(
                    "filesystem.rootfs Local conflicts with the explicit image selection"
                        .to_string(),
                );
            }
            return Ok(Vec::new());
        }
        Some(SandboxFilesystemRoot::Image { digest }) => {
            derived.push(SandboxImageSelection {
                role: SandboxImageRole::Base,
                digest: digest.clone(),
                target: None,
                mode: SandboxImageMode::ReadOnly,
            });
        }
        None => {
            if !filesystem.mounts.is_empty() || filesystem.workspace.is_some() {
                return Err("filesystem mounts or Workspace require an image RootFS".to_string());
            }
            return Ok(explicit);
        }
    }

    for mount in &filesystem.mounts {
        if !mount.read_only {
            return Err("filesystem.mounts is read-only in the first implementation".to_string());
        }
        let SandboxMountSource::Image { digest } = &mount.source;
        derived.push(SandboxImageSelection {
            role: SandboxImageRole::Toolchain,
            digest: digest.clone(),
            target: Some(mount.target.clone()),
            mode: SandboxImageMode::ReadOnly,
        });
    }

    if !explicit.is_empty() && !same_selections(&derived, &explicit) {
        return Err(
            "the filesystem declaration and the explicit image selection disagree".to_string(),
        );
    }
    Ok(derived)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> String {
        format!("sha256:{}", "a".repeat(64))
    }

    fn tool() -> String {
        format!("sha256:{}", "b".repeat(64))
    }

    fn draft(filesystem: serde_json::Value) -> SandboxPolicyDraft {
        serde_json::from_value(serde_json::json!({
            "enabled": true,
            "filesystem": filesystem,
        }))
        .unwrap()
    }

    #[test]
    fn a_declaration_derives_base_and_toolchain_selections() {
        let policy = draft(serde_json::json!({
            "access": { "read": [], "write": [] },
            "rootfs": { "kind": "image", "digest": base() },
            "mounts": [{
                "source": { "kind": "image", "digest": tool() },
                "target": "/opt/tool",
                "read_only": true,
            }],
            "workspace": { "kind": "auto" },
        }));
        let derived = derive_sandbox_image_selections(&policy, Vec::new()).unwrap();
        assert_eq!(derived.len(), 2);
        assert_eq!(derived[0].role, SandboxImageRole::Base);
        assert_eq!(derived[1].target.as_deref(), Some("/opt/tool"));
    }

    #[test]
    fn an_explicit_list_must_agree_with_the_declaration() {
        let policy = draft(serde_json::json!({
            "access": { "read": [], "write": [] },
            "rootfs": { "kind": "image", "digest": base() },
        }));
        let matching = vec![SandboxImageSelection {
            role: SandboxImageRole::Base,
            digest: base(),
            target: None,
            mode: SandboxImageMode::ReadOnly,
        }];
        assert!(derive_sandbox_image_selections(&policy, matching).is_ok());
        let conflicting = vec![SandboxImageSelection {
            role: SandboxImageRole::Base,
            digest: tool(),
            target: None,
            mode: SandboxImageMode::ReadOnly,
        }];
        assert!(derive_sandbox_image_selections(&policy, conflicting).is_err());
    }

    #[test]
    fn local_root_with_mounts_or_workspace_is_refused() {
        for filesystem in [
            serde_json::json!({
                "access": { "read": [], "write": [] },
                "rootfs": { "kind": "local" },
                "mounts": [{
                    "source": { "kind": "image", "digest": tool() },
                    "target": "/opt/tool",
                    "read_only": true,
                }],
            }),
            serde_json::json!({
                "access": { "read": [], "write": [] },
                "rootfs": { "kind": "local" },
                "workspace": { "kind": "auto" },
            }),
        ] {
            assert!(derive_sandbox_image_selections(&draft(filesystem), Vec::new()).is_err());
        }
    }
}
