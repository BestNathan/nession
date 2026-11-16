//! #3696 SC-03: a flattened Compose result is transferred to an Agent's
//! verified cache and mounted read-only without any source Image bytes.
//!
//! This is the real Linux proof lane. It builds two raw EROFS source Images
//! with the pinned `mkfs.erofs`, composes them with the pinned `fsck.erofs`
//! extraction + `mkfs.erofs` packaging path, deletes every source payload and
//! source catalog object, serves only the result Manifest/Config/layer over
//! HTTP, fetches them through the Agent cache, and mounts the verified cached
//! layer with `erofsfuse`. Executed by the staging Acceptance Case, not by the
//! ordinary unit suite.
#![cfg(all(target_os = "linux", feature = "cache", feature = "mount"))]

use std::path::Path;
use std::sync::Arc;

use httptest::{matchers::request, Expectation, Server};
use nession_erofs::build::compose::{
    ComposeBuildRequest, ComposeSourceInput, ErofsComposer, ProcessErofsExtractor,
};
use nession_erofs::cache::fetch::{fetch_manifest_image, ImageObjectGrant};
use nession_erofs::cache::ErofsCache;
use nession_erofs::oci::annotation::MEDIA_TYPE_EROFS;
use nession_erofs::oci::config::{ImageConfig, RootFs, RuntimeConfig};
use nession_erofs::oci::descriptor::{Descriptor, Platform};
use nession_erofs::{
    host_platform, image_documents_with_runtime, BlobStore, MkfsRunner, NoopObserver, Packaging,
    ProcessControl, ProcessMkfsRunner, ResumePoint,
};
use serde_json::Map;

const ROUTE_PREFIX: &str = "/images/blobs/";
const TOKEN: &str = "server-token";

fn mode(path: &Path, value: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(value))
        .expect("set fixture mode");
}

fn config() -> ImageConfig {
    ImageConfig {
        created: None,
        author: None,
        architecture: "amd64".to_string(),
        os: "linux".to_string(),
        os_version: None,
        os_features: Some(vec!["erofs".to_string()]),
        variant: None,
        config: RuntimeConfig {
            env: Some(vec!["PATH=/usr/bin".to_string()]),
            ..RuntimeConfig::default()
        },
        rootfs: RootFs {
            fs_type: "layers".to_string(),
            diff_ids: vec![
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .to_string(),
            ],
            extra: Map::new(),
        },
        history: Vec::new(),
        extra: Map::new(),
    }
}

fn source(image: &Path, destination: &str) -> ComposeSourceInput {
    let digest = nession_erofs::file_digest(image).expect("fixture digest");
    let size = std::fs::metadata(image).expect("fixture metadata").len();
    ComposeSourceInput {
        path: image.to_path_buf(),
        layer: Descriptor {
            media_type: MEDIA_TYPE_EROFS.to_string(),
            digest,
            size,
            urls: None,
            annotations: None,
            platform: None,
            artifact_type: None,
            data: None,
            extra: Map::new(),
        },
        repository: "nession/test".to_string(),
        reference: "latest".to_string(),
        manifest_digest: format!("sha256:{}", "b".repeat(64)),
        destination: destination.to_string(),
        platform: Platform {
            architecture: "amd64".to_string(),
            os: "linux".to_string(),
            os_features: Some(vec!["erofs".to_string()]),
            ..Platform::default()
        },
        config: config(),
    }
}

#[tokio::test]
#[ignore = "requires erofs-utils and /dev/fuse; executed by the #3696 acceptance Case"]
async fn a_compose_result_transfers_to_the_agent_cache_and_mounts_without_sources() {
    let root = tempfile::tempdir().unwrap();
    let base_dir = root.path().join("base-src");
    let tool_dir = root.path().join("tool-src");
    std::fs::create_dir_all(base_dir.join("usr/bin")).unwrap();
    std::fs::create_dir_all(tool_dir.join("bin")).unwrap();
    std::fs::write(base_dir.join("usr/bin/sh"), b"#!/bin/sh\n").unwrap();
    std::fs::write(tool_dir.join("bin/tool"), b"tool-binary\n").unwrap();
    mode(&base_dir.join("usr/bin/sh"), 0o755);
    mode(&tool_dir.join("bin/tool"), 0o755);

    let packaging = Packaging::default();
    let mkfs = Arc::new(ProcessMkfsRunner::default());
    let mut sources = Vec::new();
    for (name, dir, destination) in [
        ("base.erofs", &base_dir, ""),
        ("tool.erofs", &tool_dir, "/opt/tool"),
    ] {
        let image = root.path().join(name);
        mkfs.run(
            &nession_erofs::build::mkfs_command(&image, dir, &packaging),
            &ProcessControl::new(),
        )
        .unwrap();
        sources.push(source(&image, destination));
    }

    let source_paths = sources
        .iter()
        .map(|source| source.path.clone())
        .collect::<Vec<_>>();
    let store = BlobStore::new(root.path().join("server-blobs")).unwrap();
    let composer = ErofsComposer::new(
        Arc::new(ProcessErofsExtractor::default()),
        mkfs,
        store.clone(),
        root.path().join("work"),
    )
    .unwrap();
    let control = ProcessControl::new();
    let composed = composer
        .run(ComposeBuildRequest {
            build_dir: &root.path().join("build"),
            sources: &sources,
            packaging: &packaging,
            resume: ResumePoint::Source,
            control: &control,
            observer: &NoopObserver,
        })
        .unwrap();

    // Every source payload and source identity is gone before the result is
    // offered to the Agent. The result must remain complete and mountable.
    for path in &source_paths {
        std::fs::remove_file(path).unwrap();
    }
    for source in &sources {
        store.remove(&source.layer.digest).unwrap();
    }

    let layer = Descriptor {
        media_type: MEDIA_TYPE_EROFS.to_string(),
        digest: composed.built.blob.digest.clone(),
        size: composed.built.blob.size_bytes,
        urls: None,
        annotations: None,
        platform: None,
        artifact_type: None,
        data: None,
        extra: Map::new(),
    };
    let annotations = composed
        .built
        .compose
        .as_ref()
        .map(|compose| compose.runtime.annotations.clone())
        .unwrap_or_default();
    let (config_document, manifest_document) = image_documents_with_runtime(
        &layer,
        &host_platform(),
        &[],
        &RuntimeConfig::default(),
        &annotations,
    )
    .unwrap();

    let server = Server::run();
    let mut served = Vec::new();
    for (path, bytes) in [
        (
            format!("{ROUTE_PREFIX}{}", manifest_document.digest()),
            manifest_document.bytes().to_vec(),
        ),
        (
            format!("{ROUTE_PREFIX}{}", config_document.digest()),
            config_document.bytes().to_vec(),
        ),
        (
            format!("{ROUTE_PREFIX}{}", layer.digest),
            std::fs::read(&composed.built.blob.path).unwrap(),
        ),
    ] {
        server.expect(
            Expectation::matching(request::method_path("GET", path.clone()))
                .times(1)
                .respond_with(
                    httptest::http::Response::builder()
                        .status(200)
                        .body(bytes)
                        .unwrap(),
                ),
        );
        served.push(path);
    }

    let cache = ErofsCache::open(&root.path().join("agent-cache"), "agent-1", false)
        .await
        .unwrap();
    let grants = vec![
        ImageObjectGrant {
            digest: manifest_document.digest().to_string(),
            media_type: nession_erofs::oci::MEDIA_TYPE_MANIFEST.to_string(),
            size_bytes: manifest_document.size().unwrap(),
            path: served[0].clone(),
        },
        ImageObjectGrant {
            digest: config_document.digest().to_string(),
            media_type: nession_erofs::oci::MEDIA_TYPE_CONFIG.to_string(),
            size_bytes: config_document.size().unwrap(),
            path: served[1].clone(),
        },
        ImageObjectGrant {
            digest: layer.digest.clone(),
            media_type: MEDIA_TYPE_EROFS.to_string(),
            size_bytes: layer.size,
            path: served[2].clone(),
        },
    ];
    let origin = server
        .url("/")
        .to_string()
        .trim_end_matches('/')
        .to_string();
    let fetched = fetch_manifest_image(&cache, &grants, &origin, TOKEN, ROUTE_PREFIX)
        .await
        .unwrap();
    assert_eq!(fetched.manifest_digest, manifest_document.digest());
    assert_eq!(fetched.layer.digest, layer.digest);
    // The cache holds exactly the result objects, never a source descriptor.
    for source in &sources {
        assert!(!cache.blob_path(&source.layer.digest).unwrap().is_file());
    }

    let mountpoint = root.path().join("mount");
    let settings = nession_erofs::mount::MountSettings::new("erofsfuse", "fusermount3");
    let mounted =
        nession_erofs::mount::ErofsMount::mount(&fetched.layer_path, &mountpoint, &settings)
            .unwrap();
    assert_eq!(
        std::fs::read_to_string(mountpoint.join("usr/bin/sh")).unwrap(),
        "#!/bin/sh\n"
    );
    assert_eq!(
        std::fs::read_to_string(mountpoint.join("opt/tool/bin/tool")).unwrap(),
        "tool-binary\n"
    );
    drop(mounted);
}
