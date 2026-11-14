//! The one verified, resumable, single-flight object transfer engine (#3499).
//!
//! A transfer becomes Ready only after its exact bytes hash to the requested
//! digest and its size matches the descriptor's claim. Bytes live in a durable
//! partial until then, so an interrupted, duplicated or restarted transfer
//! yields either the old verified file or a resumable partial — never a
//! mountable unverified object.
//!
//! Consumers own their paths, pins and eviction policy. They observe (but do
//! not own) progress through [`ProgressObserver`]; the Agent maps those events
//! into its existing per-digest #3412 projection.

use anyhow::{Context, Result};
use futures_util::StreamExt;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use crate::digest::{regular_file_digest, verify_file};
use crate::distribution::http::{
    DownloadGrant, OpenOutcome, TransferClient, DEFAULT_MAX_OBJECT_BYTES,
};

/// How often a streaming transfer refreshes its observable byte count.
pub const PROGRESS_UPDATE_BYTES: u64 = 256 * 1024;

/// One transfer's fixed inputs.
#[derive(Debug)]
pub struct TransferSpec<'a> {
    /// `sha256:<64 lowercase hex>` the finished bytes must hash to.
    pub digest: &'a str,
    pub grant: &'a DownloadGrant,
    /// The verified destination. Existing correct bytes are a warm hit.
    pub final_path: &'a Path,
    /// The durable partial used for resume.
    pub partial_path: &'a Path,
    /// Hard upper bound for the object; a larger declaration fails closed.
    pub max_bytes: u64,
    /// Descriptor size, when the caller has one. A completed transfer must
    /// equal it exactly; a stale descriptor therefore cannot pass.
    pub expected_size: Option<u64>,
}

/// What one transfer did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TransferOutcome {
    /// The verified destination already existed; no body bytes were read.
    pub from_cache: bool,
    /// Bytes read from the network by this call.
    pub transferred: u64,
    /// Verified byte count at the destination.
    pub size_bytes: u64,
}

/// The runtime adapter's progress projection.
///
/// Events are advisory and may be coalesced; the final readiness fact is the
/// returned [`TransferOutcome`], not the last event. A consumer must not use
/// `verifying` or `progress` as proof that the object is Ready.
pub trait ProgressObserver: Send + Sync {
    /// A transfer is starting. `durable_bytes` is the partial's current size.
    fn started(&self, durable_bytes: u64);

    /// Body bytes have reached the partial (including resumed bytes).
    fn progress(&self, downloaded_bytes: u64, total_bytes: Option<u64>);

    /// The complete bytes are being hashed before publication.
    fn verifying(&self, downloaded_bytes: u64, total_bytes: Option<u64>);
}

/// The transfer engine. One instance per runtime adapter is enough; its
/// per-digest single-flight map is process-wide state for that adapter.
pub struct TransferEngine {
    http: TransferClient,
    locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
}

impl TransferEngine {
    pub fn new() -> Result<Self> {
        Ok(Self {
            http: TransferClient::new()?,
            locks: Mutex::new(HashMap::new()),
        })
    }

    /// A warm verified hit needs no network and no lock.
    pub async fn cached(&self, digest: &str, final_path: &Path) -> Option<u64> {
        if verified_regular(final_path, digest).await {
            return std::fs::metadata(final_path).ok().map(|meta| meta.len());
        }
        None
    }

    /// Fetch one object into `final_path`, resuming `partial_path` when its
    /// bytes are already durable.
    ///
    /// Concurrent callers for one digest share one transfer. A corrupt ready
    /// file is removed; a digest mismatch after transfer removes the partial
    /// (it can never become valid); an interrupted body keeps it. A `416`
    /// discards the stale partial and fails so the caller can retry from zero.
    pub async fn fetch(
        &self,
        spec: TransferSpec<'_>,
        observer: &dyn ProgressObserver,
    ) -> Result<TransferOutcome> {
        if let Some(size_bytes) = self.cached(spec.digest, spec.final_path).await {
            return Ok(TransferOutcome {
                from_cache: true,
                transferred: 0,
                size_bytes,
            });
        }
        if spec.final_path.exists() {
            let _ = std::fs::remove_file(spec.final_path);
        }
        let lock = self.digest_lock(spec.digest);
        let _guard: OwnedMutexGuard<()> = lock.lock_owned().await;
        // Another caller may have published while this one waited.
        if let Some(size_bytes) = self.cached(spec.digest, spec.final_path).await {
            return Ok(TransferOutcome {
                from_cache: true,
                transferred: 0,
                size_bytes,
            });
        }

        let existing = tokio::fs::metadata(spec.partial_path)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        observer.started(existing);
        let max_bytes = spec.max_bytes.max(1);
        let opened = self
            .http
            .open(spec.digest, spec.grant, existing, max_bytes)
            .await;
        let (response, resumed_bytes, total_bytes) = match opened {
            Ok(OpenOutcome::Stream {
                response,
                resumed_bytes,
                total_bytes,
            }) => (response, resumed_bytes, total_bytes),
            Ok(OpenOutcome::RangeRefused) => {
                let _ = tokio::fs::remove_file(spec.partial_path).await;
                anyhow::bail!("image server refused the resume range; retry the download");
            }
            Err(error) => return Err(error),
        };
        if let Some(total) = total_bytes {
            if let Some(expected) = spec.expected_size {
                if total != expected {
                    let _ = tokio::fs::remove_file(spec.partial_path).await;
                    anyhow::bail!(
                        "image declares {total} bytes but its descriptor claims {expected}"
                    );
                }
            }
        }

        let mut file = if resumed_bytes > 0 {
            tokio::fs::OpenOptions::new()
                .append(true)
                .open(spec.partial_path)
                .await
                .context("cannot resume a partial image download")?
        } else {
            tokio::fs::File::create(spec.partial_path)
                .await
                .context("cannot create a partial image download")?
        };
        let mut stream = response.bytes_stream();
        let mut transferred = 0_u64;
        let mut last_reported = 0_u64;
        let mut stream_error: Option<anyhow::Error> = None;
        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) => {
                    stream_error =
                        Some(anyhow::Error::new(error).context("image body stream failed"));
                    break;
                }
            };
            if let Err(error) = file.write_all(&chunk).await {
                stream_error = Some(error.into());
                break;
            }
            transferred += chunk.len() as u64;
            let downloaded = resumed_bytes + transferred;
            if downloaded > max_bytes {
                drop(file);
                let _ = tokio::fs::remove_file(spec.partial_path).await;
                anyhow::bail!("image body exceeded the {max_bytes}-byte transfer bound");
            }
            if transferred.saturating_sub(last_reported) >= PROGRESS_UPDATE_BYTES {
                observer.progress(downloaded, total_bytes);
                last_reported = transferred;
            }
        }
        // A `tokio::fs::File` write is accepted before its blocking write
        // completes. Flush the durable partial before reporting any outcome (a
        // failure included) so the `.part` length is a truthful resume point
        // and a later restart cannot race an in-flight buffered write.
        let flushed = match file.flush().await {
            Ok(()) => file.sync_all().await,
            Err(error) => Err(error),
        };
        drop(file);
        if let Some(error) = stream_error {
            return Err(error);
        }
        flushed?;

        let downloaded_bytes = resumed_bytes + transferred;
        if let Some(total) = total_bytes {
            if downloaded_bytes > total {
                let _ = tokio::fs::remove_file(spec.partial_path).await;
                anyhow::bail!(
                    "image body reached {downloaded_bytes} bytes but the declared total is {total}"
                );
            }
        }
        if let Some(expected) = spec.expected_size {
            if downloaded_bytes != expected {
                let _ = tokio::fs::remove_file(spec.partial_path).await;
                anyhow::bail!(
                    "image body has {downloaded_bytes} bytes but its descriptor claims {expected}"
                );
            }
        }
        observer.verifying(downloaded_bytes, total_bytes);
        let partial = spec.partial_path.to_path_buf();
        let digest = spec.digest.to_string();
        let verified = tokio::task::spawn_blocking(move || verify_file(&partial, &digest))
            .await
            .context("image verification task")?;
        if let Err(error) = verified {
            let _ = tokio::fs::remove_file(spec.partial_path).await;
            anyhow::bail!("downloaded image does not match {}: {error:#}", spec.digest);
        }
        let size_bytes = std::fs::metadata(spec.partial_path)
            .with_context(|| format!("cannot stat {}", spec.partial_path.display()))?
            .len();
        if let Err(error) = std::fs::rename(spec.partial_path, spec.final_path) {
            return Err(error).with_context(|| {
                format!(
                    "cannot publish {} as {}",
                    spec.partial_path.display(),
                    spec.final_path.display()
                )
            });
        }
        Ok(TransferOutcome {
            from_cache: false,
            transferred,
            size_bytes,
        })
    }

    fn digest_lock(&self, digest: &str) -> Arc<AsyncMutex<()>> {
        let mut locks = self
            .locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        locks
            .entry(digest.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }
}

async fn verified_regular(path: &Path, digest: &str) -> bool {
    let path = path.to_path_buf();
    let digest = digest.to_string();
    tokio::task::spawn_blocking(move || {
        regular_file_digest(&path)
            .ok()
            .flatten()
            .is_some_and(|actual| actual == digest)
    })
    .await
    .unwrap_or(false)
}

/// A no-op observer for callers that have no progress projection.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopProgress;

impl ProgressObserver for NoopProgress {
    fn started(&self, _durable_bytes: u64) {}
    fn progress(&self, _downloaded_bytes: u64, _total_bytes: Option<u64>) {}
    fn verifying(&self, _downloaded_bytes: u64, _total_bytes: Option<u64>) {}
}

/// The default transfer bound.
pub fn default_bound() -> u64 {
    DEFAULT_MAX_OBJECT_BYTES
}

/// One path pair, derived by the runtime adapter from its verified digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferPaths {
    pub final_path: PathBuf,
    pub partial_path: PathBuf,
}

#[cfg(test)]
mod tests {
    use super::*;
    use httptest::{matchers::*, Expectation, Server};
    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicU64, Ordering};

    struct CountingObserver {
        started: AtomicU64,
        progress: AtomicU64,
        verifying: AtomicU64,
    }

    impl CountingObserver {
        fn new() -> Self {
            Self {
                started: AtomicU64::new(0),
                progress: AtomicU64::new(0),
                verifying: AtomicU64::new(0),
            }
        }
    }

    impl ProgressObserver for CountingObserver {
        fn started(&self, durable_bytes: u64) {
            self.started.store(durable_bytes, Ordering::Relaxed);
        }
        fn progress(&self, _downloaded_bytes: u64, _total_bytes: Option<u64>) {
            self.progress.fetch_add(1, Ordering::Relaxed);
        }
        fn verifying(&self, _downloaded_bytes: u64, _total_bytes: Option<u64>) {
            self.verifying.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn digest_for(bytes: &[u8]) -> String {
        crate::digest::digest_of_bytes(bytes)
    }

    fn paths(dir: &Path, digest: &str) -> TransferPaths {
        let hex = digest.strip_prefix("sha256:").unwrap();
        TransferPaths {
            final_path: dir.join("sha256").join(hex),
            partial_path: dir.join("tmp").join(format!("{hex}.part")),
        }
    }

    fn prepare(dir: &Path) {
        std::fs::create_dir_all(dir.join("sha256")).unwrap();
        std::fs::create_dir_all(dir.join("tmp")).unwrap();
    }

    fn grant(server: &Server, digest: &str) -> DownloadGrant {
        DownloadGrant {
            url: server.url(&format!("/blobs/{digest}")).to_string(),
            token: "t".to_string(),
        }
    }

    fn spec<'a>(
        digest: &'a str,
        grant: &'a DownloadGrant,
        paths: &'a TransferPaths,
    ) -> TransferSpec<'a> {
        TransferSpec {
            digest,
            grant,
            final_path: &paths.final_path,
            partial_path: &paths.partial_path,
            max_bytes: DEFAULT_MAX_OBJECT_BYTES,
            expected_size: None,
        }
    }

    #[tokio::test]
    async fn a_verified_ready_file_is_a_warm_hit_and_warm_wins_over_a_stale_partial() {
        let dir = tempfile::tempdir().unwrap();
        prepare(dir.path());
        let bytes = b"ready".to_vec();
        let digest = digest_for(&bytes);
        let paths = paths(dir.path(), &digest);
        std::fs::write(&paths.final_path, &bytes).unwrap();
        std::fs::write(&paths.partial_path, b"stale").unwrap();
        let engine = TransferEngine::new().unwrap();
        let grant = DownloadGrant {
            url: "http://127.0.0.1:9/unused".to_string(),
            token: "t".to_string(),
        };
        let outcome = engine
            .fetch(spec(&digest, &grant, &paths), &NoopProgress)
            .await
            .unwrap();
        assert!(outcome.from_cache);
        assert_eq!(outcome.size_bytes, bytes.len() as u64);
        assert!(
            paths.partial_path.exists(),
            "a warm hit leaves the partial alone"
        );
    }

    #[tokio::test]
    async fn concurrent_requests_for_one_digest_share_one_transfer() {
        let dir = tempfile::tempdir().unwrap();
        prepare(dir.path());
        let body = vec![3_u8; 256 * 1024];
        let digest = digest_for(&body);
        let paths = paths(dir.path(), &digest);
        let server = Server::run();
        server.expect(
            Expectation::matching(request::method_path("GET", format!("/blobs/{digest}")))
                .times(1)
                .respond_with(
                    httptest::http::Response::builder()
                        .status(200)
                        .body(body.clone())
                        .unwrap(),
                ),
        );
        let grant = grant(&server, &digest);
        let engine = Arc::new(TransferEngine::new().unwrap());
        let left = tokio::spawn({
            let engine = Arc::clone(&engine);
            let digest = digest.clone();
            let grant = grant.clone();
            let paths = paths.clone();
            async move {
                engine
                    .fetch(spec(&digest, &grant, &paths), &NoopProgress)
                    .await
                    .unwrap()
            }
        });
        let right = tokio::spawn({
            let engine = Arc::clone(&engine);
            let digest = digest.clone();
            let grant = grant.clone();
            let paths = paths.clone();
            async move {
                engine
                    .fetch(spec(&digest, &grant, &paths), &NoopProgress)
                    .await
                    .unwrap()
            }
        });
        let (left, right) = (left.await.unwrap(), right.await.unwrap());
        assert_eq!(
            u64::from(left.from_cache) + u64::from(right.from_cache),
            1,
            "exactly one caller publishes, the other observes the ready file"
        );
        assert_eq!(left.transferred + right.transferred, body.len() as u64);
        assert_eq!(std::fs::read(&paths.final_path).unwrap(), body);
    }

    #[tokio::test]
    async fn an_interrupted_transfer_keeps_a_resumable_partial_and_never_publishes() {
        let dir = tempfile::tempdir().unwrap();
        prepare(dir.path());
        let body = vec![7_u8; 512 * 1024];
        let digest = digest_for(&body);
        let paths = paths(dir.path(), &digest);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server_body = body.clone();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                server_body.len()
            )
            .unwrap();
            stream
                .write_all(&server_body[..server_body.len() / 2])
                .unwrap();
            stream.flush().unwrap();
            // Dropping the connection before the declared length is an
            // interrupted transfer, not a successful object.
        });
        let engine = TransferEngine::new().unwrap();
        let interrupted_grant = DownloadGrant {
            url: format!("http://{address}/blobs/{digest}"),
            token: "t".to_string(),
        };
        let observer = CountingObserver::new();
        assert!(engine
            .fetch(spec(&digest, &interrupted_grant, &paths), &observer)
            .await
            .is_err());
        server.join().unwrap();
        assert!(!paths.final_path.exists());
        let durable = std::fs::metadata(&paths.partial_path).unwrap().len();
        assert!(durable > 0 && durable < body.len() as u64);
        assert_eq!(observer.started.load(Ordering::Relaxed), 0);
        assert_eq!(observer.verifying.load(Ordering::Relaxed), 0);

        // The next request resumes exactly where the durable partial ended.
        let server = Server::run();
        server.expect(
            Expectation::matching(all_of![
                request::method_path("GET", format!("/blobs/{digest}")),
                request::headers(contains(("range", format!("bytes={durable}-")))),
            ])
            .times(1)
            .respond_with(
                httptest::http::Response::builder()
                    .status(206)
                    .header(
                        "content-range",
                        format!("bytes {durable}-{}/{}", body.len() - 1, body.len()),
                    )
                    .body(body[usize::try_from(durable).unwrap()..].to_vec())
                    .unwrap(),
            ),
        );
        let resume_grant = grant(&server, &digest);
        let resumed = engine
            .fetch(spec(&digest, &resume_grant, &paths), &NoopProgress)
            .await
            .unwrap();
        assert_eq!(resumed.transferred, body.len() as u64 - durable);
        assert_eq!(std::fs::read(&paths.final_path).unwrap(), body);
    }

    #[tokio::test]
    async fn a_digest_mismatch_removes_the_partial_and_never_publishes() {
        let dir = tempfile::tempdir().unwrap();
        prepare(dir.path());
        let expected = digest_for(b"expected");
        let paths = paths(dir.path(), &expected);
        let server = Server::run();
        server.expect(
            Expectation::matching(request::method_path("GET", format!("/blobs/{expected}")))
                .times(1)
                .respond_with(
                    httptest::http::Response::builder()
                        .status(200)
                        .body(b"wrong".to_vec())
                        .unwrap(),
                ),
        );
        let grant = grant(&server, &expected);
        let engine = TransferEngine::new().unwrap();
        assert!(engine
            .fetch(spec(&expected, &grant, &paths), &NoopProgress)
            .await
            .is_err());
        assert!(!paths.final_path.exists());
        assert!(!paths.partial_path.exists());
    }

    #[tokio::test]
    async fn a_stale_descriptor_size_fails_closed_even_when_the_digest_matches() {
        let dir = tempfile::tempdir().unwrap();
        prepare(dir.path());
        let body = b"exact".to_vec();
        let digest = digest_for(&body);
        let paths = paths(dir.path(), &digest);
        let server = Server::run();
        server.expect(
            Expectation::matching(request::method_path("GET", format!("/blobs/{digest}")))
                .times(1)
                .respond_with(
                    httptest::http::Response::builder()
                        .status(200)
                        .body(body.clone())
                        .unwrap(),
                ),
        );
        let grant = grant(&server, &digest);
        let engine = TransferEngine::new().unwrap();
        let mut request = spec(&digest, &grant, &paths);
        request.expected_size = Some(body.len() as u64 + 1);
        assert!(engine.fetch(request, &NoopProgress).await.is_err());
        assert!(!paths.final_path.exists());
        assert!(!paths.partial_path.exists());
    }

    #[tokio::test]
    async fn a_restart_adopts_only_bytes_that_still_hash_to_the_digest() {
        let dir = tempfile::tempdir().unwrap();
        prepare(dir.path());
        let body = b"restart".to_vec();
        let digest = digest_for(&body);
        let paths = paths(dir.path(), &digest);
        std::fs::write(&paths.final_path, &body).unwrap();
        let engine = TransferEngine::new().unwrap();
        assert!(engine.cached(&digest, &paths.final_path).await.is_some());
        std::fs::write(&paths.final_path, b"tampered").unwrap();
        assert!(engine.cached(&digest, &paths.final_path).await.is_none());
    }
}
