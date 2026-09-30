//! The canonical model of a Claude Code transcript (#1234).
//!
//! One reader, one upstream-schema adapter, one model — and then *projections*
//! that decide what to show. This module is the middle of that sentence: what a
//! transcript **is**, independent of who is reading it.
//!
//! ## Why there is a layer here at all
//!
//! Two products answer two different questions over one file: *what did the user
//! and Claude say to each other* (the conversation), and *what did this session
//! actually do* (the transcript). They must not each parse Claude's JSONL — not
//! for tidiness, but because the two would then disagree about the same file,
//! and a parser bug would have to be found twice.
//!
//! So the raw record is read once ([`crate::source`]), understood once
//! ([`adapter`]), and the projections decide what of it to draw. Neither
//! projection sees a Claude field name.
//!
//! ## The model holds facts, not renderings
//!
//! An entry says what happened, in the transcript's own order. It does not say
//! whether a reader should see it: `attachment` and `reasoning` are both
//! canonical entries and both are hidden from the conversation *by the
//! projection's policy*, which is a different fact from "the parser could not
//! read it". That distinction is what [`ParseStats`] exists to keep — measured,
//! the median real page carries 25 of 50 records that are neither user nor
//! assistant, so a reader that calls all of them unreadable is wrong about half
//! its input.
//!
//! ## Upstream instability is absorbed as data
//!
//! Claude's record types are not a closed set — the corpus this was measured
//! against carries 18 top-level types and 7 `system` subtypes, and the set has
//! changed between versions. So most of them become an entry carrying the
//! upstream name as a **string**, and the coarse `category` only says which
//! family of fact it is. A new `system` subtype is a new string, not a new
//! protocol generation.

pub(crate) mod adapter;
pub mod read;

pub use adapter::Outcome;
pub use read::{read_page, CanonicalPage, ParseStats};

/// Where a message came from, semantically.
///
/// Deliberately not a restatement of the upstream `role`: `type: "user"` is an
/// envelope that carries notifications and injected context as well as turns a
/// human typed (see [`adapter`]), so the upstream role cannot answer this
/// question and this type exists because it cannot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageSource {
    /// A turn a human authored.
    Human,
    /// A turn the model authored.
    Assistant,
    /// A record Claude Code injected as *context for the model* — flagged
    /// upstream with `isMeta`. Nothing authored it; it is material the model was
    /// given.
    Synthetic,
    /// A turn the runtime itself produced in message position: a background-task
    /// notification, a scheduled fire, a peer session. Distinct from
    /// [`MessageSource::Synthetic`] because it *is* a turn — something in the
    /// session spoke — where injected context is not.
    System,
}

/// One block of a message body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MessageBlock {
    /// Prose, verbatim. Whether it is Markdown is the client's reading.
    Text { text: String },
    /// A block this version does not model, kept as a position rather than
    /// dropped: a message that carried one must not read as if it had not.
    Unknown,
}

/// A turn, with its content blocks in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    /// Stable within the transcript — the record's uuid, plus the index of the
    /// first block when the record produced more than one entry. A record with
    /// no uuid falls back to its byte offset, which is a property of the
    /// transcript and stable across polls.
    pub id: String,
    pub source: MessageSource,
    pub timestamp: Option<String>,
    /// Content blocks in order. Never empty in the sense of "nothing was there":
    /// a turn whose blocks were all unmodelled carries [`MessageBlock::Unknown`]
    /// rather than reading as a turn that never happened.
    pub content: Vec<MessageBlock>,
    /// Whether the record belongs to a subagent rather than to this
    /// conversation.
    ///
    /// Measured across the whole `~/.claude/projects` tree, this is the marker
    /// on **every** record of the 464 subagent transcripts — 91,137 of them,
    /// under `projects/<dir>/<session>/subagents/`. Those live in separate
    /// files rather than in the parent transcript, which is why a discovery
    /// that lists only the project level sees none of them.
    pub sidechain: bool,
}

/// Where a tool call stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolStatus {
    /// No result exists yet — the call is the newest thing written.
    Running,
    Success,
    Error,
    /// No result could be paired *and the read cannot say why*: the call sits at
    /// a page edge and its result lies beyond the window that was searched.
    ///
    /// Deliberately distinct from [`ToolStatus::Running`]. "Still going" and "we
    /// did not look far enough" are different facts, and presenting the second
    /// as the first is a claim the provider cannot support.
    Unknown,
}

/// A bounded body attached to a tool call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Payload {
    pub text: String,
    /// Whether the body is serialized JSON, so a client can choose a treatment
    /// without parsing it.
    pub is_json: bool,
    pub truncated: bool,
}

/// A tool call, paired with its result when the transcript has one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCall {
    pub id: String,
    /// The upstream `tool_use.id` this call was made under — the only thing that
    /// tells two calls to the same tool apart.
    pub call_id: String,
    pub name: String,
    pub timestamp: Option<String>,
    pub status: ToolStatus,
    /// A single-line description of the call, with whitespace collapsed and
    /// **not** truncated: how long a client may render it is a property of that
    /// client's contract, so the ceiling belongs to the projection and not here.
    ///
    /// Specialized by tool name where a tool has an argument that *is* the call
    /// — a `Read` is its path, a `Bash` is its command — and generic otherwise,
    /// so a tool Claude adds next month reads as its own best argument rather
    /// than as nothing. Claude's tool set is open, so that specialization is
    /// upstream knowledge and lives beside the schema rather than in a client.
    pub summary: String,
    pub input: Option<Payload>,
    pub output: Option<Payload>,
}

/// Model reasoning, parsed whether or not a projection draws it.
///
/// It is the *largest* block type in a real transcript (measured: 49,795
/// `thinking` blocks against 22,739 `text`), which is exactly why the
/// conversation hides it — and why hiding it must not mean failing to read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reasoning {
    pub id: String,
    pub timestamp: Option<String>,
    /// The upstream block type — `thinking`, `redacted_thinking`, or whatever
    /// Claude adds next. Data, not an enum.
    pub reasoning_type: String,
    pub text: String,
}

/// Something Claude Code injected into the conversation as context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub id: String,
    pub timestamp: Option<String>,
    /// The upstream `attachment.type` — measured, a real corpus carries ~30 of
    /// them (`hook_success` alone is 53,542 records). A string, for the same
    /// reason a `system` subtype is.
    pub attachment_type: String,
}

/// Which family of runtime fact an event is.
///
/// Coarse on purpose: the upstream `name` is carried beside it as data, so a new
/// Claude subtype lands here without this enum growing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventCategory {
    /// The runtime reporting on itself — turn duration, a local command.
    System,
    /// An operation the session performed — queueing, progress.
    Runtime,
    /// The session's own circumstances changing — a relocation, a worktree.
    Lifecycle,
    /// A state checkpoint written down — a file-history snapshot.
    Checkpoint,
}

/// A runtime/system/lifecycle fact that is not a message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeEvent {
    pub id: String,
    pub timestamp: Option<String>,
    pub category: EventCategory,
    /// The upstream `type` or `subtype`, verbatim.
    pub name: String,
}

/// A record that changes session-level state rather than saying anything.
///
/// Measured, this is the largest family by *record count* in a real corpus —
/// titles, prompts, modes, PR links — and the conversation folds it into its
/// header rather than reading it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetadataEvent {
    pub id: String,
    pub timestamp: Option<String>,
    pub name: String,
}

/// A record this version does not model.
///
/// Kept rather than discarded so the projection that wants completeness can show
/// it, and counted so the one that omits it can say how much it omitted. Absence
/// of a model is not absence of a fact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownEvent {
    pub id: String,
    pub upstream_type: Option<String>,
    pub upstream_subtype: Option<String>,
    pub timestamp: Option<String>,
}

/// One thing the transcript recorded, in the transcript's order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    Message(Message),
    ToolCall(ToolCall),
    Reasoning(Reasoning),
    Attachment(Attachment),
    Runtime(RuntimeEvent),
    Metadata(MetadataEvent),
    Unknown(UnknownEvent),
}

impl Entry {
    /// The entry's id, whichever arm it is.
    pub fn id(&self) -> &str {
        match self {
            Self::Message(m) => &m.id,
            Self::ToolCall(t) => &t.id,
            Self::Reasoning(r) => &r.id,
            Self::Attachment(a) => &a.id,
            Self::Runtime(e) => &e.id,
            Self::Metadata(e) => &e.id,
            Self::Unknown(u) => &u.id,
        }
    }
}

/// The id for the block at `index` of record `id`.
///
/// The first block keeps the bare record uuid, so the common case reads as the
/// record it came from. Later blocks are suffixed with their index, which is what
/// keeps two `Bash` calls in one turn from colliding on a React key — and stable
/// across polls, because the index is a property of the transcript rather than of
/// the page.
pub(crate) fn entry_id(record_id: &str, index: usize) -> String {
    if index == 0 {
        record_id.to_string()
    } else {
        format!("{record_id}#{index}")
    }
}
