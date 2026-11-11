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
use crate::update::download;
use crate::update::github::{self, GitHubReleaseClient};
use crate::update::transaction;
use crate::versions;
use anyhow::{bail, Result};
use semver::Version;
use std::fs;
use std::path::PathBuf;

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

    let client = GitHubReleaseClient::from_env()?;
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
    )
    .await;
    let _ = fs::remove_dir_all(&tmp_dir);
    let outcome = result?;
    report(&outcome);

    if request.include_installer {
        println!("Downloading install.sh...");
        match download::download_installer(client.http_client(), &release, &layout.install_dir)
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
) -> Result<InstallOutcome> {
    let tarball = tmp_dir.join(asset_name);
    println!("Downloading {asset_name}...");
    download::download_to_file(client.http_client(), asset_url, &tarball).await?;
    let checksums = client.download_checksums(release).await?;
    download::verify_checksum(&tarball, &checksums, asset_name)?;
    println!("Checksum verified.");
    download::extract_binaries(&tarball, tmp_dir)?;
    for name in versions::RELEASE_BINARIES {
        if !tmp_dir.join(name).is_file() {
            bail!("release archive is missing the {name} binary; refusing a partial release");
        }
    }

    // One lifecycle command at a time across every installed release. The lock
    // covers the live-process re-check and the whole archive transaction, and
    // any journal left by an earlier crash is recovered before this plan runs.
    let _lock = LifecycleLock::acquire()?;
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
            bail!(
                "{} is running (PID {}, release {}, state file {path}); installing a new Current \
                 requires moving its configuration and durable state.\n\
                 Fix: stop the {} first (`nession {} stop`), then re-run the install. Nession \
                 never stops or restarts a service implicitly.",
                match component {
                    Component::Agent => "Agent",
                    Component::Server => "Server",
                },
                identity.pid,
                identity.release_version.as_deref().unwrap_or("unknown"),
                component.as_str(),
                component.as_str()
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

    #[test]
    fn a_newer_version_archives_current_and_replaces_it() {
        let root = TempDir::new().unwrap();
        let layout = current_tree(&root, "1.1.0");
        fs::create_dir_all(&layout.home).unwrap();
        fs::write(layout.home.join("agent-config.toml"), "old-config").unwrap();
        fs::create_dir_all(layout.home.join("server")).unwrap();
        fs::write(layout.home.join("server/server.db"), "old-db").unwrap();

        let archive = transaction::replace_current(
            &layout.home,
            &layout.install_dir,
            &layout.current,
            &Version::new(1, 2, 0),
            &layout.home.join("versions/1.1.0"),
            &staged(&root, "1.2.0"),
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(layout.install_dir.join("nession")).unwrap(),
            "1.2.0"
        );
        assert_eq!(
            fs::read_to_string(archive.join("bin/nession")).unwrap(),
            "1.1.0"
        );
        assert_eq!(
            fs::read_to_string(archive.join("agent-config.toml")).unwrap(),
            "old-config"
        );
        assert_eq!(
            fs::read_to_string(archive.join("server/server.db")).unwrap(),
            "old-db"
        );
        assert!(
            !layout.home.join("agent-config.toml").exists(),
            "the new Current must not silently inherit the old config"
        );
        assert!(
            !layout.home.join("server").exists(),
            "the new Current must not silently reuse the old durable state"
        );
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
