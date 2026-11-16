//! Durable storage identity for one shared writable Overlay (#3582).
//!
//! The manager never accepts a consumer-supplied mountpoint or upper/work
//! path. A caller names an **authorized Workspace root** plus a validated
//! relative identity; this module derives the durable `upper`/`work`
//! directories and the manager derives its own mountpoint.
//!
//! The durable owner marker lives next to the durable bytes
//! (`<workspace>/.nession-overlay/owner.json`) and its advisory lock is held
//! for the full physical Overlay lifetime. That is what fences another process
//! (or another manager root) that shares the same durable upper: a process
//! local mutex cannot.

use std::io::Write as _;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::io::AsRawFd;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// The durable writable layer.
pub const UPPER_DIRECTORY: &str = "upper";
/// The Overlay work directory (same filesystem as `upper`).
pub const WORK_DIRECTORY: &str = "work";
/// Agent-owned Overlay metadata inside one managed Workspace directory.
pub const OWNER_DIRECTORY: &str = ".nession-overlay";
/// The durable owner identity file.
pub const OWNER_FILE: &str = "owner.json";
/// The advisory lock file held for the physical mount lifetime.
pub const OWNER_LOCK_FILE: &str = "owner.lock";

/// How many path components an authorized workspace identity may have.
const MAX_RELATIVE_COMPONENTS: usize = 8;

/// One authorized durable workspace identity: a canonical root plus a safe
/// relative path below it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct OverlayWorkspaceKey {
    root: PathBuf,
    relative: PathBuf,
}

impl OverlayWorkspaceKey {
    /// Construct a workspace identity.
    ///
    /// The root is normalized when it exists (the manager re-checks it against
    /// its authorized roots before any use) and the relative path must be a
    /// bounded sequence of safe components.
    pub fn new(root: impl Into<PathBuf>, relative: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        if !root.is_absolute() {
            anyhow::bail!(
                "an Overlay workspace root {} must be absolute",
                root.display()
            );
        }
        let relative = relative.into();
        validate_relative(&relative)?;
        Ok(Self { root, relative })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn relative(&self) -> &Path {
        &self.relative
    }

    /// The authorized workspace directory. Upper/work live below it.
    pub fn directory(&self) -> PathBuf {
        self.root.join(&self.relative)
    }

    pub fn upper(&self) -> PathBuf {
        self.directory().join(UPPER_DIRECTORY)
    }

    pub fn work(&self) -> PathBuf {
        self.directory().join(WORK_DIRECTORY)
    }

    /// A stable text identity. It is safe to persist: it is derived from the
    /// authorized key, never from a caller-provided filesystem path.
    pub fn identity(&self) -> String {
        format!(
            "{}::{}",
            self.root.to_string_lossy(),
            self.relative.to_string_lossy()
        )
    }

    /// A stable short identity for manager-owned names (mountpoints, sidecars
    /// and lower consumer ids).
    pub fn short_id(&self) -> String {
        let digest = crate::digest::digest_of_bytes(self.identity().as_bytes());
        digest
            .strip_prefix(crate::digest::DIGEST_PREFIX)
            .unwrap_or(&digest)
            .to_string()
    }

    /// Re-validate a key that was decoded from a record. Deserialization
    /// bypasses [`Self::new`], so the manager always calls this before use.
    pub fn validate(&self) -> Result<()> {
        if !self.root.is_absolute() {
            anyhow::bail!(
                "an Overlay workspace root {} must be absolute",
                self.root.display()
            );
        }
        validate_relative(&self.relative)
    }
}

fn validate_relative(relative: &Path) -> Result<()> {
    if relative.as_os_str().is_empty() {
        anyhow::bail!("an Overlay workspace identity must not be empty");
    }
    if relative.is_absolute() {
        anyhow::bail!(
            "an Overlay workspace identity {} must be relative to its authorized root",
            relative.display()
        );
    }
    // `Path::components()` drops an interior `.`, so only the raw segments can
    // enforce the documented rejection of every `.`/`..` component (#3681).
    for segment in relative.as_os_str().as_bytes().split(|byte| *byte == b'/') {
        if segment == b".".as_slice() || segment == b"..".as_slice() {
            anyhow::bail!(
                "an Overlay workspace identity {} must not contain `.` or `..`",
                relative.display()
            );
        }
    }
    let mut components = 0usize;
    for component in relative.components() {
        let Component::Normal(name) = component else {
            anyhow::bail!(
                "an Overlay workspace identity {} must not contain `.` or `..`",
                relative.display()
            );
        };
        let Some(text) = name.to_str() else {
            anyhow::bail!(
                "an Overlay workspace identity {} must be valid UTF-8",
                relative.display()
            );
        };
        if text.is_empty()
            || text.len() > 128
            || !text
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        {
            anyhow::bail!(
                "an Overlay workspace identity component `{text}` must use only ASCII \
                 alphanumerics, `_`, `-` and `.`"
            );
        }
        components += 1;
    }
    if components == 0 || components > MAX_RELATIVE_COMPONENTS {
        anyhow::bail!(
            "an Overlay workspace identity must have 1..={MAX_RELATIVE_COMPONENTS} components"
        );
    }
    Ok(())
}

/// The durable directory layout of one Overlay workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverlayStoragePaths {
    pub directory: PathBuf,
    pub upper: PathBuf,
    pub work: PathBuf,
}

/// Verify that an existing workspace directory has complete, real Overlay
/// storage. Nothing is created.
pub fn verify(directory: &Path) -> Result<OverlayStoragePaths> {
    verify_real_directory(directory)?;
    let upper = directory.join(UPPER_DIRECTORY);
    let work = directory.join(WORK_DIRECTORY);
    for path in [&upper, &work] {
        let metadata = std::fs::symlink_metadata(path).with_context(|| {
            format!(
                "Overlay storage {} is missing; the Agent owner must initialize it before a mount",
                path.display()
            )
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            anyhow::bail!(
                "Overlay storage {} must be a real directory, not a symlink or file",
                path.display()
            );
        }
    }
    Ok(OverlayStoragePaths {
        directory: directory.to_path_buf(),
        upper,
        work,
    })
}

/// Create the durable `upper`/`work` pair on first use.
///
/// A partial pair (only one of the two exists) is refused: it is evidence of
/// an interrupted/foreign modification and must not be turned into a fresh
/// empty upper silently.
pub fn initialize(directory: &Path) -> Result<OverlayStoragePaths> {
    verify_real_directory(directory)?;
    let upper = directory.join(UPPER_DIRECTORY);
    let work = directory.join(WORK_DIRECTORY);
    let upper_exists = std::fs::symlink_metadata(&upper).is_ok();
    let work_exists = std::fs::symlink_metadata(&work).is_ok();
    match (upper_exists, work_exists) {
        (true, true) => verify(directory),
        (false, false) => {
            for path in [&upper, &work] {
                std::fs::create_dir(path).with_context(|| {
                    format!("create Overlay storage directory {}", path.display())
                })?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
                }
            }
            Ok(OverlayStoragePaths {
                directory: directory.to_path_buf(),
                upper,
                work,
            })
        }
        (true, false) => anyhow::bail!(
            "Overlay storage {} has an upper but no work directory; refusing to create a fresh \
             work over existing durable bytes",
            directory.display()
        ),
        (false, true) => anyhow::bail!(
            "Overlay storage {} has a work directory but no upper; refusing to create a fresh \
             empty upper over existing state",
            directory.display()
        ),
    }
}

fn verify_real_directory(directory: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(directory)
        .with_context(|| format!("inspect Overlay workspace {}", directory.display()))?;
    if metadata.file_type().is_symlink() {
        anyhow::bail!(
            "Overlay workspace {} must not be a symlink",
            directory.display()
        );
    }
    if !metadata.is_dir() {
        anyhow::bail!(
            "Overlay workspace {} is not a directory",
            directory.display()
        );
    }
    Ok(())
}

/// The Agent-owned Overlay metadata directory inside a workspace.
pub fn owner_holder(directory: &Path) -> PathBuf {
    directory.join(OWNER_DIRECTORY)
}

/// A durable owner identity persisted next to the durable bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnerRecord {
    /// The Agent's stable identity.
    pub agent_identity: String,
    /// The mount namespace the owning process observed.
    pub mount_namespace: String,
    /// The authorized workspace identity.
    pub workspace: String,
    pub mountpoint: PathBuf,
    pub generation: String,
    pub updated_at: u64,
}

/// An exclusive advisory lock on one durable workspace.
///
/// The lock is held for the full physical Overlay lifetime and is released by
/// the kernel when the owning process exits. A second process (or a second
/// manager with a different manager root) that shares the durable bytes cannot
/// acquire it.
pub struct OwnerLock {
    file: std::fs::File,
}

impl std::fmt::Debug for OwnerLock {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("OwnerLock").finish_non_exhaustive()
    }
}

impl OwnerLock {
    pub fn acquire(directory: &Path) -> Result<Self> {
        let holder = owner_holder(directory);
        match std::fs::symlink_metadata(&holder) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                anyhow::bail!(
                    "Overlay metadata path {} must be a real directory",
                    holder.display()
                );
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&holder).with_context(|| {
                    format!("create Overlay metadata directory {}", holder.display())
                })?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ =
                        std::fs::set_permissions(&holder, std::fs::Permissions::from_mode(0o700));
                }
            }
            Err(error) => {
                return Err(error).with_context(|| format!("inspect {}", holder.display()));
            }
        }
        let path = holder.join(OWNER_LOCK_FILE);
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .with_context(|| format!("open Overlay owner lock {}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
        }
        let status = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if status != 0 {
            let error = std::io::Error::last_os_error();
            let code = error.raw_os_error();
            let would_block = code == Some(libc::EWOULDBLOCK) || code == Some(libc::EAGAIN);
            if would_block {
                anyhow::bail!(
                    "another process holds the durable Overlay owner lock for {}",
                    directory.display()
                );
            }
            return Err(error).with_context(|| format!("lock Overlay owner {}", path.display()));
        }
        Ok(Self { file })
    }
}

impl OwnerLock {
    /// Read-only probe: whether a live process currently holds the durable
    /// owner lock. It never creates the lock file. An unreadable metadata path
    /// is reported as held, so deletion fails closed.
    pub fn probe_held(directory: &Path) -> bool {
        let path = owner_holder(directory).join(OWNER_LOCK_FILE);
        let file = match std::fs::OpenOptions::new().read(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
            Err(_) => return true,
        };
        let status = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if status == 0 {
            let _ = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
            false
        } else {
            true
        }
    }
}

impl Drop for OwnerLock {
    fn drop(&mut self) {
        let _ = unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
    }
}

/// Read the durable owner record, when one exists.
pub fn read_owner_record(directory: &Path) -> Result<Option<OwnerRecord>> {
    let path = owner_holder(directory).join(OWNER_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("read Overlay owner record {}", path.display()))
        }
    };
    let record = serde_json::from_slice(&bytes)
        .with_context(|| format!("parse Overlay owner record {}", path.display()))?;
    Ok(Some(record))
}

/// Persist the durable owner record atomically.
pub fn write_owner_record(directory: &Path, record: &OwnerRecord) -> Result<()> {
    let holder = owner_holder(directory);
    std::fs::create_dir_all(&holder)
        .with_context(|| format!("create Overlay metadata directory {}", holder.display()))?;
    let bytes = serde_json::to_vec_pretty(record).context("serialize the Overlay owner record")?;
    write_private_atomic(&holder.join(OWNER_FILE), &bytes)
}

/// Remove the durable owner record (after a verified unmount).
pub fn remove_owner_record(directory: &Path) {
    let _ = std::fs::remove_file(owner_holder(directory).join(OWNER_FILE));
}

/// Write a private, fsynced file atomically.
pub(crate) fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let temporary = path.with_extension(format!("tmp.{}", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .with_context(|| format!("create {}", temporary.display()))?;
    file.write_all(bytes)
        .with_context(|| format!("write {}", temporary.display()))?;
    file.sync_all()
        .with_context(|| format!("sync {}", temporary.display()))?;
    std::fs::rename(&temporary, path).with_context(|| format!("publish {}", path.display()))?;
    if let Some(parent) = path.parent() {
        if let Ok(directory) = std::fs::File::open(parent) {
            let _ = directory.sync_all();
        }
    }
    Ok(())
}

pub(crate) fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identities_reject_traversal_and_unsafe_components() {
        let root = tempfile::tempdir().unwrap();
        for relative in ["", "..", "../escape", "a/../../b", "dotted/./x"] {
            assert!(
                OverlayWorkspaceKey::new(root.path(), relative).is_err(),
                "{relative}"
            );
        }
        for relative in ["ws_abc", "workspace-0000", "managed/id/workspace"] {
            OverlayWorkspaceKey::new(root.path(), relative).unwrap();
        }
        assert!(OverlayWorkspaceKey::new("relative-root", "ws_a").is_err());
    }

    #[test]
    fn initialize_creates_once_and_refuses_a_partial_pair() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("ws_a");
        std::fs::create_dir(&workspace).unwrap();
        let storage = initialize(&workspace).unwrap();
        assert!(storage.upper.is_dir());
        assert!(storage.work.is_dir());
        // Idempotent when both already exist.
        initialize(&workspace).unwrap();

        std::fs::remove_dir(&storage.work).unwrap();
        let error = initialize(&workspace).unwrap_err();
        assert!(
            format!("{error:#}").contains("no work directory"),
            "{error:#}"
        );
        // It never creates a replacement for the missing side.
        assert!(!storage.work.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_storage_directory_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let workspace = root.path().join("ws_link");
        std::fs::create_dir(&workspace).unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), workspace.join(UPPER_DIRECTORY)).unwrap();
        std::fs::create_dir(workspace.join(WORK_DIRECTORY)).unwrap();
        let error = verify(&workspace).unwrap_err();
        assert!(format!("{error:#}").contains("symlink"), "{error:#}");
        assert!(initialize(&workspace).is_err());
    }

    #[test]
    fn the_owner_lock_fences_a_second_holder() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("ws_lock");
        std::fs::create_dir(&workspace).unwrap();
        assert!(!OwnerLock::probe_held(&workspace));
        let first = OwnerLock::acquire(&workspace).unwrap();
        assert!(OwnerLock::probe_held(&workspace));
        let error = OwnerLock::acquire(&workspace).unwrap_err();
        assert!(
            format!("{error:#}").contains("another process holds"),
            "{error:#}"
        );
        drop(first);
        assert!(!OwnerLock::probe_held(&workspace));
        OwnerLock::acquire(&workspace).unwrap();
    }

    #[test]
    fn the_owner_record_round_trips() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("ws_record");
        std::fs::create_dir(&workspace).unwrap();
        assert!(read_owner_record(&workspace).unwrap().is_none());
        let record = OwnerRecord {
            agent_identity: "agent-a".to_string(),
            mount_namespace: "mnt:[1]".to_string(),
            workspace: "root::ws_record".to_string(),
            mountpoint: root.path().join("merged"),
            generation: "generation-1".to_string(),
            updated_at: 0,
        };
        write_owner_record(&workspace, &record).unwrap();
        assert_eq!(read_owner_record(&workspace).unwrap(), Some(record));
        remove_owner_record(&workspace);
        assert!(read_owner_record(&workspace).unwrap().is_none());
    }
}
