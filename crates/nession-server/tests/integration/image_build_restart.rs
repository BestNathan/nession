//! #3334 SC-02: a real `mkfs.erofs` production interrupted after the completed
//! snapshot, then a restarted Server resumes packaging from the validated
//! snapshot and publishes only the verified immutable bytes.
//!
//! The first attempt runs a wrapper that writes a partial `.part`, records a
//! marker and fails. The durable snapshot checkpoint survives. The record is
//! then left `running` with the partial output, exactly like a terminated
//! owner. A second manager over the same roots takes the build-root lock,
//! reconciles the orphan and runs the real `mkfs.erofs`.

#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

use nession_erofs::{BlobStore, ErofsBuilder, ProcessGitRunner, ProcessMkfsRunner};
use nession_protocol::contracts::image::v1::{ImageBuildStatus, ImageSource};
use nession_server::db::Database;
use nession_server::image::{
    BuildStore, ImageManager, ImageManagerOptions, DEFAULT_BUILD_LOG_MAX_BYTES,
    DEFAULT_BUILD_RETENTION_SECS,
};

fn options(dir: &std::path::Path) -> ImageManagerOptions {
    ImageManagerOptions {
        max_concurrent_builds: 1,
        build_root: dir.join("builds"),
        build_stage_timeout: Some(Duration::from_secs(120)),
        build_log_max_bytes: DEFAULT_BUILD_LOG_MAX_BYTES,
        build_retention_secs: DEFAULT_BUILD_RETENTION_SECS,
    }
}

fn builder(dir: &std::path::Path, mkfs: std::path::PathBuf) -> anyhow::Result<Arc<ErofsBuilder>> {
    Ok(Arc::new(ErofsBuilder::new(
        Arc::new(ProcessGitRunner::default()),
        Arc::new(ProcessMkfsRunner { binary: mkfs }),
        BlobStore::new(dir.join("blobs"))?,
        dir.join("builds"),
    )?))
}

async fn manager(
    dir: &std::path::Path,
    mkfs: std::path::PathBuf,
) -> anyhow::Result<Arc<ImageManager>> {
    let db = Arc::new(Database::new(":memory:").await?);
    Ok(Arc::new(ImageManager::new(
        db,
        builder(dir, mkfs)?,
        BlobStore::new(dir.join("blobs"))?,
        options(dir),
    )?))
}

#[tokio::test]
#[ignore = "requires erofs-utils; executed by the #3334 acceptance Case"]
async fn a_restarted_server_reruns_packaging_from_the_validated_snapshot() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let source = dir.path().join("source");
    std::fs::create_dir_all(source.join("sub"))?;
    std::fs::write(source.join("hello.txt"), b"hello erofs")?;
    std::fs::write(source.join("sub/nested.txt"), b"nested")?;

    let marker = dir.path().join("packaging.attempted");
    let wrapper = dir.path().join("mkfs-wrapper");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\n\
             prev=\"\"\n\
             last=\"\"\n\
             for arg in \"$@\"; do prev=\"$last\"; last=\"$arg\"; done\n\
             if [ ! -f '{marker}' ]; then\n\
               touch '{marker}'\n\
               printf 'partial interrupted output' > \"$prev\"\n\
               exit 1\n\
             fi\n\
             exec mkfs.erofs \"$@\"\n",
            marker = marker.display()
        ),
    )?;
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755))?;

    // First Server: snapshot completes, packaging fails and leaves the durable
    // snapshot checkpoint behind.
    let first = manager(dir.path(), wrapper.clone()).await?;
    let submitted = first
        .submit_build(
            &ImageSource::LocalDirectory {
                path: source.to_string_lossy().into_owned(),
            },
            None,
            None,
        )
        .await
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    let failed = tokio::time::timeout(
        Duration::from_secs(180),
        first.wait_for_build(&submitted.build_id),
    )
    .await
    .expect("timed out waiting for the first packaging attempt")
    .map_err(|error| anyhow::anyhow!("{error}"))?;
    assert_eq!(failed.status, ImageBuildStatus::Failed, "{failed:?}");
    assert_eq!(failed.progress.files, Some(2));
    drop(first);

    // The owner is gone. Leave the record running with the partial output a
    // terminated Server would have.
    {
        let store = BuildStore::open(dir.path().join("builds"), DEFAULT_BUILD_LOG_MAX_BYTES)?;
        let mut orphan = store.read_state(&submitted.build_id)?;
        orphan.status = ImageBuildStatus::Running;
        orphan.stage = Some(nession_protocol::contracts::image::v1::ImageBuildStage::Packaging);
        orphan.error = None;
        orphan.diagnostic = None;
        orphan.finished_at = None;
        store.write_state(&orphan)?;
        std::fs::write(
            nession_erofs::packaged_image_path(&store.build_dir(&submitted.build_id)),
            b"partial interrupted output",
        )?;
    }

    // Only the durable snapshot can produce the image now.
    std::fs::remove_dir_all(&source)?;

    // Second Server: same roots, real mkfs. It reconciles the orphan, reruns
    // packaging from the verified snapshot, and publishes the verified bytes.
    let second = manager(dir.path(), wrapper).await?;
    second
        .recover_builds()
        .await
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    let succeeded = tokio::time::timeout(
        Duration::from_secs(180),
        second.wait_for_build(&submitted.build_id),
    )
    .await
    .expect("timed out waiting for recovered packaging")
    .map_err(|error| anyhow::anyhow!("{error}"))?;
    assert_eq!(
        succeeded.status,
        ImageBuildStatus::Succeeded,
        "{succeeded:?}"
    );
    let digest = succeeded.digest.expect("succeeded build has a digest");
    let blobs = BlobStore::new(dir.path().join("blobs"))?;
    blobs.verify(&digest)?;
    let image = std::fs::read(blobs.path_for(&digest)?)?;
    assert_eq!(
        image.get(1024..1028),
        Some([0xe2_u8, 0xe1, 0xf5, 0xe0].as_slice()),
        "the published bytes are a real EROFS image produced by mkfs.erofs"
    );
    assert_ne!(
        image.len(),
        b"partial interrupted output".len(),
        "the partial packaging output was never published"
    );
    Ok(())
}
