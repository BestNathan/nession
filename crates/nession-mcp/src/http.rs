//! The standalone MCP host's front door (`#3264`).
//!
//! The standalone `nession-mcp` binary owns a TCP (optionally TLS) listener
//! that only serves MCP. [`sniff`] reads exactly one request head with a
//! bounded deadline, then:
//!
//! * for a WebSocket upgrade, returns a [`PrefixedStream`] that replays the
//!   consumed bytes, so the host can answer with an explicit 400;
//! * for anything else, returns the parsed head **and** a stream that replays
//!   the head plus any buffered bytes, so the HTTP/1.1 connection driver sees
//!   the original request exactly once.
//!
//! Embedded Server/Agent hosts do not use this module: their Axum router owns
//! the HTTP grammar and mounts [`crate::McpService::handle`] as a route
//! (`#3439`).
//!
//! The HTTP grammar itself is hyper's; this module only classifies one head.

use std::fmt;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader, ReadBuf,
};

/// Upper bound on a request head.
pub const MAX_HEADER_BYTES: usize = 16 * 1024;

/// How long a peer may take to send a request head.
pub const DEFAULT_IO_TIMEOUT: Duration = Duration::from_secs(10);

/// A stream whose first reads come from `prefix` and then from `inner`.
///
/// Used to replay the sniffed request to the HTTP connection driver (and the
/// WebSocket handshake, on the upgrade path).
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
    /// A non-upgrade HTTP request; the stream replays the head and body.
    Http {
        /// The parsed request head, for host routing and logging.
        head: RequestHead,
        /// The replayed stream.
        stream: PrefixedStream<S>,
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
        let wanted = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(key, _)| key == &wanted)
            .map(|(_, value)| value.as_str())
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

/// Why a connection could not be classified.
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
}

impl fmt::Display for HttpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "HTTP transport error: {error}"),
            Self::Timeout => write!(formatter, "the peer did not send a request in time"),
            Self::BadRequest(message) => write!(formatter, "bad HTTP request: {message}"),
            Self::HeaderTooLarge => write!(formatter, "HTTP request head is too large"),
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
///
/// The budget is enforced while each buffered chunk is consumed, not after a
/// whole line has been read: a line is refused as soon as its next chunk would
/// push the head past the limit, so an unterminated line is never retained in
/// full. `sniff`'s fixed-capacity `BufReader` also bounds look-ahead.
async fn read_head<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Vec<u8>, HttpError> {
    let mut head = Vec::new();
    let mut line_start = 0;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Err(HttpError::BadRequest(
                "connection closed inside the request head",
            ));
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(available.len(), |index| index.saturating_add(1));
        if take > MAX_HEADER_BYTES.saturating_sub(head.len()) {
            return Err(HttpError::HeaderTooLarge);
        }
        if let Some(chunk) = available.get(..take) {
            head.extend_from_slice(chunk);
        }
        reader.consume(take);
        if newline.is_some() {
            let line = head.get(line_start..).unwrap_or(&[]);
            if line == b"\n" || line == b"\r\n" {
                return Ok(head);
            }
            line_start = head.len();
        }
    }
}

/// Read one request head and classify the connection.
///
/// The consumed bytes (the head and anything the buffered reader pulled ahead)
/// are replayed on **both** paths, so the WebSocket handshake and the HTTP
/// connection driver each see the exact request.
pub async fn sniff<S>(stream: S, deadline: Duration) -> Result<Sniffed<S>, HttpError>
where
    S: AsyncRead + Unpin,
{
    let mut reader = BufReader::new(stream);
    let mut head = match tokio::time::timeout(deadline, read_head(&mut reader)).await {
        Ok(result) => result?,
        Err(_) => return Err(HttpError::Timeout),
    };
    let leftover = reader.buffer().to_vec();
    let inner = reader.into_inner();
    let parsed = RequestHead::parse(&head)?;
    head.extend_from_slice(&leftover);
    let replay = PrefixedStream::new(head, inner);

    if parsed.is_websocket_upgrade() {
        Ok(Sniffed::WebSocket { stream: replay })
    } else {
        Ok(Sniffed::Http {
            head: parsed,
            stream: replay,
        })
    }
}

/// Write a bare status response on a stream the host has decided not to serve
/// (for example a WebSocket upgrade offered to a standalone MCP-only port).
pub async fn write_status<S>(stream: &mut S, status: u16, reason: &str) -> io::Result<()>
where
    S: AsyncWrite + Unpin,
{
    let head =
        format!("HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    stream.write_all(head.as_bytes()).await?;
    stream.flush().await
}
