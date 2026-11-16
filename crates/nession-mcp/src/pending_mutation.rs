//! Cancellation admission for MCP mutations submitted to a host-owned queue.
//!
//! A request can end before its queued work starts. Dropping its guard must
//! reject a later worker start, without cancelling an already-started
//! Session mutation halfway through a non-transactional tmux operation.
//! This atomic claim is the linearization point between those outcomes.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

const QUEUED: u8 = 0;
const STARTED: u8 = 1;
const ABANDONED: u8 = 2;

/// Kept in the request future while it waits for its queued result.
pub struct PendingMutation {
    state: Arc<AtomicU8>,
}

/// Moved into the keyed-lane worker, where execution really begins.
pub struct MutationAdmission {
    state: Arc<AtomicU8>,
}

impl PendingMutation {
    /// Pair the caller's abandonment guard with the worker's start claim.
    pub fn new() -> (Self, MutationAdmission) {
        let state = Arc::new(AtomicU8::new(QUEUED));
        (
            Self {
                state: Arc::clone(&state),
            },
            MutationAdmission { state },
        )
    }
}

impl Drop for PendingMutation {
    fn drop(&mut self) {
        // A caller cannot revoke a mutation which has already started. The
        // running worker is responsible for settling the underlying action.
        let _ = self.state.compare_exchange(
            QUEUED,
            ABANDONED,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }
}

impl MutationAdmission {
    /// True only if the caller still owns the pending request at worker start.
    pub fn try_begin(&self) -> bool {
        self.state
            .compare_exchange(
                QUEUED,
                STARTED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caller_abandonment_prevents_queued_work_from_starting() {
        let (request, worker) = PendingMutation::new();
        drop(request);
        assert!(!worker.try_begin());
    }

    #[test]
    fn a_started_mutation_is_not_cancelled_halfway_through() {
        let (request, worker) = PendingMutation::new();
        assert!(worker.try_begin());
        drop(request);
        assert!(!worker.try_begin());
    }

    #[test]
    fn only_one_worker_can_claim_the_queued_operation() {
        let (request, worker) = PendingMutation::new();
        assert!(worker.try_begin());
        assert!(!worker.try_begin());
        drop(request);
    }
}
