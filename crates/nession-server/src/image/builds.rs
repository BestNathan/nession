//! Durable directory-backed build state (#3334).
//!
//! One build ID is one directory under the Server's configured image build
//! root. `state.json` is the execution-state authority: it is written
//! atomically (temporary file, fsync, rename, parent fsync) and readers never
//! observe truncated JSON. The published Image Registry, Blob Store, aliases
//! and grants remain the separate authority for immutable bytes and references;
//! a build directory is not a second image registry.
//!
//! # Single owner
//!
//! V1 assumes exactly one active Server build manager per shared build root.
//! The manager takes an exclusive advisory lock on `<root>/.owner.lock` for its
//! lifetime and fails closed when another process holds it. This lock is a
//! same-host ownership check, not a claim that a network filesystem can be
//! shared safely by multiple Server Pods.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use nession_protocol::contracts::image::v1::{
    is_valid_image_build_id, ImageBuildDescriptor, ImageBuildProgress, ImageBuildStage,
    ImageBuildStatus, ImagePackaging, ImageSource,
};

/// The state file format this Server writes and reads.
pub const BUILD_STATE_VERSION: u32 = 1;
/// The owner-lock file name inside the build root.
pub const OWNER_LOCK_FILE: &str = ".owner.lock";
/// The per-build state file name.
pub const BUILD_STATE_FILE: &str = "state.json";
/// The bounded per-build diagnostic log.
pub const BUILD_LOG_FILE: &str = "build.log";
/// The default diagnostic log bound.
pub const DEFAULT_BUILD_LOG_MAX_BYTES: u64 = 1024 * 1024;
/// The default retention for terminal build directories.
pub const DEFAULT_BUILD_RETENTION_SECS: u64 = 7 * 24 * 60 * 60;

/// One completed attempt in a build record's bounded history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildAttempt {
    pub attempt: u32,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub started_at: u64,
    pub finished_at: u64,
}

/// The versioned durable state of one build record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildState {
    pub version: u32,
    pub build_id: String,
    pub image_id: String,
    pub attempt: u32,
    /// Monotonic submission order used for alias intent and list ordering.
    pub sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_request_id: Option<String>,
    pub source: ImageSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    pub packaging: ImagePackaging,
    pub status: ImageBuildStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<ImageBuildStage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_sha: Option<String>,
    #[serde(default)]
    pub progress: ImageBuildProgress,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    pub size_bytes: u64,
    #[serde(default)]
    pub deduplicated: bool,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    #[serde(default)]
    pub attempts: Vec<BuildAttempt>,
    /// True when a restarted Server re-owned this record after its previous
    /// owner stopped.
    #[serde(default)]
    pub recovered: bool,
}

impl BuildState {
    pub fn is_terminal(&self) -> bool {
        self.status.is_terminal()
    }

    /// The descriptor the async protocol units return. Elapsed time is derived
    /// from the attempt's own start/finish timestamps; file/byte counts stay
    /// absent until the snapshot manifest measured them.
    pub fn descriptor(&self, now: u64) -> ImageBuildDescriptor {
        let progress = ImageBuildProgress {
            files: self.progress.files,
            bytes: self.progress.bytes,
            elapsed_ms: self
                .started_at
                .map(|started| {
                    let end = self.finished_at.unwrap_or(now).max(started);
                    end.saturating_sub(started).saturating_mul(1000)
                })
                .unwrap_or(0),
        };
        ImageBuildDescriptor {
            build_id: self.build_id.clone(),
            image_id: self.image_id.clone(),
            attempt: self.attempt,
            source: self.source.clone(),
            source_sha: self.pinned_sha.clone(),
            packaging: self.packaging.clone(),
            status: self.status,
            stage: self.stage,
            progress,
            diagnostic: self.diagnostic.clone(),
            error: self.error.clone(),
            digest: self.digest.clone(),
            size_bytes: self.size_bytes,
            alias: self.alias.clone(),
            deduplicated: self.deduplicated,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

/// The result of one bounded cleanup sweep of terminal build directories.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BuildCleanupReport {
    pub expired_builds: u64,
    pub expired_rejected: u64,
    pub deferred_active: u64,
}

/// The build directory root and its exclusive owner lock.
pub struct BuildStore {
    root: PathBuf,
    /// Held for the manager's lifetime; dropping it releases ownership.
    _owner_lock: File,
    log_max_bytes: u64,
}

impl std::fmt::Debug for BuildStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BuildStore")
            .field("root", &self.root)
            .field("log_max_bytes", &self.log_max_bytes)
            .finish()
    }
}

impl BuildStore {
    /// Open the build root, prove it is writable, and take exclusive ownership.
    ///
    /// Missing or unwritable storage fails closed: there is deliberately no
    /// fallback to ephemeral storage when the durable root cannot be used.
    pub fn open(root: impl Into<PathBuf>, log_max_bytes: u64) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)
            .with_context(|| format!("image build storage {} is not creatable", root.display()))?;
        let probe = root.join(format!(".probe-{}", uuid::Uuid::new_v4()));
        {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&probe)
                .with_context(|| {
                    format!("image build storage {} is not writable", root.display())
                })?;
            file.write_all(b"probe").with_context(|| {
                format!("image build storage {} is not durable", root.display())
            })?;
            file.sync_all().ok();
        }
        let _ = fs::remove_file(&probe);

        let lock_path = root.join(OWNER_LOCK_FILE);
        let mut owner_lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)
            .with_context(|| format!("failed to open {}", lock_path.display()))?;
        match owner_lock.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                anyhow::bail!(
                    "another Server process owns the image build directory {}",
                    root.display()
                );
            }
            Err(std::fs::TryLockError::Error(error)) => {
                return Err(error).with_context(|| {
                    format!("failed to lock image build directory {}", root.display())
                });
            }
        }
        owner_lock
            .set_len(0)
            .and_then(|()| owner_lock.seek(SeekFrom::Start(0)).map(|_| ()))
            .and_then(|()| {
                owner_lock.write_all(
                    format!(
                        "pid={} at={}\n",
                        std::process::id(),
                        crate::image::now_secs()
                    )
                    .as_bytes(),
                )
            })
            .and_then(|()| owner_lock.sync_all())
            .ok();

        Ok(Self {
            root,
            _owner_lock: owner_lock,
            log_max_bytes,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn build_dir(&self, build_id: &str) -> PathBuf {
        self.root.join(build_id)
    }

    fn state_path(&self, build_id: &str) -> PathBuf {
        self.build_dir(build_id).join(BUILD_STATE_FILE)
    }

    /// Create one build directory and its initial state.
    pub fn create(&self, state: &BuildState) -> Result<()> {
        let dir = self.build_dir(&state.build_id);
        fs::create_dir(&dir)
            .with_context(|| format!("failed to create build directory {}", dir.display()))?;
        self.write_state(state)?;
        sync_directory(&self.root);
        Ok(())
    }

    /// Atomically replace one build's state file.
    pub fn write_state(&self, state: &BuildState) -> Result<()> {
        let dir = self.build_dir(&state.build_id);
        fs::create_dir_all(&dir).with_context(|| format!("failed to create {}", dir.display()))?;
        let path = self.state_path(&state.build_id);
        let temp = dir.join(format!("{BUILD_STATE_FILE}.tmp-{}", uuid::Uuid::new_v4()));
        let json = serde_json::to_vec(state).context("failed to encode build state")?;
        {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temp)
                .with_context(|| format!("failed to create {}", temp.display()))?;
            file.write_all(&json)
                .with_context(|| format!("failed to write {}", temp.display()))?;
            file.sync_all()
                .with_context(|| format!("failed to fsync {}", temp.display()))?;
        }
        fs::rename(&temp, &path).with_context(|| {
            format!(
                "failed to publish build state {} as {}",
                temp.display(),
                path.display()
            )
        })?;
        sync_directory(&dir);
        Ok(())
    }

    /// Read one build state. A missing directory/file is `Ok(None)`; malformed
    /// JSON is an explicit error and is never treated as an empty state.
    pub fn try_read_state(&self, build_id: &str) -> Result<Option<BuildState>> {
        if !is_valid_image_build_id(build_id) {
            return Ok(None);
        }
        let path = self.state_path(build_id);
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(error).with_context(|| format!("failed to read {}", path.display()))
            }
        };
        let state: BuildState = serde_json::from_str(&text)
            .with_context(|| format!("build state {} is not valid", path.display()))?;
        if state.version != BUILD_STATE_VERSION {
            anyhow::bail!(
                "build state {} has unsupported version {}",
                path.display(),
                state.version
            );
        }
        if state.build_id != build_id {
            anyhow::bail!(
                "build state {} names a different build identity",
                path.display()
            );
        }
        Ok(Some(state))
    }

    pub fn read_state(&self, build_id: &str) -> Result<BuildState> {
        self.try_read_state(build_id)?
            .ok_or_else(|| anyhow::anyhow!("build not found"))
    }

    /// Every readable build, newest submission first.
    ///
    /// A directory whose state cannot be read is moved aside to
    /// `<build-id>.rejected` and is never resumed, listed or executed. The
    /// original bytes remain on disk for inspection and bounded cleanup.
    pub fn scan(&self) -> Result<Vec<BuildState>> {
        let mut builds = Vec::new();
        let mut entries = fs::read_dir(&self.root)
            .with_context(|| format!("failed to read {}", self.root.display()))?
            .collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || !entry.path().is_dir() || !is_valid_image_build_id(&name) {
                continue;
            }
            match self.try_read_state(&name) {
                Ok(Some(state)) => builds.push(state),
                Ok(None) => {}
                Err(error) => {
                    let rejected = self.root.join(format!("{name}.rejected"));
                    match fs::rename(entry.path(), &rejected) {
                        Ok(()) => tracing::warn!(
                            build_id = %name,
                            error = %format!("{error:#}"),
                            "rejected an unreadable image build state directory"
                        ),
                        Err(rename_error) => tracing::error!(
                            build_id = %name,
                            error = %format!("{error:#}"),
                            rename_error = %rename_error,
                            "unreadable image build state could not be moved aside"
                        ),
                    }
                }
            }
        }
        builds.sort_by(|left, right| {
            right
                .sequence
                .cmp(&left.sequence)
                .then_with(|| right.build_id.cmp(&left.build_id))
        });
        Ok(builds)
    }

    /// One page of the durable build inventory, newest first.
    pub fn list_page(&self, offset: u32, limit: u32) -> Result<(Vec<BuildState>, u64)> {
        let builds = self.scan()?;
        let total = builds.len() as u64;
        let start = usize::try_from(offset)
            .unwrap_or(usize::MAX)
            .min(builds.len());
        let take = usize::try_from(limit).unwrap_or(usize::MAX);
        let page = builds
            .into_iter()
            .skip(start)
            .take(take)
            .collect::<Vec<_>>();
        Ok((page, total))
    }

    /// The active build record (queued or running) that owns one registry row.
    pub fn active_build_for_image(&self, image_id: &str) -> Option<BuildState> {
        self.scan()
            .ok()?
            .into_iter()
            .find(|state| state.image_id == image_id && !state.is_terminal())
    }

    /// Append one bounded diagnostic line. Once the log reaches its bound it is
    /// closed rather than grown; state.json keeps the latest diagnostic field.
    pub fn append_log(&self, build_id: &str, line: &str) {
        let dir = self.build_dir(build_id);
        if fs::create_dir_all(&dir).is_err() {
            return;
        }
        let path = dir.join(BUILD_LOG_FILE);
        let current = fs::metadata(&path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if current >= self.log_max_bytes {
            return;
        }
        let room = usize::try_from(self.log_max_bytes.saturating_sub(current))
            .unwrap_or(usize::MAX)
            .max(1);
        let text: String = line.chars().take(room.saturating_sub(1)).collect();
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(file, "{text}");
        }
    }

    /// Remove one build directory after its terminal record has been observed.
    pub fn remove(&self, build_id: &str) -> Result<()> {
        let dir = self.build_dir(build_id);
        match fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error).with_context(|| format!("failed to remove {}", dir.display())),
        }
    }

    /// Remove terminal build directories older than `retention_secs`, never an
    /// active build. Rejected directories are bounded the same way by mtime.
    pub fn cleanup(
        &self,
        retention_secs: u64,
        active_builds: &HashSet<String>,
        now: u64,
    ) -> Result<BuildCleanupReport> {
        let mut report = BuildCleanupReport::default();
        let cutoff = now.saturating_sub(retention_secs);
        let mut entries = fs::read_dir(&self.root)
            .with_context(|| format!("failed to read {}", self.root.display()))?
            .collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || !entry.path().is_dir() {
                continue;
            }
            if let Ok(Some(state)) = self.try_read_state(&name) {
                if active_builds.contains(&name) || !state.is_terminal() {
                    report.deferred_active += 1;
                    continue;
                }
                if state.updated_at < cutoff && self.remove(&name).is_ok() {
                    report.expired_builds += 1;
                }
                continue;
            }
            if let Some(name) = name.strip_suffix(".rejected") {
                let modified = entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs())
                    .unwrap_or(now);
                if modified < cutoff {
                    let dir = self.root.join(format!("{name}.rejected"));
                    if fs::remove_dir_all(&dir).is_ok() {
                        report.expired_rejected += 1;
                    }
                }
            }
        }
        Ok(report)
    }

    /// Whether any build record is queued or running (used by recovery and GC
    /// protection).
    pub fn active_builds(&self) -> HashMap<String, BuildState> {
        self.scan()
            .unwrap_or_default()
            .into_iter()
            .filter(|state| !state.is_terminal())
            .map(|state| (state.build_id.clone(), state))
            .collect()
    }
}

fn sync_directory(path: &Path) {
    if let Ok(directory) = File::open(path) {
        let _ = directory.sync_all();
    }
}
