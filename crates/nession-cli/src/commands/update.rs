//! `nession update` command -- orchestrates the full self-update flow.

use crate::update::download;
use crate::update::github::GitHubReleaseClient;
use crate::update::replace;
use crate::update::version::{compare_versions, VersionStatus};
use crate::update::BinaryStatus;

pub async fn run_update(
    check_only: bool,
    target_version: Option<String>,
    dry_run: bool,
    skip_prompt: bool,
) -> Result<(), anyhow::Error> {
    let current_version = env!("CARGO_PKG_VERSION");

    let client = GitHubReleaseClient::new()?;

    let release = match &target_version {
        Some(ver) => client.fetch_version(ver).await?,
        None => client.fetch_latest().await?,
    };

    let latest_version = crate::update::github::parse_release_version(&release)
        .ok_or_else(|| anyhow::anyhow!("Invalid version tag in release: {}", release.tag_name))?;

    let status = compare_versions(current_version, &latest_version);

    if check_only {
        println!("Current version: {current_version}");
        println!("Latest version:  {latest_version}");
        match status {
            VersionStatus::UpToDate => {
                println!("Status: Up to date");
            }
            VersionStatus::UpdateAvailable { .. } => {
                println!("Status: Update available");
                println!("Run `nession update` to upgrade.");
            }
            VersionStatus::DevelopmentVersion { .. } => {
                println!(
                    "Status: Running a development version, latest release is {latest_version}"
                );
            }
        }
        return Ok(());
    }

    match status {
        VersionStatus::UpToDate => {
            println!("Already up to date (v{current_version}).");
            return Ok(());
        }
        VersionStatus::DevelopmentVersion { .. } => {
            println!("Running a development version ({current_version}), latest release is {latest_version}.");
            if target_version.is_none() {
                println!("Use --version {latest_version} to upgrade to the latest release.");
                return Ok(());
            }
        }
        VersionStatus::UpdateAvailable {
            ref current,
            ref latest,
        } => {
            println!("Upgrade available: v{current} -> v{latest}");
        }
    }

    if !skip_prompt {
        use std::io::Write;
        print!("Continue with update? [y/N] ");
        std::io::stdout().flush()?;
        let mut input = String::new();
        std::io::stdin().read_line(&mut input)?;
        if input.trim().to_lowercase() != "y" && input.trim().to_lowercase() != "yes" {
            println!("Aborted.");
            return Ok(());
        }
    }

    let asset = client.find_platform_asset(&release)?;
    println!("Downloading {}...", asset.name);

    if dry_run {
        println!("[dry-run] Would download: {}", asset.browser_download_url);
        println!("[dry-run] Would verify SHA256 checksum.");
        println!("[dry-run] Would replace: nession, nession-agent, nession-server");
        return Ok(());
    }

    let tmp_dir = download::temp_extract_dir()?;
    let tarball_path = tmp_dir.join(&asset.name);

    download::download_to_file(
        client.http_client(),
        &asset.browser_download_url,
        &tarball_path,
    )
    .await?;

    let checksums = client.download_checksums(&release).await?;
    download::verify_checksum(&tarball_path, &checksums, &asset.name)?;
    println!("Checksum verified.");

    download::extract_binaries(&tarball_path, &tmp_dir)?;

    let cli_dir = replace::cli_install_dir()?;
    let binaries = ["nession", "nession-agent", "nession-server"];
    let mut results = Vec::new();

    for name in &binaries {
        let src = tmp_dir.join(name);
        let target = match replace::locate_binary(name, &cli_dir) {
            Some(p) => p,
            None => {
                results.push(BinaryStatus::Skipped {
                    name: name.to_string(),
                    reason: "binary not found".into(),
                });
                continue;
            }
        };

        if let Err(e) = replace::check_write_permission(&target) {
            results.push(BinaryStatus::Failed {
                name: name.to_string(),
                error: e,
            });
            continue;
        }

        if let Some(pid) = replace::is_process_running(name) {
            eprintln!("{name} is running (PID: {pid}). Restart to use new version.");
        }

        if let Err(e) = replace::backup_binary(&target) {
            results.push(BinaryStatus::Failed {
                name: name.to_string(),
                error: e,
            });
            continue;
        }

        match replace::atomic_replace(&src, &target) {
            Ok(()) => {
                replace::maybe_print_quarantine_hint(&target);
                results.push(BinaryStatus::Replaced(target));
            }
            Err(e) => {
                results.push(BinaryStatus::Failed {
                    name: name.to_string(),
                    error: e,
                });
            }
        }
    }

    println!("\nUpdate results:");
    for r in &results {
        match r {
            BinaryStatus::Replaced(path) => println!(
                "  ✓ {} -> {}",
                path.file_name().unwrap_or_default().to_string_lossy(),
                path.display()
            ),
            BinaryStatus::Skipped { name, reason } => {
                println!("  - {name} (skipped: {reason})")
            }
            BinaryStatus::Failed { name, error } => println!("  ✗ {name} ({error})"),
        }
    }

    let _ = std::fs::remove_dir_all(&tmp_dir);

    let all_ok = results.iter().all(BinaryStatus::is_ok);
    if !all_ok {
        anyhow::bail!("Some binaries failed to update. Old versions are backed up as .bak files.");
    }

    println!("\nUpdate complete.");
    Ok(())
}
