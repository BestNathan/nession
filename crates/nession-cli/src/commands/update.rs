//! `nession update` command -- check for a release, or install one through the
//! same versioned archive rule as `nession install` (#3173).

use crate::update::github::GitHubReleaseClient;
use crate::update::install::{self, InstallRequest};
use crate::update::version::{compare_versions, VersionStatus};

pub async fn run(
    check_only: bool,
    target_version: Option<String>,
    dry_run: bool,
    skip_prompt: bool,
    include_installer: bool,
) -> Result<(), anyhow::Error> {
    if check_only {
        return check(target_version.as_deref()).await;
    }

    install::run(InstallRequest {
        version: target_version,
        dry_run,
        assume_yes: skip_prompt,
        // `update` keeps its confirmation prompt; `install` does not.
        prompt: !skip_prompt,
        include_installer,
    })
    .await
}

async fn check(target_version: Option<&str>) -> Result<(), anyhow::Error> {
    let current_version = env!("CARGO_PKG_VERSION");
    let client = GitHubReleaseClient::from_env()?;
    let release = match target_version {
        Some(version) => client.fetch_version(version).await?,
        None => client.fetch_latest().await?,
    };
    let latest_version = crate::update::github::parse_release_version(&release)
        .ok_or_else(|| anyhow::anyhow!("Invalid version tag in release: {}", release.tag_name))?;

    println!("Current version: {current_version}");
    println!("Latest version:  {latest_version}");
    match compare_versions(current_version, &latest_version) {
        VersionStatus::UpToDate => println!("Status: Up to date"),
        VersionStatus::UpdateAvailable { .. } => {
            println!("Status: Update available");
            println!("Run `nession update` to upgrade.");
        }
        VersionStatus::DevelopmentVersion { .. } => {
            println!("Status: Running a development version, latest release is {latest_version}");
        }
    }
    Ok(())
}
