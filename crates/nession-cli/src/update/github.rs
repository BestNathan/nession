//! GitHub Releases API client.
//!
//! Fetches release metadata and download URLs from
//! `api.github.com/repos/BestNathan/nession/releases`.

use crate::update::policy::{self, Deadline, TransferPolicy};
use crate::update::UpdateError;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, RETRY_AFTER};
use reqwest::Client;
use semver::Version;
use serde::Deserialize;

const USER_AGENT: &str = "nession-cli-update-check/1.0";

/// Read GITHUB_TOKEN or GH_TOKEN from the environment, if set.
fn github_token() -> Option<String> {
    std::env::var("GITHUB_TOKEN")
        .ok()
        .or_else(|| std::env::var("GH_TOKEN").ok())
        .filter(|t| !t.is_empty())
}

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
    #[allow(dead_code)]
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub assets: Vec<AssetInfo>,
}

/// Client for interacting with the GitHub Releases API.
///
/// Metadata and asset transfer use **separate clients with separate budgets**
/// (#4592 §8.1): the metadata client bounds each whole request (headers +
/// body) by the metadata timeout, while the asset client has no whole-request
/// timeout at all — a healthy multi-minute download must not be killed by a
/// metadata budget. The asset transfer's no-progress and total budgets are
/// enforced by the streaming owner ([`crate::update::download`]).
pub struct GitHubReleaseClient {
    metadata: Client,
    asset: Client,
    base_url: String,
    policy: TransferPolicy,
}

impl GitHubReleaseClient {
    /// Create a new client with default settings (GitHub API).
    pub fn new() -> Result<Self, reqwest::Error> {
        Self::with_base_url("https://api.github.com".to_string())
    }

    /// The client the CLI uses: `NESSION_UPDATE_API_URL` lets an isolated
    /// install/Case point release discovery at a local fixture server.
    pub fn from_env() -> Result<Self, reqwest::Error> {
        Self::from_env_with_policy(&TransferPolicy::default())
    }

    /// [`Self::from_env`] with an explicitly resolved transfer policy.
    pub fn from_env_with_policy(policy: &TransferPolicy) -> Result<Self, reqwest::Error> {
        match std::env::var("NESSION_UPDATE_API_URL") {
            Ok(url) if !url.trim().is_empty() => Self::with_policy(url, policy),
            _ => Self::with_policy("https://api.github.com".to_string(), policy),
        }
    }

    /// Create a client with a custom base URL (e.g. for testing with a mock server).
    pub fn with_base_url(base_url: String) -> Result<Self, reqwest::Error> {
        Self::with_policy(base_url, &TransferPolicy::default())
    }

    /// Create a client with a custom base URL and an explicit policy.
    pub fn with_policy(base_url: String, policy: &TransferPolicy) -> Result<Self, reqwest::Error> {
        let mut headers = HeaderMap::new();
        if let Some(token) = github_token() {
            if let Ok(mut auth_value) = HeaderValue::from_str(&format!("Bearer {token}")) {
                auth_value.set_sensitive(true);
                headers.insert(AUTHORIZATION, auth_value);
            }
        }
        let metadata = Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(policy.connect_timeout)
            .timeout(policy.metadata_timeout)
            .default_headers(headers.clone())
            .build()?;
        let asset = Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(policy.connect_timeout)
            .default_headers(headers)
            .build()?;
        Ok(Self {
            metadata,
            asset,
            base_url,
            policy: policy.clone(),
        })
    }

    /// Build the full releases API URL from the base URL.
    pub(crate) fn releases_url(&self) -> String {
        format!("{}/repos/BestNathan/nession/releases", self.base_url)
    }

    /// The asset-transfer client: connection-bounded, no whole-request timeout.
    pub fn asset_client(&self) -> &Client {
        &self.asset
    }

    /// The resolved policy this client was built with.
    pub fn policy(&self) -> &TransferPolicy {
        &self.policy
    }

    /// Send a metadata request with the bounded retry policy.
    ///
    /// Transient transport failures and 408/429/selected 5xx are retried with
    /// jittered exponential backoff inside a total budget derived from the
    /// per-request budget × attempts. A valid `Retry-After` is honored only
    /// while it fits the remaining budget; a longer one is a diagnosable
    /// rate-limit exit, never an unbounded sleep. Permanent statuses (401,
    /// 403, 404, …) are returned to the caller immediately.
    async fn send_metadata(&self, url: &str) -> Result<reqwest::Response, UpdateError> {
        let attempts = self.policy.attempts();
        // Total budget: every attempt may use the full per-request budget,
        // plus the capped backoff sleeps between them.
        let total = self
            .policy
            .metadata_timeout
            .saturating_mul(attempts)
            .saturating_add(self.policy.backoff_max.saturating_mul(self.policy.retries));
        let deadline = Deadline::after(total);
        let mut last_cause = String::new();
        for attempt in 1..=attempts {
            if deadline.expired() {
                break;
            }
            let request = self.metadata.get(url);
            let send_budget = self.policy.metadata_timeout.min(deadline.remaining());
            let result = tokio::time::timeout(send_budget, request.send()).await;
            match result {
                Ok(Ok(resp)) => {
                    let status = resp.status().as_u16();
                    if !policy::is_retryable_status(status) || attempt == attempts {
                        return Ok(resp);
                    }
                    // 429 with a Retry-After beyond the budget is a precise
                    // rate-limit diagnostic, not a silent exhaustion.
                    if status == 429 {
                        if let Some(retry_after) = resp
                            .headers()
                            .get(RETRY_AFTER)
                            .and_then(|v| v.to_str().ok())
                            .and_then(policy::parse_retry_after)
                        {
                            if retry_after > deadline.remaining() {
                                return Err(UpdateError::RateLimitedRetryAfter {
                                    retry_after,
                                    remaining: deadline.remaining(),
                                });
                            }
                            let delay = deadline.cap_sleep(retry_after);
                            tokio::time::sleep(delay).await;
                            last_cause = format!("HTTP 429 (Retry-After {retry_after:?})");
                            continue;
                        }
                    }
                    last_cause = format!("HTTP {status}");
                }
                Ok(Err(error)) => {
                    if !policy::is_retryable_transport(&error) || attempt == attempts {
                        return Err(UpdateError::Network(format!(
                            "{}: {error} (after {attempt} attempt(s))",
                            policy::redact_url(url)
                        )));
                    }
                    last_cause = error.to_string();
                }
                Err(_) => {
                    if attempt == attempts {
                        return Err(UpdateError::ConnectTimeout {
                            url: policy::redact_url(url),
                            budget: send_budget,
                        });
                    }
                    last_cause = format!("request exceeded {send_budget:?}");
                }
            }
            let delay = policy::backoff_delay(
                attempt - 1,
                self.policy.backoff_base,
                self.policy.backoff_max,
                deadline.remaining(),
            );
            tokio::time::sleep(delay).await;
        }
        Err(UpdateError::Network(format!(
            "{}: {last_cause} (metadata budget of {total:?} exhausted after {attempts} attempts)",
            policy::redact_url(url)
        )))
    }

    /// Fetch the latest non-prerelease release.
    pub async fn fetch_latest(&self) -> Result<ReleaseInfo, UpdateError> {
        let url = format!("{}/latest", self.releases_url());
        let resp = self.send_metadata(&url).await?;

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
        let url = format!("{}/tags/{tag}", self.releases_url());
        let resp = self.send_metadata(&url).await?;

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
            .send_metadata(&checksum_asset.browser_download_url)
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
            "platform '{p}' not in supported list"
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
                name: format!("nession-0.5.0-{platform}.tar.gz"),
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

    #[test]
    fn with_base_url_constructor() {
        let client = GitHubReleaseClient::with_base_url("https://api.example.com".into()).unwrap();
        let url = client.releases_url();
        assert_eq!(
            url,
            "https://api.example.com/repos/BestNathan/nession/releases"
        );
    }

    #[test]
    fn releases_url_default() {
        let client = GitHubReleaseClient::new().unwrap();
        let url = client.releases_url();
        assert_eq!(
            url,
            "https://api.github.com/repos/BestNathan/nession/releases"
        );
    }

    #[test]
    fn asset_client_accessor() {
        let client = GitHubReleaseClient::new().unwrap();
        let _asset = client.asset_client(); // Should compile and return &Client
        assert_eq!(client.policy(), &TransferPolicy::default());
    }

    #[test]
    fn find_platform_asset_with_many_assets() {
        let platform = platform_string();
        let client = GitHubReleaseClient::new().unwrap();
        let release = ReleaseInfo {
            tag_name: "v0.5.0".into(),
            prerelease: false,
            assets: vec![
                AssetInfo {
                    name: "checksums.txt".into(),
                    browser_download_url: "https://example.com/checksums.txt".into(),
                },
                AssetInfo {
                    name: format!("nession-0.5.0-{platform}.tar.gz"),
                    browser_download_url: "https://example.com/tarball.tar.gz".into(),
                },
                AssetInfo {
                    name: "nession-0.5.0-linux-amd64.tar.gz".into(),
                    browser_download_url: "https://example.com/other.tar.gz".into(),
                },
            ],
        };
        let asset = client.find_platform_asset(&release).unwrap();
        assert_eq!(asset.name, format!("nession-0.5.0-{platform}.tar.gz"));
    }

    #[test]
    fn find_platform_asset_tag_without_v() {
        let platform = platform_string();
        let client = GitHubReleaseClient::new().unwrap();
        let release = ReleaseInfo {
            tag_name: "0.5.0".into(),
            prerelease: false,
            assets: vec![AssetInfo {
                name: format!("nession-0.5.0-{platform}.tar.gz"),
                browser_download_url: "https://example.com/tarball.tar.gz".into(),
            }],
        };
        let asset = client.find_platform_asset(&release).unwrap();
        assert_eq!(asset.name, format!("nession-0.5.0-{platform}.tar.gz"));
    }

    #[test]
    fn platform_string_format() {
        let p = platform_string();
        // Should be "{os}-{arch}" format
        assert!(p.contains('-'), "platform should have a '-' separator");
        let parts: Vec<&str> = p.split('-').collect();
        assert_eq!(parts.len(), 2, "platform should have exactly 2 parts");
        assert!(!parts[0].is_empty(), "OS part should not be empty");
        assert!(!parts[1].is_empty(), "arch part should not be empty");
    }
}
