//! Download, SHA256 verification, and tarball extraction.
//!
//! Asset transfer is streamed into an owner-private `.part` file with bounded
//! memory, a no-progress timeout reset only on received bytes, a total budget
//! covering every retry, and validator-bound Range/If-Range resumption
//! (#4592 §8.2). A whole-response buffer (the old `resp.bytes()` path) is
//! deliberately gone: it bound nothing on a stalled stream and killed healthy
//! long downloads through the shared 10s client timeout.
//!
//! Resumption is an optional server capability; safe restart from zero is the
//! mandatory fallback. A 200 answer, a changed/weak validator, an invalid
//! Content-Range or a 416 always restarts or refuses — partial bytes are never
//! appended on trust. The final full SHA256 and extraction validation are
//! mandatory even after a resume; only a verified full artifact may enter the
//! transaction.

use crate::update::github::ReleaseInfo;
use crate::update::policy::{self, Deadline, TransferPolicy};
use crate::update::progress::{CancelToken, Event, Phase, Reporter};
use crate::update::UpdateError;
use flate2::read::GzDecoder;
use reqwest::header::{
    HeaderMap, CONTENT_LENGTH, CONTENT_RANGE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE, RETRY_AFTER,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How one body-streaming pass ended.
enum StreamOutcome {
    /// The body finished; the partial may be finalized.
    Done,
    /// A transient failure kept the partial; the next attempt may resume.
    Retry,
    /// A terminal failure (integrity, IO, cancellation, budget).
    Failed(UpdateError),
}

/// The sidecar that binds a partial to one exact asset representation.
#[derive(Debug, Serialize, Deserialize)]
struct PartialState {
    /// The exact request URL (release tag + platform asset are part of it).
    url: String,
    /// Strong validator (strong ETag or Last-Modified) for If-Range.
    validator: Option<String>,
    /// Declared total length when the server provided one.
    total: Option<u64>,
}

/// Stream one release asset into `dest`, resuming a verified partial at `part`
/// when the server supports it. Returns the total bytes of the finished file.
///
/// `part` lives in an owner-private cache directory; its sidecar
/// (`<part>.json`) records the URL/validator/length binding. On success the
/// partial is renamed to `dest` and the sidecar removed. On cancellation or a
/// retryable failure the usable partial is preserved for the next attempt;
/// integrity failures discard it.
#[allow(clippy::too_many_arguments)]
pub async fn download_asset(
    client: &Client,
    url: &str,
    dest: &Path,
    part: &Path,
    policy: &TransferPolicy,
    cancel: &CancelToken,
    reporter: &Reporter,
) -> Result<u64, UpdateError> {
    if let Some(parent) = part.parent() {
        ensure_private_dir(parent)?;
    }
    refuse_symlink(part)?;
    let sidecar = part.with_file_name(format!(
        "{}.json",
        part.file_name().and_then(|n| n.to_str()).unwrap_or("asset")
    ));
    refuse_symlink(&sidecar)?;

    // Cross-install concurrency: hold an advisory lock on the partial. A
    // second installer on the same home falls back to its own pid-suffixed
    // partial (fresh download, no shared mutable bytes).
    let lock_path = part.with_file_name(format!(
        "{}.lock",
        part.file_name().and_then(|n| n.to_str()).unwrap_or("asset")
    ));
    let (part, sidecar, _lock) = match try_lock_partial(&lock_path) {
        Some(lock) => (part.to_path_buf(), sidecar, Some(lock)),
        None => {
            let fallback = part.with_file_name(format!(
                "{}.{}",
                part.file_name().and_then(|n| n.to_str()).unwrap_or("asset"),
                std::process::id()
            ));
            let fallback_sidecar = fallback.with_file_name(format!(
                "{}.json",
                fallback
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("asset")
            ));
            (fallback, fallback_sidecar, None)
        }
    };
    let part = part.as_path();
    let sidecar = sidecar.as_path();

    let mut state = load_partial_state(sidecar, url);
    let mut offset = match &state {
        Some(_) => fs::metadata(part).map(|m| m.len()).unwrap_or(0),
        None => 0,
    };
    if state.is_none() {
        let _ = fs::remove_file(part);
    }

    let deadline = Deadline::after(policy.transfer_budget);
    let attempts = policy.attempts();
    let safe_url = policy::redact_url(url);
    let mut last_cause = String::new();

    for attempt in 1..=attempts {
        cancel.check(Phase::DownloadAsset)?;
        if deadline.expired() {
            save_partial_state(sidecar, url, &state);
            return Err(UpdateError::TransferBudgetExhausted {
                url: safe_url,
                budget: policy.transfer_budget,
                received: offset,
            });
        }

        let mut headers = HeaderMap::new();
        let resume_validator = if offset > 0 {
            state.as_ref().and_then(|s| s.validator.clone())
        } else {
            None
        };
        if let Some(validator) = resume_validator {
            if let Ok(value) = format!("bytes={offset}-").parse() {
                headers.insert(RANGE, value);
            }
            if let Ok(value) = validator.parse() {
                headers.insert(IF_RANGE, value);
            }
        }

        let request = client.get(url).headers(headers);
        let send_budget = policy.connect_timeout.min(deadline.remaining());
        let resp = match tokio::time::timeout(send_budget, request.send()).await {
            Ok(Ok(resp)) => resp,
            Ok(Err(error)) => {
                if !policy::is_retryable_transport(&error) {
                    discard_partial(part, sidecar);
                    return Err(UpdateError::Network(format!("{safe_url}: {error}")));
                }
                last_cause = error.to_string();
                if attempt == attempts {
                    break;
                }
                sleep_backoff(policy, attempt, &deadline).await;
                continue;
            }
            Err(_) => {
                last_cause = format!("connection/headers exceeded {send_budget:?}");
                if attempt == attempts {
                    break;
                }
                sleep_backoff(policy, attempt, &deadline).await;
                continue;
            }
        };

        let status = resp.status().as_u16();
        match status {
            200 => {
                // A full answer always restarts from zero: the validator may
                // have changed (If-Range semantics) or range was unsupported.
                let validator = strong_validator(resp.headers());
                let total = content_length(resp.headers());
                state = Some(PartialState {
                    url: url.to_string(),
                    validator,
                    total,
                });
                offset = 0;
                let _ = fs::remove_file(part);
                if let Some(total) = total {
                    crate::update::replace::check_disk_space(
                        dest.parent().unwrap_or(Path::new(".")),
                        total,
                    )?;
                }
            }
            206 => {
                let range = resp
                    .headers()
                    .get(CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("");
                match parse_content_range(range) {
                    Some((start, end, total)) if start == offset => {
                        if let Some(state) = state.as_mut() {
                            state.total = total.or(state.total);
                        }
                        let _ = end;
                    }
                    _ => {
                        // Invalid or misaligned range: never append on trust.
                        state = None;
                        offset = 0;
                        let _ = fs::remove_file(part);
                        last_cause = format!("invalid Content-Range '{range}' for offset {offset}");
                        if attempt == attempts {
                            break;
                        }
                        sleep_backoff(policy, attempt, &deadline).await;
                        continue;
                    }
                }
            }
            416 => {
                // Cannot prove the partial is the whole asset here; the safe
                // mandatory fallback is a fresh download from zero.
                state = None;
                offset = 0;
                let _ = fs::remove_file(part);
                last_cause = "HTTP 416 (range not satisfiable)".to_string();
                if attempt == attempts {
                    break;
                }
                sleep_backoff(policy, attempt, &deadline).await;
                continue;
            }
            408 | 429 | 500 | 502 | 503 | 504 => {
                if status == 429 {
                    if let Some(retry_after) = resp
                        .headers()
                        .get(RETRY_AFTER)
                        .and_then(|v| v.to_str().ok())
                        .and_then(policy::parse_retry_after)
                    {
                        if retry_after > deadline.remaining() {
                            save_partial_state(sidecar, url, &state);
                            return Err(UpdateError::RateLimitedRetryAfter {
                                retry_after,
                                remaining: deadline.remaining(),
                            });
                        }
                        let delay = deadline.cap_sleep(retry_after);
                        tokio::time::sleep(delay).await;
                        last_cause = format!("HTTP 429 (Retry-After {retry_after:?})");
                        if attempt == attempts {
                            break;
                        }
                        continue;
                    }
                }
                last_cause = format!("HTTP {status}");
                if attempt == attempts {
                    break;
                }
                sleep_backoff(policy, attempt, &deadline).await;
                continue;
            }
            _ => {
                discard_partial(part, sidecar);
                return Err(UpdateError::Network(format!(
                    "{safe_url}: download failed: HTTP {status}"
                )));
            }
        }

        // Stream the body with the no-progress budget reset only on bytes.
        let mut file = open_part_append(part).map_err(UpdateError::Io)?;
        let declared_total = state.as_ref().and_then(|s| s.total);
        let resume_base = offset;
        let mut resp = resp;
        let outcome = loop {
            if cancel.is_cancelled() {
                let _ = file.sync_all();
                save_partial_state(sidecar, url, &state);
                break StreamOutcome::Failed(UpdateError::Cancelled {
                    phase: Phase::DownloadAsset.label().to_string(),
                });
            }
            if deadline.expired() {
                let _ = file.sync_all();
                save_partial_state(sidecar, url, &state);
                break StreamOutcome::Failed(UpdateError::TransferBudgetExhausted {
                    url: safe_url.clone(),
                    budget: policy.transfer_budget,
                    received: offset,
                });
            }
            let idle_budget = policy.idle_timeout.min(deadline.remaining());
            match tokio::time::timeout(idle_budget, resp.chunk()).await {
                Ok(Ok(Some(chunk))) => {
                    if let Err(error) = file.write_all(&chunk) {
                        break StreamOutcome::Failed(UpdateError::Io(error));
                    }
                    offset += chunk.len() as u64;
                    if let Some(total) = declared_total {
                        if offset > total {
                            break StreamOutcome::Failed(UpdateError::SizeMismatch {
                                expected: total,
                                received: offset,
                            });
                        }
                    }
                    reporter.emit(Event::Download {
                        received: offset,
                        total: declared_total,
                        attempt,
                        attempts,
                        resumed_from: resume_base,
                        elapsed: deadline.elapsed(),
                    });
                }
                Ok(Ok(None)) => break StreamOutcome::Done,
                Ok(Err(error)) => {
                    if policy::is_retryable_transport(&error) {
                        last_cause = error.to_string();
                        let _ = file.sync_all();
                        save_partial_state(sidecar, url, &state);
                        break StreamOutcome::Retry;
                    }
                    break StreamOutcome::Failed(UpdateError::Network(format!(
                        "{safe_url}: {error}"
                    )));
                }
                Err(_) => {
                    let _ = file.sync_all();
                    save_partial_state(sidecar, url, &state);
                    last_cause = format!("no bytes for {idle_budget:?}");
                    break StreamOutcome::Retry;
                }
            }
        };
        drop(file);

        match outcome {
            StreamOutcome::Done => {
                if let Some(total) = declared_total {
                    if offset != total {
                        discard_partial(part, sidecar);
                        return Err(UpdateError::SizeMismatch {
                            expected: total,
                            received: offset,
                        });
                    }
                }
                fs::rename(part, dest).map_err(UpdateError::Io)?;
                let _ = fs::remove_file(sidecar);
                let _ = fs::remove_file(&lock_path);
                reporter.emit(Event::Download {
                    received: offset,
                    total: declared_total.or(Some(offset)),
                    attempt,
                    attempts,
                    resumed_from: 0,
                    elapsed: deadline.elapsed(),
                });
                return Ok(offset);
            }
            StreamOutcome::Retry => {
                if attempt == attempts {
                    // The last cause distinguishes idle exhaustion from a
                    // transport failure for the diagnostic contract.
                    if last_cause.starts_with("no bytes") {
                        return Err(UpdateError::IdleTimeout {
                            url: safe_url,
                            idle: policy.idle_timeout,
                            received: offset,
                        });
                    }
                    return Err(UpdateError::RetryExhausted {
                        url: safe_url,
                        attempts,
                        cause: last_cause,
                    });
                }
                sleep_backoff(policy, attempt, &deadline).await;
                continue;
            }
            StreamOutcome::Failed(error) => {
                // Integrity/IO/cancellation failure: a corrupt partial must
                // never become a trusted cache hit. Cancellation keeps the
                // usable partial (state saved above); integrity discards it.
                if matches!(error, UpdateError::SizeMismatch { .. } | UpdateError::Io(_)) {
                    discard_partial(part, sidecar);
                }
                return Err(error);
            }
        }
    }

    save_partial_state(sidecar, url, &state);
    Err(UpdateError::RetryExhausted {
        url: safe_url,
        attempts,
        cause: last_cause,
    })
}

/// Compatibility wrapper: stream with the default policy and no progress.
/// Used for small auxiliary assets (install.sh) and existing callers.
pub async fn download_to_file(client: &Client, url: &str, dest: &Path) -> Result<u64, UpdateError> {
    let part = dest.with_file_name(format!(
        "{}.part",
        dest.file_name().and_then(|n| n.to_str()).unwrap_or("asset")
    ));
    download_asset(
        client,
        url,
        dest,
        &part,
        &TransferPolicy::default(),
        &CancelToken::new(),
        &Reporter::silent(),
    )
    .await
}

async fn sleep_backoff(policy: &TransferPolicy, attempt: u32, deadline: &Deadline) {
    let delay = policy::backoff_delay(
        attempt - 1,
        policy.backoff_base,
        policy.backoff_max,
        deadline.remaining(),
    );
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
}

/// A strong validator usable with If-Range: a strong ETag or Last-Modified.
/// Weak ETags (`W/…`) cannot guard a range append and are rejected.
fn strong_validator(headers: &HeaderMap) -> Option<String> {
    if let Some(etag) = headers.get(ETAG).and_then(|v| v.to_str().ok()) {
        if !etag.starts_with("W/") && !etag.trim().is_empty() {
            return Some(etag.to_string());
        }
    }
    headers
        .get(LAST_MODIFIED)
        .and_then(|v| v.to_str().ok())
        .map(std::string::ToString::to_string)
}

fn content_length(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
}

/// Parse `bytes <start>-<end>/<total|*>`.
fn parse_content_range(value: &str) -> Option<(u64, u64, Option<u64>)> {
    let rest = value.trim().strip_prefix("bytes ")?;
    let (range, total) = rest.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let start = start.parse::<u64>().ok()?;
    let end = end.parse::<u64>().ok()?;
    if end < start {
        return None;
    }
    let total = if total.trim() == "*" {
        None
    } else {
        Some(total.trim().parse::<u64>().ok()?)
    };
    Some((start, end, total))
}

fn load_partial_state(sidecar: &Path, url: &str) -> Option<PartialState> {
    let bytes = fs::read(sidecar).ok()?;
    let state: PartialState = serde_json::from_slice(&bytes).ok()?;
    // The partial is bound to one exact URL (release + platform asset).
    if state.url != url {
        return None;
    }
    Some(state)
}

fn save_partial_state(sidecar: &Path, url: &str, state: &Option<PartialState>) {
    let Some(state) = state else {
        let _ = fs::remove_file(sidecar);
        return;
    };
    let _ = url;
    if let Ok(body) = serde_json::to_vec(state) {
        let _ = write_private(sidecar, &body);
    }
}

fn discard_partial(part: &Path, sidecar: &Path) {
    let _ = fs::remove_file(part);
    let _ = fs::remove_file(sidecar);
}

fn ensure_private_dir(dir: &Path) -> Result<(), UpdateError> {
    fs::create_dir_all(dir).map_err(UpdateError::Io)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(UpdateError::Io)?;
    }
    Ok(())
}

fn refuse_symlink(path: &Path) -> Result<(), UpdateError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(UpdateError::Io(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("refusing to follow a symlink at {}", path.display()),
        ))),
        _ => Ok(()),
    }
}

fn write_private(path: &Path, body: &[u8]) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(body)?;
    file.sync_all()
}

fn open_part_append(part: &Path) -> io::Result<fs::File> {
    refuse_symlink(part)
        .map_err(|e| io::Error::new(io::ErrorKind::PermissionDenied, e.to_string()))?;
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(part)
}

/// An advisory lock guarding one partial against a concurrent installer.
struct PartialLock(fs::File);

impl Drop for PartialLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            // SAFETY: the file owns a valid descriptor for this call.
            unsafe {
                libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
            }
        }
    }
}

fn try_lock_partial(lock_path: &Path) -> Option<PartialLock> {
    let mut options = fs::OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(lock_path).ok()?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        // SAFETY: the file owns a valid descriptor for this call.
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if result != 0 {
            return None;
        }
    }
    Some(PartialLock(file))
}

pub fn sha256_file(path: &Path) -> Result<String, UpdateError> {
    let mut file = fs::File::open(path).map_err(UpdateError::Io)?;
    let mut hasher = Sha256::new();
    io::copy(&mut file, &mut hasher).map_err(UpdateError::Io)?;
    let hash = hasher.finalize();
    Ok(format!("{hash:x}"))
}

/// The expected SHA256 for one asset, fetched before the transfer starts.
pub fn expected_checksum(
    checksums_content: &str,
    tarball_filename: &str,
) -> Result<String, UpdateError> {
    parse_checksum_line(checksums_content, tarball_filename)
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

/// The owner-private partial-download cache under a Nession home.
///
/// One bounded directory per home; partials are keyed by asset name and
/// cleaned on success or integrity failure. Stale entries (older than the
/// retention window) are pruned at the start of an install.
pub fn partial_cache_dir(home: &Path) -> PathBuf {
    home.join(".update-cache")
}

/// Remove partials/sidecars/locks older than the retention window. Never
/// touches verified artifacts or unrelated files.
pub fn prune_stale_partials(home: &Path, max_age: Duration) {
    let dir = partial_cache_dir(home);
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let Ok(modified_secs) = modified.duration_since(std::time::UNIX_EPOCH) else {
            continue;
        };
        let age = now.saturating_sub(modified_secs);
        if age > max_age {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Download install.sh from a GitHub Release and make it executable.
pub async fn download_installer(
    client: &Client,
    release: &ReleaseInfo,
    dest_dir: &Path,
) -> Result<PathBuf, UpdateError> {
    let asset = release
        .assets
        .iter()
        .find(|a| a.name == "install.sh")
        .ok_or_else(|| UpdateError::AssetNotFound("install.sh not found in release".into()))?;

    let dest = dest_dir.join("install.sh");
    download_to_file(client, &asset.browser_download_url, &dest).await?;

    // Make executable on Unix systems
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dest, fs::Permissions::from_mode(0o755)).map_err(UpdateError::Io)?;
    }

    Ok(dest)
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
        let checksums = format!("{expected_hash}  nession-0.5.0-linux-amd64.tar.gz\n");
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
        let archive = tar::Builder::new(encoder);
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

    #[test]
    fn content_range_parsing() {
        assert_eq!(
            parse_content_range("bytes 10-19/20"),
            Some((10, 19, Some(20)))
        );
        assert_eq!(parse_content_range("bytes 0-9/*"), Some((0, 9, None)));
        assert_eq!(parse_content_range("bytes 20-10/30"), None);
        assert_eq!(parse_content_range("items 0-9/10"), None);
        assert_eq!(parse_content_range("bytes -/10"), None);
    }

    #[test]
    fn weak_etags_are_not_resume_validators() {
        let mut headers = HeaderMap::new();
        headers.insert(ETAG, "W/\"abc\"".parse().unwrap());
        assert_eq!(strong_validator(&headers), None);
        headers.insert(ETAG, "\"abc\"".parse().unwrap());
        assert_eq!(strong_validator(&headers).as_deref(), Some("\"abc\""));
        headers.remove(ETAG);
        headers.insert(
            LAST_MODIFIED,
            "Wed, 21 Oct 2015 07:28:00 GMT".parse().unwrap(),
        );
        assert_eq!(
            strong_validator(&headers).as_deref(),
            Some("Wed, 21 Oct 2015 07:28:00 GMT")
        );
    }

    #[test]
    fn partial_state_is_bound_to_the_exact_url() {
        let dir = tempfile::tempdir().unwrap();
        let sidecar = dir.path().join("asset.json");
        let state = PartialState {
            url: "https://host/v1/asset".into(),
            validator: Some("\"v1\"".into()),
            total: Some(10),
        };
        save_partial_state(&sidecar, "https://host/v1/asset", &Some(state));
        assert!(load_partial_state(&sidecar, "https://host/v1/asset").is_some());
        assert!(
            load_partial_state(&sidecar, "https://host/v2/asset").is_none(),
            "a different release/asset must not reuse the partial"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_partial_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("elsewhere");
        fs::write(&target, b"x").unwrap();
        let link = dir.path().join("asset.part");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(refuse_symlink(&link).is_err());
    }

    #[test]
    fn stale_partials_are_pruned_without_touching_fresh_ones() {
        let dir = tempfile::tempdir().unwrap();
        let cache = partial_cache_dir(dir.path());
        fs::create_dir_all(&cache).unwrap();
        let stale = cache.join("old.part");
        let fresh = cache.join("new.part");
        fs::write(&stale, b"old").unwrap();
        fs::write(&fresh, b"new").unwrap();
        // Age the stale entry beyond the retention window.
        let old_time = std::time::SystemTime::now() - Duration::from_secs(8 * 24 * 3600);
        let times = fs::FileTimes::new().set_modified(old_time);
        fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_times(times)
            .unwrap();
        prune_stale_partials(dir.path(), Duration::from_secs(7 * 24 * 3600));
        assert!(!stale.exists());
        assert!(fresh.exists());
    }
}
