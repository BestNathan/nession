//! Cross-process lifecycle mutex in the shared runtime directory.
//!
//! `start`, `stop`, `restart` and a Current-replacing install mutate the same
//! process identity and (for install) the same durable paths. A per-command
//! check followed by a spawn is not atomic: two concurrent starts can both see
//! "not running" and create two daemons. This advisory `flock` serialises those
//! commands across every installed release, because every release resolves the
//! same OS runtime directory from #3155.
//!
//! The lock is advisory and process-scoped: it serialises the Nession commands
//! that take it, not arbitrary writers. It deliberately does not live under a
//! version home — that would give each release its own lock and defeat the
//! single-active invariant.

use anyhow::{Context, Result};
use std::fs::{File, OpenOptions};
use std::path::PathBuf;

pub const LOCK_FILE_NAME: &str = "lifecycle.lock";

/// Internal marker on the re-executed foreground child of a background start.
///
/// The parent holds the lock across spawn/readiness. Without this marker the
/// child would try to take the same lock and deadlock against its own parent.
pub const LOCK_HELD_BY_PARENT_ENV: &str = "NESSION_START_LOCK_HELD";

/// An acquired exclusive lifecycle lock. Released by dropping it.
#[derive(Debug)]
pub struct LifecycleLock {
    _file: File,
}

impl LifecycleLock {
    /// Acquire the exclusive lock, blocking until another command releases it.
    pub fn acquire() -> Result<Self> {
        let file = open_lock_file()?;
        lock_exclusive(&file).context("failed to acquire the lifecycle lock")?;
        Ok(Self { _file: file })
    }

    /// Try to acquire without blocking.
    ///
    /// CLI startup uses this to recover an interrupted install only when no
    /// install is currently running; tests use it to prove exclusion.
    pub fn try_acquire() -> Result<Option<Self>> {
        let file = open_lock_file()?;
        match lock_exclusive_nonblocking(&file) {
            Ok(true) => Ok(Some(Self { _file: file })),
            Ok(false) => Ok(None),
            Err(error) => Err(error).context("failed to try the lifecycle lock"),
        }
    }
}

fn lock_path() -> Result<PathBuf> {
    Ok(nession_common::paths::ensure_runtime_dir()?.join(LOCK_FILE_NAME))
}

fn open_lock_file() -> Result<File> {
    let path = lock_path()?;
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(&path)
        .with_context(|| format!("failed to open the lifecycle lock at {}", path.display()))
}

#[cfg(unix)]
fn lock_exclusive(file: &File) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    // SAFETY: `file` owns a valid descriptor for the duration of the call.
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn lock_exclusive_nonblocking(file: &File) -> std::io::Result<bool> {
    use std::os::fd::AsRawFd;
    // SAFETY: `file` owns a valid descriptor for the duration of the call.
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.kind() == std::io::ErrorKind::WouldBlock {
        Ok(false)
    } else {
        Err(error)
    }
}

#[cfg(not(unix))]
fn lock_exclusive(_file: &File) -> std::io::Result<()> {
    Ok(())
}

#[cfg(not(unix))]
fn lock_exclusive_nonblocking(_file: &File) -> std::io::Result<bool> {
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    /// The lock path comes from `NESSION_RUNTIME_DIR`; keep every test on its
    /// own directory so parallel tests do not serialise each other by accident.
    struct IsolatedRuntime {
        _guard: std::sync::MutexGuard<'static, ()>,
        dir: tempfile::TempDir,
        previous: Option<std::ffi::OsString>,
    }

    impl IsolatedRuntime {
        fn new() -> Self {
            let guard = ENV_MUTEX
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let dir = tempfile::tempdir().unwrap();
            let previous = std::env::var_os(nession_common::paths::NESSION_RUNTIME_DIR_ENV);
            std::env::set_var(nession_common::paths::NESSION_RUNTIME_DIR_ENV, dir.path());
            Self {
                _guard: guard,
                dir,
                previous,
            }
        }
    }

    impl Drop for IsolatedRuntime {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => {
                    std::env::set_var(nession_common::paths::NESSION_RUNTIME_DIR_ENV, value)
                }
                None => std::env::remove_var(nession_common::paths::NESSION_RUNTIME_DIR_ENV),
            }
            let _ = &self.dir;
        }
    }

    #[test]
    fn a_second_lifecycle_lock_cannot_be_acquired() {
        let _runtime = IsolatedRuntime::new();
        let held = LifecycleLock::try_acquire().unwrap().expect("first lock");

        assert!(
            LifecycleLock::try_acquire().unwrap().is_none(),
            "a concurrent lifecycle command must not share the lock"
        );

        drop(held);
        assert!(
            LifecycleLock::try_acquire().unwrap().is_some(),
            "releasing the lock must let the next command proceed"
        );
    }

    #[test]
    fn the_lock_lives_in_the_runtime_directory() {
        let runtime = IsolatedRuntime::new();

        let lock = LifecycleLock::acquire().unwrap();
        let path = runtime.dir.path().join(LOCK_FILE_NAME);

        assert!(
            path.is_file(),
            "lock file must be in the shared runtime dir"
        );
        drop(lock);
    }
}
