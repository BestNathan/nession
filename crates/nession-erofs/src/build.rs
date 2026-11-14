//! Deterministic EROFS build from a controlled snapshot (#3022, #3334).
//!
//! The builder runs only Git plumbing and `mkfs.erofs`. It never executes
//! repository code, hooks or package scripts. Packaging parameters are fixed by
//! the V1 contract and are recorded beside the digest, so a rebuilt source tree
//! with the same inputs produces the same immutable bytes.
//!
//! # Stages and checkpoints (#3334)
//!
//! A build is a sequence of explicit stages: fetch/copy the source, validate
//! and hash the private snapshot, package it with `mkfs.erofs`, then publish the
//! bytes. The completed snapshot is recorded in `snapshot.json` with its source
//! identity, packaging identity and content manifest. A later attempt may reuse
//! that snapshot only after re-verifying the manifest; an interrupted
//! `mkfs.erofs` output (`image.erofs.part`) is never trusted or published.
//!
//! Every owned Git/`mkfs.erofs` subprocess is executed through
//! [`ProcessControl`], which bounds its wall time, forwards cancellation by
//! terminating and reaping it, and reports its first diagnostic line. Dropping a
//! Tokio future is not how this builder cancels work.
//!
//! Source acquisition adapters (#3497) live in the gated submodules:
//! bounded archive/HTTPS inputs, raw EROFS import, the external OCI conversion
//! boundary, and the standard Config/Manifest publication helper. None of them
//! executes input content.

#[cfg(feature = "sources")]
pub mod archive;
#[cfg(feature = "sources")]
pub mod import;
#[cfg(feature = "sources")]
pub mod oci;
#[cfg(feature = "sources")]
pub mod publication;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::digest::DIGEST_PREFIX;
use crate::git::{self, GitCommandRunner, GitTarget};
use crate::store::{BlobDigest, BlobStore};

/// The fixed filesystem UUID V1 passes to `mkfs.erofs`.
///
/// The wire contract (`nession-protocol`) owns the accepted V1 value; this is
/// the builder's mechanical constant for the same bytes.
pub const FIXED_UUID: &str = "11111111-1111-4111-8111-111111111111";
/// The only block size V1 accepts.
pub const BLOCK_SIZE: u32 = 4096;
/// The fixed timestamp V1 passes to `mkfs.erofs`.
pub const FIXED_TIMESTAMP: i64 = 0;
/// The only compression mode V1 accepts.
pub const COMPRESSION: &str = "none";

/// Mechanical packaging inputs for one deterministic build.
///
/// This is the builder's own type; `nession-protocol`'s versioned
/// `ImagePackaging` DTO is translated by the runtime adapter after wire
/// validation. Keeping the builder free of wire types is what lets a non-
/// Nession consumer build the same bytes without the Protocol Kernel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Packaging {
    pub block_size: u32,
    pub compression: String,
    pub fixed_timestamp: i64,
    pub fixed_uuid: String,
}

impl Default for Packaging {
    fn default() -> Self {
        Self {
            block_size: BLOCK_SIZE,
            compression: COMPRESSION.to_string(),
            fixed_timestamp: FIXED_TIMESTAMP,
            fixed_uuid: FIXED_UUID.to_string(),
        }
    }
}

impl Packaging {
    /// The invariants `mkfs.erofs` itself needs. Wire-specific rejection stays
    /// in the Protocol Kernel's `validate_packaging`.
    pub fn validate(&self) -> Result<()> {
        if self.block_size == 0 {
            anyhow::bail!("EROFS packaging block size must be positive");
        }
        if self.compression.trim().is_empty() {
            anyhow::bail!("EROFS packaging compression must not be empty");
        }
        if self.fixed_uuid.trim().is_empty() {
            anyhow::bail!("EROFS packaging UUID must not be empty");
        }
        Ok(())
    }
}

/// The maximum bytes one snapshot may contain before `mkfs.erofs` runs.
pub const MAX_SNAPSHOT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// The maximum entries one snapshot may contain.
pub const MAX_SNAPSHOT_ENTRIES: u64 = 200_000;

/// One produced image and the inputs that determine its digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltImage {
    pub blob: BlobDigest,
    pub source_sha: Option<String>,
    pub packaging: Packaging,
}

// ── Stages and observation ──────────────────────────────────────────────

/// The explicit stage a build is executing (#3334).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    /// Resolving/fetching a Git source into the private snapshot.
    Fetching,
    /// Copying a local directory into the private snapshot.
    Snapshotting,
    /// Scanning, bounds-checking and hashing the snapshot manifest.
    Validating,
    /// Running `mkfs.erofs` into `image.erofs.part`.
    Packaging,
    /// Publishing the verified final bytes into the blob store.
    Publishing,
}

impl Stage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fetching => "fetching",
            Self::Snapshotting => "snapshotting",
            Self::Validating => "validating",
            Self::Packaging => "packaging",
            Self::Publishing => "publishing",
        }
    }
}

/// Measured tree counts. Never a fabricated percentage: a `mkfs.erofs` stage
/// with no native progress reports an elapsed time and no fraction.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TreeStats {
    /// Every directory entry below the snapshot root.
    pub entries: u64,
    /// Regular files below the snapshot root.
    pub files: u64,
    /// Sum of regular file sizes.
    pub bytes: u64,
}

/// Receives stage transitions and measured progress from the builder.
///
/// The observer runs on the build's blocking thread; an implementation that
/// persists state must do so durably before returning.
pub trait BuildObserver: Send + Sync {
    fn stage(&self, _stage: Stage) {}
    /// The immutable commit a Git branch resolved to for this build.
    fn pinned_source(&self, _sha: &str) {}
    /// A completed, manifest-verified snapshot that packaging may reuse.
    fn snapshot_ready(&self, _checkpoint: &SnapshotCheckpoint) {}
    fn progress(&self, _stats: &TreeStats) {}
    /// One bounded diagnostic line (usually a subprocess failure).
    fn diagnostic(&self, _message: &str) {}
}

/// A no-op observer for direct builder use.
#[derive(Debug, Clone, Copy)]
pub struct NoopObserver;

impl BuildObserver for NoopObserver {}

// ── Subprocess control ──────────────────────────────────────────────────

/// Owns cancellation and a wall-time bound for one build's subprocesses.
///
/// `Command::output()` cannot be interrupted. Every Git and `mkfs.erofs`
/// invocation therefore registers with this control: [`ProcessControl::cancel`]
/// makes the owning run loop kill and reap its child, and the timeout enforces a
/// bounded wall time even when the caller stays connected.
#[derive(Debug)]
pub struct ProcessControl {
    canceled: AtomicBool,
    timeout: Option<Duration>,
}

impl Default for ProcessControl {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessControl {
    pub fn new() -> Self {
        Self {
            canceled: AtomicBool::new(false),
            timeout: None,
        }
    }

    /// A control whose every subprocess is killed after `timeout`.
    pub fn with_timeout(timeout: Duration) -> Self {
        Self {
            canceled: AtomicBool::new(false),
            timeout: Some(timeout),
        }
    }

    /// Request termination. The running child is killed and reaped by the run
    /// loop, normally within one polling interval.
    pub fn cancel(&self) {
        self.canceled.store(true, Ordering::SeqCst);
    }

    pub fn is_canceled(&self) -> bool {
        self.canceled.load(Ordering::SeqCst)
    }

    /// Run one bounded subprocess and return its trimmed stdout.
    ///
    /// The child's stdout/stderr are drained on helper threads (each capped) so a
    /// chatty process cannot block on a full pipe. Cancellation and timeout kill
    /// and wait for the child before returning an error.
    pub(crate) fn execute(&self, command: &mut Command, description: &str) -> Result<String> {
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| format!("failed to execute {description}"))?;
        let stdout = child.stdout.take().map(bounded_reader);
        let stderr = child.stderr.take().map(bounded_reader);
        let started = Instant::now();
        let status = loop {
            if self.canceled.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                let _ = join_reader(stdout);
                let _ = join_reader(stderr);
                anyhow::bail!("build was canceled while running {description}");
            }
            if let Some(timeout) = self.timeout {
                if started.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = join_reader(stdout);
                    let _ = join_reader(stderr);
                    anyhow::bail!(
                        "{description} exceeded its {} second wall-time bound",
                        timeout.as_secs()
                    );
                }
            }
            match child
                .try_wait()
                .with_context(|| format!("failed to wait for {description}"))?
            {
                Some(status) => break status,
                None => std::thread::sleep(Duration::from_millis(10)),
            }
        };
        let stdout = join_reader(stdout);
        let stderr = join_reader(stderr);
        if !status.success() {
            let text = String::from_utf8_lossy(&stderr);
            let first = text
                .trim()
                .lines()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("unknown error");
            let bounded: String = first.chars().take(512).collect();
            anyhow::bail!("{description} failed: {bounded}");
        }
        Ok(String::from_utf8_lossy(&stdout).trim().to_string())
    }
}

/// The most bytes retained from one subprocess stream. The rest is drained and
/// discarded, so the process never blocks on a full pipe and a hostile source
/// cannot grow memory without bound.
const SUBPROCESS_CAPTURE_BYTES: usize = 64 * 1024;

fn bounded_reader(mut pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut buffer = [0_u8; 8192];
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let room = SUBPROCESS_CAPTURE_BYTES.saturating_sub(kept.len());
                    if room > 0 {
                        kept.extend_from_slice(buffer.get(..read.min(room)).unwrap_or_default());
                    }
                }
            }
        }
        kept
    })
}

fn join_reader(handle: Option<std::thread::JoinHandle<Vec<u8>>>) -> Vec<u8> {
    handle
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default()
}

/// Runs `mkfs.erofs`. Tests substitute a deterministic fake; production uses
/// the host binary.
pub trait MkfsRunner: Send + Sync {
    fn run(&self, args: &[String], control: &ProcessControl) -> Result<()>;
}

/// The host `mkfs.erofs`.
#[derive(Debug, Clone)]
pub struct ProcessMkfsRunner {
    pub binary: PathBuf,
}

impl Default for ProcessMkfsRunner {
    fn default() -> Self {
        Self {
            binary: PathBuf::from("mkfs.erofs"),
        }
    }
}

impl MkfsRunner for ProcessMkfsRunner {
    fn run(&self, args: &[String], control: &ProcessControl) -> Result<()> {
        let mut command = Command::new(&self.binary);
        command
            .args(args)
            .env("SOURCE_DATE_EPOCH", "0")
            .env("TZ", "UTC")
            .env("LC_ALL", "C");
        control.execute(&mut command, &self.binary.display().to_string())?;
        Ok(())
    }
}

// ── Snapshot checkpoint ─────────────────────────────────────────────────

/// The private snapshot directory below a build directory.
pub const SNAPSHOT_DIR: &str = "snapshot";
/// The durable snapshot checkpoint below a build directory.
pub const SNAPSHOT_CHECKPOINT_FILE: &str = "snapshot.json";
/// The in-progress `mkfs.erofs` output; never published while incomplete.
pub const PACKAGED_IMAGE_FILE: &str = "image.erofs.part";
/// The only checkpoint format version this crate reads.
pub const SNAPSHOT_CHECKPOINT_VERSION: u32 = 1;

pub fn snapshot_dir(build_dir: &Path) -> PathBuf {
    build_dir.join(SNAPSHOT_DIR)
}

pub fn snapshot_checkpoint_path(build_dir: &Path) -> PathBuf {
    build_dir.join(SNAPSHOT_CHECKPOINT_FILE)
}

pub fn packaged_image_path(build_dir: &Path) -> PathBuf {
    build_dir.join(PACKAGED_IMAGE_FILE)
}

/// The canonical source identity a snapshot was produced from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SnapshotSource {
    GitHub {
        repository_url: String,
        reference: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        requested_sha: Option<String>,
    },
    LocalDirectory {
        path: String,
    },
}

/// The durable proof that a snapshot completed and is safe to reuse.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotCheckpoint {
    pub version: u32,
    pub source: SnapshotSource,
    pub packaging: Packaging,
    /// The immutable commit this build pinned the source to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_sha: Option<String>,
    /// `sha256:<64 hex>` of the deterministic tree manifest.
    pub manifest: String,
    pub entries: u64,
    pub files: u64,
    pub bytes: u64,
}

fn read_checkpoint(build_dir: &Path) -> Result<Option<SnapshotCheckpoint>> {
    let path = snapshot_checkpoint_path(build_dir);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("failed to read {}", path.display()))
        }
    };
    let checkpoint: SnapshotCheckpoint = serde_json::from_str(&text)
        .with_context(|| format!("snapshot checkpoint {} is not valid JSON", path.display()))?;
    if checkpoint.version != SNAPSHOT_CHECKPOINT_VERSION {
        anyhow::bail!(
            "snapshot checkpoint version {} is not supported",
            checkpoint.version
        );
    }
    Ok(Some(checkpoint))
}

fn write_checkpoint(build_dir: &Path, checkpoint: &SnapshotCheckpoint) -> Result<()> {
    let path = snapshot_checkpoint_path(build_dir);
    let temp = build_dir.join(format!(
        "{SNAPSHOT_CHECKPOINT_FILE}.tmp-{}",
        uuid::Uuid::new_v4()
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .with_context(|| format!("failed to create {}", temp.display()))?;
    let json = serde_json::to_vec(checkpoint).context("failed to encode snapshot checkpoint")?;
    file.write_all(&json)
        .with_context(|| format!("failed to write {}", temp.display()))?;
    file.sync_all()
        .with_context(|| format!("failed to fsync {}", temp.display()))?;
    drop(file);
    fs::rename(&temp, &path)
        .with_context(|| format!("failed to publish snapshot checkpoint {}", path.display()))?;
    sync_directory(build_dir);
    Ok(())
}

/// Best-effort durable directory entry.
fn sync_directory(path: &Path) {
    if let Ok(directory) = File::open(path) {
        let _ = directory.sync_all();
    }
}

/// Load and fully verify a snapshot checkpoint for this exact source and
/// packaging identity.
///
/// `Ok(None)` means no checkpoint exists. An unreadable, mis-versioned,
/// identity-mismatched or content-mismatched checkpoint is an explicit error:
/// the caller must never silently reuse it.
pub fn verify_snapshot(
    build_dir: &Path,
    expected_source: &SnapshotSource,
    expected_packaging: &Packaging,
) -> Result<Option<SnapshotCheckpoint>> {
    let Some(checkpoint) = read_checkpoint(build_dir)? else {
        return Ok(None);
    };
    if &checkpoint.source != expected_source {
        anyhow::bail!("snapshot checkpoint source identity does not match this build");
    }
    if &checkpoint.packaging != expected_packaging {
        anyhow::bail!("snapshot checkpoint packaging identity does not match this build");
    }
    let dir = snapshot_dir(build_dir);
    if !dir.is_dir() {
        anyhow::bail!("snapshot checkpoint has no snapshot directory");
    }
    let manifest = manifest_tree(&dir)?;
    if manifest.digest != checkpoint.manifest
        || manifest.stats.entries != checkpoint.entries
        || manifest.stats.files != checkpoint.files
        || manifest.stats.bytes != checkpoint.bytes
    {
        anyhow::bail!("snapshot checkpoint does not match the snapshot content");
    }
    Ok(Some(checkpoint))
}

/// Remove the scratch artifacts of a successful build.
pub fn discard_snapshot_artifacts(build_dir: &Path) -> Result<()> {
    let dir = snapshot_dir(build_dir);
    if dir.exists() {
        fs::remove_dir_all(&dir).with_context(|| format!("failed to remove {}", dir.display()))?;
    }
    let checkpoint = snapshot_checkpoint_path(build_dir);
    if checkpoint.exists() {
        fs::remove_file(&checkpoint)
            .with_context(|| format!("failed to remove {}", checkpoint.display()))?;
    }
    let image = packaged_image_path(build_dir);
    if image.exists() {
        fs::remove_file(&image).with_context(|| format!("failed to remove {}", image.display()))?;
    }
    Ok(())
}

/// Remove an incomplete packaged image. Callers invoke this before rerunning
/// packaging; a partial `mkfs.erofs` output is never trusted.
pub fn discard_packaged_image(build_dir: &Path) -> Result<()> {
    let image = packaged_image_path(build_dir);
    match fs::remove_file(&image) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("failed to remove {}", image.display())),
    }
}

// ── Deterministic tree manifest ─────────────────────────────────────────

/// The deterministic identity of one snapshot tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeManifest {
    pub digest: String,
    pub stats: TreeStats,
}

/// Scan a snapshot tree exactly once: enforce the V1 safety bounds and compute
/// its deterministic manifest.
///
/// The digest covers every relative path and kind, permission bits, symlink
/// targets (never followed) and regular-file content, so any changed, added,
/// removed or re-typed entry changes the manifest.
pub fn manifest_tree(root: &Path) -> Result<TreeManifest> {
    let mut state = ManifestState {
        hasher: Sha256::new(),
        stats: TreeStats::default(),
    };
    scan_manifest(root, root, &mut state)?;
    Ok(TreeManifest {
        digest: format!("{DIGEST_PREFIX}{:x}", state.hasher.finalize()),
        stats: state.stats,
    })
}

struct ManifestState {
    hasher: Sha256,
    stats: TreeStats,
}

fn path_bytes(path: &Path) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().to_vec()
    }
    #[cfg(not(unix))]
    {
        path.to_string_lossy().as_bytes().to_vec()
    }
}

#[cfg(unix)]
fn mode_bits(metadata: &fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o777
}

#[cfg(not(unix))]
fn mode_bits(_metadata: &fs::Metadata) -> u32 {
    0
}

fn scan_manifest(root: &Path, current: &Path, state: &mut ManifestState) -> Result<()> {
    let mut entries = fs::read_dir(current)
        .with_context(|| format!("failed to read {}", current.display()))?
        .collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        state.stats.entries += 1;
        if state.stats.entries > MAX_SNAPSHOT_ENTRIES {
            anyhow::bail!("image source exceeds the entry bound");
        }
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| anyhow::anyhow!("snapshot path escaped its root"))?;
        let metadata = fs::symlink_metadata(&path)?;
        // One unambiguous record per entry: relative path, kind, mode.
        state.hasher.update(path_bytes(relative));
        state.hasher.update([0_u8]);
        state.hasher.update(mode_bits(&metadata).to_le_bytes());
        if metadata.file_type().is_symlink() {
            state.hasher.update(b"l");
            let target = fs::read_link(&path)?;
            if target.is_absolute() {
                anyhow::bail!("absolute symlink is not allowed in an image source");
            }
            let parent = path.parent().unwrap_or(root);
            let resolved = parent.join(&target);
            let normalized = normalize_without_fs(&resolved);
            if !normalized.starts_with(root) {
                anyhow::bail!("symlink escapes the image snapshot");
            }
            state.hasher.update(path_bytes(&target));
        } else if metadata.is_dir() {
            state.hasher.update(b"d");
            scan_manifest(root, &path, state)?;
        } else if metadata.is_file() {
            state.hasher.update(b"f");
            state.stats.files += 1;
            state.stats.bytes = state.stats.bytes.saturating_add(metadata.len());
            if state.stats.bytes > MAX_SNAPSHOT_BYTES {
                anyhow::bail!("image source exceeds the byte bound");
            }
            state.hasher.update(metadata.len().to_le_bytes());
            hash_file_contents(&path, &mut state.hasher)?;
        } else {
            anyhow::bail!(
                "special file is not allowed in an image source: {}",
                path.display()
            );
        }
        state.hasher.update([0x1e_u8]);
    }
    Ok(())
}

fn hash_file_contents(path: &Path, hasher: &mut Sha256) -> Result<()> {
    let mut file = File::open(path)
        .with_context(|| format!("failed to read snapshot file {}", path.display()))?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .with_context(|| format!("failed to read snapshot file {}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(buffer.get(..read).unwrap_or_default());
    }
    Ok(())
}

// ── Builder ─────────────────────────────────────────────────────────────

/// The furthest trustworthy completed stage an attempt resumes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumePoint {
    /// No reusable snapshot exists; fetch/copy and validate the source again.
    Source,
    /// A verified snapshot exists; rerun only `mkfs.erofs` and publication.
    Packaging,
}

/// The mechanical source for one build.
#[derive(Debug, Clone)]
pub enum BuildSource<'a> {
    GitHub {
        repository_url: &'a str,
        /// The originally requested branch or full SHA.
        reference: &'a str,
        requested_sha: Option<&'a str>,
        /// The commit this build already pinned, when a prior attempt resolved it.
        pinned_sha: Option<&'a str>,
    },
    LocalDirectory {
        path: &'a Path,
    },
}

impl BuildSource<'_> {
    /// The canonical identity recorded in the snapshot checkpoint.
    pub fn snapshot_identity(&self) -> SnapshotSource {
        match self {
            Self::GitHub {
                repository_url,
                reference,
                requested_sha,
                ..
            } => SnapshotSource::GitHub {
                repository_url: (*repository_url).to_string(),
                reference: (*reference).to_string(),
                requested_sha: requested_sha.map(str::to_string),
            },
            Self::LocalDirectory { path } => SnapshotSource::LocalDirectory {
                path: path.to_string_lossy().into_owned(),
            },
        }
    }
}

/// One build execution request.
pub struct BuildRequest<'a> {
    /// The durable build directory this execution owns.
    pub build_dir: &'a Path,
    pub source: BuildSource<'a>,
    pub packaging: &'a Packaging,
    pub resume: ResumePoint,
    pub control: &'a ProcessControl,
    pub observer: &'a dyn BuildObserver,
}

/// The complete build composition.
#[derive(Clone)]
pub struct ErofsBuilder {
    pub git: Arc<dyn GitCommandRunner>,
    pub mkfs: Arc<dyn MkfsRunner>,
    pub blobs: BlobStore,
    pub work_root: PathBuf,
}

impl ErofsBuilder {
    pub fn new(
        git: Arc<dyn GitCommandRunner>,
        mkfs: Arc<dyn MkfsRunner>,
        blobs: BlobStore,
        work_root: impl Into<PathBuf>,
    ) -> Result<Self> {
        let work_root = work_root.into();
        fs::create_dir_all(&work_root).with_context(|| {
            format!(
                "failed to create image build directory {}",
                work_root.display()
            )
        })?;
        Ok(Self {
            git,
            mkfs,
            blobs,
            work_root,
        })
    }

    /// Build a Git source into the content-addressed store.
    ///
    /// Retained for direct callers and tests; the Server drives [`Self::run`]
    /// through its durable build directory.
    pub fn build_git(&self, target: &GitTarget, packaging: &Packaging) -> Result<BuiltImage> {
        packaging.validate()?;
        let work = tempfile::Builder::new()
            .prefix("nession-erofs-git-")
            .tempdir_in(&self.work_root)
            .context("failed to create image build workspace")?;
        self.run(BuildRequest {
            build_dir: work.path(),
            source: BuildSource::GitHub {
                repository_url: &target.repository_url,
                reference: &target.reference,
                requested_sha: target.requested_sha.as_deref(),
                pinned_sha: target.requested_sha.as_deref(),
            },
            packaging,
            resume: ResumePoint::Source,
            control: &ProcessControl::new(),
            observer: &NoopObserver,
        })
    }

    /// Build a validated local directory/bundle into the store.
    ///
    /// The source is copied with symlinks preserved but never followed, then
    /// scanned; the build reads the private copy, not the mutable input.
    pub fn build_local(&self, source: &Path, packaging: &Packaging) -> Result<BuiltImage> {
        packaging.validate()?;
        let work = tempfile::Builder::new()
            .prefix("nession-erofs-local-")
            .tempdir_in(&self.work_root)
            .context("failed to create image build workspace")?;
        self.run(BuildRequest {
            build_dir: work.path(),
            source: BuildSource::LocalDirectory { path: source },
            packaging,
            resume: ResumePoint::Source,
            control: &ProcessControl::new(),
            observer: &NoopObserver,
        })
    }

    /// Execute one stage-level build inside `request.build_dir`.
    ///
    /// The directory belongs to the caller and is not cleaned up here: the
    /// durable owner decides when a completed snapshot or a failed attempt is
    /// retained or released.
    pub fn run(&self, request: BuildRequest<'_>) -> Result<BuiltImage> {
        request.packaging.validate()?;
        fs::create_dir_all(request.build_dir).with_context(|| {
            format!(
                "failed to create build directory {}",
                request.build_dir.display()
            )
        })?;
        let identity = request.source.snapshot_identity();

        match request.resume {
            ResumePoint::Packaging => {
                // A resume starts only from a fully verified checkpoint. The
                // partial `image.erofs.part` left by the interrupted attempt is
                // discarded and never republished.
                let Some(checkpoint) =
                    verify_snapshot(request.build_dir, &identity, request.packaging)?
                else {
                    anyhow::bail!(
                        "no validated snapshot checkpoint exists; this build cannot resume from packaging"
                    );
                };
                let source_sha = checkpoint.pinned_sha;
                self.package_and_publish(&request, source_sha)
            }
            ResumePoint::Source => {
                let checkpoint = self.prepare_snapshot(&request, &identity)?;
                self.package_and_publish(&request, checkpoint.pinned_sha)
            }
        }
    }

    fn prepare_snapshot(
        &self,
        request: &BuildRequest<'_>,
        identity: &SnapshotSource,
    ) -> Result<SnapshotCheckpoint> {
        let dir = snapshot_dir(request.build_dir);
        if dir.exists() {
            match &request.source {
                // A Git source is content-addressed: re-materializing the same
                // pinned commit is deterministic, so an unusable scratch
                // snapshot is discarded and fetched again.
                BuildSource::GitHub { .. } => {
                    fs::remove_dir_all(&dir)
                        .with_context(|| format!("failed to reset {}", dir.display()))?;
                }
                // A local directory has no immutable identity. Re-copying a
                // possibly changed source would silently alter the result, so
                // an unusable snapshot is an explicit failure.
                BuildSource::LocalDirectory { .. } => {
                    anyhow::bail!(
                        "local source has no validated snapshot; a new build is required"
                    );
                }
            }
        }

        let checkpoint = match &request.source {
            BuildSource::GitHub {
                repository_url,
                reference,
                requested_sha,
                pinned_sha,
            } => {
                request.observer.stage(Stage::Fetching);
                let target = match pinned_sha {
                    Some(sha) => GitTarget {
                        repository_url: (*repository_url).to_string(),
                        reference: (*sha).to_string(),
                        requested_sha: Some((*sha).to_string()),
                    },
                    None => GitTarget {
                        repository_url: (*repository_url).to_string(),
                        reference: (*reference).to_string(),
                        requested_sha: requested_sha.map(str::to_string),
                    },
                };
                let snapshot = git::materialize(&target, &dir, self.git.as_ref(), request.control)?;
                request.observer.pinned_source(&snapshot.commit_sha);
                request.observer.stage(Stage::Validating);
                let manifest = manifest_tree(&dir)?;
                request.observer.progress(&manifest.stats);
                let checkpoint = SnapshotCheckpoint {
                    version: SNAPSHOT_CHECKPOINT_VERSION,
                    source: identity.clone(),
                    packaging: request.packaging.clone(),
                    pinned_sha: Some(snapshot.commit_sha),
                    manifest: manifest.digest,
                    entries: manifest.stats.entries,
                    files: manifest.stats.files,
                    bytes: manifest.stats.bytes,
                };
                write_checkpoint(request.build_dir, &checkpoint)?;
                checkpoint
            }
            BuildSource::LocalDirectory { path } => {
                request.observer.stage(Stage::Snapshotting);
                let metadata = fs::symlink_metadata(path).with_context(|| {
                    format!("local image source is not readable: {}", path.display())
                })?;
                if !metadata.is_dir() {
                    anyhow::bail!("local image source must be a directory: {}", path.display());
                }
                copy_tree(path, &dir)?;
                request.observer.stage(Stage::Validating);
                let manifest = manifest_tree(&dir)?;
                request.observer.progress(&manifest.stats);
                let checkpoint = SnapshotCheckpoint {
                    version: SNAPSHOT_CHECKPOINT_VERSION,
                    source: identity.clone(),
                    packaging: request.packaging.clone(),
                    pinned_sha: None,
                    manifest: manifest.digest,
                    entries: manifest.stats.entries,
                    files: manifest.stats.files,
                    bytes: manifest.stats.bytes,
                };
                write_checkpoint(request.build_dir, &checkpoint)?;
                checkpoint
            }
        };
        request.observer.snapshot_ready(&checkpoint);
        Ok(checkpoint)
    }

    fn package_and_publish(
        &self,
        request: &BuildRequest<'_>,
        source_sha: Option<String>,
    ) -> Result<BuiltImage> {
        if request.control.is_canceled() {
            anyhow::bail!("build was canceled");
        }
        request.observer.stage(Stage::Packaging);
        discard_packaged_image(request.build_dir)?;
        let snapshot = snapshot_dir(request.build_dir);
        let image = packaged_image_path(request.build_dir);
        let args = mkfs_command(&image, &snapshot, request.packaging);
        self.mkfs.run(&args, request.control)?;
        let metadata = fs::metadata(&image)
            .with_context(|| format!("mkfs.erofs produced no image at {}", image.display()))?;
        if metadata.len() == 0 {
            anyhow::bail!("mkfs.erofs produced an empty image");
        }
        if request.control.is_canceled() {
            anyhow::bail!("build was canceled");
        }
        request.observer.stage(Stage::Publishing);
        if request.control.is_canceled() {
            anyhow::bail!("build was canceled");
        }
        let blob = self.blobs.put_file(&image)?;
        self.blobs.verify(&blob.digest)?;
        Ok(BuiltImage {
            blob,
            source_sha,
            packaging: request.packaging.clone(),
        })
    }
}

/// The exact `mkfs.erofs` argv V1 emits, published for tests and operators.
pub fn mkfs_command(image: &Path, root: &Path, packaging: &Packaging) -> Vec<String> {
    let mut args = vec![
        "-T".to_string(),
        packaging.fixed_timestamp.to_string(),
        "-U".to_string(),
        packaging.fixed_uuid.clone(),
        "-b".to_string(),
        packaging.block_size.to_string(),
    ];
    // erofs-utils has no `-z none`; uncompressed is the default. V1 only
    // accepts "none", so this branch is intentionally unreachable today and
    // keeps the command honest if a future version adds a compressor.
    if packaging.compression != "none" {
        args.push("-z".to_string());
        args.push(packaging.compression.clone());
    }
    args.push(image.to_string_lossy().into_owned());
    args.push(root.to_string_lossy().into_owned());
    args
}

/// The fixed UUID V1 uses, published so tests do not restate it.
pub fn fixed_uuid() -> &'static str {
    FIXED_UUID
}

/// Copy a tree without following symlinks. Directories are created 0o755,
/// files 0o644, and symlinks are recreated verbatim; `manifest_tree` then
/// rejects any link that escapes the snapshot.
pub fn copy_tree(source: &Path, dest: &Path) -> Result<()> {
    fs::create_dir_all(dest)?;
    let mut entries = fs::read_dir(source)
        .with_context(|| format!("failed to read {}", source.display()))?
        .collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let from = entry.path();
        let to = dest.join(entry.file_name());
        let metadata = fs::symlink_metadata(&from)?;
        if metadata.file_type().is_symlink() {
            let target = fs::read_link(&from)?;
            create_symlink(&target, &to)?;
        } else if metadata.is_dir() {
            copy_tree(&from, &to)?;
        } else if metadata.is_file() {
            fs::copy(&from, &to).with_context(|| format!("failed to copy {}", from.display()))?;
        } else {
            anyhow::bail!(
                "unsupported special file in image source: {}",
                from.display()
            );
        }
    }
    Ok(())
}

#[cfg(unix)]
fn create_symlink(target: &Path, link: &Path) -> Result<()> {
    std::os::unix::fs::symlink(target, link)
        .with_context(|| format!("failed to recreate symlink {}", link.display()))
}

#[cfg(not(unix))]
fn create_symlink(_target: &Path, _link: &Path) -> Result<()> {
    anyhow::bail!(
        "symlinks in image sources are not supported on this platform: {}",
        _link.display()
    )
}

/// Reject snapshot content that could make a build read outside its input or
/// embed a special device: absolute/escaping symlinks, special files, and
/// oversized trees.
pub fn assert_tree_is_safe(root: &Path) -> Result<()> {
    manifest_tree(root).map(|_| ())
}

/// Lexically normalize `.` and `..` without touching the filesystem, so a
/// symlink target is judged as the checkout would resolve it.
fn normalize_without_fs(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A deterministic fake `mkfs.erofs`: the image bytes are a hash of the
    /// snapshot's relative paths and file bytes. Real EROFS bytes are produced
    /// by the integration test/Case when erofs-utils is present.
    #[derive(Default)]
    struct FakeMkfs {
        calls: Mutex<Vec<Vec<String>>>,
    }

    impl MkfsRunner for FakeMkfs {
        fn run(&self, args: &[String], _control: &ProcessControl) -> Result<()> {
            self.calls.lock().unwrap().push(args.to_vec());
            let image = Path::new(args.get(args.len() - 2).unwrap());
            let root = Path::new(args.last().unwrap());
            let mut bytes = Vec::new();
            collect_bytes(root, &mut bytes)?;
            fs::write(image, bytes)?;
            Ok(())
        }
    }

    fn collect_bytes(current: &Path, out: &mut Vec<u8>) -> Result<()> {
        let mut entries = fs::read_dir(current)?.collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            let path = entry.path();
            out.extend_from_slice(entry.file_name().to_string_lossy().as_bytes());
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.is_dir() {
                collect_bytes(&path, out)?;
            } else if metadata.is_file() {
                out.extend_from_slice(&fs::read(&path)?);
            }
        }
        Ok(())
    }

    fn test_builder(root: &Path, mkfs: Arc<dyn MkfsRunner>) -> ErofsBuilder {
        ErofsBuilder::new(
            Arc::new(crate::git::ProcessGitRunner::default()),
            mkfs,
            BlobStore::new(root.join("blobs")).unwrap(),
            root.join("work"),
        )
        .unwrap()
    }

    fn local_source(root: &Path) -> PathBuf {
        let source = root.join("source");
        fs::create_dir_all(source.join("sub")).unwrap();
        fs::write(source.join("a.txt"), b"alpha").unwrap();
        fs::write(source.join("sub/b.txt"), b"beta").unwrap();
        source
    }

    #[test]
    fn repeated_local_builds_have_one_digest_and_reuse_one_blob() {
        let root = tempfile::tempdir().unwrap();
        let source = local_source(root.path());
        let mkfs = Arc::new(FakeMkfs::default());
        let builder = test_builder(root.path(), mkfs);
        let first = builder.build_local(&source, &Packaging::default()).unwrap();
        let second = builder.build_local(&source, &Packaging::default()).unwrap();
        assert_eq!(first.blob.digest, second.blob.digest);
        assert_eq!(first.blob.path, second.blob.path);
        assert_eq!(first.source_sha, None);
    }

    #[test]
    fn a_changed_source_revision_has_a_different_digest() {
        let root = tempfile::tempdir().unwrap();
        let source = local_source(root.path());
        let builder = test_builder(root.path(), Arc::new(FakeMkfs::default()));
        let first = builder.build_local(&source, &Packaging::default()).unwrap();
        fs::write(source.join("a.txt"), b"changed").unwrap();
        let second = builder.build_local(&source, &Packaging::default()).unwrap();
        assert_ne!(first.blob.digest, second.blob.digest);
        assert!(first.blob.path.exists());
        assert!(second.blob.path.exists());
    }

    #[test]
    fn the_mkfs_argv_is_fixed_and_deterministic() {
        let args = mkfs_command(
            Path::new("/tmp/image.erofs"),
            Path::new("/tmp/snapshot"),
            &Packaging::default(),
        );
        assert_eq!(
            args,
            vec![
                "-T",
                "0",
                "-U",
                fixed_uuid(),
                "-b",
                "4096",
                "/tmp/image.erofs",
                "/tmp/snapshot",
            ]
        );
    }

    #[test]
    fn a_missing_mkfs_helper_fails_explicitly() {
        // A packaging regression must surface as a failed build, never as a
        // healthy image manager with a silently absent tool (#3178).
        let root = tempfile::tempdir().unwrap();
        let source = local_source(root.path());
        let builder = ErofsBuilder::new(
            Arc::new(crate::git::ProcessGitRunner::default()),
            Arc::new(ProcessMkfsRunner {
                binary: root.path().join("missing-mkfs.erofs"),
            }),
            BlobStore::new(root.path().join("blobs")).unwrap(),
            root.path().join("work"),
        )
        .unwrap();
        let error = builder
            .build_local(&source, &Packaging::default())
            .unwrap_err();
        let text = format!("{error:#}");
        assert!(
            text.contains("failed to execute") && text.contains("missing-mkfs.erofs"),
            "{text}"
        );
    }

    #[test]
    fn an_absolute_or_escaping_symlink_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let source = local_source(root.path());
        std::os::unix::fs::symlink("/etc/passwd", source.join("absolute")).unwrap();
        let builder = test_builder(root.path(), Arc::new(FakeMkfs::default()));
        let error = builder
            .build_local(&source, &Packaging::default())
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("absolute symlink"),
            "{error:#}"
        );

        let other = root.path().join("second");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("x"), b"x").unwrap();
        std::os::unix::fs::symlink("../outside", other.join("escaping")).unwrap();
        let builder = test_builder(
            &root.path().join("second-build"),
            Arc::new(FakeMkfs::default()),
        );
        let error = builder
            .build_local(&other, &Packaging::default())
            .unwrap_err();
        assert!(format!("{error:#}").contains("escapes"), "{error:#}");
    }

    #[test]
    fn a_git_snapshot_is_built_with_its_resolved_commit() {
        let root = tempfile::tempdir().unwrap();
        let builder = test_builder(root.path(), Arc::new(FakeMkfs::default()));
        let source = local_source(root.path());
        let git_dir = root.path().join("repo");
        fs::create_dir_all(&git_dir).unwrap();
        let git = |args: &[&str]| {
            assert!(Command::new("git")
                .args(args)
                .current_dir(&git_dir)
                .env_remove("GIT_DIR")
                .env_remove("GIT_WORK_TREE")
                .env_remove("GIT_INDEX_FILE")
                .env_remove("GIT_COMMON_DIR")
                .env_remove("GIT_OBJECT_DIRECTORY")
                .env("GIT_AUTHOR_NAME", "Fixture")
                .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
                .env("GIT_COMMITTER_NAME", "Fixture")
                .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
                .status()
                .unwrap()
                .success());
        };
        git(&["init", "-q"]);
        fs::write(git_dir.join("a.txt"), b"from git").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-q", "-m", "first"]);
        let sha = String::from_utf8(
            Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(&git_dir)
                .env_remove("GIT_DIR")
                .env_remove("GIT_WORK_TREE")
                .env_remove("GIT_INDEX_FILE")
                .env_remove("GIT_COMMON_DIR")
                .env_remove("GIT_OBJECT_DIRECTORY")
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();
        let target = GitTarget {
            repository_url: git_dir.to_string_lossy().into_owned(),
            reference: sha.clone(),
            requested_sha: Some(sha.clone()),
        };
        let built = builder.build_git(&target, &Packaging::default()).unwrap();
        assert_eq!(built.source_sha.as_deref(), Some(sha.as_str()));
        let mut file = std::fs::File::open(&built.blob.path).unwrap();
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut file, &mut bytes).unwrap();
        assert!(bytes.windows(8).any(|w| w == b"from git"));
        let _ = source;
    }

    /// #3334: the manifest is deterministic, covers content and modes, and a
    /// completed snapshot checkpoint verifies; corrupting the snapshot makes the
    /// checkpoint unusable rather than silently reusable.
    #[test]
    fn a_snapshot_checkpoint_is_reverified_before_reuse() {
        let root = tempfile::tempdir().unwrap();
        let source = local_source(root.path());
        let build_dir = root.path().join("build");
        fs::create_dir_all(&build_dir).unwrap();
        let packaging = Packaging::default();
        let builder = test_builder(root.path(), Arc::new(FakeMkfs::default()));
        let control = ProcessControl::new();
        let request = BuildRequest {
            build_dir: &build_dir,
            source: BuildSource::LocalDirectory { path: &source },
            packaging: &packaging,
            resume: ResumePoint::Source,
            control: &control,
            observer: &NoopObserver,
        };
        builder.run(request).unwrap();
        let identity = BuildSource::LocalDirectory { path: &source }.snapshot_identity();
        let checkpoint = verify_snapshot(&build_dir, &identity, &packaging)
            .unwrap()
            .expect("checkpoint exists");
        assert_eq!(checkpoint.files, 2);
        assert!(checkpoint.entries >= 3);
        assert_eq!(checkpoint.bytes, 9);

        fs::write(snapshot_dir(&build_dir).join("a.txt"), b"tampered").unwrap();
        let error = verify_snapshot(&build_dir, &identity, &packaging).unwrap_err();
        assert!(
            format!("{error:#}").contains("does not match the snapshot content"),
            "{error:#}"
        );
    }

    /// #3334: resuming from a verified snapshot reruns packaging without
    /// touching the source. Packaging is deterministic, so the digest is the
    /// same one the completed build produced.
    #[test]
    fn a_verified_snapshot_resumes_without_the_source() {
        let root = tempfile::tempdir().unwrap();
        let source = local_source(root.path());
        let build_dir = root.path().join("build");
        fs::create_dir_all(&build_dir).unwrap();
        let packaging = Packaging::default();
        let builder = test_builder(root.path(), Arc::new(FakeMkfs::default()));
        let control = ProcessControl::new();
        let first = builder
            .run(BuildRequest {
                build_dir: &build_dir,
                source: BuildSource::LocalDirectory { path: &source },
                packaging: &packaging,
                resume: ResumePoint::Source,
                control: &control,
                observer: &NoopObserver,
            })
            .unwrap();
        // The source is gone; only the durable snapshot can produce the image.
        fs::remove_dir_all(&source).unwrap();
        let second = builder
            .run(BuildRequest {
                build_dir: &build_dir,
                source: BuildSource::LocalDirectory { path: &source },
                packaging: &packaging,
                resume: ResumePoint::Packaging,
                control: &control,
                observer: &NoopObserver,
            })
            .unwrap();
        assert_eq!(first.blob.digest, second.blob.digest);
    }

    /// #3334: a partial `image.erofs.part` is discarded before packaging. A
    /// resumed attempt always reruns `mkfs.erofs` rather than trusting it.
    #[test]
    fn an_incomplete_packaged_image_is_never_trusted() {
        let root = tempfile::tempdir().unwrap();
        let source = local_source(root.path());
        let build_dir = root.path().join("build");
        fs::create_dir_all(&build_dir).unwrap();
        let packaging = Packaging::default();
        let builder = test_builder(root.path(), Arc::new(FakeMkfs::default()));
        let control = ProcessControl::new();
        builder
            .run(BuildRequest {
                build_dir: &build_dir,
                source: BuildSource::LocalDirectory { path: &source },
                packaging: &packaging,
                resume: ResumePoint::Source,
                control: &control,
                observer: &NoopObserver,
            })
            .unwrap();
        fs::write(packaged_image_path(&build_dir), b"partial garbage").unwrap();
        let resumed = builder
            .run(BuildRequest {
                build_dir: &build_dir,
                source: BuildSource::LocalDirectory { path: &source },
                packaging: &packaging,
                resume: ResumePoint::Packaging,
                control: &control,
                observer: &NoopObserver,
            })
            .unwrap();
        assert!(resumed.blob.size_bytes > 0);
        assert_ne!(
            resumed.blob.size_bytes,
            b"partial garbage".len() as u64,
            "the published bytes are the rerun packaging output, never the partial file"
        );
    }

    #[test]
    fn cancellation_kills_the_owned_subprocess_and_returns_promptly() {
        let control = Arc::new(ProcessControl::new());
        let flag = Arc::clone(&control);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            flag.cancel();
        });
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30"]);
        let started = Instant::now();
        let error = control.execute(&mut command, "sleep fixture").unwrap_err();
        assert!(format!("{error:#}").contains("canceled"), "{error:#}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "cancellation must not wait for the subprocess's natural exit"
        );
    }

    #[test]
    fn a_subprocess_wall_time_bound_is_enforced() {
        let control = ProcessControl::with_timeout(Duration::from_millis(100));
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30"]);
        let error = control.execute(&mut command, "sleep fixture").unwrap_err();
        assert!(
            format!("{error:#}").contains("wall-time bound"),
            "{error:#}"
        );
    }

    #[test]
    #[ignore = "requires erofs-utils; executed by the #3022 acceptance Case"]
    fn real_erofs_build_is_deterministic() {
        let root = tempfile::tempdir().unwrap();
        let source = local_source(root.path());
        let builder = ErofsBuilder::new(
            Arc::new(crate::git::ProcessGitRunner::default()),
            Arc::new(ProcessMkfsRunner::default()),
            BlobStore::new(root.path().join("blobs")).unwrap(),
            root.path().join("work"),
        )
        .unwrap();
        let first = builder.build_local(&source, &Packaging::default()).unwrap();
        let second = builder.build_local(&source, &Packaging::default()).unwrap();
        assert_eq!(first.blob.digest, second.blob.digest);
        let image = fs::read(&first.blob.path).unwrap();
        assert_eq!(
            image.get(1024..1028),
            Some([0xe2_u8, 0xe1, 0xf5, 0xe0].as_slice()),
            "EROFS superblock magic at byte 1024"
        );
        let mut file = std::fs::File::create(root.path().join("probe.txt")).unwrap();
        file.write_all(b"probe").unwrap();
    }
}
