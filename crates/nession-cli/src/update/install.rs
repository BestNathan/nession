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
//! The filesystem half is separated from the network half so the archive
//! transaction, idempotence and rollback are testable against a temporary tree.

use crate::lifecycle::lock::LifecycleLock;
use crate::lifecycle::pid_file::{self, Component};
use crate::update::download;
use crate::update::github::{self, GitHubReleaseClient};
use crate::update::replace;
use crate::versions;
use anyhow::{bail, Context, Result};
use semver::Version;
use std::fs;
use std::path::{Path, PathBuf};

const BINARIES: [&str; 3] = ["nession", "nession-agent", "nession-server"];
const CONFIG_FILES: [&str; 2] = ["agent-config.toml", "server-config.toml"];
const DURABLE_DIRS: [&str; 2] = ["agent", "server"];

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
            if target_dir.join("bin").join("nession").is_file() {
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
    for name in BINARIES {
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

#[allow(clippy::too_many_arguments)]
async fn download_and_apply(
    client: &GitHubReleaseClient,
    release: &github::ReleaseInfo,
    asset_name: &str,
    asset_url: &str,
    tmp_dir: &Path,
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
    for name in BINARIES {
        if !tmp_dir.join(name).is_file() {
            bail!("release archive is missing the {name} binary; refusing a partial release");
        }
    }

    match plan {
        InstallPlan::NoOp => Ok(InstallOutcome::NoOp {
            version: target.clone(),
        }),
        InstallPlan::ArchiveOnly { target_dir } => {
            apply_archive_only(target_dir, tmp_dir).map(|path| InstallOutcome::ArchivedOnly {
                version: target.clone(),
                path,
            })
        }
        InstallPlan::ReplaceCurrent { archive_dir } => {
            // Hold the cross-release lifecycle lock across the live-process
            // re-check and the whole archive transaction.
            let _lock = LifecycleLock::acquire()?;
            refuse_while_running()?;
            let current_now = versions::current_version(&layout.install_dir)?;
            if current_now != layout.current {
                bail!(
                    "Current changed from {} to {} while downloading; re-run install",
                    layout.current,
                    current_now
                );
            }
            apply_replace_current(
                &layout.home,
                &layout.install_dir,
                &layout.current,
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

fn apply_archive_only(target_dir: &Path, staged: &Path) -> Result<PathBuf> {
    if target_dir.exists() {
        if target_dir.join("bin").join("nession").is_file() {
            return Ok(target_dir.to_path_buf());
        }
        bail!(
            "archive {} exists but is incomplete; remove it before reinstalling",
            target_dir.display()
        );
    }
    if let Some(parent) = target_dir.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create the versions root {}", parent.display()))?;
    }
    fs::create_dir(target_dir).with_context(|| {
        format!(
            "failed to claim the archive directory {}",
            target_dir.display()
        )
    })?;
    let bin_dir = target_dir.join("bin");
    if let Err(error) = fs::create_dir(&bin_dir) {
        let _ = fs::remove_dir_all(target_dir);
        return Err(error).with_context(|| format!("failed to create {}", bin_dir.display()));
    }
    for name in BINARIES {
        if let Err(error) = copy_binary(&staged.join(name), &bin_dir.join(name)) {
            let _ = fs::remove_dir_all(target_dir);
            return Err(error);
        }
    }
    Ok(target_dir.to_path_buf())
}

fn apply_replace_current(
    home: &Path,
    install_dir: &Path,
    current: &Version,
    archive_dir: &Path,
    staged: &Path,
) -> Result<PathBuf> {
    for name in BINARIES {
        if !install_dir.join(name).is_file() {
            bail!(
                "the Current installation is incomplete: {} is missing",
                install_dir.join(name).display()
            );
        }
    }
    if archive_dir.exists() {
        bail!(
            "archive {} appeared while installing; refusing to overwrite it",
            archive_dir.display()
        );
    }

    let archive_bin = archive_dir.join("bin");
    fs::create_dir_all(&archive_bin)
        .with_context(|| format!("failed to create {}", archive_bin.display()))?;

    // 1. A complete copy of the Current binaries is the rollback source and
    //    the archived release entry.
    for name in BINARIES {
        copy_binary(&install_dir.join(name), &archive_bin.join(name))
            .with_context(|| format!("failed to archive the Current {name} binary"))?;
    }

    // 2. Move the configuration and durable state with the release. They are
    //    restored on failure.
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for name in CONFIG_FILES.iter().chain(DURABLE_DIRS.iter()) {
        let original = home.join(name);
        if !original.exists() {
            continue;
        }
        let archived = archive_dir.join(name);
        if let Err(error) = fs::rename(&original, &archived) {
            rollback_move(&moved);
            let _ = fs::remove_dir_all(archive_dir);
            return Err(error).with_context(|| {
                format!(
                    "failed to archive {}; Current was restored",
                    original.display()
                )
            });
        }
        moved.push((original, archived));
    }

    // 3. Install the target binaries into the managed install directory.
    for name in BINARIES {
        if let Err(error) = replace::atomic_replace(&staged.join(name), &install_dir.join(name)) {
            rollback_move(&moved);
            for bin in BINARIES {
                let archived = archive_bin.join(bin);
                if archived.is_file() {
                    let _ = replace::atomic_replace(&archived, &install_dir.join(bin));
                }
            }
            let _ = fs::remove_dir_all(archive_dir);
            return Err(error).with_context(|| {
                format!("failed to install release {name}; Current was restored from the archive")
            });
        }
    }

    println!(
        "Archived release {current} to {}; Current is now the installed target.",
        archive_dir.display()
    );
    Ok(archive_dir.to_path_buf())
}

fn rollback_move(moved: &[(PathBuf, PathBuf)]) {
    for (original, archived) in moved.iter().rev() {
        if archived.exists() && !original.exists() {
            let _ = fs::rename(archived, original);
        }
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
    replace::set_executable(destination)?;
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
        write_binary(&install_dir.join("nession"), version);
        write_binary(&install_dir.join("nession-agent"), version);
        write_binary(&install_dir.join("nession-server"), version);
        versions::Layout {
            home: root.path().join("home"),
            install_dir,
            current: Version::parse(version).unwrap(),
        }
    }

    fn staged(root: &TempDir, version: &str) -> PathBuf {
        let dir = root.path().join("staged");
        for name in BINARIES {
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

        let outcome = apply_archive_only(
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

        let archive = apply_replace_current(
            &layout.home,
            &layout.install_dir,
            &layout.current,
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
    fn a_missing_binary_refuses_a_replace() {
        let root = TempDir::new().unwrap();
        let layout = current_tree(&root, "1.1.0");
        fs::remove_file(layout.install_dir.join("nession-agent")).unwrap();

        let error = apply_replace_current(
            &layout.home,
            &layout.install_dir,
            &layout.current,
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
    fn a_failed_binary_install_restores_configuration_and_binaries() {
        let root = TempDir::new().unwrap();
        let layout = current_tree(&root, "1.1.0");
        fs::create_dir_all(&layout.home).unwrap();
        fs::write(layout.home.join("agent-config.toml"), "old-config").unwrap();
        let archive = layout.home.join("versions/1.1.0");

        // A staged release missing one binary fails after the configuration has
        // moved, which exercises the rollback path deterministically.
        let incomplete = root.path().join("incomplete-staged");
        write_binary(&incomplete.join("nession"), "1.2.0");
        write_binary(&incomplete.join("nession-server"), "1.2.0");

        let result = apply_replace_current(
            &layout.home,
            &layout.install_dir,
            &layout.current,
            &archive,
            &incomplete,
        );

        assert!(result.is_err(), "an incomplete release must fail");
        assert_eq!(
            fs::read_to_string(layout.home.join("agent-config.toml")).unwrap(),
            "old-config",
            "configuration must be restored after a failed transaction"
        );
        assert_eq!(
            fs::read_to_string(layout.install_dir.join("nession")).unwrap(),
            "1.1.0",
            "Current binaries must be restored after a failed transaction"
        );
        assert!(
            !archive.exists(),
            "a rolled-back archive must not masquerade as an installed release"
        );
    }
}
