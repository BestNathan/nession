//! The interruptible Current-replacement transaction (#4592).
//!
//! An upgrade **retains** the installation: both TOML configs, the Agent
//! identity, credentials and compatible durable state stay at their Current
//! paths. The archive receives independent copies of the old binaries and a
//! bounded, verified snapshot subset — never a rename of Current. Superseded
//! rule (#3173/#3232): "the new Current starts from defaults" no longer holds;
//! single-active, archive isolation and transaction recovery do.
//!
//! Every mutating phase is recorded in `<NESSION_HOME>/.install-transaction.json`
//! (schema 2) before it starts. The journal names the release homes, the exact
//! old/new binary digests, and the config preimage fingerprints that prove
//! Current's retained state was not disturbed. Recovery compares the
//! filesystem against that journal:
//!
//! - `staging`: nothing outside the staging directory changed; remove it.
//! - `snapshot` / `archive-committed`: restore the old binaries; Current's
//!   config/state were never moved, so their preimages are verified, not
//!   restored. The uncommitted archive is removed.
//! - `binary-swap`: if all three installed binaries match the new digests AND
//!   the published archive carries its manifest, the swap had finished —
//!   commit forward. Three binary digests alone never decide a commit. A
//!   mixed set is rolled back from the archive.
//!
//! Schema-1 journals (the superseded move-based transaction) are still
//! recovered by their own compatible owner below, or refused with precise
//! instructions — never guessed.
//!
//! Any ambiguity — a missing archive copy, a changed config preimage, an
//! unreadable journal — fails closed and leaves the journal in place so the
//! next invocation reports the exact repair instead of starting a half-install.

use crate::lifecycle::lock::LifecycleLock;
use crate::update::{download, release_config, replace, snapshot};
use crate::versions;
use anyhow::{bail, Context, Result};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// The durable transaction journal, relative to the Nession home.
pub const JOURNAL_FILE: &str = ".install-transaction.json";
const JOURNAL_SCHEMA: u32 = 2;
const STAGING_PREFIX: &str = ".stage-";
const SERVER_CONFIG: &str = "server-config.toml";
const AGENT_CONFIG: &str = "agent-config.toml";
const CONFIG_FILES: [&str; 2] = [AGENT_CONFIG, SERVER_CONFIG];

/// What `recover_journal_locked` found and did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recovery {
    NoJournal,
    /// Another process holds the lifecycle lock: an install is in progress.
    InstallInProgress,
    /// The interrupted transaction was rolled back; Current is unchanged.
    RolledBack {
        from: String,
        to: String,
    },
    /// The binary swap had actually completed; the transaction was finalized.
    Completed {
        from: String,
        to: String,
    },
    /// A committed journal or an empty staging directory was cleaned up.
    Cleaned {
        from: String,
        to: String,
    },
}

impl Recovery {
    pub fn describe(&self) -> Option<String> {
        match self {
            Recovery::NoJournal | Recovery::InstallInProgress => None,
            Recovery::RolledBack { from, to } => Some(format!(
                "Recovered an interrupted install: Current remains release {from}; \
                 release {to} was not applied."
            )),
            Recovery::Completed { from, to } => Some(format!(
                "Completed an interrupted install: Current is now release {to} \
                 (release {from} is archived)."
            )),
            Recovery::Cleaned { .. } => None,
        }
    }
}

/// The phases a Current replacement passes through, in order (schema 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Phase {
    Staging,
    Snapshot,
    ArchiveCommitted,
    BinarySwap,
    Committed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Journal {
    schema: u32,
    phase: Phase,
    from: String,
    to: String,
    pid: u32,
    home: PathBuf,
    install_dir: PathBuf,
    archive_dir: PathBuf,
    staging_dir: PathBuf,
    swapped: Vec<String>,
    old_digests: BTreeMap<String, String>,
    new_digests: BTreeMap<String, String>,
    /// SHA256 of each retained config at preflight. Recovery verifies these
    /// instead of moving anything: Current's state never leaves its path.
    config_preimages: BTreeMap<String, String>,
    /// Captured original config text, used only when an explicit migration
    /// wrote Current's config (the default path never does).
    #[serde(default)]
    server_config_original: Option<String>,
    #[serde(default)]
    agent_config_original: Option<String>,
}

/// The durable recovery record for `home`.
pub fn journal_path(home: &Path) -> PathBuf {
    home.join(JOURNAL_FILE)
}

/// Recover an interrupted install before any CLI command runs.
///
/// Returns `InstallInProgress` rather than blocking when another process holds
/// the lifecycle lock: the install that owns the journal will finish or crash,
/// and the next invocation will recover it.
pub fn recover_at_cli_start() -> Result<Recovery> {
    let home = nession_common::paths::nession_home()?;
    if !journal_path(&home).exists() {
        return Ok(Recovery::NoJournal);
    }
    let Some(_lock) = LifecycleLock::try_acquire()? else {
        return Ok(Recovery::InstallInProgress);
    };
    recover_journal_locked(&home)
}

/// Recover before a CLI command reads Current.
///
/// Help, version and the capability handshakes must work without a resolvable
/// Nession home and must not mutate the installation.
pub fn recover_before_command(args: &[std::ffi::OsString]) -> Result<()> {
    if should_skip_recovery(args) {
        return Ok(());
    }
    if let Some(message) = recover_at_cli_start()?.describe() {
        eprintln!("{message}");
    }
    Ok(())
}

fn should_skip_recovery(args: &[std::ffi::OsString]) -> bool {
    args.iter().skip(1).any(|argument| {
        matches!(
            argument.to_str(),
            Some(
                "--help"
                    | "-h"
                    | "help"
                    | "--version"
                    | "-V"
                    | "--lifecycle-contract"
                    | "--upgrade-contract"
                    | "--upgrade-config-check"
            )
        )
    })
}

/// Recover under an already-held lifecycle lock (or when no journal exists).
pub fn recover_journal_locked(home: &Path) -> Result<Recovery> {
    let path = journal_path(home);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Recovery::NoJournal)
        }
        Err(error) => {
            return Err(error).with_context(|| {
                format!("failed to read the install journal at {}", path.display())
            })
        }
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes).with_context(|| {
        format!(
            "the install journal at {} is unreadable; refusing to guess whether Current is \
             complete. Fix: inspect the journal and the versions directory, then remove the \
             journal only after restoring a complete release.",
            path.display()
        )
    })?;
    let schema = value
        .get("schema")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let recovery = match schema {
        1 => {
            let journal: legacy::JournalV1 = serde_json::from_value(value).with_context(|| {
                format!(
                    "the schema-1 install journal at {} is unreadable",
                    path.display()
                )
            })?;
            if journal.home != home {
                bail!(
                    "the install journal at {} belongs to {}, not {}; refusing to use it",
                    path.display(),
                    journal.home.display(),
                    home.display()
                );
            }
            legacy::recover(&journal)?
        }
        2 => {
            let journal: Journal = serde_json::from_value(value).with_context(|| {
                format!("the install journal at {} is unreadable", path.display())
            })?;
            if journal.home != home {
                bail!(
                    "the install journal at {} belongs to {}, not {}; refusing to use it",
                    path.display(),
                    journal.home.display(),
                    home.display()
                );
            }
            recover(&journal)?
        }
        other => bail!(
            "the install journal at {} has schema {other}; this CLI understands schemas 1 and \
             {JOURNAL_SCHEMA}. Refusing to mutate the installation.",
            path.display()
        ),
    };
    fs::remove_file(&path).with_context(|| {
        format!(
            "failed to remove the recovered journal at {}",
            path.display()
        )
    })?;
    Ok(recovery)
}

fn recover(journal: &Journal) -> Result<Recovery> {
    match journal.phase {
        Phase::Committed => Ok(Recovery::Cleaned {
            from: journal.from.clone(),
            to: journal.to.clone(),
        }),
        Phase::Staging => {
            remove_dir_if_exists(&journal.staging_dir)?;
            Ok(Recovery::Cleaned {
                from: journal.from.clone(),
                to: journal.to.clone(),
            })
        }
        Phase::Snapshot | Phase::ArchiveCommitted | Phase::BinarySwap => {
            if journal.phase == Phase::BinarySwap
                && all_installed_match_new(journal)?
                && journal.archive_dir.join(snapshot::MANIFEST_FILE).is_file()
            {
                return Ok(Recovery::Completed {
                    from: journal.from.clone(),
                    to: journal.to.clone(),
                });
            }
            rollback(journal)?;
            Ok(Recovery::RolledBack {
                from: journal.from.clone(),
                to: journal.to.clone(),
            })
        }
    }
}

fn all_installed_match_new(journal: &Journal) -> Result<bool> {
    for name in versions::RELEASE_BINARIES {
        let expected = journal
            .new_digests
            .get(name)
            .with_context(|| format!("the install journal has no new digest for {name}"))?;
        let installed = journal.install_dir.join(name);
        if !installed.is_file() {
            return Ok(false);
        }
        let actual = download::sha256_file(&installed)
            .with_context(|| format!("failed to hash {}", installed.display()))?;
        if &actual != expected {
            return Ok(false);
        }
    }
    Ok(true)
}

fn rollback(journal: &Journal) -> Result<()> {
    // A previous recovery may have restored the binaries and then been killed
    // before (or while) removing the archive/staging/journal. Prove the
    // restored state first so retry is idempotent.
    if rollback_already_complete(journal)? {
        remove_dir_if_exists(&journal.archive_dir)?;
        remove_dir_if_exists(&journal.staging_dir)?;
        return Ok(());
    }

    // 1. Read-only proof first: Current's config/state were never moved, so
    //    verify their preimages before mutating anything. A changed preimage
    //    is an external writer; recovery fails closed without overwriting it.
    verify_config_preimages(journal)?;

    // 2. Restore the old binaries from the archive (or staging before the
    //    publish rename).
    for name in versions::RELEASE_BINARIES {
        let archived = journal.archive_dir.join("bin").join(name);
        let staged = journal.staging_dir.join("bin").join(name);
        let source = if archived.is_file() {
            archived
        } else if staged.is_file() {
            staged
        } else {
            bail!(
                "cannot restore the pre-install {name}: neither {} nor {} exists. The journal \
                 was kept at {}; restore the archive before removing it.",
                archived.display(),
                staged.display(),
                journal_path(&journal.home).display()
            );
        };
        let destination = journal.install_dir.join(name);
        replace::atomic_replace(&source, &destination)
            .with_context(|| format!("failed to restore {name} from {}", source.display()))?;
        let expected = journal
            .old_digests
            .get(name)
            .with_context(|| format!("the install journal has no pre-install digest for {name}"))?;
        let actual = download::sha256_file(&destination)
            .with_context(|| format!("failed to hash the restored {}", destination.display()))?;
        if &actual != expected {
            bail!(
                "restored {name} at {} does not match its pre-install digest; refusing to \
                 continue. The journal was kept at {}.",
                destination.display(),
                journal_path(&journal.home).display()
            );
        }
        remove_atomic_temp(&journal.install_dir, name, journal.pid);
    }

    // 3. Restore captured original text only for configs an explicit
    //    migration wrote (the default retention path captures none).
    restore_migrated_configs(journal)?;

    // 4. The archive never committed; remove the transaction's tree so it
    //    cannot masquerade as a runnable release.
    remove_dir_if_exists(&journal.archive_dir)?;
    remove_dir_if_exists(&journal.staging_dir)?;
    Ok(())
}

/// Verify retained configs still match their preflight fingerprints.
fn verify_config_preimages(journal: &Journal) -> Result<()> {
    for (name, expected) in &journal.config_preimages {
        let path = journal.home.join(name);
        if !path.is_file() {
            bail!(
                "the retained config {} is missing after an interrupted install; refusing to \
                 guess. The journal was kept at {}.",
                path.display(),
                journal_path(&journal.home).display()
            );
        }
        let actual = download::sha256_file(&path)
            .with_context(|| format!("failed to hash {}", path.display()))?;
        if &actual != expected {
            bail!(
                "the retained config {} changed during the interrupted install (external \
                 writer); recovery will not overwrite it. The journal was kept at {}; \
                 reconcile the config manually, then remove the journal.",
                path.display(),
                journal_path(&journal.home).display()
            );
        }
    }
    Ok(())
}

/// Restore captured original text only for configs an explicit migration
/// wrote. The default retention path captures none, so this is a no-op there.
fn restore_migrated_configs(journal: &Journal) -> Result<()> {
    if let Some(original) = journal.server_config_original.as_deref() {
        let config = journal.home.join(SERVER_CONFIG);
        fs::write(&config, original)
            .with_context(|| format!("failed to restore the original {}", config.display()))?;
    }
    if let Some(original) = journal.agent_config_original.as_deref() {
        let config = journal.home.join(AGENT_CONFIG);
        fs::write(&config, original)
            .with_context(|| format!("failed to restore the original {}", config.display()))?;
    }
    Ok(())
}

/// Whether a previous rollback already restored the binaries and cleaned up.
fn rollback_already_complete(journal: &Journal) -> Result<bool> {
    for name in versions::RELEASE_BINARIES {
        let Some(expected) = journal.old_digests.get(name) else {
            return Ok(false);
        };
        let installed = journal.install_dir.join(name);
        if !installed.is_file() {
            return Ok(false);
        }
        let actual = download::sha256_file(&installed)
            .with_context(|| format!("failed to hash {}", installed.display()))?;
        if &actual != expected {
            return Ok(false);
        }
    }
    // Configs were never moved; their preimages must still hold.
    if verify_config_preimages(journal).is_err() {
        return Ok(false);
    }
    Ok(true)
}

fn remove_atomic_temp(install_dir: &Path, name: &str, pid: u32) {
    let _ = fs::remove_file(install_dir.join(format!(".{name}.tmp.{pid}")));
}

fn remove_dir_if_exists(path: &Path) -> Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("failed to remove {}", path.display())),
    }
}

/// Which injected failure or abort the test harness asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FaultPoint {
    Staging,
    SnapshotConfig,
    StateMove,
    Publish,
    BinarySwap,
    Commit,
}

impl FaultPoint {
    fn as_str(self) -> &'static str {
        match self {
            FaultPoint::Staging => "staging",
            FaultPoint::SnapshotConfig => "snapshot-config",
            FaultPoint::StateMove => "state-move",
            FaultPoint::Publish => "publish",
            FaultPoint::BinarySwap => "binary-swap",
            FaultPoint::Commit => "commit",
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct FaultPlan {
    point: Option<FaultPoint>,
    abort: bool,
}

const FAULT_ENV: &str = "NESSION_INSTALL_FAULT";
const ABORT_ENV: &str = "NESSION_INSTALL_ABORT";

fn parse_fault(value: Option<String>) -> Option<FaultPoint> {
    match value.as_deref() {
        Some("staging") => Some(FaultPoint::Staging),
        Some("snapshot-config") => Some(FaultPoint::SnapshotConfig),
        Some("state-move") => Some(FaultPoint::StateMove),
        Some("publish") => Some(FaultPoint::Publish),
        Some("binary-swap") => Some(FaultPoint::BinarySwap),
        Some("commit") => Some(FaultPoint::Commit),
        _ => None,
    }
}

fn fault_plan_from_env() -> FaultPlan {
    if cfg!(debug_assertions) {
        // Debug-only fault injection for the SC-04 failure matrix. A release
        // build never reads these names.
        let abort = parse_fault(std::env::var(ABORT_ENV).ok());
        let fail = parse_fault(std::env::var(FAULT_ENV).ok());
        let point = abort.or(fail);
        return FaultPlan {
            point,
            abort: abort.is_some() && abort == point,
        };
    }
    FaultPlan {
        point: None,
        abort: false,
    }
}

fn inject(fault: FaultPlan, point: FaultPoint) -> Result<()> {
    if fault.point != Some(point) {
        return Ok(());
    }
    if fault.abort {
        std::process::abort();
    }
    bail!(
        "injected install failure at phase '{}' (test-only fault injection)",
        point.as_str()
    )
}

/// Archive Current and install `to` as Current, retaining Current's
/// configuration, identity and durable state in place.
///
/// Caller holds the lifecycle lock and has already recovered any prior journal.
pub fn replace_current(
    home: &Path,
    install_dir: &Path,
    from: &Version,
    to: &Version,
    archive_dir: &Path,
    staged: &Path,
) -> Result<PathBuf> {
    replace_current_inner(
        home,
        install_dir,
        from,
        to,
        archive_dir,
        staged,
        fault_plan_from_env(),
    )
}

#[cfg(test)]
fn replace_current_with_fault(
    home: &Path,
    install_dir: &Path,
    from: &Version,
    to: &Version,
    archive_dir: &Path,
    staged: &Path,
    fault: FaultPlan,
) -> Result<PathBuf> {
    replace_current_inner(home, install_dir, from, to, archive_dir, staged, fault)
}

fn replace_current_inner(
    home: &Path,
    install_dir: &Path,
    from: &Version,
    to: &Version,
    archive_dir: &Path,
    staged: &Path,
    fault: FaultPlan,
) -> Result<PathBuf> {
    let journal_file = journal_path(home);
    if journal_file.exists() {
        bail!(
            "an interrupted install journal exists at {}; run any nession command again to \
             recover it before starting a new install",
            journal_file.display()
        );
    }
    for name in versions::RELEASE_BINARIES {
        if !install_dir.join(name).is_file() {
            bail!(
                "the Current installation is incomplete: {} is missing; refusing to replace it",
                install_dir.join(name).display()
            );
        }
        if !staged.join(name).is_file() {
            bail!(
                "the staged release is incomplete: {} is missing; refusing to archive Current",
                staged.join(name).display()
            );
        }
    }
    if archive_dir.exists() {
        bail!(
            "archive {} already exists; refusing to overwrite it",
            archive_dir.display()
        );
    }

    // Preflight: inventory the durable state, refuse active mounts/escaping
    // symlinks, bound the snapshot space, and prove the TARGET release can
    // parse and validate the retained configs before any mutation.
    let plan = snapshot::plan(home)
        .context("refusing to upgrade until the durable-state inventory is safe")?;
    let binary_bytes: u64 = versions::RELEASE_BINARIES
        .iter()
        .map(|name| {
            fs::metadata(install_dir.join(name))
                .map(|m| m.len())
                .unwrap_or(0)
        })
        .sum();
    // Headroom: the snapshot plus the staged binaries plus filesystem slack.
    let needed = plan
        .estimated_bytes
        .saturating_add(binary_bytes)
        .saturating_mul(2)
        .saturating_add(64 * 1024 * 1024);
    replace::check_disk_space(home, needed)
        .map_err(|error| anyhow::anyhow!("{error}"))
        .context("refusing to upgrade without space for the independent snapshot")?;

    let mut config_preimages = BTreeMap::new();
    for name in CONFIG_FILES {
        let path = home.join(name);
        if path.is_file() {
            let digest = download::sha256_file(&path)
                .with_context(|| format!("failed to fingerprint {}", path.display()))?;
            config_preimages.insert(name.to_string(), digest);
        }
    }

    validate_target_compatibility(staged, home, to)
        .context("refusing to replace Current before the target release proves compatibility")?;

    let old_digests = digests_for_dir(install_dir, "Current")?;
    let new_digests = digests_for_dir(staged, "staged release")?;
    let staging_dir = home
        .join("versions")
        .join(format!("{STAGING_PREFIX}{from}-{}", std::process::id()));
    if staging_dir.exists() {
        fs::remove_dir_all(&staging_dir).with_context(|| {
            format!(
                "failed to clear the stale staging directory {}",
                staging_dir.display()
            )
        })?;
    }

    let mut journal = Journal {
        schema: JOURNAL_SCHEMA,
        phase: Phase::Staging,
        from: from.to_string(),
        to: to.to_string(),
        pid: std::process::id(),
        home: home.to_path_buf(),
        install_dir: install_dir.to_path_buf(),
        archive_dir: archive_dir.to_path_buf(),
        staging_dir,
        swapped: Vec::new(),
        old_digests,
        new_digests,
        config_preimages,
        server_config_original: None,
        agent_config_original: None,
    };
    write_journal(&journal_file, &journal)?;

    match apply(&journal_file, &mut journal, staged, &plan, fault) {
        Ok(()) => {
            journal.phase = Phase::Committed;
            if let Err(error) = write_journal(&journal_file, &journal) {
                eprintln!(
                    "Warning: install completed but the journal could not be marked committed \
                     ({error}); the next command will verify and clean it up."
                );
            } else if let Err(error) = fs::remove_file(&journal_file) {
                eprintln!(
                    "Warning: install completed but {} could not be removed ({error}); the next \
                     command will clean it up.",
                    journal_file.display()
                );
            }
            Ok(archive_dir.to_path_buf())
        }
        Err(error) => match recover_journal_locked(home) {
            Ok(Recovery::Completed { .. }) => Err(error.context(
                "install failed at the commit boundary, but the verified binary swap had \
                     finished; the transaction was committed forward during recovery",
            )),
            Ok(_) => Err(error.context(
                "install failed; Current and its configuration/state were restored from \
                     the transaction journal",
            )),
            Err(rollback_error) => Err(error.context(format!(
                "install failed AND automatic recovery failed: {rollback_error:#}. \
                     The journal was retained at {}; every later command will report this \
                     instead of starting a half-installed release.",
                journal_file.display()
            ))),
        },
    }
}

/// The target capability handshake and config compatibility proof.
///
/// The TARGET binary owns validation: it must advertise the upgrade contract
/// and parse+validate staged copies of both retained configs with its own
/// schema. A failure refuses the upgrade before any mutation; the original
/// bytes are never rewritten by the installer.
fn validate_target_compatibility(staged: &Path, home: &Path, to: &Version) -> Result<()> {
    let cli = staged.join("nession");
    let budget = crate::update::policy::DEFAULT_METADATA_TIMEOUT;

    let contract = run_probe(&cli, &["--upgrade-contract"], budget)?;
    let stdout = String::from_utf8_lossy(&contract.stdout);
    let mut tokens = stdout.split_whitespace();
    let token = tokens.next().unwrap_or("");
    let reported = tokens
        .next()
        .and_then(|v| versions::normalize_version(v).ok());
    if !contract.status.success()
        || token != crate::update::UPGRADE_CONTRACT_TOKEN
        || reported.as_ref() != Some(to)
    {
        bail!(
            "the staged target release {to} does not advertise the upgrade contract \
             ({token:?}); it cannot prove retention compatibility. Refusing to replace Current."
        );
    }

    let probe_dir = home
        .join("versions")
        .join(format!(".probe-{}-{}", to, std::process::id()));
    let _ = fs::remove_dir_all(&probe_dir);
    fs::create_dir_all(&probe_dir)
        .with_context(|| format!("failed to create {}", probe_dir.display()))?;
    let result = (|| -> Result<()> {
        for (kind, name) in [("agent", AGENT_CONFIG), ("server", SERVER_CONFIG)] {
            let source = home.join(name);
            if !source.is_file() {
                continue;
            }
            let copy = probe_dir.join(name);
            fs::copy(&source, &copy)
                .with_context(|| format!("failed to stage {name} for validation"))?;
            let output = run_probe(
                &cli,
                &["--upgrade-config-check", kind, &copy.display().to_string()],
                budget,
            )?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                bail!(
                    "the target release {to} cannot validate the retained {kind} config: {}. \
                     The upgrade is refused before any mutation; repair the config (or declare \
                     an owner migration) and re-run.",
                    stderr.trim()
                );
            }
        }
        Ok(())
    })();
    let _ = fs::remove_dir_all(&probe_dir);
    result
}

/// Run a capability probe child with a bounded wait; kill only our own child
/// on expiry. Never blocks indefinitely on an external process.
fn run_probe(cli: &Path, args: &[&str], budget: Duration) -> Result<std::process::Output> {
    let mut child = std::process::Command::new(cli)
        .args(args)
        .env(
            nession_common::paths::NESSION_HOME_ENV,
            cli.parent().unwrap_or(Path::new(".")),
        )
        .env(crate::versions::NESSION_VERSION_DISPATCHED_ENV, "1")
        .env_remove(crate::versions::NESSION_VERSION_ENV)
        .env("NESSION_NO_UPDATE_CHECK", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .with_context(|| format!("failed to run the target probe at {}", cli.display()))?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .context("failed to collect the probe output");
            }
            Ok(None) => {
                if start.elapsed() >= budget {
                    let _ = child.kill();
                    let _ = child.wait();
                    bail!(
                        "the target probe at {} did not finish within {budget:?}; refusing to \
                         wait unbounded",
                        cli.display()
                    );
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => {
                return Err(error).context("failed to wait for the target probe");
            }
        }
    }
}

fn apply(
    journal_file: &Path,
    journal: &mut Journal,
    staged: &Path,
    plan: &snapshot::SnapshotPlan,
    fault: FaultPlan,
) -> Result<()> {
    // Phase 1: a complete copy of the Current binaries in a staging directory.
    let staging_bin = journal.staging_dir.join("bin");
    fs::create_dir_all(&staging_bin)
        .with_context(|| format!("failed to create {}", staging_bin.display()))?;
    for name in versions::RELEASE_BINARIES {
        copy_binary(&journal.install_dir.join(name), &staging_bin.join(name))?;
    }
    sync_directory(&journal.staging_dir);
    inject(fault, FaultPoint::Staging)?;

    // Phase 2: independent snapshot copies beside the binaries. Current's
    // authoritative paths are never touched.
    journal.phase = Phase::Snapshot;
    write_journal(journal_file, journal)?;

    // Config copies first (byte-for-byte), then the durable subset.
    for name in CONFIG_FILES {
        let source = journal.home.join(name);
        if source.is_file() {
            let destination = journal.staging_dir.join(name);
            fs::copy(&source, &destination)
                .with_context(|| format!("failed to snapshot the config {}", source.display()))?;
            private_mode(&destination);
        }
    }
    inject(fault, FaultPoint::SnapshotConfig)?;

    let capture = snapshot::capture(&journal.home, &journal.staging_dir, plan)
        .context("failed to snapshot the durable state")?;
    inject(fault, FaultPoint::StateMove)?;

    // Rewrite the ARCHIVED server config only for paths actually captured as
    // independent snapshots. Uncaptured generated defaults and explicit
    // external paths stay verbatim and become recorded dependencies.
    let mut rewrite_report = release_config::RewriteReport::default();
    let archived_server_config = journal.staging_dir.join(SERVER_CONFIG);
    if archived_server_config.is_file() {
        let content = fs::read_to_string(&archived_server_config)
            .with_context(|| format!("failed to read {}", archived_server_config.display()))?;
        let captured = release_config::CapturedPaths {
            db: capture.db_captured,
            // Content-addressed stores are referenced, never copied.
            blobs: false,
            build: false,
        };
        let (text, report) = release_config::rewrite_server_config_for_archive(
            &content,
            &journal.home,
            &journal.archive_dir,
            &captured,
        )
        .context("refusing to archive Current until its server config is relocatable")?;
        fs::write(&archived_server_config, text).with_context(|| {
            format!("failed to write the release-scoped {SERVER_CONFIG} into the archive")
        })?;
        private_mode(&archived_server_config);
        let moved_fields: Vec<&str> = report.rewritten().collect();
        if !moved_fields.is_empty() {
            println!(
                "Rewrote release-owned server paths for the archive: {}",
                moved_fields.join(", ")
            );
        }
        for field in report.retained() {
            println!("Kept the explicit external server path `{field}` unchanged.");
        }
        rewrite_report = report;
    }

    // The coverage manifest: binary-complete vs state-complete is explicit.
    let mut gaps = plan.gaps.clone();
    gaps.extend(capture.gaps.clone());
    let external_dependencies: Vec<String> = rewrite_report
        .external_dependencies()
        .map(std::string::ToString::to_string)
        .collect();
    let state_complete = capture.gaps.is_empty()
        && !plan
            .gaps
            .iter()
            .any(|gap| gap.contains("unknown durable entry") || gap.contains("symlink"));
    let mut configs = BTreeMap::new();
    for name in CONFIG_FILES {
        let archived = journal.staging_dir.join(name);
        if archived.is_file() {
            configs.insert(
                name.to_string(),
                snapshot::ConfigCoverage {
                    digest: download::sha256_file(&archived)?,
                    rewritten_fields: rewrite_report
                        .rewritten()
                        .filter(|_| name == SERVER_CONFIG)
                        .map(std::string::ToString::to_string)
                        .collect(),
                    retained_fields: rewrite_report
                        .retained()
                        .filter(|_| name == SERVER_CONFIG)
                        .map(std::string::ToString::to_string)
                        .collect(),
                },
            );
        }
    }
    let manifest = snapshot::Manifest {
        schema: snapshot::MANIFEST_SCHEMA,
        release: journal.from.clone(),
        created_by: crate::update::UPGRADE_CONTRACT_TOKEN.to_string(),
        binaries: journal.old_digests.clone(),
        configs,
        state: capture.digests,
        references: plan.references.clone(),
        gaps,
        external_dependencies,
        state_complete,
    };
    snapshot::write_manifest(&journal.staging_dir, &manifest)?;
    sync_directory(&journal.home);
    sync_directory(&journal.staging_dir);

    // Phase 3: one atomic rename publishes the complete archive (with its
    // manifest). A crash before this leaves only a staging directory.
    fs::rename(&journal.staging_dir, &journal.archive_dir).with_context(|| {
        format!(
            "failed to publish the archive {}",
            journal.archive_dir.display()
        )
    })?;
    if let Some(parent) = journal.archive_dir.parent() {
        sync_directory(parent);
    }
    journal.phase = Phase::ArchiveCommitted;
    write_journal(journal_file, journal)?;
    inject(fault, FaultPoint::Publish)?;

    // Phase 4: swap the binaries. Re-verify the retained config preimages
    // under the lock first: an external writer that changed the inputs since
    // preflight fails the transaction before any Current mutation.
    verify_config_preimages(journal)
        .context("the retained configuration changed during the install; refusing to swap")?;
    journal.phase = Phase::BinarySwap;
    write_journal(journal_file, journal)?;
    for (index, name) in versions::RELEASE_BINARIES.iter().enumerate() {
        replace::atomic_replace(&staged.join(name), &journal.install_dir.join(name))
            .with_context(|| format!("failed to install release {name}"))?;
        journal.swapped.push((*name).to_string());
        write_journal(journal_file, journal)?;
        if index == 0 {
            inject(fault, FaultPoint::BinarySwap)?;
        }
    }
    sync_directory(&journal.install_dir);

    // Phase 5: validate coherence before committing — all three target
    // digests, the published manifest, and the retained config preimages.
    if !all_installed_match_new(journal)? {
        bail!("the installed binaries do not match the target digests after the swap");
    }
    if !journal.archive_dir.join(snapshot::MANIFEST_FILE).is_file() {
        bail!("the published archive has no coverage manifest; refusing to commit");
    }
    verify_config_preimages(journal)
        .context("the retained configuration changed during the swap; refusing to commit")?;
    inject(fault, FaultPoint::Commit)?;
    Ok(())
}

fn digests_for_dir(dir: &Path, label: &str) -> Result<BTreeMap<String, String>> {
    let mut digests = BTreeMap::new();
    for name in versions::RELEASE_BINARIES {
        let path = dir.join(name);
        let digest = download::sha256_file(&path)
            .with_context(|| format!("failed to hash the {label} binary {}", path.display()))?;
        digests.insert(name.to_string(), digest);
    }
    Ok(digests)
}

fn write_journal(path: &Path, journal: &Journal) -> Result<()> {
    let temp = path.with_file_name(format!("{JOURNAL_FILE}.tmp"));
    let body = serde_json::to_vec_pretty(journal)
        .context("failed to serialize the install transaction journal")?;
    // The journal may capture original config text including credentials.
    // It must never be group/world-readable.
    let mut options = fs::OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .with_context(|| format!("failed to create the install journal at {}", temp.display()))?;
    file.write_all(&body)
        .with_context(|| format!("failed to write the install journal at {}", temp.display()))?;
    file.sync_all()
        .with_context(|| format!("failed to sync the install journal at {}", temp.display()))?;
    drop(file);
    fs::rename(&temp, path).with_context(|| {
        format!(
            "failed to publish the install journal at {}",
            path.display()
        )
    })?;
    if let Some(parent) = path.parent() {
        sync_directory(parent);
    }
    Ok(())
}

fn sync_directory(path: &Path) {
    // Best effort: not every filesystem supports directory fsync.
    if let Ok(dir) = fs::File::open(path) {
        let _ = dir.sync_all();
    }
}

fn copy_binary(source: &Path, destination: &Path) -> Result<()> {
    fs::copy(source, destination).with_context(|| {
        format!(
            "failed to copy {} to {}",
            source.display(),
            destination.display()
        )
    })?;
    replace::set_executable(destination)
        .with_context(|| format!("failed to mark {} executable", destination.display()))?;
    Ok(())
}

fn private_mode(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// Install an older release into `target_dir` only.
///
/// The archive is assembled in a staging directory and published by one
/// rename, so a final `versions/<version>` is never half-copied. Current,
/// configuration and durable state are untouched.
pub fn archive_only(target_dir: &Path, staged: &Path) -> Result<PathBuf> {
    if target_dir.exists() {
        if versions::is_complete_archive(target_dir) {
            return Ok(target_dir.to_path_buf());
        }
        bail!(
            "archive {} exists but is incomplete; remove it before reinstalling",
            target_dir.display()
        );
    }
    for name in versions::RELEASE_BINARIES {
        if !staged.join(name).is_file() {
            bail!(
                "the staged release is incomplete: {} is missing",
                staged.join(name).display()
            );
        }
    }
    let parent = target_dir.parent().with_context(|| {
        format!(
            "the archive path {} has no parent directory",
            target_dir.display()
        )
    })?;
    fs::create_dir_all(parent)
        .with_context(|| format!("failed to create the versions root {}", parent.display()))?;
    let label = target_dir
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "release".to_string());
    let staging = parent.join(format!("{STAGING_PREFIX}{label}-{}", std::process::id()));
    remove_dir_if_exists(&staging)?;
    let result = (|| -> Result<()> {
        let bin = staging.join("bin");
        fs::create_dir_all(&bin).with_context(|| format!("failed to create {}", bin.display()))?;
        for name in versions::RELEASE_BINARIES {
            copy_binary(&staged.join(name), &bin.join(name))?;
        }
        sync_directory(&staging);
        sync_directory(&bin);
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    match fs::rename(&staging, target_dir) {
        Ok(()) => {
            sync_directory(parent);
            Ok(target_dir.to_path_buf())
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            if versions::is_complete_archive(target_dir) {
                return Ok(target_dir.to_path_buf());
            }
            Err(error).with_context(|| {
                format!(
                    "failed to publish the archive {}; Current was not changed",
                    target_dir.display()
                )
            })
        }
    }
}

/// The superseded schema-1 move-based transaction, kept only as a compatible
/// recovery owner. New installs never write schema 1.
mod legacy {
    use super::{
        bail, download, fs, journal_path, remove_atomic_temp, remove_dir_if_exists, replace,
        versions, BTreeMap, Context, Deserialize, PathBuf, Recovery, Result, SERVER_CONFIG,
    };

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
    #[serde(rename_all = "kebab-case")]
    pub enum PhaseV1 {
        Staging,
        StateMove,
        ArchiveCommitted,
        BinarySwap,
        Committed,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct MovePair {
        pub from: PathBuf,
        pub to: PathBuf,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct JournalV1 {
        #[allow(dead_code)]
        pub schema: u32,
        pub phase: PhaseV1,
        pub from: String,
        pub to: String,
        pub pid: u32,
        pub home: PathBuf,
        pub install_dir: PathBuf,
        pub archive_dir: PathBuf,
        pub staging_dir: PathBuf,
        pub moved: Vec<MovePair>,
        #[allow(dead_code)]
        pub swapped: Vec<String>,
        pub old_digests: BTreeMap<String, String>,
        pub new_digests: BTreeMap<String, String>,
        pub server_config_original: Option<String>,
    }

    pub fn recover(journal: &JournalV1) -> Result<Recovery> {
        match journal.phase {
            PhaseV1::Committed => Ok(Recovery::Cleaned {
                from: journal.from.clone(),
                to: journal.to.clone(),
            }),
            PhaseV1::Staging => {
                remove_dir_if_exists(&journal.staging_dir)?;
                Ok(Recovery::Cleaned {
                    from: journal.from.clone(),
                    to: journal.to.clone(),
                })
            }
            PhaseV1::StateMove | PhaseV1::ArchiveCommitted | PhaseV1::BinarySwap => {
                if journal.phase == PhaseV1::BinarySwap && all_installed_match_new_v1(journal)? {
                    return Ok(Recovery::Completed {
                        from: journal.from.clone(),
                        to: journal.to.clone(),
                    });
                }
                rollback_v1(journal)?;
                Ok(Recovery::RolledBack {
                    from: journal.from.clone(),
                    to: journal.to.clone(),
                })
            }
        }
    }

    fn all_installed_match_new_v1(journal: &JournalV1) -> Result<bool> {
        for name in versions::RELEASE_BINARIES {
            let expected = journal
                .new_digests
                .get(name)
                .with_context(|| format!("the install journal has no new digest for {name}"))?;
            let installed = journal.install_dir.join(name);
            if !installed.is_file() {
                return Ok(false);
            }
            let actual = download::sha256_file(&installed)
                .with_context(|| format!("failed to hash {}", installed.display()))?;
            if &actual != expected {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn rollback_v1(journal: &JournalV1) -> Result<()> {
        if rollback_already_complete_v1(journal)? {
            restore_original_config_v1(journal)?;
            remove_dir_if_exists(&journal.archive_dir)?;
            remove_dir_if_exists(&journal.staging_dir)?;
            return Ok(());
        }
        for name in versions::RELEASE_BINARIES {
            let archived = journal.archive_dir.join("bin").join(name);
            let staged = journal.staging_dir.join("bin").join(name);
            let source = if archived.is_file() {
                archived
            } else if staged.is_file() {
                staged
            } else {
                bail!(
                    "cannot restore the pre-install {name}: neither {} nor {} exists. The \
                     journal was kept at {}; restore the archive before removing it.",
                    archived.display(),
                    staged.display(),
                    journal_path(&journal.home).display()
                );
            };
            let destination = journal.install_dir.join(name);
            replace::atomic_replace(&source, &destination)
                .with_context(|| format!("failed to restore {name} from {}", source.display()))?;
            let expected = journal.old_digests.get(name).with_context(|| {
                format!("the install journal has no pre-install digest for {name}")
            })?;
            let actual = download::sha256_file(&destination).with_context(|| {
                format!("failed to hash the restored {}", destination.display())
            })?;
            if &actual != expected {
                bail!(
                    "restored {name} at {} does not match its pre-install digest; refusing to \
                     continue. The journal was kept at {}.",
                    destination.display(),
                    journal_path(&journal.home).display()
                );
            }
            remove_atomic_temp(&journal.install_dir, name, journal.pid);
        }
        for pair in &journal.moved {
            restore_entry_v1(journal, pair)?;
        }
        restore_original_config_v1(journal)?;
        remove_dir_if_exists(&journal.archive_dir)?;
        remove_dir_if_exists(&journal.staging_dir)?;
        Ok(())
    }

    fn restore_original_config_v1(journal: &JournalV1) -> Result<()> {
        if let Some(original) = journal.server_config_original.as_deref() {
            let config = journal.home.join(SERVER_CONFIG);
            fs::write(&config, original)
                .with_context(|| format!("failed to restore the original {}", config.display()))?;
        }
        Ok(())
    }

    fn rollback_already_complete_v1(journal: &JournalV1) -> Result<bool> {
        for name in versions::RELEASE_BINARIES {
            let Some(expected) = journal.old_digests.get(name) else {
                return Ok(false);
            };
            let installed = journal.install_dir.join(name);
            if !installed.is_file() {
                return Ok(false);
            }
            let actual = download::sha256_file(&installed)
                .with_context(|| format!("failed to hash {}", installed.display()))?;
            if &actual != expected {
                return Ok(false);
            }
        }
        for pair in &journal.moved {
            let name = pair.to.file_name().with_context(|| {
                format!("the journal entry {} has no file name", pair.to.display())
            })?;
            let staged = journal.staging_dir.join(name);
            if !pair.from.exists() || pair.to.exists() || staged.exists() {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn restore_entry_v1(journal: &JournalV1, pair: &MovePair) -> Result<()> {
        let name = pair
            .to
            .file_name()
            .with_context(|| format!("the journal entry {} has no file name", pair.to.display()))?;
        let staged = journal.staging_dir.join(name);
        let in_archive = pair.to.exists();
        let in_staging = staged.exists();
        if pair.from.exists() {
            if in_archive || in_staging {
                bail!(
                    "{} exists both at its original location and inside the transaction tree \
                     ({} or {}); refusing to choose during recovery. The journal was kept.",
                    pair.from.display(),
                    pair.to.display(),
                    staged.display()
                );
            }
            return Ok(());
        }
        let source = if in_archive {
            &pair.to
        } else if in_staging {
            &staged
        } else {
            bail!(
                "{} is missing from both the archive ({}) and staging ({}); cannot restore it. \
                 The journal was kept.",
                name.to_string_lossy(),
                pair.to.display(),
                staged.display()
            );
        };
        if let Some(parent) = pair.from.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        fs::rename(source, &pair.from).with_context(|| {
            format!(
                "failed to restore {} from {}",
                pair.from.display(),
                source.display()
            )
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    fn write_binary(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }

    /// A real SQLite database: the snapshot owner uses the backup API, which
    /// refuses a non-database file (that failure is a coverage gap, tested in
    /// snapshot.rs).
    fn write_marker_db(path: &Path, marker: &str) {
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.execute_batch("CREATE TABLE marker(v TEXT);").unwrap();
        conn.execute("INSERT INTO marker VALUES (?1)", [marker])
            .unwrap();
    }

    fn read_marker_db(path: &Path) -> String {
        let conn =
            rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        conn.query_row("SELECT v FROM marker", [], |row| row.get(0))
            .unwrap()
    }

    /// A staged target CLI fixture that advertises the upgrade contract and
    /// validates configs by exit code. The real handshake is exercised by the
    /// runtime Cases; unit tests use this script to drive the transaction.
    fn write_target_cli(staged: &Path, version: &str, fail_config: bool) {
        let script = format!(
            "#!/bin/sh\n\
             case \"$1\" in\n\
             --upgrade-contract) echo \"{} {version}\"; exit 0 ;;\n\
             --upgrade-config-check) if [ \"{}\" = 1 ]; then echo \"invalid config\" >&2; exit 1; fi; echo ok; exit 0 ;;\n\
             --version) echo \"nession {version}\"; exit 0 ;;\n\
             esac\n\
             exit 2\n",
            crate::update::UPGRADE_CONTRACT_TOKEN,
            if fail_config { 1 } else { 0 },
        );
        write_binary(&staged.join("nession"), &script);
    }

    struct Fixture {
        #[allow(dead_code)]
        root: TempDir,
        home: PathBuf,
        install_dir: PathBuf,
        staged: PathBuf,
        archive: PathBuf,
    }

    fn fixture() -> Fixture {
        let root = TempDir::new().unwrap();
        let home = root.path().join("home");
        let install_dir = root.path().join("install");
        for name in versions::RELEASE_BINARIES {
            write_binary(&install_dir.join(name), &format!("old-{name}"));
        }
        let staged = root.path().join("staged");
        for name in versions::RELEASE_BINARIES {
            write_binary(&staged.join(name), &format!("new-{name}"));
        }
        write_target_cli(&staged, "1.2.0", false);
        fs::create_dir_all(home.join("server")).unwrap();
        write_marker_db(&home.join("server/server.db"), "old-db");
        fs::create_dir_all(home.join("agent")).unwrap();
        fs::write(home.join("agent/identity"), "old-id").unwrap();
        fs::write(home.join("agent-config.toml"), "agent-config").unwrap();
        let config = format!(
            "listen_address = \"127.0.0.1:19090\"\n\
             db_path = \"{}\"\n\
             image_blob_dir = \"{}\"\n\
             image_build_dir = \"{}\"\n",
            nession_common::paths::server_db_path_under(&home).display(),
            nession_common::paths::server_image_blob_dir_under(&home).display(),
            nession_common::paths::server_image_build_dir_under(&home).display(),
        );
        fs::write(home.join("server-config.toml"), config).unwrap();
        let archive = home.join("versions/0.35.0");
        Fixture {
            root,
            home,
            install_dir,
            staged,
            archive,
        }
    }

    fn replace(fixture: &Fixture) -> Result<PathBuf> {
        replace_current(
            &fixture.home,
            &fixture.install_dir,
            &Version::new(0, 35, 0),
            &Version::new(1, 2, 0),
            &fixture.archive,
            &fixture.staged,
        )
    }

    fn installed(fixture: &Fixture, name: &str) -> String {
        fs::read_to_string(fixture.install_dir.join(name)).unwrap()
    }

    fn archived(fixture: &Fixture, name: &str) -> String {
        fs::read_to_string(fixture.archive.join("bin").join(name)).unwrap()
    }

    fn assert_old_current(fixture: &Fixture) {
        for name in versions::RELEASE_BINARIES {
            assert_eq!(installed(fixture, name), format!("old-{name}"));
        }
        assert_eq!(
            read_marker_db(&fixture.home.join("server/server.db")),
            "old-db"
        );
        assert_eq!(
            fs::read_to_string(fixture.home.join("agent/identity")).unwrap(),
            "old-id"
        );
        assert_eq!(
            fs::read_to_string(fixture.home.join("agent-config.toml")).unwrap(),
            "agent-config"
        );
        assert!(
            !fixture.archive.exists(),
            "a rolled-back archive must not exist"
        );
        assert!(!journal_path(&fixture.home).exists());
    }

    #[test]
    fn a_completed_replace_retains_current_and_archives_independent_copies() {
        let fixture = fixture();
        let original_server_config =
            fs::read_to_string(fixture.home.join("server-config.toml")).unwrap();
        replace(&fixture).unwrap();

        for name in versions::RELEASE_BINARIES {
            assert_eq!(
                installed(&fixture, name),
                fs::read_to_string(fixture.staged.join(name)).unwrap(),
                "Current must be the target release's {name}"
            );
            assert_eq!(archived(&fixture, name), format!("old-{name}"));
        }
        // SC-01: Current keeps both configs byte-for-byte at the same paths.
        assert_eq!(
            fs::read_to_string(fixture.home.join("server-config.toml")).unwrap(),
            original_server_config
        );
        assert_eq!(
            fs::read_to_string(fixture.home.join("agent-config.toml")).unwrap(),
            "agent-config"
        );
        // Current keeps its identity and durable state.
        assert_eq!(
            fs::read_to_string(fixture.home.join("agent/identity")).unwrap(),
            "old-id"
        );
        assert_eq!(
            read_marker_db(&fixture.home.join("server/server.db")),
            "old-db"
        );
        // The archive's database is an independent consistent snapshot.
        assert_eq!(
            read_marker_db(&fixture.archive.join("server/server.db")),
            "old-db"
        );
        // The archive has independent copies.
        assert_eq!(
            fs::read_to_string(fixture.archive.join("agent-config.toml")).unwrap(),
            "agent-config"
        );
        assert!(fixture.archive.join("agent/identity").is_file());
        assert_eq!(
            fs::read_to_string(fixture.archive.join("agent/identity")).unwrap(),
            "old-id"
        );
        // The archived server config rewrote only the captured db path; the
        // uncaptured CAS/build defaults stay verbatim (recorded dependencies).
        let archived_config = fs::read_to_string(fixture.archive.join(SERVER_CONFIG)).unwrap();
        assert!(archived_config.contains(
            &nession_common::paths::server_db_path_under(&fixture.archive)
                .display()
                .to_string()
        ));
        assert!(archived_config.contains(
            &nession_common::paths::server_image_blob_dir_under(&fixture.home)
                .display()
                .to_string()
        ));
        // The manifest records coverage honestly.
        let manifest = snapshot::read_manifest(&fixture.archive).unwrap();
        assert_eq!(manifest.release, "0.35.0");
        assert!(manifest.state.contains_key("agent/identity"));
        assert!(!journal_path(&fixture.home).exists());
    }

    #[test]
    fn a_staging_failure_leaves_current_untouched() {
        let fixture = fixture();
        let original_config = fs::read_to_string(fixture.home.join("server-config.toml")).unwrap();
        let error = replace_current_with_fault(
            &fixture.home,
            &fixture.install_dir,
            &Version::new(0, 35, 0),
            &Version::new(1, 2, 0),
            &fixture.archive,
            &fixture.staged,
            FaultPlan {
                point: Some(FaultPoint::Staging),
                abort: false,
            },
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("injected install failure"));
        assert_old_current(&fixture);
        assert_eq!(
            fs::read_to_string(fixture.home.join("server-config.toml")).unwrap(),
            original_config,
            "the config is untouched"
        );
    }

    #[test]
    fn a_snapshot_failure_restores_the_binaries_and_keeps_state() {
        let fixture = fixture();
        let original_config = fs::read_to_string(fixture.home.join("server-config.toml")).unwrap();
        let error = replace_current_with_fault(
            &fixture.home,
            &fixture.install_dir,
            &Version::new(0, 35, 0),
            &Version::new(1, 2, 0),
            &fixture.archive,
            &fixture.staged,
            FaultPlan {
                point: Some(FaultPoint::StateMove),
                abort: false,
            },
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("injected install failure"));
        assert_old_current(&fixture);
        assert_eq!(
            fs::read_to_string(fixture.home.join("server-config.toml")).unwrap(),
            original_config,
            "the original config text must survive verbatim"
        );
    }

    #[test]
    fn a_binary_swap_failure_restores_the_mixed_binaries() {
        let fixture = fixture();
        let error = replace_current_with_fault(
            &fixture.home,
            &fixture.install_dir,
            &Version::new(0, 35, 0),
            &Version::new(1, 2, 0),
            &fixture.archive,
            &fixture.staged,
            FaultPlan {
                point: Some(FaultPoint::BinarySwap),
                abort: false,
            },
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("injected install failure"));
        assert_old_current(&fixture);
    }

    #[test]
    fn a_publish_failure_rolls_back() {
        let fixture = fixture();
        let error = replace_current_with_fault(
            &fixture.home,
            &fixture.install_dir,
            &Version::new(0, 35, 0),
            &Version::new(1, 2, 0),
            &fixture.archive,
            &fixture.staged,
            FaultPlan {
                point: Some(FaultPoint::Publish),
                abort: false,
            },
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("injected install failure"));
        assert_old_current(&fixture);
    }

    /// A crash at the commit boundary lands AFTER the swap and its coherence
    /// validation: recovery must commit forward, not roll back a verified
    /// complete install.
    #[test]
    fn a_commit_boundary_crash_commits_forward() {
        let fixture = fixture();
        let error = replace_current_with_fault(
            &fixture.home,
            &fixture.install_dir,
            &Version::new(0, 35, 0),
            &Version::new(1, 2, 0),
            &fixture.archive,
            &fixture.staged,
            FaultPlan {
                point: Some(FaultPoint::Commit),
                abort: false,
            },
        )
        .unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("injected install failure"), "{message}");
        assert!(
            message.contains("committed forward during recovery"),
            "{message}"
        );
        for name in versions::RELEASE_BINARIES {
            assert_eq!(
                installed(&fixture, name),
                fs::read_to_string(fixture.staged.join(name)).unwrap()
            );
        }
        assert!(fixture.archive.join(snapshot::MANIFEST_FILE).is_file());
        assert!(!journal_path(&fixture.home).exists());
        // Retention still holds: Current's state was never moved.
        assert_eq!(
            fs::read_to_string(fixture.home.join("agent-config.toml")).unwrap(),
            "agent-config"
        );
    }

    #[test]
    fn a_crash_after_staging_is_cleaned_on_the_next_recovery() {
        let fixture = fixture();
        let journal = |phase, staging: &Path| Journal {
            schema: JOURNAL_SCHEMA,
            phase,
            from: "0.35.0".into(),
            to: "1.2.0".into(),
            pid: std::process::id(),
            home: fixture.home.clone(),
            install_dir: fixture.install_dir.clone(),
            archive_dir: fixture.archive.clone(),
            staging_dir: staging.to_path_buf(),
            swapped: Vec::new(),
            old_digests: BTreeMap::new(),
            new_digests: BTreeMap::new(),
            config_preimages: BTreeMap::new(),
            server_config_original: None,
            agent_config_original: None,
        };
        let staging = fixture.home.join("versions/.stage-0.35.0-1");
        fs::create_dir_all(staging.join("bin")).unwrap();
        write_journal(
            &journal_path(&fixture.home),
            &journal(Phase::Staging, &staging),
        )
        .unwrap();

        let recovery = recover_journal_locked(&fixture.home).unwrap();
        assert!(matches!(recovery, Recovery::Cleaned { .. }));
        assert!(!staging.exists());
        assert!(!journal_path(&fixture.home).exists());
        assert_old_current(&fixture);
    }

    /// Build the on-disk shape of a binary-swap crash.
    fn binary_swap_crash(fixture: &Fixture, new_count: usize, archive_present: bool) -> Journal {
        let archive = fixture.home.join("versions/0.35.0");
        let mut old = BTreeMap::new();
        let mut new = BTreeMap::new();
        if archive_present {
            fs::create_dir_all(archive.join("bin")).unwrap();
            // A published archive carries its manifest; commit-forward
            // requires it, not binary digests alone.
            snapshot::write_manifest(
                &archive,
                &snapshot::Manifest {
                    schema: snapshot::MANIFEST_SCHEMA,
                    release: "0.35.0".into(),
                    created_by: crate::update::UPGRADE_CONTRACT_TOKEN.into(),
                    binaries: BTreeMap::new(),
                    configs: BTreeMap::new(),
                    state: BTreeMap::new(),
                    references: Vec::new(),
                    gaps: Vec::new(),
                    external_dependencies: Vec::new(),
                    state_complete: true,
                },
            )
            .unwrap();
        }
        for (index, name) in versions::RELEASE_BINARIES.iter().enumerate() {
            if archive_present {
                write_binary(&archive.join("bin").join(name), &format!("old-{name}"));
                old.insert(
                    name.to_string(),
                    download::sha256_file(&archive.join("bin").join(name)).unwrap(),
                );
            }
            if index < new_count {
                // The swapped-in bytes are the staged release's actual bytes
                // (the staged CLI is a capability script, not a text marker).
                fs::copy(fixture.staged.join(name), fixture.install_dir.join(name)).unwrap();
            } else {
                write_binary(&fixture.install_dir.join(name), &format!("old-{name}"));
            }
            new.insert(
                name.to_string(),
                download::sha256_file(&fixture.staged.join(name)).unwrap(),
            );
        }
        Journal {
            schema: JOURNAL_SCHEMA,
            phase: Phase::BinarySwap,
            from: "0.35.0".into(),
            to: "1.2.0".into(),
            pid: std::process::id(),
            home: fixture.home.clone(),
            install_dir: fixture.install_dir.clone(),
            archive_dir: archive,
            staging_dir: fixture.home.join("versions/.stage-gone"),
            swapped: versions::RELEASE_BINARIES
                .iter()
                .take(new_count)
                .map(|name| (*name).to_string())
                .collect(),
            old_digests: old,
            new_digests: new,
            config_preimages: BTreeMap::new(),
            server_config_original: None,
            agent_config_original: None,
        }
    }

    #[test]
    fn a_mixed_binary_swap_is_rolled_back_from_the_archive() {
        let fixture = fixture();
        let journal = binary_swap_crash(&fixture, 1, true);
        write_journal(&journal_path(&fixture.home), &journal).unwrap();

        let recovery = recover_journal_locked(&fixture.home).unwrap();
        assert!(matches!(recovery, Recovery::RolledBack { .. }));
        for name in versions::RELEASE_BINARIES {
            assert_eq!(installed(&fixture, name), format!("old-{name}"));
        }
        assert!(!journal.archive_dir.exists());
        assert!(!journal_path(&fixture.home).exists());
    }

    #[test]
    fn a_crash_after_all_swaps_commits_forward() {
        let fixture = fixture();
        let journal = binary_swap_crash(&fixture, 3, true);
        write_journal(&journal_path(&fixture.home), &journal).unwrap();

        let recovery = recover_journal_locked(&fixture.home).unwrap();
        assert!(matches!(recovery, Recovery::Completed { .. }));
        assert!(!journal_path(&fixture.home).exists());
        for name in versions::RELEASE_BINARIES {
            assert_eq!(
                installed(&fixture, name),
                fs::read_to_string(fixture.staged.join(name)).unwrap()
            );
        }
        assert!(journal.archive_dir.join("bin/nession").is_file());
    }

    #[test]
    fn three_new_binaries_without_a_manifest_do_not_commit_forward() {
        let fixture = fixture();
        let journal = binary_swap_crash(&fixture, 3, true);
        fs::remove_file(journal.archive_dir.join(snapshot::MANIFEST_FILE)).unwrap();
        write_journal(&journal_path(&fixture.home), &journal).unwrap();

        let recovery = recover_journal_locked(&fixture.home).unwrap();
        assert!(
            matches!(recovery, Recovery::RolledBack { .. }),
            "binary digests alone must not decide a commit"
        );
        for name in versions::RELEASE_BINARIES {
            assert_eq!(installed(&fixture, name), format!("old-{name}"));
        }
    }

    #[test]
    fn a_missing_archive_during_binary_swap_recovery_fails_closed() {
        let fixture = fixture();
        let journal = binary_swap_crash(&fixture, 1, false);
        write_journal(&journal_path(&fixture.home), &journal).unwrap();
        let error = recover_journal_locked(&fixture.home).unwrap_err();
        assert!(
            format!("{error:#}").contains("cannot restore the pre-install"),
            "{error:#}"
        );
        assert!(
            journal_path(&fixture.home).exists(),
            "an unrecovered transaction must keep its journal for diagnosis"
        );
    }

    #[test]
    fn an_unreadable_journal_is_not_guessed() {
        let fixture = fixture();
        fs::write(journal_path(&fixture.home), "{not json").unwrap();
        let error = recover_journal_locked(&fixture.home).unwrap_err();
        assert!(format!("{error:#}").contains("unreadable"), "{error:#}");
        assert!(journal_path(&fixture.home).exists());
    }

    #[test]
    fn an_unknown_journal_schema_is_refused() {
        let fixture = fixture();
        fs::write(
            journal_path(&fixture.home),
            format!(
                "{{\"schema\": 99, \"home\": \"{}\"}}",
                fixture.home.display()
            ),
        )
        .unwrap();
        let error = recover_journal_locked(&fixture.home).unwrap_err();
        assert!(format!("{error:#}").contains("schema 99"), "{error:#}");
        assert!(journal_path(&fixture.home).exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_transaction_journal_is_owner_private() {
        let fixture = fixture();
        let journal = binary_swap_crash(&fixture, 0, true);
        let path = journal_path(&fixture.home);
        write_journal(&path, &journal).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "the journal may contain server credentials");
    }

    #[test]
    fn help_version_and_capability_probes_do_not_require_recovery() {
        use std::ffi::OsString;
        let args = |values: &[&str]| values.iter().map(OsString::from).collect::<Vec<_>>();
        assert!(should_skip_recovery(&args(&["nession", "--help"])));
        assert!(should_skip_recovery(&args(&["nession", "-h"])));
        assert!(should_skip_recovery(&args(&["nession", "--version"])));
        assert!(should_skip_recovery(&args(&["nession", "-V"])));
        assert!(should_skip_recovery(&args(&[
            "nession",
            "--lifecycle-contract"
        ])));
        assert!(should_skip_recovery(&args(&[
            "nession",
            "--upgrade-contract"
        ])));
        assert!(should_skip_recovery(&args(&[
            "nession",
            "--upgrade-config-check",
            "agent",
            "/tmp/x.toml"
        ])));
        assert!(!should_skip_recovery(&args(&[
            "nession", "version", "list"
        ])));
        assert!(!should_skip_recovery(&args(&["nession", "agent", "start"])));
    }

    #[test]
    fn a_recovery_that_already_restored_is_cleaned_up() {
        let fixture = fixture();
        let mut old = BTreeMap::new();
        let mut new = BTreeMap::new();
        for name in versions::RELEASE_BINARIES {
            old.insert(
                name.to_string(),
                download::sha256_file(&fixture.install_dir.join(name)).unwrap(),
            );
            new.insert(
                name.to_string(),
                download::sha256_file(&fixture.staged.join(name)).unwrap(),
            );
        }
        let journal = Journal {
            schema: JOURNAL_SCHEMA,
            phase: Phase::BinarySwap,
            from: "0.35.0".into(),
            to: "1.2.0".into(),
            pid: 999_999,
            home: fixture.home.clone(),
            install_dir: fixture.install_dir.clone(),
            archive_dir: fixture.home.join("versions/gone"),
            staging_dir: fixture.home.join("versions/.stage-gone"),
            swapped: versions::RELEASE_BINARIES
                .iter()
                .map(|name| (*name).to_string())
                .collect(),
            old_digests: old,
            new_digests: new,
            config_preimages: BTreeMap::new(),
            server_config_original: None,
            agent_config_original: None,
        };
        write_journal(&journal_path(&fixture.home), &journal).unwrap();

        let recovery = recover_journal_locked(&fixture.home).unwrap();
        assert!(matches!(recovery, Recovery::RolledBack { .. }));
        assert!(!journal_path(&fixture.home).exists());
        for name in versions::RELEASE_BINARIES {
            assert_eq!(installed(&fixture, name), format!("old-{name}"));
        }
    }

    #[test]
    fn recovery_never_overwrites_an_externally_changed_config() {
        let fixture = fixture();
        let mut preimages = BTreeMap::new();
        preimages.insert(
            SERVER_CONFIG.to_string(),
            download::sha256_file(&fixture.home.join(SERVER_CONFIG)).unwrap(),
        );
        let mut old = BTreeMap::new();
        for name in versions::RELEASE_BINARIES {
            old.insert(
                name.to_string(),
                download::sha256_file(&fixture.install_dir.join(name)).unwrap(),
            );
        }
        let journal = Journal {
            schema: JOURNAL_SCHEMA,
            phase: Phase::Snapshot,
            from: "0.35.0".into(),
            to: "1.2.0".into(),
            pid: std::process::id(),
            home: fixture.home.clone(),
            install_dir: fixture.install_dir.clone(),
            archive_dir: fixture.home.join("versions/gone"),
            staging_dir: fixture.home.join("versions/.stage-gone"),
            swapped: Vec::new(),
            old_digests: old,
            new_digests: BTreeMap::new(),
            config_preimages: preimages,
            server_config_original: None,
            agent_config_original: None,
        };
        write_journal(&journal_path(&fixture.home), &journal).unwrap();
        // An external writer changed the retained config after preflight.
        fs::write(fixture.home.join(SERVER_CONFIG), "user rewrite\n").unwrap();

        let error = recover_journal_locked(&fixture.home).unwrap_err();
        assert!(format!("{error:#}").contains("external"), "{error:#}");
        assert!(journal_path(&fixture.home).exists());
        assert_eq!(
            fs::read_to_string(fixture.home.join(SERVER_CONFIG)).unwrap(),
            "user rewrite\n",
            "recovery must not overwrite the user's writes"
        );
    }

    #[test]
    fn a_target_that_cannot_validate_the_config_refuses_before_mutation() {
        let fixture = fixture();
        write_target_cli(&fixture.staged, "1.2.0", true);
        let error = replace(&fixture).unwrap_err();
        assert!(
            format!("{error:#}").contains("cannot validate the retained"),
            "{error:#}"
        );
        assert_old_current(&fixture);
        assert!(!fixture.archive.exists());
    }

    #[test]
    fn a_target_without_the_upgrade_contract_is_refused() {
        let fixture = fixture();
        // Overwrite the staged CLI with one that does not advertise the token.
        write_binary(&fixture.staged.join("nession"), "#!/bin/sh\nexit 2\n");
        let error = replace(&fixture).unwrap_err();
        assert!(
            format!("{error:#}").contains("does not advertise the upgrade contract"),
            "{error:#}"
        );
        assert_old_current(&fixture);
    }

    #[test]
    fn archive_only_publishes_only_a_complete_release() {
        let fixture = fixture();
        let target = fixture.home.join("versions/0.30.0");
        archive_only(&target, &fixture.staged).unwrap();
        assert!(versions::is_complete_archive(&target));
        assert!(!versions::is_complete_archive(
            &fixture.home.join("versions")
        ));
        assert_eq!(installed(&fixture, "nession"), "old-nession");
    }

    #[test]
    fn an_incomplete_staged_release_is_refused_before_archiving() {
        let fixture = fixture();
        fs::remove_file(fixture.staged.join("nession-agent")).unwrap();
        let error = replace(&fixture).unwrap_err();
        assert!(format!("{error:#}").contains("staged release is incomplete"));
        assert_old_current(&fixture);
        assert!(!fixture.archive.exists());
    }

    /// A schema-1 journal from the superseded move-based transaction is still
    /// recovered by its compatible owner: moved entries return to Current.
    #[test]
    fn a_legacy_schema1_journal_moves_state_back() {
        let fixture = fixture();
        // Shape: the old transaction moved agent-config.toml into the archive
        // and crashed during the binary swap with mixed binaries.
        let archive = fixture.home.join("versions/0.35.0");
        fs::create_dir_all(archive.join("bin")).unwrap();
        let mut old = BTreeMap::new();
        let mut new = BTreeMap::new();
        for (index, name) in versions::RELEASE_BINARIES.iter().enumerate() {
            write_binary(&archive.join("bin").join(name), &format!("old-{name}"));
            old.insert(
                name.to_string(),
                download::sha256_file(&archive.join("bin").join(name)).unwrap(),
            );
            let body = if index == 0 {
                format!("new-{name}")
            } else {
                format!("old-{name}")
            };
            write_binary(&fixture.install_dir.join(name), &body);
            new.insert(
                name.to_string(),
                download::sha256_file(&fixture.staged.join(name)).unwrap(),
            );
        }
        // The config was moved into the archive by the old transaction.
        fs::rename(
            fixture.home.join("agent-config.toml"),
            archive.join("agent-config.toml"),
        )
        .unwrap();
        let original_config = "listen_address = \"127.0.0.1:19090\"\n";
        let v1 = serde_json::json!({
            "schema": 1,
            "phase": "binary-swap",
            "from": "0.35.0",
            "to": "1.2.0",
            "pid": std::process::id(),
            "home": fixture.home,
            "install_dir": fixture.install_dir,
            "archive_dir": archive,
            "staging_dir": fixture.home.join("versions/.stage-gone"),
            "moved": [{"from": fixture.home.join("agent-config.toml"), "to": archive.join("agent-config.toml")}],
            "swapped": ["nession"],
            "old_digests": old,
            "new_digests": new,
            "server_config_original": original_config,
        });
        fs::write(
            journal_path(&fixture.home),
            serde_json::to_vec_pretty(&v1).unwrap(),
        )
        .unwrap();

        let recovery = recover_journal_locked(&fixture.home).unwrap();
        assert!(matches!(recovery, Recovery::RolledBack { .. }));
        assert!(fixture.home.join("agent-config.toml").is_file());
        assert!(!archive.exists());
        for name in versions::RELEASE_BINARIES {
            assert_eq!(installed(&fixture, name), format!("old-{name}"));
        }
        assert!(!journal_path(&fixture.home).exists());
    }
}
