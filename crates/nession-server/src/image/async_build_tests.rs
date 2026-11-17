//! Asynchronous directory-backed build lifecycle tests (#3334).
//!
//! These exercise the Server-owned policy: prompt submission, durable state,
//! idempotency, cancellation of owned subprocesses, stage-level retry,
//! restart recovery, alias intent ordering, concurrency isolation and bounded
//! cleanup. The mechanical build itself is covered by `nession-erofs` tests and
//! by the real-`mkfs.erofs` acceptance Case.

use super::*;
use nession_erofs::{MkfsRunner, ProcessGitRunner};
use nession_protocol::contracts::image::v1::{ImageComposeRepresentation, ImageComposeSource};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex as StdMutex};

// ── Test backends ───────────────────────────────────────────────────────

/// Install `body` at `bin` with the file created by a **child** process.
///
/// `fork` copies the descriptor table, so writing the path a test executes can
/// leave a concurrently forked child holding it writable until that child's
/// own `exec`; an `exec` of the same inode then fails with `ETXTBSY`
/// (#1026, #3504, #3612). The body goes to a path that is never exec'd and a
/// child `cp` creates `bin`, so this process never holds a write descriptor on
/// the executable. `chmod` does not open it, and `rename` is not equivalent
/// (same inode).
#[cfg(unix)]
fn install_via_a_child(bin: &std::path::Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    let staged = bin.with_extension("src");
    std::fs::write(&staged, body).unwrap();
    let status = std::process::Command::new("cp")
        .arg(&staged)
        .arg(bin)
        .status()
        .unwrap();
    let _ = std::fs::remove_file(&staged);
    assert!(
        status.success(),
        "installing the executable fixture: cp failed"
    );
    let mut permissions = std::fs::metadata(bin).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(bin, permissions).unwrap();
}

/// A deterministic gate a build backend waits on.
#[derive(Default)]
struct Gate {
    released: StdMutex<bool>,
    changed: Condvar,
}

impl Gate {
    fn wait(&self) {
        let mut released = self.released.lock().unwrap();
        while !*released {
            released = self.changed.wait(released).unwrap();
        }
    }

    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.changed.notify_all();
    }
}

/// A backend with access to the manager's blob store that holds every build
/// until the test releases a gate. Used for prompt submission, cancellation,
/// concurrency, GC protection and alias ordering.
struct SharedBlobBackend {
    blobs: BlobStore,
    gate: Arc<Gate>,
    active: AtomicUsize,
    max_active: AtomicUsize,
    entered: tokio::sync::mpsc::UnboundedSender<String>,
    contents: StdMutex<HashMap<String, Vec<u8>>>,
}

impl SharedBlobBackend {
    fn new(blobs: BlobStore, entered: tokio::sync::mpsc::UnboundedSender<String>) -> Self {
        Self {
            blobs,
            gate: Arc::new(Gate::default()),
            active: AtomicUsize::new(0),
            max_active: AtomicUsize::new(0),
            entered,
            contents: StdMutex::new(HashMap::new()),
        }
    }

    fn set(&self, key: &str, bytes: &[u8]) {
        self.contents
            .lock()
            .unwrap()
            .insert(key.to_string(), bytes.to_vec());
    }
}

impl ImageBuildBackend for SharedBlobBackend {
    fn execute(&self, execution: BuildExecution) -> Result<BuiltImage> {
        let key = key_for(&execution.source);
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active.fetch_max(active, Ordering::SeqCst);
        let _ = self.entered.send(key.clone());
        self.gate.wait();
        execution.observer.stage(Stage::Packaging);
        let bytes = self
            .contents
            .lock()
            .unwrap()
            .get(&key)
            .cloned()
            .unwrap_or_else(|| key.into_bytes());
        std::fs::create_dir_all(&execution.build_dir)?;
        let image = execution.build_dir.join("image.erofs.part");
        std::fs::write(&image, &bytes)?;
        let blob = self.blobs.put_file(&image)?;
        self.active.fetch_sub(1, Ordering::SeqCst);
        Ok(BuiltImage {
            blob,
            source_sha: None,
            packaging: ErofsPackaging::default(),
            compose: None,
        })
    }
}

fn key_for(source: &NormalizedImageSource) -> String {
    match source {
        NormalizedImageSource::GitHub {
            repository_url,
            reference,
            ..
        } => format!("{repository_url}#{reference}"),
        NormalizedImageSource::LocalDirectory { path } => path.clone(),
        NormalizedImageSource::Compose { sources, .. } => sources
            .iter()
            .map(|source| {
                format!(
                    "{}:{}@{}",
                    source.repository, source.reference, source.destination
                )
            })
            .collect::<Vec<_>>()
            .join(","),
    }
}

/// A deterministic `mkfs.erofs` substitute for the real builder.
struct TestMkfs {
    behavior: StdMutex<TestMkfsBehavior>,
}

enum TestMkfsBehavior {
    Success,
    FailOnce(String),
}

impl MkfsRunner for TestMkfs {
    fn run(&self, args: &[String], _control: &ProcessControl) -> Result<()> {
        let mut behavior = self.behavior.lock().unwrap();
        let image = Path::new(args.get(args.len() - 2).unwrap());
        if let TestMkfsBehavior::FailOnce(message) = &*behavior {
            let message = message.clone();
            *behavior = TestMkfsBehavior::Success;
            std::fs::write(image, b"partial mkfs output").ok();
            anyhow::bail!(message);
        }
        let root = Path::new(args.last().unwrap());
        let mut bytes = Vec::new();
        collect_bytes(root, &mut bytes)?;
        std::fs::write(image, bytes)?;
        Ok(())
    }
}

fn collect_bytes(current: &Path, out: &mut Vec<u8>) -> Result<()> {
    let mut entries = std::fs::read_dir(current)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        out.extend_from_slice(entry.file_name().to_string_lossy().as_bytes());
        let metadata = std::fs::symlink_metadata(&path)?;
        if metadata.is_dir() {
            collect_bytes(&path, out)?;
        } else if metadata.is_file() {
            out.extend_from_slice(&std::fs::read(&path)?);
        }
    }
    Ok(())
}

fn real_builder(dir: &Path, mkfs: Arc<dyn MkfsRunner>) -> Arc<dyn ImageBuildBackend> {
    Arc::new(
        ErofsBuilder::new(
            Arc::new(ProcessGitRunner::default()),
            mkfs,
            BlobStore::new(dir.join("blobs")).unwrap(),
            dir.join("work"),
        )
        .unwrap(),
    )
}

fn options(dir: &Path, max_concurrent: usize) -> ImageManagerOptions {
    ImageManagerOptions {
        max_concurrent_builds: max_concurrent,
        build_root: dir.join("builds"),
        source_root: Some(std::path::PathBuf::from("/")),
        build_stage_timeout: Some(Duration::from_secs(30)),
        build_log_max_bytes: DEFAULT_BUILD_LOG_MAX_BYTES,
        build_retention_secs: 60,
    }
}

async fn manager_with(
    dir: &Path,
    backend: Arc<dyn ImageBuildBackend>,
    max_concurrent: usize,
) -> (Arc<ImageManager>, Arc<Database>) {
    let db = Arc::new(Database::new(":memory:").await.unwrap());
    let blobs = BlobStore::new(dir.join("blobs")).unwrap();
    let manager = Arc::new(
        ImageManager::new(
            Arc::clone(&db),
            backend,
            blobs,
            options(dir, max_concurrent),
        )
        .unwrap(),
    );
    (manager, db)
}

fn local(path: &str) -> ImageSource {
    ImageSource::LocalDirectory {
        path: path.to_string(),
    }
}

fn source_tree(root: &Path) -> PathBuf {
    let source = root.join("source");
    std::fs::create_dir_all(source.join("sub")).unwrap();
    std::fs::write(source.join("a.txt"), b"alpha").unwrap();
    std::fs::write(source.join("sub/b.txt"), b"beta").unwrap();
    source
}

fn channel<T>() -> (
    tokio::sync::mpsc::UnboundedSender<T>,
    tokio::sync::mpsc::UnboundedReceiver<T>,
) {
    tokio::sync::mpsc::unbounded_channel()
}

async fn wait_for_stage(
    updates: &mut tokio::sync::mpsc::UnboundedReceiver<ImageBuildDescriptor>,
    build_id: &str,
    stage: ImageBuildStage,
) -> ImageBuildDescriptor {
    loop {
        let build = tokio::time::timeout(Duration::from_secs(10), updates.recv())
            .await
            .expect("timed out waiting for a build update")
            .expect("build update channel closed");
        if build.build_id == build_id && build.stage == Some(stage) {
            return build;
        }
    }
}

// ── Submission and durable observation ──────────────────────────────────

/// SC-01: an authenticated submission returns a stable build id without
/// waiting for Git/mkfs completion, and get/list read the same durable record.
#[tokio::test]
async fn submission_returns_a_durable_record_before_the_build_finishes() {
    let dir = tempfile::tempdir().unwrap();
    let source = source_tree(dir.path());
    let blobs = BlobStore::new(dir.path().join("blobs")).unwrap();
    let (entered_tx, mut entered_rx) = channel();
    let backend = Arc::new(SharedBlobBackend::new(blobs, entered_tx));
    let (manager, _db) = manager_with(dir.path(), backend.clone(), 1).await;
    let (updates_tx, _updates) = channel();
    manager.set_build_notifier(Arc::new(move |build| {
        let _ = updates_tx.send(build.clone());
    }));
    let path = source.to_str().unwrap();

    let submitted = manager
        .submit_build(&local(path), Some("latest"), None)
        .await
        .unwrap();
    assert_eq!(submitted.status, ImageBuildStatus::Queued);
    assert!(submitted.build_id.starts_with("build-"));
    // The worker has started but is blocked; the durable record is readable and
    // reports the truth rather than a fabricated fraction.
    let entered = tokio::time::timeout(Duration::from_secs(10), entered_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(entered, path);
    let read = manager.get_build(&submitted.build_id).await.unwrap();
    assert_eq!(read.build_id, submitted.build_id);
    assert_eq!(read.status, ImageBuildStatus::Running);
    assert!(read.progress.files.is_none());
    assert!(read.progress.bytes.is_none());
    let page = manager.list_builds(0, 10).await.unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.builds[0].build_id, submitted.build_id);

    backend.gate.release();
    let done = manager.wait_terminal(&submitted.build_id).await.unwrap();
    assert_eq!(done.status, ImageBuildStatus::Succeeded);
    assert!(done.digest.is_some());
}

/// SC-01: a duplicate client submission is idempotent; reusing the same key
/// for a different request is refused. Legacy `server.image.build` still
/// returns a ready descriptor, never a job.
#[tokio::test]
async fn duplicate_submission_is_idempotent_and_legacy_build_returns_a_ready_image() {
    let dir = tempfile::tempdir().unwrap();
    let source = source_tree(dir.path());
    let blobs = BlobStore::new(dir.path().join("blobs")).unwrap();
    let (entered_tx, _entered_rx) = channel();
    let backend = Arc::new(SharedBlobBackend::new(blobs, entered_tx));
    let (manager, _db) = manager_with(dir.path(), backend.clone(), 1).await;
    backend.gate.release();

    let path = source.to_str().unwrap();
    let first = manager
        .submit_build(&local(path), Some("latest"), Some("project-build-1"))
        .await
        .unwrap();
    let second = manager
        .submit_build(&local(path), Some("latest"), Some("project-build-1"))
        .await
        .unwrap();
    assert_eq!(first.build_id, second.build_id);
    assert_eq!(manager.list_builds(0, 10).await.unwrap().total, 1);
    let mismatch = manager
        .submit_build(
            &local("/different"),
            Some("latest"),
            Some("project-build-1"),
        )
        .await
        .unwrap_err();
    assert_eq!(mismatch.kind(), "invalid");

    let ready = manager.build(&local(path), Some("latest")).await.unwrap();
    assert_eq!(ready.status, ImageStatus::Ready);
    assert!(ready.digest.is_some());
}

/// SC-04: two concurrent submissions carrying the same client key create one
/// durable build rather than two.
#[tokio::test]
async fn concurrent_duplicate_submissions_create_one_build() {
    let dir = tempfile::tempdir().unwrap();
    let source = source_tree(dir.path());
    let blobs = BlobStore::new(dir.path().join("blobs")).unwrap();
    let (entered_tx, _entered_rx) = channel();
    let backend = Arc::new(SharedBlobBackend::new(blobs, entered_tx));
    let (manager, _db) = manager_with(dir.path(), backend.clone(), 1).await;
    let path = source.to_str().unwrap().to_string();
    let source = local(&path);
    let (first, second) = tokio::join!(
        manager.submit_build(&source, Some("latest"), Some("same-request")),
        manager.submit_build(&source, Some("latest"), Some("same-request")),
    );
    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(first.build_id, second.build_id);
    assert_eq!(manager.list_builds(0, 10).await.unwrap().total, 1);
    backend.gate.release();
    manager.wait_terminal(&first.build_id).await.unwrap();
}

// ── Cancellation ────────────────────────────────────────────────────────

/// SC-03: cancellation terminates the owned `mkfs.erofs` subprocess, records a
/// truthful canceled state and never publishes partial bytes.
#[cfg(unix)]
#[tokio::test]
async fn cancellation_kills_the_owned_mkfs_process_and_publishes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let source = source_tree(dir.path());
    let pid_file = dir.path().join("mkfs.pid");
    let script = dir.path().join("slow-mkfs");
    install_via_a_child(
        &script,
        &format!(
            "#!/bin/sh\necho $$ > '{}'\nexec sleep 30\n",
            pid_file.display()
        ),
    );
    let builder = real_builder(
        dir.path(),
        Arc::new(nession_erofs::ProcessMkfsRunner { binary: script }),
    );
    let (manager, db) = manager_with(dir.path(), builder, 1).await;
    let (updates_tx, mut updates) = channel();
    manager.set_build_notifier(Arc::new(move |build| {
        let _ = updates_tx.send(build.clone());
    }));

    let submitted = manager
        .submit_build(&local(source.to_str().unwrap()), None, None)
        .await
        .unwrap();
    wait_for_stage(
        &mut updates,
        &submitted.build_id,
        ImageBuildStage::Packaging,
    )
    .await;
    let mut pid = None;
    for _ in 0..200 {
        if let Ok(text) = std::fs::read_to_string(&pid_file) {
            pid = text.trim().parse::<u32>().ok();
            if pid.is_some() {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let pid = pid.expect("the mkfs substitute recorded its pid");

    let canceled = manager.cancel_build(&submitted.build_id).await.unwrap();
    assert_eq!(canceled.status, ImageBuildStatus::Canceled);
    assert!(canceled.digest.is_none());
    let alive = std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    assert!(!alive, "the canceled mkfs process must no longer be alive");
    let row = db
        .get_image_by_id(&canceled.image_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.status, "failed");
    let images = manager.list(0, 10, "").await.unwrap().images;
    assert_eq!(images.len(), 1);
    assert_eq!(images[0].status, ImageStatus::Failed);
    assert!(!dir
        .path()
        .join("blobs/sha256")
        .read_dir()
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false));
}

// ── Retry and stage-level recovery ──────────────────────────────────────

/// SC-03: a packaging failure keeps the validated snapshot; a retry reuses it
/// without the (now deleted) source and produces the intended immutable bytes.
#[tokio::test]
async fn retry_reuses_a_verified_snapshot_and_never_recopies_the_source() {
    let dir = tempfile::tempdir().unwrap();
    let source = source_tree(dir.path());
    let mkfs = Arc::new(TestMkfs {
        behavior: StdMutex::new(TestMkfsBehavior::FailOnce(
            "simulated mkfs interruption".to_string(),
        )),
    });
    let builder = real_builder(dir.path(), mkfs);
    let (manager, _db) = manager_with(dir.path(), builder, 1).await;

    let submitted = manager
        .submit_build(&local(source.to_str().unwrap()), Some("latest"), None)
        .await
        .unwrap();
    let failed = manager.wait_terminal(&submitted.build_id).await.unwrap();
    assert_eq!(failed.status, ImageBuildStatus::Failed);
    assert!(failed.error.as_deref().unwrap().contains("simulated"));
    assert_eq!(failed.progress.files, Some(2));

    // Only the durable snapshot can produce the image after this point.
    std::fs::remove_dir_all(&source).unwrap();
    let retried = manager.retry_build(&submitted.build_id).await.unwrap();
    assert_eq!(retried.attempt, 2);
    assert_eq!(retried.status, ImageBuildStatus::Queued);
    let done = manager.wait_terminal(&submitted.build_id).await.unwrap();
    assert_eq!(done.status, ImageBuildStatus::Succeeded);
    assert!(done.digest.is_some());
    assert_eq!(done.attempts.len(), 2);
    assert_eq!(done.attempts[0].attempt, 1);
    assert_eq!(done.attempts[0].status, "failed");
    assert_eq!(done.attempts[1].attempt, 2);
    assert_eq!(done.attempts[1].status, "succeeded");
    assert!(manager.retry_build(&submitted.build_id).await.is_err());
}

/// SC-02/03: a local source with no trustworthy snapshot is refused instead of
/// being silently re-copied after a failure.
#[tokio::test]
async fn retry_refuses_a_local_source_without_a_validated_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let source = source_tree(dir.path());
    let source_path = source.to_str().unwrap().to_string();
    std::fs::remove_dir_all(&source).unwrap();
    let mkfs = Arc::new(TestMkfs {
        behavior: StdMutex::new(TestMkfsBehavior::Success),
    });
    let (manager, _db) = manager_with(dir.path(), real_builder(dir.path(), mkfs), 1).await;
    let submitted = manager
        .submit_build(&local(&source_path), None, None)
        .await
        .unwrap();
    let failed = manager.wait_terminal(&submitted.build_id).await.unwrap();
    assert_eq!(failed.status, ImageBuildStatus::Failed);
    let error = manager.retry_build(&submitted.build_id).await.unwrap_err();
    assert_eq!(error.kind(), "invalid");
    assert!(
        error.message().contains("no validated snapshot"),
        "{}",
        error.message()
    );
}

/// SC-02: a restarted Server resumes an orphaned `running` record from its
/// verified snapshot, reruns packaging, discards a partial image, and publishes
/// the intended bytes without repeating the snapshot work.
#[tokio::test]
async fn restart_recovery_resumes_from_the_verified_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let source = source_tree(dir.path());
    let source_path = source.to_str().unwrap().to_string();
    let failing_mkfs = Arc::new(TestMkfs {
        behavior: StdMutex::new(TestMkfsBehavior::FailOnce(
            "simulated packaging interruption".to_string(),
        )),
    });
    let (first, _db) = manager_with(dir.path(), real_builder(dir.path(), failing_mkfs), 1).await;
    let submitted = first
        .submit_build(&local(&source_path), None, None)
        .await
        .unwrap();
    let failed = first.wait_terminal(&submitted.build_id).await.unwrap();
    assert_eq!(failed.status, ImageBuildStatus::Failed);
    drop(first);

    // Model an owner that stopped between the completed snapshot and the next
    // mkfs: the record is still `running` and a partial output exists. This is
    // the reachable state a terminating Server leaves behind.
    let store = BuildStore::open(dir.path().join("builds"), DEFAULT_BUILD_LOG_MAX_BYTES).unwrap();
    let mut orphan = store.read_state(&submitted.build_id).unwrap();
    orphan.status = ImageBuildStatus::Running;
    orphan.stage = Some(ImageBuildStage::Packaging);
    orphan.error = None;
    orphan.diagnostic = None;
    orphan.finished_at = None;
    store.write_state(&orphan).unwrap();
    std::fs::write(
        nession_erofs::packaged_image_path(&store.build_dir(&submitted.build_id)),
        b"partial interrupted output",
    )
    .unwrap();
    drop(store);

    // The source is gone: only the durable snapshot can produce the image.
    std::fs::remove_dir_all(&source).unwrap();

    let good_mkfs = Arc::new(TestMkfs {
        behavior: StdMutex::new(TestMkfsBehavior::Success),
    });
    let second = Arc::new(
        ImageManager::new(
            Arc::new(Database::new(":memory:").await.unwrap()),
            real_builder(dir.path(), good_mkfs),
            BlobStore::new(dir.path().join("blobs")).unwrap(),
            options(dir.path(), 1),
        )
        .unwrap(),
    );
    second.recover_builds().await.unwrap();
    let recovered = second.wait_terminal(&submitted.build_id).await.unwrap();
    assert_eq!(
        recovered.status,
        ImageBuildStatus::Succeeded,
        "{:?}",
        recovered.error
    );
    assert!(recovered.recovered);
    let digest = recovered.digest.unwrap();
    let blob = second.blob_store();
    blob.verify(&digest).unwrap();
    assert_ne!(
        blob.size(&digest).unwrap(),
        b"partial interrupted output".len() as u64
    );
}

/// SC-04: a second active owner of one build root is refused (the V1
/// single-owner assumption is enforced rather than presented as safe sharing).
#[tokio::test]
async fn a_second_manager_on_one_build_root_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::new(":memory:").await.unwrap());
    let blobs = BlobStore::new(dir.path().join("blobs")).unwrap();
    let first = ImageManager::new(
        Arc::clone(&db),
        Arc::new(UnavailableBackend),
        blobs.clone(),
        options(dir.path(), 1),
    )
    .unwrap();
    let error = ImageManager::new(
        Arc::clone(&db),
        Arc::new(UnavailableBackend),
        blobs,
        options(dir.path(), 1),
    )
    .err()
    .expect("a second build-root owner must be refused");
    assert!(
        format!("{error:#}").contains("another Server process"),
        "{error:#}"
    );
    drop(first);
    ImageManager::new(
        db,
        Arc::new(UnavailableBackend),
        BlobStore::new(dir.path().join("blobs")).unwrap(),
        options(dir.path(), 1),
    )
    .expect("the lock is released with its owner");
}

/// SC-02: a corrupted state directory is rejected and never resumed.
#[tokio::test]
async fn corrupted_durable_state_is_rejected_not_resumed() {
    let dir = tempfile::tempdir().unwrap();
    let builds = dir.path().join("builds");
    std::fs::create_dir_all(builds.join("build-corrupt")).unwrap();
    std::fs::write(
        builds.join("build-corrupt").join("state.json"),
        b"{ this is not json",
    )
    .unwrap();
    let manager = Arc::new(
        ImageManager::new(
            Arc::new(Database::new(":memory:").await.unwrap()),
            Arc::new(UnavailableBackend),
            BlobStore::new(dir.path().join("blobs")).unwrap(),
            options(dir.path(), 1),
        )
        .unwrap(),
    );
    manager.recover_builds().await.unwrap();
    assert_eq!(manager.list_builds(0, 10).await.unwrap().total, 0);
    assert!(builds.join("build-corrupt.rejected").is_dir());
    assert!(!builds.join("build-corrupt").exists());
    assert!(manager.get_build("build-corrupt").await.is_err());
}

// ── Concurrency, alias intent and GC protection ─────────────────────────

/// SC-04: concurrent builds stay within the configured worker limit and each
/// build writes into its own directory.
#[tokio::test]
async fn concurrent_builds_respect_the_worker_limit_and_do_not_share_workspaces() {
    let dir = tempfile::tempdir().unwrap();
    let blobs = BlobStore::new(dir.path().join("blobs")).unwrap();
    let (entered_tx, mut entered_rx) = channel();
    let backend = Arc::new(SharedBlobBackend::new(blobs, entered_tx));
    let (manager, _db) = manager_with(dir.path(), backend.clone(), 2).await;

    let mut ids = Vec::new();
    let mut sources = Vec::new();
    for index in 0..3 {
        let source = dir.path().join(format!("source-{index}"));
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("file"), format!("content-{index}")).unwrap();
        sources.push(source.to_string_lossy().into_owned());
        ids.push(
            manager
                .submit_build(&local(&sources[index]), None, None)
                .await
                .unwrap()
                .build_id,
        );
    }
    let first = tokio::time::timeout(Duration::from_secs(10), entered_rx.recv())
        .await
        .unwrap()
        .unwrap();
    let second = tokio::time::timeout(Duration::from_secs(10), entered_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_ne!(first, second);
    let third = tokio::time::timeout(Duration::from_millis(200), entered_rx.recv()).await;
    assert!(third.is_err(), "a third build exceeded the worker limit");
    assert_eq!(backend.active.load(Ordering::SeqCst), 2);
    backend.gate.release();
    for id in &ids {
        let done = manager.wait_terminal(id).await.unwrap();
        assert_eq!(done.status, ImageBuildStatus::Succeeded);
    }
    assert!(backend.max_active.load(Ordering::SeqCst) <= 2);
    let page = manager.list_builds(0, 10).await.unwrap();
    assert_eq!(page.total, 3);
    assert_eq!(
        page.builds
            .iter()
            .filter_map(|build| build.digest.clone())
            .collect::<std::collections::HashSet<_>>()
            .len(),
        3
    );
}

/// SC-04: a stale completion cannot move an alias past a newer intended
/// association.
#[tokio::test]
async fn a_stale_completion_does_not_overwrite_a_newer_alias_intent() {
    let dir = tempfile::tempdir().unwrap();
    let blobs = BlobStore::new(dir.path().join("blobs")).unwrap();
    let (entered_tx, mut entered_rx) = channel();
    let backend = Arc::new(SharedBlobBackend::new(blobs, entered_tx));
    let older_source = dir.path().join("older-source");
    let newer_source = dir.path().join("newer-source");
    std::fs::create_dir_all(&older_source).unwrap();
    std::fs::create_dir_all(&newer_source).unwrap();
    std::fs::write(older_source.join("file"), b"older").unwrap();
    std::fs::write(newer_source.join("file"), b"newer").unwrap();
    backend.set(&older_source.to_string_lossy(), b"older-bytes");
    backend.set(&newer_source.to_string_lossy(), b"newer-bytes");
    let (manager, _db) = manager_with(dir.path(), backend.clone(), 2).await;

    let older = manager
        .submit_build(
            &local(&older_source.to_string_lossy()),
            Some("latest"),
            None,
        )
        .await
        .unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(10), entered_rx.recv())
        .await
        .unwrap();
    let newer = manager
        .submit_build(
            &local(&newer_source.to_string_lossy()),
            Some("latest"),
            None,
        )
        .await
        .unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(10), entered_rx.recv())
        .await
        .unwrap();
    // Both complete; publication is serialized, and the alias intent — not the
    // completion order — decides where the tag lands.
    backend.gate.release();
    let older_done = manager.wait_terminal(&older.build_id).await.unwrap();
    let newer_done = manager.wait_terminal(&newer.build_id).await.unwrap();
    assert_eq!(older_done.status, ImageBuildStatus::Succeeded);
    assert_eq!(newer_done.status, ImageBuildStatus::Succeeded);
    let by_alias = manager.get(None, Some("latest")).await.unwrap();
    assert_eq!(by_alias.digest, newer_done.digest);
    assert!(older_done.digest.is_some());
}

/// SC-04: GC never deletes a `building` row whose durable build is still live.
#[tokio::test]
async fn gc_skips_a_building_row_owned_by_a_live_build() {
    let dir = tempfile::tempdir().unwrap();
    let source = source_tree(dir.path());
    let blobs = BlobStore::new(dir.path().join("blobs")).unwrap();
    let (entered_tx, mut entered_rx) = channel();
    let backend = Arc::new(SharedBlobBackend::new(blobs, entered_tx));
    let (manager, db) = manager_with(dir.path(), backend.clone(), 1).await;
    let submitted = manager
        .submit_build(&local(source.to_str().unwrap()), None, None)
        .await
        .unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(10), entered_rx.recv())
        .await
        .unwrap();
    // Make the row look stale; the live durable build must still protect it.
    db.set_image_updated_at_for_test(&submitted.image_id, 0)
        .await
        .unwrap();
    let report = manager.gc_bounded(GcLimits::default()).await.unwrap();
    assert_eq!(report.skipped_active_builds, 1);
    assert!(db
        .get_image_by_id(&submitted.image_id)
        .await
        .unwrap()
        .is_some());
    backend.gate.release();
    manager.wait_terminal(&submitted.build_id).await.unwrap();
    assert_eq!(
        db.get_image_by_id(&submitted.image_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        "ready"
    );
}

/// SC-07: bounded cleanup removes only expired terminal directories and never
/// active work.
#[tokio::test]
async fn cleanup_expires_terminal_directories_but_never_active_work() {
    let dir = tempfile::tempdir().unwrap();
    let source = source_tree(dir.path());
    let blobs = BlobStore::new(dir.path().join("blobs")).unwrap();
    let (entered_tx, _entered_rx) = channel();
    let backend = Arc::new(SharedBlobBackend::new(blobs, entered_tx));
    let (manager, _db) = manager_with(dir.path(), backend, 1).await;
    let active = manager
        .submit_build(&local(source.to_str().unwrap()), Some("active"), None)
        .await
        .unwrap();
    let store = manager.builds.clone().unwrap();
    let mut expired = store.read_state(&active.build_id).unwrap();
    expired.build_id = "build-expired".to_string();
    expired.image_id = "image-expired".to_string();
    expired.status = ImageBuildStatus::Failed;
    expired.alias = None;
    expired.updated_at = 1;
    expired.created_at = 1;
    store.create(&expired).unwrap();
    let report = manager.cleanup_builds().await.unwrap();
    assert_eq!(report.expired_builds, 1);
    assert_eq!(report.deferred_active, 1);
    assert!(!store.build_dir("build-expired").exists());
    assert!(store.build_dir(&active.build_id).exists());
}

// ── Flattened Compose (#3696) ───────────────────────────────────────────

/// A backend that records the pinned Compose sources it was handed and
/// publishes one deterministic flattened layer.
struct ComposeRecordingBackend {
    blobs: BlobStore,
    gate: Arc<Gate>,
    seen: StdMutex<Vec<Vec<String>>>,
}

impl ComposeRecordingBackend {
    fn new(blobs: BlobStore) -> Self {
        Self {
            blobs,
            gate: Arc::new(Gate::default()),
            seen: StdMutex::new(Vec::new()),
        }
    }
}

impl ImageBuildBackend for ComposeRecordingBackend {
    fn execute(&self, execution: BuildExecution) -> Result<BuiltImage> {
        let compose = execution.compose.as_ref().expect("a compose execution");
        let pinned = compose
            .sources
            .iter()
            .map(|source| source.manifest_digest.clone())
            .collect::<Vec<_>>();
        self.seen.lock().unwrap().push(pinned.clone());
        self.gate.wait();
        execution.observer.stage(Stage::Packaging);
        std::fs::create_dir_all(&execution.build_dir)?;
        let image = execution.build_dir.join("image.erofs.part");
        std::fs::write(&image, format!("flattened:{pinned:?}"))?;
        let blob = self.blobs.put_file(&image)?;
        let sources = compose
            .sources
            .iter()
            .map(|source| nession_erofs::ComposeSourceProvenance {
                repository: source.repository.clone(),
                reference: source.reference.clone(),
                manifest_digest: source.manifest_digest.clone(),
                layer_digest: source.layer.digest.clone(),
                size_bytes: source.layer.size,
                destination: source.destination.clone(),
            })
            .collect::<Vec<_>>();
        Ok(BuiltImage {
            blob,
            source_sha: None,
            packaging: ErofsPackaging::default(),
            compose: Some(nession_erofs::ComposeImageMetadata {
                runtime: nession_erofs::ComposeRuntime {
                    env: vec!["PATH=/usr/bin".to_string()],
                    annotations: [
                        (
                            nession_erofs::oci::annotation::ANNOTATION_COMPOSE_FORMAT.to_string(),
                            "flattened-v1".to_string(),
                        ),
                        (
                            nession_erofs::oci::annotation::ANNOTATION_COMPOSE_SOURCES.to_string(),
                            serde_json::to_string(&sources).unwrap(),
                        ),
                    ]
                    .into_iter()
                    .collect(),
                    ..nession_erofs::ComposeRuntime::default()
                },
                sources,
                referenced: None,
            }),
        })
    }
}

async fn publish_test_source(
    db: &Database,
    blobs: &BlobStore,
    repository: &str,
    tag: &str,
    payload: &[u8],
    platform: Platform,
    expectation: nession_erofs::catalog::tag::TagExpectation,
) -> nession_erofs::image::publish::PublishOutcome {
    let stored = blobs.put_bytes(payload).unwrap();
    nession_erofs::build::publication::publish_layer(
        db.connection(),
        blobs,
        &nession_erofs::build::publication::LayerPublication {
            repository: repository.to_string(),
            tag: Some(tag.to_string()),
            expectation,
            layer: nession_erofs::oci::descriptor::Descriptor {
                media_type: nession_erofs::oci::annotation::MEDIA_TYPE_EROFS.to_string(),
                digest: stored.digest,
                size: stored.size_bytes,
                urls: None,
                annotations: None,
                platform: None,
                artifact_type: None,
                data: None,
                extra: serde_json::Map::new(),
            },
            platform,
            env: vec!["PATH=/usr/bin".to_string()],
            runtime: RuntimeConfig::default(),
            annotations: std::collections::BTreeMap::new(),
        },
    )
    .await
    .unwrap()
}

fn compose_source(repository: &str, destination: &str) -> ImageComposeSource {
    ImageComposeSource {
        repository: repository.to_string(),
        reference: "latest".to_string(),
        destination: destination.to_string(),
    }
}

/// SC-01/SC-02: Compose resolves each Repository reference once at submission,
/// pins the immutable sources, survives a Tag move, publishes a flattened
/// Manifest with source-vs-result provenance, and releases the build pins.
#[tokio::test]
async fn compose_pins_sources_publishes_provenance_and_survives_a_tag_move() {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::new(":memory:").await.unwrap());
    let blobs = BlobStore::new(dir.path().join("blobs")).unwrap();
    let backend = Arc::new(ComposeRecordingBackend::new(blobs.clone()));
    let manager = Arc::new(
        ImageManager::new(
            Arc::clone(&db),
            backend.clone(),
            blobs.clone(),
            options(dir.path(), 1),
        )
        .unwrap(),
    );
    let platform = nession_erofs::build::publication::host_platform();
    let base = publish_test_source(
        &db,
        &blobs,
        "src/base",
        "latest",
        b"base-layer",
        platform.clone(),
        nession_erofs::catalog::tag::TagExpectation::Absent,
    )
    .await;
    let tool = publish_test_source(
        &db,
        &blobs,
        "src/tool",
        "latest",
        b"tool-layer",
        platform.clone(),
        nession_erofs::catalog::tag::TagExpectation::Absent,
    )
    .await;
    let source = ImageSource::Compose {
        representation: ImageComposeRepresentation::Flattened,
        sources: vec![
            compose_source("src/base", ""),
            compose_source("src/tool", "/opt/tool"),
        ],
    };
    let submitted = manager
        .submit_build(&source, Some("composed"), None)
        .await
        .unwrap();
    // The Tag moves after submission. The pinned immutable identity is what
    // this build reads; a digest alone was never the authorization.
    let moved = publish_test_source(
        &db,
        &blobs,
        "src/base",
        "latest",
        b"moved-layer",
        platform,
        nession_erofs::catalog::tag::TagExpectation::Exact(base.manifest_digest.clone()),
    )
    .await;
    backend.gate.release();
    let done = manager.wait_terminal(&submitted.build_id).await.unwrap();
    assert_eq!(done.status, ImageBuildStatus::Succeeded, "{done:?}");
    let digest = done.digest.clone().unwrap();
    assert_ne!(digest, base.layer_digest);
    assert_ne!(digest, moved.layer_digest);
    let seen = backend.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        seen[0],
        vec![base.manifest_digest.clone(), tool.manifest_digest.clone()],
        "the build read the pinned sources, not the moved Tag"
    );

    let objects = nession_erofs::catalog::reference::all_objects(db.connection())
        .await
        .unwrap();
    let mut result_manifest = None;
    for object in objects {
        if object.kind != nession_erofs::catalog::reference::ObjectKind::Manifest {
            continue;
        }
        let bytes = blobs.read(&object.digest).unwrap();
        let (_, manifest) = nession_erofs::oci::parse_manifest(&bytes).unwrap();
        if manifest
            .layers
            .first()
            .is_some_and(|layer| layer.digest == digest)
        {
            result_manifest = Some(manifest);
            break;
        }
    }
    let manifest = result_manifest.expect("the flattened result Manifest");
    let annotations = manifest.annotations.expect("compose annotations");
    assert_eq!(
        annotations
            .get(nession_erofs::oci::annotation::ANNOTATION_COMPOSE_FORMAT)
            .map(String::as_str),
        Some("flattened-v1")
    );
    let provenance: Vec<nession_erofs::ComposeSourceProvenance> = serde_json::from_str(
        annotations
            .get(nession_erofs::oci::annotation::ANNOTATION_COMPOSE_SOURCES)
            .expect("compose source provenance"),
    )
    .unwrap();
    assert_eq!(
        provenance
            .iter()
            .map(|source| source.manifest_digest.as_str())
            .collect::<Vec<_>>(),
        vec![base.manifest_digest.as_str(), tool.manifest_digest.as_str()]
    );
    assert_eq!(
        nession_erofs::catalog::pin::live_pin_digests(db.connection(), now_i64())
            .await
            .unwrap(),
        Vec::<String>::new(),
        "a finished build releases its source pins"
    );
    let page = manager.list(0, 10, "").await.unwrap();
    assert_eq!(page.total, 1);
}

/// SC-02: a source that is not in the named Repository (a digest is not
/// authority) and a source with no image for the build platform both fail at
/// submission, before any build record or ready row exists.
#[tokio::test]
async fn compose_rejects_unresolvable_and_wrong_platform_sources_before_publication() {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::new(":memory:").await.unwrap());
    let blobs = BlobStore::new(dir.path().join("blobs")).unwrap();
    let backend = Arc::new(ComposeRecordingBackend::new(blobs.clone()));
    let manager = Arc::new(
        ImageManager::new(
            Arc::clone(&db),
            backend,
            blobs.clone(),
            options(dir.path(), 1),
        )
        .unwrap(),
    );
    let unresolvable = ImageSource::Compose {
        representation: ImageComposeRepresentation::Flattened,
        sources: vec![compose_source("src/missing", "")],
    };
    let error = manager
        .submit_build(&unresolvable, None, None)
        .await
        .unwrap_err();
    assert_eq!(error.kind(), "invalid");
    assert!(error.message().contains("does not resolve"), "{error}");

    let wrong = publish_test_source(
        &db,
        &blobs,
        "src/wrong",
        "latest",
        b"wrong-platform",
        Platform::for_consumer("linux", "riscv64", None),
        nession_erofs::catalog::tag::TagExpectation::Absent,
    )
    .await;
    assert_ne!(wrong.layer_digest, "");
    let compose = ImageSource::Compose {
        representation: ImageComposeRepresentation::Flattened,
        sources: vec![compose_source("src/wrong", "")],
    };
    let error = manager
        .submit_build(&compose, None, None)
        .await
        .unwrap_err();
    assert_eq!(error.kind(), "invalid");
    assert!(error.message().contains("no usable image"), "{error}");
    assert_eq!(manager.list_builds(0, 10).await.unwrap().total, 0);
    assert_eq!(manager.list(0, 10, "").await.unwrap().total, 0);
}

// ── Referenced multi-blob Composite (#3697) ─────────────────────────────

/// A backend that publishes one referenced Composite identity and records
/// the Manifest/Composite digests it handed the manager.
struct ReferencedRecordingBackend {
    blobs: BlobStore,
    manifest: StdMutex<Option<String>>,
    composite: StdMutex<Option<String>>,
}

impl ReferencedRecordingBackend {
    fn new(blobs: BlobStore) -> Self {
        Self {
            blobs,
            manifest: StdMutex::new(None),
            composite: StdMutex::new(None),
        }
    }
}

impl ImageBuildBackend for ReferencedRecordingBackend {
    fn execute(&self, execution: BuildExecution) -> Result<BuiltImage> {
        use nession_erofs::oci::composite::{
            validate_composite_manifest_config, CompositeDescriptor, COMPOSITE_ROOTFS_TYPE,
        };
        let compose = execution.compose.as_ref().expect("a compose execution");
        if compose.representation != ImageComposeRepresentation::Referenced {
            anyhow::bail!("this fixture only builds referenced composites");
        }
        let devices = compose
            .sources
            .iter()
            .map(|source| source.layer.clone())
            .collect::<Vec<_>>();
        let platform = Platform {
            architecture: compose.sources[0].config.architecture.clone(),
            os: compose.sources[0].config.os.clone(),
            os_features: compose.sources[0].config.os_features.clone(),
            variant: compose.sources[0].config.variant.clone(),
            ..Platform::default()
        };
        std::fs::create_dir_all(&execution.build_dir)?;
        let metadata_path = execution.build_dir.join("referenced.erofs.part");
        std::fs::write(&metadata_path, b"referenced metadata erofs")?;
        let metadata_blob = self.blobs.put_file(&metadata_path)?;
        let metadata = nession_erofs::oci::Descriptor {
            media_type: nession_erofs::oci::MEDIA_TYPE_EROFS.to_string(),
            digest: metadata_blob.digest.clone(),
            size: metadata_blob.size_bytes,
            urls: None,
            annotations: None,
            platform: None,
            artifact_type: None,
            data: None,
            extra: serde_json::Map::new(),
        };
        let descriptor_doc = CompositeDescriptor::new(&platform, &metadata, &devices)?;
        let descriptor_document = descriptor_doc.to_document()?;
        let descriptor_blob = self.blobs.put_bytes(descriptor_document.bytes())?;
        let descriptor = nession_erofs::oci::Descriptor {
            media_type: nession_erofs::oci::MEDIA_TYPE_COMPOSITE.to_string(),
            digest: descriptor_blob.digest.clone(),
            size: descriptor_blob.size_bytes,
            urls: None,
            annotations: None,
            platform: None,
            artifact_type: None,
            data: None,
            extra: serde_json::Map::new(),
        };
        let config = nession_erofs::oci::ImageConfig {
            created: None,
            author: None,
            architecture: platform.architecture.clone(),
            os: platform.os.clone(),
            os_version: None,
            os_features: Some(vec!["erofs".to_string()]),
            variant: platform.variant,
            config: nession_erofs::oci::RuntimeConfig::default(),
            rootfs: nession_erofs::oci::RootFs {
                fs_type: COMPOSITE_ROOTFS_TYPE.to_string(),
                diff_ids: descriptor_doc
                    .closure()?
                    .into_iter()
                    .map(|descriptor| descriptor.digest)
                    .collect(),
                extra: serde_json::Map::new(),
            },
            history: Vec::new(),
            extra: serde_json::Map::new(),
        };
        let config_document =
            nession_erofs::oci::RawDocument::from_bytes(nession_erofs::oci::to_bytes(&config)?);
        let manifest = nession_erofs::oci::Manifest {
            schema_version: 2,
            media_type: Some(nession_erofs::oci::MEDIA_TYPE_MANIFEST.to_string()),
            config: nession_erofs::oci::Descriptor {
                media_type: nession_erofs::oci::MEDIA_TYPE_CONFIG.to_string(),
                digest: config_document.digest().to_string(),
                size: config_document.size()?,
                urls: None,
                annotations: None,
                platform: None,
                artifact_type: None,
                data: None,
                extra: serde_json::Map::new(),
            },
            layers: vec![descriptor.clone()],
            subject: None,
            artifact_type: None,
            annotations: None,
            extra: serde_json::Map::new(),
        };
        validate_composite_manifest_config(&manifest, &config, &descriptor_doc, &descriptor)?;
        let manifest_document =
            nession_erofs::oci::RawDocument::from_bytes(nession_erofs::oci::to_bytes(&manifest)?);
        let size_bytes = metadata_blob
            .size_bytes
            .saturating_add(descriptor_blob.size_bytes)
            .saturating_add(config_document.size()?)
            .saturating_add(manifest_document.size()?)
            .saturating_add(devices.iter().map(|device| device.size).sum::<u64>());
        *self.manifest.lock().unwrap() = Some(manifest_document.digest().to_string());
        *self.composite.lock().unwrap() = Some(descriptor.digest.clone());
        let provenance = compose
            .sources
            .iter()
            .map(|source| nession_erofs::ComposeSourceProvenance {
                repository: source.repository.clone(),
                reference: source.reference.clone(),
                manifest_digest: source.manifest_digest.clone(),
                layer_digest: source.layer.digest.clone(),
                size_bytes: source.layer.size,
                destination: String::new(),
            })
            .collect::<Vec<_>>();
        Ok(BuiltImage {
            blob: metadata_blob,
            source_sha: None,
            packaging: ErofsPackaging::default(),
            compose: Some(nession_erofs::ComposeImageMetadata {
                runtime: nession_erofs::ComposeRuntime::default(),
                sources: provenance,
                referenced: Some(nession_erofs::ReferencedImageMetadata {
                    descriptor,
                    metadata,
                    devices,
                    config: config_document,
                    manifest: manifest_document,
                    manifest_digest: self
                        .manifest
                        .lock()
                        .unwrap()
                        .clone()
                        .expect("manifest digest"),
                    size_bytes,
                }),
            }),
        })
    }
}

/// SC-01/SC-02: a referenced Composite build publishes its own Manifest
/// identity, not a data Blob digest, and the resolved grant closure contains
/// the Composite descriptor plus every metadata/device blob.
#[tokio::test]
async fn a_referenced_composite_publishes_a_distinct_identity_and_full_closure() {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::new(":memory:").await.unwrap());
    let blobs = BlobStore::new(dir.path().join("blobs")).unwrap();
    let backend = Arc::new(ReferencedRecordingBackend::new(blobs.clone()));
    let manager = Arc::new(
        ImageManager::new(
            Arc::clone(&db),
            backend.clone(),
            blobs.clone(),
            options(dir.path(), 1),
        )
        .unwrap(),
    );
    let platform = nession_erofs::build::publication::host_platform();
    let node = publish_test_source(
        &db,
        &blobs,
        "src/node",
        "latest",
        b"node-backing-erofs",
        platform.clone(),
        nession_erofs::catalog::tag::TagExpectation::Absent,
    )
    .await;
    let dsh = publish_test_source(
        &db,
        &blobs,
        "src/dsh",
        "latest",
        b"dsh-backing-erofs",
        platform,
        nession_erofs::catalog::tag::TagExpectation::Absent,
    )
    .await;
    let source = ImageSource::Compose {
        representation: ImageComposeRepresentation::Referenced,
        sources: vec![
            compose_source("src/node", ""),
            compose_source("src/dsh", ""),
        ],
    };
    let submitted = manager.submit_build(&source, None, None).await.unwrap();
    let done = manager.wait_terminal(&submitted.build_id).await.unwrap();
    assert_eq!(done.status, ImageBuildStatus::Succeeded, "{done:?}");
    let manifest_digest = done.digest.clone().unwrap();
    let referenced_manifest = backend.manifest.lock().unwrap().clone().unwrap();
    assert_eq!(manifest_digest, referenced_manifest);
    assert_ne!(manifest_digest, node.layer_digest);
    assert_ne!(manifest_digest, dsh.layer_digest);
    let composite_digest = backend.composite.lock().unwrap().clone().unwrap();
    assert_ne!(manifest_digest, composite_digest);
    assert_eq!(
        nession_erofs::catalog::reference::get_object(db.connection(), &composite_digest)
            .await
            .unwrap()
            .map(|object| object.kind),
        Some(nession_erofs::catalog::reference::ObjectKind::Composite)
    );
    let reachable = nession_erofs::catalog::reference::reachable(
        db.connection(),
        std::slice::from_ref(&manifest_digest),
    )
    .await
    .unwrap();
    for digest in [&composite_digest, &node.layer_digest, &dsh.layer_digest] {
        assert!(reachable.contains(digest), "{digest} must be reachable");
    }

    // The Server's authorized resolution returns the whole closure.
    let resolution = manager
        .resolve_image_for(
            GrantConsumer::Session("session-1"),
            None,
            None,
            &manifest_digest,
            Some(&nession_erofs::build::publication::host_platform()),
            false,
            false,
        )
        .await
        .unwrap();
    let ImageResolution::Manifest(access) = resolution else {
        panic!("a referenced manifest must resolve as a Manifest");
    };
    let digests = access
        .objects
        .iter()
        .map(|object| object.digest.as_str())
        .collect::<Vec<_>>();
    for digest in [
        manifest_digest.as_str(),
        composite_digest.as_str(),
        node.layer_digest.as_str(),
        dsh.layer_digest.as_str(),
    ] {
        assert!(digests.contains(&digest), "{digest} must be granted");
    }
    assert_eq!(
        access.objects.len(),
        6,
        "manifest, config, descriptor, metadata and two devices"
    );
    for digest in [&composite_digest, &node.layer_digest, &dsh.layer_digest] {
        manager.ready_blob(digest).await.unwrap();
    }
}

/// A referenced build must not be followed by a legacy digest-addressed grant
/// that treats its Manifest/Composite identity as a raw EROFS payload.
#[tokio::test]
async fn a_referenced_identity_is_never_served_as_a_legacy_erofs_payload() {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::new(":memory:").await.unwrap());
    let blobs = BlobStore::new(dir.path().join("blobs")).unwrap();
    let backend = Arc::new(ReferencedRecordingBackend::new(blobs.clone()));
    let manager = Arc::new(
        ImageManager::new(
            Arc::clone(&db),
            backend.clone(),
            blobs.clone(),
            options(dir.path(), 1),
        )
        .unwrap(),
    );
    let platform = nession_erofs::build::publication::host_platform();
    let node = publish_test_source(
        &db,
        &blobs,
        "src/node",
        "latest",
        b"node-backing-erofs",
        platform,
        nession_erofs::catalog::tag::TagExpectation::Absent,
    )
    .await;
    let source = ImageSource::Compose {
        representation: ImageComposeRepresentation::Referenced,
        sources: vec![compose_source("src/node", "")],
    };
    let submitted = manager.submit_build(&source, None, None).await.unwrap();
    let done = manager.wait_terminal(&submitted.build_id).await.unwrap();
    let manifest_digest = done.digest.clone().unwrap();
    let legacy = manager
        .legacy_image_resolution(
            &GrantConsumer::Session("session-1"),
            &manifest_digest,
            None,
            false,
        )
        .await
        .unwrap();
    assert!(
        legacy.is_none(),
        "a Manifest/Composite identity is not a legacy raw EROFS payload"
    );
    assert_ne!(manifest_digest, node.layer_digest);
}
