//! The "Server's view of this agent may be stale" intent (#2976).
//!
//! Two producers mark it: the supervisor after every reconnection, and the
//! session-state outbox lane when it refuses an update at its bound. One
//! consumer, [`crate::sync::SessionWatcher`], satisfies it only after a full
//! snapshot has been *accepted by the outbox*.
//!
//! A boolean is not enough to own that transition. The watcher observes the
//! intent, enumerates tmux, publishes a whole snapshot, and only then may clear
//! the intent — and a second reconnect (or a refused publish) can arrive during
//! that publication. Clearing by value would erase the newer request with the
//! older attempt's success. Each [`mark`](SyncIntent::mark) therefore bumps a
//! generation, and [`clear_if_current`](SyncIntent::clear_if_current) clears
//! only the exact observation it was given.
//!
//! Satisfying the intent means every frame was **accepted by the outbox**, not
//! that the Server received it: the bounded outbox's `Ok` is an enqueue, and the
//! frame can still be coalesced into a newer one for the same Session. That is
//! the current delivery boundary. A later reconnect marks a new generation, and
//! the Server's Session upserts are idempotent, so re-deriving the whole view is
//! always safe.

use std::sync::atomic::{AtomicU64, Ordering};

/// Bit 0: a full snapshot is owed. The remaining bits: the request generation.
const NEEDED: u64 = 1;
const GENERATION_STEP: u64 = 2;

/// One observed request: the exact state a watcher must still own to clear it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncToken(u64);

/// The shared intent, read by the watcher and marked by the supervisor/outbox.
#[derive(Debug, Default)]
pub struct SyncIntent {
    state: AtomicU64,
}

impl SyncIntent {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a new request.
    ///
    /// Every mark is distinct, even while one is already pending: a reconnect
    /// that arrives during an older full re-sync is a newer request, and that
    /// older attempt must not be able to clear it.
    pub fn mark(&self) {
        loop {
            let current = self.state.load(Ordering::SeqCst);
            // Bump the generation and set the owed bit in one atomic step.
            let next = (current & !NEEDED).wrapping_add(GENERATION_STEP) | NEEDED;
            if self
                .state
                .compare_exchange(current, next, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                return;
            }
        }
    }

    /// Whether a full snapshot is currently owed.
    pub fn is_needed(&self) -> bool {
        self.state.load(Ordering::SeqCst) & NEEDED != 0
    }

    /// The request currently owed, if any.
    pub fn token(&self) -> Option<SyncToken> {
        let state = self.state.load(Ordering::SeqCst);
        (state & NEEDED != 0).then_some(SyncToken(state))
    }

    /// Clear `token` only if no newer request has arrived since it was observed.
    ///
    /// Returns whether the intent was cleared. `false` means a newer request
    /// owns the intent now and the caller's success did not satisfy it.
    pub fn clear_if_current(&self, token: SyncToken) -> bool {
        self.state
            .compare_exchange(
                token.0,
                token.0 & !NEEDED,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mark_is_owed_and_one_observation_clears_it() {
        let intent = SyncIntent::new();
        assert!(!intent.is_needed());
        assert!(intent.token().is_none());

        intent.mark();
        assert!(intent.is_needed());
        let token = intent.token().expect("a marked intent has a token");
        assert!(intent.clear_if_current(token));
        assert!(!intent.is_needed());
        assert!(
            !intent.clear_if_current(token),
            "a spent token clears nothing"
        );
    }

    #[test]
    fn a_newer_mark_survives_an_older_attempts_clear() {
        let intent = SyncIntent::new();
        intent.mark();
        let older = intent.token().expect("first request");

        intent.mark();
        assert!(
            !intent.clear_if_current(older),
            "the older attempt must not erase the newer request"
        );
        assert!(intent.is_needed());

        let newer = intent.token().expect("newer request");
        assert!(intent.clear_if_current(newer));
        assert!(!intent.is_needed());
    }

    #[test]
    fn clearing_one_request_does_not_clear_a_later_one() {
        let intent = SyncIntent::new();
        intent.mark();
        let token = intent.token().expect("request");
        assert!(intent.clear_if_current(token));
        intent.mark();
        assert!(intent.is_needed(), "a later mark is owed again");
    }
}
