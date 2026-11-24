//! Derive Server image selections from the client-safe Filesystem declaration
//! (#3405).
//!
//! The declaration is the single client authoring surface. `SandboxImageSelection`
//! remains the Server/Agent grant transport; when a client sends a
//! `filesystem.rootfs` or `filesystem.mounts` declaration, the Server derives
//! that transport shape here instead of requiring a second client object.
//! Nothing is downloaded or authorized in this module.

use nession_protocol::contracts::image::v1::IMAGE_BLOB_PATH_PREFIX;
use nession_protocol::contracts::sandbox::v1::{
    SandboxFilesystemRoot, SandboxImageMode, SandboxImageRole, SandboxImageSelection,
    SandboxMountSource, SandboxPolicyDraft,
};
use nession_protocol::contracts::session::v1::{ManagedImageGrant, ManagedImageRole};

use crate::image::{ImageAccessGrant, ImageResolution, ResolvedManifestAccess};

/// Project one scoped legacy Blob grant into the Server→Agent contract.
pub(super) fn managed_grant(
    selection: &SandboxImageSelection,
    grant: ImageAccessGrant,
) -> ManagedImageGrant {
    let (role, target) = managed_role(selection);
    ManagedImageGrant {
        role,
        digest: selection.digest.clone(),
        path: grant.path,
        target,
        objects: Vec::new(),
    }
}

/// Project one resolved Manifest closure into the Server→Agent contract.
pub(super) fn managed_manifest_grant(
    selection: &SandboxImageSelection,
    access: ResolvedManifestAccess,
) -> ManagedImageGrant {
    let (role, target) = managed_role(selection);
    // The grant route is the authorized Manifest object's route (#4250): a
    // Tag-reachable Manifest carries a repository-scoped `/v2/` route, while an
    // untagged build or digest-only legacy row keeps the bounded compatibility
    // route. Deriving it from the object set keeps the grant and its Manifest
    // object on one identical route, which the Agent's fetch fence requires.
    let path = access
        .objects
        .first()
        .map(|object| object.path.clone())
        .unwrap_or_else(|| format!("{IMAGE_BLOB_PATH_PREFIX}{}", access.manifest_digest));
    ManagedImageGrant {
        role,
        path,
        digest: access.manifest_digest,
        target,
        objects: access
            .objects
            .into_iter()
            .map(
                |object| nession_protocol::contracts::session::v1::ManagedImageObjectGrant {
                    digest: object.digest,
                    media_type: object.media_type,
                    size_bytes: object.size_bytes,
                    path: object.path,
                },
            )
            .collect(),
    }
}

fn managed_role(selection: &SandboxImageSelection) -> (ManagedImageRole, Option<String>) {
    match selection.role {
        SandboxImageRole::Base => (ManagedImageRole::Base, None),
        SandboxImageRole::Workspace => (ManagedImageRole::Workspace, None),
        SandboxImageRole::Toolchain => (ManagedImageRole::Toolchain, selection.target.clone()),
    }
}

/// The scoped grant one authorized Image identity resolves to for a
/// consumer-driven cache preparation (#3796).
pub(super) fn prepare_grant(
    selection: &SandboxImageSelection,
    resolution: ImageResolution,
) -> ManagedImageGrant {
    match resolution {
        ImageResolution::Manifest(access) => managed_manifest_grant(selection, access),
        ImageResolution::Legacy(grant) => managed_grant(selection, grant),
    }
}

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
/// - a declaration: a Base Runtime and mount digests are derived into image
///   selections, and an explicitly supplied list must agree with it;
/// - a Local (or absent) RootFS with mounts is a Host-root composition: no
///   Base selection is derived, and the toolchain digests remain the only
///   added selection (#3792).
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
    if let Some(SandboxFilesystemRoot::Image { digest, .. }) = &filesystem.rootfs {
        derived.push(SandboxImageSelection {
            role: SandboxImageRole::Base,
            digest: digest.clone(),
            target: None,
            mode: SandboxImageMode::ReadOnly,
        });
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
    fn a_local_root_derives_toolchains_without_a_base() {
        let policy = draft(serde_json::json!({
            "access": { "read": [], "write": [] },
            "rootfs": { "kind": "local" },
            "mounts": [{
                "source": { "kind": "image", "digest": tool() },
                "target": "/opt/tool",
                "read_only": true,
            }],
        }));
        let derived = derive_sandbox_image_selections(&policy, Vec::new()).unwrap();
        assert_eq!(derived.len(), 1);
        assert_eq!(derived[0].role, SandboxImageRole::Toolchain);
        assert_eq!(derived[0].target.as_deref(), Some("/opt/tool"));
        assert!(
            derived
                .iter()
                .all(|selection| selection.role != SandboxImageRole::Base),
            "a Local RootFS never derives a Base Runtime selection"
        );

        let workspace_only = draft(serde_json::json!({
            "access": { "read": [], "write": [] },
            "rootfs": { "kind": "local" },
            "workspace": { "kind": "auto" },
        }));
        assert!(
            derive_sandbox_image_selections(&workspace_only, Vec::new())
                .unwrap()
                .is_empty(),
            "a Local Workspace preparation needs no image grant"
        );
    }
}
