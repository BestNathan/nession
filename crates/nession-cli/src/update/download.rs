//! Download, SHA256 verification, and tarball extraction.

use crate::update::UpdateError;
use flate2::read::GzDecoder;
use reqwest::Client;
use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub async fn download_to_file(client: &Client, url: &str, dest: &Path) -> Result<u64, UpdateError> {
    let resp = client.get(url).send().await?;

    if !resp.status().is_success() {
        return Err(UpdateError::Network(format!(
            "Download failed: HTTP {}",
            resp.status()
        )));
    }

    let bytes = resp.bytes().await?;
    fs::write(dest, &bytes).map_err(UpdateError::Io)?;
    Ok(bytes.len() as u64)
}

pub fn sha256_file(path: &Path) -> Result<String, UpdateError> {
    let mut file = fs::File::open(path).map_err(UpdateError::Io)?;
    let mut hasher = Sha256::new();
    io::copy(&mut file, &mut hasher).map_err(UpdateError::Io)?;
    let hash = hasher.finalize();
    Ok(format!("{hash:x}"))
}

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

fn parse_checksum_line(checksums_content: &str, filename: &str) -> Result<String, UpdateError> {
    for line in checksums_content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let (hash, name_part) = line
            .split_once("  ")
            .or_else(|| line.split_once(" *"))
            .or_else(|| line.split_once('\t'))
            .ok_or_else(|| {
                UpdateError::ExtractionFailed(format!("invalid checksum line: '{line}'"))
            })?;
        let name_part = name_part.trim();
        if name_part == filename {
            return Ok(hash.trim().to_string());
        }
    }
    Err(UpdateError::AssetNotFound(format!(
        "checksum entry for '{filename}' not found in checksums.txt",
    )))
}

pub fn extract_binaries(tarball_path: &Path, dest_dir: &Path) -> Result<Vec<String>, UpdateError> {
    let file = fs::File::open(tarball_path).map_err(UpdateError::Io)?;
    let decoder = GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);

    let expected = ["nession", "nession-agent", "nession-server"];
    let mut extracted = Vec::new();

    for entry in archive
        .entries()
        .map_err(|e| UpdateError::ExtractionFailed(format!("cannot read archive: {e}")))?
    {
        let mut entry =
            entry.map_err(|e| UpdateError::ExtractionFailed(format!("cannot read entry: {e}")))?;

        let path = entry
            .path()
            .map_err(|e| UpdateError::ExtractionFailed(format!("cannot get entry path: {e}")))?;

        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        if expected.contains(&name.as_str()) {
            entry.unpack_in(dest_dir).map_err(|e| {
                UpdateError::ExtractionFailed(format!("cannot extract {name}: {e}"))
            })?;
            extracted.push(name);
        }
    }

    Ok(extracted)
}

pub fn temp_extract_dir() -> Result<PathBuf, UpdateError> {
    let dir = std::env::temp_dir().join(format!("nession-update-{}", std::process::id()));
    fs::create_dir_all(&dir).map_err(UpdateError::Io)?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;

    fn create_test_tarball(path: &Path, files: &[(&str, &[u8])]) {
        let file = fs::File::create(path).unwrap();
        let encoder = GzEncoder::new(file, flate2::Compression::default());
        let mut archive = tar::Builder::new(encoder);
        for (name, content) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            archive.append_data(&mut header, name, *content).unwrap();
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
        let checksums = format!("{}  nession-0.5.0-linux-amd64.tar.gz\n", expected_hash);
        assert!(verify_checksum(&tarball, &checksums, "nession-0.5.0-linux-amd64.tar.gz",).is_ok());
    }

    #[test]
    fn checksum_verification_fail() {
        let dir = tempfile::tempdir().unwrap();
        let tarball = dir.path().join("nession-0.5.0-linux-amd64.tar.gz");
        fs::write(&tarball, b"fake-content").unwrap();
        let checksums = "0000000000000000000000000000000000000000000000000000000000000000  nession-0.5.0-linux-amd64.tar.gz\n";
        let err =
            verify_checksum(&tarball, checksums, "nession-0.5.0-linux-amd64.tar.gz").unwrap_err();
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
        create_test_tarball(
            &tarball,
            &[
                ("nession", b"cli-binary"),
                ("nession-agent", b"agent-binary"),
                ("nession-server", b"server-binary"),
            ],
        );
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

    #[test]
    fn parse_checksum_with_tab() {
        let content = "abc123\tnession-0.5.0-linux-amd64.tar.gz\n";
        let hash = parse_checksum_line(content, "nession-0.5.0-linux-amd64.tar.gz").unwrap();
        assert_eq!(hash, "abc123");
    }

    #[test]
    fn parse_checksum_empty_content() {
        let err = parse_checksum_line("", "nession.tar.gz").unwrap_err();
        assert!(matches!(err, UpdateError::AssetNotFound(_)));
    }

    #[test]
    fn parse_checksum_skips_empty_lines() {
        let content = "\n\n\nabc123  nession-0.5.0-linux-amd64.tar.gz\n";
        let hash = parse_checksum_line(content, "nession-0.5.0-linux-amd64.tar.gz").unwrap();
        assert_eq!(hash, "abc123");
    }

    #[test]
    fn parse_checksum_malformed_line() {
        let content = "this-is-not-a-valid-checksum-line\n";
        let err = parse_checksum_line(content, "nession.tar.gz").unwrap_err();
        assert!(matches!(err, UpdateError::ExtractionFailed(_)));
    }

    #[test]
    fn temp_extract_dir_creates_directory() {
        let dir = temp_extract_dir().unwrap();
        assert!(dir.exists());
        assert!(dir.to_string_lossy().contains("nession-update-"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn extract_empty_tarball() {
        let dir = tempfile::tempdir().unwrap();
        let tarball = dir.path().join("empty.tar.gz");
        let file = fs::File::create(&tarball).unwrap();
        let encoder = GzEncoder::new(file, flate2::Compression::default());
        let mut archive = tar::Builder::new(encoder);
        let encoder = archive.into_inner().unwrap();
        encoder.finish().unwrap();

        let dest = dir.path().join("extract");
        fs::create_dir(&dest).unwrap();
        let names = extract_binaries(&tarball, &dest).unwrap();
        assert!(names.is_empty());
    }

    #[test]
    fn extract_tarball_with_no_matching_binaries() {
        let dir = tempfile::tempdir().unwrap();
        let tarball = dir.path().join("test.tar.gz");
        create_test_tarball(
            &tarball,
            &[
                ("README.md", b"# nession\n"),
                ("LICENSE", b"MIT\n"),
                ("some-random-file", b"data"),
            ],
        );
        let dest = dir.path().join("extract");
        fs::create_dir(&dest).unwrap();
        let names = extract_binaries(&tarball, &dest).unwrap();
        assert!(names.is_empty());
    }

    #[test]
    fn parse_checksum_multiple_lines_finds_correct() {
        let content =
            "aaa  file1.tar.gz\nbbb  nession-0.5.0-linux-amd64.tar.gz\nccc  file3.tar.gz\n";
        let hash = parse_checksum_line(content, "nession-0.5.0-linux-amd64.tar.gz").unwrap();
        assert_eq!(hash, "bbb");
    }
}
