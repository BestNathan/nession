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
    SandboxFilesystemPolicy, SandboxImageEnvDefault, SandboxImageRef, SandboxPolicy,
    SandboxToolchainImage, SandboxWorkspace, SANDBOX_POLICY_VERSION,
};
use nession_protocol::contracts::session::v1::{ManagedImageGrant, ManagedImageRole};
use std::path::{Path, PathBuf};

use crate::erofs_cache::{resolve_grant_image, ErofsCache, ResolvedManifestBinding};

/// The sandbox path the initial Pane starts in. The composed root exposes the
/// Project image and writable overlay here; the host has no such directory.
pub const MANAGED_WORKING_DIR: &str = "/workspace";

/// One resolved image and the composition fields it contributes (#3500).
struct ResolvedImageRef {
    role: ManagedImageRole,
    /// The actual toolchain target, after the request override or the
    /// Manifest's `io.nession.mount.default` proposal.
    target: Option<String>,
    image: SandboxImageRef,
    env: Vec<SandboxImageEnvDefault>,
    path_prepend: Option<String>,
}

/// One prepared Managed Session, before tmux creates anything.
#[derive(Debug, Clone)]
pub struct PreparedManagedSession {
    pub policy: SandboxPolicy,
    /// The Agent-owned host directory bound at `/workspace`.
    pub workspace: PathBuf,
    /// `(role, digest, resolved cache path)` for diagnostics and tests. The
    /// digest is the physical EROFS layer the mount manager keys on.
    pub images: Vec<(ManagedImageRole, String, PathBuf)>,
    /// The final resolved Manifest identity per Manifest-aware grant (#3499).
    /// Empty for a legacy digest-addressed grant set.
    pub manifests: Vec<ResolvedManifestBinding>,
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
    server_auth_token: &str,
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
    // A toolchain's target may be omitted: the resolved Manifest's
    // io.nession.mount.default proposes it, and an explicit request target is
    // the user/Session override (#3500). It is resolved after the Config is
    // fetched, so the default is not guessed here.

    let mut resolved = Vec::with_capacity(images.len());
    let mut manifests = Vec::new();
    // The target travels with the grant it was validated on: two toolchain
    // grants may legitimately share a digest, so a later digest lookup could
    // attach the wrong `/opt/<name>`.
    let mut image_refs: Vec<ResolvedImageRef> = Vec::with_capacity(images.len());
    for image in [base, workspace]
        .into_iter()
        .chain(toolchains.iter().copied())
    {
        let resolved_image = resolve_grant_image(cache, image, &origin, server_auth_token)
            .await
            .with_context(|| format!("cannot prepare the {:?} image", image.role))?;
        if let Some(manifest_digest) = resolved_image.manifest_digest.clone() {
            manifests.push(ResolvedManifestBinding {
                role: image.role,
                manifest_digest,
                layer_digest: resolved_image.layer_digest.clone(),
            });
        }
        let target = match image.role {
            ManagedImageRole::Toolchain => Some(
                crate::sandbox_images::toolchain_target(image.target.as_deref(), &resolved_image)
                    .with_context(|| format!("cannot resolve the {:?} image target", image.role))?,
            ),
            ManagedImageRole::Base | ManagedImageRole::Workspace => None,
        };
        let env = crate::sandbox_images::image_env_defaults(&resolved_image);
        let path_prepend = if image.role == ManagedImageRole::Toolchain {
            crate::sandbox_images::image_path_prepend(&resolved_image)
        } else {
            None
        };
        resolved.push((
            image.role,
            resolved_image.layer_digest.clone(),
            resolved_image.layer_path.clone(),
        ));
        image_refs.push(ResolvedImageRef {
            role: image.role,
            target,
            image: SandboxImageRef {
                // The composition carries the physical EROFS identity so the
                // mount manager shares one mount across Manifests.
                digest: resolved_image.layer_digest,
                source: resolved_image.layer_path.display().to_string(),
            },
            env,
            path_prepend,
        });
    }

    // Group the fetched images by role.
    let mut base_ref = None;
    let mut base_env = Vec::new();
    let mut workspace_ref = None;
    let mut toolchain_refs = Vec::new();
    for resolved_image in image_refs {
        match resolved_image.role {
            ManagedImageRole::Base => {
                base_env = resolved_image.env;
                base_ref = Some(resolved_image.image);
            }
            ManagedImageRole::Workspace => workspace_ref = Some(resolved_image.image),
            ManagedImageRole::Toolchain => {
                let Some(target) = resolved_image.target else {
                    anyhow::bail!(
                        "toolchain image {} has no /opt/<name> target",
                        resolved_image.image.digest
                    );
                };
                toolchain_refs.push(SandboxToolchainImage {
                    digest: resolved_image.image.digest,
                    source: resolved_image.image.source,
                    target,
                    env: resolved_image.env,
                    path_prepend: resolved_image.path_prepend,
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
    // The writable Overlay storage is durable workspace state, initialized by
    // its Agent owner before any host mount (#3582). A filesystem that cannot
    // hold it fails the create; there is no per-execution fallback.
    #[cfg(target_os = "linux")]
    if let Err(error) = nession_sandbox::mount::overlay::storage::initialize(&workspace_dir) {
        let _ = std::fs::remove_dir_all(&workspace_dir);
        return Err(error.context(format!(
            "cannot initialize the Managed workspace Overlay storage {}",
            workspace_dir.display()
        )));
    }

    let policy = SandboxPolicy {
        version: SANDBOX_POLICY_VERSION,
        enabled: true,
        filesystem: Some(SandboxFilesystemPolicy {
            access: SandboxFilesystemAccess::default(),
            rootfs: None,
            mounts: Vec::new(),
            workspace: None,
            composition: Some(SandboxFilesystemComposition {
                base: base_ref,
                workspace: Some(SandboxWorkspace {
                    image: Some(workspace_ref),
                    write: workspace_dir.display().to_string(),
                    ownership:
                        nession_protocol::contracts::sandbox::v1::SandboxWorkspaceOwnership::Agent,
                }),
                toolchains: toolchain_refs,
                base_env,
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
        manifests,
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

    /// The Server Token the Agent presents on the image-blob route (#3440).
    /// The blob origin in these tests is `httptest`, which does not check it.
    const SERVER_AUTH_TOKEN: &str = "server-auth-token";

    fn grant(role: ManagedImageRole, digest: &str, target: Option<&str>) -> ManagedImageGrant {
        ManagedImageGrant {
            role,
            digest: digest.to_string(),
            path: format!("/images/blobs/{digest}"),
            target: target.map(str::to_string),
            objects: Vec::new(),
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

        let first = prepare(&cache, &images, &ws_url(&server), SERVER_AUTH_TOKEN, &state)
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
        let second = prepare(&cache, &images, &ws_url(&server), SERVER_AUTH_TOKEN, &state)
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
        let error = prepare(
            &cache,
            &images,
            "ws://127.0.0.1:1/ws",
            SERVER_AUTH_TOKEN,
            &state,
        )
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
        let error = prepare(&cache, &images, &ws_url(&server), SERVER_AUTH_TOKEN, &state)
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

        let prepared = prepare(&cache, &images, &ws_url(&server), SERVER_AUTH_TOKEN, &state)
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
        let error = prepare(
            &cache,
            &images,
            "ws://127.0.0.1:1/ws",
            SERVER_AUTH_TOKEN,
            &state,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("more than one Base Runtime"));
    }

    struct ManifestFixture {
        manifest: Vec<u8>,
        config: Vec<u8>,
        layer: Vec<u8>,
    }

    fn manifest_fixture(payload: &[u8], env: &str) -> ManifestFixture {
        manifest_fixture_with(payload, env, None)
    }

    fn manifest_fixture_with(
        payload: &[u8],
        env: &str,
        annotations: Option<std::collections::BTreeMap<String, String>>,
    ) -> ManifestFixture {
        use nession_erofs::oci::annotation::{
            MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_MANIFEST,
        };
        use nession_erofs::oci::config::{ImageConfig, RootFs, RuntimeConfig};
        use nession_erofs::oci::descriptor::Descriptor;
        use nession_erofs::oci::manifest::Manifest;
        use nession_erofs::oci::{to_bytes, RawDocument};
        use serde_json::Map;

        let layer = payload.to_vec();
        let layer_digest = digest_for(&layer);
        let config = ImageConfig {
            created: None,
            author: None,
            architecture: "amd64".to_string(),
            os: "linux".to_string(),
            os_version: None,
            os_features: Some(vec!["erofs".to_string()]),
            variant: None,
            config: RuntimeConfig {
                env: Some(vec![format!("K={env}")]),
                ..RuntimeConfig::default()
            },
            rootfs: RootFs {
                fs_type: "layers".to_string(),
                diff_ids: vec![layer_digest.clone()],
                extra: Map::new(),
            },
            history: Vec::new(),
            extra: Map::new(),
        };
        let config = to_bytes(&config).unwrap();
        let config_document = RawDocument::from_bytes(config.clone());
        let manifest = Manifest {
            schema_version: 2,
            media_type: Some(MEDIA_TYPE_MANIFEST.to_string()),
            config: Descriptor {
                media_type: MEDIA_TYPE_CONFIG.to_string(),
                digest: config_document.digest().to_string(),
                size: config_document.size().unwrap(),
                urls: None,
                annotations: None,
                platform: None,
                artifact_type: None,
                data: None,
                extra: Map::new(),
            },
            layers: vec![Descriptor {
                media_type: MEDIA_TYPE_EROFS.to_string(),
                digest: layer_digest,
                size: layer.len() as u64,
                urls: None,
                annotations: None,
                platform: None,
                artifact_type: None,
                data: None,
                extra: Map::new(),
            }],
            subject: None,
            artifact_type: None,
            annotations,
            extra: Map::new(),
        };
        ManifestFixture {
            manifest: to_bytes(&manifest).unwrap(),
            config,
            layer,
        }
    }

    fn manifest_grant(
        role: ManagedImageRole,
        fixture: &ManifestFixture,
        target: Option<&str>,
    ) -> ManagedImageGrant {
        use nession_erofs::oci::annotation::{
            MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_MANIFEST,
        };
        let manifest_digest = digest_for(&fixture.manifest);
        let objects = vec![
            nession_protocol::contracts::session::v1::ManagedImageObjectGrant {
                digest: manifest_digest.clone(),
                media_type: MEDIA_TYPE_MANIFEST.to_string(),
                size_bytes: fixture.manifest.len() as u64,
                path: format!("/images/blobs/{manifest_digest}"),
            },
            nession_protocol::contracts::session::v1::ManagedImageObjectGrant {
                digest: digest_for(&fixture.config),
                media_type: MEDIA_TYPE_CONFIG.to_string(),
                size_bytes: fixture.config.len() as u64,
                path: format!("/images/blobs/{}", digest_for(&fixture.config)),
            },
            nession_protocol::contracts::session::v1::ManagedImageObjectGrant {
                digest: digest_for(&fixture.layer),
                media_type: MEDIA_TYPE_EROFS.to_string(),
                size_bytes: fixture.layer.len() as u64,
                path: format!("/images/blobs/{}", digest_for(&fixture.layer)),
            },
        ];
        ManagedImageGrant {
            role,
            digest: manifest_digest.clone(),
            path: format!("/images/blobs/{manifest_digest}"),
            target: target.map(str::to_string),
            objects,
        }
    }

    #[tokio::test]
    async fn a_manifest_grant_mounts_the_layer_identity_and_shares_one_payload() {
        let dir = tempfile::tempdir().unwrap();
        let payload = b"one shared managed payload";
        let base_fixture = manifest_fixture(payload, "base");
        let workspace_fixture = manifest_fixture(payload, "workspace");
        let server = Server::run();
        for fixture in [&base_fixture, &workspace_fixture] {
            for (bytes, digest) in [
                (&fixture.manifest, digest_for(&fixture.manifest)),
                (&fixture.config, digest_for(&fixture.config)),
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
        }
        let layer_digest = digest_for(&base_fixture.layer);
        server.expect(
            Expectation::matching(request::method_path(
                "GET",
                format!("/images/blobs/{layer_digest}"),
            ))
            .times(1)
            .respond_with(
                httptest::http::Response::builder()
                    .status(200)
                    .body(base_fixture.layer.clone())
                    .unwrap(),
            ),
        );
        let cache = cache(&dir.path().join("cache")).await;
        let state = dir.path().join("sandbox-state");
        std::fs::create_dir_all(&state).unwrap();
        let images = vec![
            manifest_grant(ManagedImageRole::Base, &base_fixture, None),
            manifest_grant(ManagedImageRole::Workspace, &workspace_fixture, None),
        ];
        let prepared = prepare(&cache, &images, &ws_url(&server), SERVER_AUTH_TOKEN, &state)
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
        assert_eq!(
            composition.base.digest, layer_digest,
            "the mount identity is the EROFS layer, not the Manifest"
        );
        assert_eq!(
            composition
                .workspace
                .as_ref()
                .unwrap()
                .image
                .as_ref()
                .unwrap()
                .digest,
            layer_digest
        );
        assert_eq!(prepared.manifests.len(), 2);
        let manifest_digests: Vec<&str> = prepared
            .manifests
            .iter()
            .map(|binding| binding.manifest_digest.as_str())
            .collect();
        assert!(manifest_digests.contains(&digest_for(&base_fixture.manifest).as_str()));
        assert!(manifest_digests.contains(&digest_for(&workspace_fixture.manifest).as_str()));
        assert_eq!(
            cache.fetch_count(),
            5,
            "two Manifests/Configs and one payload"
        );
        assert_eq!(
            std::fs::read_dir(cache.root().join("sha256"))
                .unwrap()
                .count(),
            5,
            "the shared payload produced one physical file"
        );

        // A second prepare reuses every verified object.
        let transfers = cache.bytes_transferred();
        let fetches = cache.fetch_count();
        prepare(&cache, &images, &ws_url(&server), SERVER_AUTH_TOKEN, &state)
            .await
            .unwrap();
        assert_eq!(cache.bytes_transferred(), transfers);
        assert_eq!(cache.fetch_count(), fetches);
    }

    fn expect_object(server: &Server, bytes: &[u8]) {
        let digest = digest_for(bytes);
        server.expect(
            Expectation::matching(request::method_path(
                "GET",
                format!("/images/blobs/{digest}"),
            ))
            .times(1)
            .respond_with(
                httptest::http::Response::builder()
                    .status(200)
                    .body(bytes.to_vec())
                    .unwrap(),
            ),
        );
    }

    fn tool_annotations(
        mount_default: &str,
        prepend: &str,
    ) -> std::collections::BTreeMap<String, String> {
        [
            (
                nession_erofs::oci::ANNOTATION_KIND.to_string(),
                "tool".to_string(),
            ),
            (
                nession_erofs::oci::ANNOTATION_MOUNT_DEFAULT.to_string(),
                mount_default.to_string(),
            ),
            (
                nession_erofs::oci::ANNOTATION_PATH_PREPEND.to_string(),
                prepend.to_string(),
            ),
        ]
        .into_iter()
        .collect()
    }

    #[tokio::test]
    async fn mount_default_and_override_rebase_the_toolchain_prepend_and_reach_the_composition() {
        let dir = tempfile::tempdir().unwrap();
        let base_fixture = manifest_fixture(b"base payload", "base");
        let workspace_fixture = manifest_fixture(b"workspace payload", "workspace");
        // Two distinct Manifests over one EROFS layer: different Config Env and
        // different advisory targets, one physical payload identity.
        let shared_layer = b"one shared toolchain payload";
        let default_fixture = manifest_fixture_with(
            shared_layer,
            "default-tool",
            Some(tool_annotations("/opt/go", "bin")),
        );
        let override_fixture = manifest_fixture_with(
            shared_layer,
            "override-tool",
            Some(tool_annotations("/opt/go-tools", "bin")),
        );
        assert_ne!(
            digest_for(&default_fixture.manifest),
            digest_for(&override_fixture.manifest)
        );
        let server = Server::run();
        for fixture in [
            &base_fixture,
            &workspace_fixture,
            &default_fixture,
            &override_fixture,
        ] {
            expect_object(&server, &fixture.manifest);
            expect_object(&server, &fixture.config);
        }
        expect_object(&server, &base_fixture.layer);
        expect_object(&server, &workspace_fixture.layer);
        expect_object(&server, shared_layer);
        let cache = cache(&dir.path().join("cache")).await;
        let state = dir.path().join("sandbox-state");
        std::fs::create_dir_all(&state).unwrap();
        let base_images = vec![
            manifest_grant(ManagedImageRole::Base, &base_fixture, None),
            manifest_grant(ManagedImageRole::Workspace, &workspace_fixture, None),
        ];

        let mut default_images = base_images.clone();
        default_images.push(manifest_grant(
            ManagedImageRole::Toolchain,
            &default_fixture,
            None,
        ));
        let prepared = prepare(
            &cache,
            &default_images,
            &ws_url(&server),
            SERVER_AUTH_TOKEN,
            &state,
        )
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
        let toolchain = &composition.toolchains[0];
        assert_eq!(toolchain.target, "/opt/go", "mount.default proposes");
        assert_eq!(toolchain.path_prepend.as_deref(), Some("bin"));
        assert_eq!(toolchain.digest, digest_for(shared_layer));
        assert_eq!(
            toolchain.env,
            vec![
                nession_protocol::contracts::sandbox::v1::SandboxImageEnvDefault {
                    name: "K".to_string(),
                    value: "default-tool".to_string(),
                }
            ],
            "the Manifest's own Config Env is carried, not the other Manifest's"
        );
        assert_eq!(
            composition.base_env,
            vec![
                nession_protocol::contracts::sandbox::v1::SandboxImageEnvDefault {
                    name: "K".to_string(),
                    value: "base".to_string(),
                }
            ]
        );
        // The Sandbox resolves the relative prepend against the actual target.
        let compiled = nession_sandbox::compile(&prepared.policy).unwrap();
        let environment = compiled.filesystem.expect("filesystem").image_environment();
        assert_eq!(environment.path_prepend, vec!["/opt/go/bin".to_string()]);
        assert_eq!(
            environment.defaults,
            vec![("K".to_string(), "default-tool".to_string())],
            "the tool default sits below the base default's key"
        );

        let mut override_images = base_images;
        override_images.push(manifest_grant(
            ManagedImageRole::Toolchain,
            &override_fixture,
            Some("/opt/go-tools"),
        ));
        let overridden = prepare(
            &cache,
            &override_images,
            &ws_url(&server),
            SERVER_AUTH_TOKEN,
            &state,
        )
        .await
        .unwrap();
        let composition = overridden
            .policy
            .filesystem
            .as_ref()
            .unwrap()
            .composition
            .as_ref()
            .unwrap();
        let toolchain = &composition.toolchains[0];
        assert_eq!(
            toolchain.target, "/opt/go-tools",
            "an explicit target overrides the proposal"
        );
        assert_eq!(toolchain.digest, digest_for(shared_layer));
        assert_eq!(
            overridden.manifests[2].manifest_digest,
            digest_for(&override_fixture.manifest)
        );
        let compiled = nession_sandbox::compile(&overridden.policy).unwrap();
        let environment = compiled.filesystem.expect("filesystem").image_environment();
        assert_eq!(
            environment.path_prepend,
            vec!["/opt/go-tools/bin".to_string()],
            "path.prepend follows the actual target, not the annotation proposal"
        );
        // The EROFS identity and its one physical cache file are unchanged.
        assert_eq!(
            toolchain.digest,
            digest_for(&default_fixture.layer),
            "both Manifests share one EROFS Blob identity"
        );
        assert_eq!(
            cache.fetch_count(),
            11,
            "4 Manifests, 4 Configs and 3 distinct payloads"
        );
    }

    #[tokio::test]
    async fn a_toolchain_without_a_target_or_mount_default_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let base_fixture = manifest_fixture(b"base payload", "base");
        let workspace_fixture = manifest_fixture(b"workspace payload", "workspace");
        let tool_fixture = manifest_fixture(b"tool payload", "tool");
        let server = Server::run();
        for fixture in [&base_fixture, &workspace_fixture, &tool_fixture] {
            expect_object(&server, &fixture.manifest);
            expect_object(&server, &fixture.config);
        }
        expect_object(&server, &base_fixture.layer);
        expect_object(&server, &workspace_fixture.layer);
        expect_object(&server, &tool_fixture.layer);
        let cache = cache(&dir.path().join("cache")).await;
        let state = dir.path().join("sandbox-state");
        std::fs::create_dir_all(&state).unwrap();
        let images = vec![
            manifest_grant(ManagedImageRole::Base, &base_fixture, None),
            manifest_grant(ManagedImageRole::Workspace, &workspace_fixture, None),
            manifest_grant(ManagedImageRole::Toolchain, &tool_fixture, None),
        ];
        let error = prepare(&cache, &images, &ws_url(&server), SERVER_AUTH_TOKEN, &state)
            .await
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("io.nession.mount.default"),
            "the refusal must name the missing proposal: {error:#}"
        );
        assert!(
            !state.join("managed").exists(),
            "no workspace may be allocated for a refused target"
        );
    }

    #[tokio::test]
    async fn a_protected_image_environment_variable_fails_before_any_launch() {
        let dir = tempfile::tempdir().unwrap();
        let base_fixture = manifest_fixture(b"base payload", "base");
        let workspace_fixture = manifest_fixture(b"workspace payload", "workspace");
        // Config Env must never set PATH; the mounted executable directory is
        // the only sanctioned image PATH contribution.
        let tool_fixture = manifest_fixture_with(
            b"tool payload",
            "x",
            Some(tool_annotations("/opt/go", "bin")),
        );
        let mut tool_fixture = tool_fixture;
        // Rewrite the Config with PATH while keeping the same layer.
        let mut config: nession_erofs::oci::ImageConfig =
            serde_json::from_slice(&tool_fixture.config).unwrap();
        config.config.env = Some(vec!["PATH=/tools/bin".to_string()]);
        tool_fixture.config = serde_json::to_vec(&config).unwrap();
        // Rebuild the Manifest because the Config digest changed.
        let mut manifest: nession_erofs::oci::Manifest =
            serde_json::from_slice(&tool_fixture.manifest).unwrap();
        let config_document =
            nession_erofs::oci::RawDocument::from_bytes(tool_fixture.config.clone());
        manifest.config.digest = config_document.digest().to_string();
        manifest.config.size = config_document.size().unwrap();
        tool_fixture.manifest = nession_erofs::oci::to_bytes(&manifest).unwrap();

        let server = Server::run();
        for fixture in [&base_fixture, &workspace_fixture, &tool_fixture] {
            expect_object(&server, &fixture.manifest);
            expect_object(&server, &fixture.config);
        }
        expect_object(&server, &base_fixture.layer);
        expect_object(&server, &workspace_fixture.layer);
        expect_object(&server, &tool_fixture.layer);
        let cache = cache(&dir.path().join("cache")).await;
        let state = dir.path().join("sandbox-state");
        std::fs::create_dir_all(&state).unwrap();
        let images = vec![
            manifest_grant(ManagedImageRole::Base, &base_fixture, None),
            manifest_grant(ManagedImageRole::Workspace, &workspace_fixture, None),
            manifest_grant(ManagedImageRole::Toolchain, &tool_fixture, None),
        ];
        let error = prepare(&cache, &images, &ws_url(&server), SERVER_AUTH_TOKEN, &state)
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("PATH"),
            "the refusal must name the protected variable: {error}"
        );
    }
}
