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
    /// Where the resize sits in the session's stream (#1303).
    ///
    /// A resize is an event **in** the timeline, not beside it: the agent
    /// records it and consumes a sequence number, exactly as it does for
    /// output. So a client that is not told the number has a hole in its
    /// timeline, and the only thing that can fill it is an
    /// `agent.terminal.stream.resume` round trip — which is why a resize used
    /// to be the one event every client's cursor skipped over.
    ///
    /// Present when the frame is the agent's own recording of the resize — the
    /// live fan-out to every attached client. **Absent means "no position"**,
    /// not position 0: the relay path states none at all, because a resize
    /// reaches a relayed client through the Server's own size-only
    /// `terminal.resize` broadcast rather than through this one, and an agent
    /// predating this field sends none. A consumer that reads absence as 0
    /// would place a resize it cannot order at the head of its timeline, which
    /// is worse than treating the frame as outside the timeline altogether.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_epoch: Option<u64>,
    /// The sequence number this resize consumed, under the rule `stream_epoch`
    /// states: absent means the frame has no position, not that it is position
    /// zero.
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

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalStreamResumeResponse {
    pub session_name: String,
    pub stream_epoch: u64,
    /// False when `stream_epoch` does not match the live session timeline (#1094).
    pub epoch_match: bool,
    pub events: Vec<TerminalStreamEventPayload>,
}
