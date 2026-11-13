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
//! WebSocket to the frame type the Server and Agent dispatchers already speak,
//! so the migration changed the HTTP owner without rewriting the protocol
//! runtime behind it.

use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::extract::ws::{CloseFrame as AxumCloseFrame, Message as AxumMessage, WebSocket};
use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use axum::Router;
use futures_util::{Sink, Stream};
use hyper_util::rt::TokioIo;
use hyper_util::service::TowerToHyperService;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::OwnedSemaphorePermit;
use tokio_rustls::server::TlsStream;
use tokio_tungstenite::tungstenite::protocol::CloseFrame as WireCloseFrame;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::warn;

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

/// Serve one accepted socket with `router` until the connection ends.
///
/// `connect` completes the optional TLS handshake. The handshake deadline
/// covers both that and the first complete HTTP request: once the slot is
/// released the deadline is disarmed, so a long-lived WebSocket or MCP stream is
/// never cut short by the pre-authentication bound.
pub async fn serve<F, Fut>(
    connect: F,
    router: Router,
    slot: AdmissionSlot,
    deadline: Duration,
) -> io::Result<()>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = io::Result<TcpOrTls>>,
{
    let served = async move {
        let io = connect().await?;
        hyper::server::conn::http1::Builder::new()
            // A header timeout needs an explicit timer in hyper 1.x.
            .timer(hyper_util::rt::TokioTimer::new())
            .header_read_timeout(deadline)
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

/// An Axum WebSocket adapted to the frame type the protocol dispatchers speak.
///
/// The HTTP handshake, upgrade response and frame limits belong to Axum. This
/// adapter is deliberately one boundary: the Server and Agent keep the same
/// text/binary/ping/pong/close vocabulary and the same bounded outbound queues,
/// so moving the ingress did not change the business runtime behind it.
pub struct AxumWebSocket {
    inner: WebSocket,
}

impl AxumWebSocket {
    /// Wrap an upgraded Axum WebSocket.
    pub fn new(inner: WebSocket) -> Self {
        Self { inner }
    }
}

fn adopt(message: AxumMessage) -> WsMessage {
    match message {
        AxumMessage::Text(text) => WsMessage::Text(text.as_str().to_string()),
        AxumMessage::Binary(data) => WsMessage::Binary(data.to_vec()),
        AxumMessage::Ping(data) => WsMessage::Ping(data.to_vec()),
        AxumMessage::Pong(data) => WsMessage::Pong(data.to_vec()),
        AxumMessage::Close(frame) => WsMessage::Close(frame.map(|frame| WireCloseFrame {
            code: frame.code.into(),
            reason: frame.reason.as_str().to_string().into(),
        })),
    }
}

fn emit(message: WsMessage) -> Result<AxumMessage, tokio_tungstenite::tungstenite::Error> {
    Ok(match message {
        WsMessage::Text(text) => AxumMessage::Text(text.into()),
        WsMessage::Binary(data) => AxumMessage::Binary(data.into()),
        WsMessage::Ping(data) => AxumMessage::Ping(data.into()),
        WsMessage::Pong(data) => AxumMessage::Pong(data.into()),
        WsMessage::Close(frame) => AxumMessage::Close(frame.map(|frame| AxumCloseFrame {
            code: frame.code.into(),
            reason: frame.reason.into_owned().into(),
        })),
        // Raw frames are a tungstenite write-side detail the dispatchers never
        // produce; a transport that cannot express one says so.
        WsMessage::Frame(_) => {
            return Err(tokio_tungstenite::tungstenite::Error::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "a raw WebSocket frame cannot be sent through Axum",
            )))
        }
    })
}

fn transport_error(error: axum::Error) -> tokio_tungstenite::tungstenite::Error {
    tokio_tungstenite::tungstenite::Error::Io(io::Error::other(error))
}

impl Stream for AxumWebSocket {
    type Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.inner)
            .poll_next(cx)
            .map(|ready| ready.map(|item| item.map(adopt).map_err(transport_error)))
    }
}

impl Sink<WsMessage> for AxumWebSocket {
    type Error = tokio_tungstenite::tungstenite::Error;

    fn poll_ready(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Pin::new(&mut self.inner)
            .poll_ready(cx)
            .map_err(transport_error)
    }

    fn start_send(mut self: Pin<&mut Self>, item: WsMessage) -> Result<(), Self::Error> {
        Pin::new(&mut self.inner)
            .start_send(emit(item)?)
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

    #[test]
    fn the_adapter_is_unpin_like_the_transports_around_it() {
        fn assert_unpin<T: Unpin>() {}
        assert_unpin::<AxumWebSocket>();
        assert_unpin::<TcpOrTls>();
    }
}
