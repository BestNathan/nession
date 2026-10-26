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

use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::{mpsc, Mutex};

use nession_protocol::contracts::terminal::v1::{
    TerminalOutputAppliedPayload, TerminalResumeRecovery, TerminalStreamResumePayload,
    TerminalStreamResumeResponse,
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
    pub(crate) client_id: String,
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
