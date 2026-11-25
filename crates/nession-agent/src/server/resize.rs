//! The agent's resize lane: a session's latest size, and nothing else
//! (`#961-D`).
//!
//! tmux tells the agent about every `%window-resize` it takes, and the agent
//! forwards each one to the central server so relay clients can size their
//! screen. That lane used to be an unbounded `mpsc`: a consumer that stopped
//! draining — the central connection was down, or slow — accumulated every
//! intermediate size of every session for as long as the producer kept going.
//!
//! An unbounded queue is not a policy, and for *this* signal it is the wrong one
//! twice over, because a resize is a **level and not an edge**. What a reader
//! needs to know is how big a session is now; a size that was superseded before
//! anyone read it is not information that was lost, it is information that was
//! never useful. `#961` says so in as many words — "可合并的高频状态（如 resize /
//! pointer-like input）允许 coalesce" — and this is the lane it names.
//!
//! So the policy is **latest wins, per session**:
//!
//! * a publish never blocks, never fails, and never allocates a second entry for
//!   a session that is already pending;
//! * at most one size per session is waiting, so the memory this lane holds is
//!   bounded by the number of sessions that exist rather than by how long a
//!   consumer has been away;
//! * a consumer that comes back sees the current size and no history.
//!
//! Per session, not global: one slot for everything would let a resize of
//! session B overwrite a pending resize of session A, and A's size would then be
//! stale at every relay client until something happened to resize it again. Two
//! sessions are two levels, and coalescing is only sound within one.
//!
//! ## What this lane is not for
//!
//! The *request* side of a resize — a client's `agent.terminal.resize` — is not
//! coalesced here and must not be: it is a request with an `id`, and a caller is
//! waiting for its answer. Coalescing it would mean answering one and dropping
//! the rest, which is the "silently dropped response" the requirement forbids.
//! What a client is free to coalesce is its *own* pending resizes before they
//! become requests, and the Web already does exactly that
//! (`web/src/platform/terminal-runtime/ConnectionManager.ts`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};

use tokio::sync::Notify;

use crate::stream::{classify_latest_state, LatestStateIdentity, LatestStateVerdict};

/// Process-wide observation order for resize levels.
///
/// The two producers of one session's size — the request/attach path's
/// authoritative resize and the tmux `%window-resize` observer — must be
/// ordered by *when they observed* the size, not by when they happened to
/// publish it. A producer draws this token immediately before it reads/applies
/// the size, so a preemption between the read and the publish cannot let an
/// older size replace a newer pending one (#4499).
static RESIZE_OBSERVATION: AtomicU64 = AtomicU64::new(1);

/// The next observation token for a resize publication.
pub fn next_generation() -> u64 {
    RESIZE_OBSERVATION.fetch_add(1, Ordering::Relaxed)
}

/// One session's latest authoritative size and the observation it belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
struct PendingLevel {
    cols: u16,
    rows: u16,
    identity: LatestStateIdentity,
}

/// The producer half: what the agent's peer-to-peer server holds.
///
/// One per process, cloned into every connection that forwards a resize. Clone
/// is cheap and every clone publishes into the same slot, because the lane is a
/// property of the agent and not of a connection — a resize is news to the
/// central server whichever peer observed it.
#[derive(Clone)]
pub struct ResizeReporter {
    shared: Arc<Shared>,
}

/// The consumer half: what the central-connection forwarder drains.
///
/// Deliberately not `Clone`: one reader draining each update once is the whole
/// of the discipline, and two readers would each see a *different* subset of the
/// sessions rather than a copy of all of them.
pub struct ResizeUpdates {
    /// A clone of the reporter's wake-up, held so that the consumer can wait on
    /// it *without* keeping [`Shared`] alive.
    available: Arc<Notify>,
    /// A clone of the slots themselves, for the same reason: a size that was
    /// published is still owed to the consumer that has not read it yet, and
    /// the last reporter going away is not a reason to forget it.
    latest: Arc<StdMutex<HashMap<String, PendingLevel>>>,
    /// The producer half, by weak reference. This is *only* liveness — "is
    /// there anyone left who could publish again?" — and holding it strongly
    /// would keep the reporter alive for as long as the consumer waits, so the
    /// drop that answers that question would never happen.
    shared: Weak<Shared>,
}

struct Shared {
    /// One size per session, keyed by the **full** session id — the
    /// `agent:session` form the central server's relay path speaks, since that
    /// is where these go.
    ///
    /// A `std::sync::Mutex` rather than a tokio one, and the difference is the
    /// point: the critical section is a map insert that cannot await anything,
    /// and `publish` is called from a task that must never yield. Nothing here
    /// is held across an await — see [`ResizeUpdates::next`], where the guard is
    /// dropped in a block before the wait.
    latest: Arc<StdMutex<HashMap<String, PendingLevel>>>,
    /// Signalled on every publish, and when the last reporter goes away.
    available: Arc<Notify>,
}

impl Drop for Shared {
    fn drop(&mut self) {
        // The consumer may be parked in `next()`, and the only thing that can
        // wake it to say "there will be no more" is this. Without it, dropping
        // the reporter leaves the forwarder task waiting forever.
        self.available.notify_waiters();
    }
}

impl ResizeReporter {
    /// A reporter and the one consumer that drains it.
    pub fn new() -> (Self, ResizeUpdates) {
        let available = Arc::new(Notify::new());
        let latest = Arc::new(StdMutex::new(HashMap::new()));
        let shared = Arc::new(Shared {
            latest: Arc::clone(&latest),
            available: Arc::clone(&available),
        });
        (
            Self {
                shared: Arc::clone(&shared),
            },
            ResizeUpdates {
                available,
                latest,
                shared: Arc::downgrade(&shared),
            },
        )
    }

    /// Record a session's current size, replacing whatever was there.
    ///
    /// Never waits and never fails: an intermediate size is superseded, not
    /// dropped, and a caller that had to handle a failure here would have
    /// nothing useful to do with it. The wake-up is what tells the consumer
    /// there is something new — it does not carry the value, because the value
    /// may already have been replaced by a newer one by the time it is read.
    ///
    /// `incarnation` names the stream generation the size belongs to and
    /// `generation` is the producer's observation token (see
    /// [`next_generation`]). The rule is [`classify_latest_state`]: a publish
    /// from the same incarnation with an older or equal generation cannot
    /// replace a newer pending level, so a preemption between the observation
    /// and this call cannot roll the lane back (#4499). A publish from another
    /// incarnation replaces it and the Server re-derives its view, which is
    /// the declared resync contract rather than a merge.
    pub fn publish(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
        incarnation: u64,
        generation: u64,
    ) {
        let incoming = LatestStateIdentity {
            incarnation,
            key: session_id.to_string(),
            generation,
        };
        {
            let mut latest = lock(&self.shared.latest);
            if let Some(pending) = latest.get(session_id) {
                match classify_latest_state(Some(&pending.identity), &incoming) {
                    LatestStateVerdict::Superseded => return,
                    LatestStateVerdict::Coalesced | LatestStateVerdict::ResyncRequired => {}
                }
            }
            latest.insert(
                session_id.to_string(),
                PendingLevel {
                    cols,
                    rows,
                    identity: incoming,
                },
            );
        }
        self.shared.available.notify_waiters();
    }

    /// How many sessions have a size waiting, for logging and tests.
    pub fn pending(&self) -> usize {
        lock(&self.shared.latest).len()
    }
}

impl ResizeUpdates {
    /// The next session whose size changed, or `None` once every reporter is
    /// gone *and* nothing is left to deliver.
    ///
    /// Which session is not specified — with several pending this returns one of
    /// them, and the caller's job is the same for any of them. What *is*
    /// specified is that a session's returned size is its latest: an update that
    /// was superseded while it waited in the map is not delivered afterwards.
    ///
    /// Draining before ending, in that order: a size published while a consumer
    /// existed is still owed to it, and the reporter going away says "there will
    /// be no more", not "forget the last one".
    pub async fn next(&mut self) -> Option<(String, u16, u16, u64, u64)> {
        loop {
            // Register before looking, so a publish that lands between the look
            // and the wait is not a lost wake-up.
            let available = Arc::clone(&self.available);
            let notified = available.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            let taken = {
                let mut latest = lock(&self.latest);
                let next = latest
                    .iter()
                    .next()
                    .map(|(key, level)| (key.clone(), level.clone()));
                if let Some((session_id, level)) = &next {
                    latest.remove(session_id);
                    Some((
                        session_id.clone(),
                        level.cols,
                        level.rows,
                        level.identity.incarnation,
                        level.identity.generation,
                    ))
                } else {
                    None
                }
            };
            if taken.is_some() {
                return taken;
            }
            // "There will be no more": the last reporter is gone and nothing is
            // left to deliver.
            self.shared.upgrade()?;

            notified.await;
        }
    }
}

/// The map's contents, whether or not a panicking writer poisoned it.
///
/// There is nothing here that a panic could leave half-written — the section
/// inserts or removes one entry — so a poisoned lock still holds exactly the
/// sizes it held, and refusing to read them would turn a panic somewhere else
/// into a permanently stalled resize lane.
fn lock(
    map: &StdMutex<HashMap<String, PendingLevel>>,
) -> std::sync::MutexGuard<'_, HashMap<String, PendingLevel>> {
    map.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// What the consumer delivers next, or `None` if nothing arrives promptly.
    ///
    /// A timeout rather than a bare await: the failure these tests care about is
    /// "something stale was delivered", and a consumer parked on an empty lane
    /// would report that as a hang instead of as a wrong value.
    async fn next_within(updates: &mut ResizeUpdates) -> Option<(String, u16, u16)> {
        match tokio::time::timeout(Duration::from_millis(500), updates.next()).await {
            Ok(value) => value.map(|(session, cols, rows, _, _)| (session, cols, rows)),
            Err(_) => panic!("no update arrived within the window"),
        }
    }

    /// Publish one size with a fresh observation token, as a producer does.
    fn publish(reporter: &ResizeReporter, session: &str, cols: u16, rows: u16) {
        let generation = next_generation();
        reporter.publish(session, cols, rows, 1, generation);
    }

    /// A session's intermediate sizes are superseded, not queued.
    ///
    /// The witness is *how many* deliveries there are and what is in them: four
    /// publishes, two sessions, and the lane hands over exactly two sizes — each
    /// session's latest. A lane that queued instead of superseding would deliver
    /// four, and `{"a:s1": 80, …}` or `{"a:s1": 100, …}` would be in them.
    ///
    /// The deliveries are compared as a set. Which of two pending sessions comes
    /// out first is not specified, and the first version of this test asserted
    /// an order — it passed four runs and then failed under `just test`, because
    /// what it was really pinning was a `HashMap` iteration order.
    #[tokio::test]
    async fn only_the_latest_size_of_a_session_survives() {
        let (reporter, mut updates) = ResizeReporter::new();
        publish(&reporter, "a:s1", 80, 24);
        publish(&reporter, "a:s1", 100, 30);
        publish(&reporter, "a:s1", 120, 40);
        publish(&reporter, "a:s2", 10, 5);

        let mut delivered = Vec::new();
        for _ in 0..2 {
            delivered.push(next_within(&mut updates).await);
        }
        delivered.sort();
        assert_eq!(
            delivered,
            vec![
                Some(("a:s1".to_string(), 120, 40)),
                Some(("a:s2".to_string(), 10, 5)),
            ],
            "the lane delivered something other than each session's latest size"
        );

        // And nothing else: a superseded size left waiting would come out of
        // `next` at once, so a short window with no delivery is the assertion.
        let extra = tokio::time::timeout(Duration::from_millis(200), updates.next()).await;
        assert!(
            extra.is_err(),
            "a superseded size was still in the lane: {extra:?}"
        );
        assert_eq!(reporter.pending(), 0, "a superseded size was left behind");
    }

    /// Two sessions keep their own latest size — one sliding slot for the whole
    /// lane would lose one of them.
    ///
    /// The assertion is on the *set* of deliveries, not their order: which of
    /// two pending sessions comes out first is not specified, and a test that
    /// pinned it would be pinning a hash order.
    #[tokio::test]
    async fn two_sessions_do_not_coalesce_each_other() {
        let (reporter, mut updates) = ResizeReporter::new();
        for (cols, rows) in [(80, 24), (90, 25), (100, 26)] {
            publish(&reporter, "a:s1", cols, rows);
            publish(&reporter, "a:s2", cols + 1, rows + 1);
        }

        let mut delivered = Vec::new();
        for _ in 0..2 {
            delivered.push(next_within(&mut updates).await);
        }
        delivered.sort();
        assert_eq!(
            delivered,
            vec![
                Some(("a:s1".to_string(), 100, 26)),
                Some(("a:s2".to_string(), 101, 27)),
            ]
        );
    }

    /// A flood of publishes holds one entry, not one per publish.
    ///
    /// This is the bound the unbounded `mpsc` did not have, and the only way to
    /// see it is to publish far more than any queue this test would tolerate
    /// holding.
    #[tokio::test]
    async fn a_flood_of_publishes_holds_one_entry() {
        let (reporter, _updates) = ResizeReporter::new();
        for i in 0..10_000u32 {
            publish(&reporter, "a:s1", (i % 1000) as u16, 24);
        }
        assert_eq!(reporter.pending(), 1);
    }

    /// The consumer drains what was published, and ends when the reporter is
    /// gone rather than waiting forever for news that cannot come.
    ///
    /// Both halves matter, and in this order: a size published while a consumer
    /// existed is owed to it, and the reporter going away says "there will be
    /// no more" rather than "forget the last one".
    #[tokio::test]
    async fn the_consumer_drains_and_then_ends_when_the_last_reporter_is_dropped() {
        let (reporter, mut updates) = ResizeReporter::new();
        publish(&reporter, "a:s1", 80, 24);
        drop(reporter);

        assert_eq!(
            next_within(&mut updates).await,
            Some(("a:s1".to_string(), 80, 24)),
            "a published size was dropped because the reporter left"
        );
        assert_eq!(
            next_within(&mut updates).await,
            None,
            "a lane with no reporter must end its consumer"
        );
    }

    /// A consumer that was parked when the reporter went away is woken to be
    /// told so.
    ///
    /// The case the previous test cannot reach: there, the consumer had a value
    /// waiting and never had to park. Here it is parked in `next()` when the
    /// reporter is dropped — which is the state the forwarder task is in for
    /// most of its life.
    #[tokio::test]
    async fn a_parked_consumer_is_woken_by_the_reporter_going_away() {
        let (reporter, mut updates) = ResizeReporter::new();
        let waiter = tokio::spawn(async move { updates.next().await });

        // Give the task every chance to park before the drop it must observe.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!waiter.is_finished(), "the consumer was not parked");

        drop(reporter);
        let ended = tokio::time::timeout(Duration::from_secs(5), waiter)
            .await
            .expect("the parked consumer was never woken")
            .expect("the consumer's task panicked");
        assert_eq!(ended, None);
    }

    /// #4499: a producer that observed an older size cannot replace a newer
    /// pending level, even when it publishes afterwards. This is the
    /// preemption between `borrow_and_update` and `publish` the rule exists
    /// for, and it fails against the unconditional-replace lane.
    #[tokio::test]
    async fn an_older_observation_cannot_replace_a_newer_pending_size() {
        let (reporter, mut updates) = ResizeReporter::new();
        let newer = next_generation();
        reporter.publish("a:s1", 100, 30, 7, newer);
        reporter.publish("a:s1", 80, 24, 7, newer.saturating_sub(1));
        assert_eq!(
            next_within(&mut updates).await,
            Some(("a:s1".to_string(), 100, 30)),
            "an older observation rolled the pending level back"
        );
    }

    /// A level from a different incarnation is not merged into its successor:
    /// it replaces the pending value, which is the declared resync contract.
    #[tokio::test]
    async fn a_different_incarnation_replaces_rather_than_merges() {
        let (reporter, mut updates) = ResizeReporter::new();
        let first = next_generation();
        reporter.publish("a:s1", 100, 30, 7, first);
        reporter.publish("a:s1", 120, 40, 8, next_generation());
        assert_eq!(
            next_within(&mut updates).await,
            Some(("a:s1".to_string(), 120, 40)),
        );
    }
}
