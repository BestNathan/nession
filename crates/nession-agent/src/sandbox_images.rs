//! Sandbox image composition preparation (#3181).
//!
//! The Server authorizes each selected digest and hands the Agent scoped
//! download grants. This module is the Agent-side bridge between those grants
//! and the canonical `filesystem.composition` value:
//!
//! 1. fetch each image into the identity-namespaced EROFS cache;
//! 2. create one owned, bounded writable workspace for the overlay;
//! 3. build the canonical composition with local cache paths.
//!
//! It deliberately knows nothing about Web aliases, Project references or the
//! Server registry. Those ownership decisions happened before the grants
//! arrived.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use nession_protocol::contracts::sandbox::v1::{
    SandboxFilesystemComposition, SandboxImageRef, SandboxImageRole, SandboxImageSelection,
    SandboxToolchainImage, SandboxWorkspace, SandboxWorkspaceOwnership,
};
use nession_protocol::contracts::session::v1::{ManagedImageGrant, ManagedImageRole};
use uuid::Uuid;

use crate::erofs_cache::{
    resolve_grant_image, ErofsCache, ResolvedGrantImage, ResolvedManifestBinding,
};

/// Referenced Composite Images are a distribution/mount format, not a
/// Sandbox runtime composition input. #3697 explicitly does not make them a
/// prerequisite for Sandbox multi-lower/root composition, so selecting one
/// here fails closed instead of mounting the metadata image as a plain root.
fn reject_referenced_composite(resolved: &ResolvedGrantImage) -> Result<()> {
    if resolved.composite.is_some() {
        anyhow::bail!(
            "referenced Composite image {} is not yet selectable by the Sandbox composition; the EROFS mount manager owns its verified composite lease (#3697)",
            resolved.layer_digest
        );
    }
    Ok(())
}
use crate::managed_session::blob_origin;
use crate::workspace_manager::WorkspaceLease;

/// Resolve the actual toolchain mount target (#3500).
///
/// An explicit grant/request target is the user/Session override and wins.
/// Otherwise the Manifest's advisory `io.nession.mount.default` proposes it.
/// A missing override and proposal fails closed with an actionable error; the
/// Sandbox remains the authority that validates the chosen target.
pub(crate) fn toolchain_target(
    requested: Option<&str>,
    resolved: &ResolvedGrantImage,
) -> Result<String> {
    if let Some(target) = requested.filter(|target| !target.is_empty()) {
        return Ok(target.to_string());
    }
    if let Some(target) = resolved
        .usage
        .as_ref()
        .and_then(|usage| usage.mount_default.clone())
    {
        return Ok(target);
    }
    anyhow::bail!(
        "toolchain image {} declares no target and no io.nession.mount.default; \
         choose an /opt/<name> target",
        resolved.layer_digest
    )
}

/// Map the bounded standard Config Env suggestions into the prepared
/// composition. A legacy digest-addressed image has no Config to read.
pub(crate) fn image_env_defaults(
    resolved: &ResolvedGrantImage,
) -> Vec<nession_protocol::contracts::sandbox::v1::SandboxImageEnvDefault> {
    resolved
        .usage
        .as_ref()
        .map(|usage| {
            usage
                .environment
                .iter()
                .map(
                    |entry| nession_protocol::contracts::sandbox::v1::SandboxImageEnvDefault {
                        name: entry.name.clone(),
                        value: entry.value.clone(),
                    },
                )
                .collect()
        })
        .unwrap_or_default()
}

/// The advisory relative executable directory of a resolved image.
pub(crate) fn image_path_prepend(resolved: &ResolvedGrantImage) -> Option<String> {
    resolved
        .usage
        .as_ref()
        .and_then(|usage| usage.path_prepend.clone())
}

/// The validated `/workspace` selection an Agent resolved before preparing a
/// composition (#3407).
pub enum SandboxWorkspaceOverride {
    /// An Agent-managed durable directory plus its exclusive RW lease.
    Managed {
        path: PathBuf,
        lease: WorkspaceLease,
    },
    /// A Project Existing Location on this Agent. External/user-owned: the
    /// Agent never writes metadata into it and never deletes it.
    ProjectLocation { path: PathBuf },
}

impl std::fmt::Debug for SandboxWorkspaceOverride {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Managed { path, .. } => formatter
                .debug_struct("Managed")
                .field("path", path)
                .finish_non_exhaustive(),
            Self::ProjectLocation { path } => formatter
                .debug_tuple("ProjectLocation")
                .field(path)
                .finish(),
        }
    }
}

/// One prepared Sandbox image set, before a Pane exists.
pub struct PreparedSandboxImages {
    pub composition: SandboxFilesystemComposition,
    /// Removes the owned workspace if the caller fails before the execution
    /// record is persisted. Disarm once the sandbox owns the record.
    pub workspace_guard: WorkspaceGuard,
    /// `(role, layer digest, resolved cache path)` for diagnostics and tests.
    pub images: Vec<(ManagedImageRole, String, PathBuf)>,
    /// The final resolved Manifest identity per Manifest-aware grant (#3499).
    pub manifests: Vec<ResolvedManifestBinding>,
    /// The RW attachment to a selected managed Workspace, when one was used.
    /// The execution owner must hold it until cleanup.
    pub workspace_lease: Option<WorkspaceLease>,
}

/// Removes one Agent-owned Sandbox workspace unless disarmed.
pub struct WorkspaceGuard {
    path: PathBuf,
    root: PathBuf,
    armed: bool,
}

impl WorkspaceGuard {
    pub fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for WorkspaceGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        remove_owned_workspace(&self.root, &self.path);
    }
}

/// Remove a workspace only when it is a direct child of the owned workspace
/// root and its name is one this module generated.
pub fn remove_owned_workspace(root: &Path, path: &Path) {
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let owned_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("workspace-"))
        .is_some_and(|suffix| Uuid::parse_str(suffix).is_ok());
    if canonical.starts_with(&root) && canonical.parent() == Some(root.as_path()) && owned_name {
        let _ = std::fs::remove_dir_all(canonical);
    }
}

/// Fetch every grant and build the canonical composition.
pub async fn prepare(
    cache: &ErofsCache,
    grants: &[ManagedImageGrant],
    server_url: &str,
    server_auth_token: &str,
    state_dir: &Path,
    workspace_override: Option<SandboxWorkspaceOverride>,
) -> Result<PreparedSandboxImages> {
    let origin = blob_origin(server_url)?;
    let mut base: Option<&ManagedImageGrant> = None;
    let mut workspaces: Vec<&ManagedImageGrant> = Vec::new();
    let mut toolchains: Vec<&ManagedImageGrant> = Vec::new();
    for grant in grants {
        match grant.role {
            ManagedImageRole::Base => {
                if base.is_some() {
                    anyhow::bail!("a Sandbox composition has more than one Base Runtime image");
                }
                base = Some(grant);
            }
            ManagedImageRole::Workspace => workspaces.push(grant),
            ManagedImageRole::Toolchain => toolchains.push(grant),
        }
    }
    if workspaces.len() > 16 {
        anyhow::bail!("a Sandbox composition has more than 16 ordered workspace lowers");
    }
    let base =
        base.ok_or_else(|| anyhow::anyhow!("a composition requires a Base Runtime image"))?;

    let workspace_root = state_dir.join("sandbox-workspaces");
    std::fs::create_dir_all(&workspace_root).with_context(|| {
        format!(
            "cannot create the Sandbox workspace root {}",
            workspace_root.display()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&workspace_root, std::fs::Permissions::from_mode(0o700));
    }
    let workspace_dir = workspace_root.join(format!("workspace-{}", Uuid::new_v4()));
    std::fs::create_dir(&workspace_dir).with_context(|| {
        format!(
            "cannot create the Sandbox workspace {}",
            workspace_dir.display()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&workspace_dir, std::fs::Permissions::from_mode(0o700));
    }
    let mut guard = WorkspaceGuard {
        path: workspace_dir.clone(),
        root: workspace_root,
        armed: true,
    };

    let mut images = Vec::with_capacity(grants.len());
    let mut manifests = Vec::new();
    let record = |role: ManagedImageRole, resolved: crate::erofs_cache::ResolvedGrantImage| {
        let mut binding = None;
        if let Some(manifest_digest) = resolved.manifest_digest.clone() {
            binding = Some(ResolvedManifestBinding {
                role,
                manifest_digest,
                layer_digest: resolved.layer_digest.clone(),
            });
        }
        ((role, resolved.layer_digest, resolved.layer_path), binding)
    };
    let (base_ref, base_env) =
        match resolve_grant_image(cache, base, &origin, server_auth_token).await {
            Ok(resolved) => {
                if let Err(error) = reject_referenced_composite(&resolved) {
                    guard.disarm();
                    remove_owned_workspace(&guard.root, &guard.path);
                    return Err(error);
                }
                let base_env = image_env_defaults(&resolved);
                let ((role, digest, path), binding) = record(ManagedImageRole::Base, resolved);
                manifests.extend(binding);
                images.push((role, digest.clone(), path.clone()));
                (
                    SandboxImageRef {
                        digest,
                        source: path.display().to_string(),
                    },
                    base_env,
                )
            }
            Err(error) => {
                guard.disarm();
                remove_owned_workspace(&guard.root, &guard.path);
                return Err(error);
            }
        };
    let mut workspace_refs = Vec::with_capacity(workspaces.len());
    for grant in workspaces {
        let resolved = match resolve_grant_image(cache, grant, &origin, server_auth_token).await {
            Ok(resolved) => resolved,
            Err(error) => {
                guard.disarm();
                remove_owned_workspace(&guard.root, &guard.path);
                return Err(error);
            }
        };
        if let Err(error) = reject_referenced_composite(&resolved) {
            guard.disarm();
            remove_owned_workspace(&guard.root, &guard.path);
            return Err(error);
        }
        let ((role, digest, path), binding) = record(ManagedImageRole::Workspace, resolved);
        manifests.extend(binding);
        images.push((role, digest.clone(), path.clone()));
        workspace_refs.push(SandboxImageRef {
            digest,
            source: path.display().to_string(),
        });
    }
    let mut toolchain_refs = Vec::with_capacity(toolchains.len());
    for grant in toolchains {
        let resolved = match resolve_grant_image(cache, grant, &origin, server_auth_token).await {
            Ok(value) => value,
            Err(error) => {
                guard.disarm();
                remove_owned_workspace(&guard.root, &guard.path);
                return Err(error);
            }
        };
        if let Err(error) = reject_referenced_composite(&resolved) {
            guard.disarm();
            remove_owned_workspace(&guard.root, &guard.path);
            return Err(error);
        }
        let target = match toolchain_target(grant.target.as_deref(), &resolved) {
            Ok(target) => target,
            Err(error) => {
                guard.disarm();
                remove_owned_workspace(&guard.root, &guard.path);
                return Err(error);
            }
        };
        let env = image_env_defaults(&resolved);
        let path_prepend = image_path_prepend(&resolved);
        let ((role, digest, path), binding) = record(ManagedImageRole::Toolchain, resolved);
        manifests.extend(binding);
        images.push((role, digest.clone(), path.clone()));
        toolchain_refs.push(SandboxToolchainImage {
            digest,
            source: path.display().to_string(),
            target,
            env,
            path_prepend,
        });
    }

    let mut composition = SandboxFilesystemComposition {
        base: base_ref,
        base_writable: false,
        workspace: Some(SandboxWorkspace {
            image: None,
            lowers: workspace_refs,
            write: workspace_dir.display().to_string(),
            ownership: SandboxWorkspaceOwnership::Agent,
        }),
        toolchains: toolchain_refs,
        base_env,
    };
    let mut workspace_lease = None;
    #[cfg(target_os = "linux")]
    let mut owns_scratch_workspace = true;
    if let Some(workspace_override) = workspace_override {
        // The selected directory is the durable workspace; the manager owns
        // its bytes. Remove the per-execution placeholder.
        #[cfg(target_os = "linux")]
        {
            owns_scratch_workspace = false;
        }
        guard.disarm();
        remove_owned_workspace(&guard.root, &guard.path);
        let (write, ownership) = match workspace_override {
            SandboxWorkspaceOverride::Managed { path, lease } => {
                workspace_lease = Some(lease);
                (path, SandboxWorkspaceOwnership::Agent)
            }
            SandboxWorkspaceOverride::ProjectLocation { path } => {
                if composition
                    .workspace
                    .as_ref()
                    .is_some_and(SandboxWorkspace::has_lowers)
                {
                    anyhow::bail!(
                        "a Project Location cannot be combined with a Project EROFS lower"
                    );
                }
                (path, SandboxWorkspaceOwnership::ProjectLocation)
            }
        };
        let lowers = composition
            .workspace
            .take()
            .map(|workspace| workspace.lowers)
            .unwrap_or_default();
        composition.workspace = Some(SandboxWorkspace {
            image: None,
            lowers,
            write: write.display().to_string(),
            ownership,
        });
    }
    // The durable Overlay upper/work is Agent-owned workspace state (#3582).
    // A scratch workspace is initialized here; a selected managed Workspace
    // must already have been initialized by its owner, so a missing pair is a
    // data-loss refusal rather than a fresh empty upper.
    #[cfg(target_os = "linux")]
    if let Some(workspace) = composition
        .workspace
        .as_ref()
        .filter(|workspace| workspace.has_lowers())
    {
        let write = workspace.write.clone();
        let write = Path::new(&write);
        let outcome = if owns_scratch_workspace {
            nession_sandbox::mount::overlay::storage::initialize(write)
        } else {
            nession_sandbox::mount::overlay::storage::verify(write)
        };
        if let Err(error) = outcome {
            return Err(error.context(format!(
                "the Sandbox workspace {} has no usable durable Overlay storage",
                write.display()
            )));
        }
    }
    Ok(PreparedSandboxImages {
        composition,
        workspace_guard: guard,
        images,
        manifests,
        workspace_lease,
    })
}

/// Build a composition from selection metadata with cache-shaped placeholder
/// paths. Preflight skips host existence checks; Enter replaces these with the
/// verified local paths.
///
/// `project_location` is the Server-resolved Project Existing Location for the
/// effective `project_location`/`auto` branch. Preflight does not touch the
/// host, so the path is carried as the declared external workspace without
/// creating anything.
pub fn preflight_composition(
    cache: &ErofsCache,
    selections: &[SandboxImageSelection],
    project_location: Option<&str>,
) -> Result<SandboxFilesystemComposition> {
    let mut base = None;
    let mut lowers = Vec::new();
    let mut toolchains = Vec::new();
    for selection in selections {
        let source = cache
            .blob_path(&selection.digest)
            .with_context(|| format!("invalid image digest {}", selection.digest))?;
        let image = SandboxImageRef {
            digest: selection.digest.clone(),
            source: source.display().to_string(),
        };
        match selection.role {
            SandboxImageRole::Base => {
                if base.replace(image).is_some() {
                    anyhow::bail!("a Sandbox composition has more than one Base Runtime image");
                }
            }
            SandboxImageRole::Workspace => {
                if lowers.len() >= 16 {
                    anyhow::bail!("a Sandbox composition has more than 16 workspace lowers");
                }
                lowers.push(image);
            }
            SandboxImageRole::Toolchain => {
                let Some(target) = selection.target.clone().filter(|target| !target.is_empty())
                else {
                    anyhow::bail!(
                        "toolchain image {} has no /opt/<name> target",
                        selection.digest
                    );
                };
                toolchains.push(SandboxToolchainImage {
                    digest: image.digest,
                    source: image.source,
                    target,
                    // Preflight reads no image bytes; Enter resolves the
                    // Config Env and advisory prepend from the verified cache.
                    env: Vec::new(),
                    path_prepend: None,
                });
            }
        }
    }
    let base =
        base.ok_or_else(|| anyhow::anyhow!("a composition requires a Base Runtime image"))?;
    if project_location.is_some() && !lowers.is_empty() {
        anyhow::bail!("a Project Location cannot be combined with a Project EROFS lower");
    }
    let (write, ownership) = match project_location {
        Some(path) => (path.to_string(), SandboxWorkspaceOwnership::ProjectLocation),
        None => (
            cache
                .root()
                .join("sandbox-workspaces")
                .join("preflight")
                .display()
                .to_string(),
            SandboxWorkspaceOwnership::Agent,
        ),
    };
    Ok(SandboxFilesystemComposition {
        base,
        base_writable: false,
        workspace: Some(SandboxWorkspace {
            image: None,
            lowers,
            write,
            ownership,
        }),
        toolchains,
        base_env: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::erofs_cache::StorageProbe;
    use httptest::http::Response;
    use httptest::{matchers::*, Expectation, Server};
    use nession_protocol::contracts::sandbox::v1::SandboxImageMode;
    use sha2::{Digest, Sha256};

    fn digest_for(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        format!("sha256:{:x}", hasher.finalize())
    }

    /// The Server Token the Agent presents on the image-blob route (#3440).
    /// The blob origin in these tests is `httptest`, which does not check it.
    const SERVER_AUTH_TOKEN: &str = "server-auth-token";

    struct DurableProbe;
    impl StorageProbe for DurableProbe {
        fn mount_type(&self, _path: &Path) -> anyhow::Result<String> {
            Ok("nfs".to_string())
        }
    }

    async fn cache(root: &Path) -> ErofsCache {
        ErofsCache::open_with_probe(root, "sandbox-images-test", true, &DurableProbe)
            .await
            .unwrap()
    }

    fn ws_url(server: &Server) -> String {
        server.url("/").to_string().replacen("http://", "ws://", 1)
    }

    fn grant(role: ManagedImageRole, digest: &str, target: Option<&str>) -> ManagedImageGrant {
        ManagedImageGrant {
            role,
            digest: digest.to_string(),
            path: format!("/images/blobs/{digest}"),
            target: target.map(str::to_string),
            objects: Vec::new(),
        }
    }

    #[tokio::test]
    async fn prepare_fetches_every_role_and_builds_the_composition() {
        let cache_dir = tempfile::tempdir().unwrap();
        let state_dir = tempfile::tempdir().unwrap();
        let cache = cache(cache_dir.path()).await;
        let base_bytes = b"base image".to_vec();
        let workspace_bytes = b"workspace image".to_vec();
        let toolchain_bytes = b"toolchain image".to_vec();
        let base = digest_for(&base_bytes);
        let workspace = digest_for(&workspace_bytes);
        let toolchain = digest_for(&toolchain_bytes);
        let server = Server::run();
        for (digest, bytes) in [
            (&base, base_bytes),
            (&workspace, workspace_bytes),
            (&toolchain, toolchain_bytes),
        ] {
            server.expect(
                Expectation::matching(request::method_path(
                    "GET",
                    format!("/images/blobs/{digest}"),
                ))
                .times(1)
                .respond_with(Response::builder().status(200).body(bytes).unwrap()),
            );
        }

        let prepared = prepare(
            &cache,
            &[
                grant(ManagedImageRole::Base, &base, None),
                grant(ManagedImageRole::Workspace, &workspace, None),
                grant(ManagedImageRole::Toolchain, &toolchain, Some("/opt/rust")),
            ],
            &ws_url(&server),
            SERVER_AUTH_TOKEN,
            state_dir.path(),
            None,
        )
        .await
        .unwrap();

        assert_eq!(prepared.composition.base.digest, base);
        assert_eq!(
            prepared
                .composition
                .workspace
                .as_ref()
                .unwrap()
                .lowers
                .first()
                .unwrap()
                .digest,
            workspace
        );
        let workspace_dir = prepared
            .composition
            .workspace
            .as_ref()
            .unwrap()
            .write
            .clone();
        assert!(Path::new(&workspace_dir).is_dir());
        assert!(workspace_dir.starts_with(state_dir.path().to_string_lossy().as_ref()));
        assert_eq!(prepared.composition.toolchains[0].target, "/opt/rust");
        assert_eq!(prepared.images.len(), 3);
        for (_, digest, path) in &prepared.images {
            assert_eq!(
                crate::erofs_cache::status(&cache, digest).await.state,
                nession_protocol::contracts::image::v1::ImageCacheState::Verified
            );
            assert!(path.exists(), "cache path exists after preparation");
        }

        // The guard owns the workspace until a persisted record takes over.
        let mut guard = prepared.workspace_guard;
        guard.disarm();
        assert!(Path::new(&workspace_dir).is_dir());
        std::fs::remove_dir_all(&workspace_dir).unwrap();
    }

    #[tokio::test]
    async fn preflight_builds_a_composition_from_metadata_without_fetching() {
        let cache_dir = tempfile::tempdir().unwrap();
        let cache = cache(cache_dir.path()).await;
        let base = format!("sha256:{}", "a".repeat(64));
        let workspace = format!("sha256:{}", "b".repeat(64));
        let toolchain = format!("sha256:{}", "c".repeat(64));
        let composition = preflight_composition(
            &cache,
            &[
                SandboxImageSelection {
                    role: SandboxImageRole::Base,
                    digest: base.clone(),
                    target: None,
                    mode: SandboxImageMode::ReadOnly,
                },
                SandboxImageSelection {
                    role: SandboxImageRole::Workspace,
                    digest: workspace.clone(),
                    target: None,
                    mode: SandboxImageMode::Overlay,
                },
                SandboxImageSelection {
                    role: SandboxImageRole::Toolchain,
                    digest: toolchain,
                    target: Some("/opt/node".to_string()),
                    mode: SandboxImageMode::ReadOnly,
                },
            ],
            None,
        )
        .unwrap();
        assert_eq!(composition.base.digest, base);
        assert_eq!(
            composition.base.source,
            cache.blob_path(&base).unwrap().display().to_string()
        );
        assert_eq!(composition.toolchains[0].target, "/opt/node");
        assert_eq!(
            composition
                .workspace
                .as_ref()
                .unwrap()
                .lowers
                .first()
                .unwrap()
                .digest,
            workspace
        );
        // No bytes were downloaded by preflight.
        assert_eq!(cache.fetch_count(), 0);
    }

    #[test]
    fn workspace_cleanup_refuses_an_unowned_path() {
        let root = tempfile::tempdir().unwrap();
        let owned_root = root.path().join("sandbox-workspaces");
        std::fs::create_dir(&owned_root).unwrap();
        let owned = owned_root.join(format!("workspace-{}", Uuid::new_v4()));
        std::fs::create_dir(&owned).unwrap();
        remove_owned_workspace(&owned_root, &owned);
        assert!(!owned.exists());

        let foreign = root.path().join("foreign");
        std::fs::create_dir(&foreign).unwrap();
        remove_owned_workspace(&owned_root, &foreign);
        assert!(foreign.exists());
    }
}

#[cfg(test)]
mod workspace_override_tests {
    use super::*;
    use crate::erofs_cache::StorageProbe;
    use httptest::http::Response;
    use httptest::{matchers::*, Expectation, Server};
    use nession_protocol::contracts::session::v1::ManagedImageRole;
    use sha2::{Digest, Sha256};
    use std::sync::Arc;

    struct DurableProbe;
    impl StorageProbe for DurableProbe {
        fn mount_type(&self, _path: &Path) -> anyhow::Result<String> {
            Ok("nfs".to_string())
        }
    }

    fn digest_for(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        format!("sha256:{:x}", hasher.finalize())
    }

    /// The Server Token the Agent presents on the image-blob route (#3440).
    /// The blob origin in these tests is `httptest`, which does not check it.
    const SERVER_AUTH_TOKEN: &str = "server-auth-token";

    async fn cache(root: &Path) -> ErofsCache {
        ErofsCache::open_with_probe(root, "workspace-override-test", true, &DurableProbe)
            .await
            .unwrap()
    }

    fn grant(role: ManagedImageRole, digest: &str, target: Option<&str>) -> ManagedImageGrant {
        ManagedImageGrant {
            role,
            digest: digest.to_string(),
            path: format!("/images/blobs/{digest}"),
            target: target.map(str::to_string),
            objects: Vec::new(),
        }
    }

    #[tokio::test]
    async fn a_selected_managed_workspace_replaces_the_execution_scratch_dir() {
        let cache_dir = tempfile::tempdir().unwrap();
        let state_dir = tempfile::tempdir().unwrap();
        let cache = cache(cache_dir.path()).await;
        let base_bytes = b"base image".to_vec();
        let base = digest_for(&base_bytes);
        let server = Server::run();
        server.expect(
            Expectation::matching(request::method_path("GET", format!("/images/blobs/{base}")))
                .respond_with(Response::builder().status(200).body(base_bytes).unwrap()),
        );
        let manager = Arc::new(
            crate::workspace_manager::WorkspaceManager::open(
                state_dir.path().join("agent-workspaces"),
            )
            .unwrap(),
        );
        let workspace = manager
            .get_or_create(None, "fix-terminal", true)
            .await
            .unwrap();
        let lease = manager.lease(&workspace.workspace_id).await.unwrap();
        let path = manager
            .workspace_directory(&workspace.workspace_id)
            .unwrap();
        let prepared = prepare(
            &cache,
            &[grant(ManagedImageRole::Base, &base, None)],
            &server.url("/").to_string().replacen("http://", "ws://", 1),
            SERVER_AUTH_TOKEN,
            state_dir.path(),
            Some(SandboxWorkspaceOverride::Managed {
                path: path.clone(),
                lease,
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            prepared.composition.workspace.as_ref().unwrap().write,
            path.display().to_string()
        );
        assert_eq!(
            prepared.composition.workspace.as_ref().unwrap().ownership,
            SandboxWorkspaceOwnership::Agent
        );
        assert!(prepared
            .composition
            .workspace
            .as_ref()
            .unwrap()
            .lowers
            .is_empty());
        assert!(prepared.workspace_lease.is_some());
        let scratch = state_dir.path().join("sandbox-workspaces");
        let leftovers = std::fs::read_dir(&scratch)
            .map(std::iter::Iterator::count)
            .unwrap_or(0);
        assert_eq!(leftovers, 0);
    }

    #[tokio::test]
    async fn a_managed_workspace_keeps_the_project_erofs_lower() {
        let cache_dir = tempfile::tempdir().unwrap();
        let state_dir = tempfile::tempdir().unwrap();
        let cache = cache(cache_dir.path()).await;
        let base_bytes = b"base image".to_vec();
        let workspace_bytes = b"project image".to_vec();
        let base = digest_for(&base_bytes);
        let workspace_digest = digest_for(&workspace_bytes);
        let server = Server::run();
        for (digest, bytes) in [(&base, base_bytes), (&workspace_digest, workspace_bytes)] {
            server.expect(
                Expectation::matching(request::method_path(
                    "GET",
                    format!("/images/blobs/{digest}"),
                ))
                .respond_with(Response::builder().status(200).body(bytes).unwrap()),
            );
        }
        let manager = Arc::new(
            crate::workspace_manager::WorkspaceManager::open(
                state_dir.path().join("agent-workspaces"),
            )
            .unwrap(),
        );
        let workspace = manager
            .get_or_create(None, "with-lower", true)
            .await
            .unwrap();
        let lease = manager.lease(&workspace.workspace_id).await.unwrap();
        let path = manager
            .workspace_directory(&workspace.workspace_id)
            .unwrap();
        // The Agent owner initializes the durable Overlay storage before a
        // lower-backed composition is prepared (#3582).
        #[cfg(target_os = "linux")]
        nession_sandbox::mount::overlay::storage::initialize(&path).unwrap();
        let prepared = prepare(
            &cache,
            &[
                grant(ManagedImageRole::Base, &base, None),
                grant(ManagedImageRole::Workspace, &workspace_digest, None),
            ],
            &server.url("/").to_string().replacen("http://", "ws://", 1),
            SERVER_AUTH_TOKEN,
            state_dir.path(),
            Some(SandboxWorkspaceOverride::Managed { path, lease }),
        )
        .await
        .unwrap();
        let composition = prepared.composition.workspace.as_ref().unwrap();
        assert_eq!(composition.ownership, SandboxWorkspaceOwnership::Agent);
        assert_eq!(
            composition.lowers.first().unwrap().digest,
            workspace_digest,
            "the Project source EROFS stays the pinned lower"
        );
        assert!(composition.write.ends_with("with-lower") || composition.write.contains("ws_"));
        assert!(prepared.workspace_lease.is_some());
    }

    #[tokio::test]
    async fn a_project_location_is_external_and_refuses_a_lower() {
        let cache_dir = tempfile::tempdir().unwrap();
        let state_dir = tempfile::tempdir().unwrap();
        let cache = cache(cache_dir.path()).await;
        let base_bytes = b"base image".to_vec();
        let workspace_bytes = b"project image".to_vec();
        let base = digest_for(&base_bytes);
        let workspace_digest = digest_for(&workspace_bytes);
        let server = Server::run();
        for (digest, bytes) in [(&base, base_bytes), (&workspace_digest, workspace_bytes)] {
            server.expect(
                Expectation::matching(request::method_path(
                    "GET",
                    format!("/images/blobs/{digest}"),
                ))
                .respond_with(Response::builder().status(200).body(bytes).unwrap()),
            );
        }
        let location = tempfile::tempdir().unwrap();
        let path = std::fs::canonicalize(location.path()).unwrap();
        let prepared = prepare(
            &cache,
            &[grant(ManagedImageRole::Base, &base, None)],
            &server.url("/").to_string().replacen("http://", "ws://", 1),
            SERVER_AUTH_TOKEN,
            state_dir.path(),
            Some(SandboxWorkspaceOverride::ProjectLocation { path: path.clone() }),
        )
        .await
        .unwrap();
        let composition = prepared.composition.workspace.as_ref().unwrap();
        assert_eq!(
            composition.ownership,
            SandboxWorkspaceOwnership::ProjectLocation
        );
        assert_eq!(composition.write, path.display().to_string());
        assert!(composition.lowers.is_empty());
        assert!(prepared.workspace_lease.is_none());
        assert!(
            path.is_dir(),
            "the external Project Location is never deleted"
        );

        let refused = prepare(
            &cache,
            &[
                grant(ManagedImageRole::Base, &base, None),
                grant(ManagedImageRole::Workspace, &workspace_digest, None),
            ],
            &server.url("/").to_string().replacen("http://", "ws://", 1),
            SERVER_AUTH_TOKEN,
            state_dir.path(),
            Some(SandboxWorkspaceOverride::ProjectLocation { path }),
        )
        .await;
        let error = match refused {
            Ok(_) => panic!("a Project Location with a lower must be refused"),
            Err(error) => error,
        };
        assert!(format!("{error:#}").contains("Project EROFS lower"));
    }

    /// Verify that reject_referenced_composite produces the expected error
    /// for a ResolvedGrantImage with composite metadata (#3784).
    #[test]
    fn reject_referenced_composite_produces_actionable_error() {
        let resolved = ResolvedGrantImage {
            manifest_digest: Some("sha256:manifest".to_string()),
            layer_digest: "sha256:metadata".to_string(),
            layer_path: PathBuf::from("/cache/metadata"),
            usage: None,
            composite: Some(ResolvedCompositeGrant {
                descriptor_digest: "sha256:descriptor".to_string(),
                metadata_digest: "sha256:metadata".to_string(),
                device_digests: vec!["sha256:device1".to_string()],
                metadata_path: PathBuf::from("/cache/metadata"),
                device_paths: vec![PathBuf::from("/cache/device1")],
            }),
        };
        let error = reject_referenced_composite(&resolved).unwrap_err();
        let message = format!("{error:#}");
        assert!(
            message.contains("not yet selectable by the Sandbox composition"),
            "error message should explain the composite is not selectable: {message}"
        );
        assert!(
            message.contains("sha256:metadata"),
            "error message should include the layer digest: {message}"
        );
        assert!(
            message.contains("#3697"),
            "error message should reference the related issue: {message}"
        );
    }

    /// Verify that a non-composite ResolvedGrantImage passes the check (#3784).
    #[test]
    fn reject_referenced_composite_accepts_plain_image() {
        let resolved = ResolvedGrantImage {
            manifest_digest: Some("sha256:manifest".to_string()),
            layer_digest: "sha256:layer".to_string(),
            layer_path: PathBuf::from("/cache/layer"),
            usage: None,
            composite: None,
        };
        reject_referenced_composite(&resolved).expect("plain image should be accepted");
    }

    /// Helper to create a composite grant with the required object structure (#3784).
    fn composite_grant(
        role: ManagedImageRole,
        manifest_digest: &str,
        target: Option<&str>,
    ) -> ManagedImageGrant {
        use nession_protocol::contracts::session::v1::ManagedImageObject;
        ManagedImageGrant {
            role,
            digest: manifest_digest.to_string(),
            path: format!("/images/blobs/{manifest_digest}"),
            target: target.map(str::to_string),
            objects: vec![
                ManagedImageObject {
                    digest: manifest_digest.to_string(),
                    media_type: nession_erofs::oci::MEDIA_TYPE_MANIFEST.to_string(),
                    size_bytes: 100,
                    path: format!("/images/blobs/{manifest_digest}"),
                },
                ManagedImageObject {
                    digest: "sha256:composite-descriptor".to_string(),
                    media_type: nession_erofs::oci::MEDIA_TYPE_COMPOSITE.to_string(),
                    size_bytes: 200,
                    path: "/images/blobs/sha256:composite-descriptor".to_string(),
                },
            ],
        }
    }

    /// Verify that a composite Base image is rejected at the preparation boundary (#3784).
    #[tokio::test]
    async fn prepare_rejects_composite_base_before_workspace_creation() {
        let cache_dir = tempfile::tempdir().unwrap();
        let state_dir = tempfile::tempdir().unwrap();
        let cache = cache(cache_dir.path()).await;
        let manifest_digest = "sha256:base-manifest";
        let server = Server::run();
        // Mock the manifest fetch to return invalid JSON (will fail before composite check)
        server.expect(
            Expectation::matching(request::method_path(
                "GET",
                format!("/images/blobs/{manifest_digest}"),
            ))
            .respond_with(Response::builder().status(200).body(b"not json").unwrap()),
        );

        let result = prepare(
            &cache,
            &[composite_grant(ManagedImageRole::Base, manifest_digest, None)],
            &ws_url(&server),
            SERVER_AUTH_TOKEN,
            state_dir.path(),
            None,
        )
        .await;

        // The preparation should fail (either during fetch or composite rejection)
        assert!(result.is_err(), "composite Base should be rejected");

        // Verify no workspace was created (cleanup occurred)
        let workspace_root = state_dir.path().join("sandbox-workspaces");
        let workspace_count = std::fs::read_dir(&workspace_root)
            .map(|entries| entries.count())
            .unwrap_or(0);
        assert_eq!(
            workspace_count, 0,
            "no workspace should remain after composite rejection"
        );
    }

    /// Verify that a composite Workspace image is rejected at the preparation boundary (#3784).
    #[tokio::test]
    async fn prepare_rejects_composite_workspace_before_mount() {
        let cache_dir = tempfile::tempdir().unwrap();
        let state_dir = tempfile::tempdir().unwrap();
        let cache = cache(cache_dir.path()).await;
        let base_bytes = b"base image".to_vec();
        let base = digest_for(&base_bytes);
        let workspace_manifest = "sha256:workspace-manifest";
        let server = Server::run();
        server.expect(
            Expectation::matching(request::method_path("GET", format!("/images/blobs/{base}")))
                .respond_with(Response::builder().status(200).body(base_bytes).unwrap()),
        );
        server.expect(
            Expectation::matching(request::method_path(
                "GET",
                format!("/images/blobs/{workspace_manifest}"),
            ))
            .respond_with(Response::builder().status(200).body(b"not json").unwrap()),
        );

        let result = prepare(
            &cache,
            &[
                grant(ManagedImageRole::Base, &base, None),
                composite_grant(ManagedImageRole::Workspace, workspace_manifest, None),
            ],
            &ws_url(&server),
            SERVER_AUTH_TOKEN,
            state_dir.path(),
            None,
        )
        .await;

        assert!(result.is_err(), "composite Workspace should be rejected");

        let workspace_root = state_dir.path().join("sandbox-workspaces");
        let workspace_count = std::fs::read_dir(&workspace_root)
            .map(|entries| entries.count())
            .unwrap_or(0);
        assert_eq!(
            workspace_count, 0,
            "workspace should be cleaned up after composite rejection"
        );
    }

    /// Verify that a composite Toolchain image is rejected at the preparation boundary (#3784).
    #[tokio::test]
    async fn prepare_rejects_composite_toolchain_before_mount() {
        let cache_dir = tempfile::tempdir().unwrap();
        let state_dir = tempfile::tempdir().unwrap();
        let cache = cache(cache_dir.path()).await;
        let base_bytes = b"base image".to_vec();
        let base = digest_for(&base_bytes);
        let toolchain_manifest = "sha256:toolchain-manifest";
        let server = Server::run();
        server.expect(
            Expectation::matching(request::method_path("GET", format!("/images/blobs/{base}")))
                .respond_with(Response::builder().status(200).body(base_bytes).unwrap()),
        );
        server.expect(
            Expectation::matching(request::method_path(
                "GET",
                format!("/images/blobs/{toolchain_manifest}"),
            ))
            .respond_with(Response::builder().status(200).body(b"not json").unwrap()),
        );

        let result = prepare(
            &cache,
            &[
                grant(ManagedImageRole::Base, &base, None),
                composite_grant(ManagedImageRole::Toolchain, toolchain_manifest, Some("/opt/rust")),
            ],
            &ws_url(&server),
            SERVER_AUTH_TOKEN,
            state_dir.path(),
            None,
        )
        .await;

        assert!(result.is_err(), "composite Toolchain should be rejected");

        let workspace_root = state_dir.path().join("sandbox-workspaces");
        let workspace_count = std::fs::read_dir(&workspace_root)
            .map(|entries| entries.count())
            .unwrap_or(0);
        assert_eq!(
            workspace_count, 0,
            "workspace should be cleaned up after composite rejection"
        );
    }
}
