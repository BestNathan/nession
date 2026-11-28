//! Persistence for the installation-owned client connection store (#4682).
//!
//! One owner for reading and mutating `client-config.toml`:
//!
//! - **Location.** A normal CLI resolves the installation home
//!   (`NESSION_HOME`/`~/.nession`). A dispatched archived release
//!   (`NESSION_VERSION_DISPATCHED`) consumes the installation's client context
//!   **read-only** through `NESSION_CLIENT_HOME`, the home the Current
//!   dispatcher captured before rebinding `NESSION_HOME` to the version home.
//!   An archive never mutates live client data and never bootstraps.
//! - **Fail closed.** A missing store is `None`; an unreadable, malformed or
//!   unsupported-schema store is an error and is never overwritten. Explicit
//!   `--server-url` resolution does not consult the store at all, so a corrupt
//!   store cannot break a stateless connection.
//! - **Serialized mutations.** Every write holds an exclusive advisory
//!   `flock` on `client-config.lock`, reloads the store under the lock, applies
//!   one change, revalidates the whole file and publishes it with an atomic
//!   0600 rename. Concurrent first invocations therefore converge on one
//!   store, and unrelated entries survive every edit.

use anyhow::{bail, Context, Result};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use super::{ClientConfigFile, DEFAULT_IMPORTED_PROFILE};
use crate::versions::{NESSION_CLIENT_HOME_ENV, NESSION_VERSION_DISPATCHED_ENV};

/// Where the client store lives and whether this process may mutate it.
#[derive(Debug, Clone)]
pub struct StoreLocation {
    pub home: PathBuf,
    /// True for a dispatched archived release: read-only consumption.
    pub read_only: bool,
}

impl StoreLocation {
    /// The installation client context for this process.
    ///
    /// `None` means there is no client store to consume (a dispatched archive
    /// whose dispatcher did not hand over the installation home).
    pub fn locate() -> Result<Option<Self>> {
        if std::env::var_os(NESSION_VERSION_DISPATCHED_ENV).is_some() {
            return Ok(std::env::var_os(NESSION_CLIENT_HOME_ENV)
                .filter(|home| !home.is_empty())
                .map(|home| Self {
                    home: PathBuf::from(home),
                    read_only: true,
                }));
        }
        Ok(Some(Self {
            home: nession_common::paths::nession_home()
                .context("failed to determine the installation home for the client store")?,
            read_only: false,
        }))
    }

    pub fn config_path(&self) -> PathBuf {
        nession_common::paths::client_config_path_under(&self.home)
    }

    fn refuse_mutation(&self) -> Result<()> {
        if self.read_only {
            bail!(
                "this archived release consumes the installation's client connection context \
                 read-only; client profile management runs on Current. Run the command without \
                 a version selector (no +<version> / NESSION_VERSION)."
            );
        }
        Ok(())
    }
}

/// Read and validate the store. `Ok(None)` is an absent store; every other
/// failure leaves the bytes untouched.
pub fn load(loc: &StoreLocation) -> Result<Option<ClientConfigFile>> {
    let path = loc.config_path();
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "the client connection store at {} is unreadable; it is never overwritten. \
                     Repair its permissions explicitly, or use --server-url for a stateless \
                     connection.",
                    path.display()
                )
            });
        }
    };
    let file: ClientConfigFile = toml::from_str(&text).map_err(|_| {
        anyhow::anyhow!(
            "the client connection store at {} is malformed; it is never overwritten. \
             Repair or remove it explicitly, or use --server-url for a stateless connection.",
            path.display()
        )
    })?;
    file.validate().map_err(|error| {
        error.context(format!(
            "the client connection store at {} is invalid; it is never overwritten",
            path.display()
        ))
    })?;
    Ok(Some(file))
}

/// Apply one mutation under the store lock, then publish atomically.
///
/// The closure sees the freshly loaded store (or an empty one when absent) and
/// edits only what it owns; the whole file is revalidated before the write, so
/// a mutation can neither persist an invalid state nor drop unrelated entries.
pub fn mutate<R>(
    loc: &StoreLocation,
    change: impl FnOnce(&mut ClientConfigFile) -> Result<R>,
) -> Result<R> {
    loc.refuse_mutation()?;
    let _lock = StoreLock::acquire(&loc.home)?;
    let mut file = load(loc)?.unwrap_or_default();
    let outcome = change(&mut file)?;
    file.validate()?;
    write_atomic(&loc.config_path(), &toml::to_string_pretty(&file)?)?;
    Ok(outcome)
}

/// The one-time Agent endpoint bootstrap, idempotent under concurrent first
/// invocations: under the lock, an existing store is consumed unchanged and
/// only a genuinely absent store is created. Endpoint only — no credential is
/// copied or derived.
pub fn bootstrap_import(loc: &StoreLocation, server_url: &str) -> Result<ClientConfigFile> {
    loc.refuse_mutation()?;
    let _lock = StoreLock::acquire(&loc.home)?;
    if let Some(existing) = load(loc)? {
        return Ok(existing);
    }
    super::validate_server_url(server_url)?;
    let mut file = ClientConfigFile {
        schema_version: super::CLIENT_SCHEMA_VERSION,
        current_profile: Some(DEFAULT_IMPORTED_PROFILE.to_string()),
        profiles: std::collections::BTreeMap::new(),
    };
    file.profiles.insert(
        DEFAULT_IMPORTED_PROFILE.to_string(),
        super::ProfileEntry {
            server_url: server_url.trim().to_string(),
            credential_ref: None,
            credential_backend: None,
            no_auth: false,
        },
    );
    file.validate()?;
    write_atomic(&loc.config_path(), &toml::to_string_pretty(&file)?)?;
    Ok(file)
}

/// Publish `text` at `path` atomically with private permissions.
fn write_atomic(path: &Path, text: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let temp = path.with_extension("toml.tmp");
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .with_context(|| format!("failed to create {}", temp.display()))?;
    file.write_all(text.as_bytes())
        .with_context(|| format!("failed to write {}", temp.display()))?;
    file.sync_all()
        .with_context(|| format!("failed to sync {}", temp.display()))?;
    drop(file);
    fs::rename(&temp, path).with_context(|| format!("failed to publish {}", path.display()))?;
    Ok(())
}

/// Exclusive advisory lock serialising client-store mutations.
///
/// The same `flock` discipline as the lifecycle lock: blocking acquisition,
/// released on drop. The lock file is installation-owned runtime state and is
/// retained in place (never archived) by the snapshot owner.
struct StoreLock {
    _file: File,
}

impl StoreLock {
    fn acquire(home: &Path) -> Result<Self> {
        let path = nession_common::paths::client_config_lock_path_under(home);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        let mut options = OpenOptions::new();
        options.create(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(&path)
            .with_context(|| format!("failed to open the client store lock {}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
            if result != 0 {
                return Err(std::io::Error::last_os_error())
                    .context("failed to acquire the client store lock");
            }
        }
        Ok(Self { _file: file })
    }
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            let _ = unsafe { libc::flock(self._file.as_raw_fd(), libc::LOCK_UN) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::{CredentialBackendKind, ProfileEntry};

    fn location(dir: &Path) -> StoreLocation {
        StoreLocation {
            home: dir.to_path_buf(),
            read_only: false,
        }
    }

    fn add_profile(loc: &StoreLocation, name: &str, url: &str) -> Result<()> {
        mutate(loc, |file| {
            if file.profiles.contains_key(name) {
                bail!("profile {name} already exists");
            }
            file.profiles.insert(
                name.to_string(),
                ProfileEntry {
                    server_url: url.to_string(),
                    credential_ref: None,
                    credential_backend: None,
                    no_auth: false,
                },
            );
            if file.current_profile.is_none() {
                file.current_profile = Some(name.to_string());
            }
            Ok(())
        })
    }

    #[test]
    fn an_absent_store_loads_as_none_and_mutate_creates_it() {
        let dir = tempfile::tempdir().unwrap();
        let loc = location(dir.path());
        assert!(load(&loc).unwrap().is_none());
        add_profile(&loc, "home", "ws://host-a/ws").unwrap();
        let file = load(&loc).unwrap().unwrap();
        assert_eq!(file.current_profile.as_deref(), Some("home"));
        assert!(file.profiles.contains_key("home"));
        assert!(!dir.path().join("client-config.toml.tmp").exists());
    }

    #[test]
    fn a_corrupt_store_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let loc = location(dir.path());
        let path = loc.config_path();
        fs::write(&path, "this is not toml {{{").unwrap();
        let before = fs::read(&path).unwrap();
        assert!(load(&loc).is_err());
        assert!(mutate(&loc, |_| Ok(())).is_err());
        assert!(bootstrap_import(&loc, "ws://host/ws").is_err());
        assert_eq!(fs::read(&path).unwrap(), before, "bytes must survive");
    }

    #[test]
    fn an_unsupported_schema_is_refused_without_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let loc = location(dir.path());
        fs::write(loc.config_path(), "schema_version = 99\n").unwrap();
        let error = load(&loc).unwrap_err();
        assert!(format!("{error:#}").contains("unsupported client connection store schema"));
        assert!(mutate(&loc, |_| Ok(())).is_err());
        assert_eq!(
            fs::read_to_string(loc.config_path()).unwrap(),
            "schema_version = 99\n"
        );
    }

    #[test]
    fn mutations_preserve_unrelated_entries() {
        let dir = tempfile::tempdir().unwrap();
        let loc = location(dir.path());
        add_profile(&loc, "home", "ws://host-a/ws").unwrap();
        add_profile(&loc, "local", "ws://127.0.0.1:8080").unwrap();
        mutate(&loc, |file| {
            file.profiles.get_mut("home").unwrap().server_url = "ws://host-b/ws".to_string();
            Ok(())
        })
        .unwrap();
        let file = load(&loc).unwrap().unwrap();
        assert_eq!(file.profiles["home"].server_url, "ws://host-b/ws");
        assert_eq!(file.profiles["local"].server_url, "ws://127.0.0.1:8080");
        assert_eq!(file.current_profile.as_deref(), Some("home"));
    }

    #[test]
    fn an_invalid_mutation_is_not_published() {
        let dir = tempfile::tempdir().unwrap();
        let loc = location(dir.path());
        add_profile(&loc, "home", "ws://host-a/ws").unwrap();
        let before = fs::read_to_string(loc.config_path()).unwrap();
        let error = mutate(&loc, |file| {
            file.profiles.get_mut("home").unwrap().server_url = "http://not-ws".to_string();
            Ok(())
        })
        .unwrap_err();
        assert!(format!("{error:#}").contains("ws://"));
        assert_eq!(fs::read_to_string(loc.config_path()).unwrap(), before);
    }

    #[test]
    fn concurrent_mutations_do_not_lose_profiles() {
        let dir = tempfile::tempdir().unwrap();
        let loc = location(dir.path());
        let threads: Vec<_> = (0..8)
            .map(|index| {
                let loc = loc.clone();
                std::thread::spawn(move || {
                    add_profile(&loc, &format!("p{index}"), &format!("ws://host-{index}/ws"))
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap().unwrap();
        }
        let file = load(&loc).unwrap().unwrap();
        assert_eq!(file.profiles.len(), 8, "every concurrent add must survive");
    }

    #[test]
    fn bootstrap_is_idempotent_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let loc = location(dir.path());
        let first = bootstrap_import(&loc, "ws://agent-endpoint/ws").unwrap();
        assert_eq!(first.current_profile.as_deref(), Some("agent"));
        assert_eq!(first.profiles["agent"].server_url, "ws://agent-endpoint/ws");
        assert!(first.profiles["agent"].credential_ref.is_none());
        // A second bootstrap (e.g. a concurrent first invocation) consumes the
        // existing store unchanged even if the Agent endpoint changed.
        let second = bootstrap_import(&loc, "ws://different/ws").unwrap();
        assert_eq!(second, first);
        let bytes = fs::read_to_string(loc.config_path()).unwrap();
        assert!(!bytes.contains("different"));
    }

    #[test]
    fn concurrent_bootstrap_converges_on_one_store() {
        let dir = tempfile::tempdir().unwrap();
        let loc = location(dir.path());
        let threads: Vec<_> = (0..6)
            .map(|_| {
                let loc = loc.clone();
                std::thread::spawn(move || bootstrap_import(&loc, "ws://agent-endpoint/ws"))
            })
            .collect();
        for thread in threads {
            let file = thread.join().unwrap().unwrap();
            assert_eq!(file.profiles.len(), 1);
            assert_eq!(file.current_profile.as_deref(), Some("agent"));
        }
    }

    #[test]
    fn a_read_only_location_refuses_every_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let loc = StoreLocation {
            home: dir.path().to_path_buf(),
            read_only: true,
        };
        let error = mutate(&loc, |_| Ok(())).unwrap_err();
        assert!(format!("{error:#}").contains("read-only"));
        assert!(bootstrap_import(&loc, "ws://host/ws").is_err());
        assert!(!loc.config_path().exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_store_is_published_with_private_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let loc = location(dir.path());
        add_profile(&loc, "home", "ws://host/ws").unwrap();
        let mode = fs::metadata(loc.config_path())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "client store must be 0600");
    }

    #[test]
    fn a_bound_reference_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let loc = location(dir.path());
        mutate(&loc, |file| {
            file.profiles.insert(
                "home".to_string(),
                ProfileEntry {
                    server_url: "wss://host/ws".to_string(),
                    credential_ref: Some("home".to_string()),
                    credential_backend: Some(CredentialBackendKind::File),
                    no_auth: false,
                },
            );
            file.current_profile = Some("home".to_string());
            Ok(())
        })
        .unwrap();
        let file = load(&loc).unwrap().unwrap();
        assert_eq!(
            file.profiles["home"].credential_state(),
            crate::profile::CredentialState::Bound(CredentialBackendKind::File)
        );
    }
}
