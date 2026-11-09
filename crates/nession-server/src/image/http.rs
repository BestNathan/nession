//! Authorized HTTP(S) blob streaming for the Image Manager (#3022).
//!
//! The Server's existing listener already sniffs one HTTP request head. This
//! service takes only `/images/blobs/<digest>` and answers with digest-bound
//! bytes: `Range`/`ETag`/`Accept-Ranges`, explicit 403/404/416, and a scoped
//! bearer grant that is rechecked against the exact digest.

use std::io;
use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt};

use nession_mcp::http::{PrefixedStream, RequestHead};
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

    /// Serve one HTTP request. The connection is closed after the response.
    pub async fn serve<S>(&self, head: RequestHead, mut stream: PrefixedStream<S>) -> io::Result<()>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        let Some(raw_digest) = head.path().strip_prefix(IMAGE_BLOB_PATH_PREFIX) else {
            return write_status(&mut stream, 404, "Not Found", &[]).await;
        };
        if raw_digest.is_empty() || raw_digest.contains('/') {
            return write_status(&mut stream, 404, "Not Found", &[]).await;
        }
        if head.method != "GET" && head.method != "HEAD" {
            return write_status(
                &mut stream,
                405,
                "Method Not Allowed",
                &[("Allow", "GET, HEAD")],
            )
            .await;
        }
        let size = match self.manager.ready_blob(raw_digest).await {
            Ok(size) => size,
            Err(ImageError::NotFound(_)) => {
                return write_status(&mut stream, 404, "Not Found", &[]).await;
            }
            Err(_) => return write_status(&mut stream, 503, "Service Unavailable", &[]).await,
        };
        let token = head
            .header("authorization")
            .and_then(|value| value.strip_prefix("Bearer "))
            .or_else(|| {
                head.header("authorization")
                    .and_then(|value| value.strip_prefix("bearer "))
            });
        let Some(token) = token else {
            return write_status(
                &mut stream,
                403,
                "Forbidden",
                &[("WWW-Authenticate", "Bearer")],
            )
            .await;
        };
        if self.manager.authorize(token, raw_digest).await.is_err() {
            return write_status(
                &mut stream,
                403,
                "Forbidden",
                &[("WWW-Authenticate", "Bearer")],
            )
            .await;
        }
        let etag = format!("\"{raw_digest}\"");
        if head
            .header("if-none-match")
            .is_some_and(|value| value.trim() == etag)
        {
            return write_status(
                &mut stream,
                304,
                "Not Modified",
                &[("ETag", etag.as_str()), ("Accept-Ranges", "bytes")],
            )
            .await;
        }
        let range = match parse_range(head.header("range"), size) {
            Ok(range) => range,
            Err(()) => {
                let content_range = format!("bytes */{size}");
                return write_status(
                    &mut stream,
                    416,
                    "Range Not Satisfiable",
                    &[
                        ("Content-Range", content_range.as_str()),
                        ("Accept-Ranges", "bytes"),
                    ],
                )
                .await;
            }
        };
        let (start, length) = match range {
            Some((start, end)) => (start, end - start + 1),
            None => (0, size),
        };
        let _guard = self.manager.begin_transfer(raw_digest);
        let status = if start == 0 && length == size {
            "200 OK"
        } else {
            "206 Partial Content"
        };
        let content_length = length.to_string();
        let mut head_bytes = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {content_length}\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\nETag: {etag}\r\nX-Nession-Image-Digest: {raw_digest}\r\nConnection: close\r\n"
        );
        if status == "206 Partial Content" {
            head_bytes.push_str(&format!(
                "Content-Range: bytes {}-{}/{size}\r\n",
                start,
                start + length - 1
            ));
        }
        head_bytes.push_str("\r\n");
        stream.write_all(head_bytes.as_bytes()).await?;
        if head.method == "HEAD" || length == 0 {
            stream.flush().await?;
            return Ok(());
        }
        let file = self
            .manager
            .open_blob(raw_digest)
            .map_err(|error| io::Error::other(format!("blob open failed: {error:#}")))?;
        let mut file = tokio::fs::File::from_std(file);
        if start > 0 {
            file.seek(io::SeekFrom::Start(start)).await?;
        }
        let mut limited = file.take(length);
        tokio::io::copy(&mut limited, &mut stream).await?;
        stream.flush().await?;
        Ok(())
    }
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

async fn write_status<S>(
    stream: &mut PrefixedStream<S>,
    code: u16,
    reason: &str,
    extra_headers: &[(&str, &str)],
) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut head =
        format!("HTTP/1.1 {code} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n");
    for (name, value) in extra_headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await?;
    stream.flush().await
}
