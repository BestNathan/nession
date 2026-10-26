//! The state one attached Session owns (#2469 slice 3).
//!
//! `AttachedSession` is the per-Session runtime: the tmux attachment behind its
//! own lock, the live subscribers, the ControlLease state, the ordered stream
//! and the input position. It is **not** connection state — a WebSocket
//! connection owns its subscribers, and a subscriber leaving or arriving never
//! creates or destroys this.
//!
//! The map and its lock live here rather than in the network handler so the
//! definition of what a Session owns has one file. The handler still drives
//! these values; moving the operations themselves is the next step of the
//! boundary work.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::{mpsc, Mutex};

use nession_protocol::contracts::session::v1::ClientAttachResponse;
use nession_protocol::contracts::terminal::v1::{
    TerminalOutputAppliedPayload, TerminalResumeRecovery, TerminalStreamEventPayload,
    TerminalStreamResumePayload, TerminalStreamResumeResponse,
};

use crate::server::issued_credit::SubscriberIssuedFlow;
use crate::server::outbound::P2pOutbound;
use crate::server::output_ack::SubscriberOutputAck;
use crate::server::output_ack::{OutputAckBinding, OutputAckVerdict};
use crate::session::terminal::state as session_terminal;
use crate::tmux::session::TmuxSession;

/// One Session's attached terminal backend.
pub(crate) type SharedBackend = Arc<Mutex<Box<dyn TmuxSession>>>;

/// Write input into the Session's attached backend.
///
/// The backend lock covers this I/O and nothing else: callers never hold the
/// registry lock across it, so a slow PTY/control write cannot park another
/// Session. Execution lives here rather than in a transport handler so there is
/// one place that drives a tmux client.
pub(crate) async fn write_input(backend: &SharedBackend, data: &[u8]) -> anyhow::Result<()> {
    backend.lock().await.write_input(data).await
}

/// Resize the Session's authoritative window through its attached backend.
pub(crate) async fn resize(backend: &SharedBackend, cols: u16, rows: u16) -> anyhow::Result<()> {
    backend.lock().await.resize(cols, rows).await
}

/// Close the Session's attached backend (detaches and reaps the tmux client).
pub(crate) async fn close(backend: &SharedBackend) -> anyhow::Result<()> {
    backend.lock().await.close().await
}

pub(crate) type OutputChunk = (Vec<u8>, u64, u64);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SubscriberEvent {
    Output(OutputChunk),
    Resize {
        cols: u16,
        rows: u16,
        stream_epoch: u64,
        stream_seq: u64,
        /// The ControlLease generation that authorized the resize (#2286).
        control_generation: Option<u64>,
    },
}

impl SubscriberEvent {
    pub(crate) fn queued_bytes(&self) -> usize {
        match self {
            Self::Output((bytes, _, _)) => bytes.len(),
            // Resize consumes a slot and a sequence but carries no PTY bytes.
            Self::Resize { .. } => 0,
        }
    }
}

#[derive(Clone)]
pub(crate) struct SessionPeer {
    /// The stable browser identity.
    pub(crate) client_id: String,
    /// The page-instance subscription, when the client states one. Two
    /// same-origin tabs share `client_id` and differ here; a reconnect of one
    /// page keeps it. Absent is the v1 rule: `client_id` is the identity.
    pub(crate) subscription_id: Option<String>,
    pub(crate) peer_token: Arc<()>,
    /// Fresh for each attach, independent of ControlLease/queue dequeue.
    pub(crate) output_ack: SubscriberOutputAck,
    /// Short synchronous lock shared with the subscriber's forwarder, never across await.
    pub(crate) issued_flow: Arc<StdMutex<SubscriberIssuedFlow>>,
    pub(crate) outbound: P2pOutbound,
    /// Sequenced output + authoritative resize share this per-peer FIFO.
    /// A legacy backend without a forwarder may leave it absent.
    pub(crate) output_tx: Option<mpsc::Sender<SubscriberEvent>>,
    /** Pending bytes charged per subscriber, never shared across peers. */
    pub(crate) queued_bytes: Arc<AtomicUsize>,
    /// Set by [`fan_out_peers`] when it drops this peer for a full queue.
    ///
    /// The forwarder's receiver ends for several reasons — the session ended,
    /// a newer attach of the same client replaced this peer, an explicit
    /// detach, this eviction — and only the eviction may close the connection
    /// (#1226). The cause therefore travels with the channel instead of being
    /// re-derived from the session map at the receiver's end, where "the peer
    /// is gone" and "the peer was replaced" used to be indistinguishable.
    pub(crate) detached_for_not_draining: Arc<AtomicBool>,
}

impl SessionPeer {
    /// The identity the ControlLease and subscription replacement use.
    ///
    /// The subscription when the client stated one; the stable client id
    /// otherwise, which is the rule a client written before #2469 slice 4
    /// already gets.
    pub(crate) fn identity(&self) -> &str {
        self.subscription_id.as_deref().unwrap_or(&self.client_id)
    }
}

/// A tmux attach session, shared by all clients attached through this
/// connection. Created on first attach, destroyed on last detach.
///
/// The `backend` is either a plain PTY or a control-mode session, hidden
/// behind [`TmuxSession`] so callers dispatch input/resize/close uniformly.
/// Per-peer fan-out uses the same FIFO for sequenced output and authoritative
/// resize, regardless of which tmux backend produced the event (#2028).
pub(crate) struct AttachedSession {
    /// The backend, behind its *own* lock (`#961-D`).
    ///
    /// This is what keeps the connection's `SessionMap` mutex short: a frame
    /// takes the map lock only long enough to find the session and clone this
    /// `Arc`, and the backend's I/O — a PTY write, a control-mode resize, a
    /// close that kills a tmux child — happens with the map lock released. The
    /// lock that *is* held across that I/O is this one, and it is the
    /// per-session resource rather than the connection's index of sessions.
    ///
    /// Two frames cannot contend for it: `attach`, `detach`, `terminal.input`
    /// and `terminal.resize` all carry the same resource key, so the key lane
    /// runs at most one of them at a time for a given session name.
    pub(crate) backend: Arc<Mutex<Box<dyn TmuxSession>>>,
    /// Live connections for this session (output fan-out + control notifications).
    pub(crate) peers: Vec<SessionPeer>,
    pub(crate) control: session_terminal::SessionControlState,
    pub(crate) stream: session_terminal::SessionStreamState,
    /// How far this session's input has been written, and in which epoch
    /// (#1307).
    ///
    /// **In this process's memory and nothing else**, which is the v1 answer to
    /// "what survives an agent restart" rather than an omission: a tmux session
    /// outlives the agent, so a restarted agent cannot distinguish input that
    /// died before the PTY write from input that was written and acknowledged
    /// into a memory that no longer exists. A durable journal would be the way
    /// to *narrow* that — it is not the way to pretend it is closed, and the
    /// requirement defers it deliberately. What the restart produces instead is
    /// a new [`SessionInputState::epoch`], and a client holding the old one
    /// reads the mismatch as delivery-unknown rather than replaying.
    pub(crate) input: session_terminal::SessionInputState,
}

/// How much terminal output one attached client may have waiting (#961).
///
/// This is the terminal lane's slow-consumer policy, and the depth is the
/// policy. What it buys is that the *slowest* client cannot become the pace of
/// the session for everybody else: the broadcast task fans one session's output
/// out to every attached client, so a `send().await` here would park the
/// fan-out on whichever client is behind — the other clients and the PTY reader
/// behind it. A client with a full queue is therefore detached. That is the same
/// verdict the Server reaches for a relayed client
/// (`server::outbound::send_terminal`), applied where the terminal is served.
///
/// **The byte cap is the memory bound; the slot count is only a metadata
/// backstop.** This used to be 64 slots, sized from the backend hop's *64
/// chunks of up to 4 KiB* — but that hop's unit is not this queue's unit.
/// Terminal events here are per-PTY-chunk, and tmux/`sed` emit small chunks
/// (measured: a 5 000-line `sed` burst arrived as ~500-byte reads, and one
/// relayed burst stalled after 913 delivered lines with only ~64 events
/// queued). A 64-slot bound therefore evicted a *healthy* relayed subscriber
/// after ~35 ms of scheduling lag with barely 1 KiB queued (#2179), while the
/// 2 MiB byte budget below had not been approached.
///
/// The number is large enough that the byte budget binds first for realistic
/// chunks (16 384 × 128 B = 2 MiB), and a genuinely stalled subscriber is still
/// detached: the per-connection outbound path ends it after
/// `DEFAULT_TERMINAL_STALL_GRACE`, and the queue's own byte reservation stops
/// it before memory does. A subscriber evicted here must also actually *end* —
/// see `P2pOutbound::close` on why the read loop races `wait_closed`.
pub(crate) const SUBSCRIBER_QUEUE_SLOTS: usize = 16_384;
/// Independent byte cap for the per-subscriber mpsc queue (#1983).
///
/// This is the bound a slow consumer actually reaches, and it is deliberately
/// small enough to be a real verdict: 2 MiB is tens of thousands of terminal
/// lines. A client that accumulates that much has stopped reading in any
/// useful sense.
pub(crate) const SUBSCRIBER_QUEUE_BYTES: usize = 2 * 1024 * 1024;

/// Fan one chunk of terminal output out to every subscriber of a session.
///
/// Returns the number of subscribers **detached** by this call, i.e. dropped
/// for having no room. A subscriber whose queue is closed is pruned too but not
/// counted: that one's connection has already ended, and `spawn_output_forwarder`
/// is on its way out.
///
/// Never waits, and that is the policy rather than an optimisation — see
/// [`SUBSCRIBER_QUEUE_SLOTS`]. A free function so the policy can be tested
/// without a socket, a PTY, or a session: the three cases (room, full, closed)
/// are the whole of it.
#[cfg(test)]
pub(crate) fn fan_out(
    subscribers: &mut Vec<mpsc::Sender<OutputChunk>>,
    chunk: OutputChunk,
) -> usize {
    let mut detached = 0usize;
    subscribers.retain(|tx| match tx.try_send(chunk.clone()) {
        Ok(()) => true,
        Err(mpsc::error::TrySendError::Full(_)) => {
            detached += 1;
            false
        }
        Err(mpsc::error::TrySendError::Closed(_)) => false,
    });
    detached
}

pub(crate) fn release_subscriber_bytes(queued: &AtomicUsize, bytes: usize) {
    // A disconnected raw-test sender may have skipped reservations; never
    // underflow. Production's only fan-out writer reserves before try_send.
    let _ = queued.fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
        Some(n.saturating_sub(bytes))
    });
}

pub(crate) fn fan_out_peers(peers: &mut Vec<SessionPeer>, chunk: OutputChunk) -> usize {
    fan_out_session_event(peers, SubscriberEvent::Output(chunk))
}

pub(crate) fn fan_out_recorded_resize(
    peers: &mut Vec<SessionPeer>,
    cols: u16,
    rows: u16,
    stream_epoch: u64,
    stream_seq: u64,
    control_generation: Option<u64>,
) -> usize {
    fan_out_session_event(
        peers,
        SubscriberEvent::Resize {
            cols,
            rows,
            stream_epoch,
            stream_seq,
            control_generation,
        },
    )
}

/// Called in the same producer lock after recording *either* event type.
/// Every subscriber gets the identical sequence in the same FIFO order.
pub(crate) fn fan_out_session_event(peers: &mut Vec<SessionPeer>, event: SubscriberEvent) -> usize {
    let mut detached = 0usize;
    peers.retain(|peer| {
        let Some(tx) = &peer.output_tx else {
            return true;
        };
        // Reserve before delivery; the receiver can immediately dequeue and
        // release its charge on another task. One oversized frame is enough
        // to evict this peer but cannot stall or evict a healthy observer.
        let bytes = event.queued_bytes();
        let reserved =
            peer.queued_bytes
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |queued| {
                    queued
                        .checked_add(bytes)
                        .filter(|n| *n <= SUBSCRIBER_QUEUE_BYTES)
                });
        if reserved.is_err() {
            peer.detached_for_not_draining
                .store(true, Ordering::Release);
            detached += 1;
            return false;
        }
        match tx.try_send(event.clone()) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                peer.queued_bytes.fetch_sub(bytes, Ordering::AcqRel);
                peer.detached_for_not_draining
                    .store(true, Ordering::Release);
                detached += 1;
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                peer.queued_bytes.fetch_sub(bytes, Ordering::AcqRel);
                false
            }
        }
    });
    detached
}

pub(crate) fn new_output_ack(stream_epoch: u64) -> Result<SubscriberOutputAck, OutputAckVerdict> {
    SubscriberOutputAck::new(OutputAckBinding {
        subscriber_generation: session_terminal::next_subscriber_generation(),
        stream_epoch,
    })
}

/// Build a contiguous prefix exclusively from the Agent's *ordered* stream
/// ring. No tmux capture occurs here, so a current-head cut and the new
/// subscriber's live queue can be activated under the same SessionMap lock.
///
/// This proves stream continuity only. It cannot restore terminal history
/// preceding the Agent reader, nor replay resize/emulator state as full VT.
/// Missing, expired or oversized prefixes must take the unverified fallback.
pub(crate) struct AtomicOutputPrefix {
    pub(crate) bytes: Vec<u8>,
    pub(crate) stream_epoch: u64,
    pub(crate) through_seq: u64,
}

pub(crate) fn atomic_output_prefix(
    stream: &session_terminal::SessionStreamState,
) -> Option<AtomicOutputPrefix> {
    use base64::Engine;
    let replay = stream.replay_since(stream.epoch, 0)?;
    if !replay.complete || replay.events.is_empty() {
        return None;
    }
    let mut raw = Vec::new();
    for event in replay.events {
        match event {
            TerminalStreamEventPayload::Output { data, .. } => {
                let decoded = base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .ok()?;
                let size = raw.len().checked_add(decoded.len())?;
                if size > crate::server::bootstrap::BOOTSTRAP_MAX_BYTES {
                    return None;
                }
                raw.extend_from_slice(&decoded);
            }
            // A resize is a real sequenced event, but not a byte sequence.
            // The baseline is marked Partial even when output replay is whole.
            TerminalStreamEventPayload::Resize { .. } => {}
        }
    }
    (!raw.is_empty()).then_some(AtomicOutputPrefix {
        bytes: raw,
        stream_epoch: stream.epoch,
        through_seq: stream.cursor(),
    })
}

/// Register a new subscriber and its bounded queue at one Agent stream cut.
///
/// The caller MUST hold the SessionMap producer lock, which also protects
/// stream.record_output + fan_out_peers. A complete ring prefix therefore
/// joins the live queue exactly at `through_seq`. For an incomplete ring, the
/// external tmux capture is still **unverified**: output may overlap that
/// snapshot, but it is no longer silently discarded while capture awaits.
///
/// Queue activation is mandatory even on the unverified fallback. In
/// particular, do not defer `output_tx = Some(..)` until after capture: that
/// leaves an unbounded loss window for concurrently recorded Agent output.
pub(crate) fn subscribe_at_stream_cut(
    peers: &mut Vec<SessionPeer>,
    stream: &session_terminal::SessionStreamState,
    mut peer: SessionPeer,
    live_tx: &mpsc::Sender<SubscriberEvent>,
    needs_bootstrap: bool,
) -> Option<AtomicOutputPrefix> {
    // A replaced subscription's queue must not receive subsequent output; its
    // detached_for_not_draining flag remains false (not a slow-peer eviction).
    // Identity, not client id: two same-origin tabs share the browser id and
    // are separate subscriptions.
    let incoming = peer.identity().to_string();
    peers.retain(|current| current.identity() != incoming);
    let prefix = if needs_bootstrap {
        atomic_output_prefix(stream)
    } else {
        None
    };
    // This is under the same lock as the producer, *before* any await.
    peer.output_tx = Some(live_tx.clone());
    peers.push(peer);
    prefix
}

pub(crate) fn client_attach_response(
    session_name: String,
    session: &AttachedSession,
    peer: &SessionPeer,
) -> ClientAttachResponse {
    let role = session.control.role_of(peer.identity());
    ClientAttachResponse {
        session_name,
        control_generation: Some(session.control.generation),
        control_role: Some(
            if role == session_terminal::TerminalRole::Controller {
                "controller"
            } else {
                "observer"
            }
            .to_string(),
        ),
        controller_client_id: session.control.controller_client_id.clone(),
        controller_subscription_id: session.control.controller_subscription_id.clone(),
        stream_epoch: Some(session.stream.epoch),
        stream_cursor: Some(session.stream.cursor()),
        subscriber_generation: Some(peer.output_ack.binding().subscriber_generation),
        // Stated on every attach, including a re-attach to a session this
        // agent already holds — which is the case they are for. A client whose
        // transport was rebuilt does not know what became of the input it had
        // in flight, and this reply is the one message it is certain to
        // receive; asking separately would need its own request, its own
        // timeout, and its own ordering against the client's first keystroke.
        //
        // `Some`, not `None`: this agent has the state and is the authority on
        // it. The absence of these fields is reserved for an agent that does
        // not — a build from before the contract existed — so that "I have no
        // position" and "my position is zero" stay different answers.
        input_epoch: Some(session.input.epoch),
        input_applied_through: Some(session.input.applied_through),
    }
}

pub(crate) type SessionMap = std::collections::HashMap<String, AttachedSession>;

/// The agent's map of attached sessions, and the reason it is a **std**
/// mutex rather than a `tokio` one (`#961-D`).
///
/// `#961` asks for a stronger thing than "the map lock is usually short": it
/// asks that no backend I/O ever happens with the map held, because a `close`
/// that terminates a tmux child or a PTY write that waits on a full pipe then
/// becomes a lock that every other frame on the connection waits behind. A
/// `tokio::sync::Mutex` cannot express that — it is *made* to be held across an
/// await, and `clippy::await_holding_lock` deliberately does not look at it.
///
/// A `std::sync::Mutex` can: its guard is not `Send`, so a guard held across an
/// await makes the enclosing future non-`Send`, and every task that carries one
/// of these arms is spawnable only if it is `Send` ([`Work`], and
/// `tokio::spawn` for the fan-out and forwarder tasks). The discipline is
/// therefore checked by the compiler and by `clippy::await_holding_lock` (deny
/// in this workspace) rather than by whoever reads the arm next.
///
/// The cost is a second mutex type in one file, and it is paid deliberately:
/// the sections here are `HashMap` operations, so the blocking is bounded by
/// another thread's insert — while the thing being prevented has no bound at
/// all.
pub(crate) type SessionMapLock = std::sync::Mutex<SessionMap>;

/// Never hand a caller the retained *tail* of an incomplete ring: it is
/// not a contiguous suffix of the requested cursor. A failed replay requires
/// a future verified checkpoint (or an explicit degraded/unavailable state).
pub(crate) fn build_terminal_resume_response(
    request: &TerminalStreamResumePayload,
    stream: &session_terminal::SessionStreamState,
) -> TerminalStreamResumeResponse {
    let replay = stream.replay_since(request.stream_epoch, request.after_seq);
    let recovery = match replay.as_ref() {
        None => TerminalResumeRecovery::Unavailable,
        Some(r) if r.complete => TerminalResumeRecovery::Complete,
        Some(_) => TerminalResumeRecovery::CheckpointRequired,
    };
    TerminalStreamResumeResponse {
        session_name: request.session_name.clone(),
        stream_epoch: stream.epoch,
        epoch_match: replay.is_some(),
        first_available_seq: replay.as_ref().map(|r| r.first_available_seq),
        complete: replay.as_ref().map(|r| r.complete),
        recovery: Some(recovery),
        events: if recovery == TerminalResumeRecovery::Complete {
            replay.map_or_else(Vec::new, |r| r.events)
        } else {
            Vec::new()
        },
    }
}

/// Socket identity and per-attach subscription generation are both required.
/// Nothing here grants credit for queued/dequeued bytes.
pub(crate) fn accept_output_ack(
    peers: &mut [SessionPeer],
    client_id: &str,
    peer_token: &Arc<()>,
    payload: &TerminalOutputAppliedPayload,
    issued_head: u64,
) -> Result<OutputAckVerdict, &'static str> {
    let Some(peer) = peers
        .iter_mut()
        .find(|peer| peer.client_id == client_id && Arc::ptr_eq(&peer.peer_token, peer_token))
    else {
        return Err("not_current_subscriber");
    };
    if !(1..=(1_u64 << 53) - 1).contains(&payload.renderer_generation) {
        return Err("invalid_renderer_generation");
    }
    // Stage the cursor: reject a beyond-issued credit claim before commit.
    let mut cursor = peer.output_ack.clone();
    let verdict = cursor.observe_with_renderer(
        OutputAckBinding {
            subscriber_generation: payload.subscriber_generation,
            stream_epoch: payload.stream_epoch,
        },
        payload.renderer_generation,
        payload.applied_through,
        issued_head,
    );
    match verdict {
        OutputAckVerdict::Advanced { .. } => {
            let mut issued = peer
                .issued_flow
                .lock()
                .map_err(|_| "credit_state_unavailable")?;
            issued
                .parser_ack(payload.stream_epoch, payload.applied_through)
                .map_err(|_| "invalid_issued_credit_ack")?;
            peer.output_ack = cursor;
            Ok(verdict)
        }
        OutputAckVerdict::Duplicate => Ok(verdict),
        _ => Err("invalid_output_ack"),
    }
}
