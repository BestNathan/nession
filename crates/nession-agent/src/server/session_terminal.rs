//! Session-scoped terminal control (#1095) and stream sequencing (#1094).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use nession_protocol::contracts::terminal::v1::TerminalStreamEventPayload;

const DEFAULT_STREAM_EVENTS: usize = 4096;

/// Hands out an epoch no client can already be holding.
///
/// It serves **both** the output stream ([`SessionStreamState`]) and the input
/// cursor ([`SessionInputState`]), because the two want the same three
/// properties and neither wants the other's value: the generations are
/// independent (the output timeline is not the input timeline, #1307), and what
/// they share is the *rule for making a fresh number*, not a number.
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
static NEXT_EPOCH: OnceLock<AtomicU64> = OnceLock::new();

/// The largest integer a JavaScript number represents exactly: 2^53 - 1.
const JS_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// How close to that limit a seed may sit, leaving the counter room to run
/// before it walks into the range a browser rounds.
const EPOCH_SEED_CEILING: u64 = JS_SAFE_INTEGER - 1_000_000;

fn next_epoch() -> u64 {
    NEXT_EPOCH
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

/// What one input frame says about its own place in the session's input stream
/// (#1307).
///
/// Built from the wire payload by the arm that serves it, and named here so the
/// decision below can be tested without a socket: the three sequenced fields
/// are one statement, and a frame that names some of them is malformed rather
/// than half-sequenced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputSequence {
    /// A sender that names an epoch and a contiguous chunk range in it.
    Sequenced {
        epoch: u64,
        seq_start: u64,
        seq_end: u64,
    },
    /// A sender that names no sequence at all.
    ///
    /// Not an error and not a gap: it is a client written before this contract
    /// existed, and its bytes reach the PTY exactly as they always did. What it
    /// cannot do is move the cursor — there is nothing to move it to — so input
    /// from such a sender is invisible to every later acknowledgement, and a
    /// sequenced client that shared a session with one would see a cursor that
    /// stalled under it. The two do not share a session in practice: sequencing
    /// exists so that one controller's retries are safe, and there is one
    /// controller.
    Unsequenced,
}

impl InputSequence {
    /// Read the three sequenced fields off a frame as one statement.
    ///
    /// `Err` names the field that arrived alone, because a malformed frame is a
    /// sender's bug and the sender is the one who has to hear about it. The
    /// three are separate fields on the wire only because an unsequenced sender
    /// must stay legal; a sender that has any of them has all of them.
    pub fn of(
        epoch: Option<u64>,
        seq_start: Option<u64>,
        seq_end: Option<u64>,
    ) -> Result<Self, &'static str> {
        match (epoch, seq_start, seq_end) {
            (None, None, None) => Ok(InputSequence::Unsequenced),
            (Some(epoch), Some(seq_start), Some(seq_end)) => Ok(InputSequence::Sequenced {
                epoch,
                seq_start,
                seq_end,
            }),
            (Some(_), _, _) => Err("input_epoch requires seq_start and seq_end"),
            (None, Some(_), _) => Err("seq_start requires input_epoch and seq_end"),
            (None, None, Some(_)) => Err("seq_end requires input_epoch and seq_start"),
        }
    }
}

/// The agent's input cursor: which chunk of which epoch is applied (#1307).
///
/// The counterpart of [`SessionStreamState`] on the other side of the socket,
/// and deliberately not the same state: the output timeline is a *log* that a
/// client replays, and this is a *cursor* that accounts for what has already
/// happened. Nothing here is durable, and that is the v1 answer rather than an
/// omission — see [`InputVerdict::StaleEpoch`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInputState {
    pub epoch: u64,
    /// The highest chunk such that every chunk from 1 through it is applied.
    ///
    /// Contiguous by construction, because [`classify`](Self::classify) only
    /// ever authorises the chunk that continues it. That contiguity is what
    /// lets a client read a number instead of a set: everything at or below
    /// this is applied, everything above it is not, and there is no third case
    /// to represent.
    pub applied_through: u64,
}

/// What the agent must do with one input frame, decided before a byte is
/// written.
///
/// Every arm is a different answer to the same question — *may these bytes go
/// to the PTY?* — and the ones that say no exist to keep a retry from writing
/// the same bytes twice. The requirement's failure to prevent is
/// `write PTY / ACK lost / reconnect / retry / PTY receives the bytes twice`,
/// and the way this type stops it is by making the decision from the cursor
/// alone, before any I/O has happened: a frame the cursor has already covered
/// is not written, whatever the sender believes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputVerdict {
    /// Write these bytes, then advance the cursor to `through` — **and only
    /// then**. The caller advances after `write_input` returns `Ok`, so a write
    /// that failed leaves the cursor where it was and the sender free to retry
    /// the same chunk.
    Apply { through: u64 },
    /// Already applied: write nothing, and restate the cursor.
    ///
    /// This is the lost-ACK retry. The sender cannot tell "my ACK was lost"
    /// from "my frame was lost", so it re-sends; the bytes must not go to the
    /// PTY a second time, and the sender must still learn where it stands.
    Duplicate,
    /// Past the cursor without continuing it. Write nothing.
    ///
    /// A gap cannot be repaired by the agent — it does not have the missing
    /// bytes and must not invent them — and writing *past* it would apply the
    /// user's later input out of order relative to the earlier input that never
    /// arrived. So the frame is refused and the cursor is restated, which is
    /// the sender's cue to re-send from there.
    Gap,
    /// The frame names an epoch this session is not in. Write nothing.
    ///
    /// The one verdict that is about *provenance* rather than position, and the
    /// one the requirement spends a section on. `applied_through` lives in this
    /// process's memory, so an agent that restarted has no cursor and cannot
    /// say whether the input that was in flight when it died reached the PTY —
    /// and a tmux session outlives the agent, so "it must have died before
    /// writing" is not something the new process can know. Refusing the frame
    /// is what makes that unprovable boundary visible to the sender instead of
    /// letting it retry a command that may already have run. The new epoch
    /// says which stream the refusal is about; the sender is the one that
    /// decides what to tell the user.
    StaleEpoch,
}

impl SessionInputState {
    pub fn new() -> Self {
        Self {
            epoch: next_epoch(),
            applied_through: 0,
        }
    }

    /// What to do with one frame, given the cursor.
    ///
    /// A free function's worth of logic on a method because the cursor is the
    /// only input: the verdict is a property of the state and the frame, and
    /// nothing here writes, logs or decides what the sender is told.
    pub fn classify(&self, sequence: InputSequence) -> InputVerdict {
        match sequence {
            InputSequence::Unsequenced => InputVerdict::Apply {
                through: self.applied_through,
            },
            InputSequence::Sequenced {
                epoch,
                seq_start,
                seq_end,
            } => {
                if epoch != self.epoch {
                    return InputVerdict::StaleEpoch;
                }
                if seq_end <= self.applied_through {
                    return InputVerdict::Duplicate;
                }
                if seq_start != self.applied_through.saturating_add(1) {
                    // Includes the straddle: a frame whose range begins at or
                    // below the cursor but ends above it. The agent has no byte
                    // offsets — a frame is written whole or not at all — so the
                    // honest answer is the cursor, and the sender resumes from
                    // it with the bytes it is still holding.
                    return InputVerdict::Gap;
                }
                InputVerdict::Apply { through: seq_end }
            }
        }
    }

    /// Move the cursor, after the bytes it accounts for are on their way.
    ///
    /// `max` rather than assignment so that a late advance from a frame the
    /// lane reordered cannot walk the cursor backwards; in-order execution is
    /// the key lane's job, and this is what keeps a violation of it from being
    /// silent.
    pub fn applied(&mut self, through: u64) {
        self.applied_through = self.applied_through.max(through);
    }
}

impl Default for SessionInputState {
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
            // Not a constant — see `next_epoch`. This used to be `1`,
            // which made every stream state indistinguishable from the last
            // one and left a reconnecting client's cursor looking valid.
            epoch: next_epoch(),
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

    // ── Input cursor (#1307) ────────────────────────────────────────────────

    /// A fresh session's input epoch is seeded like the stream's and satisfies
    /// the same three properties, which is why both come from `next_epoch`.
    ///
    /// The mutation this pins is `epoch: 1`. A client holds its epoch across a
    /// reconnect, so a restarted agent that re-used one would be asked to
    /// confirm a cursor it never had — and would answer `StaleEpoch` for input
    /// that is actually its own, turning every reattach into a false
    /// delivery-unknown.
    #[test]
    fn a_new_input_state_never_reuses_the_epoch_it_replaces() {
        let mut epochs = std::collections::HashSet::new();
        for _ in 0..64 {
            let input = SessionInputState::new();
            assert_eq!(input.applied_through, 0);
            assert!(
                epochs.insert(input.epoch),
                "input epoch {} was handed out twice; a client holding it from \
                 the previous state would be told its own input is stale",
                input.epoch
            );
            assert!(input.epoch <= JS_SAFE_INTEGER);
        }
    }

    /// The three sequenced fields are one statement: a frame naming some of
    /// them is malformed rather than half-sequenced.
    #[test]
    fn a_partial_sequence_is_not_a_sequence() {
        assert_eq!(
            InputSequence::of(Some(7), None, None),
            Err("input_epoch requires seq_start and seq_end")
        );
        assert_eq!(
            InputSequence::of(None, Some(1), None),
            Err("seq_start requires input_epoch and seq_end")
        );
        assert_eq!(
            InputSequence::of(None, None, Some(1)),
            Err("seq_end requires input_epoch and seq_start")
        );
        assert_eq!(
            InputSequence::of(None, None, None),
            Ok(InputSequence::Unsequenced)
        );
        assert_eq!(
            InputSequence::of(Some(7), Some(1), Some(2)),
            Ok(InputSequence::Sequenced {
                epoch: 7,
                seq_start: 1,
                seq_end: 2
            })
        );
    }

    /// The happy path, and the property the whole contract rests on: the cursor
    /// moves only by the frames that continue it.
    #[test]
    fn a_contiguous_frame_advances_the_cursor() {
        let mut input = SessionInputState::new();
        let epoch = input.epoch;
        assert_eq!(
            input.classify(InputSequence::Sequenced {
                epoch,
                seq_start: 1,
                seq_end: 1
            }),
            InputVerdict::Apply { through: 1 }
        );
        input.applied(1);
        assert_eq!(input.applied_through, 1);
        // A frame that coalesced three chunks advances over all three.
        assert_eq!(
            input.classify(InputSequence::Sequenced {
                epoch,
                seq_start: 2,
                seq_end: 4
            }),
            InputVerdict::Apply { through: 4 }
        );
        input.applied(4);
        assert_eq!(input.applied_through, 4);
    }

    /// The defect the requirement names: write, ACK lost, retry — and the bytes
    /// must not reach the PTY twice.
    ///
    /// The mutation is dropping the `Duplicate` arm (letting `Apply` cover a
    /// frame the cursor already holds). The bytes would be written again, which
    /// is a command running twice.
    #[test]
    fn a_retry_of_an_applied_frame_is_not_written_again() {
        let mut input = SessionInputState::new();
        let epoch = input.epoch;
        input.applied(3);
        assert_eq!(
            input.classify(InputSequence::Sequenced {
                epoch,
                seq_start: 1,
                seq_end: 3
            }),
            InputVerdict::Duplicate,
            "a frame the cursor already covers must not be written again"
        );
        assert_eq!(
            input.classify(InputSequence::Sequenced {
                epoch,
                seq_start: 2,
                seq_end: 3
            }),
            InputVerdict::Duplicate,
            "a partially covered frame is entirely covered"
        );
    }

    /// A gap is refused rather than jumped, and so is a straddle — the frame
    /// whose range begins at or below the cursor and ends above it.
    ///
    /// The mutation is `seq_start <= applied_through + 1`, which would write
    /// the straddle whole and re-send the bytes the cursor already covers.
    #[test]
    fn a_frame_that_does_not_continue_the_cursor_is_refused() {
        let mut input = SessionInputState::new();
        let epoch = input.epoch;
        input.applied(3);
        // `2..2` is deliberately absent: it ends *below* the cursor, so it is a
        // duplicate rather than a gap, and the order of those two tests is the
        // whole of "already applied" meaning. A range that ends at or below the
        // cursor is covered whatever it starts at; only a range that reaches
        // past the cursor can be a gap, because only that one has bytes the
        // cursor does not account for.
        for (seq_start, seq_end) in [(5u64, 6u64), (2, 4)] {
            assert_eq!(
                input.classify(InputSequence::Sequenced {
                    epoch,
                    seq_start,
                    seq_end
                }),
                InputVerdict::Gap,
                "range {seq_start}..{seq_end} does not continue a cursor at 3"
            );
        }
        assert_eq!(
            input.classify(InputSequence::Sequenced {
                epoch,
                seq_start: 2,
                seq_end: 2
            }),
            InputVerdict::Duplicate,
            "a range entirely below the cursor is already applied"
        );
        // The one range that does continue it.
        assert_eq!(
            input.classify(InputSequence::Sequenced {
                epoch,
                seq_start: 4,
                seq_end: 4
            }),
            InputVerdict::Apply { through: 4 }
        );
    }

    /// An epoch from another agent process is refused, and the cursor does not
    /// move — this is what makes an unprovable commit boundary visible rather
    /// than let it be retried blind.
    ///
    /// The mutation is dropping the epoch check, which is the whole of SC-09's
    /// mechanism: the two epochs are indistinguishable from two numbers, and
    /// only the refusal keeps the second from being applied over the first.
    #[test]
    fn input_from_another_epoch_is_refused() {
        let input = SessionInputState::new();
        let epoch = input.epoch;
        assert_eq!(
            input.classify(InputSequence::Sequenced {
                epoch: epoch + 1,
                seq_start: 1,
                seq_end: 1
            }),
            InputVerdict::StaleEpoch,
            "a frame from another epoch must not advance this one's cursor"
        );
        assert_eq!(input.applied_through, 0);
    }

    /// A sender with no sequence writes, and moves nothing.
    ///
    /// The mutation is treating `Unsequenced` as a gap: every client written
    /// before this contract existed would stop being able to type.
    #[test]
    fn an_unsequenced_frame_writes_without_moving_the_cursor() {
        let mut input = SessionInputState::new();
        assert_eq!(
            input.classify(InputSequence::Unsequenced),
            InputVerdict::Apply {
                through: input.applied_through
            }
        );
        input.applied(input.applied_through);
        assert_eq!(input.applied_through, 0);
    }
}
