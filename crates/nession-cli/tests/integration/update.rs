use flate2::write::GzEncoder;
use httptest::matchers::request;
use httptest::{responders::status_code, Expectation, Server};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;

fn create_test_tarball() -> anyhow::Result<(Vec<u8>, String)> {
    let mut buf = Vec::new();
    let encoder = GzEncoder::new(&mut buf, flate2::Compression::default());
    let mut archive = tar::Builder::new(encoder);
    for name in &["nession", "nession-agent", "nession-server"] {
        let content = format!("fake-{name}-content");
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        archive.append_data(&mut header, name, content.as_bytes())?;
    }
    let encoder = archive.into_inner()?;
    encoder.finish()?;
    let hash = {
        let mut hasher = Sha256::new();
        hasher.update(&buf);
        format!("{:x}", hasher.finalize())
    };
    Ok((buf, hash))
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
    assert_eq!(compare_versions("0.5.0", &latest), VersionStatus::UpToDate);
}

#[test]
fn checksum_verification_integration() {
    use nession_cli::update::download;
    let dir = tempfile::tempdir().unwrap();
    let tarball_path = dir.path().join("test.tar.gz");
    let (tarball_data, expected_hash) = create_test_tarball().unwrap();
    fs::write(&tarball_path, &tarball_data).unwrap();
    let actual_hash = download::sha256_file(&tarball_path).unwrap();
    assert_eq!(actual_hash, expected_hash);
    let checksums = format!("{expected_hash}  test.tar.gz\n");
    download::verify_checksum(&tarball_path, &checksums, "test.tar.gz").unwrap();
}

#[test]
fn checksum_mismatch_detected() {
    use nession_cli::update::download;
    let dir = tempfile::tempdir().unwrap();
    let tarball_path = dir.path().join("test.tar.gz");
    fs::write(&tarball_path, b"content").unwrap();
    let bad = "0000000000000000000000000000000000000000000000000000000000000000  test.tar.gz\n";
    let err = download::verify_checksum(&tarball_path, bad, "test.tar.gz").unwrap_err();
    assert!(matches!(
        err,
        nession_cli::update::UpdateError::ChecksumMismatch { .. }
    ));
}

#[test]
fn platform_detection_is_valid() {
    let platform = nession_cli::update::github::platform_string();
    let valid = ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"];
    assert!(
        valid.contains(&platform.as_str()),
        "unsupported platform: {platform}",
    );
}

#[test]
fn extract_and_replace_simulation() {
    use nession_cli::update::{download, replace};
    let dir = tempfile::tempdir().unwrap();
    let tarball_path = dir.path().join("test.tar.gz");
    let (tarball_data, _) = create_test_tarball().unwrap();
    fs::write(&tarball_path, &tarball_data).unwrap();
    let extract_dir = dir.path().join("extracted");
    fs::create_dir(&extract_dir).unwrap();
    let names = download::extract_binaries(&tarball_path, &extract_dir).unwrap();
    assert_eq!(names.len(), 3);
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
        assert_eq!(content, format!("fake-{name}-content"));
    }
    assert!(install_dir.join("nession.bak").exists());
}

// ── httptest-based integration tests for async HTTP methods ──

#[tokio::test]
async fn fetch_latest_with_mock_server() {
    use nession_cli::update::github::GitHubReleaseClient;

    let server = Server::run();
    let mock_json = json!({
        "tag_name": "v0.5.0",
        "prerelease": false,
        "assets": [
            {
                "name": "nession-0.5.0-linux-amd64.tar.gz",
                "browser_download_url": format!("{}/download/tarball", server.url("/")),
            },
            {
                "name": "checksums.txt",
                "browser_download_url": format!("{}/download/checksums", server.url("/")),
            }
        ]
    });

    server.expect(
        Expectation::matching(request::method("GET"))
            .respond_with(status_code(200).body(mock_json.to_string())),
    );

    let client = GitHubReleaseClient::with_base_url(server.url("/").to_string()).unwrap();
    let release = client.fetch_latest().await.unwrap();

    assert_eq!(release.tag_name, "v0.5.0");
    assert!(!release.prerelease);
    assert_eq!(release.assets.len(), 2);
}

#[tokio::test]
async fn fetch_latest_rate_limited() {
    use nession_cli::update::github::GitHubReleaseClient;
    use nession_cli::update::UpdateError;

    let server = Server::run();
    server.expect(Expectation::matching(request::method("GET")).respond_with(status_code(429)));

    let client = GitHubReleaseClient::with_base_url(server.url("/").to_string()).unwrap();
    let err = client.fetch_latest().await.unwrap_err();
    assert!(matches!(err, UpdateError::RateLimited));
}

#[tokio::test]
async fn fetch_version_with_mock_server() {
    use nession_cli::update::github::GitHubReleaseClient;

    let server = Server::run();
    server.expect(
        Expectation::matching(request::method("GET")).respond_with(
            status_code(200).body(
                json!({
                    "tag_name": "v0.3.5",
                    "prerelease": false,
                    "assets": []
                })
                .to_string(),
            ),
        ),
    );

    let client = GitHubReleaseClient::with_base_url(server.url("/").to_string()).unwrap();
    let release = client.fetch_version("0.3.5").await.unwrap();
    assert_eq!(release.tag_name, "v0.3.5");
}

#[tokio::test]
async fn fetch_version_not_found() {
    use nession_cli::update::github::GitHubReleaseClient;
    use nession_cli::update::UpdateError;

    let server = Server::run();
    server.expect(Expectation::matching(request::method("GET")).respond_with(status_code(404)));

    let client = GitHubReleaseClient::with_base_url(server.url("/").to_string()).unwrap();
    let err = client.fetch_version("99.99.99").await.unwrap_err();
    assert!(matches!(err, UpdateError::ReleaseNotFound(_)));
}

#[tokio::test]
async fn download_checksums_with_mock_server() {
    use nession_cli::update::github::{AssetInfo, GitHubReleaseClient, ReleaseInfo};

    let server = Server::run();
    let checksum_content = "abc123  nession-0.5.0-linux-amd64.tar.gz\n";

    server.expect(
        Expectation::matching(request::method("GET"))
            .respond_with(status_code(200).body(checksum_content)),
    );

    let client = GitHubReleaseClient::with_base_url(server.url("/").to_string()).unwrap();
    let release = ReleaseInfo {
        tag_name: "v0.5.0".into(),
        prerelease: false,
        assets: vec![AssetInfo {
            name: "checksums.txt".into(),
            browser_download_url: server.url("/").to_string(),
        }],
    };

    let result = client.download_checksums(&release).await.unwrap();
    assert_eq!(result, checksum_content);
}

#[tokio::test]
async fn download_to_file_with_mock_server() {
    use nession_cli::update::download;

    let server = Server::run();
    let file_content = b"fake-tarball-bytes";

    server.expect(
        Expectation::matching(request::method("GET"))
            .respond_with(status_code(200).body(file_content.to_vec())),
    );

    let reqwest_client = reqwest::Client::new();
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("downloaded.tar.gz");

    let bytes = download::download_to_file(&reqwest_client, &server.url("/").to_string(), &dest)
        .await
        .unwrap();

    assert_eq!(bytes, file_content.len() as u64);
    assert_eq!(fs::read(&dest).unwrap(), file_content);
}

#[tokio::test]
async fn background_check_all_scenarios() {
    use chrono::{Duration, Utc};
    use nession_cli::update::cache::{self, UpdateCache};

    // Point NESSION_HOME at a temp dir before touching the cache. Without it
    // `nession_home()` resolves to $HOME/.nession, so this test deleted and
    // overwrote the developer's real update-check.json — and two concurrent
    // runs overwrote each other's, which is how the concurrency check caught it.
    let home = tempfile::tempdir().unwrap();
    std::env::set_var(nession_common::paths::NESSION_HOME_ENV, home.path());

    let cache_path = nession_common::paths::nession_home()
        .unwrap()
        .join("update-check.json");
    let _ = std::fs::remove_file(&cache_path);

    // Scenario 1: Fresh cache with update available
    cache::write_cache(&UpdateCache {
        checked_at: Utc::now(),
        latest_version: "0.5.0".into(),
        current_version: "0.4.2".into(),
        update_available: true,
    })
    .unwrap();
    let msg = nession_cli::update::check::background_check()
        .await
        .expect("fresh cache should return update message");
    assert!(msg.contains("Update available"));
    assert!(msg.contains("0.5.0"));

    // Scenario 2: Stale cache, network failure → returns None
    // Use an invalid URL to simulate network failure (connection refused)
    std::env::set_var("NESSION_UPDATE_API_URL", "http://127.0.0.1:1");
    cache::write_cache(&UpdateCache {
        checked_at: Utc::now() - Duration::minutes(60),
        latest_version: "0.6.0".into(),
        current_version: "0.4.2".into(),
        update_available: true,
    })
    .unwrap();
    assert!(
        nession_cli::update::check::background_check()
            .await
            .is_none(),
        "stale cache + network failure should return None"
    );
    std::env::remove_var("NESSION_UPDATE_API_URL");

    // Scenario 3: Mock API, stale cache → fetches latest
    let server = Server::run();
    server.expect(
        Expectation::matching(request::method("GET")).respond_with(
            status_code(200)
                .body(json!({"tag_name":"v99.99.99","prerelease":false,"assets":[]}).to_string()),
        ),
    );
    cache::write_cache(&UpdateCache {
        checked_at: Utc::now() - Duration::minutes(60),
        latest_version: "0.1.0".into(),
        current_version: "0.4.2".into(),
        update_available: false,
    })
    .unwrap();
    // Trim trailing slash so releases_url() appends cleanly.
    let api_url = server.url("/").to_string();
    let api_url = api_url.strip_suffix('/').unwrap_or(&api_url);
    std::env::set_var("NESSION_UPDATE_API_URL", api_url);
    let msg = nession_cli::update::check::background_check()
        .await
        .expect("mock API should return update available");
    std::env::remove_var("NESSION_UPDATE_API_URL");
    assert!(msg.contains("Update available"));
    assert!(msg.contains("99.99.99"));

    // Scenario 4: Fresh cache with no update → returns None
    cache::write_cache(&UpdateCache {
        checked_at: Utc::now(),
        latest_version: "0.4.2".into(),
        current_version: "0.4.2".into(),
        update_available: false,
    })
    .unwrap();
    assert!(
        nession_cli::update::check::background_check()
            .await
            .is_none(),
        "fresh cache with no update should return None"
    );

    let _ = std::fs::remove_file(&cache_path);
}

#[tokio::test]
async fn download_to_file_error_status() {
    use nession_cli::update::download;
    use nession_cli::update::UpdateError;

    let server = Server::run();
    server.expect(Expectation::matching(request::method("GET")).respond_with(status_code(500)));

    let reqwest_client = reqwest::Client::new();
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("error.tar.gz");

    let err = download::download_to_file(&reqwest_client, &server.url("/").to_string(), &dest)
        .await
        .unwrap_err();
    assert!(matches!(err, UpdateError::Network(_)));
}

#[tokio::test]
async fn fetch_latest_server_error() {
    use nession_cli::update::github::GitHubReleaseClient;
    use nession_cli::update::UpdateError;

    let server = Server::run();
    server.expect(Expectation::matching(request::method("GET")).respond_with(status_code(500)));

    let client = GitHubReleaseClient::with_base_url(server.url("/").to_string()).unwrap();
    let err = client.fetch_latest().await.unwrap_err();
    assert!(matches!(err, UpdateError::Network(_)));
}

#[tokio::test]
async fn download_checksums_http_error() {
    use nession_cli::update::github::{AssetInfo, GitHubReleaseClient, ReleaseInfo};
    use nession_cli::update::UpdateError;

    let server = Server::run();
    server.expect(Expectation::matching(request::method("GET")).respond_with(status_code(500)));

    let client = GitHubReleaseClient::with_base_url(server.url("/").to_string()).unwrap();
    let release = ReleaseInfo {
        tag_name: "v0.5.0".into(),
        prerelease: false,
        assets: vec![AssetInfo {
            name: "checksums.txt".into(),
            browser_download_url: server.url("/").to_string(),
        }],
    };

    let err = client.download_checksums(&release).await.unwrap_err();
    assert!(matches!(err, UpdateError::Network(_)));
}

#[tokio::test]
async fn fetch_latest_403_rate_limited() {
    use nession_cli::update::github::GitHubReleaseClient;
    use nession_cli::update::UpdateError;

    let server = Server::run();
    server.expect(Expectation::matching(request::method("GET")).respond_with(status_code(403)));

    let client = GitHubReleaseClient::with_base_url(server.url("/").to_string()).unwrap();
    let err = client.fetch_latest().await.unwrap_err();
    assert!(matches!(err, UpdateError::RateLimited));
}
