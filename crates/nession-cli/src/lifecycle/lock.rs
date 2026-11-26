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

pub const LOCK_FILE_NAME: &str = "lifecycle.lock";

/// Internal marker on the re-executed foreground child of a background start.
///
/// The parent holds the lock across spawn/readiness. Without this marker the
/// child would try to take the same lock and deadlock against its own parent.
pub const LOCK_HELD_BY_PARENT_ENV: &str = "NESSION_START_LOCK_HELD";

/// An acquired exclusive lifecycle lock.
///
/// Dropping it releases the lock explicitly (see the [`Drop`] implementation),
/// so a child that inherited the descriptor during the critical section cannot
/// keep the advisory lock after this process is done.
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
        Self::try_acquire_file(open_lock_file()?)
    }

    /// Acquire with a bounded wait for the upgrade path (#4592 §8.3).
    ///
    /// Nonblocking acquisition with capped exponential backoff against a
    /// monotonic deadline. A timeout returns a retryable diagnostic; it never
    /// breaks or removes another process's lock and never kills a daemon.
    /// `on_wait` observes the elapsed wait for throttled progress reporting.
    pub fn acquire_bounded(
        wait: std::time::Duration,
        mut on_wait: impl FnMut(std::time::Duration),
    ) -> std::result::Result<Self, crate::update::UpdateError> {
        use crate::update::UpdateError;
        let start = std::time::Instant::now();
        let deadline = start + wait;
        let mut delay = std::time::Duration::from_millis(25);
        let max_delay = std::time::Duration::from_millis(500);
        loop {
            match Self::try_acquire() {
                Ok(Some(lock)) => return Ok(lock),
                Ok(None) => {}
                Err(error) => {
                    return Err(UpdateError::Io(std::io::Error::other(error.to_string())));
                }
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                return Err(UpdateError::LockTimeout {
                    waited: start.elapsed(),
                });
            }
            on_wait(start.elapsed());
            std::thread::sleep(delay.min(deadline - now));
            delay = (delay * 2).min(max_delay);
        }
    }

    fn try_acquire_file(file: File) -> Result<Option<Self>> {
        match lock_exclusive_nonblocking(&file) {
            Ok(true) => Ok(Some(Self { _file: file })),
            Ok(false) => Ok(None),
            Err(error) => Err(error).context("failed to try the lifecycle lock"),
        }
    }

    /// Try to acquire a lock rooted at an explicit directory.
    ///
    /// Test-only: the exclusion test must not mutate the process-global
    /// runtime directory, because concurrent CLI tests also set it and a
    /// foreign test's spawn can hold the lock this assertion is about.
    #[cfg(test)]
    fn try_acquire_in(dir: &std::path::Path) -> Result<Option<Self>> {
        Self::try_acquire_file(open_lock_file_in(dir)?)
    }
}

/// Release the advisory lock explicitly.
///
/// `flock` locks belong to the open file description, and `fork` shares that
/// description with every child spawned while the guard is held. Closing this
/// descriptor alone would leave the lock held by such a child until its own
/// `exec` closes the inherited copy — so "released by dropping it" would be
/// false for exactly the processes the lock serialises. `LOCK_UN` releases the
/// description's lock immediately (#3628).
#[cfg(unix)]
impl Drop for LifecycleLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        // SAFETY: `self._file` owns a valid descriptor for the duration of the call.
        let _ = unsafe { libc::flock(self._file.as_raw_fd(), libc::LOCK_UN) };
    }
}

fn open_lock_file() -> Result<File> {
    let dir = nession_common::paths::ensure_runtime_dir()?;
    open_lock_file_in(&dir)
}

fn open_lock_file_in(dir: &std::path::Path) -> Result<File> {
    let path = dir.join(LOCK_FILE_NAME);
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
        // Path-scoped rather than env-scoped: another CLI test may set the
        // process-global runtime directory (or hold a lock in its own) while
        // this test runs. The exclusion property is about one directory.
        let runtime = tempfile::tempdir().unwrap();
        let dir = runtime.path();
        let held = LifecycleLock::try_acquire_in(dir)
            .unwrap()
            .expect("first lock");

        assert!(
            LifecycleLock::try_acquire_in(dir).unwrap().is_none(),
            "a concurrent lifecycle command must not share the lock"
        );

        drop(held);
        assert!(
            LifecycleLock::try_acquire_in(dir).unwrap().is_some(),
            "releasing the lock must let the next command proceed"
        );
    }

    /// Dropping the guard must release the advisory lock even when another
    /// descriptor still refers to the same open file description — the state a
    /// `fork` creates for every child spawned while the guard is held.
    ///
    /// `flock` locks belong to the open file description, not to a single
    /// descriptor, so closing only the guard's descriptor would leave the lock
    /// held by the shared description (until that child's own `exec` closes its
    /// inherited copy). `dup` reproduces that sharing deterministically
    /// without forking the test process (#3628).
    #[cfg(unix)]
    #[test]
    fn dropping_the_guard_releases_a_shared_open_file_description() {
        use std::os::fd::AsRawFd;

        let _runtime = IsolatedRuntime::new();
        let held = LifecycleLock::try_acquire().unwrap().expect("first lock");
        // SAFETY: `held._file` owns a valid descriptor for the duration of the call.
        let shared = unsafe { libc::dup(held._file.as_raw_fd()) };
        assert!(
            shared >= 0,
            "dup failed: {}",
            std::io::Error::last_os_error()
        );

        drop(held);
        let reacquired = LifecycleLock::try_acquire();
        // SAFETY: `shared` is a descriptor this test owns and has not closed.
        let _ = unsafe { libc::close(shared) };
        assert!(
            reacquired.unwrap().is_some(),
            "dropping the guard must release the lock while a shared descriptor is open"
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
