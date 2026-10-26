//! The Agent-wide Session registry (#2469 slice 3).
//!
//! One registry per Agent process, shared by every P2P connection (and the
//! Relay, which reaches the Agent through that listener). It is the only
//! writable owner of the `SessionMap`: a Session's runtime is created,
//! subscribed to, retired and removed through this type.
//!
//! The handler-facing methods are being moved onto this type in this slice.
//! [`lock`](SessionRegistry::lock) is the transition seam: it lets the existing
//! handler arms keep their current shape while the ownership is relocated, and
//! it disappears as each transition gains a method.

use std::sync::{Arc, Mutex, MutexGuard};

use nession_protocol::contracts::terminal::v1::{
    TerminalControlAcquireResponse, TerminalControlChangedPayload, TerminalInputAckPayload,
    TerminalOutputAppliedPayload, TerminalStreamResumePayload, TerminalStreamResumeResponse,
};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::server::output_ack::OutputAckVerdict;
use crate::server::websocket::{msg_types, new_message};
use crate::session::terminal::state::{InputSequence, InputVerdict, TerminalRole};

use super::terminal::runtime::{
    accept_output_ack, build_terminal_resume_response, fan_out_recorded_resize, write_input,
    AttachedSession, SessionMap, SessionMapLock, SessionPeer,
};

/// The Agent's one Session map.
pub struct SessionRegistry {
    sessions: SessionMapLock,
}

impl SessionRegistry {
    /// An empty registry.
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(SessionMap::new()),
        }
    }

    /// A registry seeded with a map — test/fixture construction.
    #[cfg(test)]
    pub(crate) fn from_map(map: SessionMap) -> Self {
        Self {
            sessions: Mutex::new(map),
        }
    }

    /// Retire every subscriber a physical connection held.
    ///
    /// Pointer identity, not `client_id`: an old socket must not delete its
    /// successor when both carry the same stable browser id. The lease is
    /// released only when the holder has no remaining peer, and a session that
    /// loses its last peer is returned so the caller can close its attachment
    /// **outside** this lock. Control-change notifications are sent here, after
    /// the lock is released: the registry owns the transition and its
    /// announcement, not the connection's outbound queue.
    pub(crate) async fn retire_connection(
        &self,
        peer_token: &Arc<()>,
    ) -> Vec<(String, AttachedSession)> {
        let (drained, changes) = {
            let mut guard = self.lock();
            let mut changes = Vec::new();
            let mut empty = Vec::new();
            for (name, session) in guard.iter_mut() {
                let before = session.control.controller_client_id.clone();
                session
                    .peers
                    .retain(|peer| !Arc::ptr_eq(&peer.peer_token, peer_token));
                if let Some(holder) = before.as_ref() {
                    if !session.peers.iter().any(|peer| &peer.client_id == holder) {
                        session.control.release_if_holder(holder);
                    }
                }
                if before != session.control.controller_client_id && !session.peers.is_empty() {
                    changes.push((
                        session.peers.clone(),
                        TerminalControlChangedPayload {
                            session_name: name.clone(),
                            generation: session.control.generation,
                            controller_client_id: session.control.controller_client_id.clone(),
                        },
                    ));
                }
                if session.peers.is_empty() {
                    empty.push(name.clone());
                }
            }
            let drained = empty
                .into_iter()
                .filter_map(|name| guard.remove(&name).map(|session| (name, session)))
                .collect();
            (drained, changes)
        };
        for (peers, changed) in changes {
            notify_control_changed(&peers, changed).await;
        }
        drained
    }

    /// Remove one client's subscription from one Session.
    ///
    /// Returns the removed attachment when this was the last subscriber. A
    /// control change is broadcast when the departing client held the lease;
    /// the attachment itself is closed by the caller, outside every lock.
    pub(crate) async fn detach_client(
        &self,
        session_name: &str,
        client_id: &str,
    ) -> Result<Option<AttachedSession>, NotAttached> {
        let (removed, control_change) = {
            let mut guard = self.lock();
            let Some(session) = guard.get_mut(session_name) else {
                return Err(NotAttached);
            };
            if !session.peers.iter().any(|peer| peer.client_id == client_id) {
                return Err(NotAttached);
            }
            let before = session.control.controller_client_id.clone();
            session.peers.retain(|peer| peer.client_id != client_id);
            session.control.release_if_holder(client_id);
            let control_change = (before != session.control.controller_client_id).then(|| {
                (
                    session.peers.clone(),
                    TerminalControlChangedPayload {
                        session_name: session_name.to_string(),
                        generation: session.control.generation,
                        controller_client_id: session.control.controller_client_id.clone(),
                    },
                )
            });
            let removed = if session.peers.is_empty() {
                guard.remove(session_name)
            } else {
                None
            };
            (removed, control_change)
        };
        if let Some((peers, changed)) = control_change {
            notify_control_changed(&peers, changed).await;
        }
        Ok(removed)
    }

    /// The ordered-stream replay a resume request asks for, or `None` when the
    /// Session is not attached.
    pub(crate) fn resume_response(
        &self,
        request: &TerminalStreamResumePayload,
    ) -> Option<TerminalStreamResumeResponse> {
        let guard = self.lock();
        guard
            .get(&request.session_name)
            .map(|session| build_terminal_resume_response(request, &session.stream))
    }

    /// Apply one subscriber's output-applied acknowledgement.
    ///
    /// The peer must be the *current* subscriber (client id + socket token);
    /// `not_attached` is the one failure the handler answers differently from a
    /// rejected acknowledgement.
    pub(crate) fn record_output_ack(
        &self,
        session_name: &str,
        client_id: &str,
        peer_token: &Arc<()>,
        payload: &TerminalOutputAppliedPayload,
    ) -> Result<OutputAckVerdict, &'static str> {
        let mut guard = self.lock();
        let Some(session) = guard.get_mut(session_name) else {
            return Err("not_attached");
        };
        let head = session.stream.cursor();
        accept_output_ack(&mut session.peers, client_id, peer_token, payload, head)
    }

    /// Take or restate the Session's ControlLease for one attached client.
    ///
    /// The role change is broadcast to every peer after the map lock is
    /// released: each subscriber decides what a new generation means for its
    /// own in-flight frames.
    pub(crate) async fn acquire_control(
        &self,
        session_name: &str,
        client_id: &str,
    ) -> Result<TerminalControlAcquireResponse, ControlAcquireRejected> {
        let (response, peers, changed) = {
            let mut guard = self.lock();
            let Some(session) = guard.get_mut(session_name) else {
                return Err(ControlAcquireRejected::NotAttached);
            };
            if !session.peers.iter().any(|peer| peer.client_id == client_id) {
                return Err(ControlAcquireRejected::ClientNotAttached);
            }
            let generation = session.control.acquire(client_id);
            let role = session.control.role_of(client_id);
            let response = TerminalControlAcquireResponse {
                session_name: session_name.to_string(),
                generation,
                role: if role == TerminalRole::Controller {
                    "controller"
                } else {
                    "observer"
                }
                .to_string(),
                controller_client_id: session.control.controller_client_id.clone(),
            };
            let changed = TerminalControlChangedPayload {
                session_name: session_name.to_string(),
                generation,
                controller_client_id: session.control.controller_client_id.clone(),
            };
            (response, session.peers.clone(), changed)
        };
        notify_control_changed(&peers, changed).await;
        Ok(response)
    }

    /// Authorize, classify, write and acknowledge one terminal input frame.
    ///
    /// The classification and the cursor the acknowledgement states are read
    /// under one lock; the backend write and the cursor advance happen without
    /// it. A frame that is a duplicate, a gap or from a stale epoch is not
    /// written, but is still acknowledged with the current cursor — the sender
    /// needs the position to resume from.
    pub(crate) async fn apply_input(
        &self,
        session_name: &str,
        client_id: &str,
        control_generation: Option<u64>,
        sequence: InputSequence,
        data_b64: &str,
    ) -> Result<(), InputRejected> {
        let plan = {
            let guard = self.lock();
            let Some(session) = guard.get(session_name) else {
                return Err(InputRejected::NotAttached);
            };
            if !session
                .control
                .authorize_mutation(client_id, control_generation)
            {
                return Err(InputRejected::NotController);
            }
            InputPlan {
                verdict: session.input.classify(sequence),
                backend: Arc::clone(&session.backend),
                epoch: session.input.epoch,
                applied_through: session.input.applied_through,
                generation: session.control.generation,
                peers: session.peers.clone(),
            }
        };

        use base64::Engine;
        let data = base64::engine::general_purpose::STANDARD
            .decode(data_b64)
            .map_err(|error| InputRejected::InvalidBase64(error.to_string()))?;

        let ack_through = match plan.verdict {
            InputVerdict::Apply { through } => {
                write_input(&plan.backend, &data)
                    .await
                    .map_err(InputRejected::Write)?;
                // Only now does the cursor move, and only if the state that
                // classified this frame still holds it. The key lane serialises
                // this Session's mutations, so a mismatch means that guarantee
                // broke and the bytes must not be claimed as applied.
                let mut guard = self.lock();
                let Some(session) = guard.get_mut(session_name) else {
                    return Err(InputRejected::StateChanged);
                };
                if session.input.epoch != plan.epoch {
                    return Err(InputRejected::StateChanged);
                }
                session.input.applied(through);
                through
            }
            InputVerdict::Duplicate | InputVerdict::Gap | InputVerdict::StaleEpoch => {
                plan.applied_through
            }
        };

        notify_input_ack(
            &plan.peers,
            TerminalInputAckPayload {
                session_name: session_name.to_string(),
                input_epoch: plan.epoch,
                applied_through: ack_through,
                control_generation: Some(plan.generation),
            },
        )
        .await;
        Ok(())
    }

    /// Admit, execute and record one authoritative resize.
    ///
    /// The lease generation is captured at admission, not at record time: the
    /// lease may move across the backend await, and the recorded event must
    /// say who asked, not who owns the pane now (#2286 SC-03). The record and
    /// the subscriber fan-out happen under the same lock, so a resize cannot
    /// overtake output in any subscriber's FIFO (#2028).
    pub(crate) async fn resize(
        &self,
        session_name: &str,
        client_id: &str,
        control_generation: Option<u64>,
        cols: u16,
        rows: u16,
    ) -> Result<ResizeRecorded, ResizeRejected> {
        let (role, authorized, authorized_generation, backend) = {
            let guard = self.lock();
            let Some(session) = guard.get(session_name) else {
                return Err(ResizeRejected::NotAttached);
            };
            (
                session.control.role_of(client_id),
                session
                    .control
                    .authorize_mutation(client_id, control_generation),
                session.control.generation,
                Arc::clone(&session.backend),
            )
        };
        if role == TerminalRole::Observer {
            return Err(ResizeRejected::Observer);
        }
        if !authorized {
            return Err(ResizeRejected::NotController);
        }
        super::terminal::runtime::resize(&backend, cols, rows)
            .await
            .map_err(ResizeRejected::Backend)?;

        let recorded = {
            let mut guard = self.lock();
            guard.get_mut(session_name).map(|session| {
                let position = session.stream.record_resize(
                    session_name,
                    cols,
                    rows,
                    Some(authorized_generation),
                );
                let has_subscriber_queue =
                    session.peers.iter().any(|peer| peer.output_tx.is_some());
                let detached = fan_out_recorded_resize(
                    &mut session.peers,
                    cols,
                    rows,
                    position.0,
                    position.1,
                    Some(authorized_generation),
                );
                ResizeRecorded {
                    position: Some(position),
                    has_subscriber_queue,
                    detached,
                    authorized_generation,
                }
            })
        };
        let recorded = recorded.unwrap_or(ResizeRecorded {
            position: None,
            has_subscriber_queue: false,
            detached: 0,
            authorized_generation,
        });
        if recorded.detached > 0 {
            tracing::warn!(
                "session {session_name}: detached {} subscriber(s) on sequenced resize",
                recorded.detached
            );
        }
        Ok(recorded)
    }

    /// The transition seam for the handler arms that have not yet moved onto a
    /// registry method.
    pub(crate) fn lock(&self) -> MutexGuard<'_, SessionMap> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Default for SessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// The client was not a subscriber of the named Session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct NotAttached;

/// The Session facts an input frame is decided from, read under one lock.
struct InputPlan {
    verdict: InputVerdict,
    backend: super::terminal::runtime::SharedBackend,
    epoch: u64,
    applied_through: u64,
    generation: u64,
    peers: Vec<SessionPeer>,
}

/// Why an input frame was not acknowledged.
#[derive(Debug)]
pub(crate) enum InputRejected {
    /// The Session has no attachment in this Agent.
    NotAttached,
    /// The sender does not hold the ControlLease generation it claimed.
    NotController,
    /// The base64 payload is not bytes.
    InvalidBase64(String),
    /// The backend write failed; the cursor did not move.
    Write(anyhow::Error),
    /// The backend took the bytes, but this Session's input state changed
    /// underneath the write, so they must not be claimed as applied.
    StateChanged,
}

/// What one resize recorded.
pub(crate) struct ResizeRecorded {
    /// The stream position it was recorded at, or `None` when the Session
    /// ended across the backend resize.
    pub position: Option<(u64, u64)>,
    /// Whether any subscriber consumed the sequenced resize from its FIFO.
    /// When false, the caller may still deliver it over its own connection
    /// for a legacy attachment.
    pub has_subscriber_queue: bool,
    /// Subscribers evicted by a full queue during the fan-out.
    pub detached: usize,
    /// The lease generation this resize was admitted under.
    pub authorized_generation: u64,
}

/// Why a resize was refused.
#[derive(Debug)]
pub(crate) enum ResizeRejected {
    /// The Session has no attachment in this Agent.
    NotAttached,
    /// The sender is a known subscriber but not the controller.
    Observer,
    /// The sender does not hold the ControlLease generation it claimed.
    NotController,
    /// The attached backend refused the resize.
    Backend(anyhow::Error),
}

/// Why a ControlLease acquisition was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ControlAcquireRejected {
    /// The Session has no attachment in this Agent.
    NotAttached,
    /// The client is not a subscriber of the Session.
    ClientNotAttached,
}

/// Tell a Session's peers where its input cursor now stands (#1307).
///
/// The fact is about the *session*, not about one connection, so it goes to
/// every peer: across a takeover the client that needs the cursor is exactly
/// the one that did not send the frame. A failed delivery is dropped; the
/// cursor is restated by the next acknowledgement and by every attach.
async fn notify_input_ack(peers: &[SessionPeer], payload: TerminalInputAckPayload) {
    let msg = new_message(msg_types::TERMINAL_INPUT_ACK, payload);
    let Ok(json) = serde_json::to_string(&msg) else {
        return;
    };
    for peer in peers {
        let _ = peer
            .outbound
            .send_terminal(WsMessage::Text(json.clone()))
            .await;
    }
}

async fn notify_control_changed(peers: &[SessionPeer], payload: TerminalControlChangedPayload) {
    let msg = new_message(msg_types::TERMINAL_CONTROL_CHANGED, payload);
    let Ok(json) = serde_json::to_string(&msg) else {
        return;
    };
    for peer in peers {
        let _ = peer
            .outbound
            .send_terminal(WsMessage::Text(json.clone()))
            .await;
    }
}
