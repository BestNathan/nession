//! Authorized HTTP(S) blob streaming for the Image Manager (#3022).
//!
//! The Server's Axum router maps `/images/blobs/<digest>` here. The handler
//! answers with digest-bound bytes: `Range`/`ETag`/`Accept-Ranges`, explicit
//! 403/404/416, and a scoped bearer grant that is rechecked against the exact
//! digest. The response body is a streaming Axum body over the blob file; no
//! raw HTTP head is written by this module.

use std::io;
use std::sync::Arc;

use axum::body::Body;
use axum::http::header::{self, HeaderMap};
use axum::http::{Method, StatusCode};
use axum::response::Response;
use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use nession_protocol::contracts::image::v1::IMAGE_BLOB_PATH_PREFIX;

use super::{ImageError, ImageManager};

/// One HTTP response writer for the image blob route.
#[derive(Clone)]
pub struct ImageHttpService {
    manager: Arc<ImageManager>,
}

impl ImageHttpService {
    pub fn new(manager: Arc<ImageManager>) -> Self {
        Self { manager }
    }

    /// Answer one blob request.
    ///
    /// Routing and method selection have already happened in the Axum router
    /// (`GET`/`HEAD` are the only registered methods); the checks here are the
    /// authorization and byte-range semantics the route promises.
    pub async fn respond(
        &self,
        method: &Method,
        raw_digest: &str,
        headers: &HeaderMap,
    ) -> Response {
        if raw_digest.is_empty() || raw_digest.contains('/') {
            return status(StatusCode::NOT_FOUND, &[]);
        }
        if method != Method::GET && method != Method::HEAD {
            return status(StatusCode::METHOD_NOT_ALLOWED, &[("Allow", "GET, HEAD")]);
        }
        let size = match self.manager.ready_blob(raw_digest).await {
            Ok(size) => size,
            Err(ImageError::NotFound(_)) => return status(StatusCode::NOT_FOUND, &[]),
            Err(_) => return status(StatusCode::SERVICE_UNAVAILABLE, &[]),
        };
        let token = bearer_token(headers);
        let Some(token) = token else {
            return status(StatusCode::FORBIDDEN, &[("WWW-Authenticate", "Bearer")]);
        };
        if self.manager.authorize(token, raw_digest).await.is_err() {
            return status(StatusCode::FORBIDDEN, &[("WWW-Authenticate", "Bearer")]);
        }
        let etag = format!("\"{raw_digest}\"");
        if headers
            .get(header::IF_NONE_MATCH)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.trim() == etag)
        {
            return status(
                StatusCode::NOT_MODIFIED,
                &[("ETag", etag.as_str()), ("Accept-Ranges", "bytes")],
            );
        }
        let range = match parse_range(range_header(headers), size) {
            Ok(range) => range,
            Err(()) => {
                let content_range = format!("bytes */{size}");
                return status(
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    &[
                        ("Content-Range", content_range.as_str()),
                        ("Accept-Ranges", "bytes"),
                    ],
                );
            }
        };
        let (start, length) = match range {
            Some((start, end)) => (start, end - start + 1),
            None => (0, size),
        };
        let partial = !(start == 0 && length == size);
        let content_length = length.to_string();
        let content_range =
            partial.then(|| format!("bytes {}-{}/{size}", start, start + length - 1));
        let mut response = Response::builder()
            .status(if partial {
                StatusCode::PARTIAL_CONTENT
            } else {
                StatusCode::OK
            })
            .header(header::CONTENT_LENGTH, content_length)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::ETAG, etag.as_str())
            .header("X-Nession-Image-Digest", raw_digest);
        if let Some(content_range) = content_range.as_deref() {
            response = response.header(header::CONTENT_RANGE, content_range);
        }

        if method == Method::HEAD || length == 0 {
            return response
                .body(Body::empty())
                .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR, &[]));
        }

        // The transfer guard lives as long as the body stream, so GC cannot
        // reclaim a digest that is still being read.
        let guard = self.manager.begin_transfer(raw_digest);
        let file = match self.manager.open_blob(raw_digest) {
            Ok(file) => file,
            Err(_) => return status(StatusCode::SERVICE_UNAVAILABLE, &[]),
        };
        let mut file = tokio::fs::File::from_std(file);
        if start > 0 && file.seek(io::SeekFrom::Start(start)).await.is_err() {
            return status(StatusCode::SERVICE_UNAVAILABLE, &[]);
        }
        let limited = file.take(length);
        let stream = tokio_util::io::ReaderStream::new(limited).map(move |chunk| {
            let _guard = &guard;
            chunk
        });
        response
            .body(Body::from_stream(stream))
            .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR, &[]))
    }
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
}

fn range_header(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
}

/// A bodyless response with the given headers.
fn status(code: StatusCode, headers: &[(&str, &str)]) -> Response {
    let mut response = Response::builder().status(code);
    for (name, value) in headers {
        response = response.header(*name, *value);
    }
    response
        .body(Body::empty())
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

/// `None` means the whole entity; `Some((start, end))` is inclusive.
fn parse_range(header: Option<&str>, size: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(value) = header else {
        return Ok(None);
    };
    let Some(spec) = value.trim().strip_prefix("bytes=") else {
        return Err(());
    };
    if spec.contains(',') || size == 0 {
        return Err(());
    }
    let (start_raw, end_raw) = spec.split_once('-').ok_or(())?;
    if start_raw.is_empty() {
        let suffix = end_raw.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        let start = size.saturating_sub(suffix);
        return Ok(Some((start, size - 1)));
    }
    let start = start_raw.parse::<u64>().map_err(|_| ())?;
    if start >= size {
        return Err(());
    }
    let end = if end_raw.is_empty() {
        size - 1
    } else {
        end_raw.parse::<u64>().map_err(|_| ())?.min(size - 1)
    };
    if end < start {
        return Err(());
    }
    Ok(Some((start, end)))
}

/// The route pattern the Server mounts for authorized blob reads.
pub fn blob_route() -> String {
    format!("{IMAGE_BLOB_PATH_PREFIX}{{digest}}")
}
