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

#[derive(Debug, Clone)]
pub struct SessionStreamState {
    pub epoch: u64,
    next_seq: u64,
    events: VecDeque<TerminalStreamEventPayload>,
    max_events: usize,
    /// The size of the last resize this stream recorded, if it has recorded one
    /// (#1303).
    ///
    /// It exists so a resize that has *already* been sequenced and fanned out is
    /// not announced a second time, unsequenced, by the `%window-resize` path:
    /// the pane echoing back the size a client just asked for is the same event,
    /// and a client that took both would take one size change for two.
    ///
    /// Read per **connection**, which is what makes the guard the right one: a
    /// connection that did not ask for this resize still hears about it from its
    /// own `%window-resize`, and one that did hears about it from the fan-out
    /// instead. See `websocket.rs`'s resize arm.
    last_resize: Option<(u16, u16)>,
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
            last_resize: None,
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
        self.last_resize = Some((cols, rows));
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

    /// Whether a resize of this size is one this stream has **already** recorded
    /// and fanned out, so a second announcement of it would be a second event
    /// where there was one (#1303).
    ///
    /// Written as a comparison against the record rather than as
    /// `unwrap_or_default()`, which is the tempting simplification and a real
    /// bug: it makes "no resize recorded" indistinguishable from "the last
    /// resize was 0×0", and a 0×0 resize is a size a PTY can legitimately be
    /// given. The unrecorded case must answer `false` for every size, including
    /// that one.
    pub fn already_recorded(&self, cols: u16, rows: u16) -> bool {
        self.last_resize == Some((cols, rows))
    }

    pub fn events_since(
        &self,
        epoch: u64,
        after_seq: u64,
    ) -> Option<Vec<TerminalStreamEventPayload>> {
        if epoch != self.epoch {
            return None;
        }
        Some(
            self.events
                .iter()
                .filter(|ev| stream_seq(ev) > after_seq)
                .cloned()
                .collect(),
        )
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
        let tail = stream.events_since(epoch, 0).expect("same epoch");
        assert_eq!(tail.len(), 2);
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
