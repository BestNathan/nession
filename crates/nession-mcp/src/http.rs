//! A minimal HTTP/1.1 front door for MCP Streamable HTTP.
//!
//! A hosting Server/Agent already owns a TCP (optionally TLS) listener whose
//! next step is a WebSocket upgrade. MCP needs a *second* HTTP route on that
//! same listener without a second port and without a framework change to the
//! handshake that carries terminal traffic.
//!
//! [`sniff`] reads exactly one request head with a bounded deadline, then:
//!
//! * for a WebSocket upgrade, returns a [`PrefixedStream`] that replays the
//!   consumed bytes, so the host's existing tungstenite handshake — including
//!   its credential callback — runs unchanged;
//! * for anything else, parses the head and leaves the body for
//!   [`RequestHead`] consumers.
//!
//! It is deliberately **not a general HTTP server**: one request per
//! connection, `Connection: close`, no pipelining. MCP clients send a single
//! JSON-RPC request (or batch) per POST, which is the whole workload here.

use std::fmt;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader,
    ReadBuf,
};

/// Upper bound on a request head.
pub const MAX_HEADER_BYTES: usize = 16 * 1024;

/// Upper bound on a request body.
pub const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// How long a peer may take to send a request head or body.
pub const DEFAULT_IO_TIMEOUT: Duration = Duration::from_secs(10);

/// A stream whose first reads come from `prefix` and then from `inner`.
///
/// Used to replay the HTTP head to tungstenite, and to hand a buffered body to
/// the MCP handler after `BufReader` read ahead.
pub struct PrefixedStream<S> {
    prefix: Vec<u8>,
    cursor: usize,
    inner: S,
}

impl<S> PrefixedStream<S> {
    /// Wrap `inner`, serving `prefix` first.
    pub fn new(prefix: Vec<u8>, inner: S) -> Self {
        Self {
            prefix,
            cursor: 0,
            inner,
        }
    }

    /// The bytes that have not been replayed yet.
    pub fn remaining_prefix(&self) -> &[u8] {
        self.prefix.get(self.cursor..).unwrap_or(&[])
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for PrefixedStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.cursor < self.prefix.len() {
            let remaining = self.prefix.get(self.cursor..).unwrap_or(&[]);
            let take = remaining.len().min(buf.remaining());
            let chunk = remaining.get(..take).unwrap_or(&[]);
            buf.put_slice(chunk);
            self.cursor += chunk.len();
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for PrefixedStream<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write_vectored(cx, bufs)
    }
}

/// What one accepted connection turned out to be.
pub enum Sniffed<S> {
    /// A WebSocket upgrade request; the stream replays the head so the host's
    /// existing handshake can parse it.
    WebSocket {
        /// The replayed stream.
        stream: PrefixedStream<S>,
    },
    /// A non-upgrade HTTP request; the body starts with whatever the reader
    /// had already buffered.
    Http {
        /// The parsed request head.
        head: RequestHead,
        /// The body stream.
        body: PrefixedStream<S>,
    },
}

/// A parsed HTTP/1.1 request head.
#[derive(Debug, Clone)]
pub struct RequestHead {
    /// `GET`, `POST`, `DELETE`, …
    pub method: String,
    /// The request target as sent (path plus optional query).
    pub target: String,
    /// The protocol version token.
    pub version: String,
    /// Lower-cased header names and their values.
    pub headers: Vec<(String, String)>,
}

impl RequestHead {
    /// The path portion of the target.
    pub fn path(&self) -> &str {
        self.target
            .split('?')
            .next()
            .unwrap_or(self.target.as_str())
    }

    /// A header value, case-insensitively.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == &name.to_ascii_lowercase())
            .map(|(_, value)| value.as_str())
    }

    /// The declared `Content-Length`, if any.
    pub fn content_length(&self) -> Result<Option<usize>, HttpError> {
        let Some(raw) = self.header("content-length") else {
            return Ok(None);
        };
        let length = raw
            .parse::<usize>()
            .map_err(|_| HttpError::BadRequest("invalid Content-Length"))?;
        if length > MAX_BODY_BYTES {
            return Err(HttpError::BodyTooLarge);
        }
        Ok(Some(length))
    }

    /// Whether the body uses chunked transfer coding.
    pub fn is_chunked(&self) -> bool {
        self.header("transfer-encoding")
            .map(|value| {
                value
                    .split(',')
                    .any(|part| part.trim().eq_ignore_ascii_case("chunked"))
            })
            .unwrap_or(false)
    }

    /// Whether the request asks for a WebSocket upgrade.
    pub fn is_websocket_upgrade(&self) -> bool {
        self.header("upgrade")
            .map(|value| value.eq_ignore_ascii_case("websocket"))
            .unwrap_or(false)
            || self.header("sec-websocket-key").is_some()
    }

    fn parse(head: &[u8]) -> Result<Self, HttpError> {
        let text = std::str::from_utf8(head)
            .map_err(|_| HttpError::BadRequest("request head is not UTF-8"))?;
        let mut lines = text.split("\r\n");
        let request_line = lines
            .next()
            .ok_or(HttpError::BadRequest("missing request line"))?;
        let mut parts = request_line.split_whitespace();
        let method = parts
            .next()
            .ok_or(HttpError::BadRequest("missing method"))?;
        let target = parts
            .next()
            .ok_or(HttpError::BadRequest("missing request target"))?;
        let version = parts
            .next()
            .ok_or(HttpError::BadRequest("missing HTTP version"))?;
        if !version.starts_with("HTTP/1.") {
            return Err(HttpError::BadRequest("unsupported HTTP version"));
        }
        let mut headers = Vec::new();
        for line in lines {
            if line.is_empty() {
                break;
            }
            let (name, value) = line
                .split_once(':')
                .ok_or(HttpError::BadRequest("malformed header line"))?;
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
        Ok(Self {
            method: method.to_string(),
            target: target.to_string(),
            version: version.to_string(),
            headers,
        })
    }
}

/// Why a request could not be served.
#[derive(Debug)]
pub enum HttpError {
    /// The transport failed.
    Io(io::Error),
    /// The peer did not send a request within the bound.
    Timeout,
    /// The request is not valid HTTP/1.1.
    BadRequest(&'static str),
    /// The head is larger than [`MAX_HEADER_BYTES`].
    HeaderTooLarge,
    /// The body is larger than [`MAX_BODY_BYTES`].
    BodyTooLarge,
}

impl fmt::Display for HttpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "HTTP transport error: {error}"),
            Self::Timeout => write!(formatter, "the peer did not send a request in time"),
            Self::BadRequest(message) => write!(formatter, "bad HTTP request: {message}"),
            Self::HeaderTooLarge => write!(formatter, "HTTP request head is too large"),
            Self::BodyTooLarge => write!(formatter, "HTTP request body is too large"),
        }
    }
}

impl std::error::Error for HttpError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for HttpError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// Read one request head, bounded by [`MAX_HEADER_BYTES`].
async fn read_head<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Vec<u8>, HttpError> {
    let mut head = Vec::new();
    loop {
        let mut line = Vec::new();
        let read = reader.read_until(b'\n', &mut line).await?;
        if read == 0 {
            return Err(HttpError::BadRequest(
                "connection closed inside the request head",
            ));
        }
        head.extend_from_slice(&line);
        if head.len() > MAX_HEADER_BYTES {
            return Err(HttpError::HeaderTooLarge);
        }
        if line == b"\r\n" || line == b"\n" {
            return Ok(head);
        }
    }
}

/// Read one request head and classify the connection.
///
/// The head (and anything the buffered reader pulled ahead) is replayed on the
/// WebSocket path, so the host's handshake sees the exact bytes it expects.
pub async fn sniff<S>(stream: S, deadline: Duration) -> Result<Sniffed<S>, HttpError>
where
    S: AsyncRead + Unpin,
{
    let mut reader = BufReader::new(stream);
    let head = match tokio::time::timeout(deadline, read_head(&mut reader)).await {
        Ok(result) => result?,
        Err(_) => return Err(HttpError::Timeout),
    };
    let leftover = reader.buffer().to_vec();
    let inner = reader.into_inner();
    let parsed = RequestHead::parse(&head)?;

    if parsed.is_websocket_upgrade() {
        let mut replay = head;
        replay.extend_from_slice(&leftover);
        Ok(Sniffed::WebSocket {
            stream: PrefixedStream::new(replay, inner),
        })
    } else {
        Ok(Sniffed::Http {
            head: parsed,
            body: PrefixedStream::new(leftover, inner),
        })
    }
}

async fn read_body_line<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Vec<u8>, HttpError> {
    let mut line = Vec::new();
    let read = reader.read_until(b'\n', &mut line).await?;
    if read == 0 {
        return Err(HttpError::BadRequest("connection closed inside the body"));
    }
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    Ok(line)
}

async fn read_chunked<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Vec<u8>, HttpError> {
    let mut body = Vec::new();
    loop {
        let line = read_body_line(reader).await?;
        let size_text =
            std::str::from_utf8(&line).map_err(|_| HttpError::BadRequest("invalid chunk size"))?;
        let size = usize::from_str_radix(size_text.trim(), 16)
            .map_err(|_| HttpError::BadRequest("invalid chunk size"))?;
        if size == 0 {
            // Consume trailers through the terminating empty line.
            loop {
                let trailer = read_body_line(reader).await?;
                if trailer.is_empty() {
                    return Ok(body);
                }
            }
        }
        if body.len().saturating_add(size) > MAX_BODY_BYTES {
            return Err(HttpError::BodyTooLarge);
        }
        let mut chunk = vec![0u8; size];
        reader.read_exact(&mut chunk).await?;
        body.extend_from_slice(&chunk);
        let mut terminator = [0u8; 2];
        reader.read_exact(&mut terminator).await?;
        if terminator != *b"\r\n" {
            return Err(HttpError::BadRequest("missing chunk terminator"));
        }
    }
}

/// Read the full body described by `head`.
pub async fn read_body<S>(
    stream: &mut S,
    head: &RequestHead,
    deadline: Duration,
) -> Result<Vec<u8>, HttpError>
where
    S: AsyncRead + Unpin,
{
    let mut reader = BufReader::new(stream);
    let body = if head.is_chunked() {
        tokio::time::timeout(deadline, read_chunked(&mut reader))
            .await
            .map_err(|_| HttpError::Timeout)??
    } else if let Some(length) = head.content_length()? {
        let mut body = vec![0u8; length];
        tokio::time::timeout(deadline, reader.read_exact(&mut body))
            .await
            .map_err(|_| HttpError::Timeout)??;
        body
    } else {
        Vec::new()
    };
    Ok(body)
}

/// A response to write back.
#[derive(Debug, Clone)]
pub struct Response {
    /// HTTP status code.
    pub status: u16,
    /// Content type; empty for no body.
    pub content_type: &'static str,
    /// Extra response headers.
    pub headers: Vec<(String, String)>,
    /// The body.
    pub body: Vec<u8>,
}

impl Response {
    /// A JSON response.
    pub fn json(status: u16, body: Vec<u8>) -> Self {
        Self {
            status,
            content_type: "application/json",
            headers: Vec::new(),
            body,
        }
    }

    /// An empty response with a status.
    pub fn empty(status: u16) -> Self {
        Self {
            status,
            content_type: "",
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    /// Add one header.
    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        _ => "Error",
    }
}

/// Write one response and close the logical exchange.
pub async fn write_response<S>(stream: &mut S, response: Response) -> io::Result<()>
where
    S: AsyncWrite + Unpin,
{
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: close\r\n",
        response.status,
        reason_phrase(response.status),
        response.body.len()
    );
    if !response.content_type.is_empty() {
        head.push_str("Content-Type: ");
        head.push_str(response.content_type);
        head.push_str("\r\n");
    }
    for (name, value) in &response.headers {
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await?;
    if !response.body.is_empty() {
        stream.write_all(&response.body).await?;
    }
    stream.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn sniff_bytes(bytes: &[u8]) -> Sniffed<&[u8]> {
        sniff(bytes, Duration::from_secs(1)).await.expect("sniff")
    }

    #[tokio::test]
    async fn a_websocket_upgrade_replays_the_head() {
        let request = b"GET /ws?token=secret HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n\r\n";
        match sniff_bytes(request).await {
            Sniffed::WebSocket { stream } => {
                assert_eq!(stream.remaining_prefix(), request);
            }
            Sniffed::Http { .. } => panic!("an upgrade must be a WebSocket request"),
        }
    }

    #[tokio::test]
    async fn a_post_keeps_its_body_after_the_head() {
        let request = b"POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\n\r\nbody";
        match sniff_bytes(request).await {
            Sniffed::Http { head, mut body } => {
                assert_eq!(head.method, "POST");
                assert_eq!(head.path(), "/mcp");
                assert_eq!(head.content_length().expect("length"), Some(4));
                let mut rest = Vec::new();
                body.read_to_end(&mut rest).await.expect("read body");
                assert_eq!(rest, b"body");
            }
            Sniffed::WebSocket { .. } => panic!("a POST is not an upgrade"),
        }
    }

    #[tokio::test]
    async fn a_chunked_body_is_decoded() {
        let request =
            b"POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nbody\r\n0\r\n\r\n";
        match sniff_bytes(request).await {
            Sniffed::Http { head, mut body } => {
                assert!(head.is_chunked());
                let decoded = read_body(&mut body, &head, Duration::from_secs(1))
                    .await
                    .expect("body");
                assert_eq!(decoded, b"body");
            }
            Sniffed::WebSocket { .. } => panic!("a POST is not an upgrade"),
        }
    }

    #[tokio::test]
    async fn a_head_larger_than_the_bound_is_refused() {
        let huge = format!(
            "GET /ws HTTP/1.1\r\nX: {}\r\n\r\n",
            "a".repeat(MAX_HEADER_BYTES)
        );
        let outcome = sniff(huge.as_bytes(), Duration::from_secs(1)).await;
        assert!(matches!(outcome, Err(HttpError::HeaderTooLarge)));
    }

    #[tokio::test]
    async fn a_bad_request_line_is_refused() {
        let outcome = sniff(&b"nonsense\r\n\r\n"[..], Duration::from_secs(1)).await;
        assert!(matches!(outcome, Err(HttpError::BadRequest(_))));
    }
}
