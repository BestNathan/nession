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

use nession_protocol::contracts::terminal::v1::TerminalControlChangedPayload;

use super::terminal::runtime::{AttachedSession, SessionMap, SessionMapLock, SessionPeer};

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
    /// **outside** this lock. Control-change notifications are returned rather
    /// than sent here: the registry owns the transition, not the connection's
    /// outbound queue.
    pub(crate) fn retire_connection(&self, peer_token: &Arc<()>) -> RetiredConnection {
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
        RetiredConnection { drained, changes }
    }

    /// Remove one client's subscription from one Session.
    ///
    /// Returns the removed attachment when this was the last subscriber, and
    /// the control change to broadcast when the departing client held the
    /// lease. The handler sends/closes outside this lock, as before.
    pub(crate) fn detach_client(
        &self,
        session_name: &str,
        client_id: &str,
    ) -> Result<DetachedClient, NotAttached> {
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
        Ok(DetachedClient {
            removed,
            control_change,
        })
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

/// What one connection's retirement removed from the registry.
pub(crate) struct RetiredConnection {
    /// Sessions that lost their last subscriber; their attachments are the
    /// caller's to close, outside the map lock.
    pub drained: Vec<(String, AttachedSession)>,
    /// Control-role changes to broadcast to the remaining peers.
    pub changes: Vec<(Vec<SessionPeer>, TerminalControlChangedPayload)>,
}

/// The client was not a subscriber of the named Session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct NotAttached;

/// What a detach removed.
pub(crate) struct DetachedClient {
    /// The attachment to close because this was the last subscriber.
    pub removed: Option<AttachedSession>,
    /// The control-role change to broadcast, when the lease holder left.
    pub control_change: Option<(Vec<SessionPeer>, TerminalControlChangedPayload)>,
}
