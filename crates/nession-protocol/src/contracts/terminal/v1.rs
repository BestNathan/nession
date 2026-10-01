use serde::{Deserialize, Serialize};

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalInputPayload {
    pub session_name: String,
    /// Base64-encoded binary data.
    pub data: String,
    /// Controller generation at send time (#1095). Absent for legacy senders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control_generation: Option<u64>,
    /// The agent's input epoch this frame belongs to (#1307).
    ///
    /// Input identity, and it is deliberately not the envelope's `id`. An
    /// envelope id is a per-connection name for one *frame*, and the relay
    /// merges several frames of a burst into one — so on that path the ids of
    /// everything but the newest frame never reach the agent, and a receipt
    /// keyed on one would be a receipt for input that had no name. A cursor
    /// keyed on `(input_epoch, seq)` is a fact about the *bytes*, which survive
    /// the merge because the merge is defined to keep every byte.
    ///
    /// **Absence preserves the old meaning**, and the old meaning is a sender
    /// that has no sequence at all: its bytes are written and the applied cursor
    /// does not move, because there is nothing to advance it to. That is what a
    /// client written before this field existed gets, and what a paste from an
    /// old build must keep getting.
    ///
    /// A frame that names an epoch the agent is not in is refused rather than
    /// applied — see [`TerminalInputAckPayload`] on what the sender does then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_epoch: Option<u64>,
    /// The first and last input **chunk** this frame carries, in `input_epoch`.
    ///
    /// Chunk ordinals, not byte offsets (the requirement leaves the choice
    /// open and prefers chunks): one frame is normally one chunk, and a frame
    /// that coalesced several covers the range between them. The agent never
    /// needs a byte map, because it only ever writes a whole frame — see
    /// [`TerminalInputAckPayload::applied_through`].
    ///
    /// Both are present together or neither is; a frame that names one without
    /// the other is malformed rather than half-sequenced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq_start: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq_end: Option<u64>,
}

/// The agent's answer to input it has applied — a **cursor**, not a receipt
/// (#1307).
///
/// Emitted on its own wire (`agent.terminal.input.ack`, a notification) rather
/// than as the reply to [`TerminalInputPayload`], and that placement is forced
/// by the relay rather than chosen: the Server's 16 ms window merges a burst of
/// input frames into one that carries the newest envelope's `id` and the
/// concatenated bytes of all of them. A per-frame reply could therefore only
/// ever answer the one frame whose id survived, and the delivery state of every
/// other frame in the burst — the bytes a user actually typed — would be
/// unrecoverable. A cursor needs no id: the same number accounts for every byte
/// of a merged frame, and for every frame that preceded it.
///
/// `applied_through = N` is the whole invariant: **N and every chunk before it
/// in `input_epoch` has been written to the PTY**. Nothing above N has been.
/// The cursor is contiguous by construction — the agent writes only the chunk
/// that continues it — so a sender may drop everything it holds at or below N
/// and re-send the rest unchanged, with no renumbering and no risk of writing
/// the same bytes twice.
///
/// The epoch is what makes an unprovable boundary visible. A cursor is
/// agent-memory state, so an agent that restarted has no cursor, and a fresh
/// one cannot say whether the input that was in flight when it died reached the
/// PTY. It says so by naming a **different** epoch: a sender holding a cursor
/// from another epoch learns that its unacknowledged input is neither applied
/// nor safely re-sendable, and states that to the user rather than replaying a
/// command that may already have run.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalInputAckPayload {
    pub session_name: String,
    /// The agent's live input epoch. Not necessarily the one the frame named:
    /// a frame from a previous epoch is exactly the case this field answers.
    pub input_epoch: u64,
    /// The highest chunk such that every chunk from 1 through it is applied.
    pub applied_through: u64,
    /// The session's control generation at the moment of the write. A sender
    /// whose lease has moved on reads this and knows the acknowledgement is
    /// about a generation it no longer holds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control_generation: Option<u64>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalResizePayload {
    pub session_name: String,
    pub cols: u16,
    pub rows: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control_generation: Option<u64>,
    /// Monotonic stream identity (#1094), present when this resize is an
    /// **event in the session's stream** rather than a size the client is being
    /// told about (#1303).
    ///
    /// A resize the agent records consumes a sequence number, and a sequence
    /// number the client never receives is a hole in a cursor that is
    /// contiguous by construction: the next live frame after it is held until
    /// a resume round trip fills it. So the frame that reports a recorded
    /// resize carries the position it was recorded at, and the client places it
    /// in the timeline like any other event.
    ///
    /// Absent means the frame is only a **level**: a size change tmux reported
    /// on a path that records nothing (the `%window-resize` echo), or a relay
    /// frame forwarded through the Server, which carries no sequence numbers at
    /// all. A client applies those directly, exactly as it did before this
    /// field existed — which is what keeps the addition backward compatible in
    /// both directions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_epoch: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_seq: Option<u64>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalOutputPayload {
    pub session_name: String,
    /// Base64-encoded binary data.
    pub data: String,
    /// Monotonic stream identity (#1094). Omitted until a provider assigns seq.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_epoch: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_seq: Option<u64>,
    /// Present when this frame is the session's **history** rather than its
    /// live output (#321).
    ///
    /// The distinction is what lets a client replace its buffer instead of
    /// appending to it, and it is the only reason a bootstrap can be re-sent on
    /// every attach without duplicating on screen: absence preserves exactly
    /// the old meaning — a frame of output — so a client that does not know the
    /// field writes it as prefill, which is what today's control-mode attach
    /// already does.
    ///
    /// **Not part of the stream timeline.** A bootstrap carries no
    /// `stream_epoch`/`stream_seq`: it is a snapshot taken *before* the stream
    /// it precedes, not an event in it. Recording one in the stream log would
    /// let `agent.terminal.stream.resume` replay it, which is the duplication
    /// #1148 already measured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bootstrap: Option<TerminalBootstrapPayload>,
}

/// What a [`TerminalOutputPayload`]'s `bootstrap` says about itself.
///
/// Two facts, both of them about the *capture* rather than about the session:
/// what the client asked for, and whether it got all of it. Nothing here says
/// how to apply it — that is the client's, and it is one line (`replace the
/// buffer`) because absence of the marker is the only other case.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalBootstrapPayload {
    /// How many lines of history the bootstrap was asked for. Reported so a
    /// client can tell "this is everything" from "this is everything that was
    /// requested" without knowing the server's constant.
    pub requested_lines: u32,
    /// Whether a byte ceiling cut the capture short. **Observable rather than
    /// silent**: a client that received a truncated history and one that
    /// received all of it are different states, and only one of them should
    /// read as "this is the history".
    pub truncated: bool,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalControlAcquirePayload {
    pub session_name: String,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalControlAcquireResponse {
    pub session_name: String,
    pub generation: u64,
    /// `controller` or `observer` for this client after the operation.
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub controller_client_id: Option<String>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalControlChangedPayload {
    pub session_name: String,
    pub generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub controller_client_id: Option<String>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TerminalStreamEventPayload {
    Output {
        session_name: String,
        stream_epoch: u64,
        stream_seq: u64,
        data: String,
    },
    Resize {
        session_name: String,
        stream_epoch: u64,
        stream_seq: u64,
        cols: u16,
        rows: u16,
    },
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalStreamResumePayload {
    pub session_name: String,
    pub stream_epoch: u64,
    pub after_seq: u64,
}

/// The agent's answer to a resume (#1094) and what it says about its own
/// retained window (#1304).
///
/// `epoch_match` answers "is this the stream you asked about", and that is not
/// the same question as "does this stream still hold everything you asked
/// for". A provider's stream log is bounded — the agent's ring keeps
/// `DEFAULT_STREAM_EVENTS` and evicts from the front — so a client that was
/// away long enough gets a matching epoch and a tail of events that starts far
/// above its cursor, with nothing on the wire saying the stretch in between is
/// gone. The client reads that as complete recovery, advances its cursor over
/// the missing stretch, and never asks again. These two fields are that
/// statement.
///
/// **Absence means "not stated", never a value.** A provider that holds no
/// position for the request — an epoch mismatch, or one built before these
/// fields existed — omits both rather than sending a zero, so a consumer can
/// tell "nothing is missing" from "nothing was said", which is the difference
/// between continuing and repairing.
///
/// Two fields the issue that introduced these (#1304) also sketched are
/// deliberately absent. An echo of `after_seq` would be a second copy of a
/// value the caller already holds, and the envelope's `id` is what correlates
/// a reply to its request. `current_seq` is carried by the events themselves —
/// their last position is the head — and an answer with no events is one whose
/// caller is already there, which `complete` states rather than leaving to be
/// inferred.
#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalStreamResumeResponse {
    pub session_name: String,
    pub stream_epoch: u64,
    /// False when `stream_epoch` does not match the live session timeline (#1094).
    pub epoch_match: bool,
    /// The lowest sequence number this stream can still return — the front of
    /// the provider's retained window (#1304).
    ///
    /// A caller holding a cursor below `first_available_seq - 1` has lost
    /// `cursor + 1 .. first_available_seq - 1` for good: no later resume can
    /// return them, so advancing the cursor over that stretch is not recovery
    /// and waiting on it is waiting for output that no longer exists.
    ///
    /// Stated only when `epoch_match` is true. On a mismatch the request is
    /// about a stream the provider no longer has, so there is no window for
    /// *that* request to be inside of; the live epoch's floor is not an answer
    /// to it, because the two sequences are not comparable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_available_seq: Option<u64>,
    /// Whether `events` carries **every** event from `after_seq + 1` through
    /// the provider's current cursor.
    ///
    /// The provider's verdict, not a fact the caller should derive: a consumer
    /// that recomputed it from `first_available_seq` would be re-implementing
    /// the provider's retention policy, and would read a shorter-than-asked-for
    /// answer as whole the moment that policy bounded an answer for a reason
    /// other than eviction.
    ///
    /// `false` is the case this field exists for. It is **not** the same state
    /// as an empty `events` — an answer with no events and `complete: true`
    /// means the caller is already at the head — and stating it is what keeps
    /// that ambiguity off the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complete: Option<bool>,
    pub events: Vec<TerminalStreamEventPayload>,
}
