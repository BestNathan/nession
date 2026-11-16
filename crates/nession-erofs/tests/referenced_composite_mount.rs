//! #3697 SC-03: a referenced multi-blob Composite transfers to an Agent cache
//! and mounts as one complete file tree after every source Image is gone.
//!
//! Real Linux proof lane: `mkfs.erofs` builds two block-addressed source
//! images, `mkfs.erofs` rebuild mode produces one metadata image referencing
//! them as external devices, every source payload is deleted, and the Agent
//! cache fetches only the Manifest/Config/Composite/metadata/device closure.
//! `erofsfuse --device=...` then reads files from both backing devices.
#![cfg(all(target_os = "linux", feature = "cache", feature = "mount"))]

use std::path::Path;
use std::sync::Arc;

use httptest::{matchers::request, Expectation, Server};
use nession_erofs::build::compose::{compose_mkfs_command, ProcessErofsExtractor};
use nession_erofs::build::referenced::{
    ErofsReferencedComposer, ReferencedBuildRequest, ReferencedSourceInput,
};
use nession_erofs::cache::fetch::{fetch_composite_image, ImageObjectGrant};
use nession_erofs::cache::ErofsCache;
use nession_erofs::oci::annotation::{
    MEDIA_TYPE_COMPOSITE, MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS, MEDIA_TYPE_MANIFEST,
};
use nession_erofs::oci::config::{ImageConfig, RootFs, RuntimeConfig};
use nession_erofs::oci::descriptor::{Descriptor, Platform};
use nession_erofs::{
    BlobStore, MkfsRunner, NoopObserver, Packaging, ProcessControl, ProcessMkfsRunner,
};
use serde_json::Map;

const ROUTE_PREFIX: &str = "/images/blobs/";
const TOKEN: &str = "server-token";

fn mode(path: &Path, value: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(value))
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
            diff_ids: Vec::new(),
            extra: Map::new(),
        },
        history: Vec::new(),
        extra: Map::new(),
    }
}

fn source(path: &Path, reference: &str) -> anyhow::Result<ReferencedSourceInput> {
    let size = std::fs::metadata(path)?.len();
    Ok(ReferencedSourceInput {
        path: path.to_path_buf(),
        layer: Descriptor {
            media_type: MEDIA_TYPE_EROFS.to_string(),
            digest: nession_erofs::file_digest(path)?,
            size,
            urls: None,
            annotations: None,
            platform: None,
            artifact_type: None,
            data: None,
            extra: Map::new(),
        },
        repository: "nession/test".to_string(),
        reference: reference.to_string(),
        manifest_digest: format!("sha256:{}", "d".repeat(64)),
        platform: Platform::for_consumer("linux", "amd64", None),
        config: config(),
    })
}

#[tokio::test]
#[ignore = "requires erofs-utils and /dev/fuse; executed by the #3697 acceptance Case"]
async fn a_referenced_composite_transfers_and_mounts_after_sources_are_deleted() {
    let root = tempfile::tempdir().unwrap();
    let mkfs = Arc::new(ProcessMkfsRunner::default());
    let packaging = Packaging::default();
    let mut sources = Vec::new();
    for (name, file, bytes) in [
        ("node.erofs", "usr/bin/node", b"NODE".repeat(4096)),
        ("dsh.erofs", "srv/dsh/index.js", b"DSH!".repeat(4096)),
    ] {
        let tree = root.path().join(format!("{name}-tree"));
        let path = tree.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        mode(&path, 0o755).unwrap();
        let image = root.path().join(name);
        mkfs.run(
            &compose_mkfs_command(&image, &tree, &packaging),
            &ProcessControl::new(),
        )
        .unwrap();
        sources.push(source(&image, name).unwrap());
    }
    let composer = ErofsReferencedComposer::new(
        Arc::new(ProcessErofsExtractor::default()),
        mkfs,
        BlobStore::new(root.path().join("server-blobs")).unwrap(),
        root.path().join("work"),
    )
    .unwrap();
    let built = composer
        .run(ReferencedBuildRequest {
            build_dir: &root.path().join("build"),
            sources: &sources,
            packaging: &packaging,
            control: &ProcessControl::new(),
            observer: &NoopObserver,
        })
        .unwrap();
    let referenced = built
        .built
        .compose
        .as_ref()
        .and_then(|compose| compose.referenced.as_ref())
        .expect("referenced metadata")
        .clone();
    assert_eq!(referenced.devices.len(), 2);

    // The Server CAS holds each source blob; capture that exact byte set,
    // then remove the build-host source files before serving the result.
    let device_bytes = sources
        .iter()
        .map(|source| std::fs::read(&source.path).unwrap())
        .collect::<Vec<_>>();
    for source in &sources {
        std::fs::remove_file(&source.path).unwrap();
    }

    let server = Server::run();
    let mut served = Vec::new();
    for (path, bytes) in [
        (
            format!("{ROUTE_PREFIX}{}", referenced.manifest_digest),
            referenced.manifest.bytes().to_vec(),
        ),
        (
            format!("{ROUTE_PREFIX}{}", referenced.config.digest()),
            referenced.config.bytes().to_vec(),
        ),
        (
            format!("{ROUTE_PREFIX}{}", referenced.descriptor.digest),
            std::fs::read(
                nession_erofs::BlobStore::new(root.path().join("server-blobs"))
                    .unwrap()
                    .path_for(&referenced.descriptor.digest)
                    .unwrap(),
            )
            .unwrap(),
        ),
        (
            format!("{ROUTE_PREFIX}{}", referenced.metadata.digest),
            std::fs::read(
                nession_erofs::BlobStore::new(root.path().join("server-blobs"))
                    .unwrap()
                    .path_for(&referenced.metadata.digest)
                    .unwrap(),
            )
            .unwrap(),
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
    for (device, bytes) in referenced.devices.iter().zip(device_bytes.iter()) {
        let path = format!("{ROUTE_PREFIX}{}", device.digest);
        let bytes = bytes.clone();
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
    let mut grants = vec![
        ImageObjectGrant {
            digest: referenced.manifest_digest.clone(),
            media_type: MEDIA_TYPE_MANIFEST.to_string(),
            size_bytes: referenced.manifest.size().unwrap(),
            path: served[0].clone(),
        },
        ImageObjectGrant {
            digest: referenced.config.digest().to_string(),
            media_type: MEDIA_TYPE_CONFIG.to_string(),
            size_bytes: referenced.config.size().unwrap(),
            path: served[1].clone(),
        },
        ImageObjectGrant {
            digest: referenced.descriptor.digest.clone(),
            media_type: MEDIA_TYPE_COMPOSITE.to_string(),
            size_bytes: referenced.descriptor.size,
            path: served[2].clone(),
        },
        ImageObjectGrant {
            digest: referenced.metadata.digest.clone(),
            media_type: MEDIA_TYPE_EROFS.to_string(),
            size_bytes: referenced.metadata.size,
            path: served[3].clone(),
        },
    ];
    for (device, path) in referenced.devices.iter().zip(served[4..].iter()) {
        grants.push(ImageObjectGrant {
            digest: device.digest.clone(),
            media_type: MEDIA_TYPE_EROFS.to_string(),
            size_bytes: device.size,
            path: path.clone(),
        });
    }
    let origin = server
        .url("/")
        .to_string()
        .trim_end_matches('/')
        .to_string();
    let fetched = fetch_composite_image(&cache, &grants, &origin, TOKEN, ROUTE_PREFIX)
        .await
        .unwrap();
    assert_eq!(fetched.manifest_digest, referenced.manifest_digest);
    assert_eq!(fetched.device_paths.len(), 2);
    for source in &sources {
        assert!(!cache.blob_path(&source.layer.digest).unwrap().is_file());
    }

    let mountpoint = root.path().join("mount");
    let settings = nession_erofs::mount::MountSettings::new("erofsfuse", "fusermount3");
    nession_erofs::mount::mount_shared_with_devices(
        &fetched.metadata_path,
        &fetched.device_paths,
        &mountpoint,
        &settings,
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(mountpoint.join("usr/bin/node")).unwrap(),
        "NODE".repeat(4096)
    );
    assert_eq!(
        std::fs::read_to_string(mountpoint.join("srv/dsh/index.js")).unwrap(),
        "DSH!".repeat(4096)
    );
    nession_erofs::mount::unmount_shared(&settings.fusermount, &mountpoint).unwrap();
}
