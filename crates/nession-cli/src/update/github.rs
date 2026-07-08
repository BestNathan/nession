//! GitHub Releases API client.
//!
//! Fetches release metadata and download URLs from
//! `api.github.com/repos/BestNathan/nession/releases`.

use crate::update::UpdateError;
use reqwest::Client;
use semver::Version;
use serde::Deserialize;

const GITHUB_API: &str = "https://api.github.com/repos/BestNathan/nession/releases";
const USER_AGENT: &str = "nession-cli-update-check/1.0";

/// A single release asset from the GitHub API.
#[derive(Debug, Deserialize)]
pub struct AssetInfo {
    pub name: String,
    pub browser_download_url: String,
}

/// Release metadata fetched from GitHub.
#[derive(Debug, Deserialize)]
pub struct ReleaseInfo {
    pub tag_name: String,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub assets: Vec<AssetInfo>,
}

/// Client for interacting with the GitHub Releases API.
pub struct GitHubReleaseClient {
    pub client: Client,
}

impl GitHubReleaseClient {
    /// Create a new client with default settings.
    pub fn new() -> Result<Self, reqwest::Error> {
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .timeout(std::time::Duration::from_secs(10))
            .build()?;
        Ok(Self { client })
    }

    /// Fetch the latest non-prerelease release.
    pub async fn fetch_latest(&self) -> Result<ReleaseInfo, UpdateError> {
        let url = format!("{GITHUB_API}/latest");
        let resp = self.client.get(&url).send().await?;

        match resp.status().as_u16() {
            200 => {
                let release: ReleaseInfo = resp.json().await?;
                Ok(release)
            }
            403 | 429 => Err(UpdateError::RateLimited),
            _ => Err(UpdateError::Network(format!(
                "GitHub API returned {}",
                resp.status()
            ))),
        }
    }

    /// Fetch a specific release by tag name (with "v" prefix).
    pub async fn fetch_version(&self, version: &str) -> Result<ReleaseInfo, UpdateError> {
        let tag = format!("v{version}");
        let url = format!("{GITHUB_API}/tags/{tag}");
        let resp = self.client.get(&url).send().await?;

        match resp.status().as_u16() {
            200 => {
                let release: ReleaseInfo = resp.json().await?;
                Ok(release)
            }
            404 => Err(UpdateError::ReleaseNotFound(version.to_string())),
            403 | 429 => Err(UpdateError::RateLimited),
            _ => Err(UpdateError::Network(format!(
                "GitHub API returned {}",
                resp.status()
            ))),
        }
    }

    /// Download the checksums.txt content from a release.
    pub async fn download_checksums(&self, release: &ReleaseInfo) -> Result<String, UpdateError> {
        let checksum_asset = release
            .assets
            .iter()
            .find(|a| a.name == "checksums.txt")
            .ok_or_else(|| UpdateError::AssetNotFound("checksums.txt".into()))?;

        let resp = self
            .client
            .get(&checksum_asset.browser_download_url)
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(UpdateError::Network(format!(
                "Failed to download checksums: HTTP {}",
                resp.status()
            )));
        }

        let content = resp.text().await?;
        Ok(content)
    }

    /// Find the release asset matching the current platform.
    pub fn find_platform_asset<'a>(
        &self,
        release: &'a ReleaseInfo,
    ) -> Result<&'a AssetInfo, UpdateError> {
        let platform = platform_string();
        let pattern = format!(
            "nession-{}-{}.tar.gz",
            release.tag_name.trim_start_matches('v'),
            platform
        );
        release
            .assets
            .iter()
            .find(|a| a.name == pattern)
            .ok_or(UpdateError::AssetNotFound(pattern))
    }
}

/// Detect the current platform as "{os}-{arch}".
pub fn platform_string() -> String {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;

    let os_name = match os {
        "macos" => "darwin",
        other => other,
    };

    let arch_name = match arch {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    };

    format!("{os_name}-{arch_name}")
}

/// Parse the tag_name from a GitHub release into a semver::Version.
pub fn parse_release_version(release: &ReleaseInfo) -> Option<Version> {
    let stripped = release
        .tag_name
        .strip_prefix('v')
        .unwrap_or(&release.tag_name);
    Version::parse(stripped).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_string_is_known_format() {
        let p = platform_string();
        let valid = ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"];
        assert!(
            valid.contains(&p.as_str()),
            "platform '{}' not in supported list",
            p
        );
    }

    #[test]
    fn parse_tag_with_v_prefix() {
        let release = ReleaseInfo {
            tag_name: "v0.5.0".into(),
            prerelease: false,
            assets: vec![],
        };
        let v = parse_release_version(&release).unwrap();
        assert_eq!(v.to_string(), "0.5.0");
    }

    #[test]
    fn parse_tag_without_v_prefix() {
        let release = ReleaseInfo {
            tag_name: "0.5.0".into(),
            prerelease: false,
            assets: vec![],
        };
        let v = parse_release_version(&release).unwrap();
        assert_eq!(v.to_string(), "0.5.0");
    }

    #[test]
    fn find_platform_asset_found() {
        let platform = platform_string();
        let client = GitHubReleaseClient::new().unwrap();
        let release = ReleaseInfo {
            tag_name: "v0.5.0".into(),
            prerelease: false,
            assets: vec![AssetInfo {
                name: format!("nession-0.5.0-{}.tar.gz", platform),
                browser_download_url: "https://example.com/tarball.tar.gz".into(),
            }],
        };
        let asset = client.find_platform_asset(&release).unwrap();
        assert!(asset.name.contains(&platform));
    }

    #[test]
    fn find_platform_asset_not_found() {
        let client = GitHubReleaseClient::new().unwrap();
        let release = ReleaseInfo {
            tag_name: "v0.5.0".into(),
            prerelease: false,
            assets: vec![],
        };
        let err = client.find_platform_asset(&release).unwrap_err();
        assert!(matches!(err, UpdateError::AssetNotFound(_)));
    }
}
