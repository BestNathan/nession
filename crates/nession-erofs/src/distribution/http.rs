//! Authenticated HTTP(S) `Range`/`ETag` object reads (#3022/#3023/#3499).
//!
//! The Server's blob route answers one digest with `ETag`, `Accept-Ranges`,
//! explicit `403`/`404`/`416` and a `206` `Content-Range` for a resumed read.
//! This module is the client side of exactly that contract. It validates the
//! response shape and the declared bounds before any byte is written, so a
//! consumer can never mistake a truncated or contradictory response for a
//! complete object.
//!
//! The module knows nothing about cache paths, pins or protocol progress; the
//! transfer engine owns publication and a runtime adapter owns the progress
//! projection.

use anyhow::{Context, Result};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use std::time::Duration;

/// The scoped bearer grant the Server minted for one authorized object.
///
/// `url` is derived by the Agent from its own configured Server address plus
/// the grant path; the Server never guesses its public hostname. `token` is
/// the Agent's Server Token, which the blob route verifies (#3440).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadGrant {
    pub url: String,
    pub token: String,
}

/// Upper bound for one transferred object when the caller has no narrower
/// bound. EROFS images are bounded by the same order as the Server's blob GC
/// budget; an absurd `Content-Length` must fail before bytes are accepted.
pub const DEFAULT_MAX_OBJECT_BYTES: u64 = 32 * 1024 * 1024 * 1024;

/// The validated shape of one blob-route response.
#[derive(Debug)]
pub enum OpenOutcome {
    /// The server accepted the request; `resumed_bytes` bytes already exist
    /// in the caller's partial file.
    Stream {
        response: reqwest::Response,
        /// Bytes that precede the first body byte in the partial file.
        resumed_bytes: u64,
        /// Authoritative total when the route declared one.
        total_bytes: Option<u64>,
    },
    /// The route reported `416`: the caller's partial can never be resumed and
    /// must be discarded before retrying from zero.
    RangeRefused,
}

/// The one HTTP client for object transfers.
#[derive(Debug, Clone)]
pub struct TransferClient {
    client: reqwest::Client,
}

impl TransferClient {
    pub fn new() -> Result<Self> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30 * 60))
            .build()
            .context("cannot build the image transfer client")?;
        Ok(Self { client })
    }

    /// Open one authenticated read, resuming at `existing` bytes.
    ///
    /// The grant is validated before any network I/O. A `206` must describe
    /// exactly the requested range; a `200` deliberately restarts from byte
    /// zero (the caller truncates its stale partial). A declared total or
    /// response length above `max_bytes` fails closed.
    pub async fn open(
        &self,
        digest: &str,
        grant: &DownloadGrant,
        existing: u64,
        max_bytes: u64,
    ) -> Result<OpenOutcome> {
        if grant.token.is_empty() {
            anyhow::bail!("image download grant has no token");
        }
        if !(grant.url.starts_with("https://") || grant.url.starts_with("http://")) {
            anyhow::bail!("image download grant must be an http(s) URL");
        }
        let mut request = self
            .client
            .get(&grant.url)
            .bearer_auth(&grant.token)
            .header(reqwest::header::ACCEPT_ENCODING, "identity");
        if existing > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
        }
        let response = request.send().await.context("image download failed")?;
        let status = response.status();
        let headers = response.headers();
        let content_length = header_u64(headers, reqwest::header::CONTENT_LENGTH);
        if status == reqwest::StatusCode::PARTIAL_CONTENT {
            let content_range = headers
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| {
                    anyhow::anyhow!("image server returned 206 without Content-Range")
                })?;
            let (start, end, total) = parse_content_range(content_range).ok_or_else(|| {
                anyhow::anyhow!("image server returned an invalid Content-Range `{content_range}`")
            })?;
            if existing == 0 {
                anyhow::bail!(
                    "image server returned an unexpected partial response for a cold download"
                );
            }
            if start != existing {
                anyhow::bail!("image resume range starts at {start}, expected {existing}");
            }
            let expected = end - start + 1;
            if let Some(length) = content_length {
                if length != expected {
                    anyhow::bail!(
                        "image resume length {length} disagrees with Content-Range length {expected}"
                    );
                }
            }
            if let Some(total) = total {
                if total < end + 1 {
                    anyhow::bail!(
                        "image resume range ends at {} but the declared total is {total}",
                        end + 1
                    );
                }
                if total > max_bytes {
                    anyhow::bail!(
                        "image declares {total} bytes, above the transfer bound {max_bytes}"
                    );
                }
            }
            return Ok(OpenOutcome::Stream {
                response,
                resumed_bytes: existing,
                total_bytes: total,
            });
        }
        if status.is_success() {
            // A 200 restarts from byte zero even if the request asked for a
            // Range; the transfer engine truncates the stale partial.
            if let Some(total) = content_length {
                if total > max_bytes {
                    anyhow::bail!(
                        "image declares {total} bytes, above the transfer bound {max_bytes}"
                    );
                }
            }
            return Ok(OpenOutcome::Stream {
                response,
                resumed_bytes: 0,
                total_bytes: content_length,
            });
        }
        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            return Ok(OpenOutcome::RangeRefused);
        }
        anyhow::bail!(
            "image download refused with HTTP {} for {digest}",
            status.as_u16()
        );
    }
}

fn header_u64(headers: &HeaderMap, name: HeaderName) -> Option<u64> {
    headers
        .get(name)
        .and_then(|value: &HeaderValue| value.to_str().ok())
        .and_then(|value| value.trim().parse().ok())
}

/// Parse one `Content-Range: bytes <start>-<end>/<total|*>` value.
pub fn parse_content_range(value: &str) -> Option<(u64, u64, Option<u64>)> {
    let rest = value.strip_prefix("bytes ")?;
    let (range, total) = rest.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let start = start.parse().ok()?;
    let end = end.parse().ok()?;
    if end < start {
        return None;
    }
    let total = if total == "*" {
        None
    } else {
        Some(total.parse().ok()?)
    };
    Some((start, end, total))
}

#[cfg(test)]
mod tests {
    use super::*;
    use httptest::{matchers::*, Expectation, Server};

    fn grant(server: &Server, path: &str) -> DownloadGrant {
        DownloadGrant {
            url: server.url(path).to_string(),
            token: "scoped-token".to_string(),
        }
    }

    #[test]
    fn content_range_parsing_accepts_known_and_unknown_totals() {
        assert_eq!(
            parse_content_range("bytes 12-47/48"),
            Some((12, 47, Some(48)))
        );
        assert_eq!(parse_content_range("bytes 0-99/*"), Some((0, 99, None)));
        assert_eq!(parse_content_range("bytes 47-12/48"), None);
        assert_eq!(parse_content_range("items 0-1/2"), None);
    }

    #[tokio::test]
    async fn a_full_response_is_planned_from_byte_zero() {
        let body = vec![1_u8; 1024];
        let server = Server::run();
        server.expect(
            Expectation::matching(request::method_path("GET", "/blobs/a"))
                .times(1)
                .respond_with(
                    httptest::http::Response::builder()
                        .status(200)
                        .header("content-length", body.len())
                        .body(body)
                        .unwrap(),
                ),
        );
        let client = TransferClient::new().unwrap();
        let outcome = client
            .open(
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                &grant(&server, "/blobs/a"),
                0,
                DEFAULT_MAX_OBJECT_BYTES,
            )
            .await
            .unwrap();
        match outcome {
            OpenOutcome::Stream {
                resumed_bytes,
                total_bytes,
                ..
            } => {
                assert_eq!(resumed_bytes, 0);
                assert_eq!(total_bytes, Some(1024));
            }
            OpenOutcome::RangeRefused => panic!("a 200 is not a refused range"),
        }
    }

    #[tokio::test]
    async fn a_resumed_response_must_match_the_requested_range_exactly() {
        let server = Server::run();
        server.expect(
            Expectation::matching(all_of![
                request::method_path("GET", "/blobs/b"),
                request::headers(contains(("range", "bytes=8-"))),
            ])
            .times(1)
            .respond_with(
                httptest::http::Response::builder()
                    .status(206)
                    .header("content-range", "bytes 4-15/16")
                    .body(vec![0_u8; 12])
                    .unwrap(),
            ),
        );
        let client = TransferClient::new().unwrap();
        let error = client
            .open(
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                &grant(&server, "/blobs/b"),
                8,
                DEFAULT_MAX_OBJECT_BYTES,
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("resume range starts at 4"), "{error}");
    }

    #[tokio::test]
    async fn an_oversized_declared_total_is_refused_before_reading() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: 4096\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            stream.write_all(&[0_u8; 16]).unwrap();
            stream.flush().unwrap();
        });
        let client = TransferClient::new().unwrap();
        let grant = DownloadGrant {
            url: format!("http://{address}/blobs/c"),
            token: "t".to_string(),
        };
        let error = client
            .open(
                "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                &grant,
                0,
                1024,
            )
            .await
            .unwrap_err()
            .to_string();
        server.join().unwrap();
        assert!(error.contains("transfer bound"), "{error}");
    }

    #[tokio::test]
    async fn a_refused_range_is_reported_not_treated_as_bytes() {
        let server = Server::run();
        server.expect(
            Expectation::matching(request::method_path("GET", "/blobs/d"))
                .times(1)
                .respond_with(
                    httptest::http::Response::builder()
                        .status(416)
                        .body(Vec::new())
                        .unwrap(),
                ),
        );
        let client = TransferClient::new().unwrap();
        assert!(matches!(
            client
                .open(
                    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
                    &grant(&server, "/blobs/d"),
                    9,
                    DEFAULT_MAX_OBJECT_BYTES,
                )
                .await
                .unwrap(),
            OpenOutcome::RangeRefused
        ));
    }

    #[tokio::test]
    async fn a_missing_token_or_non_http_route_never_reaches_the_network() {
        let client = TransferClient::new().unwrap();
        let digest = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        let no_token = DownloadGrant {
            url: "http://127.0.0.1:9/blobs/x".to_string(),
            token: String::new(),
        };
        assert!(client
            .open(digest, &no_token, 0, DEFAULT_MAX_OBJECT_BYTES)
            .await
            .unwrap_err()
            .to_string()
            .contains("no token"));
        let bad_route = DownloadGrant {
            url: "file:///etc/passwd".to_string(),
            token: "t".to_string(),
        };
        assert!(client
            .open(digest, &bad_route, 0, DEFAULT_MAX_OBJECT_BYTES)
            .await
            .unwrap_err()
            .to_string()
            .contains("http(s) URL"));
    }
}
