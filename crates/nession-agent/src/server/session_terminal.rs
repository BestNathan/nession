//! Session-scoped terminal control (#1095) and stream sequencing (#1094).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use nession_protocol::contracts::terminal::v1::TerminalStreamEventPayload;

const DEFAULT_STREAM_EVENTS: usize = 4096;

/// Hands out an epoch no client can already be holding.
///
/// **A fresh stream state is a *different* stream, and the epoch is the only
/// thing that says so.** A client keeps its `lastStreamSeq` across a reconnect,
/// and resets it only when the epoch it receives differs from the one it holds.
/// So when a new stream state re-used an epoch, the client's cursor was never
/// invalidated: the agent restarted its sequence at 1 while the client still
/// held, say, 30, every live frame satisfied "not newer than my cursor", and
/// `ConnectionManager` dropped each one silently — the snapshot rendered and
/// then the screen froze (#1254).
///
/// Two properties are needed and only the first is obvious:
///
/// 1. **A counter**, so no two states in one process share an epoch.
/// 2. **A seed that is not a constant**, so a state created after an *agent
///    restart* cannot reproduce an epoch a client is still holding. A counter
///    starting at 1 does exactly that — it is the original bug, one process
///    later.
/// 3. **A value a browser holds exactly.** The epoch travels to the client as a
///    JSON number and comes back the same way, and a JavaScript number is a
///    double: above 2^53 the representable integers are further apart than 1,
///    so the value is rounded on the way in and the agent is then asked about a
///    u64 no state has ever held. `epoch_match` is false for every request and
///    a client's only way to fill a gap — `agent.terminal.stream.resume` —
///    fails for the life of the session. The same rounding makes consecutive
///    epochs indistinguishable to a browser, which is #1254's failure mode
///    arriving by a different road.
///
/// Only equality is ever tested (here and in the client), so the values need to
/// be distinct rather than ordered. Seeded from wall-clock **microseconds**,
/// which stays under the limit for some hundreds of thousands of years and
/// costs no dependency.
static NEXT_STREAM_EPOCH: OnceLock<AtomicU64> = OnceLock::new();

/// The largest integer a JavaScript number represents exactly: 2^53 - 1.
const JS_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// How close to that limit a seed may sit, leaving the counter room to run
/// before it walks into the range a browser rounds.
const EPOCH_SEED_CEILING: u64 = JS_SAFE_INTEGER - 1_000_000;

fn next_stream_epoch() -> u64 {
    NEXT_STREAM_EPOCH
        .get_or_init(|| {
            let seed = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                // Microseconds since the epoch — 1.79e15 today, so the ceiling
                // is a guard rather than a reachable state. The fallback is the
                // ceiling, never `u64::MAX`: a seed a client cannot hold
                // exactly is worse than one that repeats, because the first
                // makes every resume fail and the second only risks #1254.
                .map_or(EPOCH_SEED_CEILING, |since| {
                    u64::try_from(since.as_micros()).unwrap_or(EPOCH_SEED_CEILING)
                });
            AtomicU64::new(seed.min(EPOCH_SEED_CEILING))
        })
        .fetch_add(1, Ordering::Relaxed)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalRole {
    Controller,
    Observer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionControlState {
    pub controller_client_id: Option<String>,
    pub generation: u64,
}

impl SessionControlState {
    pub fn new() -> Self {
        Self {
            controller_client_id: None,
            generation: 0,
        }
    }

    pub fn role_of(&self, client_id: &str) -> TerminalRole {
        if self.controller_client_id.as_deref() == Some(client_id) {
            TerminalRole::Controller
        } else {
            TerminalRole::Observer
        }
    }

    pub fn ensure_controller(&mut self, client_id: &str) -> u64 {
        if self.controller_client_id.is_none() {
            self.generation = self.generation.saturating_add(1);
            self.controller_client_id = Some(client_id.to_string());
        }
        self.generation
    }

    pub fn acquire(&mut self, client_id: &str) -> u64 {
        self.generation = self.generation.saturating_add(1);
        self.controller_client_id = Some(client_id.to_string());
        self.generation
    }

    pub fn release_if_holder(&mut self, client_id: &str) {
        if self.controller_client_id.as_deref() == Some(client_id) {
            self.controller_client_id = None;
        }
    }

    pub fn authorize_mutation(&self, client_id: &str, generation: Option<u64>) -> bool {
        if self.controller_client_id.as_deref() != Some(client_id) {
            return false;
        }
        match generation {
            Some(g) => g == self.generation,
            None => true,
        }
    }
}

impl Default for SessionControlState {
    fn default() -> Self {
        Self::new()
    }
}

/// One resume's answer: the events a caller is missing, and the two facts that
/// say whether they are *all* of them (#1304).
///
/// The events are what the old answer carried on its own, and on their own they
/// cannot say whether they are the whole stretch the caller asked for or a tail
/// whose beginning has been evicted. That ambiguity is the bug: an answer of
/// `[5000..6000]` to a request from 100 is either "here is everything" or "the
/// first 4900 events are gone", and a client cannot tell. So the answer states
/// its window and its own verdict, and the caller never has to read either off
/// the events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamReplay {
    /// The lowest sequence number this stream can still return — see
    /// [`SessionStreamState::first_available_seq`].
    pub first_available_seq: u64,
    /// Whether `events` runs from `after_seq + 1` through the current cursor
    /// with nothing missing.
    pub complete: bool,
    pub events: Vec<TerminalStreamEventPayload>,
}

#[derive(Debug, Clone)]
pub struct SessionStreamState {
    pub epoch: u64,
    next_seq: u64,
    events: VecDeque<TerminalStreamEventPayload>,
    max_events: usize,
}

impl SessionStreamState {
    pub fn new() -> Self {
        Self {
            // Not a constant — see `next_stream_epoch`. This used to be `1`,
            // which made every stream state indistinguishable from the last
            // one and left a reconnecting client's cursor looking valid.
            epoch: next_stream_epoch(),
            next_seq: 0,
            events: VecDeque::new(),
            max_events: DEFAULT_STREAM_EVENTS,
        }
    }

    pub fn cursor(&self) -> u64 {
        self.next_seq.saturating_sub(1)
    }

    pub fn record_output(&mut self, session_name: &str, data: String) -> (u64, u64) {
        self.next_seq = self.next_seq.saturating_add(1);
        let seq = self.next_seq;
        let event = TerminalStreamEventPayload::Output {
            session_name: session_name.to_string(),
            stream_epoch: self.epoch,
            stream_seq: seq,
            data,
        };
        self.push_event(event);
        (self.epoch, seq)
    }

    pub fn record_resize(&mut self, session_name: &str, cols: u16, rows: u16) -> (u64, u64) {
        self.next_seq = self.next_seq.saturating_add(1);
        let seq = self.next_seq;
        let event = TerminalStreamEventPayload::Resize {
            session_name: session_name.to_string(),
            stream_epoch: self.epoch,
            stream_seq: seq,
            cols,
            rows,
        };
        self.push_event(event);
        (self.epoch, seq)
    }

    /// The lowest sequence number this stream can still hand back (#1304).
    ///
    /// The front of the ring, because that is exactly what eviction decides: a
    /// full ring drops the front on the next push, so every number below it is
    /// unreachable by any later request. Nothing else bounds what a replay can
    /// return — the ring holds a contiguous run, and `next_seq` only ever moves
    /// forward — so this one number is the whole of the retained window's lower
    /// edge.
    ///
    /// With nothing retained it is the number the next event will take. An
    /// empty ring is a stream that has issued nothing, so a caller at any
    /// cursor is level with it and has missed nothing; answering with the *next*
    /// position rather than with a zero is what makes that fall out of the same
    /// comparison as every other case instead of needing a special one.
    /// (Reachable only before the first event: the ring is capped at a positive
    /// number of events, so it cannot be pushed empty again.)
    pub fn first_available_seq(&self) -> u64 {
        self.events
            .front()
            .map_or_else(|| self.next_seq.saturating_add(1), stream_seq)
    }

    /// Everything after `after_seq` that is still retained, and whether that is
    /// everything the caller asked for (#1304).
    ///
    /// `None` is an epoch mismatch — the request is about a stream this state
    /// is not — and it is the **only** reason to refuse an answer. Whether the
    /// answer is *whole* is a separate question, and it is answered by
    /// [`StreamReplay::complete`] rather than by the caller reading the events:
    /// a caller cannot tell "you are up to date" from "your stretch is gone" by
    /// looking at a tail, and the two call for opposite responses.
    pub fn replay_since(&self, epoch: u64, after_seq: u64) -> Option<StreamReplay> {
        if epoch != self.epoch {
            return None;
        }
        let first_available_seq = self.first_available_seq();
        let events = self
            .events
            .iter()
            .filter(|ev| stream_seq(ev) > after_seq)
            .cloned()
            .collect();
        Some(StreamReplay {
            first_available_seq,
            // The ring is contiguous, so the floor is the whole test: every
            // number from `after_seq + 1` up is either retained or already
            // gone, and there is nothing in between. Saturating because
            // `after_seq` is whatever a caller sent.
            complete: after_seq.saturating_add(1) >= first_available_seq,
            events,
        })
    }

    fn push_event(&mut self, event: TerminalStreamEventPayload) {
        if self.events.len() >= self.max_events {
            self.events.pop_front();
        }
        self.events.push_back(event);
    }
}

impl Default for SessionStreamState {
    fn default() -> Self {
        Self::new()
    }
}

fn stream_seq(ev: &TerminalStreamEventPayload) -> u64 {
    match ev {
        TerminalStreamEventPayload::Output { stream_seq, .. }
        | TerminalStreamEventPayload::Resize { stream_seq, .. } => *stream_seq,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_client_becomes_controller_on_ensure() {
        let mut control = SessionControlState::new();
        let gen = control.ensure_controller("a");
        assert_eq!(gen, 1);
        assert_eq!(control.role_of("a"), TerminalRole::Controller);
        assert_eq!(control.role_of("b"), TerminalRole::Observer);
    }

    #[test]
    fn acquire_bumps_generation_and_rejects_stale() {
        let mut control = SessionControlState::new();
        control.ensure_controller("a");
        let g2 = control.acquire("b");
        assert_eq!(g2, 2);
        assert!(!control.authorize_mutation("a", Some(1)));
        assert!(control.authorize_mutation("b", Some(2)));
    }

    #[test]
    fn stream_records_monotonic_seq() {
        let mut stream = SessionStreamState::new();
        // The epoch is read off the state rather than written as a literal: it
        // is no longer a constant (#1254), and a literal here would pin the
        // test to whatever it happened to be rather than to the property.
        let epoch = stream.epoch;
        let (_, s1) = stream.record_output("s", "YQ==".to_string());
        let (_, s2) = stream.record_resize("s", 80, 24);
        assert_eq!(s1, 1);
        assert_eq!(s2, 2);
        let tail = stream.replay_since(epoch, 0).expect("same epoch");
        assert_eq!(tail.events.len(), 2);
    }

    /// A stream whose ring keeps `capacity` events, with `n` outputs recorded
    /// over it — so it holds the last `capacity` of them and eviction has taken
    /// the rest. `max_events` is the real eviction policy (`push_event` drops
    /// the front at the cap); a small cap is how a test reaches a state a real
    /// session needs 4096 events to reach.
    fn stream_of(n: u64, capacity: usize) -> SessionStreamState {
        let mut stream = SessionStreamState::new();
        stream.max_events = capacity;
        for i in 1..=n {
            stream.record_output("s", format!("e{i}"));
        }
        stream
    }

    fn seqs(events: &[TerminalStreamEventPayload]) -> Vec<u64> {
        events.iter().map(stream_seq).collect()
    }

    /// The boundary of the retained window, from the side that has lost
    /// nothing: a cursor one below the floor is asking for exactly what the
    /// ring still holds (#1304).
    ///
    /// The mutation this pins is a floor that is off by one — reporting the
    /// lowest *evicted* sequence, or comparing `after_seq > first_available_seq`
    /// instead of `after_seq + 1 >= first_available_seq`. Either turns a resume
    /// that lost nothing into one that is told it lost an event it is holding,
    /// and the client's answer to an incomplete reply is to stop trusting its
    /// buffer.
    #[test]
    fn a_replay_from_one_below_the_floor_is_complete() {
        // Six events over a ring of four: 1 and 2 are gone, 3..6 are held.
        let stream = stream_of(6, 4);
        assert_eq!(stream.first_available_seq(), 3);
        let replay = stream.replay_since(stream.epoch, 2).expect("same epoch");
        assert_eq!(
            replay.first_available_seq, 3,
            "the floor is the front of the ring"
        );
        assert!(
            replay.complete,
            "a caller at 2 was told its replay is incomplete, but the next \
             sequence it needs (3) is exactly the floor: nothing is missing"
        );
        assert_eq!(seqs(&replay.events), vec![3, 4, 5, 6]);
    }

    /// One event past that boundary, and the answer is not the same answer:
    /// the single evicted sequence is the whole difference (#1304).
    ///
    /// The mutation this pins is the boundary comparison drifting one the other
    /// way — `after_seq + 1 > first_available_seq`, which calls this case
    /// complete. A client that is told it lost nothing advances its cursor over
    /// an event that no later request can return.
    #[test]
    fn a_replay_one_event_below_the_floor_is_not_complete() {
        let stream = stream_of(6, 4);
        // Cursor 1 is missing only seq 2; 3..6 are in hand.
        let replay = stream.replay_since(stream.epoch, 1).expect("same epoch");
        assert_eq!(replay.first_available_seq, 3);
        assert!(
            !replay.complete,
            "seq 2 was evicted and no later resume can return it, so this \
             answer is not the whole stretch the cursor asked for"
        );
        assert_eq!(
            seqs(&replay.events),
            vec![3, 4, 5, 6],
            "the same tail an incomplete answer carries — the events alone \
             cannot tell the two cases apart, which is why `complete` exists"
        );
    }

    /// Far below the floor: what the caller gets is the window, and the missing
    /// stretch is every number between its cursor and the floor (#1304).
    #[test]
    fn a_replay_far_below_the_floor_states_the_window_it_is_inside() {
        let stream = stream_of(100, 4);
        let replay = stream.replay_since(stream.epoch, 1).expect("same epoch");
        assert_eq!(replay.first_available_seq, 97);
        assert!(!replay.complete);
        assert_eq!(seqs(&replay.events), vec![97, 98, 99, 100]);
        assert!(
            replay.first_available_seq > 1 + 1,
            "the floor is what says 2..96 is unrecoverable; without it the \
             caller sees only a tail and cannot tell it apart from a whole \
             stream that happens to be short"
        );
    }

    /// A cursor at the head: nothing to send is not the same state as nothing
    /// left (#1304).
    ///
    /// The mutation this pins is reading emptiness as truncation — treating an
    /// empty `events` as "the ring has evicted past you". The two are opposite
    /// answers: one means carry on, the other means the buffer has a hole.
    #[test]
    fn a_replay_from_the_cursor_is_complete_and_empty() {
        let stream = stream_of(6, 4);
        let replay = stream.replay_since(stream.epoch, 6).expect("same epoch");
        assert!(replay.events.is_empty());
        assert!(
            replay.complete,
            "an empty answer from the head was reported as incomplete"
        );
    }

    /// A stream that has issued nothing: the floor is the position the next
    /// event will take, so a caller is level with it rather than behind a
    /// window that does not exist yet.
    ///
    /// The mutation this pins is answering the empty ring with `0` — the floor
    /// collapsed to a sequence number no event can have. `0` is what absence on
    /// the wire must never mean, and a provider that reports it here is stating
    /// that sequence 0 is retained: a position the caller can never be behind
    /// and never receive.
    #[test]
    fn a_stream_with_nothing_retained_has_its_floor_at_the_next_position() {
        let stream = SessionStreamState::new();
        assert_eq!(
            stream.first_available_seq(),
            1,
            "an empty ring reported a floor that is not the next position"
        );
        // Which is what makes the caller's answer fall out of the same
        // comparison as every other case: at 0 it has missed nothing.
        let replay = stream.replay_since(stream.epoch, 0).expect("same epoch");
        assert!(
            replay.complete,
            "a caller level with a stream that has recorded nothing was told \
             its replay is incomplete"
        );
        assert!(replay.events.is_empty());
    }

    /// Epoch mismatch is unchanged: the request is about a stream this state is
    /// not, so there is no replay and **no window** — the caller's sequences are
    /// not comparable with this epoch's, so a floor here would be an answer to a
    /// question nobody asked (#1304; #1094's behaviour, kept).
    #[test]
    fn a_replay_on_another_epoch_states_nothing() {
        let stream = stream_of(6, 4);
        let replay = stream.replay_since(stream.epoch.wrapping_add(1), 0);
        assert!(
            replay.is_none(),
            "an epoch mismatch was answered with a window"
        );
    }

    /// A fresh stream must be *distinguishable* from the one it replaces.
    ///
    /// The mutation this pins is putting the old `epoch: 1` back. The client
    /// clears its stream cursor only on an epoch change, so two states sharing
    /// an epoch means a reconnecting client keeps a cursor the agent has
    /// already reset underneath it — every live frame then looks stale and is
    /// dropped, and the screen freezes after the snapshot (#1254).
    #[test]
    fn a_new_stream_never_reuses_the_epoch_it_replaces() {
        let mut epochs = std::collections::HashSet::new();
        for _ in 0..64 {
            let stream = SessionStreamState::new();
            assert!(
                epochs.insert(stream.epoch),
                "epoch {} was handed out twice; a client holding it from the \
                 previous stream would never be told its cursor is stale",
                stream.epoch
            );
        }
        assert_eq!(epochs.len(), 64);
    }

    /// The third property, and the one that made every P2P resume fail: the
    /// epoch has to survive the round trip through a browser.
    ///
    /// It reaches the client as a JSON number and comes back the same way, and
    /// JavaScript holds it as a double. Nanoseconds since the epoch (~1.79e18)
    /// are far above 2^53, so the client can only send back the nearest
    /// representable value — a u64 no state has ever held. Every resume is then
    /// answered `epoch_match: false` with no events, and the gap a client
    /// reconnects with can never be filled.
    #[test]
    fn a_stream_epoch_survives_the_round_trip_through_a_browser() {
        for _ in 0..64 {
            let stream = SessionStreamState::new();
            // Exactly what the client does with it: the epoch arrives as a JSON
            // number, and JavaScript holds that as a double. Comparing through
            // that value is the whole assertion — a number the double cannot
            // hold comes back as a different integer, and the agent then
            // refuses a cursor it never issued. Compared by bits, because the
            // question is whether the value changed at all.
            let wire = serde_json::to_string(&stream.epoch).expect("a u64 serialises");
            let as_the_client_holds_it: f64 =
                serde_json::from_str(&wire).expect("a JSON number parses as a double");
            assert_eq!(
                as_the_client_holds_it.to_bits(),
                (stream.epoch as f64).to_bits(),
                "epoch {} does not survive a JavaScript number; a client would \
                 hand back a different u64 and every resume would be refused",
                stream.epoch
            );
            assert!(
                stream.epoch <= JS_SAFE_INTEGER,
                "epoch {} is above 2^53-1 and cannot be represented exactly",
                stream.epoch
            );
        }
    }

    /// The other half of the same property, and the one a plain counter gets
    /// wrong: the seed must not be a constant either, or a state created after
    /// an agent restart reproduces an epoch a client is still holding.
    #[test]
    fn the_first_epoch_is_not_the_same_in_every_process() {
        // Measured, not asserted about the source: the seed is wall-clock
        // nanoseconds, so it must exceed anything a counter starting at 1 could
        // reach immediately — which is what makes a restart a mismatch rather
        // than a collision.
        let epoch = SessionStreamState::new().epoch;
        assert!(
            epoch > 1_000_000,
            "first epoch was {epoch}, which looks like a small constant seed — \
             a client surviving an agent restart would collide with it"
        );
    }
}
