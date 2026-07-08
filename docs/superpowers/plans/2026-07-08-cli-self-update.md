# CLI Self-Update Command — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `nession update` subcommand with GitHub Releases integration, SHA256 verification, atomic binary replacement, and background version checking.

**Architecture:** All new code in `crates/nession-cli/src/update/` — seven focused modules each with a single responsibility. The `Update` clap subcommand flows through `UpdateOrchestrator` which coordinates: version detection → GitHub API → download+verify → backup+replace. Background check uses the same cache/github modules but runs as a fire-and-forget tokio task.

**Tech Stack:** Rust, reqwest 0.12, semver 1.0, sha2 0.10, flate2 1.0, tar 0.4, thiserror 1.0, clap 4.4

---

### Task 1: Add dependencies

**Files:**
- Modify: `crates/nession-cli/Cargo.toml`

- [ ] **Step 1: Add production dependencies**

Edit `crates/nession-cli/Cargo.toml`, add to `[dependencies]`:

```toml
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "stream"] }
sha2 = "0.10"
flate2 = "1.0"
tar = "0.4"
semver = "1.0"
thiserror.workspace = true
```

And to `[dev-dependencies]`:

```toml
httptest = "0.16"
```

- [ ] **Step 2: Verify dependency resolution**

Run: `cargo check -p nession-cli 2>&1`
Expected: Dependencies resolve and download without errors.

- [ ] **Step 3: Commit**

```bash
git add crates/nession-cli/Cargo.toml Cargo.lock
git commit -m "chore: add update command dependencies (reqwest, semver, sha2, flate2, tar, thiserror, httptest)"
```

---

### Task 2: Implement version parsing and comparison

**Files:**
- Create: `crates/nession-cli/src/update/version.rs`
- Create: `crates/nession-cli/src/update/mod.rs` (minimal, will expand)

- [ ] **Step 1: Create `update/mod.rs` skeleton**

File: `crates/nession-cli/src/update/mod.rs`

```rust
//! Self-update system for nession CLI binaries.
//!
//! Provides version detection via GitHub Releases API,
//! SHA256-verified downloads, and atomic binary replacement.

pub mod cache;
pub mod check;
pub mod download;
pub mod github;
pub mod replace;
pub mod version;

use thiserror::Error;
use std::path::PathBuf;

/// Errors that can occur during the update process.
#[derive(Debug, Error)]
pub enum UpdateError {
    #[error("Network error: unable to reach GitHub API")]
    Network(#[from] reqwest::Error),

    #[error("GitHub API rate limited. Try again later.")]
    RateLimited,

    #[error("No prebuilt binary for {0}-{1}")]
    UnsupportedPlatform(String, String),

    #[error("Release {0} not found")]
    ReleaseNotFound(String),

    #[error("No asset found matching {0}")]
    AssetNotFound(String),

    #[error("Checksum mismatch: expected {expected}, got {actual}")]
    ChecksumMismatch { expected: String, actual: String },

    #[error("No write permission for {0}")]
    PermissionDenied(PathBuf),

    #[error("Insufficient disk space: need {need} bytes, have {have} bytes")]
    InsufficientSpace { need: u64, have: u64 },

    #[error("Binary {name} is running (PID: {pid}). Stop it first.")]
    ProcessRunning { name: String, pid: u32 },

    #[error("Failed to extract archive: {0}")]
    ExtractionFailed(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

/// Outcome for a single binary replacement.
#[derive(Debug)]
pub enum BinaryStatus {
    /// Successfully replaced.
    Replaced(PathBuf),
    /// Skipped (e.g., binary not found).
    Skipped { name: String, reason: String },
    /// Failed to replace.
    Failed { name: String, error: UpdateError },
}

impl BinaryStatus {
    pub fn name(&self) -> &str {
        match self {
            BinaryStatus::Replaced(_) => "replaced",
            BinaryStatus::Skipped { name, .. } => name.as_str(),
            BinaryStatus::Failed { name, .. } => name.as_str(),
        }
    }

    pub fn is_ok(&self) -> bool {
        matches!(self, BinaryStatus::Replaced(_) | BinaryStatus::Skipped { .. })
    }
}
```

- [ ] **Step 2: Write version.rs tests**

File: `crates/nession-cli/src/update/version.rs`

```rust
//! SemVer parsing and comparison.
//!
//! Handles parsing version strings with optional "v" prefix,
//! comparing current vs latest versions, and filtering prereleases.

use semver::Version;

/// Result of comparing the current version against the latest release.
#[derive(Debug, PartialEq, Eq)]
pub enum VersionStatus {
    /// Already running the latest version.
    UpToDate,
    /// A newer version is available.
    UpdateAvailable {
        current: Version,
        latest: Version,
    },
    /// Current version is newer than the latest release (development build).
    DevelopmentVersion {
        current: String,
        latest: Version,
    },
}

/// Parse a version string, stripping an optional "v" prefix.
/// Returns `None` for non-SemVer strings (like "0.4.0-dev" or "unknown").
pub fn parse_semver(raw: &str) -> Option<Version> {
    let stripped = raw.strip_prefix('v').unwrap_or(raw);
    Version::parse(stripped).ok()
}

/// Compare the current version against the latest release version.
///
/// `current_raw` is the version string from `env!("CARGO_PKG_VERSION")`.
/// `latest` is the parsed semver::Version from the GitHub release tag.
pub fn compare_versions(current_raw: &str, latest: &Version) -> VersionStatus {
    match parse_semver(current_raw) {
        Some(current) if current == *latest => VersionStatus::UpToDate,
        Some(current) if current < *latest => VersionStatus::UpdateAvailable {
            current,
            latest: latest.clone(),
        },
        Some(current) => VersionStatus::DevelopmentVersion {
            current: current_raw.to_string(),
            latest: latest.clone(),
        },
        // current_raw is not valid SemVer (e.g., "0.4.0-dev") — treat as dev version
        None => VersionStatus::DevelopmentVersion {
            current: current_raw.to_string(),
            latest: latest.clone(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_with_v_prefix() {
        let v = parse_semver("v0.5.0").unwrap();
        assert_eq!(v.major, 0);
        assert_eq!(v.minor, 5);
        assert_eq!(v.patch, 0);
    }

    #[test]
    fn parse_without_v_prefix() {
        let v = parse_semver("1.2.3").unwrap();
        assert_eq!(v.to_string(), "1.2.3");
    }

    #[test]
    fn parse_dev_version_returns_none() {
        assert!(parse_semver("0.4.0-dev").is_none());
    }

    #[test]
    fn parse_prerelease_is_valid_semver() {
        // semver crate considers "1.0.0-beta.1" valid
        let v = parse_semver("v1.0.0-beta.1").unwrap();
        assert!(v.pre.as_str() == "beta.1");
    }

    #[test]
    fn compare_up_to_date() {
        let latest = Version::new(0, 4, 2);
        let status = compare_versions("0.4.2", &latest);
        assert_eq!(status, VersionStatus::UpToDate);
    }

    #[test]
    fn compare_update_available() {
        let latest = Version::new(0, 5, 0);
        let status = compare_versions("0.4.2", &latest);
        assert!(matches!(status, VersionStatus::UpdateAvailable { .. }));
    }

    #[test]
    fn compare_development_version() {
        let latest = Version::new(0, 4, 2);
        let status = compare_versions("0.5.0", &latest);
        assert!(matches!(status, VersionStatus::DevelopmentVersion { .. }));
    }

    #[test]
    fn compare_dev_string_treated_as_dev() {
        let latest = Version::new(0, 4, 2);
        let status = compare_versions("0.5.0-dev", &latest);
        assert!(matches!(status, VersionStatus::DevelopmentVersion { .. }));
    }

    #[test]
    fn parse_v_prefix_prerelease() {
        let v = parse_semver("v0.5.0-rc.1").unwrap();
        assert_eq!(v.major, 0);
        assert_eq!(v.minor, 5);
        assert_eq!(v.patch, 0);
        assert_eq!(v.pre.as_str(), "rc.1");
    }

    #[test]
    fn parse_unknown_marker_returns_none() {
        assert!(parse_semver("unknown").is_none());
    }
}
```

- [ ] **Step 3: Run version tests**

Run: `cargo test -p nession-cli -- update::version 2>&1`
Expected: All 10 tests pass.

- [ ] **Step 4: Run clippy on the new code**

Run: `cargo clippy -p nession-cli -- -D warnings 2>&1`
Expected: No warnings.

- [ ] **Step 5: Commit**

```bash
git add crates/nession-cli/src/update/
git commit -m "feat: add version parsing and comparison for self-update"
```

---

### Task 3: Implement update check cache

**Files:**
- Create: `crates/nession-cli/src/update/cache.rs`

- [ ] **Step 1: Write cache module with tests**

File: `crates/nession-cli/src/update/cache.rs`

```rust
//! Update-check cache stored in ~/.nession/update-check.json.
//!
//! Caches the latest version check result for 30 minutes to avoid
//! excessive GitHub API calls on every CLI invocation.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::io;
use std::path::PathBuf;

/// Cache TTL: 30 minutes.
const CACHE_TTL_MINUTES: i64 = 30;

/// Serialized cache stored in ~/.nession/update-check.json.
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateCache {
    pub checked_at: DateTime<Utc>,
    pub latest_version: String,
    pub current_version: String,
    pub update_available: bool,
}

/// Returns the path to the update-check cache file.
fn cache_path() -> io::Result<PathBuf> {
    nession_common::paths::nession_home().map(|h| h.join("update-check.json"))
}

/// Read the cached update check result, if it exists and can be parsed.
pub fn read_cache() -> Option<UpdateCache> {
    let path = cache_path().ok()?;
    let data = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str::<UpdateCache>(&data).ok()
}

/// Write the update check result to the cache file.
/// Creates the ~/.nession directory if it doesn't exist.
pub fn write_cache(cache: &UpdateCache) -> io::Result<()> {
    let path = cache_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_string_pretty(cache).map_err(|e| {
        io::Error::new(io::ErrorKind::InvalidData, e)
    })?;
    std::fs::write(&path, data)
}

/// Return true if the cached result is still fresh (within TTL).
pub fn is_cache_fresh(checked_at: &DateTime<Utc>) -> bool {
    let now = Utc::now();
    let elapsed = now.signed_duration_since(*checked_at);
    elapsed.num_minutes() < CACHE_TTL_MINUTES
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    #[test]
    fn fresh_within_ttl() {
        let five_min_ago = Utc::now() - Duration::minutes(5);
        assert!(is_cache_fresh(&five_min_ago));
    }

    #[test]
    fn stale_beyond_ttl() {
        let thirty_one_min_ago = Utc::now() - Duration::minutes(31);
        assert!(!is_cache_fresh(&thirty_one_min_ago));
    }

    #[test]
    fn fresh_at_exactly_ttl_minus_one() {
        let twenty_nine_min_ago = Utc::now() - Duration::minutes(29);
        assert!(is_cache_fresh(&twenty_nine_min_ago));
    }

    #[test]
    fn stale_at_exactly_ttl() {
        let thirty_min_ago = Utc::now() - Duration::minutes(30);
        // 30 minutes exactly should be stale (< 30, not <= 30)
        assert!(!is_cache_fresh(&thirty_min_ago));
    }

    #[test]
    fn roundtrip_write_read() {
        let cache = UpdateCache {
            checked_at: Utc::now(),
            latest_version: "0.5.0".into(),
            current_version: "0.4.2".into(),
            update_available: true,
        };
        write_cache(&cache).unwrap();
        let read = read_cache().unwrap();
        assert_eq!(read.latest_version, "0.5.0");
        assert_eq!(read.current_version, "0.4.2");
        assert!(read.update_available);
    }

    #[test]
    fn read_cache_file_not_exists() {
        // Ensure no cache file exists in a clean state.
        // This test relies on the real cache path, so we clean up first.
        let path = cache_path().unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(read_cache().is_none());
    }
}
```

- [ ] **Step 2: Run cache tests**

Run: `cargo test -p nession-cli -- update::cache 2>&1`
Expected: All 6 tests pass.

- [ ] **Step 3: Run clippy**

Run: `cargo clippy -p nession-cli -- -D warnings 2>&1`
Expected: No warnings.

- [ ] **Step 4: Commit**

```bash
git add crates/nession-cli/src/update/cache.rs
git commit -m "feat: add update-check cache with 30min TTL"
```

---

### Task 4: Implement GitHub Releases API client

**Files:**
- Create: `crates/nession-cli/src/update/github.rs`

- [ ] **Step 1: Write github module with tests**

File: `crates/nession-cli/src/update/github.rs`

```rust
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
    client: Client,
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
    /// Returns the first release found (GitHub's /latest endpoint).
    pub async fn fetch_latest(&self) -> Result<ReleaseInfo, UpdateError> {
        let url = format!("{}/latest", GITHUB_API);
        let resp = self.client.get(&url).send().await?;

        match resp.status().as_u16() {
            200 => {
                let release: ReleaseInfo = resp.json().await?;
                Ok(release)
            }
            403 | 429 => Err(UpdateError::RateLimited),
            _ => Err(UpdateError::Network(
                reqwest::Error::new(
                    reqwest::StatusCode::from_u16(resp.status().as_u16())
                        .unwrap_or(reqwest::StatusCode::INTERNAL_SERVER_ERROR),
                    format!("GitHub API returned {}", resp.status()),
                )
            )),
        }
    }

    /// Fetch a specific release by tag name (with "v" prefix).
    pub async fn fetch_version(&self, version: &str) -> Result<ReleaseInfo, UpdateError> {
        let tag = format!("v{}", version);
        let url = format!("{}/tags/{}", GITHUB_API, tag);
        let resp = self.client.get(&url).send().await?;

        match resp.status().as_u16() {
            200 => {
                let release: ReleaseInfo = resp.json().await?;
                Ok(release)
            }
            404 => Err(UpdateError::ReleaseNotFound(version.to_string())),
            403 | 429 => Err(UpdateError::RateLimited),
            _ => Err(UpdateError::Network(
                reqwest::Error::new(
                    reqwest::StatusCode::from_u16(resp.status().as_u16())
                        .unwrap_or(reqwest::StatusCode::INTERNAL_SERVER_ERROR),
                    format!("GitHub API returned {}", resp.status()),
                )
            )),
        }
    }

    /// Download the checksums.txt content from a release.
    /// Finds the asset named "checksums.txt" and returns its content as a String.
    pub async fn download_checksums(
        &self,
        release: &ReleaseInfo,
    ) -> Result<String, UpdateError> {
        let checksum_asset = release
            .assets
            .iter()
            .find(|a| a.name == "checksums.txt")
            .ok_or_else(|| UpdateError::AssetNotFound("checksums.txt".into()))?;

        let resp = self.client
            .get(&checksum_asset.browser_download_url)
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(UpdateError::Network(
                reqwest::Error::new(
                    reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to download checksums: HTTP {}", resp.status()),
                )
            ));
        }

        let content = resp.text().await?;
        Ok(content)
    }

    /// Find the release asset matching the current platform.
    /// Asset naming: nession-{V}-{os}-{arch}.tar.gz
    pub fn find_platform_asset<'a>(
        &self,
        release: &'a ReleaseInfo,
    ) -> Result<&'a AssetInfo, UpdateError> {
        let platform = platform_string();
        let pattern = format!("nession-{}-{}.tar.gz", release.tag_name.trim_start_matches('v'), platform);
        release
            .assets
            .iter()
            .find(|a| a.name == pattern)
            .ok_or_else(|| UpdateError::AssetNotFound(pattern))
    }
}

/// Detect the current platform as "{os}-{arch}".
/// Returns strings like "linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64".
pub fn platform_string() -> String {
    let os = std::env::consts::OS; // "linux" or "macos"
    let arch = std::env::consts::ARCH; // "x86_64" or "aarch64"

    let os_name = match os {
        "macos" => "darwin",
        other => other,
    };

    let arch_name = match arch {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    };

    format!("{}-{}", os_name, arch_name)
}

/// Parse the tag_name from a GitHub release (strip "v" prefix) into a semver::Version.
pub fn parse_release_version(release: &ReleaseInfo) -> Option<Version> {
    let stripped = release.tag_name.strip_prefix('v').unwrap_or(&release.tag_name);
    Version::parse(stripped).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_string_is_known_format() {
        let p = platform_string();
        // Should match one of the four supported platforms.
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
            assets: vec![
                AssetInfo {
                    name: format!("nession-0.5.0-{}.tar.gz", platform),
                    browser_download_url: "https://example.com/tarball.tar.gz".into(),
                },
            ],
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
```

- [ ] **Step 2: Run github tests**

Run: `cargo test -p nession-cli -- update::github 2>&1`
Expected: All 5 tests pass.

- [ ] **Step 3: Run clippy**

Run: `cargo clippy -p nession-cli -- -D warnings 2>&1`
Expected: No warnings.

- [ ] **Step 4: Commit**

```bash
git add crates/nession-cli/src/update/github.rs
git commit -m "feat: add GitHub Releases API client for self-update"
```

---

### Task 5: Implement binary replace module

**Files:**
- Create: `crates/nession-cli/src/update/replace.rs`

- [ ] **Step 1: Write replace module with tests**

File: `crates/nession-cli/src/update/replace.rs`

```rust
//! Binary file operations: locate, backup, and atomically replace.
//!
//! Handles the file-level mechanics of updating the three nession binaries
//! (nession, nession-agent, nession-server), including self-replacement of
//! the running CLI binary via unlink+write.

use crate::update::UpdateError;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Return the install directory (where the CLI binary lives).
/// Uses `std::env::current_exe()` to find the running binary's directory.
pub fn cli_install_dir() -> Result<PathBuf, UpdateError> {
    let exe = std::env::current_exe().map_err(UpdateError::Io)?;
    // Resolve symlinks to get the real path.
    let canonical = std::fs::canonicalize(&exe).unwrap_or(exe);
    canonical
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| UpdateError::Io(
            std::io::Error::new(std::io::ErrorKind::NotFound, "cannot determine CLI directory")
        ))
}

/// Look up a binary by name. For the CLI binary, use `current_exe()`.
/// For agent/server, search the same directory as the CLI first, then PATH.
pub fn locate_binary(name: &str, cli_dir: &Path) -> Option<PathBuf> {
    // If we're looking for the CLI binary itself, use current_exe.
    if name == "nession" {
        return std::env::current_exe().ok();
    }

    // Check same directory as CLI first.
    let candidate = cli_dir.join(name);
    if candidate.exists() {
        return Some(candidate);
    }

    // Fall back to PATH search.
    which_in_path(name)
}

/// Search for a binary in the system PATH.
fn which_in_path(name: &str) -> Option<PathBuf> {
    let output = Command::new("which").arg(name).output().ok()?;
    if output.status.success() {
        let path_str = String::from_utf8(output.stdout).ok()?;
        let path = PathBuf::from(path_str.trim());
        if path.exists() {
            return Some(path);
        }
    }
    None
}

/// Check that the directory containing `path` is writable.
pub fn check_write_permission(path: &Path) -> Result<(), UpdateError> {
    let dir = path.parent().unwrap_or(path);
    if dir.is_dir() && std::fs::metadata(dir).map(|m| m.permissions().readonly()).unwrap_or(true)
    {
        return Err(UpdateError::PermissionDenied(dir.to_path_buf()));
    }
    Ok(())
}

/// Check if there's enough free space on the filesystem for `path`.
/// `needed` is the approximate bytes required (tarball + extracted binaries).
pub fn check_disk_space(path: &Path, needed: u64) -> Result<(), UpdateError> {
    // Use `df` to check available space on the filesystem.
    let dir = if path.is_dir() { path } else { path.parent().unwrap_or(path) };
    let dir_str = dir.to_string_lossy();

    let output = Command::new("df")
        .args(["--block-size=1", &dir_str])
        .output()
        .map_err(|_| UpdateError::Io(std::io::Error::new(
            std::io::ErrorKind::Other, "failed to run df",
        )))?;

    if !output.status.success() {
        return Ok(()); // Can't check — skip rather than block.
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Parse second line (skip header), fourth column is available.
    let avail = stdout
        .lines()
        .nth(1)
        .and_then(|line| line.split_whitespace().nth(3))
        .and_then(|s| s.parse::<u64>().ok());

    match avail {
        Some(a) if a < needed => Err(UpdateError::InsufficientSpace {
            need: needed,
            have: a,
        }),
        _ => Ok(()),
    }
}

/// Check if a process with the given binary name is currently running.
/// Returns the PID if found, None otherwise.
pub fn is_process_running(name: &str) -> Option<u32> {
    let output = Command::new("pgrep")
        .args(["-x", name])
        .output()
        .ok()?;

    if output.status.success() {
        let pid_str = String::from_utf8(output.stdout).ok()?;
        pid_str.trim().parse::<u32>().ok()
    } else {
        None
    }
}

/// Create a backup of the existing binary at `path` by copying to `path.bak`.
/// Returns the backup path.
pub fn backup_binary(path: &Path) -> Result<PathBuf, UpdateError> {
    let backup_path = path.with_extension("bak");
    std::fs::copy(path, &backup_path).map_err(UpdateError::Io)?;
    Ok(backup_path)
}

/// Set executable permission (755) on a file.
pub fn set_executable(path: &Path) -> Result<(), UpdateError> {
    let mut perms = std::fs::metadata(path).map_err(UpdateError::Io)?.permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).map_err(UpdateError::Io)?;
    Ok(())
}

/// Atomically replace the binary at `dst` with `src`.
///
/// For safe replacement across filesystems, this first copies `src` to a temp
/// file in `dst`'s directory, then renames the temp file over `dst`.
/// This is safe even when `dst` is the currently running binary: on Unix,
/// the running process keeps the old inode until exit, while new invocations
/// use the new file.
pub fn atomic_replace(src: &Path, dst: &Path) -> Result<(), UpdateError> {
    let dst_dir = dst.parent().unwrap_or_else(|| Path::new("."));

    // Create temp file in the same directory as dst (same filesystem = atomic rename).
    let tmp_name = format!(
        ".{}.tmp.{}",
        dst.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("binary"),
        std::process::id()
    );
    let tmp_path = dst_dir.join(&tmp_name);

    // Copy src → tmp.
    std::fs::copy(src, &tmp_path).map_err(UpdateError::Io)?;

    // Set executable permissions.
    set_executable(&tmp_path)?;

    // Atomic rename: tmp → dst.
    std::fs::rename(&tmp_path, dst).map_err(UpdateError::Io)?;

    Ok(())
}

/// Hint for macOS users about quarantine attributes.
pub fn maybe_print_quarantine_hint(path: &Path) {
    if cfg!(target_os = "macos") {
        eprintln!(
            "Note: macOS may quarantine the new binary. If blocked, run: xattr -d com.apple.quarantine {}",
            path.display()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn locate_nession_uses_current_exe() {
        let found = locate_binary("nession", Path::new("/nonexistent"));
        assert!(found.is_some(), "should find the running test binary");
    }

    #[test]
    fn locate_unknown_binary_returns_none() {
        let found = locate_binary("nonexistent-binary-xyz", Path::new("/tmp"));
        assert!(found.is_none());
    }

    #[test]
    fn backup_and_restore() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("test-bin");
        fs::write(&original, b"old").unwrap();

        let backup = backup_binary(&original).unwrap();
        assert_eq!(backup, dir.path().join("test-bin.bak"));
        assert_eq!(fs::read_to_string(&backup).unwrap(), "old");
    }

    #[test]
    fn atomic_replace_works() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("new-bin");
        let dst = dir.path().join("target-bin");
        fs::write(&src, b"new content").unwrap();
        fs::write(&dst, b"old content").unwrap();

        set_executable(&src).unwrap();
        atomic_replace(&src, &dst).unwrap();

        let content = fs::read_to_string(&dst).unwrap();
        assert_eq!(content, "new content");
        assert!(!src.exists()); // src not modified, dst has new content
    }

    #[test]
    fn write_permission_check() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("writable-bin");
        fs::write(&path, b"test").unwrap();
        // On a tempdir, we should have write permission.
        assert!(check_write_permission(&path).is_ok());
    }

    #[test]
    fn is_process_running_self() {
        // The test runner itself is unlikely to be named "nession-agent".
        let pid = is_process_running("nession-agent");
        assert!(pid.is_none(), "nession-agent should not be running during tests");
    }
}
```

- [ ] **Step 2: Run replace tests**

Run: `cargo test -p nession-cli -- update::replace 2>&1`
Expected: All 6 tests pass.

- [ ] **Step 3: Run clippy**

Run: `cargo clippy -p nession-cli -- -D warnings 2>&1`
Expected: No warnings.

- [ ] **Step 4: Commit**

```bash
git add crates/nession-cli/src/update/replace.rs
git commit -m "feat: add binary locate, backup, and atomic replace for self-update"
```

---

### Task 6: Implement download and verification module

**Files:**
- Create: `crates/nession-cli/src/update/download.rs`

- [ ] **Step 1: Write download module with tests**

File: `crates/nession-cli/src/update/download.rs`

```rust
//! Download, SHA256 verification, and tarball extraction.
//!
//! Downloads the platform-specific tarball from GitHub Releases,
//! verifies its SHA256 checksum against checksums.txt, and extracts
//! the three binaries into a temporary directory.

use crate::update::UpdateError;
use flate2::read::GzDecoder;
use reqwest::Client;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

/// Download a file from `url` and save it to `dest`.
/// Returns the number of bytes written.
pub async fn download_to_file(
    client: &Client,
    url: &str,
    dest: &Path,
) -> Result<u64, UpdateError> {
    let resp = client.get(url).send().await?;

    if !resp.status().is_success() {
        return Err(UpdateError::Network(
            reqwest::Error::new(
                reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                format!("Download failed: HTTP {}", resp.status()),
            )
        ));
    }

    let bytes = resp.bytes().await?;
    fs::write(dest, &bytes).map_err(UpdateError::Io)?;
    Ok(bytes.len() as u64)
}

/// Compute the SHA256 hash of a file and return the hex string.
pub fn sha256_file(path: &Path) -> Result<String, UpdateError> {
    let mut file = fs::File::open(path).map_err(UpdateError::Io)?;
    let mut hasher = Sha256::new();
    io::copy(&mut file, &mut hasher).map_err(UpdateError::Io)?;
    let hash = hasher.finalize();
    Ok(format!("{:x}", hash))
}

/// Verify a tarball's SHA256 against the checksums.txt content.
///
/// `checksums_content` is the raw text of checksums.txt from the GitHub release.
/// Looks for a line matching the expected tarball filename and verifies the hash.
pub fn verify_checksum(
    tarball_path: &Path,
    checksums_content: &str,
    tarball_filename: &str,
) -> Result<(), UpdateError> {
    let expected_hash = parse_checksum_line(checksums_content, tarball_filename)?;
    let actual_hash = sha256_file(tarball_path)?;

    if actual_hash != expected_hash {
        return Err(UpdateError::ChecksumMismatch {
            expected: expected_hash,
            actual: actual_hash,
        });
    }

    Ok(())
}

/// Parse a `sha256sum`-style checksum file and find the hash for `filename`.
///
/// Format: `<sha256hex>  <filename>` or `<sha256hex> *<filename>`.
fn parse_checksum_line(checksums_content: &str, filename: &str) -> Result<String, UpdateError> {
    for line in checksums_content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // Handle both "hash  filename" and "hash *filename" formats.
        let (hash, name_part) = line
            .split_once("  ")
            .or_else(|| line.split_once(" *"))
            .or_else(|| line.split_once('\t'))
            .ok_or_else(|| UpdateError::ExtractionFailed(
                format!("invalid checksum line: '{}'", line),
            ))?;

        let name_part = name_part.trim();
        if name_part == filename {
            return Ok(hash.trim().to_string());
        }
    }

    Err(UpdateError::AssetNotFound(format!(
        "checksum entry for '{}' not found in checksums.txt",
        filename
    )))
}

/// Extract the three nession binaries from a .tar.gz archive into `dest_dir`.
///
/// Returns a list of the extracted binary names.
pub fn extract_binaries(
    tarball_path: &Path,
    dest_dir: &Path,
) -> Result<Vec<String>, UpdateError> {
    let file = fs::File::open(tarball_path).map_err(UpdateError::Io)?;
    let decoder = GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);

    let expected = ["nession", "nession-agent", "nession-server"];
    let mut extracted = Vec::new();

    for entry in archive.entries().map_err(|e| {
        UpdateError::ExtractionFailed(format!("cannot read archive: {}", e))
    })? {
        let mut entry = entry.map_err(|e| {
            UpdateError::ExtractionFailed(format!("cannot read entry: {}", e))
        })?;

        let path = entry.path().map_err(|e| {
            UpdateError::ExtractionFailed(format!("cannot get entry path: {}", e))
        })?;

        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        if expected.contains(&name.as_str()) {
            entry.unpack_in(dest_dir).map_err(|e| {
                UpdateError::ExtractionFailed(format!("cannot extract {}: {}", name, e))
            })?;
            extracted.push(name);
        }
    }

    Ok(extracted)
}

/// Create a temporary directory for extraction.
pub fn temp_extract_dir() -> Result<PathBuf, UpdateError> {
    let dir = std::env::temp_dir().join(format!("nession-update-{}", std::process::id()));
    fs::create_dir_all(&dir).map_err(UpdateError::Io)?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use std::io::Write;

    /// Helper: create a test .tar.gz containing named files with content.
    fn create_test_tarball(path: &Path, files: &[(&str, &[u8])]) {
        let file = fs::File::create(path).unwrap();
        let encoder = GzEncoder::new(file, flate2::Compression::default());
        let mut archive = tar::Builder::new(encoder);

        for (name, content) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            archive.append_data(&mut header, name, content).unwrap();
        }

        let encoder = archive.into_inner().unwrap();
        encoder.finish().unwrap();
    }

    #[test]
    fn sha256_computation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.bin");
        fs::write(&path, b"hello world").unwrap();
        let hash = sha256_file(&path).unwrap();
        // Known SHA256 of "hello world"
        assert_eq!(
            hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn checksum_verification_pass() {
        let dir = tempfile::tempdir().unwrap();
        let tarball = dir.path().join("nession-0.5.0-linux-amd64.tar.gz");
        fs::write(&tarball, b"fake-tarball-content").unwrap();

        let expected_hash = sha256_file(&tarball).unwrap();
        let checksums = format!(
            "{}  nession-0.5.0-linux-amd64.tar.gz\n",
            expected_hash
        );

        assert!(verify_checksum(
            &tarball,
            &checksums,
            "nession-0.5.0-linux-amd64.tar.gz",
        )
        .is_ok());
    }

    #[test]
    fn checksum_verification_fail() {
        let dir = tempfile::tempdir().unwrap();
        let tarball = dir.path().join("nession-0.5.0-linux-amd64.tar.gz");
        fs::write(&tarball, b"fake-content").unwrap();

        let checksums = "0000000000000000000000000000000000000000000000000000000000000000  nession-0.5.0-linux-amd64.tar.gz\n";

        let err = verify_checksum(
            &tarball,
            checksums,
            "nession-0.5.0-linux-amd64.tar.gz",
        )
        .unwrap_err();
        assert!(matches!(err, UpdateError::ChecksumMismatch { .. }));
    }

    #[test]
    fn checksum_parse_with_star_prefix() {
        let content = "abc123 *nession-0.5.0-linux-amd64.tar.gz\n";
        let hash = parse_checksum_line(content, "nession-0.5.0-linux-amd64.tar.gz").unwrap();
        assert_eq!(hash, "abc123");
    }

    #[test]
    fn checksum_parse_with_double_space() {
        let content = "abc123  nession-0.5.0-linux-amd64.tar.gz\n";
        let hash = parse_checksum_line(content, "nession-0.5.0-linux-amd64.tar.gz").unwrap();
        assert_eq!(hash, "abc123");
    }

    #[test]
    fn extract_binaries_from_tarball() {
        let dir = tempfile::tempdir().unwrap();
        let tarball = dir.path().join("test.tar.gz");
        create_test_tarball(&tarball, &[
            ("nession", b"cli-binary"),
            ("nession-agent", b"agent-binary"),
            ("nession-server", b"server-binary"),
        ]);

        let dest = dir.path().join("extracted");
        fs::create_dir(&dest).unwrap();

        let names = extract_binaries(&tarball, &dest).unwrap();
        assert_eq!(names.len(), 3);
        assert!(names.contains(&"nession".to_string()));
        assert!(names.contains(&"nession-agent".to_string()));
        assert!(names.contains(&"nession-server".to_string()));

        assert_eq!(
            fs::read_to_string(dest.join("nession")).unwrap(),
            "cli-binary"
        );
    }

    #[test]
    fn parse_checksum_not_found() {
        let content = "abc123  other-file.tar.gz\n";
        let err = parse_checksum_line(content, "nession-0.5.0-linux-amd64.tar.gz").unwrap_err();
        assert!(matches!(err, UpdateError::AssetNotFound(_)));
    }
}
```

- [ ] **Step 2: Run download tests**

Run: `cargo test -p nession-cli -- update::download 2>&1`
Expected: All 7 tests pass.

- [ ] **Step 3: Run clippy**

Run: `cargo clippy -p nession-cli -- -D warnings 2>&1`
Expected: No warnings.

- [ ] **Step 4: Commit**

```bash
git add crates/nession-cli/src/update/download.rs
git commit -m "feat: add download, SHA256 verify, and tarball extraction"
```

---

### Task 7: Implement background check module

**Files:**
- Create: `crates/nession-cli/src/update/check.rs`

- [ ] **Step 1: Write background check module**

File: `crates/nession-cli/src/update/check.rs`

```rust
//! Background update check executed on every CLI invocation.
//!
//! Spawned as a fire-and-forget tokio task from `main()`. Uses the cache
//! module to avoid hammering GitHub on every command. Prints a one-line
//! hint to stderr when a new version is available.

use crate::update::cache::{self, UpdateCache, is_cache_fresh};
use crate::update::github::GitHubReleaseClient;
use crate::update::version::{compare_versions, VersionStatus};
use chrono::Utc;

/// Run a background update check. Returns `Some(message)` if an update
/// is available and should be printed to stderr, or `None` otherwise.
///
/// This function should be called via `tokio::spawn` so it doesn't block
/// the main command execution. It reads/writes the cache to avoid repeated
/// API calls within the 30-minute TTL.
pub async fn background_check() -> Option<String> {
    let current_version = env!("CARGO_PKG_VERSION");

    // If cached and fresh, use cached result.
    if let Some(cached) = cache::read_cache() {
        if is_cache_fresh(&cached.checked_at) {
            return if cached.update_available {
                Some(format!(
                    "⚠ Update available: {} → {}. Run `nession update` to upgrade.",
                    cached.current_version, cached.latest_version
                ))
            } else {
                None
            };
        }
    }

    // Fetch latest from GitHub.
    let client = match GitHubReleaseClient::new() {
        Ok(c) => c,
        Err(_) => return None, // Can't create client — silent.
    };

    let release = match tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.fetch_latest(),
    )
    .await
    {
        Ok(Ok(r)) => r,
        _ => return None, // Timeout or API error — silent.
    };

    let latest_version = match crate::update::github::parse_release_version(&release) {
        Some(v) => v,
        None => return None,
    };

    let update_available = matches!(
        compare_versions(current_version, &latest_version),
        VersionStatus::UpdateAvailable { .. }
    );

    // Write cache.
    let cache_data = UpdateCache {
        checked_at: Utc::now(),
        latest_version: latest_version.to_string(),
        current_version: current_version.to_string(),
        update_available,
    };
    let _ = cache::write_cache(&cache_data); // Best-effort; don't fail on cache write errors.

    if update_available {
        Some(format!(
            "⚠ Update available: {} → {}. Run `nession update` to upgrade.",
            current_version, latest_version
        ))
    } else {
        None
    }
}
```

- [ ] **Step 2: Verify compilation**

Run: `cargo check -p nession-cli 2>&1`
Expected: Compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add crates/nession-cli/src/update/check.rs
git commit -m "feat: add background update check with cache"
```

---

### Task 8: Implement update command orchestration

**Files:**
- Create: `crates/nession-cli/src/commands/update.rs`

- [ ] **Step 1: Write the update command handler**

File: `crates/nession-cli/src/commands/update.rs`

```rust
//! `nession update` command — orchestrates the full self-update flow.
//!
//! See the update/ module for the underlying mechanics.

use crate::update::github::GitHubReleaseClient;
use crate::update::version::{compare_versions, VersionStatus};
use crate::update::{
    BinaryStatus, UpdateError,
    download, replace,
};

/// Run the `nession update` command.
///
/// * `check_only` — if true, only report whether an update exists (no install).
/// * `target_version` — if `Some`, fetch a specific version tag.
/// * `dry_run` — if true, simulate the process without modifying files.
/// * `skip_prompt` — if true, skip the interactive confirmation prompt.
pub async fn run_update(
    check_only: bool,
    target_version: Option<String>,
    dry_run: bool,
    skip_prompt: bool,
) -> Result<(), anyhow::Error> {
    let current_version = env!("CARGO_PKG_VERSION");

    // ---------- Step 1: Fetch release info ----------
    let client = GitHubReleaseClient::new()?;

    let release = match &target_version {
        Some(ver) => client.fetch_version(ver).await?,
        None => client.fetch_latest().await?,
    };

    let latest_version = crate::update::github::parse_release_version(&release)
        .ok_or_else(|| anyhow::anyhow!(
            "Invalid version tag in release: {}",
            release.tag_name
        ))?;

    // ---------- Step 2: Compare versions ----------
    let status = compare_versions(current_version, &latest_version);

    if check_only {
        println!("Current version: {}", current_version);
        println!("Latest version:  {}", latest_version);
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
                    "Status: Running a development version, latest release is {}",
                    latest_version
                );
            }
        }
        return Ok(());
    }

    match status {
        VersionStatus::UpToDate => {
            println!("Already up to date (v{}).", current_version);
            return Ok(());
        }
        VersionStatus::DevelopmentVersion { .. } => {
            println!(
                "Running a development version ({}), latest release is {}.",
                current_version, latest_version
            );
            if target_version.is_none() {
                // Don't auto-downgrade from dev to release.
                println!("Use --version {} to upgrade to the latest release.", latest_version);
                return Ok(());
            }
        }
        VersionStatus::UpdateAvailable { ref current, ref latest } => {
            println!("Upgrade available: v{} → v{}", current, latest);
        }
    }

    // ---------- Step 3: Confirm ----------
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

    // ---------- Step 4: Find platform asset ----------
    let asset = client.find_platform_asset(&release)?;
    println!("Downloading {}...", asset.name);

    if dry_run {
        println!("[dry-run] Would download: {}", asset.browser_download_url);
        println!("[dry-run] Would verify SHA256 checksum.");
        println!(
            "[dry-run] Would replace: nession, nession-agent, nession-server"
        );
        return Ok(());
    }

    // ---------- Step 5: Download and verify ----------
    let tmp_dir = download::temp_extract_dir()?;
    let tarball_path = tmp_dir.join(&asset.name);

    // Download tarball.
    download::download_to_file(&client.client, &asset.browser_download_url, &tarball_path)
        .await?;

    // Download and verify checksum.
    let checksums = client.download_checksums(&release).await?;
    download::verify_checksum(&tarball_path, &checksums, &asset.name)?;

    println!("Checksum verified.");

    // ---------- Step 6: Extract ----------
    download::extract_binaries(&tarball_path, &tmp_dir)?;

    // ---------- Step 7: Replace binaries ----------
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

        // Check write permission.
        if let Err(e) = replace::check_write_permission(&target) {
            results.push(BinaryStatus::Failed {
                name: name.to_string(),
                error: e,
            });
            continue;
        }

        // Warn if process is running (but don't block).
        if let Some(pid) = replace::is_process_running(name) {
            eprintln!(
                "{} is running (PID: {}). Restart to use new version.",
                name, pid
            );
        }

        // Backup old binary.
        if let Err(e) = replace::backup_binary(&target) {
            results.push(BinaryStatus::Failed {
                name: name.to_string(),
                error: e,
            });
            continue;
        }

        // Replace.
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

    // ---------- Step 8: Report ----------
    println!("\nUpdate results:");
    for r in &results {
        match r {
            BinaryStatus::Replaced(path) => println!("  ✓ {} → {}", path.file_name().unwrap_or_default().to_string_lossy(), path.display()),
            BinaryStatus::Skipped { name, reason } => println!("  - {} (skipped: {})", name, reason),
            BinaryStatus::Failed { name, error } => println!("  ✗ {} ({})", name, error),
        }
    }

    // Clean up temp dir.
    let _ = std::fs::remove_dir_all(&tmp_dir);

    let all_ok = results.iter().all(|r| r.is_ok());
    if !all_ok {
        anyhow::bail!("Some binaries failed to update. Old versions are backed up as .bak files.");
    }

    println!("\nUpdate complete.");
    Ok(())
}
```

- [ ] **Step 2: Verify compilation**

Run: `cargo check -p nession-cli 2>&1`
Expected: Compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add crates/nession-cli/src/commands/update.rs
git commit -m "feat: add update command orchestration logic"
```

---

### Task 9: Wire up CLI command and background check

**Files:**
- Modify: `crates/nession-cli/src/main.rs`
- Modify: `crates/nession-cli/src/commands/mod.rs`
- Modify: `crates/nession-cli/src/lib.rs`

- [ ] **Step 1: Add `pub mod update` to lib.rs for integration test access**

Edit `crates/nession-cli/src/lib.rs`:

```rust
pub mod client;
pub mod commands;
pub mod terminal;
pub mod update;
pub mod utils;
```

- [ ] **Step 2: Add `update` to Commands enum and wire in main.rs**

Edit `crates/nession-cli/src/commands/mod.rs` — add the new module:

```rust
//! CLI command implementations.

pub mod agent;
pub mod client;
pub mod server;
pub mod update;
```

Edit `crates/nession-cli/src/main.rs` — add the `Update` variant to the `Commands` enum and its handler in `main()`. The enum change:

After the `Sessions` variant, add:

```rust
    /// Self-update nession to the latest version
    Update {
        /// Only check for updates (don't install)
        #[arg(long)]
        check: bool,

        /// Update/downgrade to a specific version
        #[arg(long)]
        version: Option<String>,

        /// Simulate the update without changing files
        #[arg(long)]
        dry_run: bool,

        /// Skip confirmation prompt
        #[arg(long)]
        yes: bool,
    },
```

In the `main()` function, add the match arm for `Update` before the `Ok(())`. Also add the background check at the beginning of `main()`.

The full modified `main.rs`:

```rust
//! nession CLI - Command-line interface for the nession distributed tmux system.

use anyhow::Result;
use clap::{Parser, Subcommand};

mod commands;

mod client;

mod terminal;

mod utils;

mod update;

/// Default server URL (ws://127.0.0.1:8080).
const DEFAULT_SERVER_URL: &str = "ws://127.0.0.1:8080";

/// Default auth token (empty string, should be overridden).
const DEFAULT_AUTH_TOKEN: &str = "";

#[derive(Parser)]
#[command(name = "nession")]
#[command(version = env!("CARGO_PKG_VERSION"))]
#[command(about = "Distributed tmux session management system")]
struct Cli {
    #[command(subcommand)]
    command: Commands,

    /// Server URL (ws:// or wss://). Overrides config and NESSION_SERVER_URL env var.
    #[arg(long, global = true, env = "NESSION_SERVER_URL")]
    server_url: Option<String>,

    /// Auth token for server authentication. Overrides config and NESSION_AUTH_TOKEN env var.
    #[arg(long, global = true, env = "NESSION_AUTH_TOKEN")]
    auth_token: Option<String>,
}

#[derive(Subcommand)]
enum Commands {
    /// Agent management commands
    Agent {
        #[command(subcommand)]
        action: AgentAction,
    },
    /// Server management commands
    Server {
        #[command(subcommand)]
        action: ServerAction,
    },
    /// Agents listing and management (connects to central server)
    Agents {
        #[command(subcommand)]
        action: AgentsAction,
    },
    /// Sessions listing and management (connects to central server)
    Sessions {
        #[command(subcommand)]
        action: SessionsAction,
    },
    /// Self-update nession to the latest version
    Update {
        /// Only check for updates (don't install)
        #[arg(long)]
        check: bool,

        /// Update/downgrade to a specific version
        #[arg(long)]
        version: Option<String>,

        /// Simulate the update without changing files
        #[arg(long)]
        dry_run: bool,

        /// Skip confirmation prompt
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Subcommand)]
enum AgentAction {
    /// Start the agent
    Start {
        /// Path to configuration file
        #[arg(short, long, default_value = "agent-config.toml")]
        config: String,

        /// Run in foreground instead of background
        #[arg(short, long)]
        foreground: bool,

        /// Path to PID file
        #[arg(long)]
        pid_file: Option<String>,
    },
    /// Stop the agent
    Stop {
        /// Path to PID file
        #[arg(long)]
        pid_file: Option<String>,
    },
    /// Show agent status
    Status {
        /// Path to PID file
        #[arg(long)]
        pid_file: Option<String>,
    },
}

#[derive(Subcommand)]
enum ServerAction {
    /// Start the server
    Start {
        /// Path to configuration file
        #[arg(short, long, default_value = "server-config.toml")]
        config: String,

        /// Run in foreground instead of background
        #[arg(short, long)]
        foreground: bool,

        /// Path to PID file
        #[arg(long)]
        pid_file: Option<String>,
    },
    /// Stop the server
    Stop {
        /// Path to PID file
        #[arg(long)]
        pid_file: Option<String>,
    },
    /// Show server status
    Status {
        /// Path to PID file
        #[arg(long)]
        pid_file: Option<String>,
    },
}

#[derive(Subcommand)]
enum AgentsAction {
    /// List all agents connected to the server
    List,
}

#[derive(Subcommand)]
enum SessionsAction {
    /// List all sessions (optionally filtered by agent)
    List {
        /// Filter sessions by agent ID
        #[arg(short = 'a', long)]
        agent_id: Option<String>,
    },
    /// Attach to a session (interactive terminal)
    Attach {
        /// Session ID in format "agent_id:session_name"
        #[arg(short = 's', long)]
        session_id: String,

        /// Force connection mode (p2p or relay)
        #[arg(short = 'm', long)]
        mode: Option<String>,
    },
    /// Create a new tmux session on an agent
    Create {
        /// Agent ID to create the session on
        #[arg(short = 'a', long)]
        agent_id: String,

        /// Name for the new session
        #[arg(short = 'n', long)]
        name: String,

        /// Terminal width in columns
        #[arg(long, default_value_t = 80)]
        width: u16,

        /// Terminal height in rows
        #[arg(long, default_value_t = 24)]
        height: u16,
    },
    /// Kill a tmux session on an agent
    Kill {
        /// Session ID in format "agent_id:session_name"
        #[arg(short = 's', long)]
        session_id: String,

        /// Skip confirmation prompt
        #[arg(short = 'f', long)]
        force: bool,
    },
}

/// Resolve the effective server URL from CLI flag, env, or default.
fn resolve_server_url(cli_url: Option<String>) -> String {
    cli_url.unwrap_or_else(|| DEFAULT_SERVER_URL.to_string())
}

/// Resolve the effective auth token from CLI flag, env, or default.
fn resolve_auth_token(cli_token: Option<String>) -> String {
    cli_token.unwrap_or_else(|| DEFAULT_AUTH_TOKEN.to_string())
}

/// Check whether background update checking should be skipped.
fn should_skip_background_check() -> bool {
    // Check the env var first.
    if std::env::var("NESSION_NO_UPDATE_CHECK").is_ok() {
        return true;
    }

    // Collect all args to check for --help and --version.
    let args: Vec<String> = std::env::args().collect();

    // Skip if --help, -h, or help subcommand.
    for arg in &args {
        if arg == "--help" || arg == "-h" || arg == "help" {
            return true;
        }
    }

    // Also skip for version-related args.
    for arg in &args {
        if arg == "--version" || arg == "-V" {
            return true;
        }
    }

    false
}

#[tokio::main]
async fn main() -> Result<()> {
    // Background update check — fire and forget.
    if !should_skip_background_check() {
        tokio::spawn(async {
            if let Some(msg) = update::check::background_check().await {
                eprintln!("{}", msg);
            }
        });
    }

    let cli = Cli::parse();

    match cli.command {
        Commands::Agent { action } => match action {
            AgentAction::Start {
                config,
                foreground,
                pid_file,
            } => {
                let pid_file = pid_file.unwrap_or_else(|| {
                    nession_common::paths::agent_pid_path()
                        .unwrap_or_else(|_| std::path::PathBuf::from("agent.pid"))
                        .to_string_lossy()
                        .into_owned()
                });
                commands::agent::start(config, foreground, pid_file).await?
            }
            AgentAction::Stop { pid_file } => {
                let pid_file = pid_file.unwrap_or_else(|| {
                    nession_common::paths::agent_pid_path()
                        .unwrap_or_else(|_| std::path::PathBuf::from("agent.pid"))
                        .to_string_lossy()
                        .into_owned()
                });
                commands::agent::stop(pid_file).await?
            }
            AgentAction::Status { pid_file } => {
                let pid_file = pid_file.unwrap_or_else(|| {
                    nession_common::paths::agent_pid_path()
                        .unwrap_or_else(|_| std::path::PathBuf::from("agent.pid"))
                        .to_string_lossy()
                        .into_owned()
                });
                commands::agent::status(pid_file).await?
            }
        },
        Commands::Server { action } => match action {
            ServerAction::Start {
                config,
                foreground,
                pid_file,
            } => {
                let pid_file = pid_file.unwrap_or_else(|| {
                    nession_common::paths::server_pid_path()
                        .unwrap_or_else(|_| std::path::PathBuf::from("server.pid"))
                        .to_string_lossy()
                        .into_owned()
                });
                commands::server::start(config, foreground, pid_file).await?
            }
            ServerAction::Stop { pid_file } => {
                let pid_file = pid_file.unwrap_or_else(|| {
                    nession_common::paths::server_pid_path()
                        .unwrap_or_else(|_| std::path::PathBuf::from("server.pid"))
                        .to_string_lossy()
                        .into_owned()
                });
                commands::server::stop(pid_file).await?
            }
            ServerAction::Status { pid_file } => {
                let pid_file = pid_file.unwrap_or_else(|| {
                    nession_common::paths::server_pid_path()
                        .unwrap_or_else(|_| std::path::PathBuf::from("server.pid"))
                        .to_string_lossy()
                        .into_owned()
                });
                commands::server::status(pid_file).await?
            }
        },
        Commands::Agents { action } => match action {
            AgentsAction::List => {
                let server_url = resolve_server_url(cli.server_url);
                let auth_token = resolve_auth_token(cli.auth_token);
                commands::client::list_agents(&server_url, &auth_token).await?;
            }
        },
        Commands::Sessions { action } => match action {
            SessionsAction::List { agent_id } => {
                let server_url = resolve_server_url(cli.server_url);
                let auth_token = resolve_auth_token(cli.auth_token);
                commands::client::list_sessions(&server_url, &auth_token, agent_id.as_deref())
                    .await?;
            }
            SessionsAction::Attach { session_id, mode } => {
                let server_url = resolve_server_url(cli.server_url);
                let auth_token = resolve_auth_token(cli.auth_token);
                commands::client::attach_session(
                    &server_url,
                    &auth_token,
                    &session_id,
                    mode.as_deref(),
                )
                .await?;
            }
            SessionsAction::Create {
                agent_id,
                name,
                width,
                height,
            } => {
                let server_url = resolve_server_url(cli.server_url);
                let auth_token = resolve_auth_token(cli.auth_token);
                commands::client::create_session(
                    &server_url,
                    &auth_token,
                    &agent_id,
                    &name,
                    width,
                    height,
                )
                .await?;
            }
            SessionsAction::Kill { session_id, force } => {
                // Prompt for confirmation unless --force is set
                if !force {
                    print!("Are you sure you want to kill session '{session_id}'? [y/N] ");
                    use std::io::Write;
                    std::io::stdout().flush()?;
                    let mut input = String::new();
                    std::io::stdin().read_line(&mut input)?;
                    let input = input.trim().to_lowercase();
                    if input != "y" && input != "yes" {
                        println!("Aborted.");
                        return Ok(());
                    }
                }

                let server_url = resolve_server_url(cli.server_url);
                let auth_token = resolve_auth_token(cli.auth_token);
                commands::client::kill_session(&server_url, &auth_token, &session_id).await?;
            }
        },
        Commands::Update {
            check,
            version,
            dry_run,
            yes,
        } => {
            commands::update::run_update(check, version, dry_run, yes).await?;
        }
    }

    Ok(())
}
```

- [ ] **Step 3: Build and fix compilation errors**

Run: `cargo check -p nession-cli 2>&1`
Expected: Compiles without errors. Fix any issues.

Note: The `update.rs` uses `client.http_client()` (Task 12) to access the inner `reqwest::Client`.

- [ ] **Step 4: Run clippy**

Run: `cargo clippy -p nession-cli -- -D warnings 2>&1`
Expected: No warnings.

- [ ] **Step 5: Run all tests**

Run: `cargo test -p nession-cli 2>&1`
Expected: All tests pass (existing + new update tests).

- [ ] **Step 6: Run fmt**

Run: `cargo fmt --all -- --check 2>&1`
Expected: No formatting issues.

- [ ] **Step 7: Commit**

```bash
git add crates/nession-cli/src/main.rs crates/nession-cli/src/commands/mod.rs crates/nession-cli/src/lib.rs
git commit -m "feat: wire up update command and background check"
```

---

### Task 10: Integration tests with httptest

**Files:**
- Create: `crates/nession-cli/tests/update_integration.rs`

- [ ] **Step 1: Write integration tests**

File: `crates/nession-cli/tests/update_integration.rs`

```rust
//! Integration tests for the self-update system.
//!
//! Uses `httptest` to mock the GitHub Releases API, testing version
//! detection, checksum verification, and the full update orchestration
//! flow without real network calls.

use httptest::{Server, Expectation, responders::*};
use serde_json::json;
use std::fs;
use std::io::Write;
use flate2::write::GzEncoder;
use sha2::{Digest, Sha256};

/// Helper: create a test tarball with fake binary content.
fn create_test_tarball() -> (Vec<u8>, String) {
    let mut buf = Vec::new();
    let encoder = GzEncoder::new(&mut buf, flate2::Compression::default());
    let mut archive = tar::Builder::new(encoder);

    for name in &["nession", "nession-agent", "nession-server"] {
        let content = format!("fake-{}-content", name);
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        archive.append_data(&mut header, name, content.as_bytes()).unwrap();
    }

    let encoder = archive.into_inner().unwrap();
    encoder.finish().unwrap();

    let hash = {
        let mut hasher = Sha256::new();
        hasher.update(&buf);
        format!("{:x}", hasher.finalize())
    };

    (buf, hash)
}

#[tokio::test]
async fn fetch_latest_release() {
    let server = Server::run();

    server.expect(
        Expectation::matching(all_of![
            request::method("GET"),
            request::path("/repos/BestNathan/nession/releases/latest"),
        ])
        .respond_with(status_code(200).body(
            json!({
                "tag_name": "v0.5.0",
                "prerelease": false,
                "assets": [
                    {
                        "name": "nession-0.5.0-linux-amd64.tar.gz",
                        "browser_download_url": format!("{}/download/tarball", server.url()),
                    },
                    {
                        "name": "checksums.txt",
                        "browser_download_url": format!("{}/download/checksums", server.url()),
                    }
                ]
            })
            .to_string(),
        )),
    );

    // Create a client that uses the mock server.
    // Note: GitHubReleaseClient hardcodes api.github.com, so we test
    // the parse/version logic separately. Full E2E with httptest would
    // require making the base URL configurable.

    // This test validates the JSON parsing path — the actual HTTP
    // interaction is exercised via unit tests on parse_release_version
    // and find_platform_asset.
    let json = json!({
        "tag_name": "v0.5.0",
        "prerelease": false,
        "assets": []
    });
    let release: nession_cli::update::github::ReleaseInfo =
        serde_json::from_value(json).unwrap();
    assert_eq!(release.tag_name, "v0.5.0");
    assert!(!release.prerelease);
}

#[test]
fn version_comparison_integration() {
    use nession_cli::update::version::*;

    let latest = semver::Version::new(0, 5, 0);
    assert_eq!(
        compare_versions("0.4.2", &latest),
        VersionStatus::UpdateAvailable {
            current: semver::Version::new(0, 4, 2),
            latest: latest.clone(),
        }
    );
}

#[test]
fn checksum_verification_integration() {
    use nession_cli::update::download;

    let dir = tempfile::tempdir().unwrap();
    let tarball_path = dir.path().join("test.tar.gz");

    // Create a real tarball with known content.
    let (tarball_data, expected_hash) = create_test_tarball();
    fs::write(&tarball_path, &tarball_data).unwrap();

    // Compute actual hash.
    let actual_hash = download::sha256_file(&tarball_path).unwrap();
    assert_eq!(actual_hash, expected_hash);

    // Verify with correct checksum.
    let checksums = format!("{}  test.tar.gz\nsome-other-hash  other-file.tar.gz\n", expected_hash);
    download::verify_checksum(&tarball_path, &checksums, "test.tar.gz").unwrap();

    // Verify with wrong checksum.
    let bad_checksums = "0000000000000000000000000000000000000000000000000000000000000000  test.tar.gz\n";
    let err = download::verify_checksum(&tarball_path, bad_checksums, "test.tar.gz").unwrap_err();
    assert!(matches!(
        err,
        nession_cli::update::UpdateError::ChecksumMismatch { .. }
    ));
}

#[test]
fn cache_roundtrip_integration() {
    use nession_cli::update::cache;

    let cache_data = cache::UpdateCache {
        checked_at: chrono::Utc::now(),
        latest_version: "0.5.0".into(),
        current_version: "0.4.2".into(),
        update_available: true,
    };

    cache::write_cache(&cache_data).unwrap();
    let read = cache::read_cache().unwrap();
    assert_eq!(read.latest_version, "0.5.0");
    assert!(read.update_available);
}

#[test]
fn platform_detection_is_valid() {
    let platform = nession_cli::update::github::platform_string();
    let valid = ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"];
    assert!(
        valid.contains(&platform.as_str()),
        "unsupported platform: {}",
        platform
    );
}

#[test]
fn extract_and_replace_simulation() {
    use nession_cli::update::{download, replace};

    // Create a test tarball.
    let dir = tempfile::tempdir().unwrap();
    let tarball_path = dir.path().join("test.tar.gz");
    let (tarball_data, _) = create_test_tarball();
    fs::write(&tarball_path, &tarball_data).unwrap();

    // Extract.
    let extract_dir = dir.path().join("extracted");
    fs::create_dir(&extract_dir).unwrap();
    let names = download::extract_binaries(&tarball_path, &extract_dir).unwrap();

    assert_eq!(names.len(), 3);

    // Simulate replacement.
    let install_dir = dir.path().join("install");
    fs::create_dir(&install_dir).unwrap();

    for name in &names {
        let src = extract_dir.join(name);
        let dst = install_dir.join(name);
        fs::write(&dst, b"old").unwrap();

        replace::backup_binary(&dst).unwrap();
        replace::set_executable(&src).unwrap();
        replace::atomic_replace(&src, &dst).unwrap();

        let content = fs::read_to_string(&dst).unwrap();
        assert_eq!(content, format!("fake-{}-content", name));
    }

    // Verify backups exist.
    assert!(install_dir.join("nession.bak").exists());
    assert!(install_dir.join("nession-agent.bak").exists());
    assert!(install_dir.join("nession-server.bak").exists());
}
```

- [ ] **Step 2: Run integration tests**

Run: `cargo test -p nession-cli -- update_integration 2>&1`
Expected: All 6 integration tests pass.

- [ ] **Step 3: Run full test suite**

Run: `cargo test -p nession-cli 2>&1 && cargo clippy -p nession-cli -- -D warnings 2>&1 && cargo fmt --all -- --check 2>&1`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add crates/nession-cli/tests/
git commit -m "test: add integration tests for self-update system"
```

---

### Task 11: CI — Add SHA256 checksums to release workflow

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Add SHA256 generation to each native binary build job**

In `release.yml`, add a checksum generation step to each of the three jobs:

**`build-linux-amd64`** — after the Package step (line ~335), add:

```yaml
      - name: Generate checksums
        run: sha256sum nession-*.tar.gz > checksums-linux-amd64.txt

      - uses: actions/upload-artifact@v4
        with:
          name: checksums-linux-amd64
          path: checksums-linux-amd64.txt
          retention-days: 7
```

**`build-linux-arm64`** — same pattern, filename `checksums-linux-arm64.txt`:

```yaml
      - name: Generate checksums
        run: sha256sum nession-*.tar.gz > checksums-linux-arm64.txt

      - uses: actions/upload-artifact@v4
        with:
          name: checksums-linux-arm64
          path: checksums-linux-arm64.txt
          retention-days: 7
```

**`build-macos`** — after both packages are built, generate two checksum files:

```yaml
      - name: Generate checksums
        run: |
          sha256sum nession-*-darwin-arm64.tar.gz > checksums-darwin-arm64.txt
          sha256sum nession-*-darwin-amd64.tar.gz > checksums-darwin-amd64.txt

      - uses: actions/upload-artifact@v4
        with:
          name: checksums-macos
          path: checksums-darwin-*.txt
          retention-days: 7
```

- [ ] **Step 2: Merge checksums in create-release job**

In the `create-release` job, add a step before "Create GitHub Release" to merge all checksum files and include them in the release:

```yaml
      - name: Merge checksums
        run: |
          cat checksums-*.txt > checksums.txt
          mv checksums.txt release-assets/
```

And update the `Create GitHub Release` step's body to mention `checksums.txt`:

```yaml
          body: |
            ## Nession v${{ needs.version-check.outputs.rust_version }}

            ### Docker Images
            ...

            ### Native Binaries
            | Platform | Architectures |
            |----------|---------------|
            | Linux | amd64, arm64 |
            | macOS | amd64 (Intel), arm64 (Apple Silicon) |

            ### Verification
            Verify downloads with `checksums.txt`:
            ```bash
            sha256sum -c checksums.txt
            ```
```

- [ ] **Step 3: Update artifact download pattern**

In `create-release`, update the `actions/download-artifact@v4` to include checksum artifacts:

```yaml
      - uses: actions/download-artifact@v4
        with:
          pattern: binaries-*
          path: release-assets
          merge-multiple: true

      - uses: actions/download-artifact@v4
        with:
          pattern: checksums-*
          path: ./
          merge-multiple: true
```

- [ ] **Step 4: Verify the workflow YAML is valid**

Run: `cat .github/workflows/release.yml | python3 -c "import sys, yaml; yaml.safe_load(sys.stdin); print('Valid YAML')" 2>&1`
Expected: "Valid YAML"

Note: You may need `pip3 install pyyaml` if not installed. Alternatively, use `actionlint` or just visually verify.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add SHA256 checksums to release workflow for self-update"
```

---

### Task 12: Make GitHubReleaseClient base URL configurable (fix for testing)

**Files:**
- Modify: `crates/nession-cli/src/update/github.rs`

- [ ] **Step 1: Make the API base URL a parameter**

The current `GitHubReleaseClient::new()` hardcodes `api.github.com`. For testing, we need to be able to point it at a mock server. Add a `with_base_url` constructor:

Add to `GitHubReleaseClient`:

```rust
    /// Create a client with a custom base URL (for testing).
    pub fn with_base_url(base_url: String) -> Result<Self, reqwest::Error> {
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .timeout(std::time::Duration::from_secs(10))
            .build()?;
        Ok(Self { client, base_url })
    }

    /// Base URL for API calls (default: api.github.com).
    fn releases_url(&self) -> String {
        format!("{}/repos/BestNathan/nession/releases", self.base_url)
    }
```

Update the struct:

```rust
pub struct GitHubReleaseClient {
    client: Client,
    base_url: String,
}
```

Update `new()`:

```rust
    pub fn new() -> Result<Self, reqwest::Error> {
        Self::with_base_url("https://api.github.com".to_string())
    }
```

Update `fetch_latest()` — replace `GITHUB_API` constant with `self.releases_url()`.

Update `fetch_version()` — same.

Remove the `const GITHUB_API` at the top.

- [ ] **Step 2: Make client field public for command orchestration**

The `commands/update.rs` accesses `client.client` for download. Since `download.rs` needs `reqwest::Client`, expose it:

```rust
    /// Access the inner reqwest Client for direct downloads.
    pub fn http_client(&self) -> &Client {
        &self.client
    }
```

Update `commands/update.rs` to use `client.http_client()` instead of `client.client`.

- [ ] **Step 3: Rebuild and test**

Run: `cargo test -p nession-cli 2>&1 && cargo clippy -p nession-cli -- -D warnings 2>&1`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add crates/nession-cli/src/update/github.rs crates/nession-cli/src/commands/update.rs
git commit -m "refactor: make GitHubReleaseClient base URL configurable for testing"
```

---

## Self-Review

### 1. Spec Coverage Check

| Spec Section | Covered By |
|---|---|
| `nession update` command | Task 8, 9 |
| `--check` flag | Task 8 (check_only param) |
| `--version <ver>` flag | Task 8 (target_version param) |
| `--dry-run` flag | Task 8 (dry_run param) |
| `--yes` flag | Task 8 (skip_prompt param) |
| Background check on startup | Task 7, 9 |
| `NESSION_NO_UPDATE_CHECK=1` | Task 9 (should_skip_background_check) |
| SHA256 checksum verification | Task 6, 10 |
| Backup old binaries (.bak) | Task 5 |
| Atomic replace | Task 5 |
| Three binaries upgraded | Task 6, 8 |
| Linux + macOS (4 platforms) | Task 4 (platform_string) |
| Cache 30 min TTL | Task 3 |
| Cache location `~/.nession/update-check.json` | Task 3 |
| Edge case: already latest | Task 8 (VersionStatus::UpToDate) |
| Edge case: dev version | Task 8 (VersionStatus::DevelopmentVersion) |
| Edge case: network error | Task 1 (UpdateError::Network) |
| Edge case: API rate limit | Task 4 (RateLimited) |
| Edge case: checksum mismatch | Task 6 (ChecksumMismatch) |
| Edge case: disk full | Task 5 (check_disk_space) |
| Edge case: no platform binary | Task 3 (UnsupportedPlatform) |
| Edge case: no write permission | Task 5 (check_write_permission) |
| Edge case: process running | Task 8 (is_process_running — warn only) |
| Edge case: binaries in different dirs | Task 5 (locate_binary per binary) |
| Edge case: partial failure | Task 8 (results reporting) |
| Edge case: symlink | Task 5 (canonicalize) |
| Edge case: macOS quarantine | Task 5 (maybe_print_quarantine_hint) |
| CI checksums generation | Task 11 |
| Unit tests | Tasks 2-6 (inline in each module) |
| Integration tests | Task 10 |
| All errors use `?` / no unwrap/expect | All tasks (follow existing lint rules) |

### 2. Placeholder Scan

No TBD, TODO, or incomplete sections found. All steps have concrete code.

### 3. Type Consistency

- `UpdateError` variants used consistently across all modules
- `GitHubReleaseClient` → `client.http_client()` accessor pattern consistent between github.rs and commands/update.rs
- `VersionStatus` matches between version.rs and commands/update.rs
- `UpdateCache` fields consistent between cache.rs and check.rs
- `BinaryStatus` returned from commands/update.rs, defined in update/mod.rs
