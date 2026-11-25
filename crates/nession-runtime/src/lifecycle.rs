//! Connection settlement: one generation-fenced verdict per connection, and
//! the finite write/flush/close deadlines the writer runs under (`#4434`).
//!
//! The outbound queue ([`crate::outbound`]) is about *room*. This module is
//! about *ending*: a connection has two halves that can end independently, a
//! writer that can be parked in a socket the peer is not reading, and a reader
//! that may never receive another frame. Before `#4434` each runtime decided on
//! its own how those halves met, and the recurring bug was the same shape — the
//! writer stopped, the reader never found out, and the connection leaked a task
//! and a registry entry (#2179, #4065).
//!
//! ## One verdict, exactly once
//!
//! [`ConnectionLifecycle::settle`] is a compare-and-set on a [`watch`] channel:
//! the first reason wins, every later settle is a no-op that reports `false`.
//! That is deliberate rather than defensive. A stalled terminal lane, a write
//! error and a reader EOF can all happen within the same few milliseconds, and
//! "which one ended it" is a fact the close line and the read side should agree
//! on. The first observation is the honest one.
//!
//! [`ConnectionLifecycle::settle_generation`] adds the generation fence from
//! `#960`: a connection that a reconnect has already superseded cannot settle
//! the newer one merely because its own socket finally noticed it was gone.
//!
//! ## The read side consumes it
//!
//! [`ConnectionLifecycle::wait_cancelled`] is a future a reader can race against
//! its stream read. That is what makes the reason travel *independently of
//! reader activity*: a reader parked on `stream.next()` with no frame incoming
//! still learns the writer declared the peer unhealthy and can end. The ingress
//! side consumes the same watch receiver through [`ConnectionLifecycle::cancelled`],
//! which is the seam `#4433`'s admission work needs and does not have to invent.
//!
//! ## Finite write deadlines
//!
//! [`write_frame`], [`flush_sink`] and [`send_close`] are the three operations a
//! writer performs, each with its own finite deadline. A socket that cannot
//! accept a frame within [`WriteTimeouts::write`] is not slow, it is unhealthy:
//! the caller settles the connection with [`CloseReason::WriteTimeout`] and the
//! read side is cancelled. Physical TCP head-of-line blocking is not hidden by
//! this; it is bounded, which is the only thing a local deadline can honestly
//! offer.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use tracing::debug;

use crate::frame::WsFrame;
use crate::metrics::{self, Direction, Domain, Labels, MetricsIdentity, ReasonKind, ResultKind};

/// Why one connection ended.
///
/// Deliberately a small, credential-free vocabulary: it is what the close line,
/// the settlement record and a test assert against. It carries no peer text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    /// The peer's read half returned EOF (a normal WebSocket close).
    PeerClosed,
    /// The read half failed.
    ReadError,
    /// A write to the socket failed.
    WriteError,
    /// A write did not complete inside its deadline.
    WriteTimeout,
    /// A terminal/stream lane waited out its stall grace.
    Stalled,
    /// A local caller closed the connection deliberately.
    LocalClose,
    /// The process is shutting down.
    Shutdown,
    /// The read half was cancelled by the write half (or vice versa).
    Aborted,
}

/// The bounded telemetry reason for a settlement.
fn settle_reason(reason: CloseReason) -> ReasonKind {
    match reason {
        CloseReason::PeerClosed => ReasonKind::PeerClosed,
        CloseReason::ReadError => ReasonKind::ReadError,
        CloseReason::WriteError => ReasonKind::WriteError,
        CloseReason::WriteTimeout => ReasonKind::WriteTimeout,
        CloseReason::Stalled => ReasonKind::Stalled,
        CloseReason::LocalClose => ReasonKind::LocalClose,
        CloseReason::Shutdown => ReasonKind::Shutdown,
        CloseReason::Aborted => ReasonKind::Aborted,
    }
}

impl CloseReason {
    /// Whether this reason is a statement about the peer being gone rather
    /// than about the local process stopping.
    pub fn is_peer_fault(self) -> bool {
        matches!(
            self,
            Self::PeerClosed
                | Self::ReadError
                | Self::WriteError
                | Self::WriteTimeout
                | Self::Stalled
        )
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::PeerClosed => "peer-closed",
            Self::ReadError => "read-error",
            Self::WriteError => "write-error",
            Self::WriteTimeout => "write-timeout",
            Self::Stalled => "stalled",
            Self::LocalClose => "local-close",
            Self::Shutdown => "shutdown",
            Self::Aborted => "aborted",
        }
    }
}

impl std::fmt::Display for CloseReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The three deadlines a connection's writer runs under.
///
/// Not one number: a frame the socket accepts is cheap to flush but may queue
/// behind TCP; a close handshake is best-effort and must not hold a connection
/// task open. Each is finite so that no single unhealthy peer can park a task
/// for the life of the process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriteTimeouts {
    /// How long one `send` may take before the peer is declared unhealthy.
    pub write: Duration,
    /// How long a flush may take.
    pub flush: Duration,
    /// How long the best-effort close frame may take.
    pub close: Duration,
}

impl Default for WriteTimeouts {
    fn default() -> Self {
        Self {
            write: Duration::from_secs(10),
            flush: Duration::from_secs(5),
            close: Duration::from_secs(2),
        }
    }
}

/// One connection's settlement cell and generation.
///
/// Shared (`Arc`) by the writer, the reader and the lifecycle supervisor. See
/// the module docs for why the first reason wins.
pub struct ConnectionLifecycle {
    generation: u64,
    tx: watch::Sender<Option<CloseReason>>,
    rx: watch::Receiver<Option<CloseReason>>,
}

impl ConnectionLifecycle {
    /// A lifecycle for one connection generation.
    ///
    /// The generation is the same number the broker's
    /// `ConnectionGeneration` carries (`conn#N` ordering): a settlement from a
    /// superseded connection must not end the newer one.
    pub fn new(generation: u64) -> Arc<Self> {
        let (tx, rx) = watch::channel(None);
        Arc::new(Self { generation, tx, rx })
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Settle with `reason`, exactly once. `true` means this call is the one
    /// that set the verdict.
    pub fn settle(&self, reason: CloseReason) -> bool {
        let winner = self.tx.send_if_modified(|slot| {
            if slot.is_none() {
                *slot = Some(reason);
                true
            } else {
                false
            }
        });
        if winner {
            metrics::counter(
                "ws_connection_closed",
                Labels::new()
                    .domain(Domain::Lifecycle)
                    .result(ResultKind::Closed)
                    .reason(settle_reason(reason)),
            );
            debug!(generation = self.generation, reason = %reason, "connection settled");
        }
        winner
    }

    /// Settle only if `generation` is still this connection's generation.
    ///
    /// A stale generation's late read error cannot end a connection that has
    /// already replaced it.
    pub fn settle_generation(&self, generation: u64, reason: CloseReason) -> bool {
        if generation != self.generation {
            debug!(
                current = self.generation,
                from = generation,
                %reason,
                "ignoring a settlement from a stale connection generation"
            );
            return false;
        }
        self.settle(reason)
    }

    pub fn is_settled(&self) -> bool {
        self.rx.borrow().is_some()
    }

    pub fn reason(&self) -> Option<CloseReason> {
        *self.rx.borrow()
    }

    /// A watch receiver the ingress side can consume without owning the
    /// lifecycle. The value is `None` until settled.
    pub fn cancelled(&self) -> watch::Receiver<Option<CloseReason>> {
        self.rx.clone()
    }

    /// Resolve when the connection settles, including when it already has.
    ///
    /// Cancel-safe: a dropped waiter re-registers and rechecks the current
    /// value, so a settle that lands between the check and the wait is not a
    /// lost wake-up.
    pub async fn wait_cancelled(&self) {
        let mut rx = self.rx.clone();
        if rx.borrow().is_some() {
            return;
        }
        // `changed()` errors when the sender is gone; the sender is inside the
        // `Arc` we are borrowing, so the error arm is unreachable in practice
        // and resolving is the safe interpretation anyway.
        let _ = rx.changed().await;
    }
}

impl std::fmt::Debug for ConnectionLifecycle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectionLifecycle")
            .field("generation", &self.generation)
            .field("reason", &self.reason())
            .finish()
    }
}

/// Why a write-side operation failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteFailure {
    /// The operation did not complete inside its deadline.
    Timeout,
    /// The sink reported an error (the peer is gone, the transport failed).
    Sink(String),
}

impl std::fmt::Display for WriteFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Timeout => f.write_str("the write did not complete inside its deadline"),
            Self::Sink(message) => write!(f, "the sink failed: {message}"),
        }
    }
}

impl std::error::Error for WriteFailure {}

/// Send one frame, bounded by `deadline`.
///
/// `SinkExt::send` includes the flush the transport needs; the timeout covers
/// the whole operation, which is what makes "the peer is not reading" a
/// verdict rather than an unbounded park.
pub async fn write_frame<S, E>(
    sink: &mut S,
    frame: WsFrame,
    deadline: Duration,
) -> Result<(), WriteFailure>
where
    S: futures_util::Sink<WsFrame, Error = E> + Unpin,
    E: std::fmt::Display,
{
    write_frame_with_identity(sink, frame, deadline, None).await
}

/// The same, attributing a write timeout to the connection's runtime, peer and
/// transport (#4437 SC-02).
pub async fn write_frame_with_identity<S, E>(
    sink: &mut S,
    frame: WsFrame,
    deadline: Duration,
    identity: Option<MetricsIdentity>,
) -> Result<(), WriteFailure>
where
    S: futures_util::Sink<WsFrame, Error = E> + Unpin,
    E: std::fmt::Display,
{
    use futures_util::SinkExt;
    match tokio::time::timeout(deadline, sink.send(frame)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(WriteFailure::Sink(error.to_string())),
        Err(_) => {
            let labels = match identity {
                Some(identity) => Labels::new().identity(identity),
                None => Labels::new(),
            };
            metrics::counter(
                "ws_outbound_write_timeout",
                labels
                    .domain(Domain::Stream)
                    .direction(Direction::Outbound)
                    .result(ResultKind::Timeout)
                    .reason(ReasonKind::WriteTimeout),
            );
            Err(WriteFailure::Timeout)
        }
    }
}

/// Flush a sink, bounded by `deadline`.
pub async fn flush_sink<S, E>(sink: &mut S, deadline: Duration) -> Result<(), WriteFailure>
where
    S: futures_util::Sink<WsFrame, Error = E> + Unpin,
    E: std::fmt::Display,
{
    use futures_util::SinkExt;
    match tokio::time::timeout(deadline, sink.flush()).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(WriteFailure::Sink(error.to_string())),
        Err(_) => Err(WriteFailure::Timeout),
    }
}

/// Send a best-effort close frame, bounded by `deadline`.
///
/// Not a queue operation: the peer that stopped reading is exactly the one a
/// queued close would never reach. The caller uses this on the socket directly.
pub async fn send_close<S, E>(sink: &mut S, deadline: Duration) -> Result<(), WriteFailure>
where
    S: futures_util::Sink<WsFrame, Error = E> + Unpin,
    E: std::fmt::Display,
{
    write_frame(sink, WsFrame::Close(None), deadline).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::pin::Pin;
    use std::task::{Context, Poll};

    #[test]
    fn the_first_settlement_wins_and_later_ones_are_no_ops() {
        let lifecycle = ConnectionLifecycle::new(7);
        assert!(!lifecycle.is_settled());
        assert!(lifecycle.settle(CloseReason::WriteTimeout));
        assert_eq!(lifecycle.reason(), Some(CloseReason::WriteTimeout));
        assert!(
            !lifecycle.settle(CloseReason::PeerClosed),
            "a second verdict must not overwrite the first"
        );
        assert_eq!(lifecycle.reason(), Some(CloseReason::WriteTimeout));
    }

    #[tokio::test]
    async fn cancellation_resolves_when_settled_and_when_already_settled() {
        let lifecycle = ConnectionLifecycle::new(1);

        // Waiting before the settle.
        let waiter = {
            let lifecycle = Arc::clone(&lifecycle);
            tokio::spawn(async move { lifecycle.wait_cancelled().await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!waiter.is_finished());
        lifecycle.settle(CloseReason::Shutdown);
        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("the waiter must resolve when the verdict lands")
            .expect("the waiter must not panic");

        // Waiting after the settle: the first poll must return.
        tokio::time::timeout(Duration::from_millis(50), lifecycle.wait_cancelled())
            .await
            .expect("an already-settled lifecycle must resolve immediately");
    }

    #[tokio::test]
    async fn a_watch_receiver_carries_the_reason_to_ingress() {
        let lifecycle = ConnectionLifecycle::new(2);
        let mut cancelled = lifecycle.cancelled();
        assert!(cancelled.borrow().is_none());
        lifecycle.settle(CloseReason::Stalled);
        cancelled
            .changed()
            .await
            .expect("the receiver must observe the settle");
        assert_eq!(*cancelled.borrow(), Some(CloseReason::Stalled));
    }

    #[test]
    fn a_stale_generation_cannot_settle_the_new_connection() {
        let lifecycle = ConnectionLifecycle::new(9);
        assert!(
            !lifecycle.settle_generation(8, CloseReason::ReadError),
            "an older generation's late error is not this connection's verdict"
        );
        assert!(!lifecycle.is_settled());
        assert!(lifecycle.settle_generation(9, CloseReason::ReadError));
        assert_eq!(lifecycle.reason(), Some(CloseReason::ReadError));
    }

    /// A sink that never makes progress, standing in for a peer that stopped
    /// reading without closing its socket.
    struct StalledSink;

    impl futures_util::Sink<WsFrame> for StalledSink {
        type Error = std::io::Error;

        fn poll_ready(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Pending
        }

        fn start_send(self: Pin<&mut Self>, _item: WsFrame) -> Result<(), Self::Error> {
            Ok(())
        }

        fn poll_flush(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Pending
        }

        fn poll_close(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Pending
        }
    }

    #[tokio::test]
    async fn a_stalled_write_returns_a_timeout_rather_than_parking_forever() {
        let mut sink = StalledSink;
        let started = std::time::Instant::now();
        let result = write_frame(
            &mut sink,
            WsFrame::Text("x".into()),
            Duration::from_millis(30),
        )
        .await;
        assert_eq!(result, Err(WriteFailure::Timeout));
        assert!(
            started.elapsed() >= Duration::from_millis(30),
            "the verdict must come after the deadline, not instead of it"
        );
    }

    /// The bounded write deadline and the one-shot settlement are observable
    /// through the metric contract, and a write timeout is not mistaken for a
    /// successful write.
    #[tokio::test]
    async fn a_write_timeout_and_settlement_emit_bounded_telemetry() {
        let _guard = crate::metrics::TEST_SINK_LOCK.lock().await;
        let capture = std::sync::Arc::new(crate::metrics::TestCapture::new());
        crate::metrics::set_sink(Some(capture.clone()));

        let mut sink = StalledSink;
        let result = write_frame(
            &mut sink,
            WsFrame::Text("x".into()),
            Duration::from_millis(20),
        )
        .await;
        assert_eq!(result, Err(WriteFailure::Timeout));
        ConnectionLifecycle::new(0).settle(CloseReason::PeerClosed);

        let names = capture.names();
        assert!(
            names.contains(&"ws_outbound_write_timeout"),
            "a write timeout must be counted: {names:?}"
        );
        assert!(
            names.contains(&"ws_connection_closed"),
            "settlement must be counted with its reason: {names:?}"
        );
        crate::metrics::set_sink(None);
    }
}
