//! The interruptible Current-replacement transaction.
//!
//! Archiving Current is a multi-step operation: copy the old binaries, move
//! configuration and durable state, publish the archive, then swap three
//! binaries in the install directory. A half-finished sequence is not a release
//! (#3232 F4): it must never be recognized as an archive, and the next CLI
//! invocation must be able to tell whether to finish or roll back.
//!
//! Every mutating phase is recorded in `<NESSION_HOME>/.install-transaction.json`
//! before it starts. The journal names the release homes, the exact old/new
//! binary digests, every state entry the transaction may move, and the original
//! server-config text. Recovery compares the filesystem against that journal:
//!
//! - `staging`: nothing outside the staging directory changed; remove it.
//! - `state-move` / `archive-committed`: restore the old binaries and move the
//!   state back. The archive is removed because the transaction never committed.
//! - `binary-swap`: if all three installed binaries match the new digests the
//!   swap had actually finished; commit forward and keep the archive. A mixed
//!   set is rolled back from the archive.
//!
//! Any ambiguity — a missing archive copy, an entry at both locations, an
//! unreadable journal — fails closed and leaves the journal in place so the
//! next invocation reports the exact repair instead of starting a half-install.
//!
//! The archive is assembled in a `versions/.stage-*` directory and published by
//! one atomic rename, so a final `versions/<version>` directory is always
//! complete. Older archives are recognized by all three binaries being present
//! (`versions::is_complete_archive`).

use crate::lifecycle::lock::LifecycleLock;
use crate::update::{download, release_config, replace};
use crate::versions;
use anyhow::{bail, Context, Result};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The durable transaction journal, relative to the Nession home.
pub const JOURNAL_FILE: &str = ".install-transaction.json";
const JOURNAL_SCHEMA: u32 = 1;
const STAGING_PREFIX: &str = ".stage-";
const SERVER_CONFIG: &str = "server-config.toml";
const CONFIG_FILES: [&str; 2] = ["agent-config.toml", SERVER_CONFIG];
const DURABLE_DIRS: [&str; 2] = ["agent", "server"];

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

/// The phases a Current replacement passes through, in order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Phase {
    Staging,
    StateMove,
    ArchiveCommitted,
    BinarySwap,
    Committed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MovePair {
    from: PathBuf,
    to: PathBuf,
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
    moved: Vec<MovePair>,
    swapped: Vec<String>,
    old_digests: BTreeMap<String, String>,
    new_digests: BTreeMap<String, String>,
    server_config_original: Option<String>,
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
/// Help, version and the lifecycle-contract handshake must work without a
/// resolvable Nession home and must not mutate the installation.
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
            Some("--help" | "-h" | "help" | "--version" | "-V" | "--lifecycle-contract")
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
    let journal: Journal = serde_json::from_slice(&bytes).with_context(|| {
        format!(
            "the install journal at {} is unreadable; refusing to guess whether Current is \
             complete. Fix: inspect the journal and the versions directory, then remove the \
             journal only after restoring a complete release.",
            path.display()
        )
    })?;
    if journal.schema != JOURNAL_SCHEMA {
        bail!(
            "the install journal at {} has schema {}; this CLI understands schema {}. \
             Refusing to mutate the installation.",
            path.display(),
            journal.schema,
            JOURNAL_SCHEMA
        );
    }
    if journal.home != home {
        bail!(
            "the install journal at {} belongs to {}, not {}; refusing to use it",
            path.display(),
            journal.home.display(),
            home.display()
        );
    }
    let recovery = recover(&journal)?;
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
        Phase::StateMove | Phase::ArchiveCommitted | Phase::BinarySwap => {
            if journal.phase == Phase::BinarySwap && all_installed_match_new(journal)? {
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
    // A previous recovery may have restored everything and then been killed
    // before (or while) removing the archive/staging/journal. In that state the
    // archive is already gone and a naive retry would report "cannot restore"
    // forever even though Current is correct. Prove the restored state first.
    if rollback_already_complete(journal)? {
        restore_original_config(journal)?;
        remove_dir_if_exists(&journal.archive_dir)?;
        remove_dir_if_exists(&journal.staging_dir)?;
        return Ok(());
    }

    // 1. The archive is the rollback source for every binary once it has been
    //    published. Before that rename the staging directory holds the same
    //    copies; a crash during the state move must be able to use it.
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

    // 2. Move configuration and durable state back. The entry may still be in
    //    the staging directory (before the archive rename) or in the archive.
    for pair in &journal.moved {
        restore_entry(journal, pair)?;
    }

    // 3. Restore the exact original server-config text.
    restore_original_config(journal)?;

    // 4. The archive never committed; remove the transaction's tree so it
    //    cannot masquerade as a runnable release.
    remove_dir_if_exists(&journal.archive_dir)?;
    remove_dir_if_exists(&journal.staging_dir)?;
    Ok(())
}

/// Restore the captured original server-config text.
///
/// Unconditional whenever the journal captured one: a crash between writing
/// the archive-scoped config and recording that fact must not leave the Current
/// config pointing into the archive. Writing over an unmoved/identical file is
/// harmless, and a reverse rewrite could lose comments or external-path
/// distinctions.
fn restore_original_config(journal: &Journal) -> Result<()> {
    if let Some(original) = journal.server_config_original.as_deref() {
        let config = journal.home.join(SERVER_CONFIG);
        fs::write(&config, original)
            .with_context(|| format!("failed to restore the original {}", config.display()))?;
    }
    Ok(())
}

/// Whether a previous rollback already restored binaries, state and config.
///
/// This is what makes recovery idempotent after its cleanup phase starts. A
/// missing source plus a restored tree is success, not the "cannot restore"
/// failure that a partially removed archive would otherwise produce.
fn rollback_already_complete(journal: &Journal) -> Result<bool> {
    for name in versions::RELEASE_BINARIES {
        let Some(expected) = journal.old_digests.get(name) else {
            // A journal without the pre-install digest cannot prove the state;
            // fall through to the normal rollback/error path.
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
        let name = pair
            .to
            .file_name()
            .with_context(|| format!("the journal entry {} has no file name", pair.to.display()))?;
        let staged = journal.staging_dir.join(name);
        if !pair.from.exists() || pair.to.exists() || staged.exists() {
            return Ok(false);
        }
    }
    Ok(true)
}

fn restore_entry(journal: &Journal, pair: &MovePair) -> Result<()> {
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

fn remove_atomic_temp(install_dir: &Path, name: &str, pid: u32) {
    // `replace::atomic_replace` names its staging file `.<name>.tmp.<pid>`. A
    // process killed mid-copy leaves one behind; it is not part of the release.
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
    StateMove,
    BinarySwap,
}

impl FaultPoint {
    fn as_str(self) -> &'static str {
        match self {
            FaultPoint::Staging => "staging",
            FaultPoint::StateMove => "state-move",
            FaultPoint::BinarySwap => "binary-swap",
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
        Some("state-move") => Some(FaultPoint::StateMove),
        Some("binary-swap") => Some(FaultPoint::BinarySwap),
        _ => None,
    }
}

fn fault_plan_from_env() -> FaultPlan {
    if cfg!(debug_assertions) {
        // Debug-only fault injection for the #3232 SC-04 failure matrix. A
        // release build never reads these names.
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

/// Archive Current and install `to` as Current.
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

    // Validate and prepare the release-scoped config rewrite before any
    // mutation. A custom path inside the Current home is a refusal, not a
    // silent cross-version read (#3232 F1).
    let config_path = home.join(SERVER_CONFIG);
    let server_config_original = if config_path.exists() {
        Some(fs::read_to_string(&config_path).with_context(|| {
            format!(
                "failed to read the server config at {}",
                config_path.display()
            )
        })?)
    } else {
        None
    };
    let rewritten = server_config_original
        .as_deref()
        .map(|content| {
            release_config::rewrite_server_config_for_archive(content, home, archive_dir)
                .context("refusing to archive Current until its server config is relocatable")
        })
        .transpose()?;

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
    let moved = CONFIG_FILES
        .iter()
        .chain(DURABLE_DIRS.iter())
        .filter_map(|name| {
            let from = home.join(name);
            from.exists().then(|| MovePair {
                from,
                to: archive_dir.join(name),
            })
        })
        .collect();

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
        moved,
        swapped: Vec::new(),
        old_digests,
        new_digests,
        server_config_original,
    };
    write_journal(&journal_file, &journal)?;

    match apply(
        &journal_file,
        &mut journal,
        staged,
        rewritten
            .as_ref()
            .map(|(text, report)| (text.as_str(), report)),
        fault,
    ) {
        Ok(()) => {
            journal.phase = Phase::Committed;
            if let Err(error) = write_journal(&journal_file, &journal) {
                // The BinarySwap phase plus the new digests lets the next
                // invocation prove the swap finished and commit forward.
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
        Err(error) => {
            // Roll back now. Recovery failures are part of the returned error,
            // never a swallowed warning.
            match recover_journal_locked(home) {
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
            }
        }
    }
}

type Rewrite<'a> = (&'a str, &'a release_config::RewriteReport);

fn apply(
    journal_file: &Path,
    journal: &mut Journal,
    staged: &Path,
    rewritten: Option<Rewrite<'_>>,
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

    // Phase 2: move configuration and durable state beside the binaries.
    journal.phase = Phase::StateMove;
    write_journal(journal_file, journal)?;
    for pair in journal.moved.clone() {
        let name = pair
            .to
            .file_name()
            .with_context(|| format!("the journal entry {} has no file name", pair.to.display()))?;
        fs::rename(&pair.from, journal.staging_dir.join(name)).with_context(|| {
            format!(
                "failed to archive {}; Current is restored from the journal",
                pair.from.display()
            )
        })?;
    }
    if let Some((text, report)) = rewritten {
        fs::write(journal.staging_dir.join(SERVER_CONFIG), text).with_context(|| {
            format!("failed to write the release-scoped {SERVER_CONFIG} into the archive")
        })?;
        write_journal(journal_file, journal)?;
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
    }
    sync_directory(&journal.home);
    sync_directory(&journal.staging_dir);
    inject(fault, FaultPoint::StateMove)?;

    // Phase 3: one atomic rename publishes the complete archive. A crash
    // before this leaves only a staging directory; a crash after it has a
    // complete archive and a journal that still says state-move, which
    // recovery resolves from whichever location holds the entries.
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

    // Phase 4: swap the binaries. The journal records each completed swap;
    // recovery also compares digests, so a kill between the rename and this
    // write is still decidable.
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
    let mut file = fs::File::create(&temp)
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
    // Best effort: not every filesystem supports directory fsync. The journal
    // itself is always synced; this narrows the rename-visibility window.
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
        fs::create_dir_all(home.join("server")).unwrap();
        fs::write(home.join("server/server.db"), "old-db").unwrap();
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
            fs::read_to_string(fixture.home.join("server/server.db")).unwrap(),
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
    fn a_completed_replace_archives_current_and_rewrites_its_paths() {
        let fixture = fixture();
        replace(&fixture).unwrap();

        for name in versions::RELEASE_BINARIES {
            assert_eq!(installed(&fixture, name), format!("new-{name}"));
            assert_eq!(archived(&fixture, name), format!("old-{name}"));
        }
        let archived_config = fs::read_to_string(fixture.archive.join(SERVER_CONFIG)).unwrap();
        assert!(archived_config.contains(
            &nession_common::paths::server_db_path_under(&fixture.archive)
                .display()
                .to_string()
        ));
        assert!(!archived_config.contains(
            &nession_common::paths::server_db_path_under(&fixture.home)
                .display()
                .to_string()
        ));
        assert!(fixture.archive.join("server/server.db").is_file());
        assert!(fixture.archive.join("agent/identity").is_file());
        assert!(!fixture.home.join("server").exists());
        assert!(!fixture.home.join("server-config.toml").exists());
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
    fn a_state_move_failure_restores_configuration_and_state() {
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
            "the original config text must be restored verbatim"
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
            moved: Vec::new(),
            swapped: Vec::new(),
            old_digests: BTreeMap::new(),
            new_digests: BTreeMap::new(),
            server_config_original: None,
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

    /// Build the on-disk shape of a binary-swap crash: an archived copy of the
    /// old release, a Current directory with `new_count` new binaries, and a
    /// journal describing exactly that.
    fn binary_swap_crash(fixture: &Fixture, new_count: usize, archive_present: bool) -> Journal {
        let archive = fixture.home.join("versions/0.35.0");
        let mut old = BTreeMap::new();
        let mut new = BTreeMap::new();
        if archive_present {
            fs::create_dir_all(archive.join("bin")).unwrap();
        }
        for (index, name) in versions::RELEASE_BINARIES.iter().enumerate() {
            if archive_present {
                write_binary(&archive.join("bin").join(name), &format!("old-{name}"));
                old.insert(
                    name.to_string(),
                    download::sha256_file(&archive.join("bin").join(name)).unwrap(),
                );
            }
            let body = if index < new_count {
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
            moved: Vec::new(),
            swapped: versions::RELEASE_BINARIES
                .iter()
                .take(new_count)
                .map(|name| (*name).to_string())
                .collect(),
            old_digests: old,
            new_digests: new,
            server_config_original: None,
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
            assert_eq!(installed(&fixture, name), format!("new-{name}"));
        }
        assert!(journal.archive_dir.join("bin/nession").is_file());
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

    /// A crash after restoration but during cleanup must not brick recovery:
    /// the archive and staging are already gone, yet Current is intact.
    #[test]
    fn help_and_version_do_not_require_recovery() {
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
        let original_config = fs::read_to_string(fixture.home.join(SERVER_CONFIG)).unwrap();
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
            moved: Vec::new(),
            swapped: versions::RELEASE_BINARIES
                .iter()
                .map(|name| (*name).to_string())
                .collect(),
            old_digests: old,
            new_digests: new,
            server_config_original: Some(original_config.clone()),
        };
        write_journal(&journal_path(&fixture.home), &journal).unwrap();

        let recovery = recover_journal_locked(&fixture.home).unwrap();
        assert!(matches!(recovery, Recovery::RolledBack { .. }));
        assert!(!journal_path(&fixture.home).exists());
        for name in versions::RELEASE_BINARIES {
            assert_eq!(installed(&fixture, name), format!("old-{name}"));
        }
        assert_eq!(
            fs::read_to_string(fixture.home.join(SERVER_CONFIG)).unwrap(),
            original_config,
            "the captured original config is re-applied"
        );
    }

    /// The same idempotent path repairs a config that was rewritten before the
    /// crash, then cleans up.
    #[test]
    fn an_already_restored_tree_repairs_the_config_before_cleanup() {
        let fixture = fixture();
        let mut old = BTreeMap::new();
        for name in versions::RELEASE_BINARIES {
            old.insert(
                name.to_string(),
                download::sha256_file(&fixture.install_dir.join(name)).unwrap(),
            );
        }
        let original_config = fs::read_to_string(fixture.home.join(SERVER_CONFIG)).unwrap();
        let config_path = fixture.home.join(SERVER_CONFIG);
        fs::write(&config_path, "db_path = \"/wrong/archive/path\"\n").unwrap();
        let journal = Journal {
            schema: JOURNAL_SCHEMA,
            phase: Phase::StateMove,
            from: "0.35.0".into(),
            to: "1.2.0".into(),
            pid: std::process::id(),
            home: fixture.home.clone(),
            install_dir: fixture.install_dir.clone(),
            archive_dir: fixture.home.join("versions/gone"),
            staging_dir: fixture.home.join("versions/.stage-gone"),
            moved: Vec::new(),
            swapped: Vec::new(),
            old_digests: old,
            new_digests: BTreeMap::new(),
            server_config_original: Some(original_config.clone()),
        };
        write_journal(&journal_path(&fixture.home), &journal).unwrap();

        let recovery = recover_journal_locked(&fixture.home).unwrap();
        assert!(matches!(recovery, Recovery::RolledBack { .. }));
        assert_eq!(fs::read_to_string(config_path).unwrap(), original_config);
        assert!(!journal_path(&fixture.home).exists());
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
}
