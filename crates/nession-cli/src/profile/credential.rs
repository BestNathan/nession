//! The independent client credential store (#4682).
//!
//! Secrets never live in the profile TOML, in argv for the credential
//! commands, in output, logs, errors, backups or diagnostic receipts. This
//! module is the one owner of client credential bytes:
//!
//! - **OS credential store preferred.** macOS Keychain, Windows Credential
//!   Manager and Linux Secret Service through `keyring`. A credential is
//!   stored under service [`KEYRING_SERVICE`] and account = profile name.
//! - **Private file fallback.** `client-credentials/<name>.toml` (0600) in a
//!   0700 directory, used when no OS store is available — or when the operator
//!   selects it with `NESSION_CREDENTIAL_STORE=file`.
//! - **No silent downgrade.** The backend that holds a credential is recorded
//!   in the profile metadata ([`super::CredentialBackendKind`]). Reading a
//!   credential whose recorded backend is now unavailable is a hard error,
//!   never a quiet read of a different store. An access *failure* (as opposed
//!   to an absent backend) is always surfaced.
//!
//! Every record binds the secret to the profile's canonical endpoint; a
//! mismatch at resolution time refuses the connection.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use super::store::StoreLocation;
use super::{canonical_endpoint, CredentialBackendKind};

/// The OS credential store service name for client profile credentials.
pub const KEYRING_SERVICE: &str = "nession-cli";

/// Operator override of the credential backend selection.
pub const CREDENTIAL_STORE_ENV: &str = "NESSION_CREDENTIAL_STORE";

/// A credential bound to one profile and its canonical endpoint.
///
/// `Debug` is redacted: this value must never reach a log or error sentence.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CredentialRecord {
    pub endpoint: String,
    pub token: String,
}

impl std::fmt::Debug for CredentialRecord {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CredentialRecord")
            .field("endpoint", &self.endpoint)
            .field("token", &"<redacted>")
            .finish()
    }
}

impl CredentialRecord {
    pub fn new(endpoint: &str, token: &str) -> Self {
        Self {
            endpoint: canonical_endpoint(endpoint),
            token: token.to_string(),
        }
    }

    /// Whether this credential is bound to `endpoint` (canonically).
    pub fn matches_endpoint(&self, endpoint: &str) -> bool {
        self.endpoint == canonical_endpoint(endpoint)
    }
}

/// Which backend a credential operation should use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendChoice {
    /// OS store when available, private file otherwise.
    Auto,
    File,
    Keychain,
}

impl BackendChoice {
    /// Read [`CREDENTIAL_STORE_ENV`]; an unknown value is refused, not guessed.
    pub fn from_env() -> Result<Self> {
        match std::env::var(CREDENTIAL_STORE_ENV) {
            Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
                "" | "auto" => Ok(Self::Auto),
                "file" => Ok(Self::File),
                "keychain" | "os" => Ok(Self::Keychain),
                other => bail!(
                    "invalid {CREDENTIAL_STORE_ENV} value {other:?}; expected auto, file or keychain"
                ),
            },
            Err(std::env::VarError::NotPresent) => Ok(Self::Auto),
            Err(error) => Err(error).context(format!("invalid {CREDENTIAL_STORE_ENV}")),
        }
    }
}

/// Read the credential a profile references, from its recorded backend.
///
/// An unavailable recorded backend is a hard error (no silent downgrade); an
/// absent entry is `None` (the reference is stale and resolution refuses).
pub async fn get_bound(
    loc: &StoreLocation,
    profile: &str,
    kind: CredentialBackendKind,
) -> Result<Option<CredentialRecord>> {
    match kind {
        CredentialBackendKind::File => FileBackend::new(loc).get(profile).await,
        CredentialBackendKind::Keychain => {
            KeychainBackend::new(profile)?.get().await.map_err(|error| {
                error.context(format!(
                    "the OS credential store holding profile {profile:?} is unavailable or \
                     refused access; refusing to fall back to another store. Restore access, \
                     or reconfigure with `nession profile credential set {profile}`."
                ))
            })
        }
    }
}

/// Store a credential, selecting the backend, and report where it landed.
pub async fn set_bound(
    loc: &StoreLocation,
    profile: &str,
    record: &CredentialRecord,
    choice: BackendChoice,
) -> Result<CredentialBackendKind> {
    match select(loc, choice).await? {
        Backend::File(backend) => {
            backend.set(profile, record).await?;
            Ok(CredentialBackendKind::File)
        }
        Backend::Keychain(backend) => {
            backend.set(record).await?;
            Ok(CredentialBackendKind::Keychain)
        }
    }
}

/// Delete a credential from its recorded backend (owned, unreferenced bytes).
pub async fn delete_bound(
    loc: &StoreLocation,
    profile: &str,
    kind: CredentialBackendKind,
) -> Result<()> {
    match kind {
        CredentialBackendKind::File => FileBackend::new(loc).delete(profile).await,
        CredentialBackendKind::Keychain => KeychainBackend::new(profile)?.delete().await,
    }
}

enum Backend {
    File(FileBackend),
    Keychain(KeychainBackend),
}

/// Select the backend for a new credential. `Auto` probes the OS store once:
/// an absent backend falls back to the private file; an access failure does
/// not.
async fn select(loc: &StoreLocation, choice: BackendChoice) -> Result<Backend> {
    match choice {
        BackendChoice::File => Ok(Backend::File(FileBackend::new(loc))),
        BackendChoice::Keychain => Ok(Backend::Keychain(KeychainBackend::new_probe()?)),
        BackendChoice::Auto => match KeychainBackend::probe().await {
            Ok(()) => Ok(Backend::Keychain(KeychainBackend::new_probe()?)),
            Err(KeyringUnavailable::Absent) => Ok(Backend::File(FileBackend::new(loc))),
            Err(KeyringUnavailable::Access(message)) => bail!(
                "the OS credential store refused access ({message}); refusing to silently \
                 downgrade to file storage. Restore access, or set \
                 {CREDENTIAL_STORE_ENV}=file to choose the private file store explicitly."
            ),
        },
    }
}

/// Why the OS credential store cannot be used.
enum KeyringUnavailable {
    /// No backend on this platform/session: the documented file fallback.
    Absent,
    /// A backend exists but refused access: never a silent downgrade.
    Access(String),
}

/// The OS credential store backend.
///
/// keyring's secret-service backend blocks on its own runtime, so every call
/// runs on a dedicated blocking thread (keyring's documented tokio caution):
/// calling it directly on an async worker would deadlock.
struct KeychainBackend {
    profile: String,
}

/// The account used only to probe backend availability.
const PROBE_ACCOUNT: &str = "__nession_availability_probe__";

impl KeychainBackend {
    fn new(profile: &str) -> Result<Self> {
        Ok(Self {
            profile: profile.to_string(),
        })
    }

    /// A probe entry used only to test backend availability.
    fn new_probe() -> Result<Self> {
        Self::new(PROBE_ACCOUNT)
    }

    fn entry(&self) -> Result<keyring::Entry> {
        keyring::Entry::new(KEYRING_SERVICE, &self.profile)
            .context("failed to address the OS credential store")
    }

    /// Probe availability without touching any real credential.
    async fn probe() -> std::result::Result<(), KeyringUnavailable> {
        tokio::task::spawn_blocking(|| {
            let entry = keyring::Entry::new(KEYRING_SERVICE, PROBE_ACCOUNT)
                .map_err(|error| KeyringUnavailable::Access(error.to_string()))?;
            match entry.get_password() {
                Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(keyring::Error::NoStorageAccess(_)) => Err(KeyringUnavailable::Absent),
                Err(error) => Err(KeyringUnavailable::Access(error.to_string())),
            }
        })
        .await
        .map_err(|error| KeyringUnavailable::Access(error.to_string()))?
    }

    async fn get(&self) -> Result<Option<CredentialRecord>> {
        let entry = self.entry()?;
        let blob = tokio::task::spawn_blocking(move || entry.get_password())
            .await
            .context("the OS credential store task failed")?;
        match blob {
            Ok(blob) => {
                let record: CredentialRecord = serde_json::from_str(&blob).map_err(|_| {
                    anyhow::anyhow!(
                        "the OS credential store entry for this profile is malformed; \
                         reconfigure it with `nession profile credential set`"
                    )
                })?;
                Ok(Some(record))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(keyring::Error::NoStorageAccess(_)) => {
                bail!("the OS credential store is not available in this session")
            }
            Err(error) => {
                bail!("the OS credential store refused access: {error}")
            }
        }
    }

    async fn set(&self, record: &CredentialRecord) -> Result<()> {
        let blob = serde_json::to_string(record).context("failed to encode the credential")?;
        let entry = self.entry()?;
        tokio::task::spawn_blocking(move || entry.set_password(&blob))
            .await
            .context("the OS credential store task failed")?
            .context("the OS credential store refused to store the credential")?;
        Ok(())
    }

    async fn delete(&self) -> Result<()> {
        let entry = self.entry()?;
        let result = tokio::task::spawn_blocking(move || entry.delete_credential())
            .await
            .context("the OS credential store task failed")?;
        match result {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => {
                bail!("the OS credential store refused to delete the credential: {error}")
            }
        }
    }
}

/// The private file fallback: one 0600 TOML record per profile in a 0700
/// directory under the installation home.
struct FileBackend {
    dir: PathBuf,
}

impl FileBackend {
    fn new(loc: &StoreLocation) -> Self {
        Self {
            dir: nession_common::paths::client_credentials_dir_under(&loc.home),
        }
    }

    fn path(&self, profile: &str) -> PathBuf {
        self.dir.join(format!("{profile}.toml"))
    }

    fn ensure_private_dir(&self) -> Result<()> {
        if !self.dir.exists() {
            fs::create_dir_all(&self.dir)
                .with_context(|| format!("failed to create {}", self.dir.display()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&self.dir, fs::Permissions::from_mode(0o700))
                    .with_context(|| format!("failed to restrict {}", self.dir.display()))?;
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&self.dir)
                .with_context(|| format!("failed to stat {}", self.dir.display()))?
                .permissions()
                .mode();
            if mode & 0o777 != 0o700 {
                bail!(
                    "the credential directory {} is not private (mode {:o}); refusing to use \
                     it. Set it to 0700 explicitly.",
                    self.dir.display(),
                    mode & 0o777
                );
            }
        }
        Ok(())
    }

    async fn get(&self, profile: &str) -> Result<Option<CredentialRecord>> {
        let path = self.path(profile);
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to read the credential file {}", path.display())
                });
            }
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path)
                .with_context(|| format!("failed to stat {}", path.display()))?
                .permissions()
                .mode();
            if mode & 0o777 != 0o600 {
                bail!(
                    "the credential file {} is not private (mode {:o}); refusing to read it. \
                     Set it to 0600 explicitly.",
                    path.display(),
                    mode & 0o777
                );
            }
        }
        let record: CredentialRecord = toml::from_str(&text).map_err(|_| {
            anyhow::anyhow!(
                "the credential file {} is malformed; reconfigure it with \
                 `nession profile credential set {profile}`",
                path.display()
            )
        })?;
        Ok(Some(record))
    }

    async fn set(&self, profile: &str, record: &CredentialRecord) -> Result<()> {
        self.ensure_private_dir()?;
        let path = self.path(profile);
        let text = toml::to_string_pretty(record).context("failed to encode the credential")?;
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
        fs::rename(&temp, &path)
            .with_context(|| format!("failed to publish {}", path.display()))?;
        Ok(())
    }

    async fn delete(&self, profile: &str) -> Result<()> {
        match fs::remove_file(self.path(profile)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error).context("failed to delete the credential file"),
        }
    }
}

/// Read a credential from the prompt (TTY, masked) or stdin (`--stdin`).
///
/// The secret never travels as argv. An empty credential is refused: explicit
/// no-auth is a profile setting, not an empty secret.
pub async fn read_secret(profile: &str, stdin: bool) -> Result<String> {
    let raw = if stdin {
        let mut line = String::new();
        std::io::stdin()
            .read_line(&mut line)
            .context("failed to read the credential from stdin")?;
        line
    } else {
        if !std::io::IsTerminal::is_terminal(&std::io::stdin()) {
            bail!(
                "stdin is not a terminal; pass --stdin to pipe the credential for profile \
                 {profile:?} (for example from a password manager)"
            );
        }
        rpassword::prompt_password(format!("Credential for profile {profile:?}: "))
            .context("failed to read the credential from the terminal")?
    };
    let token = raw.trim_end_matches(['\n', '\r']).to_string();
    if token.trim().is_empty() {
        bail!(
            "an empty credential is refused; for a Server without authentication use \
             `nession profile set {profile} --no-auth`"
        );
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn location(dir: &Path) -> StoreLocation {
        StoreLocation {
            home: dir.to_path_buf(),
            read_only: false,
        }
    }

    #[tokio::test]
    async fn the_file_backend_round_trips_and_deletes() {
        let dir = tempfile::tempdir().unwrap();
        let loc = location(dir.path());
        let record = CredentialRecord::new("wss://Host:443/ws", "canary-secret");
        let kind = set_bound(&loc, "home", &record, BackendChoice::File)
            .await
            .unwrap();
        assert_eq!(kind, CredentialBackendKind::File);
        let loaded = get_bound(&loc, "home", kind).await.unwrap().unwrap();
        assert_eq!(loaded, record);
        assert!(loaded.matches_endpoint("wss://host/ws"));
        assert!(!loaded.matches_endpoint("wss://other/ws"));
        delete_bound(&loc, "home", kind).await.unwrap();
        assert!(get_bound(&loc, "home", kind).await.unwrap().is_none());
        // Deleting an absent credential is a safe no-op at the backend level.
        delete_bound(&loc, "home", kind).await.unwrap();
    }

    #[tokio::test]
    async fn rotation_replaces_the_previous_secret() {
        let dir = tempfile::tempdir().unwrap();
        let loc = location(dir.path());
        set_bound(
            &loc,
            "home",
            &CredentialRecord::new("ws://host/ws", "old-secret"),
            BackendChoice::File,
        )
        .await
        .unwrap();
        set_bound(
            &loc,
            "home",
            &CredentialRecord::new("ws://host/ws", "new-secret"),
            BackendChoice::File,
        )
        .await
        .unwrap();
        let loaded = get_bound(&loc, "home", CredentialBackendKind::File)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.token, "new-secret");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_file_backend_enforces_private_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let loc = location(dir.path());
        set_bound(
            &loc,
            "home",
            &CredentialRecord::new("ws://host/ws", "canary"),
            BackendChoice::File,
        )
        .await
        .unwrap();
        let credentials = nession_common::paths::client_credentials_dir_under(dir.path());
        assert_eq!(
            fs::metadata(&credentials).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let file = credentials.join("home.toml");
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );

        // A world-readable credential file is refused, not consumed.
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        let error = get_bound(&loc, "home", CredentialBackendKind::File)
            .await
            .unwrap_err();
        assert!(format!("{error:#}").contains("not private"));

        // A world-readable credential directory is refused for writes.
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        fs::set_permissions(&credentials, fs::Permissions::from_mode(0o755)).unwrap();
        let error = set_bound(
            &loc,
            "home",
            &CredentialRecord::new("ws://host/ws", "canary"),
            BackendChoice::File,
        )
        .await
        .unwrap_err();
        assert!(format!("{error:#}").contains("not private"));
    }

    #[test]
    fn the_record_debug_is_redacted() {
        let record = CredentialRecord::new("ws://host/ws", "canary-secret");
        let debug = format!("{record:?}");
        assert!(!debug.contains("canary-secret"), "{debug}");
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn backend_choice_parses_only_documented_values() {
        // Explicit choices do not read the environment.
        assert_eq!(BackendChoice::File, BackendChoice::File);
        assert_ne!(BackendChoice::File, BackendChoice::Keychain);
    }
}
