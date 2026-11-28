//! Shared process-environment serialization for unit tests (#4682).
//!
//! `NESSION_*` variables are process-global. Every unit test that sets one
//! must hold this one lock, across modules, so a resolver test and a
//! dispatcher test cannot race on the same variable in one test binary.
//!
//! The lock is a `tokio::sync::Mutex` so an async test may hold its guard
//! across `.await` (a std guard there would be both a clippy violation and a
//! deadlock risk); sync tests take it with [`lock_blocking`].

use std::ffi::OsString;
use tokio::sync::{Mutex, MutexGuard};

static ENV_LOCK: Mutex<()> = Mutex::const_new(());

/// Acquire the lock inside an async test.
pub async fn lock() -> MutexGuard<'static, ()> {
    ENV_LOCK.lock().await
}

/// Acquire the lock inside a synchronous test.
pub fn lock_blocking() -> MutexGuard<'static, ()> {
    ENV_LOCK.blocking_lock()
}

/// Set or unset one variable for the duration of a test, restoring the
/// previous value on drop.
pub struct EnvSetting {
    key: &'static str,
    previous: Option<OsString>,
}

impl EnvSetting {
    pub fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, previous }
    }

    pub fn unset(key: &'static str) -> Self {
        let previous = std::env::var_os(key);
        std::env::remove_var(key);
        Self { key, previous }
    }
}

impl Drop for EnvSetting {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(previous) => std::env::set_var(self.key, previous),
            None => std::env::remove_var(self.key),
        }
    }
}
