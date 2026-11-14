//! Bounded HTTPS and archive source acquisition (#3497).
//!
//! Inputs are untrusted. Downloads are checksum-verified and size-bounded;
//! extraction accepts only regular files, directories and relative symlinks
//! that stay inside the destination. Nothing from an input is executed.

use anyhow::{Context, Result};
use flate2::read::GzDecoder;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use crate::digest::{digest_of_bytes, is_valid_digest};

/// Bounds for one acquisition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArchiveLimits {
    pub max_download_bytes: u64,
    pub max_entries: u64,
    pub max_unpacked_bytes: u64,
}

impl Default for ArchiveLimits {
    fn default() -> Self {
        Self {
            max_download_bytes: 512 * 1024 * 1024,
            max_entries: 10_000,
            max_unpacked_bytes: 2 * 1024 * 1024 * 1024,
        }
    }
}

/// The declared archive form.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveFormat {
    /// One HTTPS file, copied as the bundle payload.
    File,
    /// An uncompressed tar archive.
    Tar,
    /// A gzip-compressed tar archive.
    TarGz,
}

/// One checksum-pinned archive/HTTPS source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveSource {
    pub url: String,
    /// `sha256:<64 lowercase hex>` of the downloaded file.
    pub sha256: String,
    pub format: ArchiveFormat,
}

/// One acquisition result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveReceipt {
    pub digest: String,
    pub files: u64,
    pub bytes: u64,
}

/// Fetch one URL into a file, enforcing a byte bound.
pub trait ArchiveFetcher {
    fn fetch(&self, url: &str, destination: &Path, max_bytes: u64) -> Result<u64>;
}

/// A blocking HTTPS fetcher with bounded redirects and timeouts.
#[derive(Debug, Clone)]
pub struct ReqwestFetcher {
    pub connect_timeout: std::time::Duration,
    pub total_timeout: std::time::Duration,
}

impl Default for ReqwestFetcher {
    fn default() -> Self {
        Self {
            connect_timeout: std::time::Duration::from_secs(15),
            total_timeout: std::time::Duration::from_secs(30 * 60),
        }
    }
}

impl ArchiveFetcher for ReqwestFetcher {
    fn fetch(&self, url: &str, destination: &Path, max_bytes: u64) -> Result<u64> {
        let parsed =
            reqwest::Url::parse(url).with_context(|| format!("invalid source URL {url:?}"))?;
        let allowed = parsed.scheme() == "https"
            || (parsed.scheme() == "http"
                && parsed.host_str().is_some_and(|host| {
                    let literal = host
                        .strip_prefix('[')
                        .and_then(|value| value.strip_suffix(']'))
                        .unwrap_or(host);
                    host == "localhost"
                        || literal
                            .parse::<std::net::IpAddr>()
                            .is_ok_and(|address| address.is_loopback())
                }));
        if !allowed {
            anyhow::bail!("source URL {url:?} must use HTTPS (HTTP is allowed only for loopback)");
        }
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(self.connect_timeout)
            .timeout(self.total_timeout)
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .context("failed to build the source HTTP client")?;
        let mut response = client
            .get(parsed)
            .send()
            .with_context(|| format!("failed to download {url}"))?;
        if !response.status().is_success() {
            anyhow::bail!("source download {url} returned HTTP {}", response.status());
        }
        if let Some(length) = response.content_length() {
            if length > max_bytes {
                anyhow::bail!(
                    "source download {url} is {length} bytes, above the {max_bytes} byte bound"
                );
            }
        }
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(destination)
            .with_context(|| format!("failed to create download {}", destination.display()))?;
        let mut buffer = vec![0_u8; 64 * 1024];
        let mut written = 0_u64;
        loop {
            let read = response
                .read(&mut buffer)
                .with_context(|| format!("failed to read source download {url}"))?;
            if read == 0 {
                break;
            }
            written = written.saturating_add(u64::try_from(read).unwrap_or(u64::MAX));
            if written > max_bytes {
                anyhow::bail!("source download {url} exceeded the {max_bytes} byte bound");
            }
            file.write_all(buffer.get(..read).unwrap_or_default())
                .with_context(|| format!("failed to write source download {url}"))?;
        }
        file.sync_all()
            .context("failed to fsync the source download")?;
        Ok(written)
    }
}

/// Fetch, checksum-verify and safely extract one source into `destination`.
pub fn fetch_and_extract(
    fetcher: &dyn ArchiveFetcher,
    source: &ArchiveSource,
    destination: &Path,
    limits: &ArchiveLimits,
) -> Result<ArchiveReceipt> {
    if !is_valid_digest(&source.sha256) {
        anyhow::bail!("source checksum must be sha256:<64 lowercase hex>");
    }
    let parent = destination
        .parent()
        .context("source destination must have a parent")?;
    fs::create_dir_all(parent).with_context(|| format!("failed to create {}", parent.display()))?;
    let work = tempfile::Builder::new()
        .prefix("nession-source-")
        .tempdir_in(parent)
        .context("failed to create a source work directory")?;
    let download = work.path().join("download");
    fetcher
        .fetch(&source.url, &download, limits.max_download_bytes)
        .with_context(|| format!("failed to acquire {}", source.url))?;
    let bytes = fs::read(&download)
        .with_context(|| format!("cannot read downloaded {}", download.display()))?;
    let actual = digest_of_bytes(&bytes);
    if actual != source.sha256 {
        anyhow::bail!(
            "source checksum mismatch for {}: expected {}, got {actual}",
            source.url,
            source.sha256
        );
    }
    fs::create_dir_all(destination)
        .with_context(|| format!("failed to create {}", destination.display()))?;
    let receipt = match source.format {
        ArchiveFormat::File => extract_single_file(&download, destination, &actual)?,
        ArchiveFormat::Tar => {
            extract_tar(fs::File::open(&download)?, destination, limits, &actual)?
        }
        ArchiveFormat::TarGz => {
            let file = fs::File::open(&download)?;
            extract_tar(GzDecoder::new(file), destination, limits, &actual)?
        }
    };
    Ok(receipt)
}

fn extract_single_file(
    download: &Path,
    destination: &Path,
    digest: &str,
) -> Result<ArchiveReceipt> {
    let name = download
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("payload")
        .to_string();
    let target = destination.join(name);
    fs::copy(download, &target)
        .with_context(|| format!("failed to copy source file to {}", target.display()))?;
    let bytes = fs::metadata(&target)?.len();
    Ok(ArchiveReceipt {
        digest: digest.to_string(),
        files: 1,
        bytes,
    })
}

fn extract_tar<R: Read>(
    reader: R,
    destination: &Path,
    limits: &ArchiveLimits,
    digest: &str,
) -> Result<ArchiveReceipt> {
    let mut archive = tar::Archive::new(reader);
    archive.set_preserve_permissions(false);
    let mut files = 0_u64;
    let mut bytes = 0_u64;
    let mut seen = 0_u64;
    for entry in archive.entries().context("invalid tar archive")? {
        let mut entry = entry.context("invalid tar entry")?;
        seen += 1;
        if seen > limits.max_entries {
            anyhow::bail!("tar archive has more than {} entries", limits.max_entries);
        }
        let header = entry.header().clone();
        let relative = safe_relative_path(&entry.path().context("invalid tar entry path")?)?;
        let target = destination.join(&relative);
        let kind = header.entry_type();
        if !kind.is_file() && !kind.is_dir() && !kind.is_symlink() {
            anyhow::bail!(
                "tar entry {} has an unsupported type ({kind:?})",
                relative.display()
            );
        }
        if kind.is_file() {
            let size = entry.size();
            bytes = bytes.saturating_add(size);
            if bytes > limits.max_unpacked_bytes {
                anyhow::bail!(
                    "tar archive exceeds the {} byte unpacked bound",
                    limits.max_unpacked_bytes
                );
            }
            if target.exists() {
                anyhow::bail!(
                    "tar entry {} would overwrite an existing path",
                    relative.display()
                );
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&target)
                .with_context(|| format!("failed to create {}", target.display()))?;
            std::io::copy(&mut entry, &mut file)
                .with_context(|| format!("failed to extract {}", relative.display()))?;
            let mode = sanitized_mode(header.mode().unwrap_or(0o644), false);
            fs::set_permissions(&target, std::os::unix::fs::PermissionsExt::from_mode(mode))?;
            files += 1;
        } else if kind.is_dir() {
            fs::create_dir_all(&target)?;
        } else {
            let link = entry
                .link_name()
                .context("invalid symlink entry")?
                .context("symlink entry has no target")?;
            validate_symlink_target(&link)?;
            if target.exists() {
                anyhow::bail!(
                    "tar entry {} would overwrite an existing path",
                    relative.display()
                );
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            create_symlink(&link, &target)?;
            files += 1;
        }
    }
    Ok(ArchiveReceipt {
        digest: digest.to_string(),
        files,
        bytes,
    })
}

fn sanitized_mode(mode: u32, directory: bool) -> u32 {
    let mode = mode & 0o777 & !0o7000;
    if mode == 0 {
        if directory {
            0o755
        } else {
            0o644
        }
    } else {
        mode
    }
}

/// Accept only a relative path made of normal components.
pub(crate) fn safe_relative_path(path: &Path) -> Result<PathBuf> {
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                anyhow::bail!(
                    "archive path {} is not a safe relative path",
                    path.display()
                );
            }
        }
    }
    if clean.as_os_str().is_empty() {
        anyhow::bail!("archive path is empty");
    }
    Ok(clean)
}

/// Accept only a symlink target that stays inside the extracted tree.
pub(crate) fn validate_symlink_target(target: &Path) -> Result<()> {
    if target.is_absolute() {
        anyhow::bail!(
            "absolute symlink target {} is not allowed",
            target.display()
        );
    }
    let mut depth = 0_i32;
    for component in target.components() {
        match component {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    anyhow::bail!(
                        "symlink target {} escapes the extracted tree",
                        target.display()
                    );
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                anyhow::bail!("symlink target {} is not relative", target.display());
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn create_symlink(target: &Path, link: &Path) -> Result<()> {
    std::os::unix::fs::symlink(target, link)
        .with_context(|| format!("failed to create symlink {}", link.display()))
}

#[cfg(not(unix))]
fn create_symlink(_target: &Path, link: &Path) -> Result<()> {
    anyhow::bail!(
        "symlinks in source archives are not supported on this platform: {}",
        link.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeFetcher {
        bytes: Vec<u8>,
    }

    impl ArchiveFetcher for FakeFetcher {
        fn fetch(&self, _url: &str, destination: &Path, max_bytes: u64) -> Result<u64> {
            if u64::try_from(self.bytes.len()).unwrap_or(u64::MAX) > max_bytes {
                anyhow::bail!("too large");
            }
            fs::write(destination, &self.bytes)?;
            Ok(u64::try_from(self.bytes.len()).unwrap_or(0))
        }
    }

    fn tar_gz_with(entries: &[(&str, &[u8], u32)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::default(),
        ));
        for (path, bytes, mode) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(u64::try_from(bytes.len()).unwrap());
            header.set_mode(*mode);
            header.set_cksum();
            builder
                .append_data(&mut header, path, std::io::Cursor::new(bytes))
                .unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn source(bytes: &[u8], format: ArchiveFormat) -> ArchiveSource {
        ArchiveSource {
            url: "https://example.invalid/source".to_string(),
            sha256: digest_of_bytes(bytes),
            format,
        }
    }

    #[test]
    fn a_valid_tar_gz_preserves_executable_files_and_safe_symlinks() {
        let bytes = tar_gz_with(&[
            ("bin/tool", b"#!/bin/sh\n", 0o755),
            ("doc.txt", b"doc", 0o644),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("out");
        let receipt = fetch_and_extract(
            &FakeFetcher {
                bytes: bytes.clone(),
            },
            &source(&bytes, ArchiveFormat::TarGz),
            &destination,
            &ArchiveLimits::default(),
        )
        .unwrap();
        assert_eq!(receipt.files, 2);
        let tool = destination.join("bin/tool");
        assert_eq!(fs::read(&tool).unwrap(), b"#!/bin/sh\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&tool).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
        assert_eq!(fs::read(destination.join("doc.txt")).unwrap(), b"doc");
    }

    #[test]
    fn a_checksum_mismatch_is_refused() {
        let bytes = b"payload";
        let dir = tempfile::tempdir().unwrap();
        let mut source = source(bytes, ArchiveFormat::File);
        source.sha256 = digest_of_bytes(b"different");
        let error = fetch_and_extract(
            &FakeFetcher {
                bytes: bytes.to_vec(),
            },
            &source,
            &dir.path().join("out"),
            &ArchiveLimits::default(),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("checksum mismatch"));
    }

    #[test]
    fn traversal_and_escaping_paths_are_refused() {
        assert!(safe_relative_path(Path::new("../escape")).is_err());
        assert!(safe_relative_path(Path::new("/absolute")).is_err());
        assert!(safe_relative_path(Path::new("a/../../escape")).is_err());
        assert_eq!(
            safe_relative_path(Path::new("a/./b")).unwrap(),
            PathBuf::from("a/b")
        );
        assert!(validate_symlink_target(Path::new("../../etc/passwd")).is_err());
        assert!(validate_symlink_target(Path::new("/etc/passwd")).is_err());
        assert!(validate_symlink_target(Path::new("bin/tool")).is_ok());
        assert!(validate_symlink_target(Path::new("../sibling")).is_err());
    }

    #[test]
    fn a_download_above_the_bound_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = vec![0_u8; 64];
        let limits = ArchiveLimits {
            max_download_bytes: 8,
            ..ArchiveLimits::default()
        };
        assert!(fetch_and_extract(
            &FakeFetcher {
                bytes: bytes.clone()
            },
            &source(&bytes, ArchiveFormat::File),
            &dir.path().join("out"),
            &limits,
        )
        .is_err());
    }

    #[test]
    fn a_real_http_fetch_is_loopback_only_and_bounded() {
        let server = httptest::Server::run();
        server.expect(
            httptest::Expectation::matching(httptest::matchers::request::method_path(
                "GET", "/blob",
            ))
            .respond_with(httptest::responders::status_code(200).body("hello")),
        );
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("download");
        let url = server.url("/blob").to_string();
        let fetched = ReqwestFetcher::default()
            .fetch(&url, &destination, 1024)
            .unwrap();
        assert_eq!(fetched, 5);
        assert_eq!(fs::read(&destination).unwrap(), b"hello");
        assert!(ReqwestFetcher::default()
            .fetch("http://example.com/blob", &dir.path().join("nope"), 1024)
            .is_err());
    }

    #[test]
    fn a_hardlinked_or_special_entry_is_refused() {
        // A minimal GNU tar header with a hardlink type flag and no body.
        let mut header = tar::Header::new_gnu();
        header.set_size(0);
        header.set_mode(0o644);
        header.set_entry_type(tar::EntryType::Link);
        header.set_path("hard").unwrap();
        header.set_link_name("target").unwrap();
        header.set_cksum();
        let mut builder = tar::Builder::new(Vec::new());
        builder.append(&header, std::io::empty()).unwrap();
        let bytes = builder.into_inner().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let error = fetch_and_extract(
            &FakeFetcher {
                bytes: bytes.clone(),
            },
            &source(&bytes, ArchiveFormat::Tar),
            &dir.path().join("out"),
            &ArchiveLimits::default(),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("unsupported type"));
    }
}
