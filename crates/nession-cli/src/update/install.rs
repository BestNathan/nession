//! Versioned release installation: archive Current, install an older release,
//! or make a newer release Current.
//!
//! Every entry point (`nession install`, `nession update`, and the delegation
//! from `scripts/install.sh`) converges here. The rule is the one in #3173:
//!
//! - target == Current: idempotent, no side effects;
//! - target < Current: install only into `versions/<target>/`; Current and
//!   every other archive stay untouched;
//! - target > Current: archive Current's binaries, configuration and durable
//!   state into `versions/<current>/`, then make the target Current.
//!
//! A Current replacement is refused while an Agent or Server is live. Moving
//! the configuration/database directories a running process is using is not a
//! safe operation, and the requirement is explicit that install must never
//! stop or restart a service.
//!
//! The filesystem half is a recoverable transaction owned by
//! [`crate::update::transaction`]: a complete archive is assembled in staging
//! and published by one rename, the old release's generated server paths move
//! with its home, and an interrupted transaction is rolled back (or proven
//! complete) by the next CLI invocation instead of leaving a half-installed
//! release (#3232 F1/F4).
//!
//! The filesystem half is separated from the network half so the archive
//! transaction, idempotence and rollback are testable against a temporary tree.

use crate::lifecycle::lock::LifecycleLock;
use crate::lifecycle::pid_file::{self, Component};
use crate::update::github::{self, GitHubReleaseClient};
use crate::update::policy::{self, PolicyOverrides, TransferPolicy};
use crate::update::progress::{CancelToken, Event, FailureReport, Phase, Reporter};
use crate::update::{download, transaction};
use crate::versions;
use anyhow::{bail, Result};
use semver::Version;
use std::fs;
use std::path::{Path, PathBuf};

/// One install/update request.
#[derive(Debug, Clone)]
pub struct InstallRequest {
    /// `None` means the latest release; `Some` is an explicit SemVer target.
    pub version: Option<String>,
    pub dry_run: bool,
    /// Skip the confirmation prompt.
    pub assume_yes: bool,
    /// Ask before mutating (the `update` flow); explicit `install` does not.
    pub prompt: bool,
    /// `nession update --include-installer`.
    pub include_installer: bool,
    /// Explicit CLI timeout/retry overrides (#4592 §8.1).
    pub policy_overrides: PolicyOverrides,
}

/// What the plan will do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallPlan {
    /// Target is already Current.
    NoOp,
    /// Install into an archived release home only.
    ArchiveOnly { target_dir: PathBuf },
    /// Move Current into an archive and make the target Current.
    ReplaceCurrent { archive_dir: PathBuf },
}

/// What actually happened.
#[derive(Debug)]
pub enum InstallOutcome {
    NoOp {
        version: Version,
    },
    ArchivedOnly {
        version: Version,
        path: PathBuf,
    },
    Replaced {
        from: Version,
        to: Version,
        archive: PathBuf,
    },
}

/// Decide the operation without touching the filesystem.
pub fn plan(layout: &versions::Layout, target: &Version) -> Result<InstallPlan> {
    let versions_root = layout.home.join("versions");
    if target == &layout.current {
        return Ok(InstallPlan::NoOp);
    }
    if target < &layout.current {
        let target_dir = versions_root.join(target.to_string());
        if target_dir.exists() {
            if versions::is_complete_archive(&target_dir) {
                return Ok(InstallPlan::NoOp);
            }
            bail!(
                "archive {} exists but is incomplete; remove it before reinstalling {}",
                target_dir.display(),
                target
            );
        }
        return Ok(InstallPlan::ArchiveOnly { target_dir });
    }
    for name in versions::RELEASE_BINARIES {
        if !layout.install_dir.join(name).is_file() {
            bail!(
                "the Current installation is incomplete: {} is missing; refusing to replace it",
                layout.install_dir.join(name).display()
            );
        }
    }
    let archive_dir = versions_root.join(layout.current.to_string());
    if archive_dir.exists() {
        bail!(
            "archive {} already exists; refusing to overwrite archived release {}",
            archive_dir.display(),
            layout.current
        );
    }
    Ok(InstallPlan::ReplaceCurrent { archive_dir })
}

/// Run a full install/update, including the download and checksum.
pub async fn run(request: InstallRequest) -> Result<()> {
    let resolved =
        policy::resolve(&request.policy_overrides).map_err(|error| anyhow::anyhow!("{error}"))?;
    let cancel = CancelToken::new();
    install_signal_handlers(cancel.clone());
    let reporter = Reporter::new();
    let result = run_inner(request, &resolved, &cancel, &reporter).await;
    if let Err(error) = &result {
        // The failure contract: phase, category, retryability, Current state
        // and the safe next action. The transaction owner reports its proven
        // Current state inside the error chain; pre-lock failures never
        // mutated Current.
        let phase = phase_from_error_chain(error);
        let report = classify_failure(phase, error);
        eprintln!("{}", report.render());
    }
    result
}

/// Register SIGINT/SIGTERM on the one cooperative cancellation path.
///
/// Cancellation stops the work at the next safe boundary; it never interrupts
/// a rename/fsync/SQLite write in flight. SIGKILL/power loss is recovered from
/// the journal on the next invocation, not here (#4592 §8.3).
fn install_signal_handlers(cancel: CancelToken) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        for kind in [SignalKind::interrupt(), SignalKind::terminate()] {
            if let Ok(mut stream) = signal(kind) {
                let cancel = cancel.clone();
                tokio::spawn(async move {
                    if stream.recv().await.is_some() {
                        cancel.cancel();
                    }
                });
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = cancel;
    }
}

fn phase_from_error_chain(error: &anyhow::Error) -> Phase {
    let text = format!("{error:#}");
    if text.contains("lifecycle lock") {
        Phase::WaitLock
    } else if text.contains("download") || text.contains("Download") {
        Phase::DownloadAsset
    } else if text.contains("checksum") || text.contains("Checksum") {
        Phase::Verify
    } else if text.contains("extract") {
        Phase::Extract
    } else if text.contains("journal")
        || text.contains("archive")
        || text.contains("install failed")
    {
        Phase::Publish
    } else {
        Phase::ResolveRelease
    }
}

fn classify_failure(phase: Phase, error: &anyhow::Error) -> FailureReport {
    // Unwrap a typed UpdateError when the chain carries one.
    for cause in error.chain() {
        if let Some(update_error) = cause.downcast_ref::<crate::update::UpdateError>() {
            return FailureReport::from_update_error(phase, update_error);
        }
    }
    let text = format!("{error:#}");
    let current_state = if text.contains("recovery failed") || text.contains("journal was retained")
    {
        crate::update::progress::CurrentState::RecoveryBlocked
    } else if text.contains("were restored from the transaction journal") {
        crate::update::progress::CurrentState::RolledBack
    } else if text.contains("committed forward during recovery") {
        crate::update::progress::CurrentState::Committed
    } else {
        crate::update::progress::CurrentState::Unchanged
    };
    FailureReport {
        phase,
        category: "install-error",
        retryable: true,
        current_state,
        cause: text,
        next_action: "inspect the cause; a retained journal is recovered on the next command"
            .to_string(),
    }
}

async fn run_inner(
    request: InstallRequest,
    resolved: &TransferPolicy,
    cancel: &CancelToken,
    reporter: &Reporter,
) -> Result<()> {
    // A previous process may have been killed mid-transaction. Resolve that
    // before reading Current: a mixed binary set is not a release, and the
    // journal is the only safe source of what to restore (#3232 F4).
    report_recovery(transaction::recover_at_cli_start()?);
    let layout = versions::Layout::resolve()?;
    // An explicit version can be resolved from the local layout. Reinstalling
    // Current or an already-archived release is an idempotent no-op and must
    // not depend on the network.
    if let Some(raw) = request.version.as_deref() {
        let hinted = versions::normalize_version(raw)?;
        match plan(&layout, &hinted)? {
            InstallPlan::NoOp if hinted == layout.current => {
                println!("Already at release {hinted}; nothing to do.");
                return Ok(());
            }
            InstallPlan::NoOp => {
                println!(
                    "Release {hinted} is already archived at {}; nothing changed.",
                    layout
                        .home
                        .join("versions")
                        .join(hinted.to_string())
                        .display()
                );
                return Ok(());
            }
            _ => {}
        }
    }

    let client = GitHubReleaseClient::from_env_with_policy(resolved)?;
    download::prune_stale_partials(&layout.home, std::time::Duration::from_secs(7 * 24 * 3600));
    let release = match request.version.as_deref() {
        Some(raw) => {
            let target = versions::normalize_version(raw)?;
            client.fetch_version(&target.to_string()).await?
        }
        None => client.fetch_latest().await?,
    };
    let target = github::parse_release_version(&release).ok_or_else(|| {
        anyhow::anyhow!(
            "release tag '{}' is not a valid SemVer version",
            release.tag_name
        )
    })?;
    let plan = plan(&layout, &target)?;

    println!("Current release: {}", layout.current);
    println!("Target release:  {target}");
    match &plan {
        InstallPlan::NoOp => {
            println!("Already at release {target}; nothing to do.");
            return Ok(());
        }
        InstallPlan::ArchiveOnly { target_dir } => {
            println!("Plan: install {target} into {}", target_dir.display());
        }
        InstallPlan::ReplaceCurrent { archive_dir } => {
            println!(
                "Plan: archive Current ({}) into {} and install {target} as Current",
                layout.current,
                archive_dir.display()
            );
        }
    }

    if request.prompt && !request.assume_yes {
        use std::io::Write;
        print!("Continue? [y/N] ");
        std::io::stdout().flush()?;
        let mut input = String::new();
        std::io::stdin().read_line(&mut input)?;
        if !matches!(input.trim().to_lowercase().as_str(), "y" | "yes") {
            println!("Aborted.");
            return Ok(());
        }
    }

    let asset = client.find_platform_asset(&release)?;
    if request.dry_run {
        println!("[dry-run] Would download: {}", asset.browser_download_url);
        println!("[dry-run] Would verify SHA256 and apply the plan above.");
        return Ok(());
    }

    let tmp_dir = download::temp_extract_dir()?;
    let result = download_and_apply(
        &client,
        &release,
        &asset.name,
        &asset.browser_download_url,
        &tmp_dir,
        &layout,
        &target,
        &plan,
        cancel,
        reporter,
    )
    .await;
    let _ = fs::remove_dir_all(&tmp_dir);
    let outcome = result?;
    report(&outcome);

    if request.include_installer {
        println!("Downloading install.sh...");
        match download::download_installer(client.asset_client(), &release, &layout.install_dir)
            .await
        {
            Ok(path) => println!("  ✓ install.sh -> {}", path.display()),
            Err(error) => eprintln!("   install.sh ({error})"),
        }
    }

    Ok(())
}

fn report_recovery(recovery: transaction::Recovery) {
    if let Some(message) = recovery.describe() {
        println!("{message}");
    }
}

#[allow(clippy::too_many_arguments)]
async fn download_and_apply(
    client: &GitHubReleaseClient,
    release: &github::ReleaseInfo,
    asset_name: &str,
    asset_url: &str,
    tmp_dir: &std::path::Path,
    layout: &versions::Layout,
    target: &Version,
    plan: &InstallPlan,
    cancel: &CancelToken,
    reporter: &Reporter,
) -> Result<InstallOutcome> {
    let policy = client.policy();
    let tarball = tmp_dir.join(asset_name);

    // Verified release identity and expected SHA256 come first; the asset is
    // then streamed into a private partial, never a whole-response buffer.
    // Download/checksum/extract all happen BEFORE the lifecycle lock: no
    // network transfer or retry runs under the lock (#4592 §8.2).
    reporter.emit(Event::PhaseStarted {
        phase: Phase::DownloadChecksums,
    });
    let checksums = client.download_checksums(release).await?;
    let expected = download::expected_checksum(&checksums, asset_name)
        .map_err(|error| anyhow::anyhow!("{error}"))?;

    cancel.check(Phase::DownloadAsset)?;
    reporter.emit(Event::PhaseStarted {
        phase: Phase::DownloadAsset,
    });
    let part = download::partial_cache_dir(&layout.home).join(asset_name);
    let started = std::time::Instant::now();
    let bytes = download::download_asset(
        client.asset_client(),
        asset_url,
        &tarball,
        &part,
        policy,
        cancel,
        reporter,
    )
    .await
    .map_err(|error| anyhow::anyhow!("{error}"))?;
    reporter.emit(Event::PhaseDone {
        phase: Phase::DownloadAsset,
        elapsed: started.elapsed(),
    });

    reporter.emit(Event::PhaseStarted {
        phase: Phase::Verify,
    });
    let actual = download::sha256_file(&tarball).map_err(|error| anyhow::anyhow!("{error}"))?;
    if actual != expected {
        // A checksum mismatch never becomes a trusted cache hit: discard the
        // corrupt artifact and require a fresh verified download.
        let _ = fs::remove_file(&tarball);
        let _ = fs::remove_file(&part);
        bail!(
            "checksum mismatch for {asset_name}: expected {expected}, got {actual}; \
             the corrupt download was discarded"
        );
    }
    let _ = bytes;
    reporter.emit(Event::Note("Checksum verified.".to_string()));
    reporter.emit(Event::PhaseStarted {
        phase: Phase::Extract,
    });
    download::extract_binaries(&tarball, tmp_dir).map_err(|error| anyhow::anyhow!("{error}"))?;
    for name in versions::RELEASE_BINARIES {
        if !tmp_dir.join(name).is_file() {
            bail!("release archive is missing the {name} binary; refusing a partial release");
        }
    }
    cancel.check(Phase::WaitLock)?;

    // One lifecycle command at a time across every installed release. The
    // bounded wait covers the live-process re-check and the whole archive
    // transaction; any journal left by an earlier crash is recovered before
    // this plan runs. A busy lock is a retryable diagnostic, never a break.
    reporter.emit(Event::PhaseStarted {
        phase: Phase::WaitLock,
    });
    let lock_started = std::time::Instant::now();
    let _lock = LifecycleLock::acquire_bounded(policy.lock_wait, |elapsed| {
        reporter.emit(Event::LockWait { elapsed });
    })
    .map_err(|error| anyhow::anyhow!("{error}"))?;
    reporter.emit(Event::PhaseDone {
        phase: Phase::WaitLock,
        elapsed: lock_started.elapsed(),
    });
    report_recovery(transaction::recover_journal_locked(&layout.home)?);

    match plan {
        InstallPlan::NoOp => Ok(InstallOutcome::NoOp {
            version: target.clone(),
        }),
        InstallPlan::ArchiveOnly { target_dir } => transaction::archive_only(target_dir, tmp_dir)
            .map(|path| InstallOutcome::ArchivedOnly {
                version: target.clone(),
                path,
            }),
        InstallPlan::ReplaceCurrent { archive_dir } => {
            refuse_while_running()?;
            let current_now = versions::current_version(&layout.install_dir)?;
            if current_now != layout.current {
                bail!(
                    "Current changed from {} to {} while downloading; re-run install",
                    layout.current,
                    current_now
                );
            }
            transaction::replace_current(
                &layout.home,
                &layout.install_dir,
                &layout.current,
                target,
                archive_dir,
                tmp_dir,
            )
            .map(|archive| InstallOutcome::Replaced {
                from: layout.current.clone(),
                to: target.clone(),
                archive,
            })
        }
    }
}

fn refuse_while_running() -> Result<()> {
    for component in [Component::Agent, Component::Server] {
        if let Some((path, identity)) = pid_file::default_live(component)? {
            let stop_hint = if component == Component::Agent {
                let managed = crate::service::managed_agent();
                let targets = match managed.pid_file.as_deref() {
                    Some(pinned) => Path::new(pinned) == Path::new(&path),
                    None => pid_file::matches_default_agent_state_path(&path),
                };
                if managed.state != crate::service::ManagedAgentState::NotInstalled && targets {
                    format!(
                        "`{}` (the Agent is managed by {})",
                        crate::service::manager_lifecycle_command(
                            crate::service::AgentLifecycleAction::Stop
                        ),
                        crate::service::manager_name()
                    )
                } else {
                    "`nession agent stop`".to_string()
                }
            } else {
                "`nession server stop`".to_string()
            };
            bail!(
                "{} is running (PID {}, release {}, state file {path}); installing a new Current \
                 requires a consistent snapshot of its configuration and durable state, and a \
                 live writer would make the archive's independent copies unverifiable.\n\
                 Fix: stop the {} first with {}, then re-run the install. Nession never stops \
                 or restarts a service implicitly.",
                match component {
                    Component::Agent => "Agent",
                    Component::Server => "Server",
                },
                identity.pid,
                identity.release_version.as_deref().unwrap_or("unknown"),
                component.as_str(),
                stop_hint
            );
        }
    }
    Ok(())
}

fn report(outcome: &InstallOutcome) {
    match outcome {
        InstallOutcome::NoOp { version } => {
            println!("Release {version} is already installed; nothing changed.");
        }
        InstallOutcome::ArchivedOnly { version, path } => {
            println!("Installed release {version} into {}.", path.display());
            println!("Current was not changed.");
        }
        InstallOutcome::Replaced { from, to, archive } => {
            println!("Release {from} archived at {}.", archive.display());
            println!("Current is now release {to}.");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    fn write_binary(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn current_tree(root: &TempDir, version: &str) -> versions::Layout {
        let install_dir = root.path().join("install");
        for name in versions::RELEASE_BINARIES {
            write_binary(&install_dir.join(name), version);
        }
        versions::Layout {
            home: root.path().join("home"),
            install_dir,
            current: Version::parse(version).unwrap(),
        }
    }

    fn staged(root: &TempDir, version: &str) -> PathBuf {
        let dir = root.path().join("staged");
        for name in versions::RELEASE_BINARIES {
            write_binary(&dir.join(name), version);
        }
        dir
    }

    #[test]
    fn same_version_is_a_no_op() {
        let root = TempDir::new().unwrap();
        let layout = current_tree(&root, "1.1.0");
        assert_eq!(
            plan(&layout, &Version::new(1, 1, 0)).unwrap(),
            InstallPlan::NoOp
        );
    }

    #[test]
    fn an_older_version_archives_only() {
        let root = TempDir::new().unwrap();
        let layout = current_tree(&root, "1.1.0");
        let plan = plan(&layout, &Version::new(0, 35, 0)).unwrap();
        assert!(matches!(plan, InstallPlan::ArchiveOnly { .. }));

        let outcome = transaction::archive_only(
            &root.path().join("home/versions/0.35.0"),
            &staged(&root, "0.35.0"),
        )
        .unwrap();

        assert!(outcome.join("bin/nession").is_file());
        assert_eq!(
            fs::read_to_string(layout.install_dir.join("nession")).unwrap(),
            "1.1.0",
            "Current must not change"
        );
    }

    /// A staged target CLI that advertises the upgrade contract and validates
    /// configs (the real handshake is proven by the runtime Cases).
    fn write_target_cli(staged: &Path, version: &str) {
        let script = format!(
            "#!/bin/sh\n\
             case \"$1\" in\n\
             --upgrade-contract) echo \"{} {version}\"; exit 0 ;;\n\
             --upgrade-config-check) echo ok; exit 0 ;;\n\
             --version) echo \"nession {version}\"; exit 0 ;;\n\
             esac\n\
             exit 2\n",
            crate::update::UPGRADE_CONTRACT_TOKEN,
        );
        write_binary(&staged.join("nession"), &script);
    }

    #[test]
    fn a_newer_version_retains_current_and_archives_independent_copies() {
        let root = TempDir::new().unwrap();
        let layout = current_tree(&root, "1.1.0");
        fs::create_dir_all(&layout.home).unwrap();
        fs::write(layout.home.join("agent-config.toml"), "old-config").unwrap();
        fs::write(
            layout.home.join("server-config.toml"),
            "listen_address = \"127.0.0.1:19090\"\n",
        )
        .unwrap();
        fs::create_dir_all(layout.home.join("agent")).unwrap();
        fs::write(layout.home.join("agent/identity"), "old-id").unwrap();
        fs::create_dir_all(layout.home.join("server")).unwrap();
        {
            let conn = rusqlite::Connection::open(layout.home.join("server/server.db")).unwrap();
            conn.execute_batch(
                "CREATE TABLE marker(v TEXT); INSERT INTO marker VALUES ('old-db');",
            )
            .unwrap();
        }
        let staged = staged(&root, "1.2.0");
        write_target_cli(&staged, "1.2.0");

        let archive = transaction::replace_current(
            &layout.home,
            &layout.install_dir,
            &layout.current,
            &Version::new(1, 2, 0),
            &layout.home.join("versions/1.1.0"),
            &staged,
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(layout.install_dir.join("nession")).unwrap(),
            fs::read_to_string(staged.join("nession")).unwrap(),
            "Current must be the target release's CLI"
        );
        assert_eq!(
            fs::read_to_string(archive.join("bin/nession")).unwrap(),
            "1.1.0"
        );
        // SC-01 retention: both configs, the identity and the durable state
        // stay at their Current paths, byte-for-byte.
        assert_eq!(
            fs::read_to_string(layout.home.join("agent-config.toml")).unwrap(),
            "old-config"
        );
        assert_eq!(
            fs::read_to_string(layout.home.join("server-config.toml")).unwrap(),
            "listen_address = \"127.0.0.1:19090\"\n"
        );
        assert_eq!(
            fs::read_to_string(layout.home.join("agent/identity")).unwrap(),
            "old-id"
        );
        assert!(layout.home.join("server/server.db").is_file());
        // The archive holds independent copies, never a rename of Current.
        assert_eq!(
            fs::read_to_string(archive.join("agent-config.toml")).unwrap(),
            "old-config"
        );
        assert_eq!(
            fs::read_to_string(archive.join("agent/identity")).unwrap(),
            "old-id"
        );
        assert!(archive.join("server/server.db").is_file());
        assert!(archive.join("manifest.json").is_file());
    }

    #[test]
    fn an_existing_archive_is_never_overwritten() {
        let root = TempDir::new().unwrap();
        let layout = current_tree(&root, "1.1.0");
        let archive = layout.home.join("versions/1.1.0");
        fs::create_dir_all(&archive).unwrap();
        fs::write(archive.join("keep"), "user-data").unwrap();

        let error = plan(&layout, &Version::new(1, 2, 0)).unwrap_err();
        assert!(error.to_string().contains("already exists"));
        assert_eq!(
            fs::read_to_string(archive.join("keep")).unwrap(),
            "user-data"
        );
    }

    #[test]
    fn an_incomplete_archive_is_not_an_installed_release() {
        let root = TempDir::new().unwrap();
        let layout = current_tree(&root, "1.1.0");
        let archive = layout.home.join("versions/0.35.0/bin");
        fs::create_dir_all(&archive).unwrap();
        write_binary(&archive.join("nession"), "0.35.0");

        let error = plan(&layout, &Version::new(0, 35, 0)).unwrap_err();
        assert!(error.to_string().contains("incomplete"));
    }

    #[test]
    fn a_missing_binary_refuses_a_replace() {
        let root = TempDir::new().unwrap();
        let layout = current_tree(&root, "1.1.0");
        fs::remove_file(layout.install_dir.join("nession-agent")).unwrap();

        let error = transaction::replace_current(
            &layout.home,
            &layout.install_dir,
            &layout.current,
            &Version::new(1, 2, 0),
            &layout.home.join("versions/1.1.0"),
            &staged(&root, "1.2.0"),
        )
        .unwrap_err();

        assert!(error.to_string().contains("nession-agent"));
        assert!(!layout.home.join("versions/1.1.0").exists());
        assert_eq!(
            fs::read_to_string(layout.install_dir.join("nession")).unwrap(),
            "1.1.0"
        );
    }

    #[test]
    fn an_incomplete_staged_release_is_refused_before_archiving() {
        let root = TempDir::new().unwrap();
        let layout = current_tree(&root, "1.1.0");
        fs::create_dir_all(&layout.home).unwrap();
        fs::write(layout.home.join("agent-config.toml"), "old-config").unwrap();
        let archive = layout.home.join("versions/1.1.0");

        let incomplete = root.path().join("incomplete-staged");
        write_binary(&incomplete.join("nession"), "1.2.0");
        write_binary(&incomplete.join("nession-server"), "1.2.0");

        let result = transaction::replace_current(
            &layout.home,
            &layout.install_dir,
            &layout.current,
            &Version::new(1, 2, 0),
            &archive,
            &incomplete,
        );

        assert!(result.is_err(), "an incomplete release must fail");
        assert_eq!(
            fs::read_to_string(layout.home.join("agent-config.toml")).unwrap(),
            "old-config",
            "configuration must be untouched"
        );
        assert_eq!(
            fs::read_to_string(layout.install_dir.join("nession")).unwrap(),
            "1.1.0",
            "Current binaries must be untouched"
        );
        assert!(
            !archive.exists(),
            "a refused archive must not appear as an installed release"
        );
    }
}
