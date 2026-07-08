use flate2::write::GzEncoder;
use sha2::{Digest, Sha256};
use std::fs;

fn create_test_tarball() -> (Vec<u8>, String) {
    let mut buf = Vec::new();
    let encoder = GzEncoder::new(&mut buf, flate2::Compression::default());
    let mut archive = tar::Builder::new(encoder);
    for name in &["nession", "nession-agent", "nession-server"] {
        let content = format!("fake-{name}-content");
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        archive
            .append_data(&mut header, name, content.as_bytes())
            .unwrap();
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
    let (tarball_data, expected_hash) = create_test_tarball();
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
    // Clean up
    let _ = std::fs::remove_file(
        nession_common::paths::nession_home()
            .unwrap()
            .join("update-check.json"),
    );
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
    let (tarball_data, _) = create_test_tarball();
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
