//! The accepted-connection HTTP ingress both runtimes serve (`#3439`).
//!
//! Axum owns HTTP routing and the WebSocket Upgrade; this module owns the
//! part that has to be identical in the Server and the Agent:
//!
//! * one accepted TCP (or TLS) socket is served by one Axum [`Router`];
//! * the connection holds a *pre-authentication admission slot* until the
//!   request that ends its unauthenticated window arrives, and releasing that
//!   slot is what disarms the handshake deadline;
//! * a peer that sends nothing, half a TLS record, or half a request line is
//!   closed at that deadline rather than holding a task and a socket forever.
//!
//! The business handlers stay in the host crates. The only transport detail
//! this module imposes on them is [`AxumWebSocket`], which adapts Axum's
//! WebSocket to the transport-neutral [`crate::frame::WsFrame`] the Server and
//! Agent dispatchers speak (`#3548`), so neither the HTTP owner nor the
//! business runtime names the other's protocol type.

use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::extract::ws::{CloseFrame as AxumCloseFrame, Message as AxumMessage, WebSocket};
use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use axum::Router;
use futures_util::{Sink, Stream};
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::OwnedSemaphorePermit;
use tokio_rustls::server::TlsStream;
use tracing::warn;

use crate::frame::{WsCloseFrame, WsFrame};
use crate::metrics::{self, Direction, Domain, Labels};

/// Physical connections currently served by this runtime process.
static ACTIVE_CONNECTIONS: AtomicI64 = AtomicI64::new(0);

/// Count one accepted physical socket while it is being served, and publish the
/// process-wide active gauge on both ends.
struct ActiveConnection;

impl ActiveConnection {
    fn new() -> Self {
        metrics::counter(
            "ws_connection_attempts",
            Labels::new()
                .domain(Domain::Lifecycle)
                .direction(Direction::Inbound),
        );
        let active = ACTIVE_CONNECTIONS.fetch_add(1, Ordering::Relaxed) + 1;
        metrics::gauge(
            "ws_connection_active",
            Labels::new().domain(Domain::Lifecycle),
            active as f64,
        );
        Self
    }
}

impl Drop for ActiveConnection {
    fn drop(&mut self) {
        let active = ACTIVE_CONNECTIONS.fetch_sub(1, Ordering::Relaxed) - 1;
        metrics::gauge(
            "ws_connection_active",
            Labels::new().domain(Domain::Lifecycle),
            active.max(0) as f64,
        );
    }
}

/// The plain or TLS stream one accepted socket carries.
///
/// One enum rather than two connection drivers: TLS is a property of the
/// socket, not a second HTTP path, and the handshake deadline has to cover it
/// together with the request that follows.
pub enum TcpOrTls {
    Plain(TcpStream),
    /// Boxed because the rustls stream is over a kilobyte and every accepted
    /// plain socket would otherwise carry that size.
    Tls(Box<TlsStream<TcpStream>>),
}

impl TcpOrTls {
    /// Complete the optional TLS handshake on an accepted socket.
    pub async fn accept(
        stream: TcpStream,
        acceptor: Option<tokio_rustls::TlsAcceptor>,
    ) -> io::Result<Self> {
        match acceptor {
            Some(acceptor) => acceptor
                .accept(stream)
                .await
                .map(|stream| Self::Tls(Box::new(stream)))
                .map_err(io::Error::other),
            None => Ok(Self::Plain(stream)),
        }
    }
}

impl AsyncRead for TcpOrTls {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_read(cx, buf),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for TcpOrTls {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_write(cx, buf),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_flush(cx),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_shutdown(cx),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_shutdown(cx),
        }
    }
}

/// One connection's pre-authentication admission claim.
///
/// The slot is acquired at `accept` and released exactly once, by the handler
/// that ends the unauthenticated window (the WebSocket upgrade decision, or
/// the first routed HTTP request). Releasing it also disarms
/// [`serve`]'s handshake deadline: after that point the connection is a peer
/// or a served request, not pending work.
///
/// `Clone` shares the same claim; the drop of the underlying permit is what
/// returns capacity to the listener's semaphore.
#[derive(Clone)]
pub struct AdmissionSlot {
    permit: Arc<Mutex<Option<OwnedSemaphorePermit>>>,
    released: Arc<AtomicBool>,
}

impl AdmissionSlot {
    /// Wrap one admission permit.
    pub fn new(permit: OwnedSemaphorePermit) -> Self {
        Self {
            permit: Arc::new(Mutex::new(Some(permit))),
            released: Arc::new(AtomicBool::new(false)),
        }
    }

    /// End the pre-authentication window and return the listener's capacity.
    ///
    /// Idempotent: a routed handler may release the slot itself and the
    /// connection's response middleware releases it again.
    pub fn release(&self) {
        if let Ok(mut held) = self.permit.lock() {
            held.take();
        }
        self.released.store(true, Ordering::Release);
    }

    /// Whether the pre-authentication window has ended.
    pub fn is_released(&self) -> bool {
        self.released.load(Ordering::Acquire)
    }
}

/// Release the admission slot once any response has been produced.
///
/// The routed handlers release the slot at their own boundary — the upgrade
/// decision or the start of a long-running request — but an extractor rejection
/// (a malformed upgrade, a non-GET method) never reaches a handler. This
/// middleware is the backstop that keeps such a request from holding the
/// listener's pre-authentication capacity until the deadline.
pub async fn release_after_response(
    State(slot): State<AdmissionSlot>,
    request: Request,
    next: Next,
) -> Response {
    let response = next.run(request).await;
    slot.release();
    response
}

/// Whether a request says it is a WebSocket upgrade.
///
/// The hosts accept upgrades at the authority root as well as at `/ws` (a
/// `ws://host:port` configured endpoint has no path), so their fallback route
/// uses this to tell an upgrade-shaped request from an ordinary unmatched one.
/// The actual handshake still belongs to Axum's extractor.
pub fn looks_like_websocket_upgrade(
    method: &axum::http::Method,
    headers: &axum::http::HeaderMap,
) -> bool {
    method == axum::http::Method::GET
        && headers
            .get(axum::http::header::UPGRADE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
}

/// Upper bound on one HTTP request head.
///
/// The old listener's sniffed head had the same bound; moving the grammar to
/// hyper keeps it rather than inheriting a larger default.
pub const MAX_REQUEST_HEAD_BYTES: usize = 16 * 1024;

/// How long one HTTP request head may take to arrive, including the wait for a
/// request on a kept-alive connection.
///
/// Hyper starts this deadline whenever it begins reading a request head and
/// disarms it when the head is complete, so it bounds:
///
/// * a partial first request after the socket is accepted;
/// * an idle keep-alive connection waiting for its next request;
/// * a partial second or later request.
///
/// It does **not** bound a request body, a long-running handler, or a streaming
/// response (SSE, a large image body): while those are in progress the
/// connection is not reading a head. This is the same 10 s parity bound the
/// standalone MCP host used before Axum owned the listener (`#3439` W1).
pub const HTTP_HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);

/// Serve one accepted socket with `router` until the connection ends.
///
/// `connect` completes the optional TLS handshake. The handshake deadline
/// covers both that and the first complete HTTP request. Once the slot is
/// released that deadline is disarmed, so a long-lived WebSocket or MCP stream
/// is never cut short by the pre-authentication bound.
///
/// `header_read_timeout` is the per-request head bound described on
/// [`HTTP_HEADER_READ_TIMEOUT`]. It is passed explicitly so a test can reach the
/// policy without waiting out a production number; both hosts pass the shared
/// constant rather than re-deriving it.
pub async fn serve<F, Fut>(
    connect: F,
    router: Router,
    slot: AdmissionSlot,
    deadline: Duration,
    header_read_timeout: Duration,
) -> io::Result<()>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = io::Result<TcpOrTls>>,
{
    let _active = ActiveConnection::new();
    let served = async move {
        let io = connect().await?;
        hyper::server::conn::http1::Builder::new()
            // The pre-authentication deadline below bounds the first head; the
            // header-read timer bounds every later head (and the idle wait for
            // one) without touching a body that is still streaming.
            .max_buf_size(MAX_REQUEST_HEAD_BYTES)
            .timer(TokioTimer::new())
            .header_read_timeout(header_read_timeout)
            .serve_connection(TokioIo::new(io), TowerToHyperService::new(router))
            .with_upgrades()
            .await
            .map_err(io::Error::other)
    };
    tokio::pin!(served);

    let expiry = tokio::time::sleep(deadline);
    tokio::pin!(expiry);

    tokio::select! {
        result = &mut served => result,
        _ = &mut expiry, if !slot.is_released() => {
            // The two ready futures can race: re-check before deciding
            // that this peer never completed a request.
            if slot.is_released() {
                served.await
            } else {
                warn!(
                    ?deadline,
                    "closing a connection that did not complete a request before the admission deadline"
                );
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "the peer did not complete a request before the admission deadline",
                ))
            }
        }
    }
}

/// An Axum WebSocket adapted to the shared, transport-neutral frame vocabulary.
///
/// The HTTP handshake, upgrade response and frame limits belong to Axum. This
/// adapter is deliberately one boundary: both runtimes keep the same
/// text/binary/ping/pong/close vocabulary ([`crate::frame::WsFrame`]) and the
/// same bounded outbound queues, so neither the ingress nor the Relay's private
/// tungstenite client leaks its message type into the business runtime.
pub struct AxumWebSocket {
    inner: WebSocket,
}

impl AxumWebSocket {
    /// Wrap an upgraded Axum WebSocket.
    pub fn new(inner: WebSocket) -> Self {
        Self { inner }
    }
}

/// What an Axum WebSocket read or write can fail with, after this adapter.
///
/// The dispatchers log or return the error; none of them match on a transport's
/// own error variants, so this carries the one fact they use — a displayable
/// description — without re-exporting Axum's error as the runtime vocabulary.
#[derive(Debug)]
pub struct WsTransportError(String);

impl WsTransportError {
    fn new(error: impl std::fmt::Display) -> Self {
        Self(error.to_string())
    }
}

impl std::fmt::Display for WsTransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for WsTransportError {}

fn adopt(message: AxumMessage) -> WsFrame {
    match message {
        AxumMessage::Text(text) => WsFrame::Text(text.as_str().to_string()),
        AxumMessage::Binary(data) => WsFrame::Binary(data.to_vec()),
        AxumMessage::Ping(data) => WsFrame::Ping(data.to_vec()),
        AxumMessage::Pong(data) => WsFrame::Pong(data.to_vec()),
        AxumMessage::Close(frame) => WsFrame::Close(frame.map(|frame| WsCloseFrame {
            code: frame.code,
            reason: frame.reason.as_str().to_string(),
        })),
    }
}

fn emit(message: WsFrame) -> AxumMessage {
    match message {
        WsFrame::Text(text) => AxumMessage::Text(text.into()),
        WsFrame::Binary(data) => AxumMessage::Binary(data.into()),
        WsFrame::Ping(data) => AxumMessage::Ping(data.into()),
        WsFrame::Pong(data) => AxumMessage::Pong(data.into()),
        WsFrame::Close(frame) => AxumMessage::Close(frame.map(|frame| AxumCloseFrame {
            code: frame.code,
            reason: frame.reason.into(),
        })),
    }
}

fn transport_error(error: axum::Error) -> WsTransportError {
    WsTransportError::new(error)
}

impl Stream for AxumWebSocket {
    type Item = Result<WsFrame, WsTransportError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.inner)
            .poll_next(cx)
            .map(|ready| ready.map(|item| item.map(adopt).map_err(transport_error)))
    }
}

impl Sink<WsFrame> for AxumWebSocket {
    type Error = WsTransportError;

    fn poll_ready(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Pin::new(&mut self.inner)
            .poll_ready(cx)
            .map_err(transport_error)
    }

    fn start_send(mut self: Pin<&mut Self>, item: WsFrame) -> Result<(), Self::Error> {
        Pin::new(&mut self.inner)
            .start_send(emit(item))
            .map_err(transport_error)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Pin::new(&mut self.inner)
            .poll_flush(cx)
            .map_err(transport_error)
    }

    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Pin::new(&mut self.inner)
            .poll_close(cx)
            .map_err(transport_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn the_adapter_is_unpin_like_the_transports_around_it() {
        fn assert_unpin<T: Unpin>() {}
        assert_unpin::<AxumWebSocket>();
        assert_unpin::<TcpOrTls>();
    }

    /// #2653/#3439 SC-03: a peer that never sends a request holds one
    /// admission slot and is closed at the deadline, and the slot comes back.
    #[tokio::test]
    async fn a_silent_peer_is_closed_at_the_deadline_and_returns_its_slot() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind a local listener");
        let addr = listener.local_addr().expect("local address");
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let permit = Arc::clone(&slots)
            .try_acquire_owned()
            .expect("one free slot");
        let slot = AdmissionSlot::new(permit);
        let served_slot = slot.clone();
        let router = Router::new().route("/", get(|| async { "ok" }));

        let client = tokio::spawn(async move { tokio::net::TcpStream::connect(addr).await });
        let (server, _) = listener.accept().await.expect("accept the client");
        let client = client.await.expect("client task").expect("connect");
        // The client sends nothing at all.

        // The header timer is deliberately longer than the admission deadline:
        // this test asserts *which* bound ended a peer that sent no head at
        // all, and two equal timers would race for that verdict.
        let result = serve(
            move || async move { Ok(TcpOrTls::Plain(server)) },
            router,
            slot,
            Duration::from_millis(100),
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(
            result.expect_err("a silent peer is bounded").kind(),
            io::ErrorKind::TimedOut
        );
        drop(client);
        assert!(
            !served_slot.is_released(),
            "the slot was never released by a request"
        );
        drop(served_slot);
        assert_eq!(
            slots.available_permits(),
            1,
            "the deadline returns the admission slot"
        );
    }

    /// A completed request releases the slot and disarms the deadline, so a
    /// keep-alive connection is not closed by the pre-authentication bound.
    #[tokio::test]
    async fn a_completed_request_releases_the_slot_and_disarms_the_deadline() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind a local listener");
        let addr = listener.local_addr().expect("local address");
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let permit = Arc::clone(&slots)
            .try_acquire_owned()
            .expect("one free slot");
        let slot = AdmissionSlot::new(permit);
        let served_slot = slot.clone();
        let router = Router::new().route("/", get(|| async { "ok" })).layer(
            axum::middleware::from_fn_with_state(slot.clone(), release_after_response),
        );

        let client = tokio::spawn(async move {
            let mut client = tokio::net::TcpStream::connect(addr).await.expect("connect");
            client
                .write_all(b"GET / HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n")
                .await
                .expect("write request");
            let mut response = Vec::new();
            client
                .read_to_end(&mut response)
                .await
                .expect("read response");
            response
        });
        let (server, _) = listener.accept().await.expect("accept the client");

        let result = tokio::time::timeout(
            Duration::from_secs(2),
            serve(
                move || async move { Ok(TcpOrTls::Plain(server)) },
                router,
                slot,
                Duration::from_millis(100),
                Duration::from_millis(100),
            ),
        )
        .await
        .expect("the request completes before the test deadline");
        result.expect("the served connection ends cleanly");

        let response = client.await.expect("client task");
        assert!(
            String::from_utf8_lossy(&response).starts_with("HTTP/1.1 200 OK"),
            "{}",
            String::from_utf8_lossy(&response)
        );
        assert!(
            served_slot.is_released(),
            "the routed request ended the pre-authentication window"
        );
        assert_eq!(
            slots.available_permits(),
            1,
            "the admission slot is back while the connection is being served"
        );
    }

    /// Read one complete response head (through `\r\n\r\n`) from a raw client.
    async fn read_response_head(client: &mut tokio::net::TcpStream) -> String {
        let mut response = Vec::new();
        let mut byte = [0u8; 1];
        while !response.ends_with(b"\r\n\r\n") {
            let read = client.read(&mut byte).await.expect("read a response byte");
            assert_ne!(read, 0, "the server closed before sending a response head");
            response.push(byte[0]);
        }
        String::from_utf8_lossy(&response).into_owned()
    }

    /// Whether the peer closed (or the read errored) within `window`.
    async fn peer_closed_within(client: &mut tokio::net::TcpStream, window: Duration) -> bool {
        tokio::time::timeout(window, async {
            let mut buf = [0u8; 1];
            loop {
                match client.read(&mut buf).await {
                    Ok(0) | Err(_) => return true,
                    Ok(_) => {}
                }
            }
        })
        .await
        .unwrap_or(false)
    }

    /// A plain `serve` harness with a short header deadline, so the test does
    /// not wait out the production number.
    async fn serve_one(
        listener: tokio::net::TcpListener,
        router: Router,
        slot: AdmissionSlot,
    ) -> io::Result<()> {
        let (server, _) = listener.accept().await.expect("accept the client");
        serve(
            move || async move { Ok(TcpOrTls::Plain(server)) },
            router,
            slot,
            Duration::from_secs(5),
            Duration::from_millis(100),
        )
        .await
    }

    /// #3439 W1: a connection that completed one request and then goes idle on
    /// keep-alive is bounded by the per-request header deadline. Without it the
    /// socket (and its hyper task) would outlive the admission window forever.
    #[tokio::test]
    async fn an_idle_keep_alive_connection_is_closed_at_the_header_deadline() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind a local listener");
        let addr = listener.local_addr().expect("local address");
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let permit = Arc::clone(&slots).try_acquire_owned().expect("one slot");
        let slot = AdmissionSlot::new(permit);
        let served_slot = slot.clone();
        let router = Router::new().route("/", get(|| async { "ok" })).layer(
            axum::middleware::from_fn_with_state(slot.clone(), release_after_response),
        );

        let client = tokio::spawn(async move {
            let mut client = tokio::net::TcpStream::connect(addr).await.expect("connect");
            client
                .write_all(b"GET / HTTP/1.1\r\nHost: test\r\n\r\n")
                .await
                .expect("write the first request");
            let head = read_response_head(&mut client).await;
            // No second request: the idle wait for one is what must be bounded.
            let closed = peer_closed_within(&mut client, Duration::from_secs(2)).await;
            (head, closed)
        });

        let served =
            tokio::time::timeout(Duration::from_secs(2), serve_one(listener, router, slot))
                .await
                .expect("the idle connection is bounded");
        assert!(
            served.is_err(),
            "the header deadline, not a request, ended the connection"
        );

        let (head, closed) = client.await.expect("client task");
        assert!(head.starts_with("HTTP/1.1 200 OK"), "{head}");
        assert!(closed, "an idle keep-alive connection must be closed");
        assert!(
            served_slot.is_released(),
            "the completed request ended the pre-authentication window"
        );
    }

    /// #3439 W1: a partial second request on an otherwise valid keep-alive
    /// connection is bounded by the same per-request header deadline.
    #[tokio::test]
    async fn a_partial_next_request_is_closed_at_the_header_deadline() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind a local listener");
        let addr = listener.local_addr().expect("local address");
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let permit = Arc::clone(&slots).try_acquire_owned().expect("one slot");
        let slot = AdmissionSlot::new(permit);
        let router = Router::new().route("/", get(|| async { "ok" })).layer(
            axum::middleware::from_fn_with_state(slot.clone(), release_after_response),
        );

        let client = tokio::spawn(async move {
            let mut client = tokio::net::TcpStream::connect(addr).await.expect("connect");
            client
                .write_all(b"GET / HTTP/1.1\r\nHost: test\r\n\r\n")
                .await
                .expect("write the first request");
            let head = read_response_head(&mut client).await;
            // Half of a second request head, then silence.
            client
                .write_all(b"GET / HTTP/1.1\r\nHost")
                .await
                .expect("write a partial head");
            let closed = peer_closed_within(&mut client, Duration::from_secs(2)).await;
            (head, closed)
        });

        let served =
            tokio::time::timeout(Duration::from_secs(2), serve_one(listener, router, slot))
                .await
                .expect("the partial request is bounded");
        assert!(served.is_err(), "the partial head must not be served");

        let (head, closed) = client.await.expect("client task");
        assert!(head.starts_with("HTTP/1.1 200 OK"), "{head}");
        assert!(closed, "a partial next request must be closed");
    }

    fn slow_streaming_body() -> axum::body::Body {
        let stream = futures_util::stream::unfold(0u8, |state| async move {
            match state {
                0 => {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    Some((
                        Ok::<_, io::Error>(axum::body::Bytes::from_static(b"first")),
                        1,
                    ))
                }
                1 => Some((Ok(axum::body::Bytes::from_static(b"second")), 2)),
                _ => None,
            }
        });
        axum::body::Body::from_stream(stream)
    }

    /// #3439 W1 positive half: the header deadline bounds reading a *head*, not
    /// a response that is still streaming. An SSE-style body that takes longer
    /// than the deadline must be delivered in full.
    #[tokio::test]
    async fn a_streaming_response_longer_than_the_header_deadline_is_not_cut() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind a local listener");
        let addr = listener.local_addr().expect("local address");
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let permit = Arc::clone(&slots).try_acquire_owned().expect("one slot");
        let slot = AdmissionSlot::new(permit);
        let router = Router::new()
            .route("/stream", get(|| async { slow_streaming_body() }))
            .layer(axum::middleware::from_fn_with_state(
                slot.clone(),
                release_after_response,
            ));

        let client = tokio::spawn(async move {
            let mut client = tokio::net::TcpStream::connect(addr).await.expect("connect");
            client
                .write_all(b"GET /stream HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n")
                .await
                .expect("write the request");
            let mut body = Vec::new();
            client
                .read_to_end(&mut body)
                .await
                .expect("read the streamed response");
            body
        });

        let served =
            tokio::time::timeout(Duration::from_secs(5), serve_one(listener, router, slot))
                .await
                .expect("the streamed response completes");
        served.expect("a streaming response is not a header timeout");

        let body = client.await.expect("client task");
        let body = String::from_utf8_lossy(&body);
        assert!(
            body.contains("first") && body.contains("second"),
            "the whole streamed body must arrive: {body}"
        );
    }
}
