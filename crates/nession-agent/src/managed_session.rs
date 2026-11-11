//! Managed EROFS-backed Session preparation (#3062).
//!
//! The Server pins and authorizes every artifact and hands over scoped
//! download grants; this module turns them into a prepared composition on the
//! Agent:
//!
//! 1. fetch every image into the Agent's durable identity-namespaced EROFS
//!    cache (the same verified bytes the Sandbox will mount);
//! 2. create one Agent-owned, bounded writable workspace for this attempt;
//! 3. build and compile the `filesystem.composition` policy with absolute
//!    cache paths, `/workspace` as the sandbox cwd and the declared
//!    `/opt/<name>` toolchains.
//!
//! A missing grant, cache, URL or image refuses the create. There is no
//! Native fallback and no image is fetched from an arbitrary URL: every
//! request goes to the Agent's configured Server origin plus the grant path.

use anyhow::{Context, Result};
use nession_protocol::contracts::sandbox::v1::{
    SandboxEnforcement, SandboxFilesystemAccess, SandboxFilesystemComposition,
    SandboxFilesystemPolicy, SandboxImageRef, SandboxPolicy, SandboxToolchainImage,
    SandboxWorkspace, SANDBOX_POLICY_VERSION,
};
use nession_protocol::contracts::session::v1::{ManagedImageGrant, ManagedImageRole};
use std::path::{Path, PathBuf};

use crate::erofs_cache::{DownloadGrant, ErofsCache};

/// The sandbox path the initial Pane starts in. The composed root exposes the
/// Project image and writable overlay here; the host has no such directory.
pub const MANAGED_WORKING_DIR: &str = "/workspace";

/// One prepared Managed Session, before tmux creates anything.
#[derive(Debug, Clone)]
pub struct PreparedManagedSession {
    pub policy: SandboxPolicy,
    /// The Agent-owned host directory bound at `/workspace`.
    pub workspace: PathBuf,
    /// `(role, digest, resolved cache path)` for diagnostics and tests.
    pub images: Vec<(ManagedImageRole, String, PathBuf)>,
}

/// Derive the blob HTTP origin from the Agent's configured Server URL.
///
/// The Server states an authorized route, never a URL: the Agent is the side
/// that knows how it reaches its Server (`ws://`/`wss://`), so the scheme and
/// origin come from here and the path comes from the grant.
pub(crate) fn blob_origin(server_url: &str) -> Result<String> {
    let url = reqwest::Url::parse(server_url)
        .with_context(|| format!("the Agent's server_url '{server_url}' is not a URL"))?;
    let scheme = match url.scheme() {
        "ws" => "http",
        "wss" => "https",
        other => anyhow::bail!(
            "the Agent's server_url uses unsupported scheme '{other}'; Managed creation needs ws or wss"
        ),
    };
    let host = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("the Agent's server_url has no host"))?;
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Ok(format!("{scheme}://{host}{port}"))
}

/// Prepare one Managed Session's cache and composition.
pub async fn prepare(
    cache: &ErofsCache,
    images: &[ManagedImageGrant],
    server_url: &str,
    state_dir: &Path,
) -> Result<PreparedManagedSession> {
    let origin = blob_origin(server_url)?;

    // Validate the grant set before touching the cache or the filesystem.
    let mut base: Option<&ManagedImageGrant> = None;
    let mut workspace: Option<&ManagedImageGrant> = None;
    let mut toolchains: Vec<&ManagedImageGrant> = Vec::new();
    for image in images {
        match image.role {
            ManagedImageRole::Base => {
                if base.is_some() {
                    anyhow::bail!("a Managed Session carries more than one Base Runtime image");
                }
                base = Some(image);
            }
            ManagedImageRole::Workspace => {
                if workspace.is_some() {
                    anyhow::bail!("a Managed Session carries more than one Project Source image");
                }
                workspace = Some(image);
            }
            ManagedImageRole::Toolchain => toolchains.push(image),
        }
    }
    let base =
        base.ok_or_else(|| anyhow::anyhow!("a Managed Session requires a Base Runtime image"))?;
    let workspace = workspace
        .ok_or_else(|| anyhow::anyhow!("a Managed Session requires the Project Source image"))?;
    for toolchain in &toolchains {
        if toolchain.target.as_deref().is_none_or(str::is_empty) {
            anyhow::bail!(
                "toolchain image {} has no /opt/<name> target",
                toolchain.digest
            );
        }
    }

    let mut resolved = Vec::with_capacity(images.len());
    // The target travels with the grant it was validated on: two toolchain
    // grants may legitimately share a digest, so a later digest lookup could
    // attach the wrong `/opt/<name>`.
    let mut image_refs: Vec<(ManagedImageRole, Option<String>, SandboxImageRef)> =
        Vec::with_capacity(images.len());
    for image in [base, workspace]
        .into_iter()
        .chain(toolchains.iter().copied())
    {
        if !image.path.starts_with("/images/blobs/") {
            anyhow::bail!(
                "authorization route '{}' is not an image blob path",
                image.path
            );
        }
        let grant = DownloadGrant {
            url: format!("{origin}{}", image.path),
            token: image.token.clone(),
        };
        let cached = cache
            .get_or_fetch(&image.digest, &grant)
            .await
            .with_context(|| format!("cannot prepare the {:?} image", image.role))?;
        resolved.push((image.role, image.digest.clone(), cached.path.clone()));
        image_refs.push((
            image.role,
            image.target.clone(),
            SandboxImageRef {
                digest: image.digest.clone(),
                source: cached.path.display().to_string(),
            },
        ));
    }

    // Group the fetched images by role. The target was validated above, so a
    // toolchain without one can only be a programming error in this function's
    // own contract, and it fails before any host resource exists.
    let mut base_ref = None;
    let mut workspace_ref = None;
    let mut toolchain_refs = Vec::new();
    for (role, target, image) in image_refs {
        match role {
            ManagedImageRole::Base => base_ref = Some(image),
            ManagedImageRole::Workspace => workspace_ref = Some(image),
            ManagedImageRole::Toolchain => {
                let Some(target) = target else {
                    anyhow::bail!("toolchain image {} has no /opt/<name> target", image.digest);
                };
                toolchain_refs.push(SandboxToolchainImage {
                    digest: image.digest,
                    source: image.source,
                    target,
                });
            }
        }
    }
    let Some(base_ref) = base_ref else {
        anyhow::bail!("a Managed Session requires a Base Runtime image");
    };
    let Some(workspace_ref) = workspace_ref else {
        anyhow::bail!("a Managed Session requires the Project Source image");
    };

    // One Agent-owned bounded workspace per create attempt. Validation above
    // means a refused grant never creates one.
    let workspace_dir = state_dir
        .join("managed")
        .join(uuid::Uuid::new_v4().to_string())
        .join("workspace");
    std::fs::create_dir_all(&workspace_dir).with_context(|| {
        format!(
            "cannot create the Managed workspace {}",
            workspace_dir.display()
        )
    })?;

    let policy = SandboxPolicy {
        version: SANDBOX_POLICY_VERSION,
        enabled: true,
        filesystem: Some(SandboxFilesystemPolicy {
            access: SandboxFilesystemAccess::default(),
            composition: Some(SandboxFilesystemComposition {
                base: base_ref,
                workspace: Some(SandboxWorkspace {
                    image: Some(workspace_ref),
                    write: workspace_dir.display().to_string(),
                }),
                toolchains: toolchain_refs,
            }),
        }),
        network: None,
        process: None,
        resource: None,
        syscall: None,
        enforcement: SandboxEnforcement::Required,
    };
    // Compile before returning: a malformed composition must fail here, not
    // after tmux has a Session to compensate.
    if let Err(error) = nession_sandbox::compile(&policy) {
        let _ = std::fs::remove_dir_all(&workspace_dir);
        return Err(anyhow::anyhow!("{error}"));
    }
    Ok(PreparedManagedSession {
        policy,
        workspace: workspace_dir,
        images: resolved,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ResolvedErofsStorage;
    use httptest::{matchers::*, Expectation, Server};
    use sha2::{Digest, Sha256};

    fn digest_for(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        format!("sha256:{:x}", hasher.finalize())
    }

    fn grant(role: ManagedImageRole, digest: &str, target: Option<&str>) -> ManagedImageGrant {
        ManagedImageGrant {
            role,
            digest: digest.to_string(),
            path: format!("/images/blobs/{digest}"),
            token: "scoped-token".to_string(),
            target: target.map(str::to_string),
        }
    }

    async fn cache(root: &Path) -> ErofsCache {
        crate::erofs_cache::open_resolved(
            &ResolvedErofsStorage {
                path: root.to_path_buf(),
                explicit: false,
            },
            "agent-test",
        )
        .await
        .unwrap()
    }

    fn ws_url(server: &Server) -> String {
        server
            .url("/ws")
            .to_string()
            .replacen("http://", "ws://", 1)
    }

    #[tokio::test]
    async fn managed_prepare_downloads_pins_and_builds_the_composition() {
        let dir = tempfile::tempdir().unwrap();
        let base_bytes = b"base runtime image".to_vec();
        let workspace_bytes = b"project source image".to_vec();
        let toolchain_bytes = b"rust toolchain image".to_vec();
        let base_digest = digest_for(&base_bytes);
        let workspace_digest = digest_for(&workspace_bytes);
        let toolchain_digest = digest_for(&toolchain_bytes);
        let server = Server::run();
        for (digest, bytes) in [
            (&base_digest, &base_bytes),
            (&workspace_digest, &workspace_bytes),
            (&toolchain_digest, &toolchain_bytes),
        ] {
            server.expect(
                Expectation::matching(request::method_path(
                    "GET",
                    format!("/images/blobs/{digest}"),
                ))
                .times(1)
                .respond_with(
                    httptest::http::Response::builder()
                        .status(200)
                        .body(bytes.clone())
                        .unwrap(),
                ),
            );
        }
        let cache = cache(&dir.path().join("cache")).await;
        let images = vec![
            grant(ManagedImageRole::Base, &base_digest, None),
            grant(ManagedImageRole::Workspace, &workspace_digest, None),
            grant(
                ManagedImageRole::Toolchain,
                &toolchain_digest,
                Some("/opt/rust"),
            ),
        ];
        let state = dir.path().join("sandbox-state");
        std::fs::create_dir_all(&state).unwrap();

        let first = prepare(&cache, &images, &ws_url(&server), &state)
            .await
            .unwrap();
        assert!(first.workspace.is_dir());
        assert!(first.workspace.starts_with(&state));
        let filesystem = first.policy.filesystem.as_ref().unwrap();
        assert!(filesystem.access.read.is_empty() && filesystem.access.write.is_empty());
        let composition = filesystem.composition.as_ref().unwrap();
        assert_eq!(composition.base.digest, base_digest);
        assert!(composition
            .base
            .source
            .starts_with(cache.root().to_string_lossy().as_ref()));
        assert_eq!(
            composition
                .workspace
                .as_ref()
                .unwrap()
                .image
                .as_ref()
                .unwrap()
                .digest,
            workspace_digest
        );
        assert_eq!(
            composition.workspace.as_ref().unwrap().write,
            first.workspace.display().to_string()
        );
        assert_eq!(composition.toolchains.len(), 1);
        assert_eq!(composition.toolchains[0].target, "/opt/rust");
        nession_sandbox::compile(&first.policy).expect("the prepared policy compiles");

        // A second attempt (same image set) reuses the warm cache: no new
        // transfer, and its workspace is its own directory.
        let transferred = cache.bytes_transferred();
        let fetches = cache.fetch_count();
        let second = prepare(&cache, &images, &ws_url(&server), &state)
            .await
            .unwrap();
        assert_eq!(cache.bytes_transferred(), transferred);
        assert_eq!(cache.fetch_count(), fetches);
        assert_ne!(first.workspace, second.workspace);
        assert!(second.workspace.is_dir());
    }

    #[tokio::test]
    async fn a_missing_project_source_image_is_refused_before_any_workspace_exists() {
        let dir = tempfile::tempdir().unwrap();
        let cache = cache(&dir.path().join("cache")).await;
        let state = dir.path().join("sandbox-state");
        std::fs::create_dir_all(&state).unwrap();
        let images = vec![grant(ManagedImageRole::Base, &digest_for(b"base"), None)];
        let error = prepare(&cache, &images, "ws://127.0.0.1:1/ws", &state)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("Project Source image"));
        assert!(!state.join("managed").exists());
    }

    #[tokio::test]
    async fn a_digest_mismatch_fails_and_creates_no_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let expected = digest_for(b"expected");
        let server = Server::run();
        server.expect(
            Expectation::matching(request::method_path(
                "GET",
                format!("/images/blobs/{expected}"),
            ))
            .times(1)
            .respond_with(
                httptest::http::Response::builder()
                    .status(200)
                    .body(b"wrong bytes".to_vec())
                    .unwrap(),
            ),
        );
        let cache = cache(&dir.path().join("cache")).await;
        let state = dir.path().join("sandbox-state");
        std::fs::create_dir_all(&state).unwrap();
        let images = vec![
            grant(ManagedImageRole::Base, &expected, None),
            grant(ManagedImageRole::Workspace, &digest_for(b"workspace"), None),
        ];
        let error = prepare(&cache, &images, &ws_url(&server), &state)
            .await
            .unwrap_err();
        assert!(!error.to_string().is_empty());
        assert!(!state.join("managed").exists());
    }

    #[tokio::test]
    async fn toolchain_targets_stay_with_their_own_grant_when_digests_match() {
        let dir = tempfile::tempdir().unwrap();
        let base_bytes = b"base".to_vec();
        let workspace_bytes = b"workspace".to_vec();
        let shared_bytes = b"one toolchain image".to_vec();
        let base_digest = digest_for(&base_bytes);
        let workspace_digest = digest_for(&workspace_bytes);
        let shared_digest = digest_for(&shared_bytes);
        let server = Server::run();
        for (digest, bytes) in [
            (&base_digest, &base_bytes),
            (&workspace_digest, &workspace_bytes),
            // One image, two mounts: the cache serves the second grant without
            // a second transfer.
            (&shared_digest, &shared_bytes),
        ] {
            server.expect(
                Expectation::matching(request::method_path(
                    "GET",
                    format!("/images/blobs/{digest}"),
                ))
                .times(1)
                .respond_with(
                    httptest::http::Response::builder()
                        .status(200)
                        .body(bytes.clone())
                        .unwrap(),
                ),
            );
        }
        let cache = cache(&dir.path().join("cache")).await;
        let state = dir.path().join("sandbox-state");
        std::fs::create_dir_all(&state).unwrap();
        let images = vec![
            grant(ManagedImageRole::Base, &base_digest, None),
            grant(ManagedImageRole::Workspace, &workspace_digest, None),
            grant(ManagedImageRole::Toolchain, &shared_digest, Some("/opt/a")),
            grant(ManagedImageRole::Toolchain, &shared_digest, Some("/opt/b")),
        ];

        let prepared = prepare(&cache, &images, &ws_url(&server), &state)
            .await
            .unwrap();
        let composition = prepared
            .policy
            .filesystem
            .as_ref()
            .unwrap()
            .composition
            .as_ref()
            .unwrap();
        let targets: Vec<&str> = composition
            .toolchains
            .iter()
            .map(|toolchain| toolchain.target.as_str())
            .collect();
        assert_eq!(targets, vec!["/opt/a", "/opt/b"]);
    }

    #[tokio::test]
    async fn duplicate_base_images_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let cache = cache(&dir.path().join("cache")).await;
        let state = dir.path().join("sandbox-state");
        std::fs::create_dir_all(&state).unwrap();
        let images = vec![
            grant(ManagedImageRole::Base, &digest_for(b"a"), None),
            grant(ManagedImageRole::Base, &digest_for(b"b"), None),
            grant(ManagedImageRole::Workspace, &digest_for(b"c"), None),
        ];
        let error = prepare(&cache, &images, "ws://127.0.0.1:1/ws", &state)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("more than one Base Runtime"));
    }
}
